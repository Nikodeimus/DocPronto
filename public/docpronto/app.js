/* global PDFLib, JSZip, forge, docx, html2canvas */

const MAX_FILE_SIZE = 40 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_EXPANDED_SIZE = 180 * 1024 * 1024;
const MAX_OFX_QUEUE_FILES = 30;
const TOOL_LIBRARY_SOURCES = Object.freeze([
  "vendor/pdf-lib.min.js",
  "vendor/jszip.min.js",
  "vendor/forge.min.js",
  "vendor/tesseract.min.js",
  "vendor/docx-preview.min.js",
  "vendor/html2canvas.min.js"
]);
let toolLibrariesPromise;

const tools = [
  { id: "merge-pdf", number: "01", category: "pdf", title: "Juntar PDF", description: "Combine vários PDFs na ordem selecionada.", accept: ".pdf", multiple: true, action: mergePdfs },
  { id: "extract-pdf", number: "02", category: "pdf", title: "Extrair páginas", description: "Crie um PDF apenas com as páginas escolhidas.", accept: ".pdf", multiple: false, option: "range", action: extractPdf },
  { id: "split-pdf", number: "03", category: "pdf", title: "Separar PDF", description: "Gere um arquivo ZIP com cada página separada.", accept: ".pdf", multiple: false, action: splitPdf },
  { id: "rotate-pdf", number: "04", category: "pdf", title: "Girar PDF", description: "Gire todas as páginas em 90, 180 ou 270 graus.", accept: ".pdf", multiple: false, option: "rotation", action: rotatePdf },
  { id: "watermark-pdf", number: "05", category: "pdf", title: "Marca d'água", description: "Aplique um texto discreto em todas as páginas.", accept: ".pdf", multiple: false, option: "watermark", action: watermarkPdf },
  { id: "image-pdf", number: "06", category: "documento", title: "Imagens para PDF", description: "Transforme imagens JPG ou PNG em um PDF.", accept: ".jpg,.jpeg,.png", multiple: true, action: imagesToPdf },
  { id: "text-pdf", number: "07", category: "documento", title: "TXT para PDF", description: "Converta um arquivo de texto em PDF paginado.", accept: ".txt", multiple: false, action: textToPdf },
  { id: "docx-text", number: "08", category: "documento", title: "DOCX para TXT", description: "Extraia o texto principal de um documento Word.", accept: ".docx", multiple: false, warning: "Elementos visuais, tabelas e estilos não são preservados na saída TXT.", action: docxToText },
  { id: "csv-xlsx", number: "09", category: "planilha", title: "CSV para XLSX", description: "Converta dados CSV em uma planilha Excel.", accept: ".csv", multiple: false, option: "delimiter", action: csvToXlsx },
  { id: "xlsx-csv", number: "10", category: "planilha", title: "XLSX para CSV", description: "Exporte a primeira aba da planilha para CSV.", accept: ".xlsx", multiple: false, option: "delimiter", warning: "Esta versão exporta a primeira aba e valores básicos. Fórmulas complexas podem usar o último valor salvo.", action: xlsxToCsv },
  { id: "ofx-csv", number: "11", category: "financeiro", title: "OFX para CSV", description: "Converta o extrato bancário em uma tabela compatível com planilhas.", accept: ".ofx", multiple: false, option: "ofx-delimiter", action: ofxToCsv },
  { id: "ofx-xlsx", number: "12", category: "financeiro", title: "OFX para XLSX", description: "Transforme as transações do OFX em uma planilha Excel.", accept: ".ofx", multiple: false, action: ofxToXlsx },
  { id: "ofx-summary", number: "13", category: "financeiro", title: "OFX para PDF", description: "Gere um PDF com saldos, entradas, saídas e transações.", accept: ".ofx", multiple: false, action: ofxToSummaryPdf },
  { id: "pdf-ofx", number: "14", category: "financeiro", title: "PDF para OFX", description: "Processe vários extratos e confira cada lançamento antes de gerar os OFXs.", accept: ".pdf", multiple: true, option: "pdf-ofx", warning: "A detecção automática pode errar datas, valores ou natureza do lançamento. Cada arquivo passa pela sua conferência antes de entrar no ZIP.", action: pdfToOfx },
  { id: "word-pdf", number: "15", category: "documento", title: "Word para PDF", description: "Reconstrua visualmente cada página do DOCX em PDF.", accept: ".docx", multiple: false, option: "word-pdf", warning: "O motor online preserva imagens, cabeçalhos, rodapés, tabelas e posições. Fontes que não existirem no dispositivo podem ser substituídas.", action: wordToPdf },
  { id: "pdf-word", number: "16", category: "documento", title: "PDF para Word", description: "Converta PDFs, inclusive digitalizações, em texto editável no Word usando OCR.", accept: ".pdf", multiple: false, option: "pdf-word", warning: "Em documentos escaneados, o OCR pode demorar alguns minutos. O modo de texto editável nunca insere a página como imagem.", action: pdfToWord },
  { id: "digital-sign", number: "17", category: "documento", title: "Assinatura digital com certificado", description: "Assine com certificado disponível no Windows ou arquivo A1.", accept: ".pdf,.docx,.xlsx,.txt,.csv,.ofx,.xml,.jpg,.jpeg,.png", multiple: false, option: "digital-sign", warning: "A validade depende do certificado, da cadeia de confiança e do software usado para validar o documento.", action: signWithDigitalCertificate },
  { id: "visual-sign", number: "18", category: "documento", title: "Inserir assinatura visual", description: "Adicione nome e aparência de assinatura a um PDF.", accept: ".pdf", multiple: false, option: "visual-sign", warning: "Esta opção apenas insere uma aparência visual. Ela não equivale a assinatura digital certificada.", action: insertVisualSignature },
  { id: "pdf-xml-abrasf", number: "19", category: "documento", title: "PDF para XML ABRASF", description: "Converta NFS-e de diferentes municípios em XML ABRASF 2.04 para importação contábil.", accept: ".pdf", multiple: false, option: "pdf-xml-abrasf", warning: "O XML é reconstruído a partir do documento auxiliar e não substitui o arquivo fiscal original assinado pelo município.", action: pdfToAbrasfXml }
];

const elements = {
  grid: document.querySelector("#toolsGrid"),
  search: document.querySelector("#toolSearch"),
  resultCount: document.querySelector("#toolResultCount"),
  empty: document.querySelector("#toolsEmpty"),
  dialog: document.querySelector("#toolDialog"),
  fileInput: document.querySelector("#fileInput"),
  fileList: document.querySelector("#fileList"),
  dropZone: document.querySelector("#dropZone"),
  options: document.querySelector("#optionsPanel"),
  notice: document.querySelector("#toolNotice"),
  status: document.querySelector("#statusMessage"),
  process: document.querySelector("#processButton")
};

let activeTool = null;
let selectedFiles = [];
let isProcessing = false;
let activeTrigger = null;
let processingAbortController = null;
let activeFilter = "todos";
let ofxQueueItems = [];

renderTools();
bindNavigation();
bindUpload();
bindAccessibleDialogs();
filterTools("todos");
openToolFromHash();
window.addEventListener("docpronto:retry-tool", event => {
  const tool = tools.find(item => item.id === event.detail?.toolId);
  if (tool) openTool(tool, document.querySelector(`[data-tool="${tool.id}"]`));
});
window.requestAnimationFrame(() => {
  void window.docprontoDesktop?.signalReady?.();
  if (window.docprontoDesktop) void import("./lab-ui.mjs");
});

function renderTools() {
  elements.grid.innerHTML = tools.map(tool => `
    <button class="tool-card" data-tool="${tool.id}" data-category="${tool.category}">
      <span class="tool-number">${tool.number}</span>
      <span class="tool-arrow">↗</span>
      <h3>${tool.title}</h3>
      <p>${tool.description}</p>
    </button>
  `).join("");

  elements.grid.addEventListener("click", event => {
    const card = event.target.closest("[data-tool]");
    if (card) openTool(tools.find(tool => tool.id === card.dataset.tool), card);
  });
}

function bindNavigation() {
  document.querySelector("#exploreButton").addEventListener("click", () => {
    document.querySelector("#ferramentas").scrollIntoView({ behavior: "smooth" });
    window.setTimeout(() => elements.search.focus(), 450);
  });
  document.querySelectorAll("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      document.querySelector("#ferramentas").scrollIntoView({ behavior: "smooth" });
      filterTools(filter);
    });
  });
  elements.search.addEventListener("input", updateToolVisibility);
}

