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

const names = [
  "parseSupportedNfse",
  "parseNationalNfse",
  "parseNationalParty",
  "parseNationalOcrFields",
  "parseCriciumaMunicipalGrid",
  "parseCriciumaTaxes",
  "parseNationalRps",
  "fiscalSection",
  "fiscalLineSection",
  "findValueAfterLabel",
  "findFiscalLineValue",
  "findGridAnchors",
  "readGridValueRow",
  "parseGridMoney",
  "splitLayoutCells",
  "extractFiscalTaxId",
  "parseFlexibleFiscalMoney",
  "parseBrDateTime",
  "brDateToIso",
  "roundFiscal",
  "onlyDigits",
  "stripLayoutMarkers",
  "findBarueriInvoiceNumber",
  "parseBarueriNfse",
  "findBarueriRps",
  "findBarueriServiceItem",
  "findBarueriRetentions",
  "findLabeledFiscalMoney",
  "findFiscalMoneyNear",
  "findBarueriMunicipalRegistration",
  "extractBarueriDescription",
  "numberFromFilenameFallback",
  "parseFiscalMoney",
];

const context = vm.createContext({});
vm.runInContext(`${names.map(functionSource).join("\n")}; this.parse = parseSupportedNfse; this.party = parseNationalParty; this.barueri = parseBarueriNfse; this.barueriNumber = findBarueriInvoiceNumber;`, context);

const cell = (x, value) => `\uE000${x}\uE001${value}`;

test("converte o DANFSe v2.0 de Criciúma com os novos nomes das seções", () => {
  const lines = [
    cell(20, "DANFSe v2.0 Município: Criciuma / SC"),
    [cell(20, "Número da NFS-e"), cell(180, "Competência da NFS-e"), cell(330, "Data e Hora da emissão da")].join(" "),
    [cell(20, "1034692"), cell(180, "20/10/2026"), cell(330, "20/10/2026 23:14:44")].join(" "),
    cell(20, "Chave de Acesso da NFS-e"),
    cell(20, "42046082200910509001305000000103469226104980762141"),
    [cell(20, "PRESTADOR / FORNECEDOR"), cell(180, "CNPJ / CPF / NIF")].join(" "),
    cell(180, "00.910.509/0013-05"),
    [cell(20, "Nome / Nome Empresarial"), cell(309, "Município / Sigla UF")].join(" "),
    [cell(20, "THOMSON REUTERS BRASIL CONTEUDO E TECNOLOGIA LTDA"), cell(309, "Criciuma / SC")].join(" "),
    [cell(20, "TOMADOR / ADQUIRENTE"), cell(180, "CNPJ / CPF / NIF")].join(" "),
    cell(180, "12.564.060/0001-16"),
    [cell(20, "Nome / Nome Empresarial"), cell(309, "Município / Sigla UF")].join(" "),
    [cell(20, "PALIN MARTINS ORGANIZACAO TRIBUTARIA LTDA"), cell(309, "SAO JOSE DO RIO PRETO / SP")].join(" "),
    cell(20, "SERVIÇO PRESTADO"),
    [cell(20, "Código de Tributação Nacional"), cell(220, "Descrição do Serviço")].join(" "),
    [cell(20, "01.07.01"), cell(220, "Suporte técnico em informática")].join(" "),
    cell(20, "TRIBUTAÇÃO MUNICIPAL"),
    [cell(20, "BC ISSQN"), cell(160, "Alíquota Aplicada"), cell(300, "Retenção do ISSQN"), cell(450, "ISSQN Apurado")].join(" "),
    [cell(20, "R$ 1,222.28"), cell(160, "2.00%"), cell(300, "Não Retido"), cell(450, "R$ 24.45")].join(" "),
    cell(20, "TRIBUTAÇÃO FEDERAL"),
    [cell(20, "VALOR TOTAL DA NFS-e"), cell(180, "VALOR DA OPERAÇÃO/SERVIÇO"), cell(330, "Desconto Incondicionado")].join(" "),
    cell(180, "R$ 1,222.28"),
    [cell(20, "Total das Retenções"), cell(180, "Valor Líquido da NFS-e")].join(" "),
    [cell(20, "R$ 56.83"), cell(180, "R$ 1,165.45")].join(" "),
  ];
  const text = lines.map(line => line.replace(/\uE000\d+\uE001/g, "")).join("\n");

  const invoice = context.parse(lines, text);

  assert.equal(invoice.number, "1034692");
  assert.equal(invoice.auth, "42046082200910509001305000000103469226104980762141");
  assert.equal(invoice.provider.taxId, "00910509001305");
  assert.equal(invoice.provider.name, "THOMSON REUTERS BRASIL CONTEUDO E TECNOLOGIA LTDA");
  assert.equal(invoice.customer.taxId, "12564060000116");
  assert.equal(invoice.customer.name, "PALIN MARTINS ORGANIZACAO TRIBUTARIA LTDA");
  assert.equal(invoice.total, 1222.28);
  assert.equal(invoice.net, 1165.45);
});

test("não inclui município e UF no nome das partes do DANFSe v2.0", () => {
  const party = context.party([
    "PRESTADOR / FORNECEDOR",
    "CNPJ / CPF / NIF Nome / Nome Empresarial Município / UF",
    "00.910.509/0013-05 THOMSON REUTERS BRASIL CONTEUDO E TECNOLOGIA LTDA Criciuma / SC",
  ].join("\n"));

  assert.equal(party.name, "THOMSON REUTERS BRASIL CONTEUDO E TECNOLOGIA LTDA");
});

test("lê o número da nota de Barueri sem confundir com a autenticação", () => {
  const lines = [
    [cell(20, "Código de Autenticidade"), cell(360, "Número da Nota")].join(" "),
    [cell(20, "821G.6032.4516.9966657-Q"), cell(360, "0007944")].join(" "),
  ];

  assert.equal(context.barueriNumber(lines), "7944");
});

test("remove o CNPJ impresso depois da razão social do tomador de Barueri", () => {
  const lines = [
    "PREFEITURA MUNICIPAL DE BARUERI",
    "Código de Autenticidade Número da Nota",
    "821G.6032.4516.9966657-Q 0007944",
    "06/10/2026 14:08",
    "Prestador de Serviços",
    "CAPITAL UPGRADE ASSESSORIA E CONSULTORIA LTDA.",
    "CNPJ 28.988.409/0001-87",
    "Nome Tomador de Serviços",
    "PALIN MARTINS ORGANIZACAO TRIBUTARIA 12.564.060/0001-16",
    "Qtde Descrição do Serviço",
    "1 PLANEJAMENTO 171001220 2,00 17.820,00 17.820,00",
    "IRRF PIS/PASEP COFINS CSLL",
    "267,30 115,83 534,60 178,20",
    "VALOR TOTAL DA NOTA 17.820,00",
    "Valor Líquido 16.724,07",
    "DISCRIMINAÇÃO DOS SERVIÇOS",
    "Serviço prestado",
    "VALORES DE REPASSE A TERCEIROS",
  ];
  const invoice = context.barueri(lines, lines.join("\n"));

  assert.equal(invoice.customer.name, "PALIN MARTINS ORGANIZACAO TRIBUTARIA");
});
