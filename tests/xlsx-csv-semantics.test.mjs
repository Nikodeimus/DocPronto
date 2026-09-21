import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = ["neutralizeCsvFormula", "isPlainCsvNumber", "formatXlsxStoredValue", "excelSerialToCsvDate"];

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

const context = vm.createContext({ Date, Number, String, Math });
vm.runInContext(`${names.map(functionSource).join("\n")}; this.api = { neutralizeCsvFormula, formatXlsxStoredValue };`, context);

test("preserva números negativos e bloqueia fórmulas CSV", () => {
  assert.equal(context.api.neutralizeCsvFormula("-123.45"), "-123.45");
  assert.equal(context.api.neutralizeCsvFormula("-123,45"), "-123,45");
  assert.equal(context.api.neutralizeCsvFormula("=2+2"), "'=2+2");
  assert.equal(context.api.neutralizeCsvFormula("-CMD|' /C calc'!A0"), "'-CMD|' /C calc'!A0");
});

test("converte datas seriais e percentuais conforme o estilo XLSX", () => {
  assert.equal(context.api.formatXlsxStoredValue("45292", "1", [{}, { numFmtId: 14, formatCode: "" }]), "01/01/2024");
  assert.equal(context.api.formatXlsxStoredValue("0.125", "1", [{}, { numFmtId: 10, formatCode: "0.00%" }]), "12,50%");
  assert.equal(context.api.formatXlsxStoredValue("-10.5", "0", [{ numFmtId: 0, formatCode: "" }]), "-10.5");
});
