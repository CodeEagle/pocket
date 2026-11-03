import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';
import 'pocket_worker.dart';
import 'package_info_plugin.dart';
import 'performance_history.dart';

/// Platform orchestration only: package trust, runtime lifetime and capability
/// providers. Pages, routing, UI components and application state live in JS.
final class PocketSession extends ChangeNotifier {
  PocketSession({required this.config})
    : performance = PerformanceHistory(namespace: config.appId) {
    config.validate();
  }

  final PocketAppConfig config;
  String get appId => config.appId;
  Set<String> get capabilities => {
    'text.glyphs.baked',
    'runtime.worker',
    if (config.offloadProviderFactory != null) 'io.offload',
    if (config.workerHttpOrigins.isNotEmpty) 'net.http',
    'runtime.info',
    'runtime.performance',
    'plugins.list',
    'plugins.packageInfo',
    'updates.status',
    'updates.check',
    'updates.apply',
    'updates.rollback',
    ...config.additionalCapabilities,
  };

  final controller = PocketViewController();
  final PerformanceHistory performance;
  PocketPreparedPackage? active;
  PocketPreparedPackage? _candidate;
  PocketUpdateCoordinator? _updates;
  PocketHost? _host;
  PocketPluginManager? _plugins;
  PocketCapabilityAvailability? _negotiatedCapabilities;
  Future<void> _bridgeOperation = Future<void>.value();
  bool _foreground = true;
  bool _foregroundRequested = true;
  bool _firstFrameReady = false;

  /// App visibility, distinct from the Flutter process lifecycle. Hidden apps
  /// retain their realm but stop their clock and release active capabilities.
  bool get foreground => _foreground;

  Future<void> _serializeBridge(Future<void> Function() operation) {
    final next = _bridgeOperation.then((_) => operation());
    // A failed operation must reach its caller without poisoning later close,
    // recovery or activation work.
    _bridgeOperation = next.catchError((Object _) {});
    return next;
  }

  Future<void> setForeground(bool value) {
    if (_disposed) return Future<void>.error(StateError('Session is closed'));
    _foregroundRequested = value;
    if (!value) {
      _foreground = false;
      controller.setAppActive(false);
      _healthTimer?.cancel();
      _startupTimer?.cancel();
      notifyListeners();
    }
    return _serializeBridge(() async {
      if (_disposed) return;
      final plugins = _plugins;
      if (!value) {
        await plugins?.deactivate(foregroundOnly: true);
        return;
      }
      if (!_foregroundRequested) return;
      final negotiated = _negotiatedCapabilities;
      if (plugins != null && negotiated != null && !_foreground) {
        final granted = await plugins.activate(negotiated);
        if (!granted.satisfied) {
          throw StateError(
            'Missing capabilities on resume: '
            '${granted.missingRequired.join(', ')}',
          );
        }
      }
      if (_disposed || !_foregroundRequested) return;
      _foreground = true;
      controller.setAppActive(true);
      if (_firstFrameReady) {
        onReady(controller);
      } else if (ready) {
        _watchStartup();
      }
      notifyListeners();
    });
  }

  PocketGuestManifest _embeddedManifest = const PocketGuestManifest();
  Map<String, dynamic> _metadata = {};
  PocketWorkerProgram? workerProgram;
  int get tickHz => (_metadata['tickHz'] as num?)?.toInt() ?? 60;
  int _embeddedBuild = 0;
  String _embeddedVersion = 'embedded';
  PocketCancellationToken? _download;
  bool ready = false;
  bool _disposed = false;
  bool _busy = true;
  bool _recovering = false;
  Object? failure;
  Future<void>? _promotion;
  int generation = 0;
  String stage = 'initializing';
  String? lastError;
  Timer? _mountTimer;
  Timer? _healthTimer;
  Timer? _startupTimer;
  Future<void>? _shutdown;
  Future<void>? _initializeFuture;

  /// Initializes this session at most once.
  ///
  /// A widget can be removed while the asset bundle or update store is still
  /// loading. Keeping the future lets [close] wait for that work and prevents
  /// a second caller from constructing a second plugin/update generation.
  Future<void> initialize() {
    if (_disposed) return Future<void>.error(StateError('Session is closed'));
    final existing = _initializeFuture;
    if (existing != null) return existing;
    final future = _initialize();
    _initializeFuture = future;
    return future;
  }

