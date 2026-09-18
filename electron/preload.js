import { contextBridge } from "electron";

// Minimal, safe surface exposed to the renderer. The app talks to the Flighterz
// API over HTTPS from the renderer; nothing privileged is exposed here.
contextBridge.exposeInMainWorld("flz", {
  platform: process.platform,
  version: process.env.npm_package_version || "0.1.0",
});
