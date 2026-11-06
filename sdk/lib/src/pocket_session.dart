import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';
import 'pocket_worker.dart';
import 'package_info_plugin.dart';
import 'performance_history.dart';

typedef PocketSessionGenerationMountHook =
    Future<void> Function(String? mountedPayloadSha256, int targetGeneration);

/// Platform orchestration only: package trust, runtime lifetime and capability
/// providers. Pages, routing, UI components and application state live in JS.
final class PocketSession extends ChangeNotifier {
  static const Duration _downloadOnOpenTimeout = Duration(seconds: 20);

  PocketSession({required this.config, this.beforeGenerationMount})
    : performance = PerformanceHistory(namespace: config.appId) {
    config.validate();
    _sessionsByController[controller] = this;
  }

  static final Expando<PocketSession> _sessionsByController =
      Expando<PocketSession>('PocketSession.controller');

  /// Schedules a recorded runtime generation remount when the client starts
  /// recording through `diagnostics.recording.start`.
  static void restartControllerForRecording(
    PocketViewController controller,
    Map<String, dynamic> Function() statusProvider,
  ) {
    _sessionsByController[controller]?._restartForRecording(statusProvider);
  }

  final PocketAppConfig config;

  /// Runs after a signed package is admitted and before that generation is
  /// published to Flutter. A host can use this official mount boundary to
  /// prepare generation-bound native facts before PocketView performs its
  /// pre-evaluation compositor registration.
  final PocketSessionGenerationMountHook? beforeGenerationMount;
  PocketMemoryLimits? _memoryLimits;
  PocketMemoryLimits get memoryLimits => _memoryLimits ?? config.memoryLimits;
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

  bool get _downloadOnOpen => config.downloadOnOpen;

  /// Hash of the signed payload currently mounted in this session. Embedded
  /// bytes have no signed package identity and therefore return null; a host
  /// catalog may only be refreshed after the official update mount boundary.
  String? get mountedPayloadSha256 {
    final package = active?.package;
    if (package == null) return null;
    return sha256.convert(package.manifest.payloadBytes).toString();
  }

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
  bool _packageAdmissionInFlight = false;
  bool _recovering = false;
  Object? failure;
  Future<void>? _promotion;
  int generation = 0;
  String stage = 'initializing';
  String? lastError;
  Timer? _mountTimer;
  Future<void>? _mountOperation;
  Timer? _healthTimer;
  Timer? _startupTimer;
  Future<void>? _shutdown;
  Future<void>? _initializeFuture;
  Map<String, dynamic> Function()? _pendingRecordingStartedStatus;

  void _restartForRecording(Map<String, dynamic> Function() statusProvider) {
    if (_disposed) return;
    _pendingRecordingStartedStatus = statusProvider;
    _mountTimer?.cancel();
    // Allow the guest to receive the diagnostics.recording.start response
    // before replacing its runtime generation with a freshly recorded realm.
    _mountTimer = Timer(const Duration(milliseconds: 20), () => _mount(active));
  }

  /// Initializes this session at most once.
  ///
  /// A widget can be removed while the asset bundle or update store is still
  /// loading. Keeping the future lets [close] wait for that work and prevents
  /// a second caller from constructing a second plugin/update generation.
  ///
  /// When [prepareForOpen] is true and signed updates are configured, the
  /// remote manifest is checked and any candidate is staged before the bridge
  /// is configured. This is intentionally a one-shot startup gate; callers
  /// must pass it on the first initialize call.
  Future<void> initialize({bool prepareForOpen = false}) {
    if (_disposed) return Future<void>.error(StateError('Session is closed'));
    final existing = _initializeFuture;
    if (existing != null) return existing;
    final future = _initialize(prepareForOpen: prepareForOpen);
    _initializeFuture = future;
    return future;
  }

