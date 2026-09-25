import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/docpronto/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("tool discovery exposes a labeled search and live result count", () => {
  assert.match(html, /id="toolSearch"[^>]+type="search"/);
  assert.match(html, /id="toolResultCount"[^>]+aria-live="polite"/);
  assert.match(app, /search\.addEventListener\("input", updateToolVisibility\)/);
});

test("privacy copy describes local processing without claiming there is no server", () => {
  assert.match(html, /sem envio remoto dos arquivos/i);
  assert.doesNotMatch(html, /Sem servidor/);
});
