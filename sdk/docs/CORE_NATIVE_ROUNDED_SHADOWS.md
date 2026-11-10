# Native rounded shadow emission

## Source and retained behavior

The retained parent renderer in [pocket_ui_components.dart](../../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart#L385) uses Flutter's `BoxShadow` layers around a `ClipRRect` surface and draws rounded primitives with `Canvas.drawRRect`. The SDK host already decodes Core's `ROUNDED_RECT` operation into its `rounded` frame operation; [pocket_view_painter.dart](../packages/pocket_flutter/lib/src/pocket_view_painter.dart#L421) paints fills with `drawRRect` and rings with `drawDRRect`.

Pocket Core's existing shadow style is a compact two or three layer alpha recipe, not a blurred `BoxShadow`. This change retains each layer's offset, spread, alpha, and order. It only replaces the per-layer rectangle or scanline emission with the existing rounded rectangle DrawList op when the native rounded path is enabled and the node has no gradient.

## Eligibility and fallback

The feature remains opt-in. The existing native rounded emitter still rejects rotated, nonuniform, invalid, or otherwise unsupported geometry, so those cases keep the portable fallback. Gradient nodes also keep the old path for both the shadow and the fill. The phase adds no DrawList opcode and does not change shadow style values.

## Validation and limits

Core coverage checks exact DrawList geometry, alpha, compositing order, level-one and level-three layer counts, the default-off path, and gradient/nonuniform fallbacks. A representative radius-38, level-three probe went from 958 operations including fill to four rounded operations (three shadow layers and the fill). The test validates operation-level equivalence; Flutter's edge antialiasing can differ from the previous 2x2 raster coverage, so pixel-identical edges are not promised.
