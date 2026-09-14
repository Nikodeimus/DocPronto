import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const start = source.indexOf("function parseOfxReviewAmount(");
assert.notEqual(start, -1, "função de validação OFX não encontrada");
let depth = 0;
let opened = false;
let end = -1;
for (let index = start; index < source.length; index += 1) {
  if (source[index] === "{") { depth += 1; opened = true; }
  if (source[index] === "}") depth -= 1;
  if (opened && depth === 0) { end = index + 1; break; }
}
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}; this.parseAmount = parseOfxReviewAmount;`, context);

test("aceita lançamento de crédito zerado quando a coluna está preenchida", () => {
  assert.deepEqual({ ...context.parseAmount("0.00", "") }, { amount: 0, type: "CREDIT" });
});

test("aceita lançamento de débito zerado preservando sua natureza", () => {
  const parsed = context.parseAmount("", "0.00");
  assert.equal(parsed.type, "DEBIT");
  assert.ok(Object.is(parsed.amount, -0));
});

test("continua rejeitando linha sem coluna ou com as duas colunas preenchidas", () => {
  assert.equal(context.parseAmount("", ""), null);
  assert.equal(context.parseAmount("0.00", "0.00"), null);
});
