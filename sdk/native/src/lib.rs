//! Small PocketJS -> Flutter POC host.
//!
//! This deliberately uses PocketJS's retained UI core and its QuickJS guest,
//! but exposes a tiny JSON bridge to Dart.  The Flutter side owns painting;
//! this library owns JavaScript execution, flexbox layout and frame timing.

pub mod bytecode;

use pocket_draw_ops::{DrawOps, Operation};
use pocket_drivers::{abi, AxisDelta, MotionState};
use pocket_guest_rquickjs::{BindingProfile, RquickjsGuest};
use pocket_runtime::{AssetRegistry, Guest, GuestEnvironment, GuestFrame, OpContext};
use pocket_spec::BINDING_GENERATION;
use pocketjs_core::{damage::DamageRect, Ui};
use rquickjs::{Coerced, Ctx, Exception, FromJs, Function, Object, Value};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, CStr, CString};
use std::io::Read;
use std::ptr;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
struct NodeMeta {
    id: i32,
    kind: String,
    asset: String,
    video_id: String,
    fit: String,
    texture: i32,
    surface: i32,
    from_pack: bool,
}

/// A contact captured by the host between two guest frames.  PocketJS's
/// canonical frame ABI deliberately carries contacts as packed u32 words;
/// keeping the decoded form here lets `pocket_send(input.pointer)` resolve a
/// DOWN edge against the committed core layout exactly once.
#[derive(Clone, Copy, Debug)]
struct TouchContact {
    id: u8,
    x: u16,
    y: u16,
    hit: i32,
    surface: u8,
}

/// A complete touch snapshot queued by one host pointer edge.  PocketJS's
/// GuestFrame ABI carries a snapshot rather than explicit down/up records:
/// presence is DOWN/MOVE and disappearance is UP.  Keeping snapshots here is
/// therefore necessary when the host sends a fast down+up pair before the
/// next `pocket_frame` call.
#[derive(Clone, Debug)]
struct PendingTouchFrame {
    touches: Vec<TouchContact>,
    cancelled: Vec<TouchContact>,
    /// Consecutive move snapshots may be replaced by the newest one.  Edge
    /// snapshots are never coalesced, so DOWN/UP/CANCEL order is preserved.
    coalescible_move: bool,
}

const TOUCH_CANCEL_MARKER: u32 = 0x4000_0000;
const TOUCH_WIDE_MARKER: u32 = 0x8000_0000;
const TOUCH_COORD_MASK: u32 = 0x3ff;
const TOUCH_WIDE_ID_SHIFT: u32 = 20;
const TOUCH_LEGACY_ID_SHIFT: u32 = 18;
const MAX_FRAME_TOUCHES: usize = 8;
const DEFAULT_TICK_HZ: u32 = 60;
const MAX_HOST_TICK_HZ: u32 = 120;
const MAX_FRAME_DELTA_MS: f64 = 1000.0;
const MAX_CATCH_UP_TICKS: u32 = MAX_HOST_TICK_HZ;
const CLOCK_EPSILON_MS: f64 = 1.0e-9;

// The POC has one host-owned Flutter video Texture.  Framework
// CompositorSurface resolves its package prop through ui.__surfaces before it
// calls the canonical setCompositorSurface operation.  Keep this mapping in
// the native host (rather than asking the TSX bundle to call a private
// registration API) so the official primitive follows the same path as a
// Pocket System compositor surface.
const POCKET_FLUTTER_SURFACE_PACKAGE: &str = "pocket.flutter.surface";
const POCKET_FLUTTER_SURFACE: i32 = 1;

fn normalize_video_fit(value: Option<&str>) -> String {
    match value {
        Some("contain") => "contain",
        Some("fill") => "fill",
        Some("cover") => "cover",
        _ => "cover",
    }
    .to_owned()
}

#[derive(Clone, Debug, Serialize)]
struct FrameOp {
    #[serde(rename = "type")]
    kind: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// Flutter texture fitting policy carried by a video SURFACE_QUAD.
    /// The native bridge accepts only the canonical cover/contain/fill values;
    /// absent or unknown metadata is normalized to cover.
    #[serde(skip_serializing_if = "Option::is_none")]
    fit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<u32>,
    /// First/last endpoint of a real core GRAD_RECT. Colors use the public
    /// FrameResult ARGB convention (the core DrawList stores ABGR).
    #[serde(rename = "from", skip_serializing_if = "Option::is_none")]
    from_color: Option<u32>,
    #[serde(rename = "to", skip_serializing_if = "Option::is_none")]
    to_color: Option<u32>,
    /// pocket_spec::GradDir: 0=top, 1=bottom, 2=left, 3=right.
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f32>,
    #[serde(rename = "fontSlot", skip_serializing_if = "Option::is_none")]
    font_slot: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    radius: Option<f32>,
    /// Triangle geometry is present only for TRI/TEX_TRI records. Keeping
    /// the vertices instead of reducing them to an AABB lets a Canvas host
    /// preserve real rotated/gouraud DrawList output.
    #[serde(skip_serializing_if = "Option::is_none")]
    points: Option<Vec<FramePoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    colors: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uvs: Option<Vec<f32>>,
    /// Normalized source rectangle for an axis-aligned TEX_QUAD. This is
    /// essential for PAK sprite atlases; [0,0,1,1] is the ordinary image
    /// case. TEX_TRI uses `uvs` above because it has one pair per vertex.
    #[serde(rename = "uv", skip_serializing_if = "Option::is_none")]
    uv: Option<Vec<f32>>,
    clip: Clip,
}

#[derive(Clone, Debug, Serialize)]
struct FramePoint {
    x: f32,
    y: f32,
}

#[derive(Clone, Debug, Serialize)]
struct Clip {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Serialize)]
struct FrameResult {
    frame: u64,
    width: f32,
    height: f32,
    ops: Vec<FrameOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auxiliary: Option<SurfaceFrame>,
    events: Vec<serde_json::Value>,
    resources: Vec<FrameResource>,
    #[serde(rename = "releasedResources", skip_serializing_if = "Vec::is_empty")]
    released_resources: Vec<String>,
}

#[derive(Clone, Serialize)]
struct SurfaceFrame {
    width: f32,
    height: f32,
    ops: Vec<FrameOp>,
}

/// The decoded DrawList is normally identical for several vblanks.  Keep the
/// actual core words alongside the decoded operations so a stable frame can
/// bypass both DrawOps decoding and the large serde JSON walk. The node list
/// is part of the key because image/video asset mapping is host metadata which
/// is not encoded in the DrawList itself.
#[derive(Clone)]
struct FrameDrawCache {
    words: Vec<u32>,
    auxiliary_words: Option<Vec<u32>>,
    width: f32,
    height: f32,
    auxiliary_size: Option<(f32, f32)>,
    /// Core's raster revision catches in-place texture writes whose DrawList
    /// words and generation-tagged handles remain unchanged.  A regular
    /// DrawList equality check alone would incorrectly treat those frames as
    /// static and let the Dart image cache keep stale pixels.
    raster_revision: u64,
    nodes: Vec<NodeMeta>,
    ops: Vec<FrameOp>,
    auxiliary: Option<SurfaceFrame>,
    generic_texture_handles: Vec<i32>,
}

impl FrameDrawCache {
    fn matches(
        &self,
        words: &[u32],
        auxiliary_words: Option<&[u32]>,
        width: f32,
        height: f32,
        auxiliary_size: Option<(f32, f32)>,
        raster_revision: u64,
        nodes: &[NodeMeta],
    ) -> bool {
        self.width == width
            && self.height == height
            && self.auxiliary_size == auxiliary_size
            && self.raster_revision == raster_revision
            && self.nodes == nodes
            && self.words == words
            && self.auxiliary_words.as_deref() == auxiliary_words
    }
}

struct BuiltFrame {
    result: FrameResult,
    draw_cache_hit: bool,
}

/// One PAK image copied from the real core texture table.  Flutter can decode
/// this once and cache a ui.Image; no rootBundle asset or Dart-side texture
/// handle mapping is required for official Solid images.
#[derive(Serialize)]
struct FrameResource {
    asset: String,
    /// Live core texture content revision. Generation-tagged handles detect
    /// free/reuse; this field detects an in-place update of the same handle.
    revision: u64,
    width: u32,
    height: u32,
    psm: u32,
    linear: bool,
    pixels: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    palette: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SentResource {
    texture: i32,
    revision: u64,
}

pub struct HostState {
    ops: OpContext,
    guest: RquickjsGuest,
    nodes: Rc<RefCell<Vec<NodeMeta>>>,
    outbound: Rc<RefCell<Vec<serde_json::Value>>>,
    last_error: String,
    error_output: CString,
    output: CString,
    frame: u64,
    /// Fixed core/guest tick rate selected before the guest is mounted.  The
    /// PocketJS bundle must have been built for this same rate (`--hz`).
    tick_hz: u32,
    /// Wall-clock remainder used to turn host frame deltas into deterministic
    /// fixed ticks.  `Ui::tick` never consumes a variable delta itself.
    tick_remainder_ms: f64,
    clock_started: bool,
    viewport_width: f32,
    viewport_height: f32,
    /// Immutable pixels-per-logical-pixel contract used by core-generated
    /// bitmap resources (rounded/shadow masks and baked raster assets).
    raster_density: u32,
    auxiliary_viewport: Option<(f32, f32)>,
    guest_loaded: bool,
    touches: Vec<TouchContact>,
    pending_touch_frames: Vec<PendingTouchFrame>,
    buttons: u32,
    analog: u32,
    right_analog: u32,
    axis_deltas: Vec<AxisDelta>,
    motion: Option<MotionState>,
    text_metrics: Rc<RefCell<TextMetrics>>,
    sent_resources: HashMap<String, SentResource>,
    draw_cache: Option<FrameDrawCache>,
    frame_json_cache: Option<String>,
    // These counters are intentionally kept in the native host so regression
    // tests can measure the optimization without changing the Dart ABI. They
    // count actual serde passes/bytes, not Dart Stream objects or estimates.
    frame_json_serializations: u64,
    frame_json_serialized_bytes: u64,
    frame_json_cache_hits: u64,
    draw_decode_count: u64,
}

fn c_string(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|_| CString::new("invalid utf8").unwrap())
}

fn clear_error(host: &mut HostState) {
    host.last_error.clear();
    host.error_output = c_string("");
}

fn set_error(host: &mut HostState, error: impl Into<String>) {
    host.last_error = error.into();
    host.error_output = c_string(&host.last_error);
}

/// Patch only the leading frame number in a previously serialized static
/// FrameResult. serde preserves the declaration order here; validate the
/// prefix and comma so a future field-order change falls back to full encode.
fn patch_frame_number(cached: &str, frame: u64) -> Option<CString> {
    const PREFIX: &str = "{\"frame\":";
    let rest = cached.strip_prefix(PREFIX)?;
    let comma = rest.find(',')?;
    let frame = frame.to_string();
    let mut output = Vec::with_capacity(cached.len() + 4);
    output.extend_from_slice(PREFIX.as_bytes());
    output.extend_from_slice(frame.as_bytes());
    output.extend_from_slice(rest[comma..].as_bytes());
    CString::new(output).ok()
}

const UNCHANGED_FRAME_JSON: &str = "{\"unchanged\":true}";

/// Read a committed node rectangle for a host-owned overlay.
///
/// `Ui::layout_of` is relative to the node's parent. The Flutter
/// canvas/overlay host needs logical surface coordinates, so walk the
/// retained parent chain and accumulate the real core layout rectangles. A
/// relayout is requested before the read to ensure a query made from a guest
/// press callback cannot observe a dirty/stale frame. Detached and stale
/// generation-tagged ids return `None`; the primary and optional auxiliary
/// roots are the only valid parent-less nodes.
fn committed_layout(ops: &OpContext, id: i32) -> Result<Option<(f32, f32, f32, f32)>, String> {
    if id == 0 {
        return Ok(None);
    }
    let mut core = ops
        .core_mut()
        .map_err(|error| format!("layout query: {error:?}"))?;
    core.ui.relayout_outputs();
    if !core.ui.node_exists(id) {
        return Ok(None);
    }
    let auxiliary_root = core.ui.auxiliary_surface_root();
    let mut current = id;
    let mut x = 0.0_f32;
    let mut y = 0.0_f32;
    let mut width = 0.0_f32;
    let mut height = 0.0_f32;
    let mut depth = 0usize;
    loop {
        let Some((local_x, local_y, local_w, local_h)) = core.ui.layout_of(current) else {
            return Ok(None);
        };
        if current == id {
            width = local_w;
            height = local_h;
        }
        x += local_x;
        y += local_y;
        let parent = core.ui.node_parent(current);
        if parent == 0 {
            if current != pocket_spec::ROOT_ID && current != auxiliary_root {
                return Ok(None);
            }
            break;
        }
        depth += 1;
        if depth >= 64 {
            return Err("layout query exceeded the core parent depth limit".to_owned());
        }
        current = parent;
    }
    if [x, y, width, height].iter().any(|value| !value.is_finite()) {
        return Err("layout query returned a non-finite rectangle".to_owned());
    }
    Ok(Some((x, y, width, height)))
}

fn js_layout<'js>(ctx: Ctx<'js>, ops: &OpContext, id: i32) -> rquickjs::Result<Value<'js>> {
    let Some((x, y, width, height)) = committed_layout(ops, id)
        .map_err(|error| Exception::throw_internal(&ctx, error.as_str()))?
    else {
        return Ok(Value::new_null(ctx.clone()));
    };
    let result = Object::new(ctx.clone())?;
    result.set("x", x)?;
    result.set("y", y)?;
    result.set("width", width)?;
    result.set("height", height)?;
    Ok(result.into_value())
}

