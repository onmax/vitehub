import { readFileSync } from "node:fs"

import { compile, createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it } from "vitest"

import { consoleScheduleRunDescription } from "../src/console/runtime/client/schedule-run"
import type { ConsoleScheduleRunView } from "../src/console/runtime/client/schedule-run"

const source = readFileSync(new URL("../src/console/runtime/components/console-definitions.vue", import.meta.url), "utf8")
// Render the actual record detail template without the page's navigation and network lifecycle.
const start = source.indexOf('<main v-else-if="selectedRecord"')
const template = source.slice(start, source.indexOf("</main>", start) + "</main>".length)
  .replace('v-else-if="selectedRecord"', 'v-if="selectedRecord"')

async function renderResult(selectedRun?: ConsoleScheduleRunView) {
  const app = createSSRApp({
    render: compile(template),
    setup: () => ({
      consoleScheduleRunDescription,
      recordColumns: [],
      records: [],
      sectionDetails: { view: { notice: "Schedule metadata" } },
      selectedName: "definition:nightly-digest",
      selectedRecord: { fields: [], id: "definition:nightly-digest" },
      selectedRun,
    }),
  })
  app.component("UAlert", defineComponent({
    props: { color: String, title: String, description: String },
    setup: props => () => h("div", { "data-color": props.color }, [props.title, props.description]),
  }))
  return renderToString(app)
}

it.each([
  [{ durationMs: 1250, id: "run_1", status: "succeeded" }, "success", "Run succeeded", "1.3s · run_1"],
  [{ error: "mailbox unavailable", status: "failed" }, "error", "Run failed", "mailbox unavailable"],
  [{ error: "Request failed", status: "unavailable" }, "error", "Could not run this Schedule", "Request failed"],
] satisfies [ConsoleScheduleRunView, string, string, string][])("renders a record Schedule result %j", async (run, color, title, description) => {
  const html = await renderResult(run)
  expect(html).toContain(`data-color="${color}"`)
  expect(html).toContain(title)
  expect(html).toContain(description)
  expect(html).not.toContain("Read-only records")
})

it("keeps the read-only notice until a record has a run result", async () => {
  const html = await renderResult()
  expect(html).toContain("Read-only records")
  expect(html).toContain("Schedule metadata")
})
