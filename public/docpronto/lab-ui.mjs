const SENSITIVE_KEY = /(password|passphrase|pin|secret|token|private.?key|base64|document.?content|clipboard|signature|file.?name|file.?path|\bpath\b)/i;
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>]+/g;
const UNIX_PATH = /\/(?:Users|home|tmp|var|private|mnt)\/[^\r\n"'<>]+/g;
const FILE_NAME = /\b[^\s\\/:*?"<>|]+\.(?:pdf|docx?|xlsx?|csv|ofx|xml|txt|jpe?g|png|pfx|p12)\b/gi;
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

function sanitizeText(value) {
  return String(value)
    .replace(WINDOWS_PATH, "[LOCAL REDIGIDO]")
    .replace(UNIX_PATH, "[LOCAL REDIGIDO]")
    .replace(FILE_NAME, "[ARQUIVO REDIGIDO]")
    .slice(0, 8_000);
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
  const code = typeof error.code === "string" && error.code ? error.code : "OPERATION_FAILED";
  const known = ERROR_MESSAGES[code];
  return {
    summary: known?.summary || "A operação não foi concluída.",
    action: known?.action || "Confira o arquivo e tente novamente. Se o erro continuar, informe o código ao suporte.",
    code,
  };
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
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
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

export function createLaboratoryController({ desktopApi, documentObj = document, windowObj = window, navigatorObj = navigator } = {}) {
  const dialog = documentObj.getElementById("diagnosticsPanel");
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

  const announce = (message, isError = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

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
      await navigatorObj.clipboard.writeText(JSON.stringify(item, null, 2));
      announce("Diagnóstico redigido copiado.");
    });
    actions.append(copy);
    if (item.retryable) {
      const retry = documentObj.createElement("button");
      retry.type = "button";
      retry.className = "primary-button compact-button";
      retry.textContent = "Tentar novamente";
      retry.addEventListener("click", () => {
        dialog.close();
        windowObj.dispatchEvent(new CustomEvent("docpronto:retry-tool", { detail: { toolId: item.toolId } }));
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
    const destination = await desktopApi.diagnostics.export();
    announce(destination ? "Pacote de diagnóstico exportado." : "Exportação cancelada.");
  });
  documentObj.getElementById("diagnosticsClear")?.addEventListener("click", async () => {
    await desktopApi.diagnostics.clear();
    events = [];
    selected = null;
    renderList();
    announce("Histórico de diagnóstico apagado.");
  });
  bindAccessibleDiagnosticDialog(dialog, () => opener);

  return { refresh, renderList, renderDetails };
}

async function initializeDesktopExperience() {
  const desktopApi = window.docprontoDesktop;
  if (!desktopApi) return;
  let appInfo;
  try {
    appInfo = await desktopApi.getAppInfo();
  } catch {
    return;
  }
  const isLab = applyDesktopChannel(appInfo);
  const record = createDiagnosticRecorder(desktopApi);
  window.docProntoLaboratory = Object.freeze({
    appInfo,
    record,
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
  if (isLab) createLaboratoryController({ desktopApi });
  window.addEventListener("error", event => record({
    level: "error",
    tool: "renderer",
    stage: "unhandled-error",
    code: "RENDERER_UNHANDLED_ERROR",
    message: "Ocorreu um erro inesperado na interface.",
    technical: { name: event.error?.name, message: event.error?.message, stack: event.error?.stack },
  }));
  window.addEventListener("unhandledrejection", event => record({
    level: "error",
    tool: "renderer",
    stage: "unhandled-rejection",
    code: "RENDERER_UNHANDLED_REJECTION",
    message: "Uma operação da interface terminou com erro inesperado.",
    technical: { name: event.reason?.name, message: event.reason?.message, stack: event.reason?.stack },
  }));
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void initializeDesktopExperience();
}
