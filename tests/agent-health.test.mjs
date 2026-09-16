import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("agente inicia e publica o contrato de health", async t => {
  const port = 4184;
  const token = "integration-test-token";
  const child = spawn(process.execPath, ["server-cert-v8.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), DOCPRONTO_AGENT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("O agente não iniciou dentro do limite.")), 5000);
    child.once("error", reject);
    child.stderr.on("data", chunk => reject(new Error(chunk.toString("utf8"))));
    child.stdout.on("data", chunk => {
      if (chunk.toString("utf8").includes(`127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "X-DocPronto-Token": token } });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, "ONLINE");
  assert.equal(health.agentVersion, "2026.09.16-cert.21");
  assert.ok(health.capabilities.includes("A3_32BIT_FALLBACK"));
});
