# Harbor interface artwork

`harbor-frame.png` is original raster interface artwork generated for this game on 2026-11-07 with the built-in `image_gen` tool. It is intended for the game's image skin, including dialogue, menu and button frames. Text remains a separate editable/localizable layer.

- Generated master: `../masters/ui/harbor-frame.png`, 1254 × 1254, RGBA.
- Master SHA-256: `73a2df2960a4f5d07f7f17f350374511a772a2c0fd2071583106b2dc5b9ad808`.
- Runtime `harbor-frame.png`: 512 × 512, RGBA with alpha retained; SHA-256 `2695327d17ef463127244b0909bbac4bb7d45462518c8f71d0f462a2e02975b0`.
- Original generation retained at `/Users/lincoln.law/.codex/generated_images/01a1b110-c27f-7ca2-8fca-9fda16ae1a72/exec-0656a410-81b3-4c09-9108-2c8b81595091.png`.
- The master is unchanged. The existing `scripts/prepare_textures.ts --only=art/ui/harbor-frame.png` pipeline bakes the runtime texture with macOS `sips`, as for the game's other generated art. The pinned PAK format requires power-of-two dimensions no larger than 512; its limit was preserved.
- Runtime slicing uses the actual baked dimensions: 512 pixels with source inset 122 pixels (scaled from approximately 300 / 1254). Destination edges depend on the control's available width and height.

## Generation prompt

Use case: stylized-concept. Asset type: a single production game UI nine-slice panel texture for an atmospheric visual novel named Mist Harbor Last Letter. Create ONE square 1024x1024 front-facing flat raster UI panel, not a mockup, no perspective. The panel occupies the square almost edge to edge. Dark deep blue-green/navy opaque center with subtle aged paper and painted enamel grain, very low contrast so cream Chinese text can be drawn over it. Thin muted antique brass double-line frame; restrained engraved maritime corner details wholly inside the outermost 48 pixels. Four gently chamfered or slightly rounded corners with genuinely transparent pixels outside the panel. Top/bottom/left/right center edge strips must be straight and visually uniform for nine-slice stretching; the broad center must be uninterrupted quiet texture. Keep every ornament in corner regions, never in the broad center. Elegant hand-painted visual novel game interface art, understated late-night harbor stationery mood. No words, no letters, no numerals, no icons, no extra objects, no separate UI elements, no scene, no drop shadow beyond the transparent corners, no watermark. Output a standalone texture asset.
