/** Public PocketJS guest UI package. The package owns reusable composition;
 * applications own pages, state, routing and host capability policy. */
export * from "./ui.tsx";
export * from "./mobile.tsx";
export * from "./legacy.ts";
export * from "./responsive.ts";
export * from "./display.ts";
export * from "./graphics.ts";
export * from "./flutter-widgets.tsx";

// Preload compositor composition with the public UI entry so the pinned
// compiler collects its class literals before bundling subpath imports.
export * from "./system-surfaces.tsx";
