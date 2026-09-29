import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleDefinitions } from "./definitions.ts"
import { isConsoleSectionId } from "../sections.ts"

import type { ConsoleSectionContent } from "../definitions.ts"
import type { ConsoleSectionId } from "../sections.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: statusMessage }), { statusCode, statusMessage })
}

export default function consoleDefinitionsHandler(event: ConsoleRequestEvent): ConsoleSectionContent & {
  section: ConsoleSectionId
} {
  assertConsoleRequest(event)
  const section = consoleRequestURL(event).searchParams.get("section")
  if (!isConsoleSectionId(section)) {
    throw requestError(400, "A valid definition section is required.")
  }
  const catalog = getConsoleDefinitions().content
  const content = Object.hasOwn(catalog, section) ? catalog[section] : undefined
  if (!content) throw requestError(404, "Definition section not found.")
  return { ...content, section }
}