function filterTools(filter) {
  activeFilter = filter;
  document.querySelectorAll(".filter-button").forEach(button => {
    button.classList.toggle("active", button.dataset.filter === filter);
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
  updateToolVisibility();
}

function updateToolVisibility() {
  const query = normalizeSearchText(elements.search.value);
  let visibleCount = 0;

  document.querySelectorAll(".tool-card").forEach(card => {
    const tool = tools.find(item => item.id === card.dataset.tool);
    const matchesFilter = activeFilter === "todos" || card.dataset.category === activeFilter;
    const searchableText = normalizeSearchText(`${tool.title} ${tool.description} ${tool.category}`);
    const visible = matchesFilter && (!query || searchableText.includes(query));
    card.classList.toggle("hidden", !visible);
    if (visible) visibleCount += 1;
  });

  elements.resultCount.textContent = `${visibleCount} ${visibleCount === 1 ? "ferramenta" : "ferramentas"}`;
  elements.empty.hidden = visibleCount !== 0;
}

function bindUpload() {
  elements.dropZone.addEventListener("click", () => elements.fileInput.click());
  elements.dropZone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener("change", () => setFiles([...elements.fileInput.files]));
  ["dragenter", "dragover"].forEach(name => elements.dropZone.addEventListener(name, event => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach(name => elements.dropZone.addEventListener(name, event => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  }));
  elements.dropZone.addEventListener("drop", event => setFiles([...event.dataTransfer.files]));
  elements.fileList.addEventListener("click", event => {
    const remove = event.target.closest("[data-file-remove]");
    if (!remove || isProcessing) return;
    const index = Number(remove.dataset.fileRemove);
    selectedFiles.splice(index, 1);
    ofxQueueItems.splice(index, 1);
    renderFileList();
  });
  elements.process.addEventListener("click", processFiles);
  elements.dialog.addEventListener("click", event => {
    if (!isProcessing || !event.target.closest("[data-cancel]")) return;
    event.preventDefault();
    cancelCurrentProcessing();
  });
  elements.dialog.addEventListener("cancel", event => {
    if (isProcessing) {
      event.preventDefault();
      cancelCurrentProcessing();
    }
  });
  elements.dialog.addEventListener("close", resetDialog);
}

function bindAccessibleDialogs() {
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        if (isProcessing && dialog === elements.dialog) {
          event.preventDefault();
          cancelCurrentProcessing();
          return;
        }
        event.preventDefault();
        dialog.close("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter(element => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  });
}

function openTool(tool, trigger = document.activeElement) {
  if (!tool) return;
  activeTrigger = trigger instanceof HTMLElement ? trigger : null;
  activeTool = tool;
  selectedFiles = [];
  ofxQueueItems = [];
  document.querySelector("#dialogNumber").textContent = tool.number;
  document.querySelector("#dialogCategory").textContent = tool.category;
  document.querySelector("#dialogTitle").textContent = tool.title;
  document.querySelector("#dialogDescription").textContent = tool.description;
  const limit = tool.accept.includes(".docx") || tool.accept.includes(".xlsx") ? "12 MB" : "40 MB";
  document.querySelector("#acceptedTypes").textContent = `Aceita ${tool.accept.replaceAll(".", "").toUpperCase()} · máximo ${limit} por arquivo`;
  elements.fileInput.accept = tool.accept;
  elements.fileInput.multiple = tool.multiple;
  elements.process.textContent = tool.id === "pdf-ofx" ? "Processar fila" : "Processar arquivos";
  elements.notice.textContent = tool.warning || "";
  elements.notice.classList.toggle("visible", Boolean(tool.warning));
  renderOptions(tool.option);
  renderFileList();
  clearStatus();
  elements.dialog.showModal();
  history.replaceState(null, "", `#ferramenta/${tool.id}`);
  requestAnimationFrame(() => elements.fileInput.closest(".drop-zone")?.focus());
}

function resetDialog() {
  activeTool = null;
  selectedFiles = [];
  ofxQueueItems = [];
  elements.fileInput.value = "";
  elements.process.disabled = true;
  clearStatus();
  if (location.hash.startsWith("#ferramenta/")) history.replaceState(null, "", `${location.pathname}${location.search}`);
  activeTrigger?.focus();
  activeTrigger = null;
}

function openToolFromHash() {
  const match = location.hash.match(/^#ferramenta\/([a-z0-9-]+)$/i);
  if (!match) return;
  const tool = tools.find(item => item.id === match[1]);
  const trigger = document.querySelector(`[data-tool="${CSS.escape(match[1])}"]`);
  if (tool) openTool(tool, trigger);
}

async function setFiles(files) {
  clearStatus();
  const allowed = activeTool.accept.split(",").map(ext => ext.trim().toLowerCase());
  const candidates = files.filter(file => {
    const extension = `.${file.name.split(".").pop().toLowerCase()}`;
    const limit = [".docx", ".xlsx"].includes(extension) ? MAX_ARCHIVE_SIZE : MAX_FILE_SIZE;
    return allowed.includes(extension) && file.size > 0 && file.size <= limit && isMimeCompatible(file, extension);
  });
  const validations = await Promise.all(candidates.map(async file => ({ file, valid: await hasExpectedSignature(file) })));
  const valid = validations.filter(item => item.valid).map(item => item.file);
  if (valid.length !== files.length) {
    showStatus("Alguns arquivos foram ignorados por formato, assinatura ou tamanho incompatível.", true);
  } else if (!activeTool.multiple && valid.length > 1) {
    showStatus("Esta ferramenta aceita um arquivo por vez; somente o primeiro foi selecionado.", true);
  }
  if (activeTool.id === "pdf-ofx") {
    const existing = new Set(selectedFiles.map(file => `${file.name}|${file.size}|${file.lastModified}`));
    const combined = [...selectedFiles, ...valid.filter(file => !existing.has(`${file.name}|${file.size}|${file.lastModified}`))];
    selectedFiles = combined.slice(0, MAX_OFX_QUEUE_FILES);
    ofxQueueItems = selectedFiles.map((file, index) => ofxQueueItems[index]?.file === file
      ? ofxQueueItems[index]
      : { file, status: "queued", detail: "Na fila" });
    if (combined.length > MAX_OFX_QUEUE_FILES) showStatus(`A fila aceita até ${MAX_OFX_QUEUE_FILES} PDFs por vez.`, true);
  } else {
    selectedFiles = activeTool.multiple ? valid : valid.slice(0, 1);
  }
  elements.fileInput.value = "";
  renderFileList();
}

function renderFileList() {
  const isOfxQueue = activeTool?.id === "pdf-ofx";
  elements.fileList.classList.toggle("ofx-queue", isOfxQueue);
  elements.fileList.innerHTML = selectedFiles.map((file, index) => {
    if (!isOfxQueue) return `<div class="file-item"><span>${escapeHtml(file.name)}</span><small>${formatBytes(file.size)} · ${index + 1}</small></div>`;
    const item = ofxQueueItems[index] || { status: "queued", detail: "Na fila" };
    return `<div class="file-item queue-item ${escapeHtml(item.status)}" data-queue-index="${index}"><span class="queue-position">${index + 1}</span><span class="queue-file"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span><span class="queue-state" data-queue-state>${escapeHtml(item.detail)}</span><button class="file-remove" type="button" data-file-remove="${index}" aria-label="Remover ${escapeHtml(file.name)}" title="Remover">×</button></div>`;
  }).join("");
  elements.process.disabled = selectedFiles.length === 0;
  document.querySelector("#ofxQueueCount")?.replaceChildren(document.createTextNode(`${selectedFiles.length}/${MAX_OFX_QUEUE_FILES}`));
}

function renderOptions(type) {
  const templates = {
    range: `<label for="pageRange">Páginas ou intervalos</label><input id="pageRange" value="1" placeholder="Ex.: 1-3, 5, 8-10"><small>Use números separados por vírgula.</small>`,
    rotation: `<label for="rotation">Rotação</label><select id="rotation"><option value="90">90 graus</option><option value="180">180 graus</option><option value="270">270 graus</option></select>`,
    watermark: `<label for="watermark">Texto da marca d'água</label><input id="watermark" maxlength="80" value="CONFIDENCIAL"><label for="opacity">Opacidade</label><input id="opacity" type="range" min="0.1" max="0.8" step="0.1" value="0.25">`,
    delimiter: `<label for="delimiter">Separador do CSV</label><select id="delimiter"><option value=",">Vírgula (,)</option><option value=";">Ponto e vírgula (;)</option><option value="tab">Tabulação</option></select>`,
    "ofx-delimiter": `<label for="delimiter">Separador do CSV</label><select id="delimiter"><option value=";">Ponto e vírgula (;)</option><option value=",">Vírgula (,)</option><option value="tab">Tabulação</option></select><small>Datas, valores, documento, descrição, tipo e identificador serão exportados.</small>`,
    "pdf-ofx": `<div class="queue-meta"><span>Fila <strong id="ofxQueueCount">0/${MAX_OFX_QUEUE_FILES}</strong></span><span>Saída <strong>ZIP com OFXs</strong></span></div><label><input id="pdfUseOcr" type="checkbox" checked> Usar OCR automaticamente quando necessário</label><progress id="ofxQueueProgress" max="1" value="0" hidden></progress><small id="ofxQueueProgressText">Os arquivos serão processados na ordem da fila.</small>`,
    "pdf-word": `<label for="pdfWordMode">Modo de conversão</label><select id="pdfWordMode"><option value="editable-layout">Documento oficial — fiel e editável (recomendado)</option><option value="fast">Somente o texto editável</option><option value="visual">Cópia visual exata (imagem)</option></select><small>O modo recomendado preserva carimbos, logotipos, códigos, validações e rodapés como elementos gráficos, enquanto reconstrói o corpo do documento como texto editável nas posições originais.</small>`,
    "word-pdf": `<label for="wordPdfMode">Modo de conversão</label><select id="wordPdfMode"><option value="online">Online — reconstrução visual completa (recomendado)</option><option value="office">Microsoft Word — fidelidade máxima (somente aplicativo local)</option></select><small>Fluxo reverso em etapas: leitura do Word, reconstrução das páginas, captura visual e auditoria do PDF.</small>`,
    "digital-sign": `<label for="signatureMode">Origem do certificado</label><select id="signatureMode"><option value="certificate">Arquivo A1 (.pfx/.p12) — assinatura separada .p7s</option><option value="installed">Certificado instalado no Windows — PDF com assinatura embutida</option></select><div class="sign-mode-panel" data-sign-mode="installed" hidden><div class="notice visible">Os certificados instalados são acessados diretamente pelo aplicativo DOCPronto para Windows. A chave privada permanece protegida pelo Windows e não é extraída.</div><label for="certificateSearch">Buscar certificado</label><input id="certificateSearch" type="search" placeholder="Nome ou validade"><label for="windowsCertificate">Certificado instalado</label><div class="inline-option"><select id="windowsCertificate"><option value="">Clique em carregar certificados</option></select><button class="secondary-button compact-button" type="button" id="loadWindowsCertificates">Carregar certificados</button></div><small>PDFs recebem assinatura digital embutida. Nos outros formatos, a assinatura é entregue como arquivo .p7s.</small></div><div class="sign-mode-panel" data-sign-mode="certificate"><label for="certificateFile">Certificado A1 (.pfx ou .p12)</label><input id="certificateFile" type="file" accept=".pfx,.p12,application/x-pkcs12"><label for="certificatePassword">Senha do arquivo A1</label><input id="certificatePassword" type="password" autocomplete="off" placeholder="Senha do A1"><small>O modo A1 local gera uma assinatura separada .p7s, inclusive para PDFs. A senha é usada somente na memória desta página.</small></div><small>Escolha o modo conforme o formato de assinatura que o sistema de destino aceita.</small>`,
    "visual-sign": `<label for="writtenSignature">Nome que aparecerá no PDF</label><input id="writtenSignature" maxlength="90" autocomplete="name" placeholder="Ex.: Altair Heitor Martins Palin"><small>Na próxima etapa, escolha a página e a posição da aparência visual.</small>`,
    "pdf-xml-abrasf": `<div class="notice visible">O motor reconhece layouts de Barueri, São José do Rio Preto e DANFSe/NFS-e Nacional, identifica prestador e tomador por seção, confere retenções e gera CompNfse ABRASF 2.04.</div><label><input id="abrasfStrictValidation" type="checkbox" checked> Bloquear o XML se os totais não fecharem</label><small>Municípios validados nesta versão: Barueri/SP, São José do Rio Preto/SP, Criciúma/SC e Novo Hamburgo/RS.</small>`
  };
  elements.options.innerHTML = templates[type] || "";
  if (type === "digital-sign") bindDigitalSignOptions();
}

function isMimeCompatible(file, extension) {
  if (!file.type) return true;
  const expected = {
    ".pdf": ["application/pdf"],
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"],
    ".jpeg": ["image/jpeg"],
    ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"],
    ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"],
    ".csv": ["text/csv", "text/plain", "application/vnd.ms-excel"],
    ".txt": ["text/plain"],
    ".xml": ["application/xml", "text/xml"],
    ".ofx": ["application/x-ofx", "text/plain", "application/octet-stream"]
  };
  return !expected[extension] || expected[extension].includes(file.type);
}

function bindDigitalSignOptions() {
  const mode = document.querySelector("#signatureMode");
  const installedOption = mode?.querySelector('option[value="installed"]');
  const updateMode = () => {
    document.querySelectorAll("[data-sign-mode]").forEach(panel => {
      panel.hidden = panel.dataset.signMode !== mode?.value;
    });
  };
  mode?.addEventListener("change", updateMode);
  updateMode();
  document.querySelector("#loadWindowsCertificates")?.addEventListener("click", () => {
    loadWindowsCertificates().catch(async error => {
      showStatus(await reportApplicationError(error, { tool: "certificate", stage: "discovery" }), true);
    });
  });
  document.querySelector("#certificateSearch")?.addEventListener("input", filterCertificateOptions);
  detectLocalCertificateBridge().then(certificates => {
    if (!installedOption || !certificates) return;
    installedOption.textContent = "Certificado instalado no Windows — aplicativo conectado";
    populateWindowsCertificates(certificates);
  });
}

async function processFiles() {
  if (!activeTool || !selectedFiles.length) return;
  const startedAt = performance.now();
  const executionId = globalThis.crypto?.randomUUID?.() || `run-${Date.now().toString(36)}`;
  const diagnosticContext = {
    executionId,
    fileCount: selectedFiles.length,
    retryable: true
  };
  isProcessing = true;
  processingAbortController = new AbortController();
  document.querySelectorAll("[data-cancel]").forEach(button => { button.disabled = false; });
  elements.fileList.querySelectorAll(".file-remove").forEach(button => { button.hidden = true; });
  elements.process.disabled = true;
  elements.process.textContent = "Processando...";
  showStatus("Processando localmente. Use Cancelar se quiser interromper com segurança.");
  recordToolDiagnostic("start", activeTool, {
    ...diagnosticContext,
    code: "TOOL_RUN_STARTED",
    message: "Processamento iniciado."
  });
  try {
    showStatus("Preparando os recursos locais...");
    await loadToolLibraries();
    throwIfProcessingCancelled();
    recordToolDiagnostic("progress", activeTool, {
      ...diagnosticContext,
      code: "TOOL_RUN_IN_PROGRESS",
      message: "A ferramenta iniciou a etapa principal."
    });
    const outcome = await activeTool.action(selectedFiles);
    throwIfProcessingCancelled();
    showStatus(outcome?.message || "Pronto. O download foi iniciado.");
    recordToolDiagnostic("finish", activeTool, {
      ...diagnosticContext,
      retryable: false,
      code: "TOOL_RUN_COMPLETED",
      message: "Processamento concluído.",
      durationMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      showStatus("Processamento cancelado. Nenhum arquivo incompleto foi baixado.");
      recordToolDiagnostic("finish", activeTool, {
        ...diagnosticContext,
        level: "warning",
        code: "TOOL_RUN_CANCELLED",
        message: "Processamento cancelado.",
        durationMs: Math.round(performance.now() - startedAt)
      });
    } else {
      showStatus(await reportApplicationError(error, {
        tool: activeTool?.id || "unknown-tool",
        stage: "finish",
        retryable: true
      }), true);
    }
  } finally {
    isProcessing = false;
    processingAbortController = null;
    document.querySelectorAll("[data-cancel]").forEach(button => { button.disabled = false; });
    elements.fileList.querySelectorAll(".file-remove").forEach(button => { button.hidden = false; });
    elements.process.disabled = false;
    elements.process.textContent = activeTool?.id === "pdf-ofx" ? "Processar fila" : "Processar arquivos";
  }
}

function loadToolLibraries() {
  if (toolLibrariesPromise) return toolLibrariesPromise;
  toolLibrariesPromise = Promise.all(TOOL_LIBRARY_SOURCES.map(source => new Promise((resolveLoad, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.addEventListener("load", resolveLoad, { once: true });
    script.addEventListener("error", () => reject(Object.assign(
      new Error(`Não foi possível carregar ${source}.`),
      { code: "LOCAL_LIBRARY_LOAD_FAILED" }
    )), { once: true });
    document.head.append(script);
  }))).catch(error => {
    toolLibrariesPromise = undefined;
    throw error;
  });
  return toolLibrariesPromise;
}

function recordToolDiagnostic(stage, tool, details) {
  window.docProntoLaboratory?.recordToolEvent(stage, tool, details);
}

async function mergePdfs(files) {
  const output = await PDFLib.PDFDocument.create();
  for (const file of files) {
    throwIfProcessingCancelled();
    const source = await PDFLib.PDFDocument.load(await file.arrayBuffer());
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach(page => output.addPage(page));
  }
  download(await output.save(), "pdfs-unidos.pdf", "application/pdf");
}

async function extractPdf([file]) {
  const source = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const indices = parsePageRange(document.querySelector("#pageRange").value, source.getPageCount());
  const output = await PDFLib.PDFDocument.create();
  const pages = await output.copyPages(source, indices);
  pages.forEach(page => output.addPage(page));
  download(await output.save(), `${baseName(file.name)}-paginas.pdf`, "application/pdf");
}

async function splitPdf([file]) {
  const source = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const zip = new JSZip();
  for (let index = 0; index < source.getPageCount(); index += 1) {
    throwIfProcessingCancelled();
    const output = await PDFLib.PDFDocument.create();
    const [page] = await output.copyPages(source, [index]);
    output.addPage(page);
    zip.file(`${baseName(file.name)}-pagina-${index + 1}.pdf`, await output.save());
  }
  download(await zip.generateAsync({ type: "blob" }), `${baseName(file.name)}-separado.zip`, "application/zip");
}

async function rotatePdf([file]) {
  const pdfDocument = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const amount = Number(window.document.querySelector("#rotation").value);
  pdfDocument.getPages().forEach(page => {
    const current = page.getRotation().angle || 0;
    page.setRotation(PDFLib.degrees((current + amount) % 360));
  });
  download(await pdfDocument.save(), `${baseName(file.name)}-girado.pdf`, "application/pdf");
}

async function watermarkPdf([file]) {
  const document = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const text = window.document.querySelector("#watermark").value.trim();
  const opacity = Number(window.document.querySelector("#opacity").value);
  if (!text) throw new Error("Digite o texto da marca d'água.");
  const font = await document.embedFont(PDFLib.StandardFonts.HelveticaBold);
  document.getPages().forEach(page => {
    const { width, height } = page.getSize();
    const size = Math.max(22, Math.min(58, width / 9));
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: (width - textWidth) / 2,
      y: height / 2,
      size,
      font,
      color: PDFLib.rgb(0.25, 0.3, 0.27),
      opacity,
      rotate: PDFLib.degrees(35)
    });
  });
  download(await document.save(), `${baseName(file.name)}-marca-dagua.pdf`, "application/pdf");
}

async function imagesToPdf(files) {
  const document = await PDFLib.PDFDocument.create();
  for (const file of files) {
    throwIfProcessingCancelled();
    const bytes = await file.arrayBuffer();
    const image = file.type === "image/png" || file.name.toLowerCase().endsWith(".png")
      ? await document.embedPng(bytes)
      : await document.embedJpg(bytes);
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const scale = Math.min(1, (pageWidth - 60) / image.width, (pageHeight - 60) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const page = document.addPage([pageWidth, pageHeight]);
    // Documents are read from the top down. Keep the image horizontally
    // centered, but anchor it to the top margin instead of floating it in the
    // vertical middle of the sheet.
    const topMargin = 28;
    page.drawImage(image, { x: (pageWidth - width) / 2, y: pageHeight - topMargin - height, width, height });
  }
  download(await document.save(), "imagens-convertidas.pdf", "application/pdf");
}

async function textToPdf([file]) {
  const text = await file.text();
  download(await createTextPdf(text), `${baseName(file.name)}.pdf`, "application/pdf");
}

async function wordToPdf([file]) {
  const mode = document.querySelector("#wordPdfMode")?.value || "online";
  if (mode === "online") {
    showStatus("Montando as páginas do Word com imagens, cabeçalhos e posições originais...");
    download(await createRenderedDocxPdf(file), `${baseName(file.name)}.pdf`, "application/pdf");
    return;
  }
  try {
    showStatus("Convertendo com o Microsoft Word para preservar o layout original...");
    const converted = await convertWithLocalOffice(file, "word-to-pdf");
    download(bytesFromBase64(converted.contentBase64), converted.filename || `${baseName(file.name)}.pdf`, "application/pdf");
  } catch (error) {
    throw Object.assign(new Error("A conversão local pelo Word não foi concluída.", { cause: error }), {
      code: error?.code || "WORD_UNAVAILABLE"
    });
  }
}

function cancelCurrentProcessing() {
  if (!processingAbortController || processingAbortController.signal.aborted) return;
  processingAbortController.abort();
  showStatus("Cancelando com segurança...");
}

function throwIfProcessingCancelled() {
  if (!processingAbortController?.signal.aborted) return;
  throw new DOMException("Processamento cancelado pelo usuário.", "AbortError");
}

async function createRenderedDocxPdf(file) {
  if (!window.docx?.renderAsync || !window.html2canvas) {
    throw new Error("O motor visual do Word não foi carregado. Atualize a página com Ctrl + F5 e tente novamente.");
  }
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-20000px",
    top: "0",
    width: "1000px",
    background: "white",
    zIndex: "-1"
  });
  document.body.appendChild(host);
  try {
    await window.docx.renderAsync(await file.arrayBuffer(), host, null, {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      useBase64URL: true
    });
    await document.fonts?.ready;
    const renderedPages = [...host.querySelectorAll("section.docx")];
    if (!renderedPages.length) throw new Error("O Word não produziu páginas renderizáveis.");
    const pdf = await PDFLib.PDFDocument.create();
    for (let index = 0; index < renderedPages.length; index += 1) {
      throwIfProcessingCancelled();
      showStatus(`Renderizando página ${index + 1} de ${renderedPages.length} com alta fidelidade...`);
      const section = renderedPages[index];
      const canvas = await window.html2canvas(section, {
        backgroundColor: "#ffffff",
        scale: 2,
        useCORS: true,
        logging: false,
        width: section.scrollWidth,
        height: section.scrollHeight,
        windowWidth: Math.max(1200, section.scrollWidth + 100),
        windowHeight: Math.max(1000, section.scrollHeight + 100)
      });
      const png = await pdf.embedPng(canvas.toDataURL("image/png"));
      const pageWidth = section.scrollWidth * 0.75;
      const pageHeight = section.scrollHeight * 0.75;
      const width = pageWidth;
      const height = pageHeight;
      const page = pdf.addPage([pageWidth, pageHeight]);
      page.drawImage(png, { x: 0, y: 0, width, height });
    }
    return pdf.save();
  } finally {
    host.remove();
  }
}

function normalizeRenderedDocxPage(section) {
  const normalizedText = value => String(value || "").replace(/\s+/g, " ").trim();
  const pageText = normalizedText(section.innerText);
  const isFinancialCover = /MOVIMENTO FINANCEIRO/i.test(pageText) && /PER[IÍ]ODO/i.test(pageText) && /Assinatura/i.test(pageText);
  if (!isFinancialCover) return;

  section.style.position = "relative";
  const candidates = [...section.querySelectorAll("p, div")].filter(element => normalizedText(element.innerText));
  const findSmallest = pattern => candidates
    .filter(element => pattern.test(normalizedText(element.innerText)))
    .sort((a, b) => a.querySelectorAll("p, div").length - b.querySelectorAll("p, div").length)[0];
  const place = (pattern, top, options = {}) => {
    const element = findSmallest(pattern);
    if (!element) return;
    // DOCX text boxes have different local coordinate systems. Absolute
    // positioning a paragraph inside its original box centers it against that
    // box, not against the page. Move the final text node to the page layer so
    // every cover label shares one axis.
    section.appendChild(element);
    const style = element.style;
    style.setProperty("position", "absolute", "important");
    style.setProperty("top", `${top}%`, "important");
    style.setProperty("left", options.left || "0", "important");
    style.setProperty("right", options.right || "auto", "important");
    style.setProperty("width", options.width || "100%", "important");
    style.setProperty("margin", "0", "important");
    style.setProperty("text-align", options.align || "center", "important");
    style.setProperty("box-sizing", "border-box", "important");
    style.setProperty("transform", "none", "important");
    style.setProperty("padding-left", "0", "important");
    style.setProperty("padding-right", "0", "important");
    style.setProperty("text-indent", "0", "important");
    style.setProperty("max-width", "none", "important");
    style.setProperty("z-index", "3", "important");
    [...element.querySelectorAll("span")].forEach(span => {
      span.style.setProperty("position", "static", "important");
      span.style.setProperty("left", "auto", "important");
      span.style.setProperty("right", "auto", "important");
      span.style.setProperty("margin-left", "0", "important");
      span.style.setProperty("margin-right", "0", "important");
      span.style.setProperty("padding-left", "0", "important");
      span.style.setProperty("padding-right", "0", "important");
      span.style.setProperty("transform", "none", "important");
    });
  };
  place(/^MOVIMENTO FINANCEIRO$/i, 20.5);
  place(/^Pessoa F[ií]sica$/i, 34.5);
  place(/^Conta(?:s)?\s+a?\s*Paga(?:r|s)?$/i, 45.2);
  place(/^PER[IÍ]ODO:?$/i, 55.5);
  place(/^\d{2}\/\d{4}$/i, 62.0);
  place(/^Assinatura/i, 82.0, { left: "26%", right: "auto", width: "50%", align: "left" });

  // Word stores the watermark as a floating drawing with transparency. Some
  // browser renderers preserve its geometry but drop the alpha value. Restore
  // that alpha only for large graphics in the central body, never for logos.
  const pageRect = section.getBoundingClientRect();
  [...section.querySelectorAll("img, svg")].forEach(graphic => {
    const rect = graphic.getBoundingClientRect();
    const relativeTop = (rect.top - pageRect.top) / Math.max(pageRect.height, 1);
    if (rect.width > pageRect.width * 0.42 && rect.height > pageRect.height * 0.24 && relativeTop > 0.08 && relativeTop < 0.68) {
      graphic.style.setProperty("opacity", "0.1", "important");
      graphic.style.setProperty("z-index", "1", "important");
    }
  });

  // A layout table in this cover can become a pale, page-wide rule above the
  // footer. It is not the signature rule: the genuine signature line is short.
  [...section.querySelectorAll("hr, p, div, table, tr, td")].forEach(element => {
    const rect = element.getBoundingClientRect();
    const relativeTop = (rect.top - pageRect.top) / Math.max(pageRect.height, 1);
    const computed = getComputedStyle(element);
    const thinRule = rect.height <= 8 || element.tagName.toLowerCase() === "hr";
    const hasBorder = parseFloat(computed.borderTopWidth) > 0 || parseFloat(computed.borderBottomWidth) > 0 || element.tagName.toLowerCase() === "hr";
    if (thinRule && hasBorder && rect.width > pageRect.width * 0.62 && relativeTop > 0.68 && relativeTop < 0.92) {
      element.style.setProperty("border-top", "0", "important");
      element.style.setProperty("border-bottom", "0", "important");
      element.style.setProperty("background", "transparent", "important");
    }
  });
}

async function createOnlineDocxPdf(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  validateArchive(zip, "word/document.xml");
  const xml = await requireZipEntry(zip, "word/document.xml").async("string");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const body = parsed.getElementsByTagNameNS("*", "body")[0];
  if (!body) throw new Error("O DOCX não contém um corpo de documento reconhecível.");
  const blocks = [];
  [...body.children].forEach(node => {
    if (node.localName === "p") {
      const text = [...node.getElementsByTagNameNS("*", "t")].map(item => item.textContent).join("");
      const alignment = node.getElementsByTagNameNS("*", "jc")[0]?.getAttribute("w:val") || node.getElementsByTagNameNS("*", "jc")[0]?.getAttribute("val") || "left";
      const bold = node.getElementsByTagNameNS("*", "b").length > 0;
      const pageBreak = [...node.getElementsByTagNameNS("*", "br")].some(item => (item.getAttribute("w:type") || item.getAttribute("type")) === "page");
      if (text.trim() || pageBreak) blocks.push({ type: "paragraph", text, alignment, bold, pageBreak });
    } else if (node.localName === "tbl") {
      const rows = [...node.children].filter(item => item.localName === "tr").map(row =>
        [...row.children].filter(item => item.localName === "tc").map(cell =>
          [...cell.getElementsByTagNameNS("*", "p")].map(paragraph =>
            [...paragraph.getElementsByTagNameNS("*", "t")].map(item => item.textContent).join("")
          ).filter(Boolean).join("\n")
        )
      );
      if (rows.length) blocks.push({ type: "table", rows });
    }
  });
  if (!blocks.length) throw new Error("Nenhum texto ou tabela foi encontrado no DOCX.");

  const pdf = await PDFLib.PDFDocument.create();
  const regular = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const pageWidth = 595.28, pageHeight = 841.89, margin = 42, contentWidth = pageWidth - margin * 2;
  let page, y;
  const newPage = () => { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; };
  const ensure = height => { if (!page || y - height < margin) newPage(); };
  const drawParagraph = block => {
    if (block.pageBreak && page) newPage();
    const size = block.bold ? 11 : 10;
    const font = block.bold ? boldFont : regular;
    const lines = wrapText(block.text || " ", Math.max(20, Math.floor(contentWidth / (size * 0.52))));
    ensure(Math.max(18, lines.length * 14 + 5));
    lines.forEach(line => {
      const safe = toWinAnsi(line);
      const measured = font.widthOfTextAtSize(safe, size);
      const x = block.alignment === "center" ? margin + Math.max(0, (contentWidth - measured) / 2)
        : block.alignment === "right" ? pageWidth - margin - measured : margin;
      page.drawText(safe, { x, y, size, font, color: PDFLib.rgb(0.06, 0.09, 0.08) });
      y -= 14;
    });
    y -= 5;
  };
  const drawTable = block => {
    const columnCount = Math.max(...block.rows.map(row => row.length), 1);
    const cellWidth = contentWidth / columnCount;
    for (const row of block.rows) {
      const wrapped = Array.from({ length: columnCount }, (_, index) => wrapText(row[index] || "", Math.max(8, Math.floor((cellWidth - 8) / 5))));
      const rowHeight = Math.max(22, ...wrapped.map(lines => lines.length * 11 + 8));
      ensure(rowHeight);
      wrapped.forEach((lines, column) => {
        const x = margin + column * cellWidth;
        page.drawRectangle({ x, y: y - rowHeight, width: cellWidth, height: rowHeight, borderWidth: 0.6, borderColor: PDFLib.rgb(0.55, 0.58, 0.56) });
        lines.forEach((line, index) => page.drawText(toWinAnsi(line), { x: x + 4, y: y - 12 - index * 11, size: 8, font: regular, color: PDFLib.rgb(0.06, 0.09, 0.08) }));
      });
      y -= rowHeight;
    }
    y -= 8;
  };
  newPage();
  blocks.forEach(block => block.type === "table" ? drawTable(block) : drawParagraph(block));
  return pdf.save();
}

async function pdfToWord([file]) {
  const mode = document.querySelector("#pdfWordMode")?.value || "editable-layout";
  if (mode === "editable-layout") {
    showStatus("Reconstruindo o documento com OCR e preservação visual...");
    download(await createEditableLayoutDocx(file), `${baseName(file.name)}-editavel.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return;
  }
  if (mode === "visual") {
    showStatus("Preservando cada página exatamente como aparece no PDF...");
    download(await createDocxFromPdfImages(file), `${baseName(file.name)}-copia-visual.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return;
  }
  const pages = await extractTextFromPdf(file, true);
  let text = pages.map(lines => lines.map(stripLayoutMarkers).join("\n")).join("\n\f\n");
  if (!text.trim()) {
    showStatus("PDF escaneado detectado. Executando OCR para gerar texto realmente editável...");
    text = await extractEditableTextWithOcr(file);
  }
  if (!text.trim()) throw new Error("O OCR não conseguiu reconhecer texto neste PDF. Tente uma digitalização com maior resolução.");
  showStatus("Montando o arquivo Word editável...");
  download(await createDocxFromText(text), `${baseName(file.name)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

async function extractEditableTextWithOcr(file) {
  if (!window.Tesseract) throw new Error("O módulo de OCR não foi carregado. Atualize a página e tente novamente.");
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfProcessingCancelled();
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3.2, 2700 / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      // Keep a small neutral margin instead of cropping for one specific
      // document family. Receipts, invoices and forms may use the full page.
      const cropX = Math.round(canvas.width * 0.025);
      const cropY = Math.round(canvas.height * 0.025);
      const cropWidth = Math.round(canvas.width * 0.95);
      const cropHeight = Math.round(canvas.height * 0.95);
      const ocrCanvas = document.createElement("canvas");
      ocrCanvas.width = cropWidth;
      ocrCanvas.height = cropHeight;
      const ocrContext = ocrCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
      ocrContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      improveOcrContrast(ocrContext, cropWidth, cropHeight);
      let result;
      try {
        result = await window.Tesseract.recognize(ocrCanvas, "por", {
          workerPath: "./vendor/tesseract-worker.min.js",
          corePath: "./vendor/tesseract-core/",
          langPath: "https://tessdata.projectnaptha.com/4.0.0/",
          tessedit_pageseg_mode: "6",
          preserve_interword_spaces: "1",
          logger: message => { throwIfProcessingCancelled(); showStatus(`OCR página ${pageNumber} de ${pdf.numPages}: ${message.status || "processando"} ${Math.round((message.progress || 0) * 100)}%`); }
        });
      } catch (error) {
        if (error?.name === "AbortError" || processingAbortController?.signal.aborted) {
          throw new DOMException("Processamento cancelado pelo usuário.", "AbortError");
        }
        throw new Error("Não foi possível executar o OCR. Verifique a conexão e tente novamente; o idioma português é baixado na primeira utilização.");
      }
      pageTexts.push(cleanEditableOcrText(result.data?.text || ""));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pageTexts.join("\n\f\n");
}

function improveOcrContrast(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = gray > 205 ? 255 : gray < 125 ? 0 : Math.round((gray - 125) * 3.18);
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
  context.putImageData(image, 0, 0);
}

function cleanEditableOcrText(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const cleaned = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      if (cleaned.length && cleaned[cleaned.length - 1] !== "") cleaned.push("");
      continue;
    }
    const useful = (line.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
    if (useful < 3 || useful / Math.max(line.length, 1) < 0.45) continue;
    if (/^(?:[|_~`'.,;:!%?()\[\]{}\\/-]\s*){2,}$/.test(line)) continue;
    cleaned.push(line);
  }
  while (cleaned[0] === "") cleaned.shift();
  while (cleaned[cleaned.length - 1] === "") cleaned.pop();
  const paragraphs = [];
  let current = "";
  const flush = () => {
    if (current.trim()) paragraphs.push(current.trim());
    current = "";
  };
  cleaned.forEach(line => {
    if (!line) { flush(); return; }
    const heading = line.length < 110 && /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ0-9ªº &.,–—-]+$/.test(line) && /[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ]{4}/.test(line);
    const beginsParagraph = /^(?:Cláusula|Parágrafo|Pelo presente|Único sócio|O sócio|Totalizando|ALT[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ ]{5,})\b/i.test(line);
    if (heading) {
      flush();
      paragraphs.push(line);
    } else if (beginsParagraph && current) {
      flush();
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  });
  flush();
  return paragraphs.join("\n\n");
}

async function createEditableLayoutDocx(file) {
  if (!window.Tesseract) throw new Error("O módulo de OCR não foi carregado. Atualize a página e tente novamente.");
  const rasterPages = await pdfRasterEngine(file);
  const extractedPages = await textExtractionEngine(rasterPages);
  const analyzedPages = documentDecisionEngine(extractedPages);
  const pages = await graphicPreservationEngine(analyzedPages);
  validateDocumentPipeline(pages);
  showStatus("Motor Word: montando o documento a partir dos dados já validados...");
  return wordConversionEngine(pages);
}

// MOTOR 1 — produces immutable page images and OCR regions. It never reads,
// erases or writes text.
async function pdfRasterEngine(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfProcessingCancelled();
      showStatus(`Motor de imagem: página ${pageNumber} de ${pdf.numPages}...`);
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3.2, 2700 / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const region = { x: Math.round(canvas.width * 0.025), y: Math.round(canvas.height * 0.025), width: Math.round(canvas.width * 0.95), height: Math.round(canvas.height * 0.95) };
      pages.push({ pageNumber, pageCount: pdf.numPages, canvas, region, pageWidth: base.width, pageHeight: base.height });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

// MOTOR 2 — extracts candidates only. It cannot modify the original image or
// create Word objects.
async function textExtractionEngine(rasterPages) {
  const pages = [];
  for (const rasterPage of rasterPages) {
    throwIfProcessingCancelled();
    const { canvas, region, pageNumber, pageCount } = rasterPage;
    const ocrCanvas = document.createElement("canvas");
    ocrCanvas.width = region.width;
    ocrCanvas.height = region.height;
    const context = ocrCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    improveOcrContrast(context, region.width, region.height);
    showStatus(`Motor de extração: página ${pageNumber} de ${pageCount}...`);
    let result;
    try {
      result = await window.Tesseract.recognize(ocrCanvas, "por", {
        workerPath: "./vendor/tesseract-worker.min.js",
        corePath: "./vendor/tesseract-core/",
        langPath: "https://tessdata.projectnaptha.com/4.0.0/",
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1",
        logger: message => { throwIfProcessingCancelled(); showStatus(`Motor de extração ${pageNumber}/${pageCount}: ${message.status || "OCR"} ${Math.round((message.progress || 0) * 100)}%`); }
      }, { text: true, blocks: true, tsv: true, hocr: true });
    } catch (error) {
      if (error?.name === "AbortError" || processingAbortController?.signal.aborted) {
        throw new DOMException("Processamento cancelado pelo usuário.", "AbortError");
      }
      throw new Error(`Motor de extração, página ${pageNumber}: não foi possível executar o OCR.`);
    }
    pages.push({
      ...rasterPage,
      candidates: ocrLayoutLines(result.data, canvas.width, canvas.height, region.x, region.y, region.width, region.height)
    });
  }
  return pages;
}

// MOTOR 3 — decides what is editable legal text, protected official artwork or
// OCR noise. It returns a data model; it does not touch pixels or OOXML.
function documentDecisionEngine(extractedPages) {
  return extractedPages.map(page => {
    const accepted = [];
    const protectedGraphics = [];
    const rejectedNoise = [];
    for (const candidate of page.candidates) {
      const decision = classifyOcrCandidate(candidate, page.pageNumber);
      if (decision === "protected") protectedGraphics.push(candidate);
      else if (decision === "noise") rejectedNoise.push(candidate);
      else accepted.push(candidate);
    }
    const blocks = documentAssemblyEngine(accepted);
    return { ...page, lines: accepted, blocks, protectedGraphics, rejectedNoise };
  });
}

function classifyOcrCandidate(candidate) {
  const text = cleanOcrLine(candidate.text);
  const meaningfulShort = isMeaningfulShortOcrText(text);
  const letters = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const useful = (text.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
  const suspicious = (text.match(/[|_=<>~`^*{}\[\]\\]/g) || []).length;
  if (!text || (!meaningfulShort && useful < 1) || candidate.confidence < 58) return "noise";
  if (!meaningfulShort && (suspicious > 1 || useful / Math.max(text.length, 1) < 0.55)) return "noise";
  if (text.length <= 3 && !meaningfulShort) return "noise";
  return meaningfulShort || letters || /\d/.test(text) ? "editable" : "noise";
}

function isMeaningfulShortOcrText(text) {
  const value = String(text || "").trim();
  return /^(?:\d{1,3}[ªº]?|R\$|UF|RG|CPF|CEP|ISS|IR|IPI|PIS|COFINS|INSS|CSLL|NF|NFS|SIM|NÃO)$/i.test(value);
}

// MOTOR 4 — removes only approved editable text rectangles. The previous
// implementation erased the whole central region and destroyed JUCESP stamps.
async function graphicPreservationEngine(analyzedPages) {
  const output = [];
  for (const page of analyzedPages) {
    throwIfProcessingCancelled();
    showStatus(`Motor gráfico: protegendo selos e reconstruindo a página ${page.pageNumber}...`);
    const canvas = document.createElement("canvas");
    canvas.width = page.canvas.width;
    canvas.height = page.canvas.height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(page.canvas, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Não foi possível produzir a camada gráfica.")), "image/png"));
    output.push({
      pageNumber: page.pageNumber,
      width: canvas.width,
      height: canvas.height,
      pageWidth: page.pageWidth,
      pageHeight: page.pageHeight,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      lines: page.lines,
      blocks: page.blocks,
      protectedGraphics: page.protectedGraphics,
      rejectedNoise: page.rejectedNoise
    });
  }
  return output;
}

// MOTOR 5 — serializes an already-approved page model. No OCR or classification
// is allowed from this point forward.
async function wordConversionEngine(pages) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", docxImageContentTypesXml());
  zip.folder("_rels").file(".rels", docxRootRelsXml());
  const word = zip.folder("word");
  word.file("document.xml", editableLayoutDocumentXml(pages));
  word.folder("_rels").file("document.xml.rels", docxImageRelsXml(pages.length));
  const media = word.folder("media");
  pages.forEach((page, index) => media.file(`page-${index + 1}.png`, page.bytes));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function validateDocumentPipeline(pages) {
  if (!pages.length) throw new Error("Nenhuma página foi processada.");
  pages.forEach((page, index) => {
    if (!page.bytes?.length) throw new Error(`Página ${index + 1}: a camada gráfica não foi produzida.`);
    if (!page.blocks?.length) return;
    const readable = page.blocks.filter(block => block.text.length >= 3 && block.confidence >= 55);
    if (!readable.length) throw new Error(`Página ${index + 1}: o OCR não atingiu confiança mínima.`);
    const firstY = Math.min(...readable.map(block => block.y));
    const lastY = Math.max(...readable.map(block => block.y + block.height));
    if (readable.length >= 8 && lastY - firstY < 842 * 0.18) {
      throw new Error(`Página ${index + 1}: o texto ficou comprimido e a conversão foi bloqueada.`);
    }
    const invalid = page.blocks.filter(block => !Number.isFinite(block.x) || !Number.isFinite(block.y) || !Number.isFinite(block.width) || !Number.isFinite(block.height));
    if (invalid.length) throw new Error(`Página ${index + 1}: o motor de decisão produziu coordenadas inválidas.`);
    const outOfPage = page.blocks.filter(block => block.x < 0 || block.y < 0 || block.x >= 595 || block.y >= 842);
    if (outOfPage.length) throw new Error(`Página ${index + 1}: há texto fora da área válida da página.`);
    const suspiciousBlocks = page.blocks.filter(block => isSuspiciousEditableText(block.text));
    if (suspiciousBlocks.length) throw new Error(`Página ${index + 1}: o motor de auditoria encontrou texto suspeito e bloqueou a conversão.`);
  });
}

function isSuspiciousEditableText(text) {
  const value = String(text || "").trim();
  const meaningfulShort = isMeaningfulShortOcrText(value);
  const useful = (value.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
  const punctuation = (value.match(/[|_=<>~`^*{}\[\]\\]/g) || []).length;
  if (!value || (!meaningfulShort && useful < 1)) return true;
  if (value.length <= 3 && !meaningfulShort) return true;
  return punctuation > Math.max(1, Math.floor(value.length * 0.04));
}

// PDF -> Word production line. Each engine consumes a normalized model and
// returns a stricter model for the next stage instead of writing OOXML early.
function documentAssemblyEngine(lines) {
  const cleaned = lines.map(line => ({ ...line, text: cleanOcrLine(line.text) })).filter(line => line.text);
  const heights = cleaned.map(line => line.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 9;
  const classified = cleaned.map(line => ({ ...line, role: classifyDocumentLine(line, medianHeight) }));
  const blocks = [];
  for (const line of classified) {
    const previous = blocks[blocks.length - 1];
    const lineBottom = line.y + line.height;
    const startsParagraph = Boolean(previous) && (
      line.role !== "body" ||
      line.y - previous.bottom > Math.max(medianHeight * 1.35, 12) ||
      Math.abs(line.x - previous.x) > 24 ||
      /[.!?:]$/.test(previous.text)
    );
    const canJoin = previous && line.role === "body" && previous.role === "body" && !startsParagraph &&
      line.y - previous.bottom < Math.max(medianHeight * 2.3, 18);
    if (canJoin) {
      previous.lines.push(line);
      previous.text = `${previous.text} ${line.text}`.replace(/\s+/g, " ").trim();
      previous.bottom = Math.max(previous.bottom, lineBottom);
      previous.width = Math.max(previous.width, line.x + line.width - previous.x);
      previous.confidence = Math.min(previous.confidence, line.confidence);
    } else {
      blocks.push({
        role: line.role,
        text: line.text,
        lines: [line],
        x: line.role === "heading" ? 58 : line.role === "financial-row" ? 38 : line.x,
        y: line.y,
        width: line.role === "heading" ? 479 : line.role === "financial-row" ? 477 : Math.min(510, line.width),
        bottom: lineBottom,
        confidence: line.confidence
      });
    }
  }
  return blocks.map(block => ({
    ...block,
    height: Math.max(14, block.bottom - block.y + (block.role === "body" ? medianHeight * 0.65 : 4)),
    fontSize: block.role === "heading" ? 11.5 : block.role === "footer" ? 7.5 : block.role === "financial-row" ? 9 : 9.2,
    alignment: block.role === "heading" ? "center" : block.role === "footer" ? "center" : block.role === "financial-row" ? "left" : "both",
    financial: block.role === "financial-row" ? parseFinancialRow(block.text) : null
  }));
}

function parseFinancialRow(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const amount = (text.match(/R\$\s*[\d.]+,\d{2}/i) || [""])[0].replace(/\s+/g, " ");
  const percentage = (text.match(/\d{1,3},\d{2}\s*%/i) || [""])[0].replace(/\s+/g, " ");
  let label = text;
  if (amount) label = label.slice(0, Math.max(0, label.indexOf(amount)));
  label = label.replace(/[.·_\s]+$/g, "").replace(/[^\p{L}\p{N}\s–—-]+$/gu, "").trim();
  if (/^Totalizando/i.test(text)) label = "Totalizando";
  return { label, amount, percentage };
}

function cleanOcrLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+[|$+]{1,2}$/g, "")
    .replace(/^[:;|]+\s*/, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\.\s*\?\s*$/g, ".")
    .trim();
}

function classifyDocumentLine(line, medianHeight) {
  const text = line.text.trim();
  if ((/R\$\s*[\d.]+,\d{2}/i.test(text) && /\d{1,3},\d{2}\s*%/i.test(text)) || /^Total\b/i.test(text)) return "financial-row";
  const uppercase = /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ0-9ªº\s&.,:()–—-]+$/.test(text) && /[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ]{4}/.test(text);
  if (uppercase && (text.length < 110 || line.height > medianHeight * 1.12)) return "heading";
  if (line.y > 780) return "footer";
  return "body";
}

function ocrLayoutLines(data, pageWidth, pageHeight, offsetX = 0, offsetY = 0, regionWidth = pageWidth, regionHeight = pageHeight) {
  const source = [];
  // Tesseract may run the recognition on an internally rescaled bitmap. Its
  // word boxes are then expressed in that bitmap's coordinate system, not in
  // the canvas dimensions we supplied. Read the authoritative OCR page bbox
  // and convert every box back to the original crop before placing it in Word.
  let ocrWidth = regionWidth;
  let ocrHeight = regionHeight;
  if (typeof data?.hocr === "string") {
    // Attribute order in hOCR is not stable. Parsing the page node is more
    // reliable than a regular expression and fixes the coordinate compression
    // seen in the five-page JUCESP regression document.
    const hocrDocument = new DOMParser().parseFromString(data.hocr, "text/html");
    const pageTitle = hocrDocument.querySelector(".ocr_page")?.getAttribute("title") || "";
    const pageMatch = /bbox\s+\d+\s+\d+\s+(\d+)\s+(\d+)/i.exec(pageTitle);
    if (pageMatch) {
      const detectedWidth = Number(pageMatch[1]);
      const detectedHeight = Number(pageMatch[2]);
      if (detectedWidth > 0 && detectedHeight > 0) {
        ocrWidth = detectedWidth;
        ocrHeight = detectedHeight;
      }
    }
  }
  const scaleX = regionWidth / Math.max(ocrWidth, 1);
  let scaleY = regionHeight / Math.max(ocrHeight, 1);
  const collect = node => {
    if (!node || typeof node !== "object") return;
    // A whole OCR line inside one Word text box is unstable: Word recalculates
    // its metrics and wraps the line, which caused the overlapping text seen
    // in the JUCESP test. Keep each OCR word as an independent positioned
    // object. A word cannot reflow into the next visual line.
    if (Array.isArray(node.words)) node.words.forEach(word => source.push(word));
    for (const key of ["blocks", "paragraphs", "lines"]) {
      if (Array.isArray(node[key])) node[key].forEach(collect);
    }
  };
  // hOCR preserves the actual line geometry of the recognition canvas. The
  // convenient data.blocks tree can contain coordinates from Tesseract's
  // internally reduced analysis image, which compressed the lower half of
  // the document in Word. Prefer hOCR lines and use blocks only as fallback.
  if (typeof data?.hocr === "string") {
    const parsed = new DOMParser().parseFromString(data.hocr, "text/html");
    parsed.querySelectorAll(".ocr_line").forEach(node => {
      const match = /bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i.exec(node.getAttribute("title") || "");
      if (!match) return;
      const wordConfidences = Array.from(node.querySelectorAll(".ocrx_word")).map(word => {
        const confidence = /x_wconf\s+(\d+)/i.exec(word.getAttribute("title") || "");
        return confidence ? Number(confidence[1]) : 80;
      });
      source.push({
        text: node.textContent.replace(/\s+/g, " ").trim(),
        confidence: wordConfidences.length ? wordConfidences.reduce((sum, value) => sum + value, 0) / wordConfidences.length : 80,
        bbox: { x0: Number(match[1]), y0: Number(match[2]), x1: Number(match[3]), y1: Number(match[4]) }
      });
    });
  }
  if (!source.length) collect(data);
  if (!source.length && typeof data?.tsv === "string") {
    const rows = data.tsv.split(/\r?\n/).slice(1).map(row => row.split("\t"));
    rows.filter(row => row[0] === "5" && row.length >= 12).forEach(row => {
      const x = Number(row[6]), y = Number(row[7]), width = Number(row[8]), height = Number(row[9]);
      source.push({
        text: row.slice(11).join("\t").trim(),
        confidence: Number(row[10]),
        bbox: { x0: x, y0: y, x1: x + width, y1: y + height }
      });
    });
  }
  if (!source.length && String(data?.text || "").trim()) {
    const lines = String(data.text).replace(/\r/g, "").split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    const step = Math.min(22, regionHeight / Math.max(lines.length + 2, 1));
    lines.forEach((text, index) => source.push({
      text,
      confidence: 70,
      bbox: { x0: 0, y0: index * step, x1: regionWidth, y1: index * step + step * 0.78 }
    }));
  }
  // Some Tesseract.js builds report the page at full height while line boxes
  // still use the reduced recognition bitmap. Detect that mismatch from the
  // occupied vertical range and restore it before converting pixels to points.
  const maximumSourceY = source.reduce((maximum, item) => Math.max(maximum, Number(item?.bbox?.y1 || 0)), 0);
  const normalizedMaximumY = maximumSourceY * scaleY;
  if (maximumSourceY > 0 && normalizedMaximumY < regionHeight * 0.72) {
    scaleY *= (regionHeight * 0.9) / normalizedMaximumY;
  }
  return source.map(line => {
    const box = line.bbox || {};
    return {
      text: String(line.text || "").trim(),
      confidence: Number(line.confidence ?? line.conf ?? 100),
      x: (Number(box.x0 || 0) * scaleX + offsetX) / pageWidth * 595,
      y: (Number(box.y0 || 0) * scaleY + offsetY) / pageHeight * 842,
      width: Math.max(10, Number((box.x1 || 0) - (box.x0 || 0)) * scaleX / pageWidth * 595),
      height: Math.max(7, Number((box.y1 || 0) - (box.y0 || 0)) * scaleY / pageHeight * 842)
    };
  }).filter(line => {
    if (!line.text || line.confidence < 55 || line.width <= 2 || line.height >= 45) return false;
    const useful = (line.text.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
    if (line.text.length <= 2 && useful <= 1) return false;
    return useful >= 1 && useful / Math.max(line.text.length, 1) >= 0.4;
  });
}

function editableLayoutDocumentXml(pages) {
  const pageXml = pages.map((page, pageIndex) => {
    const imageWidth = 7560945;
    const imageHeight = 10693440;
    const background = `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${imageWidth}" cy="${imageHeight}"/><wp:wrapNone/><wp:docPr id="${pageIndex + 1}" name="Página original ${pageIndex + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${pageIndex + 1}" name="page-${pageIndex + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${pageIndex + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${imageWidth}" cy="${imageHeight}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
    const overlays = (page.blocks || page.lines).map((line, lineIndex) => {
      if (page.blocks) {
        const fontSize = line.fontSize;
        const bold = line.role === "heading" ? "<w:b/>" : "";
        const italic = "";
        const justification = line.alignment === "center" ? "center" : line.alignment === "both" ? "both" : "left";
        const contentRightEdge = 565;
        const safeX = Math.min(line.x, contentRightEdge - 40);
        const availableWidth = Math.max(40, contentRightEdge - safeX);
        const boxWidth = Math.min(availableWidth, Math.max(80, line.width));
        const boxHeight = Math.max(line.height * 1.08, fontSize * 1.5);
        const runProperties = `<w:rPr>${bold}${italic}<w:noProof/><w:sz w:val="${Math.round(fontSize * 2)}"/><w:szCs w:val="${Math.round(fontSize * 2)}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>`;
        const financialContent = line.role === "financial-row" && line.financial
          ? `<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(line.financial.label)}</w:t><w:tab/><w:t>${escapeXml(line.financial.amount)}</w:t><w:tab/><w:t>${escapeXml(line.financial.percentage)}</w:t></w:r>`
          : `<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(line.text)}</w:t></w:r>`;
        const tabs = line.role === "financial-row" ? `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="6100"/><w:tab w:val="right" w:pos="9000"/></w:tabs>` : "";
        return `<w:r><w:pict><v:rect id="block-${pageIndex}-${lineIndex}" style="position:absolute;margin-left:${safeX.toFixed(2)}pt;margin-top:${line.y.toFixed(2)}pt;width:${boxWidth.toFixed(2)}pt;height:${boxHeight.toFixed(2)}pt;z-index:2;mso-position-horizontal-relative:page;mso-position-vertical-relative:page" filled="t" fillcolor="white" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr>${tabs}<w:jc w:val="${justification}"/><w:spacing w:before="0" w:after="0" w:line="${Math.round(fontSize * 24)}" w:lineRule="auto"/></w:pPr>${financialContent}</w:p></w:txbxContent></v:textbox></v:rect></w:pict></w:r>`;
      }
      const fontSize = Math.max(7.5, Math.min(18, line.height * 0.96));
      const bold = fontSize > 12 || /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ0-9ªº\s&–—.-]{8,}$/.test(line.text) ? "<w:b/>" : "";
      const boxHeight = Math.max(line.height * 1.35, fontSize * 1.25, 11);
      const availableWidth = Math.max(24, 595 - line.x - 18);
      const boxWidth = Math.min(availableWidth, Math.max(line.width * 1.06 + 2, fontSize * 0.7, 6));
      return `<w:r><w:pict><v:rect id="ocr-${pageIndex}-${lineIndex}" style="position:absolute;margin-left:${line.x.toFixed(2)}pt;margin-top:${Math.max(0, line.y - fontSize * 0.08).toFixed(2)}pt;width:${boxWidth.toFixed(2)}pt;height:${boxHeight.toFixed(2)}pt;z-index:2;mso-position-horizontal-relative:page;mso-position-vertical-relative:page" filled="t" fillcolor="white" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:keepLines/></w:pPr><w:r><w:rPr>${bold}<w:noProof/><w:sz w:val="${Math.round(fontSize * 2)}"/><w:szCs w:val="${Math.round(fontSize * 2)}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t xml:space="preserve">${escapeXml(line.text)}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect></w:pict></w:r>`;
    }).join("");
    const pageBreak = pageIndex < pages.length - 1 ? `<w:r><w:br w:type="page"/></w:r>` : "";
    return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${background}${overlays}${pageBreak}</w:p>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>${pageXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"/></w:sectPr></w:body></w:document>`;
}

async function convertWithLocalOffice(file, endpoint) {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const response = await localConnectorFetch(`/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentBase64: base64FromBytes(fileBytes)
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw localConnectorError(result, "Não foi possível converter com o Microsoft Word local.");
  return result;
}

async function signWithDigitalCertificate([file]) {
  const mode = document.querySelector("#signatureMode")?.value || "certificate";
  if (mode === "installed") {
    await signWithInstalledCertificate(file);
    return;
  }
  if (!window.forge) throw new Error("O módulo de assinatura digital não foi carregado.");
  const certificateInput = document.querySelector("#certificateFile");
  const certificateFile = certificateInput?.files?.[0];
  const password = document.querySelector("#certificatePassword")?.value || "";
  if (!certificateFile) throw new Error("Selecione o certificado A1 em formato .pfx ou .p12.");
  if (!/\.(pfx|p12)$/i.test(certificateFile.name)) throw new Error("O certificado precisa estar em formato .pfx ou .p12.");
  if (!password) throw new Error("Informe a senha do certificado A1.");

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const certificateBytes = new Uint8Array(await certificateFile.arrayBuffer());
  const { privateKey, certificate, chain } = parsePkcs12Certificate(certificateBytes, password);
  const signature = createDetachedPkcs7Signature(fileBytes, privateKey, certificate, chain);
  download(signature, `${file.name}.p7s`, "application/pkcs7-signature");
}

async function insertVisualSignature([file]) {
  const placement = await chooseSignaturePlacement(file, "Assinatura visual");
  await signPdfWithWrittenSignature(file, placement);
}

async function signWithInstalledCertificate(file) {
  const select = document.querySelector("#windowsCertificate");
  let thumbprint = select?.value || "";
  if (!thumbprint) {
    await loadWindowsCertificates();
    thumbprint = select?.value || "";
  }
  if (!thumbprint) throw new Error("Selecione um certificado instalado no Windows.");
  const apiBase = localSignerApiBase();
  await ensureLocalSignerCompatible(apiBase);
  let fileBytes = new Uint8Array(await file.arrayBuffer());
  const pdfMode = /\.pdf$/i.test(file.name);
  const placement = pdfMode ? await chooseSignaturePlacement(file) : null;
  if (pdfMode) fileBytes = await normalizePdfForEmbeddedSignature(fileBytes);
  const response = await localConnectorFetch(`/api/${pdfMode ? "sign-pdf-installed" : "sign-installed"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      thumbprint,
      contentBase64: base64FromBytes(fileBytes),
      signerName: document.querySelector("#writtenSignature")?.value?.trim() || select?.selectedOptions?.[0]?.textContent || "",
      ...(pdfMode ? { placement } : {})
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw localConnectorError(result, "Não foi possível assinar com o certificado instalado.");
  if (pdfMode) {
    download(bytesFromBase64(result.contentBase64), result.filename || `${baseName(file.name)}-assinado.pdf`, "application/pdf");
  } else {
    download(bytesFromBase64(result.signatureBase64), `${file.name}.p7s`, "application/pkcs7-signature");
  }
}

async function ensureLocalSignerCompatible(apiBase) {
  let health;
  try {
    const response = await localConnectorFetch("/api/health", { cache: "no-store" });
    health = await response.json();
  } catch {
    throw new Error("O conector local do DOCPronto não está aberto. Baixe o conector atualizado, execute o atualizador e tente novamente.");
  }
  if (Number(health?.pdfSigningEngine || 0) < 4) {
    throw new Error("O conector local está desatualizado e pode corromper PDFs. Baixe o conector atualizado nesta tela, execute o atualizador e tente novamente.");
  }
}

async function normalizePdfForEmbeddedSignature(fileBytes) {
  if (!window.PDFLib?.PDFDocument) throw new Error("O módulo de preparação de PDF não foi carregado.");
  try {
    const document = await PDFLib.PDFDocument.load(fileBytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: false,
      updateMetadata: false
    });
    return new Uint8Array(await document.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
      objectsPerTick: 50
    }));
  } catch (error) {
    if (/encrypt|password/i.test(String(error?.message || ""))) {
      throw new Error("Este PDF está protegido por senha. Remova a proteção antes de assinar.");
    }
    throw new Error("Não foi possível normalizar este PDF para assinatura. Verifique se o arquivo abre normalmente e tente novamente.");
  }
}

async function chooseSignaturePlacement(file, label = "Assinatura digital") {
  const dialog = document.querySelector("#signaturePlacementDialog");
  const preview = document.querySelector("#signaturePreview");
  const canvas = document.querySelector("#signatureCanvas");
  const box = document.querySelector("#signatureBox");
  const pageLabel = document.querySelector("#signaturePageLabel");
  const previous = document.querySelector("#signaturePrevPage");
  const next = document.querySelector("#signatureNextPage");
  if (!dialog || !preview || !canvas || !box) return null;
  box.querySelector("span").textContent = label;

  const pdfjs = await loadPdfJs();
  const pdfBytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: pdfBytes, isEvalSupported: false }).promise;
  let pageNumber = pdf.numPages;
  let scale = 1;
  let viewport = null;
  const context = canvas.getContext("2d", { alpha: false });

  const renderPage = async () => {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    scale = Math.min(1.35, Math.max(0.7, Math.min(820 / baseViewport.width, 900 / baseViewport.height)));
    viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    await page.render({ canvasContext: context, viewport }).promise;
    pageLabel.textContent = `Página ${pageNumber} de ${pdf.numPages}`;
    previous.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= pdf.numPages;
    placeDefaultSignatureBox(box, canvas);
  };

  previous.onclick = async () => {
    if (pageNumber > 1) {
      pageNumber -= 1;
      await renderPage();
    }
  };
  next.onclick = async () => {
    if (pageNumber < pdf.numPages) {
      pageNumber += 1;
      await renderPage();
    }
  };

  makeSignatureBoxInteractive(box, preview);
  await renderPage();

  const closeValue = await new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue);
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
  if (closeValue !== "confirm") throw new Error("Posicionamento da assinatura cancelado.");

  const boxRect = box.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const left = clamp(boxRect.left - canvasRect.left, 0, canvasRect.width - boxRect.width);
  const top = clamp(boxRect.top - canvasRect.top, 0, canvasRect.height - boxRect.height);
  const viewportLeft = left * viewport.width / canvasRect.width;
  const viewportTop = top * viewport.height / canvasRect.height;
  const viewportRight = (left + boxRect.width) * viewport.width / canvasRect.width;
  const viewportBottom = (top + boxRect.height) * viewport.height / canvasRect.height;
  const firstPoint = viewport.convertToPdfPoint(viewportLeft, viewportTop);
  const secondPoint = viewport.convertToPdfPoint(viewportRight, viewportBottom);
  return {
    page: pageNumber,
    x: Math.min(firstPoint[0], secondPoint[0]),
    y: Math.min(firstPoint[1], secondPoint[1]),
    width: Math.abs(secondPoint[0] - firstPoint[0]),
    height: Math.abs(secondPoint[1] - firstPoint[1]),
    coordinateSystem: "pdf-points-v2"
  };
}

