import { resolvePublicUrl } from "@vite-hub/runtime"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthRuntimeContext,
  AuthRuntimeOptions,
  AuthRuntimeOptionsResolver,
} from "./types.ts"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAuthDatabaseMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && typeof value.name === "string"
      && Object.keys(value).every(key => key === "dedicated" || key === "name")
    )
}

function isAuthSecondaryStorageMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && typeof value.store === "string"
      && Object.keys(value).every(key => key === "store")
    )
}

function stripViteHubOptions(
  options: AuthRuntimeOptions & Record<string, unknown>,
): AuthBetterAuthRuntimeOptions {
  const {
    access: _access,
    database,
    route: _route,
    runtime: _runtime,
    secondaryStorage,
    ...rest
  } = options

  return {
    ...rest,
    ...(!isAuthDatabaseMetadata(database) ? { database } : {}),
    ...(!isAuthSecondaryStorageMetadata(secondaryStorage) ? { secondaryStorage } : {}),
    basePath: normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined),
  } as AuthBetterAuthRuntimeOptions
}

/** Resolves one coherent option snapshot before projecting it for Better Auth or host callers. */
export function resolveAuthOptions(
  definition: AuthDefinition,
  input: {
    env?: (event?: unknown) => Record<string, unknown>
    event?: unknown
    request?: Pick<Request, "headers" | "url">
    runtimeOptions?: AuthRuntimeOptions
  } = {},
) {
  const { request } = input
  const callback = typeof definition.options === "function"
  const staticRequestRuntime = request && typeof definition.options !== "function" ? definition.options.runtime : undefined
  const usesContext = !request || callback || Boolean(staticRequestRuntime)
  const context: AuthRuntimeContext = {
    env: usesContext ? input.env?.(input.event ?? request) ?? {} : {},
    ...(request ? { request } : {}),
    requestOrigin: usesContext && request ? new URL(request.url).origin : "http://localhost",
  }
  const declared = (callback
    ? (definition.options as AuthDefinitionResolver)(context)
    : definition.options) as AuthRuntimeOptions & Record<string, unknown>
  const runtime = request && !callback ? staticRequestRuntime : declared.runtime
  const resolvedRuntime = !runtime
    ? {}
    : typeof runtime === "function"
      ? (runtime as AuthRuntimeOptionsResolver)(context)
      : runtime
  let requestRuntimeOptions = {
    ...(callback ? declared : {}),
    ...resolvedRuntime,
    ...input.runtimeOptions,
  } as AuthRuntimeOptions & Record<string, unknown>
  if (request) {
    const baseURL = requestRuntimeOptions.baseURL || resolvePublicUrl({ request })
    const staticTrustedOrigins = !callback && "trustedOrigins" in declared
    requestRuntimeOptions = {
      ...(!("trustedOrigins" in requestRuntimeOptions) && !staticTrustedOrigins ? { trustedOrigins: [baseURL] } : {}),
      ...requestRuntimeOptions,
      baseURL,
    } as AuthRuntimeOptions & Record<string, unknown>
  }
  let snapshot: AuthRuntimeOptions & Record<string, unknown> | undefined
  const resolveSnapshot = () => snapshot ??= callback ? requestRuntimeOptions : { ...declared, ...requestRuntimeOptions }
  return {
    get options() { return resolveSnapshot() },
    get providerOptions() { return stripViteHubOptions(resolveSnapshot()) },
    requestRuntimeOptions,
  }
}
