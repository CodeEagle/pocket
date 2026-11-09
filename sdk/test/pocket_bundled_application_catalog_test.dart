import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;

final class _RootPolicyProbePlugin extends PocketPlugin {
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.root-policy-probe',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{},
  );

  @override
  void register(PocketPluginContext context) {}
}

final class _CountingAssetBundle extends AssetBundle {
  _CountingAssetBundle(this.contents);

  final String contents;
  int loadCount = 0;

  @override
  Future<ByteData> load(String key) async {
    loadCount += 1;
    return ByteData.sublistView(Uint8List.fromList(utf8.encode(contents)));
  }
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();

  Map<String, Object?> application({
    required String appId,
    required bool launchable,
    Map<String, Object?>? worker,
  }) => <String, Object?>{
    'appId': appId,
    'launchable': launchable,
    'assets': <String, Object?>{
      'bytecode': 'apps/$appId/app.qjbc',
      'pak': 'apps/$appId/app.pak',
      'metadata': 'apps/$appId/app.bytecode.json',
      'manifest': 'apps/$appId/guest-manifest.json',
    },
    if (worker != null) 'worker': worker,
  };

  Map<String, Object?> catalog(
    List<Map<String, Object?>> applications, {
    Map<String, int> fixedCompositorSurfaces = const <String, int>{},
  }) => <String, Object?>{
    'schemaVersion': 1,
    'applications': applications,
    'fixedCompositorSurfaces': fixedCompositorSurfaces,
  };

  const worker = <String, Object?>{
    'kind': 'quickjs-bytecode',
    'bytecode': <String, Object?>{'path': 'app.worker.qjbc'},
    'declaration': <String, Object?>{
      'nodes': <Object?>[
        <String, Object?>{'name': 'request', 'kind': 'http'},
      ],
    },
  };

  test(
    'uses the generated launch decision and stable catalog-order handles',
    () {
      final parsed = PocketBundledApplicationCatalog.fromJson(
        catalog(<Map<String, Object?>>[
          application(appId: 'example.first', launchable: true),
          application(appId: 'example.limited', launchable: false),
          application(appId: 'example.last', launchable: true),
        ]),
        assetPrefix: 'assets/',
        firstCompositorHandle: 4,
        lastCompositorHandle: 6,
        reservedAppIds: const <String>{'example.host'},
      );

      expect(parsed.entries, hasLength(3));
      expect(parsed.applications.keys, <String>[
        'example.first',
        'example.last',
      ]);
      expect(parsed.compositorSurfaces, <String, int>{
        'example.first': 4,
        'example.last': 6,
      });
      expect(
        parsed.applications['example.first']!.bytecodeAsset,
        'assets/apps/example.first/app.qjbc',
      );
      expect(parsed.applications['example.first']!.workerHttpOrigins, isEmpty);
    },
  );

  test('resolves worker paths and applies only explicit host grants', () {
    final parsed = PocketBundledApplicationCatalog.fromJson(
      catalog(<Map<String, Object?>>[
        application(appId: 'example.worker', launchable: true, worker: worker),
      ]),
      assetPrefix: 'bundle/assets',
      firstCompositorHandle: 5,
      lastCompositorHandle: 5,
    );
    final entry = parsed.launchableEntries.single;

    expect(entry.declaresHttpWorker, isTrue);
    expect(
      entry.workerBytecodeAsset,
      'bundle/assets/apps/example.worker/app.worker.qjbc',
    );
    expect(entry.config.workerHttpOrigins, isEmpty);

    final authorized = parsed.applicationsWithNativePolicies(
      nativePolicies: <String, PocketAppConfig>{
        'example.worker': PocketAppConfig(
          appId: 'example.worker',
          workerHttpOrigins: const <String>{'https://api.example'},
        ),
      },
    );
    expect(authorized['example.worker']!.workerHttpOrigins, <String>{
      'https://api.example',
    });
    expect(
      authorized['example.worker']!.metadataAsset,
      entry.config.metadataAsset,
      reason: 'the catalog remains the sole asset identity source',
    );
    expect(
      () => parsed.applicationsWithNativePolicies(
        nativePolicies: <String, PocketAppConfig>{
          'example.worker': PocketAppConfig(
            appId: 'example.worker',
            workerHttpOrigins: const <String>{'https://api.example'},
          ),
          'example.unknown': const PocketAppConfig(appId: 'example.unknown'),
        },
      ),
      throwsFormatException,
    );
  });

