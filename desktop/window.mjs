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
      preload: preloadPath,
    },
  });

  BrowserWindow.setMenu?.(null);
  window.setMenu?.(null);
  window.removeMenu?.();

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void Promise.resolve(shell.openExternal(url)).catch(() => {});
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });

  void window.loadURL(`${origin}/`);
  return window;
}
