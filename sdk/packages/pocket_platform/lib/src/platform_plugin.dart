// ignore_for_file: invalid_use_of_visible_for_testing_member

import 'dart:async';
import 'dart:collection';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

/// The capability names exported by the platform experience providers.
///
/// URL ingress is deliberately a separate provider from system UI and
/// haptics. A trusted consumer must explicitly construct
/// [PocketDeepLinkPlugin] with one custom URL scheme before the three links
/// capabilities are present.
abstract final class PocketPlatformCapabilities {
  static const String linksInitial = 'platform.links.initial';
  static const String linksLatest = 'platform.links.latest';
  static const String linksEvents = 'platform.links.events';
  static const String systemUiSet = 'platform.systemUi.set';
  static const String hapticsPerform = 'platform.haptics.perform';

  static const Set<String> links = <String>{
    linksInitial,
    linksLatest,
    linksEvents,
  };

  static const Set<String> experience = <String>{systemUiSet, hapticsPerform};
}

const String pocketPlatformPluginId = 'flutter.platform';
const String pocketDeepLinkPluginId = 'flutter.links';
const String pocketPlatformMethodChannelName = 'com.pocketnexus.host/platform';

/// Method-channel boundary used by the Dart provider.
///
/// Keeping this boundary injectable makes admission and lifecycle tests use a
/// fake transport without pretending that a platform URL arrived. The default
/// implementation is the ordinary Flutter [MethodChannel].
abstract interface class PocketPlatformTransport {
  Future<Object?> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]);

  void setMethodCallHandler(PocketPlatformMethodCallHandler? handler);
}

typedef PocketPlatformMethodCallHandler =
    FutureOr<Object?> Function(String method, Object? arguments);

/// Production method-channel transport for iOS and Android URL ingress.
final class MethodChannelPocketPlatformTransport
    implements PocketPlatformTransport {
  MethodChannelPocketPlatformTransport({MethodChannel? channel})
    : channel = channel ?? const MethodChannel(pocketPlatformMethodChannelName);

  final MethodChannel channel;

  @override
  Future<Object?> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) => channel.invokeMethod<Object?>(method, arguments);

  @override
  void setMethodCallHandler(PocketPlatformMethodCallHandler? handler) {
    channel.setMethodCallHandler(
      handler == null
          ? null
          : (call) async => handler(call.method, call.arguments),
    );
  }
}

/// Flutter-only side of the platform experience provider.
///
/// System UI and haptics are ordinary Flutter services, so they do not need
/// another native permission or a second native capability channel. Tests and
/// embedders can inject this interface to observe calls without touching the
/// real device services.
abstract interface class PocketPlatformUi {
  Future<void> setSystemUi(SystemUiOverlayStyle style);
  Future<void> performHaptic(String type);
}

final class FlutterPocketPlatformUi implements PocketPlatformUi {
  const FlutterPocketPlatformUi();

  @override
  Future<void> setSystemUi(SystemUiOverlayStyle style) {
    SystemChrome.setSystemUIOverlayStyle(style);
    return Future<void>.value();
  }

  @override
  Future<void> performHaptic(String type) {
    switch (type) {
      case PocketPlatformHaptics.selection:
        return HapticFeedback.selectionClick();
      case PocketPlatformHaptics.light:
        return HapticFeedback.lightImpact();
      case PocketPlatformHaptics.medium:
        return HapticFeedback.mediumImpact();
      case PocketPlatformHaptics.heavy:
        return HapticFeedback.heavyImpact();
      case PocketPlatformHaptics.vibrate:
        return HapticFeedback.vibrate();
      default:
        throw ArgumentError.value(type, 'type', 'unsupported haptic type');
    }
  }
}

abstract final class PocketPlatformHaptics {
  static const String selection = 'selection';
  static const String light = 'light';
  static const String medium = 'medium';
  static const String heavy = 'heavy';
  static const String vibrate = 'vibrate';

  static const Set<String> all = <String>{
    selection,
    light,
    medium,
    heavy,
    vibrate,
  };
}

