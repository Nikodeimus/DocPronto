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
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$thumbprint = $env:DOCPRONTO_CERT_THUMBPRINT -replace '\\s', ''
$content = [Convert]::FromBase64String($env:DOCPRONTO_CONTENT_BASE64)
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
  return (await runPowerShell(script, {
    DOCPRONTO_CERT_THUMBPRINT: cleanThumbprint,
    DOCPRONTO_CONTENT_BASE64: contentBase64
  })).trim();
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