function placeDefaultSignatureBox(box, canvas) {
  const width = Math.min(290, Math.max(210, canvas.width * 0.34));
  const height = 78;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.style.left = `${Math.max(24, canvas.width - width - 46)}px`;
  box.style.top = `${Math.max(24, canvas.height - height - 86)}px`;
}

function makeSignatureBoxInteractive(box, container) {
  if (box.dataset.bound === "true") return;
  box.dataset.bound = "true";
  let action = null;
  let start = null;
  box.addEventListener("pointerdown", event => {
    event.preventDefault();
    box.setPointerCapture(event.pointerId);
    const isResize = event.target.tagName === "I";
    action = isResize ? "resize" : "move";
    start = {
      x: event.clientX,
      y: event.clientY,
      left: box.offsetLeft,
      top: box.offsetTop,
      width: box.offsetWidth,
      height: box.offsetHeight
    };
  });
  box.addEventListener("pointermove", event => {
    if (!action || !start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const maxLeft = container.clientWidth - box.offsetWidth;
    const maxTop = container.clientHeight - box.offsetHeight;
    if (action === "move") {
      box.style.left = `${clamp(start.left + dx, 0, maxLeft)}px`;
      box.style.top = `${clamp(start.top + dy, 0, maxTop)}px`;
      return;
    }
    const width = clamp(start.width + dx, 180, container.clientWidth - start.left);
    const height = clamp(start.height + dy, 58, container.clientHeight - start.top);
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  });
  box.addEventListener("pointerup", () => {
    action = null;
    start = null;
  });
}

async function loadWindowsCertificates() {
  const select = document.querySelector("#windowsCertificate");
  const button = document.querySelector("#loadWindowsCertificates");
  if (!select) return;
  select.innerHTML = `<option value="">Carregando certificados...</option>`;
  if (button) button.disabled = true;
  let certificates;
  try {
    certificates = await fetchWindowsCertificates(3500);
  } catch (error) {
    select.innerHTML = `<option value="">Aplicativo local não conectado</option>`;
    throw Object.assign(new Error("Não foi possível consultar os certificados instalados.", { cause: error }), {
      code: error?.code || "CERTIFICATE_NOT_FOUND"
    });
  } finally {
    if (button) button.disabled = false;
  }
  populateWindowsCertificates(certificates);
}

function populateWindowsCertificates(certificates) {
  const select = document.querySelector("#windowsCertificate");
  if (!select) return;
  if (!certificates.length) {
    select.innerHTML = `<option value="">Nenhum certificado com chave privada encontrado</option>`;
    return;
  }
  select.dataset.certificates = JSON.stringify(certificates);
  select.innerHTML = certificates.map(certificate =>
    `<option value="${escapeHtml(certificate.thumbprint)}">${escapeHtml(maskCertificateLabel(certificate))}</option>`
  ).join("");
}

async function fetchWindowsCertificates(timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await localConnectorFetch("/api/certificates", { signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw localConnectorError(result, "Serviço local indisponível.");
    return result.certificates || [];
  } finally {
    clearTimeout(timeout);
  }
}

async function detectLocalCertificateBridge() {
  try {
    return await fetchWindowsCertificates(1400);
  } catch (error) {
    return null;
  }
}

function maskCertificateLabel(certificate) {
  const label = String(certificate.label || certificate.subject || "Certificado");
  const masked = label.replace(/\b(\d{3})\d{5}(\d{3})\b/g, "$1•••••$2").replace(/\b(\d{2})\d{8}(\d{4})\b/g, "$1••••••••$2");
  const days = Math.ceil((new Date(certificate.notAfter).getTime() - Date.now()) / 86400000);
  return days <= 30 ? `Vence em ${Math.max(0, days)} dias · ${masked}` : masked;
}

function filterCertificateOptions(event) {
  const select = document.querySelector("#windowsCertificate");
  const query = normalizeSearchText(event.target.value);
  const certificates = JSON.parse(select?.dataset.certificates || "[]");
  select.innerHTML = certificates.filter(item => normalizeSearchText(item.label).includes(query)).map(item =>
    `<option value="${escapeHtml(item.thumbprint)}">${escapeHtml(maskCertificateLabel(item))}</option>`
  ).join("") || `<option value="">Nenhum certificado encontrado</option>`;
}

function localSignerApiBase() {
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return "";
  throw Object.assign(new Error("Certificados instalados estão disponíveis somente no aplicativo DOCPronto para Windows."), {
    code: "DESKTOP_REQUIRED"
  });
}

let localConnectorToken = "";

function localConnectorError(payload, fallback) {
  return Object.assign(new Error(payload.error || fallback), {
    code: payload.code || "LOCAL_CONNECTOR_ERROR"
  });
}

async function requestLocalConnectorSession(apiBase) {
  const sessionResponse = await fetch(`${apiBase}/api/session`, {
    method: "POST",
    cache: "no-store"
  });
  const payload = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || !payload.token) {
    throw localConnectorError(payload, "Não foi possível iniciar uma sessão segura com o conector local.");
  }
  return payload.token;
}

async function localConnectorFetch(path, options = {}) {
  const apiBase = localSignerApiBase();
  if (!localConnectorToken) {
    localConnectorToken = await requestLocalConnectorSession(apiBase);
  }
  const headers = new Headers(options.headers || {});
  headers.set("X-DocPronto-Token", localConnectorToken);
  let response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (response.status === 401) {
    localConnectorToken = "";
    try {
      localConnectorToken = await requestLocalConnectorSession(apiBase);
    } catch {
      return response;
    }
    headers.set("X-DocPronto-Token", localConnectorToken);
    response = await fetch(`${apiBase}${path}`, { ...options, headers });
  }
  return response;
}

async function signPdfWithWrittenSignature(file, placement = null) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("A assinatura escrita está disponível para arquivos PDF. Converta o Word para PDF antes de assinar.");
  const signerName = document.querySelector("#writtenSignature")?.value?.trim();
  if (!signerName) throw new Error("Informe o nome que deve aparecer na assinatura escrita.");
  const pdfDocument = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const pages = pdfDocument.getPages();
  const page = pages[clamp((placement?.page || pages.length) - 1, 0, pages.length - 1)];
  const regular = await pdfDocument.embedFont(PDFLib.StandardFonts.Helvetica);
  const italic = await pdfDocument.embedFont(PDFLib.StandardFonts.TimesRomanItalic);
  const { width } = page.getSize();
  const signedAt = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date());
  const boxWidth = placement?.width || Math.min(300, width - 80);
  const boxHeight = placement?.height || 72;
  const x = placement?.x ?? width - boxWidth - 42;
  const y = placement?.y ?? 54;
  page.drawRectangle({
    x,
    y,
    width: boxWidth,
    height: boxHeight,
    borderColor: PDFLib.rgb(0.16, 0.2, 0.18),
    borderWidth: 0.8,
    color: PDFLib.rgb(1, 0.996, 0.965),
    opacity: 0.92
  });
  page.drawText(toWinAnsi(signerName).slice(0, 52), {
    x: x + 14,
    y: y + boxHeight - 33,
    size: 15,
    font: italic,
    color: PDFLib.rgb(0.08, 0.14, 0.12)
  });
  page.drawLine({
    start: { x: x + 14, y: y + boxHeight - 40 },
    end: { x: x + boxWidth - 14, y: y + boxHeight - 40 },
    thickness: 0.6,
    color: PDFLib.rgb(0.16, 0.2, 0.18)
  });
  page.drawText(toWinAnsi(`Assinado visualmente em ${signedAt}`), {
    x: x + 14,
    y: y + 15,
    size: 8.5,
    font: regular,
    color: PDFLib.rgb(0.32, 0.38, 0.35)
  });
  download(await pdfDocument.save(), `${baseName(file.name)}-assinado.pdf`, "application/pdf");
}