  Future<void> _initialize({bool prepareForOpen = false}) async {
    await performance.initialize();
    final metadataSource =
        config.bootstrapMetadataJson ??
        await rootBundle.loadString(config.metadataAsset);
    _metadata = Map<String, dynamic>.from(jsonDecode(metadataSource) as Map);
    final manifestSource =
        config.bootstrapManifestJson ??
        await rootBundle.loadString(config.manifestAsset);
    _embeddedManifest = PocketGuestManifest.fromJsonString(manifestSource);
    final manifestJson = jsonDecode(manifestSource);
    final updateConfig = config.updates;
    final embeddedBuild = _resolveEmbeddedBuild(
      _metadata,
      manifestJson,
      // Remote-only bootstrap metadata also pins the oldest allowed release.
      // Requiring a build prevents first-install replay of older signed code.
      requireBuild: updateConfig?.configured == true,
    );
    _embeddedBuild = embeddedBuild;
    if (!_downloadOnOpen) {
      _embeddedVersion = _metadata['version'] as String? ?? 'embedded';
    }
    if (updateConfig != null && updateConfig.configured) {
      final directory = await getApplicationSupportDirectory();
      final namespace = updateConfig.namespace;
      final packageRoot = Directory(
        '${directory.path}/pocket-packages/$appId/$namespace',
      );
      final trustStore = updateConfig.trustPolicyConfigured
          ? PocketTrustStore(
              directory: packageRoot,
              appId: appId,
              rootKeyId: updateConfig.trustRootKeyId!,
              rootPublicKey: base64Decode(updateConfig.trustRootPublicKey!),
            )
          : null;
      final updates = PocketUpdateCoordinator(
        manifestUri: updateConfig.manifestUri(appId),
        appId: appId,
        trustedKeys: updateConfig.trustPolicyConfigured
            ? const <String, List<int>>{}
            : <String, List<int>>{
                updateConfig.keyId: base64Decode(updateConfig.publicKey),
              },
        store: PocketPackageStore(packageRoot),
        expectedRuntimeAbi: _metadata['runtimeAbi'] as String,
        requireBytecode: true,
        // There is no embedded package to activate in downloadOnOpen mode.
        // An explicit prepareForOpen gate also needs to admit a signed package
        // at the embedded build when no remote baseline exists; older builds
        // remain rejected by the coordinator's floor. Once a remote baseline
        // exists, its version ID still prevents same-build replay.
        // Keep one build of headroom so a signed package at the embedded
        // build can be admitted on a first check. The final admission below
        // still rejects every package below the embedded executable floor.
        minimumBuild: embeddedBuild - 1,
        trustStore: trustStore,
        trustPolicyUri: updateConfig.trustPolicyConfigured
            ? Uri.parse(updateConfig.trustPolicyUrl!)
            : null,
        debugHttpHosts: kDebugMode
            ? <String>{
                '127.0.0.1',
                'localhost',
                '10.0.2.2',
                ...updateConfig.debugHttpHosts,
              }
            : const <String>[],
      );
      // The coordinator owns an HTTP client. If the widget was disposed while
      // assets/path resolution was in flight, no session field existed yet for
      // dispose() to close, so close this local coordinator before returning.
      if (_disposed) {
        updates.dispose();
        return;
      }
      _updates = updates;
      if (_downloadOnOpen || prepareForOpen) {
        // Opening a remote mini-app first reuses only a verified healthy
        // package. With no healthy cache, the coordinator performs the full
        // signed-manifest/blob admission path and stages a candidate; no
        // local qjbc/PAK fallback is available in this mode. An explicit
        // prepareForOpen gate always performs that signed check, even when a
        // healthy cache exists. This is what makes a mini-app entry check
        // different from the normal offline cache bootstrap.
        try {
          if (prepareForOpen) {
            active = await _prepareOnOpen(
              updates,
              mountedPackage: active?.package,
            );
          } else {
            active = await updates.lastGood(allowActiveFallback: false);
            if (_disposed) return;
            if (active != null && active!.build < _embeddedBuild) {
              // Keep the old pointers as a downgrade baseline. A stale healthy
              // cache must not run, but prepare() can still use it to enforce
              // the bootstrap floor while fetching the current release.
              active = null;
            }
            if (active == null) {
              active = await _prepareOnOpen(
                updates,
                mountedPackage: active?.package,
              );
            }
          }
        } catch (error) {
          if (_disposed) return;
          _failWithoutEmbedded(error);
          rethrow;
        }
      } else {
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
    }
    if (_disposed) return;
    if (_downloadOnOpen && active == null) {
      throw StateError('downloadOnOpen did not produce a verified package');
    }
    void publishInitial() {
      if (_disposed) return;
      stage = 'loading';
      ready = true;
      notifyListeners();
      _watchStartup();
    }

    try {
      await _withAdmittedPackage(active, () {});
      await _configureBridge(active);
      await _prepareBeforeGenerationMount(active, generation);
      await _withAdmittedPackage(active, publishInitial);
    } catch (error) {
      if (_downloadOnOpen || prepareForOpen) {
        final failed = active;
        if (_downloadOnOpen && !prepareForOpen) {
          final fallback = failed == null
              ? null
              : await _verifiedFallback(failed);
          if (fallback != null && !_disposed) {
            active = fallback;
            try {
              await _configureBridge(fallback);
              await _prepareBeforeGenerationMount(fallback, generation);
              await _withAdmittedPackage(fallback, publishInitial);
              return;
            } catch (_) {}
          }
        }
        _failWithoutEmbedded(error);
        rethrow;
      }
      if (active == null) rethrow;
      lastError = 'Cached capabilities rejected: $error';
      active = null;
      _resetCacheOnHealth = true;
      await _configureBridge(null);
      publishInitial();
    }
  }

  /// Prepares the first remote package with one bounded wall-clock budget.
  ///
  /// `PocketUpdateCoordinator` already checks the signed manifest, content
  /// hashes and cancellation at every download boundary. The timeout only
  /// supplies an outer bound for a cold open that may contain a manifest plus
  /// multiple blobs; awaiting the original future in `finally` lets its
  /// temporary files and transport stream finish their cancellation cleanup.
  Future<PocketPreparedPackage> _prepareOnOpen(
    PocketUpdateCoordinator updates, {
    PocketPackage? mountedPackage,
  }) async {
    final token = _download = PocketCancellationToken();
    final operation = updates.prepare(
      cancellation: token,
      mountedPackage: mountedPackage,
      onProgress: (progress) {
        if (_disposed) return;
        stage = progress.stage.name;
      },
    );
    try {
      return await operation.timeout(
        _downloadOnOpenTimeout,
        onTimeout: () {
          token.cancel();
          throw const PocketPackageException(
            'downloadOnOpen package preparation timed out',
            code: 'download-timeout',
          );
        },
      );
    } finally {
      try {
        await operation;
      } catch (_) {
        // The bounded operation's error is reported by the awaited call
        // above. This second await is only for cancellation cleanup.
      }
      if (identical(_download, token)) _download = null;
    }
  }

  /// Checks the signed update source immediately before an already resident
  /// runtime is presented.
  ///
  /// This is deliberately separate from [updates.apply]. Applying through the
  /// guest API schedules a remount and keeps [_busy] set until the visible
  /// health window completes. A prewarmed runtime is hidden, so that health
  /// window cannot complete yet. This method performs the signed preparation
  /// and mount, then returns; normal [onReady] promotion still owns the
  /// healthy-package pointer once the runtime is actually visible.
  ///
  /// The host validates the instance owner, generation and hidden state before
  /// calling this method. A session may still be [_busy] because it is waiting
  /// for its first hidden health frame; only a real package operation or
  /// lifecycle transition is a conflict here.
  Future<Map<String, Object?>> prepareForOpen({
    bool Function()? canMount,
  }) async {
    if (_disposed) {
      throw const PocketCapabilityException('host_closed', 'Session is closed');
    }
    final initialization = _initializeFuture;
    if (initialization != null) {
      await initialization;
    } else {
      await initialize();
    }

    final updates = _updates;
    if (updates == null) {
      // An embedded/local mini-app has no remote source to check. The caller
      // still receives a fact that the gate was handled, without inventing a
      // network operation or rejecting the existing local startup path.
      if (canMount != null && !canMount()) {
        throw const PocketCapabilityException(
          'runtime_busy',
          'Runtime became visible before its package was mounted',
        );
      }
      return const <String, Object?>{'configured': false, 'updated': false};
    }
    if (_download != null ||
        (_mountTimer?.isActive ?? false) ||
        _mountOperation != null ||
        _packageAdmissionInFlight ||
        _recovering ||
        _promotion != null) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }

    final previousBusy = _busy;
    final previousStage = stage;
    final previousError = lastError;
    final previousFailure = failure;
    final previousCandidate = _candidate;
    _busy = true;
    _packageAdmissionInFlight = true;
    _candidate = null;
    failure = null;
    lastError = null;
    var mounted = false;
    try {
      final next = await _prepareOnOpen(
        updates,
        mountedPackage: active?.package,
      );
      if (_disposed) {
        throw const PocketCapabilityException(
          'host_closed',
          'Session is closed',
        );
      }
      if (canMount != null && !canMount()) {
        throw const PocketCapabilityException(
          'runtime_busy',
          'Runtime became visible before its package was mounted',
        );
      }
      final sameActivePackage =
          active?.package.versionId == next.package.versionId;
      if (sameActivePackage) {
        // A hidden prewarm can have loaded a package before its first health
        // promotion, so the coordinator's store may not yet know that the
        // session already runs this exact version. Re-admit it, but do not
        // remount or advance the generation.
        // Even a no-op must cross the final trust boundary again. This keeps a
        // changed trust policy or on-disk bytes from turning a stale cache into
        // an accepted open result.
        await _withAdmittedPackage(next, () {});
        _busy = previousBusy;
        stage = previousStage;
        lastError = previousError;
        failure = previousFailure;
        return const <String, Object?>{'configured': true, 'updated': false};
      }

      // _mount performs the same final admission and bridge teardown used by
      // the normal update path. It may restore the previous package when the
      // candidate fails; the identity check below makes that restoration a
      // failed prepareOpen rather than a false success.
      await _mount(next);
      mounted = true;
      final actual = active;
      if (actual == null ||
          actual.package.versionId != next.package.versionId) {
        throw const PocketCapabilityException(
          'update_mount_failed',
          'Prepared package was not mounted',
        );
      }
      return const <String, Object?>{'configured': true, 'updated': true};
    } catch (error) {
      if (!mounted) {
        // Preparation failed before changing the runtime. Restore the visible
        // state so a caller can retry without inheriting a stale loading/busy
        // marker from this gate.
        _busy = previousBusy;
        stage = previousStage;
        lastError = previousError;
        failure = previousFailure;
        _candidate = previousCandidate;
      } else {
        // A failed mount may have restored the old package internally. Do not
        // leave a newly started hidden runtime permanently locked; the caller
        // receives the failure and may retry the gate.
        _busy = active == null || failure != null ? false : previousBusy;
      }
      if (error is PocketCapabilityException) rethrow;
      if (error is PocketPackageException) {
        throw PocketCapabilityException(error.code, error.message);
      }
      throw PocketCapabilityException('update_mount_failed', '$error');
    } finally {
      _packageAdmissionInFlight = false;
    }
  }

