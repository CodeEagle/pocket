# Dynamic image resources for saved thumbnails

## Retained behavior and gap

The retained parent project was inspected outside its excluded `pocket_host/` directory. `lib/core/real_hardware_bridge.dart:190-255` captures camera photos into the app's photo directory and lists or deletes those files. `lib/core/pocketjs_bundle_runner.dart:1458-1485` updates the camera page with the saved filename and path. That path handles camera photos, not pixels from the running guest. `test/pocket_38_components_screenshot_test.dart:43-60,109-113` captures the whole test app through `RenderRepaintBoundary`; it is a screenshot regression helper, not a production guest image resource.

The pinned compiler already supplies the pieces to draw a bounded image without changing the Flutter asset loader or adding a renderer. `compiler/framework/src/host.ts:67-70,181-186` defines `uploadImgEntry`, `setImage`, and `freeTexture`. `compiler/framework/src/primitives.ts:51-60,119-131` gives an `Image` a `ref`/`nodeRef`; the callback receives a `NodeMirror` with its native node id. `compiler/framework/src/resource.ts:11-41` already binds an uploaded handle to that node through `setImage`, but deliberately leaves texture ownership to the caller. `compiler/framework/src/native-tree.ts:624-631` confirms `src` remains a static registered string key. The component reuses `ResourceImage`'s borrowed-handle binding and adds only upload ownership plus the crop/contain sizing required by padded thumbnail textures.

The separate Flutter `PocketView._loadImage` path in `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:4234-4284` loads package files or `rootBundle` assets. A returned app-private path therefore cannot be shown by that loader. The adaptation uses the pinned native texture API and gives the JS component sole ownership of its uploaded texture handle.

## JS API and ownership

`@pocket/ui/images` exports `createPocketImagesClient(host)` and `PocketStoredImage`.

- `capture({maxWidth?, maxHeight?, maxPixels?})` requests a persisted image reference. The client bounds requests at 256×256 and 65,536 pixels; callers can request smaller captures, such as the save UI's 192×108 / 20,736-pixel cap. Capture does not happen implicitly during render.
- `read(id)` returns `{id, width, height, textureWidth, textureHeight, img}`. `img` is a raw `Uint8Array` IMG entry with an 8-byte little-endian header (PSM_8888, linear-filter flag) and straight RGBA pixels. Source pixels are top-left aligned with zero transparent padding in a power-of-two envelope, up to 256×256 (262,152 bytes including the header).
- `list()` returns metadata only. `remove(id)` returns whether the host removed the reference.
- IDs are validated as lowercase 64-character hex digests. The client rejects malformed dimensions, envelope sizes, IMG headers, and string/base64 payloads before native upload.
- `PocketStoredImage` reads and uploads one image for its current `imageId`. It contains the source aspect ratio in the requested layout box and clips padded pixels. The existing `ResourceImage` boundary creates an image node only for a ready resource and removes it when the ID changes. On ID change or unmount the component frees its owned handle; the pinned core generation-tags freed handles, so stale bindings draw nothing while the removed subtree is swept (`sdk/.cache/pocketjs/engine/core/src/lib.rs:1354-1365`). The component retains only dimensions after upload, not a second JS pixel buffer. There is no process-wide image cache or extra image state machine. Late reads are ignored before they allocate a texture.

The binary host bridge already carries nested `Uint8Array` values (`sdk/packages/pocket_ui/src/host.ts:15-17`; `sdk/packages/pocket_flutter/lib/src/pocket_binary_codec.dart:20-26,90-92`). Pixel bytes stay out of JSON save records; only the opaque image reference and source dimensions belong there. The existing `loadImgFile` API is a tethered service-directory loader with a 128 KiB limit, so it is not used for app-private images.

## Validation status

Current multi-target preview and same-resource resize evidence is recorded in [slot thumbnails](VISUAL_NOVEL_SLOT_THUMBNAILS.md); the earlier 44-case JS suite remains previous-round client evidence.
