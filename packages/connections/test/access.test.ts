import { describe, expect, it } from "vitest"

import { connectionAccessRule, decideConnectionAccess, matchesConnectionPattern } from "../src/access.ts"
import { resolveConnectionActor, routeConnectionActor, serverConnectionActor } from "../src/actor.ts"

import type { ConnectionAccess, ConnectionActor } from "../src/types.ts"

const read = { effect: "read", id: "gmail.messages.list" } as const
const write = { effect: "write", id: "gmail.messages.modify" } as const
const agent: ConnectionActor = { id: "triage", kind: "agent" }
const route: ConnectionActor = { id: "POST /api/labels/:id", kind: "route" }

describe("matchesConnectionPattern", () => {
  it("matches exact ids and globs across dots", () => {
    expect(matchesConnectionPattern(["gmail.messages.list"], "gmail.messages.list")).toBe(true)
    expect(matchesConnectionPattern(["gmail.*"], "gmail.messages.list")).toBe(true)
    expect(matchesConnectionPattern(["*"], "anything.at.all")).toBe(true)
    expect(matchesConnectionPattern(["gmail.*.list"], "gmail.labels.list")).toBe(true)
    expect(matchesConnectionPattern(["*.list"], "gmail.labels.get")).toBe(false)
    expect(matchesConnectionPattern(["gmail.messages"], "gmail.messages.list")).toBe(false)
  })

  it("treats regular expression characters as literals", () => {
    expect(matchesConnectionPattern(["gmail.labels.get"], "gmailxlabelsxget")).toBe(false)
    expect(matchesConnectionPattern(["a+b"], "aab")).toBe(false)
    expect(matchesConnectionPattern(["a+b"], "a+b")).toBe(true)
    expect(matchesConnectionPattern(["(x)|y"], "y")).toBe(false)
    expect(matchesConnectionPattern(["fetch.[get]"], "fetch.g")).toBe(false)
  })

  it("does not match without patterns", () => {
    expect(matchesConnectionPattern(undefined, "gmail.messages.list")).toBe(false)
    expect(matchesConnectionPattern([], "gmail.messages.list")).toBe(false)
  })
})

describe("connectionAccessRule", () => {
  const access: ConnectionAccess = {
    agents: { triage: { allow: ["agent.*"] } },
    routes: { "POST /api/labels/:id": { allow: ["route.*"] } },
    server: { allow: ["server.*"] },
  }

  it("uses the Agent rule only for Agents", () => {
    expect(connectionAccessRule(access, agent)).toEqual({ allow: ["agent.*"] })
    expect(connectionAccessRule(access, { id: "other", kind: "agent" })).toBeUndefined()
  })

  it("uses the route rule, then the server rule, for routes", () => {
    expect(connectionAccessRule(access, route)).toEqual({ allow: ["route.*"] })
    expect(connectionAccessRule(access, { id: "GET /api/other", kind: "route" })).toEqual({ allow: ["server.*"] })
  })

  it("uses the server rule for other actors", () => {
    for (const kind of ["schedule", "service", "user"] as const) {
      expect(connectionAccessRule(access, { id: "x", kind })).toEqual({ allow: ["server.*"] })
    }
    expect(connectionAccessRule(undefined, serverConnectionActor)).toBeUndefined()
  })
})

describe("decideConnectionAccess", () => {
  it("allows reads and denies writes without a rule", () => {
    expect(decideConnectionAccess(undefined, serverConnectionActor, read)).toBe("allow")
    expect(decideConnectionAccess(undefined, serverConnectionActor, write)).toBe("deny")
    expect(decideConnectionAccess({ server: { allow: ["other.*"] } }, serverConnectionActor, write)).toBe("deny")
  })

  it("applies deny, then approve, then allow", () => {
    const all = { allow: ["gmail.*"], approve: ["gmail.messages.*"], deny: ["gmail.messages.modify"] }
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, write)).toBe("deny")
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, read)).toBe("require-approval")
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, { effect: "write", id: "gmail.labels.create" })).toBe("allow")
  })

  it("denies reads that match a deny pattern", () => {
    expect(decideConnectionAccess({ server: { deny: ["gmail.messages.*"] } }, serverConnectionActor, read)).toBe("deny")
  })

  it("does not give Agents the server rule", () => {
    const access: ConnectionAccess = { server: { allow: ["*"] } }
    expect(decideConnectionAccess(access, serverConnectionActor, write)).toBe("allow")
    expect(decideConnectionAccess(access, agent, write)).toBe("deny")
    expect(decideConnectionAccess(access, agent, read)).toBe("allow")
    expect(decideConnectionAccess({ ...access, agents: { triage: { allow: ["gmail.messages.*"] } } }, agent, write)).toBe("allow")
  })

  it("gives routes without their own rule the server rule", () => {
    const access: ConnectionAccess = { routes: { "POST /api/labels/:id": { deny: ["*"] } }, server: { allow: ["*"] } }
    expect(decideConnectionAccess(access, route, read)).toBe("deny")
    expect(decideConnectionAccess(access, { id: "POST /api/other", kind: "route" }, write)).toBe("allow")
  })
})

describe("Connection actors", () => {
  it("uses the matched route pattern of an H3 event", () => {
    expect(routeConnectionActor({ context: { matchedRoute: { route: "/api/labels/:id" } }, method: "post", path: "/api/labels/1" }))
      .toEqual({ id: "POST /api/labels/:id", kind: "route" })
  })

  it("uses the request path without the query when no route matched", () => {
    expect(routeConnectionActor({ method: "GET", path: "/api/labels?secret=1" })).toEqual({ id: "GET /api/labels", kind: "route" })
    expect(routeConnectionActor({ req: { method: "PUT", url: "http://localhost/api/x?y=1" } })).toEqual({ id: "PUT /api/x", kind: "route" })
    expect(routeConnectionActor({ req: { method: "DELETE" }, url: new URL("https://app.example/api/z?q=1") })).toEqual({ id: "DELETE /api/z", kind: "route" })
  })

  it("returns no route actor for events without a method or path", () => {
    expect(routeConnectionActor(undefined)).toBeUndefined()
    expect(routeConnectionActor({ path: "/api" })).toBeUndefined()
    expect(routeConnectionActor({ method: "GET" })).toBeUndefined()
  })

  it("prefers an explicit actor, then the route, then the server", () => {
    expect(resolveConnectionActor({ actor: agent, event: { method: "GET", path: "/x" } })).toBe(agent)
    expect(resolveConnectionActor({ event: { method: "GET", path: "/x" } })).toEqual({ id: "GET /x", kind: "route" })
    expect(resolveConnectionActor({})).toBe(serverConnectionActor)
  })
})
