import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@cr/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@cr/datasources": path.resolve(__dirname, "packages/datasources/src/index.ts"),
      "@cr/engine": path.resolve(__dirname, "packages/engine/src/index.ts"),
    },
  },
  test: { include: ["packages/**/*.test.ts", "apps/**/*.test.ts"] },
});
