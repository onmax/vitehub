export const installOptions = {
  skill: {
    label: "Agent skill",
    value: "skill",
    icon: "i-lucide-bot",
    command: "npx skills add https://vitehub.dev",
  },
  packages: [
    {
      label: "pnpm",
      value: "pnpm",
      icon: "i-simple-icons-pnpm",
      command: "pnpm add vite-hub h3 vite",
    },
    {
      label: "npm",
      value: "npm",
      icon: "i-simple-icons-npm",
      command: "npm install vite-hub h3 vite",
    },
    {
      label: "bun",
      value: "bun",
      icon: "i-simple-icons-bun",
      command: "bun add vite-hub h3 vite",
    },
    {
      label: "yarn",
      value: "yarn",
      icon: "i-simple-icons-yarn",
      command: "yarn add vite-hub h3 vite",
    },
  ],
} as const;

export const agentStory = {
  path: "server/agents/review.ts",
  tutorialPath: "/docs/getting-started/first-agent",
  code: [
    'import { defineAgent } from "vite-hub/agent"',
    'import { browser, skills } from "vite-hub/agent/capabilities"',
    'import { github } from "vite-hub/agent/channels"',
    "",
    "export default defineAgent({",
    '  description: "Reviews pull requests.",',
    "  channels: { github: github({ pullRequest: true }) },",
    '  driver: "codex",',
    '  workspace: { mode: "write" },',
    '  capabilities: [browser(), skills({ path: "./skills" })],',
    "})",
  ],
  steps: [
    {
      id: "channel",
      label: "Channel",
      title: "A pull request opens",
      description: "Channels start an Invocation from GitHub, Slack, HTTP, or web chat.",
      lines: [2, 6],
      to: "/docs/agents/channels",
    },
    {
      id: "driver",
      label: "Driver",
      title: "Codex takes the run",
      description: "Use Codex, Claude Code, an AI SDK model, or your own function.",
      lines: [7],
      to: "/docs/agents/agent-drivers",
    },
    {
      id: "workspace",
      label: "Workspace",
      title: "It works in a real file tree",
      description: "A persistent Workspace holds the repository between runs.",
      lines: [8],
      to: "/docs/agents/workspace-context",
    },
    {
      id: "capabilities",
      label: "Capabilities",
      title: "It uses only what you grant",
      description: "The Agent gets the browser and Skills you list. Nothing else.",
      lines: [1, 9],
      to: "/docs/capabilities",
    },
  ],
} as const;

export const landingPrimitives = [
  {
    id: "workspace",
    name: "Workspace",
    description: "Persistent file trees",
    to: "/docs/server-primitives/workspace",
  },
  {
    id: "kv",
    name: "KV",
    description: "State and cache",
    to: "/docs/server-primitives/kv",
  },
  {
    id: "queue",
    name: "Queue",
    description: "Background jobs",
    to: "/docs/server-primitives/queue",
  },
  {
    id: "workflow",
    name: "Workflow",
    description: "Durable orchestration",
    to: "/docs/server-primitives/workflows",
  },
  {
    id: "schedule",
    name: "Schedule",
    description: "Recurring work",
    to: "/docs/server-primitives/schedule",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Isolated execution",
    to: "/docs/server-primitives/sandbox",
  },
  {
    id: "database",
    name: "Database",
    description: "Relational data",
    to: "/docs/server-primitives/database",
  },
  {
    id: "blob",
    name: "Blob",
    description: "Files and uploads",
    to: "/docs/server-primitives/blob",
  },
  {
    id: "auth",
    name: "Auth",
    description: "Users and sessions",
    to: "/docs/server-primitives/auth",
  },
  {
    id: "env",
    name: "Env",
    description: "Typed configuration",
    to: "/docs/server-primitives/env",
  },
  {
    id: "source",
    name: "Source",
    description: "Read-only content",
    to: "/docs/server-primitives/source",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Command execution",
    to: "/docs/server-primitives/shell",
  },
] as const;
