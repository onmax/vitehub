import { isAsyncIterable } from "./stream-result.ts";
import type { AgentChatMessage } from "../types.ts";

const citationStart = "\uE200cite\uE202";
const citationEnd = "\uE201";
const unavailableCitation = "[source link unavailable]";

// Codex app-server supplies text and search actions, not a citation-ID-to-URL map.
// Keep ordinary links; label native references without guessing their sources.
function createCitationFormatter() {
  let pending = "";
  let insideCitation = false;
  return (chunk: string, final = false): string => {
    pending += chunk;
    let output = "";
    while (pending) {
      if (insideCitation) {
        const end = pending.indexOf(citationEnd);
        if (end === -1) {
          pending = "";
          break;
        }
        output += unavailableCitation;
        pending = pending.slice(end + citationEnd.length);
        insideCitation = false;
        continue;
      }
      const start = pending.indexOf(citationStart);
      if (start !== -1) {
        output += pending.slice(0, start);
        pending = pending.slice(start + citationStart.length);
        insideCitation = true;
        continue;
      }
      let held = 0;
      if (!final) {
        for (let length = 1; length < citationStart.length; length++) {
          if (pending.endsWith(citationStart.slice(0, length))) held = length;
        }
      }
      output += pending.slice(0, pending.length - held);
      pending = pending.slice(pending.length - held);
      break;
    }
    if (final && insideCitation) {
      output += unavailableCitation;
      insideCitation = false;
    }
    return output;
  };
}

export function formatChannelCitationText(text: string): string {
  return createCitationFormatter()(text, true);
}

export async function* formatChannelCitationStream(
  stream: AsyncIterable<string>,
): AsyncIterable<string> {
  const format = createCitationFormatter();
  for await (const chunk of stream) {
    const text = format(chunk);
    if (text) yield text;
  }
  const remaining = format("", true);
  if (remaining) yield remaining;
}

export function formatChannelCitationMessage(message: AgentChatMessage): AgentChatMessage {
  if (typeof message === "string") return formatChannelCitationText(message);
  if (isAsyncIterable(message)) {
    // SAFETY: AgentChatMessage streams yield string chunks at this delivery boundary.
    return formatChannelCitationStream(message as AsyncIterable<string>);
  }
  if ("markdown" in message)
    return { ...message, markdown: formatChannelCitationText(message.markdown) };
  if ("raw" in message) return { ...message, raw: formatChannelCitationText(message.raw) };
  if ("text" in message) return { ...message, text: formatChannelCitationText(message.text) };
  return message;
}
