# Editor input timing and Codex controls

The embedded conversation UI described here was subsequently removed at the
user's request. See [Editor preview page](EDITOR_PREVIEW_PAGE.md) for the
current page. Input timing changes and backend API contracts remain relevant;
the 41-test result below is the earlier verification snapshot.

This work addresses Studio requests that need to change SDK implementation,
reasoning-effort selection, and preview drag/kinetic scrolling.

## Retained sources and adaptation

Inspected the retained parent project outside `pocket_host/`:

- `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`,
  `_PocketMultiTabFrameworkViewportState._onVSyncTick`: the existing host
  advances the guest using elapsed vsync time and wakes it for input. The
  browser preview must preserve that elapsed-time contract through its HTTP
  transport, rather than advance time once per input packet.
- The current pinned framework's `kinetics` and SDK `ScrollablePage` retain
  ownership of scrolling, velocity and edge springs. The browser remains a
  projection of real native FrameResult operations; no browser physics or
  layout fallback is added.
- The existing SDK `editor/codex.ts` transport remains the Codex integration.
  Its previous project-only developer instructions and writable root caused
  legitimate SDK requests to be rejected. New controls adapt that transport
  instead of adding another agent runner.

## Scope and reasoning effort

Project scope remains the default. SDK work must be explicitly selected in
Studio and admitted by the server's fixed SDK directory, together with the
selected project directory. The browser cannot supply an arbitrary filesystem
root. Conversation ownership includes scope; changing scope starts a new
conversation so old project-only instructions cannot conflict with the new
permission boundary. Within one Editor server, shared SDK work is serialized
with other Codex work and project mutations that could conflict with it.

SDK scope grants the entire fixed SDK root, including nested generated paths
such as the default `.pocket-build/editor-workspace`; it is not a per-file
source ACL. Instructions limit the requested edits to SDK implementation and
the selected project, preserving other managed projects and private signing
material. Project scope remains the choice for a project-only write sandbox.
The default workspace is retained to preserve existing projects and state.

Reasoning levels come from the selected model's `supportedReasoningEfforts`
and `defaultReasoningEffort`. Studio sends the chosen level as `effort` in
`turn/start`; the server validates it against the model catalog. Models that
do not advertise levels retain their provider default.

The field contract was checked using the installed CLI without submitting an
agent task:

```sh
codex app-server generate-json-schema --out /tmp/pocket-editor-codex-protocol-20261104
```

The generated `v2/ModelListResponse.json` and `v2/TurnStartParams.json` are the
local protocol evidence. No credential files or authentication tokens are
read or exposed by this verification.

## Preview input and time

Previously every input called `tickNow(0)` and reset the last-tick timestamp.
Frequent moves could continuously replace the scheduled timer while consuming
no animation time. Independently, serializing every browser move as its own
HTTP request could accumulate obsolete positions behind a slow request.

The fix must retain the final position, pointer lifecycle, multi-contact and
wheel ordering while combining only adjacent unsent moves belonging to the
same contact. Other input and terminal phases are ordering barriers.

The native frame clock uses a single monotonic elapsed-time ledger. Immediate
input frames retain a zero delta without erasing the elapsed-time baseline or
postponing an already earlier display timer. Scheduled frames consume the
elapsed time once; input count does not multiply simulated time. Native demand
scheduling includes the presented child runtime, and continues driving inertia
and springs after the browser sends UP.

## Evidence

The pre-change Studio files were already modified/untracked by parallel work.
A read-only snapshot of the relevant files is retained at
`/tmp/pocket-editor-input-baseline-20261104`; implementation is incremental and
does not restore those files over anyone else's changes.

Validation logs for this task are retained under
`/tmp/pocket-editor-input-fix-20261104-logs`. Browser acceptance uses
Playwright Chromium, actual preview HTTP requests and pinned native QJBC
execution. Controlled RPC tests check Codex options without submitting a real
agent task.

`codex_controls.test.ts` runs its real browser check in a bounded child Bun
process. In a shared process after another browser file it intermittently
closed the page or timed out, while the same check passed independently.
Isolation makes both files pass together; a nonzero exit or child timeout
fails the parent test and includes its output. It does not skip UI assertions.

The clock regression also has an isolated ablation under
`/tmp/pocket-clock-ablation-20261104.PIT8HD`: the pre-change snapshot advanced
0 ms during 109.86 ms of continuous input and failed the assertion. The fixed
host advanced 122.50 ms during 132.80 ms of input and passed. This uses a
line-protocol clock instrument to measure host deltas, independently of native
scroll physics; it is a test instrument, not a runtime fallback.

The real scroll acceptance observed the top marker overshoot `87 -> 39`,
post-release inertia `195.72473 -> 190.17453` without new input, and bottom
spring `281 -> 329`. These checks establish functioning drag, inertia and
edge return; they do not establish subjective parity with a device's scroll
feel.

Pointer, back-pressure and basic counter acceptance build independent public
SDK fixtures rather than using mutable Demo lobby bytecode as a standalone
app. The lobby requests SystemUI-owned storage and is not an independent
preview fixture. The separate real Showcase/SystemUI catalog test is retained
to cover that integration; unsupported native capabilities are not replaced
with success placeholders.

Final integrated verification (2026-11-04):

```sh
POCKET_PLAYWRIGHT=/tmp/pocket-playwright-review/node_modules/playwright/index.mjs \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe \
bun run --cwd sdk test:editor
```

Result: **41 pass, 0 fail, 0 skipped**, 12 files, 18.83 seconds. Log:
`/tmp/pocket-editor-input-fix-20261104-logs/editor-acceptance-final.log`.
This includes the browser scope/thinking check, real scrolling, clock ledger,
input ordering, counter/resize, and real Showcase SystemUI integration.
`node --check` passed for both browser JS files and `git diff --check` passed.
No Flutter code was changed for this task and no Flutter tests were run.

The user-provided `Screen Recording 2026-11-04 at 09.41.21.mov` remained in
macOS `TemporaryItems`. Both ffprobe and ffmpeg were denied with
`Operation not permitted`; native UI access also failed. No visual conclusion
about that recording is claimed.
