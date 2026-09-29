import assert from "node:assert/strict";
import * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createDiagnosticEvent } from "../../desktop/diagnostics/events.mjs";
import { exportDiagnosticBundle } from "../../desktop/diagnostics/export.mjs";
import { redactDiagnosticValue } from "../../desktop/diagnostics/redact.mjs";
import { DiagnosticStore } from "../../desktop/diagnostics/store.mjs";

const PERSONAL_PATH = "C:\\Users\\Maria\\Documents\\FATURA-123.pdf";
const SECRET_VALUES = [
  "senha-super-secreta",
  "PIN-4321-SECRET",
  "ZG9jdW1lbnRvIHByaXZhZG8=",
  "YXNzaW5hdHVyYSBwcml2YWRh",
  "FULL-SIGNATURE-SECRET",
  "PRIVATE-DOCUMENT-BODY",
  "Maria",
  "FATURA-123.pdf",
];

async function createUserData(t) {
  const userData = await mkdtemp(join(tmpdir(), "docpronto-diagnostics-test-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  return userData;
}

async function diagnosticJsonlPaths(root) {
  const paths = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".jsonl")) paths.push(path);
    }
  }
  await visit(join(root, "diagnostics"));
  return paths.sort();
}

async function seedGeneration(userData, events) {
  const diagnosticsDir = join(userData, "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(
    join(diagnosticsDir, "events-000001-000001.jsonl"),
    `${events.map(event => JSON.stringify(event)).join("\n")}\n`,
  );
  await writeFile(join(diagnosticsDir, "committed-000001"), "");
}

function input(overrides = {}) {
  return {
    level: "info",
    tool: "pdf-to-ofx",
    stage: "parse",
    code: "PDF_PARSE_STARTED",
    message: "Processamento iniciado.",
    technical: null,
    durationMs: 12,
    metadata: {},
    ...overrides,
  };
}

function assertSecretsAbsent(serialized) {
  for (const secret of SECRET_VALUES) {
    assert.equal(serialized.includes(secret), false, `leaked secret: ${secret}`);
  }
  assert.equal(serialized.includes(PERSONAL_PATH), false);
}

test("creates_unique_timestamped_events_with_a_closed_schema", () => {
  const first = createDiagnosticEvent(input({ ignored: "must-not-survive" }));
  const second = createDiagnosticEvent(input());

  assert.notEqual(first.id, second.id);
  assert.equal(new Date(first.timestamp).toISOString(), first.timestamp);
  assert.deepEqual(Object.keys(first).sort(), [
    "code",
    "durationMs",
    "id",
    "level",
    "message",
    "metadata",
    "stage",
    "technical",
    "timestamp",
    "tool",
  ]);
  assert.equal("ignored" in first, false);
});

test("accepts_only_supported_diagnostic_levels", () => {
  for (const level of ["debug", "info", "warning", "error"]) {
    assert.equal(createDiagnosticEvent(input({ level })).level, level);
  }

  assert.throws(
    () => createDiagnosticEvent(input({ level: "fatal" })),
    error => error.code === "INVALID_DIAGNOSTIC_LEVEL",
  );
});

test("redacts_nested_secrets_document_material_personal_paths_and_stack_locations", () => {
  const source = {
    password: "senha-super-secreta",
    nested: {
      pin: "PIN-4321-SECRET",
      contentBase64: "ZG9jdW1lbnRvIHByaXZhZG8=",
      signatureBase64: "YXNzaW5hdHVyYSBwcml2YWRh",
      signature: "FULL-SIGNATURE-SECRET",
      documentContent: "PRIVATE-DOCUMENT-BODY",
      privateKey: "-----BEGIN PRIVATE KEY-----",
      clipboardContent: "conteudo copiado",
    },
    filePath: PERSONAL_PATH,
    stack: `Error: falha\n    at convert (${PERSONAL_PATH}:10:2)`,
  };

  const redacted = redactDiagnosticValue(source);
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.nested.pin, "[REDACTED]");
  assert.equal(redacted.nested.contentBase64, "[REDACTED]");
  assert.equal(redacted.nested.signatureBase64, "[REDACTED]");
  assert.equal(redacted.nested.signature, "[REDACTED]");
  assert.equal(redacted.nested.documentContent, "[REDACTED]");
  assert.equal(redacted.filePath, "[REDACTED]");
  assert.match(redacted.stack, /\[REDACTED_PATH\]/);
  assertSecretsAbsent(serialized);
});

