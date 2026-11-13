import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_live2d_ffi.dart';
import 'pocket_live2d_types.dart';

const String pocketLive2dPluginId = 'dart.live2d';
const String pocketLive2dLoadCapability = 'media.live2d.model.load';
const String pocketLive2dUpdateCapability = 'media.live2d.model.update';
const String pocketLive2dReleaseCapability = 'media.live2d.model.release';

const int pocketLive2dMaxModels = 4;
const int pocketLive2dMaxMocBytes = 32 * 1024 * 1024;
const int pocketLive2dMaxNativeBytes = 128 * 1024 * 1024;
const int pocketLive2dMaxTextures = 16;

const int _maxIdentifierLength = 64;
const String _identifierPattern = r'^[A-Za-z0-9][A-Za-z0-9._-]*$';
const String _assetPattern = r'^[A-Za-z0-9._/-]{1,256}$';

const PocketPluginSchema _identifier = PocketPluginSchema.string();
const PocketPluginSchema _number = PocketPluginSchema.number();
const PocketPluginSchema _integer = PocketPluginSchema.integer();

const PocketPluginSchema _parameterValue = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'id': _identifier, 'value': _number},
  required: <String>{'id', 'value'},
);

const PocketPluginSchema _parameterDefault = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'id': _identifier, 'value': _number},
  required: <String>{'id', 'value'},
);

const PocketPluginSchema _parameterMetadata = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'id': _identifier,
    'minimum': _number,
    'maximum': _number,
    'defaultValue': _number,
  },
  required: <String>{'id', 'minimum', 'maximum', 'defaultValue'},
);
const PocketPluginSchema _partMetadata = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'id': _identifier,
    'defaultOpacity': _number,
  },
  required: <String>{'id', 'defaultOpacity'},
);

const PocketPluginSchema _canvas = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'widthPixels': _number,
    'heightPixels': _number,
    'originXPixels': _number,
    'originYPixels': _number,
    'pixelsPerUnit': _number,
  },
  required: <String>{
    'widthPixels',
    'heightPixels',
    'originXPixels',
    'originYPixels',
    'pixelsPerUnit',
  },
);

const PocketPluginSchema _drawable = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'id': _identifier,
    'textureIndex': _integer,
    'drawOrder': _integer,
    'renderOrder': _integer,
    'blendMode': _integer,
    'constantFlags': _integer,
    'dynamicFlags': _integer,
    'opacity': _number,
    // Exactly one mesh representation is present: negotiated PMS1 bytes or
    // the compatible positions/UV/index arrays.
    'meshBytes': const PocketPluginSchema.unknown(),
    'positionsXYPixels': const PocketPluginSchema.unknown(),
    'uvs': const PocketPluginSchema.unknown(),
    'indices': const PocketPluginSchema.unknown(),
    'maskIndices': const PocketPluginSchema.unknown(),
    'multiplyColorRgba': const PocketPluginSchema.unknown(),
    'screenColorRgba': const PocketPluginSchema.unknown(),
  },
  required: <String>{
    'id',
    'textureIndex',
    'drawOrder',
    'renderOrder',
    'blendMode',
    'constantFlags',
    'dynamicFlags',
    'opacity',
    'multiplyColorRgba',
    'screenColorRgba',
  },
);

const PocketPluginSchema _loadParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'id': _identifier,
    'mocAsset': PocketPluginSchema.string(),
    'textures': PocketPluginSchema.array(PocketPluginSchema.string()),
  },
  required: <String>{'id', 'mocAsset', 'textures'},
);

