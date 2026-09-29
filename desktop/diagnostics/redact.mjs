const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";
const REDACTED_FILE = "[REDACTED_FILE]";

const SENSITIVE_KEYS = /(?:password|passwd|passphrase|\bpin\b|secret|token|privatekey|contentbase64|signature(?:base64|bytes)?|documentbytes|filebytes|clipboard(?:content)?|extracted(?:text|content)|document(?:text|content)|raw(?:text|content|bytes))/i;
const PATH_KEYS = /(?:^|_)(?:path|filepath|filename|sourcefile|destinationfile|inputfile|outputfile)$/i;
const WINDOWS_PATH = /[a-z]:\\[^\r\n"'()<>|]*/gi;
const UNC_PATH = /\\\\[^\\\s]+\\[^\r\n"'()<>|]*/g;
const PERSONAL_POSIX_PATH = /\/(?:Users|home)\/[^\s"'()<>|]*/g;
const DOCUMENT_FILENAME = /\b[^\s\\/:*?"<>|()]+\.(?:pdf|docx?|xlsx?|csv|txt|ofx|pfx|p12)\b/gi;

function normalizeKey(key) {
  return key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.test(normalizeKey(key));
}

function isPathKey(key) {
  const normalized = key.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return PATH_KEYS.test(normalized);
}

function redactString(value) {
  return value
    .replace(WINDOWS_PATH, REDACTED_PATH)
    .replace(UNC_PATH, REDACTED_PATH)
    .replace(PERSONAL_POSIX_PATH, REDACTED_PATH)
    .replace(DOCUMENT_FILENAME, REDACTED_FILE);
}

function redact(value, seen) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return REDACTED;
  }
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[REDACTED_CIRCULAR]";

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => redact(item, seen));

    const source = value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack, ...value }
      : value;
    const result = {};
    for (const [key, nestedValue] of Object.entries(source)) {
      if (isSensitiveKey(key) || isPathKey(key)) result[key] = REDACTED;
      else result[key] = redact(nestedValue, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function redactDiagnosticValue(value) {
  return redact(value, new WeakSet());
}
