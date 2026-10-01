import { readViteHubDevTokenActive, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../dev.ts"
import { handleScheduleDevRequest as handleAuthorizedScheduleDevRequest } from "./console.ts"

/** Node-only authentication for the development-only Nitro Schedule route. */
export async function handleScheduleDevRequest(request: Request, options: { rootDir?: string } = {}): Promise<Response> {
  const rootDir = options.rootDir ?? process.cwd()
  return await handleAuthorizedScheduleDevRequest(request, { authorize: async request => {
    const serverId = request.headers.get(scheduleDevTokenServerHeader)
    const token = request.headers.get(viteHubDevTokenHeader)
    if (!serverId || !token) return false
    const active = await readViteHubDevTokenActive(rootDir, scheduleDevTokenNamespace)
    return active?.serverId === serverId && active.token === token
  } })
}
