import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleInvocationUrl, resolvePublicUrl } from "../src/index.ts"

describe("public URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("falls back to the request origin when no public URL is configured", () => {
    expect(resolvePublicUrl({ agentName: "bot" })).toBeUndefined()
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "http://localhost:3000/api" } })).toBe("http://localhost:3000")
  })

  it("prefers the Agent origin, then the deployment origin, then a configured origin for the request host", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { bot: "https://agent.example.com", "bot-dev": "https://agent-dev.example.com" } })
    expect(resolvePublicUrl({ agentName: "bot" })).toBe("https://agent.example.com")
    expect(resolvePublicUrl({ agentName: "other" })).toBeUndefined()
    expect(resolvePublicUrl({ request: { url: "http://agent-dev.example.com/api/auth" } })).toBe("https://agent-dev.example.com")
    expect(resolvePublicUrl({ request: { url: "http://10.0.0.1:3000/api/auth" } })).toBe("http://10.0.0.1:3000")

    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://agents.example.com" })
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "http://10.0.0.1:3000/" } })).toBe("https://agents.example.com")
  })

  it("builds one Console invocation URL with the application base path", () => {
    expect(consoleInvocationUrl("https://agents.example.com", "team/support", "a/b")).toBe(
      "https://agents.example.com/_vitehub/agents/~007400650061006d002f0073007500700070006f00720074/invocations/a%2Fb",
    )
    vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
    expect(consoleInvocationUrl("https://agents.example.com", "bot", "id")).toBe("https://agents.example.com/portal/_vitehub/agents/bot/invocations/id")
  })
})
