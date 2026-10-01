import { handleConsoleConnections } from "./connections.ts"

// Pass the whole event, so the Connections runtime can read host bindings such as Cloudflare env.
export default function handler(event: { req: Request }): Promise<Response> {
  return handleConsoleConnections(event.req, event)
}