  Future<void> _initialize() async {
    await performance.initialize();
    _metadata = Map<String, dynamic>.from(
      jsonDecode(await rootBundle.loadString(config.metadataAsset)) as Map,
    );
    final manifestSource = await rootBundle.loadString(config.manifestAsset);
    _embeddedManifest = PocketGuestManifest.fromJsonString(manifestSource);
    final manifestJson = jsonDecode(manifestSource);
    final updateConfig = config.updates;
    final embeddedBuild = _resolveEmbeddedBuild(
      _metadata,
      manifestJson,
      requireBuild: updateConfig?.configured == true,
    );
    _embeddedBuild = embeddedBuild;
    _embeddedVersion = _metadata['version'] as String? ?? 'embedded';
    if (updateConfig != null && updateConfig.configured) {
      final directory = await getApplicationSupportDirectory();
      final namespace = updateConfig.namespace;
      final updates = PocketUpdateCoordinator(
        manifestUri: Uri.parse(updateConfig.url),
        appId: appId,
        trustedKeys: {updateConfig.keyId: base64Decode(updateConfig.publicKey)},
        store: PocketPackageStore(
          Directory('${directory.path}/pocket-packages/$appId/$namespace'),
        ),
        expectedRuntimeAbi: _metadata['runtimeAbi'] as String,
        requireBytecode: true,
        minimumBuild: embeddedBuild,
        debugHttpHosts: kDebugMode
            ? const ['127.0.0.1', 'localhost', '10.0.2.2']
            : const [],
      );
      // The coordinator owns an HTTP client. If the widget was disposed while
      // assets/path resolution was in flight, no session field existed yet for
      // dispose() to close, so close this local coordinator before returning.
      if (_disposed) {
        updates.dispose();
        return;
      }
      _updates = updates;
      try {
        active = await updates.lastGood();
        if (active != null && embeddedBuild > active!.build) {
          await updates.resetToEmbedded();
          active = null;
        }
      } catch (error) {
        lastError = 'Cached package rejected: $error';
      }
    }
    if (_disposed) return;
    try {
      await _configureBridge(active);
    } catch (error) {
      if (active == null) rethrow;
      lastError = 'Cached capabilities rejected: $error';
      active = null;
      _resetCacheOnHealth = true;
      await _configureBridge(null);
    }
    stage = 'loading';
    ready = true;
    notifyListeners();
    _watchStartup();
  }

  static int _resolveEmbeddedBuild(
    Map<String, dynamic> metadata,
    Object? manifest, {
    required bool requireBuild,
  }) {
    // Legacy artifacts may carry their release floor only in the manifest.
    // An explicitly invalid metadata build must not be hidden by that fallback.
    final value = metadata.containsKey('build')
        ? metadata['build']
        : manifest is Map && manifest.containsKey('build')
        ? manifest['build']
        : null;
    if (value == null && !requireBuild) return 0;
    if (value is! num ||
        !value.isFinite ||
        value < 1 ||
        value > 9007199254740991 ||
        value != value.truncateToDouble()) {
      throw const FormatException(
        'A positive integer embedded build is required in app.bytecode.json '
        'or guest-manifest.json before enabling updates',
      );
    }
    return value.toInt();
  }

  Map<String, dynamic> runtimeInfo() => {
    'appId': appId,
    if (active == null) ..._metadata,
    'runtimeAbi': controller.runtimeAbi ?? _metadata['runtimeAbi'],
    if (active != null)
      'entrySha256': active!.package.manifest.payload.entry.sha256,
    if (active != null && active!.package.manifest.payload.worker != null)
      'worker': active!.package.manifest.payload.worker,
    'entryFormat': 'quickjs-bytecode',
    'glassRenderer': ui.ImageFilter.isShaderFilterSupported
        ? 'refractive'
        : 'frosted',
    'hostSurfaces': ['glass', 'platformTexture'],
    'version': active?.version ?? _embeddedVersion,
    'build': active?.build ?? _embeddedBuild,
    'source': active == null ? 'embedded' : 'verified-cache',
    'entryBytes':
        active?.package.manifest.payload.entry.size ??
        _metadata['bytecodeBytes'],
  };

