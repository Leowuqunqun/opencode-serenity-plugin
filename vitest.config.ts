import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // msm-call.test.ts 用 npx tsx spawn msm-exec stub, 冷启动可能 >5s 默认超时
    // msm-exec-tool.test.ts 部分用例 ~12s；显式提到 30s 避免 flake
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
