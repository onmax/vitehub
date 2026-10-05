import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const DatabasesLanding = {
  ...stubLanding("databases", "Databases", "/docs/server-primitives/databases"),
  eyebrow: "ViteHub Databases",
  description: "Use one database API with Drizzle schemas that can move from Vite to Nitro and Nuxt.",
  tagline: "A database layer that keeps your schema and your host in sync.",
  accent: "primary",
  supported: ["Drizzle" , "Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
