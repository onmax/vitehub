import { describe, expect, it, vi } from "vitest"

import { oauth2 } from "../src/providers/oauth2.ts"
import { expectCode, mockFetch, tokenSet } from "./helpers.ts"

import type { OAuth2ProviderOptions } from "../src/providers/oauth2.ts"

function options(overrides: Partial<OAuth2ProviderOptions> = {}): OAuth2ProviderOptions {
  return {
    authorizationUrl: "https://auth.example/authorize?existing=1",
    client: () => ({ clientId: "client id", clientSecret: { unseal: () => "secret:value" } }),
    scopes: ["read", "write"],
    tokenUrl: "https://auth.example/token",
    ...overrides,
  }
}

describe("oauth2", () => {
  it("validates required options", () => {
    expect(() => oauth2(options({ tokenUrl: "" }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(() => oauth2(options({ authorizationUrl: "" }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(() => oauth2(options({ scopes: [] }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(oauth2(options()).id).toBe("oauth2")
  })

  it("builds a PKCE authorization URL with extra parameters", async () => {
    const provider = oauth2(options({ authorizationParams: { prompt: "consent" } }))
    const url = new URL(await provider.authorizationUrl({ codeChallenge: "challenge", redirectUri: "https://app.example/cb", state: "state" }, { fetch: mockFetch(() => new Response(null)).fetch }))

    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client id",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      existing: "1",
      prompt: "consent",
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "read write",
      state: "state",
    })
  })

  it("passes the event to the client resolver and rejects a missing client id", async () => {
    const client = vi.fn((_context: { event?: unknown }) => ({ clientId: "" }))
    const provider = oauth2(options({ client }))
    const event = { id: "event" }

    await expectCode(provider.authorizationUrl({ codeChallenge: "c", redirectUri: "r", state: "s" }, { event, fetch: mockFetch(() => new Response(null)).fetch }), "CONNECTIONS_INVALID")
    expect(client).toHaveBeenCalledWith({ event })
  })

  it("uses HTTP basic client authentication when configured", async () => {
    const upstream = mockFetch(() => Response.json({ access_token: "new", expires_in: "120" }))
    const provider = oauth2(options({ clientAuth: "basic" }))

    const token = await provider.exchange({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/cb" }, { fetch: upstream.fetch })
    const call = upstream.mock.mock.calls[0]!
    const headers = new Headers(call[1]?.headers)
    expect(headers.get("authorization")).toBe(`Basic ${btoa("client%20id:secret%3Avalue")}`)
    expect(upstream.calls[0]!.body).not.toContain("client_secret")
    expect(token).toMatchObject({ accessToken: "new", scopes: ["read", "write"], tokenType: "Bearer" })
    expect(token.expiresAt).toBeGreaterThan(Date.now())
  })

  it("keeps the previous refresh token, scopes, and account on refresh", async () => {
    const upstream = mockFetch(() => Response.json({ access_token: "rotated", token_type: "bearer" }))
    const provider = oauth2(options())
    const previous = tokenSet()

    const token = await provider.refresh(previous, { fetch: upstream.fetch })
    expect(new URLSearchParams(upstream.calls[0]!.body)).toEqual(new URLSearchParams({ grant_type: "refresh_token", refresh_token: previous.refreshToken!, client_id: "client id", client_secret: "secret:value" }))
    expect(token).toEqual({ account: previous.account, accessToken: "rotated", refreshToken: previous.refreshToken, scopes: previous.scopes, tokenType: "bearer" })
  })

  it("maps token endpoint errors without exposing the body", async () => {
    const provider = oauth2(options())
    const invalid = mockFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }))
    const failed = mockFetch(() => new Response("upstream secret", { status: 500 }))

    await expectCode(provider.refresh(tokenSet(), { fetch: invalid.fetch }), "CONNECTIONS_NEEDS_RECONNECT")
    const error = await provider.refresh(tokenSet(), { fetch: failed.fetch }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED", details: { status: 500 } })
    expect(JSON.stringify(error)).not.toContain("upstream secret")
    await expectCode(provider.refresh(tokenSet({ refreshToken: undefined }), { fetch: invalid.fetch }), "CONNECTIONS_NEEDS_RECONNECT")
  })

  it("labels the account from user info", async () => {
    const upstream = mockFetch(url => url.pathname === "/token" ? Response.json({ access_token: "a", scope: "read,write" }) : Response.json({ login: "octo", sub: "1" }))
    const withSub = oauth2(options({ userInfoUrl: "https://auth.example/userinfo" }))
    const custom = oauth2(options({ account: info => typeof info.login === "string" ? info.login : undefined, userInfoUrl: "https://auth.example/userinfo" }))
    const input = { code: "c", codeVerifier: "v", redirectUri: "r" }

    expect(await withSub.exchange(input, { fetch: upstream.fetch })).toMatchObject({ account: "1", scopes: ["read", "write"] })
    expect(await custom.exchange(input, { fetch: upstream.fetch })).toMatchObject({ account: "octo" })
  })

  it("revokes the refresh token and accepts 400 responses", async () => {
    const upstream = mockFetch(() => new Response(null, { status: 400 }))
    const provider = oauth2(options({ revokeUrl: "https://auth.example/revoke" }))

    await provider.revoke!(tokenSet(), { fetch: upstream.fetch })
    expect(upstream.calls[0]).toMatchObject({ body: `token=${encodeURIComponent(tokenSet().refreshToken!)}`, method: "POST", url: "https://auth.example/revoke" })
    upstream.mock.mockImplementation(async () => new Response(null, { status: 503 }))
    await expectCode(provider.revoke!(tokenSet(), { fetch: upstream.fetch }), "CONNECTIONS_PROVIDER_FAILED")
    expect(oauth2(options()).revoke).toBeUndefined()
  })
})
