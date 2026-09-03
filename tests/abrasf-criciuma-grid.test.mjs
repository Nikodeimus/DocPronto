import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = [
  "parseCriciumaMunicipalGrid",
  "findGridAnchors",
  "readGridValueRow",
  "parseGridMoney",
  "splitLayoutCells",
  "parseFlexibleFiscalMoney",
  "stripLayoutMarkers",
];

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

const context = vm.createContext({});
vm.runInContext(`${names.map(functionSource).join("\n")}\nthis.parseGrid = parseCriciumaMunicipalGrid;`, context);

const cell = (x, value) => `\uE000${x}\uE001${value}`;

test("lê a grade municipal da DANFSe de Criciúma sem cruzar colunas", () => {
  const lines = [
    [cell(27, "Valor"), cell(52, "do Serviço"), cell(143, "Desconto Incondicionado"), cell(305, "Total Deduções/Reduções"), cell(446, "Cálculo do BM")].join(" "),
    [cell(27, "R$"), cell(39, "568.80"), cell(143, "-"), cell(305, "R$"), cell(317, "0.00"), cell(446, "-")].join(" "),
    [cell(27, "BC ISSQN"), cell(143, "Alíquota Aplicada"), cell(305, "Retenção do ISSQN"), cell(446, "ISSQN Apurado")].join(" "),
    [cell(27, "R$"), cell(39, "568.80"), cell(143, "2.00%"), cell(305, "Não Retido"), cell(446, "R$"), cell(458, "11.38")].join(" "),
  ];

  assert.deepEqual(
    { ...context.parseGrid(lines) },
    { total: 568.8, deductions: 0, base: 568.8, rate: 2, iss: 11.38 },
  );
});
