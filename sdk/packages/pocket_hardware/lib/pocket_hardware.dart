/// Compiled-in hardware capability provider for PocketJS hosts.
///
/// This compatibility package selects the independent capability packages and
/// adapts legacy permission calls to permission_handler. A guest update can request these capabilities, but it
/// cannot add native code or choose an arbitrary platform channel.
library;

export 'src/hardware_plugin.dart';