function parsePkcs12Certificate(bytes, password) {
  try {
    const p12Asn1 = forge.asn1.fromDer(binaryStringFromBytes(bytes));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const keyBag = firstPkcs12Bag(p12, forge.pki.oids.pkcs8ShroudedKeyBag) || firstPkcs12Bag(p12, forge.pki.oids.keyBag);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const certificate = certBags[0]?.cert;
    if (!keyBag?.key || !certificate) throw new Error("Certificado A1 incompleto.");
    return { privateKey: keyBag.key, certificate, chain: certBags.map(bag => bag.cert).filter(Boolean) };
  } catch (error) {
    throw new Error("Não foi possível abrir o certificado. Verifique se o arquivo é A1 (.pfx/.p12) e se a senha está correta.");
  }
}

function firstPkcs12Bag(p12, bagType) {
  return (p12.getBags({ bagType })[bagType] || [])[0];
}

function createDetachedPkcs7Signature(fileBytes, privateKey, certificate, chain) {
  const signedData = forge.pkcs7.createSignedData();
  signedData.content = forge.util.createBuffer(binaryStringFromBytes(fileBytes));
  chain.forEach(item => signedData.addCertificate(item));
  signedData.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  signedData.sign({ detached: true });
  return bytesFromBinaryString(forge.asn1.toDer(signedData.toAsn1()).getBytes());
}

function binaryStringFromBytes(bytes) {
  let result = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return result;
}

function bytesFromBinaryString(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes) {
  return btoa(binaryStringFromBytes(bytes));
}

function bytesFromBase64(value) {
  return bytesFromBinaryString(atob(value));
}

async function createTextPdf(text) {
  const normalizedText = String(text || "").replace(/\t/g, "    ");
  const unsupported = findUnsupportedWinAnsiCharacters(normalizedText);
  if (unsupported.length) {
    const preview = unsupported.slice(0, 12).map(formatUnsupportedCharacter).join(", ");
    const remaining = unsupported.length > 12 ? ` e mais ${unsupported.length - 12}` : "";
    throw new Error(`O TXT contém caracteres incompatíveis com o PDF básico: ${preview}${remaining}. Nenhum caractere foi substituído; remova esses símbolos ou salve o texto com caracteres latinos compatíveis.`);
  }
  const document = await PDFLib.PDFDocument.create();
  const font = await document.embedFont(PDFLib.StandardFonts.Helvetica);
  const size = 11;
  const width = 595.28;
  const height = 841.89;
  const margin = 52;
  const lineHeight = 16;
  const lines = wrapTextByWidth(normalizedText, font, size, width - margin * 2);
  let page = document.addPage([width, height]);
  let y = height - margin;
  for (const line of lines) {
    if (y < margin) {
      page = document.addPage([width, height]);
      y = height - margin;
    }
    page.drawText(toWinAnsi(line), { x: margin, y, size, font, color: PDFLib.rgb(0.08, 0.14, 0.12) });
    y -= lineHeight;
  }
  return document.save();
}

function findUnsupportedWinAnsiCharacters(text) {
  return [...new Set(Array.from(String(text || "")).filter(character =>
    character !== "\n" && character !== "\r" && !/[\x20-\x7E\u00A0-\u00FF]/.test(character)
  ))];
}

function formatUnsupportedCharacter(character) {
  const codePoint = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  const visible = /\s/.test(character) ? "espaço especial" : `“${character}”`;
  return `${visible} (U+${codePoint})`;
}

async function docxToText([file]) {
  const text = await extractTextFromDocx(file);
  download(new TextEncoder().encode(text), `${baseName(file.name)}.txt`, "text/plain;charset=utf-8");
}

async function extractTextFromDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  validateArchive(zip, "word/document.xml");
  const parts = ["word/document.xml", ...Object.keys(zip.files).filter(path => /^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/i.test(path))];
  const outputs = [];
  for (const path of parts) {
    const parsed = parseXml(await requireZipEntry(zip, path).async("string"));
    const paragraphs = [...parsed.getElementsByTagNameNS("*", "p")];
    const lines = paragraphs.map(paragraph => {
      const cells = [];
      const tableCells = [...paragraph.closest?.("tc")?.parentElement?.children || []];
      if (tableCells.length) tableCells.forEach(cell => cells.push([...cell.getElementsByTagNameNS("*", "t")].map(node => node.textContent).join("")));
      if (cells.length) return cells.join("\t");
      let value = "";
      [...paragraph.querySelectorAll("t, tab, br")].forEach(node => { value += node.localName === "tab" ? "\t" : node.localName === "br" ? "\n" : node.textContent; });
      return value;
    }).filter(value => value !== "");
    if (lines.length) outputs.push(lines.join("\n"));
  }
  return outputs.join("\n\n");
}

async function csvToXlsx([file]) {
  const delimiter = getDelimiter();
  const rows = parseCsv(await file.text(), delimiter);
  if (!rows.length) throw new Error("O CSV está vazio.");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels").file(".rels", rootRelsXml());
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbookXml());
  xl.folder("_rels").file("workbook.xml.rels", workbookRelsXml());
  xl.file("styles.xml", stylesXml());
  xl.folder("worksheets").file("sheet1.xml", worksheetXml(rows));
  download(await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${baseName(file.name)}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function xlsxToCsv([file]) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  validateArchive(zip, "xl/workbook.xml");
  const workbook = parseXml(await requireZipEntry(zip, "xl/workbook.xml").async("string"));
  const firstSheet = workbook.getElementsByTagNameNS("*", "sheet")[0];
  if (!firstSheet) throw new Error("Nenhuma aba foi encontrada na planilha.");
  const relationId = firstSheet.getAttribute("r:id") || firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const rels = parseXml(await requireZipEntry(zip, "xl/_rels/workbook.xml.rels").async("string"));
  const relation = [...rels.getElementsByTagNameNS("*", "Relationship")].find(node => node.getAttribute("Id") === relationId);
  const target = relation?.getAttribute("Target") || "worksheets/sheet1.xml";
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.?\//, "")}`;
  const sharedStrings = await readSharedStrings(zip);
  const styles = await readXlsxStyles(zip);
  const date1904 = workbook.getElementsByTagNameNS("*", "workbookPr")[0]?.getAttribute("date1904") === "1";
  const sheet = parseXml(await requireZipEntry(zip, sheetPath).async("string"));
  const rows = [];
  [...sheet.getElementsByTagNameNS("*", "row")].forEach(row => {
    const declaredRow = Number(row.getAttribute("r")) || rows.length + 1;
    while (rows.length < declaredRow - 1) rows.push([]);
    const cells = [...row.getElementsByTagNameNS("*", "c")];
    const values = [];
    cells.forEach(cell => {
      const reference = cell.getAttribute("r") || "A1";
      const column = columnNumber(reference.replace(/\d/g, ""));
      while (values.length < column) values.push("");
      const type = cell.getAttribute("t");
      const valueNode = cell.getElementsByTagNameNS("*", "v")[0];
      const inlineNode = cell.getElementsByTagNameNS("*", "t")[0];
      let value = inlineNode?.textContent ?? valueNode?.textContent ?? "";
      if (type === "s") value = sharedStrings[Number(value)] ?? "";
      if (type === "b") value = value === "1" ? "VERDADEIRO" : "FALSO";
      if (!type && value !== "") value = formatXlsxStoredValue(value, cell.getAttribute("s"), styles, date1904);
      values[column - 1] = value;
    });
    rows.push(values);
  });
  const delimiter = getDelimiter();
  const csv = rows.map(row => row.map(value => quoteCsv(neutralizeCsvFormula(value), delimiter)).join(delimiter)).join("\r\n");
  download(new TextEncoder().encode(`\uFEFF${csv}`), `${baseName(file.name)}.csv`, "text/csv;charset=utf-8");
}

async function ofxToCsv([file]) {
  const statement = parseOfx(await readOfxText(file));
  const delimiter = getDelimiter();
  const rows = ofxRows(statement);
  const csv = rows.map(row => row.map(value => quoteCsv(neutralizeCsvFormula(value), delimiter)).join(delimiter)).join("\r\n");
  download(new TextEncoder().encode(`\uFEFF${csv}`), `${baseName(file.name)}-transacoes.csv`, "text/csv;charset=utf-8");
}