test("redacts_tool_stage_and_code_before_persistence", async t => {
  const userData = await createUserData(t);
  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());

  const event = await store.append(input({
    tool: `converter ${PERSONAL_PATH}`,
    stage: "arquivo FATURA-123.pdf",
    code: `FAIL_${PERSONAL_PATH}`,
    technical: {
      nested: {
        tool: PERSONAL_PATH,
        stage: "FATURA-123.pdf",
        code: `NESTED_${PERSONAL_PATH}`,
      },
    },
  }));

  assert.match(event.tool, /\[REDACTED_PATH\]/);
  assert.match(event.stage, /\[REDACTED_FILE\]/);
  assert.match(event.code, /\[REDACTED_PATH\]/);
  assert.match(event.technical.nested.tool, /\[REDACTED_PATH\]/);
  assert.match(event.technical.nested.stage, /\[REDACTED_FILE\]/);
  assert.match(event.technical.nested.code, /\[REDACTED_PATH\]/);
  assertSecretsAbsent(JSON.stringify(event));
  const persisted = (await Promise.all(
    (await diagnosticJsonlPaths(userData)).map(path => readFile(path, "utf8")),
  )).join("\n");
  assertSecretsAbsent(persisted);
});

test("redacts_before_persistence_and_retains_only_the_latest_2000_events", async t => {
  const userData = await createUserData(t);
  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());

  await store.append(input({
    level: "error",
    code: "SECRET_FAILURE",
    technical: { stack: `at parse (${PERSONAL_PATH}:1:1)` },
    metadata: {
      password: "senha-super-secreta",
      contentBase64: "ZG9jdW1lbnRvIHByaXZhZG8=",
      signature: "FULL-SIGNATURE-SECRET",
    },
  }));
  const firstPersisted = (await Promise.all(
    (await diagnosticJsonlPaths(userData)).map(path => readFile(path, "utf8")),
  )).join("\n");
  assertSecretsAbsent(firstPersisted);

  for (let index = 0; index < 2_005; index += 1) {
    await store.append(input({
      level: index % 2 === 0 ? "info" : "warning",
      tool: index % 3 === 0 ? "word" : "pdf",
      code: `EVENT_${index}`,
      metadata: { executionId: index % 5 === 0 ? "run-a" : "run-b" },
    }));
  }

  const all = await store.list();
  assert.equal(all.length, 2_000);
  assert.equal(all[0].code, "EVENT_5");
  assert.equal(all.at(-1).code, "EVENT_2004");
  const warnings = await store.list({ level: "warning" });
  const wordEvents = await store.list({ tool: "word" });
  const runEvents = await store.list({ executionId: "run-a" });
  assert.equal(warnings.length, 1_000);
  assert.equal(warnings.every(event => event.level === "warning"), true);
  assert.equal(wordEvents.length, 667);
  assert.equal(wordEvents.every(event => event.tool === "word"), true);
  assert.equal(runEvents.length, 400);
  assert.equal(runEvents.every(event => event.metadata.executionId === "run-a"), true);
  const persisted = (await Promise.all(
    (await diagnosticJsonlPaths(userData)).map(path => readFile(path, "utf8")),
  )).join("\n");
  assertSecretsAbsent(persisted);

  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test("returns_no_events_when_list_limit_is_zero", async t => {
  const userData = await createUserData(t);
  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());
  await store.append(input({ code: "VISIBLE_WITHOUT_LIMIT" }));

  assert.deepEqual(await store.list({ limit: 0 }), []);
});

test("rotates_jsonl_at_5_MiB_and_keeps_at_most_five_files", async t => {
  const userData = await createUserData(t);
  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());
  const payload = "x".repeat(900_000);

  for (let index = 0; index < 36; index += 1) {
    await store.append(input({ code: `LARGE_${index}`, metadata: { payload } }));
  }

  const files = await diagnosticJsonlPaths(userData);
  assert.equal(files.length, 5);
  for (const path of files) {
    const contents = await readFile(path);
    assert.equal(contents.byteLength <= 5 * 1024 * 1024, true, `${path} exceeded 5 MiB`);
  }

  const liveCodes = (await store.list()).map(event => event.code);
  await store.close();
  const reopened = new DiagnosticStore({ userData });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.list()).map(event => event.code), liveCodes);
});

test("bounds_a_single_oversized_event_during_append", async t => {
  const userData = await createUserData(t);
  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());

  const stored = await store.append(input({ code: "X".repeat(6 * 1024 * 1024) }));

  assert.equal(stored.code, "DIAGNOSTIC_EVENT_TOO_LARGE");
  for (const path of await diagnosticJsonlPaths(userData)) {
    assert.equal((await stat(path)).size <= 5 * 1024 * 1024, true);
  }
});

