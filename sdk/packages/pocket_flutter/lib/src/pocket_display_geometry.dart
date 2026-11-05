import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart' show EdgeInsets;

typedef PocketDisplayGeometryUpdate =
    void Function(PocketDisplayGeometrySnapshot snapshot);

/// A reserved UIKit region in Flutter view coordinates.
///
/// The frame is expressed in logical points relative to the platform view.
/// [PocketView] converts it into the guest canvas coordinates before adding it
/// to `display.viewport`; callers outside the renderer should not apply a
/// second device-pixel-ratio conversion.
final class PocketDisplayRegion {
  const PocketDisplayRegion({
    required this.id,
    required this.kind,
    required this.frame,
    required this.margins,
    required this.active,
  });

  final String id;
  final String kind;
  final Rect frame;
  final EdgeInsets margins;
  final bool active;

  static PocketDisplayRegion? fromDynamic(Object? value) {
    if (value is! Map) return null;
    final map = Map<Object?, Object?>.from(value);
    final kind = map['kind'];
    if (kind is! String || (kind != 'division' && kind != 'occlusion')) {
      return null;
    }
    final left = _finiteNumber(map['left']);
    final top = _finiteNumber(map['top']);
    final width = _finiteNumber(map['width']);
    final height = _finiteNumber(map['height']);
    if (left == null || top == null || width == null || height == null) {
      return null;
    }
    if (width < 0 || height < 0) return null;
    final margins = _edgeInsets(map['margins']);
    if (margins == null) return null;
    final id = map['id'];
    return PocketDisplayRegion(
      id: id is String ? id : '',
      kind: kind,
      frame: Rect.fromLTWH(left, top, width, height),
      margins: margins,
      active: map['active'] == true,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id,
    'kind': kind,
    'frame': <String, double>{
      'left': frame.left,
      'top': frame.top,
      'width': frame.width,
      'height': frame.height,
    },
    'margins': <String, double>{
      'top': margins.top,
      'right': margins.right,
      'bottom': margins.bottom,
      'left': margins.left,
    },
    'active': active,
  };

  @override
  bool operator ==(Object other) {
    return other is PocketDisplayRegion &&
        other.id == id &&
        other.kind == kind &&
        other.frame == frame &&
        other.margins == margins &&
        other.active == active;
  }

  @override
  int get hashCode => Object.hash(id, kind, frame, margins, active);
}

/// A snapshot of UIKit regions exposed by the optional iOS geometry bridge.
final class PocketDisplayGeometrySnapshot {
  const PocketDisplayGeometrySnapshot({
    this.viewport,
    this.regions = const <PocketDisplayRegion>[],
    this.supported = false,
    this.reduceTransparency,
  });

  const PocketDisplayGeometrySnapshot.empty()
    : viewport = null,
      regions = const <PocketDisplayRegion>[],
      supported = false,
      reduceTransparency = null;

  final Size? viewport;
  final List<PocketDisplayRegion> regions;
  final bool supported;

  /// iOS UIKit's Reduce Transparency preference when available; null means
  /// that the optional platform provider cannot observe it.
  final bool? reduceTransparency;

