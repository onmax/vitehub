import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pagePath = resolve(
  import.meta.dirname,
  "../content/docs/agents/capabilities/index.md",
);

describe("Eve extension documentation", () => {
  it("keeps the manifest and runtime boundary visible", () => {
    const page = readFileSync(pagePath, "utf8");

    expect(page).toContain("config@1");
    expect(page).toContain("tool@54");
    expect(page).toContain("dynamicTool@52");
    expect(page).toContain("`turn.started`");
    expect(page).toContain("`getSandbox()`");
    expect(page).toContain("Session authentication fields remain `null`");
    expect(page).toContain("@github-tools/eve-extension@0.8.0 eve@0.72.1");
    expect(page).toContain("one active `session.started`, `turn.started`, or `step.started`");
    expect(page).toContain("`step.started` does not run before every model step");
    expect(page).toContain("Eve skill contributions are not mounted");
  });
});
