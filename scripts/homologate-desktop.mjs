import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SUPPORTED_TOOLS = new Set(["pdf-word", "visual-sign", "pdf-ofx", "pdf-xml-abrasf"]);
const WORD_MODES = new Set(["editable-layout", "fast", "visual"]);
const DEFAULT_TIMEOUT_MS = 180_000;

export class HarnessError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

function valueAfter(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new HarnessError("ARGUMENT_REQUIRED", `${option} exige um valor.`);
  return value;
}

export function parseHarnessArguments(arguments_, { cwd = process.cwd() } = {}) {
  const parsed = {
    inputs: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mode: "editable-layout",
    logicalCopies: 1,
    signer: "",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--tool") parsed.tool = valueAfter(arguments_, index++, option);
    else if (option === "--input") parsed.inputs.push(resolve(cwd, valueAfter(arguments_, index++, option)));
    else if (option === "--output") parsed.outputDirectory = resolve(cwd, valueAfter(arguments_, index++, option));
    else if (option === "--timeout-ms") parsed.timeoutMs = Number(valueAfter(arguments_, index++, option));
    else if (option === "--mode") parsed.mode = valueAfter(arguments_, index++, option);
    else if (option === "--copies") parsed.logicalCopies = Number(valueAfter(arguments_, index++, option));
    else if (option === "--signer") parsed.signer = valueAfter(arguments_, index++, option).trim();
    else throw new HarnessError("UNKNOWN_ARGUMENT", `Argumento desconhecido: ${option}`);
  }
  if (!SUPPORTED_TOOLS.has(parsed.tool)) {
    throw new HarnessError("INVALID_TOOL", "Use --tool pdf-word, visual-sign, pdf-ofx ou pdf-xml-abrasf.");
  }
  if (!parsed.inputs.length) throw new HarnessError("INPUT_REQUIRED", "Informe ao menos um --input.");
  if (!parsed.outputDirectory) throw new HarnessError("OUTPUT_REQUIRED", "Informe --output.");
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000 || parsed.timeoutMs > 30 * 60_000) {
    throw new HarnessError("INVALID_TIMEOUT", "--timeout-ms deve ficar entre 1000 e 1800000.");
  }
  if (!Number.isInteger(parsed.logicalCopies) || parsed.logicalCopies < 1 || parsed.logicalCopies > 30) {
    throw new HarnessError("INVALID_COPIES", "--copies deve ficar entre 1 e 30.");
  }
  if (parsed.tool !== "pdf-ofx" && parsed.logicalCopies !== 1) {
    throw new HarnessError("COPIES_NOT_SUPPORTED", "--copies só é aceito em pdf-ofx.");
  }
  if (parsed.tool === "pdf-ofx" && parsed.logicalCopies > 1) {
    if (parsed.inputs.length !== 1) throw new HarnessError("COPIES_REQUIRE_ONE_INPUT", "Use --copies com um único --input.");
    parsed.inputs = Array.from({ length: parsed.logicalCopies }, () => parsed.inputs[0]);
  }
  if (parsed.tool === "pdf-word" && !WORD_MODES.has(parsed.mode)) {
    throw new HarnessError("INVALID_WORD_MODE", "--mode deve ser editable-layout, fast ou visual.");
  }
  if (parsed.tool === "visual-sign" && !parsed.signer) {
    throw new HarnessError("SIGNER_REQUIRED", "Assinatura visual exige --signer.");
  }
  for (const input of parsed.inputs) {
    if (extname(input).toLowerCase() !== ".pdf") throw new HarnessError("INVALID_INPUT_TYPE", "Este harness aceita somente PDF.");
  }
  return parsed;
}

export function assessOfxReview(snapshot) {
  const placeholderMetadata = /^(?:pdf(?:-|$)|desconhecid|n\/a)/i;
  const safe = Boolean(
    snapshot?.open
      && !snapshot.confirmDisabled
      && Number(snapshot.transactionCount) > 0
      && snapshot.bankId
      && snapshot.accountId
      && !placeholderMetadata.test(String(snapshot.bankId).trim())
      && !placeholderMetadata.test(String(snapshot.accountId).trim())
      && !String(snapshot.errorText || "").trim(),
  );
  return { safe, reason: safe ? "OFX_REVIEW_READY" : "OFX_REVIEW_REQUIRES_HUMAN" };
}