/// Monotonic time source used for haptic throttling and short URL callback
/// coalescing. It is deliberately not wall-clock time: a device clock change
/// must not reopen or extend either window.
abstract interface class PocketPlatformClock {
  int get elapsedMicroseconds;
}

final class StopwatchPocketPlatformClock implements PocketPlatformClock {
  StopwatchPocketPlatformClock() : _stopwatch = Stopwatch()..start();

  final Stopwatch _stopwatch;

  @override
  int get elapsedMicroseconds => _stopwatch.elapsedMicroseconds;
}

const PocketPluginSchema _emptyParamsSchema = PocketPluginSchema.object();

const PocketPluginSchema _linkResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    // A missing link is null while a received link is a string. The schema
    // vocabulary has no union node, so unknown is more honest than claiming
    // either one exclusively.
    'uri': PocketPluginSchema.unknown(),
  },
  required: <String>{'uri'},
);

const PocketPluginSchema _linkEventSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'uri': PocketPluginSchema.string()},
  required: <String>{'uri'},
);

const PocketPluginSchema _systemUiStyleSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'statusBarColor': PocketPluginSchema.integer(),
    'systemNavigationBarColor': PocketPluginSchema.integer(),
    'navigationBarColor': PocketPluginSchema.integer(),
    'systemNavigationBarDividerColor': PocketPluginSchema.integer(),
    'navigationBarDividerColor': PocketPluginSchema.integer(),
    'statusBarBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'statusBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'systemNavigationBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'navigationBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'systemStatusBarContrastEnforced': PocketPluginSchema.boolean(),
    'statusBarContrastEnforced': PocketPluginSchema.boolean(),
    'systemNavigationBarContrastEnforced': PocketPluginSchema.boolean(),
    'navigationBarContrastEnforced': PocketPluginSchema.boolean(),
    'reset': PocketPluginSchema.boolean(),
  },
);

const PocketPluginSchema _systemUiParamsSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'statusBarColor': PocketPluginSchema.integer(),
    'systemNavigationBarColor': PocketPluginSchema.integer(),
    'navigationBarColor': PocketPluginSchema.integer(),
    'systemNavigationBarDividerColor': PocketPluginSchema.integer(),
    'navigationBarDividerColor': PocketPluginSchema.integer(),
    'statusBarBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'statusBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'systemNavigationBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'navigationBarIconBrightness': PocketPluginSchema.enumValue(<Object?>[
      'light',
      'dark',
    ]),
    'systemStatusBarContrastEnforced': PocketPluginSchema.boolean(),
    'statusBarContrastEnforced': PocketPluginSchema.boolean(),
    'systemNavigationBarContrastEnforced': PocketPluginSchema.boolean(),
    'navigationBarContrastEnforced': PocketPluginSchema.boolean(),
    'reset': PocketPluginSchema.boolean(),
    // The flat form above is the canonical generated shape. This optional
    // nested form preserves the provider's existing convenience API without
    // pretending that the schema language can express a union.
    'style': _systemUiStyleSchema,
  },
);

const PocketPluginSchema _systemUiResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'applied': PocketPluginSchema.boolean(),
    'reset': PocketPluginSchema.boolean(),
    'queued': PocketPluginSchema.boolean(),
  },
);

const PocketPluginSchema _hapticTypeSchema = PocketPluginSchema.enumValue(
  <Object?>['selection', 'light', 'medium', 'heavy', 'vibrate'],
);

const PocketPluginSchema _hapticParamsSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'type': _hapticTypeSchema,
    'kind': _hapticTypeSchema,
  },
);

const PocketPluginSchema _hapticResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'performed': PocketPluginSchema.boolean(),
    'reason': PocketPluginSchema.enumValue(<Object?>['rate_limited']),
    'type': _hapticTypeSchema,
  },
  required: <String>{'performed', 'type'},
);

final class _UriStamp {
  const _UriStamp(this.uri, this.atMicroseconds);

  final String uri;
  final int atMicroseconds;
}

