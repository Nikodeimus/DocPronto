const SENSITIVE_KEY = /(password|passphrase|pin|secret|token|private.?key|base64|document.?content|clipboard|signature|file.?name|file.?path|\bpath\b)/i;
const DOCUMENT_EXTENSIONS = Object.freeze([
  ".docx", ".xlsx", ".jpeg", ".pdf", ".doc", ".xls", ".csv", ".ofx", ".xml", ".txt", ".jpg", ".png", ".pfx", ".p12",
]);
const PATH_EXTENSIONS = Object.freeze([
  ...DOCUMENT_EXTENSIONS, ".exe", ".dll", ".js", ".mjs", ".cjs", ".json", ".wasm", ".html", ".css", ".map",
]);
const PATH_END = new Set(["\r", "\n", "\"", "'", "<", ">", "|", ",", ";"]);
const FILE_START = new Set(["\r", "\n", "\"", "'", "<", ">", "|", ",", ";", ":", "=", "/", "\\"]);
const FILENAME_MARKERS = new Set([
  "abrir", "abriu", "arquivo", "arquivos", "assinar", "assinou", "carregar", "carregou", "converter", "converteu",
  "documento", "documentos", "exportar", "exportou", "falharam", "falhou", "importar", "importou", "ler", "leu",
  "processar", "processou", "salvar", "salvou",
]);
const LIST_CONJUNCTIONS = new Set(["e", "nem", "ou"]);
const ERROR_MESSAGES = Object.freeze({
  WORD_UNAVAILABLE: {
    summary: "A conversão não foi concluída.",
    action: "Verifique se o Microsoft Word está instalado e tente novamente.",
  },
  CERTIFICATE_NOT_FOUND: {
    summary: "A assinatura digital não foi concluída.",
    action: "Conecte ou instale o certificado e tente novamente.",
  },
  INVALID_CERTIFICATE: {
    summary: "O certificado selecionado não pôde ser usado.",
    action: "Escolha um certificado válido e tente novamente.",
  },
  LOCAL_OPERATION_TIMEOUT: {
    summary: "A operação local demorou mais do que o esperado.",
    action: "Feche outros programas pesados e tente novamente.",
  },
});

function isWindowsPathStart(text, index) {
  return (/[A-Za-z]/.test(text[index] || "") && text[index + 1] === ":" && /[\\/]/.test(text[index + 2] || ""))
    || (text[index] === "\\" && text[index + 1] === "\\");
}

function isPersonalPosixPathStart(text, index) {
  return ["/Users/", "/home/", "/tmp/", "/var/", "/private/", "/mnt/"].some(prefix => text.startsWith(prefix, index));
}

function redactPaths(value) {
  const text = String(value);
  const lowerText = text.toLocaleLowerCase("pt-BR");
  let result = "";
  for (let index = 0; index < text.length;) {
    if (!isWindowsPathStart(text, index) && !isPersonalPosixPathStart(text, index)) {
      result += text[index];
      index += 1;
      continue;
    }
    const extension = findNextExtension(lowerText, index, PATH_EXTENSIONS);
    let end = extension ? extension.index + extension.extension.length : index;
    while (!extension && end < text.length && !PATH_END.has(text[end])) end += 1;
    result += "[LOCAL REDIGIDO]";
    index = end;
  }
  return result;
}

function findNextExtension(lowerText, fromIndex, extensions) {
  let match = null;
  for (const extension of extensions) {
    const index = lowerText.indexOf(extension, fromIndex);
    if (index < 0) continue;
    const end = index + extension.length;
    const following = lowerText[end];
    if (following && /[a-z0-9]/i.test(following)) continue;
    if (!match || index < match.index || (index === match.index && extension.length > match.extension.length)) {
      match = { index, extension };
    }
  }
  return match;
}

function findNextDocumentExtension(lowerText, fromIndex) {
  return findNextExtension(lowerText, fromIndex, DOCUMENT_EXTENSIONS);
}

function isWordCharacter(character) {
  return Boolean(character) && /[\p{L}\p{N}_-]/u.test(character);
}

