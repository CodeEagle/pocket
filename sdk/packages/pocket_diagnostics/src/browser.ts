/**
 * Opt-in browser / worker error and unhandledrejection collector adapter.
 * Zero Node/Bun built-in imports. Never swallows or preventDefaults events.
 */

import type {
  DiagnosticContext,
  DiagnosticCrashRecord,
  DiagnosticsCollector,
} from "./types.ts";

export interface BrowserEventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void, options?: boolean | { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: boolean | { capture?: boolean; passive?: boolean }): void;
}

export interface BrowserErrorCollectorOptions {
  readonly collector: DiagnosticsCollector;
  readonly target?: BrowserEventTargetLike;
  readonly context?: DiagnosticContext | (() => DiagnosticContext);
  readonly captureWindowErrors?: boolean;
  readonly captureUnhandledRejections?: boolean;
  readonly onCrashRecorded?: (record: DiagnosticCrashRecord) => void;
}

export interface BrowserErrorCollectorHandle {
  readonly active: boolean;
  detach(): void;
}

function resolveContext(ctx?: DiagnosticContext | (() => DiagnosticContext)): DiagnosticContext {
  if (!ctx) return {};
  if (typeof ctx === "function") {
    try {
      return ctx() ?? {};
    } catch {
      return {};
    }
  }
  return ctx;
}

/**
 * Attach opt-in listeners for browser/worker `error` and `unhandledrejection` events.
 * Does NOT call `event.preventDefault()` or swallow errors; returns an explicit `detach()` handle.
 */
export function attachBrowserErrorCollector(
  options: BrowserErrorCollectorOptions,
): BrowserErrorCollectorHandle {
  if (!options?.collector || typeof options.collector.recordCrash !== "function") {
    throw new TypeError("attachBrowserErrorCollector requires a valid DiagnosticsCollector");
  }

  const target: BrowserEventTargetLike | undefined =
    options.target ??
    (typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as BrowserEventTargetLike).addEventListener === "function" &&
    typeof (globalThis as unknown as BrowserEventTargetLike).removeEventListener === "function"
      ? (globalThis as unknown as BrowserEventTargetLike)
      : undefined);

  if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
    return {
      active: false,
      detach() {
        // no-op when target has no EventTarget interface
      },
    };
  }

  const captureErrors = options.captureWindowErrors !== false;
  const captureRejections = options.captureUnhandledRejections !== false;
  let active = true;

  const onError = (event: unknown): void => {
    if (!active || options.collector.closed) return;
    const ev = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
    const rawError =
      ev.error !== undefined && ev.error !== null
        ? ev.error
        : typeof ev.message === "string" && ev.message.length > 0
          ? new Error(ev.message)
          : new Error("Browser error event");

    const locationData: Record<string, unknown> = {};
    if (typeof ev.filename === "string" && ev.filename.length > 0) locationData.filename = ev.filename;
    if (typeof ev.lineno === "number" && Number.isFinite(ev.lineno)) locationData.lineno = ev.lineno;
    if (typeof ev.colno === "number" && Number.isFinite(ev.colno)) locationData.colno = ev.colno;

    const ctx = resolveContext(options.context);
    void options.collector
      .recordCrash(rawError, {
        ...ctx,
        source: ctx.source ?? "browser.error",
        tag: "window.error",
        severity: "fatal",
        unhandled: true,
        ...(typeof ev.message === "string" && ev.message.length > 0 ? { message: ev.message } : {}),
        ...(Object.keys(locationData).length > 0 ? { data: locationData } : {}),
      })
      .then((rec) => {
        options.onCrashRecorded?.(rec);
      })
      .catch(() => {
        // Never throw from global diagnostic listener
      });
  };

  const onUnhandledRejection = (event: unknown): void => {
    if (!active || options.collector.closed) return;
    const ev = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
    const reason =
      "reason" in ev
        ? ev.reason
        : new Error("Unhandled promise rejection");

    const ctx = resolveContext(options.context);
    void options.collector
      .recordCrash(reason, {
        ...ctx,
        source: ctx.source ?? "browser.unhandledrejection",
        tag: "unhandledrejection",
        severity: "fatal",
        unhandled: true,
      })
      .then((rec) => {
        options.onCrashRecorded?.(rec);
      })
      .catch(() => {
        // Never throw from global diagnostic listener
      });
  };

  if (captureErrors) {
    target.addEventListener("error", onError);
  }
  if (captureRejections) {
    target.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  return {
    get active(): boolean {
      return active;
    },
    detach(): void {
      if (!active) return;
      active = false;
      if (captureErrors) {
        target.removeEventListener("error", onError);
      }
      if (captureRejections) {
        target.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
    },
  };
}
