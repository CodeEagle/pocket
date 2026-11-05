import { after, simulationHz } from "@pocketjs/framework/clock";
import {
  createHostBridge,
  forwardHostPacket,
  type BridgeObject,
  type BridgeValue,
  type HostBridge,
  type HostEvent,
  type HostPacketHandler,
  type HostSend,
} from "./host.ts";
import { createMediaController, type MediaController, type MediaControllerOptions } from "./media.ts";

export interface AppResult {
  requestId: string;
  appId: string;
  cancelled: boolean;
  value: BridgeValue;
  reason?: string;
}

export interface AppMessage {
  id: string;
  sourceAppId: string;
  targetAppId: string;
  topic: string;
  data: BridgeValue;
}

export interface AppLaunch {
  requestId: string;
  targetAppId: string;
  result: Promise<AppResult>;
  cancel(): Promise<BridgeValue>;
}

export interface PocketPlatformClientOptions {
  bridge?: HostBridge;
  /**
   * The default scope is owned by this client and receives this client's
   * platform.lifecycle events. Pass false to opt out, a controller to share
   * one explicitly, or controller options to configure an owned scope.
   */
  media?: MediaController | MediaControllerOptions | false;
}

/** One platform client per guest. It shares the existing host RPC/event wire;
 * awaiting another app never creates a frame callback or polling timer. */