  test(
    'honors host supplied fixed surfaces without shifting allocated slots',
    () {
      final parsed = PocketBundledApplicationCatalog.fromJson(
        catalog(
          <Map<String, Object?>>[
            application(appId: 'example.fixed-low', launchable: true),
            application(appId: 'example.auto-one', launchable: true),
            application(appId: 'example.fixed-high', launchable: true),
            application(appId: 'example.auto-two', launchable: true),
          ],
          fixedCompositorSurfaces: const <String, int>{
            'example.fixed-low': 2,
            'example.fixed-high': 63,
          },
        ),
        assetPrefix: 'assets/',
        firstCompositorHandle: 4,
        lastCompositorHandle: 5,
      );

      expect(parsed.compositorSurfaces, <String, int>{
        'example.fixed-low': 2,
        'example.auto-one': 4,
        'example.fixed-high': 63,
        'example.auto-two': 5,
      });
    },
  );

  test(
    'rejects unsafe schema, paths, reserved IDs, duplicates, and handles',
    () {
      final base = application(appId: 'example.safe', launchable: true);
      final cases = <Object?>[
        <String, Object?>{'schemaVersion': 2, 'applications': <Object?>[]},
        <String, Object?>{'schemaVersion': 1, 'applications': <Object?>{}},
        catalog(
          <Map<String, Object?>>[
            application(appId: 'example.fixed', launchable: true),
          ],
          fixedCompositorSurfaces: const <String, int>{'example.fixed': 4},
        ),
        catalog(
          <Map<String, Object?>>[],
          fixedCompositorSurfaces: const <String, int>{'example.missing': 2},
        ),
        catalog(<Map<String, Object?>>[
          application(appId: 'example.safe', launchable: true)
            ..['launchable'] = 'yes',
        ]),
        catalog(<Map<String, Object?>>[
          application(appId: 'example.safe', launchable: true)
            ..['assets'] = <String, Object?>{
              'bytecode': '../outside.qjbc',
              'pak': 'app.pak',
              'metadata': 'app.bytecode.json',
              'manifest': 'guest-manifest.json',
            },
        ]),
        catalog(<Map<String, Object?>>[
          application(appId: 'example.safe', launchable: true)
            ..['assets'] = <String, Object?>{
              'bytecode': 'assets/already-prefixed.qjbc',
              'pak': 'app.pak',
              'metadata': 'app.bytecode.json',
              'manifest': 'guest-manifest.json',
            },
        ]),
        catalog(<Map<String, Object?>>[
          application(appId: 'example.safe', launchable: true),
          application(appId: 'example.safe', launchable: false),
        ]),
        catalog(<Map<String, Object?>>[
          application(appId: 'example.reserved', launchable: true),
        ]),
        catalog(<Map<String, Object?>>[
          application(
            appId: 'example.worker',
            launchable: true,
            worker: <String, Object?>{
              'bytecode': <String, Object?>{'path': '../outside.qjbc'},
            },
          ),
        ]),
      ];

      for (final value in cases) {
        expect(
          () => PocketBundledApplicationCatalog.fromJson(
            value,
            assetPrefix: 'assets/',
            firstCompositorHandle: 4,
            lastCompositorHandle: 4,
            reservedAppIds: const <String>{'example.reserved'},
          ),
          throwsFormatException,
        );
      }
      expect(
        () => PocketBundledApplicationCatalog.fromJson(
          catalog(<Map<String, Object?>>[
            base,
            application(appId: 'example.second', launchable: false),
          ]),
          assetPrefix: 'assets/',
          firstCompositorHandle: 4,
          lastCompositorHandle: 4,
        ),
        throwsFormatException,
      );
      expect(
        () => PocketBundledApplicationCatalog.fromJson(
          catalog(<Map<String, Object?>>[]),
          assetPrefix: 'assets/',
          firstCompositorHandle: 63,
          lastCompositorHandle: 64,
        ),
        throwsFormatException,
      );
    },
  );

