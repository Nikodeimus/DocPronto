import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createDiagnosticEvent } from "./events.mjs";

const MAX_EVENTS = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const FILE_PATTERN = /^events-(\d{6})\.jsonl$/;

function parseJsonLines(contents) {
  const events = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A damaged line must not make the remaining diagnostic history unavailable.
    }
  }
  return events;
}

function matchesFilters(event, filters) {
  if (filters.level && event.level !== filters.level) return false;
  if (filters.tool && event.tool !== filters.tool) return false;
  if (filters.stage && event.stage !== filters.stage) return false;
  if (filters.code && event.code !== filters.code) return false;
  if (filters.executionId && event.metadata?.executionId !== filters.executionId) return false;
  if (filters.since && event.timestamp < filters.since) return false;
  if (filters.until && event.timestamp > filters.until) return false;
  return true;
}

export class DiagnosticStore {
  #closed = false;
  #currentFile;
  #currentSize = 0;
  #directory;
  #events = [];
  #nextFileNumber = 1;
  #queue = Promise.resolve();
  #ready;

  constructor({ userData } = {}) {
    if (typeof userData !== "string" || !userData) {
      throw new TypeError("userData is required.");
    }
    this.#directory = join(userData, "diagnostics");
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.#directory, { recursive: true });
    const files = await this.#files();
    for (const file of files) {
      this.#events.push(...parseJsonLines(await readFile(join(this.#directory, file), "utf8")));
    }
    this.#events = this.#events.slice(-MAX_EVENTS);

    if (files.length > 0) {
      const last = files.at(-1);
      this.#currentFile = join(this.#directory, last);
      this.#currentSize = (await stat(this.#currentFile)).size;
      this.#nextFileNumber = Number(FILE_PATTERN.exec(last)[1]) + 1;
    }
  }

  async #files() {
    return (await readdir(this.#directory))
      .filter(name => FILE_PATTERN.test(name))
      .sort();
  }

  #enqueue(operation) {
    const pending = this.#queue.then(() => operation());
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async #startFile() {
    const name = `events-${String(this.#nextFileNumber).padStart(6, "0")}.jsonl`;
    this.#nextFileNumber += 1;
    this.#currentFile = join(this.#directory, name);
    this.#currentSize = 0;
    await writeFile(this.#currentFile, "", { flag: "wx" });

    const files = await this.#files();
    let removedHistory = false;
    while (files.length > MAX_FILES) {
      await rm(join(this.#directory, files.shift()), { force: true });
      removedHistory = true;
    }
    if (removedHistory) {
      this.#events = [];
      for (const file of files) {
        this.#events.push(...parseJsonLines(await readFile(join(this.#directory, file), "utf8")));
      }
    }
  }

  async #writeSnapshot() {
    const chunks = [];
    let current = "";
    let currentBytes = 0;
    for (const event of this.#events) {
      let line = `${JSON.stringify(event)}\n`;
      let bytes = Buffer.byteLength(line);
      if (bytes > MAX_FILE_BYTES) {
        line = `${JSON.stringify({
          ...event,
          technical: "[TRUNCATED]",
          metadata: { redacted: true, reason: "DIAGNOSTIC_EVENT_TOO_LARGE" },
        })}\n`;
        bytes = Buffer.byteLength(line);
      }
      if (current && currentBytes + bytes > MAX_FILE_BYTES) {
        chunks.push(current);
        current = "";
        currentBytes = 0;
      }
      current += line;
      currentBytes += bytes;
    }
    if (current || chunks.length === 0) chunks.push(current);
    const retainedChunks = chunks.slice(-MAX_FILES);

    const existing = await this.#files();
    const temporary = [];
    for (let index = 0; index < retainedChunks.length; index += 1) {
      const number = this.#nextFileNumber + index;
      const finalName = `events-${String(number).padStart(6, "0")}.jsonl`;
      const temporaryName = `${finalName}.tmp`;
      await writeFile(join(this.#directory, temporaryName), retainedChunks[index], { flag: "wx" });
      temporary.push({ temporaryName, finalName });
    }
    for (const name of existing) await rm(join(this.#directory, name), { force: true });
    for (const file of temporary) {
      await rename(join(this.#directory, file.temporaryName), join(this.#directory, file.finalName));
    }

    this.#nextFileNumber += retainedChunks.length;
    const last = temporary.at(-1);
    this.#currentFile = join(this.#directory, last.finalName);
    this.#currentSize = Buffer.byteLength(retainedChunks.at(-1));
    this.#events = retainedChunks.flatMap(parseJsonLines);
  }

  append(input) {
    if (this.#closed) return Promise.reject(new Error("Diagnostic store is closed."));
    return this.#enqueue(async () => {
      await this.#ready;
      const event = createDiagnosticEvent(input);
      let line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > MAX_FILE_BYTES) {
        const bounded = {
          ...event,
          technical: "[TRUNCATED]",
          metadata: { redacted: true, reason: "DIAGNOSTIC_EVENT_TOO_LARGE" },
        };
        line = `${JSON.stringify(bounded)}\n`;
      }
      const lineBytes = Buffer.byteLength(line);

      if (!this.#currentFile || this.#currentSize + lineBytes > MAX_FILE_BYTES) {
        await this.#startFile();
      }
      await appendFile(this.#currentFile, line, "utf8");
      this.#currentSize += lineBytes;
      this.#events.push(JSON.parse(line));

      if (this.#events.length > MAX_EVENTS) {
        this.#events = this.#events.slice(-MAX_EVENTS);
        await this.#writeSnapshot();
      }
      return this.#events.at(-1);
    });
  }

  async list(filters = {}) {
    await this.#ready;
    await this.#queue;
    const filtered = this.#events.filter(event => matchesFilters(event, filters));
    const limit = Number.isInteger(filters.limit) && filters.limit >= 0 ? filters.limit : filtered.length;
    return structuredClone(filtered.slice(-limit));
  }

  clear() {
    if (this.#closed) return Promise.reject(new Error("Diagnostic store is closed."));
    return this.#enqueue(async () => {
      await this.#ready;
      await rm(this.#directory, { recursive: true, force: true });
      await mkdir(this.#directory, { recursive: true });
      this.#events = [];
      this.#currentFile = undefined;
      this.#currentSize = 0;
      this.#nextFileNumber = 1;
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ready;
    await this.#queue;
  }
}
