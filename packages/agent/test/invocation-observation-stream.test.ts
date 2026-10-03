import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"
import { createInvocationObservationStream } from "../src/internal/invocation-observation-stream.ts"

function observation(name: string, attributes: TraceEventLogEntry["attributes"] = {}): TraceEventLogEntry {
  return { name, attributes, sequence: 0, timestamp: "2026-10-03T00:00:00.000Z", type: "run" }
}

function delta(id: string, content: string): TraceEventLogEntry {
  return observation("agent.message.delta", { "message.id": id, "message.content": content })
}

function contentFor(entries: TraceEventLogEntry[], id: string) {
  return entries.filter(entry => entry.attributes?.["message.id"] === id)
    .map(entry => entry.attributes?.["message.content"] ?? "").join("")
}

describe("Invocation observation stream", () => {
  it.each(["finish", "error", "cancelled"])("flushes pending text before the %s outcome", (outcome) => {
    const entries: TraceEventLogEntry[] = []
    const stream = createInvocationObservationStream({ emit: entry => entries.push(entry), maxMessageDeltaCharacters: 128, maxMessageDeltaKeys: 8 })
    stream.append(delta("answer", "The result is ready."))
    expect(entries).toEqual([])

    stream.append(observation(`agent.invocation.${outcome}`))

    expect(entries.map(entry => entry.name)).toEqual(["agent.message.delta", `agent.invocation.${outcome}`])
    expect(contentFor(entries, "answer")).toBe("The result is ready.")
  })

  it("keeps credential continuations separate across reads, message identities, and tool events", () => {
    const entries: TraceEventLogEntry[] = []
    const stream = createInvocationObservationStream({ emit: entry => entries.push(entry), maxMessageDeltaCharacters: 128, maxMessageDeltaKeys: 8 })
    stream.append(delta("answer", "See postgres://alice"))
    stream.flush()
    stream.append(delta("commentary", "Working."))
    stream.append(observation("tool.call"))
    stream.append(delta("answer", ":hunter2@db.example/path"))
    stream.append(observation("agent.invocation.finish", { "result.text": "API_TOKEN=final-secret" }))

    expect(contentFor(entries, "answer")).toBe("See postgres://[REDACTED]@db.example/path")
    expect(contentFor(entries, "commentary")).toBe("Working.")
    expect(entries.findIndex(entry => entry.attributes?.["message.id"] === "commentary"))
      .toBeLessThan(entries.findIndex(entry => entry.name === "tool.call"))
    expect(entries.at(-1)?.attributes?.["result.text"]).toBe("API_TOKEN=[REDACTED]")
    expect(JSON.stringify(entries)).not.toMatch(/alice|hunter2|final-secret/)
  })

  it("keeps stream admission stable and reports truncation on the outcome", () => {
    const entries: TraceEventLogEntry[] = []
    const stream = createInvocationObservationStream({ emit: entry => entries.push(entry), maxMessageDeltaCharacters: 128, maxMessageDeltaKeys: 1 })
    stream.append(delta("answer", "Authorization: Bear"))
    stream.append(delta("overflow", "Authorization: Bear"))
    stream.flush()
    stream.append(delta("overflow", "er dropped-secret"))
    stream.append(delta("answer", "er retained-secret;status=ok"))
    stream.append(observation("agent.invocation.finish"))

    expect(contentFor(entries, "answer")).toBe("Authorization: Bearer [REDACTED];status=ok")
    expect(contentFor(entries, "overflow")).toBe("")
    expect(entries.filter(entry => entry.attributes?.["content.omitted"])).toHaveLength(1)
    expect(entries.at(-1)?.attributes?.["content.truncated"]).toBe(true)
    expect(JSON.stringify(entries)).not.toMatch(/dropped-secret|retained-secret/)
  })
})
