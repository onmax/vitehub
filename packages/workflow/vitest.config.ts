import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "**/.vitehub/**"],
  },
})
