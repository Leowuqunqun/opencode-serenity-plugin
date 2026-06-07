import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // msm-call.test.ts 用 npx tsx spawn msm-exec stub, 冷启动可能 >5s 默认超时
    // 显式提到 20s 避免偶发 flake（与本次 debt 清理无关）
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
