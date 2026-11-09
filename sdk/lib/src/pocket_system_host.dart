// This SDK host intentionally reuses the externally managed guest surface.
// ignore_for_file: invalid_use_of_visible_for_testing_member

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart' show PocketViewController;
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_flutter/src/pocket_memory_limits.dart';
import 'package:pocket_flutter/src/pocket_view.dart' show PocketViewCapture;

import 'pocket_app.dart' show PocketGuestSession, PocketGuestSessionState;
import 'pocket_bundled_application_catalog.dart';
import 'pocket_config.dart';
import 'pocket_host_config.dart';
import 'pocket_image_store.dart';
import 'pocket_startup_indicator.dart';
import 'package:pocket_flutter/src/pocket_compositor.dart';
import 'pocket_platform_data.dart';
import 'pocket_recordings.dart';
import 'pocket_session.dart';

const Duration _platformRequestTimeout = Duration(seconds: 30);

String _runtimeFailureCode(Object error, {String fallback = 'runtime_failed'}) {
  if (error is PocketCapabilityException) return error.code;
  final message = error.toString().toLowerCase();
  if (message.contains('memory_limits.') ||
      message.contains('out of memory') ||
      message.contains('allocation failed')) {
    return 'memory_limit_exceeded';
  }
  return fallback;
}

const int _maxPendingPlatformRequests = 64;
const String _systemInstanceId = 'system-ui';
const String _compositorSurfacesCapability = 'ui.compositor-surfaces';
const String _platformImagesCaptureCapability = 'platform.images.capture';
const String _platformImagesReadCapability = 'platform.images.read';
const String _platformImagesListCapability = 'platform.images.list';
const String _platformImagesRemoveCapability = 'platform.images.remove';
const int _maxPlatformImageWidth = PocketImageStore.maxWidth;
const int _maxPlatformImageHeight = PocketImageStore.maxHeight;
const int _maxPlatformImagePixels =
    _maxPlatformImageWidth * _maxPlatformImageHeight;
const List<String> _platformImageCapabilities = <String>[
  _platformImagesCaptureCapability,
  _platformImagesReadCapability,
  _platformImagesListCapability,
  _platformImagesRemoveCapability,
];
final RegExp _storageNamespacePattern = RegExp(
  r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
);

const List<String> _platformRequestCapabilities = <String>[
  'platform.apps.list',
  'platform.apps.open',
  'platform.apps.cancel',
  'platform.apps.return',
  'platform.apps.prewarm',
  'platform.storage.get',
  'platform.storage.set',
  'platform.storage.remove',
  'platform.storage.keys',
  'platform.storage.batch',
  'platform.messages.send',
  'platform.messages.receive',
];

const List<String> _systemRequestCapabilities = <String>[
  'system.runtime.configure',
  'system.runtime.create',
  'system.runtime.prepareOpen',
  'system.runtime.awaitFirstFrame',
  'system.runtime.destroy',
  'system.runtime.post',
  'system.runtime.respond',
  'system.storage.get',
  'system.storage.set',
  'system.storage.remove',
  'system.storage.keys',
  'system.storage.batch',
];

typedef PocketSystemHostCatalogLoader =
    Future<PocketSystemHostCatalog?> Function(String? rootPayloadSha256);

typedef PocketSystemHostSystemUIApprover =
    PocketAppConfig Function(PocketAppConfig config);

typedef PocketSystemHostApplicationApprover =
    PocketAppConfig Function(String appId, PocketAppConfig config);

typedef PocketSystemHostApplicationCatalogLoader =
    Future<PocketBundledApplicationCatalog> Function();

typedef PocketSystemHostSystemUIBuilder =
    PocketAppConfig Function(PocketBundledApplicationCatalog catalog);

typedef PocketSystemHostApplicationsBuilder =
    Map<String, PocketAppConfig> Function(
      PocketBundledApplicationCatalog catalog,
    );

typedef PocketSystemHostAppBuilder =
    Widget Function(BuildContext context, Widget child);

/// A verified, native-approved catalog selected for one signed root payload.
/// The loader must return a catalog whose [rootPayloadSha256] matches the
/// mounted root generation before the host installs its child registry.
final class PocketSystemHostCatalog {
  const PocketSystemHostCatalog({
    required this.systemUI,
    required this.applications,
    required this.rootPayloadSha256,
  });

  final PocketAppConfig systemUI;
  final Map<String, PocketAppConfig> applications;
  final String? rootPayloadSha256;
}

final class _SystemHostLoadResult<T> {
  const _SystemHostLoadResult(this.value, this.error);

  final T? value;
  final Object? error;
}

final class _SystemHostBootstrap {
  const _SystemHostBootstrap({required this.host, required this.catalog});

  final _SystemHostLoadResult<PocketHostConfig?> host;
  final _SystemHostLoadResult<PocketBundledApplicationCatalog> catalog;
}

final class _BundledCatalogAssetSource {
  _BundledCatalogAssetSource({
    required this.catalogAsset,
    required this.assetPrefix,
    required this.firstCompositorHandle,
    required this.lastCompositorHandle,
    required this.bundle,
    required Set<String> reservedAppIds,
  }) : reservedAppIds = Set<String>.unmodifiable(reservedAppIds);

  final String catalogAsset;
  final String assetPrefix;
  final int firstCompositorHandle;
  final int lastCompositorHandle;
  final AssetBundle? bundle;
  final Set<String> reservedAppIds;

  Future<PocketBundledApplicationCatalog> load() =>
      PocketBundledApplicationCatalog.loadFromBundle(
        catalogAsset,
        bundle: bundle,
        assetPrefix: assetPrefix,
        firstCompositorHandle: firstCompositorHandle,
        lastCompositorHandle: lastCompositorHandle,
        reservedAppIds: reservedAppIds,
      );

  @override
  bool operator ==(Object other) =>
      other is _BundledCatalogAssetSource &&
      catalogAsset == other.catalogAsset &&
      assetPrefix == other.assetPrefix &&
      firstCompositorHandle == other.firstCompositorHandle &&
      lastCompositorHandle == other.lastCompositorHandle &&
      identical(bundle, other.bundle) &&
      reservedAppIds.length == other.reservedAppIds.length &&
      reservedAppIds.containsAll(other.reservedAppIds);

  @override
  int get hashCode => Object.hash(
    catalogAsset,
    assetPrefix,
    firstCompositorHandle,
    lastCompositorHandle,
    identityHashCode(bundle),
    Object.hashAll(reservedAppIds.toList()..sort()),
  );
}

/// Generic Material app shell for a trusted Pocket System host.
///
/// Consumers supply their own catalog loader and native config builders. This
/// widget owns only bootstrap/error presentation and the local-versus-signed
/// host selection; it introduces no application IDs or capability policy.
final class PocketSystemHostApplication extends StatefulWidget {
  const PocketSystemHostApplication({
    super.key,
    required this.loadBundledApplications,
    required this.buildSystemUI,
    required this.buildApplications,
    this.loadHostConfig,
    this.hostConfigUrl,
    this.initialHostConfig,
    this.initialHostConfigError,
    this.initialBundledApplications,
    this.initialCatalogError,
    this.controller,
    this.recordings,
    this.approveSystemUI,
    this.approveApplication,
    this.appBuilder,
    this.onExit,
    this.showPerformanceOverlay = false,
    this.backgroundColor = const Color(0xFF000000),
  }) : _bundledCatalogAssetSource = null;

  /// Builds the standard shell configuration from one embedded app catalog.
  /// Native grants and host-selected input namespaces remain caller-owned.
  factory PocketSystemHostApplication.fromBundledAssets({
    Key? key,
    required String catalogAsset,
    required String assetPrefix,
    required int firstCompositorHandle,
    required int lastCompositorHandle,
    Set<String> reservedAppIds = const <String>{},
    AssetBundle? bundle,
    required PocketAppConfig systemUI,
    Map<String, PocketAppConfig> nativePolicies =
        const <String, PocketAppConfig>{},
    Set<String> keyboardInputAppIdPrefixes = const <String>{},
    Future<PocketHostConfig?> Function()? loadHostConfig,
    Uri? hostConfigUrl,
    PocketHostConfig? initialHostConfig,
    Object? initialHostConfigError,
    PocketBundledApplicationCatalog? initialBundledApplications,
    Object? initialCatalogError,
    PocketSystemHostController? controller,
    PocketRecordingLibrary? recordings,
    PocketSystemHostSystemUIApprover? approveSystemUI,
    PocketSystemHostApplicationApprover? approveApplication,
    PocketSystemHostAppBuilder? appBuilder,
    VoidCallback? onExit,
    bool showPerformanceOverlay = false,
    Color backgroundColor = const Color(0xFF000000),
  }) {
    final source = _BundledCatalogAssetSource(
      catalogAsset: catalogAsset,
      assetPrefix: assetPrefix,
      firstCompositorHandle: firstCompositorHandle,
      lastCompositorHandle: lastCompositorHandle,
      bundle: bundle,
      reservedAppIds: <String>{...reservedAppIds, systemUI.appId},
    );
    final inputPrefixes = Set<String>.unmodifiable(keyboardInputAppIdPrefixes);
    final policies = Map<String, PocketAppConfig>.unmodifiable(nativePolicies);
    PocketAppConfig buildSystemUI(PocketBundledApplicationCatalog catalog) =>
        systemUI.copyWith(
          compositorSurfaces: <String, int>{
            ...systemUI.compositorSurfaces,
            ...catalog.compositorSurfaces,
          },
        );
    Map<String, PocketAppConfig> buildApplications(
      PocketBundledApplicationCatalog catalog,
    ) {
      final configured = catalog.applicationsWithNativePolicies(
        nativePolicies: policies,
      );
      if (inputPrefixes.isEmpty) return configured;
      return Map<String, PocketAppConfig>.unmodifiable({
        for (final entry in configured.entries)
          entry.key: inputPrefixes.any(entry.key.startsWith)
              ? entry.value.copyWith(keyboardInputEnabled: true)
              : entry.value,
      });
    }

    return PocketSystemHostApplication._fromBundledAssets(
      key: key,
      source: source,
      buildSystemUI: buildSystemUI,
      buildApplications: buildApplications,
      loadHostConfig: loadHostConfig,
      hostConfigUrl: hostConfigUrl,
      initialHostConfig: initialHostConfig,
      initialHostConfigError: initialHostConfigError,
      initialBundledApplications: initialBundledApplications,
      initialCatalogError: initialCatalogError,
      controller: controller,
      recordings: recordings,
      approveSystemUI: approveSystemUI,
      approveApplication: approveApplication,
      appBuilder: appBuilder,
      onExit: onExit,
      showPerformanceOverlay: showPerformanceOverlay,
      backgroundColor: backgroundColor,
    );
  }

  PocketSystemHostApplication._fromBundledAssets({
    Key? key,
    required _BundledCatalogAssetSource source,
    required PocketSystemHostSystemUIBuilder buildSystemUI,
    required PocketSystemHostApplicationsBuilder buildApplications,
    Future<PocketHostConfig?> Function()? loadHostConfig,
    Uri? hostConfigUrl,
    PocketHostConfig? initialHostConfig,
    Object? initialHostConfigError,
    PocketBundledApplicationCatalog? initialBundledApplications,
    Object? initialCatalogError,
    PocketSystemHostController? controller,
    PocketRecordingLibrary? recordings,
    PocketSystemHostSystemUIApprover? approveSystemUI,
    PocketSystemHostApplicationApprover? approveApplication,
    PocketSystemHostAppBuilder? appBuilder,
    VoidCallback? onExit,
    bool showPerformanceOverlay = false,
    Color backgroundColor = const Color(0xFF000000),
  }) : loadHostConfig = loadHostConfig,
       hostConfigUrl = hostConfigUrl,
       loadBundledApplications = source.load,
       buildSystemUI = buildSystemUI,
       buildApplications = buildApplications,
       initialHostConfig = initialHostConfig,
       initialHostConfigError = initialHostConfigError,
       initialBundledApplications = initialBundledApplications,
       initialCatalogError = initialCatalogError,
       controller = controller,
       recordings = recordings,
       approveSystemUI = approveSystemUI,
       approveApplication = approveApplication,
       appBuilder = appBuilder,
       onExit = onExit,
       showPerformanceOverlay = showPerformanceOverlay,
       backgroundColor = backgroundColor,
       _bundledCatalogAssetSource = source,
       super(key: key);

  final Future<PocketHostConfig?> Function()? loadHostConfig;

