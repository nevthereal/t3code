import { Duration, Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { WsRpcGroup } from "@t3tools/contracts";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { resolveServerUrl } from "./lib/utils";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(fallback);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private disposed = false;

  constructor(url?: string) {
    const resolvedUrl = resolveServerUrl({
      url,
      protocol: "ws",
      pathname: "/ws",
    });
    const SocketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const ProtocolLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(Layer.mergeAll(SocketLayer, RpcSerialization.layerJson)),
    );

    this.runtime = ManagedRuntime.make(ProtocolLayer);
    this.clientScope = Effect.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(Scope.provide(this.clientScope)(makeWsRpcClient));
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    try {
      const client = await this.clientPromise;
      return await Effect.runPromise(Effect.suspend(() => execute(client)));
    } catch (error) {
      throw asError(error, "Request failed");
    }
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const retryDelayMs = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    const cancel = Effect.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!active) {
                return;
              }
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formatErrorMessage(error),
            });
          }).pipe(Effect.andThen(Effect.sleep(retryDelayMs)));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void Effect.runPromise(Scope.close(this.clientScope, Exit.void));
    void this.runtime.dispose();
  }
}
