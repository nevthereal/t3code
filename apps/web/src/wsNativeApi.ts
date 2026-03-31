import {
  type GitActionProgressEvent,
  type ContextMenuItem,
  type NativeApi,
  type ServerProviderUpdatedPayload,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { createWsRpcClient, type WsRpcClient } from "./wsRpcClient";
import { ServerConfigUpdateSource, WsNativeApiState } from "./wsNativeApiState";

let instance: { api: NativeApi; rpcClient: WsRpcClient; cleanups: Array<() => void> } | null = null;
let state = new WsNativeApiState();

export function __resetWsNativeApiForTests() {
  if (instance) {
    for (const cleanup of instance.cleanups) {
      cleanup();
    }
    instance.rpcClient.dispose();
    instance = null;
  }
  state.dispose();
  state = new WsNativeApiState();
}

async function getServerConfigSnapshot(rpcClient: WsRpcClient) {
  const latestServerConfig = state.getServerConfig();
  if (latestServerConfig) {
    return latestServerConfig;
  }

  const config = await rpcClient.server.getConfig();
  state.setServerConfigSnapshot(config);
  return state.getServerConfig() ?? config;
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  return state.onWelcome(listener);
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (
    payload: import("@t3tools/contracts").ServerConfigUpdatedPayload,
    source: ServerConfigUpdateSource,
  ) => void,
): () => void {
  return state.onServerConfigUpdated(listener);
}

export function onServerProvidersUpdated(
  listener: (payload: ServerProviderUpdatedPayload) => void,
): () => void {
  return state.onProvidersUpdated(listener);
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = createWsRpcClient();
  const cleanups = [
    rpcClient.server.subscribeLifecycle((event) => {
      if (event.type === "welcome") {
        state.emitWelcome(event.payload);
      }
    }),
    rpcClient.server.subscribeConfig((event) => {
      state.applyServerConfigEvent(event);
    }),
    rpcClient.git.subscribeActionProgress((event: GitActionProgressEvent) => {
      state.emitGitActionProgress(event);
    }),
  ];

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: rpcClient.git.pull,
      status: rpcClient.git.status,
      runStackedAction: rpcClient.git.runStackedAction,
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
      onActionProgress: (callback) => state.onGitActionProgress(callback),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => getServerConfigSnapshot(rpcClient),
      refreshProviders: () =>
        rpcClient.server.refreshProviders().then((payload) => {
          state.applyProvidersUpdated(payload);
          return payload;
        }),
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: (patch) =>
        rpcClient.server.updateSettings(patch).then((settings) => {
          state.applySettingsUpdated(settings);
          return settings;
        }),
    },
    orchestration: {
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration
          .replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) => rpcClient.orchestration.onDomainEvent(callback),
    },
  };

  instance = { api, rpcClient, cleanups };
  return api;
}
