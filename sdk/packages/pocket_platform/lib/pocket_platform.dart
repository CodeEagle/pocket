/// Compiled-in platform experience provider for trusted PocketJS hosts.
///
/// [PocketPlatformPlugin] exposes foreground system UI and haptics. URL
/// ingress is a separate [PocketDeepLinkPlugin] with background-safe stream
/// lifecycle and is disabled unless the trusted consumer supplies both the
/// provider configuration and the host's static scheme metadata.
library;

export 'src/platform_plugin.dart';
