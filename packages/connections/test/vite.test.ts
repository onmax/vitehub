import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite";
import { mergeConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverConnectionDefinitions } from "../src/discovery.ts";
import { CONNECTIONS_REGISTRY_ID, hubConnections, hubConnectionsTypesCleanup } from "../src/vite.ts";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-vite-"));
  tempDirs.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  return root;
}

async function writeConnection(root: string, path: string): Promise<string> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "export default {}\n");
  return file;
}

type ConfigHook = (
  config: Record<PropertyKey, unknown>,
  environment: { command: "build" | "serve"; mode: string },
) => Promise<Record<string, unknown>>;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("discoverConnectionDefinitions", () => {
  it("finds server/connections files and .connection suffix files", async () => {
    const root = await createTempProject();
    const google = await writeConnection(root, "server/connections/google.ts");
    const slack = await writeConnection(root, "src/slack.connection.ts");
    const nested = await writeConnection(root, "server/connections/team/mail.ts");
    expect(discoverConnectionDefinitions({ rootDir: root })).toEqual([
      { handler: google, name: "google", source: "server-connections" },
      { handler: slack, name: "slack", source: "vite-suffix" },
      { handler: nested, name: "team/mail", source: "server-connections" },
    ]);
  });
});

describe("hubConnections", () => {
  it.each(["@vite-hub/connections", "vite-hub/connections"])("writes the registry and mounts the management API through %s in development", async (importBase) => {
    const root = await createTempProject();
    const definition = await writeConnection(root, "server/connections/google.ts");
    const plugin = hubConnections({ database: "vite-hub/database/drizzle", importBase });
    const config = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (plugin.config as unknown as ConfigHook)(config, {
      command: "serve",
      mode: "development",
    });
    const nitro = config.nitro as {
      alias: Record<string, string>;
      handlers: Array<{ handler: string; route: string }>;
    };
    const registry = await readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8");
    expect(registry).toContain(JSON.stringify(definition));
    expect(registry).toContain(
      'export const database = () => import("vite-hub/database/drizzle").then(module => module.db)',
    );
    expect(nitro.handlers.map((handler) => handler.route)).toEqual([
      "/_vitehub/connections",
      "/_vitehub/connections/**",
    ]);
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain(
      `from "${importBase}/server"`,
    );
  });

  it("requires authenticated management configuration in production", async () => {
    const root = await createTempProject();
    const build = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (hubConnections().config as unknown as ConfigHook)(build, {
      command: "build",
      mode: "production",
    });
    expect((build.nitro as { handlers?: unknown[] }).handlers ?? []).toEqual([]);
    await expect(
      (hubConnections({ management: true }).config as unknown as ConfigHook)(
        { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true },
        { command: "build", mode: "production" },
      ),
    ).rejects.toThrow("requires management");
    const managed = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true };
    await (
      hubConnections({ management: { actor: "./server/connections-auth.ts" } })
        .config as unknown as ConfigHook
    )(managed, { command: "build", mode: "production" });
    const handlers = (managed.nitro as { handlers: Array<{ handler: string }> }).handlers;
    expect(handlers).toHaveLength(2);
    const handler = await readFile(handlers[0]!.handler, "utf8");
    expect(handler).toContain(
      `import actor from ${JSON.stringify(join(root, "server/connections-auth.ts"))}`,
    );
    expect(handler).toContain("createConnectionsHandler({ actor })");
    expect(handler).not.toContain("user:local");
  });

  it("preserves existing config arrays when Vite merges the hook result", async () => {
    const root = await createTempProject();
    const config = {
      nitro: { handlers: [{ handler: "existing.ts", route: "/existing" }] },
      root,
      ssr: { noExternal: ["existing-package"] },
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    };
    const addition = await (hubConnections().config as unknown as ConfigHook)(config, {
      command: "serve",
      mode: "development",
    });
    const merged = mergeConfig(config, addition);
    expect(merged.ssr.noExternal).toEqual(["existing-package", "@vite-hub/connections"]);
    expect(merged.nitro.handlers.map((handler: { route: string }) => handler.route)).toEqual([
      "/existing",
      "/_vitehub/connections",
      "/_vitehub/connections/**",
    ]);
  });

  it.each(["ts", "tsx", "jsx"])("writes registry types and refreshes on %s hot update", async (extension) => {
    const root = await createTempProject();
    const plugin = hubConnections();
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root });
    const added = await writeConnection(root, `server/connections/slack.${extension}`);
    const invalidateModule = vi.fn();
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: added,
      server: { config: { root }, moduleGraph: { getModuleById: () => ({}), invalidateModule } },
    });
    expect(invalidateModule).toHaveBeenCalled();
    await expect(
      readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8"),
    ).resolves.toContain(`"slack": typeof import(${JSON.stringify(added)})`);
    expect(plugin.api.getDefinitions().map((definition) => definition.name)).toEqual(["slack"]);
  });

  it("removes declarations from a previously configured custom root when disabled", async () => {
    const root = await createTempProject();
    const projectRoot = join(root, "packages/api");
    const plugin = hubConnections({ projectRoot: "packages/api" });
    await plugin.api.prepareTypes({ projectRoot: root });
    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).resolves.toBeTruthy();

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });

    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes declarations from a custom root after the generating process restarts", async () => {
    const root = await createTempProject();
    const projectRoot = join(root, "packages/api");
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: root });

    vi.resetModules();
    const { hubConnectionsTypesCleanup: freshCleanup } = await import("../src/vite.ts");
    await freshCleanup().api!.prepareTypes({ projectRoot: root });

    await expect(readFile(join(projectRoot, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps declarations for another project during cleanup", async () => {
    const firstRoot = await createTempProject();
    const secondRoot = await createTempProject();
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: firstRoot });
    await hubConnections({ projectRoot: "packages/api" }).api.prepareTypes({ projectRoot: secondRoot });

    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: firstRoot });

    await expect(readFile(join(secondRoot, "packages/api/.vitehub/types/connections.d.ts"))).resolves.toBeTruthy();
  });
});
