import { timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  convertOfficeDocument,
  listWindowsCertificates,
  signPdfWithWindowsCertificate,
  signWithWindowsCertificate,
} from "./windows-capabilities.mjs";

const MAX_API_REQUEST_BYTES = 56 * 1024 * 1024;
const MAX_NATIVE_INPUT_BYTES = 40 * 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".gz", "application/gzip"],
]);
const DEFAULT_CAPABILITIES = Object.freeze({
  convertOfficeDocument,
  listWindowsCertificates,
  signPdfWithWindowsCertificate,
  signWithWindowsCertificate,
});
const PUBLIC_NATIVE_ERROR_CODES = new Set([
  "CERTIFICATE_NOT_FOUND",
  "CERTIFICATE_PROVIDER_UNAVAILABLE",
  "INPUT_TOO_LARGE",
  "INVALID_CERTIFICATE",
  "INVALID_INPUT",
  "INVALID_JSON",
  "INVALID_REQUEST_SCHEMA",
  "INVALID_SIGNATURE_PLACEMENT",
  "INVALID_SIGNED_PDF",
  "LOCAL_OPERATION_TIMEOUT",
  "OUTPUT_TOO_LARGE",
  "REQUEST_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "WORD_UNAVAILABLE",
]);

function codedError(code, message, status = 400, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, status });
}

function isPublicAsset(name) {
  return ["index.html", "app.js", "lab-ui.mjs", "styles.css"].includes(name)
    || /^vendor\/(?:[a-zA-Z0-9_-]+(?:\.worker)?(?:\.min)?\.(?:js|mjs)|tesseract-core\/[a-zA-Z0-9_.-]+\.(?:js|wasm))$/.test(name);
}

