// "Copy" actions (hashes, URLs) through the guest's clipboard capability client. A missing or denied
// clipboard is reported, never silently treated as a successful copy.
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";

export interface ClipboardWriter { writeText(text: string): Promise<void> }

export function createCopier(deps: { clipboard?: ClipboardWriter; toasts: Toasts }) {
  /** Resolves true when the text reached the system clipboard. */
  return async function copy(text: string, label: string): Promise<boolean> {
    if (!deps.clipboard) { deps.toasts.error("剪贴板不可用：宿主没有提供剪贴板能力。"); return false; }
    try {
      await deps.clipboard.writeText(text);
      deps.toasts.success(`已复制${label}`);
      return true;
    } catch (error) {
      deps.toasts.error(`复制失败：${errorText(error)}`);
      return false;
    }
  };
}
export type Copier = ReturnType<typeof createCopier>;
