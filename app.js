/* global PDFLib, JSZip, forge */

const MAX_FILE_SIZE = 40 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_EXPANDED_SIZE = 180 * 1024 * 1024;

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
  { id: "pdf-ofx", number: "14", category: "financeiro", title: "PDF para OFX", description: "Converta faturas, extratos e outros PDFs financeiros em OFX.", accept: ".pdf", multiple: false, option: "pdf-ofx", warning: "O sistema detecta transações e metadados automaticamente e usa OCR em PDFs escaneados. Revise o resultado antes de importar.", action: pdfToOfx },
  { id: "word-pdf", number: "15", category: "documento", title: "Word para PDF", description: "Converta o texto principal de um DOCX em PDF.", accept: ".docx", multiple: false, warning: "A conversão preserva o texto principal. Imagens, cabeçalhos e layout avançado podem não aparecer no PDF.", action: wordToPdf },
  { id: "pdf-word", number: "16", category: "documento", title: "PDF para Word", description: "Transforme o texto pesquisável de um PDF em DOCX editável.", accept: ".pdf", multiple: false, warning: "Funciona melhor em PDFs com texto selecionável. PDFs escaneados podem precisar de OCR antes da conversão.", action: pdfToWord },
  { id: "digital-sign", number: "17", category: "documento", title: "Assinar com certificado", description: "Assine arquivos com certificado digital A1 e gere uma assinatura .p7s.", accept: ".pdf,.docx,.xlsx,.txt,.csv,.ofx,.xml,.jpg,.jpeg,.png", multiple: false, option: "digital-sign", warning: "Use certificado A1 em arquivo .pfx ou .p12. Certificados A3/token exigem aplicativo nativo e não podem ser acessados diretamente pelo navegador.", action: signWithDigitalCertificate }
];

const elements = {
  grid: document.querySelector("#toolsGrid"),
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

renderTools();
bindNavigation();
bindUpload();

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
    if (card) openTool(tools.find(tool => tool.id === card.dataset.tool));
  });
}

function bindNavigation() {
  document.querySelector("#exploreButton").addEventListener("click", () => {
    document.querySelector("#ferramentas").scrollIntoView({ behavior: "smooth" });
  });
  document.querySelectorAll("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      document.querySelector("#ferramentas").scrollIntoView({ behavior: "smooth" });
      filterTools(filter);
    });
  });
}