function isReadablePublicFile(assetsRoot, filePath) {
  try {
    const actual = relative(assetsRoot, realpathSync(filePath));
    return !actual.startsWith("..") && !isAbsolute(actual) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function writeJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function tokenMatches(expectedToken, suppliedToken) {
  const expected = Buffer.from(String(expectedToken || ""));
  const supplied = Buffer.from(String(suppliedToken || ""));
  return expected.length > 0 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function emitDiagnostic(onDiagnostic, event) {
  try {
    onDiagnostic?.(event);
  } catch {
    // Diagnostics must never interrupt the local service.
  }
}

function assertExactObject(value, allowedKeys, name = "Requisicao") {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
    throw codedError("INVALID_REQUEST_SCHEMA", `${name} invalida.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw codedError("INVALID_REQUEST_SCHEMA", `${name} possui campos nao permitidos.`);
    }
  }
  return value;
}

function assertString(value, name, { maxLength, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || (pattern && !pattern.test(value))) {
    throw codedError("INVALID_REQUEST_SCHEMA", `${name} invalido.`);
  }
  return value;
}

function validateFilename(value, extension) {
  const filename = assertString(value, "Nome do arquivo", { maxLength: 255 });
  if (/[\\/\x00-\x1f]/.test(filename) || (extension && !filename.toLowerCase().endsWith(extension))) {
    throw codedError("INVALID_REQUEST_SCHEMA", "Nome do arquivo invalido.");
  }
  return filename;
}

function validateBase64(value) {
  const content = assertString(value, "Conteudo do arquivo", {
    maxLength: Math.ceil(MAX_NATIVE_INPUT_BYTES * 4 / 3) + 4,
    pattern: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  });
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor(content.length * 3 / 4) - padding);
  if (bytes > MAX_NATIVE_INPUT_BYTES) {
    throw codedError("INPUT_TOO_LARGE", "Arquivo grande demais para processamento local.", 413);
  }
  return content;
}

function validateThumbprint(value) {
  return assertString(value, "Certificado", { maxLength: 40, pattern: /^[A-Fa-f0-9]{40}$/ }).toUpperCase();
}

function validatePlacement(value) {
  const placement = assertExactObject(
    value,
    new Set(["coordinateSystem", "page", "x", "y", "width", "height"]),
    "Posicao da assinatura",
  );
  if (placement.coordinateSystem !== "pdf-points-v2"
    || !Number.isInteger(placement.page) || placement.page < 1 || placement.page > 100_000
    || ![placement.x, placement.y, placement.width, placement.height].every(Number.isFinite)
    || placement.x < 0 || placement.y < 0 || placement.width <= 0 || placement.height <= 0
    || placement.x > 100_000 || placement.y > 100_000
    || placement.width > 100_000 || placement.height > 100_000) {
    throw codedError("INVALID_SIGNATURE_PLACEMENT", "Posicao da assinatura invalida.");
  }
  return {
    coordinateSystem: placement.coordinateSystem,
    page: placement.page,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  };
}

function validateWordRequest(value) {
  const input = assertExactObject(value, new Set(["filename", "contentBase64"]));
  return {
    filename: validateFilename(input.filename, ".docx"),
    contentBase64: validateBase64(input.contentBase64),
  };
}

function validateDetachedSignatureRequest(value) {
  const input = assertExactObject(value, new Set(["filename", "thumbprint", "contentBase64", "signerName"]));
  const validated = {
    filename: validateFilename(input.filename),
    thumbprint: validateThumbprint(input.thumbprint),
    contentBase64: validateBase64(input.contentBase64),
  };
  if (input.signerName !== undefined) {
    validated.signerName = assertString(input.signerName, "Nome do assinante", { maxLength: 120 });
  }
  return validated;
}

function validatePdfSignatureRequest(value) {
  const input = assertExactObject(
    value,
    new Set(["filename", "thumbprint", "contentBase64", "signerName", "placement"]),
  );
  const validated = {
    filename: validateFilename(input.filename, ".pdf"),
    thumbprint: validateThumbprint(input.thumbprint),
    contentBase64: validateBase64(input.contentBase64),
    placement: validatePlacement(input.placement),
  };
  if (input.signerName !== undefined) {
    validated.signerName = assertString(input.signerName, "Nome do assinante", { maxLength: 120 });
  }
  return validated;
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
    throw codedError("UNSUPPORTED_MEDIA_TYPE", "Use Content-Type application/json.", 415);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_API_REQUEST_BYTES) {
      throw codedError("REQUEST_TOO_LARGE", "Requisicao grande demais.", 413);
    }
    chunks.push(chunk);
  }
  if (total === 0) throw codedError("INVALID_JSON", "Corpo JSON ausente.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw codedError("INVALID_JSON", "Corpo JSON invalido.", 400, cause);
  }
}

function methodNotAllowed(response, allowed) {
  writeJson(response, 405, { error: "Metodo nao permitido.", code: "METHOD_NOT_ALLOWED" }, { Allow: allowed });
}

function nativeErrorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (["INPUT_TOO_LARGE", "OUTPUT_TOO_LARGE"].includes(error?.code)) return 413;
  if (["WORD_UNAVAILABLE", "CERTIFICATE_PROVIDER_UNAVAILABLE"].includes(error?.code)) return 503;
  if (error?.code === "LOCAL_OPERATION_TIMEOUT") return 504;
  if (error?.code === "CERTIFICATE_NOT_FOUND") return 404;
  if (/^INVALID_/.test(String(error?.code || ""))) return 400;
  return 500;
}

function writeNativeError(response, error, onDiagnostic, route) {
  const originalCode = typeof error?.code === "string" ? error.code : "";
  const code = PUBLIC_NATIVE_ERROR_CODES.has(originalCode) ? originalCode : "NATIVE_OPERATION_FAILED";
  const status = code === "NATIVE_OPERATION_FAILED" ? 500 : nativeErrorStatus(error);
  emitDiagnostic(onDiagnostic, {
    code,
    tool: "native-service",
    stage: route.replace(/^\/api\//, ""),
    message: status >= 500 ? "Operacao nativa nao concluida." : "Entrada nativa rejeitada.",
  });
  writeJson(response, status, {
    error: code === "NATIVE_OPERATION_FAILED"
      ? "Nao foi possivel concluir a operacao local."
      : error?.message || "Nao foi possivel concluir a operacao local.",
    code,
  });
}

function maskIdentityNumbers(value) {
  return String(value)
    .replace(/\b(\d{3})\.?\d{3}\.?\d{3}-?(\d{2})\b/g, "$1•••••$2")
    .replace(/\b(\d{2})\.?\d{3}\.?\d{3}\/?\d{4}-?(\d{2})\b/g, "$1••••••••$2");
}

function sanitizeCertificates(certificates) {
  if (!Array.isArray(certificates)) return [];
  return certificates.flatMap(certificate => {
    try {
      return [{
        label: maskIdentityNumbers(
          assertString(certificate?.label || certificate?.subject || "Certificado", "Certificado", { maxLength: 300 }),
        ),
        thumbprint: validateThumbprint(certificate?.thumbprint),
        notAfter: assertString(certificate?.notAfter, "Validade", { maxLength: 64 }),
      }];
    } catch {
      return [];
    }
  });
}

async function handleApiRequest({
  request,
  response,
  requested,
  sessionToken,
  allowedOrigins,
  capabilities,
  capabilityDependencies,
  appInfo,
  onDiagnostic,
}) {
  if (requested === "/api/session") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    const origin = String(request.headers.origin || "");
    if (!sessionToken || !allowedOrigins.has(origin) || request.headers["sec-fetch-site"] !== "same-origin") {
      writeJson(response, 403, { error: "Sessao local nao autorizada.", code: "SESSION_NOT_AUTHORIZED" });
      return;
    }
    writeJson(response, 200, { token: sessionToken });
    return;
  }

  if (sessionToken && !tokenMatches(sessionToken, request.headers["x-docpronto-token"])) {
    writeJson(response, 401, { error: "Sessao local invalida.", code: "INVALID_SESSION" });
    return;
  }

  if (requested === "/api/health") {
    if (request.method !== "GET") return methodNotAllowed(response, "GET");
    writeJson(response, 200, {
      ok: true,
      service: "DocPronto Desktop",
      ...(sessionToken ? { pdfSigningEngine: 4 } : {}),
      ...(typeof appInfo?.version === "string" ? { version: appInfo.version } : {}),
      ...(typeof appInfo?.channel === "string" ? { channel: appInfo.channel } : {}),
    });
    return;
  }

  if (!sessionToken) {
    writeJson(response, 503, {
      error: "Sessao nativa indisponivel.",
      code: "SESSION_UNAVAILABLE",
    });
    return;
  }

  try {
    if (requested === "/api/certificates") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      const certificates = await capabilities.listWindowsCertificates(capabilityDependencies);
      writeJson(response, 200, { certificates: sanitizeCertificates(certificates) });
      return;
    }
    if (requested === "/api/word-to-pdf") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      const input = validateWordRequest(await readJsonBody(request));
      writeJson(response, 200, await capabilities.convertOfficeDocument(input, "pdf", capabilityDependencies));
      return;
    }
    if (requested === "/api/sign-installed") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      const input = validateDetachedSignatureRequest(await readJsonBody(request));
      const signatureBase64 = await capabilities.signWithWindowsCertificate(input, capabilityDependencies);
      writeJson(response, 200, { signatureBase64 });
      return;
    }
    if (requested === "/api/sign-pdf-installed") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      const input = validatePdfSignatureRequest(await readJsonBody(request));
      writeJson(response, 200, await capabilities.signPdfWithWindowsCertificate(input, capabilityDependencies));
      return;
    }
    writeJson(response, 404, { error: "API nao encontrada.", code: "API_NOT_FOUND" });
  } catch (error) {
    writeNativeError(response, error, onDiagnostic, requested);
  }
}

export async function startDocProntoService({
  assetsRoot,
  host = LOOPBACK_HOST,
  port = 0,
  sessionToken,
  onDiagnostic,
  appInfo,
  capabilities = DEFAULT_CAPABILITIES,
  temporaryParent = tmpdir(),
} = {}) {
  if (host !== LOOPBACK_HOST) throw new Error("DocPronto Desktop must bind only to the IPv4 loopback host.");
  if (port !== 0) {
    throw Object.assign(new Error("DocPronto Desktop requires an ephemeral service port."), {
      code: "INVALID_SERVICE_PORT",
    });
  }
  if (!assetsRoot) throw new TypeError("assetsRoot is required.");
  for (const name of Object.keys(DEFAULT_CAPABILITIES)) {
    if (typeof capabilities?.[name] !== "function") throw new TypeError(`Native capability ${name} is required.`);
  }

  const canonicalAssetsRoot = realpathSync(resolve(assetsRoot));
  const privateTemporaryRoot = await mkdtemp(join(resolve(temporaryParent), "docpronto-native-"));
  await chmod(privateTemporaryRoot, 0o700).catch(() => {});
  const capabilityDependencies = Object.freeze({ tempRoot: privateTemporaryRoot });

  const server = createServer((request, response) => {
    void (async () => {
      const currentPort = request.socket.localPort;
      const allowedHosts = new Set([`${LOOPBACK_HOST}:${currentPort}`, `localhost:${currentPort}`]);
      if (!allowedHosts.has(String(request.headers.host || "").toLowerCase())) {
        emitDiagnostic(onDiagnostic, { code: "LOCAL_HOST_REJECTED" });
        writeJson(response, 403, { error: "Host local nao autorizado.", code: "LOCAL_HOST_REJECTED" });
        return;
      }

      const origin = String(request.headers.origin || "");
      const allowedOrigins = new Set([`http://${LOOPBACK_HOST}:${currentPort}`, `http://localhost:${currentPort}`]);
      if (origin && !allowedOrigins.has(origin)) {
        emitDiagnostic(onDiagnostic, { code: "LOCAL_ORIGIN_REJECTED" });
        writeJson(response, 403, { error: "Origem nao autorizada.", code: "LOCAL_ORIGIN_REJECTED" });
        return;
      }
      if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");

      const contentLengthHeader = request.headers["content-length"];
      const contentLength = contentLengthHeader === undefined ? 0 : Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_API_REQUEST_BYTES) {
        writeJson(response, 413, { error: "Requisicao grande demais.", code: "REQUEST_TOO_LARGE" });
        request.resume();
        return;
      }

      let requested;
      try {
        requested = decodeURIComponent((request.url || "/").split("?")[0]);
      } catch {
        writeJson(response, 400, { error: "URL invalida.", code: "INVALID_URL" });
        return;
      }

      if (requested.startsWith("/api/")) {
        await handleApiRequest({
          request,
          response,
          requested,
          sessionToken,
          allowedOrigins,
          capabilities,
          capabilityDependencies,
          appInfo,
          onDiagnostic,
        });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }

      const requestedPath = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
      const filePath = resolve(canonicalAssetsRoot, requestedPath);
      const pathFromRoot = relative(canonicalAssetsRoot, filePath);
      if (!isPublicAsset(requestedPath) || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)
        || !isReadablePublicFile(canonicalAssetsRoot, filePath)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Arquivo nao encontrado.");
        return;
      }

      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; connect-src 'self' https://tessdata.projectnaptha.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(filePath);
      stream.on("error", error => {
        emitDiagnostic(onDiagnostic, { code: "LOCAL_ASSET_READ_FAILED", message: error.message });
        if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Nao foi possivel ler o arquivo.");
      });
      stream.pipe(response);
    })().catch(error => {
      emitDiagnostic(onDiagnostic, { code: "LOCAL_SERVICE_REQUEST_FAILED", message: error?.message });
      if (!response.headersSent) {
        writeJson(response, 500, { error: "Falha no servico local.", code: "LOCAL_SERVICE_REQUEST_FAILED" });
      } else {
        response.end();
      }
    });
  });

  try {
    await new Promise((resolveStarted, reject) => {
      const onError = error => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveStarted();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, LOOPBACK_HOST);
    });
  } catch (error) {
    await rm(privateTemporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : 0;
  const origin = `http://${LOOPBACK_HOST}:${boundPort}`;
  emitDiagnostic(onDiagnostic, { code: "LOCAL_SERVICE_STARTED", origin, port: boundPort });

  let closePromise;
  return {
    origin,
    port: boundPort,
    close() {
      if (!closePromise) {
        closePromise = new Promise((resolveClosed, reject) => {
          server.close(error => error ? reject(error) : resolveClosed());
        }).finally(async () => {
          await rm(privateTemporaryRoot, { recursive: true, force: true });
          emitDiagnostic(onDiagnostic, { code: "LOCAL_SERVICE_STOPPED", port: boundPort });
        });
      }
      return closePromise;
    },
  };
}
