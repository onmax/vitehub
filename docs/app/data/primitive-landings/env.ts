import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const EnvLanding = {
  ...stubLanding("env", "Env", "/docs/server-primitives/env"),
  eyebrow: "ViteHub Env",
  description: "Declare and inspect typed environment configuration before a host starts serving traffic.",
  tagline: "Configuration you can inspect before it fails.",
  accent: "info",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