  Future<PocketPreparedPackage?> _verifiedFallback(
    PocketPreparedPackage failed,
  ) async {
    final updates = _updates;
    if (updates == null || _disposed) return null;
    try {
      final fallback = await updates.fallbackFor(failed);
      if (_downloadOnOpen &&
          fallback != null &&
          fallback.build < _embeddedBuild) {
        return null;
      }
      return fallback;
    } catch (error) {
      if (!_disposed) lastError = 'Package rollback rejected: $error';
      return null;
    }
  }

  void _failWithoutEmbedded(Object error) {
    if (_disposed) return;
    active = null;
    _candidate = null;
    failure = error;
    lastError = '$error';
    stage = 'error';
    ready = false;
    _busy = false;
    if (hasListeners) notifyListeners();
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

  Map<String, dynamic> runtimeInfo() {
    final info = <String, dynamic>{
      'appId': appId,
      // The bootstrap metadata still contributes ABI and host-facing facts,
      // but downloadOnOpen must not present its version/bytecode fields as an
      // executable embedded package.
      if (active == null && !_downloadOnOpen) ..._metadata,
      'runtimeAbi': controller.runtimeAbi ?? _metadata['runtimeAbi'],
      if (active != null)
        'entrySha256': active!.package.manifest.payload.entry.sha256,
      if (active != null && active!.package.manifest.payload.worker != null)
        'worker': active!.package.manifest.payload.worker,
      'entryFormat': 'quickjs-bytecode',
      'memory': memoryLimits.toJson(),
      'glassRenderer': ui.ImageFilter.isShaderFilterSupported
          ? 'refractive'
          : 'frosted',
      'hostSurfaces': ['glass', 'platformTexture'],
    };
    if (active != null) {
      info.addAll(<String, dynamic>{
        'version': active!.version,
        'build': active!.build,
        'source': 'verified-cache',
        'entryBytes': active!.package.manifest.payload.entry.size,
      });
    } else if (_downloadOnOpen) {
      info.addAll(const <String, dynamic>{
        'version': null,
        'build': null,
        'source': 'download-on-open',
      });
    } else {
      info.addAll(<String, dynamic>{
        'version': _embeddedVersion,
        'build': _embeddedBuild,
        'source': 'embedded',
        'entryBytes': _metadata['bytecodeBytes'],
      });
    }
    return info;
  }

  Future<Map<String, dynamic>> status() async {
    final versions = <Map<String, dynamic>>[
      if (!_downloadOnOpen)
        <String, dynamic>{
          'version': _embeddedVersion,
          'build': _embeddedBuild,
          'source': 'embedded',
          'active': active == null,
        },
      if (_updates != null)
        for (final version in await _updates!.listVersions()) version.toJson(),
    ];
    return <String, dynamic>{
      'configured': _updates != null,
      'stage': stage,
      'activeVersion': _downloadOnOpen
          ? active?.version
          : active?.version ?? _embeddedVersion,
      'activeBuild': _downloadOnOpen
          ? active?.build
          : active?.build ?? _embeddedBuild,
      'availableVersion': _candidate?.version,
      'preparedUpdate': _candidate?.toSummaryJson(),
      'versions': versions,
      'lastError': lastError,
    };
  }

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
    registry.registerRequest('runtime.performance', (params) {
      if (params.containsKey('context')) {
        final context = params['context'];
        if (context != null && context is! String) {
          throw const FormatException('Performance context must be a string');
        }
        performance.setContext(context as String?);
      }
      return performance.snapshot();
    });
    registry.registerRequest('plugins.list', (_) => plugins.manifest());
    registry.registerRequest('updates.status', (_) => status());
    registry.registerRequest('updates.check', (params) => _check(params));
    registry.registerRequest('updates.apply', (params) => _apply(params));
    registry.registerRequest('updates.rollback', (_) => _rollback());
    for (final provider in providers) {
      plugins.register(provider);
    }
    final manifest =
        package?.package.manifest.payload.guestManifest ?? _embeddedManifest;
    _memoryLimits = config.memoryLimits.admit(manifest.memoryLimits);
    final negotiated = plugins.negotiate(
      required: manifest.requiredCapabilities,
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    );
    _negotiatedCapabilities = negotiated;
    final granted = await plugins.activate(negotiated);
    // Disposal can race the asynchronous provider activation. The close path
    // owns the manager captured above; do not continue worker admission or
    // publish any bridge configuration after that lifecycle boundary.
    if (_disposed) return;
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
        limits: PocketWorkerLimits(
          // Workers are independent realms, not an escape from the app's
          // approved per-realm heap cap. Keep their smaller default budget.
          heapBytes: memoryLimits.heapLimitBytes == null
              ? 16 * 1024 * 1024
              : memoryLimits.heapLimitBytes!.clamp(64 * 1024, 16 * 1024 * 1024),
        ),
      ).program;
    } else if (manifest.requiredCapabilities.contains('runtime.worker')) {
      throw const FormatException(
        'Guest requires runtime.worker but has no worker descriptor',
      );
    }
    if (!_foregroundRequested) await plugins.deactivate(foregroundOnly: true);
  }

  bool _send(String method, Map<String, dynamic> params, {bool wake = true}) =>
      !_disposed && controller.send(method: method, params: params, wake: wake);

  void onEvent(PocketEvent event) {
    final host = _host;
    if (host != null) unawaited(host.handle(event));
  }

  void onPerformanceSample(PocketPerformanceSample sample) {
    if (_disposed) return;
    final json = sample.toJson();
    final longFrameEvents = performance.add(json);
    final snapshot = performance.snapshot();
    final eventOnly = sample.frames <= 0 || sample.durationMs <= 0;
    _send('runtime.performance.sample', {
      'sample': {...json, 'longFrameEvents': longFrameEvents},
      'eventOnly': eventOnly,
      'minFps': (snapshot['latest'] as Map?)?['minFps'],
      'recording': true,
    }, wake: !eventOnly);
  }

  void onReady(PocketViewController _) {
    _firstFrameReady = true;
    _startupTimer?.cancel();
    final recordingStarted = _pendingRecordingStartedStatus;
    _pendingRecordingStartedStatus = null;
    if (recordingStarted != null && !_disposed) {
      _send('diagnostics.recording.started', recordingStarted());
    }
    if (!_disposed) notifyListeners();
    if (!_foreground || _disposed) return;
    final mountedGeneration = generation;
    // A successful first frame and a short live-frame period precede promotion.
    _healthTimer = Timer(const Duration(seconds: 1), () async {
      if (_disposed || !_foreground || generation != mountedGeneration) return;
      try {
        final package = active;
        if (_downloadOnOpen && package == null) {
          throw StateError(
            'downloadOnOpen runtime cannot become healthy without a package',
          );
        }
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

  Future<Map<String, dynamic>> _check([
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    final updates = _requireUpdates();
    if (_busy || _packageAdmissionInFlight) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }
    final rawMode = params['mode'];
    final mode = switch (rawMode) {
      null || 'auto' => PocketUpdateMode.auto,
      'zip' || 'bundle' => PocketUpdateMode.zip,
      'granular' => PocketUpdateMode.granular,
      _ => throw PocketCapabilityException(
        'invalid_params',
        'Unsupported update mode: $rawMode',
      ),
    };
    final rawScope = params['scope'];
    final rawResource = params['resource'];
    final target = switch (rawScope) {
      null || 'all' => const PocketUpdateTarget.all(),
      'code' => const PocketUpdateTarget.codeOnly(),
      'resource' =>
        rawResource is String && rawResource.trim().isNotEmpty
            ? PocketUpdateTarget.singleResource(rawResource)
            : throw const PocketCapabilityException(
                'invalid_params',
                'Resource update scope requires a non-empty resource parameter',
              ),
      _ => throw PocketCapabilityException(
        'invalid_params',
        'Unsupported update scope: $rawScope',
      ),
    };
    _busy = true;
    _candidate = null;
    lastError = null;
    final token = _download = PocketCancellationToken();
    try {
      _candidate = await updates.prepare(
        cancellation: token,
        mountedPackage: active?.package,
        mode: mode,
        target: target,
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
    } on PocketCapabilityException catch (error) {
      stage = 'error';
      lastError = '$error';
      rethrow;
    } on PocketPackageException catch (error) {
      stage = 'error';
      lastError = '$error';
      throw PocketCapabilityException(error.code, error.message);
    } catch (error) {
      stage = 'error';
      lastError = '$error';
      rethrow;
    } finally {
      _busy = false;
      _download = null;
    }
  }

  Future<Map<String, dynamic>> _apply([
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    _requireUpdates();
    if (_busy || _packageAdmissionInFlight) {
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
    final hasExpectedVersion = params.containsKey('expectedVersion');
    final hasExpectedBuild = params.containsKey('expectedBuild');
    if (hasExpectedVersion != hasExpectedBuild) {
      throw const PocketCapabilityException(
        'invalid_params',
        'expectedVersion and expectedBuild must be provided together',
      );
    }
    if (hasExpectedVersion) {
      final expectedVersion = params['expectedVersion'];
      final expectedBuild = params['expectedBuild'];
      final validBuild =
          expectedBuild is num &&
          expectedBuild.isFinite &&
          expectedBuild >= 0 &&
          expectedBuild == expectedBuild.truncateToDouble();
      if (expectedVersion is! String ||
          expectedVersion.isEmpty ||
          !validBuild) {
        throw const PocketCapabilityException(
          'invalid_params',
          'expectedVersion must be a non-empty string and expectedBuild a non-negative integer',
        );
      }
      final expectedBuildInt = expectedBuild.toInt();
      if (next.version != expectedVersion || next.build != expectedBuildInt) {
        throw const PocketCapabilityException(
          'stale_update',
          'The prepared update changed before apply',
        );
      }
    }
    _busy = true;
    if (!next.needsActivation) {
      _packageAdmissionInFlight = true;
      // A check against the active package is a valid no-op. Re-admit the
      // cached package at the final trust boundary, but do not remount the
      // already healthy guest or emit updates.changed (which would cause an
      // automatic refresh client to check/apply the same package again).
      try {
        await _withAdmittedPackage(next, () {});
        if (!_disposed) {
          _candidate = null;
          stage = 'ready';
          notifyListeners();
        }
        return {'scheduled': false, 'version': next.version};
      } on PocketPackageException catch (error) {
        stage = 'error';
        lastError = '$error';
        throw PocketCapabilityException(error.code, error.message);
      } catch (error) {
        stage = 'error';
        lastError = '$error';
        rethrow;
      } finally {
        _packageAdmissionInFlight = false;
        _busy = false;
      }
    }
    // Allow the old guest to consume its response before disposing its runtime.
    _mountTimer = Timer(const Duration(milliseconds: 150), () => _mount(next));
    return {'scheduled': true, 'version': next.version};
  }

  Future<Map<String, dynamic>> _rollback() async {
    final updates = _requireUpdates();
    if (_busy || _packageAdmissionInFlight) {
      throw const PocketCapabilityException(
        'busy',
        'A package operation is in progress',
      );
    }
    _busy = true;
    _packageAdmissionInFlight = true;
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
      if (_downloadOnOpen && next == null) {
        throw const PocketCapabilityException(
          'rollback-missing',
          'No verified package is available for rollback',
        );
      }
      // The immutable embedded bundle is always a rollback target. Remove cache
      // pointers only after the embedded guest has started successfully.
      final embeddedFallback = _downloadOnOpen || next != null ? null : active;
      _mountTimer = Timer(
        const Duration(milliseconds: 150),
        () => _mount(
          next,
          resetCache: next == null,
          embeddedRollbackFallback: embeddedFallback,
        ),
      );
      _packageAdmissionInFlight = false;
      return {'scheduled': true, 'version': next?.version ?? 'embedded'};
    } catch (_) {
      _packageAdmissionInFlight = false;
      _busy = false;
      rethrow;
    }
  }

  bool _resetCacheOnHealth = false;
  // An explicit rollback to the immutable bundle must retain its verified
  // recovery target until the embedded guest completes the health window.
  PocketPreparedPackage? _embeddedRollbackFallback;

  Future<T> _withAdmittedPackage<T>(
    PocketPreparedPackage? package,
    FutureOr<T> Function() publish,
  ) {
    if (package == null) return Future<T>.sync(publish);
    if (package.build < _embeddedBuild) {
      return Future<T>.error(
        PocketPackageException(
          'Cached package build ${package.build} is below bootstrap build '
          '$_embeddedBuild',
          code: 'cache-build-floor',
        ),
      );
    }
    final updates = _updates;
    if (updates == null) {
      return Future<T>.error(
        StateError('No update verifier for cached package'),
      );
    }
    return updates.withVerifiedPrepared(package, publish);
  }

  Future<void> _prepareBeforeGenerationMount(
    PocketPreparedPackage? package,
    int targetGeneration,
  ) async {
    final hook = beforeGenerationMount;
    if (hook == null) return;
    final payloadHash = package == null
        ? null
        : sha256.convert(package.package.manifest.payloadBytes).toString();
    await hook(payloadHash, targetGeneration);
  }

  Future<void> _mount(
    PocketPreparedPackage? next, {
    bool resetCache = false,
    PocketPreparedPackage? embeddedRollbackFallback,
    bool restorePreviousOnFailure = true,
  }) {
    final existing = _mountOperation;
    final operation = existing == null
        ? _mountUnlocked(
            next,
            resetCache: resetCache,
            embeddedRollbackFallback: embeddedRollbackFallback,
            restorePreviousOnFailure: restorePreviousOnFailure,
          )
        : existing.then<void>(
            (_) => _mountUnlocked(
              next,
              resetCache: resetCache,
              embeddedRollbackFallback: embeddedRollbackFallback,
              restorePreviousOnFailure: restorePreviousOnFailure,
            ),
            onError: (Object _, StackTrace __) => _mountUnlocked(
              next,
              resetCache: resetCache,
              embeddedRollbackFallback: embeddedRollbackFallback,
              restorePreviousOnFailure: restorePreviousOnFailure,
            ),
          );
    late final Future<void> tracked;
    tracked = operation.then<void>(
      (_) {
        if (identical(_mountOperation, tracked)) _mountOperation = null;
      },
      onError: (Object _, StackTrace __) {
        if (identical(_mountOperation, tracked)) _mountOperation = null;
      },
    );
    _mountOperation = tracked;
    return operation;
  }

  Future<void> _mountUnlocked(
    PocketPreparedPackage? next, {
    bool resetCache = false,
    PocketPreparedPackage? embeddedRollbackFallback,
    bool restorePreviousOnFailure = true,
  }) async {
    if (_disposed) return;
    if (_downloadOnOpen && next == null) {
      _failWithoutEmbedded(
        StateError('downloadOnOpen runtime has no verified package to mount'),
      );
      return;
    }
    _healthTimer?.cancel();
    _startupTimer?.cancel();
    final previous = active;
    final targetGeneration = generation + 1;
    var generationAdvanced = false;
    try {
      await _withAdmittedPackage(next, () {});
      // Select and verify the next root catalog before advancing the session
      // generation. The old native runtime remains untouched until the
      // generation-bound facts are ready for the new PocketView instance.
      await _prepareBeforeGenerationMount(next, targetGeneration);
      // Invalidate old callbacks before awaiting plugin teardown or
      // registration.
      generation = targetGeneration;
      generationAdvanced = true;
      _firstFrameReady = false;
      await _configureBridge(next);
      await _withAdmittedPackage(next, () {
        if (_disposed) return;
        active = next;
        _resetCacheOnHealth = resetCache;
        _embeddedRollbackFallback = embeddedRollbackFallback;
        _candidate = null;
        stage = 'loading';
        notifyListeners();
        _watchStartup();
      });
    } catch (error) {
      lastError = '$error';
      if (_downloadOnOpen && (previous == null || !restorePreviousOnFailure)) {
        _failWithoutEmbedded(error);
        return;
      }
      try {
        await _withAdmittedPackage(previous, () {});
        await _configureBridge(previous);
        if (generationAdvanced) {
          await _prepareBeforeGenerationMount(previous, generation);
        }
        await _withAdmittedPackage(previous, () {
          if (_disposed) return;
          active = previous;
          stage = 'loading';
          notifyListeners();
          _watchStartup();
        });
      } catch (restoreError) {
        active = null;
        ready = false;
        _firstFrameReady = false;
        _candidate = null;
        _resetCacheOnHealth = false;
        _embeddedRollbackFallback = null;
        failure = restoreError;
        lastError = '$restoreError';
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
    final embeddedFallback = _downloadOnOpen ? null : _embeddedRollbackFallback;
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
        fallback = _downloadOnOpen
            ? await _verifiedFallback(failed)
            : await _updates!.fallbackFor(failed);
        if (fallback?.package.versionId == failed.package.versionId) {
          fallback = null;
        }
      } catch (_) {
        fallback = null;
      }
      if (_downloadOnOpen && fallback == null) {
        _failWithoutEmbedded(error);
        return;
      }
      await _mount(
        fallback,
        resetCache: fallback == null,
        // A recovery target failing admission must not restart the guest
        // whose runtime failure caused recovery in the first place.
        restorePreviousOnFailure: !_downloadOnOpen,
      );
    } finally {
      _recovering = false;
    }
  }

  PocketUpdateCoordinator _requireUpdates() {
    final updates = _updates;
    if (updates == null) {
      throw const PocketCapabilityException(
        'updates_not_configured',
        'Configure PocketAppConfig.updates with a signed manifest/index URL and trusted public key',
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
      if (_mountOperation != null) _mountOperation!,
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
