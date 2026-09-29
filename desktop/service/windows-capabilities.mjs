import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
const ASSETS_ROOT = fileURLToPath(new URL("../../public/docpronto/", import.meta.url));

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function normalizeThumbprint(value) {
  const thumbprint = String(value || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
    throw codedError("INVALID_CERTIFICATE", "Selecione um certificado instalado valido.");
  }
  return thumbprint;
}

function decodeInput(contentBase64) {
  if (!contentBase64 || typeof contentBase64 !== "string") {
    throw codedError("INVALID_INPUT", "Arquivo nao informado para processamento local.");
  }
  const compact = contentBase64.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const decodedLength = Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
  if (decodedLength > MAX_INPUT_BYTES) {
    throw codedError("INPUT_TOO_LARGE", "Arquivo grande demais para processamento local.");
  }
  return Buffer.from(compact, "base64");
}

async function cleanupTemporaryDirectory(path, dependencies = {}) {
  try {
    await (dependencies.removeTemporaryDirectory || rm)(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch {
    // Cleanup must never replace the operation's primary result or error.
  }
}

function classifyOperationError(error, operation) {
  if (error?.code === "LOCAL_OPERATION_TIMEOUT") return error;
  if (error?.code === "INVALID_CERTIFICATE" || error?.code === "CERTIFICATE_NOT_FOUND") return error;
  const detail = `${error?.code || ""} ${error?.message || ""}`;
  if (/certificado nao encontrado|certificate.*not found/i.test(detail)) {
    return codedError("CERTIFICATE_NOT_FOUND", "Certificado nao encontrado no Windows.", error);
  }
  if (operation === "word" && /ENOENT|powershell|Word\.Application|COM|ActiveX/i.test(detail)) {
    return codedError("WORD_UNAVAILABLE", "Microsoft Word ou PowerShell nao esta disponivel.", error);
  }
  if (operation === "certificate" && /ENOENT|powershell|smart card|cryptographic provider|cert:\\|certificate provider/i.test(detail)) {
    return codedError(
      "CERTIFICATE_PROVIDER_UNAVAILABLE",
      "O provedor de certificados do Windows nao esta disponivel.",
      error,
    );
  }
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codedError(
      "LOCAL_OPERATION_TIMEOUT",
      "Operacao local demorou demais e foi cancelada.",
    )), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function invokePowerShell(script, env, defaultTimeoutMs, dependencies, operation) {
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  try {
    if (dependencies.runPowerShell) {
      return await withTimeout(
        Promise.resolve().then(() => dependencies.runPowerShell(script, env, timeoutMs)),
        timeoutMs,
      );
    }
    return await defaultRunPowerShell(script, env, timeoutMs, dependencies);
  } catch (error) {
    throw classifyOperationError(error, operation);
  }
}

const LIST_CERTIFICATES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$now = Get-Date
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $store.Certificates |
    Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt $now } |
    Sort-Object NotAfter |
    ForEach-Object {
      [PSCustomObject]@{
        subject = $_.Subject
        thumbprint = $_.Thumbprint
        notAfter = $_.NotAfter.ToString('yyyy-MM-dd HH:mm:ss')
        label = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) + ' - vence ' + $_.NotAfter.ToString('dd/MM/yyyy')
      }
    } | ConvertTo-Json -Compress
} finally {
  $store.Close()
}
`;

export async function listWindowsCertificates(dependencies = {}) {
  const output = await invokePowerShell(LIST_CERTIFICATES_SCRIPT, {}, 30_000, dependencies, "certificate");
  if (!String(output).trim()) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const PROBE_WORD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
try {
  [PSCustomObject]@{ version = [string]$word.Version } | ConvertTo-Json -Compress
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;

export async function probeMicrosoftWord(dependencies = {}) {
  const output = await invokePowerShell(PROBE_WORD_SCRIPT, {}, 20_000, dependencies, "word");
  const result = JSON.parse(String(output));
  return {
    capability: "word",
    status: "available",
    version: String(result.version || "unknown"),
  };
}

const SIGN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$thumbprint = $env:DOCPRONTO_CERT_THUMBPRINT -replace '\s', ''
$content = [System.IO.File]::ReadAllBytes($env:DOCPRONTO_SIGN_INPUT)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $cert = $store.Certificates | Where-Object { ($_.Thumbprint -replace '\s', '') -eq $thumbprint } | Select-Object -First 1
  if (-not $cert) { throw 'Certificado nao encontrado no repositorio do Windows.' }
  if (-not $cert.HasPrivateKey) { throw 'Certificado sem chave privada disponivel.' }
  $contentInfo = [System.Security.Cryptography.Pkcs.ContentInfo]::new($content)
  $signedCms = [System.Security.Cryptography.Pkcs.SignedCms]::new($contentInfo, $true)
  $signer = [System.Security.Cryptography.Pkcs.CmsSigner]::new($cert)
  $signer.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
  $signedCms.ComputeSignature($signer, $false)
  [Convert]::ToBase64String($signedCms.Encode())
} finally {
  $store.Close()
}
`;

