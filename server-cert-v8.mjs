import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
const agentVersion = "2026.09.15-cert.14";
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
  const origin = String(request.headers.origin || "");
  const configuredOrigins = String(process.env.DOCPRONTO_ALLOWED_ORIGINS || "https://nikodeimus.github.io,http://127.0.0.1:4173,http://localhost:4173")
    .split(",").map(value => value.trim()).filter(Boolean);
  const originAllowed = !origin || configuredOrigins.includes(origin);
  if (!originAllowed) {
    writeJson(response, 403, { error: "Origem não autorizada para acessar o agente local." });
    return;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    if (request.method === "GET" && requested === "/api/health") {
      writeJson(response, 200, { agentVersion, status: "ONLINE" });
      return;
    }
    if (request.method === "GET" && requested === "/api/certificates") {
      writeJson(response, 200, { agentVersion, certificates: await listWindowsCertificates() });
      return;
    }
    if (request.method === "POST" && requested === "/api/dfe/sync") {
      writeJson(response, 200, await syncFiscalDocuments(await readJsonBody(request)));
      return;
    }
    if (request.method === "POST" && requested === "/api/dfe/xml") {
      writeJson(response, 200, await readStoredFiscalDocument(await readJsonBody(request)));
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

async function syncFiscalDocuments({ thumbprint, cnpj, cuf, documentType, lastNSU, certificateMode, pfxBase64, pfxPassword }) {
  const cleanThumbprint = String(thumbprint || "").replace(/\s/g, "");
  const mode = String(certificateMode || "INSTALLED").toUpperCase();
  const cleanCnpj = String(cnpj || "").replace(/\D/g, "");
  const cleanUf = String(cuf || "").replace(/\D/g, "");
  const type = String(documentType || "NFE").toUpperCase();
  const nsu = String(lastNSU || "0").replace(/\D/g, "").padStart(15, "0").slice(-15);
  if (!["A1", "A3", "INSTALLED"].includes(mode)) throw new Error("Selecione um certificado A1 ou A3.");
  if (mode !== "A1" && !/^[a-fA-F0-9]{40}$/.test(cleanThumbprint)) throw new Error("Selecione um certificado A1 ou A3 instalado válido.");
  if (!/^\d{14}$/.test(cleanCnpj)) throw new Error("Informe o CNPJ com 14 dígitos.");
  if (!/^\d{2}$/.test(cleanUf)) throw new Error("Selecione a UF da empresa.");
  if (!["NFE", "CTE"].includes(type)) throw new Error("Tipo de documento fiscal não suportado.");
  if (mode === "A1") return syncFiscalDocumentsA1({ pfxBase64, pfxPassword, cnpj: cleanCnpj, cuf: cleanUf, type, nsu });

  let installedExportFailure = "";
  if (mode === "INSTALLED") {
    const transientPassword = randomBytes(24).toString("base64url");
    try {
      const transientPfx = await exportInstalledCertificateToMemory(cleanThumbprint, transientPassword);
      return await syncFiscalDocumentsA1({ pfxBase64: transientPfx, pfxPassword: transientPassword, cnpj: cleanCnpj, cuf: cleanUf, type, nsu });
    } catch (error) {
      installedExportFailure = String(error.message || error).replace(/\s+/g, " ").trim().slice(0, 300);
    }
  }

  const script = `$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$thumbprint = $env:DOCPRONTO_CERT_THUMBPRINT -replace '\s', ''
$cnpj = $env:DOCPRONTO_CNPJ
$cuf = $env:DOCPRONTO_CUF
$lastNsu = $env:DOCPRONTO_LAST_NSU
$type = $env:DOCPRONTO_DFE_TYPE
$certificateMode = $env:DOCPRONTO_CERT_MODE

$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $cert = $store.Certificates | Where-Object { ($_.Thumbprint -replace '\s', '') -eq $thumbprint } | Select-Object -First 1
  if (-not $cert) { throw 'Certificado A1/A3 não encontrado no Windows.' }
  if (-not $cert.HasPrivateKey) { throw 'O certificado selecionado não possui chave privada disponível.' }

  if ($type -eq 'CTE') {
    $endpoint = 'https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx'
    $serviceNs = 'http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe'
    $fiscalNs = 'http://www.portalfiscal.inf.br/cte'
    $operation = 'cteDistDFeInteresse'
    $messageElement = 'cteDadosMsg'
    $layoutVersion = '1.00'
  } else {
    $endpoint = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
    $serviceNs = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe'
    $fiscalNs = 'http://www.portalfiscal.inf.br/nfe'
    $operation = 'nfeDistDFeInteresse'
    $messageElement = 'nfeDadosMsg'
    $layoutVersion = '1.01'
  }

  $dist = '<distDFeInt xmlns="' + $fiscalNs + '" versao="' + $layoutVersion + '"><tpAmb>1</tpAmb><cUFAutor>' + $cuf + '</cUFAutor><CNPJ>' + $cnpj + '</CNPJ><distNSU><ultNSU>' + $lastNsu + '</ultNSU></distNSU></distDFeInt>'
  $soap = '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><' + $operation + ' xmlns="' + $serviceNs + '"><' + $messageElement + '>' + $dist + '</' + $messageElement + '></' + $operation + '></soap12:Body></soap12:Envelope>'

  $contentType = 'application/soap+xml; charset=utf-8; action="' + $serviceNs + '/' + $operation + '"'
  try {
    $payload = [Text.Encoding]::UTF8.GetBytes($soap)
    $webRequest = [Net.HttpWebRequest]::Create($endpoint)
    $webRequest.Method = 'POST'
    $webRequest.ContentType = $contentType
    $webRequest.ContentLength = $payload.Length
    $webRequest.KeepAlive = $false
    $webRequest.Proxy = $null
    $requestTimeout = $(if ($certificateMode -eq 'A3') { 120000 } else { 45000 })
    $webRequest.Timeout = $requestTimeout
    $webRequest.ReadWriteTimeout = $requestTimeout
    [void]$webRequest.ClientCertificates.Add($cert)
    $requestStream = $webRequest.GetRequestStream()
    try { $requestStream.Write($payload, 0, $payload.Length) } finally { $requestStream.Dispose() }
    $webResponse = $webRequest.GetResponse()
    try {
      $reader = [IO.StreamReader]::new($webResponse.GetResponseStream(), [Text.Encoding]::UTF8)
      try { $responseText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $webResponse.Dispose() }
  } catch {
    $httpMessage = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $httpMessage = $_.ErrorDetails.Message }
    throw ('Falha na conexão direta do Windows com a SEFAZ: ' + $httpMessage)
  }

  [xml]$soapXml = $responseText
  $ret = $soapXml.SelectSingleNode("//*[local-name()='retDistDFeInt']")
  if (-not $ret) { throw 'Resposta da SEFAZ sem retDistDFeInt.' }
  $statusNode = $ret.SelectSingleNode("./*[local-name()='cStat']")
  $messageNode = $ret.SelectSingleNode("./*[local-name()='xMotivo']")
  $lastNode = $ret.SelectSingleNode("./*[local-name()='ultNSU']")
  $maxNode = $ret.SelectSingleNode("./*[local-name()='maxNSU']")
  $documents = @()
  foreach ($docNode in $ret.SelectNodes(".//*[local-name()='docZip']")) {
    $compressed = [Convert]::FromBase64String($docNode.InnerText.Trim())
    $memory = [IO.MemoryStream]::new($compressed)
    $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)
    $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
    try { $documentXml = $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }
    $keyMatch = [regex]::Match($documentXml, '<ch(?:NFe|CTe)>(\d{44})</ch(?:NFe|CTe)>')
    if (-not $keyMatch.Success) { $keyMatch = [regex]::Match($documentXml, 'Id="(?:NFe|CTe)(\d{44})"') }
    if ($keyMatch.Success) { $key = $keyMatch.Groups[1].Value } else { $key = '' }
    $documents += [PSCustomObject]@{
      nsu = $docNode.GetAttribute('NSU')
      schema = $docNode.GetAttribute('schema')
      key = $key
      xmlBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($documentXml))
    }
  }
  [PSCustomObject]@{
    documentType = $type
    statusCode = $(if ($statusNode) { $statusNode.InnerText } else { '' })
    message = $(if ($messageNode) { $messageNode.InnerText } else { '' })
    lastNSU = $(if ($lastNode) { $lastNode.InnerText } else { $lastNsu })
    maxNSU = $(if ($maxNode) { $maxNode.InnerText } else { $lastNsu })
    documents = $documents
  } | ConvertTo-Json -Depth 5 -Compress
} finally {
  $store.Close()
}`;
  let output;
  try {
    output = await runPowerShell(script, {
      DOCPRONTO_CERT_THUMBPRINT: cleanThumbprint,
      DOCPRONTO_CNPJ: cleanCnpj,
      DOCPRONTO_CUF: cleanUf,
      DOCPRONTO_DFE_TYPE: type,
      DOCPRONTO_LAST_NSU: nsu,
      DOCPRONTO_CERT_MODE: mode
    }, mode === "A3" ? 135000 : 60000, {
      windowsHide: mode !== "A3",
      timeoutMessage: mode === "A3"
        ? "O A3 não respondeu. Verifique o leitor, desbloqueie o token e informe o PIN na janela do Windows."
        : "A conexão direta do Windows excedeu 60 segundos. Verifique firewall ou antivírus e tente novamente."
    });
  } catch (error) {
    const raw = String(error.message || error);
    const detail = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").replace(/\s+No linha:.*$/i, "").replace(/\s+At line:.*$/i, "").trim().slice(0, 900);
    const exportDetail = installedExportFailure ? " A tentativa segura em memória também falhou: " + installedExportFailure : "";
    throw new Error((detail || "Falha ao acessar a SEFAZ com o certificado A1/A3 instalado.") + exportDetail);
  }
  let result;
  try { result = JSON.parse(output.trim()); }
  catch { throw new Error("Não foi possível interpretar a resposta da SEFAZ."); }
  const documents = Array.isArray(result.documents) ? result.documents : (result.documents ? [result.documents] : []);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  result.documents = [];
  for (const document of documents) {
    const safeNsu = String(document.nsu || "").replace(/\D/g, "").padStart(15, "0").slice(-15);
    const key = String(document.key || "").replace(/\D/g, "").slice(0, 44);
    const fileId = `${type.toLowerCase()}-${key || safeNsu}.xml`;
    const bytes = Buffer.from(String(document.xmlBase64 || ""), "base64");
    if (bytes.length) await writeFile(join(dataDir, fileId), bytes);
    result.documents.push({ nsu: safeNsu, schema: String(document.schema || ""), key, fileId });
  }
  return result;
}

async function exportInstalledCertificateToMemory(thumbprint, password) {
  const script = `$ErrorActionPreference = 'Stop'
$thumbprint = $env:DOCPRONTO_CERT_THUMBPRINT -replace '\\s', ''
$password = $env:DOCPRONTO_TRANSIENT_PASSWORD
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $cert = $store.Certificates | Where-Object { ($_.Thumbprint -replace '\\s', '') -eq $thumbprint } | Select-Object -First 1
  if (-not $cert) { throw 'Certificado instalado não encontrado.' }
  if (-not $cert.HasPrivateKey) { throw 'Certificado instalado sem chave privada.' }
  $bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
  [Convert]::ToBase64String($bytes)
} finally {
  $store.Close()
}`;
  const output = await runPowerShell(script, {
    DOCPRONTO_CERT_THUMBPRINT: thumbprint,
    DOCPRONTO_TRANSIENT_PASSWORD: password
  }, 20000, { timeoutMessage: "O Windows demorou demais para liberar o A1 instalado." });
  const encoded = output.trim();
  if (!encoded) throw new Error("O Windows não permitiu usar o A1 instalado em memória.");
  return encoded;
}

async function syncFiscalDocumentsA1({ pfxBase64, pfxPassword, cnpj, cuf, type, nsu }) {
  const encoded = String(pfxBase64 || "");
  const password = String(pfxPassword || "");
  if (!encoded || encoded.length > 8 * 1024 * 1024) throw new Error("Selecione um arquivo A1 .pfx ou .p12 válido.");
  const pfx = Buffer.from(encoded, "base64");
  if (!pfx.length || pfx.length > 6 * 1024 * 1024) throw new Error("O arquivo A1 está vazio ou é grande demais.");
  const isCte = type === "CTE";
  const endpoint = isCte ? "https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx" : "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";
  const serviceNs = isCte ? "http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe" : "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe";
  const fiscalNs = isCte ? "http://www.portalfiscal.inf.br/cte" : "http://www.portalfiscal.inf.br/nfe";
  const operation = isCte ? "cteDistDFeInteresse" : "nfeDistDFeInteresse";
  const messageElement = isCte ? "cteDadosMsg" : "nfeDadosMsg";
  const layoutVersion = isCte ? "1.00" : "1.01";
  const dist = '<distDFeInt xmlns="' + fiscalNs + '" versao="' + layoutVersion + '"><tpAmb>1</tpAmb><cUFAutor>' + cuf + '</cUFAutor><CNPJ>' + cnpj + '</CNPJ><distNSU><ultNSU>' + nsu + '</ultNSU></distNSU></distDFeInt>';
  const soap = '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><' + operation + ' xmlns="' + serviceNs + '"><' + messageElement + '>' + dist + '</' + messageElement + '></' + operation + '></soap12:Body></soap12:Envelope>';
  const responseText = await postSoapWithA1(endpoint, soap, serviceNs + "/" + operation, pfx, password);
  const result = parseDfeDistributionResponse(responseText, type, nsu);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  for (const document of result.documents) {
    const fileId = type.toLowerCase() + "-" + (document.key || document.nsu) + ".xml";
    await writeFile(join(dataDir, fileId), document.xml);
    document.fileId = fileId;
    delete document.xml;
  }
  return result;
}

function postSoapWithA1(endpoint, soap, action, pfx, passphrase) {
  return new Promise((resolveResponse, reject) => {
    const payload = Buffer.from(soap, "utf8");
    const request = httpsRequest(endpoint, {
      method: "POST",
      family: 4,
      pfx,
      passphrase,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      headers: {
        "Content-Type": 'application/soap+xml; charset=utf-8; action="' + action + '"',
        "Content-Length": payload.length,
        "Connection": "close"
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("A1/SEFAZ HTTP " + response.statusCode + ": " + body.replace(/\s+/g, " ").slice(0, 500)));
          return;
        }
        resolveResponse(body);
      });
    });
    request.setTimeout(60000, () => request.destroy(new Error("A consulta A1 à SEFAZ excedeu 60 segundos.")));
    request.on("error", error => reject(new Error("A1/SEFAZ: " + error.message)));
    request.end(payload);
  });
}

