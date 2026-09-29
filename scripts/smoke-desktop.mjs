import { spawn, execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const UI_TIMEOUT_MS = 3_000;
export const HEALTH_TIMEOUT_MS = 15_000;
export const REQUIRED_EVENTS = Object.freeze([
  "service-ready",
  "ui-ready",
  "optional-capability-failed",
  "second-instance",
  "stopping",
]);

const execFileAsync = promisify(execFile);
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function smokeError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function eventsFrom(reportPath) {
  try {
    return (await readFile(reportPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForEvent(reportPath, predicate, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = (await eventsFrom(reportPath)).find(predicate);
    if (found) return found;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  throw smokeError(code, `Smoke event was not observed within ${timeoutMs} ms.`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(smokeError("SMOKE_PROCESS_TIMEOUT", `Process ${child.pid} did not exit.`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function processIdsForImage(imageName) {
  const { stdout } = await execFileAsync("tasklist.exe", [
    "/FO", "CSV", "/NH", "/FI", `IMAGENAME eq ${imageName}`,
  ], { windowsHide: true });
  return new Set(stdout.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^"[^"]+","(\d+)"/);
    return match ? [Number(match[1])] : [];
  }));
}

async function waitForPortRelease(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const open = await new Promise(resolveProbe => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
      socket.once("timeout", () => { socket.destroy(); resolveProbe(false); });
      socket.once("error", () => resolveProbe(false));
    });
    if (!open) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw smokeError("SMOKE_PORT_LEAK", `Local service port ${port} remained open.`);
}

async function terminateTree(pid) {
  if (!pid) return;
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch {
    // Cleanup is best-effort after a failed smoke assertion.
  }
}

async function preflightPackagedFiles(executable) {
  const files = [executable, join(dirname(executable), "resources", "app.asar")];
  for (const file of files) {
    await access(file, constants.R_OK);
    for await (const chunk of createReadStream(file)) {
      // Sequential read lets Windows finish file inspection before timing startup.
      void chunk;
    }
  }
}

export async function runPackagedSmoke({
  executable = join(projectDir, "release", "lab", "win-unpacked", "DOCPronto Laboratorio.exe"),
} = {}) {
  if (process.platform !== "win32") {
    throw smokeError("SMOKE_WINDOWS_REQUIRED", "The packaged desktop smoke test requires Windows.");
  }
  await access(executable, constants.X_OK);
  await preflightPackagedFiles(executable);
  const imageName = basename(executable);
  const baselinePids = await processIdsForImage(imageName);
  if (baselinePids.size > 0) {
    throw smokeError("SMOKE_APP_ALREADY_RUNNING", `${imageName} is already running.`);
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "docpronto-smoke-"));
  const reportPath = join(temporaryDirectory, "events.jsonl");
  const controlPath = join(temporaryDirectory, "control.txt");

  const startedAt = Date.now();
  const environment = {
    ...process.env,
    DOCPRONTO_SMOKE: "1",
    DOCPRONTO_SMOKE_REPORT: reportPath,
    DOCPRONTO_SMOKE_CONTROL: controlPath,
    DOCPRONTO_SMOKE_MISSING_OPTIONALS: "1",
  };
  let first;
  let second;
  try {
    first = spawn(executable, ["--disable-gpu"], {
      cwd: dirname(executable), env: environment, shell: false, stdio: "ignore", windowsHide: true,
    });
    first.once("error", () => {});

    const service = await waitForEvent(reportPath, event => event.type === "service-ready", HEALTH_TIMEOUT_MS, "SMOKE_HEALTH_TIMEOUT");
    const healthRemainingMs = HEALTH_TIMEOUT_MS - (Date.now() - startedAt);
    if (healthRemainingMs <= 0) throw smokeError("SMOKE_HEALTH_TIMEOUT", "Health was not ready within 15000 ms.");
    const healthResponse = await fetch(`${service.origin}/api/health`, {
      headers: { "x-docpronto-token": service.sessionToken },
      signal: AbortSignal.timeout(healthRemainingMs),
    });
    if (!healthResponse.ok) throw smokeError("SMOKE_HEALTH_FAILED", `Health returned HTTP ${healthResponse.status}.`);
    const health = await healthResponse.json();
    if (health.channel !== "lab" || health.version !== service.version) {
      throw smokeError("SMOKE_IDENTITY_MISMATCH", "Health metadata does not match the LAB executable.");
    }

    const ui = await waitForEvent(reportPath, event => event.type === "ui-ready", HEALTH_TIMEOUT_MS, "SMOKE_UI_TIMEOUT");
    const launchElapsedMs = Date.parse(ui.timestamp) - startedAt;
    const uiElapsedMs = ui.uptimeMs;
    if (!Number.isFinite(uiElapsedMs) || uiElapsedMs > UI_TIMEOUT_MS) {
      throw smokeError("SMOKE_UI_SLOW", `UI became ready after ${uiElapsedMs} ms of process runtime.`);
    }

    const word = await waitForEvent(reportPath, event => event.code === "WORD_UNAVAILABLE", 2_000, "SMOKE_WORD_RESULT_MISSING");
    const certificate = await waitForEvent(reportPath, event => event.code === "CERTIFICATE_NOT_FOUND", 2_000, "SMOKE_CERTIFICATE_RESULT_MISSING");
    if (first.exitCode !== null || word.capability !== "word" || certificate.capability !== "certificate") {
      throw smokeError("SMOKE_OPTIONAL_CAPABILITY_CRASH", "Missing optional capabilities affected the main window.");
    }

    second = spawn(executable, ["--disable-gpu"], {
      cwd: dirname(executable), env: environment, shell: false, stdio: "ignore", windowsHide: true,
    });
    const secondInstance = await waitForEvent(reportPath, event => (
      event.type === "second-instance" && event.pid === first.pid
    ), 5_000, "SMOKE_SECOND_INSTANCE_TIMEOUT");
    const secondExit = await waitForExit(second, 5_000);
    if (secondExit.code !== 0 || secondInstance.pid !== first.pid) {
      throw smokeError("SMOKE_SECOND_INSTANCE_FAILED", "Second instance was not reused cleanly.");
    }

    await writeFile(controlPath, "quit", "utf8");
    await waitForEvent(reportPath, event => event.type === "stopping", 5_000, "SMOKE_STOP_EVENT_MISSING");
    const firstExit = await waitForExit(first, 10_000);
    if (firstExit.code !== 0) throw smokeError("SMOKE_EXIT_FAILED", `LAB exited with code ${firstExit.code}.`);
    await waitForPortRelease(new URL(service.origin).port);
    await new Promise(resolveWait => setTimeout(resolveWait, 500));

    const finalPids = await processIdsForImage(imageName);
    const leaked = [...finalPids].filter(pid => !baselinePids.has(pid));
    if (leaked.length > 0) throw smokeError("SMOKE_PROCESS_LEAK", `Processes remained: ${leaked.join(", ")}.`);

    return {
      executable,
      channel: health.channel,
      version: health.version,
      port: Number(new URL(service.origin).port),
      uiElapsedMs,
      launchElapsedMs,
      events: REQUIRED_EVENTS,
    };
  } finally {
    if (second && second.exitCode === null) await terminateTree(second.pid);
    if (first && first.exitCode === null) await terminateTree(first.pid);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPackagedSmoke();
  console.log(`Desktop smoke passed: ${result.channel} ${result.version}, UI ${result.uiElapsedMs} ms process runtime (${result.launchElapsedMs} ms from spawn), port ${result.port}.`);
}
