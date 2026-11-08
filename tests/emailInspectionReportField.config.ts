import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "react-router-dom": resolve("field-app/node_modules/react-router-dom"),
      "react-dom": resolve("field-app/node_modules/react-dom"),
      react: resolve("field-app/node_modules/react"),
    },
  },
  test: { environment: "jsdom", include: ["tests/emailInspectionReportField.test.tsx"] },
});
