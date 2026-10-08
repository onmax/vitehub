import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubAppCredentials } from "../src/server/github-host.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses owner-scoped installation IDs and discovers other owners once", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const discovered: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    discovered.push(String(input));
    return Response.json({ id: 303 });
  });
  const app = createGitHubAppCredentials({ appId: 1, privateKey, installationId: 101, owner: "vite-hub", installations: { onmax: 202 } });
  const credentials = (repository: string) => app.credentials({ repository, signal: new AbortController().signal });
  expect((await credentials("vite-hub/vitehub")).installationId).toBe(101);
  expect((await credentials("onmax/vite-doctor")).installationId).toBe(202);
  expect((await credentials("nuxt-modules/better-auth")).installationId).toBe(303);
  expect((await credentials("nuxt-modules/another")).installationId).toBe(303);
  expect(discovered).toEqual(["https://api.github.com/repos/nuxt-modules/better-auth/installation"]);
});
