import type { BridgeObject, BridgeValue, HostBridge } from "./host.ts";
import {
  createPocketStreamAdapter,
  type PocketStream,
  type PocketStreamAdapter,
  type PocketStreamOpenOptions,
  type PocketStreamError,
} from "./streams.ts";

export interface PlatformLinkSubscription<T extends BridgeValue = BridgeValue> {
  readonly stream: PocketStream<T>;
  unsubscribe(): void;
  close(): void;
}

export interface PlatformLinks {
  initial<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
  latest<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
  subscribe<T extends BridgeValue = BridgeValue>(
    listener: (value: T) => void,
    options?: PlatformLinkSubscriptionOptions,
  ): PlatformLinkSubscription<T>;
}

export interface PlatformSystemUi {
  set<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
}

export interface PlatformHaptics {
  perform<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
}

export interface PlatformLinkSubscriptionOptions {
  /** Params passed to the explicit `platform.links.events` stream open. */
  params?: BridgeObject;
  /** Optional per-subscription stream bound/deadline. */
  stream?: PocketStreamOpenOptions;
  /** Reuse a caller-owned adapter instead of creating one lazily. */
  adapter?: PocketStreamAdapter;
}

export interface PlatformExperienceOptions {
  /** An adapter supplied by the caller; no adapter is made until subscribeLinks(). */
  streams?: PocketStreamAdapter;
  /** Descriptive alias for callers that prefer the singular name. */
  streamAdapter?: PocketStreamAdapter;
}

export interface PlatformExperience {
  readonly links: PlatformLinks;
  readonly systemUi: PlatformSystemUi;
  readonly haptics: PlatformHaptics;
  /** Alias for links.initial(). */
  initial<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
  /** Alias for links.latest(). */
  latest<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
  /** Explicitly subscribe to deep-link events; this never selects an app or route. */
  subscribeLinks<T extends BridgeValue = BridgeValue>(
    listener: (value: T) => void,
    options?: PlatformLinkSubscriptionOptions,
  ): PlatformLinkSubscription<T>;
  /** Alias for systemUi.set(). */
  setSystemUi<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T>;
  /** Alias for haptics.perform(). */
  performHaptic<T extends BridgeValue = BridgeValue>(
    params?: BridgeObject,
  ): Promise<T>;
  dispose(): void;
}

const unsupportedCodes = new Set([
  "unsupported",
  "unconfigured",
  "capability_unavailable",
  "capability_denied",
  "stream_unconfigured",
  "stream_adapter_unavailable",
]);

/** True when a host rejection explicitly means the optional platform feature is unavailable. */
export function isUnsupportedPlatformError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && unsupportedCodes.has(code);
}

function emptyParams(params: BridgeObject | undefined): BridgeObject {
  return params ?? {};
}

class PlatformExperienceImpl implements PlatformExperience {
  readonly links: PlatformLinks;
  readonly systemUi: PlatformSystemUi;
  readonly haptics: PlatformHaptics;
  private readonly host: HostBridge;
  private readonly suppliedStreams?: PocketStreamAdapter;
  private readonly subscriptions = new Set<() => void>();
  private disposed = false;

  constructor(host: HostBridge, options: PlatformExperienceOptions = {}) {
    this.host = host;
    this.suppliedStreams = options.streams ?? options.streamAdapter;
    this.links = {
      initial: <T extends BridgeValue = BridgeValue>(params?: BridgeObject) =>
        host.request<T>("platform.links.initial", emptyParams(params)),
      latest: <T extends BridgeValue = BridgeValue>(params?: BridgeObject) =>
        host.request<T>("platform.links.latest", emptyParams(params)),
      subscribe: <T extends BridgeValue = BridgeValue>(
        listener: (value: T) => void,
        options?: PlatformLinkSubscriptionOptions,
      ) => this.subscribeLinks<T>(listener, options),
    };
    this.systemUi = {
      set: <T extends BridgeValue = BridgeValue>(params?: BridgeObject) =>
        host.request<T>("platform.systemUi.set", emptyParams(params)),
    };
    this.haptics = {
      perform: <T extends BridgeValue = BridgeValue>(params?: BridgeObject) =>
        host.request<T>("platform.haptics.perform", emptyParams(params)),
    };
  }

  initial<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T> {
    return this.links.initial<T>(params);
  }

  latest<T extends BridgeValue = BridgeValue>(params?: BridgeObject): Promise<T> {
    return this.links.latest<T>(params);
  }

  subscribeLinks<T extends BridgeValue = BridgeValue>(
    listener: (value: T) => void,
    options: PlatformLinkSubscriptionOptions = {},
  ): PlatformLinkSubscription<T> {
    if (this.disposed) throw new Error("Platform experience is disposed");
    if (typeof listener !== "function")
      throw new TypeError("A link listener is required");
    const adapter =
      options.adapter ??
      this.suppliedStreams ??
      createPocketStreamAdapter(this.host);
    const ownsAdapter =
      options.adapter === undefined && this.suppliedStreams === undefined;
    let stream: PocketStream<T>;
    try {
      stream = adapter.open<T>(
        "platform.links.events",
        emptyParams(options.params),
        options.stream,
      );
    } catch (error) {
      if (ownsAdapter) adapter.dispose("links_open_failed");
      throw error;
    }
    let active = true;
    let removeData = (): void => {};
    let removeEnd = (): void => {};
    let unsubscribe = (): void => {};
    unsubscribe = (): void => {
      if (!active) return;
      active = false;
      removeData();
      removeEnd();
      stream.cancel("links_unsubscribed");
      if (ownsAdapter) adapter.dispose("links_unsubscribed");
      this.subscriptions.delete(unsubscribe);
    };
    removeData = stream.onData(listener);
    removeEnd = stream.onEnd(() => {
      if (!active) return;
      active = false;
      removeData();
      if (ownsAdapter) adapter.dispose("links_ended");
      this.subscriptions.delete(unsubscribe);
    });
    this.subscriptions.add(unsubscribe);
    return { stream, unsubscribe, close: unsubscribe };
  }

  setSystemUi<T extends BridgeValue = BridgeValue>(
    params?: BridgeObject,
  ): Promise<T> {
    return this.systemUi.set<T>(params);
  }

  performHaptic<T extends BridgeValue = BridgeValue>(
    params?: BridgeObject,
  ): Promise<T> {
    return this.haptics.perform<T>(params);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
    this.subscriptions.clear();
  }
}

export function createPlatformExperience(
  host: HostBridge,
  options: PlatformExperienceOptions = {},
): PlatformExperience {
  return new PlatformExperienceImpl(host, options);
}

export const createPocketPlatformExperience = createPlatformExperience;

// Keep the error type import in this module's public dependency surface for
// consumers that narrow unsupported optional stream failures by code.
export type PlatformStreamError = PocketStreamError;
