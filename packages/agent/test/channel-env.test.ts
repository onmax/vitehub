import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { builtInChannelEnv } from "../src/channel-env.ts"
import { discoverAgentChannelEnv, discoverBuiltInChannelUses } from "../src/channel-env-discovery.ts"
import { hasRuntimeType } from "../src/internal/runtime-type.ts"
import { ViteHubError } from "@vite-hub/runtime"

const kinds = Object.keys(builtInChannelEnv)

function uses(source: string) {
  return discoverBuiltInChannelUses(source, kinds).map(({ kind, optionKeys }) => ({ kind, keys: optionKeys && [...optionKeys].sort() }))
}

describe("built-in Channel discovery", () => {
  it("finds factory calls imported from the Channels module", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram, github as gh } from "vite-hub/agent/channels"
      export default defineAgent({
        channels: {
          bot: telegram({ mode: "webhook", "userName": "support" }),
          repo: gh(),
        },
      })
    `)).toEqual([
      { kind: "telegram", keys: ["mode", "userName"] },
      { kind: "github", keys: [] },
    ])
  })

  it("finds namespace calls and object shorthands", () => {
    expect(uses(`
      import * as channels from "@vite-hub/agent/channels"
      export default defineAgent({
        channels: {
          discord: channels.discord({ adapter: true }),
          telegram: { botToken: () => token(), webhookSecret: false },
          github: options,
          http: {},
        },
      })
    `)).toEqual([
      { kind: "discord", keys: ["adapter"] },
      { kind: "telegram", keys: ["botToken", "webhookSecret"] },
      { kind: "github", keys: undefined },
    ])
  })

  it("marks spread, computed, and variable options as unknown", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ ...shared })
      telegram({ [key]: value })
      telegram(options)
    `)).toEqual([
      { kind: "telegram", keys: undefined },
      { kind: "telegram", keys: undefined },
      { kind: "telegram", keys: undefined },
    ])
  })

  it("finds calls with type arguments", () => {
    expect(uses(`
      import * as channels from "vite-hub/agent/channels"
      import { telegram } from "vite-hub/agent/channels"
      telegram<Runtime>({ botToken: token })
      channels.discord<Map<string, (value: string) => void>>()
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "discord", keys: [] },
    ])
  })

  it("reads shorthands only in the top-level defineAgent() channels option", () => {
    expect(uses(`
      import { defineAgent as agent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      type Settings = { channels: { telegram: {} } }
      const defaults = { channels: { telegram: {} } }
      export const first = agent<Runtime>({ provider: { channels: { telegram: {} } }, channels: { telegram: { adapter } } })
      export default agent({ "channels": { telegram, discord: {} } })
    `)).toEqual([
      { kind: "telegram", keys: ["adapter"] },
      { kind: "telegram", keys: [] },
      { kind: "discord", keys: [] },
    ])
  })

  it("classifies bare factories by their kind and follows local objects", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { discord, telegram } from "vite-hub/agent/channels"
      const telegramOptions = { botToken: token }
      const channels = { support: telegram, discord: telegram, telegram: telegramOptions }
      export default defineAgent({ channels })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it("ignores complete definitions and shadowed factory names", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram, discord } from "vite-hub/agent/channels"
      function run(telegram) { return telegram() }
      const wrap = (discord, other) => discord({})
      export default defineAgent({ channels: { telegram: { kind: "custom" } } })
    `)).toEqual([])
  })

  it("follows typed maps and explicit properties after spreads", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      const base = {}
      const baseChannels = {}
      const channels: AgentChannels = { ...baseChannels, telegram: {} }
      function format(telegram) { return telegram() }
      export default defineAgent({ ...base, channels })
      export const second = defineAgent({ channels: { ...baseChannels, telegram: {} } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it("ignores complete Channel definitions with explicit kinds after spreads", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const custom = { ...base, kind: "custom" }
      export default defineAgent({ channels: {
        telegram: { ...base, kind: "custom" },
        discord: { kind: "custom", ...base },
        github: custom,
      } })
    `)).toEqual([])
  })

  it("respects local declarations without hiding imported factories outside their scope", () => {
    expect(uses(`
      import { telegram, discord, github } from "vite-hub/agent/channels"
      if (enabled) { const telegram = () => ({}); telegram() }
      function format() { const telegram = () => ({}); return telegram() }
      function mutable() { let discord = () => ({}); return discord() }
      function hoisted() { github(); if (enabled) { var github = () => ({}) } }
      const wrap = () => { const telegram = () => ({}); return telegram() }
      function multiple() { const first = value, telegram = () => ({}); telegram() }
      function destructured() { const { factory: telegram } = local; telegram() }
      for (const telegram of factories) { telegram() }
      const helpers = { format() { var telegram = local; return telegram() } }
      telegram({ botToken: token })
      discord()
      github()
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "discord", keys: [] },
      { kind: "github", keys: [] },
    ])
  })

  it("respects shadowed namespace and bare factory references", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      import * as channels from "vite-hub/agent/channels"
      function local() {
        const telegram = custom
        const channels = customFactories
        channels.discord()
        return defineAgent({ channels: { bot: telegram } })
      }
      channels.discord()
      export default defineAgent({ channels: { bot: telegram } })
    `)).toEqual([
      { kind: "discord", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it("treats options set to undefined as omitted", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: undefined, adapter: undefined, mode: "webhook" })
    `)).toEqual([{ kind: "telegram", keys: ["mode"] }])
  })

  it("ignores local and unrelated factories", () => {
    expect(uses(`
      import { telegram } from "./channels"
      import type { github } from "vite-hub/agent/channels"
      const slack = () => ({})
      telegram({})
      bot.telegram({})
      // telegram() in a comment
      const label = "telegram()"
    `)).toEqual([])
  })

  it("declares Channel Env for discovered Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { telegram: telegram() } })`,
      ].join("\n"))
      await writeFile(join(root, "server", "agents", "calories.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { telegram: telegram({ botToken: () => "token" }) } })`,
      ].join("\n"))

      expect(discoverAgentChannelEnv({ rootDir: root })).toEqual({
        telegram: {
          apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"], required: false, secret: false },
          botToken: { names: ["TELEGRAM_BOT_TOKEN"], required: true, secret: true },
          webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], required: false, secret: true },
        },
      })

      await rm(join(root, "server", "agents", "support.ts"))
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(false)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

