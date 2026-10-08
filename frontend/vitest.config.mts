import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DOM tests declare their own `// @vitest-environment happy-dom` pragma.
    include: ["src/**/*.test.ts", "../shared/**/*.test.ts", "site-qualification.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
