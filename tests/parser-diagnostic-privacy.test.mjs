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

function loadApi(names) {
  const context = vm.createContext({ Intl, Number, String, Math, Object, Error, Set });
  vm.runInContext(`${names.map(functionSource).join("\n")}; this.api = { ${names.join(", ")} };`, context);
  return context.api;
}

const nfseApi = loadApi([
  "createSafeParserError",
  "createNfseCancellationError",
  "validateAbrasfInvoice",
  "onlyDigits",
  "roundFiscal",
]);

const ofxApi = loadApi([
  "createSafeParserError",
  "parseOfx",
  "ofxTag",
  "parseOfxNumber",
  "normalizeOfxDate",
  "isValidCalendarDate",
  "decodeOfxEntities",
]);

const validInvoice = () => ({
  number: "6929", auth: "ABCD.1234.EFGH.56789-X", issueDate: "2026-07-01", time: "10:20:00",
  provider: { taxId: "12345678000190", name: "Prestador" }, customer: { taxId: "98765432000110", name: "Tomador" },
  municipality: { code: "3505708" }, item: { code: "171001220", rate: 2 },
  retentions: { pis: 10, cofins: 20, inss: 0, ir: 5, csll: 3, other: 0 },
  total: 1000, deductions: 0, base: 1000, iss: 20, net: 962,
});

function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("era esperado um erro");
}

function assertPrivateError(error, expectedCode, sentinels) {
  assert.equal(error.code, expectedCode);
  for (const sentinel of sentinels) assert.doesNotMatch(error.message, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("erro de NFS-e cancelada não encaminha data nem motivo do documento", () => {
  const error = nfseApi.createNfseCancellationError({
    cancelled: true,
    date: "29/09/2026 12:34:56",
    reason: "MOTIVO-SENTINELA-PRIVADO",
  });

  assertPrivateError(error, "NFSE_CANCELLED", ["29/09/2026", "MOTIVO-SENTINELA-PRIVADO"]);
  assert.match(error.message, /NFS-e está cancelada/i);
});

test("erros de conferência fiscal não encaminham valores da NFS-e", () => {
  const invoice = validInvoice();
  invoice.total = 991234.51;
  invoice.base = 881234.52;
  invoice.net = 771234.53;
  const error = captureError(() => nfseApi.validateAbrasfInvoice(invoice, true));

  assertPrivateError(error, "NFSE_TOTALS_MISMATCH", ["991234", "881234", "771234"]);
  assert.match(error.message, /valores fiscais.*não conferem/i);
});

test("erro de valor OFX não encaminha FITID nem valor bruto", () => {
  const error = captureError(() => ofxApi.parseOfx(`<OFX><STMTRS><BANKTRANLIST><STMTTRN><FITID>FITID-SENTINELA-VALOR</FITID><DTPOSTED>20260929</DTPOSTED><TRNAMT>VALOR-SENTINELA</TRNAMT></BANKTRANLIST></STMTRS></OFX>`));

  assertPrivateError(error, "OFX_TRANSACTION_AMOUNT_INVALID", ["FITID-SENTINELA-VALOR", "VALOR-SENTINELA"]);
});

test("erro de data OFX não encaminha FITID nem data bruta", () => {
  const error = captureError(() => ofxApi.parseOfx(`<OFX><STMTRS><BANKTRANLIST><STMTTRN><FITID>FITID-SENTINELA-DATA</FITID><DTPOSTED>DATA-SENTINELA</DTPOSTED><TRNAMT>10.00</TRNAMT></BANKTRANLIST></STMTRS></OFX>`));

  assertPrivateError(error, "OFX_TRANSACTION_DATE_INVALID", ["FITID-SENTINELA-DATA", "DATA-SENTINELA"]);
});

test("erro de saldo OFX não encaminha saldo bruto", () => {
  const error = captureError(() => ofxApi.parseOfx(`<OFX><STMTRS><BANKTRANLIST><STMTTRN><FITID>OK-1</FITID><DTPOSTED>20260929</DTPOSTED><TRNAMT>10.00</TRNAMT></BANKTRANLIST><LEDGERBAL><BALAMT>SALDO-SENTINELA</BALAMT></LEDGERBAL></STMTRS></OFX>`));

  assertPrivateError(error, "OFX_BALANCE_INVALID", ["SALDO-SENTINELA"]);
});

test("erro de FITID duplicado não encaminha o identificador", () => {
  const transaction = "<STMTTRN><FITID>FITID-DUPLICADO-SENTINELA</FITID><DTPOSTED>20260929</DTPOSTED><TRNAMT>10.00</TRNAMT>";
  const error = captureError(() => ofxApi.parseOfx(`<OFX><STMTRS><BANKTRANLIST>${transaction}${transaction}</BANKTRANLIST></STMTRS></OFX>`));

  assertPrivateError(error, "OFX_DUPLICATE_FITID", ["FITID-DUPLICADO-SENTINELA"]);
});