// Each test imports the Channels module again after resetting mocks.
describe("built-in Channel Env at runtime", { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.doUnmock("#vitehub/env/server")
    vi.doUnmock("@chat-adapter/telegram")
    vi.doUnmock("@chat-adapter/discord")
    vi.resetModules()
  })

  it.each([
    { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package 'missing-provider' imported from /app/#vitehub/env/server/generated.mjs", missing: false },
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED", message: 'Package import specifier "#missing-provider" is not defined in package /app/#vitehub/env/server/package.json', missing: false },
    { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package '#vitehub/env/server' imported from /app/agent.mjs", missing: true },
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED", message: 'Package import specifier "#vitehub/env/server" is not defined in package /app/package.json', missing: true },
    { code: "ERR_LOAD_URL", message: "Failed to load url #vitehub/env/server (resolved id: #vitehub/env/server) in /app/agent.mjs. Does the file exist?", missing: true },
    { code: "ERR_LOAD_URL", message: "Failed to load url missing-provider (resolved id: missing-provider) in /app/#vitehub/env/server/generated.mjs. Does the file exist?", missing: false },
  ])("falls back only for the missing generated Env specifier: $message", ({ code, message, missing }) => {
    // Native imports preserve loader errors. Vitest wraps errors thrown by mock factories.
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { registerHooks } from "node:module"
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "#vitehub/env/server") throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} })
        return next(specifier, context)
      } })
      const { channelEnvValue } = await import(${JSON.stringify(new URL("../src/channel-env.ts", import.meta.url).href)})
      try {
        const value = await channelEnvValue("telegram", "botToken", { cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } })
        console.log(JSON.stringify({ value }))
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }))
      }
    `], { encoding: "utf8", timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual(missing ? { value: "host-token" } : { code, message })
  })

  it("reads Telegram values from Server Env before host names", async () => {
    vi.resetModules()
    const useServerEnv = vi.fn(() => ({ telegram: { botToken: { unseal: () => "server-token" }, webhookSecret: "server-secret" } }))
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const context = { cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    await expect(channel.adapter(context)).resolves.toEqual({ name: "telegram" })
    expect(createTelegramAdapter).toHaveBeenCalledWith({ botToken: "server-token", secretToken: "server-secret" })
    expect(useServerEnv).toHaveBeenCalledWith({ env: { TELEGRAM_BOT_TOKEN: "host-token" } })
  })

  it("keeps explicit Telegram options ahead of Server Env", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ telegram: { botToken: "server-token" } }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram({ botToken: "option-token", webhookSecret: false })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({} as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ allowUnverifiedWebhooks: true, botToken: "option-token" })
  })

  it("reads host names only for fields that Server Env does not declare", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ telegram: { webhookSecret: undefined } }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token", TELEGRAM_WEBHOOK_SECRET_TOKEN: "stale-secret" } } } as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ botToken: "host-token" })
  })

  it("keeps Server Env module load errors visible", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => { throw new Error("provider module failed") })
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter: vi.fn() }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never)).rejects.toThrow()
  })

  it("keeps Server Env resolution errors visible", async () => {
    vi.resetModules()
    const missing = new ViteHubError("ENV_REQUIRED_MISSING", "[vitehub] Required Env value is missing.")
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => { throw missing } }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter: vi.fn() }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never)).rejects.toBe(missing)
  })

  it("loads provider-backed Channel Env asynchronously", async () => {
    vi.resetModules()
    const group = Object.defineProperty({}, "botToken", {
      enumerable: true,
      get: () => { throw new ViteHubError("ENV_ASYNC_REQUIRED", "[vitehub] Server Env requires asynchronous loading.") },
    })
    const loadServerEnv = vi.fn(async () => ({ telegram: { botToken: "provider-token" } }))
    vi.doMock("#vitehub/env/server", () => ({ loadServerEnv, useServerEnv: () => ({ telegram: group }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram({ webhookSecret: false })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({} as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ allowUnverifiedWebhooks: true, botToken: "provider-token" })
    expect(loadServerEnv).toHaveBeenCalledOnce()
  })

  it("fills Discord adapter credentials from Server Env", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({
      useServerEnv: () => ({ discord: { applicationId: "app-id", botToken: { unseal: () => "bot-token" }, publicKey: "public-key" } }),
    }))
    const createDiscordAdapter = vi.fn(() => ({ name: "discord" }))
    vi.doMock("@chat-adapter/discord", () => ({ createDiscordAdapter }))
    const { discord } = await import("../src/channels.ts")
    const channel = discord({ adapter: true })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Discord adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({} as never)).resolves.toMatchObject({ name: "discord" })
    expect(createDiscordAdapter).toHaveBeenCalledWith({ applicationId: "app-id", botToken: "bot-token", publicKey: "public-key" })
  })
})
