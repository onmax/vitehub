import { defineAgent } from "../index.ts";
import type {
  ConfiguredAgentDefinition,
  AgentDefinition,
  AgentRuntimeConfig,
  AgentInvokerProfile,
  AgentInvocationContextValues,
} from "../index.ts";
import type { GitHubPullRequestFilter } from "../channels.ts";
import type { BuiltInAgentDriverName } from "../types.ts";
import { babysitterInstructions } from "./babysitter/instructions.ts";
import { resolveBabysitterMerge, type BabysitterMerge } from "./babysitter/merge.ts";
import { defineChannel, defineChannelTrigger } from "../channels.ts";
import { channelEnvValue } from "../channel-env.ts";
import { agentProcessHostIntake, withAgentProcessHost, type AgentProcessHostContribution } from "../agent-process-host.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

export type { BabysitterMerge, BabysitterMergeMethod, BabysitterMergeReadinessInput, BabysitterMergeReady } from "./babysitter/merge.ts";

export interface BabysitterOptions {
  /** Select PRs with the same rules as the GitHub Channel. */
  filter: GitHubPullRequestFilter;
  /** Provider Driver that repairs each PR in its checkout. Defaults to `"codex"`. Set the model with `driver.model`. */
  driver: BuiltInAgentDriverName;
  /**
   * Merge policy. Defaults to `false`. `"auto"` lets the worker request GitHub native auto-merge.
   * `"direct"` merges a ready PR into its default branch before any model pass.
   */
  merge: BabysitterMerge;
  /**
   * Check names whose pending run means a review is in progress, such as a review bot's check.
   * A parked PR keeps waiting while one runs. Defaults to none.
   */
  reviewChecks: string[];
  /** PRs repaired at the same time. Defaults to 1. */
  concurrency: number;
  /** @deprecated Use `merge: "auto"`. */
  autoMerge: boolean;
}

export interface BabysitterPassResult {
  disposition: "park" | "retry";
  text: string;
}

export const babysitterPassResultSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "vitehub.babysitter",
    validate(
      value: unknown,
    ): { value: BabysitterPassResult } | { issues: Array<{ message: string }> } {
      if (
        value &&
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babysitter result validation narrows untyped external output.
        typeof value === "object" &&
        "disposition" in value &&
        "text" in value &&
        (value.disposition === "park" || value.disposition === "retry") &&
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Result text is validated at runtime.
        typeof value.text === "string" &&
        value.text.trim()
      ) {
        return {
          value: {
            disposition: value.disposition,
            text: value.text,
          } satisfies BabysitterPassResult,
        };
      }
      return {
        issues: [{ message: "Expected a park/retry disposition and a non-empty text result." }],
      };
    },
  },
};

const babysitterHost: AgentProcessHostContribution = {
  async create(context) {
    const { createBabysitterProcessHost } = await import("./babysitter/host.ts");
    return await createBabysitterProcessHost(context);
  },
};

function plainSecret(value: unknown): string | undefined {
  const plain = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value;
  return hasRuntimeType(plain, "string") && plain.trim() ? plain.trim() : undefined;
}

const babysitterIntake = defineChannel("babysitter-github", {
  messages: false,
  triggers: {
    delivery: defineChannelTrigger({
      webhooks: [{
        id: "github",
        provider: "github",
        signature: "github-sha256",
        secretHeader: "x-hub-signature-256",
        // A missing secret fails closed: unsigned deliveries must never reach the inbox.
        secretToken: async (context) => {
          const secret = plainSecret(await channelEnvValue("github", "webhookSecret", context));
          if (!secret) throw new Error("[vitehub] The Babysitter webhook needs GITHUB_WEBHOOK_SECRET.");
          return secret;
        },
      }],
      invoke: async (context, input: unknown) => {
        const github = isRuntimeRecord(input) && isRuntimeRecord(input.github) ? input.github : undefined;
        const deliveryId = github?.deliveryId, event = github?.event;
        if (!hasRuntimeType(deliveryId, "string") || !hasRuntimeType(event, "string") || !isRuntimeRecord(input)) {
          return Response.json({ accepted: false, reason: "missing GitHub delivery headers" }, { status: 400 });
        }
        const intake = agentProcessHostIntake(context.agentIdentity?.name ?? "");
        if (!intake) return Response.json({ accepted: false, reason: "Babysitter host is not running" }, { status: 503 });
        return await intake({ deliveryId, event, payload: input.payload });
      },
    }),
  },
});

/** A repair workflow. Connections, provider settings and host resources stay in the application. */
type BabysitterDefinition = AgentDefinition<
  AgentRuntimeConfig,
  unknown,
  AgentInvokerProfile,
  AgentInvocationContextValues,
  BabysitterPassResult
> & { reviewChecks: string[] };

export type BabysitterAgent = ConfiguredAgentDefinition<BabysitterOptions, BabysitterDefinition>;

export const babysitter: BabysitterAgent = defineAgent({
  options: {
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default filter is constrained by BabysitterOptions at the public preset boundary.
    filter: {} as GitHubPullRequestFilter,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented driver union.
    driver: "codex" as BuiltInAgentDriverName,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented merge union.
    merge: false as BabysitterMerge,
    reviewChecks: [] as string[],
    concurrency: 1,
    autoMerge: false,
  },
  configure: ({ driver, merge, reviewChecks, autoMerge, concurrency }) => {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new TypeError("[vitehub] Babysitter concurrency must be a positive integer.");
    }
    if (driver !== "codex" && driver !== "claude-code") {
      throw new TypeError('[vitehub] Babysitter driver must be "codex" or "claude-code".');
    }
    // Validate merge settings when the Agent is defined, not on the first PR.
    resolveBabysitterMerge(merge, autoMerge);
    const definition = defineAgent({
      description: "Repair selected pull requests and wait for their checks and reviews.",
      // Signed GitHub deliveries feed the PR inbox. They never start the Agent directly.
      channels: { github: babysitterIntake },
      driver: {
        kind: driver,
        permissions: "allow-edits",
        instructions: {
          template: babysitterInstructions,
        },
        output: { schema: babysitterPassResultSchema },
      },
    });
    return withAgentProcessHost(Object.assign(definition, { reviewChecks }), babysitterHost);
  },
});
