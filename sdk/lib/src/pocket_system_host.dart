// This SDK host intentionally reuses the externally managed guest surface.
// ignore_for_file: invalid_use_of_visible_for_testing_member

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_flutter/src/pocket_memory_limits.dart';

import 'pocket_app.dart' show PocketGuestSession, PocketGuestSessionState;
import 'pocket_config.dart';
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
  'platform.messages.send',
  'platform.messages.receive',
];

const List<String> _systemRequestCapabilities = <String>[
  'system.runtime.configure',
  'system.runtime.create',
  'system.runtime.awaitFirstFrame',
  'system.runtime.destroy',
  'system.runtime.post',
  'system.runtime.respond',
  'system.storage.get',
  'system.storage.set',
  'system.storage.remove',
  'system.storage.keys',
];

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
  });

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

  void _publish(List<PocketSystemInstanceSnapshot> next) {
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
  String? _configurationSignature;
  Future<PocketPlatformData>? _platformDataFuture;
  PocketPlatformData? _platformData;
  AppLifecycleState? _lifecycleState;
  int _nextInstanceId = 0;
  int _nextRequestId = 0;
  int _systemUIGeneration = 0;
  bool _disposed = false;

  bool get _lifecycleResumed =>
      _lifecycleState == null || _lifecycleState == AppLifecycleState.resumed;

  @override
  void initState() {
    super.initState();
    _validateHostConfiguration(widget.systemUI, widget.applications);
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
    _systemUIInstance.session = PocketSession(config: systemConfig);
    _systemUIGeneration = _systemUIInstance.session.generation;
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
        _publishFacts();
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
    unawaited(_systemUIInstance.session.close());
    final dataFuture = _platformDataFuture;
    if (dataFuture != null) {
      unawaited(
        dataFuture.then<void>((data) => data.close()).catchError((Object _) {}),
      );
    }
    _controller._detach(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PocketGuestSession(
      config: _systemUIInstance.config,
      session: _systemUIInstance.session,
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
      geometryRevision: instance.compositorGeometryRevision,
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
      // The JS mini-app sheet animates its host surface from the bottom of the
      // root canvas to the top. A child PocketView's RenderBox moves without
      // changing constraints, so Flutter emits no metrics/dependency signal;
      // carry only a revision and let that child measure its own post-layout
      // safe-area intersection. See sdk/docs/EDITOR_PREVIEW_RENDERING.md.
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
      'system.runtime.awaitFirstFrame' => _awaitFirstFrame(params),
      'system.runtime.destroy' => _destroy(params),
      'system.runtime.post' => _post(params),
      'system.runtime.respond' => _respond(params),
      'system.storage.get' => _storageGet(params),
      'system.storage.set' => _storageSet(params),
      'system.storage.remove' => _storageRemove(params),
      'system.storage.keys' => _storageKeys(params),
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
    final inFlight = _configurationFuture;
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
    try {
      await future;
      _ensureOwnerGeneration(ownerGeneration);
    } finally {
      if (identical(_configurationFuture, future)) _configurationFuture = null;
    }
    return <String, Object?>{
      'systemInstanceId': _systemInstanceId,
      'generation': _systemUIInstance.session.generation,
    };
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
      await instance.session.initialize();
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
    final timer = Timer(_platformRequestTimeout, () {
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
    if (configuring != null) await configuring;
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
    _publishFacts();
    if (mounted) setState(() {});
  }

  void _systemUIChanged() {
    if (_disposed) return;
    final generation = _systemUIInstance.session.generation;
    if (generation != _systemUIGeneration) {
      _systemUIGeneration = generation;
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
    _publishFacts();
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

  void _publishFacts() {
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
    ]);
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
