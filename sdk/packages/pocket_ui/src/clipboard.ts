import type { HostBridge } from "./host.ts";

/** Thin client over the optional pocket_clipboard provider (text only).
 * The guest manifest must declare the capability and the matching permission
 * (`clipboard.read` / `clipboard.write`); the trusted host must grant it.
 * Failures reject with the host bridge error: `capability_unavailable`,
 * `plugin_permission_denied`, `too_large`, `invalid_params`. */
export function createPocketClipboardClient(host: HostBridge) {
  return {
    /** Resolves null when the clipboard has no text. Rejects `too_large`
     * (never truncates) when the text exceeds the provider limit. */
    async readText(): Promise<string | null> {
      const result = await host.request<{ text: string | null }>("clipboard.readText", {});
      return result.text ?? null;
    },
    async writeText(text: string): Promise<void> {
      await host.request<{ ok: true }>("clipboard.writeText", { text });
    },
    async hasText(): Promise<boolean> {
      return (await host.request<{ hasText: boolean }>("clipboard.hasText", {})).hasText;
    },
  };
}

export const POCKET_CLIPBOARD_MAX_TEXT_BYTES = 192 * 1024;

export function readClipboardText(host: HostBridge): Promise<string | null> {
  return createPocketClipboardClient(host).readText();
}

export function writeClipboardText(host: HostBridge, text: string): Promise<void> {
  return createPocketClipboardClient(host).writeText(text);
}
