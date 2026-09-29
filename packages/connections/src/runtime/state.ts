import discoveredRegistry, { database } from "#vitehub/connections/registry"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { ConnectionError } from "../errors.ts"
import { createConnectionsRuntime } from "../runtime.ts"
import { createDatabaseConnectionStore } from "../store.ts"

import type { ConnectionDefinitionName, ConnectionRegistryClient } from "../registry-types.ts"
import type { ConnectionRuntimeClient, ConnectionsRuntime, ConnectionsRuntimeOptions } from "../runtime.ts"
import type { ConnectionStore } from "../store.ts"
import type { ConnectionClient, UseConnectionOptions } from "../types.ts"

let runtime: ConnectionsRuntime | undefined

/** Replace the Connections runtime, for example with a custom store in tests. Pass `undefined` to reset it. */
export function setConnectionsRuntime(options: ConnectionsRuntimeOptions | undefined): void {
  runtime = options ? createConnectionsRuntime(options) : undefined
}

function decodeKey(value: string): Uint8Array {
  if (/^[a-f0-9]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
  try {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))
  }
  catch {
    return new Uint8Array()
  }
}

function readEncryptionKey(): Uint8Array {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const cloudflareValue = getActiveCloudflareEnv()?.VITEHUB_CONNECTIONS_KEY
  const value = processEnv?.VITEHUB_CONNECTIONS_KEY ?? (typeof cloudflareValue === "string" ? cloudflareValue : undefined)
  const key = value ? decodeKey(value.trim()) : undefined
  if (key?.byteLength !== 32) {
    throw new ConnectionError("invalid", "Connections need VITEHUB_CONNECTIONS_KEY with 32 random bytes as base64 or hex. Create one with `openssl rand -base64 32`.")
  }
  return key
}

async function defaultStore(): Promise<ConnectionStore> {
  if (!database) {
    throw new ConnectionError("invalid", "Connections need the ViteHub Database. Enable `database` in vitehub(), or call setConnectionsRuntime() with a store.")
  }
  return createDatabaseConnectionStore({ db: await database(), encryptionKey: readEncryptionKey() })
}

/** The active Connections runtime. */
export function getConnectionsRuntime(): ConnectionsRuntime {
  return runtime ??= createConnectionsRuntime({ definitions: discoveredRegistry, store: defaultStore })
}

function methodProxy(client: ConnectionRuntimeClient, path: string): unknown {
  const call = (input?: unknown, options?: { signal?: AbortSignal }) => client.call(path, input, options)
  return new Proxy(call, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined
      return methodProxy(client, `${path}.${property}`)
    },
  })
}

/**
 * Use a Connection. The client calls provider API methods with the stored token,
 * applies the Connection access policy, and records activity.
 */
export function useConnection<const TName extends ConnectionDefinitionName>(name: TName, options?: UseConnectionOptions): ConnectionRegistryClient<TName>
export function useConnection<TName extends string>(name: string extends TName ? TName : never, options?: UseConnectionOptions): ConnectionClient
export function useConnection(name: string, options: UseConnectionOptions = {}): ConnectionClient {
  if (typeof name !== "string" || !name.trim()) throw new ConnectionError("invalid", "`useConnection()` requires a Connection name.")
  let client: ConnectionRuntimeClient | undefined
  const resolveClient = () => (client ??= getConnectionsRuntime().client(name, options))
  return new Proxy({ name } as ConnectionClient, {
    get(target, property) {
      if (property === "name") return target.name
      if (property === "fetch") return (input: string | URL, init?: RequestInit) => resolveClient().fetch(input, init)
      if (typeof property !== "string" || property === "then" || property === "toJSON") return undefined
      return methodProxy({
        call: (action, input, callOptions) => resolveClient().call(action, input, callOptions),
        fetch: (input, init) => resolveClient().fetch(input, init),
      }, property)
    },
  })
}
