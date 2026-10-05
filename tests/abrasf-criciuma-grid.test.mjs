import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = [
  "parseCriciumaMunicipalGrid",
  "parseCriciumaTaxes",
  "findFiscalLineValue",
  "findGridAnchors",
  "readGridValueRow",
  "parseGridMoney",
  "splitLayoutCells",
  "splitLayoutParts",
  "parseFlexibleFiscalMoney",
  "roundFiscal",
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
vm.runInContext(`${names.map(functionSource).join("\n")}\nthis.parseGrid = parseCriciumaMunicipalGrid; this.parseTaxes = parseCriciumaTaxes;`, context);

const cell = (x, value) => `\uE000${x}\uE001${value}`;

test("lê a grade municipal da DANFSe de Criciúma sem cruzar colunas", () => {
  const lines = [
    [cell(27, "Valor"), cell(52, "do Serviço"), cell(143, "Desconto Incondicionado"), cell(305, "Total Deduções/Reduções"), cell(446, "Cálculo do BM")].join(" "),
    cell(27, "R$ 1,222.28"),
    [cell(143, "-"), cell(305, "R$ 0.00"), cell(446, "-")].join(" "),
    [cell(27, "BC ISSQN"), cell(143, "Alíquota Aplicada"), cell(305, "Retenção do ISSQN"), cell(446, "ISSQN Apurado")].join(" "),
    cell(27, "R$ 1,222.28"),
    [cell(143, "2.00%"), cell(305, "Não Retido"), cell(446, "R$ 24.45")].join(" "),
  ];

  assert.deepEqual(
    { ...context.parseGrid(lines) },
    { total: 1222.28, deductions: 0, base: 1222.28, rate: 2, iss: 24.45 },
  );
});

test("separa PIS, COFINS e CSLL do total de contribuições sociais retidas", () => {
  const lines = [
    [cell(27, "IRRF"), cell(143, "Contribuição Previdenciária - Retida"), cell(305, "Contribuições Sociais - Retidas")].join(" "),
    [cell(27, "R$ 0.00"), cell(143, "-"), cell(305, "R$ 56.83")].join(" "),
    [cell(27, "PIS-Débito Apuração Própria"), cell(143, "COFINS - Débito Apuração Própria")].join(" "),
    [cell(27, "R$ 7.94"), cell(143, "R$ 36.67")].join(" "),
  ];

  assert.deepEqual(
    { ...context.parseTaxes(lines) },
    { pis: 7.94, cofins: 36.67, inss: 0, ir: 0, csll: 12.22, other: 0 },
  );
});
