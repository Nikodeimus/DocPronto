import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".gz": "application/gzip"
};

createServer(async (request, response) => {
  let requested;
  try {
    requested = decodeURIComponent((request.url || "/").split("?")[0]);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("URL invalida.");
    return;
  }

  if (requested.startsWith("/api/")) {
    await handleApi(request, response, requested);
    return;
  }

  const requestedPath = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = resolve(root, requestedPath);
  const pathFromRoot = relative(root, filePath);

  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Arquivo nao encontrado.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob: data:; connect-src 'self' http://127.0.0.1:4174 http://127.0.0.1:4173 https://tessdata.projectnaptha.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store"
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Nao foi possivel ler o arquivo.");
  });
  stream.pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`DocPronto disponivel em http://127.0.0.1:${port}`);
});

async function handleApi(request, response, requested) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    if (request.method === "GET" && requested === "/api/certificates") {
      writeJson(response, 200, { certificates: await listWindowsCertificates() });
      return;
    }
    if (request.method === "POST" && requested === "/api/sign-installed") {
      writeJson(response, 200, { signatureBase64: await signWithWindowsCertificate(await readJsonBody(request)) });
      return;
    }
    if (request.method === "POST" && requested === "/api/sign-pdf-installed") {
      writeJson(response, 200, await signPdfWithWindowsCertificate(await readJsonBody(request)));
      return;
    }
    if (request.method === "POST" && requested === "/api/word-to-pdf") {
      writeJson(response, 200, await convertOfficeDocument(await readJsonBody(request), "pdf"));
      return;
    }
    if (request.method === "POST" && requested === "/api/pdf-to-word") {
      writeJson(response, 200, await convertOfficeDocument(await readJsonBody(request), "docx"));
      return;
    }
    writeJson(response, 404, { error: "API nao encontrada." });
  } catch (error) {
    writeJson(response, 400, { error: error.message || "Falha ao processar assinatura local." });
  }
}

async function convertOfficeDocument({ filename, contentBase64 }, target) {
  if (!contentBase64 || typeof contentBase64 !== "string") throw new Error("Arquivo nao informado para conversao.");
  const sourceExt = target === "pdf" ? ".docx" : ".pdf";
  const targetExt = target === "pdf" ? ".pdf" : ".docx";
  if (!String(filename || "").toLowerCase().endsWith(sourceExt)) throw new Error(`Arquivo precisa estar em formato ${sourceExt}.`);

  const tempDir = await mkdtemp(join(tmpdir(), "docpronto-"));
  const inputPath = join(tempDir, `entrada${sourceExt}`);
  const outputPath = join(tempDir, `saida${targetExt}`);
  try {
    await writeFile(inputPath, Buffer.from(contentBase64, "base64"));
    if (target === "pdf") await wordToPdfWithMicrosoftWord(inputPath, outputPath);
    else await pdfToWordWithMicrosoftWord(inputPath, outputPath);
    const converted = await readFile(outputPath);
    return {
      filename: `${baseName(filename)}${targetExt}`,
      contentBase64: converted.toString("base64")
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function wordToPdfWithMicrosoftWord(inputPath, outputPath) {
  const script = `
$ErrorActionPreference = 'Stop'
$inputPath = $env:DOCPRONTO_INPUT
$outputPath = $env:DOCPRONTO_OUTPUT
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  try {
    $doc.ExportAsFixedFormat($outputPath, 17)
  } finally {
    $doc.Close($false)
  }
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;
  await runPowerShell(script, { DOCPRONTO_INPUT: inputPath, DOCPRONTO_OUTPUT: outputPath }, 120000);
}

async function pdfToWordWithMicrosoftWord(inputPath, outputPath) {
  const script = `
$ErrorActionPreference = 'Stop'
$inputPath = $env:DOCPRONTO_INPUT
$outputPath = $env:DOCPRONTO_OUTPUT
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  try {
    $doc.SaveAs2($outputPath, 16)
  } finally {
    $doc.Close($false)
  }
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;
  await runPowerShell(script, { DOCPRONTO_INPUT: inputPath, DOCPRONTO_OUTPUT: outputPath }, 45000);
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function baseName(filename) {
  return String(filename || "arquivo").replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 160);
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      data += chunk;
      if (data.length > 80 * 1024 * 1024) reject(new Error("Arquivo grande demais para assinatura local."));
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Requisicao invalida."));
      }
    });
    request.on("error", reject);
  });
}