function filterTools(filter) {
  document.querySelectorAll(".filter-button").forEach(button => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  document.querySelectorAll(".tool-card").forEach(card => {
    card.classList.toggle("hidden", filter !== "todos" && card.dataset.category !== filter);
  });
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
  elements.process.addEventListener("click", processFiles);
  elements.dialog.addEventListener("cancel", event => {
    if (isProcessing) event.preventDefault();
  });
  elements.dialog.addEventListener("close", resetDialog);
}

function openTool(tool) {
  activeTool = tool;
  selectedFiles = [];
  document.querySelector("#dialogNumber").textContent = tool.number;
  document.querySelector("#dialogCategory").textContent = tool.category;
  document.querySelector("#dialogTitle").textContent = tool.title;
  document.querySelector("#dialogDescription").textContent = tool.description;
  const limit = tool.accept.includes(".docx") || tool.accept.includes(".xlsx") ? "12 MB" : "40 MB";
  document.querySelector("#acceptedTypes").textContent = `Aceita ${tool.accept.replaceAll(".", "").toUpperCase()} · máximo ${limit} por arquivo`;
  elements.fileInput.accept = tool.accept;
  elements.fileInput.multiple = tool.multiple;
  elements.notice.textContent = tool.warning || "";
  elements.notice.classList.toggle("visible", Boolean(tool.warning));
  renderOptions(tool.option);
  renderFileList();
  clearStatus();
  elements.dialog.showModal();
}

function resetDialog() {
  activeTool = null;
  selectedFiles = [];
  elements.fileInput.value = "";
  elements.process.disabled = true;
  clearStatus();
}

async function setFiles(files) {
  clearStatus();
  const allowed = activeTool.accept.split(",").map(ext => ext.trim().toLowerCase());
  const candidates = files.filter(file => {
    const extension = `.${file.name.split(".").pop().toLowerCase()}`;
    const limit = [".docx", ".xlsx"].includes(extension) ? MAX_ARCHIVE_SIZE : MAX_FILE_SIZE;
    return allowed.includes(extension) && file.size <= limit;
  });
  const validations = await Promise.all(candidates.map(async file => ({ file, valid: await hasExpectedSignature(file) })));
  const valid = validations.filter(item => item.valid).map(item => item.file);
  if (valid.length !== files.length) {
    showStatus("Alguns arquivos foram ignorados por formato, assinatura ou tamanho incompatível.", true);
  } else if (!activeTool.multiple && valid.length > 1) {
    showStatus("Esta ferramenta aceita um arquivo por vez; somente o primeiro foi selecionado.", true);
  }
  selectedFiles = activeTool.multiple ? valid : valid.slice(0, 1);
  renderFileList();
}

function renderFileList() {
  elements.fileList.innerHTML = selectedFiles.map((file, index) => `
    <div class="file-item">
      <span>${escapeHtml(file.name)}</span>
      <small>${formatBytes(file.size)} · ${index + 1}</small>
    </div>
  `).join("");
  elements.process.disabled = selectedFiles.length === 0;
}

function renderOptions(type) {
  const templates = {
    range: `<label for="pageRange">Páginas ou intervalos</label><input id="pageRange" value="1" placeholder="Ex.: 1-3, 5, 8-10"><small>Use números separados por vírgula.</small>`,
    rotation: `<label for="rotation">Rotação</label><select id="rotation"><option value="90">90 graus</option><option value="180">180 graus</option><option value="270">270 graus</option></select>`,
    watermark: `<label for="watermark">Texto da marca d'água</label><input id="watermark" maxlength="80" value="CONFIDENCIAL"><label for="opacity">Opacidade</label><input id="opacity" type="range" min="0.1" max="0.8" step="0.1" value="0.25">`,
    delimiter: `<label for="delimiter">Separador do CSV</label><select id="delimiter"><option value=",">Vírgula (,)</option><option value=";">Ponto e vírgula (;)</option><option value="tab">Tabulação</option></select>`,
    "ofx-delimiter": `<label for="delimiter">Separador do CSV</label><select id="delimiter"><option value=";">Ponto e vírgula (;)</option><option value=",">Vírgula (,)</option><option value="tab">Tabulação</option></select><small>Datas, valores, documento, descrição, tipo e identificador serão exportados.</small>`,
    "pdf-ofx": `<div class="notice visible">Banco, conta e moeda serão detectados automaticamente. Basta selecionar o PDF.</div><label><input id="pdfUseOcr" type="checkbox" checked> Usar OCR automaticamente quando necessário</label><small>O OCR pode demorar alguns minutos em documentos longos.</small>`,
    "digital-sign": `<label for="signatureMode">Tipo de assinatura</label><select id="signatureMode"><option value="installed">Certificado instalado no Windows</option><option value="written">Escrita visível no PDF</option><option value="certificate">Arquivo A1 (.pfx/.p12)</option></select><label for="writtenSignature">Nome/aparência da assinatura</label><input id="writtenSignature" maxlength="90" placeholder="Ex.: Altair Heitor Martins Palin"><label for="windowsCertificate">Certificado instalado</label><div class="inline-option"><select id="windowsCertificate"><option value="">Clique em carregar certificados</option></select><button class="secondary-button compact-button" type="button" id="loadWindowsCertificates">Carregar</button></div><label for="certificateFile">Certificado A1 (.pfx ou .p12)</label><input id="certificateFile" type="file" accept=".pfx,.p12"><label for="certificatePassword">Senha do arquivo A1</label><input id="certificatePassword" type="password" autocomplete="off" placeholder="Senha do A1"><small>Com PDF + certificado instalado, o DocPronto gera um PDF assinado com aparência visível, parecido com o Adobe. Para outros arquivos, gera .p7s.</small>`
  };
  elements.options.innerHTML = templates[type] || "";
  if (type === "digital-sign") bindDigitalSignOptions();
}

function bindDigitalSignOptions() {
  document.querySelector("#loadWindowsCertificates")?.addEventListener("click", () => {
    loadWindowsCertificates().catch(error => showStatus(error.message, true));
  });
}

async function processFiles() {
  if (!activeTool || !selectedFiles.length) return;
  isProcessing = true;
  document.querySelectorAll("[data-cancel]").forEach(button => { button.disabled = true; });
  elements.process.disabled = true;
  elements.process.textContent = "Processando...";
  showStatus("Processando localmente. Mantenha esta página aberta.");
  try {
    await activeTool.action(selectedFiles);
    showStatus("Pronto. O download foi iniciado.");
  } catch (error) {
    console.error(error);
    showStatus(humanizeError(error), true);
  } finally {
    isProcessing = false;
    document.querySelectorAll("[data-cancel]").forEach(button => { button.disabled = false; });
    elements.process.disabled = false;
    elements.process.textContent = "Processar arquivos";
  }
}

async function mergePdfs(files) {
  const output = await PDFLib.PDFDocument.create();
  for (const file of files) {
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
    const bytes = await file.arrayBuffer();
    const image = file.type === "image/png" || file.name.toLowerCase().endsWith(".png")
      ? await document.embedPng(bytes)
      : await document.embedJpg(bytes);
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const scale = Math.min((pageWidth - 60) / image.width, (pageHeight - 60) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  }
  download(await document.save(), "imagens-convertidas.pdf", "application/pdf");
}

async function textToPdf([file]) {
  const text = await file.text();
  download(await createTextPdf(text), `${baseName(file.name)}.pdf`, "application/pdf");
}

async function wordToPdf([file]) {
  try {
    const converted = await convertWithLocalOffice(file, "word-to-pdf");
    download(bytesFromBase64(converted.contentBase64), converted.filename || `${baseName(file.name)}.pdf`, "application/pdf");
  } catch (error) {
    const text = await extractTextFromDocx(file);
    if (!text.trim()) throw new Error("O DOCX não contém texto principal para converter.");
    showStatus("Servidor local do Word indisponível. Gerando PDF simples somente com o texto principal...", true);
    download(await createTextPdf(text), `${baseName(file.name)}.pdf`, "application/pdf");
  }
}

async function pdfToWord([file]) {
  try {
    const converted = await convertWithLocalOffice(file, "pdf-to-word");
    download(bytesFromBase64(converted.contentBase64), converted.filename || `${baseName(file.name)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  } catch (error) {
    const pages = await extractTextFromPdf(file);
    const text = pages.map(lines => lines.join("\n")).join("\n\n");
    if (!text.trim()) throw new Error("Não encontramos texto selecionável neste PDF. Se ele for escaneado, use OCR antes de converter.");
    showStatus("Servidor local do Word indisponível. Gerando DOCX simples somente com o texto pesquisável...", true);
    download(await createDocxFromText(text), `${baseName(file.name)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }
}

async function convertWithLocalOffice(file, endpoint) {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const response = await fetch(`${localSignerApiBase()}/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentBase64: base64FromBytes(fileBytes)
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível converter com o Microsoft Word local.");
  return result;
}

async function signWithDigitalCertificate([file]) {
  const mode = document.querySelector("#signatureMode")?.value || "written";
  if (mode === "written") {
    await signPdfWithWrittenSignature(file);
    return;
  }
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

async function signWithInstalledCertificate(file) {
  const select = document.querySelector("#windowsCertificate");
  let thumbprint = select?.value || "";
  if (!thumbprint) {
    await loadWindowsCertificates();
    thumbprint = select?.value || "";
  }
  if (!thumbprint) throw new Error("Selecione um certificado instalado no Windows.");
  const apiBase = localSignerApiBase();
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const pdfMode = /\.pdf$/i.test(file.name);
  const response = await fetch(`${apiBase}/api/${pdfMode ? "sign-pdf-installed" : "sign-installed"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      thumbprint,
      contentBase64: base64FromBytes(fileBytes),
      signerName: document.querySelector("#writtenSignature")?.value?.trim() || select?.selectedOptions?.[0]?.textContent || ""
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível assinar com o certificado instalado.");
  if (pdfMode) {
    download(bytesFromBase64(result.contentBase64), result.filename || `${baseName(file.name)}-assinado.pdf`, "application/pdf");
  } else {
    download(bytesFromBase64(result.signatureBase64), `${file.name}.p7s`, "application/pkcs7-signature");
  }
}

async function loadWindowsCertificates() {
  const select = document.querySelector("#windowsCertificate");
  if (!select) return;
  select.innerHTML = `<option value="">Carregando certificados...</option>`;
  const response = await fetch(`${localSignerApiBase()}/api/certificates`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível carregar certificados instalados.");
  const certificates = result.certificates || [];
  if (!certificates.length) {
    select.innerHTML = `<option value="">Nenhum certificado com chave privada encontrado</option>`;
    return;
  }
  select.innerHTML = certificates.map(certificate =>
    `<option value="${escapeHtml(certificate.thumbprint)}">${escapeHtml(certificate.label)}</option>`
  ).join("");
}

function localSignerApiBase() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "" : "http://127.0.0.1:4174";
}

async function signPdfWithWrittenSignature(file) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("A assinatura escrita está disponível para arquivos PDF. Converta o Word para PDF antes de assinar.");
  const signerName = document.querySelector("#writtenSignature")?.value?.trim();
  if (!signerName) throw new Error("Informe o nome que deve aparecer na assinatura escrita.");
  const pdfDocument = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  const pages = pdfDocument.getPages();
  const page = pages[pages.length - 1];
  const regular = await pdfDocument.embedFont(PDFLib.StandardFonts.Helvetica);
  const italic = await pdfDocument.embedFont(PDFLib.StandardFonts.TimesRomanItalic);
  const { width } = page.getSize();
  const signedAt = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date());
  const boxWidth = Math.min(300, width - 80);
  const x = width - boxWidth - 42;
  const y = 54;
  page.drawRectangle({
    x,
    y,
    width: boxWidth,
    height: 72,
    borderColor: PDFLib.rgb(0.16, 0.2, 0.18),
    borderWidth: 0.8,
    color: PDFLib.rgb(1, 0.996, 0.965),
    opacity: 0.92
  });
  page.drawText(toWinAnsi(signerName).slice(0, 52), {
    x: x + 14,
    y: y + 39,
    size: 15,
    font: italic,
    color: PDFLib.rgb(0.08, 0.14, 0.12)
  });
  page.drawLine({
    start: { x: x + 14, y: y + 32 },
    end: { x: x + boxWidth - 14, y: y + 32 },
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
  const document = await PDFLib.PDFDocument.create();
  const font = await document.embedFont(PDFLib.StandardFonts.Helvetica);
  const size = 11;
  const width = 595.28;
  const height = 841.89;
  const margin = 52;
  const lineHeight = 16;
  const maxChars = 92;
  const lines = wrapText(text, maxChars);
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

async function docxToText([file]) {
  const text = await extractTextFromDocx(file);
  download(new TextEncoder().encode(text), `${baseName(file.name)}.txt`, "text/plain;charset=utf-8");
}

async function extractTextFromDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  validateArchive(zip, "word/document.xml");
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("O DOCX não contém um documento de texto reconhecível.");
  const xml = await entry.async("string");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = [...parsed.getElementsByTagNameNS("*", "p")];
  const text = paragraphs.map(paragraph =>
    [...paragraph.getElementsByTagNameNS("*", "t")].map(node => node.textContent).join("")
  ).join("\n");
  return text;
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
  const expenses = statement.transactions.filter(item => item.amount < 0).reduce((sum, item) => sum + item.amount, 0);
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
    `Movimentação líquida: ${formatMoney(income + expenses, statement.currency)}`,
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

async function pdfToOfx([file]) {
  const result = await extractTransactionsFromPdf(file);
  if (!result.transactions.length) {
    throw new Error("Não encontramos transações com data e valor neste PDF. Se ele contém movimentações financeiras, tente novamente com OCR ativado.");
  }
  const ofx = buildOfx({ ...result.metadata, transactions: result.transactions });
  download(new TextEncoder().encode(ofx), `${baseName(file.name)}-convertido.ofx`, "application/x-ofx");
}

async function extractTransactionsFromPdf(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  let transactions = [];
  const allLines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
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
  return { transactions: deduplicateTransactions(transactions), metadata };
}

async function extractTextFromPdf(file) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push(groupPdfTextLines(textContent.items));
    page.cleanup();
  }
  await loadingTask.destroy();
  return pages;
}

async function loadPdfJs() {
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.worker.min.mjs";
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
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map(part => part.text).join(" ").replace(/\s+/g, " ").trim());
}

function parseStatementLine(line, metadata = {}) {
  if (isHeaderOrSummary(line)) return null;
  const dateMatch = findStatementDate(line, metadata.referenceDate);
  if (!dateMatch) return null;
  const amountMatches = findStatementAmounts(line);
  if (!amountMatches.length) return null;
  const amountMatch = chooseTransactionAmount(line, amountMatches);
  let amount = parseStatementAmount(amountMatch.value, amountMatch.marker, amountMatch.context);
  if (!Number.isFinite(amount)) return null;
  const direction = inferStatementDirection(line, metadata);
  if (direction > 0) {
    amount = Math.abs(amount);
  } else if (direction < 0) {
    amount = -Math.abs(amount);
  } else if (metadata.creditCard) {
    amount = /\b(?:pagamento|cr[eé]dito|estorno|cashback|devolu[çc][aã]o)\b/i.test(line)
      ? Math.abs(amount)
      : -Math.abs(amount);
  }
  const date = dateMatch.normalized;
  const withoutDate = line.replace(dateMatch.text, " ");
  const memoSource = metadata.creditCard ? simplifyCreditCardMemo(withoutDate) : withoutDate;
  const memo = memoSource
    .replace(amountMatch.full, " ")
    .replace(/(?:R\$\s*)?[+-]?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}\s*(?:saldo)?\s*$/i, " ")
    .replace(/\b(?:cr[eé]dito|credito|d[eé]bito|debito|valor|lan[çc]amento|lancamento)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!memo || isBalanceLine(line)) return null;
  return { date, amount, memo: memo.slice(0, 255), type: amount < 0 ? "DEBIT" : "CREDIT" };
}

function inferStatementDirection(line, metadata = {}) {
  const normalized = String(line)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const incoming = /\b(?:recebimento|recebido|recebida|pix recebido|transferencia recebida|ted recebida|doc recebido|deposito|credito em conta|salario|proventos|rendimento|resgate|estorno|cashback|devolucao|reembolso)\b/;
  if (incoming.test(normalized)) return 1;

  if (metadata.creditCard && /\b(?:pagamento(?:\s+(?:de |da )?fatura)?|credito|estorno|cashback|devolucao|reembolso)\b/.test(normalized)) {
    return 1;
  }

  const outgoing = /\b(?:pagamento pix|pix enviado|transferencia enviada|ted enviada|doc enviado|pagamento|compra|saque|tarifa|taxa|juros|multa|imposto|debito automatico|boleto)\b/;
  if (outgoing.test(normalized)) return -1;

  return 0;
}

function parseStatementLines(lines, metadata = {}) {
  const transactions = [];
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
      transactions.push(direct);
      if (consumedTrailing) index += 1;
      continue;
    }
    const hasDate = findStatementDate(lines[index], metadata.referenceDate);
    if (!hasDate) continue;
    for (let span = 1; span <= 3 && index + span < lines.length; span += 1) {
      const combined = lines.slice(index, index + span + 1).join(" ");
      const transaction = parseStatementLine(combined, metadata);
      if (transaction) {
        transactions.push(transaction);
        index += span;
        break;
      }
    }
  }
  return transactions;
}

function findStatementDate(line, referenceDate = null) {
  const full = line.match(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})\b/);
  if (full) return { text: full[0], index: full.index || 0, normalized: normalizeStatementDate(full[1], full[2], full[3]) };
  const iso = line.match(/\b(\d{4})[\/.-](\d{2})[\/.-](\d{2})\b/);
  if (iso) return { text: iso[0], index: iso.index || 0, normalized: `${iso[1]}-${iso[2]}-${iso[3]}` };
  const namedMonth = line.match(/\b(\d{1,2})[\/.-](jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)(?:[\/.-](\d{2,4}))?\b/i);
  if (namedMonth) {
    const months = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
    const month = months[namedMonth[2].toLowerCase()];
    const year = namedMonth[3] ? normalizeYear(namedMonth[3]) : inferTransactionYear(month, referenceDate);
    return { text: namedMonth[0], index: namedMonth.index || 0, normalized: `${year}-${String(month).padStart(2, "0")}-${String(namedMonth[1]).padStart(2, "0")}` };
  }
  const short = line.match(/^\s*(\d{2})[\/.-](\d{2})(?=\s)/);
  if (short) {
    const year = referenceDate?.getFullYear?.() || new Date().getFullYear();
    return { text: short[0].trim(), index: short.index || 0, normalized: `${year}-${short[2]}-${short[1]}` };
  }
  return null;
}