fn empty_frame_json(host: &HostState) -> String {
    let mut frame = serde_json::json!({
        "frame": host.frame,
        "width": host.viewport_width,
        "height": host.viewport_height,
        "ops": [],
        "events": [],
        "resources": [],
        "releasedResources": [],
    });
    if let Some((width, height)) = host.auxiliary_viewport {
        frame["auxiliary"] = serde_json::json!({
            "width": width,
            "height": height,
            "ops": [],
        });
    }
    frame.to_string()
}

fn install_bridge(
    guest: &RquickjsGuest,
    ops: OpContext,
    nodes: Rc<RefCell<Vec<NodeMeta>>>,
    outbound: Rc<RefCell<Vec<serde_json::Value>>>,
    auxiliary: Option<(i32, f32, f32)>,
) -> Result<(), String> {
    guest
        .with(|ctx| {
            let globals = ctx.globals();
            let bridge = Object::new(ctx.clone())?;

            let emit_queue = outbound.clone();
            let emit = Function::new(ctx.clone(), move |_ctx: Ctx<'_>, line: String| {
                let parsed = serde_json::from_str::<serde_json::Value>(&line).unwrap_or_else(
                    |_| serde_json::json!({"type":"error","message":"invalid bridge payload"}),
                );
                emit_queue.borrow_mut().push(parsed);
                // The official PocketJS app/stream bridge treats the host
                // emitter as a boolean transport. Returning `undefined`
                // makes a valid queued event look rejected to
                // `stream.open`/`host.request`, even though it was accepted
                // by this native queue.
                Ok::<bool, rquickjs::Error>(true)
            })?;
            bridge.set("_emit", emit)?;

            let register_nodes = nodes.clone();
            let register = Function::new(
                ctx.clone(),
                move |_ctx: Ctx<'_>, id: i32, kind: String, payload: String| {
                    let mut list = register_nodes.borrow_mut();
                    list.retain(|node| node.id != id);
                    let mut meta = NodeMeta {
                        id,
                        kind,
                        asset: String::new(),
                        video_id: String::new(),
                        fit: "cover".to_owned(),
                        texture: -1,
                        surface: -1,
                        from_pack: false,
                    };
                    if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&payload) {
                        meta.asset = extra
                            .get("asset")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_owned();
                        meta.video_id = extra
                            .get("videoId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_owned();
                        meta.fit = normalize_video_fit(extra.get("fit").and_then(|v| v.as_str()));
                        meta.texture =
                            extra.get("texture").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
                        meta.surface =
                            extra.get("surface").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
                    }
                    list.push(meta);
                    Ok::<(), rquickjs::Error>(())
                },
            )?;
            bridge.set("_register", register)?;

            // Generic compositor providers. JS owns component composition and
            // optics; the host only binds a retained SURFACE_QUAD to a renderer.
            // Handles are never reused within a runtime, so stale nodes cannot
            // accidentally display a newly registered native texture.
            let surface_nodes = nodes.clone();
            let next_surface = Rc::new(RefCell::new(100_i32));
            let register_surface = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>, package: String, kind: String, payload: String| {
                    if package.is_empty() || package.len() > 160
                        || !matches!(kind.as_str(), "glass" | "platformTexture")
                        || payload.len() > 8192 {
                        return Err(Exception::throw_type(&ctx, "invalid compositor provider"));
                    }
                    let data: serde_json::Value = serde_json::from_str(&payload)
                        .map_err(|_| Exception::throw_type(&ctx, "invalid surface parameters"))?;
                    if !data.is_object() {
                        return Err(Exception::throw_type(&ctx, "surface parameters must be an object"));
                    }
                    let mut list = surface_nodes.borrow_mut();
                    let existing = list.iter().position(|n| n.kind == "hostSurface" && n.video_id == package);
                    let handle = if let Some(index) = existing {
                        list[index].surface
                    } else {
                        if list.iter().filter(|n| n.kind == "hostSurface").count() >= 64 {
                            return Err(Exception::throw_type(&ctx, "surface limit exceeded"));
                        }
                        let mut next = next_surface.borrow_mut();
                        let handle = *next;
                        *next = next.checked_add(1)
                            .ok_or_else(|| Exception::throw_type(&ctx, "surface handles exhausted"))?;
                        handle
                    };
                    let descriptor = serde_json::json!({"kind": kind, "parameters": data}).to_string();
                    let meta = NodeMeta {
                        id: -handle, kind: "hostSurface".into(), asset: descriptor,
                        video_id: package.clone(), fit: "fill".into(), texture: -1,
                        surface: handle, from_pack: false,
                    };
                    if let Some(index) = existing { list[index] = meta; } else { list.push(meta); }
                    let ui: Object = ctx.globals().get("ui")?;
                    let surfaces: Object = ui.get("__surfaces")?;
                    surfaces.set(package, handle)?;
                    Ok(handle)
                },
            )?;
            bridge.set("registerSurface", register_surface)?;
            let release_nodes = nodes.clone();
            bridge.set("releaseSurface", Function::new(ctx.clone(), move |ctx: Ctx<'_>, package: String| {
                release_nodes.borrow_mut().retain(|n| !(n.kind == "hostSurface" && n.video_id == package));
                let ui: Object = ctx.globals().get("ui")?;
                let surfaces: Object = ui.get("__surfaces")?;
                surfaces.remove(package)?;
                Ok::<(), rquickjs::Error>(())
            })?)?;


            // Host extension, deliberately kept outside canonical `ui.*`:
            // Flutter overlays need the committed logical rectangle of a
            // retained node, while PocketJS's public UI contract exposes no
            // layout read-back operation. Return null for stale/detached
            // generation-tagged ids and a named object for live nodes.
            let layout_ops = ops.clone();
            let get_layout =
                Function::new(ctx.clone(), move |ctx, id| js_layout(ctx, &layout_ops, id))?;
            bridge.set("getLayout", get_layout)?;
            globals.set("pocket", bridge)?;

            // `CompositorSurface` is an official framework primitive.  Its
            // package prop is resolved by native-tree.ts through this map;
            // leaving the map empty makes the framework deliberately bind -1
            // and the core emits no SURFACE_QUAD.  The POC owns one Flutter
            // Texture, so publish its package-to-surface handle before any
            // bundle code is evaluated.  This is intentionally a single
            // explicit host capability, not a JS-side fake rectangle.
            let ui: Object = globals.get("ui")?;
            let surfaces = Object::new(ctx.clone())?;
            surfaces.set(POCKET_FLUTTER_SURFACE_PACKAGE, POCKET_FLUTTER_SURFACE)?;
            ui.set("__surfaces", surfaces)?;
            if let Some((root, width, height)) = auxiliary {
                let descriptor = Object::new(ctx.clone())?;
                descriptor.set("root", root)?;
                descriptor.set("w", width)?;
                descriptor.set("h", height)?;
                ui.set("__auxiliarySurface", descriptor)?;
            }
            Ok::<(), rquickjs::Error>(())
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
        .map_err(|error| error.to_string())
}

fn auxiliary_descriptor(host: &HostState) -> Option<(i32, f32, f32)> {
    let (width, height) = host.auxiliary_viewport?;
    let root = host
        .ops
        .core()
        .ok()
        .map(|core| core.ui.auxiliary_surface_root())
        .unwrap_or(0);
    (root != 0).then_some((root, width, height))
}

fn guest_environment<'a>(
    host: &HostState,
    pak: &'a [u8],
    assets: Option<&'a AssetRegistry>,
) -> GuestEnvironment<'a> {
    let auxiliary_viewport = host
        .auxiliary_viewport
        .map(|(width, height)| [width as u32, height as u32]);
    GuestEnvironment {
        host: "flutter-canvas-poc",
        host_abi: BINDING_GENERATION,
        tick_hz: host.tick_hz,
        viewport: [host.viewport_width as u32, host.viewport_height as u32],
        auxiliary_viewport,
        auxiliary_root: auxiliary_viewport
            .and_then(|_| {
                host.ops
                    .core()
                    .ok()
                    .map(|core| core.ui.auxiliary_surface_root())
            })
            .unwrap_or(0),
        raster_density: host.raster_density,
        heap_limit: guest_heap_limit(pak.len()),
        pak,
        assets,
    }
}

/// Convert a QuickJS exception into a useful host diagnostic.  rquickjs's
/// `Error::Exception` Display implementation is only "Exception generated by
/// QuickJS"; the actual thrown Error object still contains `message` and
/// `stack`, which are essential when a framework bridge handler fails.
fn quickjs_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if !matches!(error, rquickjs::Error::Exception) {
        return error.to_string();
    }
    let value = ctx.catch();
    let object = value.as_object();
    let message = object
        .as_ref()
        .and_then(|object| object.get::<_, String>("message").ok())
        .or_else(|| {
            Coerced::<String>::from_js(ctx, value.clone())
                .ok()
                .map(|value| value.0)
        });
    let stack = object
        .as_ref()
        .and_then(|object| object.get::<_, String>("stack").ok());
    let mut detail = message.unwrap_or_else(|| "JavaScript exception".to_owned());
    if let Some(stack) = stack.filter(|stack| !stack.is_empty() && *stack != detail) {
        detail.push_str("\nJS stack:\n");
        detail.push_str(&stack);
    }
    format!("QuickJS exception: {detail}")
}

fn evaluate_guest(guest: &mut RquickjsGuest, source: &str, tick_hz: u32) -> Result<(), String> {
    // The canonical framework latches globalThis.__simHz while render() is
    // evaluated.  Native hosts do not have a separate package loader script,
    // so publish the selected host virtual-frame rate immediately before the
    // caller's bundle/source.  This is deliberately a prelude rather than a
    // post-eval mutation: resetClock() must observe it during mount.
    let prelude = format!("globalThis.__simHz = {tick_hz};\n");
    let mut script = String::with_capacity(prelude.len() + source.len());
    script.push_str(&prelude);
    script.push_str(source);
    guest.evaluate(script.as_bytes()).map_err(|error| {
        guest
            .last_error()
            .map(|detail| format!("guest evaluate: {error:?}: {detail}"))
            .unwrap_or_else(|| format!("guest evaluate: {error:?}"))
    })
}

