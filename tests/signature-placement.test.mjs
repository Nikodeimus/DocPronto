import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

const context = vm.createContext({ Math, Number, Error });
vm.runInContext(`${functionSource("clamp")}\n${functionSource("signaturePlacementFromGeometry")}; this.api = { signaturePlacementFromGeometry };`, context);

test("converte a caixa visível para coordenadas PDF finitas", () => {
  const placement = context.api.signaturePlacementFromGeometry({
    pageNumber: 2,
    boxRect: { left: 250, top: 500, width: 200, height: 60 },
    canvasRect: { left: 50, top: 100, width: 500, height: 700 },
    viewport: {
      width: 500,
      height: 700,
      convertToPdfPoint: (x, y) => [x, 700 - y],
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(placement)), {
    page: 2,
    x: 200,
    y: 240,
    width: 200,
    height: 60,
    coordinateSystem: "pdf-points-v2",
  });
});

test("bloqueia o cálculo quando a prévia já perdeu suas dimensões", () => {
  assert.throws(() => context.api.signaturePlacementFromGeometry({
    pageNumber: 1,
    boxRect: { left: 0, top: 0, width: 0, height: 0 },
    canvasRect: { left: 0, top: 0, width: 0, height: 0 },
    viewport: {
      width: 500,
      height: 700,
      convertToPdfPoint: (x, y) => [x, y],
    },
  }), /prévia da assinatura não está visível/i);
});
