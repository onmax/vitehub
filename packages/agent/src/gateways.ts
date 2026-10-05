import { agentDiagnostics } from "./agent-diagnostics.ts"
import { normalizeAgentDriverGateway } from "./internal/agent-gateway.ts"
import type { AgentDriverGateway, AgentProviderCredentialResolver } from "./types.ts"

export type { AgentDriverGateway } from "./types.ts"

/** Options shared by every gateway preset. */
export interface AgentGatewayPresetOptions {
  /** API key. When it is not set, the preset reads its documented environment variable. */
  apiKey?: AgentProviderCredentialResolver
  /** Extra request headers, such as Cloudflare Access service-token headers. */
  headers?: Record<string, AgentProviderCredentialResolver>
}

/** Options for a gateway that you host. */
export interface AgentHostedGatewayOptions extends AgentGatewayPresetOptions {
  /** Origin of the gateway, such as `https://proxy.example.com`. A trailing `/v1` is removed. */
  url: string
}

function origin(url: string, label: string): string {
  if (typeof url !== "string" || !url.trim()) throw agentDiagnostics.AGENT_R0975({ message: `[vitehub] ${label}({ url }) must be a non-empty URL.` })
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function preset(gateway: AgentDriverGateway, options: AgentGatewayPresetOptions | undefined): AgentDriverGateway {
  return defineGateway({
    ...gateway,
    ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
  })
}

/** Validate a custom gateway. Use it for an endpoint without a preset. */
export function defineGateway(gateway: AgentDriverGateway): AgentDriverGateway {
  return normalizeAgentDriverGateway(gateway)
}

/** [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Serves Codex and Claude Code. Reads `CLIPROXY_API_KEY`. */
export function cliproxy(options: AgentHostedGatewayOptions): AgentDriverGateway {
  const url = origin(options?.url, "cliproxy")
  return preset({ name: "cliproxy", baseURL: { "codex": `${url}/v1`, "claude-code": url }, apiKeyEnv: ["CLIPROXY_API_KEY"] }, options)
}

/** [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy). Serves Codex and Claude Code. Reads `LITELLM_API_KEY`. */
export function litellm(options: AgentHostedGatewayOptions): AgentDriverGateway {
  const url = origin(options?.url, "litellm")
  return preset({ name: "litellm", baseURL: { "codex": `${url}/v1`, "claude-code": url }, apiKeyEnv: ["LITELLM_API_KEY"] }, options)
}

/** [Ollama](https://docs.ollama.com). Serves Codex and Claude Code. Defaults to `http://localhost:11434` and reads `OLLAMA_API_KEY` when set. */
export function ollama(options: Partial<AgentHostedGatewayOptions> = {}): AgentDriverGateway {
  const url = origin(options.url ?? "http://localhost:11434", "ollama")
  return preset({
    name: "ollama",
    baseURL: { "codex": `${url}/v1`, "claude-code": url },
    // A local server does not check the key, but both CLIs need one to skip their own sign-in.
    apiKey: () => process.env.OLLAMA_API_KEY?.trim() || "ollama",
  }, options)
}

/** [OpenRouter](https://openrouter.ai/docs). Serves Codex and Claude Code. Reads `OPENROUTER_API_KEY`. */
export function openrouter(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({
    name: "openrouter",
    baseURL: { "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api" },
    apiKeyEnv: ["OPENROUTER_API_KEY"],
  }, options)
}

/** [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/coding-agents). Serves Codex and Claude Code. Reads `AI_GATEWAY_API_KEY`. */
export function vercel(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({
    name: "vercel",
    baseURL: { "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code" },
    apiKeyEnv: ["AI_GATEWAY_API_KEY"],
  }, options)
}

/** The OpenAI API with an API key. Serves Codex. Reads `OPENAI_API_KEY`. */
export function openai(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({ name: "openai", baseURL: { codex: "https://api.openai.com/v1" }, apiKeyEnv: ["OPENAI_API_KEY"] }, options)
}

/** The Anthropic API with an API key. Serves Claude Code. Reads `ANTHROPIC_API_KEY`. */
export function anthropic(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({
    name: "anthropic",
    baseURL: { "claude-code": "https://api.anthropic.com" },
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    auth: "x-api-key",
  }, options)
}