async function listWindowsCertificates() {
  const script = `
$ErrorActionPreference = 'Stop'
$now = Get-Date
Get-ChildItem Cert:\\CurrentUser\\My |
  Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt $now } |
  Sort-Object NotAfter |
  ForEach-Object {
    [PSCustomObject]@{
      subject = $_.Subject
      thumbprint = $_.Thumbprint
      notAfter = $_.NotAfter.ToString('yyyy-MM-dd HH:mm:ss')
      label = ($_.Subject -replace '^CN=', '' -replace ', OU=.*$', '') + ' - vence ' + $_.NotAfter.ToString('dd/MM/yyyy')
    }
  } | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script);
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function signWithWindowsCertificate({ thumbprint, contentBase64 }) {
  const cleanThumbprint = String(thumbprint || "").replace(/\s/g, "");
  if (!/^[a-fA-F0-9]{40}$/.test(cleanThumbprint)) throw new Error("Selecione um certificado instalado valido.");
  if (!contentBase64 || typeof contentBase64 !== "string") throw new Error("Arquivo nao informado para assinatura.");
  return signBufferWithWindowsCertificate(cleanThumbprint, Buffer.from(contentBase64, "base64"));
}

async function signBufferWithWindowsCertificate(thumbprint, content) {
  const cleanThumbprint = String(thumbprint || "").replace(/\s/g, "");
  if (!/^[a-fA-F0-9]{40}$/.test(cleanThumbprint)) throw new Error("Selecione um certificado instalado valido.");
  const tempDir = await mkdtemp(join(tmpdir(), "docpronto-sign-"));
  const inputPath = join(tempDir, "content.bin");
  await writeFile(inputPath, content);
  debugLog(`windows-sign:start:${content.length}`);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$thumbprint = $env:DOCPRONTO_CERT_THUMBPRINT -replace '\\s', ''
$content = [System.IO.File]::ReadAllBytes($env:DOCPRONTO_SIGN_INPUT)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $cert = $store.Certificates | Where-Object { ($_.Thumbprint -replace '\\s', '') -eq $thumbprint } | Select-Object -First 1
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
  try {
    const output = (await runPowerShell(script, {
      DOCPRONTO_CERT_THUMBPRINT: cleanThumbprint,
      DOCPRONTO_SIGN_INPUT: inputPath
    }, 120000)).trim();
    debugLog(`windows-sign:done:${output.length}`);
    return output;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    debugLog("windows-sign:temp-removed");
  }
}

async function signPdfWithWindowsCertificate({ filename, thumbprint, contentBase64, signerName }) {
  debugLog("sign-pdf-installed:start");
  const cleanThumbprint = String(thumbprint || "").replace(/\s/g, "");
  if (!/^[a-fA-F0-9]{40}$/.test(cleanThumbprint)) throw new Error("Selecione um certificado instalado valido.");
  if (!contentBase64 || typeof contentBase64 !== "string") throw new Error("Arquivo nao informado para assinatura.");
  const pdf = Buffer.from(contentBase64, "base64");
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("A assinatura embutida esta disponivel para PDF.");
  debugLog(`sign-pdf-installed:pdf-bytes:${pdf.length}`);
  const certificate = await getWindowsCertificate(cleanThumbprint);
  debugLog("sign-pdf-installed:certificate-ok");
  const prepared = appendPdfSignaturePlaceholder(pdf, {
    signerName: signerName || certificate.label || certificate.subject || "Assinatura digital",
    reason: "Assinado digitalmente pelo DocPronto"
  });
  debugLog(`sign-pdf-installed:prepared:${prepared.pdf.length}`);
  const signedBytes = Buffer.concat([
    prepared.pdf.subarray(0, prepared.byteRange[1]),
    prepared.pdf.subarray(prepared.byteRange[2], prepared.byteRange[2] + prepared.byteRange[3])
  ]);
  debugLog(`sign-pdf-installed:signing-bytes:${signedBytes.length}`);
  const signatureBase64 = await signBufferWithWindowsCertificate(cleanThumbprint, signedBytes);
  debugLog(`sign-pdf-installed:signature-base64:${signatureBase64.length}`);
  const signatureHex = Buffer.from(signatureBase64, "base64").toString("hex").toUpperCase();
  if (signatureHex.length > prepared.placeholderHexLength) throw new Error("Assinatura maior que o espaco reservado no PDF.");
  debugLog(`sign-pdf-installed:hex:${signatureHex.length}:${prepared.placeholderHexLength}:${prepared.contentsHexStart}`);
  const output = Buffer.from(prepared.pdf);
  output.write(signatureHex.padEnd(prepared.placeholderHexLength, "0"), prepared.contentsHexStart, "ascii");
  debugLog(`sign-pdf-installed:output-ready:${output.length}`);
  return {
    filename: `${baseName(filename)}-assinado.pdf`,
    contentBase64: output.toString("base64")
  };
}

function debugLog(message) {
  if (!process.env.DOCPRONTO_DEBUG) return;
  console.error(`[${new Date().toISOString()}] ${message}`);
}

async function getWindowsCertificate(thumbprint) {
  const certificates = await listWindowsCertificates();
  const found = certificates.find(item => String(item.thumbprint || "").replace(/\s/g, "").toUpperCase() === thumbprint.toUpperCase());
  if (!found) throw new Error("Certificado nao encontrado no Windows.");
  return found;
}

function appendPdfSignaturePlaceholder(pdf, { signerName, reason }) {
  const source = pdf.toString("latin1");
  const rootMatch = source.match(/1 0 obj\s*<<(.*?)>>\s*endobj/s);
  const pageMatch = source.match(/3 0 obj\s*<<(.*?)>>\s*endobj/s);
  const prevStart = Number((source.match(/startxref\s+(\d+)\s+%%EOF\s*$/s) || [])[1]);
  const trailerMatch = source.match(/trailer\s*<<(.*?)>>\s*startxref\s+\d+\s+%%EOF\s*$/s);
  if (!rootMatch || !pageMatch || !Number.isFinite(prevStart) || !trailerMatch) {
    throw new Error("Este PDF nao possui estrutura compativel com assinatura embutida local.");
  }

  const sizeMatch = trailerMatch[1].match(/\/Size\s+(\d+)/);
  const infoMatch = trailerMatch[1].match(/\/Info\s+\d+\s+\d+\s+R/);
  const idMatch = trailerMatch[1].match(/\/ID\s*\[[^\]]+\]/);
  const size = Number(sizeMatch?.[1] || 0);
  if (!size) throw new Error("Nao foi possivel preparar o PDF para assinatura.");

  const acroFormObj = size;
  const widgetObj = size + 1;
  const signatureObj = size + 2;
  const appearanceObj = size + 3;
  const fontObj = size + 4;
  const newSize = size + 5;
  const rootBody = addPdfDictionaryEntry(rootMatch[1], `/AcroForm ${acroFormObj} 0 R`);
  const pageBody = addPdfDictionaryEntry(pageMatch[1], `/Annots[${widgetObj} 0 R]`);
  const now = pdfDate(new Date());
  const visibleText = [
    `Assinado de forma digital por`,
    cleanPdfText(signerName).slice(0, 54),
    `Dados: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} -03'00'`
  ];
  const appearanceStream = [
    "q",
    "1 1 1 rg 0 0 290 78 re f",
    "0.1 0.1 0.1 RG 0.8 w 0 0 290 78 re S",
    "BT /Helv 10 Tf 0 0 0 rg 10 54 Td",
    `(${escapePdfString(visibleText[0])}) Tj`,
    "0 -16 Td",
    `(${escapePdfString(visibleText[1])}) Tj`,
    "0 -16 Td",
    `(${escapePdfString(visibleText[2])}) Tj`,
    "ET",
    "Q"
  ].join("\n");
  const placeholderHexLength = 65536;
  const byteRangePlaceholder = "[0000000000 0000000000 0000000000 0000000000]";
  const objects = [
    `1 0 obj\n<<${rootBody}>>\nendobj\n`,
    `3 0 obj\n<<${pageBody}>>\nendobj\n`,
    `${acroFormObj} 0 obj\n<</Fields[${widgetObj} 0 R]/SigFlags 3>>\nendobj\n`,
    `${widgetObj} 0 obj\n<</Type/Annot/Subtype/Widget/FT/Sig/Rect[300 92 590 170]/T(Signature1)/V ${signatureObj} 0 R/P 3 0 R/F 132/AP<</N ${appearanceObj} 0 R>>>>\nendobj\n`,
    `${signatureObj} 0 obj\n<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/adbe.pkcs7.detached/ByteRange ${byteRangePlaceholder}/Contents <${"0".repeat(placeholderHexLength)}>/Reason(${escapePdfString(reason)})/M(${now})/Name(${escapePdfString(cleanPdfText(signerName))})>>\nendobj\n`,
    `${appearanceObj} 0 obj\n<</Type/XObject/Subtype/Form/BBox[0 0 290 78]/Resources<</Font<</Helv ${fontObj} 0 R>>>>/Length ${Buffer.byteLength(appearanceStream, "latin1")}>>\nstream\n${appearanceStream}\nendstream\nendobj\n`,
    `${fontObj} 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n`
  ];

  const offsets = new Map();
  let incremental = "\n";
  let cursor = pdf.length + Buffer.byteLength(incremental, "latin1");
  const objectNumbers = [1, 3, acroFormObj, widgetObj, signatureObj, appearanceObj, fontObj];
  objects.forEach((object, index) => {
    offsets.set(objectNumbers[index], cursor);
    incremental += object;
    cursor += Buffer.byteLength(object, "latin1");
  });
  const xrefOffset = cursor;
  const xrefObjects = [...objectNumbers].sort((a, b) => a - b);
  incremental += "xref\n";
  xrefObjects.forEach(objectNumber => {
    incremental += `${objectNumber} 1\n${String(offsets.get(objectNumber)).padStart(10, "0")} 00000 n \n`;
  });
  incremental += `trailer\n<</Size ${newSize}/Root 1 0 R${infoMatch ? infoMatch[0] : ""}${idMatch ? idMatch[0] : ""}/Prev ${prevStart}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  let output = Buffer.concat([pdf, Buffer.from(incremental, "latin1")]);
  const contentsMarker = "/Contents <";
  const contentsStart = output.indexOf(contentsMarker, pdf.length, "latin1") + contentsMarker.length - 1;
  const contentsHexStart = contentsStart + 1;
  const contentsEnd = contentsHexStart + placeholderHexLength + 1;
  const byteRange = [0, contentsStart, contentsEnd, output.length - contentsEnd];
  const byteRangeValue = `[${byteRange.map(value => String(value).padStart(10, "0")).join(" ")}]`;
  const byteRangeOffset = output.indexOf(byteRangePlaceholder, pdf.length, "latin1");
  output.write(byteRangeValue, byteRangeOffset, "ascii");
  return { pdf: output, byteRange, contentsHexStart, placeholderHexLength };
}

function addPdfDictionaryEntry(body, entry) {
  const clean = body.trim();
  if (/\/AcroForm\b/.test(entry) && /\/AcroForm\s+\d+\s+\d+\s+R/.test(clean)) {
    return clean.replace(/\/AcroForm\s+\d+\s+\d+\s+R/, entry);
  }
  if (/\/Annots\b/.test(entry) && /\/Annots\s*\[[^\]]*\]/s.test(clean)) {
    return clean.replace(/\/Annots\s*\[([^\]]*)\]/s, (match, refs) => `/Annots[${refs.trim()} ${entry.match(/\[(.*)\]/)?.[1] || ""}]`);
  }
  return `${clean}${entry}`;
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

function runPowerShell(script, env = {}, timeoutMs = 30000) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Operacao local demorou demais e foi cancelada."));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(stderr.trim() || "PowerShell retornou erro ao acessar certificados."));
    });
  });
}
