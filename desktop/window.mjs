function sameOrigin(target, origin) {
  try {
    return new URL(target).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(target) {
  try {
    return new URL(target).protocol === "https:";
  } catch {
    return false;
  }
}

function openExternal(shell, target) {
  try {
    void Promise.resolve(shell.openExternal(target)).catch(() => {});
  } catch {
    // External navigation remains blocked even when the system shell fails.
  }
}

export function createMainWindow({ BrowserWindow, origin, preloadPath, channelConfig, shell }) {
  if (typeof origin !== "string" || !origin) throw new TypeError("origin is required.");
  if (typeof preloadPath !== "string" || !preloadPath) throw new TypeError("preloadPath is required.");

  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f5f3eb",
    title: channelConfig.productName,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: preloadPath,
    },
  });

  BrowserWindow.setMenu?.(null);
  window.setMenu?.(null);
  window.removeMenu?.();

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) openExternal(shell, url);
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) openExternal(shell, url);
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);

  const loadPromise = Promise.resolve()
    .then(() => window.loadURL(`${origin}/`))
    .catch(cause => {
      window.destroy?.();
      throw Object.assign(new Error("Nao foi possivel carregar a interface local do DOCPronto."), {
        code: "DESKTOP_WINDOW_LOAD_FAILED",
        cause,
      });
    });
  Object.defineProperty(window, "docprontoLoadPromise", {
    configurable: false,
    enumerable: false,
    value: loadPromise,
    writable: false,
  });
  return window;
}
