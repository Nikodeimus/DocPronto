import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const connectorRoot = fileURLToPath(new URL("../public/docpronto", import.meta.url));
const serverFile = fileURLToPath(new URL("../public/docpronto/downloads/server.mjs", import.meta.url));

test("conector rejeita origem desconhecida e exige sessão", async t => {
  const port = 42673;
  const child = spawn(process.execPath, [serverFile], {
    cwd: connectorRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await Promise.race([
    once(child.stdout, "data"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("conector não iniciou")), 3000)),
  ]);

  const base = `http://127.0.0.1:${port}`;
  const evil = await fetch(`${base}/api/session`, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const origin = "https://docpronto-online.podpapiruscast.chatgpt.site";
  const sessionResponse = await fetch(`${base}/api/session`, { headers: { Origin: origin } });
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get("access-control-allow-origin"), origin);
  const session = await sessionResponse.json();
  assert.match(session.token, /^[A-Za-z0-9_-]{40,}$/);

  const unauthenticated = await fetch(`${base}/api/certificates`, { headers: { Origin: origin } });
  assert.equal(unauthenticated.status, 401);

  const health = await fetch(`${base}/api/health`, {
    headers: { Origin: origin, "X-DocPronto-Token": session.token },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "DocPronto local",
    version: "4.0.0",
    pdfSigningEngine: 4,
  });
});
