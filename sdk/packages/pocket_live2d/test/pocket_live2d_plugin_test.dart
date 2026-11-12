import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_services/pocket_services.dart';

const _assets = <String, String>{
  'models/mao/Mao.moc3': 'assets/lantern/Mao.moc3',
};

void main() {
  late _MemoryAssetBundle bundle;
  late List<_FakeCoreModel> models;
  late PocketLive2dPlugin plugin;

  setUp(() {
    bundle = _MemoryAssetBundle(<String, Uint8List>{
      'assets/lantern/Mao.moc3': Uint8List.fromList(<int>[0x4d, 0x4f, 0x43]),
    });
    models = <_FakeCoreModel>[];
    plugin = PocketLive2dPlugin(
      assets: _assets,
      bundle: bundle,
      coreFactory: (bytes) {
        final model = _FakeCoreModel(Uint8List.fromList(bytes));
        models.add(model);
        return model;
      },
    );
  });

  tearDown(() async {
    await plugin.dispose();
  });

  test('registers only the three Live2D native request capabilities', () {
    plugin.descriptor.validateSchemas();
    final registry = PocketHostRegistry();
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: 'test.live2d',
      sessionId: 'live2d-session',
      registry: registry,
    );
    plugin.register(context);

    expect(context.registeredCapabilities, <String>{
      pocketLive2dLoadCapability,
      pocketLive2dUpdateCapability,
      pocketLive2dReleaseCapability,
    });
    expect(plugin.descriptor.capabilities, hasLength(3));
    context.dispose();
  });

  test(
    'loads only exact whitelist keys and returns Core parameter defaults',
    () async {
      final facts = await plugin.load(_loadRequest());
      expect(facts, <String, Object?>{
        'modelId': 'live2d-1',
        'drawableCount': 1,
        'mocVersion': 5,
        'nativeBytes': 2048,
        'parameterCount': 2,
        'parameterDefaults': <Map<String, Object?>>[
          <String, Object?>{'id': 'ParamEyeLOpen', 'value': 1.0},
          <String, Object?>{'id': 'ParamAngleX', 'value': 0.0},
        ],
        'canvas': <String, Object?>{
          'widthPixels': 100.0,
          'heightPixels': 160.0,
          'originXPixels': 50.0,
          'originYPixels': 80.0,
          'pixelsPerUnit': 100.0,
        },
        'textures': <String>['models/mao/Mao.2048/texture_00.png'],
      });
      expect(models.single.receivedBytes, <int>[0x4d, 0x4f, 0x43]);
      expect(bundle.requestedKeys, <String>['assets/lantern/Mao.moc3']);
      expect(plugin.activeModelCount, 1);
      expect(jsonEncode(facts), isNotEmpty);
    },
  );

  test(
    'keeps unnegotiated updates readable by legacy Guests as plain arrays',
    () async {
      final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      final result =
          await plugin.update(<String, dynamic>{
                'modelId': modelId,
                'parameters': <Map<String, Object>>[
                  <String, Object>{'id': 'ParamAngleX', 'value': 30},
                ],
                'partOpacities': <Map<String, Object>>[
                  <String, Object>{'id': 'PartHair', 'value': 0.6},
                ],
              })
              as Map<String, Object?>;

      expect(models.single.operations, <String>[
        'reset',
        'parameter:ParamAngleX=30.0',
        'part:PartHair=0.6',
        'update',
      ]);
      expect(models.single.topologyReads, <bool>[true]);
      expect(result['modelId'], modelId);
      final drawables = result['drawables']! as List<Map<String, Object?>>;
      expect(drawables.single['blendMode'], 10);
      expect(drawables.single['positionsXYPixels'], <double>[
        10,
        10,
        20,
        10,
        15,
        20,
      ]);
      expect(drawables.single['uvs'], <double>[0, 0, 1, 0, 0.5, 1]);
      expect(drawables.single['indices'], <int>[0, 1, 2]);
      expect(drawables.single['maskIndices'], <int>[0]);
      expect(drawables.single['positionsXYPixels'], isA<List<double>>());
      expect(drawables.single.containsKey('meshBytes'), isFalse);
      expect(jsonEncode(result), isNot(contains('ParamAngleX')));
    },
  );

  test(
    'explicit PMS1 negotiation preserves packed native mesh output',
    () async {
      final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      final result =
          await plugin.update(<String, dynamic>{
                'modelId': modelId,
                'parameters': const <Object?>[],
                'partOpacities': const <Object?>[],
                'meshFormat': 'pms1',
                'placement': <String, Object>{'dx': 10, 'dy': 20, 'scale': 1},
              })
              as Map<String, Object?>;
      final drawable =
          (result['drawables']! as List<Map<String, Object?>>).single;
      expect(drawable['positionsXYPixels'], isNull);
      expect(drawable['maskIndices'], isA<Uint8List>());
      final meshBytes = drawable['meshBytes']! as Uint8List;
      final meshData = ByteData.sublistView(meshBytes);
      expect(meshData.getUint32(0, Endian.little), pocketLive2dPms1Magic);
      expect(meshData.getUint32(4, Endian.little), 3);
      expect(meshData.getUint32(8, Endian.little), 3);
      expect(meshData.getFloat32(16, Endian.little), 20.0);
    },
  );

  test(
    'opt-in topology cache emits a complete first frame and sparse later frames',
    () async {
      final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      Map<String, dynamic> request() => <String, dynamic>{
        'modelId': modelId,
        'parameters': const <Object?>[],
        'partOpacities': const <Object?>[],
        'cacheStaticTopology': true,
        'meshFormat': 'pms1',
      };

      final first = await plugin.update(request()) as Map<String, Object?>;
      final firstDrawable =
          (first['drawables']! as List<Map<String, Object?>>).single;
      expect(first['topologyMode'], 'full');
      expect(firstDrawable['meshBytes'], isA<Uint8List>());
      expect(firstDrawable['maskIndices'], isA<Uint8List>());

      final next = await plugin.update(request()) as Map<String, Object?>;
      final nextDrawable =
          (next['drawables']! as List<Map<String, Object?>>).single;
      expect(next['topologyMode'], 'cached-v1');
      expect(nextDrawable.containsKey('maskIndices'), isFalse);
      expect(nextDrawable['meshBytes'], isA<Uint8List>());
      expect(nextDrawable['renderOrder'], 2);
      expect(nextDrawable['opacity'], 0.5);
      expect(models.single.topologyReads, <bool>[true, false]);

      await plugin.release(<String, dynamic>{'modelId': modelId});
      final reloaded =
          await plugin.load(_loadRequest()) as Map<String, Object?>;
      final newFrame =
          await plugin.update(<String, dynamic>{
                'modelId': reloaded['modelId'],
                'parameters': const <Object?>[],
                'partOpacities': const <Object?>[],
                'cacheStaticTopology': true,
                'meshFormat': 'pms1',
              })
              as Map<String, Object?>;
      expect(newFrame['topologyMode'], 'full');
      expect(models.last.topologyReads, <bool>[true]);
    },
  );

  test(
    'unnegotiated cached topology preserves the legacy array response shape',
    () async {
      final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      final request = <String, dynamic>{
        'modelId': modelId,
        'parameters': const <Object?>[],
        'partOpacities': const <Object?>[],
        'cacheStaticTopology': true,
      };
      final first = await plugin.update(request) as Map<String, Object?>;
      final firstDrawable =
          (first['drawables']! as List<Map<String, Object?>>).single;
      expect(first['topologyMode'], 'full');
      expect(firstDrawable['positionsXYPixels'], isA<List<double>>());
      expect(firstDrawable['uvs'], isA<List<double>>());
      expect(firstDrawable['indices'], isA<List<int>>());
      expect(firstDrawable['maskIndices'], isA<List<int>>());

      final next = await plugin.update(request) as Map<String, Object?>;
      final nextDrawable =
          (next['drawables']! as List<Map<String, Object?>>).single;
      expect(next['topologyMode'], 'cached-v1');
      expect(nextDrawable['positionsXYPixels'], isA<List<double>>());
      expect(nextDrawable.containsKey('uvs'), isFalse);
      expect(nextDrawable.containsKey('indices'), isFalse);
      expect(nextDrawable.containsKey('maskIndices'), isFalse);
      expect(nextDrawable.containsKey('meshBytes'), isFalse);
      expect(models.single.topologyReads, <bool>[true, false]);
    },
  );

  test('cached topology rejects a changed drawable layout', () async {
    final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
    final modelId = load['modelId']! as String;
    final request = <String, dynamic>{
      'modelId': modelId,
      'parameters': const <Object?>[],
      'partOpacities': const <Object?>[],
      'cacheStaticTopology': true,
      'meshFormat': 'pms1',
    };
    await plugin.update(request);
    models.single.changeTopologyOnSecondRead = true;
    await expectLater(
      plugin.update(request),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'live2d_topology_changed',
        ),
      ),
    );
  });

  test('legacy injected Core providers retain the full-frame API', () async {
    final legacyModels = <_LegacyFakeCoreModel>[];
    final legacyPlugin = PocketLive2dPlugin(
      assets: _assets,
      bundle: bundle,
      coreFactory: (bytes) {
        final model = _LegacyFakeCoreModel(Uint8List.fromList(bytes));
        legacyModels.add(model);
        return model;
      },
    );
    try {
      final load =
          await legacyPlugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      final baseRequest = <String, dynamic>{
        'modelId': modelId,
        'parameters': const <Object?>[],
        'partOpacities': const <Object?>[],
      };
      final frame =
          await legacyPlugin.update(baseRequest) as Map<String, Object?>;
      expect(
        ((frame['drawables']! as List<Map<String, Object?>>)
            .single)['meshBytes'],
        isNull,
      );
      expect(
        ((frame['drawables']! as List<Map<String, Object?>>)
            .single)['positionsXYPixels'],
        isA<List<double>>(),
      );

      final operationsBeforeOptIn = List<String>.of(
        legacyModels.single.inner.operations,
      );
      await expectLater(
        legacyPlugin.update(<String, dynamic>{
          ...baseRequest,
          'cacheStaticTopology': true,
        }),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'live2d_topology_cache_unsupported',
          ),
        ),
      );
      expect(legacyModels.single.inner.operations, operationsBeforeOptIn);
    } finally {
      await legacyPlugin.dispose();
    }
  });

  test('rejects unlisted paths before asset IO or Core allocation', () async {
    for (final request in <Map<String, dynamic>>[
      _loadRequest()..['mocAsset'] = '../outside.moc3',
      _loadRequest()..['mocAsset'] = 'file:///tmp/model.moc3',
      _loadRequest()..['textures'] = <String>['models/mao/../secret.png'],
      _loadRequest()
        ..['textures'] = <String>['https://example.invalid/texture.png'],
    ]) {
      await expectLater(
        () async => plugin.load(request),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'invalid_request',
          ),
        ),
      );
    }
    await expectLater(
      () async =>
          plugin.load(_loadRequest()..['mocAsset'] = 'models/mao/other.moc3'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'live2d_asset_denied',
        ),
      ),
    );
    expect(bundle.requestedKeys, isEmpty);
    expect(models, isEmpty);
    expect(
      () => PocketLive2dPlugin(
        assets: const <String, String>{'escape': '../private.moc3'},
        bundle: bundle,
        coreFactory: (_) => _FakeCoreModel(Uint8List(0)),
      ),
      throwsArgumentError,
    );
    expect(
      () => PocketLive2dPlugin(
        assets: const <String, String>{'texture.png': 'assets/texture.png'},
        bundle: bundle,
        coreFactory: (_) => _FakeCoreModel(Uint8List(0)),
      ),
      throwsArgumentError,
    );
  });

  test('release and plugin dispose free native handles exactly once', () async {
    final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
    final modelId = load['modelId']! as String;
    final released = await plugin.release(<String, dynamic>{
      'modelId': modelId,
    });
    expect(released, <String, Object?>{'modelId': modelId, 'released': true});
    expect(models.single.disposeCalls, 1);
    expect(plugin.activeModelCount, 0);

    await plugin.load(_loadRequest());
    final second = models.last;
    await plugin.dispose();
    await plugin.dispose();
    expect(second.disposeCalls, 1);
    expect(plugin.activeModelCount, 0);
  });

  test(
    'deactivate blocks Core requests and activate does not update hidden models',
    () async {
      final context = _context(plugin);
      final load = await plugin.load(_loadRequest()) as Map<String, Object?>;
      final modelId = load['modelId']! as String;
      final model = models.single;
      await plugin.deactivate(context);

      await expectLater(
        plugin.update(<String, dynamic>{
          'modelId': modelId,
          'parameters': <Object>[],
          'partOpacities': <Object>[],
        }),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'plugin_inactive',
          ),
        ),
      );
      expect(model.operations, isEmpty);
      await plugin.activate(context);
      expect(model.operations, isEmpty);
      await plugin.release(<String, dynamic>{'modelId': modelId});
      context.dispose();
    },
  );

  test(
    'dispose racing a pending asset read cannot allocate a stale Core model',
    () async {
      final gate = Completer<ByteData>();
      final delayedBundle = _DelayedAssetBundle(gate.future);
      final pendingModels = <_FakeCoreModel>[];
      final delayedPlugin = PocketLive2dPlugin(
        assets: _assets,
        bundle: delayedBundle,
        coreFactory: (bytes) {
          final model = _FakeCoreModel(Uint8List.fromList(bytes));
          pendingModels.add(model);
          return model;
        },
      );

      final load = delayedPlugin.load(_loadRequest());
      final dispose = delayedPlugin.dispose();
      gate.complete(
        ByteData.sublistView(Uint8List.fromList(<int>[0x4d, 0x4f, 0x43])),
      );
      await expectLater(
        load,
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'plugin_disposed',
          ),
        ),
      );
      await dispose;
      expect(pendingModels, isEmpty);
      expect(delayedPlugin.activeModelCount, 0);
    },
  );

  test(
    'bundled catalog allowlists only MOCs and prefixes only bundle paths',
    () async {
      final catalogBytes = Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, Object?>{
            'version': 1,
            'assets': <String, String>{
              'models/mao/Mao.moc3': 'native-models/mao/Mao.moc3',
            },
          }),
        ),
      );
      final catalogBundle = _MemoryAssetBundle(<String, Uint8List>{
        'catalog/live2d.json': catalogBytes,
        'assets/native-models/mao/Mao.moc3': Uint8List.fromList(<int>[
          0x4d,
          0x4f,
          0x43,
        ]),
      });
      final catalogPlugin = PocketLive2dPlugin.fromBundledCatalog(
        catalogAsset: 'catalog/live2d.json',
        assetPrefix: 'assets',
        bundle: catalogBundle,
        coreFactory: (bytes) => _FakeCoreModel(Uint8List.fromList(bytes)),
      );
      addTearDown(catalogPlugin.dispose);

      await catalogPlugin.load(_loadRequest());
      expect(catalogBundle.requestedKeys, <String>[
        'catalog/live2d.json',
        'assets/native-models/mao/Mao.moc3',
      ]);
    },
  );

  test('pending model slots count toward the four model limit', () async {
    final gate = Completer<ByteData>();
    final delayedBundle = _DelayedAssetBundle(gate.future);
    final pendingPlugin = PocketLive2dPlugin(
      assets: _assets,
      bundle: delayedBundle,
      coreFactory: (bytes) => _FakeCoreModel(Uint8List.fromList(bytes)),
    );
    addTearDown(pendingPlugin.dispose);

    final pending = <Future<Object?>>[
      for (var index = 0; index < pocketLive2dMaxModels; index++)
        pendingPlugin.load(_loadRequest()..['id'] = 'model-$index'),
    ];
    expect(
      () => pendingPlugin.load(_loadRequest()..['id'] = 'overflow'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'live2d_model_limit',
        ),
      ),
    );
    gate.complete(
      ByteData.sublistView(Uint8List.fromList(<int>[0x4d, 0x4f, 0x43])),
    );
    await Future.wait<Object?>(pending);
    expect(pendingPlugin.activeModelCount, pocketLive2dMaxModels);
  });

  test(
    'Core native storage facts enforce the aggregate 128 MiB budget',
    () async {
      final budgetModels = <_FakeCoreModel>[];
      final budgetPlugin = PocketLive2dPlugin(
        assets: _assets,
        bundle: bundle,
        coreFactory: (bytes) {
          final model = _FakeCoreModel(
            Uint8List.fromList(bytes),
            nativeBytes: 40 * 1024 * 1024,
          );
          budgetModels.add(model);
          return model;
        },
      );
      addTearDown(budgetPlugin.dispose);

      for (var index = 0; index < 3; index++) {
        await budgetPlugin.load(_loadRequest()..['id'] = 'budget-$index');
      }
      await expectLater(
        () async =>
            budgetPlugin.load(_loadRequest()..['id'] = 'budget-overflow'),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'live2d_resource_limit',
          ),
        ),
      );
      expect(budgetPlugin.activeModelCount, 3);
      expect(budgetModels, hasLength(4));
      expect(budgetModels.last.disposeCalls, 1);
    },
  );

  test(
    'zero topology Core drawables pass through without a fabricated texture',
    () async {
      final emptyPlugin = PocketLive2dPlugin(
        assets: _assets,
        bundle: bundle,
        coreFactory: (bytes) =>
            _FakeCoreModel(Uint8List.fromList(bytes), emptyDrawable: true),
      );
      addTearDown(emptyPlugin.dispose);
      final load =
          await emptyPlugin.load(_loadRequest()) as Map<String, Object?>;
      final result =
          await emptyPlugin.update(<String, dynamic>{
                'modelId': load['modelId'],
                'parameters': const <Object?>[],
                'partOpacities': const <Object?>[],
                'meshFormat': 'pms1',
              })
              as Map<String, Object?>;
      final drawable =
          (result['drawables']! as List<Map<String, Object?>>).single;
      expect(drawable['textureIndex'], -1);
      expect(drawable['meshBytes'], Uint8List(0));
    },
  );
}

