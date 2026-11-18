import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import path from "node:path";

// The recorded Booli pages and API answers are not part of the public repo
// (no licence to republish them). Without them, skip the tests that replay them.
const booliFixturer = existsSync(path.resolve(__dirname, "fixtures/booli-api"))
  ? []
  : [
      "src/server/annons/booli.test.ts",
      "src/server/annons/booliApiTolkning.test.ts",
      "src/server/annons/forsaljningar.test.ts",
      "src/server/annons/forsaljningarTolkning.test.ts",
      "src/server/annons/hamta.api.test.ts",
      "src/server/annons/hamta.fixtures.test.ts",
    ];

// Standalone from vite.config.ts on purpose — that file is owned by the
// @lovable.dev/vite-tanstack-config wrapper, which warns against adding
// plugins manually. The pure calc layer needs nothing from it but the
// "@/" alias.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Agent worktrees under .claude/ hold full copies of the suite.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", ...booliFixturer],
  },
});
