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

interface ServerConfigUpdatedNotification {
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

interface GitActionProgressNotification {
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

export class WsNativeApiState {
  private readonly registry = AtomRegistry.make();
  private readonly welcomeAtom = makeStateAtom<WsWelcomePayload | null>("ws-server-welcome", null);
  private readonly serverConfigAtom = makeStateAtom<ServerConfig | null>("ws-server-config", null);
  private readonly serverConfigUpdatedAtom = makeStateAtom<ServerConfigUpdatedNotification | null>(
    "ws-server-config-updated",
    null,
  );
  private readonly providersUpdatedAtom = makeStateAtom<ServerProviderUpdatedPayload | null>(
    "ws-server-providers-updated",
    null,
  );
  private readonly gitActionProgressAtom = makeStateAtom<GitActionProgressNotification | null>(
    "ws-git-action-progress",
    null,
  );

  dispose() {
    this.registry.dispose();
  }

  getServerConfig(): ServerConfig | null {
    return this.registry.get(this.serverConfigAtom);
  }

  setServerConfigSnapshot(config: ServerConfig): void {
    this.resolveServerConfig(config);
    this.emitProvidersUpdated({ providers: config.providers });
    this.emitServerConfigUpdated(toServerConfigUpdatedPayload(config), "snapshot");
  }

  applyServerConfigEvent(event: ServerConfigStreamEvent): void {
    switch (event.type) {
      case "snapshot": {
        this.setServerConfigSnapshot(event.config);
        return;
      }
      case "keybindingsUpdated": {
        const latestServerConfig = this.getServerConfig();
        if (!latestServerConfig) {
          return;
        }
        const nextConfig = {
          ...latestServerConfig,
          issues: event.payload.issues,
        } satisfies ServerConfig;
        this.resolveServerConfig(nextConfig);
        this.emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), event.type);
        return;
      }
      case "providerStatuses": {
        this.applyProvidersUpdated(event.payload);
        return;
      }
      case "settingsUpdated": {
        this.applySettingsUpdated(event.payload.settings);
        return;
      }
    }
  }

  applyProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
    const latestServerConfig = this.getServerConfig();
    this.emitProvidersUpdated(payload);

    if (!latestServerConfig) {
      return;
    }

    const nextConfig = {
      ...latestServerConfig,
      providers: payload.providers,
    } satisfies ServerConfig;
    this.resolveServerConfig(nextConfig);
    this.emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "providerStatuses");
  }

  applySettingsUpdated(settings: ServerSettings): void {
    const latestServerConfig = this.getServerConfig();
    if (!latestServerConfig) {
      return;
    }

    const nextConfig = {
      ...latestServerConfig,
      settings,
    } satisfies ServerConfig;
    this.resolveServerConfig(nextConfig);
    this.emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "settingsUpdated");
  }

  emitWelcome(payload: WsWelcomePayload): void {
    this.registry.set(this.welcomeAtom, payload);
  }

  emitGitActionProgress(event: GitActionProgressEvent): void {
    this.registry.set(this.gitActionProgressAtom, { event });
  }

  onWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
    return this.subscribeLatest(this.welcomeAtom, listener);
  }

  onServerConfigUpdated(
    listener: (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void,
  ): () => void {
    return this.subscribeLatest(this.serverConfigUpdatedAtom, (notification) => {
      listener(notification.payload, notification.source);
    });
  }

  onProvidersUpdated(listener: (payload: ServerProviderUpdatedPayload) => void): () => void {
    return this.subscribeLatest(this.providersUpdatedAtom, listener);
  }

  onGitActionProgress(listener: (event: GitActionProgressEvent) => void): () => void {
    return this.registry.subscribe(this.gitActionProgressAtom, (notification) => {
      if (!notification) {
        return;
      }
      listener(notification.event);
    });
  }

  private resolveServerConfig(config: ServerConfig): void {
    this.registry.set(this.serverConfigAtom, config);
  }

  private emitProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
    this.registry.set(this.providersUpdatedAtom, payload);
  }

  private emitServerConfigUpdated(
    payload: ServerConfigUpdatedPayload,
    source: ServerConfigUpdateSource,
  ): void {
    this.registry.set(this.serverConfigUpdatedAtom, { payload, source });
  }

  private subscribeLatest<A>(
    atom: Atom.Atom<A | null>,
    listener: (value: NonNullable<A>) => void,
  ): () => void {
    return this.registry.subscribe(
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
}