  /// Runtime URL for a Debug/container route. The SDK owns this request and
  /// cancels it on exit. A custom [loadHostConfig] takes precedence and owns
  /// its own IO cancellation.
  final Uri? hostConfigUrl;
  final PocketSystemHostApplicationCatalogLoader loadBundledApplications;
  final PocketAppConfig Function(PocketBundledApplicationCatalog catalog)
  buildSystemUI;
  final PocketSystemHostApplicationsBuilder buildApplications;
  final PocketHostConfig? initialHostConfig;
  final Object? initialHostConfigError;
  final PocketBundledApplicationCatalog? initialBundledApplications;
  final Object? initialCatalogError;
  final PocketSystemHostController? controller;
  final PocketRecordingLibrary? recordings;
  final PocketSystemHostSystemUIApprover? approveSystemUI;
  final PocketSystemHostApplicationApprover? approveApplication;
  final PocketSystemHostAppBuilder? appBuilder;

  /// Leaves the remote container immediately. Cleanup continues in the
  /// background. Without a callback, an enclosing route is popped, or the
  /// bundled host is restored when this application is the root route.
  final VoidCallback? onExit;
  final bool showPerformanceOverlay;
  final Color backgroundColor;
  final _BundledCatalogAssetSource? _bundledCatalogAssetSource;

  @override
  State<PocketSystemHostApplication> createState() =>
      _PocketSystemHostApplicationState();
}

