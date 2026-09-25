import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Função ${name} não encontrada`);
  const candidates = [source.indexOf("\nfunction ", start + 10), source.indexOf("\nasync function ", start + 10)].filter(index => index > start);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

const names = [
  "stripLayoutMarkers", "layoutXAt", "parseStatementLine", "inferStatementDirection", "parseStatementLines",
  "findStatementBalance", "confirmTransactionWithBalance", "findStatementDate", "inferFinancialMetadata",
  "normalizeYear", "inferTransactionYear", "isDescriptionContinuation", "isTrailingContinuation",
  "isHeaderOrSummary", "isCreditCardTransactionSection", "isCreditCardSectionEnd", "simplifyCreditCardMemo",
  "normalizeSearchText", "simpleHash", "findStatementAmounts", "chooseTransactionAmount", "parseStatementAmount",
  "isBalanceLine", "normalizeStatementDate"
];
const context = { Date };
vm.createContext(context);
vm.runInContext(`${names.map(extractFunction).join("\n")}\nthis.api = { inferFinancialMetadata, parseStatementLines };`, context);

const mark = (x, text) => `\uE000${x}\uE001${text}`;

test("prioriza o final mascarado do cartão sobre a conta bancária", () => {
  const metadata = context.api.inferFinancialMetadata([
    `${mark(20, "SANTANDER")} ${mark(200, "Conta: 130102285")}`,
    `${mark(20, "Número do Cartão: XXXX.XXXX.XXXX.9927")}`,
    `${mark(20, "Data Histórico das Despesas")} ${mark(330, "R$")} ${mark(410, "US$")}`
  ]);
  assert.equal(metadata.bankId, "SANTANDER");
  assert.equal(metadata.accountId, "CARTAO-9927");
  assert.equal(metadata.accountType, "CREDITCARD");
});

test("seleciona reais na fatura Santander quando US$ zero vem depois", () => {
  const lines = [
    `${mark(20, "SANTANDER Número do Cartão: XXXX.XXXX.XXXX.9927")}`,
    `${mark(20, "Demonstrativo das Transações")}`,
    `${mark(20, "Data")} ${mark(80, "Histórico das Despesas")} ${mark(330, "R$")} ${mark(410, "US$")}`,
    `${mark(20, "03/12/2025")} ${mark(80, "POSTO TESTE")} ${mark(330, "120,19")} ${mark(410, "0,00")}`,
    `${mark(20, "17/12/2025")} ${mark(80, "COMPRA TESTE")} ${mark(330, "150,00")} ${mark(410, "0,00")}`,
    `${mark(20, "Encargos Financeiros")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].amount, -120.19);
  assert.equal(transactions[1].amount, -150);
  assert.match(transactions[0].memo, /POSTO TESTE/);
});

