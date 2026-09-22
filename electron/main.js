import { app, BrowserWindow, shell, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The desktop app IS the live corporate portal — so it always matches the web
// app and every web deploy reflects instantly on every user's PC. Override the
// target with PORTAL_URL (e.g. a staging URL or http://localhost:3000/en/corporate).
const PORTAL_URL = process.env.PORTAL_URL || "https://www.flighterz.com/en/corporate";
const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;

// How long to wait for the update feed before starting anyway (offline/slow).
const UPDATE_TIMEOUT_MS = 9000;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0D2138",
    title: "Flighterz Business",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Branded splash while we check for updates and reach the portal.
  win.loadFile(path.join(__dirname, "loading.html"));

  // Open links to other sites in the OS browser; keep the portal in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && new URL(url).origin !== PORTAL_ORIGIN) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:\/\//.test(url) && new URL(url).origin !== PORTAL_ORIGIN) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // If the portal can't be reached, show the offline screen (retry via preload).
  win.webContents.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
    if (isMainFrame && failedUrl.startsWith(PORTAL_ORIGIN) && code !== -3 /* aborted */) {
      win.loadFile(path.join(__dirname, "offline.html"));
    }
  });
}

function setStatus(text) {
  win?.webContents.executeJavaScript(`window.__setStatus && window.__setStatus(${JSON.stringify(text)})`).catch(() => {});
}

function loadPortal() {
  if (!win || win.isDestroyed()) return;
  setStatus("Loading your portal…");
  win.loadURL(PORTAL_URL);
}

/**
 * Check for an update on launch. If one exists, download and install it before
 * loading the portal (so users always run the latest shell); otherwise — or if
 * the feed is slow/offline/unpackaged — proceed to the portal after a timeout.
 */
function runUpdateGateThenLoad() {
  if (!app.isPackaged) return loadPortal(); // dev / unsigned: skip the update feed

  let done = false;
  const proceed = () => {
    if (done) return;
    done = true;
    loadPortal();
  };
  const fallback = setTimeout(proceed, UPDATE_TIMEOUT_MS);

  autoUpdater.autoDownload = true;
  autoUpdater.on("checking-for-update", () => setStatus("Checking for updates…"));
  autoUpdater.on("update-available", () => {
    clearTimeout(fallback); // an update is coming — wait for it rather than time out
    setStatus("Downloading update…");
  });
  autoUpdater.on("download-progress", (p) => setStatus(`Downloading update… ${Math.round(p.percent)}%`));
  autoUpdater.on("update-downloaded", () => {
    setStatus("Installing update…");
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
  });
  autoUpdater.on("update-not-available", proceed);
  autoUpdater.on("error", proceed);

  autoUpdater.checkForUpdates().catch(proceed);
}

// Let the offline screen's "Try again" button re-attempt the portal.
ipcMain.on("flz:reload-portal", loadPortal);

app.whenReady().then(() => {
  createWindow();
  runUpdateGateThenLoad();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