async function signBufferWithWindowsCertificate(thumbprint, content, dependencies) {
  const tempDir = await mkdtemp(join(dependencies.tempRoot || tmpdir(), "docpronto-sign-"));
  const inputPath = join(tempDir, "content.bin");
  try {
    await writeFile(inputPath, content);
    return String(await invokePowerShell(SIGN_SCRIPT, {
      DOCPRONTO_CERT_THUMBPRINT: thumbprint,
      DOCPRONTO_SIGN_INPUT: inputPath,
    }, 120_000, dependencies, "certificate")).trim();
  } finally {
    await cleanupTemporaryDirectory(tempDir, dependencies);
  }
}

export async function signWithWindowsCertificate(input, dependencies = {}) {
  const thumbprint = normalizeThumbprint(input?.thumbprint);
  const content = decodeInput(input?.contentBase64);
  const signatureBase64 = await signBufferWithWindowsCertificate(thumbprint, content, dependencies);
  await verifyDetachedWindowsSignature(thumbprint, content, signatureBase64, dependencies);
  return signatureBase64;
}

const WORD_NATIVE_METHODS_SCRIPT = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DocProntoNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
`;

const WORD_PROCESS_TRACKING_SCRIPT = String.raw`
$wordProcessId = [uint32]0
[DocProntoNativeMethods]::GetWindowThreadProcessId([IntPtr]$word.Hwnd, [ref]$wordProcessId) | Out-Null
$wordProcess = Get-Process -Id $wordProcessId -ErrorAction Stop
$startedAtTicks = $wordProcess.StartTime.ToUniversalTime().Ticks
$operationStartedTicks = [Int64]$env:DOCPRONTO_WORD_OPERATION_STARTED_TICKS
if ($startedAtTicks -lt $operationStartedTicks) {
  throw 'A instancia do Word e anterior a esta operacao.'
}
[PSCustomObject]@{
  pid = [int]$wordProcessId
  startedAtTicks = [string]$startedAtTicks
  operationStartedTicks = [string]$operationStartedTicks
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:DOCPRONTO_WORD_PROCESS_FILE -Encoding UTF8
`;

const WORD_TO_PDF_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$inputPath = $env:DOCPRONTO_INPUT
$outputPath = $env:DOCPRONTO_OUTPUT
${WORD_NATIVE_METHODS_SCRIPT}
$word = New-Object -ComObject Word.Application
$ownsWordProcess = $true
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  ${WORD_PROCESS_TRACKING_SCRIPT}
  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  try {
    $doc.ExportAsFixedFormat($outputPath, 17)
  } finally {
    $doc.Close($false)
  }
} finally {
  try {
    if ($ownsWordProcess) { $word.Quit() }
  } finally {
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  }
}
`;

const PDF_TO_WORD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$inputPath = $env:DOCPRONTO_INPUT
$outputPath = $env:DOCPRONTO_OUTPUT
${WORD_NATIVE_METHODS_SCRIPT}
$word = New-Object -ComObject Word.Application
$ownsWordProcess = $true
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  ${WORD_PROCESS_TRACKING_SCRIPT}
  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  try {
    $doc.SaveAs2($outputPath, 16)
  } finally {
    $doc.Close($false)
  }
} finally {
  try {
    if ($ownsWordProcess) { $word.Quit() }
  } finally {
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  }
}
`;

function baseName(filename) {
  return String(filename || "arquivo")
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .slice(0, 160);
}

export async function convertOfficeDocument(input, target, dependencies = {}) {
  if (target !== "pdf" && target !== "docx") {
    throw codedError("INVALID_INPUT", "Formato de conversao nao suportado.");
  }
  const sourceExt = target === "pdf" ? ".docx" : ".pdf";
  const targetExt = target === "pdf" ? ".pdf" : ".docx";
  if (!String(input?.filename || "").toLowerCase().endsWith(sourceExt)) {
    throw codedError("INVALID_INPUT", `Arquivo precisa estar em formato ${sourceExt}.`);
  }
  const content = decodeInput(input?.contentBase64);
  const tempDir = await mkdtemp(join(dependencies.tempRoot || tmpdir(), "docpronto-"));
  const inputPath = join(tempDir, `entrada${sourceExt}`);
  const outputPath = join(tempDir, `saida${targetExt}`);
  const wordProcessPath = join(tempDir, "word-process.json");
  try {
    await writeFile(inputPath, content);
    const script = target === "pdf" ? WORD_TO_PDF_SCRIPT : PDF_TO_WORD_SCRIPT;
    const operationTimeout = target === "pdf" ? 120_000 : 45_000;
    const operationStartedTicks = (BigInt(Date.now()) * 10_000n) + 621_355_968_000_000_000n;
    await invokePowerShell(script, {
      DOCPRONTO_INPUT: inputPath,
      DOCPRONTO_OUTPUT: outputPath,
      DOCPRONTO_WORD_PROCESS_FILE: wordProcessPath,
      DOCPRONTO_WORD_OPERATION_STARTED_TICKS: operationStartedTicks.toString(),
    }, operationTimeout, dependencies, "word");
    const outputInfo = await (dependencies.statOutputFile || stat)(outputPath);
    if (outputInfo.size > MAX_OUTPUT_BYTES) {
      throw codedError("OUTPUT_TOO_LARGE", "Arquivo convertido excede o limite local de 80 MB.");
    }
    const converted = await (dependencies.readOutputFile || readFile)(outputPath);
    return {
      filename: `${baseName(input.filename)}${targetExt}`,
      contentBase64: converted.toString("base64"),
    };
  } finally {
    await cleanupTemporaryDirectory(tempDir, dependencies);
  }
}

async function getWindowsCertificate(thumbprint, dependencies) {
  const certificates = await listWindowsCertificates(dependencies);
  const found = certificates.find(item => String(item.thumbprint || "").replace(/\s/g, "").toUpperCase() === thumbprint);
  if (!found) throw codedError("CERTIFICATE_NOT_FOUND", "Certificado nao encontrado no Windows.");
  return found;
}

const VERIFY_SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$content = [System.IO.File]::ReadAllBytes($env:DOCPRONTO_VERIFY_CONTENT)
$signature = [System.IO.File]::ReadAllBytes($env:DOCPRONTO_VERIFY_SIGNATURE)
$cms = [System.Security.Cryptography.Pkcs.SignedCms]::new([System.Security.Cryptography.Pkcs.ContentInfo]::new($content), $true)
$cms.Decode($signature)
$cms.CheckSignature($true)
if ($cms.SignerInfos.Count -ne 1) { throw 'Quantidade inesperada de assinantes.' }
$actual = ($cms.SignerInfos[0].Certificate.Thumbprint -replace '\s', '').ToUpperInvariant()
$expected = ($env:DOCPRONTO_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()
if ($actual -ne $expected) { throw 'O certificado da assinatura nao corresponde ao certificado escolhido.' }
`;

