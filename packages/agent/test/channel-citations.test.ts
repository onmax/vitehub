import { describe, expect, it } from "vitest";
import {
  formatChannelCitationMessage,
  formatChannelCitationStream,
  formatChannelCitationText,
} from "../src/internal/channel-citations.ts";

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe("Chat SDK citation delivery", () => {
  const input =
    "Yes. citeturn228505view0turn395856view0 See [the PR](https://github.com/acme/portal/pull/1188).";
  const expected =
    "Yes. [source link unavailable] See [the PR](https://github.com/acme/portal/pull/1188).";

  it("keeps the answer and verified link without inventing a URL for opaque IDs", () => {
    expect(formatChannelCitationText(input)).toBe(expected);
    expect(formatChannelCitationText("citeturn0search0citeturn1view0L8-L13")).toBe(
      "[source link unavailable][source link unavailable]",
    );
  });

  it("produces the same delivered answer for every two-chunk split", async () => {
    for (let split = 0; split <= input.length; split++) {
      const chunks = (async function* () {
        yield input.slice(0, split);
        yield input.slice(split);
      })();
      expect(await collect(formatChannelCitationStream(chunks))).toBe(expected);
    }
  });

  it("labels a citation truncated at the end of a completed stream", async () => {
    const chunks = (async function* () {
      yield "Answer. cite";
      yield "turn0view0";
    })();
    expect(await collect(formatChannelCitationStream(chunks))).toBe(
      "Answer. [source link unavailable]",
    );
  });

  it("does not leak a native marker prefix when generation ends halfway through it", async () => {
    const marker = "citeturn0view0";
    for (let end = 1; end < marker.length; end++) {
      const truncated = `Answer. ${marker.slice(0, end)}`;
      const expected = "Answer. [source link unavailable]";
      expect(formatChannelCitationText(truncated)).toBe(expected);
      const chunks = (async function* () {
        for (const character of truncated) yield character;
      })();
      expect(await collect(formatChannelCitationStream(chunks))).toBe(expected);
    }
  });

  it("preserves ordinary Markdown, code, Unicode, and message attachments", () => {
    const markdown =
      "**Résumé**\n\n```css\n.rgh-filter { display: none; }\n```\n\n[Source](https://example.com)";
    expect(formatChannelCitationText(markdown)).toBe(markdown);
    const files = [{ filename: "report.txt", data: Buffer.from("report") }];
    expect(formatChannelCitationMessage({ markdown: input, files })).toEqual({
      markdown: expected,
      files,
    });
    expect(formatChannelCitationMessage({ raw: input })).toEqual({ raw: expected });
    expect(formatChannelCitationMessage({ text: input })).toEqual({ text: expected });
  });
});
