import 'dart:convert';
import 'dart:typed_data';

class PocketClip {
  const PocketClip({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  factory PocketClip.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('Pocket clip must be an object');
    }
    final json = Map<String, dynamic>.from(value);
    return PocketClip(
      x: _number(json['x']),
      y: _number(json['y']),
      width: _number(json['w'] ?? json['width']),
      height: _number(json['h'] ?? json['height']),
    );
  }

  final double x;
  final double y;
  final double width;
  final double height;
}

/// One drawing command emitted by the PocketJS guest.
sealed class PocketOp {
  const PocketOp({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    this.clip,
  });

  final double x;
  final double y;
  final double width;
  final double height;
  final PocketClip? clip;

  factory PocketOp.fromJson(Map<String, dynamic> json) {
    final type = json['type'];
    final x = _number(json['x']);
    final y = _number(json['y']);
    final width = _number(json['w'] ?? json['width']);
    final height = _number(json['h'] ?? json['height']);
    final clip = json['clip'] == null
        ? null
        : PocketClip.fromJson(json['clip']);
    switch (type) {
      case 'rect':
        return PocketRectOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: _color(json['color']),
          clip: clip,
        );
      case 'rounded':
        return PocketRoundedOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: _color(json['color']),
          radius: _number(json['radius']),
          clip: clip,
        );
      case 'gradient':
        return PocketGradientOp(
          x: x,
          y: y,
          width: width,
          height: height,
          fromColor: _color(
            json['fromColor'] ??
                json['from_color'] ??
                json['from'] ??
                json['color'],
          ),
          toColor: _color(
            json['toColor'] ?? json['to_color'] ?? json['to'] ?? json['color'],
          ),
          direction: _integer(json['direction'] ?? json['dir']),
          clip: clip,
        );
      case 'triangle':
        return PocketTriangleOp(
          x: x,
          y: y,
          width: width,
          height: height,
          points: _points(json['points']),
          colors: _colors(json['colors']),
          clip: clip,
        );
      case 'textureTriangle':
        return PocketTextureTriangleOp(
          x: x,
          y: y,
          width: width,
          height: height,
          asset: '${json['asset'] ?? ''}',
          color: _color(json['color']),
          points: _points(json['points']),
          uvs: _numbers(json['uvs']),
          clip: clip,
        );
      case 'text':
        final fontSlot = _fontSlot(json['fontSlot']);
        return PocketTextOp(
          x: x,
          y: y,
          width: width,
          height: height,
          text: '${json['text'] ?? ''}',
          size: _number(json['size'], fallback: _fontSlotSize(fontSlot)),
          color: _color(json['color']),
          fontSlot: fontSlot,
          clip: clip,
        );
      case 'image':
        return PocketImageOp(
          x: x,
          y: y,
          width: width,
          height: height,
          asset: '${json['asset'] ?? ''}',
          uv: _optionalNumbers(json['uv'], expected: 4),
          // The native TEX_QUAD adapter's public schema uses `color` for the
          // per-image ARGB modulation word. Keep one canonical field here so
          // the bridge does not accumulate speculative aliases.
          tint: json['color'] == null ? null : _color(json['color']),
          clip: clip,
        );
      case 'hostSurface':
        final descriptor = jsonDecode('${json['asset'] ?? '{}'}');
        if (descriptor is! Map || descriptor['parameters'] is! Map) {
          throw const FormatException('Invalid host surface descriptor');
        }
        return PocketHostSurfaceOp(
          x: x,
          y: y,
          width: width,
          height: height,
          clip: clip,
          id: '${json['id'] ?? ''}',
          kind: '${descriptor['kind']}',
          parameters: Map<String, dynamic>.from(
            descriptor['parameters'] as Map,
          ),
        );
      case 'video':
        return PocketVideoOp(
          x: x,
          y: y,
          width: width,
          height: height,
          id: '${json['id'] ?? 'video'}',
          asset: '${json['asset'] ?? ''}',
          autoplay: json['autoplay'] != false,
          fit: '${json['fit'] ?? 'cover'}',
          clip: clip,
        );
      default:
        throw FormatException('Unknown PocketJS operation: $type');
    }
  }
}

class PocketRectOp extends PocketOp {
  const PocketRectOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.color,
    super.clip,
  });

  final int color;
}

class PocketRoundedOp extends PocketOp {
  const PocketRoundedOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.color,
    required this.radius,
    super.clip,
  });

  final int color;
  final double radius;
}

class PocketGradientOp extends PocketOp {
  const PocketGradientOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.fromColor,
    required this.toColor,
    required this.direction,
    super.clip,
  });

  final int fromColor;
  final int toColor;
  final int direction;
}

class PocketPoint {
  const PocketPoint({required this.x, required this.y});

  factory PocketPoint.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('Pocket triangle point must be an object');
    }
    final json = Map<String, dynamic>.from(value);
    return PocketPoint(x: _number(json['x']), y: _number(json['y']));
  }

  final double x;
  final double y;
}

class PocketTriangleOp extends PocketOp {
  const PocketTriangleOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.points,
    required this.colors,
    super.clip,
  });

  final List<PocketPoint> points;
  final List<int> colors;
}