/// Shared implementation for the two public platform providers.
///
/// The role flags are fixed by the public wrappers below. Keeping the native
/// transport, owner gates, and lifecycle cleanup in one private core avoids a
/// second links state machine while ensuring each public descriptor exposes
/// only its own capabilities.
final class _PocketPlatformPluginCore extends PocketPlugin {
  _PocketPlatformPluginCore({
    required this.pluginId,
    required bool includeExperience,
    required bool includeLinks,
    String? deepLinkScheme,
    Iterable<String>? deepLinkSchemes,
    PocketPlatformTransport? transport,
    PocketPlatformUi? ui,
    PocketPlatformClock? clock,
    this.hapticMinInterval = const Duration(milliseconds: 80),
    this.deepLinkDedupeWindow = const Duration(milliseconds: 250),
    this.maxDeepLinkEvents = 32,
  }) : _includeExperience = includeExperience,
       _includeLinks = includeLinks,
       this.deepLinkSchemes = _resolveSchemes(
         includeLinks,
         deepLinkScheme,
         deepLinkSchemes,
       ),
       _transport = transport ?? MethodChannelPocketPlatformTransport(),
       _ui = ui ?? const FlutterPocketPlatformUi(),
       _clock = clock ?? StopwatchPocketPlatformClock() {
    if (hapticMinInterval.isNegative) {
      throw ArgumentError.value(
        hapticMinInterval,
        'hapticMinInterval',
        'must not be negative',
      );
    }
    if (deepLinkDedupeWindow.isNegative) {
      throw ArgumentError.value(
        deepLinkDedupeWindow,
        'deepLinkDedupeWindow',
        'must not be negative',
      );
    }
    if (maxDeepLinkEvents <= 0) {
      throw ArgumentError.value(
        maxDeepLinkEvents,
        'maxDeepLinkEvents',
        'must be positive',
      );
    }
  }

  final String pluginId;
  final bool _includeExperience;
  final bool _includeLinks;
  final Set<String> deepLinkSchemes;
  final PocketPlatformTransport _transport;
  final PocketPlatformUi _ui;
  final PocketPlatformClock _clock;
  final Duration hapticMinInterval;
  final Duration deepLinkDedupeWindow;
  final int maxDeepLinkEvents;

  final StreamController<Object?> _deepLinkEvents =
      StreamController<Object?>.broadcast(sync: true);
  final Queue<String> _recentUris = Queue<String>();
  final Queue<_UriStamp> _recentUriEvents = Queue<_UriStamp>();
  final Object _systemUiOwnerToken = Object();
  String? _initialUri;
  String? _latestUri;
  int? _lastHapticAtMicroseconds;
  bool _nativeLinksConfigured = false;
  bool _disposed = false;

  static final List<_SystemUiOwner> _systemUiOwners = <_SystemUiOwner>[];
  static SystemUiOverlayStyle? _systemUiBaseStyle;
  static Object? _linksOwner;
  final Object _linksOwnerToken = Object();
  bool _holdsLinksOwner = false;
  int _linksGeneration = 0;
  Future<void>? _linksActivation;

