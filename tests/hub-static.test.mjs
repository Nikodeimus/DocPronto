import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("servidor local entrega o Hub e o manifesto canônicos", async t => {
  const port = 4185;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("O servidor do Hub não iniciou dentro do limite.")), 5000);
    child.once("error", reject);
    child.stderr.on("data", chunk => reject(new Error(chunk.toString("utf8"))));
    child.stdout.on("data", chunk => {
      if (chunk.toString("utf8").includes(`127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const [page, app, release] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/hub/`),
    fetch(`http://127.0.0.1:${port}/hub/app.js`),
    fetch(`http://127.0.0.1:${port}/hub/agent-release.json`)
  ]);
  assert.equal(page.status, 200);
  assert.equal(app.status, 200);
  assert.equal(release.status, 200);
  assert.match(await page.text(), /\.\/app\.js\?v=2026\.09\.16-cert\.21/);
  assert.match(await app.text(), /agent-release\.json/);
  assert.equal((await release.json()).version, "2026.09.16-cert.21");
});