async function ofxToXlsx([file]) {
  const statement = parseOfx(await readOfxText(file));
  const rows = ofxRows(statement);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels").file(".rels", rootRelsXml());
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbookXml());
  xl.folder("_rels").file("workbook.xml.rels", workbookRelsXml());
  xl.file("styles.xml", stylesXml());
  xl.folder("worksheets").file("sheet1.xml", worksheetXml(rows));
  download(await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${baseName(file.name)}-transacoes.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function ofxToSummaryPdf([file]) {
  const statement = parseOfx(await readOfxText(file));
  const document = await PDFLib.PDFDocument.create();
  const regular = await document.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await document.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 46;
  const income = statement.transactions.filter(item => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const expenses = Math.abs(statement.transactions.filter(item => item.amount < 0).reduce((sum, item) => sum + item.amount, 0));
  const drawHeader = page => {
    page.drawText("Resumo financeiro OFX", { x: margin, y: height - margin, size: 22, font: bold, color: PDFLib.rgb(0.08, 0.14, 0.12) });
    page.drawText(`Conta: ${toWinAnsi(statement.accountId || "não informada")}  |  Banco: ${toWinAnsi(statement.bankId || "não informado")}`, { x: margin, y: height - 72, size: 9, font: regular });
  };
  let page = document.addPage([width, height]);
  drawHeader(page);
  let y = height - 105;
  const summary = [
    `Período: ${formatOfxDate(statement.startDate)} a ${formatOfxDate(statement.endDate)}`,
    `Transações: ${statement.transactions.length}`,
    `Entradas: ${formatMoney(income, statement.currency)}`,
    `Saídas: ${formatMoney(expenses, statement.currency)}`,
    `Movimentação líquida: ${formatMoney(income - expenses, statement.currency)}`,
    `Saldo informado: ${statement.balance === null ? "não informado" : formatMoney(statement.balance, statement.currency)}`
  ];
  summary.forEach(line => {
    page.drawText(toWinAnsi(line), { x: margin, y, size: 11, font: bold });
    y -= 20;
  });
  y -= 12;
  page.drawText("Data", { x: margin, y, size: 9, font: bold });
  page.drawText("Descrição", { x: 115, y, size: 9, font: bold });
  page.drawText("Valor", { x: 470, y, size: 9, font: bold });
  y -= 16;
  for (const transaction of statement.transactions) {
    if (y < margin + 25) {
      page = document.addPage([width, height]);
      drawHeader(page);
      y = height - 105;
    }
    const description = toWinAnsi(transaction.memo || transaction.name || transaction.type || "Transação").slice(0, 58);
    page.drawText(formatOfxDate(transaction.date), { x: margin, y, size: 8.5, font: regular });
    page.drawText(description, { x: 115, y, size: 8.5, font: regular });
    page.drawText(toWinAnsi(formatMoney(transaction.amount, statement.currency)), {
      x: 470,
      y,
      size: 8.5,
      font: regular,
      color: transaction.amount < 0 ? PDFLib.rgb(0.65, 0.15, 0.12) : PDFLib.rgb(0.1, 0.45, 0.2)
    });
    y -= 15;
  }
  download(await document.save(), `${baseName(file.name)}-resumo.pdf`, "application/pdf");
}

const docProntoScriptUrl = document.currentScript?.src || window.location.href;
const docProntoBaseUrl = new URL(".", docProntoScriptUrl);

async function pdfToOfx(files) {
  const outputs = [];
  const usedNames = new Set();
  let queueCancelled = false;
  const progress = document.querySelector("#ofxQueueProgress");
  const progressText = document.querySelector("#ofxQueueProgressText");
  if (progress) { progress.hidden = false; progress.max = files.length; progress.value = 0; }
  for (let index = 0; index < files.length; index += 1) {
    throwIfProcessingCancelled();
    const file = files[index];
    elements.process.textContent = `Processando ${index + 1} de ${files.length}`;
    updateOfxQueueItem(index, "processing", "Extraindo lançamentos");
    if (progressText) progressText.textContent = `${index + 1} de ${files.length} · ${file.name}`;
    try {
      const result = await extractTransactionsFromPdf(file);
      if (!result.transactions.length) throw new Error("Nenhuma transação com data e valor foi encontrada.");
      updateOfxQueueItem(index, "review", "Aguardando conferência");
      const reviewed = await reviewOfxData(result, { fileName: file.name, index, total: files.length });
      if (reviewed?.cancelQueue) {
        queueCancelled = true;
        updateOfxQueueItem(index, "skipped", "Fila cancelada");
        for (let pending = index + 1; pending < files.length; pending += 1) updateOfxQueueItem(pending, "skipped", "Não processado");
        break;
      } else if (!reviewed) {
        updateOfxQueueItem(index, "skipped", "Pulado");
      } else {
        const filename = uniqueOfxFilename(file.name, usedNames);
        outputs.push({ filename, data: new TextEncoder().encode(buildOfx(reviewed)) });
        updateOfxQueueItem(index, "done", "OFX pronto");
      }
    } catch (error) {
      if (error?.name === "AbortError" || processingAbortController?.signal.aborted) throw error;
      updateOfxQueueItem(index, "error", await reportApplicationError(error, {
        tool: "pdf-ofx",
        stage: "queue-item",
        retryable: true
      }));
    }
    if (progress) progress.value = index + 1;
  }
  if (outputs.length === 1 && files.length === 1) {
    download(outputs[0].data, outputs[0].filename, "application/x-ofx");
  } else if (outputs.length) {
    const zip = new JSZip();
    outputs.forEach(output => zip.file(output.filename, output.data));
    download(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), "ofx-convertidos.zip", "application/zip");
  }
  const failed = ofxQueueItems.filter(item => item.status === "error").length;
  const skipped = ofxQueueItems.filter(item => item.status === "skipped").length;
  const detail = [failed ? `${failed} com erro` : "", skipped ? `${skipped} pulado${skipped === 1 ? "" : "s"}` : "", queueCancelled ? "fila cancelada" : ""].filter(Boolean).join(" · ");
  return { message: outputs.length ? `${outputs.length} OFX${outputs.length === 1 ? "" : "s"} gerado${outputs.length === 1 ? "" : "s"}${detail ? ` · ${detail}` : ""}.` : `Fila concluída sem OFXs${detail ? ` · ${detail}` : ""}.` };
}

function updateOfxQueueItem(index, status, detail) {
  if (!ofxQueueItems[index]) return;
  ofxQueueItems[index].status = status;
  ofxQueueItems[index].detail = detail;
  const row = elements.fileList.querySelector(`[data-queue-index="${index}"]`);
  if (!row) return;
  row.className = `file-item queue-item ${status}`;
  const state = row.querySelector("[data-queue-state]");
  if (state) state.textContent = detail;
  row.querySelector(".file-remove")?.toggleAttribute("hidden", isProcessing);
}

function uniqueOfxFilename(sourceName, usedNames) {
  const base = `${baseName(sourceName)}-convertido`;
  let filename = `${base}.ofx`;
  let suffix = 2;
  while (usedNames.has(filename.toLowerCase())) filename = `${base}-${suffix++}.ofx`;
  usedNames.add(filename.toLowerCase());
  return filename;
}

async function reviewOfxData(result, context = {}) {
  const dialog = document.querySelector("#ofxReviewDialog");
  const metadata = document.querySelector("#ofxReviewMetadata");
  const rows = document.querySelector("#ofxReviewRows");
  const summary = document.querySelector("#ofxReviewSummary");
  const warning = document.querySelector("#ofxReviewWarning");
  const search = document.querySelector("#ofxReviewSearch");
  const count = document.querySelector("#ofxReviewCount");
  const errorCount = document.querySelector("#ofxReviewErrorCount");
  const confirmButton = document.querySelector("#ofxReviewConfirm");
  const cancelButton = document.querySelector("#ofxReviewCancel");
  const cancelQueueButton = document.querySelector("#ofxReviewCancelQueue");
  const reviewContext = document.querySelector("#ofxReviewContext");
  if (reviewContext) reviewContext.textContent = context.fileName ? `${context.index + 1} de ${context.total} · ${context.fileName}` : "Confira e edite os lançamentos extraídos antes de gerar o arquivo.";
  if (cancelButton) cancelButton.textContent = context.total > 1 ? "Pular este PDF" : "Cancelar";
  if (cancelQueueButton) {
    cancelQueueButton.hidden = !(context.total > 1);
    cancelQueueButton.onclick = () => {
      dialog.close("cancel-queue");
    };
  }
  metadata.innerHTML = `<label>Banco<input id="reviewBank" value="${escapeHtml(result.metadata.bankId)}" maxlength="32" required></label><label>Agência<input id="reviewAgency" value="${escapeHtml(result.metadata.agencyId || "")}" maxlength="20"></label><label>Conta<input id="reviewAccount" value="${escapeHtml(result.metadata.accountId)}" maxlength="40" required></label><label>Moeda<select id="reviewCurrency"><option>BRL</option><option>USD</option><option>EUR</option></select></label><label>Tipo<select id="reviewAccountType"><option value="CHECKING">Conta corrente</option><option value="SAVINGS">Poupança</option><option value="CREDITCARD">Cartão</option></select></label><label>Saldo final (opcional)<input id="reviewFinalBalance" type="number" step="0.01" value="${Number.isFinite(result.metadata.finalBalance) ? Number(result.metadata.finalBalance).toFixed(2) : ""}" placeholder="Não informado"></label>`;
  document.querySelector("#reviewCurrency").value = result.metadata.currency || "BRL";
  document.querySelector("#reviewAccountType").value = result.metadata.creditCard ? "CREDITCARD" : result.metadata.accountType || "CHECKING";
  const rowHtml = (item = { date: "", memo: "", amount: null, type: "" }) => `<tr data-review-row><td><input class="review-use" type="checkbox" checked aria-label="Incluir lançamento"></td><td class="review-index"></td><td><input class="review-date" type="date" value="${escapeHtml(item.date || "")}"></td><td><input class="review-memo" value="${escapeHtml(item.memo || "")}" maxlength="255"></td><td><input class="review-credit credit-input" type="number" min="0" step="0.01" value="${item.amount !== null && item.type === "CREDIT" ? Math.abs(item.amount).toFixed(2) : ""}"></td><td><input class="review-debit debit-input" type="number" min="0" step="0.01" value="${item.amount !== null && item.type === "DEBIT" ? Math.abs(item.amount).toFixed(2) : ""}"></td><td><button class="review-delete" type="button" title="Excluir lançamento" aria-label="Excluir lançamento">×</button></td></tr>`;
  rows.innerHTML = result.transactions.map(rowHtml).join("");
  search.value = "";
  const update = () => {
    const allRows = [...rows.querySelectorAll("[data-review-row]")];
    const query = search.value.trim().toLowerCase();
    let errors = 0;
    let duplicateWarnings = 0;
    const seen = new Set();
    allRows.forEach((row, index) => {
      row.querySelector(".review-index").textContent = index + 1;
      const date = row.querySelector(".review-date").value;
      const memo = row.querySelector(".review-memo").value.trim();
      const creditRaw = row.querySelector(".review-credit").value.trim();
      const debitRaw = row.querySelector(".review-debit").value.trim();
      const credit = Number(creditRaw || 0);
      const debit = Number(debitRaw || 0);
      const creditSet = creditRaw !== "";
      const debitSet = debitRaw !== "";
      const enabled = row.querySelector(".review-use").checked;
      const direction = debitSet ? "DEBIT" : "CREDIT";
      const key = `${date}|${memo.toLowerCase()}|${direction}|${credit}|${debit}`;
      const duplicate = enabled && seen.has(key);
      if (enabled) seen.add(key);
      const blockingDuplicate = duplicate && !result.metadata.creditCard;
      const invalid = enabled && (!isValidIsoDate(date) || !memo || !parseOfxReviewAmount(creditRaw, debitRaw) || blockingDuplicate);
      row.classList.toggle("invalid", invalid);
      row.classList.toggle("duplicate", duplicate && result.metadata.creditCard);
      row.title = duplicate ? "Possível lançamento duplicado." : "";
      if (duplicate && result.metadata.creditCard) duplicateWarnings += 1;
      if (invalid) errors += 1;
      const searchable = `${date} ${memo} ${credit} ${debit}`.toLowerCase();
      row.classList.toggle("filtered", Boolean(query) && !searchable.includes(query));
    });
    const selected = allRows.filter(row => row.querySelector(".review-use").checked);
    const credits = selected.reduce((sum, row) => sum + Number(row.querySelector(".review-credit").value || 0), 0);
    const debits = selected.reduce((sum, row) => sum + Number(row.querySelector(".review-debit").value || 0), 0);
    const expectedCredits = result.metadata.expectedCredits;
    const expectedDebits = result.metadata.expectedDebits;
    const initialBalance = result.metadata.initialBalance;
    const finalBalanceRaw = document.querySelector("#reviewFinalBalance").value.trim();
    const finalBalance = finalBalanceRaw === "" ? null : Number(finalBalanceRaw);
    const reconciliation = [];
    if (expectedCredits !== null && Math.abs(credits - expectedCredits) > 0.01) reconciliation.push(`créditos diferem do extrato em ${formatMoney(credits - expectedCredits, result.metadata.currency)}`);
    if (expectedDebits !== null && Math.abs(debits - expectedDebits) > 0.01) reconciliation.push(`débitos diferem do extrato em ${formatMoney(debits - expectedDebits, result.metadata.currency)}`);
    if (initialBalance !== null && finalBalance !== null && Math.abs(initialBalance + credits - debits - finalBalance) > 0.01) reconciliation.push("a equação entre saldo inicial, movimentações e saldo final não fecha");
    const currency = document.querySelector("#reviewCurrency").value;
    summary.innerHTML = `<span>${selected.length} selecionados</span><span class="credit">Total de créditos: ${formatMoney(credits, currency)}</span><span class="debit">Total de débitos: ${formatMoney(debits, currency)}</span><span class="balance">Saldo líquido: ${formatMoney(credits - debits, currency)}</span>`;
    count.textContent = `${allRows.length} lançamentos`;
    if (!selected.length) errors += 1;
    if (!document.querySelector("#reviewBank").value.trim() || !document.querySelector("#reviewAccount").value.trim()) errors += 1;
    const totalErrors = errors + reconciliation.length;
    errorCount.textContent = totalErrors ? `${totalErrors} ${totalErrors === 1 ? "erro" : "erros"}` : "";
    const hasReferenceTotals = expectedCredits !== null || expectedDebits !== null || initialBalance !== null || finalBalance !== null;
    warning.textContent = errors ? "Existem linhas duplicadas ou incompletas, ou faltam banco/conta. Lançamentos de 0,00 são aceitos quando constam no extrato." : reconciliation.length ? `Conferência financeira pendente: ${reconciliation.join("; ")}.` : duplicateWarnings ? `${duplicateWarnings} ${duplicateWarnings === 1 ? "lançamento idêntico foi encontrado" : "lançamentos idênticos foram encontrados"}. Confira se são compras distintas antes de gerar o OFX.` : hasReferenceTotals ? "Valores conferidos com os totais disponíveis do extrato." : "Revise os lançamentos: o PDF não trouxe totais ou saldos suficientes para reconciliação automática.";
    warning.classList.toggle("visible", totalErrors > 0 || duplicateWarnings > 0);
    confirmButton.disabled = totalErrors > 0;
  };
  rows.oninput = event => {
    if (event.target.matches(".review-credit") && event.target.value.trim() !== "") event.target.closest("tr").querySelector(".review-debit").value = "";
    if (event.target.matches(".review-debit") && event.target.value.trim() !== "") event.target.closest("tr").querySelector(".review-credit").value = "";
    update();
  };
  rows.onclick = event => {
    const remove = event.target.closest(".review-delete");
    if (remove) { remove.closest("tr").remove(); update(); }
  };
  search.oninput = update;
  document.querySelector("#ofxReviewAdd").onclick = () => { rows.insertAdjacentHTML("beforeend", rowHtml()); rows.lastElementChild.querySelector(".review-date").focus(); update(); };
  metadata.oninput = update;
  update();
  const value = await new Promise(resolve => {
    const onClose = () => { dialog.removeEventListener("close", onClose); resolve(dialog.returnValue); };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
  if (value === "cancel-queue") return { cancelQueue: true };
  if (value !== "confirm") return null;
  const transactions = [...rows.querySelectorAll("[data-review-row]")].filter(row => row.querySelector(".review-use").checked).map(row => {
    const date = row.querySelector(".review-date").value;
    const memo = row.querySelector(".review-memo").value.trim();
    const creditRaw = row.querySelector(".review-credit").value.trim();
    const debitRaw = row.querySelector(".review-debit").value.trim();
    const parsedAmount = parseOfxReviewAmount(creditRaw, debitRaw);
    if (!isValidIsoDate(date) || !memo || !parsedAmount) throw new Error("Corrija os lançamentos destacados antes de gerar o OFX.");
    return { date, memo, ...parsedAmount };
  });
  if (!transactions.length) throw new Error("Selecione ao menos um lançamento para gerar o OFX.");
  const accountType = document.querySelector("#reviewAccountType").value;
  const bankId = document.querySelector("#reviewBank").value.trim();
  const accountId = document.querySelector("#reviewAccount").value.trim();
  if (!bankId || !accountId || /^PDF(?:-|$)/i.test(bankId) || /^PDF(?:-|$)/i.test(accountId)) throw new Error("Confirme banco e conta reais antes de gerar o OFX.");
  const finalBalanceRaw = document.querySelector("#reviewFinalBalance").value.trim();
  return { bankId, agencyId: document.querySelector("#reviewAgency").value.trim(), accountId, currency: document.querySelector("#reviewCurrency").value, accountType, creditCard: accountType === "CREDITCARD", finalBalance: finalBalanceRaw === "" ? null : Number(finalBalanceRaw), transactions };
}

function parseOfxReviewAmount(creditRaw, debitRaw) {
  const creditText = String(creditRaw ?? "").trim();
  const debitText = String(debitRaw ?? "").trim();
  const creditSet = creditText !== "";
  const debitSet = debitText !== "";
  if (creditSet === debitSet) return null;
  const credit = Number(creditText || 0);
  const debit = Number(debitText || 0);
  if (!Number.isFinite(credit) || !Number.isFinite(debit) || credit < 0 || debit < 0) return null;
  return creditSet ? { amount: credit, type: "CREDIT" } : { amount: -debit, type: "DEBIT" };
}

function isValidIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return Boolean(match && isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])));
}

async function extractTransactionsFromPdf(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  let transactions = [];
  const allLines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    throwIfProcessingCancelled();
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = groupPdfTextLines(textContent.items);
    allLines.push(...lines);
    page.cleanup();
  }
  let metadata = inferFinancialMetadata(allLines);
  transactions = parseStatementLines(allLines, metadata);
  const useOcr = window.document.querySelector("#pdfUseOcr")?.checked !== false;
  if (transactions.length === 0 && useOcr) {
    showStatus("Nenhuma transação textual encontrada. Iniciando OCR local das páginas...");
    const ocrLines = await extractTransactionsWithOcr(pdf);
    metadata = inferFinancialMetadata(ocrLines);
    transactions = parseStatementLines(ocrLines, metadata);
  }
  await loadingTask.destroy();
  return { transactions, metadata };
}

async function extractTextFromPdf(file, reportProgress = false) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    throwIfProcessingCancelled();
    if (reportProgress) showStatus(`Extraindo texto: página ${pageNumber} de ${pdf.numPages}...`);
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push(groupPdfTextLines(textContent.items));
    page.cleanup();
  }
  await loadingTask.destroy();
  return pages;
}

async function pdfToAbrasfXml([file]) {
  showStatus("Lendo e classificando a NFS-e...");
  const pages = await extractTextFromPdf(file, true);
  const rawLines = pages.flat();
  const lines = rawLines.map(line => stripLayoutMarkers(line).replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = lines.join("\n");
  const cancellation = detectNfseCancellation(text);
  if (cancellation.cancelled) {
    throw createNfseCancellationError(cancellation);
  }
  const invoice = parseSupportedNfse(rawLines, text);
  validateAbrasfInvoice(invoice, document.querySelector("#abrasfStrictValidation")?.checked !== false);
  const xml = buildAbrasfCompNfse(invoice);
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("O XML ABRASF gerado não passou na validação de sintaxe.");
  validateAbrasf204Document(parsed);
  download(xml, `NFSe-${invoice.number}-ABRASF.xml`, "application/xml;charset=utf-8");
}

function detectNfseCancellation(text) {
  const source = String(text || "").replace(/\r/g, "");
  const watermark = /(?:^|\n)\s*(?:NFS-?e\s+)?CANCELAD[AO]\s*(?:\n|$)/im.test(source);
  const dateMatch = source.match(/Data(?:\s+e\s+Hora)?\s+d[oa]\s+Cancelamento[^\d]{0,40}(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i);
  const status = /(?:Situa[cç][aã]o|Status)(?:\s+da\s+NFS-?e)?[^\n]{0,30}\bCANCELAD[AO]\b/i.test(source);
  const protocol = /(?:NfseCancelamento|Confirma[cç][aã]o\s+de\s+Cancelamento|Pedido\s+de\s+Cancelamento)/i.test(source);
  const cancelled = [watermark, Boolean(dateMatch), status, protocol].filter(Boolean).length >= 2;
  const reason = cancelled ? (source.match(/Motivo(?:\s+d[oa]\s+Cancelamento)?\s*[:\-]?\s*([^\n]{3,240})/i) || [])[1]?.trim() || "" : "";
  return { cancelled, date: dateMatch?.[1] || "", reason };
}

function createNfseCancellationError() {
  return createSafeParserError(
    "NFSE_CANCELLED",
    "Esta NFS-e está cancelada. O DOCPronto não gera CompNfse ativa para documento cancelado."
  );
}

function parseSupportedNfse(rawLines, text) {
  const cleanLines = rawLines.map(line => stripLayoutMarkers(line).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (/PREFEITURA MUNICIPAL DE BARUERI|barueri\.sp\.gov\.br\/nfe/i.test(text)) return parseBarueriNfse(cleanLines, text);
  if (/MUNIC[IÍ]PIO DE S[AÃ]O JOS[EÉ] DO RIO PRETO/i.test(text)) return parseRioPretoNfse(rawLines, text);
  if (/DANFSEe?\s*v?1\.0|Chave de Acesso(?: Nacional)? da NFS-e|Munic[ií]pio de Novo Hamburgo/i.test(text)) return parseNationalNfse(rawLines, text);
  throw new Error("Município ou layout ainda não reconhecido. Envie uma NFS-e com texto selecionável para adicionarmos este padrão.");
}

function parseRioPretoNfse(lines, text) {
  const providerSection = fiscalSection(text, /Prestador de Servi[cç]o/i, /Tomador de Servi[cç]o/i);
  const customerSection = fiscalSection(text, /Tomador de Servi[cç]o/i, /Atividade Econ[oô]mica/i);
  const detailsSection = fiscalSection(text, /Identifica[cç][aã]o Presta[cç][aã]o de Servi[cç]os/i, /Outras Informa[cç][oõ]es/i);
  const number = findValueAfterLabel(lines, /^NFS-e$/i, /^\d{1,12}$/) || (text.match(/NFS-e\s*\n?\s*(\d{1,12})\b/i) || [])[1];
  const auth = findValueAfterLabel(lines, /C[oó]digo de Verifica[cç][aã]o/i, /^[A-Z0-9-]{6,30}$/i);
  const issueRaw = findValueAfterLabel(lines, /Emiss[aã]o da NFS-e/i, /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/);
  const provider = parseLabeledParty(providerSection);
  const customer = parseLabeledParty(customerSection);
  const activity = fiscalSection(text, /Atividade Econ[oô]mica/i, /Discrimina[cç][aã]o do Servi[cç]o/i).replace(/Atividade Econ[oô]mica/i, "").trim();
  const description = fiscalSection(text, /Discrimina[cç][aã]o do Servi[cç]o/i, /Tributos Federais/i).replace(/Discrimina[cç][aã]o do Servi[cç]o/i, "").trim() || activity;
  const federal = parseRioPretoFederalTaxes(lines);
  const total = findFiscalLineValue(lines, /Valor do Servi[cç]o/i);
  const net = findFiscalLineValue(lines, /Valor L[ií]quido/i);
  const base = findFiscalLineValue(lines, /Base de C[aá]lculo/i);
  const deductions = findFiscalLineValue(lines, /Dedu[cç][oõ]es Previstas em Lei/i, 0);
  const rate = findFiscalLineValue(lines, /^Al[ií]quota/i);
  const iss = findFiscalLineValue(lines, /^ISSQN\b/i);
  const retentionTotal = findFiscalLineValue(lines, /Reten[cç][oõ]es Federais/i);
  const competence = (detailsSection.match(/Compet[eê]ncia\s+(\d{2}\/\d{4})/i) || [])[1];
  const serviceCode = (activity.match(/\b(\d{1,2}[.]\d{2})(?:[.]\d{2}[.]\d{3})?/i) || [])[1] || "";
  const substituted = findValueAfterLabel(lines, /NFS-e Substitu[ií]da/i, /^\d+$/);
  if (!number || !auth || !issueRaw || !provider.taxId || !customer.taxId || !Number.isFinite(total) || !Number.isFinite(net)) {
    throw new Error("A NFS-e de São José do Rio Preto foi reconhecida, mas faltaram número, código, partes ou valores essenciais.");
  }
  const issue = parseBrDateTime(issueRaw);
  const federalSum = roundFiscal(federal.pis + federal.cofins + federal.inss + federal.ir + federal.csll + federal.other);
  if (Number.isFinite(retentionTotal) && Math.abs(federalSum - retentionTotal) > 0.02) throw new Error("As retenções federais individualizadas não conferem com o total impresso na nota.");
  return {
    number, auth, issueDate: issue.date, time: issue.time, competence: competence ? brMonthToIso(competence) : issue.date,
    provider, customer, municipality: { code: "3549805", uf: "SP", name: "São José do Rio Preto" },
    serviceMunicipalityCode: "3549805", incidenceMunicipalityCode: "3549805",
    item: { code: serviceCode, description: activity || "Serviço prestado", rate, total },
    retentions: federal, total, deductions, base, iss, net, description,
    issRetained: /ISSQN a Reter[\s\S]{0,80}\(X\)\s*Sim/i.test(detailsSection), simple: /Simples Nacional[\s\S]{0,80}\(X\)\s*Sim/i.test(detailsSection),
    exigibility: Number((detailsSection.match(/Exigibilidade ISSQN\s+(\d+)/i) || [])[1] || 1), incentive: false,
    substitutedNumber: substituted || null, rps: parseRioPretoRps(lines)
  };
}

function parseNationalNfse(lines, text) {
  const isCriciuma = /Prefeitura Municipal de Crici[uú]ma/i.test(text);
  const isNovoHamburgo = /Munic[ií]pio de Novo Hamburgo/i.test(text);
  if (!isCriciuma && !isNovoHamburgo) throw new Error("O layout nacional foi identificado, mas o município emissor ainda não está mapeado.");
  const municipality = isCriciuma ? { code: "4204608", uf: "SC", name: "Criciúma" } : { code: "4313409", uf: "RS", name: "Novo Hamburgo" };
  const providerSection = fiscalSection(text, /EMITENTE DA NFS-e/i, /TOMADOR DO SERVI[CÇ]O/i);
  const customerSection = fiscalSection(text, /TOMADOR DO SERVI[CÇ]O/i, /(?:INTERMEDI[AÁ]RIO|SERVI[CÇ]O PRESTADO)/i);
  const serviceSection = fiscalSection(text, /SERVI[CÇ]O PRESTADO/i, /(?:TRIBUTA[CÇ][AÃ]O MUNICIPAL|VALOR TOTAL DA NFS-e)/i);
  const provider = parseNationalParty(providerSection);
  const customer = parseNationalParty(customerSection);
  const number = findValueAfterLabel(lines, /N[uú]mero da (?:NFS-e|Nota Fiscal)/i, /^\d{1,15}$/);
  const auth = (text.match(/\bNFS\d{35,60}\b/) || [])[0] || findValueAfterLabel(lines, /C[oó]digo de Autenticidade/i, /^\d{20,70}$/);
  const issueRaw = findValueAfterLabel(lines, /Data e Hora da emiss[aã]o da NFS-e/i, /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?$/) || findValueAfterLabel(lines, /Data e Hora da emiss[aã]o do DPS/i, /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?$/);
  const competenceRaw = findValueAfterLabel(lines, /Compet[eê]ncia da NFS-e/i, /^\d{2}\/\d{2}\/\d{4}$/);
  const municipalGrid = isCriciuma ? parseCriciumaMunicipalGrid(lines) : null;
  const total = municipalGrid?.total ?? findFiscalLineValue(lines, /Valor do Servi[cç]o/i);
  const net = findFiscalLineValue(lines, /Valor L[ií]quido(?: da NFS-e)?/i);
  let deductions = municipalGrid?.deductions ?? findFiscalLineValue(lines, /(?:Total Dedu[cç][oõ]es\/Redu[cç][oõ]es|Dedu[cç][oõ]es)/i, 0);
  const base = municipalGrid?.base ?? findFiscalLineValue(lines, /BC ISSQN|Base de C[aá]lculo/i, total - deductions);
  // DANFSe prints the labels in one row and their amounts in another. Some
  // browser/PDF combinations split those rows differently and can associate
  // the base amount with the deductions label. The base and service total are
  // the authoritative pair for the ABRASF deduction in these mapped layouts.
  if (Number.isFinite(total) && Number.isFinite(base)) {
    const derivedDeductions = roundFiscal(Math.max(0, total - base));
    if (!Number.isFinite(deductions) || Math.abs(roundFiscal(total - deductions) - base) > 0.02) deductions = derivedDeductions;
  }
  const taxes = isNovoHamburgo ? parseNationalTaxTable(lines) : parseCriciumaTaxes(lines);
  const rate = municipalGrid?.rate ?? (Number.isFinite(taxes._issRate) ? taxes._issRate : findFiscalLineValue(lines, /Al[ií]quota (?:Aplicada|ISSQN)/i));
  const iss = municipalGrid?.iss ?? (Number.isFinite(taxes._iss) ? taxes._iss : findFiscalLineValue(lines, /ISSQN (?:Apurado|Retido)|^ISSQN\b/i, roundFiscal(base * rate / 100)));
  delete taxes._issRate;
  delete taxes._iss;
  const code = (serviceSection.match(/C[oó]digo de Tributa[cç][aã]o Nacional[\s\S]{0,160}?\b(\d{2}[.]?\d{2}[.]?\d{2}|\d{6})\b/i) || serviceSection.match(/\b(\d{2}[.]\d{2}[.]\d{2}|\d{6})\b/) || [])[1] || "";
  const description = fiscalSection(serviceSection, /Descri[cç][aã]o do Servi[cç]o/i, /$/).replace(/Descri[cç][aã]o do Servi[cç]o/i, "").trim() || "Serviço prestado";
  if (!number || !auth || !issueRaw || !provider.taxId || !customer.taxId || !Number.isFinite(total) || !Number.isFinite(net)) throw new Error("A NFS-e foi reconhecida, mas faltaram número, autenticação, partes ou valores essenciais.");
  const issue = parseBrDateTime(issueRaw);
  return {
    number, auth, issueDate: issue.date, time: issue.time, competence: competenceRaw ? brDateToIso(competenceRaw) : issue.date,
    provider, customer, municipality, serviceMunicipalityCode: municipality.code, incidenceMunicipalityCode: municipality.code,
    item: { code: onlyDigits(code), description: code || "Serviço prestado", rate, total }, retentions: taxes,
    total, deductions, base, iss, net, description, issRetained: /Reten[cç][aã]o do ISSQN[\s\S]{0,100}\bRetido\b/i.test(text) && !/N[aã]o Retido/i.test(text),
    simple: /Simples Nacional[\s\S]{0,100}(?:Sim|Optante)/i.test(providerSection) && !/N[aã]o Optante/i.test(providerSection), exigibility: 1, incentive: false,
    substitutedNumber: null, rps: parseNationalRps(lines)
  };
}

function parseCriciumaMunicipalGrid(lines) {
  const serviceHeader = lines.findIndex(line => {
    const text = stripLayoutMarkers(line);
    return /Valor\s+do\s+Servi[cç]o/i.test(text) && /Total\s+Dedu[cç][oõ]es\/Redu[cç][oõ]es/i.test(text);
  });
  const taxHeader = lines.findIndex(line => {
    const text = stripLayoutMarkers(line);
    return /BC\s+ISSQN/i.test(text) && /Al[ií]quota\s+Aplicada/i.test(text) && /ISSQN\s+Apurado/i.test(text);
  });
  if (serviceHeader < 0 || taxHeader < 0) return null;

  const serviceAnchors = findGridAnchors(lines[serviceHeader], [/^Valor\b/i, /^Desconto\b/i, /^Total\b/i, /^C[aá]lculo\b/i]);
  const taxAnchors = findGridAnchors(lines[taxHeader], [/^BC\b/i, /^Al[ií]quota\b/i, /^Reten[cç][aã]o\b/i, /^ISSQN\b/i], true);
  const serviceValues = readGridValueRow(lines, serviceHeader, serviceAnchors);
  const taxValues = readGridValueRow(lines, taxHeader, taxAnchors);
  if (!serviceValues || !taxValues) return null;

  const total = parseGridMoney(serviceValues[0]);
  const deductions = parseGridMoney(serviceValues[2], 0);
  const base = parseGridMoney(taxValues[0]);
  const rate = parseGridMoney(taxValues[1]);
  const iss = parseGridMoney(taxValues[3]);
  return [total, deductions, base, rate, iss].every(Number.isFinite) ? { total, deductions, base, rate, iss } : null;
}

function findGridAnchors(line, patterns, lastIss = false) {
  const cells = splitLayoutCells(line);
  return patterns.map((pattern, index) => {
    const matches = cells.filter(cell => pattern.test(cell.text));
    if (!matches.length) return NaN;
    return lastIss && index === patterns.length - 1 ? matches[matches.length - 1].x : matches[0].x;
  });
}

function readGridValueRow(lines, headerIndex, anchors) {
  if (!anchors.every(Number.isFinite)) return null;
  for (const line of lines.slice(headerIndex + 1, headerIndex + 4)) {
    const cells = splitLayoutCells(line);
    if (!cells.some(cell => /\d[,.]\d{2}|^-$/i.test(cell.text))) continue;
    return anchors.map((start, index) => {
      const end = anchors[index + 1] ?? Infinity;
      return cells.filter(cell => cell.x >= start - 3 && cell.x < end - 3).map(cell => cell.text).join(" ");
    });
  }
  return null;
}

function parseGridMoney(value, fallback = NaN) {
  const match = String(value || "").match(/-?(?:\d{1,3}(?:\.\d{3})*|\d+)[,.]\d{2}/);
  return match ? parseFlexibleFiscalMoney(match[0]) : fallback;
}

function fiscalSection(text, startPattern, endPattern) {
  const source = String(text || "");
  const startMatch = source.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return "";
  const rest = source.slice(startMatch.index);
  if (endPattern.source === "$") return rest;
  const endMatch = rest.slice(startMatch[0].length).match(endPattern);
  return endMatch && endMatch.index !== undefined ? rest.slice(0, startMatch[0].length + endMatch.index) : rest;
}

function findValueAfterLabel(lines, label, valuePattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const currentParts = splitLayoutCells(lines[index]);
    const labelIndex = currentParts.findIndex(cell => label.test(cell.text));
    if (labelIndex < 0) continue;
    const labelCell = currentParts[labelIndex];
    const candidates = [labelCell.text.replace(label, "").trim(), ...currentParts.slice(labelIndex + 1).map(cell => cell.text)];
    for (const nextLine of lines.slice(index + 1, index + 5)) {
      const cells = splitLayoutCells(nextLine);
      const nearest = [...cells].sort((a, b) => Math.abs(a.x - labelCell.x) - Math.abs(b.x - labelCell.x))[0];
      if (nearest) candidates.push(nearest.text);
      candidates.push(...cells.map(cell => cell.text));
    }
    for (const candidate of candidates) {
      const value = String(candidate).trim();
      const match = value.match(valuePattern);
      if (match) return match[0];
    }
  }
  return "";
}

function splitLayoutParts(line) {
  return splitLayoutCells(line).map(cell => cell.text);
}

function splitLayoutCells(line) {
  const source = String(line || "");
  const marked = [...source.matchAll(/\uE000(\d+)\uE001([^\uE000]*)/g)].map(match => ({ x: Number(match[1]), text: match[2].trim() })).filter(cell => cell.text);
  if (marked.length) return marked;
  let cursor = 0;
  return source.split(/\s{2,}|\t/).map(part => { const x = source.indexOf(part, cursor); cursor = x + part.length; return { x: Math.max(0, x), text: part.trim() }; }).filter(cell => cell.text);
}

function extractFiscalTaxId(section) {
  const labelMatch = String(section || "").match(/(?:CNPJ\s*[\/-]?\s*CPF|CPF\s*[\/-]?\s*CNPJ|CNPJ|CPF)[^0-9]{0,30}((?:\d[ .\/-]?){10,18}\d)/i);
  if (labelMatch) {
    const digits = onlyDigits(labelMatch[1]);
    if (digits.length === 11 || digits.length === 14) return digits;
  }
  const candidates = String(section || "").match(/(?:\d[ .\/-]?){11,18}/g) || [];
  return candidates.map(onlyDigits).find(value => value.length === 11 || value.length === 14) || "";
}

function parseLabeledParty(section) {
  const taxId = extractFiscalTaxId(section);
  const name = (section.match(/Nome\/Raz[aã]o Social:\s*([^\n]+)/i) || [])[1]?.trim() || "";
  const municipalRegistration = (section.match(/Inscri[cç][aã]o(?: Municipal)?:?\s*(\d{3,20})/i) || [])[1] || "";
  const email = (section.match(/E-mail:\s*([^\s\n]+)/i) || [])[1] || "";
  const cep = onlyDigits((section.match(/CEP:\s*(\d{5}-?\d{3})/i) || [])[1]);
  return { taxId, name, municipalRegistration, emails: email ? [email] : [], cep };
}

function parseNationalParty(section) {
  const taxId = extractFiscalTaxId(section);
  const lines = String(section || "").split("\n").map(value => value.trim()).filter(Boolean);
  const nameIndex = lines.findIndex(line => /Nome \/ Nome Empresarial/i.test(line));
  let name = "";
  for (let index = nameIndex + 1; index < Math.min(lines.length, nameIndex + 4); index += 1) {
    if (!/^(?:E-mail|Endere[cç]o|Munic[ií]pio|CEP)$/i.test(lines[index]) && lines[index].length > 3) { name = lines[index].replace(/\s{2,}.*$/, "").trim(); break; }
  }
  const email = (section.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/) || [])[0] || "";
  const cep = onlyDigits((section.match(/\b\d{5}-?\d{3}\b/) || [])[0]);
  return { taxId, name, municipalRegistration: "", emails: email ? [email] : [], cep };
}

function findFiscalLineValue(lines, label, fallback = NaN) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitLayoutCells(lines[lineIndex]);
    const partIndex = cells.findIndex(cell => label.test(cell.text));
    if (partIndex < 0) continue;
    const labelCell = cells[partIndex];
    const matchedLabel = labelCell.text.match(label)?.[0] || "";
    const candidates = [labelCell.text.slice(labelCell.text.indexOf(matchedLabel) + matchedLabel.length)];
    for (const nextLine of lines.slice(lineIndex + 1, lineIndex + 4)) {
      const nextCells = splitLayoutCells(nextLine);
      const nearest = [...nextCells].sort((a, b) => Math.abs(a.x - labelCell.x) - Math.abs(b.x - labelCell.x))[0];
      // PDF.js preserves each column's horizontal position. Keep the rows in
      // reading order: reversing them could associate a later field (for
      // example BC ISSQN) with Total Deducoes from the row above.
      if (nearest) candidates.push(nearest.text);
    }
    // Some municipal PDFs print label and amount on the same baseline.
    candidates.push(...cells.slice(partIndex + 1).map(cell => cell.text));
    for (const candidate of candidates) {
      const match = candidate.match(/-?(?:\d{1,3}(?:\.\d{3})*|\d+)[,.]\d{2}/);
      if (match) return parseFlexibleFiscalMoney(match[0]);
    }
  }
  return fallback;
}

