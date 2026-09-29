import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require("@electron/asar");

const FORBIDDEN_SEGMENTS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "doc", "docs",
  "example", "examples", "benchmark", "benchmarks",
  "fixture", "fixtures", "downloads",
]);

const ALLOWED_ARCHIVE_ROOTS = Object.freeze([
  "/desktop/",
  "/public/docpronto/",
  "/node_modules/",
]);
const ALLOWED_ARCHIVE_DIRECTORIES = new Set(["/desktop", "/public", "/public/docpronto", "/node_modules"]);
const TEXT_FILE = /\.(?:cjs|css|html|js|json|mjs|txt|xml|yml|yaml)$/i;
const PERSONAL_CONTENT = /(?:[a-z]:[\\/]users[\\/]|\/users\/[^/]+\/|\/home\/[^/]+\/|[\\/]downloads[\\/])/i;
const ELECTRON_LICENSE_FILES = new Set(["LICENSE.electron.txt", "LICENSES.chromium.html"]);
const ALLOWED_EXTERNAL_ROOT_FILES = new Set([
  "chrome_100_percent.pak", "chrome_200_percent.pak", "d3dcompiler_47.dll",
  "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat", "LICENSE.electron.txt",
  "LICENSES.chromium.html", "resources.pak", "snapshot_blob.bin", "v8_context_snapshot.bin",
  "vk_swiftshader_icd.json", "vk_swiftshader.dll", "vulkan-1.dll",
  "DOCPronto.exe", "DOCPronto Laboratorio.exe",
]);
const ALLOWED_RESOURCE_FILES = new Set([
  "resources/app.asar", "resources/app-update.yml", "resources/elevate.exe",
]);

async function listFiles(directory, prefix = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

function isForbiddenArchiveFile(file) {
  const normalized = file.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const name = basename(lower);
  if (segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))) return true;
  if (/^\.env(?:\.|$)/.test(name) || /\.(?:log|bak|backup)$/.test(name)) return true;
  if (segments.includes("users") || segments.includes("appdata") || segments.includes("financeiro")) return true;
  if (/\.(?:map|d\.ts)$/.test(name)) return true;
  if (/(?:^|[._-])(?:test|spec)\.(?:js|cjs|mjs|ts|tsx)$/.test(name)) return true;
  if (/^(?:readme|changelog|changes|contributing|governance)(?:\.|$)/.test(name)) return true;
  if (/^(?:sponsors\.md|\.codeclimate\.yml|\.editorconfig|\.eslintrc(?:\..+)?|\.jekyll-metadata|tsconfig\.json|graph\.svg|makefile|component\.json)$/.test(name)) return true;
  return false;
}

export function classifyArchiveEntries(entries) {
  const normalized = entries.map(file => file.replaceAll("\\", "/"));
  return {
    forbiddenFiles: normalized.filter(isForbiddenArchiveFile),
    outsideAllowlist: normalized.filter(file => (
      file !== "/package.json"
      && !ALLOWED_ARCHIVE_DIRECTORIES.has(file)
      && !ALLOWED_ARCHIVE_ROOTS.some(prefix => file.startsWith(prefix))
    )),
  };
}

export function classifyExternalEntries(entries) {
  const normalized = entries.map(file => file.replaceAll("\\", "/"));
  const isAllowed = file => (
    ALLOWED_EXTERNAL_ROOT_FILES.has(file)
    || ALLOWED_RESOURCE_FILES.has(file)
    || /^locales\/[a-z]{2,3}(?:-[A-Z]{2}|-\d{3})?\.pak$/.test(file)
  );
  return { forbiddenExternalFiles: normalized.filter(file => !isAllowed(file)) };
}

function scanSensitiveContent(archive, archiveFiles) {
  const findings = [];
  for (const file of archiveFiles) {
    if (!TEXT_FILE.test(file)) continue;
    let content;
    try {
      content = extractFile(archive, file.replace(/^\/+/, "")).toString("utf8");
    } catch {
      continue;
    }
    if (PERSONAL_CONTENT.test(content)) findings.push(file);
  }
  return findings;
}

async function scanSensitiveExternalContent(packageDirectory, externalFiles) {
  const findings = [];
  for (const file of externalFiles) {
    if (!TEXT_FILE.test(file) || file === "resources/app.asar" || ELECTRON_LICENSE_FILES.has(file)) continue;
    let content;
    try {
      content = await readFile(join(packageDirectory, ...file.split("/")), "utf8");
    } catch {
      continue;
    }
    if (PERSONAL_CONTENT.test(content)) findings.push(file);
  }
  return findings;
}

export async function inspectPackagedOutput(packageDirectory, {
  expectedChannel,
  expectedProductName,
} = {}) {
  if (typeof packageDirectory !== "string" || !packageDirectory) {
    throw new TypeError("packageDirectory is required.");
  }
  const resourcesDirectory = join(packageDirectory, "resources");
  const archive = join(resourcesDirectory, "app.asar");
  const archiveStats = await stat(archive);
  if (!archiveStats.isFile()) throw new Error("Packaged app.asar was not produced.");
  const archiveFiles = listPackage(archive).map(file => file.replaceAll("\\", "/"));
  const externalFiles = await listFiles(packageDirectory);
  const unpackedFiles = await listFiles(join(resourcesDirectory, "app.asar.unpacked"));
  const classification = classifyArchiveEntries(archiveFiles);
  const externalClassification = classifyExternalEntries(externalFiles);
  const packageMetadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  let appUpdate = "";
  try {
    appUpdate = await readFile(join(resourcesDirectory, "app-update.yml"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const identityErrors = [];
  if (expectedChannel && packageMetadata.docprontoChannel !== expectedChannel) {
    identityErrors.push(`Expected channel ${expectedChannel}, received ${packageMetadata.docprontoChannel}.`);
  }
  if (expectedProductName && packageMetadata.productName !== expectedProductName) {
    identityErrors.push(`Expected product ${expectedProductName}, received ${packageMetadata.productName}.`);
  }
  if (expectedChannel === "stable") {
    if (/laborat[oó]rio|docpronto-laboratorio|channel:\s*lab\b/i.test(JSON.stringify(packageMetadata))) {
      identityErrors.push("Stable package metadata contains LAB identity.");
    }
    if (/channel:\s*lab\b/i.test(appUpdate)) identityErrors.push("Stable update metadata points to LAB.");
  }
  return {
    archiveFiles,
    externalFiles,
    unpackedFiles,
    ...classification,
    ...externalClassification,
    sensitiveContentFiles: scanSensitiveContent(archive, archiveFiles),
    sensitiveExternalContentFiles: await scanSensitiveExternalContent(packageDirectory, externalFiles),
    packageMetadata,
    appUpdate,
    identityErrors,
  };
}
