import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  define: { __FIELD_BUILD_SHA__: JSON.stringify(process.env.OI_FIELD_BUILD_SHA || "test-build") },
  resolve: {
    alias: {
      "react-router-dom": resolve("field-app/node_modules/react-router-dom"),
      "react-dom": resolve("field-app/node_modules/react-dom"),
      react: resolve("field-app/node_modules/react"),
    },
  },
  test: { environment: "jsdom", include: ["tests/emailInspectionReportField.test.tsx", "tests/purchasingDestinationField.test.tsx", "tests/howToUse.test.tsx", "tests/inspectionVisitUi.test.tsx", "tests/scanVisitUi.test.tsx"] },
});
