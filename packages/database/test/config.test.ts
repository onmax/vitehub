import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { discoverDatabaseDefinitions, resolveDBViteConfig } from "../src/config.ts"
import { resolveCloudflareD1Bindings, resolveRuntimeCloudflareConfig } from "../src/internal/cloudflare.ts"
import { renderDatabaseConfigExpression } from "../src/internal/runtime-config-expression.ts"
import { runtimeConfig } from "../src/runtime/definition-config.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-config-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, tables = "notes", options: { cloudflare?: string, connection?: string } = {}) {
  const file = join(rootDir, path)
  const name = /(?:^|\/)src\/(.+)\.database\./.exec(path)?.[1]
    ?? /(?:^|\/)server\/databases\/(.+)\/config\./.exec(path)?.[1]
    ?? "default"
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${tables} = sqliteTable('${tables}', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    ...(options.cloudflare !== undefined ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    `  schema: { ${tables} },`,
    "})",
    "",
  ].join("\n"))
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverDatabaseDefinitions", () => {
  it("discovers the server default database definition", async () => {
    const rootDir = await createTempProject()
    const file = await writeDefinition(rootDir, "server/databases/config.ts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([{
      handler: file,
      mode: "default",
      name: "default",
      source: "server-database-default",
      tableNames: ["notes"],
    }])
  })

  it("discovers named server database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    const tenant = await writeDefinition(rootDir, "server/databases/tenant/config.ts", "accounts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", tableNames: ["events"] }),
      expect.objectContaining({ handler: tenant, mode: "named", name: "tenant", tableNames: ["accounts"] }),
    ])
  })

  it("discovers nested named database definitions", async () => {
    const rootDir = await createTempProject()
    const archive = await writeDefinition(rootDir, "server/databases/billing/archive/config.ts", "invoices")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: archive, mode: "named", name: "billing/archive", tableNames: ["invoices"] }),
    ])
  })

  it("rejects a definition name that does not match its discovered identity", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/analytics/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ name: 'default', schema: {} })",
      "",
    ].join("\n"))

    expect(() => discoverDatabaseDefinitions(rootDir)).toThrow('must set `name: "analytics"`')
  })

  it("discovers Vite default and suffix database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "src/analytics.database.ts", "events")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", source: "vite-database-suffix" }),
    ])
  })

  it("reads table names from the exported database definition only", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const ignored = sqliteTable('ignored', { title: text('title') })",
      "const notes = sqliteTable('notes', { title: text('title') })",
      "const decoy = { schema: { ignored } }",
      "defineDatabase(decoy)",
      "export default defineDatabase({",
      "  schema: { notes },",
      "})",
      "",
    ].join("\n"))

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: file, tableNames: ["notes"] }),
    ])
  })

  it("rejects mixing the default database with named databases", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    expect(() => discoverDatabaseDefinitions(rootDir)).toThrow("either one default database or all named databases")
  })
})