final class _PocketSystemHostApplicationState
    extends State<PocketSystemHostApplication> {
  late Future<_SystemHostBootstrap> _bootstrap;
  PocketHostLoadProgress? _hostConfigProgress;
  PocketCancellationToken _hostConfigProgressOwner = PocketCancellationToken();
  bool _remoteDismissed = false;

  @override
  void initState() {
    super.initState();
    _bootstrap = _loadBootstrap();
  }

  @override
  void didUpdateWidget(covariant PocketSystemHostApplication oldWidget) {
    super.didUpdateWidget(oldWidget);
    final catalogSourceChanged =
        oldWidget._bundledCatalogAssetSource != null ||
            widget._bundledCatalogAssetSource != null
        ? oldWidget._bundledCatalogAssetSource !=
              widget._bundledCatalogAssetSource
        : oldWidget.loadBundledApplications != widget.loadBundledApplications;
    if (oldWidget.loadHostConfig != widget.loadHostConfig ||
        oldWidget.hostConfigUrl != widget.hostConfigUrl ||
        catalogSourceChanged ||
        oldWidget.initialHostConfig != widget.initialHostConfig ||
        oldWidget.initialHostConfigError != widget.initialHostConfigError ||
        oldWidget.initialBundledApplications !=
            widget.initialBundledApplications ||
        oldWidget.initialCatalogError != widget.initialCatalogError) {
      _hostConfigProgress = null;
      _remoteDismissed = false;
      _bootstrap = _loadBootstrap();
    }
  }

  Future<_SystemHostBootstrap> _loadBootstrap({bool localOnly = false}) async {
    _hostConfigProgressOwner.cancel();
    final progressOwner = PocketCancellationToken();
    _hostConfigProgressOwner = progressOwner;
    final hostFuture = localOnly
        ? Future.value(
            const _SystemHostLoadResult<PocketHostConfig?>(null, null),
          )
        : _loadHostConfig(progressOwner);
    final catalogFuture = _loadCatalog();
    final host = await hostFuture;
    if (mounted &&
        identical(_hostConfigProgressOwner, progressOwner) &&
        _hostConfigProgress != null) {
      setState(() => _hostConfigProgress = null);
    }
    final catalog = await catalogFuture;
    return _SystemHostBootstrap(host: host, catalog: catalog);
  }

  void _onHostConfigProgress(
    PocketCancellationToken progressOwner,
    PocketHostLoadProgress progress,
  ) {
    if (!mounted ||
        progressOwner.isCancelled ||
        !identical(_hostConfigProgressOwner, progressOwner)) {
      return;
    }
    setState(() => _hostConfigProgress = progress);
  }

  Future<_SystemHostLoadResult<PocketHostConfig?>> _loadHostConfig(
    PocketCancellationToken progressOwner,
  ) async {
    if (widget.initialHostConfigError != null) {
      return _SystemHostLoadResult<PocketHostConfig?>(
        null,
        widget.initialHostConfigError,
      );
    }
    if (widget.initialHostConfig != null) {
      return _SystemHostLoadResult<PocketHostConfig?>(
        widget.initialHostConfig,
        null,
      );
    }
    try {
      final url = widget.hostConfigUrl;
      final config = widget.loadHostConfig != null
          ? await widget.loadHostConfig!()
          : url != null
          ? await PocketHostConfig.load(
              url,
              cancellation: progressOwner,
              onProgress: (progress) =>
                  _onHostConfigProgress(progressOwner, progress),
            )
          : await PocketHostConfig.loadFromEnvironment(
              cancellation: progressOwner,
              onProgress: (progress) =>
                  _onHostConfigProgress(progressOwner, progress),
            );
      progressOwner.throwIfCancelled();
      return _SystemHostLoadResult<PocketHostConfig?>(config, null);
    } catch (error) {
      return _SystemHostLoadResult<PocketHostConfig?>(null, error);
    }
  }

  void _exitRemote() {
    if (_remoteDismissed) return;
    _remoteDismissed = true;
    _hostConfigProgressOwner.cancel();
    final navigator = Navigator.maybeOf(context);
    final hasOuterExit =
        widget.onExit != null || (navigator?.canPop() ?? false);
    setState(() {
      _hostConfigProgress = null;
      if (!hasOuterExit) _bootstrap = _loadBootstrap(localOnly: true);
    });
    // Navigation must never await network cancellation, verification or
    // native plugin teardown. Removing the remote host disposes its session.
    if (widget.onExit case final exit?) {
      exit();
    } else if (navigator?.canPop() ?? false) {
      navigator!.pop();
    }
  }

  @override
  void dispose() {
    _hostConfigProgressOwner.cancel();
    super.dispose();
  }

  Future<_SystemHostLoadResult<PocketBundledApplicationCatalog>>
  _loadCatalog() async {
    if (widget.initialCatalogError != null) {
      return _SystemHostLoadResult<PocketBundledApplicationCatalog>(
        null,
        widget.initialCatalogError,
      );
    }
    if (widget.initialBundledApplications != null) {
      return _SystemHostLoadResult<PocketBundledApplicationCatalog>(
        widget.initialBundledApplications,
        null,
      );
    }
    try {
      return _SystemHostLoadResult<PocketBundledApplicationCatalog>(
        await widget.loadBundledApplications(),
        null,
      );
    } catch (error) {
      return _SystemHostLoadResult<PocketBundledApplicationCatalog>(
        null,
        error,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    // A popped route can remain mounted during its exit animation. Drop the
    // remote surface now, rather than waiting for that animation to dispose it.
    if (_remoteDismissed && _hostConfigProgressOwner.isCancelled) {
      return const SizedBox.shrink();
    }
    return FutureBuilder<_SystemHostBootstrap>(
      future: _bootstrap,
      builder: (context, snapshot) {
        final bootstrap = snapshot.connectionState == ConnectionState.done
            ? snapshot.data
            : null;
        final catalog =
            bootstrap?.catalog.value ?? PocketBundledApplicationCatalog.empty;
        final error = bootstrap?.host.error ?? bootstrap?.catalog.error;
        final remoteEntry =
            widget.loadHostConfig != null ||
            widget.hostConfigUrl != null ||
            widget.initialHostConfig != null ||
            widget.initialHostConfigError != null ||
            const String.fromEnvironment('POCKET_HOST_CONFIG_URL').isNotEmpty;
        final canExit =
            !_remoteDismissed &&
            (bootstrap?.host.value != null ||
                (bootstrap == null && remoteEntry) ||
                (error != null && remoteEntry));
        Widget loadingError(Object cause) => Center(
          child: SelectableText(
            'Pocket 宿主配置加载失败：$cause',
            style: TextStyle(
              color: widget.backgroundColor.computeLuminance() > 0.179
                  ? Colors.black
                  : Colors.white,
            ),
          ),
        );
        Widget body;
        if (bootstrap == null) {
          final background = widget.backgroundColor;
          body = PocketStartupIndicator(
            stage: _hostConfigProgress?.stage ?? 'initializing',
            downloadedBytes: _hostConfigProgress?.downloadedBytes,
            totalBytes: _hostConfigProgress?.totalBytes,
            foregroundColor: background.computeLuminance() > 0.179
                ? Colors.black
                : Colors.white,
          );
        } else if (error != null) {
          body = loadingError(error);
        } else {
          try {
            final systemUI = widget.buildSystemUI(catalog);
            final applications = widget.buildApplications(catalog);
            final remote = bootstrap.host.value;
            body = remote == null
                ? PocketSystemHost(
                    key: ObjectKey(_hostConfigProgressOwner),
                    systemUI: systemUI,
                    applications: applications,
                    controller: widget.controller,
                    recordings: widget.recordings,
                  )
                : PocketSystemHost.fromHostConfig(
                    key: ObjectKey(_hostConfigProgressOwner),
                    config: remote,
                    controller: widget.controller,
                    recordings: widget.recordings,
                    approveSystemUI:
                        widget.approveSystemUI ??
                        ((app) => app.withNativePolicy(
                          applications[app.appId] ?? systemUI,
                        )),
                    approveApplication:
                        widget.approveApplication ??
                        ((id, app) => app.withNativePolicy(
                          applications[id] ?? PocketAppConfig(appId: id),
                        )),
                  );
          } catch (cause) {
            body = loadingError(cause);
          }
        }
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          showPerformanceOverlay: widget.showPerformanceOverlay,
          builder: (context, child) =>
              widget.appBuilder?.call(
                context,
                child ?? const SizedBox.shrink(),
              ) ??
              child ??
              const SizedBox.shrink(),
          home: CallbackShortcuts(
            bindings: {
              if (canExit)
                const SingleActivator(LogicalKeyboardKey.escape): _exitRemote,
            },
            child: Focus(
              autofocus: true,
              child: PopScope(
                canPop: !canExit,
                onPopInvokedWithResult: (didPop, _) {
                  if (!didPop && canExit) _exitRemote();
                },
                child: Scaffold(
                  appBar: canExit
                      ? AppBar(
                          backgroundColor: widget.backgroundColor,
                          foregroundColor:
                              widget.backgroundColor.computeLuminance() > 0.179
                              ? Colors.black
                              : Colors.white,
                          leading: IconButton(
                            key: const ValueKey('pocket-container-exit'),
                            tooltip: '返回退出',
                            icon: const Icon(Icons.arrow_back),
                            onPressed: _exitRemote,
                          ),
                          title: const Text('远程容器'),
                        )
                      : null,
                  backgroundColor: bootstrap == null || error != null
                      ? widget.backgroundColor
                      : null,
                  body: body,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

final class _PendingSystemHostCatalog {
  const _PendingSystemHostCatalog({
    required this.generation,
    required this.catalog,
  });

  final int generation;
  final PocketSystemHostCatalog catalog;
}

/// Flutter's thin runtime surface for a trusted SystemUI and guest apps.
///
/// The consuming application owns the root MaterialApp. SystemUI emits child
/// surfaces into its ordinary DrawOps tree; this widget resolves those slots
/// to independent resident Pocket sessions.
final class PocketSystemHost extends StatefulWidget {
  const PocketSystemHost({
    super.key,
    required this.systemUI,
    required this.applications,
    this.maxInstances = 8,
    this.controller,
    this.recordings,
    this.catalogLoader,
    this.backgroundColor = const Color(0xFF000000),
  });

  /// Construct the host from one bootstrap document.
  ///
  /// [PocketHostConfig.load] is intentionally performed before `runApp` (or
  /// by a host-owned loading screen). Once constructed, this is the exact same
  /// SystemHost and signed `downloadOnOpen` flow as the explicit constructor;
  /// the factory only removes duplicate child URL/configuration inputs.
  factory PocketSystemHost.fromHostConfig({
    Key? key,
    required PocketHostConfig config,
    int maxInstances = 8,
    PocketSystemHostController? controller,
    PocketRecordingLibrary? recordings,
    PocketSystemHostSystemUIApprover? approveSystemUI,
    PocketSystemHostApplicationApprover? approveApplication,
    Future<PocketHostConfig?> Function(String? rootPayloadSha256)?
    reloadHostConfig,
    Color backgroundColor = const Color(0xFF000000),
  }) {
    PocketAppConfig approveRoot(PocketAppConfig value) =>
        approveSystemUI?.call(value) ?? value;
    PocketAppConfig approveChild(String appId, PocketAppConfig value) =>
        approveApplication?.call(appId, value) ?? value;

    PocketSystemHostCatalog approvedCatalog(PocketHostConfig value) {
      final applications = <String, PocketAppConfig>{};
      for (final entry in value.applications.entries) {
        applications[entry.key] = approveChild(entry.key, entry.value);
      }
      return PocketSystemHostCatalog(
        systemUI: approveRoot(value.systemUI),
        applications: Map<String, PocketAppConfig>.unmodifiable(applications),
        rootPayloadSha256: value.rootPayloadSha256,
      );
    }

    final initial = approvedCatalog(config);
    final reload =
        reloadHostConfig ??
        (config.catalog.isEmpty
            ? null
            : (String? rootPayloadSha256) async {
                // A generation carrying the same signed root can reuse the
                // already verified descriptor. Otherwise the single source
                // URL is fetched again and its immutable version record is
                // selected by the mounted payload hash.
                if (rootPayloadSha256 != null &&
                    config.rootPayloadSha256?.toLowerCase() ==
                        rootPayloadSha256.toLowerCase()) {
                  return config;
                }
                return PocketHostConfig.load(
                  config.source,
                  requiredRootPayloadSha256: rootPayloadSha256,
                );
              });
    final loader = reload == null
        ? null
        : (String? rootPayloadSha256) async {
            final next = await reload(rootPayloadSha256);
            if (next == null) return null;
            return approvedCatalog(next);
          };
    return PocketSystemHost(
      key: key,
      systemUI: initial.systemUI,
      applications: initial.applications,
      maxInstances: maxInstances,
      controller: controller,
      recordings: recordings,
      catalogLoader: loader,
      backgroundColor: backgroundColor,
    );
  }

  /// The trusted host-selected SystemUI package and authorization boundary.
  final PocketAppConfig systemUI;

  /// Host-approved package configurations indexed by their exact app ID.
  /// Guest input can select an app ID from this map, never an asset path.
  final Map<String, PocketAppConfig> applications;

  /// Maximum live sessions, including the fixed SystemUI session.
  /// This is a hard resource bound; it never evicts an instance.
  final int maxInstances;

  /// Optional fact-only view of the runtime instances for host integrations.
  final PocketSystemHostController? controller;

  /// Explicit bounded debug recording for every native guest generation.
  /// Only SystemUI receives the optional export/replay diagnostic controls.
  final PocketRecordingLibrary? recordings;

  /// Optional signed-root catalog reload boundary. The loader runs at the
  /// native session's pre-mount boundary and is also reused by the
  /// SystemUI `runtime.configure` gate. It must return a catalog for the
  /// supplied root payload hash; the host installs its child registry
  /// atomically only after that match is verified.
  final PocketSystemHostCatalogLoader? catalogLoader;

  /// Opaque root fill for the SystemUI surface, including startup and error
  /// states. Child compositor sessions stay transparent and reveal this fill.
  final Color backgroundColor;

  @override
  State<PocketSystemHost> createState() => _PocketSystemHostState();
}

/// Read-only runtime facts for embedding apps and integration tests.
///
/// It deliberately exposes no app selection, stack, result-token, or eviction
/// policy. Those decisions belong to SystemUI JavaScript.
final class PocketSystemHostController extends ChangeNotifier {
  PocketSystemHostController();

  _PocketSystemHostState? _owner;
  List<PocketSystemInstanceSnapshot> _instances =
      const <PocketSystemInstanceSnapshot>[];

  List<PocketSystemInstanceSnapshot> get instances => _instances;

  void _attach(_PocketSystemHostState owner) {
    if (_owner != null && !identical(_owner, owner)) {
      throw StateError('PocketSystemHostController is already attached');
    }
    _owner = owner;
  }

  void _detach(_PocketSystemHostState owner) {
    if (!identical(_owner, owner)) return;
    _owner = null;
    _publish(const <PocketSystemInstanceSnapshot>[]);
  }

  void _publish(
    List<PocketSystemInstanceSnapshot> next, {
    bool sessionChanged = false,
  }) {
    // The session reference also exposes live failure/update facts. Preserve
    // its notifications even when the immutable snapshot fields are equal.
    if (!sessionChanged && _instances.length == next.length) {
      var unchanged = true;
      for (var index = 0; index < next.length; index++) {
        if (!_instances[index]._sameFacts(next[index])) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return;
    }
    _instances = List<PocketSystemInstanceSnapshot>.unmodifiable(next);
    notifyListeners();
  }
}

/// An immutable snapshot of one native Pocket session.
@immutable
final class PocketSystemInstanceSnapshot {
  const PocketSystemInstanceSnapshot({
    required this.instanceId,
    required this.appId,
    required this.session,
    required this.firstFrame,
    required this.generation,
    required this.isSystemUI,
    required this.ready,
    required this.firstFrameReady,
    required this.foreground,
    required this.isPresented,
    required this.compositorFocused,
  });

  final String instanceId;
  final String appId;
  final PocketSession session;
  final Future<void>? firstFrame;
  final int generation;
  final bool isSystemUI;
  final bool ready;
  final bool firstFrameReady;
  final bool foreground;

  /// Whether this runtime has a compositor presentation. The resident
  /// SystemUI is the compositor root and remains presented beneath child
  /// surfaces; child runtimes are presented only while their visible slot has
  /// a non-empty clip. This is not a topmost/foreground indicator.
  final bool isPresented;
  final bool compositorFocused;

  bool _sameFacts(PocketSystemInstanceSnapshot other) =>
      instanceId == other.instanceId &&
      appId == other.appId &&
      identical(session, other.session) &&
      identical(firstFrame, other.firstFrame) &&
      generation == other.generation &&
      isSystemUI == other.isSystemUI &&
      ready == other.ready &&
      firstFrameReady == other.firstFrameReady &&
      foreground == other.foreground &&
      isPresented == other.isPresented &&
      compositorFocused == other.compositorFocused;
}

final class _PocketSystemHostState extends State<PocketSystemHost>
    with WidgetsBindingObserver {
  late PocketSystemHostController _controller;
  late final PocketRecordingLibrary? _recordings;
  late final _RuntimeInstance _systemUIInstance;
  final LinkedHashMap<String, _RuntimeInstance> _applications =
      LinkedHashMap<String, _RuntimeInstance>();
  final Map<String, PocketAppConfig> _trustedApplications =
      <String, PocketAppConfig>{};
  final Map<int, String> _surfaceAppIds = <int, String>{};
  final Map<String, int> _surfaceHandles = <String, int>{};
  final Map<String, _PendingPlatformRequest> _pendingRequests =
      <String, _PendingPlatformRequest>{};

  Future<void>? _configurationFuture;
  int? _configurationFutureGeneration;
  String? _configurationSignature;
  Future<void>? _catalogFuture;
  int? _catalogFutureGeneration;
  int? _catalogGeneration;
  _PendingSystemHostCatalog? _pendingCatalog;
  bool _catalogReady = true;
  Future<PocketPlatformData>? _platformDataFuture;
  PocketPlatformData? _platformData;
  Future<PocketImageStore>? _imageStoreFuture;
  PocketImageStore? _imageStore;
  AppLifecycleState? _lifecycleState;
  int _nextInstanceId = 0;
  int _nextRequestId = 0;
  int _systemUIGeneration = 0;
  bool _disposed = false;

  bool get _lifecycleResumed =>
      _lifecycleState == null || _lifecycleState == AppLifecycleState.resumed;

  // A signed root can advance its PocketSession generation while the bridge
  // is still being reconfigured, before the generation listener commits the
  // verified catalog. Do not let a transient rebuild create a PocketView with
  // the previous compositor map; native registration is strictly pre-load.
  bool get _catalogMatchesMountedGeneration =>
      widget.catalogLoader == null ||
      (_catalogReady &&
          _catalogGeneration != null &&
          _catalogGeneration == _systemUIInstance.session.generation);

  @override
  void initState() {
    super.initState();
    _validateHostConfiguration(widget.systemUI, widget.applications);
    _catalogReady = widget.catalogLoader == null;
    _trustedApplications.addAll(widget.applications);
    _surfaceAppIds.addEntries(
      widget.systemUI.compositorSurfaces.entries.map(
        (entry) => MapEntry<int, String>(entry.value, entry.key),
      ),
    );
    _surfaceHandles.addAll(widget.systemUI.compositorSurfaces);
    _lifecycleState = WidgetsBinding.instance.lifecycleState;
    WidgetsBinding.instance.addObserver(this);

    _controller = widget.controller ?? PocketSystemHostController();
    _controller._attach(this);

    _recordings =
        widget.recordings ??
        (widget.systemUI.recordingFactory == null
            ? PocketRecordingLibrary()
            : null);

    final rootConfig =
        _recordings?.attach(widget.systemUI, controls: true) ?? widget.systemUI;
    final systemConfig = _ensureSystemCaps(rootConfig)
        .withPlugins(<PocketPluginFactory>[
          ...rootConfig.pluginFactories,
          (_) => _SystemRuntimePlugin(
            this,
            widget.systemUI.appId,
            _systemUIInstance.session.generation,
          ),
          (_) => _PlatformProxyPlugin(
            this,
            _systemUIInstance,
            _systemUIInstance.session.generation,
          ),
        ]);
    _systemUIInstance = _RuntimeInstance(
      instanceId: _systemInstanceId,
      appId: widget.systemUI.appId,
      config: systemConfig,
      isSystemUI: true,
      ownerGeneration: 0,
    );
    _systemUIInstance.session = PocketSession(
      config: systemConfig,
      beforeGenerationMount: widget.catalogLoader == null
          ? null
          : _prepareSystemUIGeneration,
    );
    _systemUIGeneration = _systemUIInstance.session.generation;
    // A fixed-index bootstrap may advance between Flutter loading the host
    // document and the signed root mount. Dynamic hosts must therefore resolve
    // the catalog once more at generation 0 against the actually mounted
    // payload. Explicit constructor users keep their historical static map.
    _catalogGeneration = widget.catalogLoader == null
        ? _systemUIGeneration
        : null;
    _systemUIInstance.observedGeneration = _systemUIGeneration;
    _systemUIInstance.firstFrame = Completer<void>();
    unawaited(_systemUIInstance.firstFrame!.future.catchError((Object _) {}));
    _systemUIInstance.session.addListener(_systemUIChanged);
    unawaited(
      _systemUIInstance.session.initialize().catchError((Object error) {
        _systemUIInstance.startupError = error;
        final firstFrame = _systemUIInstance.firstFrame;
        if (firstFrame != null && !firstFrame.isCompleted) {
          firstFrame.completeError(error);
        }
        _publishFacts(sessionChanged: true);
      }),
    );
    _publishFacts();
  }

  @override
  void didUpdateWidget(covariant PocketSystemHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    _validateHostConfiguration(widget.systemUI, widget.applications);
    if (oldWidget.systemUI != widget.systemUI ||
        !_sameApplications(oldWidget.applications, widget.applications) ||
        oldWidget.maxInstances != widget.maxInstances) {
      throw StateError(
        'PocketSystemHost trust configuration is fixed for its mounted '
        'lifetime; remount it with a new key to replace it',
      );
    }
    if (!identical(oldWidget.recordings, widget.recordings)) {
      throw StateError(
        'Remount PocketSystemHost to change its recording library',
      );
    }
    if (!identical(oldWidget.controller, widget.controller)) {
      _controller._detach(this);
      _controller = widget.controller ?? PocketSystemHostController();
      _controller._attach(this);
      _publishFacts();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _lifecycleState = state;
    for (final instance in _applications.values) {
      _applyForeground(instance);
    }
    _publishFacts();
  }

  @override
  void didHaveMemoryPressure() {
    final root = _systemUIInstance;
    if (!_isCurrent(root) ||
        !root.firstFrameReady ||
        root.session.failure != null ||
        !_catalogMatchesMountedGeneration) {
      return;
    }
    root.session.controller.send(
      method: 'system.runtime.memoryPressure',
      params: <String, dynamic>{'generation': root.session.generation},
    );
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _systemUIInstance.session.removeListener(_systemUIChanged);
    for (final pending in _pendingRequests.values.toList(growable: false)) {
      _finishPendingError(
        pending,
        const PocketCapabilityException('host_closed', 'System host closed'),
      );
    }
    _pendingRequests.clear();
    for (final instance in _applications.values.toList(growable: false)) {
      _closeInstance(instance, removeFromTree: false);
    }
    unawaited(_systemUIInstance.session.close().catchError((Object _) {}));
    final dataFuture = _platformDataFuture;
    if (dataFuture != null) {
      unawaited(
        dataFuture.then<void>((data) => data.close()).catchError((Object _) {}),
      );
    }
    final imageFuture = _imageStoreFuture;
    if (imageFuture != null) {
      unawaited(
        imageFuture
            .then<void>((store) => store.close())
            .catchError((Object _) {}),
      );
    }
    _controller._detach(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_catalogMatchesMountedGeneration) {
      return ColoredBox(color: widget.backgroundColor);
    }
    return PocketGuestSession(
      config: _systemUIInstance.config,
      session: _systemUIInstance.session,
      backgroundColor: widget.backgroundColor,
      onFirstFrame: () => _onFirstFrame(_systemUIInstance),
      hostSurfaceBuilder: _buildCompositorSurface,
      hostSurfaceResidents: <int>{
        for (final instance in _applications.values)
          if (_surfaceHandles.containsKey(instance.appId))
            _surfaceHandles[instance.appId]!,
      },
    );
  }

  Widget? _buildCompositorSurface(PocketCompositorSlot slot) {
    if (!_catalogMatchesMountedGeneration) return null;
    final appId = _surfaceAppIds[slot.surfaceHandle];
    if (appId == null) return null;
    _RuntimeInstance? instance;
    for (final candidate in _applications.values) {
      if (candidate.appId == appId) {
        instance = candidate;
        break;
      }
    }
    if (instance == null || !_isCurrent(instance)) return null;
    _observeCompositorSlot(instance, slot);
    return PocketGuestSession(
      key: instance.guestKey,
      config: instance.config,
      session: instance.session,
      inputEnabled: slot.visible && slot.focused,
      enableSceneCapture: instance.session.hasConfiguredCapability(
        _platformImagesCaptureCapability,
      ),
      geometryRevision: instance.compositorGeometryRevision,
      compositorBounds: slot.bounds,
      compositorViewport: slot.logicalViewport,
      preserveCompositorDisplayGeometry: slot.preserveDisplayGeometry,
      onFirstFrame: () => _onFirstFrame(instance!),
    );
  }

  void _observeCompositorSlot(
    _RuntimeInstance instance,
    PocketCompositorSlot slot,
  ) {
    final visible = slot.visible && !slot.visibleClip.isEmpty;
    final focused = visible && slot.focused;
    final geometryChanged =
        instance.compositorBounds != slot.bounds ||
        instance.compositorVisibleClip != slot.visibleClip ||
        instance.compositorLogicalViewport != slot.logicalViewport;
    if (!geometryChanged &&
        instance.compositorVisible == visible &&
        instance.compositorFocused == focused) {
      return;
    }
    final visibilityChanged = instance.compositorVisible != visible;
    if (geometryChanged) {
      // A child PocketView's RenderBox can move without changing constraints.
      // Carry the physical slot and logical parent viewport so fullscreen
      // compositor children can keep environmental display facts anchored
      // while their bounds animate. Smaller embedded surfaces continue using
      // their physical intersection.
      instance.compositorGeometryRevision++;
      instance.compositorBounds = slot.bounds;
      instance.compositorVisibleClip = slot.visibleClip;
      instance.compositorLogicalViewport = slot.logicalViewport;
    }
    instance.compositorVisible = visible;
    instance.compositorFocused = focused;
    if (visible) {
      _checkFirstVisibleFrame(instance);
    }
    final generation = instance.session.generation;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_isCurrent(instance) ||
          instance.session.generation != generation ||
          instance.compositorVisible != visible) {
        return;
      }
      if (visibilityChanged) _applyForeground(instance);
      _publishFacts();
    });
  }

  _RuntimeInstance? _instanceFor(String instanceId) {
    if (instanceId == _systemInstanceId) return _systemUIInstance;
    return _applications[instanceId];
  }

  void _validateHostConfiguration(
    PocketAppConfig systemUI,
    Map<String, PocketAppConfig> applications,
  ) {
    if (widget.maxInstances < 1) {
      throw ArgumentError.value(
        widget.maxInstances,
        'maxInstances',
        'must be at least one for the resident SystemUI instance',
      );
    }
    systemUI.validate();
    if (applications.containsKey(systemUI.appId)) {
      throw ArgumentError.value(
        systemUI.appId,
        'applications',
        'must not contain the trusted SystemUI app ID',
      );
    }
    for (final appId in systemUI.compositorSurfaces.keys) {
      if (!applications.containsKey(appId)) {
        throw ArgumentError.value(
          appId,
          'systemUI.compositorSurfaces',
          'registry keys must be trusted child app IDs',
        );
      }
    }
    for (final entry in applications.entries) {
      entry.value.validate();
      if (entry.key != entry.value.appId) {
        throw ArgumentError.value(
          entry.key,
          'applications',
          'map keys must match each PocketAppConfig.appId',
        );
      }
      if (entry.value.compositorSurfaces.isNotEmpty) {
        throw ArgumentError.value(
          entry.key,
          'applications',
          'only the trusted SystemUI config may supply the compositor registry',
        );
      }
      if (entry.value.additionalCapabilities.contains(
        _compositorSurfacesCapability,
      )) {
        throw ArgumentError.value(
          entry.key,
          'applications',
          'only the trusted SystemUI receives the compositor capability',
        );
      }
    }
  }

  bool _sameApplications(
    Map<String, PocketAppConfig> left,
    Map<String, PocketAppConfig> right,
  ) {
    if (left.length != right.length) return false;
    for (final entry in left.entries) {
      if (right[entry.key] != entry.value) return false;
    }
    return true;
  }

  Future<Object?> _handleSystemCapability(
    String trustedSystemAppId,
    int ownerGeneration,
    String capability,
    Map<String, dynamic> params,
  ) async {
    if (_systemUIInstance.session.failure != null) {
      throw const PocketCapabilityException(
        'system_ui_failed',
        'SystemUI owner has failed',
      );
    }
    if (_disposed ||
        trustedSystemAppId != widget.systemUI.appId ||
        _systemUIInstance.session.appId != trustedSystemAppId ||
        _systemUIInstance.instanceId != _systemInstanceId ||
        ownerGeneration != _systemUIGeneration) {
      throw const PocketCapabilityException(
        'system_context_denied',
        'System capability is restricted to the trusted SystemUI instance',
      );
    }
    return await switch (capability) {
      'system.runtime.configure' => _configure(params, ownerGeneration),
      'system.runtime.create' => _create(params, ownerGeneration),
      'system.runtime.prepareOpen' => _prepareOpen(params, ownerGeneration),
      'system.runtime.awaitFirstFrame' => _awaitFirstFrame(params),
      'system.runtime.destroy' => _destroy(params),
      'system.runtime.post' => _post(params),
      'system.runtime.respond' => _respond(params),
      'system.storage.get' => _storageGet(params),
      'system.storage.set' => _storageSet(params),
      'system.storage.remove' => _storageRemove(params),
      'system.storage.keys' => _storageKeys(params),
      'system.storage.batch' => _storageBatch(params),
      _ => throw const PocketCapabilityException(
        'capability_unavailable',
        'System capability is unavailable',
      ),
    };
  }

  Future<Object?> _configure(
    Map<String, dynamic> params,
    int ownerGeneration,
  ) async {
    _ensureOwnerGeneration(ownerGeneration);
    final systemAppId = _requiredString(params, 'systemUI');
    if (systemAppId != widget.systemUI.appId) {
      throw const PocketCapabilityException(
        'system_ui_mismatch',
        'Configured SystemUI does not match the trusted host package',
      );
    }
    await _ensureCatalogForGeneration(ownerGeneration);
    _ensureOwnerGeneration(ownerGeneration);
    final grants = _parseGrants(params['grants']);
    final signature = jsonEncode(<Object?>[
      for (final grant
          in grants.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))
        <Object?>[grant.key, grant.value.toList()..sort()],
    ]);

    final configured = _configurationSignature;
    if (configured != null) {
      if (configured != signature) {
        throw const PocketCapabilityException(
          'registration_conflict',
          'System storage grants are already configured differently',
        );
      }
      return <String, Object?>{
        'systemInstanceId': _systemInstanceId,
        'generation': _systemUIInstance.session.generation,
      };
    }
    final inFlight = _configurationFutureGeneration == ownerGeneration
        ? _configurationFuture
        : null;
    if (inFlight != null) {
      await inFlight;
      _ensureOwnerGeneration(ownerGeneration);
      if (_configurationSignature != signature) {
        throw const PocketCapabilityException(
          'registration_conflict',
          'System storage grants are already configured differently',
        );
      }
      return <String, Object?>{
        'systemInstanceId': _systemInstanceId,
        'generation': _systemUIInstance.session.generation,
      };
    }

    final future = _configureStorage(grants, signature, ownerGeneration);
    _configurationFuture = future;
    _configurationFutureGeneration = ownerGeneration;
    try {
      await future;
      _ensureOwnerGeneration(ownerGeneration);
    } finally {
      if (identical(_configurationFuture, future)) {
        _configurationFuture = null;
        _configurationFutureGeneration = null;
      }
    }
    return <String, Object?>{
      'systemInstanceId': _systemInstanceId,
      'generation': _systemUIInstance.session.generation,
    };
  }

  Future<void> _prepareSystemUIGeneration(
    String? rootPayloadSha256,
    int targetGeneration,
  ) async {
    final loader = widget.catalogLoader;
    if (loader == null) return;
    if (rootPayloadSha256 == null || rootPayloadSha256.isEmpty) {
      if (targetGeneration == 0) {
        // Embedded root startup has no signed payload identity. The document
        // already supplied the initial approved registry; later generations
        // must not silently reuse it.
        _pendingCatalog = null;
        _catalogReady = true;
        return;
      }
      throw const PocketCapabilityException(
        'catalog_unavailable',
        'A signed root payload is required before refreshing the app catalog',
      );
    }

    PocketSystemHostCatalog? catalog;
    try {
      catalog = await loader(rootPayloadSha256);
    } catch (error) {
      if (error is PocketCapabilityException) rethrow;
      throw PocketCapabilityException(
        'catalog_unavailable',
        'Unable to load the signed app catalog: $error',
      );
    }
    if (catalog == null ||
        catalog.rootPayloadSha256?.toLowerCase() !=
            rootPayloadSha256.toLowerCase()) {
      throw const PocketCapabilityException(
        'catalog_unavailable',
        'The app catalog does not match the mounted signed root payload',
      );
    }
    _validateCatalog(catalog);
    _pendingCatalog = _PendingSystemHostCatalog(
      generation: targetGeneration,
      catalog: catalog,
    );
    // Keep the old root visible while a later generation is being prepared.
    // Generation 0 has no mounted view yet, so it stays gated until commit.
    if (targetGeneration == 0) _catalogReady = false;
  }

  void _validateCatalog(PocketSystemHostCatalog catalog) {
    if (catalog.systemUI.appId != widget.systemUI.appId) {
      throw const PocketCapabilityException(
        'system_ui_mismatch',
        'The refreshed app catalog selects a different SystemUI package',
      );
    }
    try {
      _validateHostConfiguration(catalog.systemUI, catalog.applications);
    } on Object catch (error) {
      throw PocketCapabilityException(
        'catalog_unavailable',
        'The signed app catalog is invalid: $error',
      );
    }
  }

  void _commitPendingCatalog(int generation) {
    final pending = _pendingCatalog;
    if (pending == null || pending.generation != generation) return;
    final catalog = pending.catalog;
    final mountedHash = _systemUIInstance.session.mountedPayloadSha256;
    if (catalog.rootPayloadSha256 == null ||
        mountedHash == null ||
        catalog.rootPayloadSha256!.toLowerCase() != mountedHash.toLowerCase()) {
      // The session's active package is the final native fact. If it differs
      // from the package that was selected before mount publication, do not
      // expose either registry; the configure gate will remain closed.
      _pendingCatalog = null;
      _catalogGeneration = null;
      _catalogReady = false;
      _trustedApplications.clear();
      _surfaceAppIds.clear();
      _surfaceHandles.clear();
      return;
    }
    final nextApplications = Map<String, PocketAppConfig>.unmodifiable(
      catalog.applications,
    );
    final nextSurfaceAppIds = <int, String>{};
    final nextSurfaceHandles = <String, int>{};
    for (final entry in catalog.systemUI.compositorSurfaces.entries) {
      nextSurfaceAppIds[entry.value] = entry.key;
      nextSurfaceHandles[entry.key] = entry.value;
    }
    // Apply the new map immediately before the generation-keyed
    // PocketGuestSession rebuild. Its fresh PocketView will therefore call
    // native configureCompositor with this verified map before JS evaluates.
    _systemUIInstance.config = _systemUIInstance.config.copyWith(
      compositorSurfaces: Map<String, int>.unmodifiable(nextSurfaceHandles),
    );
    _trustedApplications
      ..clear()
      ..addAll(nextApplications);
    _surfaceAppIds
      ..clear()
      ..addAll(nextSurfaceAppIds);
    _surfaceHandles
      ..clear()
      ..addAll(nextSurfaceHandles);
    _catalogGeneration = generation;
    _catalogReady = true;
    _pendingCatalog = null;
  }

  Future<void> _ensureCatalogForGeneration(int ownerGeneration) async {
    _ensureOwnerGeneration(ownerGeneration);
    if (_catalogGeneration == ownerGeneration) return;

    final inFlight = _catalogFutureGeneration == ownerGeneration
        ? _catalogFuture
        : null;
    if (inFlight != null) {
      await inFlight;
      _ensureOwnerGeneration(ownerGeneration);
      return;
    }

    // Explicit PocketSystemHost consumers own a static native registry. The
    // dynamic single-host bootstrap supplies a loader and therefore takes the
    // signed-root/catalog path below. Keeping this branch preserves the old
    // public constructor without creating a second update state machine.
    final loader = widget.catalogLoader;
    if (loader == null) {
      _catalogGeneration = ownerGeneration;
      return;
    }

    final rootPayloadSha256 = _systemUIInstance.session.mountedPayloadSha256;
    if (rootPayloadSha256 == null || rootPayloadSha256.isEmpty) {
      if (ownerGeneration == 0) {
        // A host may intentionally run its embedded root while the first
        // signed package is still absent. The bootstrap catalog is already
        // verified in this case; later signed generations must carry a hash
        // and cannot reuse this fallback.
        _catalogGeneration = ownerGeneration;
        return;
      }
      throw const PocketCapabilityException(
        'catalog_unavailable',
        'A signed root payload is required before refreshing the app catalog',
      );
    }

    final future = _refreshCatalog(ownerGeneration, rootPayloadSha256, loader);
    _catalogFuture = future;
    _catalogFutureGeneration = ownerGeneration;
    try {
      await future;
      _ensureOwnerGeneration(ownerGeneration);
    } finally {
      if (identical(_catalogFuture, future)) {
        _catalogFuture = null;
        _catalogFutureGeneration = null;
      }
    }
  }

  Future<void> _refreshCatalog(
    int ownerGeneration,
    String rootPayloadSha256,
    PocketSystemHostCatalogLoader loader,
  ) async {
    PocketSystemHostCatalog? catalog;
    try {
      catalog = await loader(rootPayloadSha256);
    } catch (error) {
      if (error is PocketCapabilityException) rethrow;
      throw PocketCapabilityException(
        'catalog_unavailable',
        'Unable to load the signed app catalog: $error',
      );
    }
    _ensureOwnerGeneration(ownerGeneration);
    if (catalog == null ||
        catalog.rootPayloadSha256?.toLowerCase() !=
            rootPayloadSha256.toLowerCase()) {
      throw const PocketCapabilityException(
        'catalog_unavailable',
        'The app catalog does not match the mounted signed root payload',
      );
    }
    _validateCatalog(catalog);
    _pendingCatalog = _PendingSystemHostCatalog(
      generation: ownerGeneration,
      catalog: catalog,
    );
    _commitPendingCatalog(ownerGeneration);
  }

  Map<String, Set<String>> _parseGrants(Object? rawGrants) {
    if (rawGrants is! List) {
      throw const PocketCapabilityException(
        'invalid_grants',
        'grants must be an array',
      );
    }
    final result = <String, Set<String>>{};
    for (final raw in rawGrants) {
      if (raw is! Map) {
        throw const PocketCapabilityException(
          'invalid_grants',
          'each storage grant must be an object',
        );
      }
      final grant = Map<String, dynamic>.from(raw);
      final appId = _requiredString(grant, 'appId');
      if (appId != widget.systemUI.appId &&
          !_trustedApplications.containsKey(appId)) {
        throw PocketCapabilityException(
          'untrusted_app',
          'Storage grant references an app outside the trusted host map: $appId',
        );
      }
      if (result.containsKey(appId)) {
        throw PocketCapabilityException(
          'duplicate_grant',
          'Storage grant is repeated for $appId',
        );
      }
      final rawNamespaces = grant['sharedNamespaces'] ?? const <Object?>[];
      if (rawNamespaces is! List ||
          rawNamespaces.any((value) => value is! String)) {
        throw const PocketCapabilityException(
          'invalid_grants',
          'sharedNamespaces must be an array of strings',
        );
      }
      final namespaces = rawNamespaces.cast<String>();
      for (final namespace in namespaces) {
        if (!_storageNamespacePattern.hasMatch(namespace)) {
          throw PocketCapabilityException(
            'invalid_namespace',
            'Invalid shared storage namespace: $namespace',
          );
        }
      }
      result[appId] = Set<String>.unmodifiable(namespaces);
    }
    return result;
  }

  Future<void> _configureStorage(
    Map<String, Set<String>> grants,
    String signature,
    int ownerGeneration,
  ) async {
    final data = await _getPlatformData();
    if (_disposed || ownerGeneration != _systemUIGeneration) {
      throw const PocketCapabilityException(
        'host_closed',
        'System host closed',
      );
    }
    data.registerApp(
      widget.systemUI.appId,
      sharedNamespaces: grants[widget.systemUI.appId] ?? const <String>{},
    );
    for (final appId in _trustedApplications.keys) {
      data.registerApp(
        appId,
        sharedNamespaces: grants[appId] ?? const <String>{},
      );
    }
    _configurationSignature = signature;
  }

  Future<Map<String, Object?>> _create(
    Map<String, dynamic> params,
    int ownerGeneration,
  ) async {
    await _awaitConfigured();
    _ensureOwnerGeneration(ownerGeneration);
    final appId = _requiredString(params, 'appId');
    final prepareForOpen = params['prepareForOpen'] == true;
    final trustedConfig = _trustedApplications[appId];
    if (trustedConfig == null) {
      throw PocketCapabilityException(
        'untrusted_app',
        'App ID is not present in the trusted host map: $appId',
      );
    }
    var admittedConfig = trustedConfig;
    if (params.containsKey('memory')) {
      try {
        final memory = trustedConfig.memoryLimits.admit(
          PocketMemoryLimits.fromJson(params['memory']),
        );
        admittedConfig = trustedConfig.copyWith(memoryLimits: memory);
      } on FormatException catch (error) {
        throw PocketCapabilityException('memory_limit_denied', error.message);
      }
    }
    if (_applications.length + 1 >= widget.maxInstances) {
      throw const PocketCapabilityException(
        'instance_limit',
        'System host reached its configured live instance limit',
      );
    }
    if (_disposed) {
      throw const PocketCapabilityException(
        'host_closed',
        'System host closed',
      );
    }

    final instanceId = 'pocket-app-${++_nextInstanceId}';
    final instance = _RuntimeInstance(
      instanceId: instanceId,
      appId: appId,
      config: admittedConfig,
      isSystemUI: false,
      ownerGeneration: ownerGeneration,
    );
    final capturedConfig = widget.recordings != null
        ? widget.recordings!.attach(admittedConfig)
        : _recordings != null && admittedConfig.recordingFactory == null
        ? _recordings.attach(admittedConfig)
        : admittedConfig;
    final childConfig = capturedConfig.withPlugins(<PocketPluginFactory>[
      ...capturedConfig.pluginFactories,
      (_) => _PlatformProxyPlugin(this, instance, ownerGeneration),
      (captureController) => _PlatformImagesPlugin(
        this,
        instance,
        ownerGeneration,
        instance.session.generation,
        captureController,
      ),
    ]);
    instance.config = childConfig;
    instance.session = PocketSession(config: childConfig);
    instance.observedGeneration = instance.session.generation;
    instance.announcedGeneration = instance.session.generation;
    instance.changeListener = () => _instanceChanged(instance);
    instance.session.addListener(instance.changeListener);
    instance.firstFrame = Completer<void>();
    unawaited(instance.firstFrame!.future.catchError((Object _) {}));
    instance.firstVisibleFrame = Completer<void>();
    unawaited(instance.firstVisibleFrame!.future.catchError((Object _) {}));
    _applications[instanceId] = instance;
    _publishFacts();

    try {
      await instance.session.setForeground(false);
      await instance.session.initialize(prepareForOpen: prepareForOpen);
      if (!_isCurrent(instance) ||
          ownerGeneration != _systemUIGeneration ||
          instance.ownerGeneration != _systemUIGeneration) {
        throw const PocketCapabilityException(
          'stale_instance',
          'Runtime instance was removed during startup',
        );
      }
      if (instance.session.failure case final error?) {
        throw PocketCapabilityException(
          _runtimeFailureCode(error, fallback: 'startup_failed'),
          '$error',
        );
      }
      if (mounted) setState(() {});
      if (!_isCurrent(instance) ||
          instance.session.generation != instance.observedGeneration) {
        throw const PocketCapabilityException(
          'stale_instance',
          'Runtime instance changed generation during startup',
        );
      }
      return <String, Object?>{
        'instanceId': instanceId,
        'appId': appId,
        'generation': instance.session.generation,
        if (prepareForOpen) 'preparedForOpen': true,
        if (!instance.session.memoryLimits.isEmpty)
          'memory': instance.session.memoryLimits.toJson(),
      };
    } on Object catch (error) {
      await _closeInstance(
        instance,
        removeFromTree: identical(_applications[instance.instanceId], instance),
      );
      if (error is PocketCapabilityException) rethrow;
      throw PocketCapabilityException(
        _runtimeFailureCode(error, fallback: 'startup_failed'),
        '$error',
      );
    }
  }

  Future<Map<String, Object?>> _prepareOpen(
    Map<String, dynamic> params,
    int ownerGeneration,
  ) async {
    await _awaitConfigured();
    _ensureOwnerGeneration(ownerGeneration);
    final instanceId = _requiredString(params, 'instanceId');
    final rawGeneration = params['generation'];
    if (rawGeneration is! num ||
        !rawGeneration.isFinite ||
        rawGeneration != rawGeneration.toInt()) {
      throw const PocketCapabilityException(
        'invalid_generation',
        'generation must be an integer',
      );
    }
    final instance = _applications[instanceId];
    final generation = rawGeneration.toInt();
    if (instance == null || instance.closing) {
      throw const PocketCapabilityException(
        'instance_not_found',
        'Runtime instance does not exist',
      );
    }
    if (!_isCurrent(instance) || instance.ownerGeneration != ownerGeneration) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Runtime instance belongs to a stale SystemUI generation',
      );
    }
    if (instance.session.generation != generation) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Requested preparation belongs to a stale runtime generation',
      );
    }
    if (instance.compositorVisible ||
        instance.compositorFocused ||
        instance.session.foreground) {
      throw const PocketCapabilityException(
        'runtime_busy',
        'Only a hidden runtime can be prepared before presentation',
      );
    }

    late final Map<String, Object?> result;
    try {
      result = await instance.session.prepareForOpen(
        canMount: () =>
            _isCurrent(instance) &&
            _systemUIGeneration == ownerGeneration &&
            instance.ownerGeneration == ownerGeneration &&
            instance.session.generation == generation &&
            !instance.compositorVisible &&
            !instance.compositorFocused &&
            !instance.session.foreground,
      );
    } catch (_) {
      // A hidden prewarm may not have produced a frame yet, so the normal
      // generation listener intentionally suppresses its event. If a failed
      // mount still advanced the generation and restored the old package,
      // force the fact through the same protocol so JS can retry with the
      // current generation instead of being stranded on a stale one.
      final nextGeneration = instance.session.generation;
      if (nextGeneration != generation && !instance.hasEverProducedFrame) {
        instance.announcedGeneration = generation;
        _announceChildGeneration(instance, nextGeneration);
      }
      rethrow;
    }
    _ensureOwnerGeneration(ownerGeneration);
    if (!_isCurrent(instance) || instance.closing) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Runtime instance was removed during preparation',
      );
    }
    final nextGeneration = instance.session.generation;
    return <String, Object?>{
      'instanceId': instanceId,
      'appId': instance.appId,
      'previousGeneration': generation,
      'generation': nextGeneration,
      'updated': result['updated'] == true,
      'configured': result['configured'] == true,
    };
  }

  Future<Object?> _awaitFirstFrame(Map<String, dynamic> params) async {
    final instanceId = _requiredString(params, 'instanceId');
    final rawGeneration = params['generation'];
    if (rawGeneration is! num ||
        !rawGeneration.isFinite ||
        rawGeneration != rawGeneration.toInt()) {
      throw const PocketCapabilityException(
        'invalid_generation',
        'generation must be an integer',
      );
    }
    final instance = _applications[instanceId];
    final generation = rawGeneration.toInt();
    if (instance == null || instance.closing) {
      throw const PocketCapabilityException(
        'instance_not_found',
        'Runtime instance does not exist',
      );
    }
    if (instance.session.generation != generation) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Requested first frame belongs to a stale runtime generation',
      );
    }
    if (instance.session.failure case final Object error) {
      Error.throwWithStackTrace(error, StackTrace.current);
    }
    if (!instance.isFirstVisibleFrameReady) {
      final waiter = instance.firstVisibleFrame ??= Completer<void>();
      unawaited(waiter.future.catchError((Object _) {}));
      try {
        await waiter.future.timeout(_platformRequestTimeout);
      } on TimeoutException {
        throw const PocketCapabilityException(
          'first_frame_timeout',
          'Visible child did not produce its first Pocket frame in time',
        );
      }
    }
    if (instance.session.failure case final Object error) {
      Error.throwWithStackTrace(error, StackTrace.current);
    }
    if (!_isCurrent(instance) ||
        instance.session.generation != generation ||
        !instance.isFirstVisibleFrameReady) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Runtime changed before its first frame was ready',
      );
    }
    return <String, Object?>{'ready': true, 'generation': generation};
  }

  Future<Object?> _destroy(Map<String, dynamic> params) async {
    final instanceId = _requiredString(params, 'instanceId');
    if (instanceId == _systemInstanceId) {
      throw const PocketCapabilityException(
        'system_instance_protected',
        'The resident SystemUI instance cannot be destroyed',
      );
    }
    final instance = _applications[instanceId];
    if (instance == null) {
      throw const PocketCapabilityException(
        'instance_not_found',
        'Runtime instance does not exist',
      );
    }
    await _closeInstance(instance, removeFromTree: true);
    return <String, Object?>{'destroyed': true};
  }

  Future<void> _closeInstance(
    _RuntimeInstance instance, {
    required bool removeFromTree,
    bool waitForUnmount = false,
  }) {
    final closing = instance.closeFuture;
    if (closing != null) return closing;
    final future = _closeInstanceImpl(
      instance,
      removeFromTree: removeFromTree,
      waitForUnmount: waitForUnmount,
    );
    instance.closeFuture = future;
    return future;
  }

  Future<void> _closeInstanceImpl(
    _RuntimeInstance instance, {
    required bool removeFromTree,
    required bool waitForUnmount,
  }) async {
    if (instance.closing) return;
    instance.closing = true;
    final firstFrame = instance.firstFrame;
    if (firstFrame != null && !firstFrame.isCompleted) {
      firstFrame.completeError(
        const PocketCapabilityException(
          'instance_destroyed',
          'Runtime destroyed',
        ),
      );
    }
    final firstVisibleFrame = instance.firstVisibleFrame;
    if (firstVisibleFrame != null && !firstVisibleFrame.isCompleted) {
      firstVisibleFrame.completeError(
        const PocketCapabilityException(
          'instance_destroyed',
          'Runtime destroyed',
        ),
      );
    }
    _invalidatePendingFor(
      instance.instanceId,
      instance.session.generation,
      const PocketCapabilityException(
        'stale_instance',
        'Runtime was destroyed',
      ),
    );
    await instance.session.setForeground(false).catchError((Object _) {});
    if (removeFromTree && _applications.containsKey(instance.instanceId)) {
      _applications.remove(instance.instanceId);
      instance.compositorVisible = false;
      instance.compositorFocused = false;
      instance.session.removeListener(instance.changeListener);
      _publishFacts();
      if (mounted) setState(() {});
    }
    if ((removeFromTree || waitForUnmount) && mounted) {
      await WidgetsBinding.instance.endOfFrame;
    }
    await instance.session.close();
  }

  /// Releases the runtime instances owned by the current SystemUI realm.
  ///
  /// Generation changes and terminal owner failure both invalidate this set.
  /// The JS owner retires its policy state; this clears the matching native
  /// sessions and their resident compositor slots.
  void _retireOwnedChildren() {
    if (_applications.isEmpty) {
      return;
    }
    final children = _applications.values.toList(growable: false);
    _applications.clear();
    for (final instance in children) {
      instance.compositorVisible = false;
      instance.compositorFocused = false;
      instance.session.removeListener(instance.changeListener);
      unawaited(
        _closeInstance(
          instance,
          removeFromTree: false,
          waitForUnmount: true,
        ).catchError((Object _) {}),
      );
    }
    _publishFacts();
    if (mounted) setState(() {});
  }

  Future<Object?> _post(Map<String, dynamic> params) async {
    final instanceId = _requiredString(params, 'instanceId');
    final event = _requiredString(params, 'event');
    final target = _instanceFor(instanceId);
    if (target == null || target.closing) {
      throw const PocketCapabilityException(
        'instance_not_found',
        'Runtime instance does not exist',
      );
    }
    final rawParams = params['params'] ?? const <String, dynamic>{};
    if (rawParams is! Map) {
      throw const PocketCapabilityException(
        'invalid_event',
        'Event params must be an object',
      );
    }
    // A session generation advances before Flutter replaces the keyed
    // PocketView. Until the new view has loaded and called onReady, the
    // controller may still be attached to the retired runtime (or be between
    // detach and attach). Returning accepted:false keeps lifecycle/launch
    // messages in the JS-owned queue instead of accepting them into a stale
    // controller queue that will be cleared by the remount. The resident
    // SystemUI bootstrap retains its original ordering contract.
    if (!target.isSystemUI &&
        (target.observedGeneration != target.session.generation ||
            !target.firstFrameReady)) {
      return <String, Object?>{'accepted': false};
    }
    final accepted = target.session.controller.send(
      method: event,
      params: Map<String, dynamic>.from(rawParams),
    );
    return <String, Object?>{'accepted': accepted};
  }

  Future<Object?> _respond(Map<String, dynamic> params) async {
    final requestId = _requiredString(params, 'requestId');
    final ok = params['ok'];
    if (ok is! bool) {
      throw const PocketCapabilityException(
        'invalid_response',
        'ok must be a boolean',
      );
    }
    final pending = _pendingRequests[requestId];
    if (pending == null) {
      throw const PocketCapabilityException(
        'stale_request',
        'The platform request is no longer pending',
      );
    }
    if (!_isCurrent(pending.source) ||
        pending.source.session.generation != pending.sourceGeneration ||
        pending.systemGeneration != _systemUIInstance.session.generation) {
      _finishPendingError(
        pending,
        const PocketCapabilityException(
          'stale_request',
          'The platform request belongs to an expired runtime generation',
        ),
      );
      throw const PocketCapabilityException(
        'stale_request',
        'The platform request belongs to an expired runtime generation',
      );
    }
    if (ok) {
      _pendingRequests.remove(requestId);
      pending.timer.cancel();
      pending.completer.complete(params['value']);
    } else {
      final error = _readRemoteError(params['error']);
      _finishPendingError(pending, error);
    }
    return <String, Object?>{'accepted': true};
  }

  Future<Object?> _forwardPlatformRequest(
    _RuntimeInstance source,
    int ownerGeneration,
    String capability,
    Map<String, dynamic> params,
  ) {
    if (!_isCurrent(source) ||
        source.closing ||
        ownerGeneration != _systemUIGeneration ||
        (!source.isSystemUI && source.ownerGeneration != _systemUIGeneration) ||
        (source.isSystemUI && source.session.generation != ownerGeneration)) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'stale_instance',
          'Platform request source is no longer active',
        ),
      );
    }
    if (_pendingRequests.length >= _maxPendingPlatformRequests) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'request_limit',
          'System host has too many pending platform requests',
        ),
      );
    }
    if (!source.isSystemUI &&
        source.announcedGeneration != source.session.generation &&
        !_announceChildGeneration(source, source.session.generation)) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'system_ui_unavailable',
          'SystemUI did not accept the runtime generation update',
        ),
      );
    }
    if (_systemUIInstance.startupError != null ||
        _systemUIInstance.session.failure != null ||
        !_systemUIInstance.session.controller.isReady) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'system_ui_unavailable',
          'SystemUI is not ready to handle platform requests',
        ),
      );
    }

    final requestId = 'system-rpc-${++_nextRequestId}';
    final completer = Completer<Object?>();
    unawaited(completer.future.catchError((Object _) => null));
    late final _PendingPlatformRequest pending;
    // Cold opens can download a signed package before awaiting the first frame.
    // Other platform requests retain their existing short deadline.
    final timeout =
        capability == 'platform.apps.open' ||
            capability == 'platform.apps.prewarm'
        ? const Duration(seconds: 75)
        : _platformRequestTimeout;
    final timer = Timer(timeout, () {
      final current = _pendingRequests[requestId];
      if (identical(current, pending)) {
        _finishPendingError(
          pending,
          const PocketCapabilityException(
            'request_timeout',
            'SystemUI did not answer the platform request in time',
          ),
        );
      }
    });
    pending = _PendingPlatformRequest(
      requestId: requestId,
      source: source,
      sourceGeneration: source.session.generation,
      systemGeneration: _systemUIInstance.session.generation,
      completer: completer,
      timer: timer,
    );
    _pendingRequests[requestId] = pending;
    final accepted = _systemUIInstance.session.controller.send(
      method: 'system.request',
      params: <String, dynamic>{
        'requestId': requestId,
        'sourceAppId': source.session.appId,
        'sourceInstanceId': source.instanceId,
        'sourceGeneration': source.session.generation,
        'capability': capability,
        'params': Map<String, dynamic>.from(params),
      },
    );
    if (!accepted) {
      _finishPendingError(
        pending,
        const PocketCapabilityException(
          'system_ui_unavailable',
          'SystemUI did not accept the platform request',
        ),
      );
    }
    return completer.future;
  }

  void _ensureImageGeneration(
    _RuntimeInstance source, {
    required int ownerGeneration,
    required int sessionGeneration,
    required String appId,
  }) {
    if (!_isCurrent(source) ||
        source.closing ||
        source.isSystemUI ||
        source.appId != appId ||
        source.session.appId != appId ||
        source.ownerGeneration != ownerGeneration ||
        ownerGeneration != _systemUIGeneration ||
        source.session.generation != sessionGeneration) {
      throw const PocketCapabilityException(
        'stale_instance',
        'Image request belongs to an expired child runtime generation',
      );
    }
  }

  Future<Map<String, Object?>> _captureGuestImage(
    _RuntimeInstance source, {
    required int ownerGeneration,
    required int sessionGeneration,
    required PocketViewController captureController,
    required String appId,
    required Map<String, dynamic> params,
  }) async {
    _ensureOnlyImageFields(params, const <String>{
      'maxWidth',
      'maxHeight',
      'maxPixels',
    });
    final maxWidth = _imageLimit(
      params,
      'maxWidth',
      maximum: _maxPlatformImageWidth,
    );
    final maxHeight = _imageLimit(
      params,
      'maxHeight',
      maximum: _maxPlatformImageHeight,
    );
    final maxPixels = _imageLimit(
      params,
      'maxPixels',
      maximum: _maxPlatformImagePixels,
    );
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );

    late final PocketViewCapture? capture;
    try {
      capture = await captureController.captureScene(
        maxWidth: maxWidth,
        maxHeight: maxHeight,
        maxPixels: maxPixels,
      );
    } on UnsupportedError catch (error) {
      throw PocketCapabilityException(
        'unsupported_scene',
        'Guest surface contains unsupported capture content: ${error.message}',
      );
    } on StateError catch (error) {
      final busy = error.message.toString().contains('already in progress');
      throw PocketCapabilityException(
        busy ? 'capture_busy' : 'capture_unavailable',
        busy
            ? 'A guest scene capture is already in progress'
            : 'Guest scene capture is not available: ${error.message}',
      );
    }
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    if (capture == null) {
      throw const PocketCapabilityException(
        'capture_unavailable',
        'Guest surface is not currently available for capture',
      );
    }

    final store = await _getImageStore();
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final stored = await store.put(appId, capture.pngBytes);
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    if (stored.width != capture.width || stored.height != capture.height) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Captured PNG dimensions did not match the PocketView readback',
      );
    }
    return <String, Object?>{
      'id': stored.id,
      'width': stored.width,
      'height': stored.height,
    };
  }

  Future<Map<String, Object?>> _readGuestImage(
    _RuntimeInstance source, {
    required int ownerGeneration,
    required int sessionGeneration,
    required String appId,
    required Map<String, dynamic> params,
  }) async {
    _ensureOnlyImageFields(params, const <String>{'id'});
    final id = _requiredString(params, 'id');
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final store = await _getImageStore();
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final stored = await store.read(appId, id);
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    if (stored == null) {
      throw const PocketCapabilityException(
        'image_not_found',
        'Image ID is not present in this app image store',
      );
    }
    final imageEntry = await _decodePocketImageEntry(stored);
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    return <String, Object?>{
      'id': stored.id,
      'width': stored.width,
      'height': stored.height,
      'textureWidth': imageEntry.width,
      'textureHeight': imageEntry.height,
      'img': imageEntry.bytes,
    };
  }

  Future<List<Map<String, Object?>>> _listGuestImages(
    _RuntimeInstance source, {
    required int ownerGeneration,
    required int sessionGeneration,
    required String appId,
    required Map<String, dynamic> params,
  }) async {
    _ensureOnlyImageFields(params, const <String>{});
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final store = await _getImageStore();
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final images = await store.list(appId);
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    return images;
  }

  Future<Map<String, Object?>> _removeGuestImage(
    _RuntimeInstance source, {
    required int ownerGeneration,
    required int sessionGeneration,
    required String appId,
    required Map<String, dynamic> params,
  }) async {
    _ensureOnlyImageFields(params, const <String>{'id'});
    final id = _requiredString(params, 'id');
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final store = await _getImageStore();
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    final removed = await store.remove(appId, id);
    _ensureImageGeneration(
      source,
      ownerGeneration: ownerGeneration,
      sessionGeneration: sessionGeneration,
      appId: appId,
    );
    return <String, Object?>{'removed': removed};
  }

  Future<_PocketImageEntryData> _decodePocketImageEntry(
    PocketStoredImage stored,
  ) async {
    ui.Codec? codec;
    ui.Image? image;
    try {
      codec = await ui.instantiateImageCodec(stored.pngBytes);
      image = (await codec.getNextFrame()).image;
      if (image.width != stored.width || image.height != stored.height) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Stored PNG dimensions changed during decode',
        );
      }
      final data = await image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      if (data == null ||
          data.lengthInBytes != stored.width * stored.height * 4) {
        throw const PocketCapabilityException(
          'image_decode_failed',
          'Flutter did not return a complete RGBA image',
        );
      }
      final textureWidth = _nextPowerOfTwo(stored.width);
      final textureHeight = _nextPowerOfTwo(stored.height);
      if (textureWidth > _maxPlatformImageWidth ||
          textureHeight > _maxPlatformImageHeight) {
        throw const PocketCapabilityException(
          'image_dimensions_unsupported',
          'Captured image exceeds the dynamic texture dimensions',
        );
      }
      final rgba = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      final entry = Uint8List(8 + textureWidth * textureHeight * 4);
      final header = ByteData.sublistView(entry);
      header.setUint16(0, textureWidth, Endian.little);
      header.setUint16(2, textureHeight, Endian.little);
      entry[4] = 3; // PSM_8888
      entry[5] = 2; // IMG_FLAG_LINEAR
      for (var row = 0; row < stored.height; row++) {
        final sourceStart = row * stored.width * 4;
        final targetStart = 8 + row * textureWidth * 4;
        entry.setRange(
          targetStart,
          targetStart + stored.width * 4,
          rgba,
          sourceStart,
        );
      }
      return _PocketImageEntryData(
        bytes: entry,
        width: textureWidth,
        height: textureHeight,
      );
    } on PocketCapabilityException {
      rethrow;
    } on Object catch (error) {
      throw PocketCapabilityException(
        'image_decode_failed',
        'Unable to decode stored PNG: $error',
      );
    } finally {
      image?.dispose();
      codec?.dispose();
    }
  }

  void _finishPendingError(_PendingPlatformRequest pending, Object error) {
    if (!identical(_pendingRequests[pending.requestId], pending)) return;
    _pendingRequests.remove(pending.requestId);
    pending.timer.cancel();
    if (!pending.completer.isCompleted) pending.completer.completeError(error);
  }

  void _invalidatePendingFor(String instanceId, int generation, Object error) {
    for (final pending in _pendingRequests.values.toList(growable: false)) {
      if (pending.source.instanceId == instanceId &&
          pending.sourceGeneration == generation) {
        _finishPendingError(pending, error);
      }
    }
  }

  Future<Object?> _storageGet(Map<String, dynamic> params) async {
    final appId = _trustedStorageAppId(params);
    final key = _requiredString(params, 'key');
    final namespace = _optionalString(params, 'namespace');
    return (await _configuredPlatformData()).read(
      appId,
      key,
      namespace: namespace,
    );
  }

  Future<Object?> _storageSet(Map<String, dynamic> params) async {
    final appId = _trustedStorageAppId(params);
    final key = _requiredString(params, 'key');
    final namespace = _optionalString(params, 'namespace');
    await (await _configuredPlatformData()).write(
      appId,
      key,
      params['value'],
      namespace: namespace,
    );
    return null;
  }

  Future<Object?> _storageRemove(Map<String, dynamic> params) async {
    final appId = _trustedStorageAppId(params);
    final key = _requiredString(params, 'key');
    final namespace = _optionalString(params, 'namespace');
    await (await _configuredPlatformData()).remove(
      appId,
      key,
      namespace: namespace,
    );
    return null;
  }

  Future<Object?> _storageKeys(Map<String, dynamic> params) async {
    final appId = _trustedStorageAppId(params);
    final namespace = _optionalString(params, 'namespace');
    return (await _configuredPlatformData()).keys(appId, namespace: namespace);
  }

  Future<Object?> _storageBatch(Map<String, dynamic> params) async {
    final appId = _trustedStorageAppId(params);
    final operations = params['operations'];
    if (operations is! List) {
      throw const PocketCapabilityException(
        'invalid_storage_batch',
        'Storage batch operations must be an array',
      );
    }
    final namespace = _optionalString(params, 'namespace');
    await (await _configuredPlatformData()).batch(
      appId,
      List<Object?>.from(operations),
      namespace: namespace,
    );
    return null;
  }

  String _trustedStorageAppId(Map<String, dynamic> params) {
    final appId = _requiredString(params, 'appId');
    if (appId != widget.systemUI.appId &&
        !_trustedApplications.containsKey(appId)) {
      throw const PocketCapabilityException(
        'untrusted_app',
        'Storage target is outside the trusted host app map',
      );
    }
    return appId;
  }

  Future<PocketPlatformData> _configuredPlatformData() async {
    await _awaitConfigured();
    final data = await _getPlatformData();
    if (_configurationSignature == null) {
      throw const PocketCapabilityException(
        'not_configured',
        'System storage scopes are not configured',
      );
    }
    return data;
  }

  Future<PocketPlatformData> _getPlatformData() {
    final ready = _platformData;
    if (ready != null) return Future<PocketPlatformData>.value(ready);
    final pending = _platformDataFuture;
    if (pending != null) return pending;
    final future = _openPlatformData();
    _platformDataFuture = future;
    return future;
  }

  Future<PocketImageStore> _getImageStore() {
    final ready = _imageStore;
    if (ready != null) return Future<PocketImageStore>.value(ready);
    final pending = _imageStoreFuture;
    if (pending != null) return pending;
    final future = _openImageStore();
    _imageStoreFuture = future;
    return future;
  }

  Future<PocketImageStore> _openImageStore() async {
    late final Directory supportDirectory;
    try {
      supportDirectory = await getApplicationSupportDirectory();
    } on Exception catch (error) {
      if (_disposed) {
        throw const PocketCapabilityException(
          'host_closed',
          'System host closed',
        );
      }
      throw PocketCapabilityException(
        'image_store_unavailable',
        'Unable to locate app-private image storage: $error',
      );
    }
    if (_disposed) {
      throw const PocketCapabilityException(
        'host_closed',
        'System host closed',
      );
    }
    final store = PocketImageStore(
      directory: Directory('${supportDirectory.path}/pocket-images'),
    );
    if (_disposed) {
      await store.close();
      throw const PocketCapabilityException(
        'host_closed',
        'System host closed',
      );
    }
    _imageStore = store;
    return store;
  }

  Future<PocketPlatformData> _openPlatformData() async {
    final supportDirectory = await getApplicationSupportDirectory();
    if (_disposed) {
      throw const PocketCapabilityException(
        'host_closed',
        'System host closed',
      );
    }
    final data = PocketPlatformData(
      directory: Directory('${supportDirectory.path}/pocket-platform-data'),
    );
    try {
      await data.initialize();
      if (_disposed) {
        await data.close();
        throw const PocketCapabilityException(
          'host_closed',
          'System host closed',
        );
      }
      _platformData = data;
      return data;
    } catch (_) {
      await data.close();
      rethrow;
    }
  }

  Future<void> _awaitConfigured() async {
    if (_configurationSignature != null) return;
    final configuring = _configurationFuture;
    if (configuring != null &&
        _configurationFutureGeneration == _systemUIGeneration) {
      await configuring;
    }
    if (_configurationSignature == null) {
      throw const PocketCapabilityException(
        'not_configured',
        'SystemUI must configure trusted app storage before using runtimes',
      );
    }
  }

  void _ensureOwnerGeneration(int ownerGeneration) {
    if (_disposed || ownerGeneration != _systemUIGeneration) {
      throw const PocketCapabilityException(
        'stale_system_ui',
        'SystemUI request belongs to an expired owner generation',
      );
    }
  }

  void _onFirstFrame(_RuntimeInstance instance) {
    if (!_isCurrent(instance) || instance.closing) return;
    instance.firstFrameReady = true;
    instance.hasEverProducedFrame = true;
    instance.startupError = null;
    if (instance.firstFrame case final ready? when !ready.isCompleted) {
      ready.complete();
    }
    _checkFirstVisibleFrame(instance);
    _publishFacts();
  }

  void _checkFirstVisibleFrame(_RuntimeInstance instance) {
    if (instance.isFirstVisibleFrameReady) {
      final waiter = instance.firstVisibleFrame;
      if (waiter != null && !waiter.isCompleted) {
        waiter.complete();
      }
    }
  }

  void _instanceChanged(_RuntimeInstance instance) {
    if (instance.isSystemUI) {
      _systemUIChanged();
      return;
    }
    if (!_isCurrent(instance)) return;
    final oldGeneration = instance.observedGeneration;
    final nextGeneration = instance.session.generation;
    if (oldGeneration != nextGeneration) {
      _invalidatePendingFor(
        instance.instanceId,
        oldGeneration,
        const PocketCapabilityException(
          'stale_request',
          'Platform request source changed runtime generation',
        ),
      );
      instance.observedGeneration = nextGeneration;
      instance.firstFrameReady = false;
      final oldFrame = instance.firstFrame;
      if (oldFrame != null && !oldFrame.isCompleted) {
        oldFrame.completeError(
          const PocketCapabilityException(
            'stale_instance',
            'Runtime generation changed before its first frame',
          ),
        );
      }
      instance.firstFrame = Completer<void>();
      unawaited(instance.firstFrame!.future.catchError((Object _) {}));
      final oldVisibleFrame = instance.firstVisibleFrame;
      if (oldVisibleFrame != null && !oldVisibleFrame.isCompleted) {
        oldVisibleFrame.completeError(
          const PocketCapabilityException(
            'stale_instance',
            'Runtime generation changed before its first visible frame',
          ),
        );
      }
      instance.firstVisibleFrame = Completer<void>();
      unawaited(instance.firstVisibleFrame!.future.catchError((Object _) {}));
      if (instance.hasEverProducedFrame) {
        _announceChildGeneration(instance, nextGeneration);
      } else {
        instance.announcedGeneration = nextGeneration;
      }
    }
    final failure = instance.session.failure;
    if (failure != null) {
      // A runtime can produce an Offstage first frame before its compositor
      // slot becomes visible, or reload into a new generation after an earlier
      // frame. Completing both waiters on failure must not depend on
      // hasEverProducedFrame. The attached error handlers keep these
      // diagnostic completions from becoming unhandled Future errors.
      final visible = instance.firstVisibleFrame;
      if (visible != null && !visible.isCompleted) {
        visible.completeError(failure);
      }
      final ready = instance.firstFrame;
      if (ready != null && !ready.isCompleted) {
        ready.completeError(failure);
      }
      if (!instance.hasEverProducedFrame) {
        // Initial startup failure before any frame is surfaced through
        // awaitFirstFrame rather than system.runtime.failed.
      } else if (instance.reportedFailureGeneration != nextGeneration) {
        instance.reportedFailureGeneration = nextGeneration;
        _systemUIInstance.session.controller.send(
          method: 'system.runtime.failed',
          params: <String, dynamic>{
            'instanceId': instance.instanceId,
            'appId': instance.appId,
            'error': <String, Object?>{
              'code': _runtimeFailureCode(failure),
              'message': '$failure',
            },
          },
        );
      }
    }
    _publishFacts(sessionChanged: true);
    if (mounted) setState(() {});
  }

  void _systemUIChanged() {
    if (_disposed) return;
    final generation = _systemUIInstance.session.generation;
    if (generation != _systemUIGeneration) {
      _systemUIGeneration = generation;
      _configurationSignature = null;
      final prepared = _pendingCatalog?.generation == generation;
      if (prepared) {
        // The mount hook verified the descriptor before the new generation
        // was published. Commit its child registry only at this official
        // generation notification, after the old root has stopped producing
        // requests.
        _commitPendingCatalog(generation);
      } else if (widget.catalogLoader != null) {
        _catalogGeneration = null;
        _catalogReady = false;
        // Do not let a previous root generation's child IDs or compositor
        // handles survive while the signed catalog for the new root is being
        // selected at the next `runtime.configure` boundary.
        _trustedApplications.clear();
        _surfaceAppIds.clear();
        _surfaceHandles.clear();
      }
      _systemUIInstance.observedGeneration = generation;
      _systemUIInstance.firstFrameReady = false;
      final oldFrame = _systemUIInstance.firstFrame;
      if (oldFrame != null && !oldFrame.isCompleted) {
        oldFrame.completeError(
          const PocketCapabilityException(
            'stale_instance',
            'SystemUI generation changed before its first frame',
          ),
        );
      }
      _systemUIInstance.firstFrame = Completer<void>();
      unawaited(_systemUIInstance.firstFrame!.future.catchError((Object _) {}));
      for (final pending in _pendingRequests.values.toList(growable: false)) {
        _finishPendingError(
          pending,
          const PocketCapabilityException(
            'stale_request',
            'SystemUI changed runtime generation',
          ),
        );
      }
      _retireOwnedChildren();
    }
    if (_pendingCatalog?.generation == generation) {
      _commitPendingCatalog(generation);
    } else if (generation == _systemUIGeneration &&
        widget.catalogLoader != null &&
        _catalogReady &&
        _catalogGeneration == null) {
      // Generation 0 with an embedded root has no pending signed catalog, but
      // its initial host document is already the approved registry.
      _catalogGeneration = generation;
    }
    final failure = _systemUIInstance.session.failure;
    final firstFrame = _systemUIInstance.firstFrame;
    if (failure != null &&
        !_systemUIInstance.firstFrameReady &&
        firstFrame != null &&
        !firstFrame.isCompleted) {
      firstFrame.completeError(failure);
    }
    if (failure != null) {
      for (final pending in _pendingRequests.values.toList(growable: false)) {
        _finishPendingError(
          pending,
          const PocketCapabilityException(
            'system_ui_failed',
            'SystemUI failed while handling platform requests',
          ),
        );
      }
      _retireOwnedChildren();
    }
    _publishFacts(sessionChanged: true);
    if (mounted) setState(() {});
  }

  bool _announceChildGeneration(_RuntimeInstance instance, int generation) {
    if (!_isCurrent(instance) || instance.isSystemUI) return false;
    final previousGeneration = instance.announcedGeneration;
    if (previousGeneration == generation) return true;
    final accepted = _systemUIInstance.session.controller.send(
      method: 'system.runtime.generation',
      params: <String, dynamic>{
        'instanceId': instance.instanceId,
        'appId': instance.appId,
        'previousGeneration': previousGeneration,
        'generation': generation,
      },
    );
    if (accepted) instance.announcedGeneration = generation;
    return accepted;
  }

  void _applyForeground(_RuntimeInstance instance) {
    final shouldBeForeground = _lifecycleResumed && instance.compositorVisible;
    if (instance.closing || instance.session.foreground == shouldBeForeground) {
      return;
    }
    unawaited(
      instance.session.setForeground(shouldBeForeground).catchError((Object _) {
        // Session state remains the source of truth; a JS present command can
        // retry the foreground transition without native stack recovery.
      }),
    );
  }

  bool _isCurrent(_RuntimeInstance instance) =>
      !_disposed &&
      (instance.isSystemUI
          ? identical(_systemUIInstance, instance)
          : identical(_applications[instance.instanceId], instance)) &&
      !instance.closing;

  void _publishFacts({bool sessionChanged = false}) {
    if (_disposed) return;
    final all = <_RuntimeInstance>[_systemUIInstance, ..._applications.values];
    _controller._publish(<PocketSystemInstanceSnapshot>[
      for (final instance in all)
        PocketSystemInstanceSnapshot(
          instanceId: instance.instanceId,
          appId: instance.appId,
          session: instance.session,
          firstFrame: instance.firstFrame?.future,
          generation: instance.session.generation,
          isSystemUI: instance.isSystemUI,
          ready: instance.session.ready,
          firstFrameReady: instance.firstFrameReady,
          foreground: instance.session.foreground,
          // SystemUI owns the compositor root for the lifetime of the host;
          // its presentation remains true while child surfaces are layered
          // above it. A child is presented only when its visible slot is
          // non-empty. Foreground/focus carry the separate interaction state.
          isPresented: instance.isSystemUI || instance.compositorVisible,
          compositorFocused: instance.compositorFocused,
        ),
    ], sessionChanged: sessionChanged);
  }
}

