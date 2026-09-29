import { spawn, execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const UI_TIMEOUT_MS = 3_500;
export const UI_HARD_TIMEOUT_MS = 6_000;
export const HEALTH_TIMEOUT_MS = 15_000;
export const OPTIONAL_CAPABILITY_TIMEOUT_MS = 45_000;
export const PREPARATION_LAUNCHES = 2;
export const LAB_OFFICIAL_SAMPLES = 3;
export const STABLE_OFFICIAL_SAMPLES = 3;
export const REQUIRED_EVENTS = Object.freeze([
  "service-ready",
  "window-painted",
  "certificate-capability",
  "word-capability",
  "second-instance",
  "stopping",
]);

const execFileAsync = promisify(execFile);
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function smokeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function preservePrimarySmokeError(primaryError, cleanupFailures = []) {
  if (cleanupFailures.length === 0) return primaryError;
  const cleanupFailure = Object.assign(
    new AggregateError(cleanupFailures, "Smoke cleanup did not complete."),
    { code: "SMOKE_CLEANUP_FAILED" },
  );
  if (!primaryError) return cleanupFailure;
  primaryError.cleanupFailure = cleanupFailure;
  primaryError.message += ` Cleanup failures: ${cleanupFailures.map(error => error?.code ?? error?.message ?? "unknown").join(", ")}.`;
  return primaryError;
}

export function assertLaunchDuration(launchElapsedMs) {
  if (!Number.isFinite(launchElapsedMs) || launchElapsedMs > UI_TIMEOUT_MS) {
    throw smokeError("SMOKE_UI_SLOW", `A visible window painted after ${launchElapsedMs} ms from spawn.`);
  }
}

export function assertLaunchSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 3 || samples.some(value => !Number.isFinite(value))) {
    throw smokeError("SMOKE_UI_SAMPLE_INVALID", "At least three valid launch samples are required.");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const median = ordered[Math.floor(ordered.length / 2)];
  const maximum = ordered.at(-1);
  if (maximum > UI_HARD_TIMEOUT_MS) {
    throw smokeError("SMOKE_UI_HARD_LIMIT", `A visible window exceeded the ${UI_HARD_TIMEOUT_MS} ms hard limit (${maximum} ms).`);
  }
  assertLaunchDuration(median);
  return { median, maximum };
}

export function acceptsCertificateCapability(event) {
  if (event?.capability !== "certificate") return false;
  if (event.status === "available") return Number.isInteger(event.count) && event.count >= 0;
  if (event.status === "unavailable") return event.code === "CERTIFICATE_PROVIDER_UNAVAILABLE";
  return event.status === "error" && event.code === "LOCAL_OPERATION_TIMEOUT";
}

export function acceptsWordCapability(event) {
  if (event?.capability !== "word") return false;
  if (event.status === "available") return typeof event.version === "string" && event.version.length > 0;
  const unavailableCode = ["WORD", "UNAVAILABLE"].join("_");
  if (event.status === "unavailable") return event.code === unavailableCode;
  return event.status === "error" && event.code === "LOCAL_OPERATION_TIMEOUT";
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

async function cleanupSmokeRun({ children, port, imageName, baselinePids, temporaryDirectory }) {
  const failures = [];
  for (const child of children.filter(Boolean)) {
    try {
      if (child.exitCode === null) await terminateTree(child.pid);
      await waitForExit(child, 5_000);
    } catch (error) {
      failures.push(error);
    }
  }
  if (port) {
    try { await waitForPortRelease(port); } catch (error) { failures.push(error); }
  }
  try {
    const finalPids = await processIdsForImage(imageName);
    const leaked = [...finalPids].filter(pid => !baselinePids.has(pid));
    if (leaked.length > 0) {
      failures.push(smokeError("SMOKE_PROCESS_LEAK", `Processes remained: ${leaked.join(", ")}.`));
    }
  } catch (error) {
    failures.push(error);
  }
  try { await rm(temporaryDirectory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  return failures;
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

async function warmPackagedExecutable(executable, imageName, baselinePids) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "docpronto-smoke-warmup-"));
  const reportPath = join(temporaryDirectory, "events.jsonl");
  const controlPath = join(temporaryDirectory, "control.txt");
  const startedAt = Date.now();
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    env: {
      ...process.env,
      DOCPRONTO_SMOKE: "1",
      DOCPRONTO_SMOKE_REPORT: reportPath,
      DOCPRONTO_SMOKE_CONTROL: controlPath,
      DOCPRONTO_SMOKE_WARMUP: "1",
    },
    shell: false,
    stdio: "ignore",
  });
  let port;
  let primaryError;
  let elapsed;
  try {
    const service = await waitForEvent(reportPath, event => event.type === "service-ready", 30_000, "SMOKE_WARMUP_TIMEOUT");
    port = Number(new URL(service.origin).port);
    const painted = await waitForEvent(reportPath, event => event.type === "window-painted", 30_000, "SMOKE_WARMUP_TIMEOUT");
    await writeFile(controlPath, "quit", "utf8");
    await waitForEvent(reportPath, event => event.type === "stopping", 5_000, "SMOKE_WARMUP_STOP_TIMEOUT");
    await waitForExit(child, 15_000);
    await waitForPortRelease(port);
    elapsed = Date.parse(painted.timestamp) - startedAt;
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = await cleanupSmokeRun({
    children: [child], port, imageName, baselinePids, temporaryDirectory,
  });
  if (primaryError || cleanupFailures.length) throw preservePrimarySmokeError(primaryError, cleanupFailures);
  return elapsed;
}

