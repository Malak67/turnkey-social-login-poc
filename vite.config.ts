import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { visualizer } from "rollup-plugin-visualizer";

// WalletConnect / @reown/walletkit pull in Buffer + process, same as the
// Para POC. Without the polyfill plugin the dev server white-screens.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
    visualizer({
      filename: "bundle-report.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  server: {
    // OAuth popup-flow needs the opener window to be able to read
    // `popup.closed` AND `popup.location.href` after the popup
    // transitions through accounts.google.com and back to our origin.
    // `same-origin-allow-popups` is the textbook value, but in practice
    // Chrome still severs the linkage in some configurations. For dev
    // we go fully permissive (`unsafe-none`); for prod, set this back
    // to `same-origin-allow-popups` and verify the popup flow works
    // against your real origin.
    headers: {
      "Cross-Origin-Opener-Policy": "unsafe-none",
      "Cross-Origin-Embedder-Policy": "unsafe-none",
    },
  },
});