test("seleciona reais na fatura com colunas US$ e R$ invertidas", () => {
  const lines = [
    `${mark(20, "BRADESCO Número do cartão: XXXX.XXXX.XXXX.6805")}`,
    `${mark(20, "Detalhe do Extrato")}`,
    `${mark(20, "Data")} ${mark(80, "Histórico")} ${mark(330, "US$")} ${mark(410, "R$")}`,
    `${mark(20, "02/01")} ${mark(80, "SERVICO TESTE")} ${mark(330, "0,00")} ${mark(410, "350,00")}`,
    `${mark(20, "03/01")} ${mark(80, "SEGUNDA COMPRA")} ${mark(330, "0,00")} ${mark(410, "25,90")}`,
    `${mark(20, "Total:")} ${mark(410, "375,90")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].amount, -350);
  assert.equal(transactions[1].amount, -25.9);
});

test("trata pagamento automático da fatura como crédito", () => {
  const lines = [
    `${mark(20, "SANTANDER Número do Cartão: XXXX.XXXX.XXXX.5943")}`,
    `${mark(20, "Demonstrativo das Transações")}`,
    `${mark(20, "Data Histórico das Despesas")} ${mark(330, "R$")} ${mark(410, "US$")}`,
    `${mark(20, "05/01/2026")} ${mark(80, "PAGTO. POR DEB EM C/C")} ${mark(330, "-1.229,52")} ${mark(410, "0,00")}`,
    `${mark(20, "Encargos Financeiros")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, 1229.52);
  assert.equal(transactions[0].type, "CREDIT");
});

test("preserva valor negativo de cartão como crédito mesmo sem rótulo", () => {
  const lines = [
    `${mark(20, "SICREDI Cartão final 0126")}`,
    `${mark(20, "Transações")}`,
    `${mark(20, "09/dez")} ${mark(80, "AJUSTE INTERNACIONAL")} ${mark(410, "-R$ 8.100,00")}`,
    `${mark(20, "Legenda:")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, 8100);
  assert.equal(transactions[0].type, "CREDIT");
});

test("continua lendo portadores após subtotal e total intermediário", () => {
  const lines = [
    `${mark(20, "SICREDI Cartão final 0126")}`,
    `${mark(20, "Transações")}`,
    `${mark(20, "08/jan")} ${mark(80, "COMPRA PRINCIPAL")} ${mark(410, "100,00")}`,
    `${mark(20, "Subtotal")} ${mark(410, "100,00")}`,
    `${mark(20, "Total cartão final 0126")} ${mark(410, "100,00")}`,
    `${mark(20, "Cartão portador virtual final 2406")}`,
    `${mark(20, "07/jan")} ${mark(80, "COMPRA ADICIONAL")} ${mark(410, "25,00")}`,
    `${mark(20, "Legenda:")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].amount, -100);
  assert.equal(transactions[1].amount, -25);
});

test("reconhece Banco do Brasil e cartão indicado entre parênteses", () => {
  const metadata = context.api.inferFinancialMetadata([
    `${mark(20, "bb.com.br | Central de Relacionamento BB")}`,
    `${mark(20, "Altair H M Palim (Cartão 9579)")}`,
    `${mark(20, "Data Descrição")} ${mark(410, "Valor")}`
  ]);
  assert.equal(metadata.bankId, "BANCO-DO-BRASIL");
  assert.equal(metadata.accountId, "CARTAO-9579");
});

test("combina descrição longa de cartão até encontrar o valor", () => {
  const lines = [
    `${mark(20, "SICREDI Cartão final 0126")}`,
    `${mark(20, "Transações")}`,
    `${mark(20, "08/01/2026")} ${mark(80, "SERVICO INTERNACIONAL")}`,
    `${mark(80, "DETALHE COMPLEMENTAR")}`,
    `${mark(80, "PARCELA 01/01")}`,
    `${mark(410, "199,90")}`,
    `${mark(20, "Total cartão")} ${mark(410, "199,90")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, -199.9);
  assert.match(transactions[0].memo, /SERVICO INTERNACIONAL/);
});

test("mantém encargos parcelados como lançamento e encerra antes das taxas", () => {
  const lines = [
    `${mark(20, "BRADESCO Número do cartão: XXXX.XXXX.XXXX.4816")}`,
    `${mark(20, "Detalhe do Extrato")}`,
    `${mark(20, "Data")} ${mark(80, "Histórico")} ${mark(330, "US$")} ${mark(410, "R$")}`,
    `${mark(20, "20/05")} ${mark(80, "ENCARGOS SOBRE PARCELA 008/012")} ${mark(330, "0,00")} ${mark(410, "39,51")}`,
    `${mark(20, "Taxa ao Mês")} ${mark(410, "60,10")}`
  ];
  const metadata = context.api.inferFinancialMetadata(lines);
  const transactions = context.api.parseStatementLines(lines, metadata);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, -39.51);
  assert.match(transactions[0].memo, /ENCARGOS SOBRE PARCELA/);
});

test("lançamentos idênticos de cartão geram aviso sem bloquear a conferência", () => {
  assert.match(source, /blockingDuplicate = duplicate && !result\.metadata\.creditCard/);
  assert.match(source, /duplicateWarnings \+= 1/);
});
