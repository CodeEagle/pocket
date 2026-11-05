# Opt-in guest security

Pocket Flutter keeps the legacy native ABI and development behavior by
default. A caller that wants production policy may configure one immutable
policy before the first `pocket_eval`, `pocket_load`, or
`pocket_load_bytecode`:

```json
{"hardenBuiltins":true,"maxNodes":20000,"maxDrawOps":50000}
```

The native entry point is `pocket_configure_guest_security(handle,
config_json) -> i32`. The JSON object rejects unknown fields. `maxNodes` and
`maxDrawOps` are positive integers no larger than 1,000,000. A successful
configuration is one-shot; a late call or a second call is rejected. The
policy survives package/bytecode reloads, while per-realm fatal state and live
node IDs are cleared on reload.

With `hardenBuiltins` (which is off by default), every newly mounted QuickJS
realm is hardened after the host bridge is installed and before guest code
runs. `eval` is removed,
`Function`, `AsyncFunction`, `GeneratorFunction`, and
`AsyncGeneratorFunction` constructor paths throw, and selected shared prototypes are frozen. This is a local prototype list, not a
claim that every TypedArray prototype, host API, network capability, or every
possible string-to-code mechanism outside the listed QuickJS constructors is
isolated. Constructor/toString/valueOf-style members are tamed
with accessors so normal subclass overrides define an own property on the
subclass/object. `Error.prototype` is intentionally not frozen, preserving
the Error subclass behavior used by framework/Solid code. Host-side source
evaluation and authenticated bytecode loading remain available because they
enter QuickJS from Rust rather than through guest strings.

When `maxNodes` is enabled, the native `ui.createNode` binding dispatches the
canonical op-1 call only after reconciling its generation-tagged IDs with
`core.ui.node_exists`. This handles recursive `destroyNode` and ID reuse. The
binding property is non-writable and non-configurable, so a guest cannot
replace it. A quota violation sets a sticky native fatal marker even if the
guest catches the JavaScript exception; the current eval/frame fails and no
partial frame is published. Reloading creates a fresh quota set but retains
the configured limit.

This policy applies to the UI guest realm owned by `HostState`. The independent
native Worker realm is not hardened by this switch; its existing capability,
execution-budget and IO admission boundaries remain separate. Do not treat the
option as a universal sandbox policy covering every execution domain.

`maxDrawOps` is an output budget for the decoded primary plus auxiliary
DrawLists in one frame. It is checked before resources/events are published;
over-budget output fails atomically. It does not claim to cap all QuickJS or
native heap allocations, and this change does not add a sticky OOM allocator.

## Provenance and source-first adaptation

The retained parent integration was inspected before implementation:

* `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
  supplies the retained parent component/rendering behavior to compare. The
  current SDK keeps JS composition and enforces node allocation at its
  canonical native `ui.createNode` boundary.
* `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`
  supplies prior guest execution and lifecycle behavior. This adaptation
  preserves the current SDK's pinned buildGuest/bytecode loading path; host
  bytecode loading is not disabled by guest hardening.

The hardening script is an intentionally narrow adaptation of the `HARDEN`
body at
`https://github.com/longbridge/nsh/blob/932e4aebca34723d386cf5ad0095f5c0184c0b2d/crates/nsh-js/src/sandbox.rs`.
The source repository is Apache-2.0 (see its `LICENSE-APACHE` and workspace
`Cargo.toml`; a copy is retained in `vendor/nsh-LICENSE-APACHE.txt`). This
file preserves attribution and does not modify the pinned
engine/cache. The local retained copy used for source-first inspection was
`/tmp/pocket-nsh-reference-20261104/crates/nsh-js/src/sandbox.rs` at that
same commit.
The adapted script adds only the Pocket production error text and is run in
the Pocket bridge's already-created realm. Native quotas are new boundary
checks because the retained Pocket core exposes the authoritative node and
DrawList state there.

Focused integration tests execute real QuickJS through the native FFI and
cover default compatibility, every constructor route, prototype protection,
Error subclass compatibility, sticky node/draw quotas, destroy/reuse and
unknown/late policy rejection. They do not test allocator-wide OOM behavior.