function parseFlexibleFiscalMoney(value) {
  let text = String(value || "").trim();
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma > dot) text = text.replace(/\./g, "").replace(",", ".");
  else if (dot > comma && comma >= 0) text = text.replace(/,/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function parseRioPretoFederalTaxes(lines) {
  const start = lines.findIndex(line => /\bPIS\b/i.test(line) && /COFINS/i.test(line) && /INSS/i.test(line) && /\bIR\b/i.test(line) && /CSLL/i.test(line));
  const sample = start >= 0 ? lines.slice(start + 1, start + 5).join(" ") : "";
  const values = sample.match(/(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}/g)?.slice(0, 5).map(parseFiscalMoney) || [];
  return { pis: values[0] || 0, cofins: values[1] || 0, inss: values[2] || 0, ir: values[3] || 0, csll: values[4] || 0, other: 0 };
}

function parseNationalTaxTable(lines) {
  const result = { pis: 0, cofins: 0, inss: 0, ir: 0, csll: 0, other: 0 };
  const keys = { PIS: "pis", COFINS: "cofins", INSS: "inss", IRRF: "ir", CSLL: "csll" };
  for (const rawLine of lines) {
    const line = stripLayoutMarkers(rawLine);
    const issMatch = line.match(/^\s*ISSQN\s+([\d.,]+)\s*%\s+R\$\s*([\d.,]+)/i);
    if (issMatch) { result._issRate = parseFlexibleFiscalMoney(issMatch[1]); result._iss = parseFlexibleFiscalMoney(issMatch[2]); }
    const match = line.match(/^\s*(PIS|COFINS|INSS|IRRF|CSLL)\b[\s\S]*?R\$\s*([\d.,]+)[\s\S]*?\b(Sim|N[aã]o)\b/i);
    if (match && /^Sim$/i.test(match[3])) result[keys[match[1].toUpperCase()]] = parseFlexibleFiscalMoney(match[2]);
  }
  return result;
}

function parseCriciumaTaxes(lines) {
  const result = { pis: 0, cofins: 0, inss: 0, ir: 0, csll: 0, other: 0 };
  const header = lines.findIndex(line => /IRRF/i.test(line) && /Contribui[cç][aã]o Previdenci[aá]ria/i.test(line));
  if (header >= 0) {
    const next = lines.slice(header + 1, header + 3).flatMap(splitLayoutParts);
    const amount = next.map(value => value.match(/R\$\s*([\d.,]+)/i)?.[1]).find(Boolean);
    if (amount) result.ir = parseFlexibleFiscalMoney(amount);
  }
  return result;
}

function parseBrDateTime(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return { date: "", time: "" };
  return { date: `${match[3]}-${match[2]}-${match[1]}`, time: `${match[4]}:${match[5]}:${match[6] || "00"}` };
}

function brMonthToIso(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{4})$/);
  return match ? `${match[2]}-${match[1]}-01` : "";
}

function parseRioPretoRps(lines) {
  const header = lines.findIndex(line => /^RPS\b/i.test(line) && /S[eé]rie RPS/i.test(line));
  if (header < 0) return null;
  const sample = lines.slice(header + 1, header + 3).join(" ").trim();
  const match = sample.match(/^\s*(\d+)\s+([A-Z])\s+(\d)\b/i);
  return match ? { number: match[1], series: match[2], type: Number(match[3]), date: "" } : null;
}

function parseNationalRps(lines) {
  const number = findValueAfterLabel(lines, /N[uú]mero (?:do )?(?:DPS|RPS)/i, /^\d+$/);
  const series = findValueAfterLabel(lines, /S[eé]rie (?:do )?(?:DPS|RPS)/i, /^[A-Z0-9]{1,10}$/i);
  const dateRaw = findValueAfterLabel(lines, /Data e Hora de emiss[aã]o (?:da|do) (?:DPS|RPS)/i, /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?$/);
  return number ? { number, series: series || "1", type: 1, date: dateRaw ? parseBrDateTime(dateRaw).date : "" } : null;
}

function parseBarueriNfse(lines, text) {
  if (!/PREFEITURA MUNICIPAL DE BARUERI|barueri\.sp\.gov\.br\/nfe/i.test(text)) {
    throw new Error("O documento não corresponde ao layout de NFS-e de Barueri.");
  }
  const providerSection = fiscalSection(text, /Prestador de Servi[cç]os/i, /Nome Tomador de Servi[cç]os/i);
  const customerSection = fiscalSection(text, /Nome Tomador de Servi[cç]os/i, /Qtde\s+Descri[cç][aã]o do Servi[cç]o/i);
  const providerTaxId = extractFiscalTaxId(providerSection);
  const customerTaxId = extractFiscalTaxId(customerSection);
  if (!providerTaxId || !customerTaxId) throw new Error("Não foi possível identificar CPF/CNPJ do prestador ou do tomador dentro das respectivas seções.");
  const auth = (text.match(/\b[A-Z0-9]{4}(?:\.[A-Z0-9]{4}){2}\.[A-Z0-9]{5,12}-[A-Z0-9]\b/i) || [])[0];
  const dates = text.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
  const time = (text.match(/\b\d{2}:\d{2}\b/) || [])[0] || "00:00";
  const number = findBarueriInvoiceNumber(lines) || numberFromFilenameFallback(text);
  const rps = findBarueriRps(lines, text);
  const item = findBarueriServiceItem(lines, text);
  const retentions = findBarueriRetentions(lines, text);
  const total = findLabeledFiscalMoney(lines, /VALOR TOTAL DA NOTA/i);
  const net = findFiscalMoneyNear(text, /Valor L[ií]quido/i);
  const provider = providerSection.replace(/^[\s\S]*?Prestador de Servi[cç]os/i, "").split("\n").map(value => value.trim()).find(value => value.length > 5 && !/^(?:CNPJ|CPF|ALAMEDA|RUA|CEP)/i.test(value)) || "";
  const customer = customerSection.replace(/^[\s\S]*?Nome Tomador de Servi[cç]os/i, "").split("\n").map(value => value.trim()).find(value => value.length > 5 && !/^(?:CPF|CNPJ|Endere[cç]o|Complemento)/i.test(value)) || "";
  const emails = [...new Set(text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [])];
  const description = extractBarueriDescription(lines);
  const issueDate = brDateToIso(dates[0]);
  if (!number || !auth || !issueDate || !item || !Number.isFinite(total)) {
    throw new Error("A nota foi reconhecida como Barueri, mas faltaram número, autenticação, data, serviço ou valor total.");
  }
  const serviceTotal = item.total || total;
  const base = total;
  const iss = roundFiscal(base * item.rate / 100);
  return {
    number, auth, issueDate, time: `${time}:00`, rps,
    provider: { taxId: providerTaxId, name: provider, municipalRegistration: findBarueriMunicipalRegistration(lines), emails: [] },
    customer: { taxId: customerTaxId, name: customer, emails },
    municipality: { code: "3505708", uf: "SP", name: "Barueri" }, serviceMunicipalityCode: "3505708", incidenceMunicipalityCode: "3505708",
    item: { ...item, total: serviceTotal }, retentions, total, deductions: 0, base, iss,
    net: Number.isFinite(net) ? net : roundFiscal(total - Object.values(retentions).reduce((sum, value) => sum + value, 0)),
    description, competence: issueDate, issRetained: false, simple: false, exigibility: 1, incentive: false, substitutedNumber: null
  };
}

function findBarueriInvoiceNumber(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/N[úu]mero da Nota/i.test(lines[index])) continue;
    const sample = lines.slice(index, index + 4).join(" ");
    const match = sample.match(/\b0*(\d{4,7})\b/);
    if (match) return match[1];
  }
  return "";
}

function numberFromFilenameFallback(text) {
  return (text.match(/\bN[ºo.]?\s*0*(\d{4,7})\b/i) || [])[1] || "";
}

function findBarueriRps(lines, text) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/N[úu]mero RPS/i.test(lines[index])) continue;
    const sample = lines.slice(index, index + 4).join(" ");
    const match = sample.match(/\b0*(\d{5,10})\b\s+([A-Z]{2,5})\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (match) return { number: match[1], series: match[2].toUpperCase(), date: brDateToIso(match[3]) };
  }
  const fallback = text.match(/\b0*(\d{5,10})\s+NFSE\s+(\d{2}\/\d{2}\/\d{4})/i);
  return fallback ? { number: fallback[1], series: "NFSE", date: brDateToIso(fallback[2]) } : null;
}

function findBarueriServiceItem(lines, text) {
  for (const line of lines) {
    const values = [...line.matchAll(/(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}/g)].map(match => ({ index: match.index, value: parseFiscalMoney(match[0]) }));
    const code = line.match(/\b(\d{8,9})\b/);
    if (!code || values.length < 3 || !/^\s*\d+\b/.test(line)) continue;
    const quantity = Number((line.match(/^\s*(\d+)/) || [])[1] || 1);
    const rate = values[values.length - 3].value;
    const unit = values[values.length - 2].value;
    const total = values[values.length - 1].value;
    const extractedDescription = line.slice(line.search(/\s/) + 1, code.index).trim() || "Serviço prestado";
    const description = code[1] === "171001220"
      ? "Planejamento, organização e administração de feiras, exposições e congêneres"
      : extractedDescription;
    return { quantity, description, code: code[1], rate, unit, total };
  }
  const code = (text.match(/C[oó]digo Servi[cç]o[\s\S]{0,160}?\b(\d{8,9})\b/i) || [])[1];
  return code ? { quantity: 1, description: "Serviço prestado", code, rate: 0, unit: 0, total: 0 } : null;
}

function findBarueriRetentions(lines, text) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/IRRF/i.test(lines[index]) || !/PIS\/PASEP/i.test(lines[index]) || !/COFINS/i.test(lines[index]) || !/CSLL/i.test(lines[index])) continue;
    const sample = lines.slice(index + 1, index + 4).join(" ");
    const values = sample.match(/(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}/g)?.slice(0, 4).map(parseFiscalMoney);
    if (values?.length === 4) return { ir: values[0], pis: values[1], cofins: values[2], csll: values[3], inss: 0, other: 0 };
  }
  return {
    ir: findFiscalMoneyNear(text, /Reten[cç][aã]o IRRF[^\n]*/i) || 0,
    pis: 0, cofins: 0, csll: 0, inss: 0, other: 0
  };
}

function findLabeledFiscalMoney(lines, label) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!label.test(lines[index])) continue;
    const values = lines.slice(index, index + 3).join(" ").match(/(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}/g);
    if (values?.length) return parseFiscalMoney(values[values.length - 1]);
  }
  return NaN;
}

function findFiscalMoneyNear(text, label) {
  const match = text.match(new RegExp(`${label.source}[^\\d]{0,20}(?:R\\$\\s*)?((?:\\d{1,3}(?:\\.\\d{3})*|\\d+),\\d{2})`, "i"));
  return match ? parseFiscalMoney(match[1]) : NaN;
}

function findSectionEntityName(lines, label, cnpj) {
  const formatted = formatCnpj(cnpj);
  const start = lines.findIndex(line => label.test(line));
  for (let index = Math.max(0, start); index < Math.min(lines.length, start + 6); index += 1) {
    const line = lines[index];
    if (line.includes(formatted)) {
      const before = line.slice(0, line.indexOf(formatted)).replace(label, "").trim();
      if (before.length > 3 && !/^(?:CNPJ|CPF|CNPJ\s*\/\s*CPF|Inscri[cç][aã]o Municipal)$/i.test(before)) return before;
    }
  }
  const sameLine = start >= 0 ? lines[start].replace(label, "").trim() : "";
  return sameLine.length > 3 ? sameLine : "";
}

function findBarueriMunicipalRegistration(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/Inscri[cç][aã]o Municipal/i.test(lines[index])) continue;
    const sample = lines.slice(index, index + 3).join(" ");
    const match = sample.match(/\b\d\.[A-Z]{2}\d{3}-\d\b/i);
    if (match) return match[0].toUpperCase();
  }
  return "";
}

function extractBarueriDescription(lines) {
  const start = lines.findIndex(line => /DISCRIMINA[CÇ][AÃ]O DOS SERVI[CÇ]OS/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /VALORES DE REPASSE A TERCEIROS/i.test(line));
  return start >= 0 ? lines.slice(start + 1, end > start ? end : start + 15).join("\n").trim() : "Serviço prestado";
}