  test('does not allow a host to grant HTTP to a workerless app', () {
    final parsed = PocketBundledApplicationCatalog.fromJson(
      catalog(<Map<String, Object?>>[
        application(appId: 'example.plain', launchable: true),
      ]),
      assetPrefix: 'assets/',
      firstCompositorHandle: 4,
      lastCompositorHandle: 4,
    );
    expect(
      () => parsed.applicationsWithNativePolicies(
        nativePolicies: <String, PocketAppConfig>{
          'example.plain': PocketAppConfig(
            appId: 'example.plain',
            workerHttpOrigins: const <String>{'https://api.example'},
          ),
        },
      ),
      throwsFormatException,
    );
  });

  testWidgets(
    'bundled shell composes host policy and reuses catalog bootstrap on rebuild',
    (tester) async {
      final bundled = catalog(<Map<String, Object?>>[
        application(appId: 'example.worker', launchable: true, worker: worker),
        application(appId: 'example.keyboard.child', launchable: true),
      ]);
      final bundle = _CountingAssetBundle(jsonEncode(bundled));
      final hostError = StateError('stop before guest session startup');
      final shell = () => PocketSystemHostApplication.fromBundledAssets(
        catalogAsset: 'catalog.json',
        assetPrefix: 'assets/',
        firstCompositorHandle: 4,
        lastCompositorHandle: 5,
        bundle: bundle,
        systemUI: const PocketAppConfig(
          appId: 'example.host',
          compositorSurfaces: <String, int>{'example.fixed': 2},
        ),
        nativePolicies: const <String, PocketAppConfig>{
          'example.worker': PocketAppConfig(
            appId: 'example.worker',
            workerHttpOrigins: <String>{'https://api.example'},
          ),
        },
        keyboardInputAppIdPrefixes: const <String>{'example.keyboard.'},
        initialHostConfigError: hostError,
      );
      final parsed = PocketBundledApplicationCatalog.fromJson(
        bundled,
        assetPrefix: 'assets/',
        firstCompositorHandle: 4,
        lastCompositorHandle: 5,
        reservedAppIds: const <String>{'example.host'},
      );
      final configuration = shell();

      expect(configuration.buildSystemUI(parsed).compositorSurfaces, {
        'example.fixed': 2,
        'example.worker': 4,
        'example.keyboard.child': 5,
      });
      final applications = configuration.buildApplications(parsed);
      expect(applications['example.worker']!.workerHttpOrigins, <String>{
        'https://api.example',
      });
      expect(
        applications['example.keyboard.child']!.keyboardInputEnabled,
        isTrue,
      );

      await tester.pumpWidget(configuration);
      await tester.pumpAndSettle();
      expect(bundle.loadCount, 1);

      await tester.pumpWidget(shell());
      await tester.pumpAndSettle();
      expect(
        bundle.loadCount,
        1,
        reason: 'the equal bundled catalog source must not reload bootstrap',
      );
    },
  );

  testWidgets(
    'system host selects a matching root native policy and keeps its system surface',
    (tester) async {
      final directory = Directory.systemTemp.createTempSync(
        'pocket-root-native-policy-',
      );
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (_) async => directory.path,
      );
      addTearDown(() async {
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          null,
        );
        if (directory.existsSync()) directory.deleteSync(recursive: true);
      });

      const rootSurfaces = <String, int>{'example.child': 42};
      PocketAppConfig package(
        String appId, {
        Map<String, int> surfaces = const {},
      }) => PocketAppConfig(
        appId: appId,
        bytecodeAsset: 'remote/$appId.qjbc',
        pakAsset: 'remote/$appId.pak',
        metadataAsset: 'remote/$appId.metadata.json',
        manifestAsset: 'remote/$appId.manifest.json',
        compositorSurfaces: surfaces,
        bootstrapMetadataJson: jsonEncode(<String, Object?>{
          'runtimeAbi': 'root-policy-test-abi',
          'bytecodeBytes': 1,
          'build': 1,
          'version': '1.0.0',
        }),
        bootstrapManifestJson: jsonEncode(<String, Object?>{
          'capabilities': <String, Object?>{'requires': <String>[]},
        }),
      );

