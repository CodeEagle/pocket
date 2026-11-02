/**
 * Compatibility entry for older guest imports.
 * New pages import the public `@pocket/ui` package directly; implementations
 * live in ../../sdk/packages/pocket_ui and never depend on this app directory.
 */
export * from "@pocket/ui";
