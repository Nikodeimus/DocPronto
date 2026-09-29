import { redactDiagnosticValue } from "../diagnostics/redact.mjs";

const INTEGRITY_ERROR_PATTERN = /checksum|hash|sha(?:256|512)|signature|publisher|code.?sign|integrity/i;

function technicalDetails(error) {
  return redactDiagnosticValue({
    name: error?.name,
    code: error?.code,
    message: error?.message,
  });
}

function prereleaseIdentifiers(version) {
  if (typeof version !== "string") return [];
  const separator = version.indexOf("-");
  if (separator < 0) return [];
  return version.slice(separator + 1).split(/[.+-]/).filter(Boolean);
}

function belongsToChannel(updateInfo, expectedChannel) {
  const version = updateInfo?.version;
  if (typeof version !== "string" || !version) return false;
  const declaredChannel = updateInfo?.channel;
  if (declaredChannel && declaredChannel !== expectedChannel) return false;
  const prerelease = prereleaseIdentifiers(version);
  if (expectedChannel === "lab") return prerelease.includes("lab");
  return expectedChannel === "latest" && prerelease.length === 0;
}

function integrityFailure(error) {
  return INTEGRITY_ERROR_PATTERN.test(`${error?.code ?? ""} ${error?.message ?? ""}`);
}

export function createUpdateManager({ autoUpdater, channelConfig, diagnostics, appVersion } = {}) {
  if (!autoUpdater || typeof autoUpdater.checkForUpdates !== "function") {
    throw new TypeError("autoUpdater is required.");
  }
  if (!channelConfig?.updateChannel) throw new TypeError("channelConfig is required.");
  if (!diagnostics || typeof diagnostics.append !== "function") {
    throw new TypeError("diagnostics.append is required.");
  }

  const listeners = new Map();
  let acceptedUpdate = null;
  let downloaded = false;
  let disposed = false;
  let startPromise;

  async function record(event) {
    try {
      await diagnostics.append(redactDiagnosticValue({
        tool: "desktop-updater",
        stage: "update",
        ...event,
        metadata: {
          appVersion,
          updateChannel: channelConfig.updateChannel,
          ...(event.metadata ?? {}),
        },
      }));
    } catch {
      // Update diagnostics are best-effort and never affect application use.
    }
  }

  function listen(name, listener) {
    listeners.set(name, listener);
    autoUpdater.on(name, listener);
  }

  function rejectWrongChannel(updateInfo) {
    acceptedUpdate = null;
    void record({
      level: "warning",
      code: "UPDATE_CHANNEL_REJECTED",
      message: "Uma atualizacao de outro canal foi ignorada.",
      metadata: { candidateVersion: updateInfo?.version ?? "unknown" },
    });
  }

  function consider(updateInfo) {
    if (!belongsToChannel(updateInfo, channelConfig.updateChannel)) {
      rejectWrongChannel(updateInfo);
      return false;
    }
    acceptedUpdate = updateInfo;
    return true;
  }

  function attachListeners() {
    listen("update-available", updateInfo => { consider(updateInfo); });
    listen("update-not-available", () => {
      void record({ level: "info", code: "UPDATE_NOT_AVAILABLE", message: "O aplicativo esta atualizado." });
    });
    listen("download-progress", progress => {
      void record({
        level: "debug",
        code: "UPDATE_DOWNLOAD_PROGRESS",
        message: "Download da atualizacao em andamento.",
        metadata: { percent: Number.isFinite(progress?.percent) ? progress.percent : null },
      });
    });
    listen("update-downloaded", updateInfo => {
      if (!consider(updateInfo)) return;
      downloaded = true;
      void record({
        level: "info",
        code: "UPDATE_READY",
        message: "A atualizacao esta pronta para ser instalada ao fechar o aplicativo.",
        metadata: { candidateVersion: updateInfo.version },
      });
    });
    listen("error", error => {
      void record({
        level: integrityFailure(error) ? "error" : "warning",
        code: integrityFailure(error) ? "UPDATE_INTEGRITY_FAILED" : "UPDATE_CHECK_UNAVAILABLE",
        message: integrityFailure(error)
          ? "A atualizacao foi rejeitada porque sua integridade nao pode ser confirmada."
          : "Nao foi possivel consultar atualizacoes agora.",
        technical: technicalDetails(error),
      });
    });
  }

  async function startOnce() {
    if (disposed) return false;
    autoUpdater.channel = channelConfig.updateChannel;
    autoUpdater.allowPrerelease = channelConfig.updateChannel === "lab";
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    attachListeners();
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo) consider(result.updateInfo);
      return true;
    } catch (error) {
      await record({
        level: "warning",
        code: integrityFailure(error) ? "UPDATE_INTEGRITY_FAILED" : "UPDATE_CHECK_UNAVAILABLE",
        message: integrityFailure(error)
          ? "A atualizacao foi rejeitada porque sua integridade nao pode ser confirmada."
          : "Nao foi possivel consultar atualizacoes agora.",
        technical: technicalDetails(error),
      });
      return false;
    }
  }

  return Object.freeze({
    start() {
      if (!startPromise) startPromise = startOnce();
      return startPromise;
    },
    async download() {
      if (disposed || !acceptedUpdate) return false;
      try {
        await autoUpdater.downloadUpdate();
        return true;
      } catch (error) {
        await record({
          level: integrityFailure(error) ? "error" : "warning",
          code: integrityFailure(error) ? "UPDATE_INTEGRITY_FAILED" : "UPDATE_DOWNLOAD_FAILED",
          message: integrityFailure(error)
            ? "A atualizacao foi rejeitada porque sua integridade nao pode ser confirmada."
            : "O download da atualizacao nao foi concluido.",
          technical: technicalDetails(error),
        });
        return false;
      }
    },
    installOnQuit() {
      if (disposed || !downloaded) return false;
      autoUpdater.autoInstallOnAppQuit = true;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [name, listener] of listeners) autoUpdater.removeListener(name, listener);
      listeners.clear();
    },
  });
}

export const updateManagerInternals = Object.freeze({ belongsToChannel, integrityFailure });
