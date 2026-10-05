import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const ShellLanding = {
  ...stubLanding("shell", "Shell", "/docs/server-primitives/shell"),
  eyebrow: "ViteHub Shell",
  description: "Run commands with explicit ownership, environment, and output instead of hiding a process behind a helper.",
  tagline: "Command execution with a boundary you can reason about.",
  accent: "warning",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
