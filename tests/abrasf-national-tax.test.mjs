import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = ["parseNationalTaxTable", "splitLayoutCells", "stripLayoutMarkers", "parseFlexibleFiscalMoney"];

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

const context = vm.createContext({ console: { log() {} } });
vm.runInContext(`${names.map(functionSource).join("\n")}; this.parseTaxes = parseNationalTaxTable;`, context);

const cell = (x, value) => `\uE000${x}\uE001${value}`;

test("recompõe linhas tributárias nacionais fragmentadas pelo PDF", () => {
  const lines = [
    [cell(25, "COFINS"), cell(136, "3,00 %"), cell(247, "R$ 81,68"), cell(469, "Sim")].join(" "),
    [cell(136, "1,00 %"), cell(247, "R$ 27,23"), cell(469, "Sim")].join(" "),
    cell(25, "CSLL"),
    [cell(136, "1,50 %"), cell(247, "R$ 40,84"), cell(469, "Sim")].join(" "),
    cell(25, "IRRF"),
    cell(136, "0,65 %"),
    [cell(25, "PIS"), cell(247, "R$ 17,70"), cell(469, "Sim")].join(" "),
    [cell(25, "CBS"), cell(136, "0,90 %"), cell(247, "R$ 24,50"), cell(469, "Não")].join(" "),
    [cell(136, "2,00 %"), cell(247, "R$ 54,45"), cell(469, "Não")].join(" "),
    cell(25, "ISSQN"),
  ];

  assert.deepEqual(
    { ...context.parseTaxes(lines) },
    { pis: 17.7, cofins: 81.68, inss: 0, ir: 40.84, csll: 27.23, other: 0, _issRate: 2, _iss: 54.45 },
  );
});