async function verifyDetachedWindowsSignature(thumbprint, content, signatureBase64, dependencies) {
  const tempDir = await mkdtemp(join(dependencies.tempRoot || tmpdir(), "docpronto-verify-"));
  const contentPath = join(tempDir, "content.bin");
  const signaturePath = join(tempDir, "signature.p7s");
  try {
    await writeFile(contentPath, content);
    await writeFile(signaturePath, Buffer.from(signatureBase64, "base64"));
    await invokePowerShell(VERIFY_SIGNATURE_SCRIPT, {
      DOCPRONTO_VERIFY_CONTENT: contentPath,
      DOCPRONTO_VERIFY_SIGNATURE: signaturePath,
      DOCPRONTO_CERT_THUMBPRINT: thumbprint,
    }, 30_000, dependencies, "certificate");
  } finally {
    await cleanupTemporaryDirectory(tempDir, dependencies);
  }
}

export async function signPdfWithWindowsCertificate(input, dependencies = {}) {
  const thumbprint = normalizeThumbprint(input?.thumbprint);
  if (input?.placement?.coordinateSystem !== "pdf-points-v2") {
    throw codedError(
      "INVALID_SIGNATURE_PLACEMENT",
      "A tela de posicionamento esta desatualizada. Escolha novamente a posicao da assinatura.",
    );
  }
  const pdf = decodeInput(input?.contentBase64);
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw codedError("INVALID_INPUT", "A assinatura embutida esta disponivel para PDF.");
  }
  const certificate = await getWindowsCertificate(thumbprint, dependencies);
  const signatureOptions = {
    signerName: input?.signerName || certificate.label || certificate.subject || "Assinatura digital",
    reason: "Assinado digitalmente pelo DocPronto",
    placement: input?.placement,
  };
  const prepared = await appendPdfSignaturePlaceholder(pdf, signatureOptions);
  const signedBytes = Buffer.concat([
    prepared.pdf.subarray(0, prepared.byteRange[1]),
    prepared.pdf.subarray(prepared.byteRange[2], prepared.byteRange[2] + prepared.byteRange[3]),
  ]);
  const signatureBase64 = await signBufferWithWindowsCertificate(thumbprint, signedBytes, dependencies);
  await verifyDetachedWindowsSignature(thumbprint, signedBytes, signatureBase64, dependencies);
  const signatureHex = Buffer.from(signatureBase64, "base64").toString("hex").toUpperCase();
  if (signatureHex.length > prepared.placeholderHexLength) {
    throw codedError("INVALID_CERTIFICATE", "Assinatura maior que o espaco reservado no PDF.");
  }
  const output = Buffer.from(prepared.pdf);
  output.write(signatureHex.padEnd(prepared.placeholderHexLength, "0"), prepared.contentsHexStart, "ascii");
  await validateSignedPdfOutput(output, prepared.byteRange, prepared.expectedWidget);
  return {
    filename: `${baseName(input?.filename)}-assinado.pdf`,
    contentBase64: output.toString("base64"),
  };
}

