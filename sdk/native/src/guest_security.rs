//! Opt-in guest hardening and native output/resource quotas.
//!
//! The policy is deliberately owned by the native host. JavaScript receives
//! only a locked `ui.createNode` wrapper when a node quota was explicitly
//! configured; the wrapper cannot be replaced from the guest and a quota
//! violation is recorded in this state even when JavaScript catches the
//! exception.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use pocket_runtime::{OpArg, OpContext, OpResult};
use rquickjs::{Coerced, Ctx, Exception, FromJs, Function, IntoJs, Object, Value};
use serde::Deserialize;

pub(crate) const MAX_QUOTA: u32 = 1_000_000;

#[derive(Clone, Debug, Default)]
pub(crate) struct GuestSecurityState {
    pub configured: bool,
    pub harden_builtins: bool,
    pub max_nodes: Option<u32>,
    pub max_draw_ops: Option<u32>,
    /// Sticky for one realm generation. `reset_runtime` clears it while
    /// retaining the host policy across a package/bytecode reload.
    pub fatal: Option<String>,
    pub node_ids: HashSet<i32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct GuestSecurityConfig {
    pub harden_builtins: bool,
    pub max_nodes: Option<u32>,
    pub max_draw_ops: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawGuestSecurityConfig {
    #[serde(default)]
    harden_builtins: bool,
    #[serde(default, deserialize_with = "present_quota")]
    max_nodes: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "present_quota")]
    max_draw_ops: Option<serde_json::Value>,
}

// `Option<Value>` normally treats explicit JSON null as an absent field.
// Preserve presence so null cannot silently disable an intended quota.
fn present_quota<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

pub(crate) fn parse_config(bytes: &[u8]) -> Result<GuestSecurityConfig, String> {
    if bytes.len() > 16 * 1024 {
        return Err("guest security config exceeds 16 KiB".to_owned());
    }
    let raw: RawGuestSecurityConfig = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid guest security config: {error}"))?;
    let positive_quota =
        |name: &str, value: Option<serde_json::Value>| -> Result<Option<u32>, String> {
            let Some(value) = value else {
                return Ok(None);
            };
            let value = value
                .as_u64()
                .ok_or_else(|| format!("guest security {name} must be a positive integer"))?;
            let value = u32::try_from(value)
                .map_err(|_| format!("guest security {name} must be at most {MAX_QUOTA}"))?;
            if value == 0 || value > MAX_QUOTA {
                return Err(format!("guest security {name} must be 1..={MAX_QUOTA}"));
            }
            Ok(Some(value))
        };
    Ok(GuestSecurityConfig {
        harden_builtins: raw.harden_builtins,
        max_nodes: positive_quota("maxNodes", raw.max_nodes)?,
        max_draw_ops: positive_quota("maxDrawOps", raw.max_draw_ops)?,
    })
}

pub(crate) fn reset_runtime(state: &Rc<RefCell<GuestSecurityState>>) {
    let mut state = state.borrow_mut();
    state.fatal = None;
    state.node_ids.clear();
}

pub(crate) fn fatal(state: &Rc<RefCell<GuestSecurityState>>) -> Option<String> {
    state.borrow().fatal.clone()
}

pub(crate) fn set_fatal(state: &Rc<RefCell<GuestSecurityState>>, message: impl Into<String>) {
    let mut state = state.borrow_mut();
    if state.fatal.is_none() {
        state.fatal = Some(message.into());
    }
}