class PocketTextureTriangleOp extends PocketOp {
  const PocketTextureTriangleOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.asset,
    required this.color,
    required this.points,
    required this.uvs,
    super.clip,
  });

  final String asset;
  final int color;
  final List<PocketPoint> points;
  final List<double> uvs;
}

class PocketTextOp extends PocketOp {
  const PocketTextOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.text,
    required this.size,
    required this.color,
    this.fontSlot,
    super.clip,
  });

  final String text;
  final double size;
  final int color;
  final int? fontSlot;
}

class PocketImageOp extends PocketOp {
  const PocketImageOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.asset,
    this.uv,
    this.tint,
    super.clip,
  });

  final String asset;
  final List<double>? uv;

  /// Optional ARGB modulation supplied by the native TEX_QUAD adapter's
  /// canonical `color` field. A null tint preserves the unmodulated path.
  final int? tint;
}

class PocketVideoOp extends PocketOp {
  const PocketVideoOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.id,
    required this.asset,
    required this.autoplay,
    this.fit = 'cover',
    super.clip,
  });

  final String id;
  final String asset;
  final bool autoplay;

  /// Flutter texture fitting policy. Native SURFACE_QUAD records carry the
  /// canonical host metadata when available; older hosts default to `cover`.
  final String fit;
}

class PocketEvent {
  const PocketEvent({
    required this.id,
    required this.method,
    required this.params,
  });

  final String id;
  final String method;
  final Map<String, dynamic> params;

  factory PocketEvent.fromJson(Map<String, dynamic> json) {
    final rawParams = json['params'] ?? json['payload'];
    return PocketEvent(
      id: '${json['id'] ?? ''}',
      method: '${json['method'] ?? json['name'] ?? ''}',
      params: rawParams is Map
          ? Map<String, dynamic>.from(rawParams)
          : <String, dynamic>{},
    );
  }
}

/// A native-owned image resource copied from the PocketJS texture table.
///
/// PAK admission and texture upload stay on the native side. The Flutter
/// renderer receives the already-decoded texture bytes once, then converts
/// them to a ui.Image without depending on a native view or texture handle.
class PocketImageResource {
  const PocketImageResource({
    required this.asset,
    this.revision = 0,
    required this.width,
    required this.height,
    required this.psm,
    required this.linear,
    required this.pixels,
    this.palette,
  });

  factory PocketImageResource.fromJson(Map<String, dynamic> json) {
    final pixels = _byteList(json['pixels'], field: 'pixels');
    final palette = _byteList(json['palette'], field: 'palette');
    return PocketImageResource(
      asset: '${json['asset'] ?? ''}',
      revision: _integer(json['revision']),
      width: _integer(json['width'] ?? json['w']),
      height: _integer(json['height'] ?? json['h']),
      psm: _integer(json['psm']),
      linear: json['linear'] == true,
      pixels: pixels!,
      palette: palette,
    );
  }

  final String asset;

  /// Native core texture content revision. A generation-tagged texture handle
  /// can remain unchanged while its pixels are overwritten in place.
  final int revision;
  final int width;
  final int height;
  final int psm;
  final bool linear;
  final Uint8List pixels;
  final Uint8List? palette;
}

/// A retained DrawList emitted for the optional PocketJS auxiliary surface.
///
/// Auxiliary coordinates are independent from the primary frame; the host
/// must scale this surface from its own logical viewport rather than reusing
/// the primary frame dimensions.
class PocketSurfaceFrame {
  const PocketSurfaceFrame({
    required this.width,
    required this.height,
    required this.ops,
  });

  factory PocketSurfaceFrame.fromJson(Map<String, dynamic> json) {
    return PocketSurfaceFrame(
      width: _number(json['width'] ?? json['w'], fallback: 0),
      height: _number(json['height'] ?? json['h'], fallback: 0),
      ops: _opsFromJson(json['ops']),
    );
  }

  final double width;
  final double height;
  final List<PocketOp> ops;
}

class PocketFrame {
  const PocketFrame({
    required this.width,
    required this.height,
    required this.ops,
    required this.events,
    this.resources = const <PocketImageResource>[],
    this.releasedResources = const <String>[],
    this.auxiliary,
  });

  factory PocketFrame.empty({double width = 360, double height = 640}) {
    return PocketFrame(
      width: width,
      height: height,
      ops: const <PocketOp>[],
      events: const <PocketEvent>[],
      resources: const <PocketImageResource>[],
      releasedResources: const <String>[],
      auxiliary: null,
    );
  }

