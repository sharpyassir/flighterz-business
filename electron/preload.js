import { contextBridge, ipcRenderer } from "electron";

// Minimal, safe surface exposed to the renderer. The portal runs over HTTPS in
// the window; the only privileged action is asking the shell to re-load the
// portal (used by the offline screen's "Try again" button).
contextBridge.exposeInMainWorld("flz", {
  platform: process.platform,
  version: process.env.npm_package_version || "0.2.0",
  reloadPortal: () => ipcRenderer.send("flz:reload-portal"),
});
