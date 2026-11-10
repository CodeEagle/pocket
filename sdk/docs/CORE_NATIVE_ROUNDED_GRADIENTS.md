# Native rounded gradient contract

`ROUNDED_GRADIENT` is an opt-in Pocket Core DrawList record for a rounded box
filled with a two or three stop linear gradient. It keeps the full transformed
box bounds and gradient coordinates; the active DrawOps clip remains a
separate record and never rebases the shader. Its 11 words are:

```text
op, x, y, width, height, radius, fromColor, toColor, direction, viaColor, viaPosition
```

`viaPosition` uses NaN only to signal a two stop gradient. A middle stop must
have a finite position strictly inside `(0, 1)`. Width, height, and radius are
finite and positive. Directions use Pocket's stable ordinals: top, bottom,
left, right.

Core emits this record only when native rounded rectangles are enabled, the
fill is a gradient, and the transform is positive, axis aligned, and uniformly
scaled. Rotated, nonuniform, reflected, nonfinite, and subpixel-radius shapes
keep the legacy tessellated/raster fallback. Flat fills continue to use
`ROUNDED_RECT`.

Borders remain an ordered composition: Core emits the flat outer rounded ring,
then an inset rounded gradient fill. A gradient with a shadow keeps the
existing layered shadow recipe before the single rounded-gradient fill; shadow
layers are not merged into the gradient operation.

PFB1 version 5 appends operation tag 17. Its optional middle stop is encoded
with a strict boolean presence byte, followed by color and position when true.
PFP1 carries the same versioned PFB1 payload for inserted operation segments.
Older frame versions and DrawList operations keep their prior layouts.