  String? get deepLinkScheme =>
      deepLinkSchemes.isEmpty ? null : deepLinkSchemes.first;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: pluginId,
    version: '1.0.0',
    description: _includeLinks
        ? 'Trusted opt-in URL ingress provider'
        : 'Trusted Flutter system UI and haptics provider',
    limits: const PocketPluginLimits(
      maxConcurrentRequests: 4,
      maxActiveStreams: 1,
      maxResponseBytes: 32 * 1024,
      maxStreamEvents: 256,
      maxStreamEventBytes: 8 * 1024,
    ),
    capabilities: <String, PocketPluginCapability>{
      if (_includeExperience)
        PocketPlatformCapabilities.systemUiSet: const PocketPluginCapability(
          name: PocketPlatformCapabilities.systemUiSet,
          kind: PocketCapabilityKind.request,
          description:
              'Apply an explicitly requested Flutter system overlay style',
          schema: PocketPluginCapabilitySchema(
            parameters: _systemUiParamsSchema,
            result: _systemUiResultSchema,
          ),
        ),
      if (_includeExperience)
        PocketPlatformCapabilities.hapticsPerform: const PocketPluginCapability(
          name: PocketPlatformCapabilities.hapticsPerform,
          kind: PocketCapabilityKind.request,
          description: 'Perform one bounded Flutter haptic feedback operation',
          schema: PocketPluginCapabilitySchema(
            parameters: _hapticParamsSchema,
            result: _hapticResultSchema,
          ),
        ),
      if (_includeLinks)
        PocketPlatformCapabilities.linksInitial: const PocketPluginCapability(
          name: PocketPlatformCapabilities.linksInitial,
          kind: PocketCapabilityKind.request,
          description: 'Read the first URL received since link opt-in',
          schema: PocketPluginCapabilitySchema(
            parameters: _emptyParamsSchema,
            result: _linkResultSchema,
          ),
        ),
      if (_includeLinks)
        PocketPlatformCapabilities.linksLatest: const PocketPluginCapability(
          name: PocketPlatformCapabilities.linksLatest,
          kind: PocketCapabilityKind.request,
          description: 'Read the latest URL received',
          schema: PocketPluginCapabilitySchema(
            parameters: _emptyParamsSchema,
            result: _linkResultSchema,
          ),
        ),
      if (_includeLinks)
        PocketPlatformCapabilities.linksEvents: const PocketPluginCapability(
          name: PocketPlatformCapabilities.linksEvents,
          kind: PocketCapabilityKind.stream,
          description:
              'Receive URL events with short duplicate-callback coalescing',
          schema: PocketPluginCapabilitySchema(
            parameters: _emptyParamsSchema,
            streamItem: _linkEventSchema,
          ),
        ),
    },
  );

  /// The current bounded URL event/snapshot history kept by Dart.
  ///
  /// This is diagnostic state for the enabled provider, not a routing stack.
  List<String> get recentDeepLinks => List<String>.unmodifiable(_recentUris);

  @override
  void register(PocketPluginContext context) {
    if (_includeExperience) {
      context.registerRequest(
        PocketPlatformCapabilities.systemUiSet,
        _setSystemUi,
      );
      context.registerRequest(
        PocketPlatformCapabilities.hapticsPerform,
        _performHaptic,
      );
    }
    if (!_includeLinks) return;
    context.registerRequest(
      PocketPlatformCapabilities.linksInitial,
      (_) => <String, dynamic>{'uri': _initialUri},
    );
    context.registerRequest(
      PocketPlatformCapabilities.linksLatest,
      (_) => <String, dynamic>{'uri': _latestUri},
    );
    context.registerStream(
      PocketPlatformCapabilities.linksEvents,
      (_) => _deepLinkEvents.stream,
    );
  }

  @override
  Future<void> activate(PocketPluginContext context) {
    if (_disposed) {
      return Future<void>.error(StateError('$pluginId is disposed'));
    }
    if (!_includeLinks || _nativeLinksConfigured) {
      return Future<void>.value();
    }
    final pending = _linksActivation;
    if (pending != null) return pending;
    final generation = ++_linksGeneration;
    final future = _activateLinks(generation);
    _linksActivation = future;
    unawaited(
      future.then<void>(
        (_) {
          if (identical(_linksActivation, future)) _linksActivation = null;
        },
        onError: (Object _, StackTrace __) {
          if (identical(_linksActivation, future)) _linksActivation = null;
        },
      ),
    );
    return future;
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    if (_includeLinks) {
      ++_linksGeneration;
      await _waitForLinksActivation();
      await _disableNativeLinks();
    }
    if (_includeExperience) {
      _restoreSystemUi();
      _lastHapticAtMicroseconds = null;
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    if (_includeLinks) {
      ++_linksGeneration;
      await _waitForLinksActivation();
      await _disableNativeLinks();
    }
    if (_includeExperience) _restoreSystemUi();
    await _deepLinkEvents.close();
  }

  Future<Object?> _setSystemUi(Map<String, dynamic> params) async {
    final styleParams = params['style'] is Map
        ? Map<String, dynamic>.from(params['style'] as Map)
        : params;
    if (params['reset'] == true || styleParams['reset'] == true) {
      _restoreSystemUi();
      return <String, dynamic>{'applied': false, 'reset': true};
    }
    final owner = _claimSystemUi();
    final style = _styleFrom(styleParams, base: owner.style);
    owner.style = style;
    if (!_isTopSystemUiOwner(owner)) {
      return <String, dynamic>{'applied': false, 'queued': true};
    }
    try {
      await _ui.setSystemUi(style);
      return <String, dynamic>{'applied': true};
    } catch (_) {
      _restoreSystemUi();
      rethrow;
    }
  }

  Future<Object?> _performHaptic(Map<String, dynamic> params) async {
    final rawType = params['type'] ?? params['kind'];
    if (rawType is! String || !PocketPlatformHaptics.all.contains(rawType)) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'haptic type must be one of selection, light, medium, heavy, vibrate',
      );
    }
    final now = _clock.elapsedMicroseconds;
    final previous = _lastHapticAtMicroseconds;
    if (previous != null &&
        now >= previous &&
        now - previous < hapticMinInterval.inMicroseconds) {
      return <String, dynamic>{
        'performed': false,
        'reason': 'rate_limited',
        'type': rawType,
      };
    }
    _lastHapticAtMicroseconds = now;
    await _ui.performHaptic(rawType);
    return <String, dynamic>{'performed': true, 'type': rawType};
  }

  Future<Object?> _handleNativeMethodCall(
    String method,
    Object? arguments,
  ) async {
    if (method != 'onDeepLink' ||
        !_includeLinks ||
        !_nativeLinksConfigured ||
        !_holdsLinksOwner) {
      return null;
    }
    final uri = _extractUri(arguments);
    if (uri != null) _rememberUri(uri);
    return null;
  }

  void _rememberUri(String uri, {bool emit = true}) {
    if (!_includeLinks || uri.isEmpty) return;
    final expectedScheme = deepLinkScheme;
    final parsed = Uri.tryParse(uri);
    if (expectedScheme == null || parsed?.scheme != expectedScheme) return;
    if (!emit) {
      _primeUri(uri);
      return;
    }
    final now = _clock.elapsedMicroseconds;
    final dedupeMicros = deepLinkDedupeWindow.inMicroseconds;
    final duplicate = _recentUriEvents.any(
      (entry) =>
          entry.uri == uri &&
          now >= entry.atMicroseconds &&
          now - entry.atMicroseconds < dedupeMicros,
    );
    if (duplicate) return;
    _recentUriEvents.addLast(_UriStamp(uri, now));
    while (_recentUriEvents.length > maxDeepLinkEvents) {
      _recentUriEvents.removeFirst();
    }
    _recordRecentUri(uri);
    _initialUri ??= uri;
    _latestUri = uri;
    if (emit && !_deepLinkEvents.isClosed) {
      _deepLinkEvents.add(<String, dynamic>{'uri': uri});
    }
  }

  void _primeUri(String uri) {
    if (!_includeLinks || uri.isEmpty) return;
    _initialUri ??= uri;
    _latestUri = uri;
    // Initial/latest are snapshots, not callback events. Avoid turning two
    // equal native snapshots into duplicate diagnostic entries and, crucially,
    // do not seed the short callback coalescing window.
    if (_recentUris.isEmpty || _recentUris.last != uri) {
      _recordRecentUri(uri);
    }
  }

  void _recordRecentUri(String uri) {
    _recentUris.addLast(uri);
    while (_recentUris.length > maxDeepLinkEvents) {
      _recentUris.removeFirst();
    }
  }

  Future<void> _disableNativeLinks() async {
    if (!_includeLinks || !_holdsLinksOwner) {
      _clearLinkState();
      return;
    }
    try {
      _transport.setMethodCallHandler(null);
    } catch (_) {
      // Continue cleanup and release the process-local owner even if the
      // channel was already torn down.
    }
    try {
      // Revoke even when Dart never completed configureDeepLinks: native may
      // have retained a statically opted-in cold URL before this provider was
      // activated. This closes that preconfiguration window as well as the
      // normal warm callback path.
      await _transport.invoke('disableDeepLinks');
    } catch (_) {
      // Deactivation must still revoke the Dart-side handler if native is
      // already gone (for example after an engine detach).
    }
    _nativeLinksConfigured = false;
    _clearLinkState();
    _releaseLinksOwner();
  }

  Future<void> _activateLinks(int generation) async {
    _claimLinksOwner();
    var configureAttempted = false;
    try {
      _transport.setMethodCallHandler(_handleNativeMethodCall);
      configureAttempted = true;
      await _transport.invoke('configureDeepLinks', <String, dynamic>{
        'enabled': true,
        'scheme': deepLinkScheme,
      });
      if (!_isLiveLinksGeneration(generation)) {
        await _abortLinksActivation(configureAttempted: configureAttempted);
        return;
      }
      _nativeLinksConfigured = true;
      final initial = _extractUri(await _transport.invoke('getInitialLink'));
      if (!_isLiveLinksGeneration(generation)) {
        await _abortLinksActivation(configureAttempted: true);
        return;
      }
      if (initial != null) _rememberUri(initial, emit: false);
      final latest = _extractUri(await _transport.invoke('getLatestLink'));
      if (!_isLiveLinksGeneration(generation)) {
        await _abortLinksActivation(configureAttempted: true);
        return;
      }
      if (latest != null) _rememberUri(latest, emit: false);
    } catch (_) {
      await _abortLinksActivation(configureAttempted: configureAttempted);
      rethrow;
    }
  }

  Future<void> _abortLinksActivation({required bool configureAttempted}) async {
    try {
      _transport.setMethodCallHandler(null);
    } catch (_) {
      // Continue to release the owner even when the channel is already gone.
    }
    if (configureAttempted) {
      try {
        await _transport.invoke('disableDeepLinks');
      } catch (_) {
        // The native engine may have detached between configure and cleanup.
      }
    }
    _nativeLinksConfigured = false;
    _clearLinkState();
    _releaseLinksOwner();
  }

  Future<void> _waitForLinksActivation() async {
    final pending = _linksActivation;
    if (pending == null) return;
    try {
      await pending;
    } catch (_) {
      // The caller that activated the provider receives the original error;
      // teardown only needs to wait until its native cleanup has completed.
    }
  }

  bool _isLiveLinksGeneration(int generation) =>
      !_disposed &&
      generation == _linksGeneration &&
      _holdsLinksOwner &&
      identical(_linksOwner, _linksOwnerToken);

  void _claimLinksOwner() {
    final current = _linksOwner;
    if (current != null && !identical(current, _linksOwnerToken)) {
      throw const PocketCapabilityException(
        'links_owner_busy',
        'another platform links provider instance owns URL ingress',
      );
    }
    _linksOwner = _linksOwnerToken;
    _holdsLinksOwner = true;
  }

  void _releaseLinksOwner() {
    if (identical(_linksOwner, _linksOwnerToken)) {
      _linksOwner = null;
    }
    _holdsLinksOwner = false;
  }

  void _clearLinkState() {
    _nativeLinksConfigured = false;
    _initialUri = null;
    _latestUri = null;
    _recentUris.clear();
    _recentUriEvents.clear();
  }

  _SystemUiOwner _claimSystemUi() {
    for (final owner in _systemUiOwners) {
      if (identical(owner.token, _systemUiOwnerToken)) return owner;
    }
    if (_systemUiOwners.isEmpty) {
      _systemUiBaseStyle =
          SystemChrome.latestStyle ?? const SystemUiOverlayStyle();
    }
    final owner = _SystemUiOwner(
      token: _systemUiOwnerToken,
      ui: _ui,
      style: _systemUiOwners.isEmpty
          ? _systemUiBaseStyle!
          : _systemUiOwners.last.style,
    );
    _systemUiOwners.add(owner);
    return owner;
  }

  bool _isTopSystemUiOwner(_SystemUiOwner owner) =>
      _systemUiOwners.isNotEmpty && identical(_systemUiOwners.last, owner);

  void _restoreSystemUi() {
    final index = _systemUiOwners.indexWhere(
      (owner) => identical(owner.token, _systemUiOwnerToken),
    );
    if (index < 0) return;
    final wasTop = index == _systemUiOwners.length - 1;
    final removed = _systemUiOwners.removeAt(index);
    if (!wasTop) return;
    if (_systemUiOwners.isNotEmpty) {
      final next = _systemUiOwners.last;
      unawaited(next.ui.setSystemUi(next.style));
      return;
    }
    final base = _systemUiBaseStyle ?? const SystemUiOverlayStyle();
    _systemUiBaseStyle = null;
    unawaited(removed.ui.setSystemUi(base));
  }

  SystemUiOverlayStyle _styleFrom(
    Map<String, dynamic> params, {
    required SystemUiOverlayStyle base,
  }) {
    final current = base;
    return current.copyWith(
      statusBarColor: _color(params, 'statusBarColor'),
      systemNavigationBarColor: _color(
        params,
        'systemNavigationBarColor',
        alternate: 'navigationBarColor',
      ),
      systemNavigationBarDividerColor: _color(
        params,
        'systemNavigationBarDividerColor',
        alternate: 'navigationBarDividerColor',
      ),
      statusBarBrightness: _brightness(params, 'statusBarBrightness'),
      statusBarIconBrightness: _brightness(params, 'statusBarIconBrightness'),
      systemNavigationBarIconBrightness: _brightness(
        params,
        'systemNavigationBarIconBrightness',
        alternate: 'navigationBarIconBrightness',
      ),
      systemStatusBarContrastEnforced: _bool(
        params,
        'systemStatusBarContrastEnforced',
        alternate: 'statusBarContrastEnforced',
      ),
      systemNavigationBarContrastEnforced: _bool(
        params,
        'systemNavigationBarContrastEnforced',
        alternate: 'navigationBarContrastEnforced',
      ),
    );
  }

  static ui.Color? _color(
    Map<String, dynamic> params,
    String key, {
    String? alternate,
  }) {
    final value = params.containsKey(key)
        ? params[key]
        : (alternate == null ? null : params[alternate]);
    if (value == null) return null;
    if (value is! num || !value.isFinite || value != value.round()) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$key must be an integer ARGB color',
      );
    }
    final intValue = value.toInt();
    if (intValue < 0 || intValue > 0xffffffff) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$key must be between 0 and 0xffffffff',
      );
    }
    return ui.Color(intValue);
  }

  static ui.Brightness? _brightness(
    Map<String, dynamic> params,
    String key, {
    String? alternate,
  }) {
    final value = params.containsKey(key)
        ? params[key]
        : (alternate == null ? null : params[alternate]);
    if (value == null) return null;
    if (value is! String) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$key must be "light" or "dark"',
      );
    }
    switch (value.toLowerCase()) {
      case 'light':
        return ui.Brightness.light;
      case 'dark':
        return ui.Brightness.dark;
      default:
        throw PocketCapabilityException(
          'invalid_argument',
          '$key must be "light" or "dark"',
        );
    }
  }

  static bool? _bool(
    Map<String, dynamic> params,
    String key, {
    String? alternate,
  }) {
    final value = params.containsKey(key)
        ? params[key]
        : (alternate == null ? null : params[alternate]);
    if (value == null) return null;
    if (value is! bool) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$key must be a boolean',
      );
    }
    return value;
  }

  static String? _extractUri(Object? value) {
    if (value is String && value.trim().isNotEmpty) return value.trim();
    if (value is Map) {
      final uri = value['uri'] ?? value['url'];
      if (uri is String && uri.trim().isNotEmpty) return uri.trim();
    }
    return null;
  }

  static String _validateScheme(String? value) {
    final scheme = value ?? '';
    const forbidden = <String>{
      'http',
      'https',
      'file',
      'data',
      'javascript',
      'content',
      'intent',
    };
    if (scheme.length < 1 ||
        scheme.length > 32 ||
        scheme != scheme.toLowerCase() ||
        forbidden.contains(scheme) ||
        !RegExp(r'^[a-z][a-z0-9+.-]*$').hasMatch(scheme)) {
      throw ArgumentError.value(
        value,
        'deepLinkScheme',
        'must be 1-32 lowercase characters in a custom URL scheme such as pocketapp',
      );
    }
    return scheme;
  }

  static Set<String> _resolveSchemes(
    bool enabled,
    String? singular,
    Iterable<String>? plural,
  ) {
    if (!enabled) return const <String>{};
    if (singular != null && plural != null) {
      throw ArgumentError(
        'provide either deepLinkScheme or deepLinkSchemes, not both',
      );
    }
    final values =
        plural?.toList(growable: false) ??
        (singular == null ? const <String>[] : <String>[singular]);
    if (values.length != 1) {
      throw ArgumentError(
        'exactly one deep link scheme is required when links are enabled',
      );
    }
    return Set<String>.unmodifiable(<String>{_validateScheme(values.single)});
  }
}

