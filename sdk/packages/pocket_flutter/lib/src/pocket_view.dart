import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/scheduler.dart';
import 'package:video_player/video_player.dart';

import 'pocket_assets.dart';
import 'pocket_compositor.dart';
import 'pocket_display.dart';
import 'pocket_display_geometry.dart';
import 'pocket_duplex.dart';
import 'pocket_model.dart';
import 'pocket_package.dart';
import 'pocket_performance.dart';
import 'pocket_recording.dart';
import 'pocket_runtime.dart';
import 'pocket_text_cache.dart';
import 'pocket_worker_runtime.dart';
import 'pocket_offload_runtime.dart';

part 'pocket_view_painter.dart';
part 'pocket_surface.dart';

typedef PocketEventCallback = void Function(PocketEvent event);
typedef PocketDuplexEventCallback = void Function(PocketDuplexEvent event);

final class _PocketQueuedMessage {
  const _PocketQueuedMessage(this.generation, this.message, this.byteLength);

  final int generation;
  final Map<String, dynamic> message;
  final int byteLength;
}

/// Optional test seam for delaying a native texture decode.
///
/// Production native callers leave this null and decode the resource exported
/// from the core texture table. Keeping the seam at the resource boundary
/// lets widget tests deterministically exercise release/reuse races without
/// sleeping or depending on a particular image codec implementation.
typedef PocketImageResourceDecoder =
    Future<ui.Image> Function(PocketImageResource resource);

/// Controller exposed to the surrounding Flutter app.
///
/// Messages are serialized once by the native PocketJS runtime. This is the
/// App -> JS half of the bridge; JS -> App messages arrive through
/// [PocketView.onEvent].
final class PocketViewController {
  static const int maxPendingMessages = 64;
  static const int maxPendingMessageBytes = 1024 * 1024;

  PocketRuntime? _runtime;
  PocketDuplexChannel? _duplexChannel;
  final Set<int> _platformTextures = <int>{};
  VoidCallback? _surfacesChanged;
  final Set<PocketDuplexEventCallback> _duplexListeners =
      <PocketDuplexEventCallback>{};

  /// Only trusted, compiled host providers can authorize a platform texture.
  /// A downloaded guest cannot render an arbitrary Flutter texture handle.
  void authorizePlatformTexture(int textureId) {
    if (textureId >= 0 && _platformTextures.add(textureId))
      _surfacesChanged?.call();
  }

  void revokePlatformTexture(int textureId) {
    if (_platformTextures.remove(textureId)) _surfacesChanged?.call();
  }

  bool get isReady => _runtime != null;

  bool _appActive = true;

  /// Imperative owner-side visibility gate. This composes with
  /// [PocketView.active] and the OS lifecycle; setting it false immediately
  /// makes controller messages queue instead of entering QuickJS.
  bool get appActive => _appActive;

  void setAppActive(bool active) {
    if (_appActive == active) return;
    _appActive = active;
    _onAppActiveChanged?.call();
  }

  /// ABI of the linked native QuickJS runtime, when the attached runtime
  /// exposes bytecode admission. Hosts can include this in runtime.info.
  String? get runtimeAbi => _runtime?.actualAbi;

  /// The lock-free binary channel attached to the current guest generation.
  ///
  /// The channel is owned by [PocketView] and is closed before the runtime is
  /// reloaded or disposed. Hosts may use it for scalar capability messages,
  /// but must not retain it across a guest generation change.
  PocketDuplexChannel? get duplexChannel => _duplexChannel;

  void addDuplexListener(PocketDuplexEventCallback listener) {
    _duplexListeners.add(listener);
  }

  void removeDuplexListener(PocketDuplexEventCallback listener) {
    _duplexListeners.remove(listener);
  }

  VoidCallback? _onMessageSent;
  VoidCallback? _onAppActiveChanged;
  bool Function()? _canSendImmediately;
  final List<_PocketQueuedMessage> _pendingMessages = <_PocketQueuedMessage>[];
  int _pendingMessageBytes = 0;
  int _generation = 0;

  bool send({required String method, Map<String, dynamic> params = const {}}) {
    return _sendEvent(method: method, params: params);
  }

  /// Deliver a raw PocketJS onTextEvent record. This is separate from the
  /// normal Flutter TextField IME bridge; never send the same edit to both.
  bool sendTextEvent({
    required String kind,
    String? text,
    String? key,
    int? selectionStart,
    int? selectionEnd,
    bool repeat = false,
  }) => send(
    method: 'input.text',
    params: <String, dynamic>{
      'kind': kind,
      if (text != null) 'text': text,
      if (key != null) 'key': key,
      if (repeat) 'repeat': true,
      if (selectionStart != null) 'selectionStart': selectionStart,
      if (selectionEnd != null) 'selectionEnd': selectionEnd,
    },
  );

  bool _sendEvent({
    required String method,
    Map<String, dynamic> params = const {},
    bool wake = true,
  }) {
    return _sendMessage(<String, dynamic>{
      'type': 'event',
      'id': 'dart-${DateTime.now().microsecondsSinceEpoch}',
      'name': method,
      'payload': params,
    }, wake: wake);
  }

  /// Sends a protocol message without wrapping it in the normal App event
  /// envelope. PocketAppBridge request promises use the native runtime's
  /// `{type: response, id, result|error}` packet, so capability hosts can
  /// answer a request without inventing a second event spelling.
  bool sendRaw(Map<String, dynamic> message) {
    return _sendMessage(Map<String, dynamic>.from(message), wake: true);
  }

  bool _sendMessage(Map<String, dynamic> message, {required bool wake}) {
    final runtime = _runtime;
    if (runtime == null) return false;
    final canSendImmediately = _canSendImmediately;
    if (canSendImmediately != null && !canSendImmediately()) {
      return _enqueueMessage(message);
    }
    runtime.send(message);
    if (wake) notifyWork();
    return true;
  }

  /// Captures a JSON message only while the guest is hidden. The normal active
  /// path above forwards the existing map directly, avoiding a second encode /
  /// decode on every controller message.
  bool _enqueueMessage(Map<String, dynamic> message) {
    try {
      final encoded = jsonEncode(message);
      final byteLength = utf8.encode(encoded).length;
      if (byteLength > maxPendingMessageBytes ||
          _pendingMessages.length >= maxPendingMessages ||
          _pendingMessageBytes + byteLength > maxPendingMessageBytes) {
        return false;
      }
      final decoded = jsonDecode(encoded);
      if (decoded is! Map) return false;
      final snapshot = Map<String, dynamic>.from(decoded);
      _pendingMessages.add(
        _PocketQueuedMessage(_generation, snapshot, byteLength),
      );
      _pendingMessageBytes += byteLength;
      return true;
    } on Object {
      // Non-JSON payloads cannot be retained safely across a visibility
      // transition. Match the bounded-queue contract by rejecting them.
      return false;
    }
  }

  /// Delivers hidden messages in publication order on the runtime owner
  /// isolate, immediately before the first resumed guest turn.
  void _flushPendingMessages() {
    final runtime = _runtime;
    final canSendImmediately = _canSendImmediately;
    if (runtime == null ||
        (canSendImmediately != null && !canSendImmediately())) {
      return;
    }
    while (_pendingMessages.isNotEmpty) {
      final queued = _pendingMessages.removeAt(0);
      _pendingMessageBytes -= queued.byteLength;
      if (queued.generation != _generation) continue;
      try {
        runtime.send(queued.message);
      } catch (_) {
        _pendingMessages.insert(0, queued);
        _pendingMessageBytes += queued.byteLength;
        rethrow;
      }
    }
  }

  void _clearPendingMessages() {
    _pendingMessages.clear();
    _pendingMessageBytes = 0;
  }

  @visibleForTesting
  int get pendingMessageCount => _pendingMessages.length;

  @visibleForTesting
  int get pendingMessageBytes => _pendingMessageBytes;

  /// Wakes the guest after work was published directly to its native duplex
  /// endpoint. Call this on the runtime owner isolate. A background producer
  /// must schedule this notification on the owner isolate after publishing;
  /// it must never call QuickJS itself.
  void notifyWork() => _onMessageSent?.call();

  void _attach(
    PocketRuntime runtime,
    VoidCallback surfacesChanged, {
    VoidCallback? onMessageSent,
    PocketDuplexChannel? duplexChannel,
    bool Function()? canSendImmediately,
    VoidCallback? onAppActiveChanged,
  }) {
    _clearPendingMessages();
    _generation++;
    _runtime = runtime;
    _duplexChannel = duplexChannel;
    _surfacesChanged = surfacesChanged;
    _onMessageSent = onMessageSent;
    _canSendImmediately = canSendImmediately;
    _onAppActiveChanged = onAppActiveChanged;
  }

  void _detach(PocketRuntime runtime) {
    if (identical(_runtime, runtime)) {
      _runtime = null;
      _duplexChannel = null;
      _platformTextures.clear();
      _surfacesChanged = null;
      _onMessageSent = null;
      _canSendImmediately = null;
      _onAppActiveChanged = null;
      _clearPendingMessages();
    }
  }

  void _clearDuplexChannel(PocketDuplexChannel channel) {
    if (identical(_duplexChannel, channel)) _duplexChannel = null;
  }

  void _dispatchDuplexEvent(PocketDuplexEvent event) {
    for (final listener in List<PocketDuplexEventCallback>.of(
      _duplexListeners,
    )) {
      try {
        listener(event);
      } catch (error, stackTrace) {
        FlutterError.reportError(
          FlutterErrorDetails(
            exception: error,
            stack: stackTrace,
            library: 'pocket_flutter',
            context: ErrorDescription('while delivering a duplex event'),
          ),
        );
      }
    }
  }
}

/// A Flutter-only PocketJS surface.
///
/// PocketJS is evaluated through FFI, but no AndroidView, UiKitView or
/// WebView is created. The guest emits a compact frame JSON. Flutter paints
/// rects, text and images through [CustomPainter]; videos are Flutter texture
/// widgets placed into the same stack and covered by the canvas painter.
class PocketView extends StatefulWidget {
  const PocketView({
    super.key,
    this.runtime,
    this.recordingFactory,
    this.controller,
    this.active = true,
    this.inputEnabled = true,
    this.compositorSurfaces = const {},
    this.hostSurfaceBuilder,
    this.hostSurfaceResidents = const {},
    this.workerProgram,
    this.offloadProviderFactory,
    this.viewport,
    this.tickHz = 60,
    this.fontFamilyFallback = const <String>[],
    this.onBeforeFrame,
    String? jsAsset,
    this.bytecodeAsset,
    this.bytecodeMetadataAsset = 'assets/app.bytecode.json',
    this.bytecodeBytes,
    this.bytecodeMetadata,
    this.pakAsset,
    this.jsSource,
    this.pakBytes,
    this.packageSource,
    this.auxiliaryViewport,
    this.displayGeometry,
    this.imageResourceDecoder,
    this.onReady,
    this.onEvent,
    this.onDuplexEvent,
    this.enableDuplexPointerInput = true,
    this.onError,
    this.onPerformanceSample,
    this.showDebugFps = true,
  }) : jsAsset = jsAsset ?? 'assets/app.js',
       _jsAssetWasExplicit = jsAsset != null;

  final PocketRuntime? runtime;

  /// Optional debug capture created before each fresh native guest loads.
  /// Supplying it opts into bounded recording; an injected runtime must be
  /// configured for recording by its owner instead.
  final PocketRecordingController Function()? recordingFactory;

  /// Whether this surface is eligible to advance its guest. The effective
  /// gate also requires [PocketViewController.appActive] and a resumed OS
  /// lifecycle. A false value still permits one real startup load/first frame
  /// so prewarming can finish, then parks timers, media, IME and rendering.
  final bool active;

  /// Focus gate independent from visibility: unfocused visible children may
  /// animate but cannot own an IME or pointer sequence.
  final bool inputEnabled;
  final Map<String, int> compositorSurfaces;
  final PocketHostSurfaceBuilder? hostSurfaceBuilder;

  /// Live handles kept offstage when absent from the parent's DrawOps.
  final Set<int> hostSurfaceResidents;
  final PocketWorkerProgram? workerProgram;

  /// Creates a trusted provider before evaluation. The runtime owns teardown.
  final PocketOffloadProvider Function()? offloadProviderFactory;

  /// Shows the fixed top-right renderer FPS diagnostic when enabled. This is
  /// available in debug, profile and release builds; keep it false for a
  /// production surface that does not want the overlay.
  final bool showDebugFps;
  final PocketViewController? controller;

  /// Optional logical primary viewport used when this widget creates its own
  /// FFI runtime. When omitted, the first finite LayoutBuilder constraints
  /// become the logical viewport and later constraint changes use the native
  /// live-resize ABI without recreating the guest.
  ///
  /// Injected runtimes keep their own dimensions for tests/hosts, preserving
  /// the old fixed-runtime behavior when no explicit size is supplied.
  final Size? viewport;

  /// Fixed PocketJS core/bundle rate. This must match the `--hz` value used
  /// when [jsAsset] was compiled. The Flutter ticker may run at 60 or 120 Hz;
  /// the native runtime converts each real elapsed delta into one or more
  /// fixed guest/core ticks, so a 120-Hz bundle remains one-second accurate
  /// on a 60-Hz display.
  final int tickHz;

  /// Additional font families tried after the PocketInter/PocketMono slot
  /// family. An empty list preserves the original POC font lookup behavior.
  final List<String> fontFamilyFallback;

  /// Called on the view's ticker immediately before [PocketRuntime.frame].
  /// Hosts can flush transport batches here without creating a second ticker.
  final VoidCallback? onBeforeFrame;

  /// Legacy source entry used only for an explicit source/debug host. When
  /// the default value is left untouched and no package/source override is
  /// supplied, [PocketView] loads `assets/app.qjbc` + `assets/app.pak`.
  final String jsAsset;
  final bool _jsAssetWasExplicit;

  /// Optional real QuickJS bytecode entry. When set, [jsAsset]/[jsSource]
  /// are ignored and no source fallback is attempted.
  final String? bytecodeAsset;

  /// JSON metadata emitted beside [bytecodeAsset]. It binds the asset to the
  /// linked native QuickJS ABI before native admission.
  final String? bytecodeMetadataAsset;

  /// Remote/test bytecode bytes and metadata can be supplied directly instead
  /// of loading the two Flutter assets.
  final Uint8List? bytecodeBytes;
  final String? bytecodeMetadata;

  /// Optional remotely prepared source. When supplied, [jsAsset] is not read.
  final String? jsSource;

  /// Optional PocketJS `.pak` loaded together with [jsAsset].
  ///
  /// Keeping this nullable preserves source-only hosts and injected fake
  /// runtimes; the real Solid page supplies the package explicitly.
  final String? pakAsset;

  /// Optional remotely prepared package bytes. When supplied, [pakAsset] is
  /// not read. [packageSource] is preferred for the real FFI runtime because
  /// it lets native load verified files without copying a large PAK through
  /// Dart memory.
  final Uint8List? pakBytes;

  /// Paths from [PocketPreparedPackage.source]. FfiPocketRuntime uses the
  /// optional pocket_load_files ABI; injected/older runtimes fall back to
  /// reading these two files and calling PocketRuntime.load.
  final PocketPackageSource? packageSource;

  /// Optional logical viewport for PocketJS's second DrawList output.
  ///
  /// The native auxiliary surface must be enabled before the guest is
  /// evaluated. When omitted, the primary-only path remains unchanged.
  final Size? auxiliaryViewport;

  /// Optional UIKit ReservedRegion source. When omitted, PocketView uses the
  /// optional host channel and silently falls back to an empty region list on
  /// platforms that do not register it.
  final PocketDisplayGeometrySource? displayGeometry;

  /// Test-only override for decoding a native resource.
  @visibleForTesting
  final PocketImageResourceDecoder? imageResourceDecoder;
  final ValueChanged<PocketViewController>? onReady;
  final PocketEventCallback? onEvent;
  final PocketDuplexEventCallback? onDuplexEvent;

  /// Routes pointer records through the ABI v2 numeric channel. The native
  /// owner translates the reserved pointer record into the canonical
  /// `input.pointer` path, so existing guests do not need a second JS handler.
  /// Set this to false only for hosts that intentionally reserve the duplex
  /// endpoint for another input producer.
  final bool enableDuplexPointerInput;
  final ValueChanged<Object>? onError;

  /// Receives one immutable renderer performance sample approximately every
  /// second while the view is ticking. Startup loading is excluded: the first
  /// window begins with the first ticker callback after [onReady]. The window
  /// is reset after an app lifecycle pause/resume so background time cannot
  /// become a false slow-frame gap. Hosts own any persistent history.
  final PocketPerformanceSampleCallback? onPerformanceSample;

  @override
  State<PocketView> createState() => _PocketViewState();
}

final class _PocketCanvasGeometry {
  const _PocketCanvasGeometry({required this.size, required this.origin});

  final Size size;
  final Offset origin;
}

@visibleForTesting
PocketFrame? Function(PocketRuntime runtime, double deltaMilliseconds)?
debugPocketFrameDeltaAtOverride;