export async function runPackagedSmoke({
  executable = join(projectDir, "release", "lab", "win-unpacked", "DOCPronto Laboratorio.exe"),
  expectedChannel = "lab",
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
  const warmupElapsedMs = [];
  for (let launch = 0; launch < PREPARATION_LAUNCHES; launch += 1) {
    warmupElapsedMs.push(await warmPackagedExecutable(executable, imageName, baselinePids));
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "docpronto-smoke-"));
  const reportPath = join(temporaryDirectory, "events.jsonl");
  const controlPath = join(temporaryDirectory, "control.txt");

  const environment = {
    ...process.env,
    DOCPRONTO_SMOKE: "1",
    DOCPRONTO_SMOKE_REPORT: reportPath,
    DOCPRONTO_SMOKE_CONTROL: controlPath,
  };
  let first;
  let second;
  let servicePort;
  let primaryError;
  let result;
  try {
    const startedAt = Date.now();
    first = spawn(executable, [], {
      cwd: dirname(executable), env: environment, shell: false, stdio: "ignore",
    });
    first.once("error", () => {});

    const service = await waitForEvent(reportPath, event => event.type === "service-ready", HEALTH_TIMEOUT_MS, "SMOKE_HEALTH_TIMEOUT");
    servicePort = Number(new URL(service.origin).port);
    const healthRemainingMs = HEALTH_TIMEOUT_MS - (Date.now() - startedAt);
    if (healthRemainingMs <= 0) throw smokeError("SMOKE_HEALTH_TIMEOUT", "Health was not ready within 15000 ms.");
    const healthResponse = await fetch(`${service.origin}/api/health`, {
      headers: { "x-docpronto-token": service.sessionToken },
      signal: AbortSignal.timeout(healthRemainingMs),
    });
    if (!healthResponse.ok) throw smokeError("SMOKE_HEALTH_FAILED", `Health returned HTTP ${healthResponse.status}.`);
    const health = await healthResponse.json();
    if (health.channel !== expectedChannel || health.version !== service.version) {
      throw smokeError("SMOKE_IDENTITY_MISMATCH", `Health metadata does not match the ${expectedChannel} executable.`);
    }

    const painted = await waitForEvent(reportPath, event => event.type === "window-painted", HEALTH_TIMEOUT_MS, "SMOKE_UI_TIMEOUT");
    const launchElapsedMs = Date.parse(painted.timestamp) - startedAt;

    const certificate = await waitForEvent(reportPath, event => event.type === "certificate-capability", OPTIONAL_CAPABILITY_TIMEOUT_MS, "SMOKE_CERTIFICATE_RESULT_MISSING");
    if (first.exitCode !== null || !acceptsCertificateCapability(certificate)) {
      throw smokeError("SMOKE_OPTIONAL_CAPABILITY_CRASH", "The real certificate provider affected the main window.");
    }
    const word = await waitForEvent(reportPath, event => event.type === "word-capability", OPTIONAL_CAPABILITY_TIMEOUT_MS, "SMOKE_WORD_RESULT_MISSING");
    if (first.exitCode !== null || !acceptsWordCapability(word)) {
      throw smokeError("SMOKE_OPTIONAL_CAPABILITY_CRASH", "The real Word capability returned an unexpected result.");
    }

    second = spawn(executable, [], {
      cwd: dirname(executable), env: environment, shell: false, stdio: "ignore",
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
    if (firstExit.code !== 0) throw smokeError("SMOKE_EXIT_FAILED", `${expectedChannel} exited with code ${firstExit.code}.`);
    await waitForPortRelease(servicePort);
    await new Promise(resolveWait => setTimeout(resolveWait, 500));

    const finalPids = await processIdsForImage(imageName);
    const leaked = [...finalPids].filter(pid => !baselinePids.has(pid));
    if (leaked.length > 0) throw smokeError("SMOKE_PROCESS_LEAK", `Processes remained: ${leaked.join(", ")}.`);

    result = {
      executable,
      channel: health.channel,
      version: health.version,
      port: servicePort,
      uiElapsedMs: launchElapsedMs,
      launchElapsedMs,
      warmupElapsedMs,
      events: REQUIRED_EVENTS,
    };
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = await cleanupSmokeRun({
    children: [second, first], port: servicePort, imageName, baselinePids, temporaryDirectory,
  });
  if (primaryError || cleanupFailures.length) throw preservePrimarySmokeError(primaryError, cleanupFailures);
  return result;
}

export async function runPackagedSmokes({ root = projectDir } = {}) {
  const targets = [
    {
      expectedChannel: "lab",
      executable: join(root, "release", "lab", "win-unpacked", "DOCPronto Laboratorio.exe"),
      samples: LAB_OFFICIAL_SAMPLES,
    },
    {
      expectedChannel: "stable",
      executable: join(root, "release", "stable", "win-unpacked", "DOCPronto.exe"),
      samples: STABLE_OFFICIAL_SAMPLES,
    },
  ];
  const results = [];
  for (const target of targets) {
    const targetResults = [];
    for (let sample = 1; sample <= target.samples; sample += 1) {
      const result = { ...await runPackagedSmoke(target), sample, samples: target.samples };
      targetResults.push(result);
      results.push(result);
    }
    assertLaunchSamples(targetResults.map(result => result.launchElapsedMs));
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await runPackagedSmokes();
  for (const result of results) {
    console.log(`Desktop smoke passed: ${result.channel} ${result.version}, official sample ${result.sample}/${result.samples}, painted window ${result.launchElapsedMs} ms from measured spawn (preparations ${result.warmupElapsedMs.join(", ")} ms), port ${result.port}.`);
  }
}
