//! WeChat embedding of the pinned QJBC guest on the ordinary PocketJS runtime.
//! This adapter admits the same PJBC envelope as the native host and never
//! evaluates application JavaScript source.

use crate::{bytecode, wechat_assets, WasmHost};
use pocket_guest_rquickjs::{BindingProfile, RquickjsGuest};
use pocket_runtime::{
    generated_ops::BINDING_GENERATION, Guest, GuestEnvironment, GuestFrame, OpContext, RuntimeError,
};
use rquickjs::{
    function::{FromParams, Function, IntoJsFunc, ParamRequirement, Params},
    Ctx, Object, Value,
};
use serde_json::json;
use std::{cell::RefCell, rc::Rc};

const MAX_HOST_PACKET: usize = 64 * 1024;

fn layout_value<'js>(ctx: Ctx<'js>, host: usize, id: i32) -> rquickjs::Result<Value<'js>> {
    let host = unsafe { &*(host as *const WasmHost) };
    let ops = host.ops.borrow();
    let Ok(core) = ops.core() else {
        return Ok(Value::new_undefined(ctx));
    };
    let Some((mut x, mut y, width, height)) = core.layout_of(id) else {
        return Ok(Value::new_undefined(ctx));
    };
    // Core layout records node-local rectangles. The text-input overlay expects
    // screen-relative flex geometry; walk live parents directly so allocation
    // order does not matter. Paint transforms remain the Guest UI's concern
    // (for example, ScrollablePage applies its own kinetic offset).
    let mut parent = core.node_parent(id);
    while parent != 0 {
        let Some((parent_x, parent_y, _, _)) = core.layout_of(parent) else {
            return Ok(Value::new_undefined(ctx));
        };
        x += parent_x;
        y += parent_y;
        parent = core.node_parent(parent);
    }
    let value = Object::new(ctx.clone())?;
    value.set("x", x)?;
    value.set("y", y)?;
    value.set("width", width)?;
    value.set("height", height)?;
    value.set("w", width)?;
    value.set("h", height)?;
    Ok(value.into_value())
}

struct LayoutFunction {
    host: usize,
}

impl<'js> IntoJsFunc<'js, (Ctx<'js>, i32)> for LayoutFunction {
    fn param_requirements() -> ParamRequirement {
        <(Ctx<'js>, i32)>::param_requirements()
    }

    fn call<'a>(&self, params: Params<'a, 'js>) -> rquickjs::Result<Value<'js>> {
        let (ctx, id) = <(Ctx<'js>, i32)>::from_params(&mut params.access())?;
        layout_value(ctx, self.host, id)
    }
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "pocket_wechat")]
unsafe extern "C" {
    fn host_emit(p: *const u8, n: usize) -> i32;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_emit(_: *const u8, _: usize) -> i32 {
    0
}

pub struct WechatGuest {
    state: Rc<RefCell<Option<RquickjsGuest>>>,
    tick_hz: u32,
    host: usize,
}

impl WechatGuest {
    pub fn new(state: Rc<RefCell<Option<RquickjsGuest>>>, host: *const WasmHost) -> Self {
        Self { state, tick_hz: 60, host: host as usize }
    }

    fn set_error(&self, message: &str) {
        let host = unsafe { &*(self.host as *const WasmHost) };
        *host.result.borrow_mut() = message.as_bytes().to_vec();
    }
}

impl Guest for WechatGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        if environment.host_abi != BINDING_GENERATION {
            return Err(RuntimeError::BindingGenerationMismatch);
        }
        self.tick_hz = environment.tick_hz;
        let mut guest = RquickjsGuest::new(BindingProfile::Canonical);
        if let Err(error) = guest.initialize(ops, environment) {
            self.set_error(&format!("QuickJS 0.12.2 initialization failed: {error:?}; {}",
                guest.last_error().unwrap_or("no engine detail")));
            return Err(error);
        }
        let installed = guest.with_turn(|ctx| -> rquickjs::Result<()> {
            let globals = ctx.globals();
            let pocket = match globals.get::<_, Object>("pocket") {
                Ok(value) => value,
                Err(_) => Object::new(ctx.clone())?,
            };
            let emit = Function::new(ctx.clone(), |line: String| -> bool {
                if line.len() > MAX_HOST_PACKET {
                    return false;
                }
                unsafe { host_emit(line.as_ptr(), line.len()) == 1 }
            })?;
            pocket.set("_emit", emit)?;
            let get_layout = Function::new(ctx.clone(), LayoutFunction { host: self.host })?;
            pocket.set("getLayout", get_layout)?;
            globals.set("pocket", pocket)?;
            Ok(())
        });
        if !matches!(installed, Some(Ok(()))) {
            guest.shutdown();
            return Err(RuntimeError::Guest);
        }
        *self.state.borrow_mut() = Some(guest);
        Ok(())
    }

    fn evaluate(&mut self, envelope: &[u8]) -> Result<(), RuntimeError> {
        let envelope = envelope.strip_suffix(&[0]).unwrap_or(envelope);
        let expected = bytecode::BytecodeExpectation {
            kind: bytecode::BytecodeKind::Script,
            binding_generation: BINDING_GENERATION,
            tick_hz: self.tick_hz,
        };
        let artifact = bytecode::validate(envelope, expected).map_err(|_| RuntimeError::Guest)?;
        let payload_facts = format!("payload={} sha256={} first={:02x?} last={:02x?}",
            artifact.payload.len(),
            bytecode::sha256_hex(artifact.payload),
            &artifact.payload[..artifact.payload.len().min(8)],
            &artifact.payload[artifact.payload.len().saturating_sub(8)..]);
        let mut state = self.state.borrow_mut();
        let guest = state.as_mut().ok_or(RuntimeError::InvalidState)?;
        if let Err(error) = guest.evaluate_bytecode(artifact.payload, artifact.tick_hz) {
            self.set_error(&format!("QuickJS 0.12.2 QJBC evaluation failed: {error:?}; {payload_facts}; {}",
                guest.last_error().unwrap_or("no engine detail")));
            return Err(error);
        }
        Ok(())
    }

    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        self.state
            .borrow_mut()
            .as_mut()
            .ok_or(RuntimeError::InvalidState)?
            .frame(frame)
    }

    fn collect(&mut self) -> Result<(), RuntimeError> {
        self.state
            .borrow_mut()
            .as_mut()
            .ok_or(RuntimeError::InvalidState)?
            .collect()
    }

    fn shutdown(&mut self) {
        if let Some(mut guest) = self.state.borrow_mut().take() {
            guest.shutdown();
        }
    }
}

