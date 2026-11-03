import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_platform/pocket_platform.dart';
import 'package:pocket_services/pocket_services.dart';

/// This test is the source of truth for the data-only input consumed by
/// sdk/scripts/plugin_types.ts. It deliberately asks the real plugin manager
/// and host registry for descriptors instead of maintaining a second fixture.
void main() {
  test('exports the actual hardware/platform plugin contract', () async {
    final allowed = <String>{
      ...HardwareCapabilities.all,
      ...PocketPlatformCapabilities.experience,
    };
    final registry = PocketHostRegistry();
    final streams = PocketStreamBridge(send: (_, __) => true);
    final host = PocketHost(
      registry: registry,
      streams: streams,
      allowedCapabilities: allowed,
      send: (_, __) => true,
    );
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.plugin.contract',
      sessionId: 'plugin-contract-export',
    );
    // HardwarePlugin remains the production provider; its transport is only
    // replaced so disposal cannot attempt a real native method channel. No
    // provider activation is needed to export descriptor/registry contracts.
    manager.register(HardwarePlugin(platform: _NoopHardwarePlatform()));
    manager.register(PocketPlatformPlugin());

    try {
      final availability = manager.negotiate(
        required: const <String>[],
        optional: allowed,
      );
      expect(availability.satisfied, isTrue);

      final plugins = manager.descriptors
          .map((descriptor) => descriptor.toJson())
          .toList(growable: false);
      final hostJson = host.capabilitiesJson();
      final contract = <String, dynamic>{
        'protocolVersion': PocketPluginDescriptor.currentProtocolVersion,
        'appId': manager.appId,
        'runtimeDependency': <String, dynamic>{
          'package': '@pocket/ui/host',
          'version': '0.1.0',
        },
        'host': <String, dynamic>{'available': hostJson['available']},
        'plugins': plugins,
      };
      // Force the exact JSON boundary used by the Bun generator. This catches
      // accidental Dart-only values before a file is optionally exported.
      final jsonContract = jsonDecode(jsonEncode(contract));
      expect(jsonContract, isA<Map<String, dynamic>>());

      final pluginById = <String, Map<String, dynamic>>{
        for (final plugin in (jsonContract as Map)['plugins'] as List)
          '${(plugin as Map)['id']}': Map<String, dynamic>.from(plugin),
      };
      final hardware = pluginById[hardwarePluginId]!;
      final platform = pluginById[pocketPlatformPluginId]!;
      final hardwareNames = _capabilityNames(hardware);
      final platformNames = _capabilityNames(platform);
      final availableNames = {
        for (final capability
            in (jsonContract['host'] as Map)['available'] as List)
          '${(capability as Map)['name']}',
      };

      const newHardware = <String>{
        HardwareCapabilities.bluetoothRead,
        HardwareCapabilities.bluetoothWrite,
        HardwareCapabilities.bluetoothNotifications,
        HardwareCapabilities.sensorsWatch,
      };
      expect(hardwareNames, containsAll(newHardware));
      expect(availableNames, containsAll(newHardware));
      expect(platformNames, containsAll(PocketPlatformCapabilities.experience));
      expect(
        availableNames,
        containsAll(PocketPlatformCapabilities.experience),
      );
      expect(
        platformNames,
        isNot(containsAll(PocketPlatformCapabilities.links)),
      );
      expect(
        availableNames.intersection(PocketPlatformCapabilities.links),
        isEmpty,
      );

      for (final name in <String>{
        ...newHardware,
        ...PocketPlatformCapabilities.experience,
      }) {
        final owner = newHardware.contains(name) ? hardware : platform;
        final capability = (owner['capabilities'] as List)
            .cast<Map>()
            .singleWhere((item) => item['name'] == name);
        expect(capability['schema'], isA<Map>(), reason: name);
      }

      final outputPath = const String.fromEnvironment(
        'POCKET_PLUGIN_CONTRACT_OUT',
      );
      if (outputPath.isNotEmpty) {
        if (!outputPath.startsWith('/')) {
          fail('POCKET_PLUGIN_CONTRACT_OUT must be an absolute path');
        }
        File(outputPath).writeAsStringSync(
          const JsonEncoder.withIndent('  ').convert(jsonContract),
        );
        expect(jsonDecode(File(outputPath).readAsStringSync()), jsonContract);
      }
    } finally {
      await manager.dispose();
      host.dispose();
    }
  });
}

Set<String> _capabilityNames(Map<String, dynamic> plugin) => {
  for (final capability in plugin['capabilities'] as List)
    '${(capability as Map)['name']}',
};

final class _NoopHardwarePlatform implements HardwarePlatform {
  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async => <String, dynamic>{'ok': true};
}
