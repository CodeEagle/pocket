//! Small PocketJS -> Flutter POC host.
//!
//! This deliberately uses PocketJS's retained UI core and its QuickJS guest,
//! but exposes a tiny JSON bridge to Dart.  The Flutter side owns painting;
//! this library owns JavaScript execution, flexbox layout and frame timing.

pub mod binary_bridge;
pub mod bytecode;
mod demand;
pub mod duplex;
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
use rquickjs::{Coerced, Ctx, Exception, FromJs, Function, Object, Value};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{c_char, CStr, CString};
use std::io::Read;
use std::ptr;
use std::rc::Rc;
use std::sync::Arc;

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
        && events.iter().all(|event| event.is_object() && !is_batch(event))
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
    #[serde(rename = "align", skip_serializing_if = "Option::is_none")]
    text_align: Option<u8>,
    #[serde(rename = "surfaceHandle", skip_serializing_if = "Option::is_none")]
    surface_handle: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused: Option<bool>,
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

#[derive(Serialize)]
struct FrameResult {
    frame: u64,
    width: f32,
    height: f32,
    ops: Vec<FrameOp>,
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
    fn matches_primary(
        &self,
        words: &[u32],
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
    nodes: Rc<RefCell<Vec<NodeMeta>>>,
    outbound: Rc<RefCell<Vec<OutboundEvent>>>,
    /// One lock-free SPSC channel per runtime. Reload closes this generation
    /// and installs a new Arc rather than clearing a ring borrowed by another
    /// isolate.
    duplex: Arc<duplex::DuplexRing>,
    duplex_ingress_consumer: duplex::IngressConsumer,
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
const BINARY_FRAME_VERSION: u16 = 1;

struct BinaryFrameWriter {
    bytes: Vec<u8>,
}

impl BinaryFrameWriter {
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
        let tag = match op.kind.as_str() {
            "rect" => 0,
            "rounded" => 1,
            "gradient" => 2,
            "triangle" => 3,
            "textureTriangle" => 4,
            "text" => 5,
            "image" => 6,
            "hostSurface" => 7,
            "video" => 8,
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
            4 => {
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
            6 => {
                self.string(op.asset.as_deref().unwrap_or(""))?;
                match op.uv.as_ref() {
                    Some(uv) if uv.len() == 4 => {
                        self.u8(1);
                        for value in uv {
                            self.f32(*value);
                        }
                    }
                    Some(_) => return Err("image UVs must contain four values".to_owned()),
                    None => self.u8(0),
                }
                self.optional_u32(op.color);
            }
            7 | 8 => {
                self.string(op.id.as_deref().unwrap_or(""))?;
                self.string(op.asset.as_deref().unwrap_or(""))?;
                if tag == 7 {
                    // hostSurface assets are the canonical descriptor JSON;
                    // the Dart decoder extracts kind/parameters exactly as
                    // it does for the legacy JSON schema.
                    self.u32(op.surface_handle.unwrap_or(0) as u32);
                    self.u8(u8::from(op.focused.unwrap_or(false)));
                } else {
                    self.u8(if op.fit.as_deref() == Some("contain") {
                        1
                    } else if op.fit.as_deref() == Some("fill") {
                        2
                    } else {
                        0
                    });
                    self.u8(1); // video autoplay is true for native surfaces
                }
            }
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

fn encode_binary_frame(frame: &FrameResult) -> Result<Vec<u8>, String> {
    let mut writer = BinaryFrameWriter::new();
    writer.u32(BINARY_FRAME_MAGIC);
    writer.u16(BINARY_FRAME_VERSION);
    writer.u16(1); // PFB1 metadata: TEXT_RUN align, SURFACE_QUAD handle/focus.
    writer.u64(frame.frame);
    writer.f32(frame.width);
    writer.f32(frame.height);
    writer.ops(&frame.ops)?;
    let event_count =
        u32::try_from(frame.events.len()).map_err(|_| "too many frame events".to_owned())?;
    writer.u32(event_count);
    for event in &frame.events {
        writer.bytes(&event.binary)?;
    }
    let resource_count =
        u32::try_from(frame.resources.len()).map_err(|_| "too many frame resources".to_owned())?;
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
    Ok(writer.bytes)
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
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if let Err(error) = stop_worker_checked(host) {
        set_error(host, error);
        return -1;
    }
    if let Some(provider) = &host.offload {
        provider.shutdown();
    }
    clear_error(host);
    0
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
        .with(|ctx| runtime.attach_ui(ctx.as_raw().as_ptr()))
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
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let result = (|| -> Result<PendingWorker, String> {
        if host.guest_loaded || host.worker_program.is_some() {
            return Err("worker must be configured once before guest evaluation".into());
        }
        if bytes.is_null() || length == 0 || length > 64 * 1024 * 1024 || config_json.is_null() {
            return Err("invalid worker bytecode/configuration".into());
        }
        let json = CStr::from_ptr(config_json).to_bytes();
        if json.len() > 64 * 1024 {
            return Err("worker configuration exceeds 64 KiB".into());
        }
        let config: serde_json::Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
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
}

fn checked_duplex_u32(value: f64) -> Option<u32> {
    (value.is_finite() && value >= 0.0 && value <= u32::MAX as f64 && value.fract() == 0.0)
        .then_some(value as u32)
}

fn install_bridge(
    guest: &RquickjsGuest,
    ops: OpContext,
    nodes: Rc<RefCell<Vec<NodeMeta>>>,
    outbound: Rc<RefCell<Vec<OutboundEvent>>>,
    duplex: Arc<duplex::DuplexRing>,
    auxiliary: Option<(i32, f32, f32)>,
    compositor_surfaces: &BTreeMap<String, i32>,
    offload: Option<Arc<offload::OffloadHost>>,
    trace_mode: replay::Mode,
    trace_lane: Rc<RefCell<replay::ScalarLane>>,
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
                move |raw: Value<'_>| -> rquickjs::Result<bool> {
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
                        let Ok(binary) =
                            binary_bridge::encode_json_to_binary(&parsed, usize::MAX)
                        else {
                            return Ok(false);
                        };
                        (binary, line.len())
                    } else {
                        let Ok(binary) = binary_bridge::encode_js_message(
                            raw,
                            remaining_budget,
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
                    if queue.len() >= MAX_BRIDGE_QUEUED_EVENTS || cost > remaining_budget {
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
                emit_fn_closure(value)
            })?;
            let emit_val_closure = enqueue_bridge_value;
            let emit_value = Function::new(ctx.clone(), move |_ctx: Ctx<'_>, value: Value<'_>| {
                emit_val_closure(value)
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
                    if package.is_empty()
                        || package.len() > 160
                        || !matches!(kind.as_str(), "glass" | "platformTexture")
                        || payload.len() > 8192
                    {
                        return Err(Exception::throw_type(&ctx, "invalid compositor provider"));
                    }
                    let data: serde_json::Value = serde_json::from_str(&payload)
                        .map_err(|_| Exception::throw_type(&ctx, "invalid surface parameters"))?;
                    if !data.is_object() {
                        return Err(Exception::throw_type(
                            &ctx,
                            "surface parameters must be an object",
                        ));
                    }
                    let mut list = surface_nodes.borrow_mut();
                    if list.iter().any(|n| {
                        n.kind == "hostSurface" && n.video_id == package && n.surface < 100
                    }) {
                        return Err(rquickjs::Error::new_from_js_message(
                            "surface",
                            "provider",
                            "application surface is host-owned",
                        ));
                    }
                    let existing = list
                        .iter()
                        .position(|n| n.kind == "hostSurface" && n.video_id == package);
                    let handle = if let Some(index) = existing {
                        list[index].surface
                    } else {
                        if list.iter().filter(|n| n.kind == "hostSurface").count() >= 64 {
                            return Err(Exception::throw_type(&ctx, "surface limit exceeded"));
                        }
                        let mut next = next_surface.borrow_mut();
                        let handle = *next;
                        *next = next.checked_add(1).ok_or_else(|| {
                            Exception::throw_type(&ctx, "surface handles exhausted")
                        })?;
                        handle
                    };
                    let descriptor =
                        serde_json::json!({"kind": kind, "parameters": data}).to_string();
                    let meta = NodeMeta {
                        id: -handle,
                        kind: "hostSurface".into(),
                        asset: descriptor,
                        video_id: package.clone(),
                        fit: "fill".into(),
                        texture: -1,
                        surface: handle,
                        from_pack: false,
                    };
                    if let Some(index) = existing {
                        list[index] = meta;
                    } else {
                        list.push(meta);
                    }
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
                    release_nodes
                        .borrow_mut()
                        .retain(|n| !(n.kind == "hostSurface" && n.video_id == package));
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
            install_compositor_apps(&ctx, &nodes, compositor_surfaces)?;
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

/// Extend only the trusted registry. Reinstalling the bridge would claim its
/// single-producer duplex endpoint twice and recreate retained provider state.
fn install_compositor_apps(
    ctx: &Ctx<'_>,
    nodes: &Rc<RefCell<Vec<NodeMeta>>>,
    applications: &BTreeMap<String, i32>,
) -> rquickjs::Result<()> {
    let ui: Object = ctx.globals().get("ui")?;
    let surfaces: Object = ui.get("__surfaces")?;
    for (app_id, handle) in applications {
        surfaces.set(app_id.as_str(), *handle)?;
        let mut list = nodes.borrow_mut();
        list.retain(|node| !(node.kind == "hostSurface" && node.surface == *handle));
        list.push(NodeMeta {
            id: -*handle,
            kind: "hostSurface".into(),
            asset: serde_json::json!({"kind":"application", "parameters":{"appId": app_id}})
                .to_string(),
            video_id: app_id.clone(),
            fit: "fill".into(),
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
            } else {
                let owned;
                let line = match fallback_line {
                    Some(line) => line,
                    None => {
                        owned = serde_json::to_string(json_val)
                            .map_err(|error| format!("guest event JSON encode: {error}"))?;
                        &owned
                    }
                };
                function
                    .call::<_, ()>((line.to_owned(),))
                    .map_err(|error| quickjs_error(&ctx, error))
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
            if is_js_handler_binary_capable(&function) {
                let js_packet = binary_bridge::decode_to_js(&ctx, binary_bytes)?;
                function
                    .call::<_, ()>((js_packet,))
                    .map_err(|error| quickjs_error(&ctx, error))
            } else {
                let json_val = binary_bridge::decode_to_json(binary_bytes)?;
                let line = serde_json::to_string(&json_val)
                    .map_err(|error| format!("binary fallback JSON encode: {error}"))?;
                function
                    .call::<_, ()>((line,))
                    .map_err(|error| quickjs_error(&ctx, error))
            }
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

/// Translate the reserved numeric pointer message into the exact canonical
/// `input.pointer` path used by JSON callers. The conversion is confined to
/// the native owner thread: it queues the hit-tested touch snapshot and then
/// delivers the same `__pocketEvent` line to the guest, so a JS app does not
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
    let mut payload = serde_json::json!({
        "phase": phase,
        "id": message.target_id,
        "x": message.arg0,
        "y": message.arg1,
    });
    if message.flags & POINTER_AUXILIARY_FLAG != 0 {
        payload["surface"] = serde_json::json!(1);
    }
    let input = serde_json::json!({
        "type": "event",
        "name": "input.pointer",
        "payload": payload,
    });
    queue_input(host, &input)?;
    dispatch_guest_json(&host.guest, "__pocketEvent", &input, None)
}

/// Drain host-written records on the native owner thread and dispatch them to
/// the current QuickJS guest. The cursor is committed only after JS accepts a
/// record, making an unset/failed handler observable rather than silently
/// dropping input. Generic duplex records remain scalar-only; the reserved
/// pointer record is adapted to the canonical `__pocketEvent` compatibility
/// path, where one small JSON event is intentionally created so existing JS
/// guests observe exactly the same input contract as JSON callers.
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
        touches.push(pack_touch_cancel(contact.id));
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
    host.guest.frame(&frame).map_err(|error| {
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

fn decode_draw_ops(
    words: &[u32],
    width: f32,
    height: f32,
    nodes: &[NodeMeta],
    ui: &mut Ui,
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

    if first_guest_turn
        && remaining_ticks == 0
        && (!host.pending_text.is_empty()
            || host.external_work_pending
            || !host.axis_deltas.is_empty()
            || host.motion.is_some()
            || host.offload.as_ref().is_some_and(|offload| offload.has_replies()))
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

fn build_frame(host: &mut HostState, delta_ms: f64) -> Result<BuiltFrame, String> {
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
    let guest_result = run_virtual_frames(host, pending, tick_count);
    guest_result?;
    let (cache_hit, (width, height), auxiliary_size, raster_revision) = {
        let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
        core.ui.relayout_outputs();
        let auxiliary_size = core.ui.auxiliary_viewport();
        let (width, height) = core.ui.viewport();
        let raster_revision = core.ui.raster_revision();
        let nodes = host.nodes.borrow();
        let hit = if let Some(cache) = host.draw_cache.as_ref() {
            cache.matches_primary(
                &core.ui.draw().words,
                width,
                height,
                auxiliary_size,
                raster_revision,
                &nodes,
            ) && cache.matches_auxiliary(if auxiliary_size.is_some() {
                core.ui.draw_auxiliary().map(|draw| draw.words.as_slice())
            } else {
                None
            })
        } else {
            false
        };
        (hit, (width, height), auxiliary_size, raster_revision)
    };

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
        let (words, auxiliary_words) = {
            let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
            let words = core.ui.draw().words.clone();
            let auxiliary_words = if auxiliary_size.is_some() {
                core.ui.draw_auxiliary().map(|draw| draw.words.clone())
            } else {
                None
            };
            (words, auxiliary_words)
        };
        let nodes = host.nodes.borrow().clone();
        let (ops, auxiliary, generic_texture_handles) = {
            // GLYPH_RUN page preparation allocates shared core textures, so
            // both primary and auxiliary DrawLists decode through one mutable
            // Ui borrow and one deduplicated generic-resource set.
            let mut core = host.ops.core_mut().map_err(|error| format!("{error:?}"))?;
            let mut generic_texture_handles = HashSet::new();
            let ops = decode_draw_ops(
                &words,
                width,
                height,
                &nodes,
                &mut core.ui,
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
                            &mut core.ui,
                            &mut generic_texture_handles,
                        )?,
                    })
                }
                (Some(_), None) => return Err("auxiliary draw list was not produced".to_owned()),
                (None, Some(_)) => return Err("auxiliary draw list has no viewport".to_owned()),
                (None, None) => None,
            };
            let generic_texture_handles = generic_texture_handles.into_iter().collect::<Vec<_>>();
            (ops, auxiliary, generic_texture_handles)
        };
        host.draw_cache = Some(FrameDrawCache {
            words,
            auxiliary_words,
            width,
            height,
            auxiliary_size,
            raster_revision,
            nodes,
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
    let mut released_resources = host
        .sent_resources
        .iter()
        .filter_map(|(asset, sent)| {
            let texture_released = core.ui.texture(sent.texture).is_none();
            let no_longer_referenced = !referenced_assets.contains(asset);
            (texture_released || no_longer_referenced).then(|| asset.clone())
        })
        .collect::<Vec<_>>();
    // HashMap iteration is intentionally randomized.  Resource lifecycle
    // facts are a transport list, not draw order, so publish them in a
    // stable asset order for deterministic frame/replay summaries.
    released_resources.sort();
    for asset in &released_resources {
        host.sent_resources.remove(asset);
    }
    let mut resources = Vec::new();
    let nodes_borrow = host.nodes.borrow();
    for node in nodes_borrow.iter() {
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
    // `generic_texture_handles` is collected from a HashSet because several
    // DrawOps may sample one generated page.  Do not let its randomized
    // iteration order leak into the frame ABI or replay digest.
    resources.sort_by(|left, right| left.asset.cmp(&right.asset));
    let events = host.outbound.borrow_mut().drain(..).collect();
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
    ui: &mut Ui,
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
                text_align: None,
                surface_handle: None,
                focused: None,
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
                text_align: None,
                surface_handle: None,
                focused: None,
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
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
                let gid_word = words[4 + glyph * 2];
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
                let xy = words[3 + glyph * 2];
                let gid = (words[4 + glyph * 2] & 0xffff) as u16;
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
                let asset = synthetic_texture_asset(handle);
                generic_texture_handles.insert(handle);
                let point = unpack_point(xy);
                out.push(FrameOp {
                    kind: "image".into(),
                    x: point.x,
                    y: point.y,
                    w: cell_w,
                    h: cell_h,
                    text: None,
                    asset: Some(asset),
                    id: None,
                    fit: None,
                    color: Some(argb_from_abgr(color)),
                    from_color: None,
                    to_color: None,
                    direction: None,
                    size: None,
                    font_slot: None,
                    text_align: None,
                    surface_handle: None,
                    focused: None,
                    radius: None,
                    points: None,
                    colors: None,
                    uvs: None,
                    uv: Some(page.uv(gid).to_vec()),
                    clip: clip_of(operation.clip),
                });
            }
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
                text_align: None,
                surface_handle: None,
                focused: None,
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
                text_align: None,
                surface_handle: None,
                focused: None,
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
                text_align: None,
                surface_handle: None,
                focused: None,
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
                text_align: Some(((words[1] >> 8) & 0xff).min(2) as u8),
                surface_handle: None,
                focused: None,
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
            let visible =
                pocket_draw_ops::logical_rect(words[6], words[7]).intersect(operation.clip);
            if visible.is_empty() {
                return Ok(());
            }
            let surface = words[1] as i32;
            let video = nodes
                .iter()
                .find(|node| {
                    (node.kind == "video" || node.kind == "hostSurface") && node.surface == surface
                })
                .ok_or_else(|| {
                    format!("SURFACE_QUAD surface handle {surface} has no registered video asset")
                })?;
            if video.asset.is_empty() || video.video_id.is_empty() {
                return Err(format!(
                    "SURFACE_QUAD surface handle {surface} has an incomplete video mapping"
                ));
            }
            out.push(FrameOp {
                kind: if video.kind == "hostSurface" {
                    "hostSurface"
                } else {
                    "video"
                }
                .into(),
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
                text_align: None,
                surface_handle: Some(surface),
                focused: Some(words[8] & 1 != 0),
                radius: None,
                points: None,
                colors: None,
                uvs: None,
                uv: None,
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
                MIN_CONFIGURED_HEAP_LIMIT_BYTES,
                MAX_CONFIGURED_HEAP_LIMIT_BYTES,
                heap_limit_bytes
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
        heap_limit_bytes: heap_limit_bytes,
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
    pocket_create_with_memory_limits(
        width,
        height,
        1,
        DEFAULT_TICK_HZ,
        0,
        0,
    )
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
    pocket_create_with_memory_limits(
        width,
        height,
        raster_density,
        DEFAULT_TICK_HZ,
        0,
        0,
    )
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
    pocket_create_with_memory_limits(
        width,
        height,
        raster_density,
        tick_hz,
        0,
        0,
    )
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
            format!(
                "raster density must be an integer from 1 through 4 (got {raster_density})"
            ),
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
}

fn create_error_host(width: f64, height: f64, error: impl Into<String>) -> *mut HostState {
    let handle = create_host(
        width,
        height,
        1,
        DEFAULT_TICK_HZ,
        MemoryLimits::default(),
    );
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
    let (duplex, duplex_ingress_consumer) = new_duplex_channel();
    let mut ui = Ui::new_with_raster_density(raster_density);
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
            nodes: Rc::new(RefCell::new(Vec::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            duplex: error_duplex,
            duplex_ingress_consumer: error_ingress_consumer,
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
            nodes: Rc::new(RefCell::new(Vec::new())),
            outbound: Rc::new(RefCell::new(Vec::new())),
            duplex: error_duplex,
            duplex_ingress_consumer: error_ingress_consumer,
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
        memory_limits,
        nodes: nodes.clone(),
        outbound: outbound.clone(),
        duplex,
        duplex_ingress_consumer,
        last_error: String::new(),
        error_output: c_string(""),
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
        host.duplex.clone(),
        auxiliary_descriptor(&host),
        &host.compositor_surfaces,
        host.offload.clone(),
        replay::mode(&host),
        host.trace.scalar_lane(),
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

#[no_mangle]
pub unsafe extern "C" fn pocket_trace_clock_mode(handle: *mut HostState, mode: u32) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
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
    let Some(host) = handle.as_mut() else {
        return -1;
    };
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
}

/// End one host FFI transaction and return its ordered trace envelope as a
/// borrowed NUL-terminated UTF-8 string. The pointer remains valid until the
/// next trace-clock JSON call or host destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_trace_clock_end_json(handle: *mut HostState) -> *const c_char {
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
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
}

/// Register a trusted asynchronous offload provider before guest evaluation.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_offload(
    handle: *mut HostState,
    config: *const c_char,
    notify: Option<unsafe extern "C" fn()>,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let result = (|| -> Result<Arc<offload::OffloadHost>, String> {
        if host.guest_loaded || host.offload.is_some() || config.is_null() {
            return Err("offload provider must be configured once before evaluation".into());
        }
        let bytes = CStr::from_ptr(config).to_bytes();
        if bytes.len() > 16384 {
            return Err("offload config exceeds 16 KiB".into());
        }
        let config: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
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
}

/// Pop one bounded provider request/cancellation on the UI owner thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_take(
    handle: *mut HostState,
    cancelled: u32,
) -> *const c_char {
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
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
}

/// Binary counterpart of `pocket_offload_take`. Returns a borrowed `0xB2`
/// binary record until the next offload take call on the same host.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_take_binary(
    handle: *mut HostState,
    cancelled: u32,
    out_byte_length: *mut u64,
) -> *const u8 {
    if let Some(length) = out_byte_length.as_mut() {
        *length = 0;
    }
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
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
}

/// Observe native replies without consuming them. No periodic probe is used;
/// Dart checks this only while handling a native provider notification.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_has_replies(handle: *const HostState) -> u32 {
    handle
        .as_ref()
        .and_then(|host| host.offload.as_ref())
        .map(|provider| u32::from(provider.has_replies()))
        .unwrap_or(0)
}

/// Completion is generation/session/id scoped; stale or duplicate results fail.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_complete(
    handle: *mut HostState,
    record: *const c_char,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
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
}

/// Binary counterpart of `pocket_offload_complete`. Accepts a `0xB2` binary
/// completion record without intermediate JSON envelope encoding.
#[no_mangle]
pub unsafe extern "C" fn pocket_offload_complete_binary(
    handle: *mut HostState,
    record: *const u8,
    record_len: usize,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    let Some(provider) = &host.offload else {
        return -1;
    };
    if record.is_null() || record_len == 0 || record_len > 16384 {
        return -1;
    }
    let bytes = std::slice::from_raw_parts(record, record_len);
    let Some((generation, session, id, result)) =
        binary_bridge::decode_offload_completion(bytes)
    else {
        return -1;
    };
    if provider.complete(generation, session, id, result) {
        0
    } else {
        -1
    }
}

/// Install a trusted application-to-surface registry before evaluation.
/// JS selects layout/focus with official CompositorSurface nodes; guest code
/// cannot register application packages through the dynamic texture bridge.
#[no_mangle]
pub unsafe extern "C" fn pocket_configure_compositor(
    handle: *mut HostState,
    registry: *const c_char,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
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
        host.nodes.clone(),
        host.outbound.clone(),
        host.duplex.clone(),
        auxiliary_descriptor(host),
        &host.compositor_surfaces,
        host.offload.clone(),
        replay::mode(host),
        host.trace.scalar_lane(),
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
    stop_worker(host);
    host.nodes.borrow_mut().clear();
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
    host.frame_json_cache = None;
    host.frame = 0;
    host.tick_remainder_ms = 0.0;
    host.clock_started = false;
    host.demand = demand::Demand::default();
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
        host.nodes.clone(),
        host.outbound.clone(),
        host.duplex.clone(),
        auxiliary_descriptor(host),
        &host.compositor_surfaces,
        host.offload.clone(),
        replay::mode(host),
        host.trace.scalar_lane(),
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
    let Some(host) = handle.as_mut() else {
        return -1;
    };

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

#[no_mangle]
pub unsafe extern "C" fn pocket_eval(handle: *mut HostState, source: *const c_char) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };

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
    let Some(host) = handle.as_ref() else {
        return ptr::null();
    };
    Arc::into_raw(host.duplex.clone())
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_retain(
    channel: *const duplex::DuplexRing,
) -> *const duplex::DuplexRing {
    if channel.is_null() {
        return ptr::null();
    }
    Arc::increment_strong_count(channel);
    channel
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_release(channel: *const duplex::DuplexRing) {
    if !channel.is_null() {
        Arc::decrement_strong_count(channel);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_channel_close(channel: *const duplex::DuplexRing) {
    if let Some(channel) = channel.as_ref() {
        channel.close();
    }
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
    let Some(host) = handle.as_ref() else {
        return ptr::null_mut();
    };
    make_duplex_endpoint(host.duplex.clone(), true, true)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_attach_ingress_producer(
    channel: *const duplex::DuplexRing,
) -> *mut DuplexEndpoint {
    attach_duplex_endpoint(channel, true, false)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_attach_egress_consumer(
    channel: *const duplex::DuplexRing,
) -> *mut DuplexEndpoint {
    attach_duplex_endpoint(channel, false, true)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_endpoint_release(endpoint: *mut DuplexEndpoint) {
    if !endpoint.is_null() {
        drop(Box::from_raw(endpoint));
    }
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
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_ingress_publish(
    endpoint: *mut DuplexEndpoint,
    count: u32,
) -> i32 {
    if endpoint.is_null() {
        return -1;
    }
    let Some(producer) = (*endpoint).ingress.as_ref() else {
        return -2;
    };
    producer.commit_count(count) as i32
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
}

#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_egress_consume(
    endpoint: *mut DuplexEndpoint,
    count: u32,
) -> i32 {
    if endpoint.is_null() {
        return -1;
    }
    let Some(consumer) = (*endpoint).egress.as_ref() else {
        return -2;
    };
    consumer.consume(count) as i32
}

#[no_mangle]
pub extern "C" fn pocket_duplex_abi_version() -> u32 {
    duplex::ABI_VERSION
}

#[no_mangle]
pub extern "C" fn pocket_duplex_message_size() -> u32 {
    duplex::MESSAGE_BYTES as u32
}

#[no_mangle]
pub extern "C" fn pocket_duplex_capacity() -> u32 {
    (duplex::RING_CAPACITY - 1) as u32
}

/// Drain host-written duplex records on the runtime owner thread and invoke
/// `globalThis.__pocketDuplexEvent` for each one.  A missing JS handler leaves
/// ingress queued; a throwing handler leaves the current record uncommitted.
#[no_mangle]
pub unsafe extern "C" fn pocket_duplex_step(handle: *mut HostState) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
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
}

/// Mark event-driven Worker/provider output on the native owner thread.
/// A zero-delta host frame must keep the ticker until a real fixed guest turn
/// consumes it. This is a notification, never a periodic polling probe.
#[no_mangle]
pub unsafe extern "C" fn pocket_notify_external_work(handle: *mut HostState) {
    if let Some(host) = handle.as_mut() {
        if let Err(error) = demand::before_external(host) {
            set_error(host, error);
            return;
        }
        host.external_work_pending = true;
        demand::invalidate(host);
    }
}

/// Cached scheduler status from the last guest/core transaction. This query
/// never pumps JS or probes for visual changes. Unknown/legacy guests keep
/// vsync (zero), known idle guests return -1, and a timer returns its delay.
#[no_mangle]
pub unsafe extern "C" fn pocket_next_wake_delay_ms(handle: *mut HostState) -> f64 {
    handle.as_ref().map(demand::delay_ms).unwrap_or(0.0)
}

/// Stop accounting idle wall time while the embedding application is in the
/// background. The next resumed frame establishes its normal display delta.
#[no_mangle]
pub unsafe extern "C" fn pocket_set_scheduler_paused(handle: *mut HostState, paused: i32) {
    if let Some(host) = handle.as_mut() {
        if let Some(worker) = &host.worker_runtime {
            worker.set_paused(paused != 0);
        }
        if let Err(error) = demand::set_paused(host, paused != 0) {
            set_error(host, error);
        }
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

/// Full-frame binary counterpart of `pocket_frame`. Used by initial guest load
/// (`_loadFrame`) and explicit full-frame callers so startup textures and
/// DrawOps bypass UTF-8 JSON serialization.
#[no_mangle]
pub unsafe extern "C" fn pocket_frame_binary(
    handle: *mut HostState,
    delta_ms: f64,
    out_byte_length: *mut u64,
) -> *const u8 {
    if let Some(length) = out_byte_length.as_mut() {
        *length = 0;
    }
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
    match build_frame(host, delta_ms) {
        Ok(built) => match encode_binary_frame(&built.result) {
            Ok(bytes) => {
                host.binary_output = bytes;
                if let Some(length) = out_byte_length.as_mut() {
                    *length = host.binary_output.len() as u64;
                }
                clear_error(host);
                host.binary_output.as_ptr()
            }
            Err(error) => {
                host.binary_output.clear();
                set_error(host, format!("frame binary encode: {error}"));
                ptr::null()
            }
        },
        Err(error) => {
            host.binary_output.clear();
            failed_frame_output(host, error);
            ptr::null()
        }
    }
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
    if let Some(length) = out_byte_length.as_mut() {
        *length = 0;
    }
    let Some(host) = handle.as_mut() else {
        return ptr::null();
    };
    match build_frame(host, delta_ms) {
        Ok(built) if built.draw_cache_hit && frame_has_no_transient_data(&built) => {
            clear_error(host);
            ptr::null()
        }
        Ok(built) => match encode_binary_frame(&built.result) {
            Ok(bytes) => {
                host.binary_output = bytes;
                if let Some(length) = out_byte_length.as_mut() {
                    *length = host.binary_output.len() as u64;
                }
                clear_error(host);
                host.binary_output.as_ptr()
            }
            Err(error) => {
                host.binary_output.clear();
                set_error(host, format!("frame binary encode: {error}"));
                ptr::null()
            }
        },
        Err(error) => {
            host.binary_output.clear();
            failed_frame_output(host, error);
            ptr::null()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_send_binary(
    handle: *mut HostState,
    message: *const u8,
    message_len: usize,
) -> i32 {
    let Some(host) = handle.as_mut() else {
        return -1;
    };
    if message.is_null() || message_len == 0 {
        set_error(host, "null or empty binary message");
        return -1;
    }
    if message_len > MAX_BRIDGE_MESSAGE_BYTES {
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
    // A duplex producer may be full for one edge, in which case Flutter
    // falls back to this JSON entry point. Drain already-published numeric
    // records first so a fallback UP/CANCEL cannot overtake a queued DOWN.
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
        // Make the generation boundary visible to any retained background
        // channel handle before dropping the owner-side QuickJS state.
        (*handle).duplex.close();
        drop(Box::from_raw(handle));
    }
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
        assert!(referenced_image_assets(&ops).contains(ops[0].asset.as_ref().unwrap()));

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
        assert!(!referenced_image_assets(&replacement).contains(ops[0].asset.as_ref().unwrap()));
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
            asset: r#"{"kind":"glass","parameters":{"radius":18}}"#.into(),
            video_id: "test.clip".into(),
            fit: "fill".into(),
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
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 1);
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
            globalThis.__pocketEvent = function(line) {
                const event = JSON.parse(line);
                if (event.name === 'input.pointer' && event.payload.phase === 'up') {
                    ui.setProp(node, 64, 0xffcc6633);
                }
            };
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
    fn json_pointer_fallback_does_not_overtake_queued_duplex_down() {
        let handle = pocket_create(320.0, 480.0);
        let source = CString::new(
            r#"
            const node = ui.createNode(0);
            ui.setProp(node, 1, 40); ui.setProp(node, 2, 24);
            ui.insertBefore(1, node, 0);
            globalThis.frame = function() {};
            globalThis.__pocketEvent = function(line) {
                const event = JSON.parse(line);
                if (event.name === 'input.pointer') {
                    pocket._emit(JSON.stringify({type:'event', name:'input.seen', payload:{phase:event.payload.phase}}));
                }
            };
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
        let fallback_up = CString::new(
            r#"{"type":"event","name":"input.pointer","payload":{"phase":"up","id":0,"x":8,"y":12}}"#,
        )
        .unwrap();
        assert_eq!(unsafe { pocket_send(handle, fallback_up.as_ptr()) }, 0);
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
                globalThis.frame = (_buttons, analog, _touches, _hits, _surfaces, rightAnalog) => {
                  guestFrames++;
                  const axes = String(analog) + ':' + String(rightAnalog);
                  pocket._emit(JSON.stringify({name:'analog.frame',params:{axes,guestFrames}}));
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
            assert_eq!(initial["events"][1]["name"], "analog.seen");
            assert_eq!(initial["events"][1]["params"]["axes"], "32896:32896");
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let unchanged_buttons = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, unchanged_buttons.as_ptr()), 0);
            assert!(!(*host).external_work_pending);
            let unchanged_buttons_frame = frame_json_with_delta(host, 0.0);
            assert!(unchanged_buttons_frame["events"].as_array().unwrap().is_empty());
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let unchanged_axes = CString::new(
                r#"{"method":"input.axes","payload":{"axes":[{"id":0,"value":128},{"id":1,"value":128},{"id":2,"value":128},{"id":3,"value":128}]}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, unchanged_axes.as_ptr()), 0);
            assert!(!(*host).external_work_pending);
            let unchanged_axes_frame = frame_json_with_delta(host, 0.0);
            assert!(unchanged_axes_frame["events"].as_array().unwrap().is_empty());
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            let moved = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":4660,"rightAnalog":22136}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, moved.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let moved_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(moved_frame["events"][0]["name"], "analog.frame");
            assert_eq!(moved_frame["events"][0]["params"]["guestFrames"], 2);
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
            assert_eq!(held_full_tick["events"][0]["params"]["guestFrames"], 3);

            let centered = CString::new(
                r#"{"method":"input.buttons","payload":{"buttons":0,"analog":32896,"rightAnalog":32896}}"#,
            )
            .unwrap();
            assert_eq!(pocket_send(host, centered.as_ptr()), 0);
            assert!((*host).external_work_pending);
            let centered_frame = frame_json_with_delta(host, 0.0);
            assert_eq!(centered_frame["events"][0]["name"], "analog.frame");
            assert_eq!(centered_frame["events"][0]["params"]["guestFrames"], 4);
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
            assert_eq!(
                NOTIFY_COUNT.load(Ordering::Relaxed),
                before_next_submit + 1
            );
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
            if (!offload.submit(JSON.stringify({v:1,id:1,method:"crypto.digest",payload:'{"input":"hello"}'}))) {
                throw new Error("offload.submit failed");
            }
            globalThis.frame = function() {
                const reply = offload.take();
                if (reply) {
                    pocket._emitValue({
                        type: "event",
                        name: "offload.done",
                        payload: JSON.parse(reply)
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
    fn binary_bridge_handles_reentrant_getter_emit_and_preserves_proto_data_property() {
        let handle = pocket_create(80.0, 80.0);
        let source = CString::new(
            r#"
            const handler = function(packet) {
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
}
