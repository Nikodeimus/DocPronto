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

class FakeElement {
  constructor(localName, { text = "", attributes = {}, children = [] } = {}) {
    this.localName = localName;
    this.namespaceURI = "http://www.abrasf.org.br/nfse.xsd";
    this.attributes = attributes;
    this.children = children;
    this._text = text;
  }

  get textContent() {
    return this._text || this.children.map(child => child.textContent).join("");
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  getElementsByTagNameNS(_namespace, name) {
    return this.children.flatMap(child => [
      ...(child.localName === name ? [child] : []),
      ...child.getElementsByTagNameNS("*", name),
    ]);
  }

  querySelectorAll(selector) {
    if (selector !== "[Id]") return [];
    return this.children.flatMap(child => [
      ...(child.getAttribute("Id") ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const el = (name, options) => new FakeElement(name, options);
const money = (name, value) => el(name, { text: value });

function validDocument() {
  const valoresServico = el("Valores", { children: [
    money("ValorServicos", "100.00"),
    money("ValorDeducoes", "0.00"),
  ] });
  const infDeclaracao = el("InfDeclaracaoPrestacaoServico", {
    attributes: { Id: "DPS123" },
    children: [
      el("Rps", { children: [
        el("IdentificacaoRps", { children: [el("Numero", { text: "456" })] }),
        el("DataEmissao", { text: "2026-10-05" }),
      ] }),
      el("Servico", { children: [valoresServico] }),
      el("Prestador"),
      el("TomadorServico"),
    ],
  });
  const infNfse = el("InfNfse", {
    attributes: { Id: "NFSe123" },
    children: [
      el("Numero", { text: "123" }),
      el("CodigoVerificacao", { text: "ABC" }),
      el("DataEmissao", { text: "2026-10-05T10:00:00-03:00" }),
      el("ValoresNfse", { children: [
        money("BaseCalculo", "100.00"),
        money("ValorLiquidoNfse", "100.00"),
      ] }),
      el("DeclaracaoPrestacaoServico", { children: [infDeclaracao] }),
    ],
  });
  return {
    documentElement: el("CompNfse", { children: [
      el("Nfse", { attributes: { versao: "2.04" }, children: [infNfse] }),
    ] }),
  };
}

const context = vm.createContext({ Error, Set });
vm.runInContext(`${functionSource("validateAbrasf204Document")}; ${functionSource("fiscalSection")}; this.validate = validateAbrasf204Document; this.fiscalSection = fiscalSection;`, context);

test("aceita Numero e DataEmissao próprios da NFS-e e do RPS", () => {
  assert.doesNotThrow(() => context.validate(validDocument()));
});

test("rejeita dois números diretamente dentro de InfNfse", () => {
  const documentNode = validDocument();
  const infNfse = documentNode.documentElement.children[0].children[0];
  infNfse.children.splice(1, 0, el("Numero", { text: "duplicado" }));
  assert.throws(() => context.validate(documentNode), /exatamente um campo Numero/i);
});

test("não encerra o serviço na coluna Código de Tributação Municipal", () => {
  const text = [
    "SERVIÇO PRESTADO",
    "Código de Tributação Nacional Código de Tributação Municipal Local da Prestação",
    "010701 - Suporte técnico em informática",
    "TRIBUTAÇÃO MUNICIPAL",
  ].join("\n");
  const section = context.fiscalSection(
    text,
    /SERVI[CÇ]O PRESTADO/i,
    /(?:^|\n)TRIBUTA[CÇ][AÃ]O MUNICIPAL(?:\n|$)|(?:^|\n)VALOR TOTAL DA NFS-e(?:\n|$)/im,
  );
  assert.match(section, /010701/);
  assert.doesNotMatch(section, /TRIBUTAÇÃO MUNICIPAL/);
});
