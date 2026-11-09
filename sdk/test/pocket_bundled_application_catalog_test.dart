import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

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
}
