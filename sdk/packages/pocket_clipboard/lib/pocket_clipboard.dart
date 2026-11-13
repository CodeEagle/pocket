/// Optional text-only clipboard capability provider for PocketJS hosts.
///
/// The package is separate from `pocket_sdk`: a consumer depends on it,
/// registers [PocketClipboardPlugin] in `PocketAppConfig.pluginFactories`, and
/// grants `clipboard.read` / `clipboard.write` in `allowedPermissions`.
library;

export 'src/clipboard_plugin.dart';