fn with_guest<T>(host: &WasmHost, f: impl for<'js> FnOnce(Ctx<'js>) -> Result<T, rquickjs::Error>) -> Result<T, RuntimeError> {
    let state = host.quickjs.try_borrow().map_err(|_| RuntimeError::Busy)?;
    let guest = state.as_ref().ok_or(RuntimeError::InvalidState)?;
    guest
        .with_turn(f)
        .ok_or(RuntimeError::InvalidState)?
        .map_err(|_| RuntimeError::Guest)
}

#[no_mangle]
pub unsafe extern "C" fn web_wechat_deliver(host: &WasmHost, p: *const u8, n: usize) -> i32 {
    if n == 0 || n > MAX_HOST_PACKET {
        return -1;
    }
    let line = match std::str::from_utf8(std::slice::from_raw_parts(p, n)) {
        Ok(value) => value,
        Err(_) => return -1,
    };
    let delivered = with_guest(host, |ctx| {
        let function: Function = ctx.globals().get("__pocketDeliver")?;
        function.call::<_, ()>((line.to_owned(),))
    });
    if delivered.is_err() {
        return -1;
    }
    host.quickjs
        .borrow_mut()
        .as_mut()
        .map_or(-1, |guest| guest.collect().map_or(-1, |_| 0))
}

#[no_mangle]
pub unsafe extern "C" fn web_wechat_guest_event(
    host: &WasmHost,
    method: *const u8,
    method_len: usize,
    params: *const u8,
    params_len: usize,
) -> i32 {
    if method_len == 0 || method_len > 128 || params_len > MAX_HOST_PACKET {
        return -1;
    }
    let method = match std::str::from_utf8(std::slice::from_raw_parts(method, method_len)) {
        Ok(value) => value,
        Err(_) => return -1,
    };
    let params = match std::str::from_utf8(std::slice::from_raw_parts(params, params_len)) {
        Ok(value) => value,
        Err(_) => return -1,
    };
    let delivered = with_guest(host, |ctx| {
        if method.starts_with("textInput.") {
            let json: Object = ctx.globals().get("JSON")?;
            let parse: Function = json.get("parse")?;
            let params: Value = parse.call::<_, Value>((params.to_owned(),))?;
            let function: Function = ctx.globals().get("__pocketTextInputEvent")?;
            let _: bool = function.call((method.to_owned(), params))?;
        } else {
            let line = format!("{{\"type\":\"event\",\"name\":{},\"payload\":{}}}",
                serde_json::to_string(method).unwrap(),
                params);
            let function: Function = ctx.globals().get("__pocketEvent")?;
            function.call::<_, ()>((line,))?;
        }
        Ok(())
    });
    if delivered.is_err() {
        return -1;
    }
    host.quickjs
        .borrow_mut()
        .as_mut()
        .map_or(-1, |guest| guest.collect().map_or(-1, |_| 0))
}

#[no_mangle]
pub extern "C" fn web_wechat_work_state(host: &WasmHost) -> i32 {
    let state = with_guest(host, |ctx| {
        let function: Function = ctx.globals().get("__pocketWorkState")?;
        let value: Object = function.call::<_, Object>(())?;
        let continuous: bool = value.get("continuous")?;
        let frames: Option<u32> = value.get("framesUntilTimer")?;
        let hz: u32 = value.get("simulationHz")?;
        Ok(json!({"continuous":continuous,"framesUntilTimer":frames,"simulationHz":hz}))
    });
    match state {
        Ok(state) => {
            *host.result.borrow_mut() = serde_json::to_vec(&state).unwrap_or_default();
            0
        }
        Err(error) => {
            *host.result.borrow_mut() = format!("{error:?}").into_bytes();
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn web_wechat_skip_idle_frames(host: &WasmHost, requested: u32) -> i32 {
    if requested == 0 {
        return 0;
    }
    let skipped = with_guest(host, |ctx| {
        let function: Function = ctx.globals().get("__pocketSkipIdleFrames")?;
        function.call::<_, u32>((requested,))
    });
    skipped.unwrap_or(0) as i32
}

#[no_mangle]
pub unsafe extern "C" fn web_wechat_boot(host: &WasmHost, scale: u32) -> i32 {
    host.result.borrow_mut().clear();
    let identity = b"wechat";
    if crate::browser::web_set_identity(host, identity.as_ptr(), identity.len(), BINDING_GENERATION) != 0 {
        return -1;
    }
    crate::browser::web_boot(
        host,
        wechat_assets::APP_QJBC.as_ptr(),
        wechat_assets::APP_QJBC.len(),
        wechat_assets::APP_PAK.as_ptr(),
        wechat_assets::APP_PAK.len(),
        wechat_assets::TICK_HZ,
        scale,
    )
}