function parseDfeDistributionResponse(xml, type, fallbackNsu) {
  const value = tag => {
    const match = String(xml).match(new RegExp("<(?:\\w+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">", "i"));
    return match ? decodeXmlEntities(match[1].trim()) : "";
  };
  const documents = [];
  const regex = /<(?:(?:\w+):)?docZip\b([^>]*)>([\s\S]*?)<\/(?:(?:\w+):)?docZip>/gi;
  let match;
  while ((match = regex.exec(String(xml)))) {
    const attributes = match[1];
    const nsuMatch = attributes.match(/NSU=["'](\d+)["']/i);
    const schemaMatch = attributes.match(/schema=["']([^"']+)["']/i);
    const compressed = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    const documentXml = gunzipSync(compressed);
    const text = documentXml.toString("utf8");
    const keyMatch = text.match(/<ch(?:NFe|CTe)>(\d{44})<\/ch(?:NFe|CTe)>/i) || text.match(/Id=["'](?:NFe|CTe)(\d{44})["']/i);
    documents.push({
      nsu: String(nsuMatch ? nsuMatch[1] : "").padStart(15, "0").slice(-15),
      schema: schemaMatch ? schemaMatch[1] : "",
      key: keyMatch ? keyMatch[1] : "",
      xml: documentXml
    });
  }
  return {
    documentType: type,
    statusCode: value("cStat"),
    message: value("xMotivo"),
    lastNSU: value("ultNSU") || fallbackNsu,
    maxNSU: value("maxNSU") || fallbackNsu,
    documents
  };
}

function decodeXmlEntities(value) {
  return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function readStoredFiscalDocument({ fileId }) {
  const clean = String(fileId || "");
  if (!/^(nfe|cte)-[a-zA-Z0-9-]+\.xml$/.test(clean)) throw new Error("Documento fiscal inválido.");
  const dataDir = resolve(root, "data");
  const filePath = resolve(dataDir, clean);
  if (relative(dataDir, filePath).startsWith("..") || !existsSync(filePath)) throw new Error("XML não encontrado no agente local.");
  const content = await readFile(filePath);
  return { filename: clean, contentBase64: content.toString("base64") };
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

async function signPdfWithWindowsCertificate({ filename, thumbprint, contentBase64, signerName, placement }) {
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
    reason: "Assinado digitalmente pelo DocPronto",
    placement
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

function appendPdfSignaturePlaceholder(pdf, { signerName, reason, placement }) {
  const source = pdf.toString("latin1");
  const rootMatch = source.match(/1 0 obj\s*<<(.*?)>>\s*endobj/s);
  const pageMatches = [...source.matchAll(/(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*endobj/g)]
    .filter(match => /\/Type\s*\/Page\b/.test(match[2]) && !/\/Type\s*\/Pages\b/.test(match[2]));
  const pageIndex = Math.max(0, Math.min(pageMatches.length - 1, Number(placement?.page || 1) - 1));
  const pageMatch = pageMatches[pageIndex];
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
  const pageObject = Number(pageMatch[1]);
  const pageBody = addPdfDictionaryEntry(pageMatch[2], `/Annots[${widgetObj} 0 R]`);
  const rect = normalizeSignaturePlacement(placement);
  const appearanceWidth = Math.max(120, rect.width);
  const appearanceHeight = Math.max(42, rect.height);
  const now = pdfDate(new Date());
  const visibleText = [
    `Assinado de forma digital por`,
    cleanPdfText(signerName).slice(0, 54),
    `Dados: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} -03'00'`
  ];
  const appearanceStream = [
    "q",
    `1 1 1 rg 0 0 ${formatPdfNumber(appearanceWidth)} ${formatPdfNumber(appearanceHeight)} re f`,
    `0.1 0.1 0.1 RG 0.8 w 0 0 ${formatPdfNumber(appearanceWidth)} ${formatPdfNumber(appearanceHeight)} re S`,
    `BT /Helv 10 Tf 0 0 0 rg 10 ${formatPdfNumber(appearanceHeight - 24)} Td`,
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
    `${pageObject} 0 obj\n<<${pageBody}>>\nendobj\n`,
    `${acroFormObj} 0 obj\n<</Fields[${widgetObj} 0 R]/SigFlags 3>>\nendobj\n`,
    `${widgetObj} 0 obj\n<</Type/Annot/Subtype/Widget/FT/Sig/Rect[${formatPdfNumber(rect.x)} ${formatPdfNumber(rect.y)} ${formatPdfNumber(rect.x + rect.width)} ${formatPdfNumber(rect.y + rect.height)}]/T(Signature1)/V ${signatureObj} 0 R/P ${pageObject} 0 R/F 132/AP<</N ${appearanceObj} 0 R>>>>\nendobj\n`,
    `${signatureObj} 0 obj\n<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/adbe.pkcs7.detached/ByteRange ${byteRangePlaceholder}/Contents <${"0".repeat(placeholderHexLength)}>/Reason(${escapePdfString(reason)})/M(${now})/Name(${escapePdfString(cleanPdfText(signerName))})>>\nendobj\n`,
    `${appearanceObj} 0 obj\n<</Type/XObject/Subtype/Form/BBox[0 0 ${formatPdfNumber(appearanceWidth)} ${formatPdfNumber(appearanceHeight)}]/Resources<</Font<</Helv ${fontObj} 0 R>>>>/Length ${Buffer.byteLength(appearanceStream, "latin1")}>>\nstream\n${appearanceStream}\nendstream\nendobj\n`,
    `${fontObj} 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n`
  ];

  const offsets = new Map();
  let incremental = "\n";
  let cursor = pdf.length + Buffer.byteLength(incremental, "latin1");
  const objectNumbers = [1, pageObject, acroFormObj, widgetObj, signatureObj, appearanceObj, fontObj];
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

function normalizeSignaturePlacement(placement) {
  const x = Number(placement?.x);
  const y = Number(placement?.y);
  const width = Number(placement?.width);
  const height = Number(placement?.height);
  return {
    x: Number.isFinite(x) ? Math.max(0, x) : 300,
    y: Number.isFinite(y) ? Math.max(0, y) : 92,
    width: Number.isFinite(width) ? Math.min(460, Math.max(120, width)) : 290,
    height: Number.isFinite(height) ? Math.min(180, Math.max(42, height)) : 78
  };
}

function formatPdfNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
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

function runPowerShell(script, env = {}, timeoutMs = 30000, options = {}) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: options.windowsHide !== false,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(options.timeoutMessage || "Operacao local demorou demais e foi cancelada."));
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
