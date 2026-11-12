#!/usr/bin/env python3
"""Bootstrap the pinned PocketJS engine used by the minimal Flutter host.

The extracted cache is intentionally ignored. A clean checkout can recreate it
from the verified archive, while a developer checkout may populate it with a
clone/copy before running this script to avoid downloading the large archive.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request


REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836"
ARCHIVE_SHA256 = "82d5d72ca242b5827379e0e7a53114bc9ee2093af0a9306336a5def543708cba"

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "pocketjs"
MARKER = CACHE / ".pocketjs-revision"

# Only patches that affect the native guest/core contract or a stable official
# framework host boundary are applied here. Browser-host and catalog/demo
# patches stay out of this host's bootstrap.
PATCHES = (
    ("guest-rquickjs-stack-size.patch", "guest stack size"),
    ("guest-execution-budget.patch", "guest execution budget"),
    ("guest-rquickjs-bytecode.patch", "guest QuickJS bytecode"),
    ("guest-exception-diagnostics.patch", "guest exception diagnostics"),
    ("guest-exception-diagnostics-tests.patch", "guest exception diagnostics tests"),
    ("tex-quad-fractional-coverage.patch", "TEX_QUAD coverage"),
    ("rgba-tileset.patch", "RGBA TILESET"),
    ("rgba-filter-helpers.patch", "RGBA filter helper"),
    ("demand-scheduler.patch", "demand scheduler"),
    ("offload-cancel.patch", "offload provider cancellation"),
    ("offload-direct-value.patch", "offload direct-value transport"),
    ("focus-display-filter.patch", "focus display filtering"),
    ("modal-transparent-backdrop.patch", "transparent modal backdrop"),
    ("image-mesh.patch", "retained image mesh"),
    ("image-mesh-dedup.patch", "retained image mesh byte deduplication"),
    ("image-mesh-subpixel.patch", "subpixel retained mesh DrawList"),
    ("image-mesh-subpixel-backends.patch", "subpixel mesh backend readers"),
    ("image-high-resolution-pak.patch", "bounded high-resolution IMG entries"),
    ("input-touch-coordinate-sidecar.patch", "full touch coordinate sidecar"),
    ("inline-text-core.patch", "one-leaf rich inline text"),
    ("native-rounded-rects.patch", "native rounded rectangle DrawList op"),
    ("native-rounded-shadows.patch", "native rounded shadow DrawList reuse"),
    ("native-arcs.patch", "native arc DrawList op"),
    ("native-rounded-gradients.patch", "native rounded gradient DrawList op"),
    ("native-rounded-radius-threshold.patch", "native rounded radius threshold fallback"),
    ("web-live2d-raster.patch", "Web Live2D software raster"),
)

# Later patches can intentionally supersede one earlier diff hunk. The
# per-file patcher still requires every other file section to match in either
# direction; these markers are only for that declared overlap.
SUPERSEDED_PATCH_MARKERS = {
    "guest stack size": {
        "engine/guest-rquickjs/src/lib.rs": (
            "// Keep QuickJS's stack guard bounded while allowing the generated",
            "// Solid mount graph to resolve its initial reactive styles.",
            "runtime.set_max_stack_size(4 * 1024 * 1024);",
        ),
    },
    "guest execution budget": {
        "engine/guest-rquickjs/src/lib.rs": (
            # The diagnostics patch deliberately replaces several execution-
            # budget hunks. Accept that overlap only when the complete final
            # contract is present: every guest entry resets its own 5s/250ms
            # turn, the host-side pending-job drain checks the same deadline,
            # and shutdown clears both deadline and interruption state.
            "fn initialize(\n        &mut self,\n        ops: OpContext,\n        environment: &GuestEnvironment<'_>,\n    ) -> Result<(), RuntimeError> {",
            "self.begin_turn(Duration::from_secs(5));\n        let context = self.remember(Context::full(&runtime))?;",
            "fn begin_turn(&self, duration: Duration) {\n        self.turn_interrupted.store(false, Ordering::Release);\n        *self.turn_deadline.lock().unwrap() = Some(Instant::now() + duration);\n    }",
            "fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {\n        self.begin_turn(Duration::from_secs(5));",
            "fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {\n        self.begin_turn(Duration::from_millis(250));",
            'runtime.set_interrupt_handler(Some(Box::new(move || {',
            'self.turn_deadline.lock().unwrap().is_some_and(|end| Instant::now() >= end)',
            'interrupted.store(true, Ordering::Release);',
            'while runtime.is_job_pending() {',
            'self.turn_interrupted.store(true, Ordering::Release);\n                    self.last_error = Some(',
            'fn shutdown(&mut self) {\n        *self.turn_deadline.lock().unwrap() = None;\n        self.turn_interrupted.store(false, Ordering::Release);',
        ),
    },
    "guest QuickJS bytecode": {
        "engine/guest-rquickjs/src/lib.rs": (
            "pub fn evaluate_bytecode(&mut self, bytecode: &[u8], tick_hz: u32)",
            "qjs::JS_ReadObject(",
            "qjs::JS_EvalFunction(ctx.as_raw().as_ptr(), value)",
        ),
    },
    "demand scheduler": {
        "framework/src/offload.ts": (
            "const eventDriven = () =>",
            "registerServicePump(() => next.step(), () => next.needsPump());",
        ),
    },
    "retained image mesh": {
        # The follow-up byte-dedup patch supersedes the added mesh.rs section
        # while retaining its full contract. Later float-op and high-resolution
        # patches also supersede a few
        # version/spec/mesh-emitter hunks while preserving the retained-mesh
        # contract. These markers accept only that complete successor state.
        "engine/core/src/mesh.rs": (
            "pub(crate) struct ImageMesh {",
            "pub fn set_mesh(&mut self, id: i32, texture: i32, bytes: &[u8]) -> bool",
            "if bytes.is_empty() { self.set_image(id, -1); return true; }",
            "if tex_resolve(&self.textures, texture).is_none() || bytes.len() < 16 { return false; }",
            "node.tex == texture",
            "node.sprite_frames == 0",
            "node.mesh.as_ref().map_or(false, |mesh| mesh.bytes.as_slice() == bytes)",
            "if word(bytes, 0) != 0x31534d50",
            "self.mesh_bytes - old + needed > BUDGET",
            "pub fn set_mesh_effect(&mut self, id: i32, bytes: &[u8]) -> bool",
        ),
        "contracts/generated/pocket_spec.h": (
            "#define POCKET_DRAW_LIST_VERSION 5U",
            "#define POCKET_DRAW_OP_TEX_TRI_FLOAT 15U",
            "#define POCKET_DRAW_OP_TEX_TRI_REPEAT_FLOAT 16U",
            "#define POCKET_DRAW_OP_ARC 18U",
            "#define POCKET_DRAW_OP_ROUNDED_GRADIENT 19U",
        ),
        "contracts/spec/spec.ts": (
            "export const DRAW_LIST_VERSION = 5;",
            "texTriFloat: 15,",
            "texTriRepeatFloat: 16,",
            "arc: 18,",
            "roundedGradient: 19,",
        ),
        "contracts/spec/gen-rust.ts": (
            "TEX_TRI_FLOAT and TEX_TRI_REPEAT_FLOAT",
        ),
        "devices/gles/pocket-gles/src/lib.rs": (
            "spec::draw_op::TEX_TRI_REPEAT_FLOAT",
            "spec::draw_op::TEX_TRI_FLOAT",
        ),
        "devices/vita/pocket-vita-render/src/lib.rs": (
            "spec::draw_op::TEX_TRI_REPEAT_FLOAT",
            "spec::draw_op::TEX_TRI_FLOAT",
        ),
        "engine/core/src/draw.rs": (
            "fn emit_mesh_tex_tri(",
            "spec::draw_op::TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/core/src/lib.rs": (
            "self.upload_texture_flags_with_limit(data, w, h, psm, flags, spec::TEX_MAX_DIM)",
            "self.upload_texture_flags_with_limit(&blob[8..], w, h, psm, flags, spec::IMG_MAX_DIM)",
        ),
        "engine/drivers/src/abi.rs": (
            "pub const POCKET_DRAW_LIST_VERSION: u32 = 5;",
        ),
        "engine/present/src/damage.rs": (
            "fn triangle_bounds_float(",
            "spec::draw_op::TEX_TRI_FLOAT | spec::draw_op::TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/present/src/compositor.rs": (
            "// The raster backend handles mesh layers and repeated texture sampling;",
            "partial fallback for records it cannot express would change appearance.",
        ),
        "engine/raster/src/surface.rs": (
            "draw_op::MESH_LAYER_BEGIN",
            "draw_op::TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/raster/tests/driver.rs": (
            "fn float_mesh_triangle_preserves_subpixel_coverage_in_software_raster()",
            "fn float_mesh_shared_edge_uses_top_left_coverage_once()",
            "fn software_surface_rejects_native_shape_ops_before_writing()",
        ),
        "engine/render/draw-ops/src/lib.rs": (
            "draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT => 15,",
            "draw_op::ARC => 8,",
            "draw_op::ROUNDED_GRADIENT => 11,",
        ),
        "engine/render/draw-ops/tests/decoding.rs": (
            "TEX_TRI_REPEAT_FLOAT",
            "fn arc_preserves_float_geometry_under_the_active_clip()",
        ),
        "engine/spec/src/lib.rs": (
            "pub const DRAW_LIST_VERSION: u32 = 5;",
            "pub const TEX_TRI_FLOAT: u32 = 15;",
            "pub const TEX_TRI_REPEAT_FLOAT: u32 = 16;",
            "pub const ARC: u32 = 18;",
            "pub const ROUNDED_GRADIENT: u32 = 19;",
        ),
        "engine/core/src/tree.rs": (
            "pub(crate) mesh: Option<crate::mesh::ImageMesh>,",
            "pub inline_text: Option<InlineTextSpec>,",
            "pub inline_layout_key: u64,",
            "mesh: None,",
            "inline_layout_key: 0,",
        ),
        "engine/runtime/src/generated_ops.rs": (
            'name: "setMesh",',
            'name: "setMeshEffect",',
            'name: "setInlineText",',
            'name: "setInlineReveal",',
            'name: "getInlineTextLayout",',
            "7 | 64 | 65 | 66 | 8 | 9 | 10 | 62 | 63",
            "ui.set_mesh(a0, a1, a2)",
            "ui.set_mesh_effect(a0, a1)",
            "ui.set_inline_text(a0, a1, a2)",
            "ui.set_inline_reveal(a0, a1)",
            "ui.get_inline_text_layout(a0)",
        ),
    },
    "native rounded rectangle DrawList op": {
        "contracts/generated/pocket_spec.h": (
            "#define POCKET_DRAW_LIST_VERSION 5U",
            "#define POCKET_DRAW_OP_ROUNDED_RECT 17U",
            "#define POCKET_DRAW_OP_ARC 18U",
            "#define POCKET_DRAW_OP_ROUNDED_GRADIENT 19U",
        ),
        "contracts/spec/spec.ts": (
            "export const DRAW_LIST_VERSION = 5;",
            "roundedRect: 17,",
            "arc: 18,",
            "roundedGradient: 19,",
        ),
        "contracts/spec/gen-rust.ts": (
            "ROUNDED_RECT and ARC 8 each, ROUNDED_GRADIENT 11.",
            "pub const DRAW_LIST_VERSION: u32 = ${DRAW_LIST_VERSION};",
        ),
        "engine/core/src/draw.rs": (
            "if sx1 + 1.0 <= clip.x0 || sx0 - 1.0 >= clip.x1",
            "spec::draw_op::ROUNDED_RECT",
            "fn emit_native_rounded_gradient(",
            "spec::draw_op::ROUNDED_GRADIENT,",
        ),
        "engine/core/src/lib.rs": (
            "pub fn set_native_rounded_rects(&mut self, enabled: bool)",
            "x if x == spec::draw_op::ROUNDED_GRADIENT => 11,",
        ),
        "engine/spec/src/lib.rs": (
            "/// TEX_TRI_FLOAT and TEX_TRI_REPEAT_FLOAT 15 each, ROUNDED_RECT and ARC 8 each, ROUNDED_GRADIENT 11.",
            "pub const DRAW_LIST_VERSION: u32 = 5;",
            "pub const ROUNDED_RECT: u32 = 17;",
            "pub const ARC: u32 = 18;",
            "pub const ROUNDED_GRADIENT: u32 = 19;",
        ),
        "engine/render/draw-ops/src/lib.rs": (
            "draw_op::ROUNDED_RECT => 8,",
            "draw_op::ARC => 8,",
            "draw_op::ROUNDED_GRADIENT => 11,",
        ),
        "engine/present/src/damage.rs": (
            "floor_i32(bounds[0])",
            "ceil_i32(bounds[2])",
        ),
        "engine/core/src/tests.rs": (
            "fn native_rounded_rects_are_opt_in_and_preserve_ring_compositing()",
            "fn native_rounded_gradients_preserve_stops_directions_and_composition()",
            "for word in i + 2..i + 14 { assert!(f32::from_bits(words[word]).is_finite()); }",
            "spec::draw_op::TEX_TRI_FLOAT | spec::draw_op::TEX_TRI_REPEAT_FLOAT => { previous_was_tex_tri = false; i += 15; }",
            "words[triangle + 14]",
        ),
        "engine/render/draw-ops/tests/decoding.rs": (
            "fn rounded_rect_uses_the_active_viewport_and_overflow_clip()",
            "all_sixteen_records_preserve_the_original_words_and_offsets",
        ),
    },
    "native rounded shadow DrawList reuse": {
        "engine/core/src/draw.rs": (
            "let native_round = self.native_rounded_rects;",
            "let native_shadow = self.native_rounded_rects && !has_grad;",
            "r.shadow, op, &clip, native_shadow);",
            "clip: &Clip, allow_native: bool",
            "allow_native,",
            "spec::draw_op::ROUNDED_GRADIENT,",
        ),
        "engine/core/src/tests.rs": (
            "fn native_rounded_shadows_preserve_layers_and_fallbacks()",
            "assert_rect(records[2], 15.0, 14.0, 230.0, 230.0, 43.0, 0.0, 0x07000000);",
            "assert_rect(records[3], 20.0, 10.0, 220.0, 220.0, 38.0, 0.0, 0xff223344);",
            "spec::draw_op::ROUNDED_GRADIENT => i += 11,",
            "fn native_rounded_gradients_preserve_stops_directions_and_composition()",
        ),
    },
    "native arc DrawList op": {
        "contracts/spec/spec.ts": (
            "export const DRAW_LIST_VERSION = 5;",
            "arc: 18,",
            "roundedGradient: 19,",
        ),
        "contracts/spec/gen-rust.ts": (
            "ROUNDED_RECT and ARC 8 each, ROUNDED_GRADIENT 11.",
            "pub const DRAW_LIST_VERSION: u32 = ${DRAW_LIST_VERSION};",
        ),
        "contracts/generated/pocket_spec.h": (
            "#define POCKET_DRAW_LIST_VERSION 5U",
            "#define POCKET_DRAW_OP_ARC 18U",
            "#define POCKET_DRAW_OP_ROUNDED_GRADIENT 19U",
        ),
        "engine/spec/src/lib.rs": (
            "pub const DRAW_LIST_VERSION: u32 = 5;",
            "pub const ARC: u32 = 18;",
            "pub const ROUNDED_GRADIENT: u32 = 19;",
        ),
        "engine/drivers/src/abi.rs": (
            "pub const POCKET_DRAW_LIST_VERSION: u32 = 5;",
        ),
        "engine/core/src/lib.rs": (
            "x if x == spec::draw_op::ARC => 8,",
            "x if x == spec::draw_op::ROUNDED_GRADIENT => 11,",
        ),
        "engine/render/draw-ops/src/lib.rs": (
            "draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT => 15,",
            "draw_op::ARC => 8,",
            "draw_op::ROUNDED_GRADIENT => 11,",
            "DecodeError::InvalidArc",
        ),
        "engine/render/draw-ops/tests/decoding.rs": (
            "fn arc_preserves_float_geometry_under_the_active_clip()",
            "Some(Err(DecodeError::InvalidArc))",
        ),
        "engine/core/src/draw.rs": (
            "fn emit_native_arc(",
            "spec::draw_op::ARC,",
            "fn emit_native_rounded_gradient(",
            "spec::draw_op::ROUNDED_GRADIENT,",
        ),
        "engine/core/src/tests.rs": (
            "fn native_arcs_preserve_signed_geometry_and_legacy_fallback()",
        ),
        "engine/present/src/damage.rs": (
            "spec::draw_op::ARC => arc_bounds(words, clip),",
            "fn arc_damage_contains_antialias_and_stroke_caps()",
        ),
    },
    "native rounded gradient DrawList op": {
        # The retained gradient test scanner was extended to skip the new
        # 11-word record while checking the flat-shadow fallback.
        "engine/raster/src/surface.rs": (
            "draw_op::ROUNDED_GRADIENT",
        ),
        "engine/core/src/tests.rs": (
            "fn native_rounded_shadows_preserve_layers_and_fallbacks()",
            "spec::draw_op::ROUNDED_GRADIENT => i += 11,",
            "fn native_rounded_gradients_preserve_stops_directions_and_composition()",
        ),
    },
    "bounded high-resolution IMG entries": {
        # The retained-mesh patch upgrades this test's mesh assertion from
        # TEX_TRI to the already-supported float triangle opcodes. Accept the
        # complete successor assertion when checking bootstrap idempotency.
        "engine/core/src/tests.rs": (
            "spec::draw_op::TEX_TRI | spec::draw_op::TEX_TRI_FLOAT | spec::draw_op::TEX_TRI_REPEAT_FLOAT",
            "words[triangle + 14], 0x80402010",
            "f32::from_bits(words[triangle + 8]), 1.0",
        ),
    },
    "subpixel retained mesh DrawList": {
        "contracts/spec/spec.ts": (
            "texTriRepeatFloat: 16,",
        ),
        "contracts/spec/gen-rust.ts": (
            "TEX_TRI_FLOAT and TEX_TRI_REPEAT_FLOAT",
        ),
        "contracts/generated/pocket_spec.h": (
            "#define POCKET_DRAW_OP_TEX_TRI_REPEAT_FLOAT 16U",
        ),
        "engine/spec/src/lib.rs": (
            "pub const TEX_TRI_REPEAT_FLOAT: u32 = 16;",
        ),
        "engine/core/src/draw.rs": (
            "spec::draw_op::TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/core/src/lib.rs": (
            "self.upload_texture_flags_with_limit(&blob[8..], w, h, psm, flags, spec::IMG_MAX_DIM)",
        ),
        "engine/raster/src/lib.rs": (
            "fn tex_tri_float<T: RenderTarget>(",
        ),
        "engine/render/draw-ops/src/lib.rs": (
            "draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT => 15,",
        ),
        "engine/raster/src/surface.rs": (
            "draw_op::TEX_TRI_REPEAT_FLOAT",
            "draw_op::ROUNDED_GRADIENT",
        ),
        "engine/raster/tests/driver.rs": (
            "fn float_mesh_triangle_preserves_subpixel_coverage_in_software_raster()",
            "fn float_mesh_shared_edge_uses_top_left_coverage_once()",
            "fn software_surface_rejects_native_shape_ops_before_writing()",
        ),
        "engine/render/draw-ops/tests/decoding.rs": (
            "TEX_TRI_FLOAT",
            "TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/present/src/damage.rs": (
            "spec::draw_op::TEX_TRI_FLOAT | spec::draw_op::TEX_TRI_REPEAT_FLOAT",
        ),
        "engine/drivers/src/abi.rs": (
            "pub const POCKET_DRAW_LIST_VERSION: u32 = 5;",
        ),
    },
}

FINAL_CONTRACTS = {
    "contracts/generated/pocket_spec.h": (
        "#define POCKET_DRAW_LIST_VERSION 5U",
        "#define POCKET_DRAW_OP_ARC 18U",
        "#define POCKET_DRAW_OP_ROUNDED_GRADIENT 19U",
        "#define POCKET_OP_setInlineText 64U",
        "#define POCKET_OP_setInlineReveal 65U",
        "#define POCKET_OP_getInlineTextLayout 66U",
    ),
    "contracts/spec/ui-ops.ts": (
        'core("setInlineText", [arg("id", "i32"), arg("source", "string"), arg("records", "bytes")]',
        'core("getInlineTextLayout", [arg("id", "i32")]',
    ),
    "engine/core/src/lib.rs": (
        "pub fn set_inline_text(&mut self, id: i32, source: &str, records: &[u8])",
        "pub fn set_inline_reveal(&mut self, id: i32, codepoints: u32)",
        "pub fn get_inline_text_layout(&mut self, id: i32) -> Vec<u32>",
        "pub fn set_native_rounded_rects(&mut self, enabled: bool)",
    ),
    "engine/render/draw-ops/src/lib.rs": (
        "draw_op::ROUNDED_RECT => 8,",
        "draw_op::ARC => 8,",
        "draw_op::ROUNDED_GRADIENT => 11,",
    ),
    "engine/raster/src/surface.rs": (
        "let has_mesh = has_mesh_layer(words, geometry.viewport)?;",
        "if render_mesh_operation(",
        "if matches!(operation.opcode, draw_op::ROUNDED_RECT | draw_op::ARC | draw_op::ROUNDED_GRADIENT)",
    ),
    "engine/raster/tests/driver.rs": (
        "fn software_surface_renders_mesh_blends_and_rgb_tint()",
        "fn software_surface_applies_normal_and_inverted_mesh_masks()",
        "fn normal_mask_clears_outside_smaller_mask_bounds_but_inverted_mask_preserves_it()",
        "fn software_surface_repeats_fixed_and_packed_float_mesh_uvs()",
        "fn legacy_capture_rasters_mesh_layers_for_opaque_and_premultiplied_web_paths()",
        "fn mesh_opcode_detection_ignores_matching_payload_words()",
        "fn software_surface_rejects_nested_mesh_layers_before_writes()",
        "fn software_surface_rejects_native_shape_ops_before_writing()",
    ),
    "engine/core/src/draw.rs": (
        "fn emit_mesh_tex_tri(",
        "spec::draw_op::TEX_TRI_REPEAT_FLOAT",
        "let native_round = self.native_rounded_rects;",
        "clip: &Clip, allow_native: bool",
        "fn emit_native_arc(",
        "spec::draw_op::ARC,",
        "spec::draw_op::ROUNDED_GRADIENT,",
        "if !radius.is_finite() || !border_width.is_finite() || radius <= 0.5 { return false; }",
    ),
    "engine/core/src/tests.rs": (
        "fn native_rounded_shadows_preserve_layers_and_fallbacks()",
        "fn native_rounded_radius_threshold_preserves_legacy_square_fallback()",
        "assert_rect(records[2], 15.0, 14.0, 230.0, 230.0, 43.0, 0.0, 0x07000000);",
        "assert_rect(records[3], 20.0, 10.0, 220.0, 220.0, 38.0, 0.0, 0xff223344);",
        "fn native_arcs_preserve_signed_geometry_and_legacy_fallback()",
        "fn native_rounded_gradients_preserve_stops_directions_and_composition()",
        "spec::draw_op::ROUNDED_GRADIENT => i += 11,",
    ),
    "engine/core/src/inline_text.rs": (
        "pub fn layout(",
        "pub fn encode_query(",
        "complex-script shaping remains the responsibility of a future shaper",
    ),
    "engine/spec/src/lib.rs": (
        "pub const SET_INLINE_TEXT: u8 = 64;",
        "pub const SET_INLINE_REVEAL: u8 = 65;",
        "pub const GET_INLINE_TEXT_LAYOUT: u8 = 66;",
    ),
    "engine/runtime/src/generated_ops.rs": (
        'name: "setInlineText",',
        'name: "setInlineReveal",',
        'name: "getInlineTextLayout",',
        "ui.set_inline_text(a0, a1, a2)",
        "ui.set_inline_reveal(a0, a1)",
        "ui.get_inline_text_layout(a0)",
    ),
    "engine/guest-quickjs/src/generated_ops.h": (
        '{ 64, "setInlineText", 3, PJS_RESULT_NONE, 0, 0,',
        '{ 65, "setInlineReveal", 2, PJS_RESULT_NONE, 0, 0,',
        '{ 66, "getInlineTextLayout", 1, PJS_RESULT_U32ARRAY, 0, 0,',
    ),
    "framework/src/renderer-solid.ts": (
        "syncStyle,",
    ),
    "framework/src/inline-fonts.ts": (
        "export function inlineFontSlot(role: InlineFontRole): number",
        "INLINE_TEXT_FONT_SLOTS",
    ),
    "tools/inline-text-slots.ts": (
        "export function addInlineTextFontSlots(",
        "fontSlotFor(16, false)",
        "fontSlotFor(12, false)",
    ),
    "framework/src/services.ts": (
        "export function registerServicePump(pump: ServicePump, pending: PendingWork = () => true): () => void {",
        "export function hasPendingServiceWork(): boolean",
        "type PendingWork = () => boolean;",
    ),
    "framework/src/offload.ts": (
        "const eventDriven = () =>",
        "registerServicePump(() => next.step(), () => next.needsPump());",
        "ops as OffloadOps & { cancel?:",
        "if (item.sent) (ops as OffloadOps",
    ),
    "framework/src/touch.ts": (
        "const COORDINATE_SIDECAR_MARKER = 0x10000000;",
        "coordinates?: readonly TouchCoordinate[],",
        "if (needsSidecar && !isCoordinate(coordinate)) continue;",
    ),
    "framework/src/index.ts": (
        "touchCoordinates?: readonly TouchCoordinate[],",
        "__setTouches(touches, hits, touchSurfaces, touchCoordinates)",
    ),
    "framework/src/index-vue-vapor.ts": (
        "touchCoordinates?: readonly TouchCoordinate[],",
        "__setTouches(touches, hits, touchSurfaces, touchCoordinates)",
    ),
    "framework/src/index-octane.ts": (
        "_axisDeltas?: readonly unknown[],",
        "_text?: readonly unknown[],",
        "__setTouches(touches, hits, touchSurfaces, touchCoordinates)",
    ),
    "framework/src/devtools.ts": (
        "touchCoordinatesArg?: readonly TouchCoordinate[],",
        "touchCoordinates = undefined;",
        "textArg, touchCoordinates);",
    ),
    "engine/guest-rquickjs/src/lib.rs": (
        "pub fn frame_with_touch_coordinates(",
        "pub fn call_frame_with_touch_coordinates(",
    ),
    "contracts/spec/spec.ts": (
        "export const TEX_MAX_DIM = 512;",
        "export const IMG_MAX_DIM = 2048;",
        "export const DRAW_LIST_VERSION = 5;",
        "texTriFloat: 15,",
        "texTriRepeatFloat: 16,",
        "arc: 18,",
        "roundedGradient: 19,",
    ),
    "contracts/spec/gen-rust.ts": (
        "  IMG_MAX_DIM,",
        "pub const IMG_MAX_DIM: u32 = ${IMG_MAX_DIM};",
    ),
    "framework/compiler/pak.ts": (
        "w > IMG_MAX_DIM || h > IMG_MAX_DIM",
        "dims must be pow2 <= ${IMG_MAX_DIM}",
    ),
    "engine/spec/src/lib.rs": (
        "pub const TEX_MAX_DIM: u32 = 512;",
        "pub const IMG_MAX_DIM: u32 = 2048;",
        "pub const DRAW_LIST_VERSION: u32 = 5;",
        "pub const TEX_TRI_FLOAT: u32 = 15;",
        "pub const TEX_TRI_REPEAT_FLOAT: u32 = 16;",
        "pub const ARC: u32 = 18;",
        "pub const ROUNDED_GRADIENT: u32 = 19;",
    ),
    "engine/drivers/src/abi.rs": (
        "pub const POCKET_DRAW_LIST_VERSION: u32 = 5;",
    ),
    "engine/render/draw-ops/src/lib.rs": (
        "draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT => 15,",
        "draw_op::ARC => 8,",
        "draw_op::ROUNDED_GRADIENT => 11,",
    ),
    "engine/raster/src/lib.rs": (
        "fn sample_linear_repeat(view: &TexView, u: f32, v: f32)",
        "pub(crate) fn has_mesh_layer(words: &[u32], viewport: DamageRect)",
        "pub(crate) fn render_mesh_operation<T: RenderTarget>(",
        "fn composite_mesh_opaque(",
        "fn composite_mesh_premultiplied(",
        "1 => (dest + source[index]).min(255),",
        "draw_op::TEX_TRI | draw_op::TEX_TRI_REPEAT => tex_tri(",
        "draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT => tex_tri_float(",
    ),
    "engine/core/src/lib.rs": (
        "self.upload_texture_flags_with_limit(data, w, h, psm, flags, spec::TEX_MAX_DIM)",
        "self.upload_texture_flags_with_limit(&blob[8..], w, h, psm, flags, spec::IMG_MAX_DIM)",
        "x if x == spec::draw_op::ARC => 8,",
        "x if x == spec::draw_op::ROUNDED_GRADIENT => 11,",
    ),
    "engine/present/src/damage.rs": (
        "spec::draw_op::ARC => arc_bounds(words, clip),",
        "fn arc_damage_contains_antialias_and_stroke_caps()",
        "spec::draw_op::ROUNDED_RECT | spec::draw_op::ROUNDED_GRADIENT",
        "fn rounded_gradient_damage_keeps_the_full_bounds_and_intersects_clip()",
    ),
}


def extract_archive() -> None:
    url = f"https://codeload.github.com/pocket-nexus/pocketjs/tar.gz/{REVISION}"
    print(f"Downloading pinned PocketJS {REVISION} …")
    with urllib.request.urlopen(url, timeout=120) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise SystemExit(f"PocketJS archive hash mismatch: {digest}")
    CACHE.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        for member in package.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            if not relative.parts:
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit(f"Unsafe archive entry: {member.name}")
            # The upstream archive contains documentation links (including an
            # AGENTS.md link). Never follow them into the checkout; no linked
            # entry is required by the native engine.
            if member.issym() or member.islnk():
                continue
            target = CACHE / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = package.extractfile(member)
                if source is None:
                    raise SystemExit(f"Unable to read archive entry: {member.name}")
                target.write_bytes(source.read())
    MARKER.write_text(REVISION + "\n", encoding="utf-8")


def patch_sections(patch_bytes: bytes) -> list[tuple[str, bytes]]:
    """Split a unified diff into independently verifiable file sections."""
    lines = patch_bytes.splitlines(keepends=True)
    starts: list[int] = []
    for index, line in enumerate(lines):
        if line.startswith(b"diff --git "):
            starts.append(index)
        elif line.startswith(b"--- ") and (
            index + 1 < len(lines) and lines[index + 1].startswith(b"+++ ")
        ):
            if not starts or not any(
                lines[position].startswith(b"diff --git ")
                for position in range(starts[-1], index + 1)
            ):
                starts.append(index)
    if not starts:
        raise SystemExit("Patch has no unified-diff file sections")

    sections: list[tuple[str, bytes]] = []
    for slot, start in enumerate(starts):
        end = starts[slot + 1] if slot + 1 < len(starts) else len(lines)
        section = b"".join(lines[start:end])
        target: str | None = None
        for line in lines[start:end]:
            if line.startswith(b"+++ b/"):
                target = line[6:].decode("utf-8").strip()
                break
            if line.startswith(b"--- a/"):
                target = line[6:].decode("utf-8").strip()
        if target is None:
            raise SystemExit("Patch section does not identify a target file")
        sections.append((target, section))
    return sections


def run_patch(target: str, section: bytes, *, reverse: bool = False, dry_run: bool = True) -> subprocess.CompletedProcess[bytes]:
    # GNU patch otherwise auto-detects a reversed diff even when --reverse was
    # explicitly requested. That makes an unapplied patch look "already
    # present" and let the bootstrap skip it. --forward disables that fallback
    # for both directions, so a successful dry run proves the requested
    # direction actually matches.
    command = ["patch", "--batch", "--fuzz=0", "--forward", "-p1"]
    if reverse:
        command.append("--reverse")
    if dry_run:
        command.append("--dry-run")
    result = subprocess.run(
        command,
        cwd=CACHE,
        input=section,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    # `patch` still exits zero when --forward skips a previously applied hunk
    # (and with --batch it can also skip a missing file). Treat those reports
    # as a failed directional match instead of trusting its status alone.
    output = result.stdout.lower()
    skipped = (
        b"ignored" in output
        or b"previously applied" in output
        or b"no file to patch" in output
        or b"skipping" in output
        or b" failed" in output
    )
    if result.returncode == 0 and skipped:
        return subprocess.CompletedProcess(result.args, 1, result.stdout, result.stderr)
    return result


def file_has_markers(target_name: str, markers: tuple[str, ...]) -> bool:
    target = CACHE / target_name
    if not target.is_file():
        return False
    content = target.read_text(encoding="utf-8")
    return all(marker in content for marker in markers)


def apply_patch(filename: str, label: str) -> None:
    patch_path = ROOT / "native" / "patches" / filename
    if not patch_path.is_file():
        raise SystemExit(f"Missing required {label} patch: {patch_path}")
    patch_bytes = patch_path.read_bytes()
    superseded = SUPERSEDED_PATCH_MARKERS.get(label, {})
    applied = 0
    already = 0
    for target, section in patch_sections(patch_bytes):
        reverse = run_patch(target, section, reverse=True)
        if reverse.returncode == 0:
            already += 1
            continue

        markers = superseded.get(target)
        if (
            label == "native rounded shadow DrawList reuse"
            and target == "engine/core/src/tests.rs"
            and markers
            and file_has_markers(target, markers)
        ):
            already += 1
            print(f"PocketJS {label}: accepted final gradient successor in {target} before forward apply")
            continue

        forward = run_patch(target, section)
        if forward.returncode == 0:
            result = run_patch(target, section, dry_run=False)
            if result.returncode != 0:
                detail = result.stdout.decode("utf-8", errors="replace").strip()
                raise SystemExit(f"{label} patch failed while applying {target}:\n{detail}")
            reverse = run_patch(target, section, reverse=True)
            if reverse.returncode != 0:
                detail = reverse.stdout.decode("utf-8", errors="replace").strip()
                raise SystemExit(f"{label} patch did not verify after applying {target}:\n{detail}")
            applied += 1
            continue

        if markers and file_has_markers(target, markers):
            already += 1
            print(f"PocketJS {label}: accepted superseded hunk in {target} by explicit contract markers")
            continue

        detail = forward.stdout.decode("utf-8", errors="replace").strip()
        raise SystemExit(
            f"{label} patch is neither fully applicable nor fully present in {target}; "
            f"refusing a partial match:\n{detail}"
        )

    if applied and already:
        print(f"PocketJS {label}: applied {applied} file section(s), verified {already} already-present section(s)")
    elif applied:
        print(f"PocketJS {label}: applied")
    else:
        print(f"PocketJS {label}: already present in {already} file section(s)")


def verify_final_contracts() -> None:
    for target, markers in FINAL_CONTRACTS.items():
        if not file_has_markers(target, markers):
            raise SystemExit(
                f"Pinned PocketJS integration contract is incomplete in {target}; "
                "recheck prepare_upstream patches against the pinned revision"
            )
    core_tests = CACHE / "engine/core/src/tests.rs"
    content = core_tests.read_text(encoding="utf-8")
    for name in (
        "native_rounded_shadows_preserve_layers_and_fallbacks",
        "native_rounded_radius_threshold_preserves_legacy_square_fallback",
        "native_arcs_preserve_signed_geometry_and_legacy_fallback",
        "native_rounded_gradients_preserve_stops_directions_and_composition",
    ):
        declarations = re.findall(rf"^fn {re.escape(name)}\(", content, re.MULTILINE)
        if len(declarations) != 1:
            raise SystemExit(
                f"Expected exactly one Core regression function {name} in {core_tests}, "
                f"found {len(declarations)}"
            )


def main() -> None:
    if not MARKER.is_file() or MARKER.read_text(encoding="utf-8").strip() != REVISION:
        extract_archive()
    else:
        print(f"PocketJS {REVISION}: cache ready")
    for filename, label in PATCHES:
        apply_patch(filename, label)
    verify_final_contracts()


if __name__ == "__main__":
    main()
