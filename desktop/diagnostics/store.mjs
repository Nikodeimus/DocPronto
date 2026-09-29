import { randomUUID } from "node:crypto";
import * as nodeFileSystem from "node:fs/promises";
import { join } from "node:path";

import { createDiagnosticEvent } from "./events.mjs";
import { redactDiagnosticValue } from "./redact.mjs";

const MAX_EVENTS = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const EVENT_FILE_PATTERN = /^events-(\d{6})-(\d{6})\.jsonl$/;
const LEGACY_FILE_PATTERN = /^events-(\d{6})\.jsonl$/;
const COMMIT_MARKER_PATTERN = /^committed-(\d{6})$/;

function generationName(generation) {
  return String(generation).padStart(6, "0");
}

function eventFileName(generation, fileNumber) {
  return `events-${generationName(generation)}-${String(fileNumber).padStart(6, "0")}.jsonl`;
}

function commitMarkerName(generation) {
  return `committed-${generationName(generation)}`;
}

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

function boundedEvent(event) {
  const safeEvent = redactDiagnosticValue(event);
  let line = `${JSON.stringify(safeEvent)}\n`;
  if (Buffer.byteLength(line) <= MAX_FILE_BYTES) return { event: safeEvent, line };

  const replacement = {
    id: typeof safeEvent?.id === "string" && safeEvent.id.length <= 64
      ? safeEvent.id
      : "oversized-event",
    timestamp: typeof safeEvent?.timestamp === "string" && safeEvent.timestamp.length <= 64
      ? safeEvent.timestamp
      : "1970-01-01T00:00:00.000Z",
    level: "error",
    tool: "diagnostics",
    stage: "persistence",
    code: "DIAGNOSTIC_EVENT_TOO_LARGE",
    message: "Diagnostic event exceeded the storage limit and was replaced.",
    technical: "[TRUNCATED]",
    durationMs: null,
    metadata: { redacted: true, reason: "DIAGNOSTIC_EVENT_TOO_LARGE" },
  };
  line = `${JSON.stringify(replacement)}\n`;
  if (Buffer.byteLength(line) > MAX_FILE_BYTES) {
    throw Object.assign(new Error("Unable to bound diagnostic event."), {
      code: "DIAGNOSTIC_BOUNDING_FAILED",
    });
  }
  return { event: replacement, line };
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
  #fileSystem;
  #generation = 0;
  #nextFileNumber = 1;
  #queue = Promise.resolve();
  #ready;

  constructor({ userData, fileSystem = nodeFileSystem } = {}) {
    if (typeof userData !== "string" || !userData) {
      throw new TypeError("userData is required.");
    }
    this.#directory = join(userData, "diagnostics");
    this.#fileSystem = fileSystem;
    this.#ready = this.#initialize();
  }

  async #directoryEntries() {
    return this.#fileSystem.readdir(this.#directory, { withFileTypes: true });
  }

  async #committedGenerations() {
    return (await this.#directoryEntries())
      .filter(entry => entry.isFile() && COMMIT_MARKER_PATTERN.test(entry.name))
      .map(entry => Number(COMMIT_MARKER_PATTERN.exec(entry.name)[1]))
      .sort((left, right) => left - right);
  }

  async #files(generation = this.#generation) {
    return (await this.#directoryEntries())
      .filter(entry => {
        if (!entry.isFile()) return false;
        const match = EVENT_FILE_PATTERN.exec(entry.name);
        return match && Number(match[1]) === generation;
      })
      .map(entry => entry.name)
      .sort();
  }

  async #legacyFiles() {
    return (await this.#directoryEntries())
      .filter(entry => entry.isFile() && LEGACY_FILE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();
  }

  async #readFiles(files) {
    const events = [];
    for (const file of files) {
      events.push(...parseJsonLines(await this.#fileSystem.readFile(join(this.#directory, file), "utf8")));
    }
    return events;
  }

  async #writeCommitMarker(generation) {
    const marker = commitMarkerName(generation);
    const temporary = `${marker}.${randomUUID()}.tmp`;
    const temporaryPath = join(this.#directory, temporary);
    try {
      await this.#fileSystem.writeFile(temporaryPath, "", { flag: "wx" });
      await this.#fileSystem.rename(temporaryPath, join(this.#directory, marker));
    } catch (error) {
      await this.#fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #initialize() {
    await this.#fileSystem.mkdir(this.#directory, { recursive: true });
    const committed = await this.#committedGenerations();
    const legacyFiles = committed.length === 0 ? await this.#legacyFiles() : [];

    if (committed.length === 0 && legacyFiles.length > 0) {
      this.#events = (await this.#readFiles(legacyFiles)).slice(-MAX_EVENTS);
      await this.#commitSnapshot(this.#events);
      return;
    }

    if (committed.length === 0) {
      this.#generation = 1;
      await this.#writeCommitMarker(this.#generation);
    } else {
      this.#generation = committed.at(-1);
    }

    const files = await this.#files();
    while (files.length > MAX_FILES) {
      await this.#fileSystem.rm(join(this.#directory, files.shift()), { force: true });
    }
    this.#events = (await this.#readFiles(files)).slice(-MAX_EVENTS);
    if (files.length > 0) {
      const last = files.at(-1);
      const match = EVENT_FILE_PATTERN.exec(last);
      this.#currentFile = join(this.#directory, last);
      this.#currentSize = (await this.#fileSystem.stat(this.#currentFile)).size;
      this.#nextFileNumber = Number(match[2]) + 1;
    }
    await this.#cleanupInactiveGenerations();
  }

  async #cleanupInactiveGenerations() {
    for (const entry of await this.#directoryEntries()) {
      if (!entry.isFile()) continue;
      const eventMatch = EVENT_FILE_PATTERN.exec(entry.name);
      const markerMatch = COMMIT_MARKER_PATTERN.exec(entry.name);
      const inactiveEvent = eventMatch && Number(eventMatch[1]) !== this.#generation;
      const inactiveMarker = markerMatch && Number(markerMatch[1]) !== this.#generation;
      if (inactiveEvent || inactiveMarker || LEGACY_FILE_PATTERN.test(entry.name) || entry.name.endsWith(".tmp")) {
        await this.#fileSystem.rm(join(this.#directory, entry.name), { force: true }).catch(() => {});
      }
    }
  }

  #enqueue(operation) {
    const pending = this.#queue.then(() => operation());
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async #startFile() {
    const name = eventFileName(this.#generation, this.#nextFileNumber);
    this.#nextFileNumber += 1;
    this.#currentFile = join(this.#directory, name);
    this.#currentSize = 0;
    await this.#fileSystem.writeFile(this.#currentFile, "", { flag: "wx" });

    const files = await this.#files();
    let removedHistory = false;
    while (files.length > MAX_FILES) {
      await this.#fileSystem.rm(join(this.#directory, files.shift()), { force: true });
      removedHistory = true;
    }
    if (removedHistory) this.#events = await this.#readFiles(files);
  }

  async #commitSnapshot(events) {
    const generation = this.#generation + 1;
    const chunks = [];
    let current = { contents: "", bytes: 0, events: [] };
    for (const sourceEvent of events) {
      const encoded = boundedEvent(sourceEvent);
      const bytes = Buffer.byteLength(encoded.line);
      if (current.contents && current.bytes + bytes > MAX_FILE_BYTES) {
        chunks.push(current);
        current = { contents: "", bytes: 0, events: [] };
      }
      current.contents += encoded.line;
      current.bytes += bytes;
      current.events.push(encoded.event);
    }
    if (current.contents || chunks.length === 0) chunks.push(current);
    const retainedChunks = chunks.slice(-MAX_FILES);
    const createdFiles = [];

    try {
      for (let index = 0; index < retainedChunks.length; index += 1) {
        const name = eventFileName(generation, index + 1);
        createdFiles.push(name);
        await this.#fileSystem.writeFile(
          join(this.#directory, name),
          retainedChunks[index].contents,
          { flag: "wx" },
        );
      }
      await this.#writeCommitMarker(generation);
    } catch (error) {
      for (const name of createdFiles) {
        await this.#fileSystem.rm(join(this.#directory, name), { force: true }).catch(() => {});
      }
      throw error;
    }

    this.#generation = generation;
    this.#events = retainedChunks.flatMap(chunk => chunk.events);
    const last = createdFiles.at(-1);
    this.#currentFile = join(this.#directory, last);
    this.#currentSize = retainedChunks.at(-1).bytes;
    this.#nextFileNumber = retainedChunks.length + 1;
    await this.#cleanupInactiveGenerations();
  }

  append(input) {
    if (this.#closed) return Promise.reject(new Error("Diagnostic store is closed."));
    return this.#enqueue(async () => {
      await this.#ready;
      const encoded = boundedEvent(createDiagnosticEvent(input));

      if (this.#events.length >= MAX_EVENTS) {
        await this.#commitSnapshot([...this.#events, encoded.event].slice(-MAX_EVENTS));
        return this.#events.at(-1);
      }

      const lineBytes = Buffer.byteLength(encoded.line);
      if (!this.#currentFile || this.#currentSize + lineBytes > MAX_FILE_BYTES) {
        await this.#startFile();
      }
      await this.#fileSystem.appendFile(this.#currentFile, encoded.line, "utf8");
      this.#currentSize += lineBytes;
      this.#events.push(encoded.event);
      return encoded.event;
    });
  }

  async list(filters = {}) {
    await this.#ready;
    await this.#queue;
    const filtered = this.#events.filter(event => matchesFilters(event, filters));
    const limit = Number.isInteger(filters.limit) && filters.limit >= 0 ? filters.limit : filtered.length;
    if (limit === 0) return [];
    return structuredClone(filtered.slice(-limit));
  }

  clear() {
    if (this.#closed) return Promise.reject(new Error("Diagnostic store is closed."));
    return this.#enqueue(async () => {
      await this.#ready;
      await this.#fileSystem.rm(this.#directory, { recursive: true, force: true });
      await this.#fileSystem.mkdir(this.#directory, { recursive: true });
      this.#events = [];
      this.#currentFile = undefined;
      this.#currentSize = 0;
      this.#generation += 1;
      this.#nextFileNumber = 1;
      await this.#writeCommitMarker(this.#generation);
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ready;
    await this.#queue;
  }
}