  factory PocketFrame.fromJson(String source) {
    final decoded = jsonDecode(source);
    if (decoded is! Map) {
      throw const FormatException('Pocket frame must be a JSON object');
    }
    final json = Map<String, dynamic>.from(decoded);
    final rawOps = json['ops'];
    final rawEvents = json['events'];
    final rawResources = json['resources'];
    final rawReleasedResources = json['releasedResources'];
    final rawAuxiliary = json['auxiliary'];
    return PocketFrame(
      width: _number(json['width'], fallback: 360),
      height: _number(json['height'], fallback: 640),
      ops: _opsFromJson(rawOps),
      events: rawEvents is List
          ? rawEvents
                .whereType<Map>()
                .map(
                  (event) =>
                      PocketEvent.fromJson(Map<String, dynamic>.from(event)),
                )
                .toList(growable: false)
          : const <PocketEvent>[],
      resources: rawResources is List
          ? rawResources
                .whereType<Map>()
                .map(
                  (resource) => PocketImageResource.fromJson(
                    Map<String, dynamic>.from(resource),
                  ),
                )
                .toList(growable: false)
          : const <PocketImageResource>[],
      releasedResources: rawReleasedResources is List
          ? rawReleasedResources.whereType<String>().toList(growable: false)
          : const <String>[],
      auxiliary: rawAuxiliary is Map
          ? PocketSurfaceFrame.fromJson(Map<String, dynamic>.from(rawAuxiliary))
          : null,
    );
  }

  final double width;
  final double height;
  final List<PocketOp> ops;
  final List<PocketEvent> events;
  final List<PocketImageResource> resources;
  final List<String> releasedResources;
  final PocketSurfaceFrame? auxiliary;
}

List<PocketOp> _opsFromJson(Object? rawOps) {
  if (rawOps is! List) return const <PocketOp>[];
  return rawOps
      .whereType<Map>()
      .map((op) => PocketOp.fromJson(Map<String, dynamic>.from(op)))
      .toList(growable: false);
}

Uint8List? _byteList(Object? value, {required String field}) {
  if (value == null && field == 'palette') return null;
  if (value is! List) {
    throw FormatException('Pocket image resource $field must be a list');
  }
  final bytes = <int>[];
  for (final entry in value) {
    if (entry is! num || !entry.isFinite) {
      throw FormatException(
        'Pocket image resource $field entries must be finite numbers',
      );
    }
    bytes.add(entry.toInt() & 0xff);
  }
  return Uint8List.fromList(bytes);
}

double _number(Object? value, {double fallback = 0}) {
  if (value is num && value.isFinite) return value.toDouble();
  return fallback;
}

int _color(Object? value) {
  if (value is int) return value & 0xffffffff;
  if (value is num) return value.toInt() & 0xffffffff;
  if (value is String) {
    final text = value.replaceFirst('#', '');
    final parsed = int.tryParse(text, radix: 16);
    if (parsed != null) {
      return text.length <= 6 ? (0xff000000 | parsed) : parsed;
    }
  }
  return 0xff000000;
}

int _integer(Object? value) {
  if (value is num && value.isFinite) return value.toInt();
  return 0;
}

List<PocketPoint> _points(Object? value) {
  if (value is! List) {
    throw const FormatException('Pocket triangle points must be a list');
  }
  final points = value.map(PocketPoint.fromJson).toList(growable: false);
  if (points.length != 3) {
    throw const FormatException('Pocket triangle must have three points');
  }
  return points;
}

List<int> _colors(Object? value) {
  if (value is! List || value.length != 3) {
    throw const FormatException('Pocket triangle must have three colors');
  }
  return value.map(_color).toList(growable: false);
}

List<double> _numbers(Object? value) {
  if (value is! List || value.length != 6) {
    throw const FormatException('Pocket texture triangle must have six UVs');
  }
  final numbers = value.map((item) => _number(item, fallback: double.nan));
  final result = numbers.toList(growable: false);
  if (result.any((number) => !number.isFinite)) {
    throw const FormatException('Pocket texture triangle UVs must be finite');
  }
  return result;
}

List<double>? _optionalNumbers(Object? value, {required int expected}) {
  if (value == null) return null;
  if (value is! List || value.length != expected) {
    throw FormatException('Pocket image UVs must have $expected values');
  }
  final numbers = value.map((item) => _number(item, fallback: double.nan));
  final result = numbers.toList(growable: false);
  if (result.any((number) => !number.isFinite)) {
    throw const FormatException('Pocket image UVs must be finite');
  }
  return result;
}

int? _fontSlot(Object? value) {
  if (value is num && value.isFinite) {
    final slot = value.toInt();
    if (slot >= 0 && slot <= 255) return slot;
  }
  return null;
}

double _fontSlotSize(int? slot) {
  if (slot == null) return 16;
  return switch (slot) {
    >= 0 && <= 6 => const <double>[12, 14, 16, 18, 20, 24, 36][slot],
    >= 7 && <= 13 => const <double>[12, 14, 16, 18, 20, 24, 36][slot - 7],
    14 || 15 => 54,
    >= 16 && <= 18 => const <double>[12, 14, 16][slot - 16],
    19 || 20 => 10,
    _ => 16,
  };
}

/// Generic native compositor projection. It carries no page or widget schema.
/// The retained engine supplies geometry/order/clip; JS supplies parameters.
class PocketHostSurfaceOp extends PocketOp {
  const PocketHostSurfaceOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    super.clip,
    required this.id,
    required this.kind,
    required this.parameters,
  });
  final String id;
  final String kind;
  final Map<String, dynamic> parameters;
}