function validateAbrasfInvoice(invoice, strict) {
  if (!invoice || typeof invoice !== "object") throw new Error("A leitura da NFS-e não produziu dados fiscais válidos.");
  if (!String(invoice.number || "").trim() || !String(invoice.auth || "").trim()) throw new Error("Número da NFS-e ou código de verificação não foi identificado.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.issueDate || "") || !/^\d{2}:\d{2}:\d{2}$/.test(invoice.time || "")) throw new Error("Data ou hora de emissão da NFS-e está ausente ou inválida.");
  if (![11, 14].includes(onlyDigits(invoice.provider.taxId).length) || ![11, 14].includes(onlyDigits(invoice.customer.taxId).length)) throw new Error("CPF/CNPJ do prestador ou tomador está ausente ou incompleto.");
  if (!String(invoice.provider.name || "").trim() || !String(invoice.customer.name || "").trim()) throw new Error("Razão social do prestador ou do tomador não foi identificada.");
  if (!invoice.municipality?.code || !/^\d{7}$/.test(invoice.municipality.code)) throw new Error("Código IBGE do município emissor não foi identificado.");
  if (!String(invoice.item?.code || "").trim()) throw new Error("Código do serviço não foi identificado; o XML não será preenchido por suposição.");
  const requiredMoney = { "valor do serviço": invoice.total, "deduções": invoice.deductions, "base de cálculo": invoice.base, "ISSQN": invoice.iss, "valor líquido": invoice.net };
  const missingMoney = Object.entries(requiredMoney).filter(([, value]) => !Number.isFinite(value)).map(([label]) => label);
  if (missingMoney.length) throw new Error(`Campos fiscais ausentes: ${missingMoney.join(", ")}. O DOCPronto não substitui campos ausentes por 0,00.`);
  if (!Number.isFinite(invoice.item.rate) || invoice.item.rate < 0) throw new Error("Alíquota do serviço está ausente ou inválida.");
  const retentionEntries = Object.entries(invoice.retentions || {});
  if (!retentionEntries.length || retentionEntries.some(([, value]) => !Number.isFinite(Number(value)))) throw new Error("As retenções não foram identificadas de forma segura.");
  const retentionTotal = Object.values(invoice.retentions).reduce((sum, value) => sum + Number(value || 0), 0);
  const expectedNet = roundFiscal(invoice.total - retentionTotal);
  if (strict && Math.abs(expectedNet - invoice.net) > 0.02) {
    throw createSafeParserError("NFSE_TOTALS_MISMATCH", "Os valores fiscais da NFS-e não conferem. Revise o documento antes de gerar o XML.");
  }
  if (strict && invoice.item.rate <= 0) throw new Error("Não foi possível identificar uma alíquota positiva do serviço.");
  if (strict && Number.isFinite(invoice.base) && Number.isFinite(invoice.deductions) && Math.abs(roundFiscal(invoice.total - invoice.deductions) - invoice.base) > 0.02) {
    throw createSafeParserError("NFSE_BASE_MISMATCH", "Os valores fiscais da NFS-e não conferem. Revise o documento antes de gerar o XML.");
  }
  if (strict && Number.isFinite(invoice.iss) && Math.abs(roundFiscal(invoice.base * invoice.item.rate / 100) - invoice.iss) > 0.02) {
    throw createSafeParserError("NFSE_ISS_MISMATCH", "Os valores fiscais da NFS-e não conferem. Revise o documento antes de gerar o XML.");
  }
}

function validateAbrasf204Document(documentNode) {
  const root = documentNode.documentElement;
  if (!root || root.localName !== "CompNfse" || root.namespaceURI !== "http://www.abrasf.org.br/nfse.xsd") throw new Error("A raiz ou o namespace do XML não corresponde ao CompNfse ABRASF.");
  const one = name => {
    const nodes = root.getElementsByTagNameNS("*", name);
    if (nodes.length !== 1) throw new Error(`Estrutura ABRASF inválida: esperado exatamente um campo ${name}.`);
    return nodes[0];
  };
  const required = ["Nfse", "InfNfse", "Numero", "CodigoVerificacao", "DataEmissao", "ValoresNfse", "DeclaracaoPrestacaoServico", "Servico", "Prestador", "TomadorServico"];
  required.forEach(one);
  if (one("Nfse").getAttribute("versao") !== "2.04") throw new Error("A versão do bloco Nfse não é 2.04.");
  const moneyFields = ["BaseCalculo", "ValorLiquidoNfse", "ValorServicos", "ValorDeducoes"];
  moneyFields.forEach(name => {
    const value = one(name).textContent?.trim() || "";
    if (!/^\d+\.\d{2}$/.test(value)) throw new Error(`Campo monetário ABRASF inválido: ${name}.`);
  });
  const allText = root.textContent || "";
  if (/\b(?:NaN|undefined|null)\b/i.test(allText)) throw new Error("O XML contém campo não identificado e foi bloqueado antes do download.");
  const ids = [...root.querySelectorAll("[Id]")].map(node => node.getAttribute("Id"));
  if (new Set(ids).size !== ids.length) throw new Error("O XML contém identificadores duplicados.");
}

function buildAbrasfCompNfse(invoice) {
  const v = value => escapeXml(String(value ?? ""));
  const money = value => Number(value || 0).toFixed(2);
  const rate = (Number(invoice.item.rate || 0) / 100).toFixed(4);
  const issue = `${invoice.issueDate}T${invoice.time}-03:00`;
  const rps = invoice.rps ? `<Rps><IdentificacaoRps><Numero>${v(invoice.rps.number)}</Numero><Serie>${v(invoice.rps.series || "1")}</Serie><Tipo>${v(invoice.rps.type || 1)}</Tipo></IdentificacaoRps>${invoice.rps.date ? `<DataEmissao>${v(invoice.rps.date)}</DataEmissao>` : ""}<Status>1</Status></Rps>` : "";
  const emails = invoice.customer.emails?.length ? `<Contato><Email>${v(invoice.customer.emails.join(";"))}</Email></Contato>` : "";
  const taxIdXml = party => onlyDigits(party.taxId).length === 11 ? `<Cpf>${v(onlyDigits(party.taxId))}</Cpf>` : `<Cnpj>${v(onlyDigits(party.taxId))}</Cnpj>`;
  const municipality = invoice.municipality;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse versao="2.04"><InfNfse Id="NFSe${v(invoice.number)}"><Numero>${v(invoice.number)}</Numero><CodigoVerificacao>${v(invoice.auth)}</CodigoVerificacao><DataEmissao>${issue}</DataEmissao><ValoresNfse><BaseCalculo>${money(invoice.base)}</BaseCalculo><Aliquota>${rate}</Aliquota><ValorIss>${money(invoice.iss)}</ValorIss><ValorLiquidoNfse>${money(invoice.net)}</ValorLiquidoNfse></ValoresNfse><DescricaoCodigoTributacaoMunicipio>${v(invoice.item.description)}</DescricaoCodigoTributacaoMunicipio><PrestadorServico><RazaoSocial>${v(invoice.provider.name)}</RazaoSocial><Endereco><CodigoMunicipio>${v(municipality.code)}</CodigoMunicipio><Uf>${v(municipality.uf)}</Uf></Endereco></PrestadorServico><OrgaoGerador><CodigoMunicipio>${v(municipality.code)}</CodigoMunicipio><Uf>${v(municipality.uf)}</Uf></OrgaoGerador><DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico Id="DPS${v(invoice.number)}">${rps}<Competencia>${v(invoice.competence || invoice.issueDate)}</Competencia><Servico><Valores><ValorServicos>${money(invoice.total)}</ValorServicos><ValorDeducoes>${money(invoice.deductions)}</ValorDeducoes><ValorPis>${money(invoice.retentions.pis)}</ValorPis><ValorCofins>${money(invoice.retentions.cofins)}</ValorCofins><ValorInss>${money(invoice.retentions.inss)}</ValorInss><ValorIr>${money(invoice.retentions.ir)}</ValorIr><ValorCsll>${money(invoice.retentions.csll)}</ValorCsll><OutrasRetencoes>${money(invoice.retentions.other)}</OutrasRetencoes><ValorIss>${money(invoice.iss)}</ValorIss><Aliquota>${rate}</Aliquota><DescontoIncondicionado>0.00</DescontoIncondicionado><DescontoCondicionado>0.00</DescontoCondicionado></Valores><IssRetido>${invoice.issRetained ? 1 : 2}</IssRetido><ItemListaServico>${v(serviceListItem(invoice.item.code))}</ItemListaServico><CodigoTributacaoMunicipio>${v(onlyDigits(invoice.item.code))}</CodigoTributacaoMunicipio><Discriminacao>${v(invoice.description)}</Discriminacao><CodigoMunicipio>${v(invoice.serviceMunicipalityCode || municipality.code)}</CodigoMunicipio><ExigibilidadeISS>${v(invoice.exigibility || 1)}</ExigibilidadeISS><MunicipioIncidencia>${v(invoice.incidenceMunicipalityCode || municipality.code)}</MunicipioIncidencia></Servico><Prestador><CpfCnpj>${taxIdXml(invoice.provider)}</CpfCnpj>${invoice.provider.municipalRegistration ? `<InscricaoMunicipal>${v(invoice.provider.municipalRegistration)}</InscricaoMunicipal>` : ""}</Prestador><TomadorServico><IdentificacaoTomador><CpfCnpj>${taxIdXml(invoice.customer)}</CpfCnpj>${invoice.customer.municipalRegistration ? `<InscricaoMunicipal>${v(invoice.customer.municipalRegistration)}</InscricaoMunicipal>` : ""}</IdentificacaoTomador><RazaoSocial>${v(invoice.customer.name)}</RazaoSocial>${emails}</TomadorServico><OptanteSimplesNacional>${invoice.simple ? 1 : 2}</OptanteSimplesNacional><IncentivoFiscal>${invoice.incentive ? 1 : 2}</IncentivoFiscal></InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico></InfNfse></Nfse></CompNfse>`;
}

function serviceListItem(code) {
  const digits = onlyDigits(code);
  return digits.length >= 4 ? `${digits.slice(0, 2)}.${digits.slice(2, 4)}` : code;
}

function parseFiscalMoney(value) {
  const parsed = Number(String(value || "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function roundFiscal(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatCnpj(value) {
  const digits = onlyDigits(value).padStart(14, "0");
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function brDateToIso(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

async function loadPdfJs() {
  const pdfjs = await import(new URL("vendor/pdf.min.mjs", docProntoBaseUrl).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", docProntoBaseUrl).href;
  return pdfjs;
}

function groupPdfTextLines(items) {
  const rows = new Map();
  items.forEach(item => {
    const text = String(item.str || "").trim();
    if (!text) return;
    const y = Math.round(Number(item.transform?.[5] || 0) / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ text, x: Number(item.transform?.[4] || 0) });
  });
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) => parts
      .sort((a, b) => a.x - b.x)
      .map(part => `\uE000${Math.round(part.x)}\uE001${part.text}`)
      .join(" "));
}

function stripLayoutMarkers(value) {
  return String(value || "").replace(/\uE000\d+\uE001/g, "");
}

function layoutXAt(line, index) {
  const markers = [...String(line).slice(0, index).matchAll(/\uE000(\d+)\uE001/g)];
  return markers.length ? Number(markers[markers.length - 1][1]) : null;
}

function parseStatementLine(line, metadata = {}) {
  if (isHeaderOrSummary(line)) return null;
  const dateMatch = findStatementDate(line, metadata.referenceDate);
  if (!dateMatch) return null;
  const amountMatches = findStatementAmounts(line);
  if (!amountMatches.length) return null;
  const amountMatch = chooseTransactionAmount(line, amountMatches, metadata);
  let amount = parseStatementAmount(amountMatch.value, amountMatch.marker, amountMatch.context);
  if (!Number.isFinite(amount)) return null;
  const direction = inferStatementDirection(line, metadata, amountMatch);
  if (direction > 0) {
    amount = Math.abs(amount);
  } else if (direction < 0) {
    amount = -Math.abs(amount);
  } else if (metadata.creditCard) {
    amount = amount < 0 || /\b(?:pagamento|pagto|pgto|deb(?:ito)?\s+(?:autom(?:atico)?\s+de\s+fatura|conta)|deb\s+em\s+c\/?c|cr[eé]dito|estorno|cashback|devolu[çc][aã]o)\b/i.test(line)
      ? Math.abs(amount)
      : -Math.abs(amount);
  }
  const date = dateMatch.normalized;
  const withoutDate = stripLayoutMarkers(line.replace(dateMatch.text, " "));
  const memoSource = metadata.creditCard ? simplifyCreditCardMemo(withoutDate) : withoutDate;
  const memo = memoSource
    .replace(amountMatch.full, " ")
    .replace(/(?:R\$\s*)?[+-]?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}\s*(?:saldo)?\s*$/i, " ")
    .replace(/\b(?:cr[eé]dito|credito|d[eé]bito|debito|valor|lan[çc]amento|lancamento)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!memo || isBalanceLine(line)) return null;
  return { date, amount, memo: memo.slice(0, 255), type: direction < 0 || amount < 0 ? "DEBIT" : "CREDIT" };
}

function inferStatementDirection(line, metadata = {}, amountMatch = null) {
  if (amountMatch && metadata.statementColumns) {
    const { debit, credit } = metadata.statementColumns;
    const debitDistance = Math.abs(amountMatch.x - debit);
    const creditDistance = Math.abs(amountMatch.x - credit);
    if (Math.min(debitDistance, creditDistance) <= 55) return debitDistance < creditDistance ? -1 : 1;
  }
  const normalized = String(line)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const incoming = /\b(?:recebimento|recebido|recebida|pix recebido|transferencia recebida|ted recebida|doc recebido|deposito|credito em conta|salario|proventos|rendimento|resgate|estorno|cashback|devolucao|reembolso)\b/;
  if (incoming.test(normalized)) return 1;

  if (metadata.creditCard && /\b(?:pagamento(?:\s+(?:de |da )?fatura)?|pagto|pgto|deb(?:ito)?\s+(?:autom(?:atico)?\s+de\s+fatura|conta)|deb\s+em\s+c\/?c|credito|estorno|cashback|devolucao|reembolso)\b/.test(normalized)) {
    return 1;
  }

  const outgoing = /\b(?:pagamento pix|pix enviado|transferencia enviada|ted enviada|doc enviado|pagamento|compra|saque|tarifa|taxa|juros|multa|imposto|debito automatico|boleto)\b/;
  if (outgoing.test(normalized)) return -1;

  return 0;
}

function parseStatementLines(lines, metadata = {}) {
  const transactions = [];
  let previousBalance = Number.isFinite(metadata.initialBalance) ? metadata.initialBalance : null;
  const useSectionGate = metadata.creditCard && lines.some(isCreditCardTransactionSection);
  let inTransactionSection = !useSectionGate;
  for (let index = 0; index < lines.length; index += 1) {
    let candidate = lines[index];
    if (isCreditCardTransactionSection(candidate)) {
      inTransactionSection = true;
      continue;
    }
    if (useSectionGate && isCreditCardSectionEnd(candidate)) {
      inTransactionSection = false;
      continue;
    }
    if (!inTransactionSection) continue;
    if (index > 0 && isDescriptionContinuation(lines[index - 1], candidate)) candidate = `${lines[index - 1]} ${candidate}`;
    const consumedTrailing = index + 1 < lines.length && isTrailingContinuation(lines[index + 1]);
    if (consumedTrailing) candidate = `${candidate} ${lines[index + 1]}`;
    const direct = parseStatementLine(candidate, metadata);
    if (direct) {
      transactions.push(metadata.creditCard ? direct : confirmTransactionWithBalance(direct, candidate, previousBalance));
      if (!metadata.creditCard) {
        const detectedBalance = findStatementBalance(candidate);
        if (Number.isFinite(detectedBalance)) previousBalance = detectedBalance;
      }
      if (consumedTrailing) index += 1;
      continue;
    }
    const hasDate = findStatementDate(lines[index], metadata.referenceDate);
    if (!hasDate) continue;
    const maxSpan = metadata.creditCard ? 6 : 3;
    for (let span = 1; span <= maxSpan && index + span < lines.length; span += 1) {
      if (span > 1 && findStatementDate(lines[index + span], metadata.referenceDate)) break;
      const combined = lines.slice(index, index + span + 1).join(" ");
      const transaction = parseStatementLine(combined, metadata);
      if (transaction) {
        transactions.push(metadata.creditCard ? transaction : confirmTransactionWithBalance(transaction, combined, previousBalance));
        if (!metadata.creditCard) {
          const detectedBalance = findStatementBalance(combined);
          if (Number.isFinite(detectedBalance)) previousBalance = detectedBalance;
        }
        index += span;
        break;
      }
    }
  }
  return transactions;
}

function findStatementBalance(line) {
  const amounts = findStatementAmounts(line);
  if (amounts.length < 2) return null;
  return parseStatementAmount(amounts[amounts.length - 1].value, amounts[amounts.length - 1].marker, amounts[amounts.length - 1].context);
}

function confirmTransactionWithBalance(transaction, line, previousBalance) {
  const currentBalance = findStatementBalance(line);
  if (!Number.isFinite(previousBalance) || !Number.isFinite(currentBalance)) return transaction;
  const movement = Number((currentBalance - previousBalance).toFixed(2));
  return { ...transaction, amount: movement, type: movement < 0 ? "DEBIT" : "CREDIT" };
}

function findStatementDate(line, referenceDate = null) {
  const plainLine = stripLayoutMarkers(line);
  const fullDates = [...plainLine.matchAll(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})\b/g)];
  const full = /(?:about:blank|\bIBPJ\b)/i.test(plainLine) && fullDates.length > 1 ? fullDates[fullDates.length - 1] : fullDates[0];
  if (full) return { text: full[0], index: String(line).indexOf(full[0]), normalized: normalizeStatementDate(full[1], full[2], full[3]) };
  const iso = plainLine.match(/\b(\d{4})[\/.-](\d{2})[\/.-](\d{2})\b/);
  if (iso) return { text: iso[0], index: String(line).indexOf(iso[0]), normalized: `${iso[1]}-${iso[2]}-${iso[3]}` };
  const namedMonth = plainLine.match(/\b(\d{1,2})[\/.-](jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)(?:[\/.-](\d{2,4}))?\b/i);
  if (namedMonth) {
    const months = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
    const month = months[namedMonth[2].toLowerCase()];
    const year = namedMonth[3] ? normalizeYear(namedMonth[3]) : inferTransactionYear(month, referenceDate);
    return { text: namedMonth[0], index: String(line).indexOf(namedMonth[0]), normalized: `${year}-${String(month).padStart(2, "0")}-${String(namedMonth[1]).padStart(2, "0")}` };
  }
  const short = plainLine.match(/^\s*(\d{2})[\/.-](\d{2})(?=\s)/);
  if (short) {
    const year = referenceDate?.getFullYear?.() || new Date().getFullYear();
    const text = short[0].trim();
    return { text, index: String(line).indexOf(text), normalized: `${year}-${short[2]}-${short[1]}` };
  }
  return null;
}

function inferFinancialMetadata(lines) {
  const text = lines.join("\n");
  const normalizedText = normalizeSearchText(text);
  const dueDate = normalizedText.match(/vencimento[\s\S]{0,80}?(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i);
  const documentDate = normalizedText.match(/(?:data\s+do\s+documento|atualizados\s+em|fechamento\s+proxima\s+fatura)[\s\S]{0,40}?(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i);
  const anyDate = normalizedText.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2}|19\d{2})\b/);
  const referenceMatch = dueDate || documentDate || anyDate;
  const referenceDate = referenceMatch
    ? new Date(Number(referenceMatch[3]), Number(referenceMatch[2]) - 1, Number(referenceMatch[1]))
    : new Date();
  const cardFinal = normalizedText.match(/(?:[x*]{4}[.\s-]*){3}(\d{4})\b/i)
    || normalizedText.match(/(?:cartao\s*(?:n[\u00BAo.:?]*|numero)?\s*[:.-]?\s*\d{0,8}\*+|n[\u00BAo?]\s*|final\s*)(\d{4})/i)
    || normalizedText.match(/\bcartao\s+(\d{4})\b/i)
    || normalizedText.match(/\b\d{4}\*{4,}(\d{4})\b/);
  const bankName = normalizedText.match(/\b(itau|bradesco|santander|sicredi|sicoob|nubank|inter|caixa|banco do brasil|btg|c6)\b/i);
  const knownBankId = /\b(?:bb\.com\.br|ouvidoria bb|central de relacionamento bb)\b/i.test(normalizedText)
    ? "BANCO-DO-BRASIL"
    : null;
  const bankCode = normalizedText.match(/\bbanco\s*:\s*(\d{3,4})\b/i);
  const agency = normalizedText.match(/\bagencia\s*:\s*([\d.-]+)/i);
  const checkingAccount = normalizedText.match(/\bconta\s+corrente\s*:\s*([\d.-]+)/i);
  const account = checkingAccount || normalizedText.match(/\bconta\s*:\s*([\d.-]+)/i);
  const headerLine = lines.find(line => /d[eé]bito/i.test(line) && /cr[eé]dito/i.test(line) && /saldo/i.test(line));
  const statementColumns = headerLine ? {
    debit: layoutXAt(headerLine, String(headerLine).toLowerCase().indexOf("débito")),
    credit: layoutXAt(headerLine, String(headerLine).toLowerCase().indexOf("crédito")),
    balance: layoutXAt(headerLine, String(headerLine).toLowerCase().lastIndexOf("saldo"))
  } : null;
  const cardHeaderLine = lines.find(line => {
    const normalized = normalizeSearchText(line);
    const hasLocal = /r\$|valor em reais/.test(normalized);
    const hasForeign = /us\$|valor em dolar/.test(normalized);
    return hasLocal && hasForeign && /(?:data|historico|descricao|compra)/.test(normalized);
  });
  const localCurrencyIndex = cardHeaderLine ? String(cardHeaderLine).search(/(?:R\$|valor em reais)/i) : -1;
  const foreignCurrencyIndex = cardHeaderLine ? String(cardHeaderLine).search(/(?:US\$|valor em d[oó]lar)/i) : -1;
  const cardAmountColumns = cardHeaderLine ? {
    local: localCurrencyIndex >= 0 ? layoutXAt(cardHeaderLine, localCurrencyIndex) : null,
    foreign: foreignCurrencyIndex >= 0 ? layoutXAt(cardHeaderLine, foreignCurrencyIndex) : null
  } : null;
  const readSummaryValue = label => {
    const match = normalizedText.match(new RegExp(`${label}\\s+(-?(?:\\d{1,3}(?:[.\\s]\\d{3})+|\\d+),\\d{2})`, "i"));
    return match ? parseStatementAmount(match[1]) : null;
  };
  const initialBalance = readSummaryValue("saldo\\s+inicial");
  const finalBalance = readSummaryValue("saldo\\s+final");
  const expectedCredits = readSummaryValue("total\\s+de\\s+creditos");
  const expectedDebits = readSummaryValue("total\\s+de\\s+debitos");
  const creditCard = /\b(?:fatura|cartao|mastercard|visa|elo|amex)\b/i.test(normalizedText);
  return {
    referenceDate,
    currency: Number.isFinite(cardAmountColumns?.local) || /(?:R\$|\breais\b|\bBRL\b)/i.test(text) ? "BRL" : /(?:US\$|\bUSD\b|d[oó]lar)/i.test(text) ? "USD" : "BRL",
    accountId: creditCard && cardFinal ? `CARTAO-${cardFinal[1]}` : account ? account[1] : cardFinal ? `CARTAO-${cardFinal[1]}` : `PDF-${simpleHash(text.slice(0, 500))}`,
    agencyId: agency ? agency[1] : "",
    bankId: bankCode ? bankCode[1] : knownBankId || (bankName ? bankName[1].toUpperCase().replace(/\s+/g, "-") : "PDF"),
    accountType: creditCard ? "CREDITCARD" : "CHECKING",
    creditCard,
    statementColumns,
    cardAmountColumns,
    initialBalance,
    finalBalance,
    expectedCredits,
    expectedDebits
  };
}

function normalizeYear(year) {
  return year.length === 2 ? (Number(year) >= 70 ? `19${year}` : `20${year}`) : year;
}

function inferTransactionYear(month, referenceDate) {
  const reference = referenceDate instanceof Date && !Number.isNaN(referenceDate.valueOf()) ? referenceDate : new Date();
  return month > reference.getMonth() + 1 ? reference.getFullYear() - 1 : reference.getFullYear();
}

function isDescriptionContinuation(previous, current) {
  return Boolean(findStatementDate(current)) && !findStatementDate(previous) && !findStatementAmounts(previous).length &&
    previous.length < 80 && !/^\d{1,8}$/.test(previous.trim()) && !isHeaderOrSummary(previous);
}

function isTrailingContinuation(line) {
  return !findStatementDate(line) && !findStatementAmounts(line).length && line.length <= 35 && !isHeaderOrSummary(line);
}

function isHeaderOrSummary(line) {
  const normalized = normalizeSearchText(line);
  return /\b(?:transacoes|data e hora|data historico|historico de despesas|descricao|valor origem|cotacao|total cartao|resumo da fatura|vencimento|limite|pagamento minimo|opcoes de pagamento|opcoes de parcelamento|programa de recompensa|encargos financeiros|encargos vigentes|taxas mensais|legenda|fechamento da proxima fatura|total de parcelas|recibo do pagador|autenticacao|beneficiario|nosso numero|sacador|avalista|codigo de barra|local do pagamento|instrucoes|\d+ de \d+)\b/i.test(normalized);
}

function isCreditCardTransactionSection(line) {
  const normalized = normalizeSearchText(line).replace(/\s+/g, " ").trim();
  return /\b(?:demonstrativo das transacoes|detalhe do extrato|detalhes da fatura|despesas no brasil|despesas no exterior|lancamentos nacionais|lancamentos internacionais)\b/i.test(normalized)
    || /^transacoes\s*$/.test(normalized);
}

function isCreditCardSectionEnd(line) {
  const normalized = normalizeSearchText(line);
  return /\b(?:total da fatura|legenda|atendimento 24 horas|taxa ao mes|taxas mensais|autenticacao|recibo do pagador|opcoes de parcelamento|encargos financeiros|encargos vigentes|programa de recompensa|sacador|avalista|codigo de barra)\b/i.test(normalized)
    || /^\s*total\s*:/.test(normalized);
}

function simplifyCreditCardMemo(value) {
  return String(value)
    .replace(/\b\d{2}[\/.-]\d{2}[\/.-]\d{4},?\s*\d{2}:\d{2}\s+IBPJ\s+about:blank\s+\d+\/\d+\b/gi, " ")
    .replace(/\b\d{2}[\/.-]\d{2}[\/.-]\d{4},?\s*\d{2}:\d{2}\s+IBPJ\b/gi, " ")
    .replace(/\b(?:IBPJ\s+)?about:blank\s+\d+\/\d+\b/gi, " ")
    .replace(/\b(?:BRL|R\$|USD|US\$|EUR)\b[\s\S]*$/i, " ")
    .replace(/(?:\s+(?:BRL|R\$|USD|US\$|EUR)?\s*\(?[+-]?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2,4}\)?){1,4}\s*$/i, " ");
}

function normalizeSearchText(value) {
  return stripLayoutMarkers(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0000/g, " ")
    .toLowerCase();
}

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36).toUpperCase();
}

function findStatementAmounts(line) {
  const pattern = /(?<![\d/])(\(?[+-]?\s*(?:R\$\s*)?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}\)?)(?:\s*([DC]))?(?![\d/])/gi;
  return [...line.matchAll(pattern)].map(match => ({
    full: match[0],
    value: match[1],
    marker: match[2] || "",
    index: match.index || 0,
    x: layoutXAt(line, match.index || 0),
    context: line.slice(Math.max(0, (match.index || 0) - 18), (match.index || 0) + match[0].length + 18)
  }));
}

function chooseTransactionAmount(line, amounts, metadata = {}) {
  if (metadata.creditCard && amounts.length >= 2) {
    const nonZero = amounts.filter(item => Math.abs(parseStatementAmount(item.value, item.marker, item.context)) > 0);
    if (nonZero.length === 1) return nonZero[0];
  }
  if (metadata.creditCard && Number.isFinite(metadata.cardAmountColumns?.local)) {
    const positioned = amounts.filter(item => Number.isFinite(item.x));
    if (positioned.length) {
      const localAmount = positioned.reduce((closest, item) => (
        Math.abs(item.x - metadata.cardAmountColumns.local) < Math.abs(closest.x - metadata.cardAmountColumns.local) ? item : closest
      ));
      if (Math.abs(localAmount.x - metadata.cardAmountColumns.local) <= 65) return localAmount;
    }
  }
  if (metadata.statementColumns && amounts.length >= 2) {
    const balance = metadata.statementColumns.balance;
    const nonBalance = amounts.filter(item => item.x === null || Math.abs(item.x - balance) > 45);
    if (nonBalance.length) return nonBalance[nonBalance.length - 1];
  }
  const explicit = amounts.find(item => item.marker || /^[(-]/.test(item.value) || /\b(?:d[eé]bito|sa[ií]da)\b/i.test(item.context));
  if (explicit) return explicit;
  if (amounts.length >= 2 && /\b(?:saldo|balance)\b/i.test(line)) return amounts[0];
  return amounts[amounts.length - 1];
}

function parseStatementAmount(value, debitCredit, context = "") {
  const negativeParentheses = /^\(.*\)$/.test(String(value).trim());
  let normalized = String(value).replace(/[()\s]/g, "").replace(/R\$/gi, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma > lastDot) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else normalized = normalized.replace(/,/g, "");
  let amount = Number(normalized);
  if (!Number.isFinite(amount)) return Number.NaN;
  if (negativeParentheses || /^[−-]/.test(normalized) || /\b(?:d[eé]bito|sa[ií]da)\b/i.test(context)) amount = -Math.abs(amount);
  if (String(debitCredit || "").toUpperCase() === "D") amount = -Math.abs(amount);
  if (String(debitCredit || "").toUpperCase() === "C") amount = Math.abs(amount);
  return amount;
}

function isBalanceLine(line) {
  return /^\s*(?:\d{2}[\/.-]\d{2}(?:[\/.-]\d{2,4})?\s+)?(?:saldo\s+(?:fatura\s+anterior|anterior|final|dispon[ií]vel|do dia)|saldo|total\s+(?:do dia|geral)|limite)\b/i.test(stripLayoutMarkers(line));
}

async function extractTransactionsWithOcr(pdf) {
  if (!window.Tesseract) throw new Error("O módulo de OCR não foi carregado.");
  const lines = [];
  if (pdf.numPages > 20) throw new Error(`Este PDF possui ${pdf.numPages} páginas. O OCR seguro aceita no máximo 20; divida o documento para evitar um OFX incompleto.`);
  const pageLimit = pdf.numPages;
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    throwIfProcessingCancelled();
    showStatus(`Executando OCR local: página ${pageNumber} de ${pageLimit}...`);
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: context, viewport }).promise;
    let result;
    try {
      result = await window.Tesseract.recognize(canvas, "por", {
        workerPath: "./vendor/tesseract-worker.min.js",
        corePath: "./vendor/tesseract-core/",
        langPath: "https://tessdata.projectnaptha.com/4.0.0/",
        logger: message => {
          const percentage = Math.round((message.progress || 0) * 100);
          throwIfProcessingCancelled();
          showStatus(`OCR página ${pageNumber}: ${message.status || "processando"} ${percentage}%`);
        }
      });
    } catch (error) {
      if (error?.name === "AbortError" || processingAbortController?.signal.aborted) {
        throw new DOMException("Processamento cancelado pelo usuário.", "AbortError");
      }
      throw new Error("Não foi possível carregar ou executar o OCR. Verifique sua conexão e tente novamente; na primeira utilização o modelo em português precisa ser baixado.");
    }
    lines.push(...result.data.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    page.cleanup();
  }
  return lines;
}

function normalizeStatementDate(day, month, year) {
  const fullYear = year.length === 2 ? (Number(year) >= 70 ? `19${year}` : `20${year}`) : year;
  return `${fullYear}-${month}-${day}`;
}

function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(transaction => {
    const key = `${transaction.date}|${transaction.amount}|${transaction.memo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildOfx({ bankId, agencyId, accountId, accountType, currency, transactions, finalBalance = null, creditCard = false }) {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const now = new Date();
  const generatedAt = formatOfxTimestamp(now);
  const transactionXml = sorted.map(transaction => `
          <STMTTRN>
            <TRNTYPE>${transaction.type}</TRNTYPE>
            <DTPOSTED>${transaction.date.replaceAll("-", "")}120000[-3:BRT]</DTPOSTED>
            <TRNAMT>${transaction.amount.toFixed(2)}</TRNAMT>
            <FITID>${escapeXml(`PDF-${simpleHash(`${bankId}|${accountId}|${transaction.date}|${transaction.amount.toFixed(2)}|${transaction.memo.trim().toLowerCase()}`)}`)}</FITID>
            <NAME>${escapeXml(transaction.memo.slice(0, 32))}</NAME>
            <MEMO>${escapeXml(transaction.memo)}</MEMO>
          </STMTTRN>`).join("");
  const accountBlock = creditCard
    ? `<CCACCTFROM><ACCTID>${escapeXml(accountId)}</ACCTID></CCACCTFROM>`
    : `<BANKACCTFROM><BANKID>${escapeXml(bankId)}</BANKID>${agencyId ? `<BRANCHID>${escapeXml(agencyId)}</BRANCHID>` : ""}<ACCTID>${escapeXml(accountId)}</ACCTID><ACCTTYPE>${accountType}</ACCTTYPE></BANKACCTFROM>`;
  const messageOpen = creditCard ? "<CREDITCARDMSGSRSV1><CCSTMTTRNRS>" : "<BANKMSGSRSV1><STMTTRNRS>";
  const statementOpen = creditCard ? "<CCSTMTRS>" : "<STMTRS>";
  const statementClose = creditCard ? "</CCSTMTRS>" : "</STMTRS>";
  const messageClose = creditCard ? "</CCSTMTTRNRS></CREDITCARDMSGSRSV1>" : "</STMTTRNRS></BANKMSGSRSV1>";
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:UTF-8
CHARSET:NONE
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <DTSERVER>${generatedAt}</DTSERVER>
      <LANGUAGE>POR</LANGUAGE>
    </SONRS>
  </SIGNONMSGSRSV1>
  ${messageOpen}
      <TRNUID>PDF-${now.getTime()}</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      ${statementOpen}
        <CURDEF>${currency}</CURDEF>
        ${accountBlock}
        <BANKTRANLIST>
          <DTSTART>${sorted[0].date.replaceAll("-", "")}000000[-3:BRT]</DTSTART>
          <DTEND>${sorted[sorted.length - 1].date.replaceAll("-", "")}235959[-3:BRT]</DTEND>${transactionXml}
        </BANKTRANLIST>
        ${Number.isFinite(finalBalance) ? `<LEDGERBAL><BALAMT>${Number(finalBalance).toFixed(2)}</BALAMT><DTASOF>${sorted[sorted.length - 1].date.replaceAll("-", "")}235959[-3:BRT]</DTASOF></LEDGERBAL>` : ""}
      ${statementClose}
  ${messageClose}
</OFX>`;
}

function formatOfxTimestamp(date) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}[-3:BRT]`;
}

async function readOfxText(file) {
  const buffer = await file.arrayBuffer();
  const header = new TextDecoder("windows-1252").decode(buffer.slice(0, Math.min(buffer.byteLength, 500))).toUpperCase();
  const isLatin = /ENCODING:\s*(USASCII|ASCII|1252|ISO-8859-1)/.test(header) || /CHARSET:\s*(1252|ISO-8859-1)/.test(header);
  return new TextDecoder(isLatin ? "windows-1252" : "utf-8").decode(buffer);
}

function parseOfx(rawText) {
  const normalized = rawText.replace(/\0/g, "").replace(/\r/g, "");
  const ofxStart = normalized.search(/<OFX[\s>]/i);
  if (ofxStart < 0) throw new Error("O arquivo não contém uma estrutura OFX reconhecível.");
  const content = normalized.slice(ofxStart);
  const statementBlocks = content.match(/<(?:STMTRS|CCSTMTRS)>[\s\S]*?(?=<\/(?:STMTRS|CCSTMTRS)>|$)/gi) || [];
  if (statementBlocks.length > 1) throw new Error("Este OFX contém mais de uma conta ou fatura. Separe cada conta em um arquivo antes de converter para evitar mistura de lançamentos.");
  const statementContent = statementBlocks[0] || content;
  const transactionBlocks = content.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/OFX>|$)/gi) || [];
  const transactions = transactionBlocks.map((block, index) => {
    const fitId = ofxTag(block, "FITID");
    const rawAmount = ofxTag(block, "TRNAMT");
    const rawDate = ofxTag(block, "DTPOSTED") || ofxTag(block, "DTUSER");
    let amount;
    try { amount = parseOfxNumber(rawAmount); }
    catch { throw createSafeParserError("OFX_TRANSACTION_AMOUNT_INVALID", `O valor do lançamento ${index + 1} é inválido. Corrija o arquivo de origem antes de converter.`); }
    const date = normalizeOfxDate(rawDate);
    if (!date) throw createSafeParserError("OFX_TRANSACTION_DATE_INVALID", `A data do lançamento ${index + 1} é inválida. Corrija o arquivo de origem antes de converter.`);
    return { type: ofxTag(block, "TRNTYPE"), date, amount, fitId, checkNumber: ofxTag(block, "CHECKNUM") || ofxTag(block, "REFNUM"), name: decodeOfxEntities(ofxTag(block, "NAME")), memo: decodeOfxEntities(ofxTag(block, "MEMO")) };
  });
  if (!transactions.length) throw new Error("Nenhuma transação bancária foi encontrada no OFX.");
  const balanceRaw = ofxTag(statementContent, "BALAMT") || ofxTag(statementContent, "AVAILCASH");
  let balance = null;
  if (balanceRaw) {
    try { balance = parseOfxNumber(balanceRaw); }
    catch { throw createSafeParserError("OFX_BALANCE_INVALID", "O saldo informado no OFX é inválido. Corrija o arquivo de origem antes de converter."); }
  }
  const fitIds = new Set();
  for (const item of transactions) {
    if (item.fitId && fitIds.has(item.fitId)) throw createSafeParserError("OFX_DUPLICATE_FITID", "O OFX contém identificadores de lançamento duplicados. Corrija o arquivo de origem antes de converter.");
    if (item.fitId) fitIds.add(item.fitId);
  }
  return {
    bankId: ofxTag(statementContent, "BANKID") || ofxTag(content, "ORG"),
    accountId: ofxTag(statementContent, "ACCTID") || ofxTag(statementContent, "ACCTKEY"),
    accountType: ofxTag(statementContent, "ACCTTYPE"),
    currency: ofxTag(statementContent, "CURDEF") || "BRL",
    startDate: normalizeOfxDate(ofxTag(statementContent, "DTSTART")) || transactions[0].date,
    endDate: normalizeOfxDate(ofxTag(statementContent, "DTEND")) || transactions[transactions.length - 1].date,
    balance,
    transactions
  };
}

function ofxRows(statement) {
  return [
    ["Data", "Valor", "Tipo", "Descrição", "Nome", "Documento", "FITID", "Banco", "Conta", "Moeda"],
    ...statement.transactions.map(item => [
      formatOfxDate(item.date),
      item.amount.toFixed(2).replace(".", ","),
      item.type,
      item.memo,
      item.name,
      item.checkNumber,
      item.fitId,
      statement.bankId,
      statement.accountId,
      statement.currency
    ])
  ];
}

function ofxTag(content, tag) {
  const match = content.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<\\n]+)`, "i"));
  return match ? match[1].trim() : "";
}

function parseOfxNumber(value) {
  let normalized = String(value ?? "").trim().replace(/\s/g, "");
  if (!normalized) throw new Error("Valor OFX vazio.");
  if (!/^[+-]?[\d.,]+$/.test(normalized)) throw new Error("Valor OFX inválido.");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const decimals = normalized.length - comma - 1;
    normalized = decimals === 2 ? normalized.replace(",", ".") : normalized.replace(/,/g, "");
  } else if ((normalized.match(/\./g) || []).length > 1) {
    const parts = normalized.split(".");
    const decimal = parts.pop();
    normalized = `${parts.join("")}.${decimal}`;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error("Valor OFX inválido.");
  return number;
}

function createSafeParserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeOfxDate(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match || !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function formatOfxDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "não informada";
}

function decodeOfxEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'");
}

function formatMoney(value, currency = "BRL") {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function parsePageRange(value, pageCount) {
  const pages = new Set();
  value.split(",").map(part => part.trim()).forEach(part => {
    if (!part || !/^\d+(?:-\d+)?$/.test(part)) throw new Error("Use páginas como 1,3,5-8, sem vírgulas vazias ou intervalos incompletos.");
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > pageCount || start > end) {
      throw new Error(`Intervalo inválido. O documento possui ${pageCount} página(s).`);
    }
    for (let page = start; page <= end; page += 1) pages.add(page - 1);
  });
  if (!pages.size) throw new Error("Informe ao menos uma página.");
  return [...pages];
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let value = "";
  let state = "FIELD_START";
  let wasQuoted = false;
  const pushField = () => { row.push({ value, quoted: wasQuoted }); value = ""; wasQuoted = false; state = "FIELD_START"; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (state === "QUOTED") {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') state = "AFTER_QUOTE";
      else value += char;
      continue;
    }
    if (state === "AFTER_QUOTE") {
      if (char === delimiter) pushField();
      else if (char === "\n" || char === "\r") { if (char === "\r" && text[index + 1] === "\n") index += 1; pushRow(); }
      else throw new Error(`CSV malformado: caractere inesperado após aspas na posição ${index + 1}.`);
      continue;
    }
    if (state === "FIELD_START" && char === '"') { state = "QUOTED"; wasQuoted = true; }
    else if (char === '"') throw new Error(`CSV malformado: aspas em campo não citado na posição ${index + 1}.`);
    else if (char === delimiter) pushField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[index + 1] === "\n") index += 1; pushRow(); }
    else { value += char; state = "UNQUOTED"; }
  }
  if (state === "QUOTED") throw new Error("O CSV possui um campo com aspas não fechadas.");
  if (value.length || row.length || wasQuoted || state === "AFTER_QUOTE") pushRow();
  return rows;
}

async function hasExpectedSignature(file) {
  const extension = `.${file.name.split(".").pop().toLowerCase()}`;
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const startsWith = (...signature) => signature.every((value, index) => bytes[index] === value);
  if (extension === ".pdf") return startsWith(0x25, 0x50, 0x44, 0x46);
  if (extension === ".png") return startsWith(0x89, 0x50, 0x4E, 0x47);
  if (extension === ".jpg" || extension === ".jpeg") return startsWith(0xFF, 0xD8, 0xFF);
  if (extension === ".docx" || extension === ".xlsx") return startsWith(0x50, 0x4B);
  return true;
}

function validateArchive(zip, requiredPath) {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("O arquivo compactado possui itens demais para processamento seguro.");
  let expandedSize = 0;
  entries.forEach(entry => {
    expandedSize += Number(entry?._data?.uncompressedSize || 0);
  });
  if (expandedSize > MAX_ARCHIVE_EXPANDED_SIZE) throw new Error("O arquivo se expande além do limite seguro.");
  if (!zip.file(requiredPath)) throw new Error("O arquivo não possui a estrutura esperada para este formato.");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((input, columnIndex) => {
      const ref = `${columnLetters(columnIndex + 1)}${rowIndex + 1}`;
      const cell = typeof input === "object" && input !== null && "value" in input ? input : { value: input, quoted: false };
      const value = String(cell.value ?? "");
      assertValidXmlText(value, rowIndex + 1, columnIndex + 1);
      const classified = classifyCsvCell(value, Boolean(cell.quoted));
      if (classified.type === "number") return `<c r="${ref}"><v>${classified.value}</v></c>`;
      if (classified.type === "date") return `<c r="${ref}" s="1"><v>${classified.value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
}
function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}
function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}
function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function classifyCsvCell(value, quoted) {
  if (quoted || value === "" || /^[=+@]/.test(value) || /^-?0\d+/.test(value)) return { type: "text", value };
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const br = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const dateParts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : br ? [Number(br[3]), Number(br[2]), Number(br[1])] : null;
  if (dateParts && isValidCalendarDate(...dateParts)) return { type: "date", value: excelDateSerial(...dateParts) };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return { type: "number", value: String(number) };
  }
  return { type: "text", value };
}

