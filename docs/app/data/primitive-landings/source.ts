import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const SourceLanding = {
  ...stubLanding("source", "Source", "/docs/server-primitives/source"),
  eyebrow: "ViteHub Source",
  description: "Mount read only content from local files, archives, or remote providers with one access contract.",
  tagline: "Read the project without giving it away.",
  accent: "info",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