class _PocketViewState extends State<PocketView>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  static final PocketDisplayGeometrySource _defaultDisplayGeometry =
      PocketDisplayGeometryChannel();
  static const int _maxPointerSlots = 8;
  static const int _duplexPointerMessageType = 1;
  static const int _duplexPointerDown = 1;
  static const int _duplexPointerMove = 2;
  static const int _duplexPointerUp = 3;
  static const int _duplexPointerCancel = 4;
  // Keep the retained-layer count bounded while limiting a text/label update
  // to a small contiguous draw block. Video ops still force a boundary so
  // painter blocks never cross a texture in the original op order.
  static const int _canvasBlockSize = 32;
  static const String _defaultSourceAsset = 'assets/app.js';
  static const String _defaultBytecodeAsset = 'assets/app.qjbc';
  static const String _defaultBytecodeMetadataAsset =
      'assets/app.bytecode.json';
  static const String _defaultPakAsset = 'assets/app.pak';

  late final PocketViewController _controller =
      widget.controller ?? PocketViewController();
  PocketRuntime? _runtime;
  PocketDuplexChannel? _duplexChannel;
  Timer? _idleWakeTimer;
  bool _wakePendingUntilTickerCreated = false;
  bool _deliveringGuestOutput = false;
  bool _workPublishedDuringGuestOutput = false;
  Duration? _idleStartedAt;
  bool _resumedFromIdle = false;
  PocketFrame _frame = PocketFrame.empty();
  PocketSurfaceFrame? _auxiliaryFrame;
  final Map<String, ui.Image> _images = <String, ui.Image>{};
  final PocketTextLayoutCache _textLayoutCache = PocketTextLayoutCache();
  final Map<String, VideoPlayerController> _videos =
      <String, VideoPlayerController>{};
  final Set<String> _loadingImages = <String>{};
  final Map<String, int> _loadingImageRevisions = <String, int>{};
  final Map<String, int> _imageEpochs = <String, int>{};
  final Map<String, int> _imageResourceRevisions = <String, int>{};
  final Set<String> _loadingVideos = <String>{};
  final Set<String> _failedImages = <String>{};
  final Set<String> _failedVideos = <String>{};
  final Map<String, String> _videoAssets = <String, String>{};
  final Map<String, String> _loadingVideoAssets = <String, String>{};
  final Map<String, int> _videoEpochs = <String, int>{};
  final Map<String, bool> _videoVisibility = <String, bool>{};
  // Flutter pointer IDs are host-global and can grow beyond the native touch
  // wire range. Keep them only as map keys; the native bridge receives a
  // bounded, reusable slot in [0, _maxPointerSlots).
  final Map<int, int> _pointerSlots = <int, int>{};
  final Map<int, int> _pointerSurfaceIds = <int, int>{};
  final Map<int, PocketCompositorSlot> _lastCompositorSlots =
      <int, PocketCompositorSlot>{};
  final List<Map<String, dynamic>> _pendingPointerJson =
      <Map<String, dynamic>>[];
  final Map<int, Offset> _outsideTextInputPointerOrigins = <int, Offset>{};
  final Map<int, Offset> _textInputTapRegionDowns = <int, Offset>{};
  // Regions declared by the guest for its own pan gestures. They are logical
  // DrawList coordinates, not host screen rectangles. The Flutter arena uses
  // the declaration only to decide whether the guest or the ancestor
  // Scrollable owns a drag; PocketJS still receives and interprets the input.
  final List<_PocketGestureRegion> _guestGestureRegions =
      <_PocketGestureRegion>[];
  final Map<String, bool> _videoDesiredPlayback = <String, bool>{};
  String? _textInputId;
  String? _textInputEditingSession;
  int _textInputRevision = 0;
  // Guest-controlled value commands have their own revision stream. Keep the
  // latest accepted JS revision separate from the native IME edit revision:
  // a delayed JS prop update must not replay an older value after a newer JS
  // command, while a native edit must still be echoed with the latest JS
  // revision acknowledged by this Flutter editor.
  int _textInputJsRevision = 0;
  Rect? _textInputRect;
  // A JS scroll viewport can clip the input shell independently of the
  // shell's current visual rect. Keep it in surface coordinates so the
  // platform TextField cannot float above a page header/navigation bar while
  // the guest content is scrolled.
  Rect? _textInputClipRect;
  TextEditingController? _textInputController;
  FocusNode? _textInputFocusNode;
  TextInputType _textInputKeyboardType = TextInputType.text;
  TextInputAction _textInputAction = TextInputAction.done;
  bool _textInputObscure = false;
  bool _textInputAutocorrect = true;
  int? _textInputMaxLines = 1;
  int? _textInputMinLines;
  // Visual input properties are supplied by the JS shell. The Flutter layer
  // owns the real editor/IME, but it must not replace the JS component's
  // appearance with a host-default dark field while that editor is focused.
  String? _textInputHintText;
  Color _textInputTextColor = const Color(0xff283444);
  Color _textInputHintColor = const Color(0xff667485);
  Color _textInputFillColor = Colors.white;
  Color _textInputBorderColor = const Color(0xff9aa5b2);
  Color _textInputFocusedBorderColor = const Color(0xff2676cb);
  double _textInputBorderRadius = 8;
  double _textInputFontSize = 14;
  FontWeight _textInputFontWeight = FontWeight.normal;
  double _textInputPaddingHorizontal = 12;
  double _textInputPaddingVertical = 8;
  bool _applyingTextInputValue = false;
  bool _suppressTextInputFocusEvents = false;
  FocusNode? _scheduledTextInputBlurNode;
  String? _scheduledOutsideTextInputId;
  Ticker? _ticker;
  // Ticker.elapsed is relative to the current Ticker instance and resets when
  // an idle ticker is restarted. Flutter's frame timestamp is monotonic for
  // the scheduler, including frames produced while this view's ticker is
  // stopped, so it is the correct clock for both native guest time and FPS
  // accounting. Lifecycle pauses explicitly clear the baseline below.
  Duration? _lastSchedulerTimestamp;
  int _idleWakeCreditMicroseconds = 0;

  @visibleForTesting
  int get idleWakeCreditMicroseconds => _idleWakeCreditMicroseconds;
  bool _isDisposed = false;
  double _firstFrameDeltaMs = 1000.0 / 60.0;

  void _cancelScheduledWake() {
    _idleWakeTimer?.cancel();
    _idleWakeTimer = null;
  }

  void _wakeTicker() {
    // Guest events are delivered after the native frame has already captured
    // its scheduling snapshot. If one of those callbacks publishes more work,
    // the current ticker callback cannot consume it; remember to keep one
    // following guest turn alive instead of parking on the stale snapshot.
    if (_deliveringGuestOutput) _workPublishedDuringGuestOutput = true;
    _cancelScheduledWake();
    if (_isDisposed || !_effectiveActive || !mounted || _runtime == null)
      return;
    final ticker = _ticker;
    if (ticker == null) {
      // Startup callbacks such as onReady/controller responses can dispatch
      // work before the ticker has been created. Preserve that direct wake.
      _wakePendingUntilTickerCreated = true;
      return;
    }
    if (!ticker.isActive) {
      if (_idleStartedAt != null) _resumedFromIdle = true;
      ticker.start();
    }
  }

  @visibleForTesting
  bool get isTickerActive => _ticker?.isActive ?? false;

  @visibleForTesting
  bool get hasScheduledWake => _idleWakeTimer != null;
  Object? _error;
  bool _loading = true;
  bool _ownsRuntime = false;
  bool _lifecyclePaused = false;
  bool _started = false;
  Size? _hostConstraints;
  Size? _pendingResize;
  bool _resizeScheduled = false;
  bool _resizeUnavailable = false;
  Duration? _performanceWindowStart;
  Duration? _performanceLastTick;
  int _performanceFrames = 0;
  double _performanceMaxGapMs = 0;
  int _performanceSlowFrames = 0;
  final List<double> _performanceNativeDurationsMs = <double>[];
  double? _fps;
  double? _sessionMinFps;
  double _refreshHz = 60;
  final GlobalKey _hostKey = GlobalKey(debugLabel: 'pocket-host');
  late final PocketDisplayGeometrySource _displayGeometry =
      widget.displayGeometry ?? _defaultDisplayGeometry;
  late final PocketDisplayGeometryUpdate _displayGeometryListener =
      _onDisplayGeometryUpdate;
  PocketDisplayGeometrySnapshot _displayGeometrySnapshot =
      const PocketDisplayGeometrySnapshot.empty();
  bool _displayGeometryStarted = false;
  bool _safeAreaReportScheduled = false;
  Size? _reportedViewport;
  EdgeInsets? _reportedSafeArea;
  double? _reportedKeyboardInset;
  String? _reportedReservedRegionsKey;

  bool get _effectiveActive =>
      widget.active && _controller.appActive && !_lifecyclePaused;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startDisplayGeometry();
  }

  Future<void> _startDisplayGeometry() async {
    if (_displayGeometryStarted || !mounted) return;
    _displayGeometryStarted = true;
    try {
      final snapshot = await _displayGeometry.start(
        onUpdate: _displayGeometryListener,
      );
      if (!mounted) return;
      _displayGeometrySnapshot = snapshot;
      _scheduleSafeAreaReport();
    } catch (_) {
      // The bridge is optional. Keep the normal safe-area contract when a
      // host has no ReservedRegion provider or the channel is unavailable.
      if (mounted) _scheduleSafeAreaReport();
    }
  }

  void _onDisplayGeometryUpdate(PocketDisplayGeometrySnapshot snapshot) {
    if (!mounted) return;
    _displayGeometrySnapshot = snapshot;
    _scheduleSafeAreaReport();
  }

  Future<void> _stopDisplayGeometry() async {
    try {
      await _displayGeometry.stop(onUpdate: _displayGeometryListener);
    } catch (_) {
      // Geometry is optional and disposal must not surface a late channel
      // failure as an unhandled Future.
    }
  }

  @override
  void didUpdateWidget(covariant PocketView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.recordingFactory, widget.recordingFactory)) {
      throw StateError('Remount PocketView to change its recording factory');
    }
    if (!mapEquals(oldWidget.compositorSurfaces, widget.compositorSurfaces)) {
      throw StateError('Remount PocketView to change compositor registration');
    }
    if (oldWidget.inputEnabled && !widget.inputEnabled) {
      _cancelPointerSequences();
      _dismissTextInput(reason: 'focus.lost', rebuild: false);
    }
    if (oldWidget.viewport != widget.viewport &&
        _isUsableSize(widget.viewport)) {
      _scheduleResize(widget.viewport!);
    }
    if (oldWidget.active != widget.active) _syncGuestActivity();
    final wasCollecting =
        oldWidget.showDebugFps || oldWidget.onPerformanceSample != null;
    final isCollecting =
        widget.showDebugFps || widget.onPerformanceSample != null;
    if (wasCollecting != isCollecting) {
      _resetPerformanceWindow();
      // The performance window is intentionally restarted when collection is
      // toggled. Do not let an idle interval from the previous window be
      // consumed by the first sample in the new window.
      _resumedFromIdle = false;
      _idleStartedAt = null;
    }
  }

  void _onControllerActivityChanged() {
    if (!mounted) return;
    _syncGuestActivity();
  }

  void _syncGuestActivity() {
    if (_effectiveActive) {
      _resumeGuestForActivity();
    } else {
      _pauseGuestForActivity();
    }
  }

  /// Stops every source of guest advancement for a hidden surface. The
  /// scheduler pause is also sent to native so QuickJS timer deadlines do not
  /// accumulate while Flutter has no ticker.
  void _pauseGuestForActivity() {
    final runtime = _runtime;
    _cancelPointerSequences();
    _cancelScheduledWake();
    _ticker?.stop();
    _lastSchedulerTimestamp = null;
    _wakePendingUntilTickerCreated = false;
    _idleStartedAt = null;
    _resumedFromIdle = false;
    _resetPerformanceWindow();
    if (runtime != null) pocketSetSchedulerPaused(runtime, true);
    _dismissTextInput(reason: 'inactive', rebuild: false);
    for (final entry in _videos.entries) {
      _videoDesiredPlayback[entry.key] ??= entry.value.value.isPlaying;
      unawaited(
        _applyVideoPlayback(
          entry.key,
          entry.value,
          visible: _videoVisibility[entry.key] ?? false,
        ),
      );
    }
  }

  /// Resumes only when both public visibility gates and the OS lifecycle allow
  /// it. Hidden messages are flushed in order on this owner isolate before a
  /// single guest turn; no hidden wall-clock time is added to its delta.
  void _resumeGuestForActivity() {
    final runtime = _runtime;
    if (runtime == null || !_effectiveActive || !mounted) return;
    pocketSetSchedulerPaused(runtime, false);
    final desiredViewport = widget.viewport ?? _hostConstraints;
    if (_isUsableSize(desiredViewport) &&
        (desiredViewport!.width != _frame.width ||
            desiredViewport.height != _frame.height)) {
      _scheduleResize(desiredViewport);
    }
    try {
      _controller._flushPendingMessages();
    } catch (error) {
      _failRuntime(error);
      return;
    }
    _lastSchedulerTimestamp = null;
    _refreshHz = _readRefreshRate();
    _firstFrameDeltaMs = 1000.0 / _refreshHz;
    _resetPerformanceWindow();
    final ticker = _ticker ??= createTicker(_onTick);
    _wakePendingUntilTickerCreated = false;
    if (!ticker.isActive) ticker.start();
    for (final entry in _videos.entries) {
      unawaited(
        _applyVideoPlayback(
          entry.key,
          entry.value,
          visible: _videoVisibility[entry.key] ?? false,
        ),
      );
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Register the inherited dependency explicitly; the actual lookup is
    // performed later from the host RenderBox after layout. Depend on the
    // current ModalRoute as well so route coverage changes wake a sleeping
    // guest when its view becomes visible again.
    MediaQuery.maybeOf(context);
    ModalRoute.of(context);
    _wakeTicker();
    _scheduleStartIfReady();
    _scheduleSafeAreaReport();
  }

  @override
  void didChangeMetrics() {
    super.didChangeMetrics();
    // viewPadding can change on rotation, multi-window moves, or a system
    // bar transition. Report it after layout so the host rectangle and its
    // intersection with the FlutterView are current. The report also carries
    // the logical keyboard inset so a guest can reposition its requested rect
    // after the system keyboard changes the available viewport. Do not infer
    // an input-session close from a transient zero inset: iOS can publish a
    // zero while the keyboard is transitioning, and the Flutter focus node or
    // an explicit guest close is the authoritative dismissal signal.
    _wakeTicker();
    _scheduleSafeAreaReport();
  }

  bool _isUsableSize(Size? size) {
    return size != null &&
        size.width.isFinite &&
        size.height.isFinite &&
        size.width > 0 &&
        size.height > 0;
  }

  void _scheduleStartIfReady() {
    if (_started || !mounted) return;
    // A self-owned runtime needs a real bounded host to establish its
    // logical viewport when no fixed preview size was requested. An injected
    // runtime already owns its viewport and can start immediately.
    if (widget.runtime == null &&
        widget.viewport == null &&
        !_isUsableSize(_hostConstraints)) {
      return;
    }
    _started = true;
    unawaited(_start());
  }

  void _observeConstraints(BoxConstraints constraints) {
    if (!constraints.hasBoundedWidth || !constraints.hasBoundedHeight) return;
    final next = Size(constraints.maxWidth, constraints.maxHeight);
    if (!_isUsableSize(next) || _hostConstraints == next) return;
    final wasKnown = _hostConstraints != null;
    _hostConstraints = next;
    _scheduleSafeAreaReport();
    if (!wasKnown) {
      _scheduleStartIfReady();
      return;
    }
    if (widget.runtime == null &&
        widget.viewport == null &&
        _runtime != null &&
        !_resizeUnavailable) {
      _scheduleResize(next);
    }
  }

  void _scheduleResize(Size size) {
    _pendingResize = size;
    if (_resizeScheduled) return;
    _resizeScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _resizeScheduled = false;
      final next = _pendingResize;
      _pendingResize = null;
      if (!mounted || next == null) return;
      _resizeRuntime(next);
    });
  }

  void _resizeRuntime(Size size) {
    final runtime = _runtime;
    if (runtime == null || !_effectiveActive || widget.runtime != null) {
      return;
    }
    _wakeTicker();
    try {
      if (!runtime.resizeViewport(size.width, size.height)) {
        // Older native libraries retain their original logical viewport. The
        // Flutter surface still fits that frame, but do not retry this ABI
        // lookup on every layout pass.
        _resizeUnavailable = true;
        return;
      }
      // The resize event and the new root layout are observable immediately;
      // obtain the first post-resize frame without advancing guest time.
      final deltaFn = debugPocketFrameDeltaAtOverride ?? pocketFrameDeltaAt;
      final next = deltaFn(runtime, 0);
      _idleWakeCreditMicroseconds = 0;
      if (_lastSchedulerTimestamp != null &&
          SchedulerBinding.instance.schedulerPhase ==
              SchedulerPhase.persistentCallbacks) {
        _lastSchedulerTimestamp =
            SchedulerBinding.instance.currentSystemFrameTimeStamp;
      } else {
        _lastSchedulerTimestamp = null;
      }
      // Apply scheduling after decoded frame events and duplex egress callbacks
      // have had a chance to publish new owner-thread work.
      _beginGuestOutputDelivery();
      try {
        if (next != null) _applyFrame(next);
        _drainDuplexEvents();
      } finally {
        _finishGuestOutputDelivery();
      }
      _scheduleSafeAreaReport();
    } catch (error) {
      _failRuntime(error);
    }
  }

  Future<void> _start() async {
    PocketRuntime? startupRuntime;
    try {
      if (widget.runtime != null && widget.recordingFactory != null) {
        throw ArgumentError(
          'An injected runtime owns its recording configuration',
        );
      }
      final viewport = widget.viewport;
      _refreshHz = _readRefreshRate();
      if (_refreshHz.isFinite && _refreshHz > 0) {
        // This is only the first-ticker fallback. Subsequent callbacks use
        // their actual elapsed timestamps; no 120-Hz work is fabricated on a
        // 60-Hz display. Native tickHz remains the bundle/core rate.
        _firstFrameDeltaMs = 1000.0 / _refreshHz;
      }
      final runtimeViewport = viewport ?? _hostConstraints;
      if (widget.runtime == null && !_isUsableSize(runtimeViewport)) {
        throw ArgumentError.value(
          runtimeViewport,
          'viewport',
          'must have finite positive dimensions',
        );
      }
      if (widget.tickHz < 1 || widget.tickHz > 120) {
        throw RangeError.range(widget.tickHz, 1, 120, 'tickHz');
      }
      final runtime = startupRuntime =
          widget.runtime ??
          FfiPocketRuntime.open(
            recording: widget.recordingFactory?.call(),
            width: runtimeViewport!.width,
            height: runtimeViewport.height,
            rasterDensity: pocketRasterDensity(
              View.of(context).devicePixelRatio,
            ),
            tickHz: widget.tickHz,
          );
      if (widget.compositorSurfaces.isNotEmpty) {
        if (runtime is! PocketCompositorRuntime) {
          throw UnsupportedError(
            'Runtime does not support compositor registration',
          );
        }
        (runtime as PocketCompositorRuntime).configureCompositor(
          widget.compositorSurfaces,
        );
      }
      final offloadFactory = widget.offloadProviderFactory;
      if (offloadFactory != null) {
        if (runtime is! PocketOffloadRuntime) {
          throw UnsupportedError('Runtime does not support PocketJS offload');
        }
        final provider = offloadFactory();
        try {
          (runtime as PocketOffloadRuntime).configureOffload(
            provider,
            onWake: () {
              if (mounted && !_isDisposed) _wakeTicker();
            },
          );
        } catch (_) {
          unawaited(provider.close().catchError((Object _) {}));
          rethrow;
        }
      }
      final worker = widget.workerProgram;
      if (worker != null) {
        if (runtime is! PocketWorkerRuntime) {
          throw UnsupportedError('Runtime does not support PocketJS workers');
        }
        (runtime as PocketWorkerRuntime).configureWorker(
          worker,
          onWake: () {
            if (mounted && !_isDisposed) _wakeTicker();
          },
        );
      }
      final ownsRuntime = widget.runtime == null;
      _ownsRuntime = ownsRuntime;
      final auxiliaryViewport = widget.auxiliaryViewport;
      if (auxiliaryViewport != null) {
        if (!auxiliaryViewport.width.isFinite ||
            !auxiliaryViewport.height.isFinite ||
            auxiliaryViewport.width <= 0 ||
            auxiliaryViewport.height <= 0) {
          throw ArgumentError.value(
            auxiliaryViewport,
            'auxiliaryViewport',
            'must have finite positive dimensions',
          );
        }
        runtime.enableAuxiliary(
          auxiliaryViewport.width,
          auxiliaryViewport.height,
        );
      }
      final implicitBytecode =
          widget.bytecodeAsset == null &&
          widget.bytecodeBytes == null &&
          widget.packageSource == null &&
          widget.jsSource == null &&
          widget.pakAsset == null &&
          widget.pakBytes == null &&
          widget.bytecodeMetadataAsset == _defaultBytecodeMetadataAsset &&
          !widget._jsAssetWasExplicit &&
          widget.jsAsset == _defaultSourceAsset;
      final bytecodeMode =
          implicitBytecode ||
          widget.bytecodeAsset != null ||
          widget.bytecodeBytes != null;
      final source = bytecodeMode
          ? ''
          : widget.jsSource ??
                (widget.packageSource == null
                    ? await rootBundle.loadString(widget.jsAsset)
                    : '');
      final first = implicitBytecode
          ? await _loadBytecodeAssets(
              runtime,
              bytecodeAsset: _defaultBytecodeAsset,
              metadataAsset: _defaultBytecodeMetadataAsset,
              pakAsset: _defaultPakAsset,
            )
          : await _loadPreparedPackage(runtime, source);
      if (!mounted) {
        _detachRuntime(fallback: runtime);
        return;
      }
      _runtime = runtime;
      // Loading can finish while the app is backgrounded or explicitly hidden.
      // Synchronize native wall-clock accounting before attaching callbacks;
      // the startup load/first frame above remains the one permitted prewarm
      // turn, while all later guest work is gated by effective activity.
      pocketSetSchedulerPaused(runtime, !_effectiveActive);
      _duplexChannel = _openDuplexChannel(runtime);
      _controller._attach(
        runtime,
        () {
          if (mounted) setState(() {});
        },
        onMessageSent: _wakeTicker,
        duplexChannel: _duplexChannel,
        canSendImmediately: () => _effectiveActive,
        onAppActiveChanged: _onControllerActivityChanged,
      );
      final visualFirst = _visualFrame(first);
      _frame = visualFirst;
      _auxiliaryFrame = visualFirst.auxiliary;
      _loading = false;
      widget.onReady?.call(_controller);
      if (!mounted) return;
      _requestResources(first);
      _handleEvents(first.events);
      setState(() {});
      _scheduleSafeAreaReport();
      _ticker = createTicker(_onTick);
      // Runtime loading/evaluation and the first frame above are startup
      // work, not display samples. Begin the bounded performance window only
      // when the post-startup ticker is about to run.
      _lastSchedulerTimestamp =
          SchedulerBinding.instance.currentSystemFrameTimeStamp;
      _resetPerformanceWindow();
      if (_effectiveActive) {
        final wakePending = _wakePendingUntilTickerCreated;
        _wakePendingUntilTickerCreated = false;
        if (wakePending) {
          _ticker!.start();
        } else {
          _applyRuntimeScheduleAfterGuestTurn();
        }
      } else {
        // A hidden/prewarmed view may have emitted an IME or video event from
        // its initial frame. Close/pause those platform resources now that
        // startup has completed, while retaining the guest's visual frame.
        _pauseGuestForActivity();
      }
    } catch (error) {
      _detachRuntime(fallback: startupRuntime);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error;
      });
      widget.onError?.call(error);
    }
  }

  Future<PocketFrame> _loadPreparedPackage(
    PocketRuntime runtime,
    String source,
  ) async {
    final packageSource = widget.packageSource;
    // A prepared package is authoritative when present. This matters when a
    // host also supplies its built-in bytecode asset as a UI fallback: the
    // signed package must win, and a bytecode entry must never be decoded as
    // UTF-8 source.
    if (packageSource != null) {
      if (packageSource.entryFormat == 'quickjs-bytecode' ||
          packageSource.entryFormat == 'bytecode') {
        if (runtime is FfiPocketRuntime) {
          return runtime.loadBytecodeFiles(
            bytecodePath: packageSource.entryPath,
            pakPath: packageSource.pakPath,
            expectedRuntimeAbi: packageSource.runtimeAbi,
          );
        }
        final bytes = await File(packageSource.entryPath).readAsBytes();
        return runtime.loadBytecode(
          Uint8List.fromList(bytes),
          await _readPakFile(packageSource.pakPath),
          expectedRuntimeAbi: packageSource.runtimeAbi,
        );
      }
      if (runtime is FfiPocketRuntime) {
        try {
          return await runtime.loadFiles(
            sourcePath: packageSource.entryPath,
            pakPath: packageSource.pakPath,
          );
        } on UnsupportedError {
          // Older mobile binaries predate the path ABI. Fall through to the
          // safe, compatible byte-copy path below.
        }
      }
      final fallbackSource = source.isEmpty
          ? await File(packageSource.entryPath).readAsString()
          : source;
      return runtime.load(
        fallbackSource,
        await _readPakFile(packageSource.pakPath),
      );
    }
    final bytecodeAsset = widget.bytecodeAsset;
    final bytecodeBytes = widget.bytecodeBytes;
    if (bytecodeAsset != null || bytecodeBytes != null) {
      final bytes = bytecodeBytes ?? await _loadBinaryAsset(bytecodeAsset!);
      final metadataSource =
          widget.bytecodeMetadata ??
          (widget.bytecodeMetadataAsset == null
              ? null
              : await rootBundle.loadString(widget.bytecodeMetadataAsset!));
      if (metadataSource == null) {
        throw const PocketRuntimeException(
          'bytecode metadata asset is required; source fallback is disabled',
        );
      }
      return _loadBytecodePayload(
        runtime,
        bytes,
        metadataSource,
        widget.pakBytes ??
            (widget.pakAsset == null ? null : await _loadPak(widget.pakAsset!)),
      );
    }
    final pak =
        widget.pakBytes ??
        (widget.pakAsset == null ? null : await _loadPak(widget.pakAsset!));
    return pak == null ? runtime.eval(source) : runtime.load(source, pak);
  }

  Future<PocketFrame> _loadBytecodeAssets(
    PocketRuntime runtime, {
    required String bytecodeAsset,
    required String metadataAsset,
    required String pakAsset,
  }) async {
    final bytes = await _loadBinaryAsset(bytecodeAsset);
    final metadataSource = await rootBundle.loadString(metadataAsset);
    final pak = await _loadPak(pakAsset);
    return _loadBytecodePayload(runtime, bytes, metadataSource, pak);
  }

  PocketFrame _loadBytecodePayload(
    PocketRuntime runtime,
    Uint8List bytes,
    String metadataSource,
    Uint8List? pak,
  ) {
    if (pak == null) {
      throw const PocketRuntimeException(
        'bytecode loading requires a PAK asset',
      );
    }
    final metadata = PocketBytecodeMetadata.fromJsonString(metadataSource);
    if (metadata.entryFormat != 'quickjs-bytecode' ||
        metadata.kind != 'script' ||
        metadata.formatVersion != 1 ||
        metadata.bindingGeneration <= 0 ||
        metadata.tickHz != widget.tickHz ||
        metadata.bytecodeBytes != bytes.length) {
      throw const PocketRuntimeException(
        'bytecode metadata does not match host entry',
      );
    }
    final actualAbi = runtime.actualAbi;
    if (actualAbi != null && actualAbi != metadata.runtimeAbi) {
      throw PocketRuntimeException(
        'bytecode runtimeAbi mismatch: package=${metadata.runtimeAbi} host=$actualAbi',
      );
    }
    return runtime.loadBytecode(
      bytes,
      pak,
      expectedRuntimeAbi: metadata.runtimeAbi,
    );
  }

  Future<Uint8List> _loadPak(String asset) async {
    final data = await rootBundle.load(asset);
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  }

  Future<Uint8List> _loadBinaryAsset(String asset) async {
    final data = await rootBundle.load(asset);
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  }

  Future<Uint8List> _readPakFile(String filePath) async {
    final bytes = await File(filePath).readAsBytes();
    return Uint8List.fromList(bytes);
  }

  double _readRefreshRate() {
    final refreshRate = View.of(context).display.refreshRate;
    if (refreshRate.isFinite && refreshRate > 0) return refreshRate;
    return 60;
  }

  PocketDuplexChannel? _openDuplexChannel(PocketRuntime runtime) {
    if (runtime is! PocketBinaryDuplexRuntime) return null;
    try {
      return PocketDuplexChannel.fromRuntime(
        runtime as PocketBinaryDuplexRuntime,
        onIngressPublished: _wakeTicker,
      );
    } on UnsupportedError {
      // Older native libraries do not expose ABI v2. The JSON bridge remains
      // the compatibility path for those hosts.
      return null;
    } on StateError {
      // A host may have explicitly claimed the endpoint for another
      // embedding. Do not fail guest startup merely because the optional
      // transport is unavailable.
      return null;
    }
  }

  void _drainDuplexEvents() {
    final channel = _duplexChannel;
    if (channel == null || channel.isClosed) return;
    try {
      final events = channel.drainFromPocketJs();
      if (events.isEmpty) return;
      for (final event in events) {
        _controller._dispatchDuplexEvent(event);
        final callback = widget.onDuplexEvent;
        if (callback != null) {
          try {
            callback(event);
          } catch (error, stackTrace) {
            FlutterError.reportError(
              FlutterErrorDetails(
                exception: error,
                stack: stackTrace,
                library: 'pocket_flutter',
                context: ErrorDescription(
                  'while delivering PocketView.onDuplexEvent',
                ),
              ),
            );
          }
        }
      }
    } catch (error) {
      // A stale endpoint can race a reload/dispose. Close it and keep the
      // regular JSON frame path alive; endpoint errors must not tear down the
      // guest that owns the view.
      channel.close();
      _duplexChannel = null;
      _controller._clearDuplexChannel(channel);
      if (mounted)
        FlutterError.reportError(
          FlutterErrorDetails(
            exception: error,
            library: 'pocket_flutter',
            context: ErrorDescription('while draining Pocket duplex events'),
          ),
        );
    }
  }

  void _markRuntimeSleeping() {
    // Keep the first timestamp across arbitrarily long idle/deadline waits so
    // FPS accounting excludes the entire intentional sleep interval.
    final alreadyIdle = _idleStartedAt != null;
    _idleStartedAt ??= _lastSchedulerTimestamp;
    if (!alreadyIdle) _resumedFromIdle = false;
  }

  /// Applies the native scheduling snapshot after a completed guest turn.
  /// Injected/legacy runtimes default to continuous vsync because they cannot
  /// prove that the guest has no pending deadline.
  void _applyRuntimeScheduleAfterGuestTurn() {
    final runtime = _runtime;
    if (_isDisposed || !_effectiveActive || !mounted || runtime == null) {
      _cancelScheduledWake();
      _ticker?.stop();
      return;
    }

    final delayMs = pocketNextWakeDelayMilliseconds(runtime);
    if (!delayMs.isFinite || delayMs == 0) {
      // Zero and invalid snapshots are conservatively treated as continuous.
      _cancelScheduledWake();
      final ticker = _ticker;
      if (ticker != null && !ticker.isActive) ticker.start();
      return;
    }

    _cancelScheduledWake();
    _markRuntimeSleeping();
    _ticker?.stop();
    if (delayMs < 0) return;

    final scheduledRuntime = runtime;
    final microseconds = (delayMs * 1000).ceil();
    late final Timer scheduledWake;
    scheduledWake = Timer(
      Duration(microseconds: microseconds < 1 ? 1 : microseconds),
      () {
        if (!identical(_idleWakeTimer, scheduledWake) ||
            !identical(_runtime, scheduledRuntime)) {
          return;
        }
        _idleWakeTimer = null;
        _wakeTicker();
      },
    );
    _idleWakeTimer = scheduledWake;
  }

  void _beginGuestOutputDelivery() {
    _workPublishedDuringGuestOutput = false;
    _deliveringGuestOutput = true;
  }

  void _finishGuestOutputDelivery() {
    _deliveringGuestOutput = false;
    final publishedWork = _workPublishedDuringGuestOutput;
    _workPublishedDuringGuestOutput = false;
    if (!publishedWork) {
      _applyRuntimeScheduleAfterGuestTurn();
      return;
    }

    // A host callback sent a response or published a duplex record after the
    // native capture. Give that ingress one owner-thread frame before asking
    // the native scheduler for a fresh snapshot.
    _cancelScheduledWake();
    if (_isDisposed || !_effectiveActive || !mounted || _runtime == null) {
      _ticker?.stop();
      return;
    }
    final ticker = _ticker;
    if (ticker == null) {
      _wakePendingUntilTickerCreated = true;
    } else if (!ticker.isActive) {
      if (_idleStartedAt != null) _resumedFromIdle = true;
      ticker.start();
    }
  }

  bool get _performanceCollectionEnabled =>
      widget.showDebugFps || widget.onPerformanceSample != null;

  void _resetPerformanceWindow() {
    _performanceWindowStart = null;
    _performanceLastTick = null;
    _performanceFrames = 0;
    _performanceMaxGapMs = 0;
    _performanceSlowFrames = 0;
    _performanceNativeDurationsMs.clear();
    _fps = null;
  }

  double _nativeDurationP95() {
    if (_performanceNativeDurationsMs.isEmpty) return 0;
    final sorted = List<double>.of(_performanceNativeDurationsMs)..sort();
    final index = ((sorted.length - 1) * 0.95).ceil();
    return sorted[index];
  }

  void _recordPerformanceTick(Duration elapsed, Duration nativeDuration) {
    final clockElapsed = elapsed;
    if (_performanceWindowStart == null) {
      // This baseline is created after runtime loading, so startup
      // evaluation and the initial frame are intentionally excluded.
      _performanceWindowStart = clockElapsed;
      _performanceLastTick = clockElapsed;
      // A known-idle guest may not have produced a ticker callback before its
      // first later wake. In that case no pre-idle performance interval
      // exists to adjust, so establish a fresh baseline here.
      if (_resumedFromIdle) {
        _resumedFromIdle = false;
        _idleStartedAt = null;
      }
      return;
    }
    final previous = _performanceLastTick;
    if (previous == null) return;
    var gapMs = math
        .max(
          0.0,
          (clockElapsed - previous).inMicroseconds /
              Duration.microsecondsPerSecond *
              1000.0,
        )
        .toDouble();
    if (_resumedFromIdle) {
      // Idle sleep is intentional and must not be reported as a dropped
      // display frame. Keep the active performance window continuous by
      // removing the sleep interval from its elapsed denominator.
      final idleStarted = _idleStartedAt;
      if (idleStarted != null && _performanceWindowStart != null) {
        _performanceWindowStart =
            _performanceWindowStart! + (clockElapsed - idleStarted);
      }
      _resumedFromIdle = false;
      _idleStartedAt = null;
      gapMs = 0;
    }
    _performanceMaxGapMs = math.max(_performanceMaxGapMs, gapMs).toDouble();
    final frameBudgetMs = 1000.0 / _refreshHz;
    if (gapMs > frameBudgetMs * 1.5) _performanceSlowFrames++;
    _performanceLastTick = clockElapsed;
    _performanceFrames++;
    _performanceNativeDurationsMs.add(
      nativeDuration.inMicroseconds / Duration.microsecondsPerSecond * 1000.0,
    );

    final start = _performanceWindowStart!;
    final durationMs =
        (clockElapsed - start).inMicroseconds /
        Duration.microsecondsPerSecond *
        1000.0;
    if (durationMs < 1000 || _performanceFrames == 0) return;

    final fps = _performanceFrames * 1000.0 / durationMs;
    _fps = fps;
    final previousMinimum = _sessionMinFps;
    _sessionMinFps = previousMinimum == null
        ? fps
        : math.min(previousMinimum, fps);
    final sample = PocketPerformanceSample(
      timestamp: DateTime.now().toUtc(),
      fps: fps,
      frames: _performanceFrames,
      durationMs: durationMs,
      maxGapMs: _performanceMaxGapMs,
      slowFrames: _performanceSlowFrames,
      nativeMsP95: _nativeDurationP95(),
      refreshHz: _refreshHz,
    );
    final callback = widget.onPerformanceSample;
    if (callback != null) {
      try {
        callback(sample);
      } catch (error, stackTrace) {
        // Diagnostics must never stop the render ticker or turn a callback
        // failure into a runtime rollback. Keep it in Flutter's diagnostics
        // channel instead of invoking the runtime error callback.
        FlutterError.reportError(
          FlutterErrorDetails(
            exception: error,
            stack: stackTrace,
            library: 'pocket_flutter',
            context: ErrorDescription(
              'while delivering PocketView.onPerformanceSample',
            ),
          ),
        );
      }
    }
    if (widget.showDebugFps && mounted) setState(() {});
    // Keep only the current one-second window; the host owns persistent
    // history. Preserve the elapsed baseline so a long first gap in the next
    // window remains visible instead of being discarded at this boundary.
    _performanceWindowStart = clockElapsed;
    _performanceLastTick = clockElapsed;
    _performanceFrames = 0;
    _performanceMaxGapMs = 0;
    _performanceSlowFrames = 0;
    _performanceNativeDurationsMs.clear();
  }

  void _onTick(Duration _) {
    final runtime = _runtime;
    if (runtime == null || !mounted) return;
    if (!_effectiveActive) {
      _ticker?.stop();
      return;
    }
    _wakePendingUntilTickerCreated = false;
    final clockElapsed = SchedulerBinding.instance.currentSystemFrameTimeStamp;
    final previous = _lastSchedulerTimestamp;
    _lastSchedulerTimestamp = clockElapsed;
    // Preserve the scheduler's fractional delta.  Truncating a 16.667ms
    // display interval to 16ms slowly starves a fixed 60/120Hz native clock;
    // pocketFrameDeltaAt keeps the old integer seam for injected tests but
    // forwards the precise value through the real FFI ABI.
    final delta = previous == null
        ? _firstFrameDeltaMs
        : (clockElapsed - previous).inMicroseconds /
              Duration.microsecondsPerSecond *
              1000.0;
    final frameDelta = delta.isFinite && delta > 0 ? delta : 0.0;
    try {
      widget.onBeforeFrame?.call();
      // A pointer edge that fell back because the duplex ring was full must
      // reach the native queue before this frame boundary. Otherwise the
      // post-frame outside-editor dismiss can enqueue `textInput.dismiss`
      // first, and the guest may process the dismiss/re-layout before the
      // pending pointer-up snapshot is consumed by its next frame.
      _flushPendingPointerJson();
      final stopwatch = _performanceCollectionEnabled
          ? (Stopwatch()..start())
          : null;
      PocketFrame? next;
      try {
        // This public seam measures the whole renderer bridge path: FFI,
        // compact binary frame copy and decode for the real runtime.
        // Keep the compatibility sample key `nativeMsP95`, but do not read it
        // as a pure native-CPU measurement.
        final deltaFn = debugPocketFrameDeltaAtOverride ?? pocketFrameDeltaAt;
        next = deltaFn(runtime, frameDelta);
      } finally {
        stopwatch?.stop();
      }
      // Scheduling is independent of DrawList equality: a guest can retain the
      // same pixels while a timeout needs a future turn, and a host callback
      // can publish new work after this native frame captured its status.
      _beginGuestOutputDelivery();
      try {
        if (next != null) {
          if (stopwatch != null) {
            _recordPerformanceTick(clockElapsed, stopwatch.elapsed);
          }
          _applyFrame(next);
        }
        _drainDuplexEvents();
      } finally {
        _finishGuestOutputDelivery();
      }
    } catch (error) {
      _failRuntime(error);
    }
  }

  PocketFrame _visualFrame(PocketFrame frame) {
    if (frame.events.isEmpty &&
        frame.resources.isEmpty &&
        frame.releasedResources.isEmpty) {
      return frame;
    }
    return PocketFrame(
      width: frame.width,
      height: frame.height,
      ops: frame.ops,
      events: const <PocketEvent>[],
      resources: const <PocketImageResource>[],
      releasedResources: const <String>[],
      auxiliary: frame.auxiliary,
    );
  }

  static bool _isVisibleApplicationSurface(
    PocketHostSurfaceOp op,
    PocketFrame frame,
  ) {
    var rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
    final clip = op.clip;
    if (clip != null) {
      rect = rect.intersect(
        Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
      );
    }
    final frameBounds = Rect.fromLTWH(0, 0, frame.width, frame.height);
    rect = rect.intersect(frameBounds);
    return rect.width > 0 && rect.height > 0;
  }

  void _applyFrame(PocketFrame next) {
    if (identical(_frame, next)) return;
    final visual = _visualFrame(next);
    int? focusedApplication(PocketFrame frame) {
      for (final op in frame.ops.whereType<PocketHostSurfaceOp>()) {
        if (op.kind == 'application' &&
            op.focused &&
            _isVisibleApplicationSurface(op, frame)) {
          return op.surfaceHandle;
        }
      }
      return null;
    }

    final previousFocus = focusedApplication(_frame);
    final nextFocus = focusedApplication(visual);
    _frame = visual;
    _auxiliaryFrame = visual.auxiliary;
    _requestResources(next);
    if (nextFocus != null && nextFocus != previousFocus) {
      _cancelPointerSequences();
      _dismissTextInput(reason: 'compositor.focus', rebuild: false);
    }
    _handleEvents(next.events);
    _scheduleSafeAreaReport();
    if (mounted) setState(() {});
  }

  void _scheduleSafeAreaReport() {
    if (_safeAreaReportScheduled || !mounted) return;
    _safeAreaReportScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _safeAreaReportScheduled = false;
      _reportSafeArea();
    });
  }

  /// Geometry actually used by the primary surface in [_buildContent].
  ///
  /// A self-owned runtime without an explicit preview viewport is the live
  /// host mode. During a native resize it deliberately keeps the old frame at
  /// 1:1, top-left anchored, and clipped by the host until the next frame
  /// arrives. Safe-area and keyboard coordinates must use that same geometry;
  /// independently aspect-fitting the old frame would report a fictitious
  /// inset while the IME or a Duo fold is animating.
  _PocketCanvasGeometry _canvasGeometryForHost(RenderBox host) {
    final automaticViewport =
        widget.runtime == null &&
        widget.viewport == null &&
        !_resizeUnavailable;
    final canvasSize = automaticViewport
        ? Size(_frame.width, _frame.height)
        : _fitSurfaceSize(
            _frame.width,
            _frame.height,
            BoxConstraints.tight(host.size),
          );
    final origin = automaticViewport
        ? Offset.zero
        : Offset(
            (host.size.width - canvasSize.width) / 2,
            (host.size.height - canvasSize.height) / 2,
          );
    return _PocketCanvasGeometry(size: canvasSize, origin: origin);
  }

  /// Returns the safe-area overlap in the guest canvas's logical coordinates.
  /// Using the render box instead of blindly forwarding the whole device
  /// padding matters when PocketView is nested or is already below a Flutter
  /// SafeArea: the latter exposes a reduced viewPadding and the former only
  /// receives the portion of the system bars that overlaps this host
  /// rectangle. Mapping through the actual aspect-fitted canvas also keeps a
  /// fixed logical preview from receiving host-DP values in a different
  /// coordinate space.
  EdgeInsets _safeAreaForHost(
    RenderBox host,
    BuildContext context, {
    _PocketCanvasGeometry? geometry,
  }) {
    if (!host.size.width.isFinite ||
        !host.size.height.isFinite ||
        host.size.width <= 0 ||
        host.size.height <= 0) {
      return EdgeInsets.zero;
    }
    final view = View.of(context);
    final devicePixelRatio = view.devicePixelRatio;
    final viewSize = devicePixelRatio > 0
        ? view.physicalSize / devicePixelRatio
        : Size.zero;
    final media = MediaQuery.maybeOf(context);
    final viewPadding =
        media?.viewPadding ?? MediaQueryData.fromView(view).viewPadding;
    final canvasGeometry = geometry ?? _canvasGeometryForHost(host);
    final canvasSize = canvasGeometry.size;
    if (canvasSize.width <= 0 || canvasSize.height <= 0) {
      return EdgeInsets.zero;
    }
    final canvasOrigin = host.localToGlobal(canvasGeometry.origin);
    final rect = canvasOrigin & canvasSize;
    final scaleX = canvasSize.width / _frame.width;
    final scaleY = canvasSize.height / _frame.height;

    double overlapBefore(double boundary, double start, double length) {
      if (!boundary.isFinite || !start.isFinite || !length.isFinite) {
        return 0;
      }
      return (boundary - start).clamp(0.0, length).toDouble();
    }

    double overlapAfter(double boundary, double end, double length) {
      if (!boundary.isFinite || !end.isFinite || !length.isFinite) return 0;
      return (end - boundary).clamp(0.0, length).toDouble();
    }

    return EdgeInsets.only(
      top: overlapBefore(viewPadding.top, rect.top, rect.height) / scaleY,
      right:
          overlapAfter(
            viewSize.width - viewPadding.right,
            rect.right,
            rect.width,
          ) /
          scaleX,
      bottom:
          overlapAfter(
            viewSize.height - viewPadding.bottom,
            rect.bottom,
            rect.height,
          ) /
          scaleY,
      left: overlapBefore(viewPadding.left, rect.left, rect.width) / scaleX,
    );
  }

  /// UIKit can publish a new ReservedRegion snapshot one frame before the
  /// FlutterView metrics settle. Do not pair that snapshot with the previous
  /// viewPadding: on Duo this briefly reports the closed/open edge as a huge
  /// safe area and makes JS resize its whole page. The next Flutter metrics
  /// callback schedules the report again once both coordinate spaces agree.
  bool _displayGeometryMatchesView(BuildContext context, RenderBox host) {
    final snapshotViewport = _displayGeometrySnapshot.viewport;
    if (!_displayGeometrySnapshot.supported || snapshotViewport == null) {
      // A native snapshot is optional on older platforms. The self-owned
      // runtime still needs the frame/host check below during a resize,
      // because a stale renderer frame can otherwise be paired with the new
      // Flutter layout even when no ReservedRegion snapshot is available.
    } else {
      final view = View.of(context);
      final devicePixelRatio = view.devicePixelRatio;
      if (!devicePixelRatio.isFinite || devicePixelRatio <= 0) return false;
      final viewSize = view.physicalSize / devicePixelRatio;
      if (!viewSize.width.isFinite || !viewSize.height.isFinite) return false;
      const tolerance = 1.0;
      if ((snapshotViewport.width - viewSize.width).abs() > tolerance ||
          (snapshotViewport.height - viewSize.height).abs() > tolerance) {
        return false;
      }
    }

    // In live self-owned mode Flutter can lay out the host one frame before
    // the native resize call returns the first frame at the new viewport.
    // Do not convert safe-area/reserved-region coordinates with the old
    // _frame in that interval. Fixed preview/injected runtimes intentionally
    // fit their logical frame, so this guard is limited to automatic mode.
    final automaticViewport =
        widget.runtime == null &&
        widget.viewport == null &&
        !_resizeUnavailable;
    if (!automaticViewport || !host.hasSize) return true;
    final frame = Size(_frame.width, _frame.height);
    final expectedHostSize = _hostConstraints ?? host.size;
    const tolerance = 1.0;
    return frame.width.isFinite &&
        frame.height.isFinite &&
        frame.width > 0 &&
        frame.height > 0 &&
        expectedHostSize.width.isFinite &&
        expectedHostSize.height.isFinite &&
        (frame.width - expectedHostSize.width).abs() <= tolerance &&
        (frame.height - expectedHostSize.height).abs() <= tolerance;
  }

  /// Returns the portion of the software keyboard that overlaps the actual
  /// guest canvas, in guest logical pixels. `viewInsets` is measured against
  /// the FlutterView, not against an already padded/nested PocketView. Using
  /// the host/canvas intersection prevents a SafeArea or split-window host
  /// from forwarding the whole display inset a second time.
  double _keyboardInsetForHost(
    RenderBox host,
    BuildContext context, {
    _PocketCanvasGeometry? geometry,
  }) {
    final canvasGeometry = geometry ?? _canvasGeometryForHost(host);
    final canvasSize = canvasGeometry.size;
    if (canvasSize.width <= 0 ||
        canvasSize.height <= 0 ||
        !_frame.width.isFinite ||
        !_frame.height.isFinite ||
        _frame.width <= 0 ||
        _frame.height <= 0) {
      return 0;
    }
    final view = View.of(context);
    final devicePixelRatio = view.devicePixelRatio;
    if (!devicePixelRatio.isFinite || devicePixelRatio <= 0) return 0;
    final viewSize = view.physicalSize / devicePixelRatio;
    final inset = view.viewInsets.bottom / devicePixelRatio;
    if (!viewSize.height.isFinite ||
        !inset.isFinite ||
        inset <= 0 ||
        viewSize.height <= 0) {
      return 0;
    }
    final canvasOrigin = host.localToGlobal(canvasGeometry.origin);
    final canvasRect = canvasOrigin & canvasSize;
    final keyboardTop = viewSize.height - inset;
    final overlap = (canvasRect.bottom - keyboardTop)
        .clamp(0.0, canvasRect.height)
        .toDouble();
    final scaleY = canvasSize.height / _frame.height;
    if (!scaleY.isFinite || scaleY <= 0) return 0;
    return overlap / scaleY;
  }

  /// Converts platform-view ReservedRegion frames into the current guest
  /// canvas coordinates. UIKit reports these in the Flutter root view; a
  /// PocketView may be nested, padded, clipped, or aspect-fitted, so sending
  /// the raw window rectangles would move JS controls to the wrong place.
  List<Map<String, dynamic>> _reservedRegionsForHost(
    RenderBox host,
    _PocketCanvasGeometry geometry,
  ) {
    final canvasSize = geometry.size;
    if (canvasSize.width <= 0 || canvasSize.height <= 0) {
      return const <Map<String, dynamic>>[];
    }
    final scaleX = canvasSize.width / _frame.width;
    final scaleY = canvasSize.height / _frame.height;
    if (!scaleX.isFinite || !scaleY.isFinite || scaleX <= 0 || scaleY <= 0) {
      return const <Map<String, dynamic>>[];
    }
    final canvasOrigin = host.localToGlobal(geometry.origin);
    final canvasRect = canvasOrigin & canvasSize;
    final result = <Map<String, dynamic>>[];
    for (final region in _displayGeometrySnapshot.regions) {
      final visible = region.frame.intersect(canvasRect);
      if (visible.isEmpty) continue;
      final local = Rect.fromLTRB(
        ((visible.left - canvasRect.left) / scaleX).clamp(0.0, _frame.width),
        ((visible.top - canvasRect.top) / scaleY).clamp(0.0, _frame.height),
        ((visible.right - canvasRect.left) / scaleX).clamp(0.0, _frame.width),
        ((visible.bottom - canvasRect.top) / scaleY).clamp(0.0, _frame.height),
      );
      if (local.isEmpty) continue;
      result.add(<String, dynamic>{
        'id': region.id,
        'kind': region.kind,
        'frame': <String, double>{
          'left': local.left,
          'top': local.top,
          'width': local.width,
          'height': local.height,
        },
        'margins': <String, double>{
          'top': region.margins.top / scaleY,
          'right': region.margins.right / scaleX,
          'bottom': region.margins.bottom / scaleY,
          'left': region.margins.left / scaleX,
        },
        'active': region.active,
      });
    }
    return result;
  }

  String _reservedRegionsKey(List<Map<String, dynamic>> regions) {
    final buffer = StringBuffer();
    for (final region in regions) {
      buffer
        ..write(region['id'])
        ..write('|')
        ..write(region['kind'])
        ..write('|')
        ..write(region['active'])
        ..write('|');
      final frame = region['frame'] as Map<String, double>;
      buffer
        ..write(frame['left'])
        ..write(',')
        ..write(frame['top'])
        ..write(',')
        ..write(frame['width'])
        ..write(',')
        ..write(frame['height'])
        ..write('|');
      final margins = region['margins'] as Map<String, double>;
      buffer
        ..write(margins['top'])
        ..write(',')
        ..write(margins['right'])
        ..write(',')
        ..write(margins['bottom'])
        ..write(',')
        ..write(margins['left'])
        ..write(';');
    }
    return buffer.toString();
  }

  void _reportSafeArea() {
    final runtime = _runtime;
    if (runtime == null || !mounted) return;
    final hostContext = _hostKey.currentContext;
    if (hostContext == null) return;
    final renderObject = hostContext.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) return;
    if (!_displayGeometryMatchesView(hostContext, renderObject)) return;
    final geometry = _canvasGeometryForHost(renderObject);
    final safeArea = _safeAreaForHost(
      renderObject,
      hostContext,
      geometry: geometry,
    );
    final viewport = Size(_frame.width, _frame.height);
    if (!viewport.width.isFinite ||
        !viewport.height.isFinite ||
        viewport.width <= 0 ||
        viewport.height <= 0) {
      return;
    }
    final keyboardInset = _keyboardInsetForHost(
      renderObject,
      hostContext,
      geometry: geometry,
    );
    final reservedRegions = _reservedRegionsForHost(renderObject, geometry);
    final reservedRegionsKey = _reservedRegionsKey(reservedRegions);
    if (_reportedViewport == viewport &&
        _reportedSafeArea == safeArea &&
        _reportedKeyboardInset == keyboardInset &&
        _reportedReservedRegionsKey == reservedRegionsKey) {
      return;
    }
    // Native already owns the canonical resize ABI. This is an additive host
    // event sent through the existing FFI bridge so the guest receives the
    // same display.viewport contract with Flutter's logical safe-area data,
    // without remounting or adding a second runtime channel.
    try {
      final payload = <String, dynamic>{
        'width': viewport.width,
        'height': viewport.height,
        'safeArea': <String, double>{
          'top': safeArea.top,
          'right': safeArea.right,
          'bottom': safeArea.bottom,
          'left': safeArea.left,
        },
        'keyboardInset': keyboardInset,
        'reservedRegions': reservedRegions,
      };
      if (_controller.send(method: 'display.viewport', params: payload)) {
        _reportedViewport = viewport;
        _reportedSafeArea = safeArea;
        _reportedKeyboardInset = keyboardInset;
        _reportedReservedRegionsKey = reservedRegionsKey;
      }
    } catch (error) {
      _failRuntime(error);
    }
  }

  void _requestResources(PocketFrame frame) {
    _releaseImages(frame.releasedResources);
    // Prefer native texture-table resources. This keeps package parsing and
    // texture admission in Rust while still allowing the old PAK fallback
    // below when an older host does not send resources.
    for (final resource in frame.resources) {
      _loadImageResource(resource);
    }
    final videoRequests = <String, _PocketVideoRequest>{};
    void collectResources(List<PocketOp> ops, double width, double height) {
      for (final op in ops) {
        if (op is PocketImageOp) _loadImage(op.asset);
        if (op is PocketVideoOp) {
          final request = _PocketVideoRequest(
            op: op,
            visible: _isVideoVisible(op, width: width, height: height),
          );
          final previous = videoRequests[op.id];
          if (previous == null || (!previous.visible && request.visible)) {
            videoRequests[op.id] = request;
          }
        }
      }
    }

    collectResources(frame.ops, frame.width, frame.height);
    final auxiliary = frame.auxiliary;
    if (auxiliary != null) {
      collectResources(auxiliary.ops, auxiliary.width, auxiliary.height);
    }

    // A texture is owned by the current DrawList, not by the lifetime of the
    // whole PocketView. Retire both loaded and in-flight videos that no
    // longer occur in either surface. The epoch prevents a late initialize()
    // from re-inserting a controller after this point.
    final activeVideoIds = <String>{
      ..._videos.keys,
      ..._loadingVideos,
      ..._loadingVideoAssets.keys,
    };
    for (final id in activeVideoIds) {
      if (!videoRequests.containsKey(id)) {
        _releaseVideo(id, resetDesiredPlayback: true);
      }
    }

    for (final entry in videoRequests.entries) {
      final id = entry.key;
      final request = entry.value;
      final op = request.op;
      final previousVisible = _videoVisibility[id];
      _videoVisibility[id] = request.visible;

      final loadedAsset = _videoAssets[id] ?? _loadingVideoAssets[id];
      if (loadedAsset != null && loadedAsset != op.asset) {
        // A resource identity is (id, asset), not just id. Reset the default
        // playback intent for a newly loaded asset; a later JS event can set
        // it again before initialization completes.
        _releaseVideo(id, resetDesiredPlayback: true);
        _videoVisibility[id] = request.visible;
      }

      final video = _videos[id];
      if (!request.visible) {
        if (video != null) {
          unawaited(_applyVideoPlayback(id, video, visible: false));
        } else if (_loadingVideos.contains(id)) {
          // Do not finish an invisible first load. The platform create cannot
          // be synchronously cancelled, so invalidate its epoch and dispose
          // the controller when initialize() eventually returns.
          _invalidateVideoLoad(id);
        }
        continue;
      }

      if (video != null) {
        // Playback is synchronized only on a state transition. This keeps a
        // static DrawList from issuing play() on every engine frame.
        if (previousVisible != true || video.value.isPlaying != true) {
          unawaited(_applyVideoPlayback(id, video, visible: true));
        }
      } else {
        _loadVideo(op);
      }
    }
  }

  bool _isVideoVisible(
    PocketVideoOp op, {
    required double width,
    required double height,
  }) {
    if (![
      width,
      height,
      op.x,
      op.y,
      op.width,
      op.height,
    ].every((value) => value.isFinite)) {
      return false;
    }
    if (width <= 0 || height <= 0 || op.width <= 0 || op.height <= 0) {
      return false;
    }
    var visible = Rect.fromLTWH(
      0,
      0,
      width,
      height,
    ).intersect(Rect.fromLTWH(op.x, op.y, op.width, op.height));
    final clip = op.clip;
    if (clip != null) {
      if (![
        clip.x,
        clip.y,
        clip.width,
        clip.height,
      ].every((value) => value.isFinite)) {
        return false;
      }
      visible = visible.intersect(
        Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
      );
    }
    return visible.width > 0 && visible.height > 0;
  }

  void _invalidateVideoLoad(String id) {
    if (!_loadingVideos.remove(id)) return;
    _loadingVideoAssets.remove(id);
    _videoEpochs[id] = (_videoEpochs[id] ?? 0) + 1;
  }

  void _releaseVideo(String id, {bool resetDesiredPlayback = false}) {
    _videoEpochs[id] = (_videoEpochs[id] ?? 0) + 1;
    _loadingVideos.remove(id);
    _loadingVideoAssets.remove(id);
    _videoVisibility.remove(id);
    _videoAssets.remove(id);
    if (resetDesiredPlayback) _videoDesiredPlayback.remove(id);
    final video = _videos.remove(id);
    if (video != null) unawaited(video.dispose());
  }

  /// Retire native textures before admitting resources from the same frame.
  ///
  /// Native texture keys include a generation. The complete key can therefore
  /// be reused after a release, but an in-flight decode for the previous
  /// generation must not be allowed to write the old pixels into that slot.
  void _releaseImages(Iterable<String> assets) {
    for (final asset in assets.toSet()) {
      if (asset.isEmpty) continue;
      _imageEpochs[asset] = (_imageEpochs[asset] ?? 0) + 1;
      _images.remove(asset)?.dispose();
      _failedImages.remove(asset);
      _imageResourceRevisions.remove(asset);
      // A release explicitly retires an in-flight decode. The old Future's
      // epoch check keeps it from removing a newer load's marker in finally.
      _loadingImages.remove(asset);
      _loadingImageRevisions.remove(asset);
    }
  }

  Future<void> _loadImageResource(PocketImageResource resource) async {
    final asset = resource.asset;
    final revision = resource.revision;
    if (asset.isEmpty) return;
    final loadedRevision = _imageResourceRevisions[asset];
    if (_images.containsKey(asset) && loadedRevision == revision) return;
    if (loadedRevision != null && revision < loadedRevision) {
      // Frames are ordered, but do not let a late older resource overwrite a
      // newer in-place texture update if a host queues work asynchronously.
      return;
    }
    if (_loadingImages.contains(asset)) {
      if (_loadingImageRevisions[asset] == revision) return;
      // A newer revision supersedes an in-flight decode for the same asset.
      // Advance the epoch before starting the replacement so the old Future
      // cannot install stale pixels or clear the new loading marker.
      _imageEpochs[asset] = (_imageEpochs[asset] ?? 0) + 1;
      _loadingImages.remove(asset);
      _loadingImageRevisions.remove(asset);
    }
    _loadingImages.add(asset);
    _loadingImageRevisions[asset] = revision;
    final epoch = _imageEpochs[asset] ?? 0;
    final decoder = widget.imageResourceDecoder;
    final image = decoder == null
        ? PocketPakImages.fromResource(resource)
        : null;
    if (decoder == null && image == null) {
      if (_imageEpochs[asset] == epoch) {
        _loadingImages.remove(asset);
        _loadingImageRevisions.remove(asset);
      }
      return;
    }
    try {
      final decoded = await (decoder == null
          ? image!.decode()
          : decoder(resource));
      if (!mounted || (_imageEpochs[asset] ?? 0) != epoch) {
        decoded.dispose();
        return;
      }
      _images.remove(asset)?.dispose();
      _images[asset] = decoded;
      _imageResourceRevisions[asset] = revision;
      _failedImages.remove(asset);
      setState(() {});
    } catch (error) {
      if ((_imageEpochs[asset] ?? 0) == epoch) {
        _failedImages.add(asset);
        if (mounted) widget.onError?.call(error);
      }
    } finally {
      if ((_imageEpochs[asset] ?? 0) == epoch) {
        _loadingImages.remove(asset);
        _loadingImageRevisions.remove(asset);
      }
    }
  }

  Future<void> _loadImage(String asset) async {
    if (asset.isEmpty ||
        _images.containsKey(asset) ||
        _failedImages.contains(asset) ||
        !_loadingImages.add(asset)) {
      return;
    }
    final epoch = _imageEpochs[asset] ?? 0;
    ui.Codec? codec;
    try {
      final ui.Image decoded;
      final packagePath = widget.packageSource?.pathForAsset(asset);
      final Uint8List imageBytes;
      if (packagePath == null) {
        final data = await rootBundle.load(asset);
        imageBytes = Uint8List.fromList(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        );
      } else {
        imageBytes = await File(packagePath).readAsBytes();
      }
      codec = await ui.instantiateImageCodec(imageBytes);
      decoded = await codec.getNextFrame().then((frame) => frame.image);
      if (!mounted || (_imageEpochs[asset] ?? 0) != epoch) {
        decoded.dispose();
        return;
      }
      _images.remove(asset)?.dispose();
      _images[asset] = decoded;
      setState(() {});
    } catch (error) {
      if ((_imageEpochs[asset] ?? 0) == epoch) {
        _failedImages.add(asset);
        if (mounted) widget.onError?.call(error);
      }
    } finally {
      codec?.dispose();
      if ((_imageEpochs[asset] ?? 0) == epoch) {
        _loadingImages.remove(asset);
      }
    }
  }

  Future<void> _loadVideo(PocketVideoOp op) async {
    final resourceKey = _videoResourceKey(op);
    if (_videos.containsKey(op.id) || _failedVideos.contains(resourceKey)) {
      return;
    }
    final loadingAsset = _loadingVideoAssets[op.id];
    if (loadingAsset == op.asset) return;
    if (loadingAsset != null) _invalidateVideoLoad(op.id);
    if (!_loadingVideos.add(op.id)) return;
    _loadingVideoAssets[op.id] = op.asset;
    final epoch = _videoEpochs[op.id] ?? 0;
    VideoPlayerController? video;
    try {
      // video_player renders through Flutter's Texture widget by default; no
      // AndroidView/UiKitView is requested by this POC.
      final packagePath = widget.packageSource?.pathForAsset(op.asset);
      video = packagePath == null
          ? VideoPlayerController.asset(op.asset)
          : VideoPlayerController.file(File(packagePath));
      await video.initialize();
      await video.setLooping(true);
      await video.setVolume(0);
      if (!mounted || (_videoEpochs[op.id] ?? 0) != epoch) {
        await video.dispose();
        return;
      }
      _videos[op.id] = video;
      _videoAssets[op.id] = op.asset;
      _videoDesiredPlayback.putIfAbsent(op.id, () => op.autoplay);
      await _applyVideoPlayback(
        op.id,
        video,
        visible: _videoVisibility[op.id] ?? false,
      );
      if (!mounted || (_videoEpochs[op.id] ?? 0) != epoch) {
        if (identical(_videos[op.id], video)) {
          _videos.remove(op.id);
          _videoAssets.remove(op.id);
          await video.dispose();
        }
        return;
      }
      setState(() {});
    } catch (error) {
      await video?.dispose();
      if ((_videoEpochs[op.id] ?? 0) == epoch) {
        _failedVideos.add(resourceKey);
        if (mounted) widget.onError?.call(error);
      }
    } finally {
      if ((_videoEpochs[op.id] ?? 0) == epoch) {
        _loadingVideos.remove(op.id);
        _loadingVideoAssets.remove(op.id);
      }
    }
  }

  String _videoResourceKey(PocketVideoOp op) => '${op.id}\u0000${op.asset}';

  Future<void> _applyVideoPlayback(
    String id,
    VideoPlayerController video, {
    required bool visible,
  }) async {
    final desired = _videoDesiredPlayback[id];
    if (desired == null || !video.value.isInitialized) return;
    try {
      if (!_effectiveActive || !visible) {
        if (video.value.isPlaying) await video.pause();
      } else if (desired) {
        if (!video.value.isPlaying) await video.play();
      } else {
        if (video.value.isPlaying) await video.pause();
      }
      // Visibility can change while the platform play/pause Future is in
      // flight. Re-check after the await so a late play completion cannot
      // leave a hidden texture running.
      if (!_effectiveActive && video.value.isPlaying) await video.pause();
    } catch (error) {
      if (mounted) widget.onError?.call(error);
    }
  }

  double? _finiteTextInputNumber(Object? value) {
    if (value is! num || !value.isFinite) return null;
    return value.toDouble();
  }

  Rect? _textInputRectFromRaw(Object? rawRect) {
    final rect = rawRect is Map ? Map<String, dynamic>.from(rawRect) : null;
    if (rect == null) return null;
    final x = _finiteTextInputNumber(rect['x']);
    final y = _finiteTextInputNumber(rect['y']);
    final width = _finiteTextInputNumber(rect['width'] ?? rect['w']);
    final height = _finiteTextInputNumber(rect['height'] ?? rect['h']);
    if (x == null ||
        y == null ||
        width == null ||
        height == null ||
        width <= 0 ||
        height <= 0) {
      return null;
    }
    return Rect.fromLTWH(x, y, width, height);
  }

  Rect? _textInputRectFromParams(Map<String, dynamic> params) {
    final parsed = _textInputRectFromRaw(params['rect']);
    if (parsed != null) return parsed;
    return _textInputRectFromRaw(<String, dynamic>{
      'x': params['x'],
      'y': params['y'],
      'width': params['width'] ?? params['w'],
      'height': params['height'] ?? params['h'],
    });
  }

  /// Returns the portion of the native editor that is actually visible to
  /// hit testing. The TextField is clipped by [_textInputClipRect] in the
  /// widget tree, so pointer routing must use the same effective geometry;
  /// otherwise an invisible part of a scrolled editor can swallow a guest
  /// button or navigation tap underneath it.
  Rect? _effectiveTextInputRect() {
    final rect = _textInputRect;
    if (rect == null) {
      return null;
    }
    final clipRect = _textInputClipRect;
    final visible = clipRect == null ? rect : rect.intersect(clipRect);
    if (visible.width <= 0 || visible.height <= 0) {
      return null;
    }
    return visible;
  }

  Rect? _textInputClipRectFromParams(Map<String, dynamic> params) {
    return _textInputRectFromRaw(params['clip']);
  }

  Color _textInputColor(Object? value, Color fallback) {
    if (value is num && value.isFinite) {
      return Color(value.toInt() & 0xffffffff);
    }
    if (value is String) {
      var hex = value.trim();
      if (hex.startsWith('#')) hex = hex.substring(1);
      final parsed = int.tryParse(hex, radix: 16);
      if (parsed != null) {
        if (hex.length <= 6) return Color(0xff000000 | parsed);
        if (hex.length == 8) return Color(parsed);
      }
    }
    return fallback;
  }

  double _textInputDimension(
    Object? value,
    double fallback, {
    double minimum = 0,
    double maximum = 256,
  }) {
    if (value is! num || !value.isFinite) return fallback;
    return value.toDouble().clamp(minimum, maximum);
  }

  // PocketJS's native text slots use ceil(fontSize * 1.2) as their default
  // line box (see sdk/native/src/lib.rs:font_slot_line_height).  TextField's
  // Material 3 default inherits bodyLarge.height instead; leaving `height`
  // unset therefore makes a 14px input line 21px tall and moves its glyph
  // three pixels above the JS text op inside the fixed 33px shell. Keep the
  // platform editor's line box on the same protocol value as the guest.
  double _textInputLineHeight() {
    final fontSize = _textInputFontSize;
    if (!fontSize.isFinite || fontSize <= 0) return 1.2;
    return (fontSize * 1.2).ceilToDouble() / fontSize;
  }

  FontWeight _resolveTextInputFontWeight(Object? value, FontWeight fallback) {
    if (value is num && value.isFinite) {
      final index = (value.toInt() / 100).round() - 1;
      if (index >= 0 && index < FontWeight.values.length) {
        return FontWeight.values[index];
      }
    }
    if (value is String) {
      return switch (value.trim().toLowerCase()) {
        'thin' => FontWeight.w100,
        'extralight' || 'ultralight' => FontWeight.w200,
        'light' => FontWeight.w300,
        'medium' => FontWeight.w500,
        'semibold' || 'demibold' => FontWeight.w600,
        'bold' => FontWeight.w700,
        'extrabold' || 'ultrabold' => FontWeight.w800,
        'black' || 'heavy' => FontWeight.w900,
        'normal' || 'regular' => FontWeight.normal,
        _ => fallback,
      };
    }
    return fallback;
  }

  bool _updateTextInputAppearance(Map<String, dynamic> params) {
    var changed = false;
    if (params.containsKey('placeholder') || params.containsKey('hintText')) {
      final value = params['placeholder'] ?? params['hintText'];
      final next = value == null ? null : '$value';
      if (next != _textInputHintText) {
        _textInputHintText = next;
        changed = true;
      }
    }
    if (params.containsKey('textColor')) {
      final next = _textInputColor(params['textColor'], _textInputTextColor);
      if (next != _textInputTextColor) {
        _textInputTextColor = next;
        changed = true;
      }
    }
    if (params.containsKey('placeholderColor') ||
        params.containsKey('hintColor')) {
      final next = _textInputColor(
        params['placeholderColor'] ?? params['hintColor'],
        _textInputHintColor,
      );
      if (next != _textInputHintColor) {
        _textInputHintColor = next;
        changed = true;
      }
    }
    if (params.containsKey('fillColor')) {
      final next = _textInputColor(params['fillColor'], _textInputFillColor);
      if (next != _textInputFillColor) {
        _textInputFillColor = next;
        changed = true;
      }
    }
    if (params.containsKey('borderColor')) {
      final next = _textInputColor(
        params['borderColor'],
        _textInputBorderColor,
      );
      if (next != _textInputBorderColor) {
        _textInputBorderColor = next;
        changed = true;
      }
    }
    if (params.containsKey('focusedBorderColor')) {
      final next = _textInputColor(
        params['focusedBorderColor'],
        _textInputFocusedBorderColor,
      );
      if (next != _textInputFocusedBorderColor) {
        _textInputFocusedBorderColor = next;
        changed = true;
      }
    }
    if (params.containsKey('borderRadius') || params.containsKey('radius')) {
      final next = _textInputDimension(
        params['borderRadius'] ?? params['radius'],
        _textInputBorderRadius,
        maximum: 128,
      );
      if (next != _textInputBorderRadius) {
        _textInputBorderRadius = next;
        changed = true;
      }
    }
    if (params.containsKey('fontSize')) {
      final next = _textInputDimension(
        params['fontSize'],
        _textInputFontSize,
        minimum: 1,
        maximum: 128,
      );
      if (next != _textInputFontSize) {
        _textInputFontSize = next;
        changed = true;
      }
    }
    if (params.containsKey('fontWeight')) {
      final next = _resolveTextInputFontWeight(
        params['fontWeight'],
        _textInputFontWeight,
      );
      if (next != _textInputFontWeight) {
        _textInputFontWeight = next;
        changed = true;
      }
    }
    if (params.containsKey('paddingHorizontal') ||
        params.containsKey('paddingX')) {
      final next = _textInputDimension(
        params['paddingHorizontal'] ?? params['paddingX'],
        _textInputPaddingHorizontal,
        maximum: 128,
      );
      if (next != _textInputPaddingHorizontal) {
        _textInputPaddingHorizontal = next;
        changed = true;
      }
    }
    if (params.containsKey('paddingVertical') ||
        params.containsKey('paddingY')) {
      final next = _textInputDimension(
        params['paddingVertical'] ?? params['paddingY'],
        _textInputPaddingVertical,
        maximum: 128,
      );
      if (next != _textInputPaddingVertical) {
        _textInputPaddingVertical = next;
        changed = true;
      }
    }
    return changed;
  }

  TextInputType _textInputKeyboardTypeFromParams(
    Map<String, dynamic> params, {
    TextInputType fallback = TextInputType.text,
  }) {
    final raw = params['keyboardType'] ?? params['inputType'];
    if (raw == null) return fallback;
    final type = '$raw'.trim().toLowerCase().replaceAll('-', '');
    return switch (type) {
      'multiline' || 'textarea' => TextInputType.multiline,
      'number' || 'numeric' => TextInputType.number,
      'decimal' => const TextInputType.numberWithOptions(decimal: true),
      'signed' => const TextInputType.numberWithOptions(signed: true),
      'phone' || 'tel' => TextInputType.phone,
      'datetime' || 'date' || 'time' => TextInputType.datetime,
      'email' || 'emailaddress' => TextInputType.emailAddress,
      'url' || 'uri' => TextInputType.url,
      'password' || 'visiblepassword' => TextInputType.visiblePassword,
      'name' || 'namephone' => TextInputType.name,
      _ => fallback,
    };
  }

  TextInputAction _textInputActionFromParams(
    Map<String, dynamic> params, {
    TextInputAction fallback = TextInputAction.done,
  }) {
    final raw = params['action'] ?? params['textInputAction'];
    if (raw == null) return fallback;
    final action = '$raw'.trim().toLowerCase().replaceAll('-', '');
    return switch (action) {
      'none' => TextInputAction.none,
      'unspecified' || 'default' => TextInputAction.unspecified,
      'done' || 'submit' => TextInputAction.done,
      'go' => TextInputAction.go,
      'search' => TextInputAction.search,
      'send' => TextInputAction.send,
      'next' => TextInputAction.next,
      'previous' || 'prev' => TextInputAction.previous,
      'continue' || 'continueaction' => TextInputAction.continueAction,
      'join' => TextInputAction.join,
      'route' => TextInputAction.route,
      'emergencycall' => TextInputAction.emergencyCall,
      'newline' || 'return' => TextInputAction.newline,
      _ => fallback,
    };
  }

  int? _textInputLineCount(
    Map<String, dynamic> params, {
    required bool max,
    int? fallback,
  }) {
    final value = params[max ? 'maxLines' : 'minLines'];
    if (value == null) return fallback;
    if (value is! num || !value.isFinite || value < 1) return fallback;
    return value.toInt();
  }

  String _textInputActionName(TextInputAction action) {
    return switch (action) {
      TextInputAction.none => 'none',
      TextInputAction.unspecified => 'unspecified',
      TextInputAction.done => 'done',
      TextInputAction.go => 'go',
      TextInputAction.search => 'search',
      TextInputAction.send => 'send',
      TextInputAction.next => 'next',
      TextInputAction.previous => 'previous',
      TextInputAction.continueAction => 'continue',
      TextInputAction.join => 'join',
      TextInputAction.route => 'route',
      TextInputAction.emergencyCall => 'emergencyCall',
      TextInputAction.newline => 'newline',
    };
  }

  void _syncTextController(
    TextEditingController controller,
    _PocketTextInputState state,
  ) {
    if (!state.hasExplicitTextOrSelection) {
      return;
    }
    final nextValue = state.value;
    if (controller.value == nextValue) return;
    _applyingTextInputValue = true;
    try {
      controller.value = nextValue;
    } finally {
      _applyingTextInputValue = false;
    }
  }

  String? _textInputEventId(Map<String, dynamic> params) {
    final rawId = params['id'];
    if (rawId == null) return null;
    final id = '$rawId';
    return id.isEmpty ? null : id;
  }

  String? _textInputEditingSessionFromParams(Map<String, dynamic> params) {
    final rawSession = params['editingSession'];
    if (rawSession == null) return null;
    final session = '$rawSession';
    return session.isEmpty ? null : session;
  }

  int? _textInputRevisionFromParams(
    Map<String, dynamic> params, {
    String key = 'revision',
  }) {
    final rawRevision = params[key];
    if (rawRevision is! num || !rawRevision.isFinite) return null;
    return rawRevision.toInt().clamp(0, 0x7fffffff);
  }

  int? _textInputJsRevisionFromParams(Map<String, dynamic> params) {
    return _textInputRevisionFromParams(params, key: 'jsRevision');
  }

  bool _textInputHasValueFields(Map<String, dynamic> params) {
    return params.containsKey('text') ||
        params.containsKey('selectionBase') ||
        params.containsKey('selectionExtent') ||
        params.containsKey('composingBase') ||
        params.containsKey('composingExtent');
  }

  Map<String, dynamic> _textInputNativePayload(Map<String, dynamic> payload) {
    final next = Map<String, dynamic>.from(payload)
      ..['revision'] = _textInputRevision
      ..['jsRevision'] = _textInputJsRevision
      ..['source'] = 'native';
    final session = _textInputEditingSession;
    if (session != null) next['editingSession'] = session;
    return next;
  }

  bool _isCurrentTextInput(Map<String, dynamic> params) {
    final currentId = _textInputId;
    final eventId = _textInputEventId(params);
    if (currentId == null || eventId == null || eventId != currentId) {
      return false;
    }
    final currentSession = _textInputEditingSession;
    // Once a guest supplies an editing epoch, a late event from a previous
    // overlay with the same id must not touch the active Flutter controller.
    // Legacy guests that never supplied a token remain compatible.
    return currentSession == null ||
        _textInputEditingSessionFromParams(params) == currentSession;
  }

  void _sendTextInputDismiss(String id, String reason) {
    _controller.send(
      method: 'textInput.dismiss',
      params: _textInputNativePayload(<String, dynamic>{
        'id': id,
        'reason': reason,
      }),
    );
  }

  void _dismissTextInput({required String reason, bool rebuild = true}) {
    final id = _textInputId;
    if (id == null) return;
    _sendTextInputDismiss(id, reason);
    _closeTextInput(id: id, rebuild: rebuild);
  }

  void _onTextInputFocusChanged() {
    if (_suppressTextInputFocusEvents ||
        _textInputFocusNode?.hasFocus != false) {
      return;
    }
    final id = _textInputId;
    final focusNode = _textInputFocusNode;
    if (id == null || focusNode == null) return;
    if (identical(_scheduledTextInputBlurNode, focusNode)) return;
    _scheduledTextInputBlurNode = focusNode;
    // FocusManager notifies listeners while iterating its focus set. Dispose
    // the controller/node after that notification completes; synchronous
    // disposal mutates the listener set and triggers Flutter assertions.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (identical(_scheduledTextInputBlurNode, focusNode)) {
        _scheduledTextInputBlurNode = null;
      }
      if (!mounted ||
          _textInputId != id ||
          !identical(_textInputFocusNode, focusNode) ||
          focusNode.hasFocus) {
        return;
      }
      _dismissTextInput(reason: 'blur');
    });
  }

  void _openTextInput(Map<String, dynamic> params) {
    _wakeTicker();
    final id = _textInputEventId(params);
    final rect = _textInputRectFromParams(params);
    if (id == null || rect == null) return;

    final incomingSession = _textInputEditingSessionFromParams(params);
    if (_textInputId == id &&
        _textInputEditingSession != null &&
        incomingSession != _textInputEditingSession) {
      // A delayed open from an earlier guest generation is indistinguishable
      // by id alone. Ignore it until the active session has been closed.
      return;
    }

    if (_textInputId != null) {
      _dismissTextInput(reason: 'replaced', rebuild: false);
    }
    final inputState = _PocketTextInputState.fromJson(
      params,
      fallback: const TextEditingValue(),
      isOpen: true,
    );
    final controller = TextEditingController.fromValue(inputState.value);
    final focusNode = FocusNode(debugLabel: 'PocketJS textInput $id');
    controller.addListener(_onTextInputChanged);
    focusNode.addListener(_onTextInputFocusChanged);
    _textInputId = id;
    _textInputEditingSession = incomingSession;
    _textInputRevision =
        _textInputRevisionFromParams(params) ??
        _textInputRevisionFromParams(params, key: 'observedRevision') ??
        0;
    _textInputJsRevision = _textInputJsRevisionFromParams(params) ?? 0;
    _textInputRect = rect;
    _textInputClipRect = _textInputClipRectFromParams(params);
    _textInputController = controller;
    _textInputFocusNode = focusNode;
    _updateTextInputAppearance(params);
    _textInputKeyboardType = _textInputKeyboardTypeFromParams(params);
    _textInputAction = _textInputActionFromParams(params);
    _textInputObscure =
        params['obscureText'] == true || params['obscure'] == true;
    _textInputAutocorrect = params['autocorrect'] != false;
    _textInputMaxLines = _textInputLineCount(
      params,
      max: true,
      fallback: _textInputKeyboardType == TextInputType.multiline ? null : 1,
    );
    _textInputMinLines = _textInputLineCount(params, max: false);
    if (_textInputObscure) {
      _textInputMaxLines = 1;
      _textInputMinLines = null;
    }
    if (mounted) setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          _textInputId != id ||
          !identical(_textInputFocusNode, focusNode)) {
        return;
      }
      focusNode.requestFocus();
    });
  }

  void _updateTextInput(Map<String, dynamic> params) {
    if (!_isCurrentTextInput(params)) return;
    final controller = _textInputController;
    if (controller == null) return;
    final incomingRevision = _textInputRevisionFromParams(params);
    final incomingJsRevision = _textInputJsRevisionFromParams(params);
    final source = params['source'];
    // `programmatic` is the legacy explicit override. The JS component now
    // uses `source: 'js', force: true` for the same operation so a delayed
    // native IME echo cannot overwrite a newer JS-controlled value.
    final isJsCommand =
        source == 'programmatic' || (source == 'js' && params['force'] == true);
    final hasValueFields = _textInputHasValueFields(params);
    final staleNativeValue =
        incomingRevision != null &&
        incomingRevision < _textInputRevision &&
        !isJsCommand;
    // Rect-only updates deliberately remain applicable even when they arrive
    // out of order. Only a stale command carrying text/selection/composing
    // data is stripped; its geometry and visual metadata still flow through.
    final staleJsValue =
        hasValueFields &&
        incomingJsRevision != null &&
        incomingJsRevision < _textInputJsRevision;
    final staleValue = staleNativeValue || staleJsValue;
    final valueParams = staleValue
        ? (Map<String, dynamic>.from(params)
            ..remove('text')
            ..remove('selectionBase')
            ..remove('selectionExtent')
            ..remove('composingBase')
            ..remove('composingExtent'))
        : params;
    final state = _PocketTextInputState.fromJson(
      valueParams,
      fallback: controller.value,
      isOpen: false,
    );
    _syncTextController(controller, state);
    if (incomingRevision != null &&
        (isJsCommand || incomingRevision >= _textInputRevision)) {
      _textInputRevision = math.max(_textInputRevision, incomingRevision);
    }
    if (incomingJsRevision != null &&
        (!staleJsValue || incomingJsRevision >= _textInputJsRevision)) {
      _textInputJsRevision = math.max(_textInputJsRevision, incomingJsRevision);
    }
    final observedRevision = _textInputRevisionFromParams(
      params,
      key: 'observedRevision',
    );
    if (observedRevision != null) {
      _textInputRevision = math.max(_textInputRevision, observedRevision);
    }
    var metadataChanged = _updateTextInputAppearance(params);
    if (params.containsKey('keyboardType') || params.containsKey('inputType')) {
      _textInputKeyboardType = _textInputKeyboardTypeFromParams(
        params,
        fallback: _textInputKeyboardType,
      );
      metadataChanged = true;
    }
    if (params.containsKey('action') || params.containsKey('textInputAction')) {
      _textInputAction = _textInputActionFromParams(
        params,
        fallback: _textInputAction,
      );
      metadataChanged = true;
    }
    if (params.containsKey('obscureText') || params.containsKey('obscure')) {
      _textInputObscure =
          params['obscureText'] == true || params['obscure'] == true;
      metadataChanged = true;
    }
    if (params.containsKey('autocorrect')) {
      _textInputAutocorrect = params['autocorrect'] != false;
      metadataChanged = true;
    }
    if (params.containsKey('maxLines')) {
      _textInputMaxLines = _textInputLineCount(
        params,
        max: true,
        fallback: _textInputMaxLines,
      );
      metadataChanged = true;
    }
    if (params.containsKey('minLines')) {
      _textInputMinLines = _textInputLineCount(
        params,
        max: false,
        fallback: _textInputMinLines,
      );
      metadataChanged = true;
    }
    if (_textInputObscure) {
      _textInputMaxLines = 1;
      _textInputMinLines = null;
    }
    final rect = _textInputRectFromParams(params);
    if (rect != null) {
      _textInputRect = rect;
      metadataChanged = true;
    }
    if (params.containsKey('clip')) {
      _textInputClipRect = _textInputClipRectFromParams(params);
      metadataChanged = true;
    }
    if (metadataChanged && mounted) setState(() {});
  }

  void _onTextInputChanged() {
    if (_applyingTextInputValue || !mounted) return;
    final id = _textInputId;
    final controller = _textInputController;
    if (id == null || controller == null) return;
    final value = controller.value;
    _textInputRevision++;
    _controller.send(
      method: 'textInput.edit',
      params: _textInputNativePayload(<String, dynamic>{
        'id': id,
        'text': value.text,
        'selectionBase': value.selection.baseOffset,
        'selectionExtent': value.selection.extentOffset,
        'composingBase': value.composing.start,
        'composingExtent': value.composing.end,
      }),
    );
  }

  void _submitTextInput() {
    final id = _textInputId;
    final controller = _textInputController;
    if (id == null || controller == null) return;
    final value = controller.value;
    _controller.send(
      method: 'textInput.submit',
      params: _textInputNativePayload(<String, dynamic>{
        'id': id,
        'text': value.text,
        'selectionBase': value.selection.baseOffset,
        'selectionExtent': value.selection.extentOffset,
        'composingBase': value.composing.start,
        'composingExtent': value.composing.end,
        'action': _textInputActionName(_textInputAction),
      }),
    );
    final focusNode = _textInputFocusNode;
    // EditableText is still servicing TextInputClient.performAction when
    // onSubmitted runs. Defer disposal until the frame callback so the
    // controller/focus node cannot be disposed during that platform callback.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          _textInputId != id ||
          !identical(_textInputFocusNode, focusNode)) {
        return;
      }
      _closeTextInput(id: id);
    });
  }

  void _scheduleOutsideTextInputDismiss() {
    final id = _textInputId;
    if (id == null || _scheduledOutsideTextInputId == id) return;
    _scheduledOutsideTextInputId = id;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scheduledOutsideTextInputId == id) {
        _scheduledOutsideTextInputId = null;
      }
      if (!mounted || _textInputId != id) return;
      _dismissTextInput(reason: 'outside');
    });
    // Pointer-up normally schedules a frame, but explicitly request one so a
    // post-frame close is not stranded when the host is otherwise idle.
    WidgetsBinding.instance.scheduleFrame();
  }

  void _onTextInputTapOutside(PointerDownEvent event) {
    if (_textInputId == null) return;
    _textInputTapRegionDowns[event.pointer] = event.position;
  }

  void _onTextInputTapUpOutside(PointerUpEvent event) {
    final origin = _textInputTapRegionDowns.remove(event.pointer);
    if (origin == null || (event.position - origin).distance > kTouchSlop) {
      return;
    }
    _scheduleOutsideTextInputDismiss();
  }

  void _closeTextInput({String? id, bool rebuild = true}) {
    if (_textInputId == null || (id != null && id != _textInputId)) return;
    _wakeTicker();
    final controller = _textInputController;
    final focusNode = _textInputFocusNode;
    controller?.removeListener(_onTextInputChanged);
    focusNode?.removeListener(_onTextInputFocusChanged);
    if (identical(_scheduledTextInputBlurNode, focusNode)) {
      _scheduledTextInputBlurNode = null;
    }
    _suppressTextInputFocusEvents = true;
    focusNode?.unfocus();
    _suppressTextInputFocusEvents = false;
    controller?.dispose();
    focusNode?.dispose();
    _outsideTextInputPointerOrigins.clear();
    _textInputTapRegionDowns.clear();
    _scheduledOutsideTextInputId = null;
    _textInputId = null;
    _textInputEditingSession = null;
    _textInputRevision = 0;
    _textInputJsRevision = 0;
    _textInputRect = null;
    _textInputClipRect = null;
    _textInputController = null;
    _textInputFocusNode = null;
    _textInputKeyboardType = TextInputType.text;
    _textInputAction = TextInputAction.done;
    _textInputObscure = false;
    _textInputAutocorrect = true;
    _textInputMaxLines = 1;
    _textInputMinLines = null;
    _textInputHintText = null;
    _textInputTextColor = const Color(0xff283444);
    _textInputHintColor = const Color(0xff667485);
    _textInputFillColor = Colors.white;
    _textInputBorderColor = const Color(0xff9aa5b2);
    _textInputFocusedBorderColor = const Color(0xff2676cb);
    _textInputBorderRadius = 8;
    _textInputFontSize = 14;
    _textInputFontWeight = FontWeight.normal;
    _textInputPaddingHorizontal = 12;
    _textInputPaddingVertical = 8;
    if (rebuild && mounted) setState(() {});
  }

  void _handleGestureRegions(PocketEvent event) {
    if (event.method != 'input.gesture.regions') return;
    final rawRegions = event.params['regions'];
    if (rawRegions is! List) return;
    final next = <_PocketGestureRegion>[];
    for (final raw in rawRegions) {
      if (raw is! Map) continue;
      final region = _PocketGestureRegion.fromJson(
        Map<String, dynamic>.from(raw),
      );
      if (region != null) next.add(region);
    }
    _guestGestureRegions
      ..clear()
      ..addAll(next);
  }

  void _handleTextInputEvent(PocketEvent event) {
    switch (event.method) {
      case 'textInput.open':
        _openTextInput(event.params);
      case 'textInput.update':
        _updateTextInput(event.params);
      case 'textInput.close':
        final id = _textInputEventId(event.params);
        if (id != null && _isCurrentTextInput(event.params)) {
          _closeTextInput(id: id);
        }
    }
  }

  void _handleEvents(List<PocketEvent> events) {
    for (final event in events) {
      _handleGestureRegions(event);
      if (event.method == 'input.gesture.regions') continue;
      _handleTextInputEvent(event);
      if (event.method == 'video.play' || event.method == 'video.pause') {
        final id = '${event.params['id'] ?? 'video'}';
        _videoDesiredPlayback[id] = event.method == 'video.play';
        final video = _videos[id];
        if (video != null) {
          unawaited(
            _applyVideoPlayback(
              id,
              video,
              visible: _videoVisibility[id] ?? false,
            ),
          );
        }
      }
      if (event.method == 'app.echo') {
        final result = event.params['message'] ?? event.params;
        _controller.sendRaw(<String, dynamic>{
          'type': 'response',
          'id': event.id,
          'ok': true,
          'result': result,
          'payload': event.params,
        });
      }
      widget.onEvent?.call(event);
    }
  }

  void _flushPendingPointerJson() {
    if (_pendingPointerJson.isEmpty) return;
    final pending = List<Map<String, dynamic>>.of(_pendingPointerJson);
    _pendingPointerJson.clear();
    for (var index = 0; index < pending.length; index++) {
      final params = pending[index];
      try {
        if (_controller._sendEvent(
          method: 'input.pointer',
          params: params,
          wake: false,
        )) {
          continue;
        }
      } catch (_) {
        // Preserve the event below so a transient bridge failure cannot
        // reorder a later pointer edge.
      }
      _pendingPointerJson.addAll(pending.sublist(index));
      break;
    }
  }

  void _cancelPointerSequences() {
    if (_runtime == null || _pointerSlots.isEmpty) return;
    _flushPendingPointerJson();
    for (final entry in _pointerSlots.entries) {
      _controller.send(
        method: 'input.pointer',
        params: <String, dynamic>{
          'phase': 'cancel',
          'id': entry.value,
          'x': 0.0,
          'y': 0.0,
          if ((_pointerSurfaceIds[entry.key] ?? 0) != 0)
            'surface': _pointerSurfaceIds[entry.key],
        },
      );
    }
    _pointerSlots.clear();
    _pointerSurfaceIds.clear();
    _outsideTextInputPointerOrigins.clear();
  }

  bool _sendPointer({
    required int surface,
    required String phase,
    required int id,
    required Offset localPosition,
    required double actualWidth,
    required double actualHeight,
  }) {
    if (!widget.inputEnabled) return false;
    _wakeTicker();
    if (surface != 0 && _auxiliaryFrame == null) return false;
    // PocketFrame and PocketSurfaceFrame intentionally share the same
    // dimensions, but are separate model types. Select the concrete frame
    // before reading its fields so Dart does not widen the conditional to
    // Object.
    final frameWidth = surface == 0 ? _frame.width : _auxiliaryFrame!.width;
    final frameHeight = surface == 0 ? _frame.height : _auxiliaryFrame!.height;
    if (!actualWidth.isFinite ||
        !actualHeight.isFinite ||
        actualWidth <= 0 ||
        actualHeight <= 0 ||
        !frameWidth.isFinite ||
        !frameHeight.isFinite ||
        frameWidth <= 0 ||
        frameHeight <= 0) {
      return false;
    }

    // PointerEvent.localPosition is in the rendered PocketView's coordinates.
    // PocketJS hit testing runs in the frame's logical viewport, so preserve
    // that coordinate space rather than making Dart-side hit-test decisions.
    final rawX = localPosition.dx * frameWidth / actualWidth;
    final rawY = localPosition.dy * frameHeight / actualHeight;
    if (!rawX.isFinite || !rawY.isFinite) return false;

    // A focused nested guest owns its local pointer route. Parent Listener
    // also sees bubbling events, so do not submit the same down to both realms.
    if (phase == 'down' &&
        surface == 0 &&
        _frame.ops.whereType<PocketHostSurfaceOp>().any(
          (op) =>
              op.kind == 'application' &&
              op.focused &&
              Rect.fromLTWH(
                op.x,
                op.y,
                op.width,
                op.height,
              ).contains(Offset(rawX, rawY)) &&
              (op.clip == null ||
                  Rect.fromLTWH(
                    op.clip!.x,
                    op.clip!.y,
                    op.clip!.width,
                    op.clip!.height,
                  ).contains(Offset(rawX, rawY))),
        )) {
      return false;
    }
    final effectiveTextInputRect = surface == 0
        ? _effectiveTextInputRect()
        : null;

    final outsideTextInputDown =
        phase == 'down' &&
        surface == 0 &&
        _textInputId != null &&
        _textInputRect != null &&
        (effectiveTextInputRect == null ||
            !effectiveTextInputRect.contains(Offset(rawX, rawY)));
    final Offset? outsideTextInputOrigin = phase == 'up' || phase == 'cancel'
        ? _outsideTextInputPointerOrigins.remove(id)
        : null;
    final outsideTextInputContact = outsideTextInputOrigin != null;

    // The Flutter IME editor is a child of this Listener, so the Listener also
    // observes its pointer stream. Keep that stream entirely in Flutter: a
    // down in the logical editor rect must not re-hit the guest Focusable and
    // reopen the same text input. Move/up then naturally have no native slot.
    if (phase == 'down' &&
        surface == 0 &&
        _textInputId != null &&
        effectiveTextInputRect != null) {
      if (effectiveTextInputRect.contains(Offset(rawX, rawY))) return false;
      // Do not dismiss on pointer down. The guest needs the complete
      // down/up pair for a button tap (and the viewport can change as the IME
      // starts closing). TextField.onTapUpOutside handles taps outside this
      // surface after the up edge; the guest's own close event remains the
      // authority for interactions inside the surface.
    }

    // Mouse hover and some trackpad streams produce move events without a
    // preceding down. The native input contract only accepts move/up/cancel
    // events for an active contact, so ignore those host-only events while
    // forwarding every event belonging to a real contact. A down allocates a
    // free native slot; the ninth simultaneous contact is ignored until a
    // previous slot is released.
    int? slot = _pointerSlots[id];
    if (phase == 'down') {
      if (slot != null) return false;
      slot = _freePointerSlot();
      if (slot == null) return false;
    } else if (slot == null) {
      return false;
    }

    // A pointer route remains attached to Listener after the contact leaves
    // the render box. Native hit testing must never receive out-of-viewport
    // coordinates: turn the first out-of-bounds move/up into one clamped
    // cancel, then retire the contact so later host events are ignored.
    final leftViewport =
        rawX < 0 || rawX > frameWidth || rawY < 0 || rawY > frameHeight;
    final outgoingPhase = (phase == 'move' || phase == 'up') && leftViewport
        ? 'cancel'
        : phase;
    final x = rawX.clamp(0.0, frameWidth).toDouble();
    final y = rawY.clamp(0.0, frameHeight).toDouble();
    final params = <String, dynamic>{
      'phase': outgoingPhase,
      'id': slot,
      'x': x,
      'y': y,
    };
    if (surface != 0) params['surface'] = surface;
    var sent = false;
    var deferredToJson = false;
    final duplex = _duplexChannel;
    if (widget.enableDuplexPointerInput && _pendingPointerJson.isNotEmpty) {
      deferredToJson = true;
    }
    if (widget.enableDuplexPointerInput &&
        duplex != null &&
        !duplex.isClosed &&
        // Once one edge falls back because the ring is full, keep the rest of
        // that contact in the same FIFO until the next frame flushes it. A
        // later edge must never overtake the deferred predecessor.
        _pendingPointerJson.isEmpty) {
      final flags = switch (outgoingPhase) {
        'down' => _duplexPointerDown,
        'move' => _duplexPointerMove,
        'up' => _duplexPointerUp,
        'cancel' => _duplexPointerCancel,
        _ => 0,
      };
      if (flags != 0) {
        // targetId carries the native pointer slot. The surface is encoded in
        // the high bit of flags so primary/auxiliary contacts retain one
        // canonical slot namespace without allocating a JSON envelope.
        final transportFlags = surface == 0 ? flags : flags | 0x0100;
        try {
          sent = duplex.pushToPocketJs(
            msgType: _duplexPointerMessageType,
            flags: transportFlags,
            targetId: slot,
            arg0: x,
            arg1: y,
          );
        } catch (_) {
          // A closed endpoint falls back immediately. A live endpoint only
          // returns false when full, which is deferred until after the next
          // frame drains ingress so JSON cannot overtake an older duplex edge.
          if (!duplex.isClosed) deferredToJson = true;
          if (duplex.isClosed) {
            _duplexChannel = null;
            _controller._clearDuplexChannel(duplex);
          }
          sent = false;
        }
        if (!sent && !duplex.isClosed) deferredToJson = true;
      }
    }
    if (!sent) {
      if (deferredToJson) {
        _pendingPointerJson.add(params);
        sent = true;
      } else {
        sent = _controller.send(
          // Native owns one pointer queue for all surfaces. The surface
          // selector stays in the canonical pointer payload so down/up edges
          // share the same slot and hit-test path on primary and auxiliary
          // outputs.
          method: 'input.pointer',
          params: params,
        );
      }
    }
    if (outgoingPhase == 'down') {
      if (sent) {
        _pointerSlots[id] = slot;
        _pointerSurfaceIds[id] = surface;
        if (outsideTextInputDown) {
          _outsideTextInputPointerOrigins[id] = localPosition;
        }
      }
    } else if (outgoingPhase == 'up' || outgoingPhase == 'cancel') {
      _pointerSlots.remove(id);
      _pointerSurfaceIds.remove(id);
    }
    if (sent &&
        outsideTextInputContact &&
        outgoingPhase == 'up' &&
        (localPosition - outsideTextInputOrigin).distance <= kTouchSlop) {
      final rect = _effectiveTextInputRect();
      if (_textInputId != null &&
          (rect == null || !rect.contains(Offset(rawX, rawY)))) {
        // Deliver the guest up edge before changing the overlay/focus tree so
        // a button tap cannot lose its action when the IME starts dismissing.
        _scheduleOutsideTextInputDismiss();
      }
    }
    return sent;
  }

  bool _dispatchSurfacePointer({
    required int surface,
    required Size size,
    required String phase,
    required PointerEvent event,
  }) {
    return _sendPointer(
      surface: surface,
      phase: phase,
      id: event.pointer,
      localPosition: event.localPosition,
      actualWidth: size.width,
      actualHeight: size.height,
    );
  }

  bool _guestGestureForPointer({
    required int surface,
    required Offset localPosition,
    required Offset travel,
    required Size size,
  }) {
    final frameWidth = surface == 0 ? _frame.width : _auxiliaryFrame?.width;
    final frameHeight = surface == 0 ? _frame.height : _auxiliaryFrame?.height;
    if (frameWidth == null ||
        frameHeight == null ||
        !frameWidth.isFinite ||
        !frameHeight.isFinite ||
        frameWidth <= 0 ||
        frameHeight <= 0 ||
        size.width <= 0 ||
        size.height <= 0) {
      return false;
    }
    final point = Offset(
      localPosition.dx * frameWidth / size.width,
      localPosition.dy * frameHeight / size.height,
    );
    return _guestGestureRegions.any(
      (region) => region.surface == surface && region.accepts(point, travel),
    );
  }

  int? _freePointerSlot() {
    for (var slot = 0; slot < _maxPointerSlots; slot++) {
      if (!_pointerSlots.values.contains(slot)) return slot;
    }
    return null;
  }

  @override
  void dispose() {
    _isDisposed = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_stopDisplayGeometry());
    _cancelScheduledWake();
    _idleStartedAt = null;
    _resumedFromIdle = false;
    _ticker?.dispose();
    _ticker = null;
    _pointerSlots.clear();
    _pendingPointerJson.clear();
    _outsideTextInputPointerOrigins.clear();
    _textInputTapRegionDowns.clear();
    _guestGestureRegions.clear();
    _dismissTextInput(reason: 'runtime.dispose', rebuild: false);
    _closeTextInput(rebuild: false);
    _detachRuntime(fallback: widget.runtime);
    for (final image in _images.values) {
      image.dispose();
    }
    _textLayoutCache.dispose();
    for (final id in _loadingVideos) {
      _videoEpochs[id] = (_videoEpochs[id] ?? 0) + 1;
    }
    _loadingVideos.clear();
    _loadingVideoAssets.clear();
    _videoVisibility.clear();
    _videoAssets.clear();
    final videos = _videos.values.toList(growable: false);
    _videos.clear();
    for (final video in videos) {
      unawaited(video.dispose());
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        _pauseForLifecycle();
      case AppLifecycleState.resumed:
        _resumeFromLifecycle();
    }
  }

  void _pauseForLifecycle() {
    if (_lifecyclePaused) return;
    _lifecyclePaused = true;
    _pauseGuestForActivity();
  }

  void _resumeFromLifecycle() {
    if (!_lifecyclePaused) return;
    _lifecyclePaused = false;
    _resumeGuestForActivity();
  }

  void _failRuntime(Object error) {
    _cancelScheduledWake();
    _ticker?.stop();
    _pointerSlots.clear();
    _pendingPointerJson.clear();
    _dismissTextInput(reason: 'runtime.dispose', rebuild: false);
    _detachRuntime();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _error = error;
    });
    widget.onError?.call(error);
  }

  void _detachRuntime({PocketRuntime? fallback}) {
    _cancelScheduledWake();
    final runtime = _runtime ?? fallback;
    final shouldDispose = _runtime != null
        ? _ownsRuntime
        : fallback != null && widget.runtime == null;
    _runtime = null;
    _ownsRuntime = false;
    _pendingPointerJson.clear();
    final duplex = _duplexChannel;
    _duplexChannel = null;
    duplex?.close();
    if (runtime == null) return;
    _controller._detach(runtime);
    if (shouldDispose) runtime.dispose();
  }

  Color _fpsLabelColor() {
    final fps = _fps;
    if (fps == null) return Colors.white;
    if (fps < 45) return Colors.redAccent;
    // Compare the measured cadence with the actual display refresh rate; a
    // 120/144-Hz surface is warned below its own budget while sub-45 FPS stays
    // red on all panels.
    if (fps < _refreshHz) return Colors.amberAccent;
    return Colors.greenAccent;
  }

  /// Returns the inset for diagnostics in this PocketView's local host
  /// coordinates. Safe-area values are reported in guest logical pixels, so
  /// map them through the same canvas geometry used by pointer/IME mapping;
  /// never read whole-window padding directly for a nested or fixed preview.
  EdgeInsets _diagnosticOverlayInsets(BuildContext context) {
    final hostContext = _hostKey.currentContext;
    final object = hostContext?.findRenderObject();
    if (hostContext == null || object is! RenderBox || !object.hasSize) {
      return EdgeInsets.zero;
    }
    if (!_displayGeometryMatchesView(hostContext, object)) {
      // A live resize is between Flutter layout and the first matching native
      // frame. Keep diagnostics at their conservative host edge for one
      // frame instead of using stale frame coordinates.
      return EdgeInsets.zero;
    }
    final frame = Size(_frame.width, _frame.height);
    if (!frame.width.isFinite ||
        !frame.height.isFinite ||
        frame.width <= 0 ||
        frame.height <= 0) {
      return EdgeInsets.zero;
    }
    final geometry = _canvasGeometryForHost(object);
    if (geometry.size.width <= 0 || geometry.size.height <= 0) {
      return EdgeInsets.zero;
    }
    final scaleX = geometry.size.width / frame.width;
    final scaleY = geometry.size.height / frame.height;
    if (!scaleX.isFinite || !scaleY.isFinite || scaleX <= 0 || scaleY <= 0) {
      return EdgeInsets.zero;
    }
    final safe = _safeAreaForHost(object, hostContext, geometry: geometry);
    final right =
        object.size.width -
        (geometry.origin.dx + geometry.size.width - safe.right * scaleX);
    final bottom =
        object.size.height -
        (geometry.origin.dy + geometry.size.height - safe.bottom * scaleY);
    return EdgeInsets.only(
      left: math.max(0, geometry.origin.dx + safe.left * scaleX),
      top: math.max(0, geometry.origin.dy + safe.top * scaleY),
      right: math.max(0, right),
      bottom: math.max(0, bottom),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      key: _hostKey,
      builder: (context, constraints) {
        _observeConstraints(constraints);
        return _buildContent(context);
      },
    );
  }

  Widget _buildContent(BuildContext context) {
    if (_loading) {
      return const ColoredBox(
        color: Color(0xff101827),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_error != null) {
      return ColoredBox(
        color: const Color(0xff101827),
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Text(
              'PocketJS runtime unavailable\n$_error',
              style: const TextStyle(color: Colors.white),
            ),
          ),
        ),
      );
    }
    final content = LayoutBuilder(
      builder: (context, constraints) {
        // A null viewport is the live host-viewport mode. During a keyboard
        // resize Flutter rebuilds this widget before the post-frame native
        // resize has returned the new PocketFrame. Fitting the old frame into
        // the new, shorter constraints here applies a temporary contain scale
        // (and Center adds a horizontal offset), which makes the whole page
        // wobble while the IME animates. Keep the old logical frame at 1:1 and
        // clip it from the top-left until the resize frame arrives. A supplied
        // viewport remains the fixed preview mode and keeps its contain fit.
        // Injected runtimes retain their established fixed-frame preview
        // semantics. Only a self-owned runtime with no explicit viewport can
        // follow changing host constraints.
        final automaticViewport =
            widget.runtime == null &&
            widget.viewport == null &&
            !_resizeUnavailable;
        final primarySize = automaticViewport
            ? Size(_frame.width, _frame.height)
            : _fitSurfaceSize(_frame.width, _frame.height, constraints);
        Widget placeSurface(Widget surface, Size surfaceSize) {
          if (!automaticViewport) return Center(child: surface);
          return ClipRect(
            child: OverflowBox(
              alignment: Alignment.topLeft,
              // Null OverflowBox bounds inherit the keyboard-shortened
              // parent constraints and would compress the old frame again.
              // Keep the logical surface at its exact frame size; ClipRect
              // supplies the temporary viewport until native returns resize.
              minWidth: surfaceSize.width,
              maxWidth: surfaceSize.width,
              minHeight: surfaceSize.height,
              maxHeight: surfaceSize.height,
              child: surface,
            ),
          );
        }

        final auxiliary = _auxiliaryFrame;
        if (auxiliary == null || auxiliary.ops.isEmpty) {
          return Builder(
            builder: (surfaceContext) => placeSurface(
              _buildSurface(
                width: _frame.width,
                height: _frame.height,
                ops: _frame.ops,
                size: primarySize,
                devicePixelRatio: View.of(surfaceContext).devicePixelRatio,
                surface: 0,
                allowHostArena: Scrollable.maybeOf(surfaceContext) != null,
              ),
              primarySize,
            ),
          );
        }
        // Auxiliary output remains the original scrollable preview layout.
        // Its vertical SingleChildScrollView intentionally gives the Column an
        // unbounded height; do not put the live-mode OverflowBox there because
        // OverflowBoxFit.max would inherit an infinite parent extent.
        final auxiliarySize = _fitSurfaceSize(
          auxiliary.width,
          auxiliary.height,
          constraints,
        );
        // The auxiliary output is an independent logical surface. Keep it
        // below the primary in a scrollable host layout so both canvases
        // remain real, fully sized DrawList targets even when their aspect
        // ratios do not fit the parent side by side.
        return SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Builder(
                builder: (surfaceContext) => Center(
                  child: _buildSurface(
                    width: _frame.width,
                    height: _frame.height,
                    ops: _frame.ops,
                    size: primarySize,
                    devicePixelRatio: View.of(surfaceContext).devicePixelRatio,
                    surface: 0,
                    allowHostArena: Scrollable.maybeOf(surfaceContext) != null,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Builder(
                builder: (surfaceContext) => Center(
                  child: _buildSurface(
                    width: auxiliary.width,
                    height: auxiliary.height,
                    ops: auxiliary.ops,
                    size: auxiliarySize,
                    devicePixelRatio: View.of(surfaceContext).devicePixelRatio,
                    surface: 1,
                    allowHostArena: Scrollable.maybeOf(surfaceContext) != null,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
    if (!widget.showDebugFps) return content;
    final fpsText = _fps?.toStringAsFixed(0) ?? '--';
    final minimumText = _sessionMinFps?.toStringAsFixed(0) ?? '--';
    final diagnosticInsets = _diagnosticOverlayInsets(context);
    return Stack(
      children: <Widget>[
        content,
        Positioned(
          top: diagnosticInsets.top + 6,
          right: diagnosticInsets.right + 6,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xb3000000),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                child: Text(
                  'FPS $fpsText | min $minimumText',
                  style: TextStyle(fontSize: 11, color: _fpsLabelColor()),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Size _fitSurfaceSize(
    double logicalWidth,
    double logicalHeight,
    BoxConstraints constraints,
  ) {
    if (!logicalWidth.isFinite ||
        !logicalHeight.isFinite ||
        logicalWidth <= 0 ||
        logicalHeight <= 0) {
      return Size.zero;
    }
    final maxWidth = constraints.maxWidth.isFinite
        ? constraints.maxWidth
        : logicalWidth;
    final maxHeight = constraints.maxHeight.isFinite
        ? constraints.maxHeight
        : logicalHeight;
    if (maxWidth <= 0 || maxHeight <= 0) return Size.zero;
    final scale = math.min(maxWidth / logicalWidth, maxHeight / logicalHeight);
    return Size(logicalWidth * scale, logicalHeight * scale);
  }

  BoxFit _videoBoxFit(String value) {
    return switch (value.toLowerCase()) {
      'contain' => BoxFit.contain,
      'fill' => BoxFit.fill,
      _ => BoxFit.cover,
    };
  }

  Widget _buildVideoTexture(VideoPlayerController video, PocketVideoOp op) {
    final source = video.value.size;
    final sourceWidth = source.width.isFinite && source.width > 0
        ? source.width
        : op.width;
    final sourceHeight = source.height.isFinite && source.height > 0
        ? source.height
        : op.height;
    // VideoPlayer is a Flutter Texture widget. Keep the source aspect ratio
    // explicit and let FittedBox perform cover/contain/fill inside the DrawOp
    // destination; passing a tight destination straight to VideoPlayer would
    // silently stretch the decoded media.
    return FittedBox(
      fit: _videoBoxFit(op.fit),
      alignment: Alignment.center,
      clipBehavior: Clip.hardEdge,
      child: SizedBox(
        width: sourceWidth,
        height: sourceHeight,
        child: VideoPlayer(video),
      ),
    );
  }

  Widget _buildSurface({
    required double width,
    required double height,
    required List<PocketOp> ops,
    required Size size,
    required double devicePixelRatio,
    required int surface,
    required bool allowHostArena,
  }) {
    if (size.width <= 0 || size.height <= 0) return const SizedBox.shrink();
    final scaleX = width == 0 ? 1.0 : size.width / width;
    final scaleY = height == 0 ? 1.0 : size.height / height;
    final sceneChildren = <Widget>[];
    final canvasOps = <PocketOp>[];
    void flushCanvas() {
      if (canvasOps.isEmpty) return;
      // Each block remains a full-size transparent canvas. Stacking the
      // blocks preserves Canvas order while RepaintBoundary lets unchanged
      // blocks retain their raster layer when another block changes.
      for (var start = 0; start < canvasOps.length; start += _canvasBlockSize) {
        final end = math.min(start + _canvasBlockSize, canvasOps.length);
        sceneChildren.add(
          Positioned.fill(
            child: RepaintBoundary(
              child: CustomPaint(
                painter: PocketCanvasPainter(
                  width: width,
                  height: height,
                  ops: List<PocketOp>.of(canvasOps.sublist(start, end)),
                  images: _images,
                  renderedSize: size,
                  devicePixelRatio: devicePixelRatio,
                  fontFamilyFallback: widget.fontFamilyFallback,
                  textLayoutCache: _textLayoutCache,
                ),
              ),
            ),
          ),
        );
      }
      canvasOps.clear();
    }

    final mountedSurfaces = <int>{};
    for (var drawIndex = 0; drawIndex < ops.length; drawIndex++) {
      final op = ops[drawIndex];
      if (op is PocketHostSurfaceOp) {
        flushCanvas();
        Widget? child;
        if (op.kind == 'application' && widget.hostSurfaceBuilder != null) {
          if (!mountedSurfaces.add(op.surfaceHandle)) {
            throw StateError(
              'Duplicate compositor surface ${op.surfaceHandle}',
            );
          }
          final bounds = Rect.fromLTWH(op.x, op.y, op.width, op.height);
          var visible = bounds.intersect(Rect.fromLTWH(0, 0, width, height));
          if (op.clip != null) {
            visible = visible.intersect(
              Rect.fromLTWH(
                op.clip!.x,
                op.clip!.y,
                op.clip!.width,
                op.clip!.height,
              ),
            );
          }
          final slot = PocketCompositorSlot(
            surfaceHandle: op.surfaceHandle,
            bounds: bounds,
            visibleClip: visible,
            logicalViewport: Size(width, height),
            visible: !visible.isEmpty,
            focused: op.focused && !visible.isEmpty,
            drawIndex: drawIndex,
          );
          _lastCompositorSlots[op.surfaceHandle] = slot;
          child = widget.hostSurfaceBuilder!(slot);
        } else if (op.kind == 'glass') {
          child = _PocketGlassFilter(
            key: ValueKey('glass-${op.id}'),
            parameters: op.parameters,
            geometry: Rect.fromLTWH(
              op.x * scaleX,
              op.y * scaleY,
              op.width * scaleX,
              op.height * scaleY,
            ),
            surfaceSize: size,
            scale: math.min(scaleX, scaleY),
          );
        } else if (op.kind == 'platformTexture') {
          final textureId = op.parameters['textureId'];
          if (textureId is int &&
              _controller._platformTextures.contains(textureId)) {
            final sourceWidth = _surfaceNumber(
              op.parameters,
              'sourceWidth',
              640,
              1,
              8192,
            );
            final sourceHeight = _surfaceNumber(
              op.parameters,
              'sourceHeight',
              480,
              1,
              8192,
            );
            // Camera2 returns explicit transform metadata. Keep this
            // optional so non-camera platform textures and iOS remain
            // unchanged. RotatedBox swaps layout dimensions before FittedBox
            // scales the texture into its JS-owned surface bounds.
            final rotationDegrees = _surfaceNumber(
              op.parameters,
              'rotationDegrees',
              0,
              -360,
              360,
            );
            final quarterTurns = ((rotationDegrees / 90).round() % 4 + 4) % 4;
            Widget texture = SizedBox(
              width: sourceWidth,
              height: sourceHeight,
              child: Texture(textureId: textureId),
            );
            if (quarterTurns != 0) {
              texture = RotatedBox(quarterTurns: quarterTurns, child: texture);
            }
            if (op.parameters['mirrorX'] == true) {
              texture = Transform(
                alignment: Alignment.center,
                transform: Matrix4.diagonal3Values(-1, 1, 1),
                child: texture,
              );
            }
            child = FittedBox(
              fit: op.parameters['fit'] == 'contain'
                  ? BoxFit.contain
                  : BoxFit.cover,
              child: texture,
            );
          }
        }
        if (child != null) {
          final clip = op.clip;
          final bounds = Rect.fromLTWH(op.x, op.y, op.width, op.height);
          final visible =
              (clip == null
                      ? bounds
                      : bounds.intersect(
                          Rect.fromLTWH(
                            clip.x,
                            clip.y,
                            clip.width,
                            clip.height,
                          ),
                        ))
                  .intersect(Rect.fromLTWH(0, 0, width, height));
          if (visible.isEmpty && op.kind == 'application') {
            sceneChildren.add(
              Positioned(
                key: ValueKey('surface-application-${op.surfaceHandle}'),
                left: 0,
                top: 0,
                width: op.width * scaleX,
                height: op.height * scaleY,
                child: Offstage(offstage: true, child: child),
              ),
            );
          }
          if (!visible.isEmpty) {
            final radius =
                _surfaceNumber(
                  op.parameters,
                  'radius',
                  0,
                  0,
                  math.min(op.width, op.height) / 2,
                ) *
                math.min(scaleX, scaleY);
            // Apply the rounded mask in the surface's original bounds.
            // The visible rectangle is only a viewport clip: applying the
            // RRect after intersecting it would manufacture new rounded
            // corners whenever a scrolling surface is partially visible.
            final roundedChild = radius > 0
                ? ClipRRect(
                    clipBehavior: Clip.antiAlias,
                    borderRadius: BorderRadius.circular(radius),
                    child: child,
                  )
                : child;
            final surfaceStack = Stack(
              children: [
                Positioned(
                  left: (op.x - visible.left) * scaleX,
                  top: (op.y - visible.top) * scaleY,
                  width: op.width * scaleX,
                  height: op.height * scaleY,
                  child: roundedChild,
                ),
              ],
            );
            // This clip is intentionally rectangular. The rounded mask is
            // already attached to the full-size positioned child above.
            final clippedSurface = ClipRect(child: surfaceStack);
            sceneChildren.add(
              Positioned(
                key: ValueKey(
                  'surface-${op.kind}-${op.kind == 'application' ? op.surfaceHandle : op.id}',
                ),
                left: visible.left * scaleX,
                top: visible.top * scaleY,
                width: visible.width * scaleX,
                height: visible.height * scaleY,
                child: IgnorePointer(
                  ignoring: op.kind != 'application' || !op.focused,
                  child: clippedSurface,
                ),
              ),
            );
          }
        }
        continue;
      }
      if (op is! PocketVideoOp) {
        canvasOps.add(op);
        continue;
      }
      flushCanvas();
      final video = _videos[op.id];
      if (video?.value.isInitialized ?? false) {
        final clip = op.clip;
        if (clip == null) {
          sceneChildren.add(
            Positioned(
              left: op.x * scaleX,
              top: op.y * scaleY,
              width: op.width * scaleX,
              height: op.height * scaleY,
              child: ClipRect(child: _buildVideoTexture(video!, op)),
            ),
          );
        } else {
          // Keep the video in the same logical op order, while clipping the
          // Flutter texture to the clip rectangle emitted by JS.
          sceneChildren.add(
            Positioned(
              left: clip.x * scaleX,
              top: clip.y * scaleY,
              width: clip.width * scaleX,
              height: clip.height * scaleY,
              child: ClipRect(
                child: Stack(
                  fit: StackFit.expand,
                  children: <Widget>[
                    Positioned(
                      left: (op.x - clip.x) * scaleX,
                      top: (op.y - clip.y) * scaleY,
                      width: op.width * scaleX,
                      height: op.height * scaleY,
                      child: _buildVideoTexture(video!, op),
                    ),
                  ],
                ),
              ),
            ),
          );
        }
      }
    }
    flushCanvas();
    if (surface == 0 && widget.hostSurfaceBuilder != null) {
      _lastCompositorSlots.removeWhere(
        (handle, _) => !widget.hostSurfaceResidents.contains(handle),
      );
      for (final handle in widget.hostSurfaceResidents.difference(
        mountedSurfaces,
      )) {
        final prior = _lastCompositorSlots[handle];
        final bounds = prior?.bounds ?? Rect.fromLTWH(0, 0, width, height);
        final child = widget.hostSurfaceBuilder!(
          PocketCompositorSlot(
            surfaceHandle: handle,
            bounds: bounds,
            visibleClip: Rect.zero,
            logicalViewport: Size(width, height),
            visible: false,
            focused: false,
            drawIndex: -1,
          ),
        );
        if (child != null) {
          sceneChildren.add(
            Positioned(
              key: ValueKey('surface-application-$handle'),
              left: 0,
              top: 0,
              width: bounds.width * scaleX,
              height: bounds.height * scaleY,
              child: Offstage(offstage: true, child: child),
            ),
          );
        }
      }
    }
    final textInputId = _textInputId;
    final textInputRect = _textInputRect;
    final textInputClipRect = _textInputClipRect;
    final textInputController = _textInputController;
    final textInputFocusNode = _textInputFocusNode;
    final textInputLineHeight = _textInputLineHeight();
    if (surface == 0 &&
        widget.inputEnabled &&
        textInputId != null &&
        textInputRect != null &&
        textInputController != null &&
        textInputFocusNode != null) {
      final textInputField = Material(
        type: MaterialType.transparency,
        child: TextField(
          key: ValueKey<String>('pocket-text-input-$textInputId'),
          controller: textInputController,
          focusNode: textInputFocusNode,
          keyboardType: _textInputKeyboardType,
          textInputAction: _textInputAction,
          obscureText: _textInputObscure,
          autocorrect: _textInputAutocorrect,
          enableSuggestions: !_textInputObscure,
          maxLines: _textInputMaxLines,
          minLines: _textInputMinLines,
          scrollPadding: EdgeInsets.zero,
          onEditingComplete: () {},
          onSubmitted: (_) => _submitTextInput(),
          // A down-outside callback would close the overlay before the
          // surrounding Pocket surface can deliver its matching up edge.
          // Keep down as a no-op and dismiss after the complete tap.
          onTapOutside: _onTextInputTapOutside,
          onTapUpOutside: _onTextInputTapUpOutside,
          style: TextStyle(
            color: _textInputTextColor,
            fontSize: _textInputFontSize,
            fontWeight: _textInputFontWeight,
            height: textInputLineHeight,
          ),
          cursorColor: _textInputFocusedBorderColor,
          decoration: InputDecoration(
            isDense: true,
            filled: true,
            fillColor: _textInputFillColor,
            hintText: _textInputHintText,
            hintStyle: TextStyle(
              color: _textInputHintColor,
              fontSize: _textInputFontSize,
              fontWeight: _textInputFontWeight,
              height: textInputLineHeight,
            ),
            contentPadding: EdgeInsets.symmetric(
              horizontal: _textInputPaddingHorizontal,
              vertical: _textInputPaddingVertical,
            ),
            border: OutlineInputBorder(
              // Material 3 adds OutlineInputBorder.gapPadding to the
              // input's horizontal origin even when there is no floating
              // label. JS owns the shell geometry, so keep the native text
              // origin aligned with its 12px content padding.
              gapPadding: 0,
              borderRadius: BorderRadius.circular(_textInputBorderRadius),
              borderSide: BorderSide(color: _textInputBorderColor),
            ),
            enabledBorder: OutlineInputBorder(
              gapPadding: 0,
              borderRadius: BorderRadius.circular(_textInputBorderRadius),
              borderSide: BorderSide(color: _textInputBorderColor),
            ),
            focusedBorder: OutlineInputBorder(
              gapPadding: 0,
              borderRadius: BorderRadius.circular(_textInputBorderRadius),
              borderSide: BorderSide(
                color: _textInputFocusedBorderColor,
                width: 1,
              ),
            ),
          ),
        ),
      );
      // Keep the TextField in one stable Element tree even when the page
      // scrolls it fully outside the viewport. Removing it on an empty
      // intersection would dispose EditableText, close the platform keyboard,
      // and recreate the controller on the next scroll frame. The outer
      // viewport remains the clip; the child retains its full input geometry
      // relative to that viewport.
      final overlayBounds = textInputClipRect ?? textInputRect;
      sceneChildren.add(
        Positioned(
          key: ValueKey<String>('pocket-text-overlay-$textInputId'),
          left: overlayBounds.left * scaleX,
          top: overlayBounds.top * scaleY,
          width: overlayBounds.width * scaleX,
          height: overlayBounds.height * scaleY,
          child: ClipRect(
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                Positioned(
                  left: (textInputRect.left - overlayBounds.left) * scaleX,
                  top: (textInputRect.top - overlayBounds.top) * scaleY,
                  width: textInputRect.width * scaleX,
                  height: textInputRect.height * scaleY,
                  child: textInputField,
                ),
              ],
            ),
          ),
        ),
      );
    }
    final hasGlass = ops.any(
      (op) => op is PocketHostSurfaceOp && op.kind == 'glass',
    );
    final scene = Stack(fit: StackFit.expand, children: sceneChildren);
    // Backdrop shaders sample their current render target. Isolate only an
    // optical canvas so embedding or translating PocketView cannot change
    // the normalized sampling coordinates. Ordinary pages keep cached layers
    // and incur no extra saveLayer.
    final Widget stack = hasGlass
        ? ClipRect(clipBehavior: Clip.antiAliasWithSaveLayer, child: scene)
        : scene;
    final gestureChild = allowHostArena
        ? RawGestureDetector(
            behavior: HitTestBehavior.opaque,
            excludeFromSemantics: true,
            gestures: <Type, GestureRecognizerFactory>{
              _PocketSurfaceGestureRecognizer:
                  GestureRecognizerFactoryWithHandlers<
                    _PocketSurfaceGestureRecognizer
                  >(
                    () => _PocketSurfaceGestureRecognizer(
                      surface: surface,
                      size: size,
                      onPointer: (phase, event) => _dispatchSurfacePointer(
                        surface: surface,
                        size: size,
                        phase: phase,
                        event: event,
                      ),
                      onProbe: (pointer, localPosition, travel) =>
                          _guestGestureForPointer(
                            surface: surface,
                            localPosition: localPosition,
                            travel: travel,
                            size: size,
                          ),
                    ),
                    (_PocketSurfaceGestureRecognizer recognizer) {},
                  ),
            },
            child: stack,
          )
        : stack;
    return SizedBox(
      width: size.width,
      height: size.height,
      child: Listener(
        key: ValueKey<String>('pocket-surface-$surface'),
        behavior: HitTestBehavior.opaque,
        onPointerSignal: (event) => _wakeTicker(),
        onPointerDown: allowHostArena
            ? null
            : (event) => _sendPointer(
                surface: surface,
                phase: 'down',
                id: event.pointer,
                localPosition: event.localPosition,
                actualWidth: size.width,
                actualHeight: size.height,
              ),
        onPointerMove: allowHostArena
            ? null
            : (event) => _sendPointer(
                surface: surface,
                phase: 'move',
                id: event.pointer,
                localPosition: event.localPosition,
                actualWidth: size.width,
                actualHeight: size.height,
              ),
        onPointerUp: allowHostArena
            ? null
            : (event) => _sendPointer(
                surface: surface,
                phase: 'up',
                id: event.pointer,
                localPosition: event.localPosition,
                actualWidth: size.width,
                actualHeight: size.height,
              ),
        onPointerCancel: allowHostArena
            ? null
            : (event) => _sendPointer(
                surface: surface,
                phase: 'cancel',
                id: event.pointer,
                localPosition: event.localPosition,
                actualWidth: size.width,
                actualHeight: size.height,
              ),
        child: gestureChild,
      ),
    );
  }
}

final class _PocketVideoRequest {
  const _PocketVideoRequest({required this.op, required this.visible});

  final PocketVideoOp op;
  final bool visible;
}

final class _PocketTextInputState {
  const _PocketTextInputState({
    required this.value,
    required this.hasExplicitTextOrSelection,
  });

  final TextEditingValue value;
  final bool hasExplicitTextOrSelection;

  static int _textInputOffset(
    Object? value,
    int fallback,
    int textLength, {
    bool allowUnset = false,
  }) {
    final number = value is num && value.isFinite ? value.toInt() : fallback;
    if (allowUnset && number < 0) return -1;
    return number.clamp(0, textLength);
  }

  static _PocketTextInputState fromJson(
    Map<String, dynamic> params, {
    TextEditingValue? fallback,
    bool isOpen = false,
  }) {
    final effectiveFallback = fallback ?? const TextEditingValue();
    final text = params.containsKey('text')
        ? '${params['text'] ?? ''}'
        : effectiveFallback.text;
    final fallbackSelectionBase = effectiveFallback.selection.baseOffset < 0
        ? text.length
        : effectiveFallback.selection.baseOffset;
    final fallbackSelectionExtent = effectiveFallback.selection.extentOffset < 0
        ? text.length
        : effectiveFallback.selection.extentOffset;
    final selectionBase = _textInputOffset(
      params['selectionBase'],
      fallbackSelectionBase,
      text.length,
      allowUnset: true,
    );
    final selectionExtent = _textInputOffset(
      params['selectionExtent'],
      fallbackSelectionExtent,
      text.length,
      allowUnset: true,
    );
    final hasComposing =
        params.containsKey('composingBase') ||
        params.containsKey('composingExtent');
    final composingBase = _textInputOffset(
      params['composingBase'],
      effectiveFallback.composing.start,
      text.length,
      allowUnset: true,
    );
    final composingExtent = _textInputOffset(
      params['composingExtent'],
      effectiveFallback.composing.end,
      text.length,
      allowUnset: true,
    );
    final composing = hasComposing
        ? (composingBase >= 0 &&
                  composingExtent >= 0 &&
                  composingBase <= composingExtent)
              ? TextRange(start: composingBase, end: composingExtent)
              : TextRange.empty
        : (effectiveFallback.composing.start >= 0 &&
              effectiveFallback.composing.end >=
                  effectiveFallback.composing.start &&
              effectiveFallback.composing.end <= text.length)
        ? effectiveFallback.composing
        : TextRange.empty;

    final TextSelection selection;
    if (fallback != null &&
        params['selectionBase'] == null &&
        params['selectionExtent'] == null &&
        selectionBase == fallback.selection.baseOffset &&
        selectionExtent == fallback.selection.extentOffset) {
      selection = fallback.selection;
    } else {
      selection = TextSelection(
        baseOffset: selectionBase,
        extentOffset: selectionExtent,
      );
    }

    final hasExplicitTextOrSelection =
        isOpen ||
        params.containsKey('text') ||
        params.containsKey('selectionBase') ||
        params.containsKey('selectionExtent') ||
        params.containsKey('composingBase') ||
        params.containsKey('composingExtent');

    return _PocketTextInputState(
      value: TextEditingValue(
        text: text,
        selection: selection,
        composing: composing,
      ),
      hasExplicitTextOrSelection: hasExplicitTextOrSelection,
    );
  }
}