const PocketPluginSchema _loadResult = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'modelId': _identifier,
    'drawableCount': _integer,
    'mocVersion': _integer,
    'nativeBytes': _integer,
    'parameterCount': _integer,
    'parameterDefaults': PocketPluginSchema.array(_parameterDefault),
    'parameterMetadata': PocketPluginSchema.array(_parameterMetadata),
    'parts': PocketPluginSchema.array(_partMetadata),
    'canvas': _canvas,
    'textures': PocketPluginSchema.array(PocketPluginSchema.string()),
  },
  required: <String>{
    'modelId',
    'drawableCount',
    'mocVersion',
    'nativeBytes',
    'parameterCount',
    'parameterDefaults',
    'canvas',
    'textures',
  },
);

const PocketPluginSchema _placement = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'dx': _number,
    'dy': _number,
    'scale': _number,
    'opacity': _number,
  },
  required: <String>{'dx', 'dy', 'scale'},
);

const PocketPluginSchema _updateParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'modelId': _identifier,
    'parameters': PocketPluginSchema.array(_parameterValue),
    'partOpacities': PocketPluginSchema.array(_parameterValue),
    'placement': _placement,
    'cacheStaticTopology': PocketPluginSchema.boolean(),
    'meshFormat': PocketPluginSchema.enumValue(<Object?>['pms1']),
  },
  required: <String>{'modelId', 'parameters', 'partOpacities'},
);

const PocketPluginSchema _updateResult = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'modelId': _identifier,
    'drawables': PocketPluginSchema.array(_drawable),
    'topologyMode': PocketPluginSchema.enumValue(<Object?>[
      'full',
      'cached-v1',
    ]),
  },
  required: <String>{'modelId', 'drawables'},
);

const PocketPluginSchema _releaseParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'modelId': _identifier},
  required: <String>{'modelId'},
);

const PocketPluginSchema _releaseResult = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'modelId': _identifier,
    'released': PocketPluginSchema.boolean(),
  },
  required: <String>{'modelId', 'released'},
);

const PocketPluginCapabilitySchema _loadSchema = PocketPluginCapabilitySchema(
  parameters: _loadParameters,
  result: _loadResult,
);
const PocketPluginCapabilitySchema _updateSchema = PocketPluginCapabilitySchema(
  parameters: _updateParameters,
  result: _updateResult,
);
const PocketPluginCapabilitySchema _releaseSchema =
    PocketPluginCapabilitySchema(
      parameters: _releaseParameters,
      result: _releaseResult,
    );

/// Thin bridge from PocketJS requests to the official Cubism Core C ABI.
///
/// Asset keys are exact request allowlist entries. Their mapped values are
/// Flutter asset bundle paths, so guest input never becomes a filesystem path.
final class PocketLive2dPlugin extends PocketPlugin {
  PocketLive2dPlugin({
    required Map<String, String> assets,
    AssetBundle? bundle,
    PocketLive2dCoreFactory? coreFactory,
  }) : this._(
         assets: _validateAssets(assets),
         bundle: bundle ?? rootBundle,
         coreFactory: coreFactory ?? PocketLive2dFfiCore.createModel,
       );

  /// Creates a provider whose exact asset allowlist comes from a trusted
  /// buildGuest-generated version 1 catalog bundled with the host app.
  ///
  /// Catalog keys are the exact request keys that JavaScript sends. Catalog
  /// values are Flutter asset bundle paths relative to [assetPrefix]. The
  /// catalog is loaded once, on the first model load; guests cannot supply or
  /// expand it.
  PocketLive2dPlugin.fromBundledCatalog({
    required String catalogAsset,
    String assetPrefix = '',
    AssetBundle? bundle,
    PocketLive2dCoreFactory? coreFactory,
  }) : this._(
         catalogAsset: _validateAssetReference(catalogAsset, 'catalogAsset'),
         assetPrefix: _validateAssetPrefix(assetPrefix),
         bundle: bundle ?? rootBundle,
         coreFactory: coreFactory ?? PocketLive2dFfiCore.createModel,
       );

  PocketLive2dPlugin._({
    Map<String, String>? assets,
    String? catalogAsset,
    this.assetPrefix = '',
    required AssetBundle bundle,
    required PocketLive2dCoreFactory coreFactory,
  }) : _assets = assets,
       _bundle = bundle,
       _coreFactory = coreFactory,
       _catalogAsset = catalogAsset;

