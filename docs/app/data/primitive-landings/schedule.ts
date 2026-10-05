import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const ScheduleLanding = {
  ...stubLanding("schedule", "Schedule", "/docs/server-primitives/schedule"),
  eyebrow: "ViteHub Schedule",
  description: "Run recurring work with a typed schedule that belongs to your server code.",
  tagline: "Recurring work that follows the same contract everywhere.",
  accent: "secondary",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