pub(crate) fn install_node_quota<'js>(
    ctx: &Ctx<'js>,
    ops: OpContext,
    state: Rc<RefCell<GuestSecurityState>>,
    max_nodes: u32,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let ui: Object = globals.get("ui")?;
    let wrapper_state = state.clone();
    let create = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, value: Value<'js>| -> rquickjs::Result<Value<'js>> {
            // Match the canonical generated binding: required i32 coercion,
            // followed by the u32 wire representation used by op 1.
            if value.is_undefined() {
                return Err(Exception::throw_type(&ctx, "missing UI argument"));
            }
            let value = Coerced::<i32>::from_js(&ctx, value)
                .map_err(|_| Exception::throw_type(&ctx, "invalid UI argument"))?;
            let enforce = {
                let security = wrapper_state.borrow();
                security.configured && security.max_nodes == Some(max_nodes)
            };
            if enforce && wrapper_state.borrow().node_ids.len() >= max_nodes as usize {
                let core = ops
                    .core()
                    .map_err(|_| Exception::throw_internal(&ctx, "UI operation unavailable"))?;
                let mut security = wrapper_state.borrow_mut();
                // `destroyNode` can recursively free descendants. Reconcile
                // against the real generation-tagged core tree before
                // admitting another allocation instead of decrementing one
                // guessed counter. This scan is only needed at the quota
                // boundary; ordinary allocations remain O(1).
                security.node_ids.retain(|id| core.ui.node_exists(*id));
                if security.node_ids.len() >= max_nodes as usize {
                    security.fatal = Some(format!("guest node quota exceeded ({max_nodes})"));
                    return Err(Exception::throw_range(&ctx, "guest node quota exceeded"));
                }
            }
            let result = ops
                .dispatch(1, &[OpArg::Integer((value.0 as u32) as i64)])
                .map_err(|_| Exception::throw_internal(&ctx, "UI operation failed"))?;
            let OpResult::Integer(id) = result else {
                return Err(Exception::throw_internal(&ctx, "invalid UI result"));
            };
            let id = id as i32;
            if id > 0 {
                let mut security = wrapper_state.borrow_mut();
                if security.configured && security.max_nodes == Some(max_nodes) {
                    security.node_ids.insert(id);
                }
            }
            id.into_js(&ctx)
        },
    )?;
    create.set_name("createNode")?;
    create.set_length(1)?;

    // `ui.createNode` is an own non-configurable/non-writable property once a
    // quota is enabled. Calling the ordinary setter later cannot replace it.
    let descriptor = Object::new(ctx.clone())?;
    descriptor.set("value", create)?;
    descriptor.set("writable", false)?;
    descriptor.set("enumerable", true)?;
    descriptor.set("configurable", false)?;
    let object_constructor: Object = globals.get("Object")?;
    let define_property: Function = object_constructor.get("defineProperty")?;
    define_property.call::<_, Value>((ui, "createNode", descriptor))?;
    Ok(())
}

// This hardening body is adapted from
// /tmp/pocket-nsh-reference-20261104/crates/nsh-js/src/sandbox.rs (HARDEN).
// The reference is from longbridge/nsh, Apache-2.0, commit
// 932e4aebca34723d386cf5ad0095f5c0184c0b2d; see sdk/docs/GUEST_SECURITY.md
// for the original path and the intentional scope.
const HARDEN: &str = r#"
(() => {
  const deny = (label) => function () {
    throw new TypeError(label + " is disabled: Pocket production hardening runs no code from strings");
  };
  const replace = (fn, value) => {
    Object.defineProperty(Object.getPrototypeOf(fn), "constructor", {
      value, writable: false, enumerable: false, configurable: false,
    });
  };
  const blocked = deny("the Function constructor");
  blocked.prototype = Function.prototype;
  replace(function () {}, blocked);
  replace(async function () {}, deny("the AsyncFunction constructor"));
  replace(function* () {}, deny("the GeneratorFunction constructor"));
  replace(async function* () {}, deny("the AsyncGeneratorFunction constructor"));
  Object.defineProperty(globalThis, "Function", { value: blocked, writable: false, configurable: false });
  delete globalThis.eval;
  // Preserve subclass constructor/toString/valueOf overrides through an
  // accessor that defines an own property on the subclass/object. Error is
  // intentionally excluded so Error subclasses can set `this.name`.
  const tamed = [
    "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf",
    "propertyIsEnumerable", "toJSON",
  ];
  const tame = (proto) => {
    for (const name of tamed) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !("value" in d) || !d.writable) continue;
      const value = d.value;
      Object.defineProperty(proto, name, {
        get() { return value; },
        set(v) {
          if (this === proto) throw new TypeError(`Cannot assign to read only property '${name}'`);
          Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    }
  };
  for (const proto of [
    Object.prototype, Array.prototype, Function.prototype, String.prototype, Number.prototype,
    Boolean.prototype, Symbol.prototype, RegExp.prototype, Promise.prototype, Map.prototype,
    Set.prototype, WeakMap.prototype, WeakSet.prototype, Date.prototype,
    Object.getPrototypeOf(Uint8Array.prototype),
  ]) {
    tame(proto);
    Object.freeze(proto);
  }
})();
"#;

pub(crate) fn install_hardening(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(HARDEN)
}
