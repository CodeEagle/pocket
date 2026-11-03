import { after, simulationHz } from "@pocketjs/framework/clock";
import { createHostBridge, type HostBridge, type HostSend, type JsonObject, type JsonValue } from "./host.ts";

export interface AppResult {
  requestId: string;
  appId: string;
  cancelled: boolean;
  value: JsonValue;
  reason?: string;
}

export interface AppMessage {
  id: string;
  sourceAppId: string;
  targetAppId: string;
  topic: string;
  data: JsonValue;
}

export interface AppLaunch {
  requestId: string;
  targetAppId: string;
  result: Promise<AppResult>;
  cancel(): Promise<JsonValue>;
}

/** One platform client per guest. It shares the existing host RPC/event wire;
 * awaiting another app never creates a frame callback or polling timer. */
export function createPocketPlatformClient(send?: HostSend, options: { bridge?: HostBridge } = {}) {
  const host = options.bridge ?? createHostBridge(send, {
    timeoutFrames: 30 * simulationHz(),
    scheduleTimeout: (frames, callback) => after(frames / simulationHz(), callback),
  });
  const pending = new Map<string, { resolve: (value: AppResult) => void; reject: (error: Error) => void }>();
  // A fast callee may close before the open RPC response reaches its caller.
  const earlyResults = new Map<string, AppResult>();
  const messageListeners = new Set<(message: AppMessage) => void>();
  const lifecycleListeners = new Set<(event: JsonObject) => void>();
  let disposed = false;
  const target = globalThis as typeof globalThis & { __pocketEvent?: (line: string) => void };
  const previous = target.__pocketEvent;
  const receive = (line: string) => {
    host.handle(line);
    let event: Record<string, unknown> | undefined;
    try { event = JSON.parse(line); } catch { /* Other guest handlers may own this packet. */ }
    if (!disposed && event) {
      const name = event.name ?? event.method;
      const value = event.payload ?? event.params;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (name === "platform.result") {
          const result = value as AppResult;
          if (typeof result.requestId === "string") {
            const waiter = pending.get(result.requestId);
            if (waiter) { pending.delete(result.requestId); waiter.resolve(result); }
            else if (earlyResults.size < 32) earlyResults.set(result.requestId, result);
          }
        } else if (name === "platform.message") {
          for (const listener of [...messageListeners]) listener(value as AppMessage);
        } else if (name === "platform.lifecycle" || name === "platform.launch") {
          for (const listener of [...lifecycleListeners]) listener(value as JsonObject);
        }
      }
    }
    previous?.(line);
  };
  target.__pocketEvent = receive;

  const request = (name: string, params: JsonObject = {}) => host.request(name, params);
  const launchApp = async (appId: string, argumentsValue: JsonValue = null): Promise<AppLaunch> => {
    if (disposed) throw new Error("Platform client is disposed");
    if (pending.size >= 32) throw new Error("Too many pending app results");
    const opened = await request("platform.apps.open", { appId, arguments: argumentsValue }) as JsonObject;
    if (disposed) throw new Error("Platform client is disposed");
    if (typeof opened.requestId !== "string" || !opened.requestId) {
      throw new Error("Host returned an invalid launch token");
    }
    const requestId = opened.requestId;
    const result = new Promise<AppResult>((resolve, reject) => {
      const early = earlyResults.get(requestId);
      if (early) { earlyResults.delete(requestId); resolve(early); }
      else pending.set(requestId, { resolve, reject });
    });
    return {
      requestId,
      targetAppId: appId,
      result,
      cancel: () => request("platform.apps.cancel", { requestId }),
    };
  };

  return {
    listApps: () => request("platform.apps.list"),
    launchApp,
    openApp: async (appId: string, argumentsValue: JsonValue = null) =>
      (await launchApp(appId, argumentsValue)).result,
    returnResult: (value: JsonValue = null) => request("platform.apps.return", { value }),
    prewarm: (appId: string) => request("platform.apps.prewarm", { appId }),
    storage: {
      get: (key: string, namespace?: string) => request("platform.storage.get", { key, ...(namespace ? { namespace } : {}) }),
      set: (key: string, value: JsonValue, namespace?: string) => request("platform.storage.set", { key, value, ...(namespace ? { namespace } : {}) }),
      remove: (key: string, namespace?: string) => request("platform.storage.remove", { key, ...(namespace ? { namespace } : {}) }),
      keys: (namespace?: string) => request("platform.storage.keys", namespace ? { namespace } : {}),
    },
    sendMessage: (appId: string, data: JsonValue, topic = "default") => request("platform.messages.send", { appId, data, topic }),
    receiveMessages: () => request("platform.messages.receive"),
    onMessage(listener: (message: AppMessage) => void) {
      messageListeners.add(listener);
      return () => { messageListeners.delete(listener); };
    },
    onLifecycle(listener: (event: JsonObject) => void) {
      lifecycleListeners.add(listener);
      return () => { lifecycleListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (target.__pocketEvent === receive) target.__pocketEvent = previous;
      if (!options.bridge) host.dispose();
      for (const waiter of pending.values()) waiter.reject(new Error("Platform client disposed"));
      pending.clear();
      earlyResults.clear();
      messageListeners.clear();
      lifecycleListeners.clear();
    },
  };
}
