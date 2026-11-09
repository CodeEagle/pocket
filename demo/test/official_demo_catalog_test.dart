import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_host/main.dart' as showcase;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Map<String, Object?> application({
    required String appId,
    required bool launchable,
    Map<String, Object?>? worker,
  }) => <String, Object?>{
    'appId': appId,
    'launchable': launchable,
    'assets': <String, Object?>{
      'bytecode': 'apps/official/$appId/app.qjbc',
      'pak': 'apps/official/$appId/app.pak',
      'metadata': 'apps/official/$appId/app.bytecode.json',
      'manifest': 'apps/official/$appId/guest-manifest.json',
    },
    if (worker != null) 'worker': worker,
  };

  Map<String, Object?> document(List<Map<String, Object?>> applications) =>
      <String, Object?>{'schemaVersion': 1, 'applications': applications};

  const httpWorker = <String, Object?>{
    'kind': 'quickjs-bytecode',
    'bytecode': <String, Object?>{'path': 'app.worker.qjbc'},
    'declaration': <String, Object?>{
      'nodes': <Object?>[
        <String, Object?>{'name': 'http', 'kind': 'http'},
      ],
    },
  };

  PocketBundledApplicationCatalog parse(Object? value) =>
      PocketBundledApplicationCatalog.fromJson(
        value,
        assetPrefix: 'assets/',
        firstCompositorHandle: 4,
        lastCompositorHandle: 62,
        reservedAppIds: const <String>{'demo.host', 'demo.profile'},
      );

  test('uses generated launch decisions and stable catalog-order handles', () {
    final catalog = parse(
      document(<Map<String, Object?>>[
        application(appId: 'sample.first', launchable: true),
        application(appId: 'sample.limited', launchable: false),
        application(appId: 'sample.last', launchable: true),
      ]),
    );

    expect(catalog.launchableEntries.map((entry) => entry.appId), [
      'sample.first',
      'sample.last',
    ]);
    expect(catalog.applications.keys, ['sample.first', 'sample.last']);
    expect(catalog.compositorSurfaces, {'sample.first': 4, 'sample.last': 6});
    expect(
      catalog.applications['sample.first']!.manifestAsset,
      'assets/apps/official/sample.first/guest-manifest.json',
    );
  });

  test(
    'worker bytecode is derived from metadata, and grants stay host-owned',
    () {
      final catalog = parse(
        document(<Map<String, Object?>>[
          application(
            appId: 'sample.worker',
            launchable: true,
            worker: httpWorker,
          ),
          application(appId: 'sample.plain', launchable: true),
        ]),
      );
      final worker = catalog.launchableEntries.first;

      expect(
        worker.workerBytecodeAsset,
        'assets/apps/official/sample.worker/app.worker.qjbc',
      );
      expect(worker.declaresHttpWorker, isTrue);
      expect(worker.config.workerHttpOrigins, isEmpty);

      final apps = catalog.applicationsWithNativePolicies(
        nativePolicies: <String, PocketAppConfig>{
          'sample.worker': PocketAppConfig(
            appId: 'sample.worker',
            workerHttpOrigins: const <String>{'https://example.test'},
          ),
        },
      );
      expect(apps['sample.worker']!.workerHttpOrigins, {
        'https://example.test',
      });
      expect(apps['sample.worker']!.bytecodeAsset, worker.config.bytecodeAsset);
      expect(apps['sample.plain']!.workerHttpOrigins, isEmpty);
    },
  );

  test(
    'rejects unsafe paths, untrusted IDs, duplicates, and malformed workers',
    () {
      final invalid = <Object?>[
        <String, Object?>{'schemaVersion': 2, 'applications': <Object?>[]},
        <String, Object?>{'schemaVersion': 1, 'applications': <Object?>{}},
        document(<Map<String, Object?>>[
          application(appId: 'sample.first', launchable: true)
            ..['launchable'] = 'passed',
        ]),
        document(<Map<String, Object?>>[
          application(appId: 'sample.first', launchable: true)
            ..['assets'] = <String, Object?>{
              'bytecode': '../outside.qjbc',
              'pak': 'app.pak',
              'metadata': 'app.bytecode.json',
              'manifest': 'guest-manifest.json',
            },
        ]),
        document(<Map<String, Object?>>[
          application(appId: 'sample.first', launchable: true),
          application(appId: 'sample.first', launchable: false),
        ]),
        document(<Map<String, Object?>>[
          application(appId: 'demo.host', launchable: true),
        ]),
        document(<Map<String, Object?>>[
          application(
            appId: 'sample.worker',
            launchable: true,
            worker: <String, Object?>{
              'bytecode': <String, Object?>{'path': '../outside.qjbc'},
            },
          ),
        ]),
      ];
      for (final value in invalid) {
        expect(() => parse(value), throwsFormatException);
      }
      expect(
        () => PocketBundledApplicationCatalog.fromJson(
          document(<Map<String, Object?>>[
            application(appId: 'sample.first', launchable: true),
            application(appId: 'sample.second', launchable: false),
          ]),
          assetPrefix: 'assets/',
          firstCompositorHandle: 4,
          lastCompositorHandle: 4,
        ),
        throwsFormatException,
      );
    },
  );

  test(
    'rejects native grants for unknown, nonlaunchable, or workerless apps',
    () {
      final catalog = parse(
        document(<Map<String, Object?>>[
          application(appId: 'sample.workerless', launchable: true),
          application(appId: 'sample.limited', launchable: false),
        ]),
      );
      PocketAppConfig httpPolicy(String appId) => PocketAppConfig(
        appId: appId,
        workerHttpOrigins: const <String>{'https://example.test'},
      );

      for (final appId in [
        'sample.workerless',
        'sample.limited',
        'sample.unknown',
      ]) {
        expect(
          () => catalog.applicationsWithNativePolicies(
            nativePolicies: <String, PocketAppConfig>{appId: httpPolicy(appId)},
          ),
          throwsFormatException,
        );
      }
    },
  );

  test('the staged bundle catalog and compiled assets are packaged', () async {
    final catalog = await PocketBundledApplicationCatalog.loadFromBundle(
      'assets/apps/official/catalog.json',
      assetPrefix: 'assets/',
      firstCompositorHandle: 4,
      lastCompositorHandle: 62,
      reservedAppIds: const <String>{'pocket.host.demo'},
    );

    expect(catalog.entries, isNotEmpty);
    expect(catalog.compositorSurfaces['pocket.demo.profile'], 2);
    expect(catalog.compositorSurfaces['pocket.demo.lobby'], 3);
    expect(catalog.compositorSurfaces['pocket.demo.lantern'], 63);
    for (final entry in catalog.launchableEntries) {
      final config = entry.config;
      expect(await rootBundle.load(config.bytecodeAsset), isNotNull);
      expect(await rootBundle.load(config.pakAsset), isNotNull);
      expect(await rootBundle.loadString(config.metadataAsset), isNotEmpty);
      final manifest = await rootBundle.loadString(config.manifestAsset);
      expect(manifest, contains('capabilities'));
      if (entry.workerBytecodeAsset case final workerAsset?) {
        expect(await rootBundle.load(workerAsset), isNotNull);
      }
    }
    final httpWorker = catalog.launchableEntries.singleWhere(
      (entry) => entry.declaresHttpWorker,
    );
    expect(httpWorker.config.workerHttpOrigins, isEmpty);
    final authorized = catalog.applicationsWithNativePolicies(
      nativePolicies: showcase.showcaseNativePolicies,
    );
    expect(authorized[httpWorker.appId]!.workerHttpOrigins, const <String>{
      'https://example.com',
    });
    for (final entry in catalog.launchableEntries.where(
      (entry) => !entry.declaresHttpWorker,
    )) {
      expect(authorized[entry.appId]!.workerHttpOrigins, isEmpty);
    }
  });
}
