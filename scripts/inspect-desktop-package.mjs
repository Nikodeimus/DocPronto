import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const { listPackage } = require("@electron/asar");

const FORBIDDEN_SEGMENTS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "doc", "docs",
  "example", "examples", "benchmark", "benchmarks",
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
  if (/\.(?:map|d\.ts)$/.test(name)) return true;
  if (/(?:^|[._-])(?:test|spec)\.(?:js|cjs|mjs|ts|tsx)$/.test(name)) return true;
  if (/^(?:readme|changelog|changes|contributing|governance)(?:\.|$)/.test(name)) return true;
  if (/^(?:sponsors\.md|\.codeclimate\.yml|\.editorconfig|\.eslintrc(?:\..+)?|\.jekyll-metadata|tsconfig\.json|graph\.svg|makefile|component\.json)$/.test(name)) return true;
  return false;
}

export async function inspectPackagedOutput(resourcesDirectory) {
  if (typeof resourcesDirectory !== "string" || !resourcesDirectory) {
    throw new TypeError("resourcesDirectory is required.");
  }
  const archive = join(resourcesDirectory, "app.asar");
  const archiveStats = await stat(archive);
  if (!archiveStats.isFile()) throw new Error("Packaged app.asar was not produced.");
  const archiveFiles = listPackage(archive).map(file => file.replaceAll("\\", "/"));
  const unpackedFiles = await listFiles(join(resourcesDirectory, "app.asar.unpacked"));
  return {
    archiveFiles,
    unpackedFiles,
    forbiddenFiles: archiveFiles.filter(isForbiddenArchiveFile),
  };
}
