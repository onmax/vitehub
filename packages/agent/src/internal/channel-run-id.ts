/**
 * Invocation run ID of a Channel message. It is stable per Channel and item key, so a live message,
 * a Channel dispatch, and a replay of the same message share one ID and a repeated replay skips it.
 * Dry runs use their own IDs; a dry run never blocks a later live run.
 */
export function channelMessageRunId(channel: string, key: string, options: { dryRun?: boolean } = {}): string {
  const encodedChannel = channel.replaceAll("%", "%25").replaceAll(":", "%3A")
  const encodedKey = key.replaceAll("%", "%25").replaceAll(":", "%3A")
  return `${options.dryRun ? "channel-dry-run" : "channel"}:${encodedChannel}:${encodedKey}`
}
