import { afterEach, describe, expect, it, vi } from "vitest"

import { anthropic, cliproxy, defineGateway, litellm, ollama, openai, openrouter, vercel } from "../src/gateways.ts"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { resolveAgentDriverGateway } from "../src/internal/agent-gateway.ts"

const context = { purpose: "inspection" } as never

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("gateway presets", () => {
  it("maps each preset to the base URL that each Driver expects", () => {
    expect(cliproxy({ url: "https://proxy.example/v1/" }).baseURL).toEqual({ "codex": "https://proxy.example/v1", "claude-code": "https://proxy.example" })
    expect(litellm({ url: "http://litellm:4000" }).baseURL).toEqual({ "codex": "http://litellm:4000/v1", "claude-code": "http://litellm:4000" })
    expect(ollama().baseURL).toEqual({ "codex": "http://localhost:11434/v1", "claude-code": "http://localhost:11434" })
    expect(openrouter().baseURL).toEqual({ "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api" })
    expect(vercel().baseURL).toEqual({ "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code" })
    expect(openai().baseURL).toEqual({ codex: "https://api.openai.com/v1" })
    expect(anthropic().baseURL).toEqual({ "claude-code": "https://api.anthropic.com" })
  })

  it("requires a URL for hosted gateways", () => {
    expect(() => cliproxy({ url: " " })).toThrow("cliproxy({ url })")
    // SAFETY: This fixture omits the required option to test runtime validation.
    expect(() => litellm(undefined as never)).toThrow("litellm({ url })")
  })

  it("validates custom gateways", () => {
    expect(() => defineGateway({ name: "x", baseURL: {} })).toThrow('must set a baseURL for "codex" or "claude-code"')
    expect(() => defineGateway({ name: "x", baseURL: { codex: "ftp://proxy" }, apiKey: "k" })).toThrow("http or https URL")
    expect(() => defineGateway({ name: "x", baseURL: { codex: "https://proxy" } })).toThrow("needs apiKey or apiKeyEnv")
    expect(() => defineGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", headers: { "bad header": "v" } })).toThrow("not a valid HTTP header name")
    expect(() => defineGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", headers: { Authorization: "v" } })).toThrow("sets the API key with apiKey")
    // SAFETY: This fixture supplies an unknown option to test runtime validation.
    expect(() => defineGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", url: "https://proxy" } as never)).toThrow("does not support: url")
  })
})

describe("gateway resolution", () => {
  it("selects a generated Codex provider and keeps secrets out of the arguments", async () => {
    const gateway = cliproxy({
      url: "https://proxy.example",
      apiKey: { unseal: () => "proxy-key" },
      headers: { "CF-Access-Client-Id": "client-id", "CF-Access-Client-Secret": async () => "client-secret" },
    })

    const resolved = await resolveAgentDriverGateway(gateway, "codex", context)

    expect(resolved.environment).toEqual({
      VITEHUB_GATEWAY_API_KEY: "proxy-key",
      VITEHUB_GATEWAY_HEADER_0: "client-id",
      VITEHUB_GATEWAY_HEADER_1: "client-secret",
    })
    expect(resolved.launchArgs).toBe([
      '-c "model_provider=\\"vitehub\\""',
      '-c "model_providers.vitehub.name=\\"cliproxy\\""',
      '-c "model_providers.vitehub.base_url=\\"https://proxy.example/v1\\""',
      '-c "model_providers.vitehub.wire_api=\\"responses\\""',
      '-c "model_providers.vitehub.env_key=\\"VITEHUB_GATEWAY_API_KEY\\""',
      '-c "model_providers.vitehub.env_http_headers={\\"CF-Access-Client-Id\\"=\\"VITEHUB_GATEWAY_HEADER_0\\",\\"CF-Access-Client-Secret\\"=\\"VITEHUB_GATEWAY_HEADER_1\\"}"',
    ].join(" "))
    expect(resolved.launchArgs).not.toContain("proxy-key")
    expect(resolved.launchArgs).not.toContain("client-secret")
  })

  it("sends an x-api-key gateway key as a Codex header", async () => {
    const gateway = defineGateway({ name: "keyed", baseURL: { codex: "https://keyed.example/v1" }, apiKey: "k", auth: "x-api-key" })
    const resolved = await resolveAgentDriverGateway(gateway, "codex", context)
    expect(resolved.launchArgs).not.toContain("env_key")
    expect(resolved.launchArgs).toContain('env_http_headers={\\"x-api-key\\"=\\"VITEHUB_GATEWAY_API_KEY\\"}')
  })

  it("sets the Claude Code gateway environment", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "vercel-key")
    expect(await resolveAgentDriverGateway(vercel({ headers: { "X-Team": "quiver" } }), "claude-code", context)).toEqual({
      environment: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "vercel-key",
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code",
        ANTHROPIC_CUSTOM_HEADERS: "X-Team: quiver",
      },
    })
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key")
    expect((await resolveAgentDriverGateway(anthropic(), "claude-code", context)).environment).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "",
    })
  })

  it("reads the preset key variable and names it when it is missing", async () => {
    vi.stubEnv("CLIPROXY_API_KEY", "")
    await expect(resolveAgentDriverGateway(cliproxy({ url: "https://proxy.example" }), "codex", context)).rejects.toThrow("Set CLIPROXY_API_KEY, or pass apiKey")
    vi.stubEnv("CLIPROXY_API_KEY", "env-key")
    expect((await resolveAgentDriverGateway(cliproxy({ url: "https://proxy.example" }), "codex", context)).environment.VITEHUB_GATEWAY_API_KEY).toBe("env-key")
    expect((await resolveAgentDriverGateway(ollama(), "claude-code", context)).environment.ANTHROPIC_AUTH_TOKEN).toBe("ollama")
  })

  it("fails an explicit undefined key instead of using the preset variable", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-key")
    const optionalKey: string | undefined = undefined
    await expect(resolveAgentDriverGateway(vercel({ apiKey: optionalKey }), "codex", context)).rejects.toThrow('Gateway "vercel" apiKey resolved to an empty value')
    await expect(resolveAgentDriverGateway(ollama({ apiKey: optionalKey }), "codex", context)).rejects.toThrow('Gateway "ollama" apiKey resolved to an empty value')
    const header = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: { "CF-Access-Client-Id": optionalKey } })
    await expect(resolveAgentDriverGateway(header, "codex", context)).rejects.toThrow('header "CF-Access-Client-Id" resolved to an empty value')
  })

  it("rejects empty header values instead of letting Codex drop them", async () => {
    const gateway = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: { "CF-Access-Client-Id": () => undefined } })
    await expect(resolveAgentDriverGateway(gateway, "codex", context)).rejects.toThrow('header "CF-Access-Client-Id" resolved to an empty value')
  })
})

