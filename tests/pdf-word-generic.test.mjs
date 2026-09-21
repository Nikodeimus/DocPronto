import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const names = ["cleanOcrLine", "isMeaningfulShortOcrText", "classifyOcrCandidate", "isSuspiciousEditableText", "classifyDocumentLine"];

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

const context = vm.createContext({ String, Math });
vm.runInContext(`${names.map(functionSource).join("\n")}; this.api = { cleanOcrLine, classifyOcrCandidate, isSuspiciousEditableText, classifyDocumentLine };`, context);

test("preserva campos curtos legítimos de formulários e notas", () => {
  for (const text of ["CPF", "UF", "CEP", "R$", "ISS", "42"]) {
    assert.equal(context.api.classifyOcrCandidate({ text, confidence: 92 }), "editable", text);
    assert.equal(context.api.isSuspiciousEditableText(text), false, text);
  }
});

test("continua rejeitando símbolos curtos e ruído de OCR", () => {
  for (const text of ["|", "__", "~^", "x"]) {
    assert.equal(context.api.classifyOcrCandidate({ text, confidence: 92 }), "noise", text);
  }
});

test("não reescreve palavras com correções jurídicas presumidas", () => {
  assert.equal(context.api.cleanOcrLine("Produto da lel"), "Produto da lel");
  assert.equal(context.api.cleanOcrLine("Plano de z exercer"), "Plano de z exercer");
});

test("classifica títulos e rodapés por forma e posição, não por vocabulário jurídico", () => {
  assert.equal(context.api.classifyDocumentLine({ text: "RELATÓRIO DE VISTORIA", height: 14, y: 80 }, 10), "heading");
  assert.equal(context.api.classifyDocumentLine({ text: "Contato: exemplo", height: 9, y: 800 }, 10), "footer");
});
