export interface ChannelConnectorResult {
  id?: string
  raw?: unknown
}

export interface ChannelSendResult extends ChannelConnectorResult {
  channel: string
  connector: string
  deliveryId: string
}

export type ChannelSendOutcome = [error: Error, receipt: null] | [error: null, receipt: ChannelSendResult]

export interface ChannelConnector<TOptions extends object = Record<string, unknown>, TResult extends object = ChannelConnectorResult> {
  send: (text: string, options: TOptions) => Promise<TResult> | TResult
}

export type ChannelConnectorMap = Record<string, ChannelConnector<never, object>>

type ValidatedChannelConnectors<TConnectors extends ChannelConnectorMap> = string extends keyof TConnectors
  ? TConnectors
  : {
      [TName in keyof TConnectors]: TConnectors[TName] extends ChannelConnector<infer _TOptions, infer _TResult>
        ? TConnectors[TName]
        : never
    }

export interface ChannelDefinition<
  TConnectors extends ChannelConnectorMap = ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> {
  connectors: TConnectors & ValidatedChannelConnectors<TConnectors>
  defaultConnector?: TDefault
}

export interface ChannelDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ChannelDefinition } | ChannelDefinition>
}

export interface DiscoveredChannelDefinition {
  handler: string
  name: string
  source: "server-channels" | "vite-suffix"
}

type ConnectorOptions<TConnector> = TConnector extends ChannelConnector<infer TOptions, infer _TResult> ? TOptions : never

type ExplicitChannelSendOptions<TConnectors extends ChannelConnectorMap> = {
  [TName in keyof TConnectors & string]: {
    connector: TName
  } & ConnectorOptions<TConnectors[TName]>
}[keyof TConnectors & string]

type DynamicChannelSendOptions = {
  connector?: string
}

type DefaultChannelSendOptions<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string,
> = {
  connector?: TDefault
} & ConnectorOptions<TConnectors[TDefault]>

export type ChannelSendOptions<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> = string extends keyof TConnectors
  ? DynamicChannelSendOptions
  : ExplicitChannelSendOptions<TConnectors>
    | ([TDefault] extends [never] ? never : DefaultChannelSendOptions<TConnectors, TDefault>)

export interface ChannelClient<
  TConnectors extends ChannelConnectorMap = ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> {
  readonly name: string
  send: <TOptions extends object>(text: string, options: TOptions & ChannelSendOptions<TConnectors, TDefault>) => Promise<ChannelSendOutcome>
}
