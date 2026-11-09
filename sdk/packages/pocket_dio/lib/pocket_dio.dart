/// Optional Dio-backed HTTP capability provider for PocketJS hosts.
/// HTTP and response decoding run in a lazily created IO Worker isolate.
///
/// The package is intentionally separate from `pocket_sdk`: applications opt
/// into network access by depending on this package, constructing
/// [PocketDioPlugin] with an explicit origin allowlist, and registering its
/// factory in [PocketAppConfig.pluginFactories].
library;

export 'src/dio_plugin.dart';
