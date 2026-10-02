import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The extension's code runs against a stand-in for the VS Code API.
    alias: { vscode: fileURLToPath(new URL("packages/vscode/test/e2e/vscode.ts", import.meta.url)) },
  },
  // Build-time constants; no update address, so tests never contact the update server.
  define: { __DIMOSI_UPDATE_URL__: '""', __DIMOSI_VERSION__: '"0.0.0-test"' },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