function scanWords(text, start, end) {
  const words = [];
  for (let index = start; index < end;) {
    if (!isWordCharacter(text[index])) {
      index += 1;
      continue;
    }
    const wordStart = index;
    while (index < end && isWordCharacter(text[index])) index += 1;
    words.push({
      start: wordStart,
      end: index,
      value: text.slice(wordStart, index).toLocaleLowerCase("pt-BR"),
    });
  }
  return words;
}

function skipWhitespace(text, index, end) {
  let cursor = index;
  while (cursor < end && /\s/u.test(text[cursor])) cursor += 1;
  return cursor;
}

function findDocumentNameStart(text, segmentStart, extensionIndex) {
  const words = scanWords(text, segmentStart, extensionIndex);
  if (!words.length) return extensionIndex;

  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (FILENAME_MARKERS.has(words[index].value)) {
      return skipWhitespace(text, words[index].end, extensionIndex);
    }
  }

  if (LIST_CONJUNCTIONS.has(words[0].value)) {
    return skipWhitespace(text, words[0].end, extensionIndex);
  }
  return words[0].start;
}

function redactDocumentNames(value) {
  const text = String(value);
  const lowerText = text.toLocaleLowerCase("pt-BR");
  let cursor = 0;
  let result = "";
  while (cursor < text.length) {
    const match = findNextDocumentExtension(lowerText, cursor);
    if (!match) {
      result += text.slice(cursor);
      break;
    }
    let segmentStart = match.index;
    while (segmentStart > cursor && !FILE_START.has(text[segmentStart - 1])) segmentStart -= 1;
    const start = findDocumentNameStart(text, segmentStart, match.index);
    result += text.slice(cursor, start);
    result += "[ARQUIVO REDIGIDO]";
    cursor = match.index + match.extension.length;
  }
  return result;
}

function sanitizeText(value) {
  return redactDocumentNames(redactPaths(value)).slice(0, 8_000);
}

function normalizeTechnicalError(error) {
  if (!error || typeof error !== "object") return { message: sanitizeText(error || "Erro não informado") };
  return sanitizeDiagnosticValue({
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
  });
}

function safeStackLocation(stack) {
  const frame = String(stack || "").split("\n").map(line => line.trim()).find(line => /^at\s/i.test(line));
  if (!frame) return "";
  const functionName = frame.match(/^at\s+([^\s(]+)/i)?.[1] || "código";
  const coordinates = frame.match(/:(\d+):(\d+)\)?$/);
  return `at ${sanitizeText(functionName)} ([LOCAL REDIGIDO]${coordinates ? `:${coordinates[1]}:${coordinates[2]}` : ""})`;
}

export function sanitizeDiagnosticValue(value, key = "") {
  if (SENSITIVE_KEY.test(key) && key !== "stack") return "[REDIGIDO]";
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDiagnosticValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeDiagnosticValue(childValue, childKey),
    ]));
  }
  return value;
}

export function applyDesktopChannel(appInfo, { documentObj = document } = {}) {
  const isLab = appInfo?.isLab === true;
  const badge = documentObj.getElementById("labBadge");
  const button = documentObj.getElementById("diagnosticsButton");
  const version = documentObj.getElementById("desktopVersion");
  if (badge) {
    badge.hidden = !isLab;
    badge.textContent = "LAB";
  }
  if (button) button.hidden = !isLab;
  if (version) version.textContent = appInfo?.appVersion ? `v${appInfo.appVersion}` : "";
  if (documentObj.body) {
    documentObj.body.dataset.desktopChannel = appInfo?.channel || (isLab ? "lab" : "stable");
    documentObj.body.classList.toggle("desktop-app", true);
  }
  return isLab;
}

export function createStableErrorMessage(error = {}) {
  const candidate = typeof error.code === "string" ? error.code.toUpperCase() : "";
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : "OPERATION_FAILED";
  const known = ERROR_MESSAGES[code];
  return {
    summary: known?.summary || "A operação não foi concluída.",
    action: known?.action || "Confira o arquivo e tente novamente. Se o erro continuar, informe o código ao suporte.",
    code,
  };
}

