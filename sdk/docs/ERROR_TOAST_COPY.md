# Editor Error Toast Click-to-Copy

## Sources and Retained Behavior

Inspected the retained parent at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocketjs_super_app_demo.html` (excluding `pocket_host/`):
- Lines 852–853 and 959–975 implement `showToast(msg, color)` as a passive auto-fading notification container.
- Lines 2103–2116 implement `copyCurrentGitCode()`, which uses a temporary `textarea` and `document.execCommand("copy")` with toast feedback.
- Also inspected existing clipboard handling in `sdk/editor/client/editor.js` (`copyVersionUrl` at lines 1213–1244 and `copyPreviewLink` at lines 1855–1873), which prefers `navigator.clipboard.writeText` with a `document.execCommand("copy")` fallback.

Previously in `sdk/editor/client/editor.js`, clicking anywhere on `#notice` called `clearNotice()`. When an error toast such as `{"error":"pointer move for unknown contact id 0","phase":"move","pointerId":0}` appeared, clicking the error toast immediately dismissed it instead of copying the error text.

## Necessary Adaptation and Ablation

- Updated `sdk/editor/client/editor.js` so that when `showNotice(message, tone)` renders an error toast (`tone === "error"`), it retains the full normalized/localized error text in `noticeCopyText`, sets `title="点击复制错误信息"` on `#notice`, and exposes `#notice-message` as a keyboard-focusable button (`role="button"`, `tabIndex = 0`, `aria-label="点击复制错误信息"`).
- Clicking an error toast body/message (or pressing `Enter`/`Space` when focused, unless `#notice-close` is targeted or the user is actively selecting text) copies the full original error text (`noticeCopyText`) via `navigator.clipboard.writeText` with a `document.execCommand("copy")` fallback.
- On copy, `#notice` stays open, sets `data-copied="true"`, updates `#notice-icon` to `✓`, and displays `已复制错误信息：<full error text>` for 1800ms before restoring the original error text and `!` icon. Repeated clicks always copy the original full error text without duplicating the confirmation prefix.
- Preserved `#notice-close` click and `Escape` key dismissal, as well as click-to-dismiss behavior for non-error (`info` / `success`) notices.
- Added minimal styling in `sdk/editor/client/editor.css` for `.notice[data-tone="error"][data-copied="true"]` and `#notice-message[role="button"]:focus-visible`.

## Validation

- `bun test editor/test/preview_stream_reconnect_browser.test.ts` (using Playwright bundled Chromium):
  - Verified that delivering `preview.error` with `{"error":"pointer move for unknown contact id 0","phase":"move","pointerId":0}` shows the error toast (`role="alert"`).
  - Verified clicking `#notice-message` copies the exact full error string via `navigator.clipboard.writeText`, keeps `#notice` visible, sets `data-copied="true"`, changes `#notice-icon` to `✓`, and shows `已复制错误信息：{"error":"pointer move for unknown contact id 0","phase":"move","pointerId":0}`.
  - Verified keyboard accessibility (`Enter` on focused `#notice-message`) and the `document.execCommand("copy")` fallback copy the exact original error string without prefix duplication.
  - Verified clicking `#notice-close` dismisses the error toast and clears `#notice-message`.