final class _RuntimeInstance {
  _RuntimeInstance({
    required this.instanceId,
    required this.appId,
    required this.config,
    required this.isSystemUI,
    required this.ownerGeneration,
  });

  final String instanceId;
  final String appId;
  PocketAppConfig config;
  final bool isSystemUI;
  final int ownerGeneration;
  late PocketSession session;
  Completer<void>? firstFrame;
  Completer<void>? firstVisibleFrame;
  int observedGeneration = 0;
  int announcedGeneration = 0;
  int? reportedFailureGeneration;
  bool firstFrameReady = false;
  bool hasEverProducedFrame = false;
  bool compositorVisible = false;
  bool compositorFocused = false;
  int compositorGeometryRevision = 0;
  Rect? compositorBounds;
  Rect? compositorVisibleClip;
  Size? compositorLogicalViewport;
  bool get isFirstVisibleFrameReady =>
      firstFrameReady &&
      session.failure == null &&
      (isSystemUI || compositorVisible);
  bool closing = false;
  Future<void>? closeFuture;
  Object? startupError;
  late VoidCallback changeListener;
  final GlobalKey<PocketGuestSessionState> guestKey =
      GlobalKey<PocketGuestSessionState>();
}

final class _PendingPlatformRequest {
  const _PendingPlatformRequest({
    required this.requestId,
    required this.source,
    required this.sourceGeneration,
    required this.systemGeneration,
    required this.completer,
    required this.timer,
  });

