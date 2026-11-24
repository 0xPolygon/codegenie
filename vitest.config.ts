import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/vitest-global-setup.ts"],
    globals: true,
    env: { CODEGENIE_HOME: mkdtempSync(path.join(tmpdir(), "codegenie-vitest-home-")) },
    include: ["tests/**/*.test.ts", "evals/synthetics/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true
  }
});
