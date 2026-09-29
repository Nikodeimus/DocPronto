import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDesktopChannel,
  bindAccessibleDiagnosticDialog,
  createDiagnosticRecorder,
  createStableErrorMessage,
  presentDiagnosticEvent,
  sanitizeDiagnosticValue,
} from "../../public/docpronto/lab-ui.mjs";

function createElement() {
  return {
    hidden: false,
    textContent: "",
    dataset: {},
    classList: {
      values: new Set(),
      toggle(name, enabled) {
        if (enabled) this.values.add(name);
        else this.values.delete(name);
      },
      contains(name) { return this.values.has(name); },
    },
  };
}

function createChannelDocument() {
  const elements = new Map([
    ["labBadge", createElement()],
    ["diagnosticsButton", createElement()],
    ["desktopVersion", createElement()],
  ]);
  return {
    body: createElement(),
    getElementById(id) { return elements.get(id) ?? null; },
    elements,
  };
}

test("applyDesktopChannel mostra identidade e controles somente no Laboratorio", () => {
  const labDocument = createChannelDocument();
  applyDesktopChannel({ isLab: true, channel: "lab", appVersion: "1.4.2" }, { documentObj: labDocument });

  assert.equal(labDocument.elements.get("labBadge").hidden, false);
  assert.equal(labDocument.elements.get("labBadge").textContent, "LAB");
  assert.equal(labDocument.elements.get("diagnosticsButton").hidden, false);
  assert.equal(labDocument.elements.get("desktopVersion").textContent, "v1.4.2");
  assert.equal(labDocument.body.dataset.desktopChannel, "lab");

  const stableDocument = createChannelDocument();
  applyDesktopChannel({ isLab: false, channel: "stable", appVersion: "1.4.2" }, { documentObj: stableDocument });
  assert.equal(stableDocument.elements.get("labBadge").hidden, true);
  assert.equal(stableDocument.elements.get("diagnosticsButton").hidden, true);
  assert.equal(stableDocument.body.dataset.desktopChannel, "stable");
});

test("presentDiagnosticEvent entrega codigo ferramenta etapa causa e local sem caminho pessoal", () => {
  const presentation = presentDiagnosticEvent({
    id: "evt-1",
    timestamp: "2026-09-29T12:30:00.000Z",
    level: "error",
    code: "PDF_PARSE_FAILED",
    tool: "pdf-to-ofx",
    stage: "parse",
    message: "Não foi possível interpretar o documento.",
    technical: {
      cause: "Invalid cross-reference table",
      stack: "Error: failed\n    at parsePdf (C:\\Users\\Maria\\Documents\\FATURA-9927.pdf:42:7)",
    },
    metadata: { executionId: "run-8", retryable: true, toolId: "pdf-ofx" },
  });

  assert.equal(presentation.code, "PDF_PARSE_FAILED");
  assert.equal(presentation.tool, "pdf-to-ofx");
  assert.equal(presentation.stage, "parse");
  assert.equal(presentation.cause, "Invalid cross-reference table");
  assert.match(presentation.location, /parsePdf/);
  assert.match(presentation.location, /\[LOCAL REDIGIDO\]/);
  assert.match(presentation.location, /42:7/);
  assert.equal(presentation.retryable, true);
  assert.equal(JSON.stringify(presentation).includes("Maria"), false);
  assert.equal(JSON.stringify(presentation).includes("FATURA-9927.pdf"), false);
});

test("createStableErrorMessage limita o erro a resumo acao e codigo", () => {
  const result = createStableErrorMessage({
    code: "WORD_UNAVAILABLE",
    message: "Word ausente em C:\\Program Files\\Microsoft Office\\WINWORD.EXE",
    technical: { stack: "segredo", password: "1234" },
  });

  assert.deepEqual(Object.keys(result).sort(), ["action", "code", "summary"]);
  assert.equal(result.summary, "A conversão não foi concluída.");
  assert.equal(result.action, "Verifique se o Microsoft Word está instalado e tente novamente.");
  assert.equal(result.code, "WORD_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("Program Files"), false);
});

test("sanitizeDiagnosticValue redige arquivo caminho segredo e bytes antes do IPC", () => {
  const result = sanitizeDiagnosticValue({
    message: "Falha em C:\\Users\\Maria\\Documents\\cliente.pdf",
    password: "minha-senha",
    contentBase64: "c2VncmVkbw==",
    metadata: { fileName: "cliente.pdf", fileCount: 2 },
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("Maria"), false);
  assert.equal(serialized.includes("cliente.pdf"), false);
  assert.equal(serialized.includes("minha-senha"), false);
  assert.equal(serialized.includes("c2VncmVkbw=="), false);
  assert.equal(result.metadata.fileCount, 2);
});

test("Esc fecha o painel e devolve o foco ao botao que o abriu", () => {
  const listeners = new Map();
  const trigger = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const closeButton = { addEventListener() {}, focus() {} };
  const dialog = {
    open: true,
    closeCalls: 0,
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelectorAll() { return [closeButton]; },
    close() {
      this.open = false;
      this.closeCalls += 1;
      listeners.get("close")?.();
    },
  };
  bindAccessibleDiagnosticDialog(dialog, () => trigger);

  let prevented = false;
  listeners.get("keydown")({
    key: "Escape",
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(dialog.closeCalls, 1);
  assert.equal(trigger.focusCalls, 1);
});

test("createDiagnosticRecorder redige antes do IPC e preserva a ordem dos eventos", async () => {
  const received = [];
  let releaseFirst;
  const firstPending = new Promise(resolve => { releaseFirst = resolve; });
  const desktopApi = {
    diagnostics: {
      async record(event) {
        received.push(event);
        if (received.length === 1) await firstPending;
      },
    },
  };
  const record = createDiagnosticRecorder(desktopApi);
  const first = record({ code: "START", message: "C:\\Users\\Maria\\cliente.pdf" });
  const second = record({ code: "FINISH" });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(received.length, 1);
  assert.equal(JSON.stringify(received[0]).includes("Maria"), false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(received.map(event => event.code), ["START", "FINISH"]);
});