  final String requestId;
  final _RuntimeInstance source;
  final int sourceGeneration;
  final int systemGeneration;
  final Completer<Object?> completer;
  final Timer timer;
}

PocketAppConfig _ensureSystemCaps(PocketAppConfig config) {
  if (config.additionalCapabilities.contains(_compositorSurfacesCapability)) {
    return config;
  }
  return config.copyWith(
    additionalCapabilities: <String>{
      ...config.additionalCapabilities,
      _compositorSurfacesCapability,
    },
  );
}

final class _SystemRuntimePlugin extends PocketPlugin {
  _SystemRuntimePlugin(
    this.host,
    this.trustedSystemAppId,
    this.ownerGeneration,
  );

  final _PocketSystemHostState host;
  final String trustedSystemAppId;
  final int ownerGeneration;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.system.runtime',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{
      for (final capability in _systemRequestCapabilities)
        capability: PocketPluginCapability(
          name: capability,
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    if (context.appId != trustedSystemAppId) {
      throw const PocketCapabilityException(
        'system_context_denied',
        'System runtime provider was attached to a non-SystemUI session',
      );
    }
    for (final capability in _systemRequestCapabilities) {
      context.registerRequest(
        capability,
        (params) => host._handleSystemCapability(
          trustedSystemAppId,
          ownerGeneration,
          capability,
          Map<String, dynamic>.from(params),
        ),
      );
    }
  }
}

