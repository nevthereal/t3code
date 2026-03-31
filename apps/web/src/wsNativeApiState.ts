import {
  type GitActionProgressEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerConfigUpdatedPayload,
  type ServerProviderUpdatedPayload,
  type ServerSettings,
  type WsWelcomePayload,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

export type ServerConfigUpdateSource = ServerConfigStreamEvent["type"];

export interface ServerConfigUpdatedNotification {
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

export interface GitActionProgressNotification {
  readonly event: GitActionProgressEvent;
}

function makeStateAtom<A>(label: string, initialValue: A) {
  return Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label));
}

function toServerConfigUpdatedPayload(config: ServerConfig): ServerConfigUpdatedPayload {
  return {
    issues: config.issues,
    providers: config.providers,
    settings: config.settings,
  };
}

export let wsNativeApiRegistry = AtomRegistry.make();

export const wsWelcomeAtom = makeStateAtom<WsWelcomePayload | null>("ws-server-welcome", null);
export const serverConfigAtom = makeStateAtom<ServerConfig | null>("ws-server-config", null);
export const serverConfigUpdatedAtom = makeStateAtom<ServerConfigUpdatedNotification | null>(
  "ws-server-config-updated",
  null,
);
export const providersUpdatedAtom = makeStateAtom<ServerProviderUpdatedPayload | null>(
  "ws-server-providers-updated",
  null,
);
export const gitActionProgressAtom = makeStateAtom<GitActionProgressNotification | null>(
  "ws-git-action-progress",
  null,
);

export function getServerConfig(): ServerConfig | null {
  return wsNativeApiRegistry.get(serverConfigAtom);
}

export function setServerConfigSnapshot(config: ServerConfig): void {
  resolveServerConfig(config);
  emitProvidersUpdated({ providers: config.providers });
  emitServerConfigUpdated(toServerConfigUpdatedPayload(config), "snapshot");
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  switch (event.type) {
    case "snapshot": {
      setServerConfigSnapshot(event.config);
      return;
    }
    case "keybindingsUpdated": {
      const latestServerConfig = getServerConfig();
      if (!latestServerConfig) {
        return;
      }
      const nextConfig = {
        ...latestServerConfig,
        issues: event.payload.issues,
      } satisfies ServerConfig;
      resolveServerConfig(nextConfig);
      emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), event.type);
      return;
    }
    case "providerStatuses": {
      applyProvidersUpdated(event.payload);
      return;
    }
    case "settingsUpdated": {
      applySettingsUpdated(event.payload.settings);
      return;
    }
  }
}

export function applyProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  const latestServerConfig = getServerConfig();
  emitProvidersUpdated(payload);

  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    providers: payload.providers,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "providerStatuses");
}

export function applySettingsUpdated(settings: ServerSettings): void {
  const latestServerConfig = getServerConfig();
  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    settings,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "settingsUpdated");
}

export function emitWelcome(payload: WsWelcomePayload): void {
  wsNativeApiRegistry.set(wsWelcomeAtom, payload);
}

export function emitGitActionProgress(event: GitActionProgressEvent): void {
  wsNativeApiRegistry.set(gitActionProgressAtom, { event });
}

export function onWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  return subscribeLatest(wsWelcomeAtom, listener);
}

export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void,
): () => void {
  return subscribeLatest(serverConfigUpdatedAtom, (notification) => {
    listener(notification.payload, notification.source);
  });
}

export function onProvidersUpdated(
  listener: (payload: ServerProviderUpdatedPayload) => void,
): () => void {
  return subscribeLatest(providersUpdatedAtom, listener);
}

export function onGitActionProgress(listener: (event: GitActionProgressEvent) => void): () => void {
  return wsNativeApiRegistry.subscribe(gitActionProgressAtom, (notification) => {
    if (!notification) {
      return;
    }
    listener(notification.event);
  });
}

export function resetWsNativeApiStateForTests() {
  wsNativeApiRegistry.dispose();
  wsNativeApiRegistry = AtomRegistry.make();
}

function resolveServerConfig(config: ServerConfig): void {
  wsNativeApiRegistry.set(serverConfigAtom, config);
}

function emitProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  wsNativeApiRegistry.set(providersUpdatedAtom, payload);
}

function emitServerConfigUpdated(
  payload: ServerConfigUpdatedPayload,
  source: ServerConfigUpdateSource,
): void {
  wsNativeApiRegistry.set(serverConfigUpdatedAtom, { payload, source });
}

function subscribeLatest<A>(
  atom: Atom.Atom<A | null>,
  listener: (value: NonNullable<A>) => void,
): () => void {
  return wsNativeApiRegistry.subscribe(
    atom,
    (value) => {
      if (value === null) {
        return;
      }
      listener(value as NonNullable<A>);
    },
    { immediate: true },
  );
}
