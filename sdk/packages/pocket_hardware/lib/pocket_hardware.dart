/// Compiled-in hardware capability provider for PocketJS hosts.
///
/// The package contains the Dart capability adapter and the compiled iOS and
/// Android providers. A guest update can request these capabilities, but it
/// cannot add native code or choose an arbitrary platform channel.
library;

export 'src/hardware_plugin.dart';
