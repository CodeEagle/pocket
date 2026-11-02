import 'package:package_info_plus/package_info_plus.dart';
import 'package:pocket_services/pocket_services.dart';

/// Adapter for a real Flutter plugin. JS only sees its declared capability.
final class PackageInfoPlugin extends PocketPlugin {
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'flutter.package_info_plus',
    version: '8.3.0',
    description: 'Native application metadata via package_info_plus',
    capabilities: {
      'plugins.packageInfo': PocketPluginCapability(
        name: 'plugins.packageInfo',
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('plugins.packageInfo', (_) async {
      final info = await PackageInfo.fromPlatform();
      return {
        'provider': descriptor.id,
        'appName': info.appName,
        'packageName': info.packageName,
        'version': info.version,
        'buildNumber': info.buildNumber,
      };
    });
  }
}
