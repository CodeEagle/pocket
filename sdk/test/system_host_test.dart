import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_recordings.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';

void main() {
  test('controller starts with an empty runtime facts list', () {
    final controller = PocketSystemHostController();
    expect(controller.instances, isEmpty);
    controller.dispose();
  });

  test('copying app config preserves the trusted offload provider factory', () {
    final factory = () => PocketBoundedOffloadProvider(session: 17);
    final config = PocketAppConfig(
      appId: 'trusted.offload.consumer',
      offloadProviderFactory: factory,
    );

    final copy = config.withPlugins(const <PocketPluginFactory>[]);

    expect(identical(copy.offloadProviderFactory, factory), isTrue);
    expect(copy, config);
  });

  test(
    'recording preserves an offload factory without creating a provider',
    () {
      var factoryCalls = 0;
      final config = PocketAppConfig(
        appId: 'trusted.recorded.offload',
        offloadProviderFactory: () {
          factoryCalls++;
          return PocketBoundedOffloadProvider(session: 18);
        },
      );
      final recordings = PocketRecordingLibrary();

      expect(config.validate, returnsNormally);
      final recorded = recordings.attach(config);
      expect(recorded.validate, returnsNormally);
      expect(recorded.recordingFactory, isNotNull);
      expect(
        identical(
          recorded.offloadProviderFactory,
          config.offloadProviderFactory,
        ),
        isTrue,
      );
      expect(factoryCalls, 0);
    },
  );

  testWidgets('trusted application map keys must match their configs', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(appId: 'trusted.system.ui'),
          applications: <String, PocketAppConfig>{
            'untrusted.alias': PocketAppConfig(appId: 'trusted.child'),
          },
        ),
      ),
    );

    expect(tester.takeException(), isA<ArgumentError>());
  });

  testWidgets('the resident SystemUI consumes one instance slot', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(appId: 'trusted.system.ui'),
          applications: <String, PocketAppConfig>{},
          maxInstances: 0,
        ),
      ),
    );

    expect(tester.takeException(), isA<ArgumentError>());
  });

  testWidgets('SystemUI compositor handles are reserved for trusted children', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(
            appId: 'trusted.system.ui',
            compositorSurfaces: <String, int>{'untrusted.app': 2},
          ),
          applications: <String, PocketAppConfig>{},
        ),
      ),
    );

    expect(tester.takeException(), isA<ArgumentError>());
  });

  testWidgets('the legacy texture handle is not a System app handle', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(
            appId: 'trusted.system.ui',
            compositorSurfaces: <String, int>{'trusted.child': 1},
          ),
          applications: <String, PocketAppConfig>{
            'trusted.child': PocketAppConfig(appId: 'trusted.child'),
          },
        ),
      ),
    );

    expect(tester.takeException(), isA<FormatException>());
  });

  testWidgets('child configs cannot replace the trusted compositor registry', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(appId: 'trusted.system.ui'),
          applications: <String, PocketAppConfig>{
            'trusted.child': PocketAppConfig(
              appId: 'trusted.child',
              compositorSurfaces: <String, int>{'trusted.other': 2},
            ),
          },
        ),
      ),
    );

    expect(tester.takeException(), isA<ArgumentError>());
  });

  testWidgets('child configs cannot self-grant SystemUI compositor access', (
    tester,
  ) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: PocketAppConfig(appId: 'trusted.system.ui'),
          applications: <String, PocketAppConfig>{
            'trusted.child': PocketAppConfig(
              appId: 'trusted.child',
              additionalCapabilities: <String>{'ui.compositor-surfaces'},
            ),
          },
        ),
      ),
    );

    expect(tester.takeException(), isA<ArgumentError>());
  });
}
