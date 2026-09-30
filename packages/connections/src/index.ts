export { decideConnectionAccess, matchesConnectionPattern } from "./access.ts"
export { defineConnection } from "./definition.ts"
export { isConnectionError } from "./errors.ts"
export { apiKey } from "./providers/api-key.ts"
export { oauth2 } from "./providers/oauth2.ts"
export { useConnection } from "./runtime/state.ts"

export type { ConnectionErrorCode, ConnectionErrorDetails } from "./errors.ts"
export type { ApiKeyProviderOptions } from "./providers/api-key.ts"
export type { OAuth2ProviderOptions } from "./providers/oauth2.ts"
export type { ConnectionName } from "./registry-types.ts"
export type {
  ConnectionAccess,
  ConnectionAccessDecision,
  ConnectionAccessRule,
  ConnectionActivity,
  ConnectionActivityAction,
  ConnectionActivityOutcome,
  ConnectionActor,
  ConnectionApiKeyProvider,
  ConnectionApiKeyVerification,
  ConnectionAuthorizationInput,
  ConnectionCallResult,
  ConnectionClient,
  ConnectionDefinition,
  ConnectionEffect,
  ConnectionExchangeInput,
  ConnectionKind,
  ConnectionOAuth2Provider,
  ConnectionOAuthClient,
  ConnectionOperation,
  ConnectionProvider,
  ConnectionProviderContext,
  ConnectionRequest,
  ConnectionSecret,
  ConnectionSkipped,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTokenSet,
  ConnectionTrace,
  UseConnectionOptions,
} from "./types.ts"
