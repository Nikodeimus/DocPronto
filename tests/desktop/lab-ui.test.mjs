import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyDesktopChannel,
  bindAccessibleDiagnosticDialog,
  createDiagnosticRecorder,
  createErrorReporter,
  createLaboratoryController,
  createStableErrorMessage,
  initializeDesktopExperience,
  presentDiagnosticEvent,
  sanitizeDiagnosticValue,
} from "../../public/docpronto/lab-ui.mjs";

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, enabled) {
    const active = enabled === undefined ? !this.values.has(name) : enabled;
    if (active) this.values.add(name);
    else this.values.delete(name);
    return active;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName, ownerDocument, id = "") {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.open = false;
    this.value = "";
    this.type = "";
    this._textContent = "";
  }
  set textContent(value) { this._textContent = String(value); if (value) this.children = []; }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join("") : this._textContent; }
  append(...children) {
    for (const child of children) {
      const node = typeof child === "string" ? this.ownerDocument.createTextNode(child) : child;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...children) { this.children = []; this._textContent = ""; this.append(...children); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.showModalCalls = (this.showModalCalls || 0) + 1; }
  async close() { this.open = false; await this.dispatch("close"); }
  querySelectorAll() {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (["BUTTON", "INPUT", "SELECT"].includes(child.tagName) && !child.hidden && !child.disabled) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  findButton(label) {
    return this.querySelectorAll().find(element => element.tagName === "BUTTON" && element.textContent === label);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.body = new FakeElement("body", this, "body");
    this.activeElement = null;
  }
  add(id, tagName = "div") {
    const element = new FakeElement(tagName, this, id);
    this.elements.set(id, element);
    return element;
  }
  getElementById(id) { return this.elements.get(id) ?? null; }
  createElement(tagName) { return new FakeElement(tagName, this); }
  createTextNode(text) { const node = new FakeElement("#text", this); node._textContent = String(text); return node; }
}

function createControllerHarness(overrides = {}) {
  const documentObj = new FakeDocument();
  const dialog = documentObj.add("diagnosticsPanel", "dialog");
  const ids = [
    ["diagnosticsButton", "button"], ["diagnosticsClose", "button"], ["diagnosticsList", "div"],
    ["diagnosticsDetails", "div"], ["diagnosticsStatus", "span"], ["diagnosticsLevel", "select"],
    ["diagnosticsTool", "input"], ["diagnosticsExecution", "input"], ["diagnosticsRefresh", "button"],
    ["diagnosticsExport", "button"], ["diagnosticsClear", "button"],
  ];
  for (const [id, tag] of ids) dialog.append(documentObj.add(id, tag));
  const calls = { list: 0, export: 0, clear: 0, record: [], dispatched: [] };
  const events = overrides.events || [{
    id: "event-1", timestamp: "2026-09-29T12:30:00.000Z", level: "error", code: "PDF_PARSE_FAILED",
    tool: "pdf-ofx", stage: "parse", message: "Falha controlada.",
    technical: { cause: "Tabela inválida", location: "at parse ([LOCAL REDIGIDO])" },
    metadata: { executionId: "run-8", retryable: true, toolId: "pdf-ofx" },
  }];
  const desktopApi = overrides.desktopApi || {
    diagnostics: {
      async list() { calls.list += 1; return events; },
      async export() { calls.export += 1; return "diagnostico.zip"; },
      async clear() { calls.clear += 1; },
      async record(event) { calls.record.push(event); },
    },
  };
  const clipboard = { async writeText(value) { calls.clipboard = value; } };
  const windowObj = {
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    dispatchEvent(event) { calls.dispatched.push(event); },
  };
  return { documentObj, dialog, desktopApi, navigatorObj: { clipboard }, windowObj, calls, events };
}

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

test("presentDiagnosticEvent nao inventa causa ou local para evento informativo", () => {
  const presentation = presentDiagnosticEvent({
    id: "evt-success",
    level: "info",
    code: "TOOL_RUN_COMPLETED",
    tool: "pdf-ofx",
    stage: "finish",
    message: "Processamento concluído.",
    technical: null,
  });

  assert.equal(presentation.cause, null);
  assert.equal(presentation.location, null);
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
  assert.deepEqual(createStableErrorMessage({ code: "FAIL_FATURA 9927 org.pdf" }), {
    summary: "A operação não foi concluída.",
    action: "Confira o arquivo e tente novamente. Se o erro continuar, informe o código ao suporte.",
    code: "OPERATION_FAILED",
  });
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

test("redige referencias documentais completas com espacos maiusculas caminhos e multiplos nomes", async () => {
  const received = [];
  const record = createDiagnosticRecorder({ diagnostics: { async record(event) { received.push(event); } } });
  await record({
    code: "FILES_FAILED",
    message: "Falharam FATURA 9927 org.pdf, CARTÃO PRATICO 01-26.PDF e RELATORIO (FINAL) 2026.PDF.",
    technical: {
      cause: "Não abriu C:\\Users\\Financeiro\\Downloads\\FATURA 9927 org.pdf nem \\\\servidor\\financeiro\\CARTÃO PRATICO 01-26.PDF",
    },
  });
  const serialized = JSON.stringify(received[0]);

  for (const fragment of ["FATURA", "9927", "org.pdf", "CARTÃO", "PRATICO", "RELATORIO", "FINAL", "2026", "Financeiro", "servidor"]) {
    assert.equal(serialized.includes(fragment), false, `fragmento vazou: ${fragment}`);
  }
  assert.match(serialized, /\[ARQUIVO REDIGIDO\]|\[LOCAL REDIGIDO\]/);
});

test("redacao preserva prefixo e causa ao ocultar somente o nome documental", () => {
  const result = sanitizeDiagnosticValue("Falha ao abrir FATURA 9927 org.pdf por formato inválido.");

  assert.equal(result, "Falha ao abrir [ARQUIVO REDIGIDO] por formato inválido.");
  for (const fragment of ["FATURA", "9927", "org.pdf"]) {
    assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
  }
});

test("redacao nao confunde verbo interno com limite do nome documental", () => {
  const result = sanitizeDiagnosticValue("Falha ao abrir RELATORIO PARA ABRIR 2026.pdf por formato inválido.");

  assert.equal(result, "Falha ao abrir [ARQUIVO REDIGIDO] por formato inválido.");
  for (const fragment of ["RELATORIO", "PARA", "ABRIR", "2026.pdf"]) {
    assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
  }
});

test("redacao preserva a causa depois de caminhos Windows e UNC", () => {
  const messages = [
    "Falha em C:\\Users\\Financeiro\\Downloads\\FATURA 9927 org.pdf porque o arquivo está corrompido.",
    "Falha em \\\\servidor\\financeiro\\CARTÃO PRATICO 01-26.PDF porque o arquivo está corrompido.",
  ];

  for (const message of messages) {
    const result = sanitizeDiagnosticValue(message);
    assert.equal(result, "Falha em [LOCAL REDIGIDO] porque o arquivo está corrompido.");
    for (const fragment of ["FATURA", "9927", "org.pdf", "servidor", "financeiro", "CARTÃO", "PRATICO", "01-26.PDF"]) {
      assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
    }
  }
});

test("redacao cobre caminhos completos mesmo com extensao em segmento intermediario", () => {
  const messages = [
    "Falha em C:\\dados\\arquivo.pdf\\lote\\FATURA 9927 org.pdf porque o arquivo está corrompido.",
    "Falha em \\\\servidor\\dados\\arquivo.pdf\\lote\\FATURA 9927 org.pdf porque o arquivo está corrompido.",
  ];

  for (const message of messages) {
    const result = sanitizeDiagnosticValue(message);
    assert.equal(result, "Falha em [LOCAL REDIGIDO] porque o arquivo está corrompido.");
    for (const fragment of ["dados", "arquivo.pdf", "lote", "FATURA", "9927", "org.pdf", "servidor"]) {
      assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
    }
  }
});

test("palavra de causa dentro de segmento nao encerra caminho Windows UNC ou POSIX", () => {
  const cases = [
    ["C:\\Clientes porque importantes\\lote\\FATURA 9927.pdf", ["Clientes", "porque importantes", "lote", "FATURA"]],
    ["\\\\servidor\\Clientes porque importantes\\lote\\FATURA 9927.pdf", ["servidor", "porque importantes", "lote", "FATURA"]],
    ["/tmp/Clientes durante auditoria/lote/FATURA 9927.pdf", ["Clientes", "durante auditoria", "lote", "FATURA"]],
  ];

  for (const [message, fragments] of cases) {
    const result = sanitizeDiagnosticValue(message);
    assert.equal(result, "[LOCAL REDIGIDO]");
    for (const fragment of fragments) {
      assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
    }
  }
});

test("redacao de caminho sem extensao preserva conectores de causa reconhecidos", () => {
  const cases = [
    ["Não abriu C:\\Temp porque a pasta não existe.", "Não abriu [LOCAL REDIGIDO] porque a pasta não existe."],
    ["/tmp/cache indisponível porque faltou permissão", "[LOCAL REDIGIDO] indisponível porque faltou permissão"],
  ];

  for (const [message, expected] of cases) assert.equal(sanitizeDiagnosticValue(message), expected);
});

test("redacao mantem pontuacao e conjuncao em listas de documentos", () => {
  const result = sanitizeDiagnosticValue(
    "Falharam FATURA 9927 org.pdf, FATURA 6805 org.PDF e CARTÃO PRATICO 01-26.pdf; revise os arquivos.",
  );

  assert.equal(
    result,
    "Falharam [ARQUIVO REDIGIDO], [ARQUIVO REDIGIDO] e [ARQUIVO REDIGIDO]; revise os arquivos.",
  );
  for (const fragment of ["FATURA", "9927", "6805", "org.pdf", "org.PDF", "CARTÃO", "PRATICO", "01-26.pdf"]) {
    assert.equal(result.includes(fragment), false, `fragmento vazou: ${fragment}`);
  }
});

test("redacao nao altera mensagens tecnicas comuns sem referencia documental", () => {
  const messages = [
    "A API retornou status 500 e versão 1.2.3.",
    "O módulo parser falhou na etapa validate.",
    "Falha HTTP em api.exemplo.com porque a conexão expirou.",
  ];

  for (const message of messages) assert.equal(sanitizeDiagnosticValue(message), message);
});

test("redacao de diagnostico permanece idempotente", () => {
  const message = "Falha ao abrir FATURA 9927 org.pdf e C:\\Users\\Financeiro\\Downloads\\FATURA 6805 org.PDF por formato inválido.";
  const once = sanitizeDiagnosticValue(message);

  assert.equal(sanitizeDiagnosticValue(once), once);
});

test("createErrorReporter limita Estavel e entrega detalhes redigidos apenas ao Laboratorio", async () => {
  const stableEvents = [];
  const stableConsole = [];
  const stable = createErrorReporter({
    isLab: false,
    record: async event => stableEvents.push(event),
    consoleObj: { error: value => stableConsole.push(value) },
  });
  const stableMessage = await stable.report(
    Object.assign(new Error("Falha em C:\\Users\\Maria\\FATURA 9927 org.pdf"), { code: "WORD_UNAVAILABLE" }),
    { tool: "word-pdf", stage: "convert" },
  );
  assert.match(stableMessage, /Código: WORD_UNAVAILABLE/);
  assert.equal(stableMessage.includes("Maria"), false);
  assert.deepEqual(stableEvents[0].technical, null);
  assert.equal(stableConsole.length, 0);

  const labEvents = [];
  const labConsole = [];
  const laboratory = createErrorReporter({
    isLab: true,
    record: async event => labEvents.push(event),
    consoleObj: { error: value => labConsole.push(value) },
  });
  await laboratory.report(new Error("Falha em FATURA 9927 org.pdf"), { tool: "pdf-ofx", stage: "parse" });
  assert.equal(JSON.stringify(labEvents).includes("FATURA"), false);
  assert.equal(JSON.stringify(labConsole).includes("FATURA"), false);
  assert.match(labEvents[0].technical.message, /\[ARQUIVO REDIGIDO\]/);
});

test("createErrorReporter relaciona a falha ao lote e a posicao na fila", async () => {
  const events = [];
  const reporter = createErrorReporter({ isLab: true, record: async event => events.push(event), consoleObj: { error() {} } });

  await reporter.report(new Error("Nenhum lançamento encontrado."), {
    tool: "pdf-ofx",
    stage: "queue-item",
    executionId: "run-42",
    queuePosition: 2,
    queueTotal: 5,
  });

  assert.equal(events[0].metadata.executionId, "run-42");
  assert.equal(events[0].metadata.queuePosition, 2);
  assert.equal(events[0].metadata.queueTotal, 5);
});

test("detalhes de sucesso ocultam campos tecnicos inexistentes", async () => {
  const harness = createControllerHarness({ events: [{
    id: "success-1",
    level: "info",
    code: "TOOL_RUN_COMPLETED",
    tool: "pdf-ofx",
    stage: "finish",
    message: "Processamento concluído.",
    technical: null,
    metadata: { executionId: "run-42", retryable: false, toolId: "pdf-ofx" },
  }] });

  createLaboratoryController(harness);
  await harness.documentObj.getElementById("diagnosticsButton").dispatch("click");
  await harness.documentObj.getElementById("diagnosticsList").children[0].dispatch("click");
  const text = harness.documentObj.getElementById("diagnosticsDetails").textContent;

  assert.doesNotMatch(text, /Causa/);
  assert.doesNotMatch(text, /Local/);
});

test("createLaboratoryController exerce modal foco filtros detalhes copiar exportar limpar e retry", async () => {
  const harness = createControllerHarness();
  const controller = createLaboratoryController(harness);
  const open = harness.documentObj.getElementById("diagnosticsButton");
  const close = harness.documentObj.getElementById("diagnosticsClose");

  await open.dispatch("click");
  assert.equal(harness.dialog.showModalCalls, 1);
  assert.equal(harness.documentObj.activeElement, close);
  assert.match(harness.documentObj.getElementById("diagnosticsStatus").textContent, /1 evento/);

  const row = harness.documentObj.getElementById("diagnosticsList").children[0];
  await row.dispatch("click");
  const details = harness.documentObj.getElementById("diagnosticsDetails");
  assert.match(details.textContent, /PDF_PARSE_FAILED/);
  assert.match(details.textContent, /Tabela inválida/);
  await details.findButton("Copiar diagnóstico").dispatch("click");
  assert.match(harness.calls.clipboard, /PDF_PARSE_FAILED/);
  await details.findButton("Tentar novamente").dispatch("click");
  assert.equal(harness.calls.dispatched[0].detail.toolId, "pdf-ofx");

  harness.documentObj.getElementById("diagnosticsTool").value = "word";
  await harness.documentObj.getElementById("diagnosticsTool").dispatch("input");
  assert.match(harness.documentObj.getElementById("diagnosticsList").textContent, /Nenhum evento/);
  harness.documentObj.getElementById("diagnosticsTool").value = "pdf";
  harness.documentObj.getElementById("diagnosticsLevel").value = "error";
  harness.documentObj.getElementById("diagnosticsExecution").value = "run-8";
  await harness.documentObj.getElementById("diagnosticsExecution").dispatch("input");
  assert.equal(harness.documentObj.getElementById("diagnosticsList").children.length, 1);

  await harness.documentObj.getElementById("diagnosticsExport").dispatch("click");
  assert.equal(harness.calls.export, 1);
  await harness.documentObj.getElementById("diagnosticsClear").dispatch("click");
  assert.equal(harness.calls.clear, 1);
  assert.match(harness.documentObj.getElementById("diagnosticsList").textContent, /Nenhum evento/);
  assert.equal(typeof controller.refresh, "function");
});

test("controlador real prende Tab e Shift Tab fecha por Esc retorna foco e nao duplica listeners", async () => {
  const harness = createControllerHarness();
  const first = createLaboratoryController(harness);
  const second = createLaboratoryController(harness);
  assert.equal(first, second);
  assert.equal(harness.documentObj.getElementById("diagnosticsButton").listeners.get("click").length, 1);

  const opener = harness.documentObj.getElementById("diagnosticsButton");
  await opener.dispatch("click");
  const focusable = harness.dialog.querySelectorAll();
  focusable.at(-1).focus();
  const tab = await harness.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(harness.documentObj.activeElement, focusable[0]);
  focusable[0].focus();
  const shiftTab = await harness.dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(shiftTab.defaultPrevented, true);
  assert.equal(harness.documentObj.activeElement, focusable.at(-1));
  const escape = await harness.dialog.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(harness.dialog.open, false);
  assert.equal(harness.documentObj.activeElement, opener);
});

test("falhas de clipboard exportacao e limpeza ficam controladas e registradas sem rejeicao", async () => {
  const recorded = [];
  const failure = new Error("Falha em C:\\Users\\Maria\\FATURA 9927 org.pdf");
  const harness = createControllerHarness({
    desktopApi: {
      diagnostics: {
        async list() { return [{
          id: "e", level: "error", code: "E", tool: "pdf", stage: "parse", message: "Falha",
          technical: {}, metadata: { retryable: false },
        }]; },
        async export() { throw failure; },
        async clear() { throw failure; },
        async record(event) { recorded.push(event); },
      },
    },
  });
  harness.navigatorObj.clipboard.writeText = async () => { throw failure; };
  createLaboratoryController(harness);
  await harness.documentObj.getElementById("diagnosticsButton").dispatch("click");
  await harness.documentObj.getElementById("diagnosticsList").children[0].dispatch("click");
  await harness.documentObj.getElementById("diagnosticsDetails").findButton("Copiar diagnóstico").dispatch("click");
  await harness.documentObj.getElementById("diagnosticsExport").dispatch("click");
  await harness.documentObj.getElementById("diagnosticsClear").dispatch("click");
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.match(harness.documentObj.getElementById("diagnosticsStatus").textContent, /Não foi possível/);
  assert.deepEqual(recorded.map(event => event.code), [
    "DIAGNOSTIC_COPY_FAILED", "DIAGNOSTIC_EXPORT_FAILED", "DIAGNOSTIC_CLEAR_FAILED",
  ]);
  assert.equal(JSON.stringify(recorded).includes("Maria"), false);
  assert.equal(JSON.stringify(recorded).includes("FATURA"), false);
});

test("initializeDesktopExperience preserva web e nao cria painel no Estavel", async () => {
  const webDocument = createChannelDocument();
  const webWindow = { addEventListener() { throw new Error("não deve registrar listeners"); } };
  assert.deepEqual(await initializeDesktopExperience({ windowObj: webWindow, documentObj: webDocument }), { mode: "web" });

  const stableDocument = createChannelDocument();
  const listeners = [];
  const stableWindow = {
    docprontoDesktop: {
      async getAppInfo() { return { isLab: false, channel: "stable", appVersion: "2.0.0" }; },
      diagnostics: { async record() {} },
    },
    addEventListener(type) { listeners.push(type); },
  };
  const result = await initializeDesktopExperience({ windowObj: stableWindow, documentObj: stableDocument, consoleObj: { error() {} } });
  const repeated = await initializeDesktopExperience({ windowObj: stableWindow, documentObj: stableDocument, consoleObj: { error() {} } });
  assert.equal(result.mode, "stable");
  assert.equal(repeated.mode, "stable");
  assert.equal(stableDocument.elements.get("diagnosticsButton").hidden, true);
  assert.deepEqual(listeners.sort(), ["error", "unhandledrejection"]);
});

test("fluxos da aplicacao nao imprimem nem exibem erros tecnicos brutos", async () => {
  const source = await readFile(new URL("../../public/docpronto/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.error\s*\(/);
  assert.doesNotMatch(source, /showStatus\s*\(\s*error(?:\?\.)?\.message/);
  assert.doesNotMatch(source, /return\s+error(?:\?\.)?\.message/);
  assert.doesNotMatch(source, /technical:\s*\{\s*name:\s*error/);
  assert.match(source, /reportApplicationError\(error, \{ tool: "certificate", stage: "discovery" \}\)/);
  assert.match(source, /await reportApplicationError\(error, \{\s*tool: activeTool\?\.id/);
});
