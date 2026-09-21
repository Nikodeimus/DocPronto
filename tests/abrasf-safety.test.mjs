import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = ["detectNfseCancellation", "validateAbrasfInvoice", "onlyDigits", "roundFiscal", "formatMoney"];

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

const context = vm.createContext({ Intl, Number, String, Math, Object, Error });
vm.runInContext(`${names.reverse().map(functionSource).join("\n")}; this.api = { detectNfseCancellation, validateAbrasfInvoice };`, context);

const validInvoice = () => ({
  number: "6929", auth: "ABCD.1234.EFGH.56789-X", issueDate: "2026-07-01", time: "10:20:00",
  provider: { taxId: "12345678000190", name: "Prestador" }, customer: { taxId: "98765432000110", name: "Tomador" },
  municipality: { code: "3505708" }, item: { code: "171001220", rate: 2 },
  retentions: { pis: 10, cofins: 20, inss: 0, ir: 5, csll: 3, other: 0 },
  total: 1000, deductions: 0, base: 1000, iss: 20, net: 962,
});

test("não classifica cancelamento por uma palavra isolada", () => {
  assert.equal(context.api.detectNfseCancellation("Descrição: consultoria para nota CANCELADA anteriormente").cancelled, false);
});

test("bloqueia cancelamento confirmado por sinais independentes", () => {
  const result = context.api.detectNfseCancellation("NFS-e CANCELADA\nData e Hora do Cancelamento: 05/08/2026 10:42:54\nMotivo: valor incorreto");
  assert.equal(result.cancelled, true);
  assert.equal(result.date, "05/08/2026 10:42:54");
  assert.equal(result.reason, "valor incorreto");
});

test("bloqueia campo fiscal ausente em vez de gerar 0,00", () => {
  const invoice = validInvoice();
  invoice.base = Number.NaN;
  assert.throws(() => context.api.validateAbrasfInvoice(invoice, true), /base de cálculo.*não substitui/i);
});

test("aceita zero real quando o campo foi identificado", () => {
  const invoice = validInvoice();
  invoice.deductions = 0;
  assert.doesNotThrow(() => context.api.validateAbrasfInvoice(invoice, true));
});