function inferFinancialMetadata(lines) {
  const text = lines.join(" ");
  const normalizedText = normalizeSearchText(text);
  const dueDate = normalizedText.match(/vencimento[\s\S]{0,80}?(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i);
  const documentDate = normalizedText.match(/(?:data\s+do\s+documento|atualizados\s+em|fechamento\s+proxima\s+fatura)[\s\S]{0,40}?(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i);
  const anyDate = normalizedText.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2}|19\d{2})\b/);
  const referenceMatch = dueDate || documentDate || anyDate;
  const referenceDate = referenceMatch
    ? new Date(Number(referenceMatch[3]), Number(referenceMatch[2]) - 1, Number(referenceMatch[1]))
    : new Date();
  const cardFinal = normalizedText.match(/(?:cartao\s*(?:n[\u00BAo.:?]*|numero)?\s*[:.-]?\s*\d{0,8}\*+|n[\u00BAo?]\s*|final\s*)(\d{4})/i) || normalizedText.match(/\b\d{4}\*{4,}(\d{4})\b/);
  const bankName = normalizedText.match(/\b(itau|bradesco|santander|sicredi|sicoob|nubank|inter|caixa|banco do brasil|btg|c6)\b/i);
  const creditCard = /\b(?:fatura|cartao|mastercard|visa|elo|amex)\b/i.test(normalizedText);
  return {
    referenceDate,
    currency: /\b(?:R\$|reais|BRL)\b/i.test(text) ? "BRL" : /\b(?:US\$|USD|d[oó]lar)\b/i.test(text) ? "USD" : "BRL",
    accountId: cardFinal ? `CARTAO-${cardFinal[1]}` : `PDF-${simpleHash(text.slice(0, 500))}`,
    bankId: bankName ? bankName[1].toUpperCase().replace(/\s+/g, "-") : "PDF",
    accountType: creditCard ? "CREDITCARD" : "CHECKING",
    creditCard
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
  return /\b(?:transacoes|data e hora|historico de despesas|descricao|valor em|valor origem|cotacao|total cartao|resumo da fatura|vencimento|limite|pagamento minimo|opcoes de pagamento|opcoes de parcelamento|programa de recompensa|encargos|legenda|fechamento da proxima fatura|total de parcelas|recibo do pagador|autenticacao|beneficiario|nosso numero|sacador|avalista|codigo de barra|local do pagamento|instrucoes|\d+ de \d+)\b/i.test(normalized);
}

