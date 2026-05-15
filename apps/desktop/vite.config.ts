import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// process is a nodejs global — this file is build-time only, never
// bundled, so the missing type definition is fine.
// @ts-expect-error build-time node global, not bundled
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Pin the JS target and minifier explicitly. Vite's defaults (esbuild
    // minify, "modules" target → roughly ES2020+) work today but a future
    // vite-major bump could shift them; pin so a dependency upgrade
    // doesn't quietly change the shipped output. ES2022 matches the
    // tsconfig's `target` so syntax used in source survives the bundle.
    target: "es2022",
    minify: "esbuild",
    // Hidden sourcemaps so future error-tracking (Sentry et al.) can
    // symbolicate without shipping source to end users.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Split the heavy vendors into their own chunks so cold starts
        // don't always re-download xterm when only app code changed.
        // `@xterm/addon-webgl` is intentionally absent — TerminalView
        // dynamic-imports it after a feature-detect, and forcing it
        // into vendor-xterm would defeat the split (Rollup respects
        // manual chunks above lazy-import boundaries).
        //
        // Function form: vite 8 (rolldown) dropped the legacy
        // object-form `manualChunks: { name: [...modules] }` and now
        // requires `(id) => string | undefined`. Returning a chunk name
        // routes the module into that chunk; returning undefined lets
        // the bundler do its own splitting.
        manualChunks: (id) => {
          if (
            id.includes("/@xterm/xterm/") ||
            id.includes("/@xterm/addon-fit/")
          ) {
            return "vendor-xterm";
          }
          return undefined;
        },
      },
    },
  },
}));
