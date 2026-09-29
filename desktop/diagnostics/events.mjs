import { randomUUID } from "node:crypto";

import { redactDiagnosticValue } from "./redact.mjs";

const LEVELS = new Set(["debug", "info", "warning", "error"]);

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function createDiagnosticEvent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Diagnostic event input must be an object.");
  }

  const level = input.level ?? "info";
  if (!LEVELS.has(level)) {
    throw Object.assign(new TypeError(`Unsupported diagnostic level: ${String(level)}`), {
      code: "INVALID_DIAGNOSTIC_LEVEL",
    });
  }

  const durationMs = Number.isFinite(input.durationMs) && input.durationMs >= 0
    ? input.durationMs
    : null;

  return Object.freeze({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    tool: text(input.tool, "desktop"),
    stage: text(input.stage),
    code: text(input.code, "DIAGNOSTIC_EVENT"),
    message: redactDiagnosticValue(text(input.message)),
    technical: redactDiagnosticValue(input.technical ?? null),
    durationMs,
    metadata: redactDiagnosticValue(input.metadata ?? {}),
  });
}