function isCreditCardTransactionSection(line) {
  const normalized = normalizeSearchText(line);
  return /\b(?:despesas no brasil|despesas no exterior|lancamentos nacionais|lancamentos internacionais)\b/i.test(normalized);
}

function isCreditCardSectionEnd(line) {
  const normalized = normalizeSearchText(line);
  return /\b(?:subtotal|autenticacao|recibo do pagador|opcoes de parcelamento|encargos vigentes|programa de recompensa|sacador|avalista|codigo de barra)\b/i.test(normalized);
}

function simplifyCreditCardMemo(value) {
  return String(value)
    .replace(/\b(?:BRL|R\$|USD|US\$|EUR)\b[\s\S]*$/i, " ")
    .replace(/\b\d{1,4}[,.]\d{2}\b(?:\s+\d{1,4}[,.]\d{2})*\s*$/i, " ");
}

function normalizeSearchText(value) {
  return String(value || "")
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
  const pattern = /(?:R\$\s*)?(\(?[+-]?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}\)?)(?:\s*([DC]))?/gi;
  return [...line.matchAll(pattern)].map(match => ({
    full: match[0],
    value: match[1],
    marker: match[2] || "",
    index: match.index || 0,
    context: line.slice(Math.max(0, (match.index || 0) - 18), (match.index || 0) + match[0].length + 18)
  }));
}