async function validateSignedPdfOutput(output, expectedByteRange, expectedWidget) {
  try {
    const source = output.toString("latin1");
    if (output.subarray(0, 5).toString("latin1") !== "%PDF-" || !/%%EOF\s*$/.test(source)) {
      throw new Error("O PDF assinado nao possui inicio ou termino validos.");
    }

    const rangeMatches = [...source.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
    const range = rangeMatches.at(-1)?.slice(1).map(Number);
    if (!range || range.length !== 4 || range.some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("O PDF assinado nao contem ByteRange valido.");
    }
    if (range.some((value, index) => value !== expectedByteRange[index])
      || range[0] !== 0 || range[1] >= range[2] || range[2] + range[3] !== output.length) {
      throw new Error("A cobertura criptografica do PDF assinado esta incompleta.");
    }
    const excluded = output.subarray(range[1], range[2]).toString("ascii");
    if (!/^<([0-9A-F]{2})+0*>$/.test(excluded)) {
      throw new Error("O conteudo criptografico embutido no PDF esta invalido.");
    }

    const PDFLib = await loadPdfLibrary();
    const document = await PDFLib.PDFDocument.load(output, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    const pageNumber = expectedWidget.pageNumber;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) {
      throw new Error("A pagina escolhida para a assinatura nao existe no PDF final.");
    }
    const page = document.getPage(pageNumber - 1);
    const { PDFArray, PDFDict, PDFName } = PDFLib;
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const signatureWidgets = [];
    if (annotations) {
      for (let index = 0; index < annotations.size(); index += 1) {
        const reference = annotations.get(index);
        const widget = document.context.lookup(reference, PDFDict);
        if (String(widget?.get(PDFName.of("Subtype"))) === "/Widget"
          && String(widget?.get(PDFName.of("FT"))) === "/Sig"
          && widget.get(PDFName.of("T"))?.decodeText?.() === expectedWidget.fieldName) {
          signatureWidgets.push(widget);
        }
      }
    }
    if (signatureWidgets.length !== 1) {
      throw new Error("O widget de assinatura nao foi encontrado na pagina esperada.");
    }

    const [widget] = signatureWidgets;
    if (String(widget.get(PDFName.of("P"))) !== String(page.ref)) {
      throw new Error("O widget de assinatura nao esta associado a pagina esperada.");
    }
    const signature = widget.lookupMaybe(PDFName.of("V"), PDFDict);
    if (!signature || String(signature.get(PDFName.of("Type"))) !== "/Sig") {
      throw new Error("O widget nao referencia uma assinatura PDF valida.");
    }

    const rectangle = widget.lookupMaybe(PDFName.of("Rect"), PDFArray);
    const actualRectangle = rectangle
      ? Array.from({ length: rectangle.size() }, (_, index) => rectangle.lookup(index)?.asNumber?.())
      : [];
    const tolerance = 0.01;
    if (actualRectangle.length !== 4 || actualRectangle.some((value, index) =>
      !Number.isFinite(value) || Math.abs(value - expectedWidget.rectangle[index]) > tolerance)) {
      throw new Error("O widget de assinatura foi deslocado no PDF final.");
    }

    const appearanceDictionary = widget.lookupMaybe(PDFName.of("AP"), PDFDict);
    const normalAppearanceReference = appearanceDictionary?.get(PDFName.of("N"));
    const normalAppearance = normalAppearanceReference
      ? document.context.lookup(normalAppearanceReference)
      : undefined;
    if (String(normalAppearance?.dict?.get(PDFName.of("Type"))) !== "/XObject"
      || String(normalAppearance?.dict?.get(PDFName.of("Subtype"))) !== "/Form") {
      throw new Error("A aparencia normal da assinatura nao e um Form XObject valido.");
    }
    const appearanceBounds = normalAppearance?.dict?.lookupMaybe(PDFName.of("BBox"), PDFArray);
    const actualBounds = appearanceBounds
      ? Array.from({ length: appearanceBounds.size() }, (_, index) => appearanceBounds.lookup(index)?.asNumber?.())
      : [];
    if (actualBounds.length !== 4 || actualBounds.some((value, index) =>
      !Number.isFinite(value) || Math.abs(value - expectedWidget.appearanceBounds[index]) > tolerance)) {
      throw new Error("A aparencia visual da assinatura possui limites invalidos.");
    }
    if (typeof normalAppearance?.getContents !== "function") {
      throw new Error("O widget de assinatura nao possui aparencia normal visivel.");
    }
    const appearanceContent = Buffer.from(PDFLib.decodePDFRawStream(normalAppearance).decode()).toString("latin1");
    if (!/(?:^|\s)(?:Tj|TJ|Do|S|s|f|F|f\*|B|B\*|b|b\*)(?:\s|$)/.test(appearanceContent)) {
      throw new Error("A aparencia normal da assinatura nao contem conteudo visivel.");
    }
  } catch (error) {
    if (error?.code === "INVALID_SIGNED_PDF") throw error;
    throw codedError("INVALID_SIGNED_PDF", "O PDF assinado falhou na validacao local.", error);
  }
}

let pdfLibrary;
async function loadPdfLibrary() {
  if (!pdfLibrary) {
    const libraryPath = join(ASSETS_ROOT, "vendor", "pdf-lib.min.js");
    if (!existsSync(libraryPath)) throw new Error("Biblioteca de PDF indisponivel.");
    const sandbox = {
      exports: {}, module: { exports: {} }, console,
      setTimeout, clearTimeout, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(await readFile(libraryPath, "utf8"), sandbox, { filename: "pdf-lib.min.js" });
    pdfLibrary = sandbox.exports;
  }
  return pdfLibrary;
}

async function loadUnsignedPdf(pdf) {
  const lib = await loadPdfLibrary();
  let doc;
  try {
    doc = await lib.PDFDocument.load(pdf, { updateMetadata: false });
  } catch (error) {
    const message = /encrypt|password/i.test(error.message)
      ? "Este PDF esta protegido por senha. Remova a protecao antes de assinar."
      : "Nao foi possivel abrir a estrutura deste PDF.";
    throw codedError("INVALID_INPUT", message, error);
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof lib.PDFDict
      && (object.has(lib.PDFName.of("ByteRange")) || object.get(lib.PDFName.of("Type")) === lib.PDFName.of("Sig"))) {
      throw codedError("INVALID_INPUT", "Este PDF ja contem assinatura digital.");
    }
  }
  for (const field of doc.getForm().getFields()) {
    if (field.acroField.dict.get(lib.PDFName.of("FT")) === lib.PDFName.of("Sig")
      && field.acroField.dict.has(lib.PDFName.of("V"))) {
      throw codedError("INVALID_INPUT", "Este PDF ja contem assinatura digital.");
    }
  }
  return { doc, lib };
}

async function appendPdfSignaturePlaceholder(pdf, { signerName, reason, placement } = {}) {
  const { doc, lib } = await loadUnsignedPdf(pdf);
  const { PDFName, PDFNumber, PDFString, PDFHexString, PDFDict, PDFArray, StandardFonts } = lib;
  const pages = doc.getPages();
  const pageNumber = Number(placement?.page ?? 1);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages.length) {
    throw codedError("INVALID_INPUT", "Pagina de assinatura invalida.");
  }
  const page = pages[pageNumber - 1];
  const rect = normalizeSignaturePlacement(placement, page.getCropBox());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    "Assinado de forma digital por",
    cleanPdfText(signerName).slice(0, 54),
    `Dados: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
  ];
  const margin = 4;
  const fontSize = Math.max(4, Math.min(
    10,
    (rect.width - margin * 2) / Math.max(...lines.map(estimateHelveticaWidth)),
    (rect.height - margin * 2) / 3.75,
  ));
  const appearance = doc.context.register(doc.context.flateStream([
    "q", `0 0 ${rect.width} ${rect.height} re W n`,
    `1 1 1 rg 0 0 ${rect.width} ${rect.height} re f`,
    `0.1 0.1 0.1 RG 0.8 w 0 0 ${rect.width} ${rect.height} re S`,
    `BT /Helv ${fontSize} Tf 0 0 0 rg ${margin} ${rect.height - margin - fontSize} Td`,
    ...lines.flatMap((line, index) => [...(index ? [`0 -${fontSize * 1.25} Td`] : []), `(${escapePdfString(line)}) Tj`]),
    "ET", "Q",
  ].join("\n"), {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, rect.width, rect.height],
    Resources: { Font: { Helv: font.ref } },
  }));
  const placeholderHexLength = 65_536;
  const sentinel = 9_999_999_999;
  const signature = doc.context.obj({
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached",
    ByteRange: [sentinel, sentinel, sentinel, sentinel],
    Contents: PDFHexString.of("0".repeat(placeholderHexLength)),
    Reason: PDFString.of(cleanPdfText(reason)),
    M: PDFString.of(pdfDate(new Date())),
    Name: PDFString.of(cleanPdfText(signerName)),
  });
  const signatureRef = doc.context.register(signature);
  const form = doc.getForm();
  const names = new Set(form.getFields().map(field => field.getName()));
  let name = "Signature1";
  let suffix = 1;
  while (names.has(name)) name = `Signature${++suffix}`;
  const widget = doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Widget", FT: "Sig",
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    T: PDFString.of(name), V: signatureRef, P: page.ref, F: 132, AP: { N: appearance },
  }));
  const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  let fields = acroForm.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    fields = doc.context.obj([]);
    acroForm.set(PDFName.of("Fields"), fields);
  }
  fields.push(widget);
  acroForm.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(widget);
  const output = Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
  const contentsToken = `<${"0".repeat(placeholderHexLength)}>`;
  const contentsStart = output.indexOf(contentsToken, 0, "ascii");
  const rangeToken = `[ ${[sentinel, sentinel, sentinel, sentinel].join(" ")} ]`;
  const rangeOffset = output.indexOf(rangeToken, 0, "ascii");
  if (contentsStart < 0 || rangeOffset < 0
    || output.indexOf(contentsToken, contentsStart + 1, "ascii") !== -1
    || output.indexOf(rangeToken, rangeOffset + 1, "ascii") !== -1) {
    throw new Error("Nao foi possivel localizar espaco unico para assinatura.");
  }
  const contentsEnd = contentsStart + contentsToken.length;
  const byteRange = [0, contentsStart, contentsEnd, output.length - contentsEnd];
  const rangeValue = `[ ${byteRange.join(" ")} ]`;
  if (rangeValue.length > rangeToken.length) throw new Error("PDF grande demais para assinatura.");
  output.write(rangeValue.padEnd(rangeToken.length, " "), rangeOffset, "ascii");
  return {
    pdf: output,
    byteRange,
    contentsHexStart: contentsStart + 1,
    placeholderHexLength,
    expectedWidget: {
      fieldName: name,
      pageNumber,
      rectangle: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      appearanceBounds: [0, 0, rect.width, rect.height],
    },
  };
}

function estimateHelveticaWidth(text) {
  return [...String(text || "")].reduce(
    (width, char) => width + (/[MW@#%&]/.test(char) ? 0.9 : /[ilI1.,:;' ]/.test(char) ? 0.28 : 0.55),
    0,
  );
}

function normalizeSignaturePlacement(placement, crop) {
  const rect = {
    x: Number(placement?.x ?? crop.x + Math.max(0, crop.width - Math.min(290, crop.width))),
    y: Number(placement?.y ?? crop.y + Math.min(92, Math.max(0, crop.height - 78))),
    width: Number(placement?.width ?? Math.min(290, crop.width)),
    height: Number(placement?.height ?? Math.min(78, crop.height)),
  };
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw codedError("INVALID_INPUT", "Dimensoes de assinatura invalidas.");
  }
  const tolerance = 0.01;
  if (rect.x < crop.x - tolerance || rect.y < crop.y - tolerance
    || rect.x + rect.width > crop.x + crop.width + tolerance
    || rect.y + rect.height > crop.y + crop.height + tolerance) {
    throw codedError("INVALID_INPUT", "A assinatura deve ficar dentro da pagina.");
  }
  return rect;
}

function pdfDate(date) {
  const pad = value => String(value).padStart(2, "0");
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-03'00'`;
}

