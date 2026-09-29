import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import JSZip from "jszip";

import { redactDiagnosticValue } from "./redact.mjs";

const ALLOWED_OPTIONS = new Set(["events", "environment", "destination"]);

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Diagnostic export options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (/document.*bytes|bytes.*document/i.test(key)) {
      throw Object.assign(new TypeError("Document bytes are not accepted by diagnostic export."), {
        code: "DOCUMENT_BYTES_NOT_ALLOWED",
      });
    }
    if (!ALLOWED_OPTIONS.has(key)) {
      throw Object.assign(new TypeError(`Unsupported diagnostic export option: ${key}`), {
        code: "INVALID_DIAGNOSTIC_EXPORT_OPTION",
      });
    }
  }
  if (!Array.isArray(options.events)) throw new TypeError("events must be an array.");
  if (!options.environment || typeof options.environment !== "object" || Array.isArray(options.environment)) {
    throw new TypeError("environment must be an object.");
  }
  if (typeof options.destination !== "string" || !options.destination) {
    throw new TypeError("destination is required.");
  }
}

function createSummary(events, createdAt) {
  const counts = new Map();
  for (const event of events) counts.set(event.level, (counts.get(event.level) ?? 0) + 1);
  const levels = ["debug", "info", "warning", "error"]
    .map(level => `${level}: ${counts.get(level) ?? 0}`)
    .join("\n");
  const eventLines = events.map(event => (
    `${event.timestamp ?? "unknown"} [${event.level ?? "unknown"}] ${event.code ?? "DIAGNOSTIC_EVENT"} - ${event.message ?? ""}`
  ));
  return [
    "DOCPronto - Resumo de diagnostico",
    `Gerado em: ${createdAt}`,
    `Eventos: ${events.length}`,
    "",
    levels,
    "",
    ...eventLines,
    "",
  ].join("\n");
}

export async function exportDiagnosticBundle(options) {
  validateOptions(options);
  const { events, environment, destination } = options;
  const createdAt = new Date().toISOString();
  const safeEvents = redactDiagnosticValue(events);
  const safeEnvironment = redactDiagnosticValue(environment);
  const manifest = redactDiagnosticValue({
    format: "docpronto-diagnostics",
    formatVersion: 1,
    createdAt,
    eventCount: safeEvents.length,
    environment: safeEnvironment,
  });

  const archive = new JSZip();
  archive.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  archive.file("events.json", `${JSON.stringify(safeEvents, null, 2)}\n`);
  archive.file("summary.txt", redactDiagnosticValue(createSummary(safeEvents, createdAt)));
  const contents = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return destination;
}
