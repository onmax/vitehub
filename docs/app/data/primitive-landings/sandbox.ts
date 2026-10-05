import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const SandboxLanding = {
  ...stubLanding("sandbox", "Sandbox", "/docs/server-primitives/sandbox"),
  eyebrow: "ViteHub Sandbox",
  description: "Run untrusted or isolated work with a clear boundary and a project you can inspect.",
  tagline: "A safe place to run the work your server should not own.",
  accent: "warning",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
