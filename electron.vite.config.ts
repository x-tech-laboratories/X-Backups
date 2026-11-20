// The desktop app: the main process and preload in src/main and src/preload, and the same src/web page the server serves.

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") } } },
  },
  renderer: {
    root: resolve("src/web"),
    // The page loads from a file, so its scripts and icons are found beside it.
    base: "./",
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve("src/web/index.html") } } },
  },
});
