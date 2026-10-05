import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const QueueLanding = {
  ...stubLanding("queue", "Queue", "/docs/server-primitives/queue"),
  eyebrow: "ViteHub Queue",
  description: "Move slow work out of the request and keep delivery, retries, and ownership explicit.",
  tagline: "Background work with a place to go.",
  accent: "warning",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