fn dispatch_guest(guest: &RquickjsGuest, function_name: &str, line: &str) -> Result<(), String> {
    guest
        .with(|ctx| -> Result<(), String> {
            let value: Value = ctx
                .globals()
                .get(function_name)
                .map_err(|error| quickjs_error(&ctx, error))?;
            if value.is_undefined() {
                return Ok(());
            }
            let function =
                Function::from_js(&ctx, value).map_err(|error| quickjs_error(&ctx, error))?;
            function
                .call::<_, ()>((line.to_owned(),))
                .map_err(|error| quickjs_error(&ctx, error))
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

/// Update the framework's live-viewport hook in the existing QuickJS realm.
///
/// The compiled framework installs `globalThis.__pocketResizeViewport` after
/// mount. Calling that hook keeps the retained app/overlay roots and
/// `ui.__viewport` synchronized without remounting or resetting route state.
/// Source-only guests may not install the hook; in that case update the
/// official `ui.__viewport` object directly and leave their tree untouched.
fn resize_guest_viewport(guest: &RquickjsGuest, width: f32, height: f32) -> Result<(), String> {
    guest
        .with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();
            let hook: Value = globals
                .get("__pocketResizeViewport")
                .map_err(|error| quickjs_error(&ctx, error))?;
            if !hook.is_undefined() && !hook.is_null() {
                let function =
                    Function::from_js(&ctx, hook).map_err(|error| quickjs_error(&ctx, error))?;
                function
                    .call::<_, ()>((width, height))
                    .map_err(|error| quickjs_error(&ctx, error))?;
                return Ok(());
            }

            // A raw guest can still observe the official host viewport even
            // when it does not use the framework renderer hook.
            let ui: Value = globals
                .get("ui")
                .map_err(|error| quickjs_error(&ctx, error))?;
            let Some(ui) = ui.as_object() else {
                return Ok(());
            };
            let viewport = Object::new(ctx.clone()).map_err(|error| quickjs_error(&ctx, error))?;
            viewport
                .set("w", width)
                .map_err(|error| quickjs_error(&ctx, error))?;
            viewport
                .set("h", height)
                .map_err(|error| quickjs_error(&ctx, error))?;
            ui.set("__viewport", viewport)
                .map_err(|error| quickjs_error(&ctx, error))?;
            Ok(())
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

fn pack_touch(contact: TouchContact) -> u32 {
    // framework/src/touch.ts supports the wide form for logical coordinates
    // above 511.  The POC's maximum packed coordinate is 1023 (the official
    // ten-bit wire format); create() still accepts larger viewports, but
    // input.pointer rejects coordinates outside this canonical range.
    let wide = contact.x > 511 || contact.y > 511;
    if wide {
        TOUCH_WIDE_MARKER
            | ((contact.id as u32) << TOUCH_WIDE_ID_SHIFT)
            | ((contact.y as u32 & TOUCH_COORD_MASK) << 10)
            | (contact.x as u32 & TOUCH_COORD_MASK)
    } else {
        ((contact.id as u32) << TOUCH_LEGACY_ID_SHIFT)
            | ((contact.y as u32 & 0x1ff) << 9)
            | (contact.x as u32 & 0x1ff)
    }
}

fn pack_touch_cancel(id: u8) -> u32 {
    TOUCH_CANCEL_MARKER | ((id as u32) << TOUCH_LEGACY_ID_SHIFT)
}

fn pointer_payload<'a>(message: &'a serde_json::Value) -> Option<&'a serde_json::Value> {
    message
        .get("payload")
        .or_else(|| message.get("params"))
        .filter(|value| value.is_object())
}

fn pointer_surface(host: &HostState, payload: &serde_json::Value) -> Result<u8, String> {
    let value = payload.get("surface");
    let surface = match value {
        None => 0,
        Some(value) if value.as_u64() == Some(0) => 0,
        Some(value) if value.as_u64() == Some(1) => 1,
        Some(value) => match value.as_str() {
            Some("primary") => 0,
            Some("auxiliary") => 1,
            _ => {
                return Err(
                    "input.pointer payload.surface must be primary/auxiliary or 0/1".to_owned(),
                )
            }
        },
    };
    if surface == 1 && host.auxiliary_viewport.is_none() {
        return Err("input.pointer auxiliary surface is not enabled".to_owned());
    }
    Ok(surface)
}

fn enqueue_touch_frame(host: &mut HostState, cancelled: Vec<TouchContact>, coalescible_move: bool) {
    let snapshot = PendingTouchFrame {
        touches: host.touches.clone(),
        cancelled,
        coalescible_move,
    };
    if coalescible_move
        && host
            .pending_touch_frames
            .last()
            .is_some_and(|pending| pending.coalescible_move)
    {
        *host
            .pending_touch_frames
            .last_mut()
            .expect("move snapshot exists") = snapshot;
    } else {
        host.pending_touch_frames.push(snapshot);
    }
}

/// Capture one host pointer edge.  A DOWN resolves the official core bounds
/// hit once, then the id/hit pair is carried in every GuestFrame until UP or
/// CANCEL.  No Flutter-side hit rectangle is involved in this path.
fn queue_pointer(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let Some(payload) = pointer_payload(message) else {
        return Err("input.pointer requires an object payload".to_owned());
    };
    let phase = payload
        .get("phase")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            "input.pointer payload.phase must be down, move, up, or cancel".to_owned()
        })?;
    let id = payload
        .get("id")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    if id > u8::MAX as u64 {
        return Err("input.pointer payload.id must be an integer in [0,255]".to_owned());
    }
    let id = id as u8;
    let surface = pointer_surface(host, payload)?;
    let x_value = payload
        .get("x")
        .and_then(|value| value.as_f64())
        .ok_or_else(|| "input.pointer payload.x must be finite".to_owned())?;
    let y_value = payload
        .get("y")
        .and_then(|value| value.as_f64())
        .ok_or_else(|| "input.pointer payload.y must be finite".to_owned())?;
    if !x_value.is_finite() || !y_value.is_finite() {
        return Err("input.pointer payload coordinates must be finite".to_owned());
    }
    let x = x_value.round();
    let y = y_value.round();
    let (surface_width, surface_height) = if surface == 1 {
        host.auxiliary_viewport
            .ok_or_else(|| "input.pointer auxiliary surface is not enabled".to_owned())?
    } else {
        (host.viewport_width, host.viewport_height)
    };
    if x < 0.0
        || y < 0.0
        || x > TOUCH_COORD_MASK as f64
        || y > TOUCH_COORD_MASK as f64
        || x > surface_width as f64
        || y > surface_height as f64
    {
        return Err(format!(
            "input.pointer coordinates ({x_value},{y_value}) exceed the logical viewport or 10-bit touch wire format"
        ));
    }
    let x = x as u16;
    let y = y as u16;

    match phase {
        "down" => {
            if host
                .touches
                .iter()
                .all(|contact| contact.id != id || contact.surface != surface)
                && host.touches.len() >= MAX_FRAME_TOUCHES
            {
                return Err(format!(
                    "input.pointer has more than {MAX_FRAME_TOUCHES} active contacts"
                ));
            }
            let hit = {
                let mut core = host
                    .ops
                    .core_mut()
                    .map_err(|error| format!("input.pointer hit-test: {error:?}"))?;
                if surface == 0 {
                    core.ui.hit_test_bounds(x as f32, y as f32)
                } else {
                    core.ui.hit_test_bounds_auxiliary(x as f32, y as f32)
                }
            };
            host.touches
                .retain(|contact| contact.id != id || contact.surface != surface);
            host.touches.push(TouchContact {
                id,
                x,
                y,
                hit,
                surface,
            });
            enqueue_touch_frame(host, Vec::new(), false);
        }
        "move" => {
            let Some(contact) = host
                .touches
                .iter_mut()
                .find(|contact| contact.id == id && contact.surface == surface)
            else {
                return Err(format!("input.pointer move for unknown contact id {id}"));
            };
            contact.x = x;
            contact.y = y;
            enqueue_touch_frame(host, Vec::new(), true);
        }
        "up" => {
            host.touches
                .retain(|contact| contact.id != id || contact.surface != surface);
            enqueue_touch_frame(host, Vec::new(), false);
        }
        "cancel" => {
            if let Some(contact) = host
                .touches
                .iter()
                .find(|contact| contact.id == id && contact.surface == surface)
            {
                let cancelled = vec![*contact];
                host.touches
                    .retain(|active| active.id != id || active.surface != surface);
                enqueue_touch_frame(host, cancelled, false);
            }
        }
        _ => {
            return Err(format!(
                "input.pointer payload.phase {phase:?} must be down, move, up, or cancel"
            ));
        }
    }
    Ok(())
}

fn input_value<'a>(message: &'a serde_json::Value) -> &'a serde_json::Value {
    message
        .get("payload")
        .or_else(|| message.get("params"))
        .unwrap_or(message)
}

fn input_u32(value: Option<&serde_json::Value>, name: &str) -> Result<u32, String> {
    let number = value
        .and_then(|item| item.as_u64())
        .ok_or_else(|| format!("{name} must be an unsigned 32-bit integer"))?;
    u32::try_from(number).map_err(|_| format!("{name} is outside the u32 range"))
}

fn queue_buttons(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let value = input_value(message);
    let buttons = if value.is_number() {
        input_u32(Some(value), "input.buttons")?
    } else {
        input_u32(value.get("buttons"), "input.buttons.buttons")?
    };
    host.buttons = buttons;
    if let Some(analog) = value.get("analog") {
        host.analog = input_u32(Some(analog), "input.buttons.analog")?;
    }
    if let Some(right_analog) = value.get("rightAnalog") {
        host.right_analog = input_u32(Some(right_analog), "input.buttons.rightAnalog")?;
    }
    Ok(())
}

fn packed_axis_values(host: &HostState) -> [u32; 4] {
    [
        (host.analog >> 8) & 0xff,
        host.analog & 0xff,
        (host.right_analog >> 8) & 0xff,
        host.right_analog & 0xff,
    ]
}

fn axis_entry(entry: &serde_json::Value) -> Result<(u32, f64), String> {
    let id = entry
        .get("id")
        .or_else(|| entry.get("axis"))
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "input.axes entry.id must be 0..3".to_owned())?;
    let value = entry
        .get("value")
        .and_then(|item| item.as_f64())
        .ok_or_else(|| "input.axes entry.value must be finite".to_owned())?;
    if id > 3 || !value.is_finite() {
        return Err("input.axes entry requires id 0..3 and a finite value".to_owned());
    }
    Ok((id as u32, value))
}

fn queue_axes(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let value = input_value(message);
    let entries = value
        .get("axes")
        .and_then(|item| item.as_array())
        .or_else(|| value.as_array())
        .ok_or_else(|| "input.axes requires an axes array".to_owned())?;
    let mut packed = packed_axis_values(host);
    for entry in entries {
        let (id, value) = axis_entry(entry)?;
        packed[id as usize] = value.clamp(0.0, 255.0) as u32;
    }
    host.analog = (packed[0] << 8) | packed[1];
    host.right_analog = (packed[2] << 8) | packed[3];
    if let Some(relative) = value.get("relative").and_then(|item| item.as_array()) {
        queue_relative_axes(host, relative)?;
    }
    Ok(())
}

fn queue_relative_axes(host: &mut HostState, entries: &[serde_json::Value]) -> Result<(), String> {
    for entry in entries {
        let id = entry
            .get("id")
            .or_else(|| entry.get("axis"))
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "relative axis entry.id must be 0 or 1".to_owned())?;
        let delta = entry
            .get("delta")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| "relative axis entry.delta must be a signed i32".to_owned())?;
        let id = u32::try_from(id).map_err(|_| "relative axis id is outside u32".to_owned())?;
        let delta = i32::try_from(delta)
            .map_err(|_| "relative axis delta is outside the i32 range".to_owned())?;
        if id > 1 {
            return Err("relative axis entry.id must be 0 or 1".to_owned());
        }
        host.axis_deltas.push(AxisDelta { id, delta });
    }
    Ok(())
}

fn queue_relative_axis(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let value = input_value(message);
    let entries = if value.is_array() {
        value.as_array().expect("JSON array checked above").clone()
    } else {
        vec![value.clone()]
    };
    queue_relative_axes(host, &entries)
}

fn motion_numbers(object: &serde_json::Value, key: &str, count: usize) -> Result<Vec<f32>, String> {
    let values = object
        .get(key)
        .and_then(|value| value.get("value"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| format!("input.motion.{key}.value must be an array"))?;
    if values.len() != count {
        return Err(format!(
            "input.motion.{key}.value must contain {count} numbers"
        ));
    }
    values
        .iter()
        .map(|value| {
            let number = value
                .as_f64()
                .ok_or_else(|| format!("input.motion.{key}.value must be finite"))?;
            let number = number as f32;
            if !number.is_finite() {
                return Err(format!("input.motion.{key}.value must be finite"));
            }
            Ok(number)
        })
        .collect()
}

fn motion_scalar(object: &serde_json::Value, key: &str) -> Result<f32, String> {
    let number = object
        .get(key)
        .and_then(|value| value.get("value"))
        .and_then(|value| value.as_f64())
        .ok_or_else(|| format!("input.motion.{key}.value must be finite"))?;
    let number = number as f32;
    if number.is_finite() {
        Ok(number)
    } else {
        Err(format!("input.motion.{key}.value must be finite"))
    }
}

fn motion_quality(object: &serde_json::Value, key: &str) -> Result<u8, String> {
    let quality = object
        .get(key)
        .and_then(|value| value.get("quality"))
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("input.motion.{key}.quality must be 0..4"))?;
    if quality > 4 {
        return Err(format!("input.motion.{key}.quality must be 0..4"));
    }
    Ok(quality as u8)
}

fn motion_reference_frame(object: &serde_json::Value, key: &str) -> Result<u8, String> {
    let frame = object
        .get(key)
        .and_then(|value| value.get("referenceFrame"))
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("input.motion.{key}.referenceFrame must be 0..3"))?;
    if frame > 3 {
        return Err(format!("input.motion.{key}.referenceFrame must be 0..3"));
    }
    Ok(frame as u8)
}

fn motion_epoch(object: &serde_json::Value, key: &str) -> Result<u32, String> {
    let epoch = object
        .get(key)
        .and_then(|value| value.get("epoch"))
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("input.motion.{key}.epoch must be a u32"))?;
    u32::try_from(epoch).map_err(|_| format!("input.motion.{key}.epoch must be a u32"))
}

fn queue_motion(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let value = input_value(message);
    let timestamp = value
        .get("timestamp")
        .and_then(|item| item.as_u64())
        .ok_or_else(|| "input.motion.timestamp must be a non-negative integer".to_owned())?;
    let mut motion = MotionState::default();
    motion.timestamp = timestamp;

    if value.get("gravityDirection").is_some() {
        let mut estimate = abi::PocketMotionGravityDirection::empty();
        estimate.value = motion_numbers(value, "gravityDirection", 3)?
            .try_into()
            .unwrap();
        estimate.quality = motion_quality(value, "gravityDirection")?;
        motion.gravity_direction = Some(estimate);
    }
    if value.get("inclination").is_some() {
        let mut estimate = abi::PocketMotionInclination::empty();
        estimate.value = [motion_scalar(value, "inclination")?];
        estimate.quality = motion_quality(value, "inclination")?;
        motion.inclination = Some(estimate);
    }
    if value.get("linearAcceleration").is_some() {
        let mut estimate = abi::PocketMotionLinearAcceleration::empty();
        estimate.value = motion_numbers(value, "linearAcceleration", 3)?
            .try_into()
            .unwrap();
        estimate.quality = motion_quality(value, "linearAcceleration")?;
        motion.linear_acceleration = Some(estimate);
    }
    if value.get("rotationRate").is_some() {
        let mut estimate = abi::PocketMotionRotationRate::empty();
        estimate.value = motion_numbers(value, "rotationRate", 3)?
            .try_into()
            .unwrap();
        estimate.quality = motion_quality(value, "rotationRate")?;
        motion.rotation_rate = Some(estimate);
    }
    if value.get("orientation").is_some() {
        let mut estimate = abi::PocketMotionOrientation::empty();
        estimate.value = motion_numbers(value, "orientation", 4)?.try_into().unwrap();
        estimate.quality = motion_quality(value, "orientation")?;
        estimate.reference_frame = motion_reference_frame(value, "orientation")?;
        estimate.epoch = motion_epoch(value, "orientation")?;
        motion.orientation = Some(estimate);
    }
    if value.get("heading").is_some() {
        let mut estimate = abi::PocketMotionHeading::empty();
        estimate.value = [
            motion_scalar(value, "heading")?,
            value
                .get("heading")
                .and_then(|item| item.get("accuracy"))
                .and_then(|item| item.as_f64())
                .map(|item| item as f32)
                .filter(|item| item.is_finite())
                .ok_or_else(|| "input.motion.heading.accuracy must be finite".to_owned())?,
        ];
        estimate.quality = motion_quality(value, "heading")?;
        estimate.reference_frame = motion_reference_frame(value, "heading")?;
        motion.heading = Some(estimate);
    }
    if value.get("screenRotation").is_some() {
        let mut estimate = abi::PocketMotionScreenRotation::empty();
        estimate.value = [motion_scalar(value, "screenRotation")?];
        estimate.quality = motion_quality(value, "screenRotation")?;
        motion.screen_rotation = Some(estimate);
    }
    if value.get("tilt").is_some() {
        let mut estimate = abi::PocketMotionTilt::empty();
        estimate.value = motion_numbers(value, "tilt", 2)?.try_into().unwrap();
        estimate.quality = motion_quality(value, "tilt")?;
        motion.tilt = Some(estimate);
    }
    if value.get("angles").is_some() {
        let mut estimate = abi::PocketMotionAngles::empty();
        estimate.value = motion_numbers(value, "angles", 3)?.try_into().unwrap();
        estimate.quality = motion_quality(value, "angles")?;
        estimate.reference_frame = motion_reference_frame(value, "angles")?;
        estimate.epoch = motion_epoch(value, "angles")?;
        motion.angles = Some(estimate);
    }
    host.motion = Some(motion);
    Ok(())
}