export function createPocketPlatformClient(send?: HostSend, options: PocketPlatformClientOptions = {}) {
  const host = options.bridge ?? createHostBridge(send, {
    timeoutFrames: 30 * simulationHz(),
    scheduleTimeout: (frames, callback) => after(frames / simulationHz(), callback),
  });
  const pending = new Map<string, { resolve: (value: AppResult) => void; reject: (error: Error) => void }>();
  // A fast callee may close before the open RPC response reaches its caller.
  const earlyResults = new Map<string, AppResult>();
  const messageListeners = new Set<(message: AppMessage) => void>();
  const lifecycleListeners = new Set<(event: BridgeObject) => void>();
  let disposed = false;
  const suppliedMedia = options.media && typeof options.media === "object" &&
    typeof (options.media as MediaController).register === "function"
    ? options.media as MediaController
    : undefined;
  const ownsMedia = options.media !== false && suppliedMedia === undefined;
  const media = options.media === false
    ? undefined
    : suppliedMedia ?? createMediaController({
      ...(options.media && typeof options.media === "object" ? options.media as MediaControllerOptions : {}),
      // The platform client is the single lifecycle dispatcher. Avoid making
      // the owned controller subscribe to the same HostBridge a second time.
      subscribeLifecycle: false,
      bridge: options.media && typeof options.media === "object" && "bridge" in options.media
        ? (options.media as MediaControllerOptions).bridge ?? host
        : host,
    });
  const target = globalThis as typeof globalThis & {
    __pocketEvent?: HostPacketHandler;
  };
  const previous = typeof host.onEvent === "function" ? undefined : target.__pocketEvent;
  const handleEvent = (name: string, value: unknown): void => {
    if (disposed || !value || typeof value !== "object" || Array.isArray(value)) return;
    if (name === "platform.result") {
      const result = value as AppResult;
      if (typeof result.requestId === "string") {
        const waiter = pending.get(result.requestId);
        if (waiter) { pending.delete(result.requestId); waiter.resolve(result); }
        else if (earlyResults.size < 32) earlyResults.set(result.requestId, result);
      }
    } else if (name === "platform.message") {
      for (const listener of [...messageListeners]) {
        try { listener(value as AppMessage); } catch { /* isolate consumer callbacks */ }
      }
    } else if (name === "platform.lifecycle" || name === "platform.launch") {
      if (name === "platform.lifecycle" && media) media.handleLifecycle(value as BridgeObject);
      for (const listener of [...lifecycleListeners]) {
        try { listener(value as BridgeObject); } catch { /* isolate consumer callbacks */ }
      }
    }
  };
  const receive: HostPacketHandler = (packet): void => {
    // Request-only injected bridges retain the explicit compatibility path.
    if (typeof host.onEvent !== "function") host.handle(packet);
    let event: Record<string, unknown> | undefined;
    if (typeof packet === "string") {
      try { event = JSON.parse(packet); } catch { /* Other guest handlers may own this packet. */ }
    } else if (packet && typeof packet === "object" && !Array.isArray(packet)) {
      event = packet;
    }
    if (event) handleEvent(
      typeof event.name === "string" ? event.name : typeof event.method === "string" ? event.method : "",
      event.payload ?? event.params,
    );
    try { forwardHostPacket(previous, packet); } catch { /* isolate legacy previous sinks */ }
  };
  receive.__binaryCapable = true;
  const removeHostEvent = typeof host.onEvent === "function"
    ? host.onEvent((event: HostEvent) => handleEvent(event.method, event.params))
    : undefined;
  if (typeof host.onEvent !== "function") target.__pocketEvent = receive;

  const request = (name: string, params: BridgeObject = {}) => host.request(name, params,
    name === "platform.apps.open" || name === "platform.apps.prewarm"
      ? { timeoutFrames: 90 * simulationHz() }
      : undefined);
  const launchApp = async (appId: string, argumentsValue: BridgeValue = null): Promise<AppLaunch> => {
    if (disposed) throw new Error("Platform client is disposed");
    if (pending.size >= 32) throw new Error("Too many pending app results");
    // The SystemUI root remains foreground while a child is on top. This
    // coverage gate pauses registered videos without freezing root scheduling.
    const releaseCoverage = media?.beginCoverage("platform.apps.open");
    try {
      const opened = await request("platform.apps.open", { appId, arguments: argumentsValue }) as BridgeObject;
      if (disposed) throw new Error("Platform client is disposed");
      if (typeof opened.requestId !== "string" || !opened.requestId) {
        throw new Error("Host returned an invalid launch token");
      }
      const requestId = opened.requestId;
      const result = new Promise<AppResult>((resolve, reject) => {
        const early = earlyResults.get(requestId);
        if (early) { earlyResults.delete(requestId); resolve(early); }
        else pending.set(requestId, { resolve, reject });
      }).finally(() => releaseCoverage?.());
      return {
        requestId,
        targetAppId: appId,
        result,
        cancel: async () => {
          // A successful cancel request is only an acknowledgement that the
          // host accepted the request. Keep media covered until the matching
          // platform.result proves the child was actually dismissed; a failed
          // or rejected cancel must never resume the root video early.
          return request("platform.apps.cancel", { requestId });
        },
      };
    } catch (error) {
      releaseCoverage?.();
      throw error;
    }
  };

  return {
    media,
    listApps: () => request("platform.apps.list"),
    launchApp,
    openApp: async (appId: string, argumentsValue: BridgeValue = null) =>
      (await launchApp(appId, argumentsValue)).result,
    returnResult: (value: BridgeValue = null) => request("platform.apps.return", { value }),
    prewarm: (appId: string) => request("platform.apps.prewarm", { appId }),
    storage: {
      get: (key: string, namespace?: string) => request("platform.storage.get", { key, ...(namespace ? { namespace } : {}) }),
      set: (key: string, value: BridgeValue, namespace?: string) => request("platform.storage.set", { key, value, ...(namespace ? { namespace } : {}) }),
      remove: (key: string, namespace?: string) => request("platform.storage.remove", { key, ...(namespace ? { namespace } : {}) }),
      keys: (namespace?: string) => request("platform.storage.keys", namespace ? { namespace } : {}),
    },
    sendMessage: (appId: string, data: BridgeValue, topic = "default") => request("platform.messages.send", { appId, data, topic }),
    receiveMessages: () => request("platform.messages.receive"),
    onMessage(listener: (message: AppMessage) => void) {
      messageListeners.add(listener);
      return () => { messageListeners.delete(listener); };
    },
    onLifecycle(listener: (event: BridgeObject) => void) {
      lifecycleListeners.add(listener);
      return () => { lifecycleListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeHostEvent?.();
      if (target.__pocketEvent === receive) target.__pocketEvent = previous;
      if (ownsMedia) media?.dispose();
      if (!options.bridge) host.dispose();
      for (const waiter of pending.values()) waiter.reject(new Error("Platform client disposed"));
      pending.clear();
      earlyResults.clear();
      messageListeners.clear();
      lifecycleListeners.clear();
    },
  };
}
