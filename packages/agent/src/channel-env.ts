import { getViteHubErrorShape } from "@vite-hub/runtime"

import { isRuntimeRecord } from "./internal/runtime-type.ts"

import type { AgentCallbackContext, AgentRuntimeConfig } from "./types.ts"

/** One Server Env value that a built-in Channel reads when its options omit the value. */
export interface ChannelEnvField {
  /** Host variable names in lookup order. */
  names: readonly [string, ...string[]]
  secret?: true
  /**
   * The value is required when an Agent uses the Channel without one of these option keys.
   * Omit it to keep the value optional.
   */
  requiredUnless?: readonly string[]
}

/**
 * Server Env declared by built-in Channels, keyed by Channel factory name and then by
 * the `env.server.<channel>.<field>` path.
 *
 * To add Env for a built-in Channel, add its factory name here and read each value with
 * `channelEnvValue()`. ViteHub then finds the factory in Agent files, declares the values
 * in Server Env, shows them in the Console, and adds required secrets to Wrangler.
 */
export const builtInChannelEnv = {
  discord: {
    applicationId: { names: ["DISCORD_APPLICATION_ID"] },
    botToken: { names: ["DISCORD_BOT_TOKEN"], secret: true },
    publicKey: { names: ["DISCORD_PUBLIC_KEY"], secret: true },
  },
  github: {
    appId: { names: ["GITHUB_APP_ID"] },
    appInstallationId: { names: ["GITHUB_APP_INSTALLATION_ID"] },
    appPrivateKey: { names: ["GITHUB_APP_PRIVATE_KEY"], secret: true },
    appPrivateKeyPath: { names: ["GITHUB_APP_PRIVATE_KEY_PATH"] },
    token: { names: ["VITEHUB_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], secret: true },
    webhookSecret: { names: ["GITHUB_WEBHOOK_SECRET"], secret: true },
  },
  telegram: {
    apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"] },
    botToken: { names: ["TELEGRAM_BOT_TOKEN"], requiredUnless: ["adapter", "botToken"], secret: true },
    webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], secret: true },
  },
} as const satisfies Record<string, Record<string, ChannelEnvField>>

export type BuiltInChannelEnv = typeof builtInChannelEnv

const channelEnvFields: Readonly<Record<string, Readonly<Record<string, ChannelEnvField>>>> = builtInChannelEnv

const serverEnvModuleId = "#vitehub/env/server"

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return isRuntimeRecord(value) && !Array.isArray(value)
}

interface ServerEnvModule {
  loadServerEnv?: (event?: unknown) => Promise<unknown>
  useServerEnv?: (event?: unknown) => unknown
}

let serverEnvModule: Promise<ServerEnvModule | undefined> | undefined

function importServerEnvModule(): Promise<ServerEnvModule | undefined> {
  // hubEnv() rewrites the tagged import so Vite can resolve its generated module.
  // SAFETY: The generated server env module exposes the optional useServerEnv and loadServerEnv entrypoints.
  serverEnvModule ??= (import(/* @vite-ignore */ /* @vitehub-env */ serverEnvModuleId) as Promise<ServerEnvModule>)
    .catch(() => undefined)
  return serverEnvModule
}

function channelGroup(env: unknown, channel: string): Record<PropertyKey, unknown> | undefined {
  const group = isRecord(env) ? env[channel] : undefined
  return isRecord(group) ? group : undefined
}

// Returns undefined when Server Env does not declare the field.
async function serverEnvField(channel: string, field: string, cloudflareEnv: Record<string, unknown> | undefined): Promise<{ value: unknown } | undefined> {
  const module = await importServerEnvModule()
  if (!module?.useServerEnv) return undefined
  const event = cloudflareEnv ? { env: cloudflareEnv } : undefined
  // Resolution errors, such as a missing required value, are configuration errors and stay visible.
  const group = channelGroup(module.useServerEnv(event), channel)
  if (!group || !Object.hasOwn(group, field)) return undefined
  try {
    return { value: group[field] }
  }
  catch (error) {
    // Provider-backed values need the asynchronous snapshot.
    if (getViteHubErrorShape(error)?.code !== "ENV_ASYNC_REQUIRED" || !module.loadServerEnv) throw error
    return { value: channelGroup(await module.loadServerEnv(event), channel)?.[field] }
  }
}

/**
 * Read `env.server.<channel>.<field>`. When Server Env does not declare the field, or the
 * application does not use hubEnv(), read the host variable names of the field instead.
 * Explicit Channel options take precedence; callers read Env only when an option is omitted.
 */
export async function channelEnvValue<
  TChannel extends keyof BuiltInChannelEnv,
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  channel: TChannel,
  field: keyof BuiltInChannelEnv[TChannel] & string,
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<unknown> {
  const cloudflareEnv = context.cloudflare?.env
  const declared = await serverEnvField(channel, field, cloudflareEnv)
  if (declared) return declared.value
  for (const name of channelEnvFields[channel]?.[field]?.names ?? []) {
    const hostValue = cloudflareEnv?.[name] ?? globalThis.process?.env?.[name]
    if (hostValue !== undefined) return hostValue
  }
}
