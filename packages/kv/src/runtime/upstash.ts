import { readEnv } from "@vite-hub/internal/env"

import type {
  ResolvedKVModuleOptions,
  ResolvedUpstashKVStoreConfig,
} from "../types.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { upstashTokenEnvNames, upstashUrlEnvNames } from "../integrations/upstash.ts"

function isMaskedValue(value: string | undefined) {
  return !value || /^\*+$/.test(value)
}

function assertRuntimeValue(value: string | undefined, envNames: readonly string[]) {
  if (isMaskedValue(value)) {
    const names = envNames.map(name => `\`${name}\``).join(" or ")
    throw kvErrorDiagnostics.KV_R0012({ message: `Missing runtime environment variable ${names} for Upstash KV.` })
  }
}

function resolveRuntimeUpstashStore(
  config: ResolvedUpstashKVStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedUpstashKVStoreConfig {
  const completeEnvPair = upstashUrlEnvNames
    .map((urlName, index) => [readEnv(env, urlName), readEnv(env, upstashTokenEnvNames[index])] as const)
    .find(([url, token]) => url && token)
  const envUrl = readEnv(env, ...upstashUrlEnvNames)
  const envToken = readEnv(env, ...upstashTokenEnvNames)
  const generatedValues = isMaskedValue(config.url) && isMaskedValue(config.token)

  const resolved = {
    ...config,
    token: isMaskedValue(config.token) ? (generatedValues ? completeEnvPair?.[1] : envToken) || config.token : config.token,
    url: isMaskedValue(config.url) ? (generatedValues ? completeEnvPair?.[0] : envUrl) || config.url : config.url,
  }

  assertRuntimeValue(resolved.url, upstashUrlEnvNames)
  assertRuntimeValue(resolved.token, upstashTokenEnvNames)

  return resolved
}

export function resolveRuntimeKVOptions(
  config: false | ResolvedKVModuleOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): false | ResolvedKVModuleOptions | undefined {
  if (!config || config.store.driver !== "upstash") {
    return config
  }

  return {
    ...config,
    store: resolveRuntimeUpstashStore(config.store, env),
  } satisfies ResolvedKVModuleOptions
}
