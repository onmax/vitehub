import { describe, expect, it } from "vitest"

import { decide, envActor, matchesPattern } from "../src/policy.ts"
import { mailConnection } from "./helpers.ts"

describe("Connection access", () => {
  it("matches exact actions and trailing namespace patterns", () => {
    expect(matchesPattern("mail.messages.modify", "mail.messages.*")).toBe(true)
    expect(matchesPattern("mail.messages.modify", "mail.messages")).toBe(false)
    expect(matchesPattern("mail.messages.modify", "*")).toBe(true)
    expect(matchesPattern("mailxmessagesxmodify", "mail.messages.modify")).toBe(false)
    expect(matchesPattern("aab", "a+b")).toBe(false)
    expect(matchesPattern("a+b", "a+b")).toBe(true)
  })

  it("maps explicit actors to audited Env actors", () => {
    expect(envActor("agent:triage")).toEqual({ id: "triage", kind: "agent" })
    expect(envActor("user:owner")).toEqual({ id: "owner", kind: "user" })
    expect(envActor("route:POST /api/labels")).toEqual({ id: "route:POST /api/labels", kind: "service" })
  })

  it("does not give Agents another actor's authority", () => {
    const definition = mailConnection({ server: { read: true, write: ["mail.messages.modify"] } })
    const action = { action: "mail.messages.modify", definition, highRisk: false, write: true }
    expect(decide({ ...action, actor: "server" })).toBe("allow")
    expect(decide({ ...action, actor: "agent:triage" })).toBe("deny")
    expect(decide({ ...action, actor: "agent:triage", approved: true })).toBe("deny")
  })

  it("requires Agent approval and preserves denial after approval", () => {
    const definition = mailConnection({ "agent:triage": { read: true, write: ["mail.messages.modify"] } })
    const action = { action: "mail.messages.modify", actor: "agent:triage", definition, highRisk: false, write: true }
    expect(decide(action)).toBe("approve")
    expect(decide({ ...action, approved: true })).toBe("allow")
    expect(decide({ ...action, action: "mail.messages.send", highRisk: true, approved: true })).toBe("deny")
  })

  it("requires exact high-risk and raw-fetch write authority", () => {
    const definition = mailConnection({ server: { read: true, write: true } })
    expect(decide({ action: "mail.messages.send", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
    expect(decide({ action: "fetch", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
  })
})
