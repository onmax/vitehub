import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const ContentLanding = {
  ...stubLanding("content", "Content", "/docs/server-primitives/content"),
  eyebrow: "ViteHub Content",
  description: "Parse and search content in the server layer so applications can work with documents directly.",
  tagline: "Content that is ready to query.",
  accent: "secondary",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
