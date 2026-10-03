import { defineNuxtRouteMiddleware, navigateTo } from "#imports";
import { docsLegacyFragmentRedirects } from "~~/modules/vitehub-docs/redirects";

export default defineNuxtRouteMiddleware((to) => {
  const fragment = to.hash.slice(1);
  const path = to.path.replace(/\/+$/, "");
  const target = Object.entries(docsLegacyFragmentRedirects)
    .find(([redirectPath]) => redirectPath === path)?.[1][fragment];

  if (!target || target === to.path) return;

  return navigateTo({ path: target, hash: `#${fragment}` }, { replace: true });
});