final class _PlatformProxyPlugin extends PocketPlugin {
  _PlatformProxyPlugin(this.host, this.source, this.ownerGeneration);

  final _PocketSystemHostState host;
  final _RuntimeInstance source;
  final int ownerGeneration;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.system.platform-proxy',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{
      for (final capability in _platformRequestCapabilities)
        capability: PocketPluginCapability(
          name: capability,
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    if (context.appId != source.appId) {
      throw const PocketCapabilityException(
        'platform_context_denied',
        'Platform proxy identity does not match its host runtime',
      );
    }
    for (final capability in _platformRequestCapabilities) {
      context.registerRequest(
        capability,
        (params) => host._forwardPlatformRequest(
          source,
          ownerGeneration,
          capability,
          Map<String, dynamic>.from(params),
        ),
      );
    }
  }
}

/// Filesystem and current-scene IO stays bound to one child runtime. These
/// requests intentionally bypass SystemUI's `system.request` router: the
/// caller's controller and generation are the authority for capture.
final class _PlatformImagesPlugin extends PocketPlugin {
  _PlatformImagesPlugin(
    this.host,
    this.source,
    this.ownerGeneration,
    this.sessionGeneration,
    this.captureController,
  );

  final _PocketSystemHostState host;
  final _RuntimeInstance source;
  final int ownerGeneration;
  final int sessionGeneration;
  final PocketViewController captureController;
  late String _appId;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.platform.images',
    version: '1.0.0',
    description: 'App-private scene capture and image IO',
    limits: const PocketPluginLimits(maxResponseBytes: 512 * 1024),
    capabilities: <String, PocketPluginCapability>{
      for (final capability in _platformImageCapabilities)
        capability: PocketPluginCapability(
          name: capability,
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    if (source.isSystemUI ||
        context.appId != source.appId ||
        source.session.appId != source.appId ||
        source.session.generation != sessionGeneration) {
      throw const PocketCapabilityException(
        'platform_context_denied',
        'Image provider must be attached to its current child runtime',
      );
    }
    _appId = context.appId;
    context.registerRequest(
      _platformImagesCaptureCapability,
      (params) => host._captureGuestImage(
        source,
        ownerGeneration: ownerGeneration,
        sessionGeneration: sessionGeneration,
        captureController: captureController,
        appId: _appId,
        params: Map<String, dynamic>.from(params),
      ),
    );
    context.registerRequest(
      _platformImagesReadCapability,
      (params) => host._readGuestImage(
        source,
        ownerGeneration: ownerGeneration,
        sessionGeneration: sessionGeneration,
        appId: _appId,
        params: Map<String, dynamic>.from(params),
      ),
    );
    context.registerRequest(
      _platformImagesListCapability,
      (params) => host._listGuestImages(
        source,
        ownerGeneration: ownerGeneration,
        sessionGeneration: sessionGeneration,
        appId: _appId,
        params: Map<String, dynamic>.from(params),
      ),
    );
    context.registerRequest(
      _platformImagesRemoveCapability,
      (params) => host._removeGuestImage(
        source,
        ownerGeneration: ownerGeneration,
        sessionGeneration: sessionGeneration,
        appId: _appId,
        params: Map<String, dynamic>.from(params),
      ),
    );
  }
}

final class _PocketImageEntryData {
  const _PocketImageEntryData({
    required this.bytes,
    required this.width,
    required this.height,
  });

