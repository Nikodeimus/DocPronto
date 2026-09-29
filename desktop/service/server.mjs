import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
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

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function tokenMatches(expectedToken, suppliedToken) {
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function emitDiagnostic(onDiagnostic, event) {
  try {
    onDiagnostic?.(event);
  } catch {
    // Diagnostics must never interrupt the local service.
  }
}

export async function startDocProntoService({
  assetsRoot,
  host = LOOPBACK_HOST,
  port = 0,
  sessionToken,
  onDiagnostic,
  appInfo,
} = {}) {
  if (host !== LOOPBACK_HOST) throw new Error("DocPronto Desktop must bind only to the IPv4 loopback host.");
  if (port !== 0) {
    throw Object.assign(new Error("DocPronto Desktop requires an ephemeral service port."), {
      code: "INVALID_SERVICE_PORT",
    });
  }
  if (!assetsRoot) throw new TypeError("assetsRoot is required.");

  const canonicalAssetsRoot = realpathSync(resolve(assetsRoot));
  const server = createServer((request, response) => {
    const currentPort = request.socket.localPort;
    const allowedHosts = new Set([`${LOOPBACK_HOST}:${currentPort}`, `localhost:${currentPort}`]);
    if (!allowedHosts.has(String(request.headers.host || "").toLowerCase())) {
      emitDiagnostic(onDiagnostic, { code: "LOCAL_HOST_REJECTED", host: request.headers.host || "" });
      writeJson(response, 403, { error: "Host local nao autorizado." });
      return;
    }

    const origin = String(request.headers.origin || "");
    const allowedOrigins = new Set([`http://${LOOPBACK_HOST}:${currentPort}`, `http://localhost:${currentPort}`]);
    if (origin && !allowedOrigins.has(origin)) {
      emitDiagnostic(onDiagnostic, { code: "LOCAL_ORIGIN_REJECTED", origin });
      writeJson(response, 403, { error: "Origem nao autorizada." });
      return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");

    const contentLength = Number(request.headers["content-length"] || 0);
    if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
      writeJson(response, 413, { error: "Arquivo grande demais para processamento local." });
      request.resume();
      return;
    }

    let requested;
    try {
      requested = decodeURIComponent((request.url || "/").split("?")[0]);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("URL invalida.");
      return;
    }

    if (requested.startsWith("/api/")) {
      if (sessionToken && !tokenMatches(sessionToken, String(request.headers["x-docpronto-token"] || ""))) {
        writeJson(response, 401, { error: "Sessao local invalida." });
        return;
      }
      if (request.method === "GET" && requested === "/api/health") {
        writeJson(response, 200, {
          ok: true,
          service: "DocPronto Desktop",
          ...(typeof appInfo?.version === "string" ? { version: appInfo.version } : {}),
          ...(typeof appInfo?.channel === "string" ? { channel: appInfo.channel } : {}),
        });
        return;
      }
      writeJson(response, 404, { error: "API nao encontrada." });
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
  });

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
          server.close(error => {
            if (error) reject(error);
            else {
              emitDiagnostic(onDiagnostic, { code: "LOCAL_SERVICE_STOPPED", port: boundPort });
              resolveClosed();
            }
          });
        });
      }
      return closePromise;
    },
  };
}
