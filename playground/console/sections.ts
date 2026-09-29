/**
 * Section descriptors that the Workflow, Queue, and Email owner packages contribute. The playground serves them without a build.
 * `packages/vite-hub/test/console-contributions.test.ts` keeps them equal to the owner descriptors.
 */
export const playgroundConsoleContributions = [
  {
    description: "Inspect discovered Workflow Definitions and their source metadata.",
    icon: "i-ph-git-branch-light",
    id: "workflows",
    label: "Workflows",
    view: {
      kind: "definition-catalog",
      notice: "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
    },
  },
  {
    description: "Inspect discovered Queue Definitions and their source metadata.",
    icon: "i-ph-tray-light",
    id: "queues",
    label: "Queues",
    view: {
      kind: "definition-catalog",
      notice: "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
    },
  },
  {
    description: "Inspect messages that the development outbox captured.",
    icon: "i-lucide-mail",
    id: "email",
    label: "Email",
    view: {
      columns: [
        { key: "subject", label: "Subject" },
        { key: "to", label: "To" },
        { key: "provider", label: "Provider" },
        { key: "delivery", label: "Delivery" },
        { key: "captured", label: "Captured" },
      ],
      kind: "record-table",
      notice: "Messages come from the in-memory development outbox of this server runtime on each request. The outbox exists only in `vite dev`, keeps the newest messages up to its limit, and a restart clears it. HTML is shown as escaped source and is never rendered. Use `vitehub email outbox show <id> --html` for the full source.",
    },
  },
] as const