export async function runWithTimeout(operation, timeoutMs, cleanup = async () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HarnessError(
          "HARNESS_TIMEOUT",
          `A homologação excedeu ${timeoutMs} ms.`,
        )), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error?.code === "HARNESS_TIMEOUT") await cleanup();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function validateOutput(path, tool) {
  const bytes = await readFile(path);
  if (bytes.length < 5) throw new HarnessError("OUTPUT_EMPTY", `Saída vazia: ${basename(path)}`);
  if (tool === "pdf-word") {
    if (extname(path).toLowerCase() !== ".docx" || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new HarnessError("INVALID_DOCX_OUTPUT", `Saída DOCX inválida: ${basename(path)}`);
    }
    return { path, kind: "docx", size: bytes.length };
  }
  if (tool === "visual-sign") {
    if (extname(path).toLowerCase() !== ".pdf" || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new HarnessError("INVALID_PDF_OUTPUT", `Saída PDF inválida: ${basename(path)}`);
    }
    return { path, kind: "pdf", size: bytes.length };
  }
  if (tool === "pdf-ofx") {
    const extension = extname(path).toLowerCase();
    const validOfx = extension === ".ofx" && /<(?:OFX|OFXHEADER)>/i.test(bytes.toString("utf8"));
    const validZip = extension === ".zip" && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!validOfx && !validZip) throw new HarnessError("INVALID_OFX_OUTPUT", `Saída OFX/ZIP inválida: ${basename(path)}`);
    return { path, kind: validZip ? "zip" : "ofx", size: bytes.length };
  }
  if (tool === "pdf-xml-abrasf") {
    const text = bytes.toString("utf8");
    if (extname(path).toLowerCase() !== ".xml" || !/<CompNfse\b[^>]*xmlns="http:\/\/www\.abrasf\.org\.br\/nfse\.xsd"/i.test(text) || !/<Nfse\b[^>]*versao="2\.04"/i.test(text)) {
      throw new HarnessError("INVALID_ABRASF_OUTPUT", `Saída XML ABRASF inválida: ${basename(path)}`);
    }
    return { path, kind: "xml", size: bytes.length };
  }
  throw new HarnessError("INVALID_TOOL", `Ferramenta sem validador: ${tool}`);
}

export function registerHarnessIpc(ipcMain) {
  const handlers = new Map([
    ["docpronto:get-app-info", async () => ({
      channel: "lab",
      productName: "DOCPronto Homologação",
      laboratory: false,
    })],
    ["docpronto:window-painted", async () => true],
    ["docpronto:diagnostics:list", async () => []],
    ["docpronto:diagnostics:clear", async () => true],
    ["docpronto:diagnostics:export", async () => null],
    ["docpronto:diagnostics:record", async () => true],
  ]);
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  };
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(webContents, expression, { timeoutMs = 15_000, intervalMs = 100, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await webContents.executeJavaScript(expression, true);
    if (value) return value;
    await delay(intervalMs);
  }
  throw new HarnessError("UI_WAIT_TIMEOUT", `Tempo esgotado aguardando ${label}.`);
}

async function setFileInputPaths(webContents, paths) {
  if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
  const { root } = await webContents.debugger.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await webContents.debugger.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#fileInput",
  });
  if (!nodeId) throw new HarnessError("FILE_INPUT_NOT_FOUND", "O input de arquivo da UI não foi encontrado.");
  await webContents.debugger.sendCommand("DOM.setFileInputFiles", { files: paths, nodeId });
  await webContents.executeJavaScript("document.querySelector('#fileInput').dispatchEvent(new Event('change', { bubbles: true }))", true);
}

async function makeLogicalCopies(inputs, root) {
  if (new Set(inputs).size === inputs.length) return inputs;
  const paths = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const source = inputs[index];
    const target = join(root, `${String(index + 1).padStart(2, "0")}-${basename(source)}`);
    await copyFile(source, target);
    paths.push(target);
  }
  return paths;
}

