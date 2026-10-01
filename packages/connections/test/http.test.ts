import { describe, expect, it, vi } from "vitest";

import { createConnectionsRuntime } from "../src/runtime.ts";
import { createConnectionsHandler } from "../src/http.ts";
import { ACCESS_TOKEN, createTestRuntime, REFRESH_TOKEN, mailConnection } from "./helpers.ts";

const origin = "http://localhost:5173";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/_vitehub/connections`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, ...headers },
    method: "POST",
  });
}

describe("createConnectionsHandler", () => {
  it.each([
    undefined,
    () => undefined,
    () => "agent:worker",
    () => "user:",
    () => "user:bad identity",
  ])("denies every route without a valid authenticated management user (%s)", async (actor) => {
    const getRuntime = vi.fn(() => createTestRuntime().runtime);
    const handler = createConnectionsHandler({ actor, runtime: getRuntime });
    for (const request of [
      post({ action: "list" }),
      post({ action: "revoke", name: "mail" }),
      post({ action: "approve", id: "approval_1" }),
      new Request(`${origin}/_vitehub/connections/connect/mail`),
      new Request(`${origin}/_vitehub/connections/callback?state=state&code=code`, {
        headers: { cookie: "vitehub_connection_state=state" },
      }),
    ]) {
      expect((await handler(request)).status).toBe(403);
    }
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it.each(["team/mail", "n".repeat(129)])("manages discovered names through JSON and web authorization (%s)", async (name) => {
    const test = createTestRuntime();
    const runtime = createConnectionsRuntime({
      definitions: { [name]: mailConnection() },
      fetch: test.provider.fetch,
      store: test.store,
    });
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => runtime });
    const inspect = await handler(post({ action: "inspect", name }));
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ connection: { name } });
    const start = await handler(new Request(`${origin}/_vitehub/connections/connect/${encodeURIComponent(name)}`));
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location")!).searchParams.get("state")).toBeTruthy();
    expect((await handler(post({ action: "inspect", name: "team//mail" }))).status).toBe(400);
  });

  it("runs JSON actions for same-origin requests", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    const response = await handler(post({ action: "list" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connections: [{ name: "mail", provider: "example", status: "disconnected" }],
    });
  });

  it("rejects cross-origin, non-JSON, and invalid requests", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    expect(
      (await handler(post({ action: "list" }, { origin: "https://attacker.example.com" }))).status,
    ).toBe(403);
    expect(
      (await handler(post({ action: "list" }, { "sec-fetch-site": "cross-site" }))).status,
    ).toBe(403);
    expect((await handler(post({ action: "list" }, { "content-type": "text/plain" }))).status).toBe(
      403,
    );
    expect((await handler(post({ action: "drop" }))).status).toBe(400);
    expect((await handler(new Request(`${origin}/_vitehub/connections`))).status).toBe(405);
  });

  it("maps Connection errors to HTTP statuses", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    const response = await handler(post({ action: "inspect", name: "missing" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_INVALID" } });
    expect((await handler(post({ action: "approve", id: "approval_missing" }))).status).toBe(400);
  });

  it("completes the web authorization flow with a state cookie", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:owner",
      runtime: () => test.runtime,
    });
    const start = await handler(new Request(`${origin}/_vitehub/connections/connect/mail`));
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${origin}/_vitehub/connections/callback`,
    );
    const state = location.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toContain(`vitehub_connection_state=${state}`);
    expect(cookie).toContain("HttpOnly");

    const mismatch = await handler(
      new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`),
    );
    expect(mismatch.status).toBe(400);

    test.provider.tokenResponses.push({
      body: {
        access_token: ACCESS_TOKEN,
        expires_in: 3600,
        id_token: "account-1",
        refresh_token: REFRESH_TOKEN,
        scope: "mail.modify",
      },
    });
    const callback = await handler(
      new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`, {
        headers: { cookie: `vitehub_connection_state=${state}` },
      }),
    );
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain(ACCESS_TOKEN);
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" });
    const activity = await test.runtime.activity({ name: "mail" });
    expect(activity.find((entry) => entry.action === "replace")).toMatchObject({
      actor: { id: "owner", kind: "user" },
    });
  });
});