      final fallbackFactory = (PocketViewController _) =>
          _RootPolicyProbePlugin();
      final lanternFactory = (PocketViewController _) =>
          _RootPolicyProbePlugin();
      const fallbackPolicy = PocketAppConfig(
        appId: 'example.generic-system-ui',
        allowedPermissions: <String>{'system.default'},
        additionalCapabilities: <String>{'policy.system-default'},
        memoryLimits: PocketMemoryLimits(maxPakBytes: 8 * 1024 * 1024),
      );
      final generic = fallbackPolicy.withPlugins(<PocketPluginFactory>[
        fallbackFactory,
      ]);
      final lanternPolicy = const PocketAppConfig(
        appId: 'example.lantern',
        allowedPermissions: <String>{'audio.play'},
        additionalCapabilities: <String>{'policy.lantern-audio-live2d'},
        memoryLimits: PocketMemoryLimits(maxPakBytes: 72 * 1024 * 1024),
      ).withPlugins(<PocketPluginFactory>[lanternFactory]);
      final localApplications = <String, PocketAppConfig>{
        lanternPolicy.appId: lanternPolicy,
      };
      final emptyCatalog = PocketBundledApplicationCatalog.empty;

      PocketHostConfig remoteHost(String rootId) => PocketHostConfig(
        source: Uri.parse('https://host.example/latest.json'),
        systemUI: package(rootId, surfaces: rootSurfaces),
        applications: <String, PocketAppConfig>{
          'example.child': package('example.child'),
        },
        hostVersion: '0.1.0',
        packageVersion: '0.1.0',
      );

      Widget shell(String rootId) => PocketSystemHostApplication(
        key: ValueKey<String>(rootId),
        loadBundledApplications: () async => emptyCatalog,
        buildSystemUI: (_) => generic.copyWith(
          compositorSurfaces: const <String, int>{'example.child': 7},
        ),
        buildApplications: (_) => localApplications,
        initialHostConfig: remoteHost(rootId),
        initialBundledApplications: emptyCatalog,
      );

      Future<PocketSystemHost> mount(String rootId) async {
        await tester.pumpWidget(shell(rootId));
        for (
          var attempt = 0;
          attempt < 3 && find.byType(PocketSystemHost).evaluate().isEmpty;
          attempt++
        ) {
          await tester.pump();
        }
        return tester.widget<PocketSystemHost>(find.byType(PocketSystemHost));
      }

      final matching = await mount('example.lantern');
      expect(matching.systemUI.appId, 'example.lantern');
      expect(matching.systemUI.bytecodeAsset, 'remote/example.lantern.qjbc');
      expect(matching.systemUI.memoryLimits.maxPakBytes, 72 * 1024 * 1024);
      expect(matching.systemUI.allowedPermissions, <String>{'audio.play'});
      expect(matching.systemUI.additionalCapabilities, <String>{
        'policy.lantern-audio-live2d',
      });
      expect(matching.systemUI.pluginFactories.single, same(lanternFactory));
      expect(matching.systemUI.compositorSurfaces, rootSurfaces);

      final rootGuest = tester.widget<PocketGuestSession>(
        find.byType(PocketGuestSession),
      );
      expect(rootGuest.config.compositorSurfaces, rootSurfaces);
      expect(
        rootGuest.config.additionalCapabilities,
        contains('ui.compositor-surfaces'),
      );
      expect(rootGuest.config.pluginFactories.first, same(lanternFactory));
      expect(rootGuest.config.pluginFactories, hasLength(4));

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      final fallback = await mount('example.unmapped-root');
      expect(fallback.systemUI.memoryLimits.maxPakBytes, 8 * 1024 * 1024);
      expect(fallback.systemUI.allowedPermissions, <String>{'system.default'});
      expect(fallback.systemUI.additionalCapabilities, <String>{
        'policy.system-default',
      });
      expect(fallback.systemUI.pluginFactories.single, same(fallbackFactory));
      expect(fallback.systemUI.compositorSurfaces, rootSurfaces);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
