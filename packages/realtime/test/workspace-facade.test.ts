import { expect, it } from "vitest";
import { defineWorkspace, useWorkspace } from "@vite-hub/workspace";
import { registerWorkspace } from "@vite-hub/workspace/test";
import { readRealtimeWorkspaceDocument } from "../src/server.ts";

it("opens a new collaborative document through real memory Workspace facades", async () => {
  const name = "realtime-new-memory-document";
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" }, rules: { "/**": { write: true, mediaType: "text/markdown" } } }));
  const readable = useWorkspace(name);
  const writable = useWorkspace(name, { mode: "write" });
  await expect(readRealtimeWorkspaceDocument(readable, writable, "guides/new.md")).resolves.toEqual({ baselineDigest: undefined, markdown: "" });
});
