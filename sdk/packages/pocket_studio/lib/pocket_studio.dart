/// Optional Pocket Studio provider: a stateless allowlisted route map from
/// `studio.*` capabilities onto the local editor service, plus the trusted
/// host's service lifecycle helper. `pocket_sdk` does not depend on it.
library;

export 'src/studio_config.dart';
export 'src/studio_paths.dart';
export 'src/studio_plugin.dart';
export 'src/studio_scrub.dart';
export 'src/studio_service.dart';