/// Flutter system chrome and haptics provider.
///
/// This provider is foreground-only. It has no URL listener and does not
/// configure the native links channel.
final class PocketPlatformPlugin extends PocketPlugin {
  PocketPlatformPlugin({
    PocketPlatformUi? ui,
    PocketPlatformClock? clock,
    Duration hapticMinInterval = const Duration(milliseconds: 80),
  }) : _core = _PocketPlatformPluginCore(
         pluginId: pocketPlatformPluginId,
         includeExperience: true,
         includeLinks: false,
         ui: ui,
         clock: clock,
         hapticMinInterval: hapticMinInterval,
       );

  final _PocketPlatformPluginCore _core;

  @override
  PocketPluginDescriptor get descriptor => _core.descriptor;

  @override
  void register(PocketPluginContext context) => _core.register(context);

  @override
  Future<void> activate(PocketPluginContext context) => _core.activate(context);

  @override
  Future<void> deactivate(PocketPluginContext context) =>
      _core.deactivate(context);

  @override
  Future<void> dispose() => _core.dispose();
}

/// Explicit URL ingress provider.
///
/// URL ingress is background-safe so a foreground-only manager transition
/// revokes UI/haptic capabilities without tearing down this provider's native
/// listener or stream. Full manager disposal still disables and clears it.
final class PocketDeepLinkPlugin extends PocketPlugin {
  PocketDeepLinkPlugin({
    String? deepLinkScheme,
    Iterable<String>? deepLinkSchemes,
    PocketPlatformTransport? transport,
    PocketPlatformClock? clock,
    Duration deepLinkDedupeWindow = const Duration(milliseconds: 250),
    int maxDeepLinkEvents = 32,
  }) : _core = _PocketPlatformPluginCore(
         pluginId: pocketDeepLinkPluginId,
         includeExperience: false,
         includeLinks: true,
         deepLinkScheme: deepLinkScheme,
         deepLinkSchemes: deepLinkSchemes,
         transport: transport,
         clock: clock,
         deepLinkDedupeWindow: deepLinkDedupeWindow,
         maxDeepLinkEvents: maxDeepLinkEvents,
       );

  final _PocketPlatformPluginCore _core;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => _core.descriptor;

  String? get deepLinkScheme => _core.deepLinkScheme;

  /// The bounded diagnostic URL history for this links provider.
  List<String> get recentDeepLinks => _core.recentDeepLinks;

  @override
  void register(PocketPluginContext context) => _core.register(context);

  @override
  Future<void> activate(PocketPluginContext context) => _core.activate(context);

  @override
  Future<void> deactivate(PocketPluginContext context) =>
      _core.deactivate(context);

  @override
  Future<void> dispose() => _core.dispose();
}

final class _SystemUiOwner {
  _SystemUiOwner({required this.token, required this.ui, required this.style});

  final Object token;
  final PocketPlatformUi ui;
  SystemUiOverlayStyle style;
}