  final Uint8List bytes;
  final int width;
  final int height;
}

int _imageLimit(
  Map<String, dynamic> params,
  String name, {
  required int maximum,
}) {
  if (!params.containsKey(name)) return maximum;
  final value = params[name];
  if (value is! int || value <= 0 || value > maximum) {
    throw PocketCapabilityException(
      'invalid_request',
      '$name must be an integer in 1..$maximum',
    );
  }
  return value;
}

void _ensureOnlyImageFields(Map<String, dynamic> params, Set<String> allowed) {
  final unexpected = params.keys.where((key) => !allowed.contains(key));
  if (unexpected.isNotEmpty) {
    throw PocketCapabilityException(
      'invalid_request',
      'Unsupported image request fields: ${unexpected.join(', ')}',
    );
  }
}

int _nextPowerOfTwo(int value) {
  var next = 1;
  while (next < value) {
    next <<= 1;
  }
  return next;
}

String _requiredString(Map<String, dynamic> params, String name) {
  final value = params[name];
  if (value is! String || value.trim().isEmpty) {
    throw PocketCapabilityException(
      'invalid_request',
      '$name must be a non-empty string',
    );
  }
  return value;
}

String? _optionalString(Map<String, dynamic> params, String name) {
  final value = params[name];
  if (value == null) return null;
  if (value is! String || value.trim().isEmpty) {
    throw PocketCapabilityException(
      'invalid_request',
      '$name must be a non-empty string when provided',
    );
  }
  return value;
}

PocketCapabilityException _readRemoteError(Object? rawError) {
  if (rawError is String && rawError.isNotEmpty) {
    return PocketCapabilityException('system_request_failed', rawError);
  }
  if (rawError is Map) {
    final error = Map<String, dynamic>.from(rawError);
    final code = error['code'];
    final message = error['message'];
    return PocketCapabilityException(
      code is String && code.isNotEmpty ? code : 'system_request_failed',
      message is String && message.isNotEmpty
          ? message
          : 'SystemUI rejected the platform request',
    );
  }
  return const PocketCapabilityException(
    'system_request_failed',
    'SystemUI rejected the platform request',
  );
}