Map<String, dynamic> _loadRequest() => <String, dynamic>{
  'id': 'mao',
  'mocAsset': 'models/mao/Mao.moc3',
  'textures': <String>['models/mao/Mao.2048/texture_00.png'],
};

PocketPluginContext _context(PocketLive2dPlugin plugin) => PocketPluginContext(
  plugin: plugin.descriptor,
  appId: 'test.live2d',
  sessionId: 'live2d-session',
  registry: PocketHostRegistry(),
);

final class _MemoryAssetBundle extends CachingAssetBundle {
  _MemoryAssetBundle(this.assets);

  final Map<String, Uint8List> assets;
  final List<String> requestedKeys = <String>[];

  @override
  Future<ByteData> load(String key) async {
    requestedKeys.add(key);
    final bytes = assets[key];
    if (bytes == null) throw StateError('missing asset $key');
    return ByteData.sublistView(bytes);
  }
}

final class _DelayedAssetBundle extends CachingAssetBundle {
  _DelayedAssetBundle(this.result);

  final Future<ByteData> result;

  @override
  Future<ByteData> load(String key) => result;
}

final class _FakeCoreModel
    implements PocketLive2dCoreModel, PocketLive2dCoreTopologyReader {
  _FakeCoreModel(
    this.receivedBytes, {
    this.nativeBytes = 2048,
    this.emptyDrawable = false,
  });

  final Uint8List receivedBytes;
  final List<String> operations = <String>[];
  final List<bool> topologyReads = <bool>[];
  int disposeCalls = 0;
  int frameRevision = 0;
  bool changeTopologyOnSecondRead = false;

  @override
  final int nativeBytes;

  final bool emptyDrawable;

  @override
  PocketLive2dCanvas get canvas => const PocketLive2dCanvas(
    widthPixels: 100,
    heightPixels: 160,
    originXPixels: 50,
    originYPixels: 80,
    pixelsPerUnit: 100,
  );

  @override
  int get drawableCount => 1;

  @override
  int get mocVersion => 5;

  @override
  List<PocketLive2dParameterDefault> get parameterDefaults =>
      const <PocketLive2dParameterDefault>[
        PocketLive2dParameterDefault(id: 'ParamEyeLOpen', value: 1),
        PocketLive2dParameterDefault(id: 'ParamAngleX', value: 0),
      ];

  @override
  int get parameterCount => 2;

  @override
  void resetToDefaults() => operations.add('reset');

  @override
  void setParameter(String id, double value) =>
      operations.add('parameter:$id=$value');

  @override
  void setPartOpacity(String id, double opacity) =>
      operations.add('part:$id=$opacity');

  @override
  void update() {
    operations.add('update');
    frameRevision++;
  }

  @override
  PocketLive2dDrawable drawableAt(int index) => drawableAtWithTopology(index);

  @override
  PocketLive2dDrawable drawableAtWithTopology(
    int index, {
    bool includeTopology = true,
  }) {
    topologyReads.add(includeTopology);
    return PocketLive2dDrawable(
      id: emptyDrawable ? 'ArtMeshEmpty' : 'ArtMesh01',
      textureIndex: emptyDrawable ? -1 : 0,
      drawOrder: 1,
      renderOrder: frameRevision,
      blendMode: 10,
      constantFlags: 0,
      dynamicFlags: 1,
      opacity: emptyDrawable ? 0 : (frameRevision > 1 ? 0.5 : 1),
      vertexCount: emptyDrawable ? 0 : 3,
      indexCount: emptyDrawable
          ? 0
          : (changeTopologyOnSecondRead && frameRevision > 1 ? 6 : 3),
      maskCount: emptyDrawable ? 0 : 1,
      positionsXYPixels: emptyDrawable
          ? const <double>[]
          : <double>[(9 + frameRevision).toDouble(), 10, 20, 10, 15, 20],
      uvs: emptyDrawable || !includeTopology
          ? const <double>[]
          : const <double>[0, 0, 1, 0, 0.5, 1],
      indices: emptyDrawable || !includeTopology
          ? const <int>[]
          : const <int>[0, 1, 2],
      maskIndices: emptyDrawable || !includeTopology
          ? const <int>[]
          : const <int>[0],
      multiplyColorRgba: const <double>[1, 1, 1, 1],
      screenColorRgba: const <double>[0, 0, 0, 1],
    );
  }

  @override
  void dispose() => disposeCalls++;
}

/// Simulates a third-party Core provider compiled against the original API.
final class _LegacyFakeCoreModel implements PocketLive2dCoreModel {
  _LegacyFakeCoreModel(Uint8List receivedBytes)
    : inner = _FakeCoreModel(receivedBytes);

  final _FakeCoreModel inner;

  @override
  PocketLive2dCanvas get canvas => inner.canvas;
  @override
  int get drawableCount => inner.drawableCount;
  @override
  int get mocVersion => inner.mocVersion;
  @override
  int get nativeBytes => inner.nativeBytes;
  @override
  List<PocketLive2dParameterDefault> get parameterDefaults =>
      inner.parameterDefaults;
  @override
  int get parameterCount => inner.parameterCount;
  @override
  void resetToDefaults() => inner.resetToDefaults();
  @override
  void setParameter(String id, double value) => inner.setParameter(id, value);
  @override
  void setPartOpacity(String id, double opacity) =>
      inner.setPartOpacity(id, opacity);
  @override
  void update() => inner.update();
  @override
  PocketLive2dDrawable drawableAt(int index) => inner.drawableAt(index);
  @override
  void dispose() => inner.dispose();
}
