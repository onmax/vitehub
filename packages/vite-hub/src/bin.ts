#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { createBoxCliNamespace } from "./box-cli.ts"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

import type { ViteHubCliCommandNamespace } from "@vite-hub/internal/cli"

// `agent invocations` talks to a server or a journal database, so a broken or slow project config cannot block it.
const agentRuntimeFeatures: ViteHubCliCommandNamespace = {
  features: [{
    name: "invocations",
    run: async (args, context) => (await import("@vite-hub/agent/cli")).runAgentInvocationsCli(args, context),
  }],
  name: "agent",
}

runViteHubCliEntrypoint({ loadConfig: loadViteHubCliConfig, runtimeFeatures: [agentRuntimeFeatures], runtimeNamespaces: [createBoxCliNamespace()] })