  final Map<String, String>? _assets;
  final String? _catalogAsset;
  final String assetPrefix;
  final AssetBundle _bundle;
  final PocketLive2dCoreFactory _coreFactory;
  Future<Map<String, String>>? _catalogFuture;
  final Map<String, _Live2dModelSlot> _models = <String, _Live2dModelSlot>{};
  final Map<String, Future<void>> _modelTails = <String, Future<void>>{};
  final Set<Future<Object?>> _pendingLoads = <Future<Object?>>{};
  bool _active = true;
  bool _disposed = false;
  int _pendingModelLoads = 0;
  int _nextModelId = 0;

  int get activeModelCount => _models.length;
  bool get isActive => _active && !_disposed;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketLive2dPluginId,
    version: '0.1.0',
    description: 'Whitelisted Cubism Core model deformation and mesh facts',
    limits: PocketPluginLimits(maxConcurrentRequests: pocketLive2dMaxModels),
    capabilities: <String, PocketPluginCapability>{
      pocketLive2dLoadCapability: PocketPluginCapability(
        name: pocketLive2dLoadCapability,
        kind: PocketCapabilityKind.request,
        description: 'Load a whitelisted MOC3 asset into Cubism Core',
        schema: _loadSchema,
      ),
      pocketLive2dUpdateCapability: PocketPluginCapability(
        name: pocketLive2dUpdateCapability,
        kind: PocketCapabilityKind.request,
        description: 'Apply parameter values and return deformed drawables',
        schema: _updateSchema,
      ),
      pocketLive2dReleaseCapability: PocketPluginCapability(
        name: pocketLive2dReleaseCapability,
        kind: PocketCapabilityKind.request,
        description: 'Release one native Cubism Core model handle',
        schema: _releaseSchema,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(pocketLive2dLoadCapability, load);
    context.registerRequest(pocketLive2dUpdateCapability, update);
    context.registerRequest(pocketLive2dReleaseCapability, release);
  }

  Future<Object?> load(Map<String, dynamic> params) {
    _ensureActive();
    final id = _parseIdentifier(params['id'], 'id');
    final mocAsset = _validateAssetReference(params['mocAsset'], 'mocAsset');
    final textures = _parseTextures(params['textures']);
    if (_models.length + _pendingModelLoads >= pocketLive2dMaxModels) {
      throw const PocketCapabilityException(
        'live2d_model_limit',
        'Live2D model limit reached',
      );
    }
    if (textures.isEmpty) {
      throw const PocketCapabilityException(
        'invalid_request',
        'textures must contain at least one whitelisted asset key',
      );
    }

    _pendingModelLoads++;
    final pending = _loadModel(id, mocAsset, textures);
    _pendingLoads.add(pending);
    return pending.whenComplete(() {
      _pendingLoads.remove(pending);
    });
  }

  Future<Object?> _loadModel(
    String requestedId,
    String mocAsset,
    List<String> textures,
  ) async {
    var reservationActive = true;
    try {
      _ensureActive();
      final assets = await _resolveAssets();
      _ensureActive();
      _requireWhitelistedAsset(mocAsset, 'mocAsset', assets);
      final ByteData data;
      try {
        data = await _bundle.load(assets[mocAsset]!);
      } catch (error) {
        throw PocketCapabilityException(
          'live2d_asset_load_failed',
          'Could not load whitelisted MOC3 asset "$mocAsset": $error',
        );
      }
      _ensureActive();
      if (data.lengthInBytes > pocketLive2dMaxMocBytes) {
        throw const PocketCapabilityException(
          'live2d_resource_limit',
          'MOC3 asset exceeds the 32 MiB model input limit',
        );
      }
      final bytes = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      if (bytes.isEmpty) {
        throw const PocketCapabilityException(
          'live2d_asset_empty',
          'The whitelisted MOC3 asset is empty',
        );
      }

      late final PocketLive2dCoreModel model;
      try {
        model = _coreFactory(bytes);
      } catch (error) {
        throw PocketCapabilityException(
          'live2d_core_create_failed',
          'Cubism Core could not create model "$requestedId": $error',
        );
      }

      try {
        final modelId = 'live2d-${++_nextModelId}';
        final nativeBytes = model.nativeBytes;
        final currentNativeBytes = _models.values.fold<int>(
          0,
          (total, slot) => total + slot.nativeBytes,
        );
        if (nativeBytes <= 0 ||
            nativeBytes > pocketLive2dMaxNativeBytes ||
            currentNativeBytes + nativeBytes > pocketLive2dMaxNativeBytes) {
          throw const PocketCapabilityException(
            'live2d_resource_limit',
            'Cubism Core model storage would exceed the 128 MiB provider budget',
          );
        }

        final modelTextures = List<String>.unmodifiable(textures);
        final facts = <String, Object?>{
          'modelId': modelId,
          'drawableCount': model.drawableCount,
          'mocVersion': model.mocVersion,
          'nativeBytes': nativeBytes,
          'parameterCount': model.parameterCount,
          'parameterDefaults': <Map<String, Object?>>[
            for (final parameter in model.parameterDefaults) parameter.toJson(),
          ],
          if (model is PocketLive2dCoreMetadata) ...<String, Object?>{
            'parameterMetadata': <Map<String, Object?>>[
              for (final parameter
                  in (model as PocketLive2dCoreMetadata).parameterMetadata)
                parameter.toJson(),
            ],
            'parts': <Map<String, Object?>>[
              for (final part in (model as PocketLive2dCoreMetadata).parts)
                part.toJson(),
            ],
          },
          'canvas': model.canvas.toJson(),
          'textures': modelTextures,
        };
        _models[modelId] = _Live2dModelSlot(
          model: model,
          nativeBytes: nativeBytes,
          textures: modelTextures,
        );
        _pendingModelLoads--;
        reservationActive = false;
        return facts;
      } catch (_) {
        model.dispose();
        rethrow;
      }
    } finally {
      if (reservationActive) _pendingModelLoads--;
    }
  }

  Future<Map<String, String>> _resolveAssets() {
    final assets = _assets;
    if (assets != null) return Future<Map<String, String>>.value(assets);
    return _catalogFuture ??= _readBundledCatalog();
  }

  Future<Map<String, String>> _readBundledCatalog() async {
    final catalogAsset = _catalogAsset;
    if (catalogAsset == null) {
      throw StateError('Live2D asset allowlist is not configured');
    }
    final ByteData data;
    try {
      data = await _bundle.load(catalogAsset);
    } catch (error) {
      throw PocketCapabilityException(
        'live2d_catalog_load_failed',
        'Could not load trusted Live2D asset catalog "$catalogAsset": $error',
      );
    }
    final bytes = data.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(bytes));
    } on FormatException catch (error) {
      throw PocketCapabilityException(
        'live2d_catalog_invalid',
        'Trusted Live2D asset catalog is not valid JSON: $error',
      );
    }
    if (decoded is! Map ||
        decoded['version'] != 1 ||
        decoded['assets'] is! Map) {
      throw const PocketCapabilityException(
        'live2d_catalog_invalid',
        'Trusted Live2D asset catalog must have version 1 and an assets map',
      );
    }
    final assets = <String, String>{};
    for (final entry in (decoded['assets']! as Map).entries) {
      if (entry.key is! String || entry.value is! String) {
        throw const PocketCapabilityException(
          'live2d_catalog_invalid',
          'Trusted Live2D asset catalog keys and paths must be strings',
        );
      }
      final requestKey = _validateAssetReference(entry.key, 'catalog key');
      final relativeBundlePath = _validateAssetReference(
        entry.value,
        'catalog asset path',
      );
      assets[requestKey] = assetPrefix.isEmpty
          ? relativeBundlePath
          : '$assetPrefix/$relativeBundlePath';
    }
    return _validateAssets(assets);
  }

  Future<Object?> update(Map<String, dynamic> params) {
    final modelId = _parseModelId(params['modelId']);
    final rawMeshFormat = params['meshFormat'];
    if (rawMeshFormat != null && rawMeshFormat != 'pms1') {
      throw const PocketCapabilityException(
        'invalid_request',
        'meshFormat must be pms1 when present',
      );
    }
    final packedMesh = rawMeshFormat == 'pms1';
    final rawCacheStaticTopology = params['cacheStaticTopology'];
    if (rawCacheStaticTopology != null && rawCacheStaticTopology is! bool) {
      throw const PocketCapabilityException(
        'invalid_request',
        'cacheStaticTopology must be a boolean when present',
      );
    }
    final cacheStaticTopology = rawCacheStaticTopology == true;
    final parameters = _parseValues(params['parameters'], 'parameters');
    final partOpacities = _parseValues(
      params['partOpacities'],
      'partOpacities',
      opacity: true,
    );
    final placement = _parsePlacement(params['placement']);
    return _serializeModel(modelId, () {
      _ensureActive();
      final slot = _models[modelId];
      if (slot == null) {
        throw const PocketCapabilityException(
          'live2d_model_not_found',
          'modelId does not identify a loaded Live2D model',
        );
      }
      if (cacheStaticTopology &&
          slot.model is! PocketLive2dCoreTopologyReader) {
        throw const PocketCapabilityException(
          'live2d_topology_cache_unsupported',
          'This Live2D Core provider cannot omit static topology copies',
        );
      }
      try {
        slot.model.resetToDefaults();
        for (final entry in parameters) {
          slot.model.setParameter(entry.id, entry.value);
        }
        for (final entry in partOpacities) {
          slot.model.setPartOpacity(entry.id, entry.value);
        }
        if (slot.model is PocketLive2dCorePlacementUpdater) {
          (slot.model as PocketLive2dCorePlacementUpdater).updateWithPlacement(
            placement,
          );
        } else {
          slot.model.update();
        }
        final previousTopology = slot.topology;
        final includeTopology =
            !cacheStaticTopology || previousTopology == null;
        if (cacheStaticTopology &&
            previousTopology != null &&
            previousTopology.length != slot.model.drawableCount) {
          throw const PocketCapabilityException(
            'live2d_topology_changed',
            'Drawable count changed while using cached static topology',
          );
        }
        final drawables = <Map<String, Object?>>[];
        final topology = cacheStaticTopology && includeTopology
            ? <_Live2dDrawableTopology>[]
            : null;
        for (var index = 0; index < slot.model.drawableCount; index++) {
          final drawable = cacheStaticTopology
              ? (slot.model as PocketLive2dCoreTopologyReader)
                    .drawableAtWithTopology(
                      index,
                      includeTopology: includeTopology,
                    )
              : slot.model.drawableAt(index);
          final expected = previousTopology == null || includeTopology
              ? null
              : previousTopology[index];
          if (expected != null &&
              (expected.id != drawable.id ||
                  expected.vertexCount != drawable.vertexCount ||
                  expected.indexCount != drawable.indexCount ||
                  expected.maskCount != drawable.maskCount ||
                  drawable.vertexCount * 2 !=
                      drawable.positionsXYPixels.length ||
                  drawable.uvs.isNotEmpty ||
                  drawable.indices.isNotEmpty ||
                  drawable.maskIndices.isNotEmpty)) {
            throw const PocketCapabilityException(
              'live2d_topology_changed',
              'Cached drawable identity or vertex count changed',
            );
          }
          final indexCount = includeTopology
              ? drawable.indices.length
              : expected!.indexCount;
          final maskCount = includeTopology
              ? drawable.maskIndices.length
              : expected!.maskCount;
          if ((includeTopology &&
                  (drawable.vertexCount * 2 !=
                          drawable.positionsXYPixels.length ||
                      drawable.uvs.length !=
                          drawable.positionsXYPixels.length ||
                      drawable.indices.length != drawable.indexCount ||
                      drawable.maskIndices.length != drawable.maskCount ||
                      drawable.indices.length % 3 != 0)) ||
              (!includeTopology &&
                  (drawable.indices.isNotEmpty ||
                      drawable.maskIndices.isNotEmpty))) {
            throw const PocketCapabilityException(
              'live2d_topology_changed',
              'Cached drawable topology has an invalid shape',
            );
          }
          if ((includeTopology && drawable.indices.isNotEmpty ||
                  !includeTopology && indexCount > 0) &&
              (drawable.textureIndex < 0 ||
                  drawable.textureIndex >= slot.textures.length)) {
            throw StateError(
              'Core drawable "${drawable.id}" references texture '
              '${drawable.textureIndex}, but only ${slot.textures.length} '
              'texture assets were allowlisted',
            );
          }
          if (topology != null) {
            topology.add(
              _Live2dDrawableTopology(
                id: drawable.id,
                vertexCount: drawable.positionsXYPixels.length ~/ 2,
                indexCount: indexCount,
                maskCount: maskCount,
                uvs: List<double>.unmodifiable(drawable.uvs),
                indices: List<int>.unmodifiable(drawable.indices),
              ),
            );
          }
          drawables.add(
            drawable.toJson(
              packedMesh: packedMesh,
              includeTopology: includeTopology,
              placement: placement,
              uvsOverride: expected?.uvs,
              indicesOverride: expected?.indices,
            ),
          );
        }
        if (topology != null) slot.topology = List.unmodifiable(topology);
        return <String, Object?>{
          'modelId': modelId,
          'drawables': drawables,
          if (cacheStaticTopology)
            'topologyMode': includeTopology ? 'full' : 'cached-v1',
        };
      } on PocketCapabilityException {
        rethrow;
      } catch (error) {
        throw PocketCapabilityException(
          'live2d_update_failed',
          'Cubism Core could not update model "$modelId": $error',
        );
      }
    });
  }

  Future<Object?> release(Map<String, dynamic> params) {
    final modelId = _parseModelId(params['modelId']);
    _ensureNotDisposed();
    return _serializeModel(modelId, () {
      final slot = _models.remove(modelId);
      if (slot == null) {
        throw const PocketCapabilityException(
          'live2d_model_not_found',
          'modelId does not identify a loaded Live2D model',
        );
      }
      try {
        slot.model.dispose();
      } catch (error) {
        throw PocketCapabilityException(
          'live2d_model_release_failed',
          'Could not release model "$modelId": $error',
        );
      }
      return <String, Object?>{'modelId': modelId, 'released': true};
    });
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    if (_disposed || !_active) return;
    _active = false;
    await _drainPendingWork();
  }

  @override
  Future<void> activate(PocketPluginContext context) async {
    if (_disposed) return;
    // This provider has no animation clock. Reactivation admits later requests
    // and deliberately performs no hidden Core updates.
    _active = true;
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _active = false;
    await _drainPendingWork();
    Object? firstError;
    StackTrace? firstStack;
    for (final modelId in _models.keys.toList(growable: false)) {
      try {
        await _serializeModel(modelId, () {
          final slot = _models.remove(modelId);
          slot?.model.dispose();
        });
      } catch (error, stackTrace) {
        firstError ??= error;
        firstStack ??= stackTrace;
      }
    }
    if (firstError != null) Error.throwWithStackTrace(firstError, firstStack!);
  }

  Future<void> _drainPendingWork() async {
    final pending = <Future<void>>[..._modelTails.values];
    final loads = _pendingLoads.toList(growable: false);
    if (loads.isNotEmpty) {
      pending.add(
        Future.wait<Object?>(
          loads,
        ).then<void>((_) {}, onError: (Object _, StackTrace __) {}),
      );
    }
    if (pending.isEmpty) return;
    await Future.wait<void>(
      pending.map((future) => future.catchError((Object _) {})),
    );
  }

  Future<T> _serializeModel<T>(String modelId, FutureOr<T> Function() action) {
    final previous = _modelTails[modelId] ?? Future<void>.value();
    final completed = Completer<void>();
    final tail = completed.future;
    _modelTails[modelId] = tail;
    return (() async {
      try {
        await previous;
        return await action();
      } finally {
        completed.complete();
        if (identical(_modelTails[modelId], tail)) _modelTails.remove(modelId);
      }
    })();
  }

  void _ensureNotDisposed() {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'Live2D plugin is disposed',
      );
    }
  }

  void _ensureActive() {
    _ensureNotDisposed();
    if (!_active) {
      throw const PocketCapabilityException(
        'plugin_inactive',
        'Live2D plugin is inactive',
      );
    }
  }

  static String _parseIdentifier(Object? value, String field) {
    if (value is! String ||
        value.length > _maxIdentifierLength ||
        !RegExp(_identifierPattern).hasMatch(value)) {
      throw PocketCapabilityException(
        'invalid_request',
        '$field must be a short non-empty identifier',
      );
    }
    return value;
  }

  static String _parseModelId(Object? value) =>
      _parseIdentifier(value, 'modelId');

  static String _requireWhitelistedAsset(
    String value,
    String field,
    Map<String, String> assets,
  ) {
    if (!assets.containsKey(value)) {
      throw PocketCapabilityException(
        'live2d_asset_denied',
        '$field is not present in the exact Live2D asset allowlist',
      );
    }
    return value;
  }

  static List<String> _parseTextures(Object? value) {
    if (value is! List) {
      throw const PocketCapabilityException(
        'invalid_request',
        'textures must be an array of asset keys',
      );
    }
    if (value.length > pocketLive2dMaxTextures) {
      throw const PocketCapabilityException(
        'live2d_resource_limit',
        'A model cannot reference more than 16 texture assets',
      );
    }
    return List<String>.unmodifiable(
      value.map((entry) {
        if (entry is! String) {
          throw const PocketCapabilityException(
            'invalid_request',
            'texture asset keys must be strings',
          );
        }
        return _validateAssetReference(entry, 'textures');
      }),
    );
  }

  static PocketLive2dPlacement _parsePlacement(Object? value) {
    if (value == null) return PocketLive2dPlacement.identity;
    if (value is! Map) {
      throw const PocketCapabilityException(
        'invalid_request',
        'placement must be an object when present',
      );
    }
    final rawDx = value['dx'];
    final rawDy = value['dy'];
    final rawScale = value['scale'];
    final rawOpacity = value['opacity'];
    if (rawDx is! num || !rawDx.isFinite) {
      throw const PocketCapabilityException(
        'invalid_request',
        'placement.dx must be a finite number',
      );
    }
    if (rawDy is! num || !rawDy.isFinite) {
      throw const PocketCapabilityException(
        'invalid_request',
        'placement.dy must be a finite number',
      );
    }
    if (rawScale is! num || !rawScale.isFinite || rawScale <= 0) {
      throw const PocketCapabilityException(
        'invalid_request',
        'placement.scale must be a positive finite number',
      );
    }
    var opacity = 1.0;
    if (rawOpacity != null) {
      if (rawOpacity is! num || !rawOpacity.isFinite) {
        throw const PocketCapabilityException(
          'invalid_request',
          'placement.opacity must be a finite number',
        );
      }
      opacity = rawOpacity.toDouble().clamp(0.0, 1.0);
    }
    return PocketLive2dPlacement(
      dx: rawDx.toDouble(),
      dy: rawDy.toDouble(),
      scale: rawScale.toDouble(),
      opacity: opacity,
    );
  }

  static List<_Live2dValue> _parseValues(
    Object? value,
    String field, {
    bool opacity = false,
  }) {
    if (value is! List) {
      throw PocketCapabilityException(
        'invalid_request',
        '$field must be an array',
      );
    }
    final ids = <String>{};
    return List<_Live2dValue>.unmodifiable(
      value.map((entry) {
        if (entry is! Map) {
          throw PocketCapabilityException(
            'invalid_request',
            '$field entries must be objects',
          );
        }
        final id = _parseIdentifier(entry['id'], '$field.id');
        final rawValue = entry['value'];
        if (rawValue is! num || !rawValue.isFinite) {
          throw PocketCapabilityException(
            'invalid_request',
            '$field.$id value must be finite',
          );
        }
        final parsedValue = rawValue.toDouble();
        if (opacity && (parsedValue < 0 || parsedValue > 1)) {
          throw PocketCapabilityException(
            'invalid_request',
            '$field.$id must be between zero and one',
          );
        }
        if (!ids.add(id)) {
          throw PocketCapabilityException(
            'invalid_request',
            '$field contains duplicate id "$id"',
          );
        }
        return _Live2dValue(id, parsedValue);
      }),
    );
  }

  static Map<String, String> _validateAssets(Map<String, String> assets) {
    final validated = <String, String>{};
    for (final entry in assets.entries) {
      try {
        final requestKey = _validateAssetReference(entry.key, 'MOC key');
        final bundlePath = _validateAssetReference(
          entry.value,
          'MOC bundle path',
        );
        if (!requestKey.toLowerCase().endsWith('.moc3') ||
            !bundlePath.toLowerCase().endsWith('.moc3')) {
          throw const PocketCapabilityException(
            'invalid_request',
            'Live2D asset allowlists may contain MOC3 files only',
          );
        }
        validated[requestKey] = bundlePath;
      } on PocketCapabilityException catch (error) {
        throw ArgumentError('invalid Live2D asset mapping: ${error.message}');
      }
    }
    return Map<String, String>.unmodifiable(validated);
  }

  static String _validateAssetReference(Object? value, String field) {
    if (value is! String || !_isSafeAssetKey(value)) {
      throw PocketCapabilityException(
        'invalid_request',
        '$field must be a safe relative asset key',
      );
    }
    return value;
  }

  static String _validateAssetPrefix(String value) {
    if (value.isEmpty) return '';
    final normalized = value.replaceAll(RegExp(r'/+$'), '');
    if (normalized.isEmpty || !_isSafeAssetKey(normalized)) {
      throw ArgumentError.value(
        value,
        'assetPrefix',
        'must be a safe relative asset prefix',
      );
    }
    return normalized;
  }

  static bool _isSafeAssetKey(String value) {
    if (!RegExp(_assetPattern).hasMatch(value) ||
        value.startsWith('/') ||
        value.contains('://')) {
      return false;
    }
    return value
        .split('/')
        .every(
          (segment) => segment.isNotEmpty && segment != '.' && segment != '..',
        );
  }
}

final class _Live2dModelSlot {
  _Live2dModelSlot({
    required this.model,
    required this.nativeBytes,
    required this.textures,
  });

  final PocketLive2dCoreModel model;
  final int nativeBytes;
  final List<String> textures;
  List<_Live2dDrawableTopology>? topology;
}

final class _Live2dDrawableTopology {
  const _Live2dDrawableTopology({
    required this.id,
    required this.vertexCount,
    required this.indexCount,
    required this.maskCount,
    required this.uvs,
    required this.indices,
  });

  final String id;
  final int vertexCount;
  final int indexCount;
  final int maskCount;
  final List<double> uvs;
  final List<int> indices;
}

final class _Live2dValue {
  const _Live2dValue(this.id, this.value);

  final String id;
  final double value;
}