test("bounds_an_oversized_event_during_snapshot_rewrite", async t => {
  const userData = await createUserData(t);
  const seeded = Array.from({ length: 1_999 }, (_, index) => createDiagnosticEvent(input({
    code: `SEED_${index}`,
  })));
  seeded.push(createDiagnosticEvent(input({ code: "Y".repeat(6 * 1024 * 1024) })));
  await seedGeneration(userData, seeded);

  const store = new DiagnosticStore({ userData });
  t.after(() => store.close());
  await store.append(input({ code: "TRIGGER_SNAPSHOT" }));

  assert.equal((await store.list()).some(event => event.code === "DIAGNOSTIC_EVENT_TOO_LARGE"), true);
  for (const path of await diagnosticJsonlPaths(userData)) {
    assert.equal((await stat(path)).size <= 5 * 1024 * 1024, true);
  }
});

test("keeps_the_previous_snapshot_readable_when_generation_commit_fails", async t => {
  const userData = await createUserData(t);
  const seeded = Array.from({ length: 2_000 }, (_, index) => createDiagnosticEvent(input({
    code: `SAFE_${index}`,
  })));
  await seedGeneration(userData, seeded);
  const injectedFileSystem = {
    ...fileSystem,
    async rename(source, destination) {
      if (destination.endsWith("committed-000002")) throw new Error("injected commit failure");
      return fileSystem.rename(source, destination);
    },
  };
  const store = new DiagnosticStore({ userData, fileSystem: injectedFileSystem });

  await assert.rejects(
    store.append(input({ code: "MUST_NOT_COMMIT" })),
    /injected commit failure/,
  );
  await store.close();

  const reopened = new DiagnosticStore({ userData });
  t.after(() => reopened.close());
  const events = await reopened.list();
  assert.equal(events.length, 2_000);
  assert.equal(events[0].code, "SAFE_0");
  assert.equal(events.at(-1).code, "SAFE_1999");
});

test("exports_a_readable_re_redacted_zip_without_document_bytes", async t => {
  const userData = await createUserData(t);
  const destination = join(userData, "diagnostics.zip");
  const event = createDiagnosticEvent(input({
    level: "error",
    code: "EXPORT_FAILURE",
    technical: { stack: `at export (${PERSONAL_PATH}:20:4)` },
    metadata: {
      password: "senha-super-secreta",
      contentBase64: "ZG9jdW1lbnRvIHByaXZhZG8=",
      signatureBase64: "YXNzaW5hdHVyYSBwcml2YWRh",
      filePath: PERSONAL_PATH,
    },
  }));
  event.metadata.password = "senha-super-secreta";

  const result = await exportDiagnosticBundle({
    events: [event],
    environment: {
      appVersion: "0.1.0",
      node: process.version,
      recentFile: PERSONAL_PATH,
      pin: "PIN-4321-SECRET",
    },
    destination,
  });

  assert.equal(result, destination);
  const archive = await JSZip.loadAsync(await readFile(destination));
  assert.deepEqual(Object.keys(archive.files).sort(), ["events.json", "manifest.json", "summary.txt"]);

  const exported = (await Promise.all([
    archive.file("manifest.json").async("string"),
    archive.file("events.json").async("string"),
    archive.file("summary.txt").async("string"),
  ])).join("\n");
  assertSecretsAbsent(exported);
  assert.match(exported, /\[REDACTED\]|\[REDACTED_PATH\]/);

  await assert.rejects(
    exportDiagnosticBundle({
      events: [],
      environment: {},
      destination: join(userData, "invalid.zip"),
      documentBytes: Buffer.from("document"),
    }),
    error => error.code === "DOCUMENT_BYTES_NOT_ALLOWED",
  );
});

test("exports_only_the_newest_2000_events", async t => {
  const userData = await createUserData(t);
  const destination = join(userData, "bounded.zip");
  const events = Array.from({ length: 2_005 }, (_, index) => ({
    ...input({ code: `EXPORT_${index}` }),
    id: `id-${index}`,
    timestamp: new Date(index).toISOString(),
  }));

  await exportDiagnosticBundle({ events, environment: {}, destination });

  const archive = await JSZip.loadAsync(await readFile(destination));
  const exportedEvents = JSON.parse(await archive.file("events.json").async("string"));
  const manifest = JSON.parse(await archive.file("manifest.json").async("string"));
  assert.equal(exportedEvents.length, 2_000);
  assert.equal(exportedEvents[0].code, "EXPORT_5");
  assert.equal(exportedEvents.at(-1).code, "EXPORT_2004");
  assert.equal(manifest.eventCount, 2_000);
});
