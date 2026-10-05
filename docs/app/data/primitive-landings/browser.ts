import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const BrowserLanding = {
  ...stubLanding("browser", "Browser", "/docs/server-primitives/browser"),
  eyebrow: "ViteHub Browser",
  description: "Give server code a controlled browser surface for pages, screenshots, and automation.",
  tagline: "A browser your Agent can use and your server can inspect.",
  accent: "secondary",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