function createDownloadCollector(session, outputDirectory) {
  const downloads = [];
  const pending = new Set();
  const listener = (_event, item) => {
    const promise = (async () => {
      const suggested = basename(item.getFilename());
      let destination = join(outputDirectory, suggested);
      let suffix = 2;
      while (downloads.some(entry => entry.path.toLowerCase() === destination.toLowerCase())) {
        destination = join(outputDirectory, `${basename(suggested, extname(suggested))}-${suffix++}${extname(suggested)}`);
      }
      item.setSavePath(destination);
      const state = await new Promise(resolveState => item.once("done", (_doneEvent, finalState) => resolveState(finalState)));
      if (state !== "completed") throw new HarnessError("DOWNLOAD_FAILED", `Download ${suggested} terminou em ${state}.`);
      downloads.push({ path: destination, filename: basename(destination) });
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };
  session.on("will-download", listener);
  return {
    downloads,
    async waitForCount(count, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (downloads.length < count && Date.now() < deadline) {
        const rejected = [...pending].map(promise => promise.then(() => null, error => error));
        const failure = rejected.length ? await Promise.race([Promise.all(rejected), delay(100).then(() => [])]) : [];
        if (failure.some(Boolean)) throw failure.find(Boolean);
        await delay(100);
      }
      if (downloads.length < count) throw new HarnessError("DOWNLOAD_TIMEOUT", "A UI não concluiu o download esperado.");
      await Promise.all(pending);
      return downloads;
    },
    dispose() { session.off("will-download", listener); },
  };
}

async function driveTool(window, options, inputPaths, collector) {
  const webContents = window.webContents;
  await waitFor(webContents, "document.readyState === 'complete' && Boolean(document.querySelector('[data-tool]'))", {
    label: "a página real do DOCPronto",
  });
  const opened = await webContents.executeJavaScript(`(() => {
    const card = document.querySelector(${JSON.stringify(`[data-tool="${options.tool}"]`)});
    if (!card) return false;
    card.click();
    return true;
  })()`, true);
  if (!opened) throw new HarnessError("TOOL_NOT_FOUND", `Ferramenta não encontrada na UI: ${options.tool}`);
  await waitFor(webContents, "document.querySelector('#toolDialog')?.open === true", { label: "o diálogo da ferramenta" });
  await setFileInputPaths(webContents, inputPaths);
  await waitFor(webContents, `document.querySelectorAll('#fileList .file-item').length === ${inputPaths.length}`, {
    timeoutMs: 20_000,
    label: "a validação dos arquivos pela UI",
  });

  if (options.tool === "pdf-word") {
    await webContents.executeJavaScript(`document.querySelector('#pdfWordMode').value = ${JSON.stringify(options.mode)}`, true);
  } else if (options.tool === "visual-sign") {
    await webContents.executeJavaScript(`document.querySelector('#writtenSignature').value = ${JSON.stringify(options.signer)}`, true);
  }
  await webContents.executeJavaScript("document.querySelector('#processButton').click()", true);

  if (options.tool === "visual-sign") {
    await waitFor(webContents, "document.querySelector('#signaturePlacementDialog')?.open === true && !document.querySelector('#signatureConfirmButton')?.disabled", {
      timeoutMs: Math.min(options.timeoutMs, 60_000),
      label: "a prévia de posicionamento da assinatura visual",
    });
    await webContents.executeJavaScript("document.querySelector('#signatureConfirmButton').click()", true);
  }

  if (options.tool === "pdf-ofx") {
    for (let index = 0; index < inputPaths.length; index += 1) {
      const snapshot = await waitFor(webContents, `(() => {
        const dialog = document.querySelector('#ofxReviewDialog');
        if (!dialog?.open) return null;
        return {
          open: true,
          confirmDisabled: document.querySelector('#ofxReviewConfirm')?.disabled === true,
          bankId: document.querySelector('#reviewBank')?.value || '',
          accountId: document.querySelector('#reviewAccount')?.value || '',
          transactionCount: document.querySelectorAll('#ofxReviewRows [data-review-row]').length,
          errorText: document.querySelector('#ofxReviewErrorCount')?.textContent || ''
        };
      })()`, {
        timeoutMs: Math.min(options.timeoutMs, 90_000),
        label: `a conferência OFX ${index + 1} de ${inputPaths.length}`,
      });
      const assessment = assessOfxReview(snapshot);
      if (!assessment.safe) {
        await webContents.executeJavaScript("document.querySelector('#ofxReviewCancelQueue')?.click()", true).catch(() => {});
        throw new HarnessError(assessment.reason, "A conferência OFX exige revisão humana; nenhum sucesso foi declarado.", snapshot);
      }
      await webContents.executeJavaScript("document.querySelector('#ofxReviewConfirm').click()", true);
      await waitFor(webContents, "document.querySelector('#ofxReviewDialog')?.open !== true", {
        label: `o fechamento da conferência OFX ${index + 1}`,
      });
    }
  }

  return collector.waitForCount(1, options.timeoutMs);
}

async function runElectronHarness(options) {
  const { app, BrowserWindow, ipcMain, session, shell } = await import("electron");
  const { createMainWindow } = await import("../desktop/window.mjs");
  const { startDocProntoService } = await import("../desktop/service/server.mjs");
  const runRoot = await mkdtemp(join(tmpdir(), "docpronto-homologation-"));
  let service;
  let window;
  let collector;
  let disposeIpc;
  const sourceSnapshots = [];
  const startedAt = Date.now();
  const cleanup = async () => {
    collector?.dispose();
    disposeIpc?.();
    disposeIpc = undefined;
    try { if (window?.webContents?.debugger?.isAttached()) window.webContents.debugger.detach(); } catch {}
    if (window && !window.isDestroyed()) window.destroy();
    if (service) await service.close().catch(() => {});
    await rm(runRoot, { recursive: true, force: true });
  };

  try {
    for (const path of new Set(options.inputs)) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new HarnessError("INPUT_NOT_FOUND", `Arquivo não encontrado: ${path}`);
      sourceSnapshots.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
    await mkdir(options.outputDirectory, { recursive: true });
    app.setPath("userData", join(runRoot, "user-data"));
    await app.whenReady();
    const sessionToken = randomBytes(32).toString("hex");
    service = await startDocProntoService({
      assetsRoot: join(PROJECT_ROOT, "public", "docpronto"),
      sessionToken,
      appInfo: { version: app.getVersion(), channel: "lab" },
    });
    disposeIpc = registerHarnessIpc(ipcMain);
    window = createMainWindow({
      BrowserWindow,
      origin: service.origin,
      preloadPath: join(PROJECT_ROOT, "desktop", "preload.cjs"),
      channelConfig: { productName: "DOCPronto Homologação" },
      shell,
    });
    window.show();
    await window.docprontoLoadPromise;
    collector = createDownloadCollector(session.defaultSession, options.outputDirectory);
    const inputPaths = await makeLogicalCopies(options.inputs, runRoot);
    const downloaded = await runWithTimeout(
      () => driveTool(window, options, inputPaths, collector),
      options.timeoutMs,
      cleanup,
    );
    const outputs = [];
    for (const item of downloaded) outputs.push(await validateOutput(item.path, options.tool));
    for (const before of sourceSnapshots) {
      const after = await stat(before.path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new HarnessError("SOURCE_FILE_CHANGED", `O arquivo-fonte foi alterado: ${before.path}`);
      }
    }
    const report = {
      ok: true,
      tool: options.tool,
      mode: options.tool === "pdf-word" ? options.mode : undefined,
      inputCount: options.inputs.length,
      logicalCopies: options.logicalCopies,
      durationMs: Date.now() - startedAt,
      outputs,
      sourceFilesUnchanged: true,
    };
    const reportPath = join(options.outputDirectory, `homologation-${options.tool}-${Date.now()}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, reportPath };
  } finally {
    await cleanup();
  }
}

async function writeProcessStatus(payload) {
  const statusPath = process.env.DOCPRONTO_HOMOLOGATION_STATUS;
  if (process.versions.electron && statusPath) {
    await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

async function spawnElectron(arguments_) {
  const executable = join(PROJECT_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const statusRoot = await mkdtemp(join(tmpdir(), "docpronto-harness-status-"));
  const statusPath = join(statusRoot, "result.json");
  try {
    await writeFile(join(statusRoot, "package.json"), `${JSON.stringify({
      name: "docpronto-homologation-runner",
      private: true,
      type: "module",
      main: "main.mjs",
    }, null, 2)}\n`, "utf8");
    await writeFile(join(statusRoot, "main.mjs"), `import ${JSON.stringify(new URL(`file:///${SCRIPT_PATH.replaceAll("\\", "/")}`).href)};\n`, "utf8");
    await new Promise((resolveRun, reject) => {
      const child = spawn(executable, [statusRoot, ...arguments_], {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        windowsHide: false,
        env: { ...process.env, DOCPRONTO_HOMOLOGATION_STATUS: statusPath },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolveRun();
        else reject(new HarnessError("ELECTRON_HARNESS_FAILED", `Electron terminou com ${signal || `código ${code}`}.`));
      });
    });
    const raw = await readFile(statusPath, "utf8").catch(() => "");
    if (!raw) throw new HarnessError("ELECTRON_STATUS_MISSING", "O processo Electron encerrou sem registrar o resultado.");
    const payload = JSON.parse(raw);
    if (!payload.ok) throw new HarnessError(payload.code || "HARNESS_FAILED", payload.message || "Falha na homologação.", payload.details);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } finally {
    await rm(statusRoot, { recursive: true, force: true });
  }
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (!process.versions.electron) return spawnElectron(arguments_);
  const options = parseHarnessArguments(arguments_, { cwd: process.cwd() });
  const result = await runElectronHarness(options);
  await writeProcessStatus(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.versions.electron || (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH))) {
  void (async () => {
    try {
      const code = await main();
      process.exitCode = code;
      if (process.versions.electron) {
        const { app } = await import("electron");
        app.exit(code);
      }
    } catch (error) {
      const payload = {
        ok: false,
        code: error?.code || "HARNESS_FAILED",
        message: error?.message || "Falha na homologação.",
        details: error?.details,
      };
      await writeProcessStatus(payload).catch(() => {});
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = 1;
      if (process.versions.electron) {
        const { app } = await import("electron");
        app.exit(1);
      }
    }
  })();
}