describe("resolveDBViteConfig", () => {
  it("returns undefined when no database definition exists", async () => {
    const rootDir = await createTempProject()

    expect(resolveDBViteConfig(undefined, rootDir)).toBeUndefined()
  })

  it("resolves generated files, migrations, and local fallback connection", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databaseNames).toEqual(["default"])
    expect(resolved?.databases.default).toMatchObject({
      connection: { url: "file:.vitehub/data/database/sqlite.db" },
      dialect: "sqlite",
      migrationsDir: "server/databases/migrations",
      mode: "default",
      name: "default",
      orm: "drizzle",
    })
    expect(resolved?.generatedDrizzleConfigFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/drizzle/default.config.ts"))
    expect(resolved?.generatedSchemaFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(resolved?.generatedDrizzleConfigFile).toBe(join(rootDir, ".vitehub/database/drizzle.config.ts"))
    expect(resolved?.definitionDefaults.cloudflareProjections.default?.resource).toBe("inherited")
  })

  it("records dynamic Definition Cloudflare configuration that cannot be resolved statically", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "const cloudflare = { binding: 'APP_DB' }",
      "export default defineDatabase({ cloudflare, schema: {} })",
      "",
    ].join("\n"))

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databases.default.cloudflare).toBeUndefined()
    expect(resolved?.definitionDefaults.cloudflareProjections.default?.resource).toBe("opaque")
  })

  it("does not treat an empty parsed Definition object as unresolvable Cloudflare configuration", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({})",
      "",
    ].join("\n"))

    expect(resolveDBViteConfig(undefined, rootDir)?.definitionDefaults.cloudflareProjections.default?.resource).toBe("inherited")
  })

  it("treats a literal undefined Definition Cloudflare value as omitted", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ cloudflare: undefined, schema: {} })",
      "",
    ].join("\n"))

    expect(resolveDBViteConfig(undefined, rootDir)?.definitionDefaults.cloudflareProjections.default?.resource).toBe("inherited")
  })

  it("recognizes a static computed Definition Cloudflare property", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "const cloudflare = { binding: 'APP_DB' }",
      "export default defineDatabase({ ['cloudflare']: cloudflare, schema: {} })",
      "",
    ].join("\n"))

    expect(resolveDBViteConfig(undefined, rootDir)?.definitionDefaults.cloudflareProjections.default?.resource).toBe("opaque")
  })

  it("recognizes a configured Definition Cloudflare property after an undefined one", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "const cloudflare = { binding: 'APP_DB' }",
      "export default defineDatabase({ cloudflare: undefined, cloudflare, schema: {} })",
      "",
    ].join("\n"))

    expect(resolveDBViteConfig(undefined, rootDir)?.definitionDefaults.cloudflareProjections.default?.resource).toBe("opaque")
  })

  it("treats a final undefined Definition Cloudflare property as omitted", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "const cloudflare = { binding: 'APP_DB' }",
      "export default defineDatabase({ cloudflare, cloudflare: undefined, schema: {} })",
      "",
    ].join("\n"))

    expect(resolveDBViteConfig(undefined, rootDir)?.definitionDefaults.cloudflareProjections.default?.resource).toBe("inherited")
  })

  it("resolves named database defaults from definition locations", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databases.analytics).toMatchObject({
      connection: { url: "file:.vitehub/data/database/analytics.sqlite.db" },
      migrationsDir: "server/databases/analytics/migrations",
      mode: "named",
    })
  })

  it("resolves default migrations from a forwarded server directory", async () => {
    const rootDir = await createTempProject()
    const serverDir = join(rootDir, "backend")
    await writeDefinition(rootDir, "backend/databases/config.ts")

    const resolved = resolveDBViteConfig(undefined, rootDir, { serverDirs: [serverDir] })

    expect(resolved?.databases.default.migrationsDir).toBe("backend/databases/migrations")
  })

  it("uses the integration connection when the definition does not select a host", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_DATABASE_URL

    const connection = {
      authToken: {
        kind: "env-variable" as const,
        source: { kind: "env" as const, name: "TURSO_AUTH_TOKEN" },
      },
      url: {
        kind: "env-variable" as const,
        source: { kind: "env" as const, name: "TURSO_DATABASE_URL" },
      },
    }

    try {
      expect(resolveDBViteConfig({ connection }, rootDir)?.databases.default.connection).toEqual(connection)
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("lets a definition override the integration connection URL", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      connection: "    url: 'libsql://definition.example.turso.io',",
    })

    expect(resolveDBViteConfig({
      connection: {
        authToken: "integration-token",
        url: "libsql://integration.example.turso.io",
      },
    }, rootDir)?.databases.default.connection).toEqual({
      authToken: "integration-token",
      url: "libsql://definition.example.turso.io",
    })
  })

  it("preserves an unresolved definition URL over the integration connection", async () => {
    const rootDir = await createTempProject()
    const originalUrl = process.env.ANALYTICS_DATABASE_URL
    delete process.env.ANALYTICS_DATABASE_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: "    url: process.env.ANALYTICS_DATABASE_URL,",
      })

      expect(resolveDBViteConfig({
        connection: {
          authToken: "integration-token",
          url: "libsql://integration.example.turso.io",
        },
      }, rootDir)?.databases.default.connection).toEqual({
        authToken: "integration-token",
        url: {
          kind: "env-variable",
          source: { kind: "env", name: "ANALYTICS_DATABASE_URL" },
        },
      })
    }
    finally {
      if (typeof originalUrl === "undefined") delete process.env.ANALYTICS_DATABASE_URL
      else process.env.ANALYTICS_DATABASE_URL = originalUrl
    }
  })

  it("preserves an unresolved definition auth token for a remote URL", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_AUTH_TOKEN

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: 'libsql://definition.example.turso.io',",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.connection).toEqual({
        authToken: {
          kind: "env-variable",
          source: { kind: "env", name: "TURSO_AUTH_TOKEN" },
        },
        url: "libsql://definition.example.turso.io",
      })
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
    }
  })

  it("uses the local connection fallback when an env-only URL is unset", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_DATABASE_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.connection).toEqual({
        authToken: undefined,
        url: "file:.vitehub/data/database/sqlite.db",
      })
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("applies Nuxt D1 options to definitions without Cloudflare settings", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const resolved = resolveDBViteConfig({
      driver: "d1",
      databaseId: "remote-id",
      databaseName: "remote-name",
      cloudflare: { http: true },
    }, rootDir)

    expect(resolved?.databases.default.cloudflare).toMatchObject({
      databaseId: "remote-id",
      databaseName: "remote-name",
      http: true,
    })
  })

  it("uses Nuxt D1 values as fallbacks for partial Cloudflare definitions", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: "" })

    const resolved = resolveDBViteConfig({
      driver: "d1",
      databaseId: "remote-id",
      databaseName: "remote-name",
      migrationsTable: "__nuxt_migrations",
      previewDatabaseId: "preview-id",
      cloudflare: { http: true },
    }, rootDir)

    expect(resolved?.databases.default.cloudflare).toMatchObject({
      databaseId: "remote-id",
      databaseName: "remote-name",
      http: true,
      migrationsTable: "__nuxt_migrations",
      previewDatabaseId: "preview-id",
    })
  })

  it.each([
    { access: "build", field: "databaseId" },
    { access: "build", field: "databaseName" },
    { access: "definition", field: "databaseId" },
    { access: "definition", field: "databaseName" },
    { access: "registry", field: "databaseId" },
    { access: "registry", field: "databaseName" },
  ] as const)("keeps a one-field $field resource separate from host identifiers in $access configuration", async ({ access, field }) => {
    const rootDir = await createTempProject()
    const resource = field === "databaseId" ? { databaseId: "application-id" } : { databaseName: "application-name" }
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: `${field}: ${JSON.stringify(resource[field])},` })
    const resolved = resolveDBViteConfig({
      binding: "HOST_DB",
      cloudflare: { http: true },
      databaseId: "host-id",
      databaseName: "host-name",
      driver: "d1",
      previewDatabaseId: "host-preview-id",
    }, rootDir)!
    const definition = { cloudflare: resource, drizzle: {}, name: "default", schema: {} }
    const config = access === "build" ? resolved.databases.default
      : access === "definition" ? runtimeConfig(definition, resolved.definitionDefaults)
        : Function("definition", "resolveRuntimeCloudflareConfig", `return (${renderDatabaseConfigExpression("default", resolved, "definition")})`)(definition, resolveRuntimeCloudflareConfig)

    expect(config.cloudflare?.databaseId).toBe(resource.databaseId)
    expect(config.cloudflare?.databaseName).toBe(resource.databaseName)
    expect(config.cloudflare?.previewDatabaseId).toBeUndefined()
    if (access !== "build") expect(config.cloudflare?.binding).toBeUndefined()
  })

  it("preserves D1 HTTP credentials for a one-field URL override", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: "http: { url: 'https://application-proxy.example/raw' }," })
    const resolved = resolveDBViteConfig({
      cloudflare: { http: { authToken: "host-token", url: "https://host-proxy.example/raw" } },
      databaseId: "host-id",
      databaseName: "host-name",
      driver: "d1",
    }, rootDir)!
    const definition = { cloudflare: { http: { url: "https://application-proxy.example/raw" } }, drizzle: {}, name: "default", schema: {} }
    const expression = renderDatabaseConfigExpression("default", resolved, "definition")
    const registry = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)(definition, resolveRuntimeCloudflareConfig)
    for (const config of [resolved.databases.default, runtimeConfig(definition, resolved.definitionDefaults), registry]) {
      expect(config.cloudflare?.http).toEqual({ authToken: "host-token", url: "https://application-proxy.example/raw" })
    }
  })

  it("uses the binding for a name-only Definition after its own resource is provisioned", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: "databaseName: 'application-name'," })
    const provisionState = { cloudflare: { d1: { default: "application-id" } } }
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify(provisionState))
    const resolved = resolveDBViteConfig({ binding: "HOST_DB", databaseId: "host-id", databaseName: "host-name", driver: "d1" }, rootDir)!
    const definition = { cloudflare: { databaseName: "application-name" }, drizzle: {}, name: "default", schema: {} }
    const expression = renderDatabaseConfigExpression("default", resolved, "definition")
    const registry = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)(definition, resolveRuntimeCloudflareConfig)

    expect(resolved.databases.default?.cloudflare?.databaseId).toBe("application-id")
    expect(resolveCloudflareD1Bindings(resolved, { provisionState }).d1Databases).toMatchObject([{
      binding: "HOST_DB", database_id: "application-id", database_name: "application-name",
    }])
    expect(runtimeConfig(definition, resolved.definitionDefaults).cloudflare?.binding).toBe("HOST_DB")
    expect(registry.cloudflare?.binding).toBe("HOST_DB")
  })

  it("preserves explicit D1 HTTP proxy declarations without resolving their secrets", async () => {
    const rootDir = await createTempProject()
    const originalToken = process.env.D1_HTTP_TOKEN
    const originalUrl = process.env.D1_HTTP_URL
    delete process.env.D1_HTTP_TOKEN
    delete process.env.D1_HTTP_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        cloudflare: [
          "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
          "    http: {",
          "      authToken: process.env.D1_HTTP_TOKEN,",
          "      url: process.env.D1_HTTP_URL,",
          "    },",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.cloudflare).toMatchObject({
        http: {
          authToken: {
            kind: "env-variable",
            source: { kind: "env", name: "D1_HTTP_TOKEN" },
          },
          url: {
            kind: "env-variable",
            source: { kind: "env", name: "D1_HTTP_URL" },
          },
        },
      })
    }
    finally {
      if (typeof originalToken === "undefined") delete process.env.D1_HTTP_TOKEN
      else process.env.D1_HTTP_TOKEN = originalToken
      if (typeof originalUrl === "undefined") delete process.env.D1_HTTP_URL
      else process.env.D1_HTTP_URL = originalUrl
    }
  })

  it("preserves Runtime Env declarations for D1 HTTP proxy config", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: [
        "    databaseId: env({ source: env.source('CLOUDFLARE_D1_DATABASE_ID') }),",
        "    http: {",
        "      authToken: env({ secret: true, source: env.source('D1_HTTP_TOKEN') }),",
        "      url: env({ source: env.source(['D1_HTTP_URL', 'D1_PROXY_URL']) }),",
        "    },",
      ].join("\n"),
    })

    expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.cloudflare).toMatchObject({
      databaseId: {
        kind: "env-variable",
        source: { kind: "env", name: "CLOUDFLARE_D1_DATABASE_ID" },
      },
      http: {
        authToken: {
          kind: "env-variable",
          source: { kind: "env", name: "D1_HTTP_TOKEN" },
        },
        url: {
          kind: "env-variable",
          source: { kind: "env", name: "D1_HTTP_URL", names: ["D1_HTTP_URL", "D1_PROXY_URL"] },
        },
      },
    })
  })
})
