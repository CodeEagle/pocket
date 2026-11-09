# Foreground sea mist and rain

Sea mist was generated with the built-in GPT Image tool; saved output
`exec-15094ed8-3405-40ec-8e64-993f3e60e6e0.png`, session
`01a1b110-c27f-7ca2-8fca-9fda16ae1a72`. Master is retained in
`art/masters/fx/sea-mist.png`. Runtime bake: `sips -z 512 512`.

Prompt: Use case: stylized-concept. Asset type: production transparent 2D
atmospheric VFX texture for an original painted maritime mystery visual novel,
consumed as a separately animated foreground layer. Generate ONE isolated
horizontal elongated wind-torn plume of sea mist, centered within a square
canvas with generous fully transparent margins. Intricate soft natural
turbulent wisps and delicate layered curls, cool desaturated blue-teal and ivory
haze, low opacity translucent density, elegant cinematic painterly texture,
softly lit by distant moonlight. Wisps flow primarily left-to-right, richest
near lower middle, airy uneven silhouettes and transparent holes, never a flat
white blob. This will drift subtly over an existing rainy train station at
night; DO NOT depict that station or any background. True alpha transparency
outside and through thinner wisps. No solid background, checkerboard pattern,
frame, characters, objects, text, symbols, lightning, raindrops or interface.
Single mist cloud only; no atlas/grid. Preserve soft transparent edges for
compositing.

Master SHA-256: `808653b323ecdd0c6fb64b0726d5b62fbd56deae41c277bf76d57b0114f350ee`.
Runtime SHA-256: `030a26fc99ba9d0243be2bc904cd0710da52551a3c8a9f7c7a52e63847ec3d8b`.

`rain-streak.svg` is an original deterministic white tapered streak authored
in source. The SDK repeats its image across a single bounded retained mesh;
it is a real texture, not one Flutter widget or transport call per raindrop.
The saved assets, not image regeneration, are the reproducible inputs.

The pinned SVG baker rejects gradient fills (`url(#r)`), so the retained source uses a supported solid white tapered path; per-mesh opacity and linear texture sampling supply the runtime translucency.
