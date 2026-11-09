import type { HostBridge, JsonValue } from "./host.ts";

export interface PocketDioRequest {
  url: string;
  method?: string;
  headers?: Record<string, string | number | boolean | string[]>;
  queryParameters?: Record<string, string | number | boolean | string[]>;
  data?: JsonValue;
  /** Defaults to json: decodes JSON MIME responses and preserves other bodies as text. */
  responseType?: "json" | "text" | "bytes";
  /** Positive total deadline, capped by the trusted host's requestTimeout.
   * The caller's HostBridge deadline also applies independently. */
  timeoutMs?: number;
}

export type PocketDioResponse<T extends JsonValue = JsonValue> = {
  statusCode: number;
  headers: Record<string, string[]>;
  data: T;
};

/** Uses the caller's existing bridge and the opt-in pocket_dio provider.
 * The native provider performs HTTP, bounded stream reading and decoding
 * in its dedicated IO Worker isolate; this is independent of renderWorker.
 * HTTP error statuses are returned as responses; transport, policy and
 * lifecycle failures reject. Retries and application state belong to JS.
 */
export function createPocketDioClient(host: HostBridge) {
  return {
    request<T extends JsonValue = JsonValue>(params: PocketDioRequest): Promise<PocketDioResponse<T>> {
      return host.request<PocketDioResponse<T>>("dio.request", { ...params });
    },
  };
}
