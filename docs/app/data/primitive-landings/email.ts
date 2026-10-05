import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const EmailLanding = {
  ...stubLanding("email", "Email", "/docs/server-primitives/email"),
  eyebrow: "ViteHub Email",
  description: "Send transactional email through a typed server primitive that keeps provider details at the edge.",
  tagline: "Email delivery that stays inside your server contract.",
  accent: "primary",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
