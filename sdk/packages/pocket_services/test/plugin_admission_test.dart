import 'dart:async';
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

class _DevicePlugin extends PocketPlugin {
  _DevicePlugin({this.fail = false});
  final bool fail;
  int cleaned = 0;
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.device',
    version: '1',
    permissions: {'camera'},
    capabilities: {
      'device.camera': PocketPluginCapability(
        name: 'device.camera',
        kind: PocketCapabilityKind.request,
      ),
    },
  );
  @override
  void register(PocketPluginContext context) {
    context.registerRequest('device.camera', (_) => {'real': true});
  }

  @override
  void activate(PocketPluginContext context) {
    if (fail) throw StateError('native device failed');
  }

  @override
  void deactivate(PocketPluginContext context) {
    cleaned++;
  }
}

void main() {
  for (final scenario in ['deny', 'widen', 'provider-failure']) {
    test(
      'failed $scenario admission cannot leave native capability callable',
      () async {
        final decision = Completer<Set<String>>();
        final host = PocketHost(
          registry: PocketHostRegistry(),
          streams: PocketStreamBridge(send: (_, __) => true),
          allowedCapabilities: {'device.camera'},
          send: (_, __) => true,
        );
        final plugin = _DevicePlugin(fail: scenario == 'provider-failure');
        final manager = PocketPluginManager(
          host: host,
          appId: 'test',
          sessionId: '1',
          onPermissionRequest: (_) => decision.future,
        );
        manager.register(plugin);
        try {
          final availability = manager.negotiate(
            required: ['device.camera'],
            requestedPermissions: ['camera'],
          );
          final activation = manager.activate(availability);
          expect(
            host.isAllowed('device.camera'),
            isFalse,
            reason: 'pending decision is not a grant',
          );
          final rejected = expectLater(activation, throwsA(scenario == 'provider-failure' ? isA<StateError>() : isA<PocketCapabilityException>()));
          decision.complete(
            scenario == 'deny'
                ? {}
                : scenario == 'widen'
                ? {'camera', 'location'}
                : {'camera'},
          );
          await rejected;
          expect(host.isAllowed('device.camera'), isFalse);
          if (scenario == 'provider-failure') expect(plugin.cleaned, 1);
        } finally {
          await manager.dispose();
          host.dispose();
        }
      },
    );
  }
}