function cleanPdfText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, " ");
}

function escapePdfString(value) {
  return cleanPdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const PROCESS_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ([int]$env:DOCPRONTO_TRACKED_PID) -ErrorAction Stop
[PSCustomObject]@{
  name = [string]$process.ProcessName
  startedAtTicks = [string]$process.StartTime.ToUniversalTime().Ticks
} | ConvertTo-Json -Compress
`;

async function defaultGetProcessIdentity(pid) {
  const output = await defaultRunPowerShell(
    PROCESS_IDENTITY_SCRIPT,
    { DOCPRONTO_TRACKED_PID: String(pid) },
    5_000,
    {},
  );
  return JSON.parse(String(output));
}

function defaultKillProcessTree(pid) {
  return new Promise((resolve, reject) => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Nao foi possivel encerrar a arvore do Word."));
    });
  });
}

export async function terminateTrackedWordProcess(trackingPath, dependencies = {}) {
  let tracked;
  try {
    tracked = JSON.parse(await readFile(trackingPath, "utf8"));
  } catch {
    return false;
  }
  const pid = Number(tracked?.pid);
  const startedAtTicks = String(tracked?.startedAtTicks || "");
  const operationStartedTicks = String(tracked?.operationStartedTicks || "");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(startedAtTicks)
    || !/^\d+$/.test(operationStartedTicks) || BigInt(startedAtTicks) < BigInt(operationStartedTicks)) {
    return false;
  }
  let identity;
  try {
    identity = await (dependencies.getProcessIdentity || defaultGetProcessIdentity)(pid);
  } catch {
    return false;
  }
  if (String(identity?.name || "").toUpperCase() !== "WINWORD"
    || String(identity?.startedAtTicks || "") !== startedAtTicks) {
    return false;
  }
  await (dependencies.killProcessTree || defaultKillProcessTree)(pid);
  return true;
}

function defaultRunPowerShell(script, env = {}, timeoutMs = 30_000, dependencies = {}) {
  return new Promise((resolveOutput, reject) => {
    const spawnPowerShell = dependencies.spawnPowerShell || spawn;
    const child = spawnPowerShell("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let trackedTreeTerminated = false;
      let operationTreeTerminated = false;
      try {
        if (env.DOCPRONTO_WORD_PROCESS_FILE) {
          trackedTreeTerminated = await (dependencies.terminateTrackedWordProcess || terminateTrackedWordProcess)(
            env.DOCPRONTO_WORD_PROCESS_FILE,
            dependencies,
          );
        }
      } catch {
        // Keep the primary timeout error even if process cleanup fails.
      }
      if (!trackedTreeTerminated && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          await (dependencies.killProcessTree || defaultKillProcessTree)(child.pid);
          operationTreeTerminated = true;
        } catch {
          // Fall back to terminating the PowerShell host below.
        }
      }
      if (!operationTreeTerminated) {
        child.kill("SIGKILL");
      }
      reject(codedError("LOCAL_OPERATION_TIMEOUT", "Operacao local demorou demais e foi cancelada."));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", finish(reject));
    child.on("close", code => {
      if (code === 0) finish(resolveOutput)(stdout);
      else finish(reject)(new Error(stderr.trim() || "PowerShell retornou erro ao acessar recursos do Windows."));
    });
  });
}
