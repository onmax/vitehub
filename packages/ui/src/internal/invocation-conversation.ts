import { stringAttribute, type InvocationActivity } from "./invocation-activity.ts";
import { hasRuntimeType } from "./runtime-type.ts";

export type InvocationConversation = {
  deliveredAnswerCount: number;
  promptId?: string;
} & (
  | { kind: "activities"; activities: readonly InvocationActivity[] }
  | {
      kind: "conversation";
      history: readonly InvocationActivity[];
      prompt?: InvocationActivity;
      work: readonly InvocationActivity[];
      answers: readonly InvocationActivity[];
      followup: readonly InvocationActivity[];
    }
);

/** Selects the current turn and separates visible answers from their work receipts. */
export function buildInvocationConversation(activities: readonly InvocationActivity[]): InvocationConversation {
  const promptId = activities[promptActivityIndex(activities)]?.id;
  const orderedActivities = activities.filter(activity => activity.kind !== "message" || isVisibleMessage(activity));
  const firstUser = promptActivityIndex(orderedActivities);
  const lastUser = orderedActivities.findLastIndex(activity => activity.kind === "message" && activity.role === "user");
  const lastAssistant = orderedActivities.findLastIndex((activity, index) => index > lastUser
    && activity.kind === "message" && activity.role === "assistant" && activity.attributes["message.phase"] !== "commentary");
  const tail = orderedActivities.slice(firstUser + 1);
  const finalBody = lastAssistant >= 0 ? orderedActivities[lastAssistant]!.body?.trim() : undefined;
  const answers = new Set(uniqueDeliveredAnswers(tail, new Set(finalBody ? [finalBody] : [])));
  const metadata = { deliveredAnswerCount: answers.size, promptId };
  if (firstUser < 0 && !orderedActivities.some(isDeliveredAnswer)) {
    return { ...metadata, kind: "activities", activities: orderedActivities };
  }

  const history = orderedActivities.slice(0, Math.max(firstUser, 0)).filter(isVisibleMessage);
  const workBeforePrompt = orderedActivities.slice(0, Math.max(firstUser, 0)).filter(activity => activity.kind !== "message");
  const prompt = orderedActivities[firstUser];
  const hasLaterCommentary = lastAssistant >= 0 && orderedActivities.slice(lastAssistant + 1).some(activity =>
    activity.kind === "message" && activity.role === "assistant" && activity.attributes["message.phase"] === "commentary");
  if (hasLaterCommentary) {
    const beforeAnswer = orderedActivities.slice(firstUser + 1, lastAssistant);
    const followup = orderedActivities.slice(lastAssistant);
    return {
      ...metadata,
      kind: "conversation",
      history,
      prompt,
      work: coalesceAgentConfiguration([...workBeforePrompt, ...beforeAnswer, ...followup.filter(activity => activity.kind === "delivery")])
        .map(activity => isDeliveredAnswer(activity) ? deliveryReceipt(activity) : activity),
      answers: beforeAnswer.filter(activity => answers.has(activity)).map(deliveryAnswer),
      followup: followup.flatMap(activity =>
        answers.has(activity) ? [deliveryAnswer(activity)] : activity.kind === "delivery" ? [] : [activity]),
    };
  }

  return {
    ...metadata,
    kind: "conversation",
    history,
    prompt,
    work: coalesceAgentConfiguration([...workBeforePrompt, ...tail.filter((_, offset) => firstUser + 1 + offset !== lastAssistant)])
      .map(activity => isDeliveredAnswer(activity) ? deliveryReceipt(activity) : activity),
    answers: [...[...answers].map(deliveryAnswer), ...(lastAssistant >= 0 ? [orderedActivities[lastAssistant]!] : [])]
      .sort((left, right) => left.sequence - right.sequence),
    followup: [],
  };
}

function promptActivityIndex(activities: readonly InvocationActivity[]): number {
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind === "message"
      && activity.role === "user"
      && activity.name !== "agent.input.message"
      && activity.attributes["input.mode"] !== "steer") return index;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind === "message" && activity.role === "user" && activity.attributes["input.mode"] !== "steer") return index;
  }
  return -1;
}

function isVisibleMessage(activity: InvocationActivity): boolean {
  return activity.kind === "message" && Boolean(activity.body?.trim());
}

function coalesceAgentConfiguration(activities: readonly InvocationActivity[]): InvocationActivity[] {
  let latestConfiguration = -1;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]!.name === "vitehub.agent.configured") {
      latestConfiguration = index;
      break;
    }
  }
  return latestConfiguration < 0
    ? [...activities]
    : activities.filter((activity, index) => activity.name !== "vitehub.agent.configured" || index === latestConfiguration);
}

const answerDeliveryKinds = new Set(["reply", "update"]);

function deliveryContent(activity: InvocationActivity): string | undefined {
  const content = activity.attributes["channel.effect.content"];
  return hasRuntimeType(content, "string") && content.trim() ? content : undefined;
}

function isDeliveredAnswer(activity: InvocationActivity): boolean {
  return activity.kind === "delivery"
    && activity.status === "completed"
    && activity.attributes["channel.effect.supported"] !== false
    && !stringAttribute(activity.attributes, "channel.effect.skipped")
    && answerDeliveryKinds.has(stringAttribute(activity.attributes, "channel.effect.kind")?.toLocaleLowerCase() ?? "")
    && deliveryContent(activity) !== undefined;
}

function uniqueDeliveredAnswers(activities: readonly InvocationActivity[], bodies: Set<string>): InvocationActivity[] {
  return activities.filter(activity => {
    if (!isDeliveredAnswer(activity)) return false;
    const body = deliveryContent(activity)!.trim();
    if (bodies.has(body)) return false;
    bodies.add(body);
    return true;
  });
}

function deliveryReceipt(activity: InvocationActivity): InvocationActivity {
  return { ...activity, attributes: Object.fromEntries(Object.entries(activity.attributes).filter(([key]) => key !== "channel.effect.content")) };
}

function deliveryAnswer(activity: InvocationActivity): InvocationActivity {
  return { ...activity, body: deliveryContent(activity), id: `${activity.id}:answer`, kind: "message", role: "assistant" };
}
