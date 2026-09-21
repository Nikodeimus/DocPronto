import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("TXT para PDF bloqueia caracteres incompatíveis sem substituição silenciosa", () => {
  assert.match(source, /const unsupported = findUnsupportedWinAnsiCharacters\(normalizedText\)/);
  assert.match(source, /Nenhum caractere foi substituído/);
  assert.match(source, /formatUnsupportedCharacter/);
});

test("TXT para PDF normaliza tabulações e mantém caracteres latinos compatíveis", () => {
  assert.match(source, /replace\(\/\\t\/g, " {4}"\)/);
  assert.match(source, /\\x20-\\x7E\\u00A0-\\u00FF/);
  assert.match(source, /wrapTextByWidth\(normalizedText/);
});
