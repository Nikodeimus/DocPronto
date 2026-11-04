import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `função ${name} não encontrada`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; opened = true; }
    if (source[index] === "}") depth -= 1;
    if (opened && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`função ${name} incompleta`);
}

const context = vm.createContext({ Date, Uint8Array });
const buildStart = source.indexOf("function buildOfx(");
const buildEnd = source.indexOf("function formatOfxTimestamp(", buildStart);
assert.notEqual(buildStart, -1);
assert.notEqual(buildEnd, -1);
vm.runInContext([
  source.slice(buildStart, buildEnd),
  functionSource("formatOfxTimestamp"),
  functionSource("escapeXml"),
  functionSource("simpleHash"),
  "this.build = buildOfx;",
].join("\n"), context);

test("gera OFX 1.02 em Windows-1252 com as tags exigidas pela Domínio", () => {
  const bytes = context.build({
    bankId: "001",
    agencyId: "1234",
    accountId: "56789-0",
    accountType: "CHECKING",
    currency: "BRL",
    finalBalance: 120.5,
    transactions: [{
      date: "2026-11-04",
      amount: -35.9,
      type: "DEBIT",
      document: "DOC-7788",
      memo: "Pagamento São João",
    }],
  });

  assert.equal(Object.prototype.toString.call(bytes), "[object Uint8Array]");
  const text = new TextDecoder("windows-1252").decode(bytes);
  assert.match(text, /ENCODING:USASCII/);
  assert.match(text, /CHARSET:1252/);
  assert.match(text, /<STMTTRN>[\s\S]*<TRNTYPE>DEBIT<\/TRNTYPE>/);
  assert.match(text, /<DTPOSTED>20261104120000\[-3:BRT\]<\/DTPOSTED>/);
  assert.match(text, /<CHECKNUM>DOC-7788<\/CHECKNUM>/);
  assert.match(text, /<MEMO>Pagamento São João<\/MEMO>/);
});