function assertValidXmlText(value, row, column) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value)) {
    throw new Error(`O CSV contém um caractere incompatível com Excel na linha ${row}, coluna ${column}.`);
  }
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function excelDateSerial(year, month, day) {
  const days = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 31)) / 86400000);
  return days >= 60 ? days + 1 : days;
}
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;
}

async function createDocxFromText(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", docxContentTypesXml());
  zip.folder("_rels").file(".rels", docxRootRelsXml());
  const word = zip.folder("word");
  word.file("document.xml", wordDocumentXml(text));
  word.folder("_rels").file("document.xml.rels", docxDocumentRelsXml());
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

async function createDocxFromPdfImages(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const images = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfProcessingCancelled();
      showStatus(`Convertendo página ${pageNumber} de ${pdf.numPages} para o Word...`);
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Não foi possível renderizar a página do PDF.")), "image/png"));
      images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const zip = new JSZip();
  zip.file("[Content_Types].xml", docxImageContentTypesXml());
  zip.folder("_rels").file(".rels", docxRootRelsXml());
  const word = zip.folder("word");
  word.file("document.xml", wordImageDocumentXml(images));
  word.folder("_rels").file("document.xml.rels", docxImageRelsXml(images.length));
  const media = word.folder("media");
  images.forEach((image, index) => media.file(`page-${index + 1}.png`, image.bytes));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function docxImageContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
}

function docxImageRelsXml(count) {
  const relationships = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page-${index + 1}.png"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function wordImageDocumentXml(images) {
  const pages = images.map((image, index) => {
    const maxWidth = 5943600;
    const maxHeight = 8229600;
    const ratio = Math.min(maxWidth / image.width, maxHeight / image.height);
    const width = Math.round(image.width * ratio);
    const height = Math.round(image.height * ratio);
    const pageBreak = index < images.length - 1 ? `<w:r><w:br w:type="page"/></w:r>` : "";
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${index + 1}" name="Página ${index + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index + 1}" name="page-${index + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>${pageBreak}</w:p>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${pages}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
}

function docxContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
}

function docxRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
}

function docxDocumentRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
}

function wordDocumentXml(text) {
  const paragraphs = String(text || "").replace(/\r/g, "").split("\n").map(line => {
    if (line === "\f") return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    if (!line.trim()) return "<w:p/>";
    const trimmed = line.trim();
    const upperHeading = trimmed.length < 100 && /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ0-9ªº &.,–—-]+$/.test(trimmed) && /[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ]{4}/.test(trimmed);
    const centered = upperHeading || /^(?:CONTRATO SOCIAL|PALIN\s*&\s*MARTINS)/i.test(trimmed);
    const clause = /^(Cláusula\s+[^:]+:|Parágrafo\s+(?:Único|Primeiro|Segundo|Terceiro|Quarto|Quinta|Sexto|Sétimo|Oitavo|Nono|Décimo)\s*[–—-]?)/i.exec(trimmed);
    const paragraphProps = `<w:pPr><w:jc w:val="${centered ? "center" : "both"}"/><w:spacing w:before="0" w:after="90" w:line="276" w:lineRule="auto"/>${centered ? "" : "<w:ind w:firstLine=\"0\"/>"}</w:pPr>`;
    const runProps = `<w:rPr>${upperHeading ? "<w:b/>" : ""}<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>`;
    if (clause) {
      const rest = trimmed.slice(clause[0].length);
      return `<w:p>${paragraphProps}<w:r><w:rPr><w:b/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(clause[0])}</w:t></w:r><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(rest)}</w:t></w:r></w:p>`;
    }
    return `<w:p>${paragraphProps}<w:r>${runProps}<w:t xml:space="preserve">${escapeXml(trimmed)}</w:t></w:r></w:p>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1276" w:bottom="992" w:left="1276" w:header="420" w:footer="420" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

async function readSharedStrings(zip) {
  const entry = zip.file("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = parseXml(await entry.async("string"));
  return [...xml.getElementsByTagNameNS("*", "si")].map(item =>
    [...item.getElementsByTagNameNS("*", "t")].map(node => node.textContent).join("")
  );
}

function requireZipEntry(zip, path) {
  const entry = zip.file(path);
  if (!entry) throw new Error(`Estrutura XLSX incompleta: ${path}.`);
  return entry;
}
function parseXml(xml) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("O arquivo contém XML inválido.");
  return parsed;
}
function getDelimiter() {
  const value = window.document.querySelector("#delimiter")?.value || ",";
  return value === "tab" ? "\t" : value;
}
function quoteCsv(value, delimiter) {
  const string = String(value ?? "");
  return string.includes(delimiter) || /["\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}
function neutralizeCsvFormula(value) {
  const string = String(value ?? "");
  if (isPlainCsvNumber(string)) return string;
  return /^[=+\-@]/.test(string) ? `'${string}` : string;
}

function isPlainCsvNumber(value) {
  return /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(String(value || "").trim());
}

async function readXlsxStyles(zip) {
  const entry = zip.file("xl/styles.xml");
  if (!entry) return [];
  const xml = parseXml(await entry.async("string"));
  const custom = new Map([...xml.getElementsByTagNameNS("*", "numFmt")].map(node => [Number(node.getAttribute("numFmtId")), node.getAttribute("formatCode") || ""]));
  const cellXfs = xml.getElementsByTagNameNS("*", "cellXfs")[0];
  return cellXfs ? [...cellXfs.children].map(node => {
    const numFmtId = Number(node.getAttribute("numFmtId") || 0);
    return { numFmtId, formatCode: custom.get(numFmtId) || "" };
  }) : [];
}

function formatXlsxStoredValue(value, styleIndex, styles, date1904 = false) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const style = styles[Number(styleIndex)] || { numFmtId: 0, formatCode: "" };
  const formatCode = String(style.formatCode || "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  const dateStyle = [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47].includes(style.numFmtId) || /[dmy]/i.test(formatCode);
  if (dateStyle) return excelSerialToCsvDate(number, date1904);
  const percentStyle = [9, 10].includes(style.numFmtId) || /%/.test(formatCode);
  if (percentStyle) {
    const decimals = (formatCode.match(/0\.([0#]+)/)?.[1].length) || (style.numFmtId === 10 ? 2 : 0);
    return `${(number * 100).toFixed(decimals).replace(".", ",")}%`;
  }
  return value;
}

function excelSerialToCsvDate(serial, date1904 = false) {
  const wholeDays = Math.floor(serial);
  if (!Number.isFinite(wholeDays) || wholeDays < 0) return String(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjustedDays = !date1904 && wholeDays >= 60 ? wholeDays - 1 : wholeDays;
  const date = new Date(epoch + adjustedDays * 86400000);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const pad = value => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}
function columnLetters(number) {
  let result = "";
  while (number > 0) { number -= 1; result = String.fromCharCode(65 + (number % 26)) + result; number = Math.floor(number / 26); }
  return result;
}
function columnNumber(letters) {
  return [...letters].reduce((total, letter) => total * 26 + letter.toUpperCase().charCodeAt(0) - 64, 0);
}
function wrapText(text, maxChars) {
  return text.replace(/\r/g, "").split("\n").flatMap(paragraph => {
    if (!paragraph) return [""];
    const words = paragraph.split(/\s+/);
    const lines = [];
    let line = "";
    words.forEach(word => {
      if (`${line} ${word}`.trim().length > maxChars && line) { lines.push(line); line = word; }
      else line = `${line} ${word}`.trim();
    });
    if (line) lines.push(line);
    return lines;
  });
}
function wrapTextByWidth(text, font, size, maxWidth) {
  const result = [];
  const safeWidth = value => font.widthOfTextAtSize(toWinAnsi(value), size);
  for (const paragraph of String(text || "").replace(/\r/g, "").split("\n")) {
    if (!paragraph) { result.push(""); continue; }
    const tokens = paragraph.split(/(\s+)/).filter(Boolean);
    let line = "";
    for (const token of tokens) {
      const candidate = `${line}${token}`;
      if (safeWidth(candidate) <= maxWidth) { line = candidate; continue; }
      if (line.trim()) { result.push(line.trimEnd()); line = ""; }
      let chunk = "";
      for (const char of token) {
        if (safeWidth(`${chunk}${char}`) > maxWidth && chunk) { result.push(chunk); chunk = char; }
        else chunk += char;
      }
      line = chunk;
    }
    if (line) result.push(line.trimEnd());
  }
  return result;
}
function toWinAnsi(text) {
  return String(text || "").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "□");
}
function download(data, filename, type) {
  throwIfProcessingCancelled();
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.add("visible");
  elements.status.classList.toggle("error", error);
}
function clearStatus() {
  elements.status.textContent = "";
  elements.status.className = "status-message";
}
async function reportApplicationError(error, context = {}) {
  if (window.docProntoLaboratory?.reportError) {
    return window.docProntoLaboratory.reportError(error, context);
  }
  const candidate = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : "OPERATION_FAILED";
  if (/encrypted|password/i.test(String(error?.message || ""))) {
    return `O arquivo protegido não pôde ser processado. Remova a senha e tente novamente. Código: ${code}`;
  }
  return `A operação não foi concluída. Confira o arquivo e tente novamente. Código: ${code}`;
}
function baseName(filename) { return filename.replace(/\.[^.]+$/, ""); }
function sanitizeFilename(filename) { return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 180); }
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function escapeXml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function escapeHtml(value) { return escapeXml(value); }