  static PocketDisplayGeometrySnapshot fromDynamic(Object? value) {
    if (value is! Map) return const PocketDisplayGeometrySnapshot.empty();
    final map = Map<Object?, Object?>.from(value);
    Size? viewport;
    final rawViewport = map['viewport'];
    if (rawViewport is Map) {
      final width = _finiteNumber(rawViewport['width']);
      final height = _finiteNumber(rawViewport['height']);
      if (width != null && height != null && width > 0 && height > 0) {
        viewport = Size(width, height);
      }
    }
    final regions = <PocketDisplayRegion>[];
    final rawRegions = map['reservedRegions'];
    if (rawRegions is List) {
      for (final raw in rawRegions) {
        final region = PocketDisplayRegion.fromDynamic(raw);
        if (region != null) regions.add(region);
      }
    }
    return PocketDisplayGeometrySnapshot(
      viewport: viewport,
      regions: List<PocketDisplayRegion>.unmodifiable(regions),
      supported: map['supported'] == true,
      reduceTransparency: map['reduceTransparency'] is bool
          ? map['reduceTransparency'] as bool
          : null,
    );
  }
}

/// Optional platform channel for iOS ReservedRegion and Reduce Transparency
/// facts. ReservedRegion data requires iOS 27.1; the accessibility fact is
/// available on the supported iOS deployment target.
///
/// The channel is intentionally optional. On Android, macOS, older iOS, or a
/// host that has not registered the provider, [start] returns an empty
/// snapshot and PocketView continues to report the ordinary safe area.
abstract interface class PocketDisplayGeometrySource {
  Future<PocketDisplayGeometrySnapshot> start({
    PocketDisplayGeometryUpdate? onUpdate,
  });

  Future<void> stop({PocketDisplayGeometryUpdate? onUpdate});
}

final class PocketDisplayGeometryChannel
    implements PocketDisplayGeometrySource {
  static const String channelName = 'com.pocketnexus.host/displayGeometry';

  PocketDisplayGeometryChannel({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(channelName);

  final MethodChannel _channel;
  final List<PocketDisplayGeometryUpdate> _listeners =
      <PocketDisplayGeometryUpdate>[];
  int _activeStarts = 0;
  bool _handlerInstalled = false;

  @override
  Future<PocketDisplayGeometrySnapshot> start({
    PocketDisplayGeometryUpdate? onUpdate,
  }) async {
    if (onUpdate != null && !_listeners.contains(onUpdate)) {
      _listeners.add(onUpdate);
    }
    _activeStarts++;
    if (!_handlerInstalled) {
      _handlerInstalled = true;
      _channel.setMethodCallHandler(_handleMethodCall);
    }
    try {
      final value = await _channel.invokeMethod<dynamic>('start');
      return PocketDisplayGeometrySnapshot.fromDynamic(value);
    } on MissingPluginException {
      return const PocketDisplayGeometrySnapshot.empty();
    } on PlatformException {
      return const PocketDisplayGeometrySnapshot.empty();
    }
  }

  Future<Object?> _handleMethodCall(MethodCall call) async {
    if (call.method == 'update') {
      final snapshot = PocketDisplayGeometrySnapshot.fromDynamic(
        call.arguments,
      );
      for (final listener in List<PocketDisplayGeometryUpdate>.of(_listeners)) {
        listener(snapshot);
      }
    }
    return null;
  }

  @override
  Future<void> stop({PocketDisplayGeometryUpdate? onUpdate}) async {
    if (onUpdate != null) _listeners.remove(onUpdate);
    if (_activeStarts > 0) _activeStarts--;
    try {
      await _channel.invokeMethod<dynamic>('stop');
    } on MissingPluginException {
      // Optional on hosts that do not include the iOS provider.
    } on PlatformException {
      // A geometry provider must not make renderer disposal fail.
    } finally {
      if (_activeStarts == 0) {
        _listeners.clear();
        if (_handlerInstalled) _channel.setMethodCallHandler(null);
        _handlerInstalled = false;
      }
    }
  }
}

double? _finiteNumber(Object? value) {
  if (value is! num || !value.isFinite) return null;
  return value.toDouble();
}

EdgeInsets? _edgeInsets(Object? value) {
  if (value is! Map) return null;
  final map = Map<Object?, Object?>.from(value);
  final top = _finiteNumber(map['top']);
  final right = _finiteNumber(map['right']);
  final bottom = _finiteNumber(map['bottom']);
  final left = _finiteNumber(map['left']);
  if (top == null || right == null || bottom == null || left == null) {
    return null;
  }
  if (top < 0 || right < 0 || bottom < 0 || left < 0) return null;
  return EdgeInsets.only(top: top, right: right, bottom: bottom, left: left);
}
