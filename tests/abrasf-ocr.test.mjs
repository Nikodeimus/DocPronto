import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = ["parseNationalOcrFields", "parseFlexibleFiscalMoney", "roundFiscal"];

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

const context = vm.createContext({ Number, Math, String });
vm.runInContext(`${names.reverse().map(functionSource).join("\n")}; this.parseOcr = parseNationalOcrFields;`, context);

test("recupera os campos fiscais de uma DANFSe reconhecida por OCR", () => {
  const text = `
    Chave de Acesso da NFS-e NFS4204608220091050900 1305000000093724526092011358828
    Número da NFS-e Competência da NFS-e Data e Hora da emissão da NFS-e 937245 16/09/2026 16/09/2026 10:17:28
    TRIBUTAÇÃO MUNICIPAL Valor do Serviço Desconto Incondicionado Total Deduções/Reduções Cálculo do BM R$ 568.80 - R$ 0.00 -
    BC ISSQN Alíquota Aplicada Retenção do ISSQN ISSQN Apurado R$ 568.80 2.00% Não Retido R$ 11.38
    TRIBUTAÇÃO FEDERAL IRRF Contribuição Previdenciária - Retida Contribuições Sociais - Retidas R$ 0.00 - R$ 0.00
    PIS-Débito Apuração Própria COFINS - Débito Apuração Própria R$ 9.39 R$ 43.23
    VALOR TOTAL DA NFS-e Valor das Retenções Valor Líquido da NFS-e R$ 0.00 R$ 568.80
    TOTAIS APROXIMADOS DOS TRIBUTOS
  `;
  const result = context.parseOcr(text);
  assert.equal(result.number, "937245");
  assert.match(result.auth, /^NFS\d{40,}$/);
  assert.equal(result.issueRaw, "16/09/2026 10:17:28");
  assert.equal(result.competenceRaw, "16/09/2026");
  assert.deepEqual({ ...result.municipal }, { total: 568.8, deductions: 0, base: 568.8, rate: 2, iss: 11.38 });
  assert.deepEqual({ ...result.taxes }, { pis: 0, cofins: 0, inss: 0, ir: 0, csll: 0, other: 0 });
  assert.equal(result.net, 568.8);
});
