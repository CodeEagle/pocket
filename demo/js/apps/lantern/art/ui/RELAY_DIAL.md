# Relay dial image

Generated with the built-in GPT Image tool on 2026-11-07. The full-resolution
original is `../masters/ui/relay-dial.png` (SHA-256
`a72b3b331a6e6ca6c145cb4484f22ef063bfa5b03fa1bfc82f30c2b9ba0ce612`).
The runtime copy is `relay-dial.png` (SHA-256
`a43ace3003c8dd7768aba183b31edb1736430f0c9c7bd413bbf500fdf181b3ad`),
baked with the existing `prepare_textures.ts` / macOS `sips -z 512 512` pipeline.
Both retain transparency. The image contains no baked option labels; canonical
localized choice text and the existing engine own those labels and selections.

## Full generation prompt

Create one production-ready square 2D visual-novel puzzle prop illustration: a weathered antique nautical signal selector, viewed perfectly straight on, centered with full object inside frame, in the refined hand-painted anime background style of a mysterious foggy coastal railway station. A round deep navy enamel and aged warm brass instrument mounted on a dark teal square plate, fine engraved radial tick marks, subtle salt corrosion, tiny restrained cyan status light, beautifully modeled tactile metal with warm amber rim light and cool moonlit shadow. Three large circular recessed touch pads arranged horizontally across the lower middle of the dial at image coordinates approximately (0.23,0.60), (0.50,0.60), (0.77,0.60), each diameter 0.20 of image width. Each pad must have an EMPTY dark navy center for runtime labels, with a clear raised brass ring. A small central compass rose at (0.5,0.30), and a narrow EMPTY nameplate near bottom. The overall plate occupies x0.05..0.95,y0.05..0.95. Art only; absolutely NO letters, NO numbers, NO words, NO UI screenshots, NO hands or people. Crisp large shapes and rich elegant craft, readable at 512px. Isolated on a transparent background, preserving translucent edge antialiasing, no cast shadow outside object.

## Integration

`novel.assets.json.choiceSurfaces` maps the three existing dial choices to this
same image and normalized touch regions. No extra story state, instructions,
interpreter or timer is introduced. The investigation hub uses the same optional
spatial renderer and existing image skin. Small targets or overflowing localized
captions use the ordinary scrollable choices, keeping every legal option.
