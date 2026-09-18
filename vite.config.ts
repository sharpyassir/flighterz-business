import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Electron loads the built files from disk (file://), so use relative asset paths.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