  Future<Map<String, dynamic>> status() async => {
    'configured': _updates != null,
    'stage': stage,
    'activeVersion': active?.version ?? _embeddedVersion,
    'activeBuild': active?.build ?? _embeddedBuild,
    'availableVersion': _candidate?.version,
    'versions': [
      {
        'version': _embeddedVersion,
        'build': _embeddedBuild,
        'source': 'embedded',
        'active': active == null,
      },
      if (_updates != null)
        for (final version in await _updates!.listVersions()) version.toJson(),
    ],
    'lastError': lastError,
  };

  Future<void> _configureBridge(PocketPreparedPackage? package) =>
      _serializeBridge(() => _configureBridgeUnlocked(package));

  Future<void> _configureBridgeUnlocked(PocketPreparedPackage? package) async {
    final oldPlugins = _plugins;
    final oldHost = _host;
    _plugins = null;
    _negotiatedCapabilities = null;
    _host = null;
    await oldPlugins?.dispose();
    oldHost?.dispose();
    if (_disposed) return;
    final providers = <PocketPlugin>[
      PackageInfoPlugin(),
      for (final factory in config.pluginFactories) factory(controller),
    ];
    final registry = PocketHostRegistry();
    final host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: _send),
      allowedCapabilities: {
        ...capabilities,
        for (final provider in providers)
          ...provider.descriptor.capabilities.keys,
      },
      send: _send,
      builtInCapabilities: {
        'text.glyphs.baked',
        'runtime.worker',
        if (config.offloadProviderFactory != null) 'io.offload',
        if (config.workerHttpOrigins.isNotEmpty) 'net.http',
        if (config.additionalCapabilities.contains('ui.compositor-surfaces'))
          'ui.compositor-surfaces',
      },
      sendRaw: controller.sendRaw,
    );
    final plugins = PocketPluginManager(
      host: host,
      appId: appId,
      sessionId: 'guest-$generation',
      // Host policy permits these compiled capabilities. Each platform still
      // asks for OS authorization at the user's explicit action; activation
      // asks none.
      allowedPermissions: config.allowedPermissions,
    );
    _host = host;
    _plugins = plugins;
    registry.registerRequest('runtime.info', (_) => runtimeInfo());
    registry.registerRequest(
      'runtime.performance',
      (_) => performance.snapshot(),
    );
    registry.registerRequest('plugins.list', (_) => plugins.manifest());
    registry.registerRequest('updates.status', (_) => status());
    registry.registerRequest('updates.check', (_) => _check());
    registry.registerRequest('updates.apply', (_) => _apply());
    registry.registerRequest('updates.rollback', (_) => _rollback());
    for (final provider in providers) {
      plugins.register(provider);
    }
    final manifest =
        package?.package.manifest.payload.guestManifest ?? _embeddedManifest;
    final negotiated = plugins.negotiate(
      required: manifest.requiredCapabilities,
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    );
    _negotiatedCapabilities = negotiated;
    final granted = await plugins.activate(negotiated);
    if (!granted.satisfied) {
      throw StateError(
        'Missing capabilities: ${granted.missingRequired.join(', ')}',
      );
    }
    final descriptor = package == null
        ? _metadata['worker']
        : package.package.manifest.payload.worker;
    workerProgram = null;
    if (descriptor != null) {
      final worker = Map<String, dynamic>.from(descriptor as Map);
      final bytecodeDescriptor = Map<String, dynamic>.from(
        worker['bytecode'] as Map,
      );
      final relative = bytecodeDescriptor['path'] as String;
      if (relative.startsWith('/') ||
          relative.contains('\\') ||
          relative.split('/').any((p) => p.isEmpty || p == '.' || p == '..')) {
        throw const FormatException('Invalid worker asset path');
      }
      final Uint8List bytes;
      if (package != null) {
        final file = package.source.pathForAsset(relative);
        if (file == null)
          throw const FormatException(
            'Signed package is missing worker bytecode',
          );
        bytes = await File(file).readAsBytes();
      } else {
        final separator = config.metadataAsset.lastIndexOf('/');
        final base = separator < 0
            ? ''
            : config.metadataAsset.substring(0, separator + 1);
        bytes = (await rootBundle.load('$base$relative')).buffer.asUint8List();
      }
      workerProgram = PocketWorkerArtifact.verify(
        appMetadataJson: jsonEncode({'worker': worker}),
        bytecode: bytes,
        actualRuntimeAbi: _metadata['runtimeAbi'] as String,
        expectedBindingGeneration: (_metadata['bindingGeneration'] as num)
            .toInt(),
        expectedTickHz: (worker['tickHz'] as num?)?.toInt() ?? tickHz,
        admittedCapabilities: granted.granted,
        allowedHttpOrigins: config.workerHttpOrigins,
      ).program;
    } else if (manifest.requiredCapabilities.contains('runtime.worker')) {
      throw const FormatException(
        'Guest requires runtime.worker but has no worker descriptor',
      );
    }
    if (!_foregroundRequested) await plugins.deactivate(foregroundOnly: true);
  }

  bool _send(String method, Map<String, dynamic> params) =>
      !_disposed && controller.send(method: method, params: params);

  void onEvent(PocketEvent event) {
    final host = _host;
    if (host != null) unawaited(host.handle(event));
  }

  void onPerformanceSample(PocketPerformanceSample sample) {
    if (_disposed) return;
    final json = sample.toJson();
    performance.add(json);
    final snapshot = performance.snapshot();
    _send('runtime.performance.sample', {
      'sample': json,
      'minFps': (snapshot['latest'] as Map?)?['minFps'],
      'recording': true,
    });
  }

  void onReady(PocketViewController _) {
    _firstFrameReady = true;
    _startupTimer?.cancel();
    if (!_disposed) notifyListeners();
    if (!_foreground || _disposed) return;
    final mountedGeneration = generation;
    // A successful first frame and a short live-frame period precede promotion.
    _healthTimer = Timer(const Duration(seconds: 1), () async {
      if (_disposed || !_foreground || generation != mountedGeneration) return;
      try {
        final package = active;
        _promotion = package != null
            ? _updates!.commitHealthy(package)
            : _resetCacheOnHealth
            ? _updates!.resetToEmbedded()
            : Future<void>.value();
        await _promotion;
        _promotion = null;
        _resetCacheOnHealth = false;
        _embeddedRollbackFallback = null;
        if (_disposed || generation != mountedGeneration) return;
        stage = _updates == null ? 'not_configured' : 'ready';
        _busy = false;
        _send('updates.changed', await status());
      } catch (error) {
        await onError(error);
      }
    });
  }

  Future<Map<String, dynamic>> _check() async {
    final updates = _requireUpdates();
    if (_busy) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }
    _busy = true;
    _candidate = null;
    lastError = null;
    final token = _download = PocketCancellationToken();
    try {
      _candidate = await updates.prepare(
        cancellation: token,
        onProgress: (progress) {
          stage = progress.stage.name;
          _send('updates.progress', {
            'stage': stage,
            'downloadedBytes': progress.downloadedBytes,
            'totalBytes': progress.totalBytes,
          });
        },
      );
      stage = 'verified';
      return await status();
    } catch (error) {
      stage = 'error';
      lastError = '$error';
      rethrow;
    } finally {
      _busy = false;
      _download = null;
    }
  }

  Map<String, dynamic> _apply() {
    _requireUpdates();
    if (_busy) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }
    final next = _candidate;
    if (next == null) {
      throw const PocketCapabilityException(
        'update_not_checked',
        'Check and verify an update first',
      );
    }
    _busy = true;
    // Allow the old guest to consume its response before disposing its runtime.
    _mountTimer = Timer(const Duration(milliseconds: 150), () => _mount(next));
    return {'scheduled': true, 'version': next.version};
  }

  Future<Map<String, dynamic>> _rollback() async {
    final updates = _requireUpdates();
    if (_busy) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }
    _busy = true;
    try {
      final versions = await updates.listVersions();
      final previous = versions.where(
        (version) =>
            version.isPrevious &&
            version.versionId != active?.package.versionId,
      );
      PocketPreparedPackage? next;
      if (previous.isNotEmpty) {
        next = PocketPreparedPackage(
          package: previous.first.package,
          needsActivation: true,
          isRollback: true,
        );
      }
      // The immutable embedded bundle is always a rollback target. Remove cache
      // pointers only after the embedded guest has started successfully.
      final embeddedFallback = next == null ? active : null;
      _mountTimer = Timer(
        const Duration(milliseconds: 150),
        () => _mount(
          next,
          resetCache: next == null,
          embeddedRollbackFallback: embeddedFallback,
        ),
      );
      return {'scheduled': true, 'version': next?.version ?? 'embedded'};
    } catch (_) {
      _busy = false;
      rethrow;
    }
  }

  bool _resetCacheOnHealth = false;
  // An explicit rollback to the immutable bundle must retain its verified
  // recovery target until the embedded guest completes the health window.
  PocketPreparedPackage? _embeddedRollbackFallback;

  Future<void> _mount(
    PocketPreparedPackage? next, {
    bool resetCache = false,
    PocketPreparedPackage? embeddedRollbackFallback,
  }) async {
    if (_disposed) return;
    _healthTimer?.cancel();
    _startupTimer?.cancel();
    final previous = active;
    // Invalidate old callbacks before awaiting plugin teardown or registration.
    generation++;
    _firstFrameReady = false;
    try {
      await _configureBridge(next);
      if (_disposed) return;
      active = next;
      _resetCacheOnHealth = resetCache;
      _embeddedRollbackFallback = embeddedRollbackFallback;
      _candidate = null;
      stage = 'loading';
      notifyListeners();
      _watchStartup();
    } catch (error) {
      lastError = '$error';
      try {
        await _configureBridge(previous);
        if (_disposed) return;
        active = previous;
        stage = 'loading';
        notifyListeners();
        _watchStartup();
      } catch (restoreError) {
        failure = restoreError;
        _busy = false;
        stage = 'error';
        if (!_disposed) notifyListeners();
      }
    }
  }

  void _watchStartup() {
    _startupTimer?.cancel();
    if (!_foreground || _disposed) return;
    final expectedGeneration = generation;
    _startupTimer = Timer(const Duration(seconds: 15), () {
      if (_disposed || generation != expectedGeneration) return;
      unawaited(
        onError(
          StateError('Guest did not produce its first frame within 15 seconds'),
        ),
      );
    });
  }

  Future<void> onError(Object error) async {
    if (_disposed || _recovering) return;
    _recovering = true;
    // An old guest can fail during the response-to-mount delay. Cancel that
    // candidate before scheduling recovery so it cannot overwrite fallback.
    _mountTimer?.cancel();
    _mountTimer = null;
    _healthTimer?.cancel();
    _startupTimer?.cancel();
    final embeddedFallback = _embeddedRollbackFallback;
    _embeddedRollbackFallback = null;
    _resetCacheOnHealth = false;
    lastError = '$error';
    stage = 'error';
    _busy = true;
    try {
      // If disk promotion was already in flight, finish it before determining
      // the previous healthy pointer. This avoids promoting a failed guest late.
      try {
        await _promotion;
      } catch (_) {}
      _promotion = null;
      if (_disposed) return;
      final failed = active;
      if (failed == null) {
        if (embeddedFallback != null) {
          await _mount(embeddedFallback);
        } else {
          _busy = false;
          failure = error;
          notifyListeners();
        }
        return;
      }
      PocketPreparedPackage? fallback;
      try {
        fallback = await _updates!.fallbackFor(failed);
        if (fallback?.package.versionId == failed.package.versionId) {
          fallback = null;
        }
      } catch (_) {
        fallback = null;
      }
      await _mount(fallback, resetCache: fallback == null);
    } finally {
      _recovering = false;
    }
  }

  PocketUpdateCoordinator _requireUpdates() {
    final updates = _updates;
    if (updates == null) {
      throw const PocketCapabilityException(
        'updates_not_configured',
        'Configure PocketAppConfig.updates with a signed manifest URL and trusted public key',
      );
    }
    return updates;
  }

  /// Await plugin teardown and performance persistence when managing a
  /// session directly. Widget disposal schedules the same single cleanup.
  Future<void> close() {
    dispose();
    final pending = <Future<void>>[
      _shutdown ?? Future<void>.value(),
      if (_initializeFuture != null) _initializeFuture!,
      if (_promotion != null) _promotion!,
      _bridgeOperation,
    ];
    return Future.wait<void>(pending).then<void>((_) {});
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _foregroundRequested = false;
    _foreground = false;
    controller.setAppActive(false);
    _mountTimer?.cancel();
    _healthTimer?.cancel();
    _startupTimer?.cancel();
    _download?.cancel();
    final plugins = _plugins;
    _host?.dispose();
    _updates?.dispose();
    _shutdown = _bridgeOperation.then((_) async {
      await Future.wait<void>([
        if (plugins != null) plugins.dispose(),
        performance.dispose(),
      ]);
    });
    unawaited(
      _shutdown!.catchError((Object error) {
        lastError = '$error';
      }),
    );
    super.dispose();
  }
}
