import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/offlineSyncModel.test.ts", "tests/offlineDb.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