export function createErrorReporter({ isLab, record, consoleObj = console } = {}) {
  return Object.freeze({
    async report(error, context = {}) {
      const presentation = createStableErrorMessage({ code: error?.code || context.code });
      const technical = isLab ? normalizeTechnicalError(error) : null;
      const event = {
        level: "error",
        tool: context.tool || "aplicativo",
        stage: context.stage || "operation",
        code: presentation.code,
        message: presentation.summary,
        technical,
        metadata: { retryable: context.retryable === true, toolId: context.tool || "" },
      };
      await record?.(event);
      if (isLab) consoleObj?.error?.(sanitizeDiagnosticValue({
        code: presentation.code,
        tool: event.tool,
        stage: event.stage,
        technical,
      }));
      return `${presentation.summary} ${presentation.action} Código: ${presentation.code}`;
    },
  });
}

export function presentDiagnosticEvent(event = {}) {
  const sourceLocation = safeStackLocation(event.technical?.stack);
  const safe = sanitizeDiagnosticValue(event);
  const stackLines = String(safe.technical?.stack || "").split("\n").map(line => line.trim());
  const location = safe.technical?.location || sourceLocation
    || stackLines.find(line => /^at\s/i.test(line)) || "Local não informado";
  return {
    id: safe.id || "",
    timestamp: safe.timestamp || "",
    level: safe.level || "info",
    code: safe.code || "SEM_CODIGO",
    tool: safe.tool || "aplicativo",
    stage: safe.stage || "não informada",
    message: safe.message || "Evento sem resumo.",
    cause: safe.technical?.cause || safe.technical?.message || safe.technical?.name || "Causa técnica não informada.",
    location: sanitizeText(location),
    executionId: safe.metadata?.executionId || "",
    retryable: safe.metadata?.retryable === true,
    toolId: safe.metadata?.toolId || safe.tool || "",
    durationMs: Number.isFinite(safe.durationMs) ? safe.durationMs : null,
  };
}

export function bindAccessibleDiagnosticDialog(dialog, getTrigger) {
  if (!dialog) return;
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    const activeElement = dialog.ownerDocument?.activeElement;
    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("close", () => getTrigger()?.focus?.());
}

export function createDiagnosticRecorder(desktopApi) {
  let queue = Promise.resolve();
  return event => {
    const safeEvent = sanitizeDiagnosticValue(event);
    const location = safeStackLocation(event?.technical?.stack);
    if (location && safeEvent.technical && typeof safeEvent.technical === "object") {
      safeEvent.technical.location = location;
    }
    queue = queue.then(() => desktopApi.diagnostics.record(safeEvent)).catch(() => {});
    return queue;
  };
}

function setText(documentObj, parent, label, value, className = "") {
  const row = documentObj.createElement("p");
  if (className) row.className = className;
  const term = documentObj.createElement("strong");
  term.textContent = `${label}: `;
  row.append(term, documentObj.createTextNode(value));
  parent.append(row);
}

const CONTROLLERS = new WeakMap();

