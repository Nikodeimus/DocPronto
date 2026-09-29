const startupTools = [
  ["merge-pdf", "01", "pdf", "Juntar PDF", "Combine vários PDFs na ordem selecionada."],
  ["extract-pdf", "02", "pdf", "Extrair páginas", "Crie um PDF apenas com as páginas escolhidas."],
  ["split-pdf", "03", "pdf", "Separar PDF", "Gere um arquivo ZIP com cada página separada."],
  ["rotate-pdf", "04", "pdf", "Girar PDF", "Gire todas as páginas em 90, 180 ou 270 graus."],
  ["watermark-pdf", "05", "pdf", "Marca d'água", "Aplique um texto discreto em todas as páginas."],
  ["image-pdf", "06", "documento", "Imagens para PDF", "Transforme imagens JPG ou PNG em um PDF."],
  ["text-pdf", "07", "documento", "TXT para PDF", "Converta um arquivo de texto em PDF paginado."],
  ["docx-text", "08", "documento", "DOCX para TXT", "Extraia o texto principal de um documento Word."],
  ["csv-xlsx", "09", "planilha", "CSV para XLSX", "Converta dados CSV em uma planilha Excel."],
  ["xlsx-csv", "10", "planilha", "XLSX para CSV", "Exporte a primeira aba da planilha para CSV."],
  ["ofx-csv", "11", "financeiro", "OFX para CSV", "Converta o extrato bancário em uma tabela compatível com planilhas."],
  ["ofx-xlsx", "12", "financeiro", "OFX para XLSX", "Transforme as transações do OFX em uma planilha Excel."],
  ["ofx-summary", "13", "financeiro", "OFX para PDF", "Gere um PDF com saldos, entradas, saídas e transações."],
  ["pdf-ofx", "14", "financeiro", "PDF para OFX", "Processe vários extratos e confira cada lançamento antes de gerar os OFXs."],
  ["word-pdf", "15", "documento", "Word para PDF", "Reconstrua visualmente cada página do DOCX em PDF."],
  ["pdf-word", "16", "documento", "PDF para Word", "Converta PDFs, inclusive digitalizações, em texto editável no Word usando OCR."],
  ["digital-sign", "17", "documento", "Assinatura digital com certificado", "Assine com certificado disponível no Windows ou arquivo A1."],
  ["visual-sign", "18", "documento", "Inserir assinatura visual", "Adicione nome e aparência de assinatura a um PDF."],
  ["pdf-xml-abrasf", "19", "documento", "PDF para XML ABRASF", "Converta NFS-e de diferentes municípios em XML ABRASF 2.04 para importação contábil."],
].map(([id, number, category, title, description]) => ({ id, number, category, title, description }));

const startupElements = {
  grid: document.querySelector("#toolsGrid"),
  search: document.querySelector("#toolSearch"),
  resultCount: document.querySelector("#toolResultCount"),
  empty: document.querySelector("#toolsEmpty"),
  filters: [...document.querySelectorAll("[data-filter]")],
};
let startupFilter = "todos";
let applicationPromise;

function renderStartupTools() {
  startupElements.grid.innerHTML = startupTools.map(tool => `
    <button class="tool-card" data-tool="${tool.id}" data-category="${tool.category}">
      <span class="tool-number">${tool.number}</span>
      <span class="tool-arrow">↗</span>
      <h3>${tool.title}</h3>
      <p>${tool.description}</p>
    </button>
  `).join("");
  filterStartupTools();
}

function filterStartupTools() {
  const query = startupElements.search.value.trim().toLocaleLowerCase("pt-BR");
  let visible = 0;
  for (const card of startupElements.grid.querySelectorAll(".tool-card")) {
    const categoryMatches = startupFilter === "todos" || card.dataset.category === startupFilter;
    const textMatches = !query || card.textContent.toLocaleLowerCase("pt-BR").includes(query);
    card.hidden = !(categoryMatches && textMatches);
    if (!card.hidden) visible += 1;
  }
  startupElements.resultCount.textContent = `${visible} ${visible === 1 ? "ferramenta" : "ferramentas"}`;
  startupElements.empty.hidden = visible !== 0;
}

function onStartupFilter(event) {
  startupFilter = event.currentTarget.dataset.filter;
  for (const button of startupElements.filters) {
    const active = button === event.currentTarget;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  filterStartupTools();
}

async function onStartupCard(event) {
  const card = event.target.closest("[data-tool]");
  if (!card) return;
  const toolId = card.dataset.tool;
  await loadApplication();
  document.querySelector(`[data-tool="${toolId}"]`)?.click();
}

function bindStartupInteractions() {
  startupElements.grid.addEventListener("click", onStartupCard);
  startupElements.search.addEventListener("input", filterStartupTools);
  for (const button of startupElements.filters) button.addEventListener("click", onStartupFilter);
}

function unbindStartupInteractions() {
  startupElements.grid.removeEventListener("click", onStartupCard);
  startupElements.search.removeEventListener("input", filterStartupTools);
  for (const button of startupElements.filters) button.removeEventListener("click", onStartupFilter);
}

async function loadApplication() {
  if (!applicationPromise) {
    unbindStartupInteractions();
    applicationPromise = import("./app.js?v=20260929-2");
  }
  return applicationPromise;
}

function signalDesktopPaintedFrame() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(async () => {
      try {
        const accepted = await window.docprontoDesktop.signalPainted();
        if (!accepted) {
          window.setTimeout(signalDesktopPaintedFrame, 16);
          return;
        }
        await loadApplication();
        await import("./lab-ui.mjs");
      } catch {
        // The desktop shell owns startup diagnostics; the initial tools remain usable.
      }
    });
  });
}

renderStartupTools();
bindStartupInteractions();
if (window.docprontoDesktop) signalDesktopPaintedFrame();
else void loadApplication();
