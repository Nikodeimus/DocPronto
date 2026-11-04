import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { DOMParser } from "@xmldom/xmldom";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

function optionalFunctionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; opened = true; }
    if (source[index] === "}") depth -= 1;
    if (opened && depth === 0) return source.slice(start, index + 1);
  }
  return "";
}

const names = [
  "parseAbrasfXmlDocument",
  "parseAbrasfXmlDocuments",
  "parseAbrasfXmlInvoiceNode",
  "validateAbrasfXmlReview",
  "abrasfInvoiceFingerprint",
  "xmlDirectChild",
  "xmlFirstDescendant",
  "xmlNodeText",
  "parseAbrasfXmlParty",
  "parseAbrasfXmlMoney",
  "normalizeAbrasfXmlDate",
  "onlyDigits",
  "roundFiscal",
  "simpleHash",
];
const context = vm.createContext({ DOMParser, Number, Math, String, Object, Error, RegExp, Date });
vm.runInContext(`${names.map(optionalFunctionSource).filter(Boolean).join("\n")}; this.api = { parse: typeof parseAbrasfXmlDocument === "function" ? parseAbrasfXmlDocument : null, parseAll: typeof parseAbrasfXmlDocuments === "function" ? parseAbrasfXmlDocuments : null, validate: typeof validateAbrasfXmlReview === "function" ? validateAbrasfXmlReview : null, fingerprint: typeof abrasfInvoiceFingerprint === "function" ? abrasfInvoiceFingerprint : null };`, context);

const xml204 = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Nfse versao="2.04"><InfNfse Id="NFSe7944">
    <Numero>7944</Numero><CodigoVerificacao>ABC123</CodigoVerificacao><DataEmissao>2026-10-06T14:08:00-03:00</DataEmissao>
    <ValoresNfse><BaseCalculo>17820.00</BaseCalculo><Aliquota>0.0200</Aliquota><ValorIss>356.40</ValorIss><ValorLiquidoNfse>16724.07</ValorLiquidoNfse></ValoresNfse>
    <PrestadorServico><RazaoSocial>CAPITAL UPGRADE ASSESSORIA</RazaoSocial></PrestadorServico>
    <DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico>
      <Competencia>2026-10-06</Competencia>
      <Servico><Valores><ValorServicos>17820.00</ValorServicos><ValorDeducoes>0.00</ValorDeducoes><ValorPis>115.83</ValorPis><ValorCofins>534.60</ValorCofins><ValorInss>0.00</ValorInss><ValorIr>267.30</ValorIr><ValorCsll>178.20</ValorCsll><OutrasRetencoes>0.00</OutrasRetencoes><ValorIss>356.40</ValorIss><Aliquota>0.0200</Aliquota></Valores><IssRetido>2</IssRetido><Discriminacao>Serviços de consultoria</Discriminacao><ExigibilidadeISS>1</ExigibilidadeISS></Servico>
      <Prestador><CpfCnpj><Cnpj>28988409000187</Cnpj></CpfCnpj></Prestador>
      <TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>12564060000116</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>PALIN MARTINS ORGANIZACAO TRIBUTARIA</RazaoSocial></TomadorServico>
    </InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico>
  </InfNfse></Nfse>
</CompNfse>`;

test("lê e confere os principais dados de um XML ABRASF 2.04", () => {
  assert.equal(typeof context.api.parse, "function");
  const invoice = context.api.parse(xml204);
  const review = context.api.validate(invoice);

  assert.equal(invoice.version, "2.04");
  assert.equal(invoice.number, "7944");
  assert.equal(invoice.issueDate, "2026-10-06");
  assert.equal(invoice.competence, "2026-10-06");
  assert.equal(invoice.provider.taxId, "28988409000187");
  assert.equal(invoice.customer.taxId, "12564060000116");
  assert.equal(invoice.description, "Serviços de consultoria");
  assert.equal(invoice.values.services, 17820);
  assert.equal(invoice.values.net, 16724.07);
  assert.deepEqual({ ...invoice.retentions }, { pis: 115.83, cofins: 534.6, inss: 0, ir: 267.3, csll: 178.2, other: 0 });
  assert.deepEqual([...review.errors], []);
});

test("aceita layout ABRASF antigo identificado por NaturezaOperacao", () => {
  assert.equal(typeof context.api.parse, "function");
  const oldXml = `<?xml version="1.0"?><ListaNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><CompNfse><Nfse versao="1.00"><InfNfse><Numero>88</Numero><CodigoVerificacao>X88</CodigoVerificacao><DataEmissao>2026-09-30</DataEmissao><NaturezaOperacao>1</NaturezaOperacao><PrestadorServico><IdentificacaoPrestador><CpfCnpj><Cnpj>00910509001305</Cnpj></CpfCnpj></IdentificacaoPrestador><RazaoSocial>PRESTADOR ANTIGO</RazaoSocial></PrestadorServico><TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>12564060000116</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>TOMADOR ANTIGO</RazaoSocial></TomadorServico><Servico><Valores><ValorServicos>568.80</ValorServicos><BaseCalculo>568.80</BaseCalculo><Aliquota>2.00</Aliquota><ValorIss>11.38</ValorIss><ValorLiquidoNfse>568.80</ValorLiquidoNfse></Valores><Discriminacao>Suporte técnico</Discriminacao></Servico></InfNfse></Nfse></CompNfse></ListaNfse>`;
  const invoice = context.api.parse(oldXml);

  assert.equal(invoice.version, "1.00");
  assert.equal(invoice.number, "88");
  assert.equal(invoice.provider.name, "PRESTADOR ANTIGO");
  assert.equal(invoice.customer.name, "TOMADOR ANTIGO");
  assert.equal(invoice.values.services, 568.8);
  assert.equal(invoice.values.rate, 0.02);
  assert.doesNotMatch(context.api.validate(invoice).warnings.join(" "), /ISS não confere/);
});

test("indica campos críticos ausentes e cria chave estável contra duplicidade", () => {
  assert.equal(typeof context.api.validate, "function");
  assert.equal(typeof context.api.fingerprint, "function");
  const invoice = context.api.parse(xml204);
  const fingerprint = context.api.fingerprint(invoice);
  const sameInvoice = context.api.parse(xml204.replace("Serviços de consultoria", "Histórico alterado"));
  const sameInvoiceNewAuth = context.api.parse(xml204.replace("ABC123", "CODIGO-NOVO"));
  const incomplete = { ...invoice, number: "", customer: { ...invoice.customer, taxId: "" } };

  assert.equal(context.api.fingerprint(sameInvoice), fingerprint);
  assert.equal(context.api.fingerprint(sameInvoiceNewAuth), fingerprint);
  assert.ok(context.api.validate(incomplete).errors.length >= 2);
});

test("confere todas as notas de um lote ListaNfse", () => {
  const second = xml204.replaceAll("7944", "7945").replace("ABC123", "ABC124");
  const firstBody = xml204.replace(/^<\?xml[^>]+>\s*/, "").replace(/^<CompNfse[^>]*>|<\/CompNfse>$/g, "");
  const secondBody = second.replace(/^<\?xml[^>]+>\s*/, "").replace(/^<CompNfse[^>]*>|<\/CompNfse>$/g, "");
  const batch = `<ListaNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><CompNfse>${firstBody}</CompNfse><CompNfse>${secondBody}</CompNfse></ListaNfse>`;
  const invoices = context.api.parseAll(batch);

  assert.equal(invoices.length, 2);
  assert.deepEqual(Array.from(invoices, invoice => invoice.number), ["7944", "7945"]);
});
