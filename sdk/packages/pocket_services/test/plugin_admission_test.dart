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

class _MultiCapabilityPlugin extends PocketPlugin {
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.multi',
    version: '1',
    capabilities: {
      'test.weather': PocketPluginCapability(
        name: 'test.weather',
        kind: PocketCapabilityKind.request,
        permissions: {'hardware.network'},
      ),
      'test.camera': PocketPluginCapability(
        name: 'test.camera',
        kind: PocketCapabilityKind.request,
        permissions: {'hardware.camera'},
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('test.weather', (_) => {'weather': 'sunny'});
    context.registerRequest('test.camera', (_) => {'camera': 'snapped'});
  }
}

class _DynamicPermissionsPlugin extends PocketPlugin {
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'flutter.hardware',
    version: '1',
    optionalPermissions: {'hardware.microphone'},
    capabilities: {
      'hardware.permissions.request': PocketPluginCapability(
        name: 'hardware.permissions.request',
        kind: PocketCapabilityKind.request,
        permissions: <String>{},
        optionalPermissions: {'hardware.microphone'},
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(
      'hardware.permissions.request',
      (_) => {'ok': true},
    );
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

  test(
    'per-method permission negotiation admits declared optional methods and revokes undeclared ones',
    () async {
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: {'test.weather', 'test.camera'},
        send: (_, __) => true,
      );
      final plugin = _MultiCapabilityPlugin();
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.app',
        sessionId: 'session-multi',
        allowedPermissions: {'hardware.network', 'hardware.camera'},
      );
      manager.register(plugin);
      try {
        final availability = manager.negotiate(
          required: const <String>[],
          optional: const <String>['test.weather', 'test.camera'],
          requestedPermissions: const <String>['hardware.network'],
        );
        expect(
          availability.granted,
          containsAll(<String>['test.weather', 'test.camera']),
        );

        final activated = await manager.activate(availability);
        expect(activated.granted, contains('test.weather'));
        expect(activated.granted, isNot(contains('test.camera')));
        expect(activated.unavailableOptional, contains('test.camera'));

        expect(host.guestAvailability?.granted, contains('test.weather'));
        expect(host.guestAvailability?.granted, isNot(contains('test.camera')));
        expect(
          host.guestAvailability?.unavailableOptional,
          contains('test.camera'),
        );

        expect(host.isAllowed('test.weather'), isTrue);
        expect(host.isAllowed('test.camera'), isFalse);

        final result = await manager.invoke('test.weather');
        expect(result, {'weather': 'sunny'});
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );

  test(
    'manager.invoke throws capability_denied when capability was not granted or not in host.isAllowed',
    () async {
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: {'test.weather', 'test.camera'},
        send: (_, __) => true,
      );
      final plugin = _MultiCapabilityPlugin();
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.app',
        sessionId: 'session-multi-deny',
        allowedPermissions: {'hardware.network', 'hardware.camera'},
      );
      manager.register(plugin);
      try {
        final availability = manager.negotiate(
          required: const <String>[],
          optional: const <String>['test.weather', 'test.camera'],
          requestedPermissions: const <String>['hardware.network'],
        );
        await manager.activate(availability);

        // Host allowedPermissions contains 'hardware.camera', but 'test.camera' was not granted
        await expectLater(
          manager.invoke('test.camera'),
          throwsA(
            isA<PocketCapabilityException>().having(
              (e) => e.code,
              'code',
              'capability_denied',
            ),
          ),
        );
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );

  test(
    'dynamic declarable permissions via optionalPermissions pass negotiate and do not force requirement',
    () async {
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: {'hardware.permissions.request'},
        send: (_, __) => true,
      );
      final plugin = _DynamicPermissionsPlugin();
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.app',
        sessionId: 'session-dynamic',
        allowedPermissions: {'hardware.microphone'},
      );
      manager.register(plugin);
      try {
        // 1. Guest declares hardware.microphone; negotiate succeeds without throwing permission_not_declared
        final availabilityWithMic = manager.negotiate(
          required: const <String>['hardware.permissions.request'],
          requestedPermissions: const <String>['hardware.microphone'],
        );
        expect(
          availabilityWithMic.granted,
          contains('hardware.permissions.request'),
        );
        final activatedWithMic = await manager.activate(availabilityWithMic);
        expect(
          activatedWithMic.granted,
          contains('hardware.permissions.request'),
        );
        await manager.deactivate();

        // 2. Guest does NOT declare hardware.microphone; activate still succeeds because optionalPermissions is not required
        final availabilityWithoutMic = manager.negotiate(
          required: const <String>['hardware.permissions.request'],
          requestedPermissions: const <String>[],
        );
        expect(
          availabilityWithoutMic.granted,
          contains('hardware.permissions.request'),
        );
        final activatedWithoutMic =
            await manager.activate(availabilityWithoutMic);
        expect(
          activatedWithoutMic.granted,
          contains('hardware.permissions.request'),
        );
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );
}
