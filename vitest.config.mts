import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The extension's code runs against a stand-in for the VS Code API.
    alias: { vscode: fileURLToPath(new URL("packages/vscode/test/e2e/vscode.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