export function createLaboratoryController({ desktopApi, documentObj = document, windowObj = window, navigatorObj = navigator, record } = {}) {
  const dialog = documentObj.getElementById("diagnosticsPanel");
  if (CONTROLLERS.has(dialog)) return CONTROLLERS.get(dialog);
  const openButton = documentObj.getElementById("diagnosticsButton");
  const closeButton = documentObj.getElementById("diagnosticsClose");
  const list = documentObj.getElementById("diagnosticsList");
  const details = documentObj.getElementById("diagnosticsDetails");
  const status = documentObj.getElementById("diagnosticsStatus");
  const levelFilter = documentObj.getElementById("diagnosticsLevel");
  const toolFilter = documentObj.getElementById("diagnosticsTool");
  const executionFilter = documentObj.getElementById("diagnosticsExecution");
  let opener = null;
  let events = [];
  let selected = null;
  const recordFailure = record || createDiagnosticRecorder(desktopApi);

  const announce = (message, isError = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

  async function handleActionFailure(code, stage, message, error) {
    announce(message, true);
    await recordFailure({
      level: "error",
      tool: "diagnostics",
      stage,
      code,
      message,
      technical: normalizeTechnicalError(error),
      metadata: { retryable: true, toolId: "diagnostics" },
    });
  }

  function filteredEvents() {
    const level = levelFilter?.value || "";
    const tool = String(toolFilter?.value || "").toLocaleLowerCase("pt-BR");
    const execution = String(executionFilter?.value || "").toLocaleLowerCase("pt-BR");
    return events.filter(event => (!level || event.level === level)
      && (!tool || String(event.tool).toLocaleLowerCase("pt-BR").includes(tool))
      && (!execution || String(event.metadata?.executionId || "").toLocaleLowerCase("pt-BR").includes(execution)));
  }

  function renderDetails(event) {
    details.replaceChildren();
    if (!event) {
      details.textContent = "Selecione um evento para ver os detalhes técnicos redigidos.";
      return;
    }
    const item = presentDiagnosticEvent(event);
    const heading = documentObj.createElement("h3");
    heading.textContent = item.code;
    details.append(heading);
    setText(documentObj, details, "Resumo", item.message);
    setText(documentObj, details, "Ferramenta", item.tool);
    setText(documentObj, details, "Etapa", item.stage);
    setText(documentObj, details, "Causa", item.cause);
    setText(documentObj, details, "Local", item.location, "diagnostic-location");
    if (item.durationMs !== null) setText(documentObj, details, "Duração", `${item.durationMs} ms`);
    const actions = documentObj.createElement("div");
    actions.className = "diagnostic-detail-actions";
    const copy = documentObj.createElement("button");
    copy.type = "button";
    copy.className = "secondary-button compact-button";
    copy.textContent = "Copiar diagnóstico";
    copy.addEventListener("click", async () => {
      try {
        await navigatorObj.clipboard.writeText(JSON.stringify(item, null, 2));
        announce("Diagnóstico redigido copiado.");
      } catch (error) {
        await handleActionFailure("DIAGNOSTIC_COPY_FAILED", "copy", "Não foi possível copiar o diagnóstico.", error);
      }
    });
    actions.append(copy);
    if (item.retryable) {
      const retry = documentObj.createElement("button");
      retry.type = "button";
      retry.className = "primary-button compact-button";
      retry.textContent = "Tentar novamente";
      retry.addEventListener("click", () => {
        dialog.close();
        windowObj.dispatchEvent(new windowObj.CustomEvent("docpronto:retry-tool", { detail: { toolId: item.toolId } }));
      });
      actions.append(retry);
    }
    details.append(actions);
  }

  function renderList() {
    list.replaceChildren();
    const visible = filteredEvents();
    if (!visible.length) {
      const empty = documentObj.createElement("p");
      empty.className = "diagnostics-empty";
      empty.textContent = "Nenhum evento encontrado com estes filtros.";
      list.append(empty);
      renderDetails(null);
      return;
    }
    for (const event of [...visible].reverse()) {
      const item = presentDiagnosticEvent(event);
      const button = documentObj.createElement("button");
      button.type = "button";
      button.className = "diagnostic-row";
      button.dataset.level = item.level;
      button.setAttribute("aria-pressed", String(selected?.id === event.id));
      const title = documentObj.createElement("strong");
      title.textContent = item.code;
      const meta = documentObj.createElement("span");
      meta.textContent = `${item.tool} · ${item.stage}`;
      const message = documentObj.createElement("span");
      message.textContent = item.message;
      button.append(title, meta, message);
      button.addEventListener("click", () => {
        selected = event;
        renderList();
        renderDetails(event);
      });
      list.append(button);
    }
    if (selected && visible.some(event => event.id === selected.id)) renderDetails(selected);
  }

  async function refresh() {
    try {
      events = await desktopApi.diagnostics.list({ limit: 200 });
      renderList();
      announce(`${events.length} evento${events.length === 1 ? "" : "s"} no histórico recente.`);
    } catch {
      announce("Não foi possível carregar o histórico de diagnóstico.", true);
    }
  }

  openButton?.addEventListener("click", async () => {
    opener = openButton;
    await refresh();
    dialog.showModal();
    closeButton?.focus();
  });
  closeButton?.addEventListener("click", () => dialog.close());
  for (const filter of [levelFilter, toolFilter, executionFilter]) filter?.addEventListener("input", renderList);
  documentObj.getElementById("diagnosticsRefresh")?.addEventListener("click", refresh);
  documentObj.getElementById("diagnosticsExport")?.addEventListener("click", async () => {
    try {
      const destination = await desktopApi.diagnostics.export();
      announce(destination ? "Pacote de diagnóstico exportado." : "Exportação cancelada.");
    } catch (error) {
      await handleActionFailure("DIAGNOSTIC_EXPORT_FAILED", "export", "Não foi possível exportar o diagnóstico.", error);
    }
  });
  documentObj.getElementById("diagnosticsClear")?.addEventListener("click", async () => {
    try {
      await desktopApi.diagnostics.clear();
      events = [];
      selected = null;
      renderList();
      announce("Histórico de diagnóstico apagado.");
    } catch (error) {
      await handleActionFailure("DIAGNOSTIC_CLEAR_FAILED", "clear", "Não foi possível limpar o histórico.", error);
    }
  });
  bindAccessibleDiagnosticDialog(dialog, () => opener);

  const controller = Object.freeze({ refresh, renderList, renderDetails });
  CONTROLLERS.set(dialog, controller);
  return controller;
}

const INITIALIZATIONS = new WeakMap();

async function initializeDesktopExperienceOnce({
  windowObj = window,
  documentObj = document,
  navigatorObj = navigator,
  consoleObj = console,
} = {}) {
  const desktopApi = windowObj.docprontoDesktop;
  if (!desktopApi) return { mode: "web" };
  let appInfo;
  try {
    appInfo = await desktopApi.getAppInfo();
  } catch {
    return;
  }
  const isLab = applyDesktopChannel(appInfo, { documentObj });
  const record = createDiagnosticRecorder(desktopApi);
  const reporter = createErrorReporter({ isLab, record, consoleObj });
  windowObj.docProntoLaboratory = Object.freeze({
    appInfo,
    record,
    reportError: (error, context) => reporter.report(error, context),
    recordToolEvent(stage, tool, extra = {}) {
      return record({
        level: extra.level || "info",
        tool: tool?.id || "unknown-tool",
        stage,
        code: extra.code || `TOOL_${stage.toUpperCase()}`,
        message: extra.message || "Operação local atualizada.",
        technical: extra.technical || null,
        durationMs: extra.durationMs,
        metadata: {
          executionId: extra.executionId,
          fileCount: extra.fileCount,
          retryable: extra.retryable === true,
          toolId: tool?.id || "",
        },
      });
    },
    stableError: createStableErrorMessage,
  });
  if (isLab) createLaboratoryController({ desktopApi, documentObj, windowObj, navigatorObj, record });
  windowObj.addEventListener("error", event => record({
    level: "error",
    tool: "renderer",
    stage: "unhandled-error",
    code: "RENDERER_UNHANDLED_ERROR",
    message: "Ocorreu um erro inesperado na interface.",
    technical: { name: event.error?.name, message: event.error?.message, stack: event.error?.stack },
  }));
  windowObj.addEventListener("unhandledrejection", event => record({
    level: "error",
    tool: "renderer",
    stage: "unhandled-rejection",
    code: "RENDERER_UNHANDLED_REJECTION",
    message: "Uma operação da interface terminou com erro inesperado.",
    technical: { name: event.reason?.name, message: event.reason?.message, stack: event.reason?.stack },
  }));
  return { mode: isLab ? "lab" : "stable" };
}

export function initializeDesktopExperience(options = {}) {
  const windowObj = options.windowObj ?? window;
  if (INITIALIZATIONS.has(windowObj)) return INITIALIZATIONS.get(windowObj);
  const initialization = initializeDesktopExperienceOnce({ ...options, windowObj });
  INITIALIZATIONS.set(windowObj, initialization);
  return initialization;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void initializeDesktopExperience();
}
