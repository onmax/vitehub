import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const AuthLanding = {
  ...stubLanding("auth", "Auth", "/docs/server-primitives/auth"),
  eyebrow: "ViteHub Auth",
  description: "Build sessions and providers with Better Auth while keeping the server contract portable.",
  tagline: "Authentication that stays yours across hosts.",
  accent: "primary",
  supported: ["Better Auth" , "Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
