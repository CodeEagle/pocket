//! Small PocketJS -> Flutter POC host.
//!
//! This deliberately uses PocketJS's retained UI core and its QuickJS guest,
//! but exposes a tiny JSON bridge to Dart.  The Flutter side owns painting;
//! this library owns JavaScript execution, flexbox layout and frame timing.

pub mod binary_bridge;
mod binary_offload;
pub mod bytecode;
mod demand;
pub mod duplex;
mod frame_delta;
mod guest_security;
pub mod offload;
mod replay;
pub mod worker;
mod worker_trace;

use pocket_draw_ops::{DrawOps, Operation};
use pocket_drivers::{abi, AxisDelta, MotionState, TextEvent};
use pocket_guest_rquickjs::{BindingProfile, RquickjsGuest};
use pocket_runtime::{AssetRegistry, Guest, GuestEnvironment, GuestFrame, OpContext};
use pocket_spec::BINDING_GENERATION;
use pocketjs_core::{damage::DamageRect, Ui};
use rquickjs::{
    function::{FromParams, IntoJsFunc, ParamRequirement, Params},
    Coerced, Ctx, Exception, FromJs, Function, Object, Value,
};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{c_char, CStr, CString};
use std::io::Read;
use std::ptr;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

static PERF_SAMPLING_ENABLED: AtomicBool = AtomicBool::new(false);
static LIVE2D_UPDATE_NANOS: AtomicU64 = AtomicU64::new(0);

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeFrameStageTimingsUs {
    pub js_tick_us: u64,
    pub live2d_update_us: u64,
    pub live2d_emit_us: u64,
    pub relayout_us: u64,
    pub draw_decode_us: u64,
    pub splice_us: u64,
    pub encode_us: u64,
    pub other_us: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct NodeMeta {
    id: i32,
    kind: String,
    asset: String,
    /// Typed compositor descriptor retained beside the legacy JSON asset
    /// spelling. The binary frame path consumes these bytes directly; the
    /// legacy JSON serializer reconstructs the asset only when requested.
    surface_kind: String,
    surface_parameters: Vec<u8>,
    video_id: String,
    fit: String,
    /// Video playback policy carried by the surface metadata.  `true` is the
    /// legacy default for registrations that predate the explicit field;
    /// JS-owned `Video` surfaces send `false` and rely on media events.
    autoplay: bool,
    texture: i32,
    surface: i32,
    from_pack: bool,
}

#[derive(Clone, Debug, Default)]
struct NodeRegistry {
    entries: Vec<NodeMeta>,
    revision: u64,
}

impl NodeRegistry {
    #[inline]
    fn new() -> Self {
        Self::default()
    }

    #[inline]
    fn revision(&self) -> u64 {
        self.revision
    }

    #[inline]
    fn write(&mut self) -> &mut Vec<NodeMeta> {
        self.revision = self.revision.wrapping_add(1);
        &mut self.entries
    }
}

impl std::ops::Deref for NodeRegistry {
    type Target = [NodeMeta];

    #[inline]
    fn deref(&self) -> &[NodeMeta] {
        &self.entries
    }
}

/// A contact captured by the host between two guest frames.  PocketJS's
/// canonical frame ABI deliberately carries contacts as packed u32 words;
/// keeping the decoded form here lets `pocket_send(input.pointer)` resolve a
/// DOWN edge against the committed core layout exactly once.
#[derive(Clone, Copy, Debug)]
struct TouchContact {
    id: u8,
    x: u32,
    y: u32,
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
const TOUCH_COORDINATE_SIDECAR_MARKER: u32 = 0x1000_0000;
const TOUCH_COORD_MASK: u32 = 0x3ff;
const TOUCH_WIDE_ID_SHIFT: u32 = 20;
const TOUCH_LEGACY_ID_SHIFT: u32 = 18;
const MAX_FRAME_TOUCHES: usize = 8;
const DEFAULT_TICK_HZ: u32 = 60;
const MAX_HOST_TICK_HZ: u32 = 120;
const MAX_FRAME_DELTA_MS: f64 = 1000.0;
const MAX_CATCH_UP_TICKS: u32 = MAX_HOST_TICK_HZ;
const CLOCK_EPSILON_MS: f64 = 1.0e-9;

// Control traffic is bounded independently of the high-frequency binary ring.
// Match the JS SDK's event/batch limits and bound retained native frames even
// when a guest emits many small packets before returning its frame.
const MAX_BRIDGE_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_BRIDGE_BATCH_EVENTS: usize = 256;
const MAX_BRIDGE_QUEUED_BYTES: usize = 1024 * 1024;
const MAX_BRIDGE_QUEUED_EVENTS: usize = 1024;

fn valid_bridge_batch(value: &serde_json::Value) -> bool {
    if !value.is_object() {
        return false;
    }
    let is_batch = |event: &serde_json::Value| {
        ["method", "name"]
            .iter()
            .any(|key| event.get(*key).and_then(|v| v.as_str()) == Some("stream.batch"))
    };
    if !is_batch(value) {
        return true;
    }
    let Some(events) = value
        .get("params")
        .or_else(|| value.get("payload"))
        .and_then(|params| params.get("events"))
        .and_then(|events| events.as_array())
    else {
        return false;
    };
    events.len() <= MAX_BRIDGE_BATCH_EVENTS
        && events
            .iter()
            .all(|event| event.is_object() && !is_batch(event))
}

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

fn js_string_property<'js>(object: &Object<'js>, key: &str) -> Option<String> {
    let value: Value<'js> = object.get(key).ok()?;
    value.as_string()?.to_string().ok()
}

fn js_bool_property<'js>(object: &Object<'js>, key: &str) -> Option<bool> {
    let value: Value<'js> = object.get(key).ok()?;
    value.as_bool()
}

fn js_i32_property<'js>(object: &Object<'js>, key: &str) -> Option<i32> {
    let value: Value<'js> = object.get(key).ok()?;
    if let Some(integer) = value.as_int() {
        return Some(integer);
    }
    value
        .as_number()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
        .and_then(|number| i32::try_from(number as i64).ok())
}

#[derive(Clone, Debug)]
struct SharedStr(Rc<str>);

impl PartialEq for SharedStr {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0) || *self.0 == *other.0
    }
}

impl Eq for SharedStr {}

impl std::ops::Deref for SharedStr {
    type Target = str;

    #[inline]
    fn deref(&self) -> &str {
        &self.0
    }
}

impl From<String> for SharedStr {
    #[inline]
    fn from(value: String) -> Self {
        Self(Rc::from(value.into_boxed_str()))
    }
}

impl From<&str> for SharedStr {
    #[inline]
    fn from(value: &str) -> Self {
        Self(Rc::from(value))
    }
}

#[derive(Clone, Debug, PartialEq)]
struct FrameOp {
    kind: &'static str,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    text: Option<String>,
    asset: Option<SharedStr>,
    id: Option<String>,
    /// Flutter texture fitting policy carried by a video SURFACE_QUAD.
    /// The native bridge accepts only the canonical cover/contain/fill values;
    /// absent or unknown metadata is normalized to cover.
    fit: Option<String>,
    /// Explicit native-video initial playback policy.  `None` is omitted for
    /// non-video operations; video operations always carry `Some`, including
    /// `Some(false)`, so the JSON path cannot fall back to legacy autoplay.
    autoplay: Option<bool>,
    repeat_texture: bool,
    color: Option<u32>,
    /// First/last endpoint of a real core GRAD_RECT. Colors use the public
    /// FrameResult ARGB convention (the core DrawList stores ABGR).
    from_color: Option<u32>,
    to_color: Option<u32>,
    /// pocket_spec::GradDir: 0=top, 1=bottom, 2=left, 3=right.
    direction: Option<u32>,
    /// Middle rounded-gradient stop; the fields are paired in JSON/PFB1.
    via_color: Option<u32>,
    via_position: Option<f32>,
    size: Option<f32>,
    font_slot: Option<u8>,
    text_align: Option<u8>,
    surface_handle: Option<i32>,
    focused: Option<bool>,
    radius: Option<f32>,
    border_width: Option<f32>,
    start_angle: Option<f32>,
    sweep_angle: Option<f32>,
    /// Inline triangle geometry for TRI/TEX_TRI records (eliminates per-op heap Vecs).
    points: Option<[FramePoint; 3]>,
    colors: Option<[u32; 3]>,
    uvs: Option<[f32; 6]>,
    /// Normalized source rectangle for an axis-aligned TEX_QUAD.
    uv: Option<[f32; 4]>,
    /// Optional explicit tracking (letter-spacing in logical px) for TEXT_RUN.
    tracking: Option<f32>,
    /// Optional 2x2 linear transform `[a, b, c, d]` anchored at `(x, y)` for TEXT_RUN.
    text_affine: Option<[f32; 4]>,
    /// Typed compositor descriptor used only by the PFB1 encoder. Keeping it
    /// out of the serde representation preserves the legacy JSON asset
    /// descriptor contract without building JSON on the binary hot path.
    surface_kind: Option<String>,
    surface_parameters: Option<Vec<u8>>,
    clip: Clip,
}

#[derive(Serialize)]
struct LegacyFrameOp<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fit: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    autoplay: Option<bool>,
    #[serde(rename = "repeatTexture", skip_serializing_if = "Option::is_none")]
    repeat_texture: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<u32>,
    #[serde(rename = "from", skip_serializing_if = "Option::is_none")]
    from_color: Option<u32>,
    #[serde(rename = "to", skip_serializing_if = "Option::is_none")]
    to_color: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<u32>,
    #[serde(rename = "viaColor", skip_serializing_if = "Option::is_none")]
    via_color: Option<u32>,
    #[serde(rename = "viaPosition", skip_serializing_if = "Option::is_none")]
    via_position: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f32>,
    #[serde(rename = "fontSlot", skip_serializing_if = "Option::is_none")]
    font_slot: Option<u8>,
    #[serde(rename = "align", skip_serializing_if = "Option::is_none")]
    text_align: Option<u8>,
    #[serde(rename = "surfaceHandle", skip_serializing_if = "Option::is_none")]
    surface_handle: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    radius: Option<f32>,
    #[serde(rename = "borderWidth", skip_serializing_if = "Option::is_none")]
    border_width: Option<f32>,
    #[serde(rename = "startAngle", skip_serializing_if = "Option::is_none")]
    start_angle: Option<f32>,
    #[serde(rename = "sweepAngle", skip_serializing_if = "Option::is_none")]
    sweep_angle: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    points: Option<&'a [FramePoint]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    colors: Option<&'a [u32]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uvs: Option<&'a [f32]>,
    #[serde(rename = "uv", skip_serializing_if = "Option::is_none")]
    uv: Option<&'a [f32]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tracking: Option<f32>,
    #[serde(rename = "affine", skip_serializing_if = "Option::is_none")]
    text_affine: Option<&'a [f32]>,
    clip: &'a Clip,
}

impl Serialize for FrameOp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Only the legacy JSON ABI needs the descriptor string. PFB1 calls
        // BinaryFrameWriter directly and never enters this method.
        let descriptor;
        let asset = if self.kind == "hostSurface" && self.asset.is_none() {
            let kind = self
                .surface_kind
                .as_deref()
                .ok_or_else(|| serde::ser::Error::custom("hostSurface kind is missing"))?;
            let parameters = self
                .surface_parameters
                .as_deref()
                .ok_or_else(|| serde::ser::Error::custom("hostSurface parameters are missing"))?;
            let value =
                binary_bridge::decode_to_json(parameters).map_err(serde::ser::Error::custom)?;
            descriptor = serde_json::to_string(&serde_json::json!({
                "kind": kind,
                "parameters": value,
            }))
            .map_err(serde::ser::Error::custom)?;
            Some(descriptor.as_str())
        } else {
            self.asset.as_deref()
        };
        LegacyFrameOp {
            kind: self.kind,
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
            text: self.text.as_deref(),
            asset,
            id: self.id.as_deref(),
            fit: self.fit.as_deref(),
            autoplay: self.autoplay,
            repeat_texture: self.repeat_texture.then_some(true),
            color: self.color,
            from_color: self.from_color,
            to_color: self.to_color,
            direction: self.direction,
            via_color: self.via_color,
            via_position: self.via_position,
            size: self.size,
            font_slot: self.font_slot,
            text_align: self.text_align,
            surface_handle: self.surface_handle,
            focused: self.focused,
            radius: self.radius,
            border_width: self.border_width,
            start_angle: self.start_angle,
            sweep_angle: self.sweep_angle,
            points: self.points.as_ref().map(|v| v.as_slice()),
            colors: self.colors.as_ref().map(|v| v.as_slice()),
            uvs: self.uvs.as_ref().map(|v| v.as_slice()),
            uv: self.uv.as_ref().map(|v| v.as_slice()),
            tracking: self.tracking.filter(|&v| v != 0.0),
            text_affine: self.text_affine.as_ref().map(|v| v.as_slice()),
            clip: &self.clip,
        }
        .serialize(serializer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct FramePoint {
    x: f32,
    y: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct Clip {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Clone, Debug)]
struct OutboundEvent {
    /// Pre-encoded `0xB1` Binary TLV bytes ready to be written directly into
    /// `PFB1` binary frames without any re-serialization.
    binary: Vec<u8>,
}

impl Serialize for OutboundEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let value =
            binary_bridge::decode_to_json(&self.binary).map_err(serde::ser::Error::custom)?;
        value.serialize(serializer)
    }
}

fn serialize_rc_ops<S>(ops: &Rc<Vec<FrameOp>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    ops.as_slice().serialize(serializer)
}

#[derive(Serialize)]
struct FrameResult {
    frame: u64,
    width: f32,
    height: f32,
    #[serde(serialize_with = "serialize_rc_ops")]
    ops: Rc<Vec<FrameOp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auxiliary: Option<SurfaceFrame>,
    events: Vec<OutboundEvent>,
    resources: Vec<FrameResource>,
    #[serde(rename = "releasedResources", skip_serializing_if = "Vec::is_empty")]
    released_resources: Vec<String>,
}

#[derive(Clone, Serialize)]
struct SurfaceFrame {
    width: f32,
    height: f32,
    #[serde(serialize_with = "serialize_rc_ops")]
    ops: Rc<Vec<FrameOp>>,
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
    nodes_revision: u64,
    ops: Rc<Vec<FrameOp>>,
    auxiliary: Option<SurfaceFrame>,
    generic_texture_handles: Rc<Vec<i32>>,
}

impl FrameDrawCache {
    fn matches_primary(
        &self,
        words: &[u32],
        width: f32,
        height: f32,
        auxiliary_size: Option<(f32, f32)>,
        raster_revision: u64,
        nodes_revision: u64,
    ) -> bool {
        self.width == width
            && self.height == height
            && self.auxiliary_size == auxiliary_size
            && self.raster_revision == raster_revision
            && self.nodes_revision == nodes_revision
            && self.words == words
    }

    fn matches_auxiliary(&self, auxiliary_words: Option<&[u32]>) -> bool {
        self.auxiliary_words.as_deref() == auxiliary_words
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

struct PendingWorker {
    bytecode: Vec<u8>,
    config: serde_json::Value,
    notify: Option<unsafe extern "C" fn()>,
}

pub struct HostState {
    ops: OpContext,
    guest: RquickjsGuest,
    /// Immutable per-runtime memory admission policy.  A configured heap
    /// limit is passed to every QuickJS realm initialization, including
    /// reloads; it is deliberately not mutable after construction so an
    /// active realm cannot be downgraded while it is executing.
    memory_limits: MemoryLimits,
    /// Opt-in guest hardening/quota policy. Configuration survives reloads;
    /// the associated fatal marker and live node IDs are per-realm state.
    guest_security: Rc<RefCell<guest_security::GuestSecurityState>>,
    nodes: Rc<RefCell<NodeRegistry>>,
    outbound: Rc<RefCell<Vec<OutboundEvent>>>,
    /// One lock-free SPSC channel per runtime. Reload closes this generation
    /// and installs a new Arc rather than clearing a ring borrowed by another
    /// isolate.
    duplex: Arc<duplex::DuplexRing>,
    duplex_ingress_consumer: duplex::IngressConsumer,
    poisoned: bool,
    last_error: String,
    error_output: CString,
    output: CString,
    /// Last compact binary frame returned by the optional binary delta ABI.
    /// The pointer is borrowed by the Flutter caller until the next native
    /// frame call; Dart copies it immediately before issuing another FFI call.
    binary_output: Vec<u8>,
    frame: u64,
    /// Fixed core/guest tick rate selected before the guest is mounted.  The
    /// PocketJS bundle must have been built for this same rate (`--hz`).
    tick_hz: u32,
    /// Wall-clock remainder used to turn host frame deltas into deterministic
    /// fixed ticks.  `Ui::tick` never consumes a variable delta itself.
    tick_remainder_ms: f64,
    clock_started: bool,
    demand: demand::Demand,
    trace: replay::TraceClock,
    trace_output: CString,
    viewport_width: f32,
    viewport_height: f32,
    /// Immutable pixels-per-logical-pixel contract used by core-generated
    /// bitmap resources (rounded/shadow masks and baked raster assets).
    raster_density: u32,
    auxiliary_viewport: Option<(f32, f32)>,
    compositor_surfaces: BTreeMap<String, i32>,
    guest_loaded: bool,
    worker_program: Option<PendingWorker>,
    worker_runtime: Option<worker::WorkerRuntime>,
    worker_bridge: Option<worker::WorkerUiBridge>,
    worker_trace: Option<Arc<worker_trace::WorkerTrace>>,
    worker_instance: u64,
    offload: Option<Arc<offload::OffloadHost>>,
    offload_output: CString,
    offload_binary_output: Vec<u8>,
    touches: Vec<TouchContact>,
    pending_touch_frames: Vec<PendingTouchFrame>,
    buttons: u32,
    analog: u32,
    right_analog: u32,
    axis_deltas: Vec<AxisDelta>,
    motion: Option<MotionState>,
    pending_text: Vec<TextEvent>,
    external_work_pending: bool,
    text_metrics: Rc<RefCell<TextMetrics>>,
    sent_resources: HashMap<String, SentResource>,
    /// Resource ledger for the caller's last confirmed frame baseline.  The
    /// current `sent_resources` ledger is advanced while building a frame;
    /// this one deliberately stays one transaction behind until the caller
    /// supplies that frame's sequence again.  A stale-base/full-resync call
    /// can therefore re-send current pixels and release assets from the
    /// caller's real baseline without retaining unbounded frame history.
    frame_delta_v2_resource_base: HashMap<String, SentResource>,
    draw_cache: Option<FrameDrawCache>,
    /// Sequence of the most recent frame actually published to the caller.
    /// `build_frame` advances `frame` for every native transaction, including
    /// an idle v2 probe that returns zero bytes; keeping this separate prevents
    /// an unobservable probe from moving the client's base sequence forward.
    /// A reload clears the publication baseline. A resize keeps the sequence
    /// for resource acknowledgement while dropping draw_cache, which still
    /// forces a full PFB1 frame on the next v2 call.
    frame_delta_v2_published: Option<u64>,
    frame_json_cache: Option<String>,
    // These counters are intentionally kept in the native host so regression
    // tests can measure the optimization without changing the Dart ABI. They
    // count actual serde passes/bytes, not Dart Stream objects or estimates.
    frame_json_serializations: u64,
    frame_json_serialized_bytes: u64,
    frame_json_cache_hits: u64,
    draw_decode_count: u64,
    last_stage_timings: NativeFrameStageTimingsUs,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct MemoryLimits {
    /// `None` preserves the legacy 16 MiB script/DOM budget plus the PAK
    /// bytes reserved by `guest_heap_limit`.  A configured value is the
    /// complete QuickJS runtime budget and already includes `globalThis.__pak`.
    heap_limit_bytes: Option<usize>,
    /// Optional package admission limit.  It is checked against the actual
    /// PAK byte length before native assets or a guest realm are mounted.
    max_pak_bytes: Option<usize>,
}

/// Compact, little-endian frame transport used by the production Flutter
/// bridge. JSON remains available through `pocket_frame` and
/// `pocket_frame_delta` for diagnostics and older hosts, while this format
/// keeps DrawOps and image pixels out of the UTF-8/serde JSON path.
const BINARY_FRAME_MAGIC: u32 = u32::from_le_bytes(*b"PFB1");
const BINARY_FRAME_VERSION: u16 = 2;
const BINARY_FRAME_ROUNDED_RING_VERSION: u16 = 3;
const BINARY_FRAME_ARC_VERSION: u16 = 4;
const BINARY_FRAME_ROUNDED_GRADIENT_VERSION: u16 = 5;
const BINARY_FRAME_TEXT_TRANSFORM_VERSION: u16 = 6;

struct BinaryFrameWriter {
    bytes: Vec<u8>,
}

impl BinaryFrameWriter {
    #[cfg(test)]
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), String> {
        let len =
            u32::try_from(value.len()).map_err(|_| "binary frame field is too large".to_owned())?;
        self.u32(len);
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn string(&mut self, value: &str) -> Result<(), String> {
        self.bytes(value.as_bytes())
    }

    fn optional_u32(&mut self, value: Option<u32>) {
        match value {
            Some(value) => {
                self.u8(1);
                self.u32(value);
            }
            None => self.u8(0),
        }
    }

    fn clip(&mut self, clip: &Clip) {
        self.f32(clip.x);
        self.f32(clip.y);
        self.f32(clip.w);
        self.f32(clip.h);
    }

    fn op(&mut self, op: &FrameOp) -> Result<(), String> {
        let border_width = op.border_width.unwrap_or(0.0);
        if op.kind == "rounded" && (!border_width.is_finite() || border_width < 0.0) {
            return Err("rounded rectangle border width must be finite and nonnegative".to_owned());
        }
        if op.kind == "arc"
            && (!op.radius.is_some_and(f32::is_finite)
                || op.radius.unwrap_or(-1.0) < 0.0
                || !border_width.is_finite()
                || border_width <= 0.0
                || !op.start_angle.is_some_and(f32::is_finite)
                || !op.sweep_angle.is_some_and(f32::is_finite)
                || op.sweep_angle.unwrap_or(0.0) == 0.0
                || op.sweep_angle.unwrap_or(0.0).abs() > 360.0)
        {
            return Err(
                "arc geometry must be finite with a nonzero sweep in ±360 degrees".to_owned(),
            );
        }
        if op.kind == "roundedGradient" {
            let via_is_complete = op.via_color.is_some() == op.via_position.is_some();
            if ![op.x, op.y, op.w, op.h]
                .into_iter()
                .all(f32::is_finite)
                || op.w <= 0.0
                || op.h <= 0.0
                || op.from_color.is_none()
                || op.to_color.is_none()
                || !op.radius.is_some_and(|radius| radius.is_finite() && radius > 0.0)
                || !op.direction.is_some_and(|direction| direction <= 3)
                || !via_is_complete
                || op.via_position.is_some_and(|position| {
                    !position.is_finite() || position <= 0.0 || position >= 1.0
                })
            {
                return Err("rounded gradient has invalid geometry, direction, or middle stop".to_owned());
            }
        }
        let tag = match op.kind {
            "rect" => 0,
            "rounded" if border_width > 0.0 => 15,
            "rounded" => 1,
            "arc" => 16,
            "roundedGradient" => 17,
            "gradient" => 2,
            "triangle" => 3,
            "textureTriangle" if op.repeat_texture => 14,
            "textureTriangle" => 4,
            "text" if op.tracking.is_some_and(|t| t != 0.0) || op.text_affine.is_some() => 18,
            "text" => 5,
            "image" => 6,
            "hostSurface" => 7,
            "video" => 8,
            "meshLayerBegin" => 9,
            "meshMaskBegin" => 10,
            "meshLayerRestore" => 11,
            other => return Err(format!("unsupported binary frame operation {other}")),
        };
        self.u8(tag);
        self.f32(op.x);
        self.f32(op.y);
        self.f32(op.w);
        self.f32(op.h);
        self.clip(&op.clip);
        match tag {
            0 => self.u32(op.color.unwrap_or(0)),
            1 => {
                self.u32(op.color.unwrap_or(0));
                self.f32(op.radius.unwrap_or(0.0));
            }
            15 => {
                let radius = op.radius.unwrap_or(0.0);
                if !radius.is_finite() || radius < 0.0 {
                    return Err(
                        "rounded rectangle radius must be finite and nonnegative".to_owned()
                    );
                }
                self.u32(op.color.unwrap_or(0));
                self.f32(radius);
                self.f32(border_width);
            }
            16 => {
                self.u32(op.color.unwrap_or(0));
                self.f32(op.radius.unwrap_or(0.0));
                self.f32(border_width);
                self.f32(op.start_angle.unwrap_or(0.0));
                self.f32(op.sweep_angle.unwrap_or(0.0));
            }
            17 => {
                self.u32(op.from_color.expect("validated rounded gradient start color"));
                self.u32(op.to_color.expect("validated rounded gradient end color"));
                self.u32(op.direction.expect("validated rounded gradient direction"));
                self.f32(op.radius.expect("validated rounded gradient radius"));
                match (op.via_color, op.via_position) {
                    (Some(color), Some(position)) => {
                        self.u8(1);
                        self.u32(color);
                        self.f32(position);
                    }
                    (None, None) => self.u8(0),
                    _ => unreachable!("rounded gradient optional fields were validated"),
                }
            }
            2 => {
                self.u32(op.from_color.unwrap_or(0));
                self.u32(op.to_color.unwrap_or(0));
                self.u32(op.direction.unwrap_or(0));
            }
            3 => {
                let points = op
                    .points
                    .as_ref()
                    .ok_or_else(|| "triangle points missing".to_owned())?;
                let colors = op
                    .colors
                    .as_ref()
                    .ok_or_else(|| "triangle colors missing".to_owned())?;
                if points.len() != 3 || colors.len() != 3 {
                    return Err("triangle must contain three points and colors".to_owned());
                }
                for point in points {
                    self.f32(point.x);
                    self.f32(point.y);
                }
                for color in colors {
                    self.u32(*color);
                }
            }
            4 | 14 => {
                let points = op
                    .points
                    .as_ref()
                    .ok_or_else(|| "texture triangle points missing".to_owned())?;
                let uvs = op
                    .uvs
                    .as_ref()
                    .ok_or_else(|| "texture triangle UVs missing".to_owned())?;
                if points.len() != 3 || uvs.len() != 6 {
                    return Err("texture triangle must contain three points and six UVs".to_owned());
                }
                self.string(op.asset.as_deref().unwrap_or(""))?;
                self.u32(op.color.unwrap_or(0));
                for point in points {
                    self.f32(point.x);
                    self.f32(point.y);
                }
                for uv in uvs {
                    self.f32(*uv);
                }
            }
            5 => {
                self.string(op.text.as_deref().unwrap_or(""))?;
                self.f32(op.size.unwrap_or(16.0));
                self.u32(op.color.unwrap_or(0));
                match op.font_slot {
                    Some(slot) => {
                        self.u8(1);
                        self.u8(slot);
                    }
                    None => self.u8(0),
                }
                self.u8(op.text_align.unwrap_or(0));
            }
            18 => {
                let tracking = op.tracking.filter(|&t| t != 0.0);
                if let Some(t) = tracking {
                    if !t.is_finite() {
                        return Err("text tracking must be finite".to_owned());
                    }
                }
                if let Some(affine) = op.text_affine.as_ref() {
                    if affine.iter().any(|v| !v.is_finite()) {
                        return Err("text affine transform must be finite".to_owned());
                    }
                }
                self.string(op.text.as_deref().unwrap_or(""))?;
                self.f32(op.size.unwrap_or(16.0));
                self.u32(op.color.unwrap_or(0));
                match op.font_slot {
                    Some(slot) => {
                        self.u8(1);
                        self.u8(slot);
                    }
                    None => self.u8(0),
                }
                self.u8(op.text_align.unwrap_or(0));
                let mut ext_flags = 0u8;
                if tracking.is_some() {
                    ext_flags |= 0x01;
                }
                if op.text_affine.is_some() {
                    ext_flags |= 0x02;
                }
                self.u8(ext_flags);
                if let Some(t) = tracking {
                    self.f32(t);
                }
                if let Some(affine) = op.text_affine.as_ref() {
                    for value in affine {
                        self.f32(*value);
                    }
                }
            }
            6 => {
                self.string(op.asset.as_deref().unwrap_or(""))?;
                match op.uv.as_ref() {
                    Some(uv) => {
                        self.u8(1);
                        for value in uv {
                            self.f32(*value);
                        }
                    }
                    None => self.u8(0),
                }
                self.optional_u32(op.color);
            }
            7 | 8 => {
                self.string(op.id.as_deref().unwrap_or(""))?;
                if tag == 7 {
                    self.string(
                        op.surface_kind
                            .as_deref()
                            .ok_or_else(|| "hostSurface kind is missing".to_owned())?,
                    )?;
                    let parameters = op
                        .surface_parameters
                        .as_deref()
                        .ok_or_else(|| "hostSurface parameters are missing".to_owned())?;
                    if parameters.first().copied() != Some(binary_bridge::BINARY_MESSAGE_MAGIC) {
                        return Err("hostSurface parameters are not a 0xB1 object".to_owned());
                    }
                    self.bytes(parameters)?;
                    self.u32(op.surface_handle.unwrap_or(0) as u32);
                    self.u8(u8::from(op.focused.unwrap_or(false)));
                } else {
                    self.string(op.asset.as_deref().unwrap_or(""))?;
                    self.u8(if op.fit.as_deref() == Some("contain") {
                        1
                    } else if op.fit.as_deref() == Some("fill") {
                        2
                    } else {
                        0
                    });
                    // Older FrameOps did not carry this bit and native
                    // surfaces historically autoplayed. Keep that fallback
                    // for legacy producers while honoring explicit JS video
                    // metadata (including false).
                    self.u8(u8::from(op.autoplay.unwrap_or(true)));
                }
            }
            9 => {
                let tints = op
                    .uvs
                    .as_ref()
                    .ok_or_else(|| "mesh layer tint is missing".to_owned())?;
                if tints.len() != 6 || !(0..=3).contains(&op.color.unwrap_or(u32::MAX)) {
                    return Err("invalid mesh layer parameters".to_owned());
                }
                self.u32(op.color.unwrap_or(0));
                for value in tints {
                    if !value.is_finite() || !(0.0..=1.0).contains(value) {
                        return Err("invalid mesh layer tint".to_owned());
                    }
                    self.f32(*value);
                }
            }
            10 => match op.color {
                Some(0 | 1) => self.u8(op.color.unwrap_or(0) as u8),
                _ => return Err("invalid mesh mask inversion flag".to_owned()),
            },
            11 => {}
            _ => unreachable!(),
        }
        Ok(())
    }

    fn ops(&mut self, ops: &[FrameOp]) -> Result<(), String> {
        let count = u32::try_from(ops.len()).map_err(|_| "too many frame operations".to_owned())?;
        self.u32(count);
        for op in ops {
            self.op(op)?;
        }
        Ok(())
    }
}

// Every current PFB1 operation has a fixed tag/geometry/clip prefix of
// 33 bytes, before its kind-specific fields. PFP1 adds 28 bytes, so retaining
// at least one common operation always makes the splice smaller than a full
// PFB1. Keep this invariant explicit when adding a new binary operation tag.
const MIN_BINARY_OP_BYTES: usize = 33;
const MAX_RETAINED_BINARY_OUTPUT_CAPACITY: usize = 256 * 1024;

#[inline]
fn reset_binary_output_buffer(buf: &mut Vec<u8>) {
    buf.clear();
    if buf.capacity() > MAX_RETAINED_BINARY_OUTPUT_CAPACITY {
        buf.shrink_to(MAX_RETAINED_BINARY_OUTPUT_CAPACITY);
    }
}

#[cfg(test)]
fn encode_binary_frame(frame: &FrameResult) -> Result<Vec<u8>, String> {
    encode_binary_frame_with_ops(frame, &frame.ops)
}

/// Encode a complete PFB1 frame while replacing only the primary operation
/// segment. PFP1 uses this to carry the insertion segment of a splice; events,
/// resources, releases, and the complete auxiliary surface remain the current
/// frame's metadata. The ordinary PFB1 ABI always calls this with `frame.ops`.
#[cfg(test)]
fn encode_binary_frame_with_ops(frame: &FrameResult, ops: &[FrameOp]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    encode_binary_frame_append(&mut out, frame, ops)?;
    Ok(out)
}

fn scan_binary_frame_version(operations: &[FrameOp]) -> u16 {
    let mut version = BINARY_FRAME_VERSION;
    for op in operations {
        match op.kind {
            "text" if op.tracking.is_some_and(|t| t != 0.0) || op.text_affine.is_some() => {
                return BINARY_FRAME_TEXT_TRANSFORM_VERSION;
            }
            "roundedGradient" => {
                version = version.max(BINARY_FRAME_ROUNDED_GRADIENT_VERSION);
            }
            "arc" => version = version.max(BINARY_FRAME_ARC_VERSION),
            "rounded" if op.border_width.is_some_and(|width| width > 0.0) => {
                version = version.max(BINARY_FRAME_ROUNDED_RING_VERSION);
            }
            _ => {}
        }
    }
    version
}

/// Append a complete PFB1 frame into `out`, reusing `out`'s existing heap
/// allocation across frames to eliminate steady-state buffer reallocations.
fn encode_binary_frame_append(
    out: &mut Vec<u8>,
    frame: &FrameResult,
    ops: &[FrameOp],
) -> Result<(), String> {
    let aux_len = frame.auxiliary.as_ref().map_or(0, |aux| aux.ops.len());
    out.reserve(ops.len().saturating_add(aux_len).saturating_mul(48).saturating_add(64));
    let mut writer = BinaryFrameWriter {
        bytes: std::mem::take(out),
    };
    let result = (|| -> Result<(), String> {
        writer.u32(BINARY_FRAME_MAGIC);
        let mut version = scan_binary_frame_version(ops);
        if version < BINARY_FRAME_TEXT_TRANSFORM_VERSION {
            if let Some(auxiliary) = frame.auxiliary.as_ref() {
                version = version.max(scan_binary_frame_version(&auxiliary.ops));
            }
        }
        writer.u16(version);
        // PFB1 metadata: existing text/handle fields plus typed surface
        // descriptors (tag 7).
        writer.u16(3);
        writer.u64(frame.frame);
        writer.f32(frame.width);
        writer.f32(frame.height);
        writer.ops(ops)?;
        let event_count =
            u32::try_from(frame.events.len()).map_err(|_| "too many frame events".to_owned())?;
        writer.u32(event_count);
        for event in &frame.events {
            writer.bytes(&event.binary)?;
        }
        let resource_count = u32::try_from(frame.resources.len())
            .map_err(|_| "too many frame resources".to_owned())?;
        writer.u32(resource_count);
        for resource in &frame.resources {
            writer.string(&resource.asset)?;
            writer.u64(resource.revision);
            writer.u32(resource.width);
            writer.u32(resource.height);
            writer.u32(resource.psm);
            writer.u8(if resource.linear { 1 } else { 0 });
            writer.bytes(&resource.pixels)?;
            match resource.palette.as_deref() {
                Some(palette) => {
                    writer.u8(1);
                    writer.bytes(palette)?;
                }
                None => writer.u8(0),
            }
        }
        let released_count = u32::try_from(frame.released_resources.len())
            .map_err(|_| "too many released resources".to_owned())?;
        writer.u32(released_count);
        for resource in &frame.released_resources {
            writer.string(resource)?;
        }
        match frame.auxiliary.as_ref() {
            Some(auxiliary) => {
                writer.u8(1);
                writer.f32(auxiliary.width);
                writer.f32(auxiliary.height);
                writer.ops(&auxiliary.ops)?;
            }
            None => writer.u8(0),
        }
        Ok(())
    })();
    *out = writer.bytes;
    result
}

fn new_duplex_channel() -> (Arc<duplex::DuplexRing>, duplex::IngressConsumer) {
    let ring = duplex::DuplexRing::new_shared();
    let consumer = ring
        .claim_ingress_consumer()
        .expect("new duplex channel must have an unclaimed ingress consumer");
    (ring, consumer)
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

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(msg) = payload.downcast_ref::<&str>() {
        (*msg).to_owned()
    } else if let Some(msg) = payload.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}

#[inline]
fn catch_ffi_unwind<T, F>(sentinel: T, f: F) -> T
where
    T: Copy,
    F: FnOnce() -> T,
{
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(sentinel)
}

unsafe fn guard_host_mut<T, F>(
    handle: *mut HostState,
    fn_name: &'static str,
    sentinel: T,
    f: F,
) -> T
where
    T: Copy,
    F: FnOnce(&mut HostState) -> T,
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(host) = handle.as_mut() else {
            return sentinel;
        };
        if host.poisoned {
            if host.last_error.is_empty() {
                set_error(host, "host runtime is poisoned after a previous native panic");
            }
            return sentinel;
        }
        f(host)
    }));
    match result {
        Ok(value) => value,
        Err(payload) => {
            let msg = panic_payload_message(payload);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Some(host) = handle.as_mut() {
                    host.poisoned = true;
                    set_error(host, format!("native panic in {fn_name}: {msg}"));
                }
            }));
            sentinel
        }
    }
}

unsafe fn guard_host_ref<T, F>(handle: *const HostState, sentinel: T, f: F) -> T
where
    T: Copy,
    F: FnOnce(&HostState) -> T,
{
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(host) = handle.as_ref() else {
            return sentinel;
        };
        if host.poisoned {
            return sentinel;
        }
        f(host)
    }))
    .unwrap_or(sentinel)
}

fn guest_security_fatal(host: &HostState) -> Option<String> {
    guest_security::fatal(&host.guest_security)
}

fn ensure_guest_security_healthy(host: &HostState) -> Result<(), String> {
    guest_security_fatal(host).map_or(Ok(()), Err)
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
const MAX_BATCH_LAYOUT_IDS: usize = 256;

fn committed_layout_in_ui(ui: &Ui, id: i32) -> Result<Option<(f32, f32, f32, f32)>, String> {
    if id == 0 || !ui.node_exists(id) {
        return Ok(None);
    }
    let auxiliary_root = ui.auxiliary_surface_root();
    let mut current = id;
    let mut x = 0.0_f32;
    let mut y = 0.0_f32;
    let mut width = 0.0_f32;
    let mut height = 0.0_f32;
    let mut depth = 0usize;
    loop {
        let Some((local_x, local_y, local_w, local_h)) = ui.layout_of(current) else {
            return Ok(None);
        };
        if current == id {
            width = local_w;
            height = local_h;
        }
        x += local_x;
        y += local_y;
        let parent = ui.node_parent(current);
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

fn committed_layout(ops: &OpContext, id: i32) -> Result<Option<(f32, f32, f32, f32)>, String> {
    if id == 0 {
        return Ok(None);
    }
    let mut core = ops
        .core_mut()
        .map_err(|error| format!("layout query: {error:?}"))?;
    core.ui.relayout_outputs();
    committed_layout_in_ui(&core.ui, id)
}

fn committed_layouts(
    ops: &OpContext,
    ids: &[i32],
) -> Result<Vec<Option<(f32, f32, f32, f32)>>, String> {
    if ids.is_empty() || ids.iter().all(|&id| id == 0) {
        return Ok(vec![None; ids.len()]);
    }
    let mut core = ops
        .core_mut()
        .map_err(|error| format!("layout query: {error:?}"))?;
    core.ui.relayout_outputs();
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        out.push(committed_layout_in_ui(&core.ui, id)?);
    }
    Ok(out)
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

fn js_layouts<'js>(
    ctx: Ctx<'js>,
    ops: &OpContext,
    ids_val: Value<'js>,
) -> rquickjs::Result<Value<'js>> {
    let Some(array) = ids_val.as_array() else {
        return Err(Exception::throw_type(
            &ctx,
            "getLayouts expects an array of node ids",
        ));
    };
    let len = array.len();
    if len > MAX_BATCH_LAYOUT_IDS {
        return Err(Exception::throw_range(
            &ctx,
            "getLayouts batch exceeds limit",
        ));
    }
    let mut parsed_ids = Vec::with_capacity(len);
    for idx in 0..len {
        let elem: Value<'js> = array.get(idx)?;
        let id = if let Some(id) = elem.as_int() {
            id
        } else if let Some(n) = elem.as_number() {
            if n.is_finite() && n.fract() == 0.0 && n >= i32::MIN as f64 && n <= i32::MAX as f64 {
                n as i32
            } else {
                0
            }
        } else {
            0
        };
        parsed_ids.push(id);
    }
    let rects = committed_layouts(ops, &parsed_ids)
        .map_err(|error| Exception::throw_internal(&ctx, error.as_str()))?;
    let out = rquickjs::Array::new(ctx.clone())?;
    for (idx, rect) in rects.into_iter().enumerate() {
        let val = if let Some((x, y, width, height)) = rect {
            let obj = Object::new(ctx.clone())?;
            obj.set("x", x)?;
            obj.set("y", y)?;
            obj.set("width", width)?;
            obj.set("height", height)?;
            obj.into_value()
        } else {
            Value::new_null(ctx.clone())
        };
        out.set(idx, val)?;
    }
    Ok(out.into_value())
}

struct LayoutsFunction {
    ops: OpContext,
}

impl<'js> IntoJsFunc<'js, (Ctx<'js>, Value<'js>)> for LayoutsFunction {
    fn param_requirements() -> ParamRequirement {
        <(Ctx<'js>, Value<'js>)>::param_requirements()
    }

    fn call<'a>(&self, params: Params<'a, 'js>) -> rquickjs::Result<Value<'js>> {
        let (ctx, ids) = <(Ctx<'js>, Value<'js>)>::from_params(&mut params.access())?;
        js_layouts(ctx, &self.ops, ids)
    }
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

fn checked_duplex_u16(value: f64) -> Option<u16> {
    (value.is_finite() && value >= 0.0 && value <= u16::MAX as f64 && value.fract() == 0.0)
        .then_some(value as u16)
}

fn stop_worker(host: &mut HostState) {
    if let Err(error) = stop_worker_checked(host) {
        set_error(host, error);
    }
}

fn stop_worker_checked(host: &mut HostState) -> Result<(), String> {
    if let Some(runtime) = &mut host.worker_runtime {
        runtime.request_stop_and_wait();
    }
    if let Some(mut bridge) = host.worker_bridge.take() {
        bridge.detach();
    }
    if let Some(mut runtime) = host.worker_runtime.take() {
        let worker_error = runtime.last_error();
        let join_result = runtime.destroy_and_join();
        let post_error = runtime.last_error();
        if let Some(err) = worker_error.or(post_error) {
            return Err(format!("worker error: {err}"));
        }
        if let Err(error) = join_result {
            return Err(format!("worker teardown: {error}"));
        }
    }
    Ok(())
}

/// Stop asynchronous producers while the UI realm and trace transaction are
/// still alive. The caller closes the trace before freeing the native handle;
/// this preserves cancellation and exit facts in the recording.
#[no_mangle]
pub unsafe extern "C" fn pocket_stop_async(handle: *mut HostState) -> i32 {
    guard_host_mut(handle, "pocket_stop_async", -1, |host| {
        if let Err(error) = stop_worker_checked(host) {
            set_error(host, error);
            return -1;
        }
        if let Some(provider) = &host.offload {
            provider.shutdown();
        }
        clear_error(host);
        0
    })
}

impl Drop for HostState {
    fn drop(&mut self) {
        stop_worker(self);
        if let Some(provider) = self.offload.take() {
            provider.shutdown();
        }
    }
}

fn ensure_async_trace(
    host: &mut HostState,
) -> Result<Option<Arc<worker_trace::WorkerTrace>>, String> {
    if replay::mode(host) == replay::Mode::Live {
        return Ok(None);
    }
    if let Some(lane) = &host.worker_trace {
        return Ok(Some(lane.clone()));
    }
    let lane = worker_trace::WorkerTrace::new(replay::mode(host));
    // The configure transaction began before the first async resource existed.
    // Its empty prefix opens the same lane used by every later UI transaction.
    lane.begin_batch(&[])?;
    host.worker_trace = Some(lane.clone());
    Ok(Some(lane))
}

fn start_worker(host: &mut HostState) -> Result<(), String> {
    if host.worker_runtime.is_some() {
        return Ok(());
    }
    let Some(program) = &host.worker_program else {
        return Ok(());
    };
    let config = &program.config;
    let declaration: worker::WorkerDeclaration =
        serde_json::from_value(config["declaration"].clone()).map_err(|e| e.to_string())?;
    let policy = worker::WorkerPolicy {
        required_capabilities: serde_json::from_value(
            config["policy"]["requiredCapabilities"].clone(),
        )
        .map_err(|e| e.to_string())?,
        allowed_http_origins: serde_json::from_value(
            config["policy"]["allowedHttpOrigins"].clone(),
        )
        .map_err(|e| e.to_string())?,
    };
    let integer = |field: &str| -> Result<u32, String> {
        config["limits"][field]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("invalid worker limit {field}"))
    };
    let limits = worker::WorkerLimits {
        heap_bytes: integer("heapBytes")? as usize,
        stack_bytes: integer("stackBytes")? as usize,
        turn_budget_micros: integer("turnBudgetMicros")?,
        window_micros: integer("windowMicros")?,
        quota_micros: integer("quotaMicros")?,
    };
    let arguments = (
        declaration,
        policy,
        limits,
        if replay::is_replay(host) {
            None
        } else {
            program.notify
        },
    );
    host.worker_instance = host
        .worker_instance
        .checked_add(1)
        .ok_or("worker instance counter exhausted")?;
    let mut runtime = if let Some(trace) = &host.worker_trace {
        worker::WorkerRuntime::spawn_traced(
            &program.bytecode,
            BINDING_GENERATION,
            host.tick_hz,
            arguments.0,
            arguments.1,
            arguments.2,
            arguments.3,
            trace.clone(),
            format!(
                "worker:{}:{}",
                config["nativeGeneration"], host.worker_instance
            ),
        )
    } else {
        worker::WorkerRuntime::spawn(
            &program.bytecode,
            BINDING_GENERATION,
            host.tick_hz,
            arguments.0,
            arguments.1,
            arguments.2,
            arguments.3,
        )
    }
    .map_err(|e| e.to_string())?;
    if let Err(error) = runtime.wait_ready(std::time::Duration::from_secs(2)) {
        runtime.request_stop_and_wait();
        let _ = runtime.destroy_and_join();
        return Err(error.to_string());
    }
    let attached = host
        .guest
        .with(|ctx| unsafe { runtime.attach_ui(ctx.as_raw().as_ptr()) })
        .ok_or("UI context is not initialized")?;
    match attached {
        Ok(bridge) => {
            host.worker_bridge = Some(bridge);
            host.worker_runtime = Some(runtime);
            Ok(())
        }
        Err(error) => {
            runtime.request_stop_and_wait();
            let _ = runtime.destroy_and_join();
            Err(error.to_string())
        }
    }
}

/// Configure a real QJBC worker before loading its UI guest. The consuming
/// package admission layer verifies the signed descriptor and origin grants.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_worker(
    handle: *mut HostState,
    bytes: *const u8,
    length: usize,
    config_json: *const c_char,
    notify: Option<unsafe extern "C" fn()>,
) -> i32 {
    guard_host_mut(handle, "pocket_configure_worker", -1, |host| {
        let result = (|| -> Result<PendingWorker, String> {
            if host.guest_loaded || host.worker_program.is_some() {
                return Err("worker must be configured once before guest evaluation".into());
            }
            if bytes.is_null() || length == 0 || length > 64 * 1024 * 1024 || config_json.is_null()
            {
                return Err("invalid worker bytecode/configuration".into());
            }
            let json = CStr::from_ptr(config_json).to_bytes();
            if json.len() > 64 * 1024 {
                return Err("worker configuration exceeds 64 KiB".into());
            }
            let config: serde_json::Value =
                serde_json::from_slice(json).map_err(|e| e.to_string())?;
            if config["protocolVersion"] != 1
                || config["bindingGeneration"] != BINDING_GENERATION
                || config["tickHz"] != host.tick_hz
                || config["nativeGeneration"]
                    .as_u64()
                    .filter(|v| *v > 0 && *v <= u32::MAX as u64)
                    .is_none()
                || config["expectedRuntimeAbi"] != bytecode::runtime_abi()
            {
                return Err("worker protocol/binding/tick/ABI mismatch".into());
            }
            let bytecode = std::slice::from_raw_parts(bytes, length);
            bytecode::validate(
                bytecode,
                bytecode::BytecodeExpectation {
                    kind: bytecode::BytecodeKind::Script,
                    binding_generation: BINDING_GENERATION,
                    tick_hz: host.tick_hz,
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(PendingWorker {
                bytecode: bytecode.to_vec(),
                config,
                notify,
            })
        })();
        match result {
            Ok(program) => {
                if let Err(error) = ensure_async_trace(host) {
                    set_error(host, error);
                    return -1;
                }
                host.worker_program = Some(program);
                clear_error(host);
                0
            }
            Err(e) => {
                set_error(host, e);
                -1
            }
        }
    })
}

fn checked_duplex_u32(value: f64) -> Option<u32> {
    (value.is_finite() && value >= 0.0 && value <= u32::MAX as f64 && value.fract() == 0.0)
        .then_some(value as u32)
}

fn install_bridge(
    guest: &RquickjsGuest,
    ops: OpContext,
    security: Rc<RefCell<guest_security::GuestSecurityState>>,
    nodes: Rc<RefCell<NodeRegistry>>,
    outbound: Rc<RefCell<Vec<OutboundEvent>>>,
    duplex: Arc<duplex::DuplexRing>,
    auxiliary: Option<(i32, f32, f32)>,
    compositor_surfaces: &BTreeMap<String, i32>,
    offload: Option<Arc<offload::OffloadHost>>,
    trace_mode: replay::Mode,
    trace_lane: Rc<RefCell<replay::ScalarLane>>,
    host_fonts: bool,
) -> Result<(), String> {
    guest
        .with(|ctx| {
            let globals = ctx.globals();
            let bridge = Object::new(ctx.clone())?;

            let emit_queue = outbound.clone();
            // This closure is the only producer of this queue. An empty queue
            // means the frame/load/error boundary drained it, so accounting
            // resets without introducing a second host queue or polling task.
            let queued_bytes = Rc::new(Cell::new(0usize));
            let enqueue_bridge_value = {
                let emit_queue = emit_queue.clone();
                let queued_bytes = queued_bytes.clone();
                move |raw: Value<'_>, allow_legacy_string: bool| -> rquickjs::Result<bool> {
                    let remaining_budget = {
                        let queue = emit_queue.borrow();
                        if queue.is_empty() {
                            queued_bytes.set(0);
                        }
                        if queue.len() >= MAX_BRIDGE_QUEUED_EVENTS {
                            return Ok(false);
                        }
                        MAX_BRIDGE_QUEUED_BYTES.saturating_sub(queued_bytes.get())
                    };
                    if remaining_budget == 0 {
                        return Ok(false);
                    }
                    let (binary, cost) = if let Some(js_str) = raw.as_string() {
                        if !allow_legacy_string {
                            return Ok(false);
                        }
                        let Ok(line) = js_str.to_string() else {
                            return Ok(false);
                        };
                        if line.len() > MAX_BRIDGE_MESSAGE_BYTES.min(remaining_budget) {
                            return Ok(false);
                        }
                        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
                            return Ok(false);
                        };
                        if !valid_bridge_batch(&parsed) {
                            return Ok(false);
                        }
                        let Ok(binary) = binary_bridge::encode_json_to_binary(&parsed, usize::MAX)
                        else {
                            return Ok(false);
                        };
                        (binary, line.len())
                    } else {
                        let Ok(binary) = binary_bridge::encode_js_message(
                            raw,
                            MAX_BRIDGE_MESSAGE_BYTES.min(remaining_budget),
                            MAX_BRIDGE_BATCH_EVENTS,
                        ) else {
                            return Ok(false);
                        };
                        let cost = binary.len();
                        (binary, cost)
                    };
                    let mut queue = emit_queue.borrow_mut();
                    if queue.is_empty() {
                        queued_bytes.set(0);
                    }
                    let remaining_budget =
                        MAX_BRIDGE_QUEUED_BYTES.saturating_sub(queued_bytes.get());
                    if queue.len() >= MAX_BRIDGE_QUEUED_EVENTS
                        || cost > MAX_BRIDGE_MESSAGE_BYTES.min(remaining_budget)
                    {
                        return Ok(false);
                    }
                    queue.push(OutboundEvent { binary });
                    queued_bytes.set(queued_bytes.get() + cost);
                    // The official PocketJS app/stream bridge treats the host
                    // emitter as a boolean transport. Returning `undefined`
                    // makes a valid queued event look rejected to
                    // `stream.open`/`host.request`, even though it was accepted
                    // by this native queue.
                    Ok(true)
                }
            };
            let emit_fn_closure = enqueue_bridge_value.clone();
            let emit = Function::new(ctx.clone(), move |_ctx: Ctx<'_>, value: Value<'_>| {
                emit_fn_closure(value, true)
            })?;
            let emit_val_closure = enqueue_bridge_value;
            let emit_value = Function::new(ctx.clone(), move |_ctx: Ctx<'_>, value: Value<'_>| {
                emit_val_closure(value, false)
            })?;
            bridge.set("_emit", emit)?;
            bridge.set("_emitValue", emit_value)?;

            // Binary high-frequency host/guest transport.  The record is
            // written straight into the native-owned ring; only five scalar
            // values cross QuickJS, never a JSON envelope.  The ring remains
            // owner-thread serialized, so this closure must not be moved to a
            // worker or retained after the host is destroyed.
            let duplex_emit_ring = duplex.claim_egress_producer().ok_or_else(|| {
                Exception::throw_type(&ctx, "duplex egress producer is already claimed")
            })?;
            let duplex_emit = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>,
                      msg_type: f64,
                      flags: f64,
                      target_id: f64,
                      arg0: f64,
                      arg1: f64| {
                    let msg_type = checked_duplex_u16(msg_type).ok_or_else(|| {
                        Exception::throw_type(&ctx, "duplex msgType must be a uint16")
                    })?;
                    let flags = checked_duplex_u16(flags).ok_or_else(|| {
                        Exception::throw_type(&ctx, "duplex flags must be a uint16")
                    })?;
                    let target_id = checked_duplex_u32(target_id).ok_or_else(|| {
                        Exception::throw_type(&ctx, "duplex targetId must be a uint32")
                    })?;
                    if !arg0.is_finite()
                        || !arg1.is_finite()
                        || arg0.abs() > f32::MAX as f64
                        || arg1.abs() > f32::MAX as f64
                    {
                        return Err(Exception::throw_type(
                            &ctx,
                            "duplex arguments must be finite float32 values",
                        ));
                    }
                    Ok::<bool, rquickjs::Error>(duplex_emit_ring.push(duplex::DuplexMessage {
                        msg_type,
                        flags,
                        target_id,
                        arg0: arg0 as f32,
                        arg1: arg1 as f32,
                    }))
                },
            )?;
            let duplex_bridge = Object::new(ctx.clone())?;
            duplex_bridge.set("emit", duplex_emit)?;
            bridge.set("duplex", duplex_bridge)?;

            let register_nodes = nodes.clone();
            let register = Function::new(
                ctx.clone(),
                move |_ctx: Ctx<'_>, id: i32, kind: String, payload: Value<'_>| {
                    let mut registry = register_nodes.borrow_mut();
                    let list = registry.write();
                    list.retain(|node| node.id != id);
                    let mut meta = NodeMeta {
                        id,
                        kind,
                        asset: String::new(),
                        surface_kind: String::new(),
                        surface_parameters: Vec::new(),
                        video_id: String::new(),
                        fit: "cover".to_owned(),
                        autoplay: true,
                        texture: -1,
                        surface: -1,
                        from_pack: false,
                    };
                    if let Some(extra) = payload.as_object() {
                        meta.asset = js_string_property(&extra, "asset").unwrap_or_default();
                        meta.video_id = js_string_property(&extra, "videoId").unwrap_or_default();
                        meta.fit =
                            normalize_video_fit(js_string_property(&extra, "fit").as_deref());
                        meta.autoplay = js_bool_property(&extra, "autoplay").unwrap_or(true);
                        meta.texture = js_i32_property(&extra, "texture").unwrap_or(-1);
                        meta.surface = js_i32_property(&extra, "surface").unwrap_or(-1);
                    } else if let Some(js_string) = payload.as_string() {
                        if let Ok(payload) = js_string.to_string() {
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
                                meta.fit =
                                    normalize_video_fit(extra.get("fit").and_then(|v| v.as_str()));
                                meta.autoplay = extra
                                    .get("autoplay")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(true);
                                meta.texture =
                                    extra.get("texture").and_then(|v| v.as_i64()).unwrap_or(-1)
                                        as i32;
                                meta.surface =
                                    extra.get("surface").and_then(|v| v.as_i64()).unwrap_or(-1)
                                        as i32;
                            }
                        }
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
                move |ctx: Ctx<'_>, package: String, kind: String, payload: Value<'_>| {
                    if package.is_empty()
                        || package.len() > 160
                        || !matches!(kind.as_str(), "glass" | "platformTexture" | "video")
                    {
                        return Err(Exception::throw_type(&ctx, "invalid compositor provider"));
                    }
                    let is_video = kind == "video";
                    let (parameters, video_asset, fit, autoplay) = if let Some(object) =
                        payload.as_object()
                    {
                        let parameters = binary_bridge::encode_js_message(
                            payload.clone(),
                            8192,
                            MAX_BRIDGE_BATCH_EVENTS,
                        )
                        .map_err(|_| Exception::throw_type(&ctx, "invalid surface parameters"))?;
                        let video_asset = js_string_property(&object, "asset");
                        let fit =
                            normalize_video_fit(js_string_property(&object, "fit").as_deref());
                        let autoplay = js_bool_property(&object, "autoplay").unwrap_or(true);
                        (parameters, video_asset, fit, autoplay)
                    } else if let Some(js_string) = payload.as_string() {
                        let text = js_string.to_string().map_err(|_| {
                            Exception::throw_type(&ctx, "invalid surface parameters")
                        })?;
                        if text.len() > 8192 {
                            return Err(Exception::throw_type(&ctx, "invalid surface parameters"));
                        }
                        let data: serde_json::Value =
                            serde_json::from_str(&text).map_err(|_| {
                                Exception::throw_type(&ctx, "invalid surface parameters")
                            })?;
                        if !data.is_object() {
                            return Err(Exception::throw_type(
                                &ctx,
                                "surface parameters must be an object",
                            ));
                        }
                        let parameters = binary_bridge::encode_json_to_binary(&data, 8192)
                            .map_err(|_| {
                                Exception::throw_type(&ctx, "invalid surface parameters")
                            })?;
                        let video_asset = data
                            .get("asset")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned);
                        let fit =
                            normalize_video_fit(data.get("fit").and_then(|value| value.as_str()));
                        let autoplay = data
                            .get("autoplay")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(true);
                        (parameters, video_asset, fit, autoplay)
                    } else {
                        return Err(Exception::throw_type(
                            &ctx,
                            "surface parameters must be an object",
                        ));
                    };
                    if is_video && video_asset.as_deref().map_or(true, str::is_empty) {
                        return Err(Exception::throw_type(
                            &ctx,
                            "video surface parameters require a non-empty asset",
                        ));
                    }
                    let mut registry = surface_nodes.borrow_mut();
                    if registry.iter().any(|n| {
                        n.kind == "hostSurface" && n.video_id == package && n.surface < 100
                    }) {
                        return Err(rquickjs::Error::new_from_js_message(
                            "surface",
                            "provider",
                            "application surface is host-owned",
                        ));
                    }
                    let existing = registry.iter().position(|n| {
                        (n.kind == "hostSurface" || n.kind == "video") && n.video_id == package
                    });
                    let handle = if let Some(index) = existing {
                        registry[index].surface
                    } else {
                        if registry
                            .iter()
                            .filter(|n| n.kind == "hostSurface" || n.kind == "video")
                            .count()
                            >= 64
                        {
                            return Err(Exception::throw_type(&ctx, "surface limit exceeded"));
                        }
                        let mut next = next_surface.borrow_mut();
                        let handle = *next;
                        *next = next.checked_add(1).ok_or_else(|| {
                            Exception::throw_type(&ctx, "surface handles exhausted")
                        })?;
                        handle
                    };
                    let (node_kind, asset, fit) = if is_video {
                        (
                            "video".to_owned(),
                            video_asset.expect("validated video asset").to_owned(),
                            fit,
                        )
                    } else {
                        ("hostSurface".to_owned(), String::new(), "fill".to_owned())
                    };
                    let meta = NodeMeta {
                        id: -handle,
                        kind: node_kind,
                        asset,
                        surface_kind: if is_video {
                            String::new()
                        } else {
                            kind.clone()
                        },
                        surface_parameters: if is_video { Vec::new() } else { parameters },
                        video_id: package.clone(),
                        fit,
                        autoplay,
                        texture: -1,
                        surface: handle,
                        from_pack: false,
                    };
                    let list = registry.write();
                    if let Some(index) = existing {
                        list[index] = meta;
                    } else {
                        list.push(meta);
                    }
                    drop(registry);
                    let ui: Object = ctx.globals().get("ui")?;
                    let surfaces: Object = ui.get("__surfaces")?;
                    surfaces.set(package, handle)?;
                    Ok(handle)
                },
            )?;
            bridge.set("registerSurface", register_surface)?;
            let release_nodes = nodes.clone();
            bridge.set(
                "releaseSurface",
                Function::new(ctx.clone(), move |ctx: Ctx<'_>, package: String| {
                    if release_nodes.borrow().iter().any(|n| {
                        n.kind == "hostSurface" && n.video_id == package && n.surface < 100
                    }) {
                        return Err(rquickjs::Error::new_from_js_message(
                            "surface",
                            "provider",
                            "application surface is host-owned",
                        ));
                    }
                    release_nodes.borrow_mut().write().retain(|n| {
                        !((n.kind == "hostSurface" || n.kind == "video") && n.video_id == package)
                    });
                    let ui: Object = ctx.globals().get("ui")?;
                    let surfaces: Object = ui.get("__surfaces")?;
                    surfaces.remove(package)?;
                    Ok::<(), rquickjs::Error>(())
                })?,
            )?;

            // Host extension, deliberately kept outside canonical `ui.*`:
            // Flutter overlays need the committed logical rectangle of a
            // retained node, while PocketJS's public UI contract exposes no
            // layout read-back operation. Return null for stale/detached
            // generation-tagged ids and a named object for live nodes.
            let layout_ops = ops.clone();
            let get_layout =
                Function::new(ctx.clone(), move |ctx, id| js_layout(ctx, &layout_ops, id))?;
            bridge.set("getLayout", get_layout)?;
            let get_layouts = Function::new(ctx.clone(), LayoutsFunction { ops: ops.clone() })?;
            bridge.set("getLayouts", get_layouts)?;
            globals.set("pocket", bridge)?;
            if let Some(provider) = offload.clone() {
                offload::OffloadHost::install(ctx.clone(), provider, None)?;
            } else {
                offload::OffloadHost::install_disconnected(ctx.clone())?;
            }

            // Date.now/Math.random/performance.now tracing is an explicit
            // record/replay debug lane. Live mode leaves every global intact;
            // the Date constructor itself is never replaced.
            replay::install_scalar_hooks(&ctx, trace_mode, trace_lane)?;

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
            if host_fonts {
                ui.set("__hostFonts", true)?;
            }
            install_compositor_apps(&ctx, &nodes, compositor_surfaces)?;
            if let Some((root, width, height)) = auxiliary {
                let descriptor = Object::new(ctx.clone())?;
                descriptor.set("root", root)?;
                descriptor.set("w", width)?;
                descriptor.set("h", height)?;
                ui.set("__auxiliarySurface", descriptor)?;
            }
            let security_snapshot = security.borrow().clone();
            if let Some(max_nodes) = security_snapshot.max_nodes {
                guest_security::install_node_quota(&ctx, ops.clone(), security.clone(), max_nodes)?;
            }
            if security_snapshot.harden_builtins {
                guest_security::install_hardening(&ctx)?;
            }
            Ok::<(), rquickjs::Error>(())
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
        .map_err(|error| error.to_string())
}

/// Extend only the trusted registry. Reinstalling the bridge would claim its
/// single-producer duplex endpoint twice and recreate retained provider state.
fn install_compositor_apps(
    ctx: &Ctx<'_>,
    nodes: &Rc<RefCell<NodeRegistry>>,
    applications: &BTreeMap<String, i32>,
) -> rquickjs::Result<()> {
    let ui: Object = ctx.globals().get("ui")?;
    let surfaces: Object = ui.get("__surfaces")?;
    for (app_id, handle) in applications {
        surfaces.set(app_id.as_str(), *handle)?;
        let mut registry = nodes.borrow_mut();
        let list = registry.write();
        list.retain(|node| !(node.kind == "hostSurface" && node.surface == *handle));
        list.push(NodeMeta {
            id: -*handle,
            kind: "hostSurface".into(),
            asset: String::new(),
            surface_kind: "application".into(),
            surface_parameters: binary_bridge::encode_json_to_binary(
                &serde_json::json!({"appId": app_id}),
                8192,
            )
            .unwrap_or_else(|_| vec![binary_bridge::BINARY_MESSAGE_MAGIC, 0]),
            video_id: app_id.clone(),
            fit: "fill".into(),
            autoplay: true,
            texture: -1,
            surface: *handle,
            from_pack: false,
        });
    }
    Ok(())
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
) -> Result<GuestEnvironment<'a>, String> {
    let auxiliary_viewport = host
        .auxiliary_viewport
        .map(|(width, height)| [width as u32, height as u32]);
    Ok(GuestEnvironment {
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
        heap_limit: guest_heap_limit(host, pak.len())?,
        pak,
        assets,
    })
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

fn is_js_handler_binary_capable(function: &Function<'_>) -> bool {
    function
        .as_object()
        .and_then(|obj| obj.get::<_, bool>("__binaryCapable").ok())
        .unwrap_or(false)
}

fn dispatch_guest_json(
    guest: &RquickjsGuest,
    function_name: &str,
    json_val: &serde_json::Value,
    fallback_line: Option<&str>,
) -> Result<(), String> {
    guest
        .with_turn(|ctx| -> Result<(), String> {
            let value: Value = ctx
                .globals()
                .get(function_name)
                .map_err(|error| quickjs_error(&ctx, error))?;
            if value.is_undefined() {
                return Ok(());
            }
            let function =
                Function::from_js(&ctx, value).map_err(|error| quickjs_error(&ctx, error))?;
            if is_js_handler_binary_capable(&function) {
                let js_packet = binary_bridge::json_to_js(&ctx, json_val)?;
                function
                    .call::<_, ()>((js_packet,))
                    .map_err(|error| quickjs_error(&ctx, error))
            } else if let Some(line) = fallback_line {
                // Only pocket_send's explicit diagnostic record uses text.
                function
                    .call::<_, ()>((line.to_owned(),))
                    .map_err(|error| quickjs_error(&ctx, error))
            } else {
                Err(format!(
                    "Pocket direct-object guest ABI unavailable: {function_name}.__binaryCapable is required; rebuild the guest"
                ))
            }
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

fn dispatch_guest_binary(
    guest: &RquickjsGuest,
    function_name: &str,
    binary_bytes: &[u8],
) -> Result<(), String> {
    guest
        .with_turn(|ctx| -> Result<(), String> {
            let value: Value = ctx
                .globals()
                .get(function_name)
                .map_err(|error| quickjs_error(&ctx, error))?;
            if value.is_undefined() {
                return Ok(());
            }
            let function =
                Function::from_js(&ctx, value).map_err(|error| quickjs_error(&ctx, error))?;
            if !is_js_handler_binary_capable(&function) {
                return Err(format!(
                    "Pocket direct-object guest ABI unavailable: {function_name}.__binaryCapable is required; rebuild the guest"
                ));
            }
            let js_packet = binary_bridge::decode_to_js(&ctx, binary_bytes)?;
            function
                .call::<_, ()>((js_packet,))
                .map_err(|error| quickjs_error(&ctx, error))
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

/// Invoke the optional JS duplex consumer with scalar arguments.  Returning
/// `false` means the guest has not installed a consumer yet; in that case the
/// ingress cursor is intentionally left untouched so a later frame can attach
/// the handler without losing host messages.
fn dispatch_duplex_event(
    guest: &RquickjsGuest,
    message: duplex::DuplexMessage,
) -> Result<bool, String> {
    guest
        .with_turn(|ctx| -> Result<bool, String> {
            let value: Value = ctx
                .globals()
                .get("__pocketDuplexEvent")
                .map_err(|error| quickjs_error(&ctx, error))?;
            if value.is_undefined() || value.is_null() {
                return Ok(false);
            }
            let function =
                Function::from_js(&ctx, value).map_err(|error| quickjs_error(&ctx, error))?;
            function
                .call::<_, ()>((
                    message.msg_type as u32,
                    message.flags as u32,
                    message.target_id,
                    message.arg0,
                    message.arg1,
                ))
                .map_err(|error| quickjs_error(&ctx, error))?;
            Ok(true)
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

fn dispatch_duplex_pointer_guest(
    guest: &RquickjsGuest,
    phase: &str,
    id: u8,
    x: f64,
    y: f64,
    surface: u8,
) -> Result<(), String> {
    guest
        .with_turn(|ctx| -> Result<(), String> {
            let value: Value = ctx
                .globals()
                .get("__pocketEvent")
                .map_err(|error| quickjs_error(&ctx, error))?;
            if value.is_undefined() || value.is_null() {
                return Ok(());
            }
            let function =
                Function::from_js(&ctx, value).map_err(|error| quickjs_error(&ctx, error))?;
            if !is_js_handler_binary_capable(&function) {
                return Err(
                    "Pocket direct-object guest ABI unavailable: __pocketEvent.__binaryCapable is required; rebuild the guest".to_owned(),
                );
            }
            let payload = Object::new(ctx.clone()).map_err(|error| quickjs_error(&ctx, error))?;
            payload
                .set("phase", phase)
                .map_err(|error| quickjs_error(&ctx, error))?;
            payload
                .set("id", id as u32)
                .map_err(|error| quickjs_error(&ctx, error))?;
            payload
                .set("x", x)
                .map_err(|error| quickjs_error(&ctx, error))?;
            payload
                .set("y", y)
                .map_err(|error| quickjs_error(&ctx, error))?;
            if surface == 1 {
                payload
                    .set("surface", 1_u32)
                    .map_err(|error| quickjs_error(&ctx, error))?;
            }
            let input = Object::new(ctx.clone()).map_err(|error| quickjs_error(&ctx, error))?;
            input
                .set("type", "event")
                .map_err(|error| quickjs_error(&ctx, error))?;
            input
                .set("name", "input.pointer")
                .map_err(|error| quickjs_error(&ctx, error))?;
            input
                .set("payload", payload)
                .map_err(|error| quickjs_error(&ctx, error))?;
            function
                .call::<_, ()>((input.into_value(),))
                .map_err(|error| quickjs_error(&ctx, error))
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

/// Translate the reserved numeric pointer message into the exact canonical
/// `input.pointer` path used by binary callers. The conversion is confined to
/// the native owner thread: it queues the hit-tested touch snapshot and then
/// delivers a direct `__pocketEvent` object to the guest, so a JS app does not
/// need a second pointer protocol just because the host selected the
/// lock-free transport.
fn dispatch_duplex_pointer(
    host: &mut HostState,
    message: duplex::DuplexMessage,
) -> Result<(), String> {
    const POINTER_MESSAGE_TYPE: u16 = 1;
    const POINTER_PHASE_MASK: u16 = 0x00ff;
    const POINTER_AUXILIARY_FLAG: u16 = 0x0100;
    if message.msg_type != POINTER_MESSAGE_TYPE {
        return Err("not a pointer duplex message".to_owned());
    }
    let phase = match message.flags & POINTER_PHASE_MASK {
        1 => "down",
        2 => "move",
        3 => "up",
        4 => "cancel",
        value => return Err(format!("duplex pointer phase {value} is invalid")),
    };
    if message.flags & !(POINTER_PHASE_MASK | POINTER_AUXILIARY_FLAG) != 0 {
        return Err("duplex pointer flags contain unknown bits".to_owned());
    }
    let id = u8::try_from(message.target_id)
        .map_err(|_| "input.pointer payload.id must be an integer in [0,255]".to_owned())?;
    let surface = if message.flags & POINTER_AUXILIARY_FLAG != 0 {
        1
    } else {
        0
    };
    queue_pointer_fields(
        host,
        phase,
        id,
        message.arg0 as f64,
        message.arg1 as f64,
        surface,
    )?;
    dispatch_duplex_pointer_guest(
        &host.guest,
        phase,
        id,
        message.arg0 as f64,
        message.arg1 as f64,
        surface,
    )
}

/// Drain host-written records on the native owner thread and dispatch them to
/// the current QuickJS guest. The cursor is committed only after JS accepts a
/// record, making an unset/failed handler observable rather than silently
/// dropping input. Generic duplex records remain scalar-only; the reserved
/// pointer record is adapted to the canonical `__pocketEvent` object path.
/// A stale guest without the direct-object ABI fails without consuming the
/// record; canonical input never falls back to JSON text.
fn drain_duplex(host: &mut HostState) -> Result<i32, String> {
    let mut processed = 0_i32;
    loop {
        let Some(message) = host.duplex_ingress_consumer.peek() else {
            break;
        };
        if message.msg_type == 1 && (1..=4).contains(&(message.flags & 0x00ff)) {
            dispatch_duplex_pointer(host, message)?;
        } else if !dispatch_duplex_event(&host.guest, message)? {
            break;
        }
        if !host.duplex_ingress_consumer.consume_one() {
            return Err("duplex ingress cursor changed while dispatching".to_owned());
        }
        processed = processed.saturating_add(1);
    }
    Ok(processed)
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
        .with_turn(|ctx| -> Result<(), String> {
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
    // Preserve the established 9-bit and 10-bit packed forms. Coordinates
    // above the packed range use an explicit sidecar marker; the exact u32
    // coordinates are appended to the QuickJS frame call.
    if contact.x > TOUCH_COORD_MASK || contact.y > TOUCH_COORD_MASK {
        return TOUCH_WIDE_MARKER
            | TOUCH_COORDINATE_SIDECAR_MARKER
            | ((contact.id as u32) << TOUCH_WIDE_ID_SHIFT);
    }
    let wide = contact.x > 511 || contact.y > 511;
    if wide {
        TOUCH_WIDE_MARKER
            | ((contact.id as u32) << TOUCH_WIDE_ID_SHIFT)
            | ((contact.y & TOUCH_COORD_MASK) << 10)
            | (contact.x & TOUCH_COORD_MASK)
    } else {
        ((contact.id as u32) << TOUCH_LEGACY_ID_SHIFT)
            | ((contact.y & 0x1ff) << 9)
            | (contact.x & 0x1ff)
    }
}

fn pack_touch_cancel(contact: TouchContact) -> u32 {
    if contact.x > TOUCH_COORD_MASK || contact.y > TOUCH_COORD_MASK {
        TOUCH_CANCEL_MARKER
            | TOUCH_WIDE_MARKER
            | TOUCH_COORDINATE_SIDECAR_MARKER
            | ((contact.id as u32) << TOUCH_WIDE_ID_SHIFT)
    } else {
        TOUCH_CANCEL_MARKER | ((contact.id as u32) << TOUCH_LEGACY_ID_SHIFT)
    }
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

/// Queue a pointer edge after its transport-specific envelope has been
/// decoded. Keeping this path scalar lets the duplex ring avoid constructing
/// a serde value while preserving the JSON input.pointer validation and touch
/// snapshot semantics exactly.
fn queue_pointer_fields(
    host: &mut HostState,
    phase: &str,
    id: u8,
    x_value: f64,
    y_value: f64,
    surface: u8,
) -> Result<(), String> {
    if surface == 1 && host.auxiliary_viewport.is_none() {
        return Err("input.pointer auxiliary surface is not enabled".to_owned());
    }
    if surface > 1 {
        return Err("input.pointer payload.surface must be primary/auxiliary or 0/1".to_owned());
    }
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
        || x > u32::MAX as f64
        || y > u32::MAX as f64
        || x > surface_width as f64
        || y > surface_height as f64
    {
        return Err(format!(
            "input.pointer coordinates ({x_value},{y_value}) exceed the logical viewport or u32 coordinate sidecar range"
        ));
    }
    let x = x as u32;
    let y = y as u32;

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
    queue_pointer_fields(host, phase, id, x_value, y_value, surface)
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
    let previous = (host.buttons, host.analog, host.right_analog);
    host.buttons = buttons;
    if let Some(analog) = value.get("analog") {
        host.analog = input_u32(Some(analog), "input.buttons.analog")?;
    }
    if let Some(right_analog) = value.get("rightAnalog") {
        host.right_analog = input_u32(Some(right_analog), "input.buttons.rightAnalog")?;
    }
    // Buttons/axes are sampled by the next GuestFrame.  Keep the existing
    // event-driven wake marker so a zero-delta host boundary still delivers
    // both a non-neutral sample and the later return-to-center sample.
    if (host.buttons, host.analog, host.right_analog) != previous {
        host.external_work_pending = true;
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
    let previous = (host.analog, host.right_analog);
    host.analog = (packed[0] << 8) | packed[1];
    host.right_analog = (packed[2] << 8) | packed[3];
    if (host.analog, host.right_analog) != previous {
        host.external_work_pending = true;
    }
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

// Independent raw text lane for terminal/editor-style guests using
// onTextEvent. Flutter TextField's textInput.edit remains the sole IME lane
// for framework TextInput, so those edits must not also enter this queue.
fn queue_text(host: &mut HostState, message: &serde_json::Value) -> Result<(), String> {
    let value = input_value(message);
    let values: Vec<&serde_json::Value> = match value.as_array() {
        Some(events) => events.iter().collect(),
        None => vec![value],
    };
    if host.pending_text.len() + values.len() > 64 {
        return Err("input.text queue exceeds 64 events".into());
    }
    let mut admitted = Vec::with_capacity(values.len());
    for value in values {
        let string = |field: &str, limit: usize| -> Result<String, String> {
            let text = value
                .get(field)
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("input.text.{field} must be a string"))?;
            if text.len() > limit {
                return Err(format!("input.text.{field} is too long"));
            }
            Ok(text.to_owned())
        };
        let kind = value
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or("input.text.kind must be a string")?;
        admitted.push(match kind {
            "keyDown" | "keyUp" => TextEvent::Key {
                key: string("key", 128)?,
                pressed: kind == "keyDown",
                repeat: value
                    .get("repeat")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            },
            "commit" => TextEvent::Commit(string("text", 4096)?),
            "composition" => {
                let text = string("text", 4096)?;
                let length = text.encode_utf16().count() as u64;
                let start = value
                    .get("selectionStart")
                    .and_then(|v| v.as_u64())
                    .ok_or("input.text.selectionStart must be an integer")?;
                let end = value
                    .get("selectionEnd")
                    .and_then(|v| v.as_u64())
                    .ok_or("input.text.selectionEnd must be an integer")?;
                if start > end || end > length {
                    return Err("input.text selection outside UTF-16 text".into());
                }
                TextEvent::Composition {
                    text,
                    selection_start: start as u32,
                    selection_end: end as u32,
                }
            }
            "compositionEnd" => TextEvent::CompositionEnd,
            _ => return Err("unknown input.text kind".into()),
        });
    }
    host.pending_text.extend(admitted);
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
        "input.text" => queue_text(host, message),
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
        touches.push(pack_touch_cancel(*contact));
        hits.push(0);
        touch_surfaces.push(contact.surface);
    }
    if let Some(worker) = &host.worker_runtime {
        if let Some(error) = worker.last_error() {
            return Err(format!("worker: {error}"));
        }
    }
    if let Some(bridge) = &mut host.worker_bridge {
        bridge.latch().map_err(|e| e.to_string())?;
    }
    host.external_work_pending = false;
    let text = std::mem::take(&mut host.pending_text);
    let frame = GuestFrame {
        buttons: host.buttons,
        analog: host.analog,
        touches: &touches,
        hits: &hits,
        touch_surfaces: &touch_surfaces,
        right_analog: host.right_analog,
        axis_deltas: &host.axis_deltas,
        motion: host.motion.as_ref(),
        text: &text,
    };
    let requires_coordinate_sidecar = active
        .iter()
        .chain(cancelled)
        .any(|contact| contact.x > TOUCH_COORD_MASK || contact.y > TOUCH_COORD_MASK);
    let result = if requires_coordinate_sidecar {
        let touch_coordinates = active
            .iter()
            .chain(cancelled)
            .map(|contact| (contact.x, contact.y))
            .collect::<Vec<_>>();
        host.guest
            .frame_with_touch_coordinates(&frame, &touch_coordinates)
    } else {
        host.guest.frame(&frame)
    };
    result.map_err(|error| {
        host.guest
            .last_error()
            .map(|detail| format!("{error:?}: {detail}"))
            .unwrap_or_else(|| format!("{error:?}"))
    })?;
    if let Some(bridge) = &mut host.worker_bridge {
        bridge.mark_frame_consumed();
    }
    Ok(())
}

#[cfg(test)]
fn decode_draw_ops(
    words: &[u32],
    width: f32,
    height: f32,
    nodes: &[NodeMeta],
    ui: &mut Ui,
    generic_texture_handles: &mut HashSet<i32>,
) -> Result<Vec<FrameOp>, String> {
    decode_draw_ops_with_metrics(words, width, height, nodes, ui, generic_texture_handles, None)
}

fn decode_draw_ops_with_metrics(
    words: &[u32],
    width: f32,
    height: f32,
    nodes: &[NodeMeta],
    ui: &mut Ui,
    generic_texture_handles: &mut HashSet<i32>,
    text_metrics: Option<&TextMetrics>,
) -> Result<Vec<FrameOp>, String> {
    let viewport = DamageRect::new(0, 0, width as i32, height as i32);
    let mut ops = Vec::with_capacity(words.len() / 8);
    let mut texture_cache = TextureDecodeCache::default();
    for item in DrawOps::new(words, viewport) {
        let operation = item.map_err(|error| format!("draw list decode: {error:?}"))?;
        append_draw_operation_cached(
            &mut ops,
            &operation,
            nodes,
            ui,
            generic_texture_handles,
            Some(&mut texture_cache),
            text_metrics,
        )?;
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

    if first_guest_turn
        && remaining_ticks == 0
        && (!host.pending_text.is_empty()
            || host.external_work_pending
            || !host.axis_deltas.is_empty()
            || host.motion.is_some()
            || host
                .offload
                .as_ref()
                .is_some_and(|offload| offload.has_replies()))
    {
        let active = host.touches.clone();
        run_guest_touch_frame(host, &active, &[])?;
        host.axis_deltas.clear();
        host.motion = None;
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

fn build_frame(
    host: &mut HostState,
    delta_ms: f64,
    allow_unchanged: bool,
    force_full_resources: bool,
) -> Result<BuiltFrame, String> {
    let sampling = PERF_SAMPLING_ENABLED.load(Ordering::Relaxed);
    if sampling {
        host.last_stage_timings = NativeFrameStageTimingsUs {
            live2d_update_us: LIVE2D_UPDATE_NANOS.swap(0, Ordering::Relaxed) / 1000,
            ..NativeFrameStageTimingsUs::default()
        };
    }
    ensure_guest_security_healthy(host)?;
    // Advance known quiescent time before delivering this boundary's input.
    // A virtual timer's due frame still runs the ordinary guest transaction.
    let tick_count = demand::ticks_for_delta(host, delta_ms)?;
    // Service the binary host -> guest channel before any guest/core tick.
    // The standalone FFI step calls this same helper, so callers may either
    // explicitly pump input or rely on the ordinary frame boundary.
    drain_duplex(host)?;
    // A host may deliver several pointer edges between vblanks.  Feed the
    // retained guest one complete snapshot per queued edge so its official
    // gesture pump can observe DOWN followed by UP (or CANCEL).  When there
    // are no edges, preserve the ordinary held-contact frame semantics.
    let pending = std::mem::take(&mut host.pending_touch_frames);
    let t_js = sampling.then(Instant::now);
    let guest_result = run_virtual_frames(host, pending, tick_count);
    if let Some(t) = t_js {
        host.last_stage_timings.js_tick_us = t.elapsed().as_micros() as u64;
    }
    guest_result?;
    // Node-quota failures are intentionally sticky even when guest code
    // catches the JS exception. Do not decode or publish a partial frame.
    ensure_guest_security_healthy(host)?;
    let (cache_hit, (width, height), auxiliary_size, raster_revision, words, auxiliary_words) = {
        let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
        let t_relayout = sampling.then(Instant::now);
        core.ui.relayout_outputs();
        if let Some(t) = t_relayout {
            host.last_stage_timings.relayout_us = t.elapsed().as_micros() as u64;
        }
        let auxiliary_size = core.ui.auxiliary_viewport();
        let (width, height) = core.ui.viewport();
        let raster_revision = core.ui.raster_revision();
        let nodes_revision = host.nodes.borrow().revision();
        let t_emit = sampling.then(Instant::now);
        let primary_hit = {
            let draw = core.ui.draw();
            host.draw_cache.as_ref().is_some_and(|cache| {
                cache.matches_primary(
                    &draw.words,
                    width,
                    height,
                    auxiliary_size,
                    raster_revision,
                    nodes_revision,
                )
            })
        };
        let auxiliary = if auxiliary_size.is_some() {
            core.ui.draw_auxiliary()
        } else {
            None
        };
        let hit = primary_hit
            && host.draw_cache.as_ref().is_some_and(|cache| {
                cache.matches_auxiliary(auxiliary.map(|draw| draw.words.as_slice()))
            });
        // The official draw API returns a retained list. Build each output
        // once, and only own its words when decoding a changed snapshot.
        // current_* accessors do not traverse the tree or allocate on a hit.
        let (words, auxiliary_words) = if hit {
            (Vec::new(), None)
        } else {
            (
                core.ui.current_draw_list().words.clone(),
                core.ui
                    .current_auxiliary_draw_list()
                    .map(|draw| draw.words.clone()),
            )
        };
        if let Some(t) = t_emit {
            host.last_stage_timings.live2d_emit_us = t.elapsed().as_micros() as u64;
        }
        (
            hit,
            (width, height),
            auxiliary_size,
            raster_revision,
            words,
            auxiliary_words,
        )
    };

    // Consume the actual PocketJS DrawList. Unsupported operations are
    // surfaced as development diagnostics instead of inventing boxes. Every
    // decoded DrawList operation is forwarded as-is (with its original
    // geometry/UV/tint). Core-generated rounded/shadow masks are ordinary
    // live TEX_QUAD resources, so no host-side RRect reconstruction is needed.
    let decoded = if cache_hit {
        None
    } else {
        // A changed DrawList means any static JSON captured for the previous
        // visual state is stale. It must not be reused merely because this
        // frame happens to emit no bridge events.
        host.frame_json_cache = None;
        host.draw_decode_count = host.draw_decode_count.wrapping_add(1);
        let nodes_revision = host.nodes.borrow().revision();
        let (ops, auxiliary, generic_texture_handles) = {
            // GLYPH_RUN page preparation allocates shared core textures, so
            // both primary and auxiliary DrawLists decode through one mutable
            // Ui borrow and one deduplicated generic-resource set.
            let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
            let nodes = host.nodes.borrow();
            let text_metrics = host.text_metrics.borrow();
            let mut generic_texture_handles = HashSet::new();
            let t_decode = sampling.then(Instant::now);
            let ops = Rc::new(decode_draw_ops_with_metrics(
                &words,
                width,
                height,
                &nodes,
                &mut core.ui,
                &mut generic_texture_handles,
                Some(&text_metrics),
            )?);
            let auxiliary = match (auxiliary_size, auxiliary_words.as_deref()) {
                (Some((auxiliary_width, auxiliary_height)), Some(auxiliary_words)) => {
                    Some(SurfaceFrame {
                        width: auxiliary_width,
                        height: auxiliary_height,
                        ops: Rc::new(decode_draw_ops_with_metrics(
                            auxiliary_words,
                            auxiliary_width,
                            auxiliary_height,
                            &nodes,
                            &mut core.ui,
                            &mut generic_texture_handles,
                            Some(&text_metrics),
                        )?),
                    })
                }
                (Some(_), None) => return Err("auxiliary draw list was not produced".to_owned()),
                (None, Some(_)) => return Err("auxiliary draw list has no viewport".to_owned()),
                (None, None) => None,
            };
            if let Some(t) = t_decode {
                host.last_stage_timings.draw_decode_us = t.elapsed().as_micros() as u64;
            }
            let generic_texture_handles =
                Rc::new(generic_texture_handles.into_iter().collect::<Vec<_>>());
            (ops, auxiliary, generic_texture_handles)
        };
        host.draw_cache = Some(FrameDrawCache {
            words,
            auxiliary_words,
            width,
            height,
            auxiliary_size,
            raster_revision,
            nodes_revision,
            ops: Rc::clone(&ops),
            auxiliary: auxiliary.clone(),
            generic_texture_handles: Rc::clone(&generic_texture_handles),
        });
        Some((ops, auxiliary, generic_texture_handles))
    };

    // Borrow retained DrawOps for resource bookkeeping. Delta callers only
    // need owned operations when a draw/resource/event actually changed.
    let (ops, auxiliary, generic_texture_handles) = match decoded.as_ref() {
        Some((ops, auxiliary, textures)) => (ops.as_slice(), auxiliary, textures.as_slice()),
        None => {
            let cache = host
                .draw_cache
                .as_ref()
                .expect("draw cache hit must have a cache");
            (
                cache.ops.as_slice(),
                &cache.auxiliary,
                cache.generic_texture_handles.as_slice(),
            )
        }
    };

    let max_draw_ops = { host.guest_security.borrow().max_draw_ops };
    if let Some(max_draw_ops) = max_draw_ops {
        let count = ops.len() + auxiliary.as_ref().map_or(0, |frame| frame.ops.len());
        if count > max_draw_ops as usize {
            guest_security::set_fatal(
                &host.guest_security,
                format!("guest draw operation quota exceeded ({max_draw_ops})"),
            );
            return Err(format!(
                "guest draw operation quota exceeded ({max_draw_ops})"
            ));
        }
    }

    let referenced_assets = {
        let mut assets = referenced_image_assets(&ops);
        if let Some(auxiliary) = auxiliary.as_ref() {
            assets.extend(referenced_image_assets(&auxiliary.ops));
        }
        assets
    };
    // A full resync cannot rely on `sent_resources`: that ledger is advanced
    // while building every frame, including a frame the caller may later
    // discard after a decode error.  Keep the one caller-confirmed snapshot
    // separate and use it only to recover release records on a forced full.
    let confirmed_resources = if force_full_resources {
        Some(host.frame_delta_v2_resource_base.clone())
    } else {
        None
    };
    let core = host.ops.core().map_err(|error| format!("{error:?}"))?;
    let mut released_resources = host
        .sent_resources
        .iter()
        .filter_map(|(asset, sent)| {
            let texture_released = core.ui.texture(sent.texture).is_none();
            let no_longer_referenced = !referenced_assets.contains(asset);
            (texture_released || no_longer_referenced).then(|| asset.clone())
        })
        .collect::<Vec<_>>();
    if let Some(confirmed_resources) = confirmed_resources.as_ref() {
        released_resources.extend(
            confirmed_resources
                .keys()
                .filter(|asset| !referenced_assets.contains(*asset))
                .cloned(),
        );
    }
    // HashMap iteration is intentionally randomized.  Resource lifecycle
    // facts are a transport list, not draw order, so publish them in a
    // stable asset order for deterministic frame/replay summaries.
    released_resources.sort();
    released_resources.dedup();
    for asset in &released_resources {
        host.sent_resources.remove(asset);
    }
    let mut resources = Vec::new();
    let mut emitted_resources = HashSet::new();
    let nodes_borrow = host.nodes.borrow();
    for node in nodes_borrow.iter() {
        if !node.from_pack || node.asset.is_empty() || !referenced_assets.contains(&node.asset) {
            continue;
        }
        if !emitted_resources.insert(node.asset.clone()) {
            continue;
        }
        let revision = core.ui.texture_revision(node.texture).ok_or_else(|| {
            format!(
                "PAK image {} has stale texture handle {}",
                node.asset, node.texture
            )
        })?;
        let current = SentResource {
            texture: node.texture,
            revision,
        };
        let previous = host.sent_resources.get(&node.asset).copied();
        let confirmed = confirmed_resources
            .as_ref()
            .and_then(|resources| resources.get(&node.asset).copied());
        let expected = if force_full_resources {
            // A v2-confirmed snapshot is authoritative when present. Before
            // the first v2 echo (for example after a legacy full ABI call),
            // the sent ledger is the only conservative indication that the
            // receiver may already hold this asset. Releasing a possibly
            // absent asset is harmless and prevents same-key stale pixels.
            confirmed.or(previous)
        } else {
            previous
        };
        if !force_full_resources && previous == Some(current) {
            continue;
        }
        if expected.is_some_and(|sent| sent != current) {
            // Flutter keys decoded images by asset.  Emit a release before a
            // same-asset identity/revision replacement so an old image cannot
            // survive when a stale-base resync reuses the asset name.
            released_resources.push(node.asset.clone());
        }
        if previous.is_some_and(|sent| sent != current) {
            host.sent_resources.remove(&node.asset);
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
    for &texture in generic_texture_handles {
        let asset = synthetic_texture_asset(texture);
        if !emitted_resources.insert(asset.clone()) {
            continue;
        }
        let revision = core
            .ui
            .texture_revision(texture)
            .ok_or_else(|| format!("generic TEX texture handle {texture} went stale"))?;
        let current = SentResource { texture, revision };
        let previous = host.sent_resources.get(&asset).copied();
        let confirmed = confirmed_resources
            .as_ref()
            .and_then(|resources| resources.get(&asset).copied());
        let expected = if force_full_resources {
            confirmed.or(previous)
        } else {
            previous
        };
        if !force_full_resources && previous == Some(current) {
            continue;
        }
        if expected.is_some_and(|sent| sent != current) {
            released_resources.push(asset.clone());
        }
        if previous.is_some_and(|sent| sent != current) {
            host.sent_resources.remove(&asset);
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
    // Identity replacement records are added while the current resource
    // entries are walked; normalize them again after that pass so node order
    // and the generic-handle HashSet cannot leak into the ABI.
    released_resources.sort();
    released_resources.dedup();
    // `generic_texture_handles` is collected from a HashSet because several
    // DrawOps may sample one generated page.  Do not let its randomized
    // iteration order leak into the frame ABI or replay digest.
    resources.sort_by(|left, right| left.asset.cmp(&right.asset));
    let events: Vec<_> = host.outbound.borrow_mut().drain(..).collect();
    let unchanged = allow_unchanged
        && cache_hit
        && events.is_empty()
        && resources.is_empty()
        && released_resources.is_empty();
    let (ops, auxiliary) = if unchanged {
        (Rc::new(Vec::new()), None)
    } else if let Some((ops, auxiliary, _)) = decoded {
        (ops, auxiliary)
    } else {
        let cache = host
            .draw_cache
            .as_ref()
            .expect("draw cache hit must have a cache");
        (Rc::clone(&cache.ops), cache.auxiliary.clone())
    };
    host.frame = host.frame.wrapping_add(1);
    drop(core);
    drop(nodes_borrow);
    demand::capture(host);
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
    let mut out = HashSet::new();
    let mut last_ptr: usize = 0;
    for op in ops {
        if op.kind == "image" || op.kind == "textureTriangle" {
            if let Some(asset) = &op.asset {
                let ptr = Rc::as_ptr(&asset.0) as *const u8 as usize;
                if ptr == last_ptr {
                    continue;
                }
                last_ptr = ptr;
                if !out.contains(&**asset) {
                    out.insert((**asset).to_owned());
                }
            }
        }
    }
    out
}

fn registered_texture_asset(texture: i32, nodes: &[NodeMeta]) -> Option<&str> {
    nodes
        .iter()
        .find(|node| node.kind == "image" && node.texture == texture)
        .map(|node| node.asset.as_str())
        .filter(|asset| !asset.is_empty())
}

#[derive(Default)]
struct TextureDecodeCache {
    last: Option<(i32, SharedStr)>,
    by_handle: HashMap<i32, SharedStr>,
}

impl TextureDecodeCache {
    fn resolve(
        &mut self,
        texture: i32,
        nodes: &[NodeMeta],
        ui: &Ui,
        generic_texture_handles: &mut HashSet<i32>,
        opcode_label: &str,
    ) -> Result<SharedStr, String> {
        if let Some((last_handle, ref asset)) = self.last {
            if last_handle == texture {
                return Ok(asset.clone());
            }
        }
        if let Some(asset) = self.by_handle.get(&texture) {
            let cloned = asset.clone();
            self.last = Some((texture, cloned.clone()));
            return Ok(cloned);
        }
        if ui.texture(texture).is_none() {
            return Err(format!(
                "{opcode_label} texture handle {texture} has no live core texture"
            ));
        }
        let shared: SharedStr = match registered_texture_asset(texture, nodes) {
            Some(name) => SharedStr::from(name),
            None => {
                generic_texture_handles.insert(texture);
                SharedStr::from(synthetic_texture_asset(texture))
            }
        };
        self.by_handle.insert(texture, shared.clone());
        self.last = Some((texture, shared.clone()));
        Ok(shared)
    }

    fn resolve_glyph_page(
        &mut self,
        handle: i32,
        generic_texture_handles: &mut HashSet<i32>,
    ) -> SharedStr {
        if let Some((last_handle, ref asset)) = self.last {
            if last_handle == handle {
                return asset.clone();
            }
        }
        if let Some(asset) = self.by_handle.get(&handle) {
            let cloned = asset.clone();
            self.last = Some((handle, cloned.clone()));
            return cloned;
        }
        generic_texture_handles.insert(handle);
        let shared = SharedStr::from(synthetic_texture_asset(handle));
        self.by_handle.insert(handle, shared.clone());
        self.last = Some((handle, shared.clone()));
        shared
    }
}

fn clip_of(rect: DamageRect) -> Clip {
    Clip {
        x: rect.x0 as f32,
        y: rect.y0 as f32,
        w: (rect.x1 - rect.x0).max(0) as f32,
        h: (rect.y1 - rect.y0).max(0) as f32,
    }
}

#[cfg(test)]
fn append_draw_operation(
    out: &mut Vec<FrameOp>,
    operation: &Operation<'_>,
    nodes: &[NodeMeta],
    ui: &mut Ui,
    generic_texture_handles: &mut HashSet<i32>,
) -> Result<(), String> {
    append_draw_operation_cached(
        out,
        operation,
        nodes,
        ui,
        generic_texture_handles,
        None,
        None,
    )
}

fn append_draw_operation_cached(
    out: &mut Vec<FrameOp>,
    operation: &Operation<'_>,
    nodes: &[NodeMeta],
    ui: &mut Ui,
    generic_texture_handles: &mut HashSet<i32>,
    mut texture_cache: Option<&mut TextureDecodeCache>,
    text_metrics: Option<&TextMetrics>,
) -> Result<(), String> {
    let words = operation.words;
    match operation.opcode {
        1 => {
            let (x, y, w, h) = unpack_rect(
                *words
                    .get(1)
                    .ok_or_else(|| "RECT is missing its position".to_owned())?,
                *words
                    .get(2)
                    .ok_or_else(|| "RECT is missing its size".to_owned())?,
            );
            let color = *words
                .get(3)
                .ok_or_else(|| "RECT is missing its color".to_owned())?;
            out.push(FrameOp {
                kind: "rect",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(argb_from_abgr(color)),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
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
                kind: "gradient",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: None,
                from_color: Some(argb_from_abgr(from)),
                to_color: Some(argb_from_abgr(to)),
                direction: Some(direction),
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        3 => {
            let header = *words
                .get(1)
                .ok_or_else(|| "GLYPH_RUN is missing its font slot and count".to_owned())?;
            let color = *words
                .get(2)
                .ok_or_else(|| "GLYPH_RUN is missing its color".to_owned())?;
            if header & 0x0000_ff00 != 0 {
                return Err("GLYPH_RUN has nonzero reserved font-slot bits".to_owned());
            }
            let slot = (header & 0xff) as u8;
            let count = (header >> 16) as usize;
            let expected_len = 3usize
                .checked_add(count.checked_mul(2).ok_or_else(|| {
                    "GLYPH_RUN glyph count overflows its record length".to_owned()
                })?)
                .ok_or_else(|| "GLYPH_RUN record length overflow".to_owned())?;
            if words.len() != expected_len {
                return Err(format!(
                    "GLYPH_RUN has {} words for {count} glyphs; expected {expected_len}",
                    words.len()
                ));
            }
            for glyph in 0..count {
                let gid_word = *words
                    .get(4 + glyph * 2)
                    .ok_or_else(|| "GLYPH_RUN is truncated".to_owned())?;
                if gid_word & 0xffff_0000 != 0 {
                    return Err(format!(
                        "GLYPH_RUN glyph {glyph} has nonzero reserved gid bits"
                    ));
                }
            }
            if count == 0 || (color >> 24) == 0 {
                return Ok(());
            }
            let Some((cell_w, cell_h, glyph_count)) = ui
                .font_atlas(slot)
                .map(|atlas| (atlas.cell_w as f32, atlas.cell_h as f32, atlas.glyph_count))
            else {
                // Match the pinned upstream raster/GPUI renderer: a run whose
                // font slot is not installed contributes no pixels.
                return Ok(());
            };
            for glyph in 0..count {
                let xy = *words
                    .get(3 + glyph * 2)
                    .ok_or_else(|| "GLYPH_RUN is truncated".to_owned())?;
                let gid = (*words
                    .get(4 + glyph * 2)
                    .ok_or_else(|| "GLYPH_RUN is truncated".to_owned())?
                    & 0xffff) as u16;
                if gid >= glyph_count {
                    // Upstream renderers skip out-of-range gids as well.
                    continue;
                }
                let page = ui.prepare_glyph_page(slot, gid).ok_or_else(|| {
                    format!("GLYPH_RUN could not prepare glyph page for slot {slot}, gid {gid}")
                })?;
                if !page.contains(gid) {
                    return Err(format!(
                        "GLYPH_RUN page for slot {slot}, gid {gid} does not contain the glyph"
                    ));
                }
                let handle = page.handle as i32;
                let asset = match texture_cache.as_deref_mut() {
                    Some(cache) => cache.resolve_glyph_page(handle, generic_texture_handles),
                    None => {
                        generic_texture_handles.insert(handle);
                        SharedStr::from(synthetic_texture_asset(handle))
                    }
                };
                let point = unpack_point(xy);
                out.push(FrameOp {
                    kind: "image",
                    x: point.x,
                    y: point.y,
                    w: cell_w,
                    h: cell_h,
                    text: None,
                    asset: Some(asset),
                    id: None,
                    fit: None,
                    autoplay: None,
                    repeat_texture: false,
                    color: Some(argb_from_abgr(color)),
                    from_color: None,
                    to_color: None,
                    direction: None,
                    via_color: None,
                    via_position: None,
                    size: None,
                    font_slot: None,
                    text_align: None,
                    surface_handle: None,
                    focused: None,
                    radius: None,
                    border_width: None,
                    start_angle: None,
                    sweep_angle: None,
                    points: None,
                    colors: None,
                    uvs: None,
                    uv: Some(page.uv(gid)),
                    tracking: None,
                    text_affine: None,
                    surface_kind: None,
                    surface_parameters: None,
                    clip: clip_of(operation.clip),
                });
            }
        }
        4 => {
            let texture = *words
                .get(1)
                .ok_or_else(|| "TEX_QUAD is missing its texture handle".to_owned())?
                as i32;
            let (x, y, w, h) = unpack_rect(
                *words
                    .get(2)
                    .ok_or_else(|| "TEX_QUAD is missing its position".to_owned())?,
                *words
                    .get(3)
                    .ok_or_else(|| "TEX_QUAD is missing its size".to_owned())?,
            );
            let asset = match texture_cache.as_deref_mut() {
                Some(cache) => cache.resolve(
                    texture,
                    nodes,
                    ui,
                    generic_texture_handles,
                    "TEX_QUAD",
                )?,
                None => {
                    if ui.texture(texture).is_none() {
                        return Err(format!(
                            "TEX_QUAD texture handle {texture} has no live core texture"
                        ));
                    }
                    match registered_texture_asset(texture, nodes) {
                        Some(name) => SharedStr::from(name),
                        None => {
                            generic_texture_handles.insert(texture);
                            SharedStr::from(synthetic_texture_asset(texture))
                        }
                    }
                }
            };
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
                kind: "image",
                x,
                y,
                w,
                h,
                text: None,
                asset: Some(asset),
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(argb_from_abgr(*words.get(8).ok_or_else(|| {
                    "TEX_QUAD is missing its modulation color".to_owned()
                })?)),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: Some(uv),
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        7 => {
            let points = [
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
            let colors = [
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
                kind: "triangle",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: None,
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: Some(points),
                colors: Some(colors),
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        8 | 14 | 15 | 16 => {
            let texture = *words
                .get(1)
                .ok_or_else(|| "TEX_TRI is missing its texture handle".to_owned())?
                as i32;
            let asset = match texture_cache.as_deref_mut() {
                Some(cache) => cache.resolve(
                    texture,
                    nodes,
                    ui,
                    generic_texture_handles,
                    "TEX_TRI",
                )?,
                None => {
                    if ui.texture(texture).is_none() {
                        return Err(format!(
                            "TEX_TRI texture handle {texture} has no live core texture"
                        ));
                    }
                    match registered_texture_asset(texture, nodes) {
                        Some(name) => SharedStr::from(name),
                        None => {
                            generic_texture_handles.insert(texture);
                            SharedStr::from(synthetic_texture_asset(texture))
                        }
                    }
                }
            };
            let fractional = matches!(operation.opcode, 15 | 16);
            let stride = if fractional { 4 } else { 3 };
            let word = |index: usize| -> Result<u32, String> {
                words
                    .get(index)
                    .copied()
                    .ok_or_else(|| "TEX_TRI is truncated".to_owned())
            };
            let mut points = [FramePoint { x: 0.0, y: 0.0 }; 3];
            let mut uvs = [0.0f32; 6];
            for vertex in 0..3 {
                let offset = 2 + vertex * stride;
                let uv_offset = if fractional {
                    points[vertex] = FramePoint {
                        x: f32::from_bits(word(offset)?),
                        y: f32::from_bits(word(offset + 1)?),
                    };
                    offset + 2
                } else {
                    points[vertex] = unpack_point(word(offset)?);
                    offset + 1
                };
                uvs[vertex * 2] = f32::from_bits(word(uv_offset)?);
                uvs[vertex * 2 + 1] = f32::from_bits(word(uv_offset + 1)?);
            }
            let (x, y, w, h) = triangle_bounds(&points)?;
            if uvs
                .iter()
                .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
            {
                return Err("TEX_TRI contains an invalid UV".to_owned());
            }
            out.push(FrameOp {
                kind: "textureTriangle",
                x,
                y,
                w,
                h,
                text: None,
                asset: Some(asset),
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: matches!(operation.opcode, 14 | 16),
                color: Some(argb_from_abgr(*words.get(2 + 3 * stride).ok_or_else(
                    || "TEX_TRI is missing its modulation color".to_owned(),
                )?)),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: Some(points),
                colors: None,
                uvs: Some(uvs),
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        11 => {
            let (x, y, w, h) = unpack_rect(
                *words
                    .get(1)
                    .ok_or_else(|| "MESH_LAYER_BEGIN is missing its position".to_owned())?,
                *words
                    .get(2)
                    .ok_or_else(|| "MESH_LAYER_BEGIN is missing its size".to_owned())?,
            );
            let blend = *words
                .get(3)
                .ok_or_else(|| "MESH_LAYER_BEGIN is missing its blend mode".to_owned())?;
            if blend > 3 {
                return Err(format!(
                    "MESH_LAYER_BEGIN has unsupported blend mode {blend}"
                ));
            }
            let tint_words = words
                .get(4..10)
                .ok_or_else(|| "MESH_LAYER_BEGIN is missing its RGB tints".to_owned())?;
            let tints = [
                f32::from_bits(tint_words[0]),
                f32::from_bits(tint_words[1]),
                f32::from_bits(tint_words[2]),
                f32::from_bits(tint_words[3]),
                f32::from_bits(tint_words[4]),
                f32::from_bits(tint_words[5]),
            ];
            if tints
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            {
                return Err("MESH_LAYER_BEGIN contains an invalid RGB tint".to_owned());
            }
            out.push(FrameOp {
                kind: "meshLayerBegin",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(blend),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: Some(tints),
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        12 => {
            let inverted = *words
                .get(1)
                .ok_or_else(|| "MESH_MASK_BEGIN is missing its inversion flag".to_owned())?;
            let (x, y, w, h) = unpack_rect(
                *words
                    .get(2)
                    .ok_or_else(|| "MESH_MASK_BEGIN is missing its position".to_owned())?,
                *words
                    .get(3)
                    .ok_or_else(|| "MESH_MASK_BEGIN is missing its size".to_owned())?,
            );
            if inverted > 1 {
                return Err("MESH_MASK_BEGIN has an invalid inversion flag".to_owned());
            }
            out.push(FrameOp {
                kind: "meshMaskBegin",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(inverted),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        13 => out.push(FrameOp {
            kind: "meshLayerRestore",
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            text: None,
            asset: None,
            id: None,
            fit: None,
            autoplay: None,
            repeat_texture: false,
            color: None,
            from_color: None,
            to_color: None,
            direction: None,
            via_color: None,
            via_position: None,
            size: None,
            font_slot: None,
            text_align: None,
            surface_handle: None,
            focused: None,
            radius: None,
            border_width: None,
            start_angle: None,
            sweep_angle: None,
            points: None,
            colors: None,
            uvs: None,
            uv: None,
            tracking: None,
            text_affine: None,
            surface_kind: None,
            surface_parameters: None,
            clip: clip_of(operation.clip),
        }),
        17 => {
            if words.len() != 8 {
                return Err(format!(
                    "ROUNDED_RECT has {} words; expected 8",
                    words.len()
                ));
            }
            let x = f32::from_bits(words[1]);
            let y = f32::from_bits(words[2]);
            let w = f32::from_bits(words[3]);
            let h = f32::from_bits(words[4]);
            let radius = f32::from_bits(words[5]);
            let border_width = f32::from_bits(words[6]);
            if ![x, y, w, h, radius, border_width]
                .into_iter()
                .all(f32::is_finite)
                || w < 0.0
                || h < 0.0
                || radius < 0.0
                || border_width < 0.0
            {
                return Err("ROUNDED_RECT contains invalid geometry".to_owned());
            }
            out.push(FrameOp {
                kind: "rounded",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(argb_from_abgr(words[7])),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: Some(radius),
                border_width: Some(border_width),
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        18 => {
            if words.len() != 8 {
                return Err(format!("ARC has {} words; expected 8", words.len()));
            }
            let center_x = f32::from_bits(words[1]);
            let center_y = f32::from_bits(words[2]);
            let radius = f32::from_bits(words[3]);
            let stroke_width = f32::from_bits(words[4]);
            let start_angle = f32::from_bits(words[5]);
            let sweep_angle = f32::from_bits(words[6]);
            if ![
                center_x,
                center_y,
                radius,
                stroke_width,
                start_angle,
                sweep_angle,
            ]
            .into_iter()
            .all(f32::is_finite)
                || radius < 0.0
                || stroke_width <= 0.0
                || sweep_angle == 0.0
                || sweep_angle.abs() > 360.0
            {
                return Err("ARC contains invalid geometry".to_owned());
            }
            let outer_radius = radius + stroke_width * 0.5;
            let (x, y, w, h) = (
                center_x - outer_radius,
                center_y - outer_radius,
                outer_radius * 2.0,
                outer_radius * 2.0,
            );
            if ![outer_radius, x, y, w, h].into_iter().all(f32::is_finite) || w <= 0.0 {
                return Err("ARC contains invalid bounds".to_owned());
            }
            out.push(FrameOp {
                kind: "arc",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(argb_from_abgr(words[7])),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: Some(radius),
                border_width: Some(stroke_width),
                start_angle: Some(start_angle),
                sweep_angle: Some(sweep_angle),
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        19 => {
            if words.len() != 11 {
                return Err(format!(
                    "ROUNDED_GRADIENT has {} words; expected 11",
                    words.len()
                ));
            }
            let x = f32::from_bits(words[1]);
            let y = f32::from_bits(words[2]);
            let w = f32::from_bits(words[3]);
            let h = f32::from_bits(words[4]);
            let radius = f32::from_bits(words[5]);
            let direction = words[8];
            let via_position = f32::from_bits(words[10]);
            if ![x, y, w, h, radius].into_iter().all(f32::is_finite)
                || w <= 0.0
                || h <= 0.0
                || radius <= 0.0
                || direction > 3
                || (!via_position.is_nan()
                    && (!via_position.is_finite()
                        || via_position <= 0.0
                        || via_position >= 1.0))
            {
                return Err("ROUNDED_GRADIENT contains invalid geometry, direction, or stop".to_owned());
            }
            let via = (!via_position.is_nan()).then(|| {
                (argb_from_abgr(words[9]), via_position)
            });
            out.push(FrameOp {
                kind: "roundedGradient",
                x,
                y,
                w,
                h,
                text: None,
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: None,
                from_color: Some(argb_from_abgr(words[6])),
                to_color: Some(argb_from_abgr(words[7])),
                direction: Some(direction),
                via_color: via.map(|(color, _)| color),
                via_position: via.map(|(_, position)| position),
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: Some(radius),
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        5 | 6 => {}
        9 => {
            let header = *words
                .get(1)
                .ok_or_else(|| "TEXT_RUN is missing its header".to_owned())?;
            let x = f32::from_bits(
                *words
                    .get(2)
                    .ok_or_else(|| "TEXT_RUN is missing x".to_owned())?,
            );
            let y = f32::from_bits(
                *words
                    .get(3)
                    .ok_or_else(|| "TEXT_RUN is missing y".to_owned())?,
            );
            let w = f32::from_bits(
                *words
                    .get(4)
                    .ok_or_else(|| "TEXT_RUN is missing w".to_owned())?,
            );
            let line_height = f32::from_bits(
                *words
                    .get(5)
                    .ok_or_else(|| "TEXT_RUN is missing line height".to_owned())?,
            );
            let color_word = *words
                .get(6)
                .ok_or_else(|| "TEXT_RUN is missing color".to_owned())?;
            let bytes = *words
                .get(7)
                .ok_or_else(|| "TEXT_RUN is missing byte length".to_owned())?
                as usize;
            let has_tracking = (header & pocket_spec::draw_op::TEXT_RUN_FLAG_TRACKING) != 0;
            let has_affine = (header & pocket_spec::draw_op::TEXT_RUN_FLAG_AFFINE) != 0;
            let mut payload_idx = 8usize;
            let tracking = if has_tracking {
                let bits = *words
                    .get(payload_idx)
                    .ok_or_else(|| "TEXT_RUN is missing tracking".to_owned())?;
                payload_idx += 1;
                let value = f32::from_bits(bits);
                if !value.is_finite() {
                    return Err("TEXT_RUN tracking must be finite".to_owned());
                }
                (value != 0.0).then_some(value)
            } else {
                None
            };
            let text_affine = if has_affine {
                let slice = words
                    .get(payload_idx..payload_idx + 4)
                    .ok_or_else(|| "TEXT_RUN is missing affine matrix".to_owned())?;
                payload_idx += 4;
                let matrix = [
                    f32::from_bits(slice[0]),
                    f32::from_bits(slice[1]),
                    f32::from_bits(slice[2]),
                    f32::from_bits(slice[3]),
                ];
                if matrix.iter().any(|v| !v.is_finite()) {
                    return Err("TEXT_RUN affine matrix must be finite".to_owned());
                }
                Some(matrix)
            } else {
                None
            };
            let packed_end = payload_idx
                .checked_add(bytes.div_ceil(4))
                .ok_or_else(|| "TEXT_RUN payload length overflow".to_owned())?;
            let packed = words
                .get(payload_idx..packed_end)
                .ok_or_else(|| "TEXT_RUN payload is truncated".to_owned())?;
            let mut raw = Vec::with_capacity(bytes);
            for word in packed {
                raw.extend_from_slice(&word.to_le_bytes());
            }
            raw.truncate(bytes);
            let text = String::from_utf8_lossy(&raw).into_owned();
            let font_slot = (header & 0xff) as u8;
            let default_lh = text_metrics
                .map(|m| m.default_line_height(font_slot))
                .unwrap_or_else(|| font_slot_line_height(font_slot));
            let line_height = if line_height.is_finite() && line_height > 0.0 {
                line_height
            } else {
                default_lh
            };
            let line_count = text.split('\n').count().max(1) as f32;
            let measured_h = (line_count * line_height).max(default_lh);
            out.push(FrameOp {
                kind: "text",
                x,
                y,
                w,
                h: measured_h,
                text: Some(text),
                asset: None,
                id: None,
                fit: None,
                autoplay: None,
                repeat_texture: false,
                color: Some(argb_from_abgr(color_word)),
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: Some(font_slot_px(font_slot)),
                font_slot: Some(font_slot),
                text_align: Some(((header >> 8) & 0xff).min(2) as u8),
                surface_handle: None,
                focused: None,
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking,
                text_affine,
                surface_kind: None,
                surface_parameters: None,
                clip: clip_of(operation.clip),
            });
        }
        10 => {
            let surface = *words
                .get(1)
                .ok_or_else(|| "SURFACE_QUAD is missing its surface handle".to_owned())?
                as i32;
            let x = f32::from_bits(
                *words
                    .get(2)
                    .ok_or_else(|| "SURFACE_QUAD is missing x".to_owned())?,
            );
            let y = f32::from_bits(
                *words
                    .get(3)
                    .ok_or_else(|| "SURFACE_QUAD is missing y".to_owned())?,
            );
            let w = f32::from_bits(
                *words
                    .get(4)
                    .ok_or_else(|| "SURFACE_QUAD is missing w".to_owned())?,
            );
            let h = f32::from_bits(
                *words
                    .get(5)
                    .ok_or_else(|| "SURFACE_QUAD is missing h".to_owned())?,
            );
            let visible_xy = *words
                .get(6)
                .ok_or_else(|| "SURFACE_QUAD is missing visible position".to_owned())?;
            let visible_wh = *words
                .get(7)
                .ok_or_else(|| "SURFACE_QUAD is missing visible size".to_owned())?;
            let flags = *words
                .get(8)
                .ok_or_else(|| "SURFACE_QUAD is missing flags".to_owned())?;
            let visible =
                pocket_draw_ops::logical_rect(visible_xy, visible_wh).intersect(operation.clip);
            if visible.is_empty() {
                return Ok(());
            }
            let video = nodes
                .iter()
                .find(|node| {
                    (node.kind == "video" || node.kind == "hostSurface") && node.surface == surface
                })
                .ok_or_else(|| {
                    format!("SURFACE_QUAD surface handle {surface} has no registered video asset")
                })?;
            if video.video_id.is_empty()
                || (video.kind == "video" && video.asset.is_empty())
                || (video.kind == "hostSurface"
                    && (video.surface_kind.is_empty() || video.surface_parameters.is_empty()))
            {
                return Err(format!(
                    "SURFACE_QUAD surface handle {surface} has an incomplete video mapping"
                ));
            }
            out.push(FrameOp {
                kind: if video.kind == "hostSurface" {
                    "hostSurface"
                } else {
                    "video"
                },
                x,
                y,
                w,
                h,
                text: None,
                asset: (video.kind == "video").then(|| SharedStr::from(video.asset.as_str())),
                id: Some(video.video_id.clone()),
                fit: Some(video.fit.clone()),
                autoplay: (video.kind == "video").then_some(video.autoplay),
                repeat_texture: false,
                color: None,
                from_color: None,
                to_color: None,
                direction: None,
                via_color: None,
                via_position: None,
                size: None,
                font_slot: None,
                text_align: None,
                surface_handle: Some(surface),
                focused: Some(flags & 1 != 0),
                radius: None,
                border_width: None,
                start_angle: None,
                sweep_angle: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
                tracking: None,
                text_affine: None,
                surface_kind: if video.kind == "hostSurface" {
                    Some(video.surface_kind.clone())
                } else {
                    None
                },
                surface_parameters: if video.kind == "hostSurface" {
                    Some(video.surface_parameters.clone())
                } else {
                    None
                },
                clip: clip_of(visible),
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

const HOST_FONT_SLOTS: usize = pocket_spec::MAX_FONT_SLOTS;
const ACTIVE_HOST_FONT_SLOTS: usize = 21;
const HOST_ASCII_START: u32 = 0x20;
const HOST_ASCII_COUNT: usize = 95;
const MAX_HOST_GLYPH_CACHE_ENTRIES: usize = 16_384;

type HostGlyphMeasureCallback =
    unsafe extern "C" fn(user_data: usize, slot: u8, codepoint: u32) -> f32;

type HostTextMeasureCallback = unsafe extern "C" fn(
    user_data: usize,
    slot: u8,
    tracking: f32,
    utf8_ptr: *const u8,
    utf8_len: usize,
) -> f32;

#[derive(Clone, Copy)]
struct HostGlyphCallback {
    func: HostGlyphMeasureCallback,
    user_data: usize,
}

impl std::fmt::Debug for HostGlyphCallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostGlyphCallback")
            .field("user_data", &self.user_data)
            .finish()
    }
}

#[derive(Clone, Copy)]
struct HostTextCallback {
    func: HostTextMeasureCallback,
    user_data: usize,
}

impl std::fmt::Debug for HostTextCallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostTextCallback")
            .field("user_data", &self.user_data)
            .finish()
    }
}

#[derive(Clone, Debug)]
struct HostFontTable {
    line_heights: [f32; HOST_FONT_SLOTS],
    cjk_advances: [f32; HOST_FONT_SLOTS],
    ascii_advances: [[f32; HOST_ASCII_COUNT]; HOST_FONT_SLOTS],
}

#[doc(hidden)]
pub fn default_probe_host_font_metrics() -> (
    [f32; ACTIVE_HOST_FONT_SLOTS],
    [f32; ACTIVE_HOST_FONT_SLOTS],
    [f32; ACTIVE_HOST_FONT_SLOTS * HOST_ASCII_COUNT],
) {
    let mut line_heights = [0.0f32; ACTIVE_HOST_FONT_SLOTS];
    let mut cjk_advances = [0.0f32; ACTIVE_HOST_FONT_SLOTS];
    let mut ascii_advances = [0.0f32; ACTIVE_HOST_FONT_SLOTS * HOST_ASCII_COUNT];
    for slot in 0..ACTIVE_HOST_FONT_SLOTS {
        let slot_u8 = slot as u8;
        let px = font_slot_px(slot_u8);
        line_heights[slot] = font_slot_line_height(slot_u8);
        cjk_advances[slot] = px;
        for i in 0..HOST_ASCII_COUNT {
            let cp = HOST_ASCII_START + i as u32;
            ascii_advances[slot * HOST_ASCII_COUNT + i] =
                TextMetrics::advance_pak_or_fallback(slot_u8, None, cp);
        }
    }
    (line_heights, cjk_advances, ascii_advances)
}

fn is_wide_scalar(codepoint: u32) -> bool {
    matches!(
        codepoint,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3040..=0x33BF
            | 0x3400..=0x4DBF
            | 0x4E00..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE6F
            | 0xFF01..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x3FFFF
    )
}

#[derive(Clone, Debug, Default)]
struct TextMetrics {
    fonts: Vec<FontMetric>,
    fontless_pak: bool,
    host_table: Option<HostFontTable>,
    glyph_callback: Option<HostGlyphCallback>,
    text_callback: Option<HostTextCallback>,
    trace_lane: Option<Rc<RefCell<replay::ScalarLane>>>,
    glyph_cache: RefCell<HashMap<(u8, u32), (u64, f32)>>,
    segment_cache: RefCell<HashMap<Box<str>, Vec<(u8, u32, u64, f32)>>>,
    segment_cache_entries: std::cell::Cell<usize>,
    cache_generation: std::cell::Cell<u64>,
}

impl TextMetrics {
    fn clear_caches(&self) {
        self.glyph_cache.borrow_mut().clear();
        self.segment_cache.borrow_mut().clear();
        self.segment_cache_entries.set(0);
        self.cache_generation.set(0);
    }

    fn next_generation(&self) -> u64 {
        let next = self.cache_generation.get().wrapping_add(1);
        self.cache_generation.set(next);
        next
    }

    fn insert_glyph_cached(&self, key: (u8, u32), width: f32) {
        let gen = self.next_generation();
        let mut cache = self.glyph_cache.borrow_mut();
        if cache.len() >= MAX_HOST_GLYPH_CACHE_ENTRIES {
            let min_gen = cache.values().map(|(g, _)| *g).min().unwrap_or(0);
            let max_gen = cache.values().map(|(g, _)| *g).max().unwrap_or(gen);
            let cutoff = min_gen + (max_gen.saturating_sub(min_gen)) / 2 + 1;
            cache.retain(|_, (g, _)| *g >= cutoff);
            if cache.len() >= MAX_HOST_GLYPH_CACHE_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (gen, width));
    }

    fn lookup_segment_cached(&self, line: &str, slot: u8, tracking_bits: u32) -> Option<f32> {
        let cache = self.segment_cache.borrow();
        let bucket = cache.get(line)?;
        bucket
            .iter()
            .find(|(s, t, _, _)| *s == slot && *t == tracking_bits)
            .map(|(_, _, _, width)| *width)
    }

    fn insert_segment_cached(&self, line: &str, slot: u8, tracking_bits: u32, width: f32) {
        let gen = self.next_generation();
        let mut cache = self.segment_cache.borrow_mut();
        if self.segment_cache_entries.get() >= MAX_HOST_GLYPH_CACHE_ENTRIES {
            let mut min_gen = u64::MAX;
            let mut max_gen = 0u64;
            for bucket in cache.values() {
                for &(_, _, g, _) in bucket {
                    min_gen = min_gen.min(g);
                    max_gen = max_gen.max(g);
                }
            }
            let cutoff = if min_gen <= max_gen {
                min_gen + (max_gen - min_gen) / 2 + 1
            } else {
                gen
            };
            let mut remaining = 0usize;
            cache.retain(|_, bucket| {
                bucket.retain(|(_, _, g, _)| *g >= cutoff);
                remaining += bucket.len();
                !bucket.is_empty()
            });
            if remaining >= MAX_HOST_GLYPH_CACHE_ENTRIES {
                cache.clear();
                remaining = 0;
            }
            self.segment_cache_entries.set(remaining);
        }
        if let Some(bucket) = cache.get_mut(line) {
            if let Some(existing) = bucket
                .iter_mut()
                .find(|(s, t, _, _)| *s == slot && *t == tracking_bits)
            {
                existing.2 = gen;
                existing.3 = width;
                return;
            }
            bucket.push((slot, tracking_bits, gen, width));
        } else {
            cache.insert(
                line.to_owned().into_boxed_str(),
                vec![(slot, tracking_bits, gen, width)],
            );
        }
        self.segment_cache_entries
            .set(self.segment_cache_entries.get().saturating_add(1));
    }

    fn settle_traced_advance<F: FnOnce() -> f32>(&self, compute: F) -> f32 {
        match self.trace_lane {
            Some(ref lane) => replay::settle_host_text_advance(lane, compute),
            None => compute(),
        }
    }

    fn font(&self, slot: u8) -> Option<&FontMetric> {
        self.fonts.iter().find(|font| font.slot == slot)
    }

    fn default_line_height(&self, slot: u8) -> f32 {
        if let Some(ref host) = self.host_table {
            if let Some(&lh) = host.line_heights.get(slot as usize) {
                if lh.is_finite() && lh > 0.0 {
                    return lh;
                }
            }
        }
        self.font(slot)
            .map(|item| item.line_height)
            .unwrap_or_else(|| font_slot_line_height(slot))
    }

    fn advance_pak_or_fallback(slot: u8, font: Option<&FontMetric>, codepoint: u32) -> f32 {
        if codepoint == '\r' as u32 {
            return 0.0;
        }
        if let Some(font) = font {
            return font
                .advances
                .binary_search_by_key(&codepoint, |(cp, _)| *cp)
                .map(|index| font.advances[index].1)
                .unwrap_or(font.cell_w);
        }
        let px = font_slot_px(slot);
        if is_wide_scalar(codepoint) {
            px
        } else if (16..=18).contains(&slot) {
            (px * 0.6).round().max(1.0)
        } else if codepoint == ' ' as u32 {
            (px * 0.32).round().max(1.0)
        } else {
            (px * 0.56).round().max(1.0)
        }
    }

    fn host_scalar_fallback(host: &HostFontTable, slot_idx: usize, codepoint: u32) -> f32 {
        if codepoint == '\r' as u32 {
            0.0
        } else if codepoint == '\t' as u32 {
            host.ascii_advances[slot_idx][0] * 4.0
        } else if codepoint >= HOST_ASCII_START
            && codepoint < HOST_ASCII_START + (HOST_ASCII_COUNT as u32)
        {
            host.ascii_advances[slot_idx][(codepoint - HOST_ASCII_START) as usize]
        } else if is_wide_scalar(codepoint) {
            host.cjk_advances[slot_idx]
        } else {
            host.ascii_advances[slot_idx][('M' as u32 - HOST_ASCII_START) as usize]
        }
    }

    fn advance_host_scalar(&self, host: &HostFontTable, slot: u8, codepoint: u32) -> f32 {
        let slot_idx = slot as usize;
        if codepoint == '\r' as u32 {
            return 0.0;
        }
        if codepoint == '\t' as u32 {
            return host.ascii_advances[slot_idx][0] * 4.0;
        }
        if codepoint >= HOST_ASCII_START
            && codepoint < HOST_ASCII_START + (HOST_ASCII_COUNT as u32)
        {
            return host.ascii_advances[slot_idx][(codepoint - HOST_ASCII_START) as usize];
        }
        if let Some(&(_, cached)) = self.glyph_cache.borrow().get(&(slot, codepoint)) {
            return cached;
        }
        let resolved = if let Some(cb) = self.glyph_callback {
            let measured = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                (cb.func)(cb.user_data, slot, codepoint)
            }))
            .unwrap_or(-1.0);
            if measured.is_finite() && measured >= 0.0 {
                measured
            } else {
                Self::host_scalar_fallback(host, slot_idx, codepoint)
            }
        } else {
            Self::host_scalar_fallback(host, slot_idx, codepoint)
        };
        // Cache both succeeded and fallback lookups so unmeasurable scalars
        // never re-enter FFI on subsequent frames.
        self.insert_glyph_cached((slot, codepoint), resolved);
        resolved
    }

    fn measure_host_line(&self, host: &HostFontTable, line: &str, slot: u8, tracking: f32) -> f32 {
        if line.is_empty() {
            return 0.0;
        }
        let slot_idx = slot as usize;
        if line.bytes().all(|b| (0x20..=0x7E).contains(&b)) {
            let table = &host.ascii_advances[slot_idx];
            let mut width = 0.0f32;
            for b in line.bytes() {
                width += table[(b - 0x20) as usize] + tracking;
            }
            return width.max(0.0);
        }
        let norm_tracking = if tracking == 0.0 { 0.0 } else { tracking };
        let tracking_bits = norm_tracking.to_bits();
        if let Some(cached) = self.lookup_segment_cached(line, slot, tracking_bits) {
            return cached;
        }
        let resolved = self.settle_traced_advance(|| {
            if let Some(cb) = self.text_callback {
                let measured = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    (cb.func)(
                        cb.user_data,
                        slot,
                        norm_tracking,
                        line.as_ptr(),
                        line.len(),
                    )
                }))
                .unwrap_or(-1.0);
                if measured.is_finite() && measured >= 0.0 {
                    return measured;
                }
            }
            let mut fallback = 0.0f32;
            for ch in line.chars() {
                if ch != '\r' {
                    fallback += self.advance_host_scalar(host, slot, ch as u32) + norm_tracking;
                }
            }
            fallback.max(0.0)
        });
        self.insert_segment_cached(line, slot, tracking_bits, resolved);
        resolved
    }

    fn measure(&self, text: &str, slot: u8, tracking: f32, line_height: f32) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }
        let default_line_height = self.default_line_height(slot);
        let line_height = if line_height.is_nan() {
            default_line_height
        } else {
            line_height
        };
        if let Some(ref host) = self.host_table {
            if (slot as usize) < HOST_FONT_SLOTS {
                let mut max_width = 0.0_f32;
                let mut lines = 0.0_f32;
                for line in text.split('\n') {
                    lines += 1.0;
                    max_width = max_width.max(self.measure_host_line(host, line, slot, tracking));
                }
                return (max_width, lines * line_height);
            }
        }
        let font = self.font(slot);
        let mut max_width = 0.0_f32;
        let mut line_width = 0.0_f32;
        let mut lines = 1.0_f32;
        for character in text.chars() {
            if character == '\n' {
                max_width = max_width.max(line_width);
                line_width = 0.0;
                lines += 1.0;
            } else if character != '\r' {
                line_width += Self::advance_pak_or_fallback(slot, font, character as u32) + tracking;
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
const BASE_GUEST_HEAP_LIMIT: usize = 128 * 1024 * 1024;
/// A configured QuickJS limit must leave enough room for the runtime and
/// bridge bootstrap.  This is a configuration guard, not a promise about
/// process RSS or native/GPU allocations.
const MIN_CONFIGURED_HEAP_LIMIT_BYTES: u64 = 64 * 1024;
/// Keep the public constructor bounded on 32-bit and mobile targets.  The
/// value is intentionally capped at the public SDK contract's 2 GiB ceiling
/// rather than accepting an accidental near-`usize::MAX` allocation request.
const MAX_CONFIGURED_HEAP_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The configured admission ceiling is independent from the legacy local-file
/// loader's 256 MiB bound.  A caller may choose a larger policy ceiling while
/// still being subject to the existing package/file admission path.
const MAX_CONFIGURED_PAK_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

/// The QuickJS guest owns an immutable copy of `pak` as `globalThis.__pak`.
/// Keep the original script/DOM budget while reserving room for that package
/// copy; otherwise a valid image/font-heavy bundle can fail during mount with
/// only the opaque `RuntimeError::Guest` at the FFI boundary.
fn validate_memory_limits(
    heap_limit_bytes: u64,
    max_pak_bytes: u64,
) -> Result<MemoryLimits, String> {
    let heap_limit_bytes = if heap_limit_bytes == 0 {
        None
    } else {
        if heap_limit_bytes < MIN_CONFIGURED_HEAP_LIMIT_BYTES
            || heap_limit_bytes > MAX_CONFIGURED_HEAP_LIMIT_BYTES
        {
            return Err(format!(
                "memory_limits.heapLimitBytes must be 0 or between {} and {} bytes (got {})",
                MIN_CONFIGURED_HEAP_LIMIT_BYTES, MAX_CONFIGURED_HEAP_LIMIT_BYTES, heap_limit_bytes
            ));
        }
        Some(usize::try_from(heap_limit_bytes).map_err(|_| {
            format!(
                "memory_limits.heapLimitBytes {} does not fit in native usize",
                heap_limit_bytes
            )
        })?)
    };

    let max_pak_bytes = if max_pak_bytes == 0 {
        None
    } else {
        if max_pak_bytes > MAX_CONFIGURED_PAK_LIMIT_BYTES {
            return Err(format!(
                "memory_limits.maxPakBytes must be 0 or at most {} bytes (got {})",
                MAX_CONFIGURED_PAK_LIMIT_BYTES, max_pak_bytes
            ));
        }
        Some(usize::try_from(max_pak_bytes).map_err(|_| {
            format!(
                "memory_limits.maxPakBytes {} does not fit in native usize",
                max_pak_bytes
            )
        })?)
    };

    Ok(MemoryLimits {
        heap_limit_bytes,
        max_pak_bytes,
    })
}

fn guest_heap_limit(host: &HostState, pak_len: usize) -> Result<usize, String> {
    if let Some(max_pak_bytes) = host.memory_limits.max_pak_bytes {
        if pak_len > max_pak_bytes {
            return Err(format!(
                "pak admission: {} bytes exceeds memory_limits.maxPakBytes {}",
                pak_len, max_pak_bytes
            ));
        }
    }
    if let Some(heap_limit_bytes) = host.memory_limits.heap_limit_bytes {
        if pak_len > heap_limit_bytes {
            return Err(format!(
                "pak admission: {} bytes exceeds memory_limits.heapLimitBytes {} (configured heap includes __pak)",
                pak_len, heap_limit_bytes
            ));
        }
        return Ok(heap_limit_bytes);
    }
    BASE_GUEST_HEAP_LIMIT.checked_add(pak_len).ok_or_else(|| {
        format!(
            "legacy guest heap limit overflow for PAK of {} bytes",
            pak_len
        )
    })
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
    catch_ffi_unwind(ptr::null_mut(), || {
        pocket_create_with_memory_limits(width, height, 1, DEFAULT_TICK_HZ, 0, 0)
    })
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
    catch_ffi_unwind(ptr::null_mut(), || {
        pocket_create_with_memory_limits(width, height, raster_density, DEFAULT_TICK_HZ, 0, 0)
    })
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
    catch_ffi_unwind(ptr::null_mut(), || {
        pocket_create_with_memory_limits(width, height, raster_density, tick_hz, 0, 0)
    })
}

/// Create an engine instance with an immutable per-runtime memory policy.
///
/// `heap_limit_bytes` is the complete QuickJS heap budget, including the
/// package bytes exposed as `globalThis.__pak`. `max_pak_bytes` is an
/// admission ceiling checked before native package assets or a guest realm
/// are mounted. A zero value means that the corresponding policy is absent;
/// it never means an unlimited QuickJS heap. The legacy 16 MiB plus PAK
/// behavior is retained when both values are zero.
#[no_mangle]
pub extern "C" fn pocket_create_with_memory_limits(
    width: f64,
    height: f64,
    raster_density: u32,
    tick_hz: u32,
    heap_limit_bytes: u64,
    max_pak_bytes: u64,
) -> *mut HostState {
    catch_ffi_unwind(ptr::null_mut(), || {
        let memory_limits = match validate_memory_limits(heap_limit_bytes, max_pak_bytes) {
            Ok(memory_limits) => memory_limits,
            Err(error) => return create_error_host(width, height, error),
        };
        if !(1..=4).contains(&raster_density) {
            // Creation failures in this ABI return a destroyable opaque handle so
            // callers can retrieve the diagnostic through pocket_last_error. Build
            // a density-1 fallback only to carry that error; it must not escape as
            // a usable runtime because last_error is non-empty.
            return create_error_host(
                width,
                height,
                format!("raster density must be an integer from 1 through 4 (got {raster_density})"),
            );
        }
        if !(1..=MAX_HOST_TICK_HZ).contains(&tick_hz) {
            return create_error_host(
                width,
                height,
                format!(
                    "tick rate must be an integer from 1 through {MAX_HOST_TICK_HZ} (got {tick_hz})"
                ),
            );
        }
        create_host(width, height, raster_density, tick_hz, memory_limits)
    })
}

fn create_error_host(width: f64, height: f64, error: impl Into<String>) -> *mut HostState {
    let handle = create_host(width, height, 1, DEFAULT_TICK_HZ, MemoryLimits::default());
    if !handle.is_null() {
        unsafe { set_error(&mut *handle, error) };
    }
    handle
}

fn create_host(
    width: f64,
    height: f64,
    raster_density: u32,
    tick_hz: u32,
    memory_limits: MemoryLimits,
) -> *mut HostState {
    let width = width.max(1.0).min(65535.0) as u32;
    let height = height.max(1.0).min(65535.0) as u32;
    let text_metrics = Rc::new(RefCell::new(TextMetrics::default()));
    let guest_security = Rc::new(RefCell::new(guest_security::GuestSecurityState::default()));
    let (duplex, duplex_ingress_consumer) = new_duplex_channel();
    let mut ui = Ui::new_with_raster_density(raster_density);
    ui.set_native_rounded_rects(true);
    ui.set_viewport(width as f32, height as f32);
    // Native text mode makes the core emit TEXT_RUN records. Flutter decodes
    // those records with its own font system, so no platform view or native
    // text widget is involved in the POC.
    install_text_measure(&mut ui, text_metrics.clone());
    let _ = ui.set_tick_rate(tick_hz);
    let ops = OpContext::from_ui(ui);
    // This low-level embedding owns the complete retained UI engine. Physics
    // is local deterministic core work, not a platform permission/provider.
    // Enable its generated bindings before mounting the QuickJS realm; no
    // world is created or ticked until the guest explicitly requests one.
    // This host owns the Flutter compositor/texture bridge.  Enabling the
    // capability before mounting exposes ui.setCompositorSurface to JS and
    // causes Surface nodes to produce SURFACE_QUAD DrawOps.
    if let Err(error) = ops
        .set_physics_enabled(true)
        .and_then(|_| ops.set_compositor_enabled(true))
    {
        let (error_duplex, error_ingress_consumer) = new_duplex_channel();
        return Box::into_raw(Box::new(HostState {
            ops,
            guest: RquickjsGuest::new(BindingProfile::Canonical),
            memory_limits,
            guest_security: guest_security.clone(),
            nodes: Rc::new(RefCell::new(NodeRegistry::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            duplex: error_duplex,
            duplex_ingress_consumer: error_ingress_consumer,
            poisoned: false,
            last_error: format!("{error:?}"),
            error_output: c_string(&format!("{error:?}")),
            output: c_string("{}"),
            binary_output: Vec::new(),
            frame: 0,
            tick_hz,
            tick_remainder_ms: 0.0,
            clock_started: false,
            demand: demand::Demand::default(),
            trace: replay::TraceClock::default(),
            trace_output: c_string("{\"idleMs\":[],\"scalars\":[]}"),
            viewport_width: width as f32,
            viewport_height: height as f32,
            raster_density,
            auxiliary_viewport: None,
            compositor_surfaces: BTreeMap::new(),
            guest_loaded: false,
            worker_program: None,
            worker_runtime: None,
            worker_bridge: None,
            worker_trace: None,
            worker_instance: 0,
            offload: None,
            offload_output: c_string(""),
            offload_binary_output: Vec::new(),
            touches: Vec::new(),
            pending_touch_frames: Vec::new(),
            buttons: 0,
            analog: 0x8080,
            right_analog: 0x8080,
            axis_deltas: Vec::new(),
            motion: None,
            pending_text: Vec::new(),
            external_work_pending: false,
            text_metrics: text_metrics.clone(),
            sent_resources: HashMap::new(),
            frame_delta_v2_resource_base: HashMap::new(),
            draw_cache: None,
            frame_delta_v2_published: None,
            frame_json_cache: None,
            frame_json_serializations: 0,
            frame_json_serialized_bytes: 0,
            frame_json_cache_hits: 0,
            draw_decode_count: 0,
            last_stage_timings: NativeFrameStageTimingsUs::default(),
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
        heap_limit: memory_limits
            .heap_limit_bytes
            .unwrap_or(BASE_GUEST_HEAP_LIMIT),
        pak: &[],
        assets: None,
    };
    if let Err(error) = guest.initialize(ops.clone(), &env) {
        let (error_duplex, error_ingress_consumer) = new_duplex_channel();
        return Box::into_raw(Box::new(HostState {
            ops,
            guest,
            memory_limits,
            guest_security: guest_security.clone(),
            nodes: Rc::new(RefCell::new(NodeRegistry::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            duplex: error_duplex,
            duplex_ingress_consumer: error_ingress_consumer,
            poisoned: false,
            last_error: format!("{error:?}"),
            error_output: c_string(&format!("{error:?}")),
            output: c_string("{}"),
            binary_output: Vec::new(),
            frame: 0,
            tick_hz,
            tick_remainder_ms: 0.0,
            clock_started: false,
            demand: demand::Demand::default(),
            trace: replay::TraceClock::default(),
            trace_output: c_string("{\"idleMs\":[],\"scalars\":[]}"),
            viewport_width: width as f32,
            viewport_height: height as f32,
            raster_density,
            auxiliary_viewport: None,
            compositor_surfaces: BTreeMap::new(),
            guest_loaded: false,
            worker_program: None,
            worker_runtime: None,
            worker_bridge: None,
            worker_trace: None,
            worker_instance: 0,
            offload: None,
            offload_output: c_string(""),
            offload_binary_output: Vec::new(),
            touches: Vec::new(),
            pending_touch_frames: Vec::new(),
            buttons: 0,
            analog: 0x8080,
            right_analog: 0x8080,
            axis_deltas: Vec::new(),
            motion: None,
            pending_text: Vec::new(),
            external_work_pending: false,
            text_metrics: text_metrics.clone(),
            sent_resources: HashMap::new(),
            frame_delta_v2_resource_base: HashMap::new(),
            draw_cache: None,
            frame_delta_v2_published: None,
            frame_json_cache: None,
            frame_json_serializations: 0,
            frame_json_serialized_bytes: 0,
            frame_json_cache_hits: 0,
            draw_decode_count: 0,
            last_stage_timings: NativeFrameStageTimingsUs::default(),
        }));
    }
    let nodes = Rc::new(RefCell::new(NodeRegistry::new()));
    let outbound = Rc::new(RefCell::new(Vec::new()));
    let mut host = HostState {
        ops,
        guest,
        memory_limits,
        guest_security: guest_security.clone(),
        nodes: nodes.clone(),
        outbound: outbound.clone(),
        duplex,
        duplex_ingress_consumer,
        poisoned: false,
        last_error: String::new(),
        error_output: c_string(""),
        output: c_string("{}"),
        binary_output: Vec::new(),
        frame: 0,
        tick_hz,
        tick_remainder_ms: 0.0,
        clock_started: false,
        demand: demand::Demand::default(),
        trace: {
            let trace = replay::TraceClock::default();
            text_metrics.borrow_mut().trace_lane = Some(trace.scalar_lane());
            trace
        },
        trace_output: c_string("{\"idleMs\":[],\"scalars\":[]}"),
        viewport_width: width as f32,
        viewport_height: height as f32,
        raster_density,
        auxiliary_viewport: None,
        compositor_surfaces: BTreeMap::new(),
        guest_loaded: false,
        worker_program: None,
        worker_runtime: None,
        worker_bridge: None,
        worker_trace: None,
        worker_instance: 0,
        offload: None,
        offload_output: c_string(""),
        offload_binary_output: Vec::new(),
        touches: Vec::new(),
        pending_touch_frames: Vec::new(),
        buttons: 0,
        analog: 0x8080,
        right_analog: 0x8080,
        axis_deltas: Vec::new(),
        motion: None,
        pending_text: Vec::new(),
        external_work_pending: false,
        text_metrics: text_metrics.clone(),
        sent_resources: HashMap::new(),
        frame_delta_v2_resource_base: HashMap::new(),
        draw_cache: None,
        frame_delta_v2_published: None,
        frame_json_cache: None,
        frame_json_serializations: 0,
        frame_json_serialized_bytes: 0,
        frame_json_cache_hits: 0,
        draw_decode_count: 0,
        last_stage_timings: NativeFrameStageTimingsUs::default(),
    };
    if let Err(error) = install_bridge(
        &host.guest,
        host.ops.clone(),
        host.guest_security.clone(),
        nodes,
        outbound,
        host.duplex.clone(),
        auxiliary_descriptor(&host),
        &host.compositor_surfaces,
        host.offload.clone(),
        replay::mode(&host),
        host.trace.scalar_lane(),
        {
            let m = host.text_metrics.borrow();
            m.host_table.is_some() || m.fontless_pak
        },
    ) {
        set_error(&mut host, error);
    }
    Box::into_raw(Box::new(host))
}

/// Select the native external-clock trace mode before the first guest load or
/// eval.  0 is live (the default), 1 records actual idle elapsed time, and 2
/// replays intervals/scalars supplied by `pocket_trace_clock_begin_json`.
fn refresh_trace_hooks(host: &HostState) -> Result<(), String> {
    let mode = replay::mode(host);
    let lane = host.trace.scalar_lane();
    host.guest
        .with(|ctx| {
            replay::install_scalar_hooks(&ctx, mode, lane)
                .map_err(|error| quickjs_error(&ctx, error))
        })
        .ok_or_else(|| "guest context is not initialized".to_owned())?
}

/// Configure the optional production guest policy exactly once, before the
/// first source/bytecode evaluation. The policy itself is retained across
/// reloads; only the sticky fatal marker and live node IDs are reset per
/// realm generation.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_guest_security(
    handle: *mut HostState,
    config_json: *const c_char,
) -> i32 {
    guard_host_mut(handle, "pocket_configure_guest_security", -1, |host| {
        if host.guest_loaded {
            set_error(
                host,
                "guest security policy must be configured before guest load/eval",
            );
            return -1;
        }
        if config_json.is_null() {
            set_error(host, "null guest security config");
            return -1;
        }
        if host.guest_security.borrow().configured {
            set_error(host, "guest security policy is already configured");
            return -1;
        }
        let config = match guest_security::parse_config(CStr::from_ptr(config_json).to_bytes()) {
            Ok(config) => config,
            Err(error) => {
                set_error(host, error);
                return -1;
            }
        };
        let install = match host.guest.with(|ctx| -> rquickjs::Result<()> {
            if config.harden_builtins {
                guest_security::install_hardening(&ctx)?;
            }
            if let Some(max_nodes) = config.max_nodes {
                guest_security::install_node_quota(
                    &ctx,
                    host.ops.clone(),
                    host.guest_security.clone(),
                    max_nodes,
                )?;
            }
            Ok(())
        }) {
            Some(result) => result.map_err(|error| format!("{error}")),
            None => Err("guest context is not initialized".to_owned()),
        };
        if let Err(error) = install {
            set_error(host, format!("guest security install: {error}"));
            return -1;
        }
        {
            let mut state = host.guest_security.borrow_mut();
            state.configured = true;
            state.harden_builtins = config.harden_builtins;
            state.max_nodes = config.max_nodes;
            state.max_draw_ops = config.max_draw_ops;
            state.fatal = None;
            state.node_ids.clear();
        }
        clear_error(host);
        0
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_trace_clock_mode(handle: *mut HostState, mode: u32) -> i32 {
    guard_host_mut(handle, "pocket_trace_clock_mode", -1, |host| {
        let was_replay = replay::is_replay(host);
        match replay::set_mode(host, mode).and_then(|()| {
            if was_replay && mode == 0 {
                demand::leave_replay(host);
            }
            refresh_trace_hooks(host)
        }) {
            Ok(()) => {
                clear_error(host);
                0
            }
            Err(error) => {
                set_error(host, error);
                -1
            }
        }
    })
}

/// Begin one host FFI transaction with an ordered trace envelope, for example
/// `{"idleMs":[12.5,0],"scalars":[{"kind":"mathRandom","value":0.25}]}`.
/// A legacy bare idle array is accepted. Record/live mode intentionally
/// ignores the payload. Replay validates and consumes each value in order.
#[no_mangle]
pub unsafe extern "C" fn pocket_trace_clock_begin_json(
    handle: *mut HostState,
    intervals: *const c_char,
) -> i32 {
    guard_host_mut(handle, "pocket_trace_clock_begin_json", -1, |host| {
        let Some(intervals) = intervals.as_ref() else {
            set_error(host, "null trace clock begin JSON");
            return -1;
        };
        let intervals = match CStr::from_ptr(intervals).to_str() {
            Ok(intervals) => intervals,
            Err(_) => {
                set_error(host, "trace clock begin JSON must be UTF-8");
                return -1;
            }
        };
        match replay::begin_json(host, intervals) {
            Ok(()) => {
                clear_error(host);
                0
            }
            Err(error) => {
                set_error(host, error);
                -1
            }
        }
    })
}

/// End one host FFI transaction and return its ordered trace envelope as a
/// borrowed NUL-terminated UTF-8 string. The pointer remains valid until the
/// next trace-clock JSON call or host destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_trace_clock_end_json(handle: *mut HostState) -> *const c_char {
    guard_host_mut(handle, "pocket_trace_clock_end_json", ptr::null(), |host| {
        match replay::end_json(host) {
            Ok(json) => {
                host.trace_output = c_string(&json);
                clear_error(host);
                host.trace_output.as_ptr()
            }
            Err(error) => {
                set_error(host, error);
                ptr::null()
            }
        }
    })
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
    guard_host_mut(handle, "pocket_resize_viewport", -1, |host| {
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
            demand::before_external(host)?;
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
            // Keep frame_delta_v2_published so the caller can echo the last frame
            // sequence and acknowledge its resource ledger even though the next
            // packet must be a full frame (draw_cache is gone).
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
            dispatch_guest_json(&host.guest, "__pocketEvent", &event, None)?;
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
    })
}

/// Register a trusted asynchronous offload provider before guest evaluation.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_offload(
    handle: *mut HostState,
    config: *const c_char,
    notify: Option<unsafe extern "C" fn()>,
) -> i32 {
    guard_host_mut(handle, "pocket_configure_offload", -1, |host| {
        let result = (|| -> Result<Arc<offload::OffloadHost>, String> {
            if host.guest_loaded || host.offload.is_some() || config.is_null() {
                return Err("offload provider must be configured once before evaluation".into());
            }
            let bytes = CStr::from_ptr(config).to_bytes();
            if bytes.len() > 16384 {
                return Err("offload config exceeds 16 KiB".into());
            }
            let config: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            let number = |field: &str| {
                config[field]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .filter(|v| *v > 0)
                    .ok_or_else(|| format!("invalid offload {field}"))
            };
            let generation = number("generation")?;
            let session = number("session")?;
            let timeout = number("timeoutMs")?;
            if timeout > 60000 {
                return Err("offload timeout exceeds 60s".into());
            }
            let methods: Vec<String> =
                serde_json::from_value(config["methods"].clone()).map_err(|e| e.to_string())?;
            if methods.is_empty()
                || methods.len() > 64
                || methods.iter().any(|s| {
                    s.is_empty()
                        || s.len() > 64
                        || !s.bytes().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c)
                        })
                })
            {
                return Err("invalid offload method allowlist".into());
            }
            let timeout = std::time::Duration::from_millis(timeout as u64);
            Ok(if let Some(trace) = ensure_async_trace(host)? {
                offload::OffloadHost::new_traced(
                    generation,
                    session,
                    timeout,
                    methods,
                    if replay::is_replay(host) {
                        None
                    } else {
                        notify
                    },
                    trace,
                    format!("offload:{generation}"),
                )
            } else {
                offload::OffloadHost::new(generation, session, timeout, methods, notify)
            })
        })();
        match result {
            Ok(provider) => {
                let installed = host
                    .guest
                    .with(|ctx| offload::OffloadHost::install(ctx, provider.clone(), None));
                match installed {
                    Some(Ok(())) => {
                        host.offload = Some(provider);
                        clear_error(host);
                        0
                    }
                    _ => {
                        provider.shutdown();
                        set_error(host, "offload UI installation failed");
                        -1
                    }
                }
            }
            Err(e) => {
                set_error(host, e);
                -1
            }
        }
    })
}

/// Pop one bounded provider request/cancellation on the UI owner thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_take(
    handle: *mut HostState,
    cancelled: u32,
) -> *const c_char {
    guard_host_mut(handle, "pocket_offload_take", ptr::null(), |host| {
        let Some(provider) = &host.offload else {
            return ptr::null();
        };
        let request = if cancelled == 0 {
            provider.take_request()
        } else {
            provider.take_cancellation()
        };
        let Some(request) = request else {
            return ptr::null();
        };
        host.offload_output = c_string(&serde_json::json!({
            "generation":request.generation,"session":request.session,"id":request.id,
            "method":request.method,"payload":request.payload,"timeoutMicros":request.timeout.as_micros() as u64,
        }).to_string());
        host.offload_output.as_ptr()
    })
}

/// Binary counterpart of `pocket_offload_take`. Returns a borrowed `0xB2`
/// binary record until the next offload take call on the same host.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_take_binary(
    handle: *mut HostState,
    cancelled: u32,
    out_byte_length: *mut u64,
) -> *const u8 {
    catch_ffi_unwind(ptr::null(), || {
        if let Some(length) = out_byte_length.as_mut() {
            *length = 0;
        }
        let ptr = guard_host_mut(handle, "pocket_offload_take_binary", ptr::null(), |host| {
            let Some(provider) = &host.offload else {
                return ptr::null();
            };
            let request = if cancelled == 0 {
                provider.take_request()
            } else {
                provider.take_cancellation()
            };
            let Some(request) = request else {
                return ptr::null();
            };
            host.offload_binary_output = binary_bridge::encode_offload_request(&request);
            if let Some(length) = out_byte_length.as_mut() {
                *length = host.offload_binary_output.len() as u64;
            }
            host.offload_binary_output.as_ptr()
        });
        if ptr.is_null() {
            if let Some(length) = out_byte_length.as_mut() {
                *length = 0;
            }
        }
        ptr
    })
}

/// Observe native replies without consuming them. No periodic probe is used;
/// Dart checks this only while handling a native provider notification.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_has_replies(handle: *const HostState) -> u32 {
    guard_host_ref(handle, 0, |host| {
        host.offload
            .as_ref()
            .map(|provider| u32::from(provider.has_replies()))
            .unwrap_or(0)
    })
}

/// Completion is generation/session/id scoped; stale or duplicate results fail.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_complete(
    handle: *mut HostState,
    record: *const c_char,
) -> i32 {
    guard_host_mut(handle, "pocket_offload_complete", -1, |host| {
        let Some(provider) = &host.offload else {
            return -1;
        };
        if record.is_null() {
            return -1;
        }
        let bytes = CStr::from_ptr(record).to_bytes();
        if bytes.len() > 16384 {
            return -1;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return -1;
        };
        let Some(generation) = value["generation"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
        else {
            return -1;
        };
        let Some(session) = value["session"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
        else {
            return -1;
        };
        let Some(id) = value["id"].as_u64() else {
            return -1;
        };
        let result = match (value["payload"].as_str(), value["error"].as_str()) {
            (Some(payload), None) => Ok(payload.to_owned()),
            (None, Some(error)) => Err(error.to_owned()),
            _ => return -1,
        };
        if provider.complete(generation, session, id, result) {
            0
        } else {
            -1
        }
    })
}

/// Binary counterpart of `pocket_offload_complete`. Accepts a `0xB2` binary
/// completion record without intermediate JSON envelope encoding.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_complete_binary(
    handle: *mut HostState,
    record: *const u8,
    record_len: usize,
) -> i32 {
    guard_host_mut(handle, "pocket_offload_complete_binary", -1, |host| {
        let Some(provider) = &host.offload else {
            return -1;
        };
        if record.is_null() || record_len == 0 || record_len > 16384 {
            return -1;
        }
        let bytes = std::slice::from_raw_parts(record, record_len);
        let Some((generation, session, id, result)) = binary_bridge::decode_offload_completion(bytes)
        else {
            return -1;
        };
        if provider.complete(generation, session, id, result) {
            0
        } else {
            -1
        }
    })
}

/// Install a trusted application-to-surface registry before evaluation.
/// JS selects layout/focus with official CompositorSurface nodes; guest code
/// cannot register application packages through the dynamic texture bridge.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_compositor(
    handle: *mut HostState,
    registry: *const c_char,
) -> i32 {
    guard_host_mut(handle, "pocket_configure_compositor", -1, |host| {
        if host.guest_loaded || registry.is_null() {
            set_error(
                host,
                "compositor registry must be configured before guest load",
            );
            return -1;
        }
        let result = (|| -> Result<BTreeMap<String, i32>, String> {
            let bytes = CStr::from_ptr(registry).to_bytes();
            if bytes.len() > 16384 {
                return Err("compositor registry exceeds 16 KiB".into());
            }
            let map: BTreeMap<String, i32> =
                serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            if map.len() > 62 {
                return Err("too many compositor applications".into());
            }
            let mut handles = HashSet::new();
            for (id, handle) in &map {
                if id.is_empty()
                    || id.len() > 128
                    || !id.as_bytes()[0].is_ascii_alphanumeric()
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                    || id == POCKET_FLUTTER_SURFACE_PACKAGE
                    || !(2..=63).contains(handle)
                    || !handles.insert(*handle)
                {
                    return Err("invalid or duplicate compositor application handle".into());
                }
            }
            Ok(map)
        })();
        match result {
            Ok(map) => {
                if !host.compositor_surfaces.is_empty() && host.compositor_surfaces != map {
                    set_error(host, "compositor registry is already configured");
                    return -1;
                }
                let result = host
                    .guest
                    .with(|ctx| install_compositor_apps(&ctx, &host.nodes, &map));
                match result {
                    Some(Ok(())) => {
                        host.compositor_surfaces = map;
                        clear_error(host);
                        0
                    }
                    Some(Err(e)) => {
                        set_error(host, e.to_string());
                        -1
                    }
                    None => {
                        set_error(host, "guest context is not initialized");
                        -1
                    }
                }
            }
            Err(e) => {
                set_error(host, e);
                -1
            }
        }
    })
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
    guard_host_mut(handle, "pocket_enable_auxiliary", -1, |host| {
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
        host.frame_delta_v2_published = None;
        host.frame_json_cache = None;
        let environment = match guest_environment(host, &[], None) {
            Ok(environment) => environment,
            Err(error) => {
                set_error(host, error);
                return -1;
            }
        };
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
            host.guest_security.clone(),
            host.nodes.clone(),
            host.outbound.clone(),
            host.duplex.clone(),
            auxiliary_descriptor(host),
            &host.compositor_surfaces,
            host.offload.clone(),
            replay::mode(host),
            host.trace.scalar_lane(),
        {
            let m = host.text_metrics.borrow();
            m.host_table.is_some() || m.fontless_pak
        },
        ) {
            set_error(host, error);
            return -1;
        }
        clear_error(host);
        0
    })
}

const MAX_SCRIPT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BYTECODE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn package_file_limit(host: &HostState) -> u64 {
    let policy = host.memory_limits;
    MAX_PACKAGE_FILE_BYTES
        .min(policy.max_pak_bytes.map_or(u64::MAX, |value| value as u64))
        .min(
            policy
                .heap_limit_bytes
                .map_or(u64::MAX, |value| value as u64),
        )
}

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
    stop_worker(host);
    guest_security::reset_runtime(&host.guest_security);
    // The new package is admitted before this reset. Retain its static texture
    // metadata while dropping the prior guest's transient host registrations.
    host.nodes.borrow_mut().write().retain(|node| node.from_pack);
    // A reload is a channel-generation boundary. Never clear cursors in an
    // Arc that may still be borrowed by a background Dart isolate.
    host.duplex.close();
    let (duplex, ingress_consumer) = new_duplex_channel();
    host.duplex = duplex;
    host.duplex_ingress_consumer = ingress_consumer;
    host.touches.clear();
    host.pending_touch_frames.clear();
    host.buttons = 0;
    host.analog = 0x8080;
    host.right_analog = 0x8080;
    host.axis_deltas.clear();
    host.motion = None;
    host.pending_text.clear();
    host.external_work_pending = false;
    host.outbound.borrow_mut().clear();
    // Keep the last published keys until the next frame computes releases.
    // That frame compares the new DrawList and generation-tagged core handles
    // against this set, so a guest reload retires old decoded images (including
    // glyph pages) through the same resource lifecycle as ordinary frames.
    host.draw_cache = None;
    host.frame_delta_v2_published = None;
    host.frame_json_cache = None;
    host.frame = 0;
    host.tick_remainder_ms = 0.0;
    host.clock_started = false;
    host.demand = demand::Demand::default();
    host.text_metrics.borrow().clear_caches();
}

fn install_host_assets(host: &mut HostState, pak: &[u8]) -> Result<AssetRegistry, String> {
    // Use the runtime's atomic package admission rather than merely exposing
    // bytes to JS. This installs styles/font atlases and uploads every
    // `ui:img.*` entry in the real core, then publishes the resulting name ->
    // texture handle table to framework/host.
    let metrics = parse_pak_font_metrics(pak)?;
    if metrics.fonts.is_empty() && host.text_metrics.borrow().host_table.is_none() {
        return Err(
            "pak admission: package contains no baked ui:font.* atlases and host font metrics are not installed"
                .to_owned(),
        );
    }
    let mut previous_pack_handles = host
        .nodes
        .borrow()
        .iter()
        .filter(|node| node.from_pack)
        .map(|node| node.texture)
        .collect::<Vec<_>>();
    previous_pack_handles.sort_unstable();
    previous_pack_handles.dedup();
    let assets: AssetRegistry = host
        .ops
        .install_assets(pak)
        .map_err(|error| format!("pak asset install: {error:?}"))?;
    let use_host_or_fontless = {
        let mut current = host.text_metrics.borrow_mut();
        current.fontless_pak = metrics.fonts.is_empty();
        current.fonts = metrics.fonts;
        current.host_table.is_some() || current.fontless_pak
    };
    {
        let mut core = host
            .ops
            .core_mut()
            .map_err(|error| format!("font measure install: {error:?}"))?;
        // A fresh guest realm cannot reuse the previous realm's retained
        // Core tree. Clear only guest UI children after the new package has
        // been admitted, then retire old PAK handles through the Core API;
        // free_texture preserves any texture storage pinned by an in-flight
        // Core submission until its frame fence retires.
        let roots = [pocket_spec::ROOT_ID, core.ui.auxiliary_surface_root()];
        for root in roots {
            if root == 0 {
                continue;
            }
            let children = core.ui.node_children(root).to_vec();
            for child in children {
                core.ui.destroy_node(child);
            }
        }
        for texture in previous_pack_handles {
            core.ui.free_texture(texture);
        }
        core.ui.set_native_transformed_text(use_host_or_fontless);
        install_text_measure(&mut core.ui, host.text_metrics.clone());
    }
    {
        let mut registry = host.nodes.borrow_mut();
        let nodes = registry.write();
        nodes.retain(|node| !node.from_pack);
        for (index, texture) in assets.textures.iter().enumerate() {
            nodes.push(NodeMeta {
                id: i32::MIN.saturating_add(index as i32),
                kind: "image".to_owned(),
                asset: texture.name.clone(),
                surface_kind: String::new(),
                surface_parameters: Vec::new(),
                video_id: String::new(),
                fit: "cover".to_owned(),
                autoplay: true,
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
                surface_kind: String::new(),
                surface_parameters: Vec::new(),
                video_id: String::new(),
                fit: "cover".to_owned(),
                autoplay: true,
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
    let environment = guest_environment(host, pak, Some(assets))?;
    host.guest
        .initialize(host.ops.clone(), &environment)
        .map_err(|error| {
            let detail = host.guest.last_error().unwrap_or("no guest detail");
            format!("guest reinitialize: {error:?}: {detail}")
        })?;
    install_bridge(
        &host.guest,
        host.ops.clone(),
        host.guest_security.clone(),
        host.nodes.clone(),
        host.outbound.clone(),
        host.duplex.clone(),
        auxiliary_descriptor(host),
        &host.compositor_surfaces,
        host.offload.clone(),
        replay::mode(host),
        host.trace.scalar_lane(),
        {
            let m = host.text_metrics.borrow();
            m.host_table.is_some() || m.fontless_pak
        },
    )?;
    start_worker(host)
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
    guard_host_mut(handle, "pocket_load_files", -1, |host| {
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
                package_file_limit(host),
                "guest PAK",
            )?;
            Ok::<_, String>((source, pak))
        })();
        match result {
            Ok((source, pak)) => {
                pocket_load_inner(host, source.as_ptr(), pak.as_ptr(), pak.len())
            }
            Err(error) => {
                set_error(host, error);
                -1
            }
        }
    })
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
/// A successful source package reload may replace the guest on the same
/// non-offload handle. Package admission completes before the current guest is
/// reset, and the old guest tree and PAK textures are retired after admission;
/// an offload guest reload still requires a fresh native runtime generation.
#[no_mangle]
pub unsafe extern "C" fn pocket_load(
    handle: *mut HostState,
    source: *const c_char,
    pak: *const u8,
    pak_len: usize,
) -> i32 {
    guard_host_mut(handle, "pocket_load", -1, |host| {
        pocket_load_inner(host, source, pak, pak_len)
    })
}

unsafe fn pocket_load_inner(
    host: &mut HostState,
    source: *const c_char,
    pak: *const u8,
    pak_len: usize,
) -> i32 {
    if host.guest_loaded && host.offload.is_some() {
        set_error(
            host,
            "offload guest reload requires a fresh native runtime generation",
        );
        return -1;
    }
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
        // Admit against the immutable runtime policy before resetting the
        // current guest or installing any native package assets. A rejected
        // reload therefore leaves the existing realm and frame state intact.
        let _ = guest_heap_limit(host, pak.len())?;
        let assets = install_host_assets(host, pak)?;
        reset_host_for_load(host);
        initialize_guest_for_load(host, pak, &assets)?;
        evaluate_guest(&mut host.guest, &source, host.tick_hz)?;
        ensure_guest_security_healthy(host)
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
            stop_worker(host);
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
    guard_host_mut(handle, "pocket_load_bytecode", -1, |host| {
        pocket_load_bytecode_inner(host, bytecode, bytecode_len, pak, pak_len)
    })
}

unsafe fn pocket_load_bytecode_inner(
    host: &mut HostState,
    bytecode: *const u8,
    bytecode_len: usize,
    pak: *const u8,
    pak_len: usize,
) -> i32 {
    if host.guest_loaded && host.offload.is_some() {
        set_error(
            host,
            "offload guest reload requires a fresh native runtime generation",
        );
        return -1;
    }
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
        // Keep package admission before reset/asset mount for bytecode loads as
        // well; reloads must preserve the configured policy and old realm on
        // an oversized package.
        let _ = guest_heap_limit(host, pak.len())?;
        let assets = install_host_assets(host, pak)?;
        reset_host_for_load(host);
        initialize_guest_for_load(host, pak, &assets)?;
        host.guest
            .evaluate_bytecode(artifact.payload, host.tick_hz)
            .map_err(|error| {
                let detail = host.guest.last_error().unwrap_or("no guest detail");
                format!("guest bytecode evaluate: {error:?}: {detail}")
            })?;
        ensure_guest_security_healthy(host)
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
            stop_worker(host);
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
    guard_host_mut(handle, "pocket_load_bytecode_files", -1, |host| {
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
                package_file_limit(host),
                "guest PAK",
            )?;
            Ok::<_, String>((bytecode, pak))
        })();
        match result {
            Ok((bytecode, pak)) => pocket_load_bytecode_inner(
                host,
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
    })
}

/// ABI string embedded in bytecode metadata and package manifests. It is
/// process-static, so callers may compare it without owning or freeing the
/// returned pointer.
#[no_mangle]
pub extern "C" fn pocket_bytecode_runtime_abi() -> *const c_char {
    catch_ffi_unwind(ptr::null(), || {
        static ABI: std::sync::OnceLock<CString> = std::sync::OnceLock::new();
        ABI.get_or_init(|| c_string(&bytecode::runtime_abi()))
            .as_ptr()
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_eval(handle: *mut HostState, source: *const c_char) -> i32 {
    guard_host_mut(handle, "pocket_eval", -1, |host| {
        if host.guest_loaded && host.offload.is_some() {
            set_error(
                host,
                "offload guest reload requires a fresh native runtime generation",
            );
            return -1;
        }
        let Some(source) = source.as_ref() else {
            set_error(host, "null source");
            return -1;
        };
        let source = CStr::from_ptr(source).to_string_lossy();
        if let Err(error) = demand::before_external(host) {
            set_error(host, error);
            return -1;
        }
        if let Err(error) = start_worker(host) {
            set_error(host, error);
            return -1;
        }
        match evaluate_guest(&mut host.guest, &source, host.tick_hz) {
            Ok(()) => {
                if let Some(error) = guest_security_fatal(host) {
                    stop_worker(host);
                    host.outbound.borrow_mut().clear();
                    set_error(host, error);
                    return -1;
                }
                host.guest_loaded = true;
                host.draw_cache = None;
                host.frame_json_cache = None;
                clear_error(host);
                0
            }
            Err(error) => {
                // A failed evaluation is not a frame boundary. Do not deliver
                // requests emitted by partially executed JS on a later frame.
                stop_worker(host);
                host.outbound.borrow_mut().clear();
                set_error(host, error);
                -1
            }
        }
    })
}

fn frame_has_no_transient_data(frame: &BuiltFrame) -> bool {
    frame.result.events.is_empty()
        && frame.result.resources.is_empty()
        && frame.result.released_resources.is_empty()
}

fn publish_frame_sequence(host: &mut HostState, frame: u64) {
    host.frame_delta_v2_published = Some(frame);
}

#[derive(Serialize)]
struct CompactFrameResource<'a> {
    asset: &'a str,
    revision: u64,
    width: u32,
    height: u32,
    psm: u32,
    linear: bool,
    #[serde(rename = "bytesEncoding")]
    bytes_encoding: &'static str,
    pixels: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    palette: Option<String>,
}

impl<'a> From<&'a FrameResource> for CompactFrameResource<'a> {
    fn from(resource: &'a FrameResource) -> Self {
        use base64::Engine;
        Self {
            asset: &resource.asset,
            revision: resource.revision,
            width: resource.width,
            height: resource.height,
            psm: resource.psm,
            linear: resource.linear,
            bytes_encoding: "base64",
            pixels: base64::engine::general_purpose::STANDARD.encode(&resource.pixels),
            palette: resource
                .palette
                .as_ref()
                .map(|palette| base64::engine::general_purpose::STANDARD.encode(palette)),
        }
    }
}

#[derive(Serialize)]
struct CompactFrameResult<'a> {
    frame: u64,
    width: f32,
    height: f32,
    #[serde(serialize_with = "serialize_rc_ops")]
    ops: &'a Rc<Vec<FrameOp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auxiliary: &'a Option<SurfaceFrame>,
    events: &'a [OutboundEvent],
    resources: Vec<CompactFrameResource<'a>>,
    #[serde(rename = "releasedResources", skip_serializing_if = "Vec::is_empty")]
    released_resources: &'a Vec<String>,
}

/// Serialize a complete frame for both the legacy ABI and the delta ABI's
/// changed-frame fallback. Both entry points therefore consume the same
/// BuiltFrame and drain the same events/resources.
fn complete_frame_output(
    host: &mut HostState,
    built: BuiltFrame,
    compact_resources: bool,
) -> *const c_char {
    let is_static = frame_has_no_transient_data(&built);
    if built.draw_cache_hit && is_static {
        if let Some(cached) = host.frame_json_cache.as_deref() {
            if let Some(json) = patch_frame_number(cached, built.result.frame) {
                host.frame_json_cache_hits = host.frame_json_cache_hits.wrapping_add(1);
                publish_frame_sequence(host, built.result.frame);
                clear_error(host);
                host.output = json;
                return host.output.as_ptr();
            }
        }
    }
    let frame = built.result;
    let encoded = if compact_resources && !frame.resources.is_empty() {
        let compact = CompactFrameResult {
            frame: frame.frame,
            width: frame.width,
            height: frame.height,
            ops: &frame.ops,
            auxiliary: &frame.auxiliary,
            events: &frame.events,
            resources: frame
                .resources
                .iter()
                .map(CompactFrameResource::from)
                .collect(),
            released_resources: &frame.released_resources,
        };
        serde_json::to_string(&compact)
    } else {
        serde_json::to_string(&frame)
    };
    match encoded {
        Ok(json) => {
            host.frame_json_serializations = host.frame_json_serializations.wrapping_add(1);
            host.frame_json_serialized_bytes = host
                .frame_json_serialized_bytes
                .wrapping_add(json.len() as u64);
            if is_static {
                host.frame_json_cache = Some(json.clone());
            }
            publish_frame_sequence(host, frame.frame);
            clear_error(host);
            host.output = c_string(&json);
        }
        Err(error) => {
            host.frame_delta_v2_published = None;
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
    // A failed build/serialization may already have mutated the retained core
    // or cache. Do not let a later v2 call splice that unpublished state
    // against the caller's last successful sequence; force a fresh PFB1
    // baseline instead.
    host.frame_delta_v2_published = None;
    host.frame_json_cache = None;
    set_error(host, error);
    let fallback = empty_frame_json(host);
    host.output = c_string(&fallback);
    host.output.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn pocket_frame(handle: *mut HostState, delta_ms: f64) -> *const c_char {
    guard_host_mut(handle, "pocket_frame", ptr::null(), |host| {
        match build_frame(host, delta_ms, false, false) {
            Ok(built) => complete_frame_output(host, built, false),
            Err(error) => failed_frame_output(host, error),
        }
    })
}

/// Rust-only probe entry point that shares `pocket_frame`'s single
/// `build_frame` execution and `complete_frame_output` cache/error path while
/// optionally serializing `FrameResource` pixel/palette buffers as lossless
/// base64 strings (`bytesEncoding: "base64"`).
pub unsafe fn pocket_frame_for_probe_json(
    handle: *mut HostState,
    delta_ms: f64,
    compact_resources: bool,
) -> *const c_char {
    guard_host_mut(handle, "pocket_frame", ptr::null(), |host| {
        match build_frame(host, delta_ms, false, false) {
            Ok(built) => complete_frame_output(host, built, compact_resources),
            Err(error) => failed_frame_output(host, error),
        }
    })
}

/// Opaque ABI v2 endpoint. The normal host endpoint owns both external SPSC
/// roles (Dart ingress producer and Dart egress consumer). Advanced background
/// isolates can attach a single role to a retained channel handle instead.
/// There is no MPMC endpoint: each role can be claimed once per generation.
/// An endpoint role is thread/isolate-affine; the two independent roles may
/// run concurrently, but one role must not be called concurrently by two
/// threads. A returned payload pointer is borrowed until its matching
/// publish/consume and must not be retained afterwards.
pub struct DuplexEndpoint {
    ingress: Option<duplex::IngressProducer>,
    egress: Option<duplex::EgressConsumer>,
}

unsafe fn clone_duplex_channel(
    channel: *const duplex::DuplexRing,
) -> Option<Arc<duplex::DuplexRing>> {
    if channel.is_null() {
        return None;
    }
    // The caller owns one strong count from pocket_duplex_channel_acquire or
    // pocket_duplex_channel_retain. Clone that count before constructing a
    // temporary Arc, leaving the caller's count untouched.
    Arc::increment_strong_count(channel);
    Some(Arc::from_raw(channel))
}

/// Acquire an independent strong channel reference. It remains valid after
/// `pocket_destroy`; release it with `pocket_duplex_channel_release`.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_acquire(
    handle: *mut HostState,
) -> *const duplex::DuplexRing {
    guard_host_mut(handle, "pocket_duplex_channel_acquire", ptr::null(), |host| {
        Arc::into_raw(host.duplex.clone())
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_retain(
    channel: *const duplex::DuplexRing,
) -> *const duplex::DuplexRing {
    catch_ffi_unwind(ptr::null(), || {
        if channel.is_null() {
            return ptr::null();
        }
        Arc::increment_strong_count(channel);
        channel
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_release(channel: *const duplex::DuplexRing) {
    catch_ffi_unwind((), || {
        if !channel.is_null() {
            Arc::decrement_strong_count(channel);
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_close(channel: *const duplex::DuplexRing) {
    catch_ffi_unwind((), || {
        if let Some(channel) = channel.as_ref() {
            channel.close();
        }
    })
}

unsafe fn attach_duplex_endpoint(
    channel: *const duplex::DuplexRing,
    ingress: bool,
    egress: bool,
) -> *mut DuplexEndpoint {
    let Some(channel) = clone_duplex_channel(channel) else {
        return ptr::null_mut();
    };
    make_duplex_endpoint(channel, ingress, egress)
}

fn make_duplex_endpoint(
    channel: Arc<duplex::DuplexRing>,
    ingress: bool,
    egress: bool,
) -> *mut DuplexEndpoint {
    let ingress_endpoint = if ingress {
        let Some(endpoint) = channel.claim_ingress_producer() else {
            return ptr::null_mut();
        };
        Some(endpoint)
    } else {
        None
    };
    let egress_endpoint = if egress {
        let Some(endpoint) = channel.claim_egress_consumer() else {
            return ptr::null_mut();
        };
        Some(endpoint)
    } else {
        None
    };
    Box::into_raw(Box::new(DuplexEndpoint {
        ingress: ingress_endpoint,
        egress: egress_endpoint,
    }))
}

/// Acquire the normal combined endpoint for the host's current channel
/// generation. The endpoint retains the channel independently of HostState.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_endpoint_acquire(
    handle: *mut HostState,
) -> *mut DuplexEndpoint {
    guard_host_mut(handle, "pocket_duplex_endpoint_acquire", ptr::null_mut(), |host| {
        make_duplex_endpoint(host.duplex.clone(), true, true)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_attach_ingress_producer(
    channel: *const duplex::DuplexRing,
) -> *mut DuplexEndpoint {
    catch_ffi_unwind(ptr::null_mut(), || attach_duplex_endpoint(channel, true, false))
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_attach_egress_consumer(
    channel: *const duplex::DuplexRing,
) -> *mut DuplexEndpoint {
    catch_ffi_unwind(ptr::null_mut(), || attach_duplex_endpoint(channel, false, true))
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_endpoint_release(endpoint: *mut DuplexEndpoint) {
    catch_ffi_unwind((), || {
        if !endpoint.is_null() {
            drop(Box::from_raw(endpoint));
        }
    })
}

/// Reserve a contiguous ingress batch. On success the returned pointer points
/// into native-owned slots; the same endpoint must publish exactly `out_count`
/// records. Dart never reads or writes an atomic cursor. The returned pointer
/// is borrowed until `pocket_duplex_ingress_publish`.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_ingress_reserve(
    endpoint: *mut DuplexEndpoint,
    max_count: u32,
    out_count: *mut u32,
) -> *mut u8 {
    catch_ffi_unwind(ptr::null_mut(), || {
        if endpoint.is_null() || out_count.is_null() {
            return ptr::null_mut();
        }
        *out_count = 0;
        let Some(producer) = (*endpoint).ingress.as_ref() else {
            return ptr::null_mut();
        };
        let Some(reservation) = producer.reserve(max_count) else {
            return ptr::null_mut();
        };
        let Some(payload) = producer.payload_ptr(reservation) else {
            return ptr::null_mut();
        };
        *out_count = reservation.count();
        payload
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_ingress_publish(
    endpoint: *mut DuplexEndpoint,
    count: u32,
) -> i32 {
    catch_ffi_unwind(-1, || {
        if endpoint.is_null() {
            return -1;
        }
        let Some(producer) = (*endpoint).ingress.as_ref() else {
            return -2;
        };
        producer.commit_count(count) as i32
    })
}

/// Return a contiguous egress batch. The pointer remains valid until this
/// endpoint consumes exactly the returned count; no producer can overwrite it
/// before that Release cursor store. A second peek before consume is rejected
/// so a new span cannot invalidate the existing borrow.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_egress_peek(
    endpoint: *mut DuplexEndpoint,
    max_count: u32,
    out_count: *mut u32,
) -> *const u8 {
    catch_ffi_unwind(ptr::null(), || {
        if endpoint.is_null() || out_count.is_null() {
            return ptr::null();
        }
        *out_count = 0;
        let Some(consumer) = (*endpoint).egress.as_ref() else {
            return ptr::null();
        };
        let Some((payload, count)) = consumer.peek(max_count) else {
            return ptr::null();
        };
        *out_count = count;
        payload
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_egress_consume(
    endpoint: *mut DuplexEndpoint,
    count: u32,
) -> i32 {
    catch_ffi_unwind(-1, || {
        if endpoint.is_null() {
            return -1;
        }
        let Some(consumer) = (*endpoint).egress.as_ref() else {
            return -2;
        };
        consumer.consume(count) as i32
    })
}

#[no_mangle]
pub extern "C" fn pocket_duplex_abi_version() -> u32 {
    catch_ffi_unwind(0, || duplex::ABI_VERSION)
}

#[no_mangle]
pub extern "C" fn pocket_duplex_message_size() -> u32 {
    catch_ffi_unwind(0, || duplex::MESSAGE_BYTES as u32)
}

#[no_mangle]
pub extern "C" fn pocket_duplex_capacity() -> u32 {
    catch_ffi_unwind(0, || (duplex::RING_CAPACITY - 1) as u32)
}

/// Drain host-written duplex records on the runtime owner thread and invoke
/// `globalThis.__pocketDuplexEvent` for each one.  A missing JS handler leaves
/// ingress queued; a throwing handler leaves the current record uncommitted.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_step(handle: *mut HostState) -> i32 {
    guard_host_mut(handle, "pocket_duplex_step", -1, |host| {
        if !host.guest_loaded {
            set_error(host, "duplex step requires a loaded guest");
            return -1;
        }
        if let Err(error) = demand::before_external(host) {
            set_error(host, error);
            return -1;
        }
        match drain_duplex(host) {
            Ok(processed) => {
                clear_error(host);
                processed
            }
            Err(error) => {
                set_error(host, error);
                -1
            }
        }
    })
}

/// Mark event-driven Worker/provider output on the native owner thread.
/// A zero-delta host frame must keep the ticker until a real fixed guest turn
/// consumes it. This is a notification, never a periodic polling probe.
#[no_mangle]
pub unsafe extern "C" fn pocket_notify_external_work(handle: *mut HostState) {
    guard_host_mut(handle, "pocket_notify_external_work", (), |host| {
        if let Err(error) = demand::before_external(host) {
            set_error(host, error);
            return;
        }
        host.external_work_pending = true;
        demand::invalidate(host);
    });
}

/// Cached scheduler status from the last guest/core transaction. This query
/// never pumps JS or probes for visual changes. Unknown/legacy guests keep
/// vsync (zero), known idle guests return -1, and a timer returns its delay.
#[no_mangle]
pub unsafe extern "C" fn pocket_next_wake_delay_ms(handle: *mut HostState) -> f64 {
    if handle.is_null() {
        return 0.0;
    }
    guard_host_mut(handle, "pocket_next_wake_delay_ms", -1.0, |host| {
        demand::delay_ms(host)
    })
}

/// Stop accounting idle wall time while the embedding application is in the
/// background. The next resumed frame establishes its normal display delta.
#[no_mangle]
pub unsafe extern "C" fn pocket_set_scheduler_paused(handle: *mut HostState, paused: i32) {
    guard_host_mut(handle, "pocket_set_scheduler_paused", (), |host| {
        if let Some(worker) = &host.worker_runtime {
            worker.set_paused(paused != 0);
        }
        if let Err(error) = demand::set_paused(host, paused != 0) {
            set_error(host, error);
        }
    });
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
    guard_host_mut(handle, "pocket_frame_delta", ptr::null(), |host| {
        match build_frame(host, delta_ms, true, false) {
            Ok(built) if built.draw_cache_hit && frame_has_no_transient_data(&built) => {
                clear_error(host);
                host.output = c_string(UNCHANGED_FRAME_JSON);
                host.output.as_ptr()
            }
            Ok(built) => complete_frame_output(host, built, false),
            Err(error) => failed_frame_output(host, error),
        }
    })
}

/// Full-frame binary counterpart of `pocket_frame`. Used by initial guest load
/// (`_loadFrame`) and explicit full-frame callers so startup textures and
/// DrawOps bypass UTF-8 JSON serialization.
#[no_mangle]
pub unsafe extern "C" fn pocket_frame_binary(
    handle: *mut HostState,
    delta_ms: f64,
    out_byte_length: *mut u64,
) -> *const u8 {
    catch_ffi_unwind((), || {
        if let Some(length) = out_byte_length.as_mut() {
            *length = 0;
        }
    });
    let res = guard_host_mut(handle, "pocket_frame_binary", ptr::null(), |host| {
        let sampling = PERF_SAMPLING_ENABLED.load(Ordering::Relaxed);
        let t_total = sampling.then(Instant::now);
        match build_frame(host, delta_ms, false, false) {
            Ok(built) => {
                let t_encode = sampling.then(Instant::now);
                reset_binary_output_buffer(&mut host.binary_output);
                let encoded = encode_binary_frame_append(
                    &mut host.binary_output,
                    &built.result,
                    &built.result.ops,
                );
                if let Some(t) = t_encode {
                    host.last_stage_timings.encode_us = t.elapsed().as_micros() as u64;
                }
                match encoded {
                    Ok(()) => {
                        if let Some(length) = out_byte_length.as_mut() {
                            *length = host.binary_output.len() as u64;
                        }
                        publish_frame_sequence(host, built.result.frame);
                        clear_error(host);
                        if let Some(t) = t_total {
                            let total_us = t.elapsed().as_micros() as u64;
                            let accounted = host.last_stage_timings.js_tick_us
                                + host.last_stage_timings.relayout_us
                                + host.last_stage_timings.live2d_emit_us
                                + host.last_stage_timings.draw_decode_us
                                + host.last_stage_timings.splice_us
                                + host.last_stage_timings.encode_us;
                            host.last_stage_timings.other_us = total_us.saturating_sub(accounted);
                        }
                        host.binary_output.as_ptr()
                    }
                    Err(error) => {
                        reset_binary_output_buffer(&mut host.binary_output);
                        host.frame_delta_v2_published = None;
                        set_error(host, format!("frame binary encode: {error}"));
                        ptr::null()
                    }
                }
            }
            Err(error) => {
                reset_binary_output_buffer(&mut host.binary_output);
                failed_frame_output(host, error);
                ptr::null()
            }
        }
    });
    if res.is_null() {
        catch_ffi_unwind((), || {
            if let Some(length) = out_byte_length.as_mut() {
                *length = 0;
            }
        });
    }
    res
}

/// Compact binary counterpart of `pocket_frame_delta`.  A zero output length
/// with no `pocket_last_error` means the retained frame was unchanged.  The
/// returned bytes are borrowed from the runtime and remain valid until the
/// next frame call; Flutter copies them immediately.
#[no_mangle]
pub unsafe extern "C" fn pocket_frame_delta_binary(
    handle: *mut HostState,
    delta_ms: f64,
    out_byte_length: *mut u64,
) -> *const u8 {
    catch_ffi_unwind((), || {
        if let Some(length) = out_byte_length.as_mut() {
            *length = 0;
        }
    });
    let res = guard_host_mut(handle, "pocket_frame_delta_binary", ptr::null(), |host| {
        match build_frame(host, delta_ms, true, false) {
            Ok(built) if built.draw_cache_hit && frame_has_no_transient_data(&built) => {
                reset_binary_output_buffer(&mut host.binary_output);
                clear_error(host);
                ptr::null()
            }
            Ok(built) => {
                reset_binary_output_buffer(&mut host.binary_output);
                match encode_binary_frame_append(
                    &mut host.binary_output,
                    &built.result,
                    &built.result.ops,
                ) {
                    Ok(()) => {
                        if let Some(length) = out_byte_length.as_mut() {
                            *length = host.binary_output.len() as u64;
                        }
                        publish_frame_sequence(host, built.result.frame);
                        clear_error(host);
                        host.binary_output.as_ptr()
                    }
                    Err(error) => {
                        reset_binary_output_buffer(&mut host.binary_output);
                        host.frame_delta_v2_published = None;
                        set_error(host, format!("frame binary encode: {error}"));
                        ptr::null()
                    }
                }
            }
            Err(error) => {
                reset_binary_output_buffer(&mut host.binary_output);
                failed_frame_output(host, error);
                ptr::null()
            }
        }
    });
    if res.is_null() {
        catch_ffi_unwind((), || {
            if let Some(length) = out_byte_length.as_mut() {
                *length = 0;
            }
        });
    }
    res
}

/// Opt-in PFP1 binary frame delta ABI.
///
/// `base_frame` is the sequence of the last frame the caller actually
/// received.  A caller must pass it on every invocation; native frame probes
/// that return zero bytes do not advance the published baseline.  If the
/// sequence does not match the most recently published frame, or if a reload,
/// resize, or first frame removed the retained DrawOps baseline, this function
/// returns a complete PFB1 frame.  Otherwise a changed frame may be returned
/// as a PFP1 envelope when its complete embedded PFB1 payload (with only the
/// inserted primary ops) is smaller than the full PFB1 frame.
///
/// The 28-byte PFP1 header is, in little endian order:
/// `magic:u32`, `baseSequence:u64`, `prefixCount:u32`, `deleteCount:u32`,
/// `resultingOpCount:u32`, `embeddedPayloadLength:u32`.  The embedded payload
/// is a complete PFB1 frame; its primary operation list is the splice's
/// insertion segment, while events/resources/releases and auxiliary metadata
/// describe the complete current frame.
#[no_mangle]
pub unsafe extern "C" fn pocket_frame_delta_binary_v2(
    handle: *mut HostState,
    delta_ms: f64,
    base_frame: u64,
    out_byte_length: *mut u64,
) -> *const u8 {
    catch_ffi_unwind((), || {
        if let Some(length) = out_byte_length.as_mut() {
            *length = 0;
        }
    });
    let res = guard_host_mut(handle, "pocket_frame_delta_binary_v2", ptr::null(), |host| {
        let sampling = PERF_SAMPLING_ENABLED.load(Ordering::Relaxed);
        let t_total = sampling.then(Instant::now);

        // This is deliberately checked before build_frame.  The retained cache is
        // the previous published visual baseline; an idle v2 transaction advances
        // the internal diagnostic sequence but must not make an old client base
        // appear stale on the next call.
        let base_matches = host.frame_delta_v2_published == Some(base_frame);
        let previous_ops = if base_matches {
            host.draw_cache.as_ref().map(|cache| Rc::clone(&cache.ops))
        } else {
            None
        };
        let can_delta = base_matches && previous_ops.is_some();
        if base_matches {
            // Resource acknowledgement is independent of whether the retained
            // DrawOps baseline is still spliceable. A resize (or another layout
            // invalidation) deliberately drops draw_cache, but the caller can
            // still echo the last published sequence. Capture that ledger before
            // build_frame advances it for the next frame; if the next packet is
            // dropped, this remains the exact baseline needed by a later stale-
            // base resync.
            host.frame_delta_v2_resource_base = host.sent_resources.clone();
        }

        match build_frame(host, delta_ms, false, !can_delta) {
            Ok(built) => {
                // A stable retained frame with no lifecycle/event metadata is the
                // only zero-byte result. Keep `frame_delta_v2_published` unchanged
                // so the caller's base remains the last sequence it received.
                if can_delta && built.draw_cache_hit && frame_has_no_transient_data(&built) {
                    reset_binary_output_buffer(&mut host.binary_output);
                    clear_error(host);
                    if let Some(t) = t_total {
                        let total_us = t.elapsed().as_micros() as u64;
                        let accounted = host.last_stage_timings.js_tick_us
                            + host.last_stage_timings.relayout_us
                            + host.last_stage_timings.live2d_emit_us
                            + host.last_stage_timings.draw_decode_us;
                        host.last_stage_timings.other_us = total_us.saturating_sub(accounted);
                    }
                    return ptr::null();
                }

                if can_delta {
                    let previous_ops = previous_ops
                        .as_deref()
                        .expect("delta baseline must retain decoded operations");
                    let t_splice = sampling.then(Instant::now);
                    let splice = frame_delta::common_splice(previous_ops, &built.result.ops);
                    if let Some(t) = t_splice {
                        host.last_stage_timings.splice_us = t.elapsed().as_micros() as u64;
                    }
                    let insert_end = built
                        .result
                        .ops
                        .len()
                        .checked_sub(splice.suffix_count)
                        .expect("common splice suffix cannot exceed result length");
                    let retained_ops = splice.prefix_count + splice.suffix_count;
                    let t_encode = sampling.then(Instant::now);
                    // PFP1 adds 28 bytes. Every current PFB1 op is at least the
                    // 33-byte tag/geometry/clip prefix, so one retained op is a
                    // strict size win without a second full encoder/count pass.
                    let encoded = if retained_ops.saturating_mul(MIN_BINARY_OP_BYTES)
                        > frame_delta::HEADER_BYTES
                    {
                        let patch_res = frame_delta::encode_with_writer(
                            &mut host.binary_output,
                            base_frame,
                            splice,
                            built.result.ops.len(),
                            |out| {
                                encode_binary_frame_append(
                                    out,
                                    &built.result,
                                    &built.result.ops[splice.prefix_count..insert_end],
                                )
                            },
                        );
                        match patch_res {
                            Ok(()) => Ok(()),
                            Err(_) => {
                                reset_binary_output_buffer(&mut host.binary_output);
                                encode_binary_frame_append(
                                    &mut host.binary_output,
                                    &built.result,
                                    &built.result.ops,
                                )
                            }
                        }
                    } else {
                        reset_binary_output_buffer(&mut host.binary_output);
                        encode_binary_frame_append(
                            &mut host.binary_output,
                            &built.result,
                            &built.result.ops,
                        )
                    };
                    if let Some(t) = t_encode {
                        host.last_stage_timings.encode_us = t.elapsed().as_micros() as u64;
                    }
                    if let Err(error) = encoded {
                        reset_binary_output_buffer(&mut host.binary_output);
                        host.frame_delta_v2_published = None;
                        set_error(host, format!("frame binary encode: {error}"));
                        return ptr::null();
                    }
                } else {
                    // First frame, invalid base, resize, reload, and any call
                    // after a cache invalidation retain the original PFB1 ABI.
                    let t_encode = sampling.then(Instant::now);
                    reset_binary_output_buffer(&mut host.binary_output);
                    let encoded = encode_binary_frame_append(
                        &mut host.binary_output,
                        &built.result,
                        &built.result.ops,
                    );
                    if let Some(t) = t_encode {
                        host.last_stage_timings.encode_us = t.elapsed().as_micros() as u64;
                    }
                    if let Err(error) = encoded {
                        reset_binary_output_buffer(&mut host.binary_output);
                        host.frame_delta_v2_published = None;
                        set_error(host, format!("frame binary encode: {error}"));
                        return ptr::null();
                    }
                };
                if let Some(length) = out_byte_length.as_mut() {
                    *length = host.binary_output.len() as u64;
                }
                publish_frame_sequence(host, built.result.frame);
                clear_error(host);
                if let Some(t) = t_total {
                    let total_us = t.elapsed().as_micros() as u64;
                    let accounted = host.last_stage_timings.js_tick_us
                        + host.last_stage_timings.relayout_us
                        + host.last_stage_timings.live2d_emit_us
                        + host.last_stage_timings.draw_decode_us
                        + host.last_stage_timings.splice_us
                        + host.last_stage_timings.encode_us;
                    host.last_stage_timings.other_us = total_us.saturating_sub(accounted);
                }
                host.binary_output.as_ptr()
            }
            Err(error) => {
                host.binary_output.clear();
                failed_frame_output(host, error);
                ptr::null()
            }
        }
    });
    if res.is_null() {
        catch_ffi_unwind((), || {
            if let Some(length) = out_byte_length.as_mut() {
                *length = 0;
            }
        });
    }
    res
}

#[no_mangle]
pub unsafe extern "C" fn pocket_set_perf_sampling_enabled(enabled: u32) {
    catch_ffi_unwind((), || {
        let active = enabled != 0;
        PERF_SAMPLING_ENABLED.store(active, Ordering::Relaxed);
        if !active {
            LIVE2D_UPDATE_NANOS.store(0, Ordering::Relaxed);
        }
    });
}

#[no_mangle]
pub unsafe extern "C" fn pocket_is_perf_sampling_enabled() -> u32 {
    catch_ffi_unwind(0, || {
        u32::from(PERF_SAMPLING_ENABLED.load(Ordering::Relaxed))
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_record_live2d_update_ns(nanos: u64) {
    catch_ffi_unwind((), || {
        if PERF_SAMPLING_ENABLED.load(Ordering::Relaxed) {
            LIVE2D_UPDATE_NANOS.fetch_add(nanos, Ordering::Relaxed);
        }
    });
}

#[no_mangle]
pub unsafe extern "C" fn pocket_last_frame_stage_timings_us(
    handle: *const HostState,
    out_timings: *mut u64,
) -> u32 {
    if out_timings.is_null() {
        return 0;
    }
    guard_host_ref(handle, 0, |host| {
        let t = &host.last_stage_timings;
        let slice = std::slice::from_raw_parts_mut(out_timings, 8);
        slice[0] = t.js_tick_us;
        slice[1] = t.live2d_update_us;
        slice[2] = t.live2d_emit_us;
        slice[3] = t.relayout_us;
        slice[4] = t.draw_decode_us;
        slice[5] = t.splice_us;
        slice[6] = t.encode_us;
        slice[7] = t.other_us;
        8
    })
}

const MAX_INBOUND_BINARY_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[no_mangle]
pub unsafe extern "C" fn pocket_send_binary(
    handle: *mut HostState,
    message: *const u8,
    message_len: usize,
) -> i32 {
    guard_host_mut(handle, "pocket_send_binary", -1, |host| {
        if message.is_null() || message_len == 0 {
            set_error(host, "null or empty binary message");
            return -1;
        }
        if message_len > MAX_INBOUND_BINARY_MESSAGE_BYTES {
            set_error(host, "binary message exceeds maximum bridge limit");
            return -1;
        }
        let bytes = std::slice::from_raw_parts(message, message_len);
        let meta = match binary_bridge::inspect_binary_envelope(bytes) {
            Ok(meta) => meta,
            Err(error) => {
                set_error(host, format!("invalid binary message: {error}"));
                return -1;
            }
        };
        let target = if meta.is_response() {
            "__pocketDeliver"
        } else {
            "__pocketEvent"
        };
        if host.guest_loaded {
            if let Err(error) = demand::before_external(host) {
                set_error(host, error);
                return -1;
            }
            if let Err(error) = drain_duplex(host) {
                set_error(host, error);
                return -1;
            }
        }
        if meta.is_input() {
            let parsed = match binary_bridge::decode_to_json(bytes) {
                Ok(value) => value,
                Err(error) => {
                    set_error(host, format!("invalid binary input message: {error}"));
                    return -1;
                }
            };
            if let Err(error) = queue_input(host, &parsed) {
                set_error(host, error);
                return -1;
            }
        }
        match dispatch_guest_binary(&host.guest, target, bytes) {
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
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_send(handle: *mut HostState, message: *const c_char) -> i32 {
    guard_host_mut(handle, "pocket_send", -1, |host| {
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
        // Explicit legacy callers must preserve the same edge ordering as the
        // binary ABI. Drain published records before dispatching their next edge.
        if host.guest_loaded {
            if let Err(error) = demand::before_external(host) {
                set_error(host, error);
                return -1;
            }
            if let Err(error) = drain_duplex(host) {
                set_error(host, error);
                return -1;
            }
        }
        if let Err(error) = queue_input(host, &parsed) {
            set_error(host, error);
            return -1;
        }
        match dispatch_guest_json(&host.guest, target, &parsed, Some(&line)) {
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
    })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_last_error(handle: *mut HostState) -> *const c_char {
    catch_ffi_unwind(ptr::null(), || {
        let Some(host) = handle.as_ref() else {
            return ptr::null();
        };
        host.error_output.as_ptr()
    })
}

fn invalidate_host_text_metrics(host: &mut HostState) -> Result<(), String> {
    host.draw_cache = None;
    host.frame_json_cache = None;
    let enable_transformed = {
        let m = host.text_metrics.borrow();
        m.host_table.is_some() || m.fontless_pak
    };
    let mut core = host
        .ops
        .core_mut()
        .map_err(|error| format!("font metrics invalidate: {error:?}"))?;
    if enable_transformed {
        core.ui.set_native_transformed_text(true);
    }
    core.ui.invalidate_text_metrics();
    core.mutated();
    Ok(())
}

/// Installs precomputed host font metrics for PocketJS font slots
/// (active slots `0..20`; `slot_count` in `21..=24`):
/// - `line_heights`: `slot_count` finite positive `f32` values
/// - `cjk_advances`: `slot_count` finite positive `f32` values (fullwidth CJK reference)
/// - `ascii_advances`: `slot_count * 95` finite non-negative `f32` values (`0x20..=0x7E`)
#[no_mangle]
pub unsafe extern "C" fn pocket_set_host_font_metrics(
    handle: *mut HostState,
    slot_count: u32,
    line_heights: *const f32,
    cjk_advances: *const f32,
    ascii_advances: *const f32,
) -> i32 {
    guard_host_mut(handle, "pocket_set_host_font_metrics", -1, |host| {
        const MIN_ACTIVE_FONT_SLOTS: usize = ACTIVE_HOST_FONT_SLOTS;
        let count = slot_count as usize;
        if !(MIN_ACTIVE_FONT_SLOTS..=HOST_FONT_SLOTS).contains(&count) {
            set_error(
                host,
                format!(
                    "host font metrics slot_count must be in {MIN_ACTIVE_FONT_SLOTS}..={HOST_FONT_SLOTS}, got {slot_count}"
                ),
            );
            return -1;
        }
        if line_heights.is_null() || cjk_advances.is_null() || ascii_advances.is_null() {
            set_error(host, "host font metrics pointers must be non-null");
            return -1;
        }
        let lh_slice = std::slice::from_raw_parts(line_heights, count);
        let cjk_slice = std::slice::from_raw_parts(cjk_advances, count);
        let ascii_slice = std::slice::from_raw_parts(ascii_advances, count * HOST_ASCII_COUNT);
        if lh_slice.iter().any(|v| !v.is_finite() || *v <= 0.0)
            || cjk_slice.iter().any(|v| !v.is_finite() || *v <= 0.0)
        {
            set_error(
                host,
                "host font line_heights and cjk_advances must be finite and positive",
            );
            return -1;
        }
        if ascii_slice.iter().any(|v| !v.is_finite() || *v < 0.0) {
            set_error(
                host,
                "host font ascii_advances must be finite and non-negative",
            );
            return -1;
        }
        let default_lh = lh_slice[1];
        let default_cjk = cjk_slice[1];
        let mut lh_arr = [default_lh; HOST_FONT_SLOTS];
        lh_arr[..count].copy_from_slice(lh_slice);
        let mut cjk_arr = [default_cjk; HOST_FONT_SLOTS];
        cjk_arr[..count].copy_from_slice(cjk_slice);
        let mut default_ascii = [0.0f32; HOST_ASCII_COUNT];
        default_ascii.copy_from_slice(&ascii_slice[HOST_ASCII_COUNT..2 * HOST_ASCII_COUNT]);
        let mut ascii_arr = [default_ascii; HOST_FONT_SLOTS];
        for slot in 0..count {
            let start = slot * HOST_ASCII_COUNT;
            ascii_arr[slot].copy_from_slice(&ascii_slice[start..start + HOST_ASCII_COUNT]);
        }
        {
            let mut metrics = host.text_metrics.borrow_mut();
            metrics.host_table = Some(HostFontTable {
                line_heights: lh_arr,
                cjk_advances: cjk_arr,
                ascii_advances: ascii_arr,
            });
            metrics.clear_caches();
        }
        let _ = host.guest.with(|ctx| -> rquickjs::Result<()> {
            let globals = ctx.globals();
            if let Ok(ui) = globals.get::<_, Object>("ui") {
                ui.set("__hostFonts", true)?;
            }
            Ok(())
        });
        if let Err(error) = invalidate_host_text_metrics(host) {
            set_error(host, error);
            return -1;
        }
        clear_error(host);
        0
    })
}

/// Registers or clears (`callback = None`) the synchronous same-thread glyph
/// advance callback used as a scalar fallback when no shaped text callback is set.
#[no_mangle]
pub unsafe extern "C" fn pocket_set_host_glyph_measure_callback(
    handle: *mut HostState,
    callback: Option<HostGlyphMeasureCallback>,
    user_data: usize,
) -> i32 {
    guard_host_mut(
        handle,
        "pocket_set_host_glyph_measure_callback",
        -1,
        |host| {
            {
                let mut metrics = host.text_metrics.borrow_mut();
                metrics.glyph_callback = callback.map(|func| HostGlyphCallback { func, user_data });
                metrics.clear_caches();
            }
            if let Err(error) = invalidate_host_text_metrics(host) {
                set_error(host, error);
                return -1;
            }
            clear_error(host);
            0
        },
    )
}

/// Registers or clears (`callback = None`) the synchronous same-thread UTF-8
/// shaped text run measurer used for non-ASCII lines (grapheme clusters, ZWJ
/// emoji sequences, combining marks, and complex scripts).
#[no_mangle]
pub unsafe extern "C" fn pocket_set_host_text_measure_callback(
    handle: *mut HostState,
    callback: Option<HostTextMeasureCallback>,
    user_data: usize,
) -> i32 {
    guard_host_mut(
        handle,
        "pocket_set_host_text_measure_callback",
        -1,
        |host| {
            {
                let mut metrics = host.text_metrics.borrow_mut();
                metrics.text_callback = callback.map(|func| HostTextCallback { func, user_data });
                metrics.clear_caches();
            }
            if let Err(error) = invalidate_host_text_metrics(host) {
                set_error(host, error);
                return -1;
            }
            clear_error(host);
            0
        },
    )
}

#[no_mangle]
pub unsafe extern "C" fn pocket_destroy(handle: *mut HostState) {
    catch_ffi_unwind((), || {
        if !handle.is_null() {
            // Detach any Dart NativeCallable before tearing down QuickJS/Core.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut metrics = (*handle).text_metrics.borrow_mut();
                metrics.glyph_callback = None;
                metrics.text_callback = None;
            }));
            // Make the generation boundary visible to any retained background
            // channel handle before dropping the owner-side QuickJS state.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                (*handle).duplex.close();
            }));
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                drop(Box::from_raw(handle));
            }));
        }
    });
}

#[doc(hidden)]
#[no_mangle]
pub unsafe extern "C" fn pocket_test_trigger_panic(handle: *mut HostState) -> i32 {
    guard_host_mut(handle, "pocket_test_trigger_panic", -1, |_host| {
        panic!("simulated FFI panic for catch_unwind verification");
    })
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use rquickjs::{Context, Module, Runtime, WriteOptions, WriteOptionsEndianness};
    use std::ffi::{CStr, CString};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn physics_bindings_use_the_retained_core_and_do_not_create_idle_work() {
        let handle = pocket_create(64.0, 64.0);
        let source = CString::new(
            r#"
            const world = ui.physicsCreate(1, new ArrayBuffer(0));
            if (world <= 0) throw new Error('core physics world was not created');
            ui.physicsDestroy(world);
            pocket._emit(JSON.stringify({name:'physics.world.destroyed',payload:{world}}));
            globalThis.frame = () => {};
        "#,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, source.as_ptr()) },
            0,
            "{}",
            unsafe { CStr::from_ptr(pocket_last_error(handle)).to_string_lossy() }
        );
        let output = frame_json(handle);
        assert_eq!(output["events"][0]["name"], "physics.world.destroyed");
        assert!(!unsafe { &*handle }
            .ops
            .core()
            .unwrap()
            .ui
            .has_pending_work());
        unsafe {
            pocket_destroy(handle);
        }
    }

    fn frame_json(handle: *mut HostState) -> serde_json::Value {
        frame_json_with_delta(handle, 16.0)
    }

    fn frame_json_with_delta(handle: *mut HostState, delta_ms: f64) -> serde_json::Value {
        let pointer = unsafe { pocket_frame(handle, delta_ms) };
        assert!(!pointer.is_null());
        let text = unsafe { CStr::from_ptr(pointer) }.to_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    struct PackageFixture {
        root: Option<PathBuf>,
        source: PathBuf,
        pak: PathBuf,
        bytecode: PathBuf,
    }

    impl Drop for PackageFixture {
        fn drop(&mut self) {
            if let Some(root) = self.root.take() {
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }

    fn empty_pak() -> Vec<u8> {
        let mut pak = vec![0u8; 32];
        pak[0..4].copy_from_slice(&PAK_MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&1u16.to_le_bytes());
        pak[12..16].copy_from_slice(&32u32.to_le_bytes());
        pak[16..20].copy_from_slice(&32u32.to_le_bytes());
        pak[20..24].copy_from_slice(&32u32.to_le_bytes());
        pak[24..28].copy_from_slice(&32u32.to_le_bytes());
        pak
    }

    fn test_font_atlas(
        slot: u8,
        cell_w: u8,
        cell_h: u8,
        density: u8,
        first_codepoint: u32,
        coverage: &[u8],
    ) -> Vec<u8> {
        assert!(!coverage.is_empty());
        let count = u16::try_from(coverage.len()).unwrap();
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&pocket_spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&pocket_spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&count.to_le_bytes());
        atlas.extend_from_slice(&[cell_w, cell_h, cell_h, cell_h, slot, 0, density, 0]);
        for gid in 0..count {
            atlas.extend_from_slice(&(first_codepoint + gid as u32).to_le_bytes());
            atlas.extend_from_slice(&gid.to_le_bytes());
            atlas.extend_from_slice(&[cell_w, 0]);
        }
        let samples = cell_w as usize * cell_h as usize * density as usize * density as usize;
        for alpha in coverage {
            atlas.extend(std::iter::repeat_n(*alpha, samples));
        }
        atlas
    }

    fn pak_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
        assert!(!entries.is_empty());
        let directory_offset = 32usize;
        let names_offset = directory_offset + entries.len() * 24;
        let names_len = entries.iter().map(|(key, _)| key.len()).sum::<usize>();
        let first_blob_offset = (names_offset + names_len + 15) & !15;
        let mut records = Vec::with_capacity(entries.len());
        let mut name_offset = 0usize;
        let mut blob_offset = first_blob_offset;
        for (key, blob) in entries {
            records.push((blob_offset, blob.len(), name_offset, key.len()));
            name_offset += key.len();
            blob_offset = (blob_offset + blob.len() + 15) & !15;
        }
        let mut pak = vec![0u8; blob_offset];
        pak[0..4].copy_from_slice(&PAK_MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&1u16.to_le_bytes());
        pak[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        pak[12..16].copy_from_slice(&(directory_offset as u32).to_le_bytes());
        pak[16..20].copy_from_slice(&(names_offset as u32).to_le_bytes());
        pak[20..24].copy_from_slice(&(first_blob_offset as u32).to_le_bytes());
        let pak_len = pak.len() as u32;
        pak[24..28].copy_from_slice(&pak_len.to_le_bytes());
        for (index, ((key, blob), (blob_offset, blob_len, name_offset, name_len))) in
            entries.iter().zip(records).enumerate()
        {
            let entry = directory_offset + index * 24;
            pak[entry + 4..entry + 8].copy_from_slice(&(blob_offset as u32).to_le_bytes());
            pak[entry + 8..entry + 12].copy_from_slice(&(blob_len as u32).to_le_bytes());
            pak[entry + 12..entry + 16].copy_from_slice(&(name_offset as u32).to_le_bytes());
            pak[entry + 16..entry + 18].copy_from_slice(&(name_len as u16).to_le_bytes());
            pak[names_offset + name_offset..names_offset + name_offset + name_len]
                .copy_from_slice(key.as_bytes());
            pak[blob_offset..blob_offset + blob_len].copy_from_slice(blob);
        }
        pak
    }

    fn one_entry_pak(key: &str, blob: &[u8]) -> Vec<u8> {
        pak_entries(&[(key, blob)])
    }

    fn exercise_repeated_package_reload(bytecode_load: bool) {
        let source = CString::new(
            r#"
            const image = ui.createNode(2);
            ui.setProp(image, 1, 5);
            ui.setProp(image, 2, 5);
            ui.setImage(image, ui.__textures.reload);
            ui.insertBefore(1, image, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(line) {
                const event = JSON.parse(line);
                if (event.name === 'input.pointer' && event.payload.phase === 'up') {
                    ui.setProp(image, 1, 24);
                }
            };
            "#,
        )
        .unwrap();
        let bytecode = bytecode_load.then(|| compile_test_bytecode(source.as_bytes()));
        let package = |rgba: [u8; 4]| {
            let mut image = vec![1, 0, 1, 0, pocket_spec::psm::PSM_8888 as u8, 0, 0, 0];
            image.extend_from_slice(&rgba);
            one_entry_pak("ui:img.reload", &image)
        };
        let load = |handle: *mut HostState, pak: &[u8]| unsafe {
            if let Some(bytecode) = bytecode.as_deref() {
                pocket_load_bytecode(
                    handle,
                    bytecode.as_ptr(),
                    bytecode.len(),
                    pak.as_ptr(),
                    pak.len(),
                )
            } else {
                pocket_load(handle, source.as_ptr(), pak.as_ptr(), pak.len())
            }
        };
        let pack_handle = |handle: *mut HostState| {
            unsafe { &*handle }
                .nodes
                .borrow()
                .iter()
                .find(|node| node.from_pack && node.asset == "reload")
                .map(|node| node.texture)
                .expect("package image has a host texture node")
        };
        let pixels = |handle: *mut HostState, texture: i32| {
            unsafe { &*handle }
                .ops
                .core()
                .unwrap()
                .ui
                .texture(texture)
                .map(|view| view.pixels.to_vec())
        };
        let texture_stats = |handle: *mut HostState| {
            let core = unsafe { &*handle }.ops.core().unwrap();
            let ui = &core.ui;
            let slots = ui.texture_slot_count();
            let mut live_textures = 0;
            let mut live_bytes = 0;
            for slot in 0..slots {
                if let Some((_, view)) = ui.texture_at(slot as u32) {
                    live_textures += 1;
                    live_bytes += view.pixels.len();
                }
            }
            (slots, live_textures, live_bytes)
        };

        let red = [11, 22, 33, 255];
        let blue = [44, 55, 66, 255];
        let first_pak = package(red);
        let replacement_pak = package(blue);
        let handle = pocket_create(64.0, 64.0);
        assert!(!handle.is_null());

        assert_eq!(load(handle, &first_pak), 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        let first_frame = frame_json(handle);
        assert_eq!(first_frame["resources"][0]["pixels"][0], red[0]);
        let first_texture = pack_handle(handle);
        let first_stats = texture_stats(handle);

        // Reloading identical PAK bytes must retire the prior generation too.
        assert_eq!(load(handle, &first_pak), 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        let same_package_frame = frame_json(handle);
        let second_texture = pack_handle(handle);
        let same_package_stats = texture_stats(handle);
        let first_texture_after_same_load = pixels(handle, first_texture);
        let same_package_released = same_package_frame["releasedResources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset == "reload");

        // A new PAK with the same asset name must publish its new pixels and
        // keep that replacement drawable after the old Core handle is freed.
        assert_eq!(load(handle, &replacement_pak), 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        let replacement_frame = frame_json(handle);
        let replacement_texture = pack_handle(handle);
        let replacement_stats = texture_stats(handle);
        let first_texture_after_changed_load = pixels(handle, first_texture);
        let second_texture_after_changed_load = pixels(handle, second_texture);
        let replacement_resource = replacement_frame["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["asset"] == "reload")
            .expect("replacement frame exports the newly mounted image");
        let replacement_pixels = replacement_resource["pixels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        let replacement_image_ops = replacement_frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|op| op["type"] == "image")
            .collect::<Vec<_>>();
        let replacement_asset_ops = replacement_image_ops
            .iter()
            .filter(|op| op["asset"] == "reload")
            .collect::<Vec<_>>();
        let replacement_released = replacement_frame["releasedResources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset == "reload");
        eprintln!(
            "reload_frame bytecode={bytecode_load} frame={replacement_frame} new_core_pixels={:?}",
            pixels(handle, replacement_texture)
        );
        let replacement_handle_pixels = pixels(handle, replacement_texture);

        let down = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"down","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, down.as_ptr()) }, 0);
        let _ = frame_json(handle);
        let up = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"up","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, up.as_ptr()) }, 0);
        let input_frame = frame_json(handle);
        let input_image_op = input_frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["asset"] == "reload")
            .cloned();

        let fresh = pocket_create(64.0, 64.0);
        assert!(!fresh.is_null());
        assert_eq!(load(fresh, &replacement_pak), 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(fresh)).to_string_lossy()
        });
        let fresh_frame = frame_json(fresh);
        let fresh_stats = texture_stats(fresh);
        let fresh_resource_pixels = fresh_frame["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["asset"] == "reload")
            .unwrap()["pixels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();

        eprintln!(
            "reload_probe bytecode={bytecode_load} first={first_stats:?} same={same_package_stats:?} replacement={replacement_stats:?} fresh={fresh_stats:?} first_old={first_texture_after_same_load:?}->{first_texture_after_changed_load:?} second_old={second_texture_after_changed_load:?} replacement_pixels={replacement_pixels:?} replacement_handle_pixels={replacement_handle_pixels:?} replacement_asset_ops={replacement_asset_ops:?} input_image_op={input_image_op:?} same_package_released={same_package_released} replacement_released={replacement_released} fresh_pixels={fresh_resource_pixels:?}"
        );

        unsafe {
            pocket_destroy(handle);
            pocket_destroy(fresh);
        }

        assert_eq!(first_texture_after_same_load, None, "identical reload left the old Core texture readable; live state {same_package_stats:?}");
        assert_eq!(first_texture_after_changed_load, None);
        assert_eq!(second_texture_after_changed_load, None);
        assert_ne!(first_texture, second_texture);
        assert_ne!(second_texture, replacement_texture);
        assert_eq!(replacement_pixels, blue);
        assert_eq!(replacement_handle_pixels, Some(blue.to_vec()));
        assert_eq!(
            replacement_image_ops.len(),
            1,
            "old guest DrawOps remain after reload: {replacement_image_ops:?}"
        );
        assert_eq!(replacement_asset_ops.len(), 1);
        assert_eq!(replacement_asset_ops[0]["w"], 5.0);
        assert_eq!(input_image_op.unwrap()["w"], 24.0);
        assert!(same_package_released);
        assert!(replacement_released);
        assert_eq!(fresh_resource_pixels, blue);
        assert_eq!(fresh_stats.1, 1);
        assert_eq!(replacement_stats.1, fresh_stats.1);
        assert_eq!(replacement_stats.2, fresh_stats.2);
        assert!(
            replacement_stats.0 <= fresh_stats.0 + 1,
            "package reload grew Core texture slots beyond one retired staging slot"
        );
    }

    #[test]
    fn source_package_reload_retires_old_pak_textures_and_keeps_new_drawable() {
        exercise_repeated_package_reload(false);
    }

    #[test]
    fn bytecode_package_reload_retires_old_pak_textures_and_keeps_new_drawable() {
        exercise_repeated_package_reload(true);
    }

    #[test]
    fn invalid_pak_admission_preserves_previous_guest_tree_and_textures() {
        let source = CString::new(
            r#"
            const image = ui.createNode(2);
            ui.setProp(image, 1, 5);
            ui.setProp(image, 2, 5);
            ui.setImage(image, ui.__textures.reload);
            ui.insertBefore(1, image, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(line) {
                const event = JSON.parse(line);
                if (event.name === 'input.pointer' && event.payload.phase === 'up') {
                    ui.setProp(image, 1, 24);
                }
            };
            "#,
        )
        .unwrap();
        let mut image = vec![1, 0, 1, 0, pocket_spec::psm::PSM_8888 as u8, 0, 0, 0];
        image.extend_from_slice(&[11, 22, 33, 255]);
        let pak = one_entry_pak("ui:img.reload", &image);
        let invalid_pak = one_entry_pak("ui:img.broken", &[]);
        let handle = pocket_create(64.0, 64.0);
        assert!(!handle.is_null());
        assert_eq!(
            unsafe { pocket_load(handle, source.as_ptr(), pak.as_ptr(), pak.len()) },
            0
        );
        let initial = frame_json(handle);
        assert_eq!(initial["ops"].as_array().unwrap().len(), 1);
        assert_eq!(initial["ops"][0]["asset"], "reload");
        let texture = unsafe { &*handle }
            .nodes
            .borrow()
            .iter()
            .find(|node| node.from_pack && node.asset == "reload")
            .unwrap()
            .texture;
        let initial_stats = {
            let core = unsafe { &*handle }.ops.core().unwrap();
            let ui = &core.ui;
            let slots = ui.texture_slot_count();
            let live = (0..slots)
                .filter_map(|slot| ui.texture_at(slot as u32))
                .map(|(_, view)| view.pixels.len())
                .sum::<usize>();
            (slots, live)
        };

        assert_eq!(
            unsafe {
                pocket_load(
                    handle,
                    source.as_ptr(),
                    invalid_pak.as_ptr(),
                    invalid_pak.len(),
                )
            },
            -1
        );
        assert_eq!(
            unsafe { &*handle }
                .ops
                .core()
                .unwrap()
                .ui
                .texture(texture)
                .map(|view| view.pixels.to_vec()),
            Some(vec![11, 22, 33, 255])
        );
        let retained_frame = frame_json(handle);
        assert_eq!(retained_frame["ops"].as_array().unwrap().len(), 1);
        assert_eq!(retained_frame["ops"][0]["asset"], "reload");
        assert_eq!(retained_frame["ops"][0]["w"], 5.0);
        let retained_stats = {
            let core = unsafe { &*handle }.ops.core().unwrap();
            let ui = &core.ui;
            let slots = ui.texture_slot_count();
            let live = (0..slots)
                .filter_map(|slot| ui.texture_at(slot as u32))
                .map(|(_, view)| view.pixels.len())
                .sum::<usize>();
            (slots, live)
        };
        assert_eq!(retained_stats, initial_stats);

        let down = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"down","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, down.as_ptr()) }, 0);
        let _ = frame_json(handle);
        let up = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"up","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, up.as_ptr()) }, 0);
        let input_frame = frame_json(handle);
        assert_eq!(input_frame["ops"][0]["asset"], "reload");
        assert_eq!(input_frame["ops"][0]["w"], 24.0);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn invalid_and_oversized_bytecode_preflight_preserve_previous_guest() {
        let source = br#"
            const image = ui.createNode(2);
            ui.setProp(image, 1, 5);
            ui.setProp(image, 2, 5);
            ui.setImage(image, ui.__textures.reload);
            ui.insertBefore(1, image, 0);
            globalThis.frame = function() {};
        "#;
        let bytecode = compile_test_bytecode(source);
        let mut invalid_bytecode = bytecode.clone();
        invalid_bytecode[bytecode::HEADER_LEN] ^= 1;
        let mut image = vec![1, 0, 1, 0, pocket_spec::psm::PSM_8888 as u8, 0, 0, 0];
        image.extend_from_slice(&[11, 22, 33, 255]);
        let pak = one_entry_pak("ui:img.reload", &image);
        let handle = pocket_create(64.0, 64.0);
        assert!(!handle.is_null());
        assert_eq!(
            unsafe {
                pocket_load_bytecode(
                    handle,
                    bytecode.as_ptr(),
                    bytecode.len(),
                    pak.as_ptr(),
                    pak.len(),
                )
            },
            0
        );
        let _ = frame_json(handle);
        let texture = unsafe { &*handle }
            .nodes
            .borrow()
            .iter()
            .find(|node| node.from_pack && node.asset == "reload")
            .unwrap()
            .texture;
        assert_eq!(
            unsafe {
                pocket_load_bytecode(
                    handle,
                    invalid_bytecode.as_ptr(),
                    invalid_bytecode.len(),
                    pak.as_ptr(),
                    pak.len(),
                )
            },
            -1
        );
        unsafe { (*handle).memory_limits.max_pak_bytes = Some(1) };
        assert_eq!(
            unsafe {
                pocket_load_bytecode(
                    handle,
                    bytecode.as_ptr(),
                    bytecode.len(),
                    pak.as_ptr(),
                    pak.len(),
                )
            },
            -1
        );
        assert_eq!(
            unsafe { &*handle }
                .ops
                .core()
                .unwrap()
                .ui
                .texture(texture)
                .map(|view| view.pixels.to_vec()),
            Some(vec![11, 22, 33, 255])
        );
        let retained = frame_json(handle);
        assert_eq!(retained["ops"].as_array().unwrap().len(), 1);
        assert_eq!(retained["ops"][0]["asset"], "reload");
        unsafe { pocket_destroy(handle) };
    }

    fn test_glyph_run(slot: u8, color: u32, cells: &[(i16, i16, u32)]) -> Vec<u32> {
        let mut words = vec![3, ((cells.len() as u32) << 16) | slot as u32, color];
        for &(x, y, gid) in cells {
            words.push((u32::from(y as u16) << 16) | u32::from(x as u16));
            words.push(gid);
        }
        words
    }

    #[test]
    fn glyph_run_decoder_projects_tinted_coverage_pages_and_skips_upstream_noops() {
        let mut ui = Ui::new();
        assert!(ui.load_font_atlas(&test_font_atlas(0, 3, 2, 2, 32, &[64, 128, 224])));
        let mut words = vec![5, (10 << 16) | 5, (20 << 16) | 30];
        words.extend(test_glyph_run(0, 0x8040_2010, &[(-2, 7, 0), (8, 9, 1)]));
        words.push(6);
        let mut handles = HashSet::new();
        let ops = decode_draw_ops(&words, 100.0, 100.0, &[], &mut ui, &mut handles).unwrap();

        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].kind, "image");
        assert_eq!(ops[0].x, -2.0);
        assert_eq!(ops[0].y, 7.0);
        assert_eq!((ops[0].w, ops[0].h), (3.0, 2.0));
        assert_eq!(ops[0].color, Some(0x8010_2040));
        assert_eq!(ops[0].clip.x, 5.0);
        assert_eq!(ops[0].clip.y, 10.0);
        assert_eq!(ops[0].clip.w, 30.0);
        assert_eq!(ops[0].clip.h, 20.0);
        assert_eq!(
            ops[0].asset, ops[1].asset,
            "same-page glyphs share one texture"
        );
        assert!(ops[0].uv.as_ref().unwrap()[0] < ops[1].uv.as_ref().unwrap()[0]);
        assert_eq!(handles.len(), 1);
        assert!(referenced_image_assets(&ops).contains(ops[0].asset.as_deref().unwrap()));

        let handle = *handles.iter().next().unwrap();
        let texture = ui.texture(handle).unwrap();
        assert_eq!(texture.psm, pocket_spec::psm::PSM_T8);
        assert_eq!((texture.w, texture.h), (32, 8));
        assert_eq!(texture.pixels[1 * texture.w as usize + 1], 64);
        assert_eq!(texture.pixels[1 * texture.w as usize + 9], 128);
        let palette = texture.palette.unwrap();
        assert_eq!(&palette[64 * 4..64 * 4 + 4], &[255, 255, 255, 64]);

        let mut ignored = vec![3, (1 << 16) | 7, 0xffff_ffff, 0, 0]; // missing font slot
        ignored.extend([3, 0, 0xffff_ffff]); // valid empty run
        ignored.extend(test_glyph_run(0, 0xffff_ffff, &[(1, 2, 99)])); // invalid gid
        assert!(
            decode_draw_ops(&ignored, 100.0, 100.0, &[], &mut ui, &mut handles)
                .unwrap()
                .is_empty()
        );

        let reserved_slot = [3, 0x0000_0100, 0];
        assert!(
            decode_draw_ops(&reserved_slot, 100.0, 100.0, &[], &mut ui, &mut handles)
                .unwrap_err()
                .contains("reserved font-slot bits")
        );
        let reserved_gid = [3, 1 << 16, 0xffff_ffff, 0, 0x0001_0000];
        assert!(
            decode_draw_ops(&reserved_gid, 100.0, 100.0, &[], &mut ui, &mut handles)
                .unwrap_err()
                .contains("reserved gid bits")
        );
        let truncated = [3, 1 << 16, 0xffff_ffff, 0];
        assert!(
            decode_draw_ops(&truncated, 100.0, 100.0, &[], &mut ui, &mut handles)
                .unwrap_err()
                .contains("draw list decode")
        );
    }

    #[test]
    fn glyph_run_pages_cross_slots_reuse_a_to_b_to_a_and_replace_on_font_revision() {
        let mut ui = Ui::new();
        let slot0_coverage = (50..100).collect::<Vec<u8>>();
        assert!(ui.load_font_atlas(&test_font_atlas(0, 64, 64, 1, 32, &slot0_coverage)));
        assert!(ui.load_font_atlas(&test_font_atlas(1, 4, 4, 1, 32, &[180])));
        let mut words = test_glyph_run(0, 0xffff_ffff, &[(0, 0, 0), (64, 0, 49), (128, 0, 0)]);
        words.extend(test_glyph_run(1, 0xffff_ffff, &[(0, 70, 0)]));
        let mut handles = HashSet::new();
        let ops = decode_draw_ops(&words, 256.0, 256.0, &[], &mut ui, &mut handles).unwrap();
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0].asset, ops[2].asset, "A→B→A reuses the first page");
        assert_ne!(ops[0].asset, ops[1].asset, "gid 49 is on another page");
        assert_ne!(
            ops[0].asset, ops[3].asset,
            "different font slots own different pages"
        );
        assert_ne!(
            ops[0].uv, ops[1].uv,
            "page-local UVs reflect different page sizes"
        );
        assert_eq!(handles.len(), 3);
        let old_handle = handles
            .iter()
            .copied()
            .find(|handle| synthetic_texture_asset(*handle) == ops[0].asset.as_deref().unwrap())
            .unwrap();
        let old_revision = ui.font_atlas_revision(0);

        assert!(ui.load_font_atlas(&test_font_atlas(0, 64, 64, 1, 32, &[200; 50])));
        assert_ne!(ui.font_atlas_revision(0), old_revision);
        let replacement_words = test_glyph_run(0, 0xffff_ffff, &[(4, 5, 0)]);
        let mut replacement_handles = HashSet::new();
        let replacement = decode_draw_ops(
            &replacement_words,
            256.0,
            256.0,
            &[],
            &mut ui,
            &mut replacement_handles,
        )
        .unwrap();
        assert_eq!(replacement.len(), 1);
        assert_ne!(replacement[0].asset, ops[0].asset);
        assert!(!referenced_image_assets(&replacement).contains(ops[0].asset.as_deref().unwrap()));
        assert!(
            ui.texture(old_handle).is_none(),
            "replaced pages invalidate old handles"
        );
        let new_handle = *replacement_handles.iter().next().unwrap();
        let new_texture = ui.texture(new_handle).unwrap();
        assert_eq!(new_texture.pixels[new_texture.w as usize + 1], 200);
    }

    #[test]
    fn guest_glyph_run_exports_real_page_resources_and_releases_replaced_pages() {
        let handle = pocket_create(64.0, 64.0);
        let source = CString::new(
            r#"let mounted = false;
            globalThis.frame = function() {
                if (mounted) return;
                mounted = true;
                const text = ui.createNode(1);
                ui.setText(text, 'AB');
                ui.setProp(text, 1, 48);
                ui.setProp(text, 2, 12);
                ui.setProp(text, 96, 0x80402010);
                ui.setProp(text, 100, 1);
                ui.insertBefore(1, text, 0);
            };"#,
        )
        .unwrap();
        let first_pak = one_entry_pak(
            "ui:font.0",
            &test_font_atlas(0, 4, 6, 2, 'A' as u32, &[64, 192]),
        );
        let bytecode = compile_test_bytecode(source.as_bytes());
        let load_result = unsafe {
            pocket_load_bytecode(
                handle,
                bytecode.as_ptr(),
                bytecode.len(),
                first_pak.as_ptr(),
                first_pak.len(),
            )
        };
        assert_eq!(load_result, 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });

        let first = frame_json(handle);
        let ops = first["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        assert!(ops.iter().all(|op| op["type"] == "image"));
        assert!(ops.iter().all(|op| op["w"] == 4.0 && op["h"] == 6.0));
        assert!(ops.iter().all(|op| op["color"] == 0x8010_2040u64));
        let first_asset = ops[0]["asset"].as_str().unwrap().to_owned();
        assert_eq!(ops[1]["asset"], first_asset);
        let first_uv = ops[0]["uv"].as_array().unwrap();
        assert!((first_uv[0].as_f64().unwrap() - 1.0 / 32.0).abs() < 1.0e-6);
        assert!((first_uv[2].as_f64().unwrap() - 9.0 / 32.0).abs() < 1.0e-6);
        let resources = first["resources"].as_array().unwrap();
        assert_eq!(
            resources.len(),
            1,
            "a same-page run exports one shared resource"
        );
        let resource = &resources[0];
        assert_eq!(resource["asset"], first_asset);
        assert_eq!(resource["psm"], pocket_spec::psm::PSM_T8);
        let width = resource["width"].as_u64().unwrap() as usize;
        assert_eq!((width, resource["height"].as_u64().unwrap()), (32, 16));
        let pixels = resource["pixels"].as_array().unwrap();
        assert_eq!(pixels[width + 1], 64);
        assert_eq!(pixels[width + 11], 192);
        let palette = resource["palette"].as_array().unwrap();
        assert_eq!(
            palette[64 * 4..64 * 4 + 4],
            [255, 255, 255, 64].map(serde_json::Value::from)
        );

        let cached = frame_json(handle);
        assert!(cached["resources"].as_array().unwrap().is_empty());
        let second_pak = one_entry_pak(
            "ui:font.0",
            &test_font_atlas(0, 4, 6, 2, 'A' as u32, &[220, 240]),
        );
        let reload_result = unsafe {
            pocket_load(
                handle,
                source.as_ptr(),
                second_pak.as_ptr(),
                second_pak.len(),
            )
        };
        assert_eq!(reload_result, 0, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });
        let replaced = frame_json(handle);
        assert!(replaced["releasedResources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset == &first_asset));
        let replacement_resource = &replaced["resources"].as_array().unwrap()[0];
        assert_ne!(replacement_resource["asset"], first_asset);
        let replacement_pixels = replacement_resource["pixels"].as_array().unwrap();
        let replacement_width = replacement_resource["width"].as_u64().unwrap() as usize;
        assert_eq!(replacement_pixels[replacement_width + 1], 220);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn fresh_hosts_publish_stable_resource_and_release_order_without_reordering_ops() {
        let source = CString::new(
            r#"
            const nodes = [];
            let mounted = false;
            let cleared = false;
            globalThis.frame = function() {
                if (mounted || cleared) return;
                mounted = true;
                for (let slot = 0; slot < 3; slot++) {
                    const node = ui.createNode(1);
                    ui.setText(node, 'A');
                    ui.setProp(node, 1, 64);
                    ui.setProp(node, 2, 16);
                    ui.setProp(node, 97, slot);
                    ui.setProp(node, 100, 1);
                    ui.insertBefore(1, node, 0);
                    nodes.push(node);
                }
            };
            globalThis.clear = function() {
                for (const node of nodes) ui.destroyNode(node);
                nodes.length = 0;
                cleared = true;
            };
            "#,
        )
        .unwrap();
        let clear = CString::new("globalThis.clear();").unwrap();
        let font0 = test_font_atlas(0, 4, 6, 2, 'A' as u32, &[64]);
        let font1 = test_font_atlas(1, 4, 6, 2, 'A' as u32, &[128]);
        let font2 = test_font_atlas(2, 4, 6, 2, 'A' as u32, &[192]);
        let pak = pak_entries(&[
            ("ui:font.0", &font0),
            ("ui:font.1", &font1),
            ("ui:font.2", &font2),
        ]);
        let mut expected_ops = None;
        let expected_assets = vec![
            "pocket.texture.0".to_owned(),
            "pocket.texture.1".to_owned(),
            "pocket.texture.2".to_owned(),
        ];
        for iteration in 0..16 {
            let handle = pocket_create(128.0, 64.0);
            let load_result =
                unsafe { pocket_load(handle, source.as_ptr(), pak.as_ptr(), pak.len()) };
            assert_eq!(load_result, 0, "iteration {iteration}: {}", unsafe {
                CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
            });

            let first = frame_json(handle);
            let resources = first["resources"].as_array().unwrap();
            let assets = resources
                .iter()
                .map(|resource| resource["asset"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            assert_eq!(assets, expected_assets, "iteration {iteration}");
            if let Some(previous) = expected_ops.as_ref() {
                assert_eq!(
                    first["ops"], *previous,
                    "DrawOps changed at iteration {iteration}"
                );
            } else {
                expected_ops = Some(first["ops"].clone());
            }

            assert_eq!(unsafe { pocket_eval(handle, clear.as_ptr()) }, 0);
            let cleared_frame = frame_json(handle);
            assert!(cleared_frame["resources"].as_array().unwrap().is_empty());
            assert_eq!(
                cleared_frame["releasedResources"],
                serde_json::json!(expected_assets),
                "release order changed at iteration {iteration}"
            );
            unsafe { pocket_destroy(handle) };
        }
    }

    fn compile_test_worker_bytecode(source: &[u8]) -> Vec<u8> {
        use rquickjs::qjs;
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let payload = context.with(|ctx| unsafe {
            let input = CString::new(source).unwrap();
            let name = CString::new("worker-fixture.js").unwrap();
            let value = qjs::JS_Eval(
                ctx.as_raw().as_ptr(),
                input.as_ptr(),
                source.len() as _,
                name.as_ptr(),
                (qjs::JS_EVAL_TYPE_GLOBAL
                    | qjs::JS_EVAL_FLAG_STRICT
                    | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            );
            assert_ne!(qjs::JS_VALUE_GET_NORM_TAG(value), qjs::JS_TAG_EXCEPTION);
            let mut length = 0;
            let buffer = qjs::JS_WriteObject(
                ctx.as_raw().as_ptr(),
                &mut length,
                value,
                (qjs::JS_WRITE_OBJ_BYTECODE
                    | qjs::JS_WRITE_OBJ_STRIP_SOURCE
                    | qjs::JS_WRITE_OBJ_STRIP_DEBUG) as i32,
            );
            assert!(!buffer.is_null());
            let bytes = std::slice::from_raw_parts(buffer, length as usize).to_vec();
            qjs::js_free(ctx.as_raw().as_ptr(), buffer.cast());
            qjs::JS_FreeValue(ctx.as_raw().as_ptr(), value);
            bytes
        });
        bytecode::encode(
            bytecode::BytecodeKind::Script,
            bytecode::DEFAULT_FLAGS,
            BINDING_GENERATION,
            DEFAULT_TICK_HZ,
            source,
            &payload,
        )
        .unwrap()
    }

    fn compile_test_bytecode(source: &[u8]) -> Vec<u8> {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let payload = context.with(|ctx| {
            let module = Module::declare(ctx, "fixture.js", source.to_vec()).unwrap();
            module
                .write(WriteOptions {
                    endianness: WriteOptionsEndianness::Little,
                    strip_source: true,
                    strip_debug: true,
                    ..Default::default()
                })
                .unwrap()
        });
        bytecode::encode(
            bytecode::BytecodeKind::Module,
            bytecode::DEFAULT_FLAGS,
            BINDING_GENERATION,
            DEFAULT_TICK_HZ,
            source,
            &payload,
        )
        .unwrap()
    }

    fn package_fixture() -> PackageFixture {
        let source_env = std::env::var_os("POCKET_TEST_SOURCE").map(PathBuf::from);
        let pak_env = std::env::var_os("POCKET_TEST_ASSETS")
            .map(PathBuf::from)
            .map(|path| path.join("app.pak"));
        let bytecode_env = std::env::var_os("POCKET_TEST_ASSETS")
            .map(PathBuf::from)
            .map(|path| path.join("app.qjbc"));
        if let (Some(source), Some(pak), Some(bytecode)) = (source_env, pak_env, bytecode_env) {
            if source.is_file() && pak.is_file() && bytecode.is_file() {
                return PackageFixture {
                    root: None,
                    source,
                    pak,
                    bytecode,
                };
            }
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pocket-native-fixture-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("app.js");
        let pak = root.join("app.pak");
        let bytecode = root.join("app.qjbc");
        let source_bytes = b"globalThis.frame = function() {};\n";
        std::fs::write(&source, source_bytes).unwrap();
        std::fs::write(&pak, empty_pak()).unwrap();
        std::fs::write(&bytecode, compile_test_bytecode(source_bytes)).unwrap();
        PackageFixture {
            root: Some(root),
            source,
            pak,
            bytecode,
        }
    }

    #[test]
    fn retained_host_surfaces_preserve_clip_update_and_release() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
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
        "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        // The first 16ms sample primes the fixed 60Hz accumulator.
        let _ = frame_json(handle);
        let first = frame_json(handle);
        let op = first["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "hostSurface")
            .unwrap();
        assert_eq!(op["id"], "test.glass");
        assert_eq!(op["w"], 100.0);
        assert!(op["clip"].is_object());
        let second = frame_json(handle);
        let op = second["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "hostSurface")
            .unwrap();
        let descriptor: serde_json::Value =
            serde_json::from_str(op["asset"].as_str().unwrap()).unwrap();
        assert_eq!(descriptor["parameters"]["radius"], 28);
        let third = frame_json(handle);
        assert!(!third["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["type"] == "hostSurface"));
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn typed_surface_and_duplex_pointer_avoid_guest_json_and_preserve_edges() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
            JSON.parse = function() { throw new Error('JSON.parse must not run'); };
            JSON.stringify = function() { throw new Error('JSON.stringify must not run'); };
            const seen = [];
            const handler = function(packet) {
                if (typeof packet === 'string') throw new Error('pointer must be an object');
                if (!packet || packet.name !== 'input.pointer') throw new Error('wrong pointer event');
                seen.push(packet.payload.phase);
                pocket._emitValue({
                    type: 'event',
                    name: 'pointer.seen',
                    payload: { phase: packet.payload.phase, id: packet.payload.id }
                });
            };
            handler.__binaryCapable = true;
            globalThis.__pocketEvent = handler;
            pocket._register(77, 'image', { asset: 'typed.png', texture: 4 });
            if (pocket._emitValue('must-be-rejected') !== false) throw new Error('string accepted');
            if (pocket._emitValue({ type: 'event', name: 'typed.emit', payload: { ok: true } }) !== true) {
                throw new Error('object emit rejected');
            }
            const surface = pocket.registerSurface('typed.glass', 'glass', {
                radius: 18,
                nested: { enabled: true }
            });
            const node = ui.createNode(3);
            ui.setProp(node, 1, 100); ui.setProp(node, 2, 60);
            ui.setCompositorSurface(node, surface, 0);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, source.as_ptr()) },
            0,
            "{}",
            unsafe { CStr::from_ptr(pocket_last_error(handle)).to_string_lossy() }
        );

        let producer = unsafe { (&*handle).duplex.claim_ingress_producer().unwrap() };
        for (flags, x, y) in [
            (1_u16, 10.0_f32, 20.0_f32),
            (2, 12.0, 22.0),
            (3, 14.0, 24.0),
        ] {
            let reservation = producer.reserve(1).unwrap();
            unsafe {
                ptr::write(
                    producer
                        .payload_ptr(reservation)
                        .unwrap()
                        .cast::<duplex::DuplexMessage>(),
                    duplex::DuplexMessage {
                        msg_type: 1,
                        flags,
                        target_id: 9,
                        arg0: x,
                        arg1: y,
                    },
                );
            }
            assert!(producer.commit(reservation));
        }
        assert_eq!(unsafe { pocket_duplex_step(handle) }, 3, "{}", unsafe {
            CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
        });

        let phases = unsafe { &*handle }
            .outbound
            .borrow()
            .iter()
            .filter_map(|event| {
                let value = binary_bridge::decode_to_json(&event.binary).unwrap();
                (value["name"] == "pointer.seen")
                    .then(|| value["payload"]["phase"].as_str().unwrap().to_owned())
            })
            .collect::<Vec<_>>();
        assert_eq!(phases, ["down", "move", "up"]);

        // The native touch queue still carries the three edge snapshots to
        // the real GuestFrame path; UP must not leave an active contact.
        let _ = frame_json(handle);
        assert!(unsafe { &*handle }.touches.is_empty());
        let frame = frame_json(handle);
        let surface_op = frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "hostSurface")
            .expect("typed surface draw op");
        let descriptor: serde_json::Value =
            serde_json::from_str(surface_op["asset"].as_str().unwrap()).unwrap();
        assert_eq!(descriptor["kind"], "glass");
        assert_eq!(descriptor["parameters"]["nested"]["enabled"], true);

        let mut length = 0_u64;
        let pointer = unsafe { pocket_frame_binary(handle, 16.0, &mut length) };
        assert!(!pointer.is_null() && length > 32);
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
        assert_eq!(&bytes[..4], b"PFB1");
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 3);
        let op_count = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        assert!(op_count >= 1);
        let mut offset = 28_usize;
        assert_eq!(bytes[offset], 7, "expected typed hostSurface tag");
        offset += 33;
        let read_bytes = |bytes: &[u8], offset: &mut usize| {
            let len = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap()) as usize;
            *offset += 4;
            let result = bytes[*offset..*offset + len].to_vec();
            *offset += len;
            result
        };
        assert_eq!(
            String::from_utf8(read_bytes(bytes, &mut offset)).unwrap(),
            "typed.glass"
        );
        assert_eq!(
            String::from_utf8(read_bytes(bytes, &mut offset)).unwrap(),
            "glass"
        );
        let parameters = read_bytes(bytes, &mut offset);
        assert_eq!(
            parameters.first().copied(),
            Some(binary_bridge::BINARY_MESSAGE_MAGIC)
        );
        let decoded = binary_bridge::decode_to_json(&parameters).unwrap();
        assert_eq!(decoded["nested"]["enabled"], true);
        assert_eq!(
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()),
            100
        );

        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn registered_video_surface_updates_asset_and_fit_without_reusing_cached_op() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
            const surface = pocket.registerSurface('test.video', 'video', JSON.stringify({asset:'one.mp4', fit:'contain', autoplay:false}));
            const node = ui.createNode(3);
            ui.setProp(node, 1, 120); ui.setProp(node, 2, 80);
            ui.setCompositorSurface(node, surface, 0);
            ui.insertBefore(1, node, 0);
            let tick = 0;
            globalThis.frame = function() {
                tick++;
                if (tick === 2) pocket.registerSurface('test.video', 'video', JSON.stringify({asset:'two.mp4', fit:'fill', autoplay:true}));
            };
        "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let _ = frame_json(handle);
        let first = frame_json(handle);
        let first_op = first["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "video")
            .unwrap();
        assert_eq!(first_op["id"], "test.video");
        assert_eq!(first_op["asset"], "one.mp4");
        assert_eq!(first_op["fit"], "contain");
        assert_eq!(first_op["autoplay"], false);

        let second = frame_json(handle);
        assert_ne!(second["unchanged"], serde_json::json!(true));
        let second_op = second["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "video")
            .unwrap();
        assert_eq!(second_op["id"], "test.video");
        assert_eq!(second_op["asset"], "two.mp4");
        assert_eq!(second_op["fit"], "fill");
        assert_eq!(second_op["autoplay"], true);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn legacy_video_surface_without_autoplay_metadata_keeps_native_default() {
        let handle = pocket_create(160.0, 120.0);
        let source = CString::new(
            r#"
            const surface = pocket.registerSurface('legacy.video', 'video', '{"asset":"legacy.mp4"}');
            const node = ui.createNode(3);
            ui.setProp(node, 1, 80); ui.setProp(node, 2, 40);
            ui.setCompositorSurface(node, surface, 0);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
        "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let frame = frame_json(handle);
        let op = frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "video")
            .unwrap();
        assert_eq!(op["autoplay"], true);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn host_surface_projection_uses_inline_clip_for_nested_and_fully_clipped_nodes() {
        let handle = pocket_create(80.0, 80.0);
        let source = CString::new(
            r#"
            const surface = pocket.registerSurface('test.clip', 'glass', '{"radius":18}');

            const outer = ui.createNode(0);
            ui.setProp(outer, 1, 30);
            ui.setProp(outer, 2, 25);
            ui.setProp(outer, 30, 1);

            const inner = ui.createNode(0);
            ui.setProp(inner, 1, 20);
            ui.setProp(inner, 2, 10);
            ui.setProp(inner, 30, 1);

            const partiallyVisible = ui.createNode(3);
            ui.setProp(partiallyVisible, 1, 30);
            ui.setProp(partiallyVisible, 2, 100);
            ui.setProp(partiallyVisible, 21, 0);
            ui.setProp(partiallyVisible, 128, -5);
            ui.setCompositorSurface(partiallyVisible, surface, 0);

            const fullyClippedParent = ui.createNode(0);
            ui.setProp(fullyClippedParent, 1, 10);
            ui.setProp(fullyClippedParent, 2, 10);
            ui.setProp(fullyClippedParent, 24, 1);
            ui.setProp(fullyClippedParent, 25, 0);
            ui.setProp(fullyClippedParent, 28, 40);
            ui.setProp(fullyClippedParent, 30, 1);
            const fullyClipped = ui.createNode(3);
            ui.setProp(fullyClipped, 1, 30);
            ui.setProp(fullyClipped, 2, 100);
            ui.setProp(fullyClipped, 21, 0);
            ui.setProp(fullyClipped, 128, 20);
            ui.setCompositorSurface(fullyClipped, surface, 0);

            ui.insertBefore(inner, partiallyVisible, 0);
            ui.insertBefore(outer, inner, 0);
            ui.insertBefore(fullyClippedParent, fullyClipped, 0);
            ui.insertBefore(1, outer, 0);
            ui.insertBefore(1, fullyClippedParent, 0);
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let frame = frame_json(handle);
        let host_ops = frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|op| op["type"] == "hostSurface")
            .collect::<Vec<_>>();
        assert_eq!(host_ops.len(), 1, "fully clipped surface is omitted");
        let op = host_ops[0];
        assert_eq!(op["id"], "test.clip");
        assert_eq!(
            op["x"], -5.0,
            "the unclipped full bound keeps its negative origin"
        );
        assert_eq!(op["y"], 0.0);
        assert_eq!(op["w"], 30.0);
        assert_eq!(
            op["h"], 100.0,
            "full geometry is preserved for surface optics"
        );
        assert_eq!(op["clip"]["x"], 0.0);
        assert_eq!(op["clip"]["y"], 0.0);
        assert_eq!(op["clip"]["w"], 20.0);
        assert_eq!(op["clip"]["h"], 10.0, "nested overflow clips are retained");

        // The real tree above exercises nested scissors. SURFACE_QUAD also
        // carries inline visible bounds when no SCISSOR accompanies it, so
        // verify the host intersects that contract with a viewport-only clip.
        let nodes = [NodeMeta {
            id: -7,
            kind: "hostSurface".into(),
            asset: String::new(),
            surface_kind: "glass".into(),
            surface_parameters: binary_bridge::encode_json_to_binary(
                &serde_json::json!({"radius": 18}),
                8192,
            )
            .unwrap(),
            video_id: "test.clip".into(),
            fit: "fill".into(),
            autoplay: true,
            texture: -1,
            surface: 7,
            from_pack: false,
        }];
        let mut words = vec![
            10,
            7,
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            30.0f32.to_bits(),
            100.0f32.to_bits(),
            0,
            (25 << 16) | 30,
            0,
        ];
        let operation = Operation {
            opcode: 10,
            words: &words,
            clip: DamageRect::new(0, 0, 80, 80),
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &operation,
            &nodes,
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].w, 30.0);
        assert_eq!(projected[0].h, 100.0);
        assert_eq!(projected[0].clip.w, 30.0);
        assert_eq!(projected[0].clip.h, 25.0);

        words[6] = (90 << 16) | 90;
        words[7] = (10 << 16) | 10;
        let fully_clipped_operation = Operation {
            opcode: 10,
            words: &words,
            clip: DamageRect::new(0, 0, 80, 80),
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &fully_clipped_operation,
            &nodes,
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        assert!(
            projected.is_empty(),
            "inline bounds outside the viewport draw nothing"
        );
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn mesh_effect_drawlist_markers_reach_json_and_pfb_v2() {
        let viewport = DamageRect::new(0, 0, 8, 8);
        let mut words = vec![
            11,
            0,
            (8 << 16) | 8,
            3,
            1.0f32.to_bits(),
            0.9f32.to_bits(),
            0.8f32.to_bits(),
            0.1f32.to_bits(),
            0.2f32.to_bits(),
            0.3f32.to_bits(),
        ];
        let operation = Operation {
            opcode: 11,
            words: &words,
            clip: viewport,
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &operation,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(projected[0].kind, "meshLayerBegin");
        let legacy = serde_json::to_value(&projected[0]).unwrap();
        assert_eq!(legacy["type"], "meshLayerBegin");
        assert_eq!(legacy["color"], 3);
        assert_eq!(legacy["uvs"][0], 1.0);
        assert!((legacy["uvs"][5].as_f64().unwrap() - 0.3).abs() < 1e-6);
        let mut writer = BinaryFrameWriter::new();
        writer.op(&projected[0]).unwrap();
        assert_eq!(writer.bytes[0], 9);
        assert_eq!(
            u32::from_le_bytes(writer.bytes[33..37].try_into().unwrap()),
            3
        );
        assert_eq!(BINARY_FRAME_VERSION, 2);

        words[4] = f32::NAN.to_bits();
        let invalid = Operation {
            opcode: 11,
            words: &words,
            clip: viewport,
        };
        assert!(append_draw_operation(
            &mut Vec::new(),
            &invalid,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .is_err());
    }

    #[test]
    fn rounded_rect_drawlist_preserves_fill_and_versions_ring_frames() {
        let make_rounded = |border_width: f32| {
            let words = vec![
                17,
                1.25f32.to_bits(),
                2.0f32.to_bits(),
                20.0f32.to_bits(),
                10.0f32.to_bits(),
                3.0f32.to_bits(),
                border_width.to_bits(),
                0xff11_2233,
            ];
            let operation = Operation {
                opcode: 17,
                words: &words,
                clip: DamageRect::new(4, 5, 24, 15),
            };
            let mut projected = Vec::new();
            append_draw_operation(
                &mut projected,
                &operation,
                &[],
                &mut Ui::new(),
                &mut HashSet::new(),
            )
            .unwrap();
            assert_eq!(projected.len(), 1);
            projected.pop().unwrap()
        };
        let make_frame = |op| FrameResult {
            frame: 1,
            width: 32.0,
            height: 32.0,
            ops: Rc::new(vec![op]),
            auxiliary: None,
            events: Vec::new(),
            resources: Vec::new(),
            released_resources: Vec::new(),
        };

        let fill = make_rounded(0.0);
        assert_eq!((fill.x, fill.y, fill.w, fill.h), (1.25, 2.0, 20.0, 10.0));
        assert_eq!(fill.clip.x, 4.0);
        assert_eq!(fill.clip.y, 5.0);
        assert_eq!(fill.color, Some(0xff33_2211));
        let legacy = serde_json::to_value(&fill).unwrap();
        assert_eq!(legacy["type"], "rounded");
        assert_eq!(legacy["borderWidth"], 0.0);
        let mut writer = BinaryFrameWriter::new();
        writer.op(&fill).unwrap();
        assert_eq!(writer.bytes[0], 1, "fill keeps the existing rounded tag");
        let fill_frame = encode_binary_frame(&make_frame(fill)).unwrap();
        assert_eq!(u16::from_le_bytes([fill_frame[4], fill_frame[5]]), 2);

        let ring = make_rounded(2.0);
        assert_eq!(ring.border_width, Some(2.0));
        let mut writer = BinaryFrameWriter::new();
        writer.op(&ring).unwrap();
        assert_eq!(writer.bytes[0], 15, "ring uses the appended PFB tag");
        assert_eq!(writer.bytes.len(), 45);
        assert_eq!(
            f32::from_le_bytes(writer.bytes[41..45].try_into().unwrap()),
            2.0
        );
        let ring_frame = encode_binary_frame(&make_frame(ring)).unwrap();
        assert_eq!(u16::from_le_bytes([ring_frame[4], ring_frame[5]]), 3);

        let mut auxiliary_frame = make_frame(make_rounded(0.0));
        auxiliary_frame.auxiliary = Some(SurfaceFrame {
            width: 12.0,
            height: 8.0,
            ops: Rc::new(vec![make_rounded(1.0)]),
        });
        let encoded_auxiliary = encode_binary_frame(&auxiliary_frame).unwrap();
        assert_eq!(
            u16::from_le_bytes([encoded_auxiliary[4], encoded_auxiliary[5]]),
            3
        );
    }

    #[test]
    fn native_arc_drawlist_roundtrips_json_and_versions_full_and_patch_frames() {
        let words = vec![
            18,
            115.25f32.to_bits(),
            105.5f32.to_bits(),
            47.0f32.to_bits(),
            8.0f32.to_bits(),
            15.0f32.to_bits(),
            (-90.0f32).to_bits(),
            0xff12_3456,
        ];
        let operation = Operation {
            opcode: 18,
            words: &words,
            clip: DamageRect::new(4, 5, 224, 214),
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &operation,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(projected.len(), 1);
        let arc = projected.pop().unwrap();
        assert_eq!(arc.kind, "arc");
        assert_eq!((arc.x, arc.y, arc.w, arc.h), (64.25, 54.5, 102.0, 102.0));
        assert_eq!(arc.color, Some(0xff56_3412));
        assert_eq!(arc.radius, Some(47.0));
        assert_eq!(arc.border_width, Some(8.0));
        assert_eq!(arc.start_angle, Some(15.0));
        assert_eq!(arc.sweep_angle, Some(-90.0));
        assert_eq!(arc.clip.x, 4.0);
        assert_eq!(arc.clip.y, 5.0);
        let legacy = serde_json::to_value(&arc).unwrap();
        assert_eq!(legacy["type"], "arc");
        assert_eq!(legacy["startAngle"], 15.0);
        assert_eq!(legacy["sweepAngle"], -90.0);

        let mut writer = BinaryFrameWriter::new();
        writer.op(&arc).unwrap();
        assert_eq!(writer.bytes[0], 16);
        assert_eq!(writer.bytes.len(), 53);
        assert_eq!(
            f32::from_le_bytes(writer.bytes[45..49].try_into().unwrap()),
            15.0
        );
        assert_eq!(
            f32::from_le_bytes(writer.bytes[49..53].try_into().unwrap()),
            -90.0
        );

        let make_frame = |ops| FrameResult {
            frame: 12,
            width: 240.0,
            height: 240.0,
            ops: Rc::new(ops),
            auxiliary: None,
            events: Vec::new(),
            resources: Vec::new(),
            released_resources: Vec::new(),
        };
        let full = encode_binary_frame(&make_frame(vec![arc.clone()])).unwrap();
        assert_eq!(
            u16::from_le_bytes([full[4], full[5]]),
            BINARY_FRAME_ARC_VERSION
        );

        // PFP1 embeds only the inserted op segment in its PFB1 payload. The
        // same encoder must select v4 there so the Flutter patch decoder accepts
        // tag 16 before the outer splice is applied.
        let patch_payload = encode_binary_frame_with_ops(&make_frame(Vec::new()), &[arc]).unwrap();
        assert_eq!(
            u16::from_le_bytes([patch_payload[4], patch_payload[5]]),
            BINARY_FRAME_ARC_VERSION
        );
        assert_eq!(patch_payload[28], 16);

        // Frames without arcs keep their established wire versions.
        let empty_frame = encode_binary_frame(&make_frame(Vec::new())).unwrap();
        assert_eq!(
            u16::from_le_bytes([empty_frame[4], empty_frame[5]]),
            BINARY_FRAME_VERSION
        );
        let short = Operation {
            opcode: 18,
            words: &words[..7],
            clip: DamageRect::new(0, 0, 240, 240),
        };
        assert!(append_draw_operation(
            &mut Vec::new(),
            &short,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap_err()
        .contains("expected 8"));
    }

    #[test]
    fn rounded_gradient_roundtrips_json_and_versions_full_patch_and_auxiliary_frames() {
        let words = vec![
            19,
            15.25f32.to_bits(),
            12.5f32.to_bits(),
            44.0f32.to_bits(),
            28.0f32.to_bits(),
            8.0f32.to_bits(),
            0x8060_4020,
            0xdc78_6450,
            3,
            0x96dc_e6f0,
            0.35f32.to_bits(),
        ];
        let operation = Operation {
            opcode: 19,
            words: &words,
            clip: DamageRect::new(10, 11, 30, 41),
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &operation,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(projected.len(), 1);
        let gradient = projected.pop().unwrap();
        assert_eq!(gradient.kind, "roundedGradient");
        assert_eq!((gradient.x, gradient.y, gradient.w, gradient.h), (15.25, 12.5, 44.0, 28.0));
        assert_eq!(gradient.from_color, Some(0x8020_4060));
        assert_eq!(gradient.to_color, Some(0xdc50_6478));
        assert_eq!(gradient.direction, Some(3));
        assert_eq!(gradient.radius, Some(8.0));
        assert_eq!(gradient.via_color, Some(0x96f0_e6dc));
        assert_eq!(gradient.via_position, Some(0.35));
        assert_eq!(gradient.clip.x, 10.0);

        let legacy = serde_json::to_value(&gradient).unwrap();
        assert_eq!(legacy["type"], "roundedGradient");
        assert_eq!(legacy["from"], 0x8020_4060u32);
        assert_eq!(legacy["to"], 0xdc50_6478u32);
        assert_eq!(legacy["direction"], 3);
        assert_eq!(legacy["radius"], 8.0);
        assert_eq!(legacy["viaColor"], 0x96f0_e6dcu32);
        assert!((legacy["viaPosition"].as_f64().unwrap() - 0.35).abs() < 1e-6);

        let mut writer = BinaryFrameWriter::new();
        writer.op(&gradient).unwrap();
        assert_eq!(writer.bytes[0], 17);
        assert_eq!(writer.bytes.len(), 58);
        assert_eq!(writer.bytes[49], 1, "a complete middle stop has a strict true flag");
        assert_eq!(
            u32::from_le_bytes(writer.bytes[50..54].try_into().unwrap()),
            0x96f0_e6dc
        );
        assert_eq!(
            f32::from_le_bytes(writer.bytes[54..58].try_into().unwrap()),
            0.35
        );

        let make_frame = |ops| FrameResult {
            frame: 13,
            width: 240.0,
            height: 160.0,
            ops: Rc::new(ops),
            auxiliary: None,
            events: Vec::new(),
            resources: Vec::new(),
            released_resources: Vec::new(),
        };
        let full = encode_binary_frame(&make_frame(vec![gradient.clone()])).unwrap();
        assert_eq!(
            u16::from_le_bytes([full[4], full[5]]),
            BINARY_FRAME_ROUNDED_GRADIENT_VERSION
        );
        assert_eq!(full[28], 17);

        let patch_payload =
            encode_binary_frame_with_ops(&make_frame(Vec::new()), &[gradient.clone()]).unwrap();
        assert_eq!(
            u16::from_le_bytes([patch_payload[4], patch_payload[5]]),
            BINARY_FRAME_ROUNDED_GRADIENT_VERSION
        );
        assert_eq!(patch_payload[28], 17);

        let mut auxiliary_frame = make_frame(Vec::new());
        auxiliary_frame.auxiliary = Some(SurfaceFrame {
            width: 80.0,
            height: 60.0,
            ops: Rc::new(vec![gradient.clone()]),
        });
        let encoded_auxiliary = encode_binary_frame(&auxiliary_frame).unwrap();
        assert_eq!(
            u16::from_le_bytes([encoded_auxiliary[4], encoded_auxiliary[5]]),
            BINARY_FRAME_ROUNDED_GRADIENT_VERSION
        );

        let mut two_stop_words = words.clone();
        two_stop_words[10] = f32::NAN.to_bits();
        let two_stop_operation = Operation {
            opcode: 19,
            words: &two_stop_words,
            clip: DamageRect::new(0, 0, 240, 160),
        };
        let mut two_stop = Vec::new();
        append_draw_operation(
            &mut two_stop,
            &two_stop_operation,
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .unwrap();
        let two_stop = two_stop.pop().unwrap();
        let two_stop_json = serde_json::to_value(&two_stop).unwrap();
        assert!(two_stop_json.get("viaColor").is_none());
        assert!(two_stop_json.get("viaPosition").is_none());
        let mut writer = BinaryFrameWriter::new();
        writer.op(&two_stop).unwrap();
        assert_eq!(writer.bytes[49], 0);
        assert_eq!(writer.bytes.len(), 50);

        let mut malformed = two_stop.clone();
        malformed.via_color = Some(0xff00_0000);
        assert!(BinaryFrameWriter::new().op(&malformed).is_err());
        let mut zero_position = two_stop.clone();
        zero_position.via_color = Some(0xff00_0000);
        zero_position.via_position = Some(0.0);
        assert!(BinaryFrameWriter::new().op(&zero_position).is_err());
        let mut infinite_position = two_stop.clone();
        infinite_position.via_color = Some(0xff00_0000);
        infinite_position.via_position = Some(f32::INFINITY);
        assert!(BinaryFrameWriter::new().op(&infinite_position).is_err());
        for (index, value) in [(8, 4), (10, f32::INFINITY.to_bits()), (10, 0)] {
            let mut invalid_words = words.clone();
            invalid_words[index] = value;
            let invalid = Operation {
                opcode: 19,
                words: &invalid_words,
                clip: DamageRect::new(0, 0, 240, 160),
            };
            assert!(append_draw_operation(
                &mut Vec::new(),
                &invalid,
                &[],
                &mut Ui::new(),
                &mut HashSet::new(),
            )
            .is_err());
        }
        let mut invalid_geometry = words.clone();
        invalid_geometry[3] = 0.0f32.to_bits();
        assert!(append_draw_operation(
            &mut Vec::new(),
            &Operation {
                opcode: 19,
                words: &invalid_geometry,
                clip: DamageRect::new(0, 0, 240, 160),
            },
            &[],
            &mut Ui::new(),
            &mut HashSet::new(),
        )
        .is_err());
    }

    #[test]
    fn repeated_texture_triangle_keeps_uv_and_sampler_mode_in_json_and_pfb() {
        let mut ui = Ui::new();
        let texture =
            ui.upload_texture(&[0xff, 0x00, 0x00, 0xff], 1, 1, pocket_spec::psm::PSM_8888);
        assert!(texture >= 0);
        let xy = |x: i16, y: i16| x as u16 as u32 | ((y as u16 as u32) << 16);
        let words = vec![
            pocket_spec::draw_op::TEX_TRI_REPEAT,
            texture as u32,
            xy(0, 0),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            xy(7, 0),
            1.25f32.to_bits(),
            0.0f32.to_bits(),
            xy(0, 7),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            u32::MAX,
        ];
        let operation = Operation {
            opcode: pocket_spec::draw_op::TEX_TRI_REPEAT,
            words: &words,
            clip: DamageRect::new(0, 0, 8, 8),
        };
        let mut projected = Vec::new();
        append_draw_operation(
            &mut projected,
            &operation,
            &[],
            &mut ui,
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(projected.len(), 1);
        assert!(projected[0].repeat_texture);
        assert_eq!(projected[0].uvs.as_ref().unwrap()[2], 1.25);

        let legacy = serde_json::to_value(&projected[0]).unwrap();
        assert_eq!(legacy["type"], "textureTriangle");
        assert_eq!(legacy["repeatTexture"], true);
        assert_eq!(legacy["uvs"][2], 1.25);

        let mut writer = BinaryFrameWriter::new();
        writer.op(&projected[0]).unwrap();
        assert_eq!(
            writer.bytes[0], 14,
            "repeat sampler uses the append-only PFB tag"
        );
    }

    #[test]
    fn subpixel_texture_triangles_preserve_xy_uv_sampler_and_pfb() {
        let mut ui = Ui::new();
        let texture = ui.upload_texture(&[255; 4], 1, 1, pocket_spec::psm::PSM_8888);
        for opcode in [15u32, 16] {
            let mut words = vec![opcode, texture as u32];
            for value in [
                0.25f32, 0.375, -0.125, 0.0, 7.75, 0.625, 1.25, 0.0, 0.5, 7.875, 0.0, 1.0,
            ] {
                words.push(value.to_bits());
            }
            words.push(u32::MAX);
            let project = |words: &[u32], ui: &mut Ui| {
                let mut projected = Vec::new();
                append_draw_operation(
                    &mut projected,
                    &Operation {
                        opcode,
                        words,
                        clip: DamageRect::new(0, 0, 8, 8),
                    },
                    &[],
                    ui,
                    &mut HashSet::new(),
                )
                .map(|_| projected)
            };
            let projected = project(&words, &mut ui).unwrap();
            let triangle = &projected[0];
            assert_eq!(triangle.points.as_ref().unwrap()[0].x, 0.25);
            assert_eq!(triangle.points.as_ref().unwrap()[0].y, 0.375);
            assert_eq!(triangle.points.as_ref().unwrap()[2].y, 7.875);
            assert_eq!(triangle.uvs.as_ref().unwrap()[0], -0.125);
            assert_eq!(triangle.repeat_texture, opcode == 16);
            let json = serde_json::to_value(triangle).unwrap();
            assert_eq!(json["points"][0]["x"], 0.25);
            let mut writer = BinaryFrameWriter::new();
            writer.op(triangle).unwrap();
            assert_eq!(writer.bytes[0], if opcode == 16 { 14 } else { 4 });
            // PFB already has float XY: no second tag or Dart projection is needed.
            let asset_bytes = triangle.asset.as_ref().unwrap().len();
            let xy_offset = 33 + 4 + asset_bytes + 4;
            assert_eq!(
                f32::from_le_bytes(writer.bytes[xy_offset..xy_offset + 4].try_into().unwrap()),
                0.25
            );
            assert!(project(&words[..14], &mut ui).is_err());
            let mut invalid = words.clone();
            invalid[2] = f32::NAN.to_bits();
            assert!(project(&invalid, &mut ui).is_err());
            invalid = words.clone();
            invalid[4] = f32::INFINITY.to_bits();
            assert!(project(&invalid, &mut ui).is_err());
        }
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
    fn binary_frame_delta_encodes_draw_ops_without_json() {
        let handle = pocket_create(320.0, 480.0);
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
        let mut length = 0u64;
        let pointer = unsafe { pocket_frame_delta_binary(handle, 16.0, &mut length) };
        assert!(!pointer.is_null());
        assert!(length > 32);
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
        assert_eq!(&bytes[..4], b"PFB1");
        // PFB1 v2 carries the extended operation/resource envelope.
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 2);
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 3);
        // Header (24 bytes) is followed by the operation count. The source
        // above emits at least one rect operation.
        let op_count = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        assert!(op_count > 0);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn binary_duplex_reaches_quickjs_and_returns_without_json() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let source = CString::new(
            r#"globalThis.__pocketDuplexEvent = function(type, flags, target, a0, a1) {
                pocket.duplex.emit(type + 1, flags + 1, target + 1, a0 + 0.25, a1 + 0.5);
            };"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let producer = unsafe { (&*handle).duplex.claim_ingress_producer().unwrap() };
        let reservation = producer.reserve(1).unwrap();
        unsafe {
            ptr::write(
                producer
                    .payload_ptr(reservation)
                    .unwrap()
                    .cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage {
                    msg_type: 11,
                    flags: 2,
                    target_id: 101,
                    arg0: 1.5,
                    arg1: 2.5,
                },
            );
        }
        assert!(producer.commit(reservation));

        assert_eq!(unsafe { pocket_duplex_step(handle) }, 1);
        let consumer = unsafe { (&*handle).duplex.claim_egress_consumer().unwrap() };
        let (payload, count) = consumer.peek(1).unwrap();
        assert_eq!(count, 1);
        let message = unsafe { *payload.cast::<duplex::DuplexMessage>() };
        assert_eq!(message.msg_type, 12);
        assert_eq!(message.flags, 3);
        assert_eq!(message.target_id, 102);
        assert!((message.arg0 - 1.75).abs() < f32::EPSILON);
        assert!((message.arg1 - 3.0).abs() < f32::EPSILON);
        assert!(consumer.consume(1));
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn binary_duplex_keeps_ingress_when_guest_has_no_or_failing_handler() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let source = CString::new("globalThis.frame = function() {};").unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let producer = unsafe { (&*handle).duplex.claim_ingress_producer().unwrap() };
        let reservation = producer.reserve(1).unwrap();
        unsafe {
            ptr::write(
                producer
                    .payload_ptr(reservation)
                    .unwrap()
                    .cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage {
                    msg_type: 9,
                    ..duplex::DuplexMessage::default()
                },
            );
        }
        assert!(producer.commit(reservation));
        assert_eq!(unsafe { pocket_duplex_step(handle) }, 0);
        assert_eq!(
            unsafe { (&*handle).duplex_ingress_consumer.peek().unwrap().msg_type },
            9
        );

        let failing = CString::new(
            "globalThis.__pocketDuplexEvent = function() { throw new Error('duplex failure'); };
            ",
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, failing.as_ptr()) }, 0);
        assert_eq!(unsafe { pocket_duplex_step(handle) }, -1);
        assert_eq!(
            unsafe { (&*handle).duplex_ingress_consumer.peek().unwrap().msg_type },
            9
        );
        let error = unsafe { CStr::from_ptr(pocket_last_error(handle)) }.to_string_lossy();
        assert!(
            error.contains("duplex failure"),
            "unexpected error: {error}"
        );
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn binary_duplex_js_emit_respects_full_egress_without_overwrite() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let source = CString::new(
            "globalThis.__pocketDuplexEvent = function() { pocket.duplex.emit(99, 0, 1, 2, 3); };",
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let producer = unsafe { (&*handle).duplex.claim_ingress_producer().unwrap() };
        let reservation = producer
            .reserve((duplex::RING_CAPACITY - 1) as u32)
            .unwrap();
        for index in 0..reservation.count() {
            unsafe {
                ptr::write(
                    producer
                        .payload_ptr(reservation)
                        .unwrap()
                        .cast::<duplex::DuplexMessage>()
                        .add(index as usize),
                    duplex::DuplexMessage {
                        msg_type: index as u16,
                        ..duplex::DuplexMessage::default()
                    },
                );
            }
        }
        assert!(producer.commit(reservation));
        assert_eq!(
            unsafe { pocket_duplex_step(handle) },
            (duplex::RING_CAPACITY - 1) as i32
        );
        let consumer = unsafe { (&*handle).duplex.claim_egress_consumer().unwrap() };
        let (payload, count) = consumer.peek(1).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            unsafe { (*payload.cast::<duplex::DuplexMessage>()).msg_type },
            99
        );

        // The egress queue is full. A subsequent JS emit must fail without
        // changing the first published record.
        let reservation = producer.reserve(1).unwrap();
        unsafe {
            ptr::write(
                producer
                    .payload_ptr(reservation)
                    .unwrap()
                    .cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage::default(),
            );
        }
        assert!(producer.commit(reservation));
        assert_eq!(unsafe { pocket_duplex_step(handle) }, 1);
        assert_eq!(
            unsafe { (*payload.cast::<duplex::DuplexMessage>()).msg_type },
            99
        );
        assert!(consumer.consume(1));
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn binary_duplex_ffi_endpoint_contract_uses_retained_channel() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let source = CString::new(
            "globalThis.__pocketDuplexEvent = function(type, flags, target, a0, a1) { pocket.duplex.emit(type + 1, flags, target, a0, a1); };",
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let channel = unsafe { pocket_duplex_channel_acquire(handle) };
        assert!(!channel.is_null());
        let retained_channel = unsafe { pocket_duplex_channel_retain(channel) };
        assert_eq!(retained_channel, channel);
        let endpoint = unsafe { pocket_duplex_endpoint_acquire(handle) };
        assert!(!endpoint.is_null());

        let payload;
        let mut count = 0_u32;
        payload = unsafe { pocket_duplex_ingress_reserve(endpoint, 1, &mut count) };
        assert!(!payload.is_null());
        assert_eq!(count, 1);
        unsafe {
            ptr::write(
                payload.cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage {
                    msg_type: 20,
                    ..duplex::DuplexMessage::default()
                },
            );
        }
        assert_eq!(unsafe { pocket_duplex_ingress_publish(endpoint, count) }, 1);
        assert_eq!(unsafe { pocket_duplex_step(handle) }, 1);

        let mut output_count = 0_u32;
        let output = unsafe { pocket_duplex_egress_peek(endpoint, 1, &mut output_count) };
        assert!(!output.is_null());
        assert_eq!(output_count, 1);
        assert_eq!(
            unsafe { (*output.cast::<duplex::DuplexMessage>()).msg_type },
            21
        );
        assert_eq!(unsafe { pocket_duplex_egress_consume(endpoint, 1) }, 1);

        unsafe {
            pocket_duplex_endpoint_release(endpoint);
            pocket_duplex_channel_release(channel);
            pocket_duplex_channel_release(retained_channel);
            pocket_destroy(handle);
        }
    }

    #[test]
    fn binary_duplex_reload_keeps_old_endpoint_and_allocates_new_generation() {
        let handle = pocket_create(320.0, 480.0);
        assert!(!handle.is_null());
        let old_channel = unsafe { pocket_duplex_channel_acquire(handle) };
        let old_endpoint = unsafe { pocket_duplex_endpoint_acquire(handle) };
        assert!(!old_channel.is_null());
        assert!(!old_endpoint.is_null());

        let mut old_count = 0_u32;
        let old_payload = unsafe { pocket_duplex_ingress_reserve(old_endpoint, 1, &mut old_count) };
        assert!(!old_payload.is_null());
        unsafe {
            ptr::write(
                old_payload.cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage {
                    target_id: 0xfeed,
                    ..duplex::DuplexMessage::default()
                },
            );
        }

        // This is the same generation transition used by pocket_load and
        // pocket_load_bytecode, exercised directly without requiring a PAK
        // fixture. The old endpoint retains its old Arc and may finish its
        // in-flight publish, while the host receives a fresh channel.
        unsafe { reset_host_for_load(&mut *handle) };
        assert_eq!(
            unsafe { pocket_duplex_ingress_publish(old_endpoint, old_count) },
            1
        );
        let new_channel = unsafe { pocket_duplex_channel_acquire(handle) };
        let new_endpoint = unsafe { pocket_duplex_endpoint_acquire(handle) };
        assert!(!new_channel.is_null());
        assert!(!new_endpoint.is_null());
        assert_ne!(old_channel, new_channel);

        let mut new_count = 0_u32;
        let new_payload = unsafe { pocket_duplex_ingress_reserve(new_endpoint, 1, &mut new_count) };
        assert!(!new_payload.is_null());
        assert_eq!(new_count, 1);
        assert_eq!(
            unsafe { pocket_duplex_ingress_publish(new_endpoint, new_count) },
            1
        );

        unsafe {
            pocket_destroy(handle);
            pocket_duplex_endpoint_release(old_endpoint);
            pocket_duplex_endpoint_release(new_endpoint);
            pocket_duplex_channel_release(old_channel);
            pocket_duplex_channel_release(new_channel);
        }
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

    #[test]
    fn full_coordinate_pointer_sidecar_preserves_large_viewports_and_surfaces() {
        assert_eq!(
            pack_touch(TouchContact {
                id: 3,
                x: 479,
                y: 271,
                hit: 0,
                surface: 0
            }),
            (3 << TOUCH_LEGACY_ID_SHIFT) | (271 << 9) | 479,
        );
        assert_eq!(
            pack_touch(TouchContact {
                id: 9,
                x: 639,
                y: 359,
                hit: 0,
                surface: 0
            }),
            TOUCH_WIDE_MARKER | (9 << TOUCH_WIDE_ID_SHIFT) | (359 << 10) | 639,
        );
        assert_eq!(
            pack_touch_cancel(TouchContact {
                id: 3,
                x: 479,
                y: 271,
                hit: 0,
                surface: 0
            }),
            TOUCH_CANCEL_MARKER | (3 << TOUCH_LEGACY_ID_SHIFT),
        );
        let handle = pocket_create(2560.0, 1440.0);
        unsafe {
            (*handle).auxiliary_viewport = Some((1920.0, 1200.0));
        }
        let source = CString::new(
            r#"
            globalThis.frame = function(buttons, analog, touches, hits, surfaces,
                rightAnalog, axisDeltas, motion, text, coordinates) {
                const points = [];
                for (let i = 0; i < (touches ? touches.length : 0); i++) {
                    points.push({ packed: touches[i] >>> 0, hit: hits[i], surface: surfaces[i], coordinate: coordinates && coordinates[i] });
                }
                if (points.length) pocket._emitValue({ type: 'event', name: 'fullcoords.frame', payload: { points } });
            };
            "#,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, source.as_ptr()) },
            0,
            "{}",
            unsafe { CStr::from_ptr(pocket_last_error(handle)).to_string_lossy() }
        );

        for message in [
            r#"{"method":"input.pointer","payload":{"phase":"down","id":7,"x":2048,"y":1200}}"#,
            r#"{"method":"input.pointer","payload":{"phase":"down","id":8,"x":1500,"y":1100,"surface":"auxiliary"}}"#,
        ] {
            let message = CString::new(message).unwrap();
            assert_eq!(
                unsafe { pocket_send(handle, message.as_ptr()) },
                0,
                "{}",
                unsafe { CStr::from_ptr(pocket_last_error(handle)).to_string_lossy() }
            );
        }

        let frame = frame_json(handle);
        let frames = frame["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["name"] == "fullcoords.frame")
            .collect::<Vec<_>>();
        assert!(frames.len() >= 2, "{frame}");
        let first_points = frames[0]["payload"]["points"].as_array().unwrap();
        assert_eq!(first_points.len(), 1);
        assert_eq!(first_points[0]["coordinate"]["x"], 2048);
        assert_eq!(first_points[0]["coordinate"]["y"], 1200);
        assert_eq!(first_points[0]["surface"], 0);
        assert_ne!(
            first_points[0]["packed"].as_u64().unwrap() as u32 & TOUCH_COORDINATE_SIDECAR_MARKER,
            0
        );

        let both_points = frames
            .iter()
            .map(|event| event["payload"]["points"].as_array().unwrap())
            .find(|points| points.len() == 2)
            .expect("second down exposes both simultaneous contacts");
        assert_eq!(both_points[0]["coordinate"]["x"], 2048);
        assert_eq!(both_points[0]["coordinate"]["y"], 1200);
        assert_eq!(both_points[0]["surface"], 0);
        assert_eq!(both_points[1]["coordinate"]["x"], 1500);
        assert_eq!(both_points[1]["coordinate"]["y"], 1100);
        assert_eq!(both_points[1]["surface"], 1);

        let cancel = CString::new(
            r#"{"method":"input.pointer","payload":{"phase":"cancel","id":8,"x":1500,"y":1100,"surface":"auxiliary"}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, cancel.as_ptr()) }, 0);
        let after_cancel = frame_json(handle);
        let cancel_frame = after_cancel["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["name"] == "fullcoords.frame")
            .map(|event| event["payload"]["points"].as_array().unwrap())
            .find(|points| points.len() == 2 && points[1]["surface"] == 1)
            .expect("cancel keeps the contact/surface slots aligned for this frame");
        assert_eq!(cancel_frame[1]["coordinate"]["x"], 1500);
        assert_eq!(cancel_frame[1]["coordinate"]["y"], 1100);
        let cancel_word = cancel_frame[1]["packed"].as_u64().unwrap() as u32;
        assert_ne!(cancel_word & TOUCH_CANCEL_MARKER, 0);
        assert_ne!(cancel_word & TOUCH_COORDINATE_SIDECAR_MARKER, 0);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn packaged_guest_loads_real_host_assets() {
        let fixture = package_fixture();
        let source_file = CString::new(fixture.source.to_str().unwrap()).unwrap();
        let pak_file = CString::new(fixture.pak.to_str().unwrap()).unwrap();
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
        let fixture = package_fixture();
        let bytecode_file = CString::new(fixture.bytecode.to_str().unwrap()).unwrap();
        let pak_file = CString::new(fixture.pak.to_str().unwrap()).unwrap();
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
        let fixture = package_fixture();
        let mut bytecode = std::fs::read(&fixture.bytecode).unwrap();
        bytecode[bytecode::HEADER_LEN] ^= 1;
        let pak = std::fs::read(&fixture.pak).unwrap();
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

    #[test]
    fn duplex_pointer_message_uses_canonical_input_path() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
            const node = ui.createNode(0);
            ui.setProp(node, 1, 40); ui.setProp(node, 2, 24);
            ui.setProp(node, 64, 0xff336699); ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(event) {
                if (event.name === 'input.pointer' && event.payload.phase === 'up') {
                    ui.setProp(node, 64, 0xffcc6633);
                }
            };
            __pocketEvent.__binaryCapable = true;
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let endpoint = unsafe { pocket_duplex_endpoint_acquire(handle) };
        assert!(!endpoint.is_null());
        let count = 0u32;
        let write_pointer = |flags: u16| {
            let mut count = count;
            let payload = unsafe { pocket_duplex_ingress_reserve(endpoint, 1, &mut count) };
            assert!(!payload.is_null());
            unsafe {
                ptr::write(
                    payload.cast::<duplex::DuplexMessage>(),
                    duplex::DuplexMessage {
                        msg_type: 1,
                        flags,
                        target_id: 0,
                        arg0: 8.0,
                        arg1: 12.0,
                    },
                );
                assert_eq!(pocket_duplex_ingress_publish(endpoint, count), 1);
            }
        };
        write_pointer(1);
        let down = frame_json(handle);
        let down_color = down["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "rect")
            .and_then(|op| op["color"].as_u64());
        write_pointer(3);
        let up = frame_json(handle);
        let up_color = up["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "rect")
            .and_then(|op| op["color"].as_u64());
        assert_ne!(down_color, up_color);
        unsafe {
            pocket_duplex_endpoint_release(endpoint);
            pocket_destroy(handle);
        }
    }

    #[test]
    fn binary_pointer_fallback_does_not_overtake_queued_duplex_down() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
            const node = ui.createNode(0);
            ui.setProp(node, 1, 40); ui.setProp(node, 2, 24);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(event) {
                if (event.name === 'input.pointer') {
                    pocket._emitValue({type:'event', name:'input.seen', payload:{phase:event.payload.phase}});
                }
            };
            __pocketEvent.__binaryCapable = true;
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let endpoint = unsafe { pocket_duplex_endpoint_acquire(handle) };
        assert!(!endpoint.is_null());
        let mut count = 0u32;
        let payload = unsafe { pocket_duplex_ingress_reserve(endpoint, 1, &mut count) };
        assert!(!payload.is_null());
        unsafe {
            ptr::write(
                payload.cast::<duplex::DuplexMessage>(),
                duplex::DuplexMessage {
                    msg_type: 1,
                    flags: 1,
                    target_id: 0,
                    arg0: 8.0,
                    arg1: 12.0,
                },
            );
            assert_eq!(pocket_duplex_ingress_publish(endpoint, count), 1);
        }
        let fallback_up = binary_bridge::encode_json_to_binary(
            &serde_json::json!({"type":"event","name":"input.pointer","payload":{"phase":"up","id":0,"x":8,"y":12}}),
            4096,
        ).unwrap();
        assert_eq!(
            unsafe { pocket_send_binary(handle, fallback_up.as_ptr(), fallback_up.len()) },
            0
        );
        let frame = frame_json(handle);
        let phases = frame["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["name"] == "input.seen")
            .filter_map(|event| event["payload"]["phase"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(phases, vec!["down", "up"]);
        unsafe {
            pocket_duplex_endpoint_release(endpoint);
            pocket_destroy(handle);
        }
    }
    #[test]
    fn raw_text_edges_reach_real_guest_once_even_at_zero_delta() {
        let handle = pocket_create(80.0, 80.0);
        let source = CString::new(r#"globalThis.__pocketEvent=function(){}; globalThis.frame=function(){
            if (arguments[8].length) pocket._emit(JSON.stringify({method:'text.edge',params:{events:arguments[8]}}));
        };"#).unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        frame_json(handle);
        let message = CString::new(r#"{"method":"input.text","params":[{"kind":"keyDown","key":"A","repeat":true},{"kind":"composition","text":"中😀","selectionStart":1,"selectionEnd":3},{"kind":"compositionEnd"},{"kind":"commit","text":"中😀"},{"kind":"keyUp","key":"A"}]}"#).unwrap();
        assert_eq!(unsafe { pocket_send(handle, message.as_ptr()) }, 0);
        let pointer = unsafe { pocket_frame(handle, 0.0) };
        let frame: serde_json::Value =
            serde_json::from_str(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
        let events = frame["events"][0]["params"]["events"]
            .as_array()
            .unwrap_or_else(|| panic!("actual frame: {frame}"));
        assert_eq!(events.len(), 5);
        assert_eq!(events[0]["repeat"], true);
        assert_eq!(events[1]["text"], "中😀");
        assert_eq!(events[1]["selectionEnd"], 3);
        assert!(frame_json(handle)["events"].as_array().unwrap().is_empty());
        let bad = serde_json::json!({"method":"input.text","params":[{"kind":"commit","text":"valid"},{"kind":"composition","text":"😀","selectionStart":0,"selectionEnd":3}]});
        assert!(queue_text(unsafe { &mut *handle }, &bad).is_err());
        assert!(
            unsafe { &*handle }.pending_text.is_empty(),
            "batch admission is atomic"
        );
        for _ in 0..64 {
            queue_text(
                unsafe { &mut *handle },
                &serde_json::json!({"params":{"kind":"compositionEnd"}}),
            )
            .unwrap();
        }
        assert!(queue_text(
            unsafe { &mut *handle },
            &serde_json::json!({"params":{"kind":"compositionEnd"}})
        )
        .is_err());
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn analog_samples_and_center_release_reach_zero_delta_guest_frames() {
        unsafe {
            let host = pocket_create(80.0, 80.0);
            let source = CString::new(
                r#"let previousAxes = '';
                let guestFrames = 0;
                globalThis.__pocketWorkState = () => ({version:1,continuous:false,
                  simulationHz:60,framesUntilTimer:null});
                globalThis.__pocketSkipIdleFrames = (n) => n;
                globalThis.frame = (buttons, analog, _touches, _hits, _surfaces, rightAnalog) => {
                  guestFrames++;
                  const axes = String(analog) + ':' + String(rightAnalog);
                  pocket._emit(JSON.stringify({name:'analog.frame',params:{buttons,axes,guestFrames}}));
                  if (axes !== previousAxes) {
                    previousAxes = axes;
                    pocket._emit(JSON.stringify({name:'analog.seen',params:{axes}}));
                  }
                };"#,
            )
            .unwrap();
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);

            // Establish the idle scheduler state and consume the initial
            // neutral sample. Subsequent input boundaries use no elapsed
            // time, so any event proves that the one-shot input wake was
            // delivered by the zero-tick path.
            let initial = frame_json_with_delta(host, 1000.0 / 60.0);
            assert_eq!(initial["events"][0]["name"], "analog.frame");
            assert_eq!(initial["events"][0]["params"]["buttons"], 0);
            assert_eq!(initial["events"][1]["name"], "analog.seen");
            assert_eq!(initial["events"][1]["params"]["axes"], "32896:32896");
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let pressed = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":16384,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, pressed.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let pressed_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(pressed_frame["events"][0]["name"], "analog.frame");
            assert_eq!(pressed_frame["events"][0]["params"]["buttons"], 16384);
            assert_eq!(pressed_frame["events"][0]["params"]["guestFrames"], 2);
            assert_eq!(pocket_next_wake_delay_ms(host), 0.0);

            let released = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, released.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let released_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(released_frame["events"][0]["name"], "analog.frame");
            assert_eq!(released_frame["events"][0]["params"]["buttons"], 0);
            assert_eq!(released_frame["events"][0]["params"]["guestFrames"], 3);
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let unchanged_buttons = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, unchanged_buttons.as_ptr()), 0);
            assert!(!(*host).external_work_pending);
            let unchanged_buttons_frame = frame_json_with_delta(host, 0.0);
            assert!(unchanged_buttons_frame["events"]
                .as_array()
                .unwrap()
                .is_empty());
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let unchanged_axes = CString::new(
                r#"{"method":"input.axes","payload":{"axes":[{"id":0,"value":128},{"id":1,"value":128},{"id":2,"value":128},{"id":3,"value":128}]}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, unchanged_axes.as_ptr()), 0);
            assert!(!(*host).external_work_pending);
            let unchanged_axes_frame = frame_json_with_delta(host, 0.0);
            assert!(unchanged_axes_frame["events"]
                .as_array()
                .unwrap()
                .is_empty());
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let moved = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":16384,"analog":4660,"rightAnalog":22136}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, moved.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let moved_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(moved_frame["events"][0]["name"], "analog.frame");
            assert_eq!(moved_frame["events"][0]["params"]["buttons"], 16384);
            assert_eq!(moved_frame["events"][0]["params"]["guestFrames"], 4);
            assert_eq!(moved_frame["events"][1]["name"], "analog.seen");
            assert_eq!(moved_frame["events"][1]["params"]["axes"], "4660:22136");
            assert_eq!(pocket_next_wake_delay_ms(host), 0.0);

            // Holding a non-neutral stick must not bypass the fixed-step clock
            // on a zero-tick call, while a full tick does advance the guest.
            let held_zero_tick = frame_json_with_delta(host, 0.0);
            assert!(
                held_zero_tick["events"].as_array().unwrap().is_empty(),
                "held non-neutral stick must not step an extra guest frame on a zero-tick call"
            );
            assert_eq!(pocket_next_wake_delay_ms(host), 0.0);
            let held_full_tick = frame_json_with_delta(host, 1000.0 / 60.0);
            assert_eq!(held_full_tick["events"][0]["name"], "analog.frame");
            assert_eq!(held_full_tick["events"][0]["params"]["axes"], "4660:22136");
            assert_eq!(held_full_tick["events"][0]["params"]["buttons"], 16384);
            assert_eq!(held_full_tick["events"][0]["params"]["guestFrames"], 5);

            let centered = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, centered.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let centered_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(centered_frame["events"][0]["name"], "analog.frame");
            assert_eq!(centered_frame["events"][0]["params"]["buttons"], 0);
            assert_eq!(centered_frame["events"][0]["params"]["guestFrames"], 6);
            assert_eq!(centered_frame["events"][1]["name"], "analog.seen");
            assert_eq!(centered_frame["events"][1]["params"]["axes"], "32896:32896");
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let settled = frame_json_with_delta(host, 0.0);
            assert!(
                settled["events"].as_array().unwrap().is_empty(),
                "a settled neutral sample must not keep the ticker alive"
            );
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);
            pocket_destroy(host);
        }
    }

    #[test]
    fn queued_offload_replies_keep_scheduler_awake_across_single_delivery_frames() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NOTIFY_COUNT: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn notify() {
            NOTIFY_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        NOTIFY_COUNT.store(0, Ordering::Relaxed);
        let handle = pocket_create(80.0, 80.0);
        let config = CString::new(
            r#"{"generation":9,"session":3,"timeoutMs":5000,"methods":["compute.sum"]}"#,
        )
        .unwrap();
        let source = CString::new(
            r#"
            if (!offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[1,2]'}))) throw Error('submit 1');
            if (!offload.submit(JSON.stringify({v:1,id:2,method:'compute.sum',payload:'[3,4]'}))) throw Error('submit 2');
            globalThis.__pocketWorkState = () => ({version:1,continuous:false,simulationHz:60,framesUntilTimer:null});
            globalThis.__pocketSkipIdleFrames = (n) => n;
            globalThis.frame = () => {
              const reply = offload.take();
              if (reply) pocket._emit(JSON.stringify({name:'offload.reply',params:JSON.parse(reply)}));
            };
            "#,
        )
        .unwrap();
        unsafe {
            assert_eq!(
                pocket_configure_offload(handle, config.as_ptr(), Some(notify)),
                0
            );
            assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
            let initial = frame_json_with_delta(handle, 1000.0 / 60.0);
            assert!(initial["events"].as_array().unwrap().is_empty());
            assert_eq!(pocket_next_wake_delay_ms(handle), -1.0);

            assert!(!pocket_offload_take(handle, 0).is_null());
            assert!(!pocket_offload_take(handle, 0).is_null());
            assert!(pocket_offload_take(handle, 0).is_null());

            let reply1 =
                CString::new(r#"{"generation":9,"session":3,"id":1,"payload":"3"}"#).unwrap();
            let reply2 =
                CString::new(r#"{"generation":9,"session":3,"id":2,"payload":"7"}"#).unwrap();
            assert_eq!(pocket_offload_complete(handle, reply1.as_ptr()), 0);
            assert_eq!(pocket_offload_complete(handle, reply2.as_ptr()), 0);
            assert_eq!(pocket_offload_has_replies(handle), 1);

            pocket_notify_external_work(handle);
            let frame1 = frame_json_with_delta(handle, 0.0);
            assert_eq!(frame1["events"][0]["name"], "offload.reply");
            assert_eq!(frame1["events"][0]["params"]["id"], 1);
            assert_eq!(frame1["events"][0]["params"]["payload"], "3");
            assert_eq!(pocket_offload_has_replies(handle), 1);
            assert_eq!(
                pocket_next_wake_delay_ms(handle),
                0.0,
                "remaining queued replies must keep demand::capture continuous"
            );

            let frame2 = frame_json_with_delta(handle, 0.0);
            assert_eq!(frame2["events"][0]["name"], "offload.reply");
            assert_eq!(frame2["events"][0]["params"]["id"], 2);
            assert_eq!(frame2["events"][0]["params"]["payload"], "7");
            assert_eq!(pocket_offload_has_replies(handle), 0);
            assert_eq!(pocket_next_wake_delay_ms(handle), -1.0);

            let before_next_submit = NOTIFY_COUNT.load(Ordering::Relaxed);
            assert!(
                (*handle)
                    .offload
                    .as_ref()
                    .unwrap()
                    .submit_record(r#"{"v":1,"id":3,"method":"compute.sum","payload":"[5,6]"}"#),
                "emptying the second reply must rearm wake_pending for subsequent submits"
            );
            assert_eq!(NOTIFY_COUNT.load(Ordering::Relaxed), before_next_submit + 1);
            pocket_destroy(handle);
        }
    }

    #[test]
    fn production_worker_ffi_wakes_a_zero_delta_ui_turn_and_releases_its_channel() {
        use std::sync::{Condvar, Mutex};
        use std::time::{Duration, Instant};
        static WAKE: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());
        unsafe extern "C" fn notify() {
            let mut epoch = WAKE.0.lock().unwrap();
            *epoch += 1;
            WAKE.1.notify_all();
        }
        let worker = compile_test_worker_bytecode(br#"
            __pocketWorker.declareChannel(1,1,16,1,0);
            globalThis.__pocketWorkerTurn=(context,facts)=>{
                if(context.sequence===1) __pocketWorker.timer(1,context.nowMicros+50000,0);
                for(const fact of facts) if(fact.kind===6) __pocketWorker.publish(1,new Uint8Array([42]));
            };
        "#);
        let config = CString::new(serde_json::json!({
            "protocolVersion":1,"nativeGeneration":1,"bindingGeneration":BINDING_GENERATION,
            "tickHz":DEFAULT_TICK_HZ,"expectedRuntimeAbi":bytecode::runtime_abi(),
            "declaration":{"entry":"worker.js","nodes":[],"channels":[
                {"name":"results","kind":"snapshot","direction":"worker-to-ui","recordBytes":16,"capacity":1}
            ]},
            "policy":{"requiredCapabilities":["runtime.worker"],"allowedHttpOrigins":[]},
            "limits":{"heapBytes":16777216,"stackBytes":1048576,"turnBudgetMicros":10000,"windowMicros":100000,"quotaMicros":50000}
        }).to_string()).unwrap();
        let handle = pocket_create(80.0, 80.0);
        assert_eq!(
            unsafe {
                pocket_configure_worker(
                    handle,
                    worker.as_ptr(),
                    worker.len(),
                    config.as_ptr(),
                    Some(notify),
                )
            },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );
        let ui = CString::new(r#"
            __pocketWorkerChannels.configure(1,1);
            let delivered=false;
            globalThis.frame=()=>{
                const records=__pocketWorkerChannels.observe(1);
                if(!delivered && records.length) {
                    delivered=true;
                    pocket._emit(JSON.stringify({method:'worker.result',params:{value:records[0][0]}}));
                }
            };
        "#).unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, ui.as_ptr()) },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );
        let mut seen = *WAKE.0.lock().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let first = frame_json(handle);
        let mut delivered = first["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["params"]["value"] == 42);
        while !delivered {
            let guard = WAKE.0.lock().unwrap();
            let (guard, timeout) = WAKE
                .1
                .wait_timeout_while(
                    guard,
                    deadline.saturating_duration_since(Instant::now()),
                    |epoch| *epoch == seen,
                )
                .unwrap();
            seen = *guard;
            assert!(
                !timeout.timed_out(),
                "worker output did not wake UI: {:?}",
                unsafe { &*handle }
                    .worker_runtime
                    .as_ref()
                    .and_then(|worker| worker.last_error())
            );
            drop(guard);
            // This is the Dart listener's owner-thread handoff, never a call
            // into HostState from the worker thread. No periodic frame probe.
            unsafe {
                pocket_notify_external_work(handle);
            }
            let pointer = unsafe { pocket_frame(handle, 0.0) };
            assert!(
                unsafe { &*handle }.last_error.is_empty(),
                "{}",
                unsafe { &*handle }.last_error
            );
            let frame: serde_json::Value =
                serde_json::from_str(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
            delivered = frame["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["params"]["value"] == 42);
        }
        assert!(!unsafe { &*handle }
            .worker_bridge
            .as_ref()
            .unwrap()
            .has_pending_output());
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn ending_offline_replay_closes_its_provider_broker() {
        let handle = pocket_create(80.0, 80.0);
        let config = CString::new(
            r#"{"generation":9,"session":3,"timeoutMs":5000,"methods":["compute.sum"]}"#,
        )
        .unwrap();
        let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
        unsafe {
            assert_eq!(pocket_trace_clock_mode(handle, 2), 0);
            assert_eq!(pocket_trace_clock_begin_json(handle, empty.as_ptr()), 0);
            assert_eq!(pocket_configure_offload(handle, config.as_ptr(), None), 0);
            assert!(!pocket_trace_clock_end_json(handle).is_null());
            assert_eq!(pocket_trace_clock_mode(handle, 0), 0);
            assert!(!(*handle)
                .offload
                .as_ref()
                .unwrap()
                .submit_record(r#"{"v":1,"id":1,"method":"compute.sum","payload":"[2,3]"}"#,));
            pocket_destroy(handle);
        }
    }

    #[test]
    fn production_offload_recording_replays_without_host_provider() {
        let config = CString::new(
            r#"{"generation":9,"session":3,"timeoutMs":5000,"methods":["compute.sum"]}"#,
        )
        .unwrap();
        let source = CString::new(r#"
            if(!offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[2,3]'}))) throw Error('submit');
            globalThis.frame=()=>{const reply=offload.take();if(reply)pocket._emit(JSON.stringify({method:'sum',params:JSON.parse(reply)}));};
        "#).unwrap();
        let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
        struct Host(*mut HostState);
        impl Drop for Host {
            fn drop(&mut self) {
                unsafe {
                    pocket_destroy(self.0);
                }
            }
        }
        let run = |handle: *mut HostState, operation, recording| unsafe {
            let status = match operation {
                0 => pocket_configure_offload(handle, config.as_ptr(), None),
                1 => pocket_eval(handle, source.as_ptr()),
                2 if recording => {
                    let request = pocket_offload_take(handle, 0);
                    assert!(!request.is_null());
                    let request: serde_json::Value =
                        serde_json::from_slice(CStr::from_ptr(request).to_bytes()).unwrap();
                    assert_eq!(request["method"], "compute.sum");
                    let result =
                        CString::new(r#"{"generation":9,"session":3,"id":1,"payload":"5"}"#)
                            .unwrap();
                    assert_eq!(pocket_offload_complete(handle, result.as_ptr()), 0);
                    0
                }
                2 => 0, // Replay facts executor completes the original broker.
                3 => {
                    let output = pocket_frame(handle, 0.0);
                    assert!(!output.is_null(), "{}", (*handle).last_error);
                    return Some(
                        serde_json::from_slice::<serde_json::Value>(
                            CStr::from_ptr(output).to_bytes(),
                        )
                        .unwrap(),
                    );
                }
                4 => pocket_stop_async(handle),
                _ => unreachable!(),
            };
            assert_eq!(status, 0, "{}", (*handle).last_error);
            None
        };
        let finish = |handle| unsafe {
            let output = pocket_trace_clock_end_json(handle);
            assert!(!output.is_null(), "{}", (*handle).last_error);
            CStr::from_ptr(output).to_str().unwrap().to_owned()
        };
        let original = Host(pocket_create(80.0, 80.0));
        assert_eq!(unsafe { pocket_trace_clock_mode(original.0, 1) }, 0);
        let mut tape = Vec::new();
        for operation in 0..5 {
            assert_eq!(
                unsafe { pocket_trace_clock_begin_json(original.0, empty.as_ptr()) },
                0
            );
            let frame = run(original.0, operation, true);
            if operation == 3 {
                assert_eq!(
                    frame.as_ref().unwrap()["events"][0]["params"]["payload"],
                    "5"
                );
            }
            tape.push((operation, finish(original.0), frame));
        }
        assert_eq!(unsafe { pocket_trace_clock_mode(original.0, 0) }, 0);
        drop(original);
        for _ in 0..3 {
            let replay = Host(pocket_create(80.0, 80.0));
            assert_eq!(unsafe { pocket_trace_clock_mode(replay.0, 2) }, 0);
            for (operation, expected, frame) in &tape {
                let input = CString::new(expected.as_str()).unwrap();
                assert_eq!(
                    unsafe { pocket_trace_clock_begin_json(replay.0, input.as_ptr()) },
                    0,
                    "{}",
                    unsafe { &*replay.0 }.last_error
                );
                assert_eq!(&run(replay.0, *operation, false), frame);
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&finish(replay.0)).unwrap(),
                    serde_json::from_str::<serde_json::Value>(expected).unwrap()
                );
            }
            assert_eq!(unsafe { pocket_trace_clock_mode(replay.0, 0) }, 0);
        }
    }

    #[test]
    fn production_worker_recording_replays_timers_and_latches_after_destroy() {
        use std::sync::{Condvar, Mutex};
        use std::time::{Duration, Instant};
        static WAKE: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());
        unsafe extern "C" fn notify() {
            let mut epoch = WAKE.0.lock().unwrap();
            *epoch += 1;
            WAKE.1.notify_all();
        }
        struct OwnedHost(*mut HostState);
        impl Drop for OwnedHost {
            fn drop(&mut self) {
                unsafe {
                    pocket_destroy(self.0);
                }
            }
        }
        let worker = compile_test_worker_bytecode(br#"
            __pocketWorker.declareChannel(1,1,16,1,0);
            globalThis.__pocketWorkerTurn=(context,facts)=>{
                if(context.sequence===1) __pocketWorker.timer(1,context.nowMicros+50000,0);
                for(const fact of facts) if(fact.kind===6) {
                    __pocketWorker.publish(1,new Uint8Array([42,Math.floor(Math.random()*256),Date.now()%256]));
                }
            };
        "#);
        let config = CString::new(serde_json::json!({
            "protocolVersion":1,"nativeGeneration":1,"bindingGeneration":BINDING_GENERATION,
            "tickHz":DEFAULT_TICK_HZ,"expectedRuntimeAbi":bytecode::runtime_abi(),
            "declaration":{"entry":"worker.js","nodes":[],"channels":[
                {"name":"results","kind":"snapshot","direction":"worker-to-ui","recordBytes":16,"capacity":1}
            ]},
            "policy":{"requiredCapabilities":["runtime.worker"],"allowedHttpOrigins":[]},
            "limits":{"heapBytes":16777216,"stackBytes":1048576,"turnBudgetMicros":10000,"windowMicros":100000,"quotaMicros":50000}
        }).to_string()).unwrap();
        let ui = CString::new(r#"
            __pocketWorkerChannels.configure(1,1);
            globalThis.frame=()=>{
                for (const bytes of __pocketWorkerChannels.observe(1)) {
                    pocket._emit(JSON.stringify({method:'worker.result',params:{bytes:Array.from(bytes)}}));
                }
            };
        "#).unwrap();
        let command = |handle: *mut HostState, operation: u8, recording: bool| {
            let status = unsafe {
                match operation {
                    0 => pocket_configure_worker(
                        handle,
                        worker.as_ptr(),
                        worker.len(),
                        config.as_ptr(),
                        if recording { Some(notify) } else { None },
                    ),
                    1 => pocket_eval(handle, ui.as_ptr()),
                    2 => {
                        pocket_notify_external_work(handle);
                        0
                    }
                    3 => pocket_stop_async(handle),
                    _ => unreachable!(),
                }
            };
            assert_eq!(status, 0, "{}", unsafe { &*handle }.last_error);
            if operation == 1 || operation == 2 {
                let pointer = unsafe { pocket_frame(handle, 0.0) };
                assert!(!pointer.is_null(), "{}", unsafe { &*handle }.last_error);
                assert!(
                    unsafe { &*handle }.last_error.is_empty(),
                    "{}",
                    unsafe { &*handle }.last_error
                );
                Some(
                    serde_json::from_str::<serde_json::Value>(
                        unsafe { CStr::from_ptr(pointer) }.to_str().unwrap(),
                    )
                    .unwrap(),
                )
            } else {
                None
            }
        };
        let trace_end = |handle| {
            let pointer = unsafe { pocket_trace_clock_end_json(handle) };
            assert!(!pointer.is_null(), "{}", unsafe { &*handle }.last_error);
            unsafe { CStr::from_ptr(pointer) }
                .to_str()
                .unwrap()
                .to_owned()
        };
        let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
        let original = OwnedHost(pocket_create(80.0, 80.0));
        assert_eq!(unsafe { pocket_trace_clock_mode(original.0, 1) }, 0);
        let mut tape = Vec::new();
        let mut delivered = false;
        let mut seen = *WAKE.0.lock().unwrap();
        for operation in [0, 1] {
            assert_eq!(
                unsafe { pocket_trace_clock_begin_json(original.0, empty.as_ptr()) },
                0
            );
            let frame = command(original.0, operation, true);
            if let Some(frame) = &frame {
                delivered |= frame["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["params"]["bytes"][0] == 42);
            }
            tape.push((operation, trace_end(original.0), frame));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !delivered {
            let guard = WAKE.0.lock().unwrap();
            let (guard, timeout) = WAKE
                .1
                .wait_timeout_while(
                    guard,
                    deadline.saturating_duration_since(Instant::now()),
                    |epoch| *epoch == seen,
                )
                .unwrap();
            seen = *guard;
            assert!(
                !timeout.timed_out(),
                "recording worker failed to produce its timed channel value"
            );
            drop(guard);
            assert_eq!(
                unsafe { pocket_trace_clock_begin_json(original.0, empty.as_ptr()) },
                0
            );
            let frame = command(original.0, 2, true).unwrap();
            delivered = frame["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["params"]["bytes"][0] == 42);
            tape.push((2, trace_end(original.0), Some(frame)));
        }
        assert_eq!(
            unsafe { pocket_trace_clock_begin_json(original.0, empty.as_ptr()) },
            0
        );
        command(original.0, 3, true);
        tape.push((3, trace_end(original.0), None));
        assert_eq!(unsafe { pocket_trace_clock_mode(original.0, 0) }, 0);
        drop(original);

        for _ in 0..3 {
            let replay = OwnedHost(pocket_create(80.0, 80.0));
            assert_eq!(unsafe { pocket_trace_clock_mode(replay.0, 2) }, 0);
            for (operation, expected_trace, expected_frame) in &tape {
                let input = CString::new(expected_trace.as_str()).unwrap();
                assert_eq!(
                    unsafe { pocket_trace_clock_begin_json(replay.0, input.as_ptr()) },
                    0,
                    "{}",
                    unsafe { &*replay.0 }.last_error
                );
                assert_eq!(&command(replay.0, *operation, false), expected_frame);
                let actual = trace_end(replay.0);
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&actual).unwrap(),
                    serde_json::from_str::<serde_json::Value>(expected_trace).unwrap()
                );
            }
            assert_eq!(unsafe { pocket_trace_clock_mode(replay.0, 0) }, 0);
        }
    }

    #[test]
    fn trusted_compositor_registry_reaches_real_core_and_cannot_be_replaced() {
        let handle = pocket_create(80.0, 80.0);
        for invalid in [
            r#"{"app.a":1}"#,
            r#"{"app.a":2,"app.b":2}"#,
            r#"{"../app":2}"#,
        ] {
            assert_eq!(
                unsafe {
                    pocket_configure_compositor(handle, CString::new(invalid).unwrap().as_ptr())
                },
                -1
            );
        }
        assert_eq!(
            unsafe {
                pocket_configure_compositor(
                    handle,
                    CString::new(r#"{"app.a":2}"#).unwrap().as_ptr(),
                )
            },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );
        let source = CString::new(r#"const child=ui.createNode(3); ui.setProp(child,1,40);ui.setProp(child,2,40);
            ui.setCompositorSurface(child,ui.__surfaces['app.a'],1);ui.insertBefore(1,child,0);
            let blocked=0;try{pocket.registerSurface('app.a','glass','{}')}catch(e){blocked++}
            try{pocket.releaseSurface('app.a')}catch(e){blocked++} if(blocked!==2)throw Error('registry escaped');
            globalThis.frame=function(){};"#).unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, source.as_ptr()) },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );
        let frame = frame_json(handle);
        let op = frame["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["type"] == "hostSurface")
            .unwrap();
        assert_eq!(op["surfaceHandle"], 2);
        assert_eq!(op["focused"], true);
        assert_eq!(op["id"], "app.a");
        assert_eq!(
            unsafe { pocket_configure_compositor(handle, CString::new("{}").unwrap().as_ptr()) },
            -1
        );
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn binary_bridge_ffi_roundtrips_emit_value_send_binary_and_offload_binary() {
        let handle = pocket_create(80.0, 80.0);
        let offload_cfg = CString::new(
            r#"{"generation":1,"session":3,"timeoutMs":1000,"methods":["crypto.digest"]}"#,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_configure_offload(handle, offload_cfg.as_ptr(), None) },
            0
        );

        let source = CString::new(
            r#"
            JSON.parse = JSON.stringify = function() { throw new Error("JSON reached binary bridge"); };
            const handler = function(packet) {
                if (typeof packet === "string") {
                    throw new Error("expected direct JS object for __binaryCapable handler");
                }
                const bytes = packet.payload.bytes;
                if (!(bytes instanceof Uint8Array) || bytes.length !== 3 || bytes[1] !== 99) {
                    throw new Error("expected Uint8Array payload");
                }
                pocket._emitValue({
                    type: "event",
                    name: "echo.binary",
                    payload: {
                        count: packet.payload.count + 1,
                        bytes: new Uint8Array([bytes[0], bytes[1], bytes[2], 77])
                    }
                });
            };
            handler.__binaryCapable = true;
            globalThis.__pocketEvent = handler;
            if (!offload.submitValue({v:1,id:1,method:"crypto.digest",payload:'{"input":"hello"}'})) {
                throw new Error("offload.submitValue failed");
            }
            globalThis.frame = function() {
                const reply = offload.takeValue();
                if (reply) {
                    pocket._emitValue({
                        type: "event",
                        name: "offload.done",
                        payload: reply
                    });
                }
            };
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let inbound = binary_bridge::encode_json_to_binary(
            &serde_json::json!({
                "type": "event",
                "name": "host.push",
                "payload": {
                    "count": 10,
                    "bytes": [1, 99, 250]
                }
            }),
            4096,
        )
        .unwrap();
        // Patch the array in `inbound` or construct a packet with TAG_BYTES via QuickJS:
        let inbound_with_bytes = {
            let rt = Runtime::new().unwrap();
            let ctx = Context::full(&rt).unwrap();
            ctx.with(|c| {
                let v: Value = c
                    .eval(
                        r#"({
                            type: "event",
                            name: "host.push",
                            payload: {
                                count: 10,
                                bytes: new Uint8Array([1, 99, 250])
                            }
                        })"#,
                    )
                    .unwrap();
                binary_bridge::encode_js_message(v, 4096, 256).unwrap()
            })
        };
        assert_eq!(
            unsafe {
                pocket_send_binary(
                    handle,
                    inbound_with_bytes.as_ptr(),
                    inbound_with_bytes.len(),
                )
            },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );

        let mut req_len = 0u64;
        let req_ptr = unsafe { pocket_offload_take_binary(handle, 0, &mut req_len) };
        assert!(!req_ptr.is_null());
        let req_bytes = unsafe { std::slice::from_raw_parts(req_ptr, req_len as usize) };
        assert_eq!(req_bytes[0], binary_bridge::OFFLOAD_BINARY_MAGIC);
        let req_id = u64::from_le_bytes(req_bytes[9..17].try_into().unwrap());

        let mut completion = Vec::new();
        completion.push(binary_bridge::OFFLOAD_BINARY_MAGIC);
        completion.extend_from_slice(&1u32.to_le_bytes());
        completion.extend_from_slice(&3u32.to_le_bytes());
        completion.extend_from_slice(&req_id.to_le_bytes());
        completion.push(1);
        let reply_json = br#"{"ok":true}"#;
        completion.extend_from_slice(&(reply_json.len() as u32).to_le_bytes());
        completion.extend_from_slice(reply_json);
        assert_eq!(
            unsafe {
                pocket_offload_complete_binary(handle, completion.as_ptr(), completion.len())
            },
            0
        );

        let mut frame_len = 0u64;
        let frame_ptr = unsafe { pocket_frame_binary(handle, 16.0, &mut frame_len) };
        assert!(!frame_ptr.is_null() && frame_len > 0);
        assert_eq!(unsafe { &*handle }.frame_json_serializations, 0);

        unsafe {
            pocket_destroy(handle);
        }
        let _ = inbound;
    }

    #[test]
    fn binary_input_rejects_a_stale_guest_without_a_json_downgrade() {
        let handle = pocket_create(80.0, 80.0);
        let source = CString::new(
            r#"
            let seen = 0;
            globalThis.__pocketEvent = function(line) {
                if (typeof line !== 'string') throw Error('legacy diagnostic expects text');
                seen++;
            };
            globalThis.frame = function() {};
        "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        let packet = serde_json::json!({"type":"event", "name":"test", "payload":{}});
        let bytes = binary_bridge::encode_json_to_binary(&packet, 4096).unwrap();
        assert_eq!(
            unsafe { pocket_send_binary(handle, bytes.as_ptr(), bytes.len()) },
            -1
        );
        assert!(unsafe { &*handle }.last_error.contains("__binaryCapable"));
        assert!(
            dispatch_duplex_pointer_guest(&unsafe { &*handle }.guest, "down", 0, 1.0, 1.0, 0)
                .is_err()
        );
        assert!(
            dispatch_guest_json(&unsafe { &*handle }.guest, "__pocketEvent", &packet, None)
                .is_err()
        );
        // The explicit diagnostic API remains source compatible.
        let line = CString::new(packet.to_string()).unwrap();
        assert_eq!(unsafe { pocket_send(handle, line.as_ptr()) }, 0);
        let check =
            CString::new("if (seen !== 1) throw Error('canonical input invoked legacy handler');")
                .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, check.as_ptr()) }, 0);
        unsafe { pocket_destroy(handle) };
    }

    #[test]
    fn binary_bridge_handles_reentrant_getter_emit_and_defines_own_data_properties() {
        let handle = pocket_create(80.0, 80.0);
        let source = CString::new(
            r#"
            let setterCalled = false;
            Object.defineProperty(Object.prototype, "answer", {
                configurable: true,
                set() { setterCalled = true; }
            });
            const handler = function(packet) {
                const answer = Object.getOwnPropertyDescriptor(packet.payload, "answer");
                if (setterCalled || !answer || answer.value !== 42 ||
                    !answer.writable || !answer.enumerable || !answer.configurable) {
                    throw new Error("expected answer as an own data property without invoking the setter");
                }
                if (!Object.prototype.hasOwnProperty.call(packet.payload, "__proto__")) {
                    throw new Error("expected __proto__ as an own property");
                }
                if (packet.payload.evil === true) {
                    throw new Error("prototype pollution occurred");
                }
                pocket._emitValue({
                    type: "event",
                    name: "outer.emit",
                    payload: {
                        get nested() {
                            pocket._emitValue({
                                type: "event",
                                name: "inner.emit",
                                payload: { ok: true }
                            });
                            return 42;
                        }
                    }
                });
            };
            handler.__binaryCapable = true;
            globalThis.__pocketEvent = handler;
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let inbound = binary_bridge::encode_json_to_binary(
            &serde_json::json!({
                "type": "event",
                "name": "proto.check",
                "payload": {
                    "answer": 42,
                    "__proto__": { "evil": true }
                }
            }),
            4096,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_send_binary(handle, inbound.as_ptr(), inbound.len()) },
            0,
            "{}",
            unsafe { &*handle }.last_error
        );
        assert_eq!(unsafe { (*handle).outbound.borrow().len() }, 2);
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn perf_sampling_gate_controls_frame_stage_timings() {
        let handle = pocket_create(120.0, 80.0);
        let source = CString::new(
            r#"
            const box = ui.createNode(0);
            ui.setProp(box, 1, 40);
            ui.setProp(box, 2, 30);
            ui.setProp(box, 64, 0xff224488);
            ui.insertBefore(1, box, 0);
            let step = 0;
            globalThis.frame = function() {
                step += 1;
                ui.setProp(box, 64, 0xff224400 + (step & 0xff));
            };
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        unsafe { pocket_set_perf_sampling_enabled(0) };
        assert_eq!(unsafe { pocket_is_perf_sampling_enabled() }, 0);
        let mut out_len = 0u64;
        let ptr1 = unsafe { pocket_frame_delta_binary_v2(handle, 17.0, 0, &mut out_len) };
        assert!(!ptr1.is_null() && out_len > 0);
        let mut timings = [99u64; 8];
        assert_eq!(
            unsafe { pocket_last_frame_stage_timings_us(handle, timings.as_mut_ptr()) },
            8
        );
        assert_eq!(timings, [0u64; 8]);

        unsafe {
            pocket_set_perf_sampling_enabled(1);
            pocket_record_live2d_update_ns(42_000);
        }
        assert_eq!(unsafe { pocket_is_perf_sampling_enabled() }, 1);
        let base_seq = unsafe { (*handle).frame_delta_v2_published.unwrap() };
        let ptr2 = unsafe { pocket_frame_delta_binary_v2(handle, 17.0, base_seq, &mut out_len) };
        assert!(!ptr2.is_null() && out_len > 0);
        assert_eq!(
            unsafe { pocket_last_frame_stage_timings_us(handle, timings.as_mut_ptr()) },
            8
        );
        assert_eq!(timings[1], 42);
        assert!(timings.iter().sum::<u64>() >= 42);

        unsafe {
            pocket_set_perf_sampling_enabled(0);
            pocket_destroy(handle);
        }
    }

    #[test]
    fn node_metadata_mutation_bumps_revision_and_invalidates_draw_cache() {
        let handle = pocket_create(160.0, 120.0);
        let source = CString::new(
            r#"
            const surface = pocket.registerSurface('test.video', 'video', JSON.stringify({asset:'clip-initial.mp4', fit:'contain', autoplay:false}));
            const node = ui.createNode(3);
            ui.setProp(node, 1, 60);
            ui.setProp(node, 2, 40);
            ui.setCompositorSurface(node, surface, 0);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);

        let rev1 = unsafe { (*handle).nodes.borrow().revision() };
        let frame1 = frame_json(handle);
        let ops1 = frame1["ops"].as_array().unwrap();
        let video_op1 = ops1
            .iter()
            .find(|op| op["type"] == "video")
            .expect("initial video op must be emitted");
        assert_eq!(video_op1["id"], "test.video");
        assert_eq!(video_op1["asset"], "clip-initial.mp4");
        assert_eq!(video_op1["fit"], "contain");
        assert_eq!(video_op1["autoplay"], false);

        // Second identical frame hits the DrawList cache (delta returns unchanged).
        let delta_hit = unsafe {
            CStr::from_ptr(pocket_frame_delta(handle, 16.0))
                .to_str()
                .unwrap()
        };
        let delta_hit_json: serde_json::Value = serde_json::from_str(delta_hit).unwrap();
        assert_eq!(delta_hit_json["unchanged"], true);

        // Mutate node metadata without changing C layout / DrawList words.
        let update_meta = CString::new(
            r#"
            pocket.registerSurface('test.video', 'video', JSON.stringify({asset:'clip-updated.mp4', fit:'fill', autoplay:true}));
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, update_meta.as_ptr()) }, 0);
        let rev2 = unsafe { (*handle).nodes.borrow().revision() };
        assert!(
            rev2 > rev1,
            "mutating node metadata must increment nodes_revision"
        );

        let delta_miss = unsafe {
            CStr::from_ptr(pocket_frame_delta(handle, 16.0))
                .to_str()
                .unwrap()
        };
        let delta_miss_json: serde_json::Value = serde_json::from_str(delta_miss).unwrap();
        assert!(
            delta_miss_json.get("unchanged").is_none(),
            "metadata mutation must invalidate FrameDrawCache"
        );
        let ops2 = delta_miss_json["ops"].as_array().unwrap();
        let video_op2 = ops2
            .iter()
            .find(|op| op["type"] == "video")
            .expect("updated video op must be emitted");
        assert_eq!(video_op2["id"], "test.video");
        assert_eq!(video_op2["asset"], "clip-updated.mp4");
        assert_eq!(video_op2["fit"], "fill");
        assert_eq!(video_op2["autoplay"], true);

        // Releasing surface metadata also increments revision and invalidates cache.
        let _ = unsafe { pocket_frame_delta(handle, 16.0) };
        let release_meta = CString::new(
            r#"
            pocket.releaseSurface('test.video');
            "#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_eval(handle, release_meta.as_ptr()) }, 0);
        let rev3 = unsafe { (*handle).nodes.borrow().revision() };
        assert!(rev3 > rev2);
        let delta_after_release = unsafe {
            CStr::from_ptr(pocket_frame_delta(handle, 16.0))
                .to_str()
                .unwrap()
        };
        let delta_after_release_json: serde_json::Value =
            serde_json::from_str(delta_after_release).unwrap();
        assert!(delta_after_release_json.get("unchanged").is_none());

        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn truncated_drawlist_opcodes_return_err_without_panicking() {
        let handle = pocket_create(160.0, 120.0);
        let ui = unsafe { &mut (*handle).ops.core_mut().unwrap().ui };
        let nodes = Vec::new();
        let mut generic_handles = HashSet::new();

        for &opcode in &[1u32, 3, 4, 7, 8, 9, 10, 11, 12, 17, 18] {
            let truncated = [opcode];
            let operation = pocket_draw_ops::Operation {
                opcode,
                words: &truncated,
                clip: DamageRect::new(0, 0, 160, 120),
            };
            let mut out = Vec::new();
            let res = append_draw_operation_cached(
                &mut out,
                &operation,
                &nodes,
                ui,
                &mut generic_handles,
                None,
                None,
            );
            assert!(
                res.is_err(),
                "truncated opcode {opcode} must return Err instead of panicking"
            );
        }
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn get_layouts_batches_committed_rects_and_enforces_batch_limit() {
        let handle = pocket_create(320.0, 240.0);
        let source = CString::new(
            r#"
            const n1 = ui.createNode(0);
            ui.setProp(n1, 1, 80);
            ui.setProp(n1, 2, 36);
            ui.insertBefore(1, n1, 0);

            const n2 = ui.createNode(0);
            ui.setProp(n2, 1, 120);
            ui.setProp(n2, 2, 44);
            ui.insertBefore(1, n2, 0);

            const single1 = pocket.getLayout(n1);
            const single2 = pocket.getLayout(n2);
            const batch = pocket.getLayouts([n1, 0, n2, 999999]);
            if (!Array.isArray(batch) || batch.length !== 4) {
              throw new Error('unexpected batch length');
            }
            if (JSON.stringify(batch[0]) !== JSON.stringify(single1)) {
              throw new Error('batch[0] mismatch: ' + JSON.stringify(batch[0]) + ' vs ' + JSON.stringify(single1));
            }
            if (batch[1] !== null) {
              throw new Error('batch[1] expected null');
            }
            if (JSON.stringify(batch[2]) !== JSON.stringify(single2)) {
              throw new Error('batch[2] mismatch: ' + JSON.stringify(batch[2]) + ' vs ' + JSON.stringify(single2));
            }
            if (batch[3] !== null) {
              throw new Error('batch[3] expected null');
            }
            let threwRange = false;
            try {
              pocket.getLayouts(new Array(257).fill(n1));
            } catch (err) {
              threwRange = err instanceof RangeError;
            }
            if (!threwRange) {
              throw new Error('expected RangeError for >256 ids');
            }
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();
        assert_eq!(
            unsafe { pocket_eval(handle, source.as_ptr()) },
            0,
            "getLayouts test failed: {}",
            unsafe { CStr::from_ptr(pocket_last_error(handle)).to_string_lossy() }
        );
        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn probe_compact_resource_json_matches_legacy_and_shrinks_large_textures_under_64_mib() {
        use base64::Engine;

        let source = CString::new(
            r#"
            const img = ui.createNode(2);
            ui.setProp(img, 1, 16);
            ui.setProp(img, 2, 16);
            ui.setImage(img, ui.__textures.rgba_sample);
            ui.insertBefore(1, img, 0);

            const txt = ui.createNode(1);
            ui.setProp(txt, 1, 64);
            ui.setProp(txt, 2, 16);
            ui.setProp(txt, 100, 1);
            ui.setText(txt, 'A');
            ui.insertBefore(1, txt, 0);
            globalThis.frame = function() {};
            "#,
        )
        .unwrap();

        let mut rgba = vec![2, 0, 2, 0, pocket_spec::psm::PSM_8888 as u8, 0, 0, 0];
        let rgba_pixels: [u8; 16] = [
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 128,
        ];
        rgba.extend_from_slice(&rgba_pixels);
        let font = test_font_atlas(0, 4, 6, 2, b'A' as u32, &[255]);
        let pak = pak_entries(&[("ui:img.rgba_sample", &rgba), ("ui:font.0", &font)]);

        let legacy_handle = pocket_create(96.0, 48.0);
        let compact_handle = pocket_create(96.0, 48.0);
        assert_eq!(
            unsafe { pocket_load(legacy_handle, source.as_ptr(), pak.as_ptr(), pak.len()) },
            0
        );
        assert_eq!(
            unsafe { pocket_load(compact_handle, source.as_ptr(), pak.as_ptr(), pak.len()) },
            0
        );

        let legacy_ptr = unsafe { pocket_frame_for_probe_json(legacy_handle, 16.0, false) };
        let compact_ptr = unsafe { pocket_frame_for_probe_json(compact_handle, 16.0, true) };
        assert!(!legacy_ptr.is_null());
        assert!(!compact_ptr.is_null());
        let legacy: serde_json::Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(legacy_ptr) }.to_bytes()).unwrap();
        let compact: serde_json::Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(compact_ptr) }.to_bytes()).unwrap();

        assert_eq!(compact["frame"], legacy["frame"]);
        assert_eq!(compact["width"], legacy["width"]);
        assert_eq!(compact["height"], legacy["height"]);
        assert_eq!(compact["ops"], legacy["ops"]);
        assert_eq!(compact["events"], legacy["events"]);

        let legacy_resources = legacy["resources"].as_array().unwrap();
        let compact_resources = compact["resources"].as_array().unwrap();
        assert_eq!(compact_resources.len(), legacy_resources.len());
        assert!(
            compact_resources.len() >= 2,
            "expected RGBA and PSM5 font resources"
        );
        let mut saw_palette = false;
        for (leg, cmp) in legacy_resources.iter().zip(compact_resources.iter()) {
            assert_eq!(cmp["asset"], leg["asset"]);
            assert_eq!(cmp["revision"], leg["revision"]);
            assert_eq!(cmp["width"], leg["width"]);
            assert_eq!(cmp["height"], leg["height"]);
            assert_eq!(cmp["psm"], leg["psm"]);
            assert_eq!(cmp["linear"], leg["linear"]);
            assert_eq!(cmp["bytesEncoding"], "base64");
            assert!(leg.get("bytesEncoding").is_none());

            let expected_pixels: Vec<u8> = leg["pixels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            let decoded_pixels = base64::engine::general_purpose::STANDARD
                .decode(cmp["pixels"].as_str().unwrap())
                .unwrap();
            assert_eq!(decoded_pixels, expected_pixels);

            match (leg.get("palette"), cmp.get("palette")) {
                (Some(leg_pal), Some(cmp_pal)) => {
                    saw_palette = true;
                    let expected_palette: Vec<u8> = leg_pal
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect();
                    let decoded_palette = base64::engine::general_purpose::STANDARD
                        .decode(cmp_pal.as_str().unwrap())
                        .unwrap();
                    assert_eq!(decoded_palette, expected_palette);
                }
                (None, None) => {}
                other => panic!("palette presence mismatch: {other:?}"),
            }
        }
        assert!(saw_palette, "expected at least one PSM5 palette resource");

        // Second frame has no new resources; compact and legacy share the exact
        // no-resource serialization and frame_json_cache path.
        let legacy_second = unsafe {
            CStr::from_ptr(pocket_frame_for_probe_json(legacy_handle, 16.0, false))
                .to_str()
                .unwrap()
                .to_owned()
        };
        let compact_second = unsafe {
            CStr::from_ptr(pocket_frame_for_probe_json(compact_handle, 16.0, true))
                .to_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(compact_second, legacy_second);

        let compact_third = unsafe {
            CStr::from_ptr(pocket_frame_for_probe_json(compact_handle, 16.0, true))
                .to_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(unsafe { (*compact_handle).frame_json_cache_hits }, 1);
        assert!(compact_third.starts_with("{\"frame\":3,"));

        unsafe {
            pocket_destroy(legacy_handle);
            pocket_destroy(compact_handle);
        }

        // Hiyori-sized fixture: two 2048x2048 RGBA8888 pages (32 MiB raw pixels).
        // Legacy numeric JSON array expands each byte >= 2 chars (100+ -> 4 chars),
        // exceeding 64 MiB; compact base64 is ~42.7 MiB and stays well below 64 MiB.
        let page_pixels = vec![128u8; 2048 * 2048 * 4];
        let large_frame = FrameResult {
            frame: 1,
            width: 390.0,
            height: 844.0,
            ops: Rc::new(Vec::new()),
            auxiliary: None,
            events: Vec::new(),
            resources: vec![
                FrameResource {
                    asset: "hiyori_page_0".to_owned(),
                    revision: 1,
                    width: 2048,
                    height: 2048,
                    psm: pocket_spec::psm::PSM_8888,
                    linear: true,
                    pixels: page_pixels.clone(),
                    palette: None,
                },
                FrameResource {
                    asset: "hiyori_page_1".to_owned(),
                    revision: 1,
                    width: 2048,
                    height: 2048,
                    psm: pocket_spec::psm::PSM_8888,
                    linear: true,
                    pixels: page_pixels,
                    palette: None,
                },
            ],
            released_resources: Vec::new(),
        };
        let legacy_large_json = serde_json::to_string(&large_frame).unwrap();
        assert!(
            legacy_large_json.len() > 64 * 1024 * 1024,
            "legacy 2x2048 RGBA JSON should exceed 64 MiB, got {}",
            legacy_large_json.len()
        );
        drop(legacy_large_json);

        let host_handle = pocket_create(390.0, 844.0);
        let compact_ptr = unsafe {
            complete_frame_output(
                &mut *host_handle,
                BuiltFrame {
                    result: large_frame,
                    draw_cache_hit: false,
                },
                true,
            )
        };
        let compact_bytes = unsafe { CStr::from_ptr(compact_ptr).to_bytes() };
        assert!(
            compact_bytes.len() < 64 * 1024 * 1024,
            "compact 2x2048 RGBA JSON must be under 64 MiB, got {}",
            compact_bytes.len()
        );
        unsafe {
            pocket_destroy(host_handle);
        }
    }

    #[test]
    fn host_font_metrics_warmup_lazy_callback_and_transformed_text_pfb1_v6() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        unsafe extern "C" fn test_glyph_cb(user_data: usize, slot: u8, codepoint: u32) -> f32 {
            let counter = &*(user_data as *const AtomicUsize);
            counter.fetch_add(1, AtomicOrdering::SeqCst);
            if codepoint == '测' as u32 {
                100.0 + slot as f32
            } else {
                22.5
            }
        }

        let handle = pocket_create(320.0, 240.0);
        let mut line_heights = [20.0f32; HOST_FONT_SLOTS];
        line_heights[4] = 21.0;
        let cjk_advances = [16.0f32; HOST_FONT_SLOTS];
        let mut ascii_advances = [8.5f32; HOST_FONT_SLOTS * HOST_ASCII_COUNT];
        ascii_advances[4 * HOST_ASCII_COUNT + ('A' as usize - 0x20)] = 9.25;
        let cb_calls = AtomicUsize::new(0);

        unsafe {
            assert_eq!(
                pocket_set_host_font_metrics(
                    handle,
                    HOST_FONT_SLOTS as u32,
                    line_heights.as_ptr(),
                    cjk_advances.as_ptr(),
                    ascii_advances.as_ptr(),
                ),
                0
            );
            assert_eq!(
                pocket_set_host_glyph_measure_callback(
                    handle,
                    Some(test_glyph_cb),
                    (&cb_calls as *const AtomicUsize) as usize,
                ),
                0
            );
        }

        let source = CString::new(
            r#"
            if (ui.__hostFonts !== true) {
              throw new Error('expected ui.__hostFonts === true');
            }
            const asciiW = ui.measureText('AA', 4);
            if (Math.abs(asciiW - 18.5) > 1e-4) {
              throw new Error('unexpected ascii width: ' + asciiW);
            }
            const cjkW1 = ui.measureText('测测', 4);
            const cjkW2 = ui.measureText('测', 4);
            if (Math.abs(cjkW1 - 208) > 1e-3 || Math.abs(cjkW2 - 104) > 1e-3) {
              throw new Error('unexpected lazy cjk width: ' + cjkW1 + ', ' + cjkW2);
            }
            const n = ui.createNode(1);
            ui.setProp(n, 24, 1); // absolute
            ui.setProp(n, 28, 12); // left
            ui.setProp(n, 25, 24); // top
            ui.setProp(n, 97, 4); // FONT_SLOT = 4
            ui.setProp(n, 96, 0xff112233); // TEXT_COLOR
            ui.setProp(n, 100, 2.5); // TRACKING
            ui.setProp(n, 131, 30); // ROTATE (deg)
            ui.setText(n, 'A测');
            ui.insertBefore(1, n, 0);
            globalThis.frame = () => {};
            "#,
        )
        .unwrap();

        assert_eq!(unsafe { pocket_eval(handle, source.as_ptr()) }, 0);
        // 'A' hit the ASCII warmup table; '测' was queried once and cached across
        // both measureText calls AND native layout!
        assert_eq!(cb_calls.load(AtomicOrdering::SeqCst), 1);

        let mut byte_len = 0u64;
        let frame_ptr = unsafe { pocket_frame_binary(handle, 0.0, &mut byte_len) };
        assert!(!frame_ptr.is_null() && byte_len > 28);
        let bytes = unsafe { std::slice::from_raw_parts(frame_ptr, byte_len as usize) }.to_vec();
        assert_eq!(&bytes[0..4], b"PFB1");
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        assert_eq!(version, BINARY_FRAME_TEXT_TRANSFORM_VERSION);
        let op_count = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        assert_eq!(op_count, 1, "rotated tracked text must emit 1 vector TEXT_RUN op, not GLYPH_RUN quads");
        assert_eq!(bytes[28], 18, "extended text op must use PFB1 tag 18");

        let json_ptr = unsafe { pocket_frame(handle, 0.0) };
        let json_str = unsafe { CStr::from_ptr(json_ptr).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        let op = &parsed["ops"][0];
        assert_eq!(op["type"], "text");
        assert_eq!(op["text"], "A测");
        assert!((op["h"].as_f64().unwrap() - 21.0).abs() < 1e-4);
        assert!((op["tracking"].as_f64().unwrap() - 2.5).abs() < 1e-4);
        let affine = op["affine"].as_array().unwrap();
        assert_eq!(affine.len(), 4);
        assert!((affine[0].as_f64().unwrap() - 30.0_f64.to_radians().cos()).abs() < 1e-3);

        unsafe {
            pocket_destroy(handle);
        }
    }

    #[test]
    fn fontless_pak_requires_host_font_metrics_and_preserves_active_guest_on_rejection() {
        let mut pak = vec![0u8; 32];
        pak[0..4].copy_from_slice(&PAK_MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&1u16.to_le_bytes());
        pak[8..12].copy_from_slice(&0u32.to_le_bytes());
        pak[12..16].copy_from_slice(&32u32.to_le_bytes());
        pak[16..20].copy_from_slice(&32u32.to_le_bytes());
        pak[20..24].copy_from_slice(&32u32.to_le_bytes());
        pak[24..28].copy_from_slice(&32u32.to_le_bytes());

        let handle = pocket_create(160.0, 120.0);
        let active_guest = CString::new(format!(
            "const n = ui.createNode(0); ui.setProp(n, {}, 40); ui.setProp(n, {}, 30); ui.setProp(n, {}, {}); ui.insertBefore(1, n, 0); globalThis.frame = () => {{}};",
            pocket_spec::prop::WIDTH,
            pocket_spec::prop::HEIGHT,
            pocket_spec::prop::BG_COLOR,
            0xff22_4466u32,
        ))
        .unwrap();
        let c_src = CString::new("globalThis.frame = () => {};").unwrap();

        unsafe {
            assert_eq!(pocket_eval(handle, active_guest.as_ptr()), 0);
            assert_eq!(
                pocket_load(handle, c_src.as_ptr(), pak.as_ptr(), pak.len()),
                -1
            );
            let err = CStr::from_ptr(pocket_last_error(handle)).to_string_lossy();
            assert!(
                err.contains("contains no baked ui:font.* atlases"),
                "unexpected error: {err}"
            );
            // Active guest remains intact after admission rejection.
            let frame_json: serde_json::Value =
                serde_json::from_str(CStr::from_ptr(pocket_frame(handle, 0.0)).to_str().unwrap())
                    .unwrap();
            assert_eq!(frame_json["ops"][0]["type"], "rect");

            // Split validation checks positive line_heights/cjk_advances vs non-negative ascii.
            let (mut lh, cjk, mut ascii) = default_probe_host_font_metrics();
            lh[0] = 0.0;
            assert_eq!(
                pocket_set_host_font_metrics(
                    handle,
                    ACTIVE_HOST_FONT_SLOTS as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ),
                -1
            );
            assert!(CStr::from_ptr(pocket_last_error(handle))
                .to_string_lossy()
                .contains("positive"));
            lh[0] = 16.0;
            ascii[0] = -0.5;
            assert_eq!(
                pocket_set_host_font_metrics(
                    handle,
                    ACTIVE_HOST_FONT_SLOTS as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ),
                -1
            );
            assert!(CStr::from_ptr(pocket_last_error(handle))
                .to_string_lossy()
                .contains("non-negative"));

            // Valid host font metrics admit the font-less PAK.
            ascii[0] = 4.0;
            assert_eq!(
                pocket_set_host_font_metrics(
                    handle,
                    ACTIVE_HOST_FONT_SLOTS as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ),
                0
            );
            assert_eq!(
                pocket_load(handle, c_src.as_ptr(), pak.as_ptr(), pak.len()),
                0
            );
            pocket_destroy(handle);
        }
    }

    #[test]
    fn shaped_text_callback_caches_failures_evicts_older_half_and_replays_deterministically() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        unsafe extern "C" fn shaped_cb(
            user_data: usize,
            _slot: u8,
            tracking: f32,
            utf8_ptr: *const u8,
            utf8_len: usize,
        ) -> f32 {
            let calls = &*(user_data as *const AtomicUsize);
            calls.fetch_add(1, AtomicOrdering::SeqCst);
            let text = std::str::from_utf8(std::slice::from_raw_parts(utf8_ptr, utf8_len)).unwrap();
            if text.contains('\u{FFFD}') {
                return -1.0; // Simulate failed lookup to verify fallback caching.
            }
            // Treat ZWJ family sequence or combining sequence as a single shaped cluster.
            if text == "👨\u{200D}👩\u{200D}👧\u{200D}👦" {
                return 19.5 + tracking;
            }
            if text == "e\u{0301}" {
                return 8.25 + tracking;
            }
            33.0 + tracking
        }

        let (lh, cjk, ascii) = default_probe_host_font_metrics();
        let record_handle = pocket_create(240.0, 160.0);
        let calls = AtomicUsize::new(0);
        let empty_env = CString::new("{}").unwrap();
        let script = CString::new(
            r#"
            const zwj = ui.measureText('👨\u200d👩\u200d👧\u200d👦', 2);
            const comb = ui.measureText('e\u0301', 2);
            const bad1 = ui.measureText('\ufffd', 2);
            const bad2 = ui.measureText('\ufffd', 2);
            if (Math.abs(zwj - 19.5) > 1e-4) throw new Error('zwj=' + zwj);
            if (Math.abs(comb - 8.25) > 1e-4) throw new Error('comb=' + comb);
            if (Math.abs(bad1 - bad2) > 1e-4) throw new Error('bad mismatch');
            const n = ui.createNode(1);
            ui.setProp(n, 97, 2);
            ui.setText(n, '👨\u200d👩\u200d👧\u200d👦');
            ui.insertBefore(1, n, 0);
            globalThis.frame = () => {};
            "#,
        )
        .unwrap();

        let recorded_trace: String;
        let recorded_frame: serde_json::Value;
        unsafe {
            assert_eq!(
                pocket_set_host_font_metrics(
                    record_handle,
                    ACTIVE_HOST_FONT_SLOTS as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ),
                0
            );
            assert_eq!(
                pocket_set_host_text_measure_callback(
                    record_handle,
                    Some(shaped_cb),
                    (&calls as *const AtomicUsize) as usize,
                ),
                0
            );
            assert_eq!(pocket_trace_clock_mode(record_handle, 1), 0);
            assert_eq!(pocket_trace_clock_begin_json(record_handle, empty_env.as_ptr()), 0);
            assert_eq!(pocket_eval(record_handle, script.as_ptr()), 0);
            recorded_frame =
                serde_json::from_str(CStr::from_ptr(pocket_frame(record_handle, 0.0)).to_str().unwrap())
                    .unwrap();
            let trace_ptr = pocket_trace_clock_end_json(record_handle);
            assert!(!trace_ptr.is_null());
            recorded_trace = CStr::from_ptr(trace_ptr).to_str().unwrap().to_owned();
            // 3 distinct non-ASCII strings ('zwj', 'comb', '\ufffd'): '\ufffd' failed once and cached.
            assert_eq!(calls.load(AtomicOrdering::SeqCst), 3);
            pocket_destroy(record_handle);
        }

        // Replay on a second host with NO text callback installed: must reproduce exact widths!
        let replay_handle = pocket_create(240.0, 160.0);
        let trace_cstr = CString::new(recorded_trace).unwrap();
        unsafe {
            assert_eq!(
                pocket_set_host_font_metrics(
                    replay_handle,
                    ACTIVE_HOST_FONT_SLOTS as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ),
                0
            );
            assert_eq!(pocket_trace_clock_mode(replay_handle, 2), 0);
            assert_eq!(pocket_trace_clock_begin_json(replay_handle, trace_cstr.as_ptr()), 0);
            assert_eq!(pocket_eval(replay_handle, script.as_ptr()), 0);
            let replayed_frame: serde_json::Value =
                serde_json::from_str(CStr::from_ptr(pocket_frame(replay_handle, 0.0)).to_str().unwrap())
                    .unwrap();
            assert!(!pocket_trace_clock_end_json(replay_handle).is_null());
            assert_eq!(replayed_frame["ops"], recorded_frame["ops"]);

            // Verify half-capacity generation eviction preserves recent entries.
            let metrics = (*replay_handle).text_metrics.borrow();
            metrics.clear_caches();
            for idx in 0..MAX_HOST_GLYPH_CACHE_ENTRIES {
                metrics.insert_glyph_cached((0, idx as u32 + 0x100), 10.0);
            }
            metrics.insert_glyph_cached((0, 0x20000), 12.0);
            let len_after = metrics.glyph_cache.borrow().len();
            assert!(
                len_after >= MAX_HOST_GLYPH_CACHE_ENTRIES / 2 && len_after < MAX_HOST_GLYPH_CACHE_ENTRIES,
                "expected half-capacity eviction, got {len_after}"
            );
            assert!(metrics.glyph_cache.borrow().contains_key(&(0, 0x20000)));
            drop(metrics);
            pocket_destroy(replay_handle);
        }
    }
}