fn queue_input(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let method = message
        .get("method")
        .or_else(|| message.get("name"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    match method {
        "input.pointer" => queue_pointer(host, message),
        "input.buttons" => queue_buttons(host, message),
        "input.axes" => queue_axes(host, message),
        "input.axis" | "input.axis.relative" => queue_relative_axis(host, message),
        "input.motion" => queue_motion(host, message),
        _ => Ok(()),
    }
}

fn run_guest_touch_frame(
    host: &mut HostState,
    active: &[TouchContact],
    cancelled: &[TouchContact],
) -> Result<(), String> {
    let mut touches = Vec::with_capacity(active.len() + cancelled.len());
    let mut hits = Vec::with_capacity(touches.capacity());
    let mut touch_surfaces = Vec::with_capacity(touches.capacity());
    for contact in active {
        touches.push(pack_touch(*contact));
        hits.push(contact.hit);
        touch_surfaces.push(contact.surface);
    }
    for contact in cancelled {
        touches.push(pack_touch_cancel(contact.id));
        hits.push(0);
        touch_surfaces.push(contact.surface);
    }
    let frame = GuestFrame {
        buttons: host.buttons,
        analog: host.analog,
        touches: &touches,
        hits: &hits,
        touch_surfaces: &touch_surfaces,
        right_analog: host.right_analog,
        axis_deltas: &host.axis_deltas,
        motion: host.motion.as_ref(),
        text: &[],
    };
    host.guest.frame(&frame).map_err(|error| {
        host.guest
            .last_error()
            .map(|detail| format!("{error:?}: {detail}"))
            .unwrap_or_else(|| format!("{error:?}"))
    })
}

fn decode_draw_ops(
    words: &[u32],
    width: f32,
    height: f32,
    nodes: &[NodeMeta],
    ui: &Ui,
    generic_texture_handles: &mut HashSet<i32>,
) -> Result<Vec<FrameOp>, String> {
    let viewport = DamageRect::new(0, 0, width as i32, height as i32);
    let decoded: Vec<Operation<'_>> = DrawOps::new(words, viewport)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("draw list decode: {error:?}"))?;
    let mut ops = Vec::new();
    for operation in &decoded {
        append_draw_operation(&mut ops, operation, nodes, ui, generic_texture_handles)?;
    }
    Ok(ops)
}

fn fixed_tick_count(host: &mut HostState, delta_ms: f64) -> u32 {
    let step_ms = 1000.0 / host.tick_hz as f64;
    // A freshly evaluated guest still needs one frame transaction so it can
    // publish its initial bridge requests/DrawList.  If the first host delta
    // is already large (a direct FFI caller may do this), account for that
    // elapsed time too rather than dropping it behind the startup special
    // case.
    if !host.clock_started {
        host.clock_started = true;
        host.tick_remainder_ms = if delta_ms.is_finite() {
            delta_ms.clamp(0.0, MAX_FRAME_DELTA_MS)
        } else {
            0.0
        };
        let ticks = ((host.tick_remainder_ms + CLOCK_EPSILON_MS) / step_ms).floor() as u32;
        if ticks == 0 {
            host.tick_remainder_ms = 0.0;
            return 1;
        }
        host.tick_remainder_ms -= ticks.min(MAX_CATCH_UP_TICKS) as f64 * step_ms;
        return ticks.min(MAX_CATCH_UP_TICKS);
    }
    let delta_ms = if delta_ms.is_finite() {
        delta_ms.clamp(0.0, MAX_FRAME_DELTA_MS)
    } else {
        0.0
    };
    host.tick_remainder_ms += delta_ms;
    let mut ticks = ((host.tick_remainder_ms + CLOCK_EPSILON_MS) / step_ms).floor() as u32;
    if ticks > MAX_CATCH_UP_TICKS {
        // A stalled view must not monopolize the UI isolate after it resumes.
        // The bounded drop is explicit: the fixed-step simulation never runs
        // a variable dt and the next frame starts from the remaining clock.
        ticks = MAX_CATCH_UP_TICKS;
    }
    host.tick_remainder_ms -= ticks as f64 * step_ms;
    if host.tick_remainder_ms < 0.0 {
        // This can only be caused by the bounded catch-up path.  Do not carry
        // a negative debt into a later frame.
        host.tick_remainder_ms = 0.0;
    }
    ticks
}

fn tick_core(host: &mut HostState) -> Result<(), String> {
    let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
    core.ui.tick();
    Ok(())
}

fn run_virtual_frames(
    host: &mut HostState,
    pending: Vec<PendingTouchFrame>,
    ticks: u32,
) -> Result<(), String> {
    let mut remaining_ticks = ticks;
    let mut first_guest_turn = true;

    // Every edge snapshot is a separate official GuestFrame transaction.  If
    // a fast DOWN+UP arrives between vblanks, both edges are therefore still
    // visible even when the elapsed delta did not yet reach one fixed step.
    for snapshot in pending {
        run_guest_touch_frame(host, &snapshot.touches, &snapshot.cancelled)?;
        if first_guest_turn {
            // Axes/motion are samples for one host input boundary.  Do not
            // replay them when a slower host delta requires catch-up ticks.
            host.axis_deltas.clear();
            host.motion = None;
            first_guest_turn = false;
        }
        if remaining_ticks > 0 {
            tick_core(host)?;
            remaining_ticks -= 1;
        }
    }

    // A normal host frame has no edge queue and advances one or more virtual
    // frames according to the fixed-step clock.  Held touches/buttons remain
    // active for each catch-up turn; one-shot axis/motion samples were cleared
    // after the first turn above.
    while remaining_ticks > 0 {
        let active = host.touches.clone();
        run_guest_touch_frame(host, &active, &[])?;
        if first_guest_turn {
            host.axis_deltas.clear();
            host.motion = None;
            first_guest_turn = false;
        }
        tick_core(host)?;
        remaining_ticks -= 1;
    }
    Ok(())
}

fn build_frame(host: &mut HostState, delta_ms: f64) -> Result<BuiltFrame, String> {
    // A host may deliver several pointer edges between vblanks.  Feed the
    // retained guest one complete snapshot per queued edge so its official
    // gesture pump can observe DOWN followed by UP (or CANCEL).  When there
    // are no edges, preserve the ordinary held-contact frame semantics.
    let pending = std::mem::take(&mut host.pending_touch_frames);
    let tick_count = fixed_tick_count(host, delta_ms);
    let guest_result = run_virtual_frames(host, pending, tick_count);
    guest_result?;
    let (words, auxiliary_words, (width, height), auxiliary_size, raster_revision) = {
        let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
        core.ui.relayout_outputs();
        let words = core.ui.draw().words.clone();
        let auxiliary_size = core.ui.auxiliary_viewport();
        let auxiliary_words = if auxiliary_size.is_some() {
            core.ui.draw_auxiliary().map(|draw| draw.words.clone())
        } else {
            None
        };
        (
            words,
            auxiliary_words,
            core.ui.viewport(),
            auxiliary_size,
            core.ui.raster_revision(),
        )
    };
    let nodes = host.nodes.borrow().clone();
    let cache_hit = host.draw_cache.as_ref().is_some_and(|cache| {
        cache.matches(
            &words,
            auxiliary_words.as_deref(),
            width,
            height,
            auxiliary_size,
            raster_revision,
            &nodes,
        )
    });

    // Consume the actual PocketJS DrawList. Unsupported operations are
    // surfaced as development diagnostics instead of inventing boxes. Every
    // decoded DrawList operation is forwarded as-is (with its original
    // geometry/UV/tint). Core-generated rounded/shadow masks are ordinary
    // live TEX_QUAD resources, so no host-side RRect reconstruction is needed.
    let (ops, auxiliary, generic_texture_handles) = if cache_hit {
        let cache = host
            .draw_cache
            .as_ref()
            .expect("draw cache hit must have a cache");
        (
            cache.ops.clone(),
            cache.auxiliary.clone(),
            cache.generic_texture_handles.clone(),
        )
    } else {
        // A changed DrawList means any static JSON captured for the previous
        // visual state is stale. It must not be reused merely because this
        // frame happens to emit no bridge events.
        host.frame_json_cache = None;
        host.draw_decode_count = host.draw_decode_count.wrapping_add(1);
        let core = host.ops.core().map_err(|error| format!("{error:?}"))?;
        let mut generic_texture_handles = HashSet::new();
        let ops = decode_draw_ops(
            &words,
            width,
            height,
            &nodes,
            &core.ui,
            &mut generic_texture_handles,
        )?;
        let auxiliary = match (auxiliary_size, auxiliary_words.as_deref()) {
            (Some((auxiliary_width, auxiliary_height)), Some(auxiliary_words)) => {
                Some(SurfaceFrame {
                    width: auxiliary_width,
                    height: auxiliary_height,
                    ops: decode_draw_ops(
                        auxiliary_words,
                        auxiliary_width,
                        auxiliary_height,
                        &nodes,
                        &core.ui,
                        &mut generic_texture_handles,
                    )?,
                })
            }
            (Some(_), None) => return Err("auxiliary draw list was not produced".to_owned()),
            (None, Some(_)) => return Err("auxiliary draw list has no viewport".to_owned()),
            (None, None) => None,
        };
        let generic_texture_handles = generic_texture_handles.into_iter().collect::<Vec<_>>();
        host.draw_cache = Some(FrameDrawCache {
            words: words.clone(),
            auxiliary_words: auxiliary_words.clone(),
            width,
            height,
            auxiliary_size,
            raster_revision,
            nodes: nodes.clone(),
            ops: ops.clone(),
            auxiliary: auxiliary.clone(),
            generic_texture_handles: generic_texture_handles.clone(),
        });
        (ops, auxiliary, generic_texture_handles)
    };

    let referenced_assets = {
        let mut assets = referenced_image_assets(&ops);
        if let Some(auxiliary) = auxiliary.as_ref() {
            assets.extend(referenced_image_assets(&auxiliary.ops));
        }
        assets
    };
    let core = host.ops.core().map_err(|error| format!("{error:?}"))?;
    let released_resources = host
        .sent_resources
        .iter()
        .filter_map(|(asset, sent)| {
            let texture_released = core.ui.texture(sent.texture).is_none();
            let no_longer_referenced = !referenced_assets.contains(asset);
            (texture_released || no_longer_referenced).then(|| asset.clone())
        })
        .collect::<Vec<_>>();
    for asset in &released_resources {
        host.sent_resources.remove(asset);
    }
    let mut resources = Vec::new();
    for node in &nodes {
        if !node.from_pack || node.asset.is_empty() || !referenced_assets.contains(&node.asset) {
            continue;
        }
        let revision = core.ui.texture_revision(node.texture).ok_or_else(|| {
            format!(
                "PAK image {} has stale texture handle {}",
                node.asset, node.texture
            )
        })?;
        if host
            .sent_resources
            .get(&node.asset)
            .is_some_and(|sent| sent.texture == node.texture && sent.revision == revision)
        {
            continue;
        }
        let view = core.ui.texture(node.texture).ok_or_else(|| {
            format!(
                "PAK image {} has stale texture handle {}",
                node.asset, node.texture
            )
        })?;
        resources.push(FrameResource {
            asset: node.asset.clone(),
            revision,
            width: view.w,
            height: view.h,
            psm: view.psm,
            linear: view.linear,
            pixels: view.pixels.to_vec(),
            palette: view.palette.map(|palette| palette.to_vec()),
        });
        host.sent_resources.insert(
            node.asset.clone(),
            SentResource {
                texture: node.texture,
                revision,
            },
        );
    }
    for texture in generic_texture_handles {
        let asset = synthetic_texture_asset(texture);
        let revision = core
            .ui
            .texture_revision(texture)
            .ok_or_else(|| format!("generic TEX texture handle {texture} went stale"))?;
        if host
            .sent_resources
            .get(&asset)
            .is_some_and(|sent| sent.texture == texture && sent.revision == revision)
        {
            continue;
        }
        let view = core
            .ui
            .texture(texture)
            .ok_or_else(|| format!("generic TEX texture handle {texture} went stale"))?;
        resources.push(FrameResource {
            asset: asset.clone(),
            revision,
            width: view.w,
            height: view.h,
            psm: view.psm,
            linear: view.linear,
            pixels: view.pixels.to_vec(),
            palette: view.palette.map(|palette| palette.to_vec()),
        });
        host.sent_resources
            .insert(asset, SentResource { texture, revision });
    }
    let events = host.outbound.borrow_mut().drain(..).collect();
    host.frame = host.frame.wrapping_add(1);
    Ok(BuiltFrame {
        result: FrameResult {
            frame: host.frame,
            width,
            height,
            ops,
            auxiliary,
            events,
            resources,
            released_resources,
        },
        draw_cache_hit: cache_hit,
    })
}

fn unpack_rect(xy: u32, wh: u32) -> (f32, f32, f32, f32) {
    let x = (xy as u16 as i16) as f32;
    let y = ((xy >> 16) as u16 as i16) as f32;
    let w = (wh & 0xffff) as f32;
    let h = (wh >> 16) as f32;
    (x, y, w, h)
}

fn unpack_point(xy: u32) -> FramePoint {
    FramePoint {
        x: (xy as u16 as i16) as f32,
        y: ((xy >> 16) as u16 as i16) as f32,
    }
}

fn triangle_bounds(points: &[FramePoint]) -> Result<(f32, f32, f32, f32), String> {
    if points.len() != 3 {
        return Err("triangle DrawList record must contain exactly three points".to_owned());
    }
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for point in points {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err("triangle DrawList record contains a non-finite point".to_owned());
        }
        min_x = min_x.min(point.x);
        min_y = min_y.min(point.y);
        max_x = max_x.max(point.x);
        max_y = max_y.max(point.y);
    }
    if max_x <= min_x || max_y <= min_y {
        return Err("triangle DrawList record is degenerate".to_owned());
    }
    Ok((min_x, min_y, max_x - min_x, max_y - min_y))
}

fn argb_from_abgr(abgr: u32) -> u32 {
    let a = abgr >> 24;
    let b = (abgr >> 16) & 0xff;
    let g = (abgr >> 8) & 0xff;
    let r = abgr & 0xff;
    (a << 24) | (r << 16) | (g << 8) | b
}

fn synthetic_texture_asset(texture: i32) -> String {
    format!("pocket.texture.{texture}")
}

/// Return only image resources that the current retained DrawList samples.
/// The PAK admission table may contain many assets for other pages; exporting
/// all of them on every mount needlessly copies large pixel arrays through the
/// FFI JSON boundary. The core still owns and keeps every admitted texture,
/// while Flutter receives a resource when a live DrawList first references it.
fn referenced_image_assets(ops: &[FrameOp]) -> HashSet<String> {
    ops.iter()
        .filter(|op| op.kind == "image" || op.kind == "textureTriangle")
        .filter_map(|op| op.asset.clone())
        .collect()
}

fn registered_texture_asset(texture: i32, nodes: &[NodeMeta]) -> Option<String> {
    nodes
        .iter()
        .find(|node| node.kind == "image" && node.texture == texture)
        .map(|node| node.asset.clone())
        .filter(|asset| !asset.is_empty())
}

fn clip_of(rect: DamageRect) -> Clip {
    Clip {
        x: rect.x0 as f32,
        y: rect.y0 as f32,
        w: (rect.x1 - rect.x0).max(0) as f32,
        h: (rect.y1 - rect.y0).max(0) as f32,
    }
}

fn append_draw_operation(
    out: &mut Vec<FrameOp>,
    operation: &Operation<'_>,
    nodes: &[NodeMeta],
    ui: &Ui,
    generic_texture_handles: &mut HashSet<i32>,
) -> Result<(), String> {
    let words = operation.words;
    match operation.opcode {
        1 => {
            let (x, y, w, h) = unpack_rect(words[1], words[2]);
            let color = words[3];
            out.push(FrameOp {
                kind: "rect".into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                color: Some(argb_from_abgr(color)),
                from_color: None,
                to_color: None,
                direction: None,
                size: None,
                font_slot: None,
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        2 => {
            let (x, y, w, h) = unpack_rect(
                *words
                    .get(1)
                    .ok_or_else(|| "GRAD_RECT is missing its position".to_owned())?,
                *words
                    .get(2)
                    .ok_or_else(|| "GRAD_RECT is missing its size".to_owned())?,
            );
            let from = *words
                .get(3)
                .ok_or_else(|| "GRAD_RECT is missing its start color".to_owned())?;
            let to = *words
                .get(4)
                .ok_or_else(|| "GRAD_RECT is missing its end color".to_owned())?;
            let direction = *words
                .get(5)
                .ok_or_else(|| "GRAD_RECT is missing its direction".to_owned())?;
            if direction > 3 {
                return Err(format!(
                    "GRAD_RECT has unsupported gradient direction {direction}"
                ));
            }
            out.push(FrameOp {
                kind: "gradient".into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                color: None,
                from_color: Some(argb_from_abgr(from)),
                to_color: Some(argb_from_abgr(to)),
                direction: Some(direction),
                size: None,
                font_slot: None,
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        4 => {
            let (x, y, w, h) = unpack_rect(words[2], words[3]);
            let texture = words[1] as i32;
            if ui.texture(texture).is_none() {
                return Err(format!(
                    "TEX_QUAD texture handle {texture} has no live core texture"
                ));
            }
            let asset = registered_texture_asset(texture, nodes).unwrap_or_else(|| {
                generic_texture_handles.insert(texture);
                synthetic_texture_asset(texture)
            });
            let uv = [
                f32::from_bits(
                    *words
                        .get(4)
                        .ok_or_else(|| "TEX_QUAD is missing u0".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(5)
                        .ok_or_else(|| "TEX_QUAD is missing v0".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(6)
                        .ok_or_else(|| "TEX_QUAD is missing u1".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(7)
                        .ok_or_else(|| "TEX_QUAD is missing v1".to_owned())?,
                ),
            ];
            if uv.iter().any(|value| !value.is_finite()) {
                return Err(format!(
                    "TEX_QUAD texture handle {texture} contains a non-finite UV"
                ));
            }
            out.push(FrameOp {
                kind: "image".into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: Some(asset),
                id: None,
                fit: None,
                // TEX_QUAD word 8 is the core's per-quad ABGR modulation
                // (alpha-covered discs and shadow masks rely on it).
                color: Some(argb_from_abgr(*words.get(8).ok_or_else(|| {
                    "TEX_QUAD is missing its modulation color".to_owned()
                })?)),
                from_color: None,
                to_color: None,
                direction: None,
                size: None,
                font_slot: None,
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: Some(uv.to_vec()),
                clip: clip_of(operation.clip),
            });
        }
        7 => {
            let points = vec![
                unpack_point(
                    *words
                        .get(1)
                        .ok_or_else(|| "TRI is missing vertex 0".to_owned())?,
                ),
                unpack_point(
                    *words
                        .get(2)
                        .ok_or_else(|| "TRI is missing vertex 1".to_owned())?,
                ),
                unpack_point(
                    *words
                        .get(3)
                        .ok_or_else(|| "TRI is missing vertex 2".to_owned())?,
                ),
            ];
            let (x, y, w, h) = triangle_bounds(&points)?;
            let colors = vec![
                argb_from_abgr(
                    *words
                        .get(4)
                        .ok_or_else(|| "TRI is missing color 0".to_owned())?,
                ),
                argb_from_abgr(
                    *words
                        .get(5)
                        .ok_or_else(|| "TRI is missing color 1".to_owned())?,
                ),
                argb_from_abgr(
                    *words
                        .get(6)
                        .ok_or_else(|| "TRI is missing color 2".to_owned())?,
                ),
            ];
            out.push(FrameOp {
                kind: "triangle".into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                color: None,
                from_color: None,
                to_color: None,
                direction: None,
                size: None,
                font_slot: None,
                radius: None,
                points: Some(points),
                colors: Some(colors),
                uvs: None,
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        8 => {
            let texture = *words
                .get(1)
                .ok_or_else(|| "TEX_TRI is missing its texture handle".to_owned())?
                as i32;
            if ui.texture(texture).is_none() {
                return Err(format!(
                    "TEX_TRI texture handle {texture} has no live core texture"
                ));
            }
            let asset = registered_texture_asset(texture, nodes).unwrap_or_else(|| {
                generic_texture_handles.insert(texture);
                synthetic_texture_asset(texture)
            });
            let points = vec![
                unpack_point(
                    *words
                        .get(2)
                        .ok_or_else(|| "TEX_TRI is missing vertex 0".to_owned())?,
                ),
                unpack_point(
                    *words
                        .get(5)
                        .ok_or_else(|| "TEX_TRI is missing vertex 1".to_owned())?,
                ),
                unpack_point(
                    *words
                        .get(8)
                        .ok_or_else(|| "TEX_TRI is missing vertex 2".to_owned())?,
                ),
            ];
            let (x, y, w, h) = triangle_bounds(&points)?;
            let uvs = vec![
                f32::from_bits(
                    *words
                        .get(3)
                        .ok_or_else(|| "TEX_TRI is missing vertex 0 u".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(4)
                        .ok_or_else(|| "TEX_TRI is missing vertex 0 v".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(6)
                        .ok_or_else(|| "TEX_TRI is missing vertex 1 u".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(7)
                        .ok_or_else(|| "TEX_TRI is missing vertex 1 v".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(9)
                        .ok_or_else(|| "TEX_TRI is missing vertex 2 u".to_owned())?,
                ),
                f32::from_bits(
                    *words
                        .get(10)
                        .ok_or_else(|| "TEX_TRI is missing vertex 2 v".to_owned())?,
                ),
            ];
            if uvs.iter().any(|value| !value.is_finite()) {
                return Err("TEX_TRI contains a non-finite UV".to_owned());
            }
            out.push(FrameOp {
                kind: "textureTriangle".into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: Some(asset),
                id: None,
                fit: None,
                color: Some(argb_from_abgr(*words.get(11).ok_or_else(|| {
                    "TEX_TRI is missing its modulation color".to_owned()
                })?)),
                from_color: None,
                to_color: None,
                direction: None,
                size: None,
                font_slot: None,
                radius: None,
                points: Some(points),
                colors: None,
                uvs: Some(uvs),
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        5 | 6 => {}
        9 => {
            let x = f32::from_bits(words[2]);
            let y = f32::from_bits(words[3]);
            let w = f32::from_bits(words[4]);
            let line_height = f32::from_bits(words[5]);
            let bytes = words[7] as usize;
            let packed_end = 8usize
                .checked_add(bytes.div_ceil(4))
                .ok_or_else(|| "TEXT_RUN payload length overflow".to_owned())?;
            let packed = words
                .get(8..packed_end)
                .ok_or_else(|| "TEXT_RUN payload is truncated".to_owned())?;
            let mut raw = Vec::with_capacity(bytes);
            for word in packed {
                raw.extend_from_slice(&word.to_le_bytes());
            }
            raw.truncate(bytes);
            let text = String::from_utf8_lossy(&raw).into_owned();
            // words[5] is the requested line height and is allowed to be NaN
            // (NaN means the font slot default).  It is not a JSON box
            // height.  Derive a finite measured height from the decoded run
            // and line height instead; this mirrors the native measure
            // callback used by Ui::relayout_outputs(). words[1]&0xff is the
            // PocketJS font slot, not a pixel size; map the pinned slot table
            // before handing it to Flutter's TextPainter.
            let font_slot = (words[1] & 0xff) as u8;
            let line_height = if line_height.is_finite() && line_height > 0.0 {
                line_height
            } else {
                font_slot_line_height(font_slot)
            };
            let line_count = text.split('\n').count().max(1) as f32;
            let measured_h = (line_count * line_height).max(font_slot_line_height(font_slot));
            out.push(FrameOp {
                kind: "text".into(),
                x,
                y,
                w,
                h: measured_h,
                text: Some(text),
                asset: None,
                id: None,
                fit: None,
                color: Some(argb_from_abgr(words[6])),
                from_color: None,
                to_color: None,
                direction: None,
                size: Some(font_slot_px(font_slot)),
                font_slot: Some(font_slot),
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        10 => {
            let x = f32::from_bits(words[2]);
            let y = f32::from_bits(words[3]);
            let w = f32::from_bits(words[4]);
            let h = f32::from_bits(words[5]);
            let surface = words[1] as i32;
            let video = nodes
                .iter()
                .find(|node| (node.kind == "video" || node.kind == "hostSurface") && node.surface == surface)
                .ok_or_else(|| {
                    format!("SURFACE_QUAD surface handle {surface} has no registered video asset")
                })?;
            if video.asset.is_empty() || video.video_id.is_empty() {
                return Err(format!(
                    "SURFACE_QUAD surface handle {surface} has an incomplete video mapping"
                ));
            }
            out.push(FrameOp {
                kind: if video.kind == "hostSurface" { "hostSurface" } else { "video" }.into(),
                x,
                y,
                w,
                h,
                text: None,
                asset: Some(video.asset.clone()),
                id: Some(video.video_id.clone()),
                fit: Some(video.fit.clone()),
                color: None,
                from_color: None,
                to_color: None,
                direction: None,
                size: None,
                font_slot: None,
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                clip: clip_of(operation.clip),
            });
        }
        unsupported => {
            return Err(format!("unsupported PocketJS draw opcode {unsupported}"));
        }
    }
    Ok(())
}

/// PocketJS's framework compiler uses these stable logical pixel values for
/// its baked font slots.  The native TEXT_RUN carries the slot in words[1],
/// while Flutter needs an actual TextPainter font size.
fn font_slot_px(slot: u8) -> f32 {
    match slot {
        0..=6 => [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0][slot as usize],
        7..=13 => [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0][(slot - 7) as usize],
        14 | 15 => 54.0,
        16..=18 => [12.0, 14.0, 16.0][(slot - 16) as usize],
        19 | 20 => 10.0,
        _ => 14.0,
    }
}

fn font_slot_line_height(slot: u8) -> f32 {
    // The POC has no platform font service in native Rust. Keep layout and
    // Flutter's TextPainter contract finite and deterministic; real Flutter
    // shaping still happens on the Dart side from the emitted TEXT_RUN.
    (font_slot_px(slot) * 1.2).ceil().max(1.0)
}

#[derive(Clone, Debug)]
struct FontMetric {
    slot: u8,
    cell_w: f32,
    line_height: f32,
    advances: Vec<(u32, f32)>,
}

#[derive(Clone, Debug, Default)]
struct TextMetrics {
    fonts: Vec<FontMetric>,
}

impl TextMetrics {
    fn clear(&mut self) {
        self.fonts.clear();
    }

    fn font(&self, slot: u8) -> Option<&FontMetric> {
        self.fonts.iter().find(|font| font.slot == slot)
    }

    fn advance(font: Option<&FontMetric>, codepoint: u32) -> f32 {
        let Some(font) = font else {
            return 13.0;
        };
        font.advances
            .binary_search_by_key(&codepoint, |(cp, _)| *cp)
            .map(|index| font.advances[index].1)
            .unwrap_or(font.cell_w)
    }

    fn measure(&self, text: &str, slot: u8, tracking: f32, line_height: f32) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }
        let font = self.font(slot);
        let default_line_height = font
            .map(|item| item.line_height)
            .unwrap_or_else(|| font_slot_line_height(slot));
        let line_height = if line_height.is_nan() {
            default_line_height
        } else {
            line_height
        };
        let mut max_width = 0.0_f32;
        let mut line_width = 0.0_f32;
        let mut lines = 1.0_f32;
        for character in text.chars() {
            if character == '\n' {
                max_width = max_width.max(line_width);
                line_width = 0.0;
                lines += 1.0;
            } else {
                line_width += Self::advance(font, character as u32) + tracking;
            }
        }
        max_width = max_width.max(line_width);
        (max_width, lines * line_height)
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
        *bytes.get(offset + 3)?,
    ]))
}

const PAK_MAGIC: u32 = 0x4b50_4344;
const FONT_ATLAS_MAGIC: u32 = 0x4146_4344;
const BASE_GUEST_HEAP_LIMIT: usize = 16 * 1024 * 1024;

/// The QuickJS guest owns an immutable copy of `pak` as `globalThis.__pak`.
/// Keep the original script/DOM budget while reserving room for that package
/// copy; otherwise a valid image/font-heavy bundle can fail during mount with
/// only the opaque `RuntimeError::Guest` at the FFI boundary.
fn guest_heap_limit(pak_len: usize) -> usize {
    BASE_GUEST_HEAP_LIMIT.saturating_add(pak_len)
}

fn parse_pak_font_metrics(pak: &[u8]) -> Result<TextMetrics, String> {
    if pak.len() < 32 || read_u32(pak, 0) != Some(PAK_MAGIC) || read_u16(pak, 4) != Some(1) {
        return Err("pak: invalid header while reading font metrics".to_owned());
    }
    let entry_count =
        read_u32(pak, 8).ok_or_else(|| "pak: missing entry count".to_owned())? as usize;
    let directory =
        read_u32(pak, 12).ok_or_else(|| "pak: missing directory offset".to_owned())? as usize;
    let names = read_u32(pak, 16).ok_or_else(|| "pak: missing names offset".to_owned())? as usize;
    let directory_end = directory
        .checked_add(
            entry_count
                .checked_mul(24)
                .ok_or_else(|| "pak: directory overflow".to_owned())?,
        )
        .ok_or_else(|| "pak: directory overflow".to_owned())?;
    if directory_end > pak.len() || names > pak.len() {
        return Err("pak: directory is outside package".to_owned());
    }
    let mut metrics = TextMetrics::default();
    for index in 0..entry_count {
        let entry = directory + index * 24;
        let blob_offset =
            read_u32(pak, entry + 4).ok_or_else(|| "pak: missing blob offset".to_owned())? as usize;
        let blob_len =
            read_u32(pak, entry + 8).ok_or_else(|| "pak: missing blob length".to_owned())? as usize;
        let name_offset = read_u32(pak, entry + 12)
            .ok_or_else(|| "pak: missing name offset".to_owned())?
            as usize;
        let name_len = read_u16(pak, entry + 16)
            .ok_or_else(|| "pak: missing name length".to_owned())? as usize;
        let name_start = names
            .checked_add(name_offset)
            .ok_or_else(|| "pak: name offset overflow".to_owned())?;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or_else(|| "pak: name length overflow".to_owned())?;
        let blob_end = blob_offset
            .checked_add(blob_len)
            .ok_or_else(|| "pak: blob length overflow".to_owned())?;
        if name_end > pak.len() || blob_end > pak.len() {
            return Err("pak: entry extends outside package".to_owned());
        }
        let name = std::str::from_utf8(&pak[name_start..name_end])
            .map_err(|_| "pak: entry name is not UTF-8".to_owned())?;
        if !name.starts_with("ui:font.") {
            continue;
        }
        let bytes = &pak[blob_offset..blob_end];
        if bytes.len() < 16 || read_u32(bytes, 0) != Some(FONT_ATLAS_MAGIC) {
            return Err(format!("pak: invalid font atlas {name}"));
        }
        let version =
            read_u16(bytes, 4).ok_or_else(|| format!("pak: missing font version {name}"))?;
        if version != 2 && version != 3 {
            return Err(format!(
                "pak: unsupported font atlas version {version} ({name})"
            ));
        }
        let glyph_count =
            read_u16(bytes, 6).ok_or_else(|| format!("pak: missing glyph count {name}"))? as usize;
        let cell_w = *bytes
            .get(8)
            .ok_or_else(|| format!("pak: missing cell width {name}"))? as f32;
        let cell_h = *bytes
            .get(9)
            .ok_or_else(|| format!("pak: missing cell height {name}"))? as f32;
        let line_height = *bytes
            .get(11)
            .ok_or_else(|| format!("pak: missing line height {name}"))?
            as f32;
        let slot = *bytes
            .get(12)
            .ok_or_else(|| format!("pak: missing font slot {name}"))?;
        let cmap_end = 16usize
            .checked_add(
                glyph_count
                    .checked_mul(8)
                    .ok_or_else(|| format!("pak: cmap overflow {name}"))?,
            )
            .ok_or_else(|| format!("pak: cmap overflow {name}"))?;
        if glyph_count == 0 || cell_w <= 0.0 || cell_h <= 0.0 || cmap_end > bytes.len() {
            return Err(format!("pak: invalid font atlas dimensions {name}"));
        }
        let mut advances = Vec::with_capacity(glyph_count);
        for glyph in 0..glyph_count {
            let entry = 16 + glyph * 8;
            let codepoint =
                read_u32(bytes, entry).ok_or_else(|| format!("pak: truncated cmap {name}"))?;
            let advance = *bytes
                .get(entry + 6)
                .ok_or_else(|| format!("pak: truncated cmap advance {name}"))?
                as f32;
            advances.push((codepoint, advance));
        }
        metrics.fonts.push(FontMetric {
            slot,
            cell_w,
            line_height: if line_height > 0.0 {
                line_height
            } else {
                cell_h
            },
            advances,
        });
    }
    Ok(metrics)
}

fn install_text_measure(ui: &mut Ui, metrics: Rc<RefCell<TextMetrics>>) {
    ui.set_text_measure(Some(Box::new(move |text, slot, tracking, line_height| {
        metrics.borrow().measure(text, slot, tracking, line_height)
    })));
}

/// Create an engine instance. The handle is single-owner: calls must be made
/// sequentially from one Dart isolate.
#[no_mangle]
pub extern "C" fn pocket_create(width: f64, height: f64) -> *mut HostState {
    pocket_create_with_density_and_tick_hz(width, height, 1, DEFAULT_TICK_HZ)
}

/// Create an engine instance with an explicit core raster density.
///
/// The logical viewport and all layout coordinates remain unchanged; the
/// density only controls the pixel dimensions of core-generated bitmap
/// resources such as rounded/shadow masks.  The POC deliberately caps the
/// host-facing value at 4 to keep mobile memory bounded even though the core
/// supports a wider 1..=255 range.
#[no_mangle]
pub extern "C" fn pocket_create_with_density(
    width: f64,
    height: f64,
    raster_density: u32,
) -> *mut HostState {
    pocket_create_with_density_and_tick_hz(width, height, raster_density, DEFAULT_TICK_HZ)
}

/// Create a host with explicit core/guest tick rate.
///
/// PocketJS rates above 120 are intentionally not exposed by this mobile
/// bridge.  The selected value is installed before guest initialization, is
/// published as `ui.__tickHz`, and is also used by the native fixed-step clock
/// to convert `pocket_frame` wall deltas into whole guest/core ticks.
#[no_mangle]
pub extern "C" fn pocket_create_with_density_and_tick_hz(
    width: f64,
    height: f64,
    raster_density: u32,
    tick_hz: u32,
) -> *mut HostState {
    if !(1..=4).contains(&raster_density) {
        // Creation failures in this ABI return a destroyable opaque handle so
        // callers can retrieve the diagnostic through pocket_last_error. Build
        // a density-1 fallback only to carry that error; it must not escape as
        // a usable runtime because last_error is non-empty.
        let handle = create_host(width, height, 1, DEFAULT_TICK_HZ);
        if !handle.is_null() {
            unsafe {
                set_error(
                    &mut *handle,
                    format!(
                        "raster density must be an integer from 1 through 4 (got {raster_density})"
                    ),
                );
            }
        }
        return handle;
    }
    if !(1..=MAX_HOST_TICK_HZ).contains(&tick_hz) {
        let handle = create_host(width, height, 1, DEFAULT_TICK_HZ);
        if !handle.is_null() {
            unsafe {
                set_error(
                    &mut *handle,
                    format!(
                        "tick rate must be an integer from 1 through {MAX_HOST_TICK_HZ} (got {tick_hz})"
                    ),
                );
            }
        }
        return handle;
    }
    create_host(width, height, raster_density, tick_hz)
}

fn create_host(width: f64, height: f64, raster_density: u32, tick_hz: u32) -> *mut HostState {
    let width = width.max(1.0).min(65535.0) as u32;
    let height = height.max(1.0).min(65535.0) as u32;
    let text_metrics = Rc::new(RefCell::new(TextMetrics::default()));
    let mut ui = Ui::new_with_raster_density(raster_density);
    ui.set_viewport(width as f32, height as f32);
    // Native text mode makes the core emit TEXT_RUN records. Flutter decodes
    // those records with its own font system, so no platform view or native
    // text widget is involved in the POC.
    install_text_measure(&mut ui, text_metrics.clone());
    let _ = ui.set_tick_rate(tick_hz);
    let ops = OpContext::from_ui(ui);
    // This host owns the Flutter compositor/texture bridge.  Enabling the
    // capability before mounting exposes ui.setCompositorSurface to JS and
    // causes Surface nodes to produce SURFACE_QUAD DrawOps.
    if let Err(error) = ops.set_compositor_enabled(true) {
        return Box::into_raw(Box::new(HostState {
            ops,
            guest: RquickjsGuest::new(BindingProfile::Canonical),
            nodes: Rc::new(RefCell::new(Vec::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            last_error: format!("{error:?}"),
            error_output: c_string(&format!("{error:?}")),
            output: c_string("{}"),
            frame: 0,
            tick_hz,
            tick_remainder_ms: 0.0,
            clock_started: false,
            viewport_width: width as f32,
            viewport_height: height as f32,
            raster_density,
            auxiliary_viewport: None,
            guest_loaded: false,
            touches: Vec::new(),
            pending_touch_frames: Vec::new(),
            buttons: 0,
            analog: 0x8080,
            right_analog: 0x8080,
            axis_deltas: Vec::new(),
            motion: None,
            text_metrics: text_metrics.clone(),
            sent_resources: HashMap::new(),
            draw_cache: None,
            frame_json_cache: None,
            frame_json_serializations: 0,
            frame_json_serialized_bytes: 0,
            frame_json_cache_hits: 0,
            draw_decode_count: 0,
        }));
    }
    let mut guest = RquickjsGuest::new(BindingProfile::Canonical);
    let env = GuestEnvironment {
        host: "flutter-canvas-poc",
        host_abi: BINDING_GENERATION,
        tick_hz,
        viewport: [width, height],
        auxiliary_viewport: None,
        auxiliary_root: 0,
        raster_density,
        heap_limit: BASE_GUEST_HEAP_LIMIT,
        pak: &[],
        assets: None,
    };
    if let Err(error) = guest.initialize(ops.clone(), &env) {
        return Box::into_raw(Box::new(HostState {
            ops,
            guest,
            nodes: Rc::new(RefCell::new(Vec::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            last_error: format!("{error:?}"),
            error_output: c_string(&format!("{error:?}")),
            output: c_string("{}"),
            frame: 0,
            tick_hz,
            tick_remainder_ms: 0.0,
            clock_started: false,
            viewport_width: width as f32,
            viewport_height: height as f32,
            raster_density,
            auxiliary_viewport: None,
            guest_loaded: false,
            touches: Vec::new(),
            pending_touch_frames: Vec::new(),
            buttons: 0,
            analog: 0x8080,
            right_analog: 0x8080,
            axis_deltas: Vec::new(),
            motion: None,
            text_metrics: text_metrics.clone(),
            sent_resources: HashMap::new(),
            draw_cache: None,
            frame_json_cache: None,
            frame_json_serializations: 0,
            frame_json_serialized_bytes: 0,
            frame_json_cache_hits: 0,
            draw_decode_count: 0,
        }));
    }
    let nodes = Rc::new(RefCell::new(Vec::new()));
    let outbound = Rc::new(RefCell::new(Vec::new()));
    let mut host = HostState {
        ops,
        guest,
        nodes: nodes.clone(),
        outbound: outbound.clone(),
        last_error: String::new(),
        error_output: c_string(""),
        output: c_string("{}"),
        frame: 0,
        tick_hz,
        tick_remainder_ms: 0.0,
        clock_started: false,
        viewport_width: width as f32,
        viewport_height: height as f32,
        raster_density,
        auxiliary_viewport: None,
        guest_loaded: false,
        touches: Vec::new(),
        pending_touch_frames: Vec::new(),
        buttons: 0,
        analog: 0x8080,
        right_analog: 0x8080,
        axis_deltas: Vec::new(),
        motion: None,
        text_metrics: text_metrics.clone(),
        sent_resources: HashMap::new(),
        draw_cache: None,
        frame_json_cache: None,
        frame_json_serializations: 0,
        frame_json_serialized_bytes: 0,
        frame_json_cache_hits: 0,
        draw_decode_count: 0,
    };
    if let Err(error) = install_bridge(
        &host.guest,
        host.ops.clone(),
        nodes,
        outbound,
        auxiliary_descriptor(&host),
    ) {
        set_error(&mut host, error);
    }
    Box::into_raw(Box::new(host))
}

/// Resize a mounted PocketJS guest in place.
///
/// The core viewport, framework root layers and `ui.__viewport` are updated
/// without rebuilding the QuickJS realm. A `display.viewport` event is then
/// delivered through the normal guest event bridge so reactive pages can
/// update their own viewport-dependent state. Existing route/cursor state is
/// intentionally preserved.
#[no_mangle]
pub unsafe extern "C" fn pocket_resize_viewport(
    handle: *mut HostState,
    width: f64,
    height: f64,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > 32000.0
        || height > 32000.0
    {
        set_error(host, "viewport must be finite and within 1..32000");
        return -1;
    }
    if !host.guest_loaded {
        set_error(host, "viewport cannot be resized before guest load/eval");
        return -1;
    }
    let requested = (width as f32, height as f32);
    if (host.viewport_width, host.viewport_height) == requested {
        clear_error(host);
        return 0;
    }

    let result = (|| -> Result<(), String> {
        {
            let mut core = host
                .ops
                .core_mut()
                .map_err(|error| format!("viewport resize core: {error:?}"))?;
            core.ui.set_viewport(requested.0, requested.1);
            core.mutated();
        }
        host.viewport_width = requested.0;
        host.viewport_height = requested.1;
        // A viewport change invalidates DrawList words, decoded op geometry and
        // the static JSON fast path, but it does not release live textures.
        host.draw_cache = None;
        host.frame_json_cache = None;

        resize_guest_viewport(&host.guest, requested.0, requested.1)?;
        let event = serde_json::json!({
            "type": "event",
            "id": format!("host-viewport-{}", host.frame.wrapping_add(1)),
            "name": "display.viewport",
            "payload": {
                "width": requested.0,
                "height": requested.1,
            },
        });
        dispatch_guest(&host.guest, "__pocketEvent", &event.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            clear_error(host);
            0
        }
        Err(error) => {
            set_error(host, error);
            -1
        }
    }
}

/// Enable one optional logical auxiliary output before loading a guest.
///
/// The output is not a platform/native view: its retained core DrawList is
/// returned in `FrameResult.auxiliary` for the Flutter host to paint on a
/// second Canvas. This is intentionally an additive opt-in; callers that do
/// not call this function retain the original primary-only contract.
#[no_mangle]
pub unsafe extern "C" fn pocket_enable_auxiliary(
    handle: *mut HostState,
    width: f64,
    height: f64,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if host.guest_loaded {
        set_error(
            host,
            "auxiliary output must be enabled before guest load/eval",
        );
        return -1;
    }
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > 32000.0
        || height > 32000.0
    {
        set_error(
            host,
            "auxiliary viewport must be finite and within 1..32000",
        );
        return -1;
    }
    let requested = (width as f32, height as f32);
    if let Some(existing) = host.auxiliary_viewport {
        if existing == requested {
            clear_error(host);
            return 0;
        }
        set_error(host, "auxiliary viewport is already configured");
        return -1;
    }
    let root_result = host
        .ops
        .core_mut()
        .map(|mut core| core.ui.create_auxiliary_surface(requested.0, requested.1));
    let root = match root_result {
        Ok(root) => root,
        Err(error) => {
            set_error(host, format!("auxiliary core setup: {error:?}"));
            return -1;
        }
    };
    if root == 0 {
        set_error(host, "core failed to create auxiliary surface");
        return -1;
    }
    host.auxiliary_viewport = Some(requested);
    host.draw_cache = None;
    host.frame_json_cache = None;
    let environment = guest_environment(host, &[], None);
    if let Err(error) = host.guest.initialize(host.ops.clone(), &environment) {
        let detail = host.guest.last_error().unwrap_or("no guest detail");
        set_error(
            host,
            format!("guest auxiliary reinitialize: {error:?}: {detail}"),
        );
        return -1;
    }
    if let Err(error) = install_bridge(
        &host.guest,
        host.ops.clone(),
        host.nodes.clone(),
        host.outbound.clone(),
        auxiliary_descriptor(host),
    ) {
        set_error(host, error);
        return -1;
    }
    clear_error(host);
    0
}

const MAX_SCRIPT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BYTECODE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn read_application_file(path: &CStr, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    let path = path
        .to_str()
        .map_err(|_| format!("{label} path is not UTF-8"))?;
    let file = std::fs::File::open(path).map_err(|error| format!("{label} open: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{label} metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(format!(
            "{label} must be a non-empty file of at most {limit} bytes"
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{label} read: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(format!("{label} changed size while reading"));
    }
    Ok(bytes)
}

fn reset_host_for_load(host: &mut HostState) {
    host.nodes.borrow_mut().clear();
    host.touches.clear();
    host.pending_touch_frames.clear();
    host.buttons = 0;
    host.analog = 0x8080;
    host.right_analog = 0x8080;
    host.axis_deltas.clear();
    host.motion = None;
    host.outbound.borrow_mut().clear();
    host.sent_resources.clear();
    host.draw_cache = None;
    host.frame_json_cache = None;
    host.frame = 0;
    host.tick_remainder_ms = 0.0;
    host.clock_started = false;
    host.text_metrics.borrow_mut().clear();
}

fn install_host_assets(host: &mut HostState, pak: &[u8]) -> Result<AssetRegistry, String> {
    // Use the runtime's atomic package admission rather than merely exposing
    // bytes to JS. This installs styles/font atlases and uploads every
    // `ui:img.*` entry in the real core, then publishes the resulting name ->
    // texture handle table to framework/host.
    let assets: AssetRegistry = host
        .ops
        .install_assets(pak)
        .map_err(|error| format!("pak asset install: {error:?}"))?;
    let metrics = parse_pak_font_metrics(pak)?;
    *host.text_metrics.borrow_mut() = metrics;
    {
        let mut core = host
            .ops
            .core_mut()
            .map_err(|error| format!("font measure install: {error:?}"))?;
        install_text_measure(&mut core.ui, host.text_metrics.clone());
    }
    {
        let mut nodes = host.nodes.borrow_mut();
        for (index, texture) in assets.textures.iter().enumerate() {
            nodes.push(NodeMeta {
                id: i32::MIN.saturating_add(index as i32),
                kind: "image".to_owned(),
                asset: texture.name.clone(),
                video_id: String::new(),
                fit: "cover".to_owned(),
                texture: texture.handle,
                surface: -1,
                from_pack: true,
            });
        }
        let texture_count = assets.textures.len();
        for (index, sprite) in assets.sprites.iter().enumerate() {
            nodes.push(NodeMeta {
                id: i32::MIN.saturating_add((texture_count + index) as i32),
                kind: "image".to_owned(),
                asset: sprite.name.clone(),
                video_id: String::new(),
                fit: "cover".to_owned(),
                texture: sprite.handle,
                surface: -1,
                from_pack: true,
            });
        }
    }
    Ok(assets)
}

fn initialize_guest_for_load(
    host: &mut HostState,
    pak: &[u8],
    assets: &AssetRegistry,
) -> Result<(), String> {
    let environment = guest_environment(host, pak, Some(assets));
    host.guest
        .initialize(host.ops.clone(), &environment)
        .map_err(|error| {
            let detail = host.guest.last_error().unwrap_or("no guest detail");
            format!("guest reinitialize: {error:?}: {detail}")
        })?;
    install_bridge(
        &host.guest,
        host.ops.clone(),
        host.nodes.clone(),
        host.outbound.clone(),
        auxiliary_descriptor(host),
    )
}

/// Load already-admitted, local application files without passing a second
/// large PAK buffer through Dart's heap and its FFI allocation. Signature and
/// content-hash verification belong to the framework package admission layer;
/// this ABI only performs bounded local reads and the canonical PAK load.
#[no_mangle]
pub unsafe extern "C" fn pocket_load_files(
    handle: *mut HostState,
    source_path: *const c_char,
    pak_path: *const c_char,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if source_path.is_null() || pak_path.is_null() {
        set_error(host, "null application file path");
        return -1;
    }
    let result = (|| {
        let source = read_application_file(
            CStr::from_ptr(source_path),
            MAX_SCRIPT_FILE_BYTES,
            "guest source",
        )?;
        let source =
            String::from_utf8(source).map_err(|_| "guest source is not UTF-8".to_owned())?;
        let source =
            CString::new(source).map_err(|_| "guest source contains a NUL byte".to_owned())?;
        let pak = read_application_file(
            CStr::from_ptr(pak_path),
            MAX_PACKAGE_FILE_BYTES,
            "guest PAK",
        )?;
        Ok::<_, String>((source, pak))
    })();
    match result {
        Ok((source, pak)) => pocket_load(handle, source.as_ptr(), pak.as_ptr(), pak.len()),
        Err(error) => {
            set_error(host, error);
            -1
        }
    }
}

/// Load an official PocketJS framework bundle and its raw PAK bytes.
///
/// `source` is a NUL-terminated compiled JS bundle. `pak` is copied into a
/// QuickJS ArrayBuffer before this function returns; the caller may therefore
/// release its package buffer immediately after a successful return. The PAK
/// is intentionally passed separately from the `.pocket` container so the
/// embedding can keep package admission/verification outside this small FFI.
/// The package must be non-empty and valid; source-only guests use
/// `pocket_eval` instead of this loader.
/// Callers should use a fresh handle for each mount; the framework's `mount`
/// function creates a retained tree during evaluation.
#[no_mangle]
pub unsafe extern "C" fn pocket_load(
    handle: *mut HostState,
    source: *const c_char,
    pak: *const u8,
    pak_len: usize,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let Some(source) = source.as_ref() else {
        set_error(host, "null source");
        return -1;
    };
    if pak_len == 0 {
        set_error(
            host,
            "pocket_load requires a non-empty valid PAK; use pocket_eval for source-only guests",
        );
        return -1;
    }
    if pak.is_null() {
        set_error(host, "non-zero pak length with null pak pointer");
        return -1;
    }
    let source = CStr::from_ptr(source).to_string_lossy();
    let pak = std::slice::from_raw_parts(pak, pak_len);
    let result = (|| {
        reset_host_for_load(host);
        let assets = install_host_assets(host, pak)?;
        initialize_guest_for_load(host, pak, &assets)?;
        evaluate_guest(&mut host.guest, &source, host.tick_hz)
    })();
    match result {
        Ok(()) => {
            host.guest_loaded = true;
            host.draw_cache = None;
            host.frame_json_cache = None;
            clear_error(host);
            0
        }
        Err(error) => {
            host.outbound.borrow_mut().clear();
            set_error(host, error);
            -1
        }
    }
}

/// Load a real QuickJS serialized bytecode envelope and its raw PAK bytes.
///
/// The envelope is validated (format, SHA-256, binding generation, tick rate,
/// and the linked QuickJS ABI) before any bytes reach `JS_ReadObject`. This
/// entry point intentionally has no source argument and never falls back to
/// interpreted JavaScript.
#[no_mangle]
pub unsafe extern "C" fn pocket_load_bytecode(
    handle: *mut HostState,
    bytecode: *const u8,
    bytecode_len: usize,
    pak: *const u8,
    pak_len: usize,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if bytecode.is_null() || bytecode_len == 0 {
        set_error(
            host,
            "pocket_load_bytecode requires a non-empty bytecode envelope",
        );
        return -1;
    }
    if pak.is_null() || pak_len == 0 {
        set_error(host, "pocket_load_bytecode requires a non-empty valid PAK");
        return -1;
    }
    let bytecode = std::slice::from_raw_parts(bytecode, bytecode_len);
    let pak = std::slice::from_raw_parts(pak, pak_len);
    // The envelope's kind is authenticated by the payload/header checks and
    // selects QuickJS's script/module object semantics. The Flutter bundle is
    // currently a Script; Module artifacts remain supported by this native
    // ABI for package/tooling callers.
    let kind = match bytecode::parse(bytecode) {
        Ok(artifact) => artifact.kind,
        Err(error) => {
            set_error(host, format!("bytecode admission: {error}"));
            return -1;
        }
    };
    let expected = bytecode::BytecodeExpectation {
        kind,
        binding_generation: BINDING_GENERATION,
        tick_hz: host.tick_hz,
    };
    let artifact = match bytecode::validate(bytecode, expected) {
        Ok(artifact) => artifact,
        Err(error) => {
            set_error(host, format!("bytecode admission: {error}"));
            return -1;
        }
    };
    let result = (|| {
        reset_host_for_load(host);
        let assets = install_host_assets(host, pak)?;
        initialize_guest_for_load(host, pak, &assets)?;
        host.guest
            .evaluate_bytecode(artifact.payload, host.tick_hz)
            .map_err(|error| {
                let detail = host.guest.last_error().unwrap_or("no guest detail");
                format!("guest bytecode evaluate: {error:?}: {detail}")
            })
    })();
    match result {
        Ok(()) => {
            host.guest_loaded = true;
            host.draw_cache = None;
            host.frame_json_cache = None;
            clear_error(host);
            0
        }
        Err(error) => {
            host.outbound.borrow_mut().clear();
            set_error(host, error);
            -1
        }
    }
}

/// Bounded local-file variant used by the static/native probe and package
/// sources that already passed signature/content admission in Dart.
#[no_mangle]
pub unsafe extern "C" fn pocket_load_bytecode_files(
    handle: *mut HostState,
    bytecode_path: *const c_char,
    pak_path: *const c_char,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if bytecode_path.is_null() || pak_path.is_null() {
        set_error(host, "null bytecode or PAK file path");
        return -1;
    }
    let result = (|| {
        let bytecode = read_application_file(
            CStr::from_ptr(bytecode_path),
            MAX_BYTECODE_FILE_BYTES,
            "guest bytecode",
        )?;
        let pak = read_application_file(
            CStr::from_ptr(pak_path),
            MAX_PACKAGE_FILE_BYTES,
            "guest PAK",
        )?;
        Ok::<_, String>((bytecode, pak))
    })();
    match result {
        Ok((bytecode, pak)) => pocket_load_bytecode(
            handle,
            bytecode.as_ptr(),
            bytecode.len(),
            pak.as_ptr(),
            pak.len(),
        ),
        Err(error) => {
            set_error(host, error);
            -1
        }
    }
}

/// ABI string embedded in bytecode metadata and package manifests. It is
/// process-static, so callers may compare it without owning or freeing the
/// returned pointer.
#[no_mangle]
pub extern "C" fn pocket_bytecode_runtime_abi() -> *const c_char {
    static ABI: std::sync::OnceLock<CString> = std::sync::OnceLock::new();
    ABI.get_or_init(|| c_string(&bytecode::runtime_abi()))
        .as_ptr()
}

/// Alias with an explicit name for hosts that call the value `actualAbi`.
#[no_mangle]
pub extern "C" fn pocket_bytecode_actual_abi() -> *const c_char {
    pocket_bytecode_runtime_abi()
}

#[no_mangle]
pub unsafe extern "C" fn pocket_eval(handle: *mut HostState, source: *const c_char) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let Some(source) = source.as_ref() else {
        set_error(host, "null source");
        return -1;
    };
    let source = CStr::from_ptr(source).to_string_lossy();
    match evaluate_guest(&mut host.guest, &source, host.tick_hz) {
        Ok(()) => {
            host.guest_loaded = true;
            host.draw_cache = None;
            host.frame_json_cache = None;
            clear_error(host);
            0
        }
        Err(error) => {
            // A failed evaluation is not a frame boundary. Do not deliver
            // requests emitted by partially executed JS on a later frame.
            host.outbound.borrow_mut().clear();
            set_error(host, error);
            -1
        }
    }
}

fn frame_has_no_transient_data(frame: &BuiltFrame) -> bool {
    frame.result.events.is_empty()
        && frame.result.resources.is_empty()
        && frame.result.released_resources.is_empty()
}

/// Serialize a complete frame for both the legacy ABI and the delta ABI's
/// changed-frame fallback. Both entry points therefore consume the same
/// BuiltFrame and drain the same events/resources.
fn complete_frame_output(host: &mut HostState, built: BuiltFrame) -> *const c_char {
    let is_static = frame_has_no_transient_data(&built);
    if built.draw_cache_hit && is_static {
        if let Some(cached) = host.frame_json_cache.as_deref() {
            if let Some(json) = patch_frame_number(cached, built.result.frame) {
                host.frame_json_cache_hits = host.frame_json_cache_hits.wrapping_add(1);
                clear_error(host);
                host.output = json;
                return host.output.as_ptr();
            }
        }
    }
    let frame = built.result;
    match serde_json::to_string(&frame) {
        Ok(json) => {
            host.frame_json_serializations = host.frame_json_serializations.wrapping_add(1);
            host.frame_json_serialized_bytes = host
                .frame_json_serialized_bytes
                .wrapping_add(json.len() as u64);
            if is_static {
                host.frame_json_cache = Some(json.clone());
            }
            clear_error(host);
            host.output = c_string(&json);
        }
        Err(error) => {
            set_error(host, format!("frame JSON encode: {error}"));
            let fallback = empty_frame_json(host);
            host.output = c_string(&fallback);
        }
    }
    host.output.as_ptr()
}

fn failed_frame_output(host: &mut HostState, error: String) -> *const c_char {
    // The DrawList/frame is discarded on any error. Drop bridge records from
    // that failed turn so repeated polling cannot grow the queue or replay a
    // request that had no corresponding frame.
    host.outbound.borrow_mut().clear();
    host.frame_json_cache = None;
    set_error(host, error);
    let fallback = empty_frame_json(host);
    host.output = c_string(&fallback);
    host.output.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn pocket_frame(handle: *mut HostState, delta_ms: f64) -> *const c_char {
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
    match build_frame(host, delta_ms) {
        Ok(built) => complete_frame_output(host, built),
        Err(error) => failed_frame_output(host, error),
    }
}

/// Delta-aware frame ABI. The native engine still performs the complete
/// guest/input/tick/layout/resource pass; only a stable DrawList with no
/// transient events or resource lifecycle changes is reduced to a tiny marker.
/// The first frame and every changed frame remain the ordinary full JSON
/// schema, so a caller can use this symbol without a separate visual baseline.
#[no_mangle]
pub unsafe extern "C" fn pocket_frame_delta(
    handle: *mut HostState,
    delta_ms: f64,
) -> *const c_char {
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
    match build_frame(host, delta_ms) {
        Ok(built) if built.draw_cache_hit && frame_has_no_transient_data(&built) => {
            clear_error(host);
            host.output = c_string(UNCHANGED_FRAME_JSON);
            host.output.as_ptr()
        }
        Ok(built) => complete_frame_output(host, built),
        Err(error) => failed_frame_output(host, error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_send(handle: *mut HostState, message: *const c_char) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let Some(message) = message.as_ref() else {
        set_error(host, "null message");
        return -1;
    };
    let line = CStr::from_ptr(message).to_string_lossy();
    let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => value,
        Err(error) => {
            set_error(host, format!("invalid JSON message: {error}"));
            return -1;
        }
    };
    let target = if parsed.get("type").and_then(|v| v.as_str()) == Some("response") {
        "__pocketDeliver"
    } else {
        "__pocketEvent"
    };
    if let Err(error) = queue_input(host, &parsed) {
        set_error(host, error);
        return -1;
    }
    match dispatch_guest(&host.guest, target, &line) {
        Ok(()) => {
            clear_error(host);
            0
        }
        Err(error) => {
            host.outbound.borrow_mut().clear();
            set_error(host, format!("dispatch {target}: {error}"));
            -1
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_last_error(handle: *mut HostState) -> *const c_char {
    if let Some(host) = handle.as_ref() {
        host.error_output.as_ptr()
    } else {
        ptr::null()
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_destroy(handle: *mut HostState) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use std::ffi::{CStr, CString};

    fn frame_json(handle: *mut HostState) -> serde_json::Value {
        let pointer = unsafe { pocket_frame(handle, 16.0) };
        assert!(!pointer.is_null());
        let text = unsafe { CStr::from_ptr(pointer) }.to_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn retained_host_surfaces_preserve_clip_update_and_release() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(r#"
            const surface = pocket.registerSurface('test.glass', 'glass', '{"radius":18}');
            const node = ui.createNode(3);
            ui.setProp(node, 1, 100); ui.setProp(node, 2, 60);
            ui.setCompositorSurface(node, surface, 0);
            ui.insertBefore(1, node, 0);
            let tick = 0;
            globalThis.frame = function() {
                tick++;
                if (tick === 2) pocket.registerSurface('test.glass', 'glass', '{"radius":28}');
                if (tick === 3) { ui.destroyNode(node); pocket.releaseSurface('test.glass'); }
            };
        "#).unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        // The first 16ms sample primes the fixed 60Hz accumulator.
        let _ = frame_json(handle);
        let first = frame_json(handle);
        let op = first["ops"].as_array().unwrap().iter().find(|op| op["type"] == "hostSurface").unwrap();
        assert_eq!(op["id"], "test.glass");
        assert_eq!(op["w"], 100.0);
        assert!(op["clip"].is_object());
        let second = frame_json(handle);
        let op = second["ops"].as_array().unwrap().iter().find(|op| op["type"] == "hostSurface").unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(op["asset"].as_str().unwrap()).unwrap();
        assert_eq!(descriptor["parameters"]["radius"], 28);
        let third = frame_json(handle);
        assert!(!third["ops"].as_array().unwrap().iter().any(|op| op["type"] == "hostSurface"));
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn source_guest_executes_and_returns_a_frame() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let source = CString::new(
            r#"globalThis.frame = function() {
                const node = ui.createNode(0);
                ui.setProp(node, 1, 40);
                ui.setProp(node, 2, 24);
                ui.setProp(node, 64, 0xff336699);
                ui.insertBefore(1, node, 0);
            };"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let frame = frame_json(handle);
        assert_eq!(frame["width"], 320.0);
        assert!(frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["type"] == "rect"));
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn pointer_input_reaches_guest_and_changes_retained_drawlist() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"const node = ui.createNode(0);
            ui.setProp(node, 1, 80);
            ui.setProp(node, 2, 40);
            ui.setProp(node, 64, 0xff336699);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(line) {
                const event = JSON.parse(line);
                if (event.name === 'input.pointer') {
                    if (event.payload.phase === 'up') ui.setProp(node, 64, 0xffcc6633);
                    pocket._emit(JSON.stringify({type:'event', name:'input.seen', payload:event.payload}));
                }
            };"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let down = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"down","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, down.as_ptr()) }, 0);
        let first = frame_json(handle);
        assert!(first["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["name"] == "input.seen"));
        let first_color = first["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "rect")
            .and_then(|op| op["color"].as_u64());
        let up = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"up","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, up.as_ptr()) }, 0);
        let second = frame_json(handle);
        let second_color = second["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "rect")
            .and_then(|op| op["color"].as_u64());
        assert_ne!(first_color, second_color);
        unsafe { pocket_destroy(handle) };
    }

    // Package integration fixtures are caller-supplied; the SDK has no
    // dependency on a sibling demo directory or its application assets.
    fn package_fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("POCKET_TEST_ASSETS")
            .expect("set POCKET_TEST_ASSETS to a compiled guest asset directory"))
            .join(name)
    }

    #[test]
    fn packaged_guest_loads_real_host_assets() {
        let source_path = std::path::PathBuf::from(std::env::var("POCKET_TEST_SOURCE")
            .expect("set POCKET_TEST_SOURCE to compiled guest JS for source-ablation tests"));
        let pak_path = package_fixture("app.pak");
        assert!(source_path.is_file() && pak_path.is_file(), "compile the package fixture before testing");
        let source_file = CString::new(source_path.to_str().unwrap()).unwrap();
        let pak_file = CString::new(pak_path.to_str().unwrap()).unwrap();
        let handle = pocket_create(390.0, 844.0);
        assert!(!handle.is_null());
        let result = unsafe { pocket_load_files(handle, source_file.as_ptr(), pak_file.as_ptr()) };
        assert_eq!(result, 0, "packaged guest failed: {}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        assert!(frame_json(handle)["ops"].as_array().is_some());
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn packaged_bytecode_guest_runs_multiple_frames_and_gc() {
        let bytecode_path = package_fixture("app.qjbc");
        let pak_path = package_fixture("app.pak");
        assert!(bytecode_path.is_file() && pak_path.is_file(), "compile the package fixture before testing");
        let bytecode_file = CString::new(bytecode_path.to_str().unwrap()).unwrap();
        let pak_file = CString::new(pak_path.to_str().unwrap()).unwrap();
        let handle = pocket_create(390.0, 844.0);
        assert!(!handle.is_null());
        let result = unsafe {
            pocket_load_bytecode_files(handle, bytecode_file.as_ptr(), pak_file.as_ptr())
        };
        assert_eq!(result, 0, "bytecode package failed: {}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        for _ in 0..8 {
            let frame = frame_json(handle);
            assert!(frame["ops"].as_array().is_some());
            // Exercise the same context after each frame while the native
            // guest's retained state is live; this catches serialized values
            // that accidentally borrow the caller's byte buffer.
            unsafe {
                (*handle).guest.with(|ctx| ctx.run_gc());
            }
        }
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn malformed_bytecode_is_rejected_without_source_fallback() {
        let bytecode_path = package_fixture("app.qjbc");
        let pak_path = package_fixture("app.pak");
        assert!(bytecode_path.is_file() && pak_path.is_file(), "compile the package fixture before testing");
        let mut bytecode = std::fs::read(bytecode_path).unwrap();
        bytecode[bytecode::HEADER_LEN] ^= 1;
        let pak = std::fs::read(pak_path).unwrap();
        let handle = pocket_create(390.0, 844.0);
        assert!(!handle.is_null());
        let result = unsafe {
            pocket_load_bytecode(
                handle,
                bytecode.as_ptr(),
                bytecode.len(),
                pak.as_ptr(),
                pak.len(),
            )
        };
        assert_eq!(result, -1);
        let error = unsafe { CStr::from_ptr(pocket_last_error(handle)) }.to_string_lossy();
        assert!(
            error.contains("digest"),
            "unexpected bytecode error: {error}"
        );
        unsafe { pocket_destroy(handle) };
    }
}
