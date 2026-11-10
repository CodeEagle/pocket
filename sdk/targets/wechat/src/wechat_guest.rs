//! WeChat embedding of the pinned QJBC guest on the ordinary PocketJS runtime.
//! This adapter admits the same PJBC envelope as the native host and never
//! evaluates application JavaScript source.

use crate::{binary_bridge, bytecode, wechat_assets, WasmHost};
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
// A real model frame contains bounded packed PMS1 buffers. Guest requests
// retain the smaller limit; only trusted host responses use the binary budget.
const MAX_HOST_RESPONSE: usize = 4 * 1024 * 1024;

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
            let emit = Function::new(ctx.clone(), |value: Value| -> bool {
                let Ok(bytes) = binary_bridge::encode_js_message(value, MAX_HOST_PACKET, 32) else {
                    return false;
                };
                unsafe { host_emit(bytes.as_ptr(), bytes.len()) == 1 }
            })?;
            pocket.set("_emitValue", emit)?;
            let get_layout = Function::new(ctx.clone(), LayoutFunction { host: self.host })?;
            pocket.set("getLayout", get_layout)?;
            globals.set("pocket", pocket)?;
            // WX capabilities use the async host bridge. There is no native
            // offload provider here; keep the pinned coverage uploader while
            // exposing the current value ABI as explicitly disconnected.
            let offload = match globals.get::<_, Object>("offload") {
                Ok(value) => value,
                Err(_) => Object::new(ctx.clone())?,
            };
            offload.set("session", Function::new(ctx.clone(), || 0_u32)?)?;
            offload.set("eventDriven", true)?;
            offload.set("submitValue", Function::new(ctx.clone(), |_value: Value<'_>| false)?)?;
            offload.set("takeValue", Function::new(ctx.clone(), || None::<Value<'_>>)?)?;
            globals.set("offload", offload)?;
            // SystemUI receives the trusted compositor registry from the
            // generated catalog. Child Guests deliberately do not receive it;
            // only the root is allowed to decide which package owns a surface.
            let host = unsafe { &*(self.host as *const WasmHost) };
            crate::web_worker_channels::install(&ctx, host.worker_channels.clone())?;
            if host.app_index.get() == 0 && !crate::wechat_assets::SYSTEM_SURFACES.is_empty() {
                let ui = match globals.get::<_, Object>("ui") {
                    Ok(value) => value,
                    Err(_) => Object::new(ctx.clone())?,
                };
                let surfaces = Object::new(ctx.clone())?;
                for (app_id, handle) in crate::wechat_assets::SYSTEM_SURFACES.iter().copied() {
                    surfaces.set(app_id, handle)?;
                }
                ui.set("__surfaces", surfaces)?;
                globals.set("ui", ui)?;
            }
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
        let host = unsafe { &*(self.host as *const WasmHost) };
        if host.worker_channels.borrow().is_some() {
            let state = self.state.borrow();
            let guest = state.as_ref().ok_or(RuntimeError::InvalidState)?;
            if !matches!(guest.with_turn(|ctx| crate::web_worker_channels::before_frame(&ctx, &host.worker_channels)), Some(Ok(()))) {
                return Err(RuntimeError::Guest);
            }
        }
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
    if n == 0 || n > MAX_HOST_RESPONSE {
        return -1;
    }
    let bytes = std::slice::from_raw_parts(p, n);
    let delivered = with_guest(host, |ctx| {
        let value = binary_bridge::decode_to_js(&ctx, bytes)
            .map_err(|_| rquickjs::Error::Exception)?;
        let function: Function = ctx.globals().get("__pocketDeliver")?;
        function.call::<_, ()>((value,))
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
    let params = std::slice::from_raw_parts(params, params_len);
    let delivered = with_guest(host, |ctx| {
        let params = binary_bridge::decode_to_js(&ctx, params)
            .map_err(|_| rquickjs::Error::Exception)?;
        if method.starts_with("textInput.") {
            let function: Function = ctx.globals().get("__pocketTextInputEvent")?;
            let _: bool = function.call((method.to_owned(), params))?;
        } else {
            let packet = Object::new(ctx.clone())?;
            packet.set("type", "event")?;
            packet.set("name", method)?;
            packet.set("payload", params)?;
            // Direct upstream apps need not install the SDK event adapter.
            // Their viewport still arrives in the canonical GuestFrame; an
            // absent optional SDK listener is not a failed native input.
            let handler: Value = ctx.globals().get("__pocketEvent")?;
            if let Some(function) = handler.as_function() {
                function.call::<_, ()>((packet,))?;
            }
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
            *host.result.borrow_mut() = binary_bridge::encode_json_to_binary(&state, MAX_HOST_PACKET).unwrap_or_default();
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
    web_wechat_boot_index(host, scale, 0)
}

#[no_mangle]
pub extern "C" fn web_wechat_app_count() -> u32 {
    wechat_assets::APPS.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn web_wechat_boot_index(host: &WasmHost, scale: u32, index: u32) -> i32 {
    let Some(app) = wechat_assets::APPS.get(index as usize) else {
        host.result.borrow_mut().clear();
        host.result.borrow_mut().extend_from_slice(b"invalid WeChat Guest app index");
        return -1;
    };
    host.app_index.set(index as usize);
    host.result.borrow_mut().clear();
    let identity = wechat_assets::APP_IDS.get(index as usize).copied().unwrap_or("wechat");
    if crate::browser::web_set_identity(host, identity.as_ptr(), identity.len(), BINDING_GENERATION) != 0 {
        return -1;
    }
    crate::browser::web_boot(host, app.qjbc.as_ptr(), app.qjbc.len(), app.pak.as_ptr(), app.pak.len(), app.tick_hz, scale)
}

/// Return the topmost generated compositor surface at a logical point. Zero
/// means the SystemUI/root surface owns the point; a negative value indicates
/// that the core was busy or the point could not be inspected.
#[no_mangle]
pub extern "C" fn web_wechat_hit_surface(host: &WasmHost, x: f32, y: f32) -> i32 {
    let Ok(mut ops) = host.ops.try_borrow_mut() else { return -1; };
    let Ok(mut core) = ops.core_mut() else { return -1; };
    // Ask the retained UI tree first so a painted SystemUI button (for
    // example the top-right close control) wins over a full-screen child.
    // NodeType::Surface is the pinned core enum value 3.
    // Bounds-only hit testing is intentional here: a compositor Surface has
    // no ink of its own, so the normal paint hit test can pass through it to
    // its shell wrapper. The bounds twin still lets a real SystemUI close
    // button claim its own rectangle before the child surface.
    let hit = core.hit_test_bounds(x, y);
    if core.node_type(hit) != Some(3) { return 0; }
    let frames = core.compositor_surface_frames();
    for frame in frames.iter().rev() {
        let [left, top, width, height] = frame.clip;
        if frame.focused && x >= left && y >= top && x < left + width && y < top + height {
            return frame.handle as i32;
        }
    }
    0
}

/// Retain the pinned upload validation/allocation path while recording the
/// actual pixel density of a child raster. The compositor samples its source
/// rectangle in logical units, so a high-resolution upload must carry density.
#[no_mangle]
pub unsafe extern "C" fn web_wechat_upload_surface(
    host: &WasmHost,
    handle: i32,
    pointer: *const u8,
    length: usize,
    width: u32,
    height: u32,
    density: u32,
) -> i32 {
    if pointer.is_null() || !(1..=4).contains(&density)
        || width % density != 0 || height % density != 0
    {
        return -1;
    }
    let uploaded = crate::web_upload_surface(host, handle, pointer, length, width, height);
    if uploaded >= 0 {
        if let Some(Some(raster)) = host.surfaces.borrow_mut().get_mut(uploaded as usize) {
            raster.width = width / density;
            raster.height = height / density;
            raster.density = density;
        }
    }
    uploaded
}