function chooseTransactionAmount(line, amounts) {
  const explicit = amounts.find(item => item.marker || /^[(-]/.test(item.value) || /\b(?:d[eé]bito|sa[ií]da)\b/i.test(item.context));
  if (explicit) return explicit;
  if (amounts.length >= 2 && /\b(?:saldo|balance)\b/i.test(line)) return amounts[0];
  return amounts[amounts.length - 1];
}

function parseStatementAmount(value, debitCredit, context = "") {
  const negativeParentheses = /^\(.*\)$/.test(String(value).trim());
  let normalized = String(value).replace(/[()\s]/g, "");
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
  return /^\s*(?:\d{2}[\/.-]\d{2}(?:[\/.-]\d{2,4})?\s+)?(?:saldo\s+(?:anterior|final|dispon[ií]vel|do dia)|saldo|total\s+(?:do dia|geral)|limite)\b/i.test(line);
}

async function extractTransactionsWithOcr(pdf) {
  if (!window.Tesseract) throw new Error("O módulo de OCR não foi carregado.");
  const lines = [];
  const pageLimit = Math.min(pdf.numPages, 20);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
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
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0",
        langPath: "https://tessdata.projectnaptha.com/4.0.0/",
        logger: message => {
          const percentage = Math.round((message.progress || 0) * 100);
          showStatus(`OCR página ${pageNumber}: ${message.status || "processando"} ${percentage}%`);
        }
      });
    } catch (error) {
      throw new Error("Não foi possível carregar ou executar o OCR. Verifique sua conexão e tente novamente; na primeira utilização o modelo em português precisa ser baixado.");
    }
    lines.push(...result.data.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    page.cleanup();
  }
  if (pdf.numPages > pageLimit) showStatus(`OCR limitado às primeiras ${pageLimit} páginas por segurança.`);
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