describe("driver.gateway", () => {
  it("replaces inherited Codex credentials and reports the gateway", () => {
    const parent = defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}" } })
    const agent = defineAgent({ extends: parent, name: "dev", driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }) } })
    const metadata = createAgentInspectionMetadata(agent).config?.driver
    expect(metadata?.provider).toMatchObject({ gateway: "cliproxy" })
    expect(metadata?.provider).not.toHaveProperty("credentials")
    expect(metadata?.executionAuthority.credentials).toBe("provisioned")
  })

  it("skips credential-only rules for credentials that a gateway replaces", () => {
    const parent = defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}", credentialProfile: "stable" } })
    expect(() => defineAgent({
      extends: parent,
      name: "dev",
      driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }), providerSettings: { shadowHomePath: "/tmp/codex" }, env: { CODEX_HOME: "/tmp/codex" } },
    })).not.toThrow()
    const child = defineAgent({ extends: defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}" } }), name: "dev", driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }), sessionStorePath: ".vitehub/sessions.db" } })
    expect(createAgentInspectionMetadata(child).config?.driver.provider).toMatchObject({ gateway: "cliproxy", sessionStore: "sqlite" })
  })

  it("rejects a gateway that does not serve the Driver", () => {
    expect(() => defineAgent({ driver: { kind: "claude-code", gateway: openai() } })).toThrow('Gateway "openai" does not serve the claude-code Driver')
  })

  it("rejects driver.env values that the gateway owns", () => {
    expect(() => normalizeAgentDriver({
      driver: { kind: "claude-code", env: { ANTHROPIC_BASE_URL: "https://other.example" }, gateway: vercel() },
    })).toThrow("driver.gateway }) sets ANTHROPIC_BASE_URL")
  })

  it("is not accepted by model drivers", () => {
    // SAFETY: This fixture sets a provider-only option on a model Driver to test runtime validation.
    expect(() => defineAgent({ driver: { model: "openai/gpt-5", gateway: vercel() } } as never)).toThrow()
  })
})
