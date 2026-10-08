import { builtinEnvironments } from "vitest/environments"

// Compile Vue client templates while the custom renderer supplies the host nodes.
export default {
  ...builtinEnvironments.node,
  name: "client-renderer",
  viteEnvironment: "client",
}