function buildOfx({ bankId, accountId, accountType, currency, transactions, creditCard = false }) {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const now = new Date();
  const generatedAt = formatOfxTimestamp(now);
  const transactionXml = sorted.map((transaction, index) => `
          <STMTTRN>
            <TRNTYPE>${transaction.type}</TRNTYPE>
            <DTPOSTED>${transaction.date.replaceAll("-", "")}120000[-3:BRT]</DTPOSTED>
            <TRNAMT>${transaction.amount.toFixed(2)}</TRNAMT>
            <FITID>${escapeXml(`PDF-${transaction.date}-${index + 1}-${Math.abs(transaction.amount).toFixed(2)}`)}</FITID>
            <NAME>${escapeXml(transaction.memo.slice(0, 32))}</NAME>
            <MEMO>${escapeXml(transaction.memo)}</MEMO>
          </STMTTRN>`).join("");
  const accountBlock = creditCard
    ? `<CCACCTFROM><ACCTID>${escapeXml(accountId)}</ACCTID></CCACCTFROM>`
    : `<BANKACCTFROM><BANKID>${escapeXml(bankId)}</BANKID><ACCTID>${escapeXml(accountId)}</ACCTID><ACCTTYPE>${accountType}</ACCTTYPE></BANKACCTFROM>`;
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
  const transactionBlocks = content.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/OFX>|$)/gi) || [];
  const transactions = transactionBlocks.map(block => ({
    type: ofxTag(block, "TRNTYPE"),
    date: normalizeOfxDate(ofxTag(block, "DTPOSTED") || ofxTag(block, "DTUSER")),
    amount: parseOfxNumber(ofxTag(block, "TRNAMT")),
    fitId: ofxTag(block, "FITID"),
    checkNumber: ofxTag(block, "CHECKNUM") || ofxTag(block, "REFNUM"),
    name: decodeOfxEntities(ofxTag(block, "NAME")),
    memo: decodeOfxEntities(ofxTag(block, "MEMO"))
  })).filter(item => item.date || item.fitId || item.amount !== 0);
  if (!transactions.length) throw new Error("Nenhuma transação bancária foi encontrada no OFX.");
  const balanceRaw = ofxTag(content, "BALAMT") || ofxTag(content, "AVAILCASH");
  return {
    bankId: ofxTag(content, "BANKID") || ofxTag(content, "ORG"),
    accountId: ofxTag(content, "ACCTID") || ofxTag(content, "ACCTKEY"),
    accountType: ofxTag(content, "ACCTTYPE"),
    currency: ofxTag(content, "CURDEF") || "BRL",
    startDate: normalizeOfxDate(ofxTag(content, "DTSTART")) || transactions[0].date,
    endDate: normalizeOfxDate(ofxTag(content, "DTEND")) || transactions[transactions.length - 1].date,
    balance: balanceRaw ? parseOfxNumber(balanceRaw) : null,
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
  const normalized = String(value || "0").trim().replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeOfxDate(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
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
  value.split(",").map(part => part.trim()).filter(Boolean).forEach(part => {
    const [startRaw, endRaw] = part.split("-").map(Number);
    const start = startRaw;
    const end = endRaw || startRaw;
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
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (quoted) throw new Error("O CSV possui um campo com aspas não fechadas.");
  if (value.length || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
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

function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnLetters(columnIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
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
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`;
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
    if (!line.trim()) return "<w:p/>";
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
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
  return /^[=+\-@]/.test(string) ? `'${string}` : string;
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
function toWinAnsi(text) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
}
function download(data, filename, type) {
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
function humanizeError(error) {
  if (/encrypted/i.test(error.message)) return "PDF protegido por senha. Esta versão ainda não abre arquivos criptografados.";
  if (/Failed to parse|invalid/i.test(error.message)) return "O arquivo parece corrompido ou não corresponde ao formato informado.";
  return error.message || "Não foi possível processar o arquivo.";
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
