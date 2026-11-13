import 'dart:collection' show UnmodifiableListView;
import 'dart:convert';
import 'dart:typed_data';

import 'pocket_binary_codec.dart';

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
          borderWidth: _number(json['borderWidth'] ?? json['border_width']),
          clip: clip,
        );
      case 'arc':
        final radius = _number(json['radius']);
        final strokeWidth = _number(
          json['strokeWidth'] ?? json['borderWidth'] ?? json['border_width'],
        );
        final startAngle = _number(json['startAngle'] ?? json['start_angle']);
        final sweepAngle = _number(json['sweepAngle'] ?? json['sweep_angle']);
        if (radius < 0 ||
            strokeWidth <= 0 ||
            sweepAngle == 0 ||
            sweepAngle.abs() > 360) {
          throw const FormatException('Invalid arc geometry');
        }
        return PocketArcOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: _color(json['color']),
          radius: radius,
          strokeWidth: strokeWidth,
          startAngle: startAngle,
          sweepAngle: sweepAngle,
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
      case 'roundedGradient':
        final rawX = _requiredFiniteNumber(json['x'], 'x');
        final rawY = _requiredFiniteNumber(json['y'], 'y');
        final rawWidth = _requiredFiniteNumber(
          json['w'] ?? json['width'],
          'width',
        );
        final rawHeight = _requiredFiniteNumber(
          json['h'] ?? json['height'],
          'height',
        );
        final radius = _requiredFiniteNumber(json['radius'], 'radius');
        final rawDirection = json['direction'] ?? json['dir'];
        final rawViaColor = json['viaColor'] ?? json['via_color'];
        final rawViaPosition = json['viaPosition'] ?? json['via_position'];
        if (rawWidth <= 0 || rawHeight <= 0 || radius <= 0) {
          throw const FormatException('Invalid rounded gradient geometry');
        }
        if (rawDirection is! num ||
            !rawDirection.isFinite ||
            rawDirection.toInt().toDouble() != rawDirection.toDouble() ||
            rawDirection < 0 ||
            rawDirection > 3) {
          throw const FormatException('Invalid rounded gradient direction');
        }
        if ((rawViaColor == null) != (rawViaPosition == null)) {
          throw const FormatException(
            'Rounded gradient middle stop is incomplete',
          );
        }
        int? viaColor;
        double? viaPosition;
        if (rawViaColor != null) {
          if (rawViaColor is! num ||
              !rawViaColor.isFinite ||
              rawViaColor.toDouble() != rawViaColor.toInt().toDouble() ||
              rawViaPosition is! num ||
              !rawViaPosition.isFinite ||
              rawViaPosition <= 0 ||
              rawViaPosition >= 1) {
            throw const FormatException('Invalid rounded gradient middle stop');
          }
          viaColor = _color(rawViaColor);
          viaPosition = rawViaPosition.toDouble();
        }
        return PocketRoundedGradientOp(
          x: rawX,
          y: rawY,
          width: rawWidth,
          height: rawHeight,
          radius: radius,
          fromColor: _color(
            json['fromColor'] ?? json['from_color'] ?? json['from'],
          ),
          toColor: _color(json['toColor'] ?? json['to_color'] ?? json['to']),
          direction: rawDirection.toInt(),
          viaColor: viaColor,
          viaPosition: viaPosition,
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
        final repeatTexture = json['repeatTexture'];
        if (repeatTexture != null && repeatTexture is! bool) {
          throw const FormatException('Invalid texture triangle repeat flag');
        }
        return PocketTextureTriangleOp(
          x: x,
          y: y,
          width: width,
          height: height,
          asset: '${json['asset'] ?? ''}',
          color: _color(json['color']),
          points: _points(json['points']),
          uvs: _numbers(json['uvs']),
          repeatTexture: repeatTexture as bool? ?? false,
          clip: clip,
        );
      case 'meshLayerBegin':
        final blend = _integer(json['color']);
        final tints = _numbers(json['uvs']);
        if (blend < 0 ||
            blend > 3 ||
            tints.any((value) => value < 0 || value > 1)) {
          throw const FormatException('Invalid mesh layer parameters');
        }
        return PocketMeshLayerBeginOp(
          x: x,
          y: y,
          width: width,
          height: height,
          blend: blend,
          multiplyRgb: tints.sublist(0, 3),
          screenRgb: tints.sublist(3, 6),
          clip: clip,
        );
      case 'meshMaskBegin':
        final inverted = _integer(json['color']);
        if (inverted < 0 || inverted > 1) {
          throw const FormatException('Invalid mesh mask inversion flag');
        }
        return PocketMeshMaskBeginOp(
          x: x,
          y: y,
          width: width,
          height: height,
          inverted: inverted != 0,
          clip: clip,
        );
      case 'meshLayerRestore':
        return PocketMeshLayerRestoreOp(
          x: x,
          y: y,
          width: width,
          height: height,
          clip: clip,
        );
      case 'text':
        final fontSlot = _fontSlot(json['fontSlot']);
        final rawAlign = json['align'];
        if (rawAlign != null &&
            (rawAlign is! int || rawAlign < 0 || rawAlign > 2)) {
          throw const FormatException('Invalid text alignment');
        }
        final rawTracking = json['tracking'];
        if (rawTracking != null &&
            (rawTracking is! num || !rawTracking.isFinite)) {
          throw const FormatException('Invalid text tracking');
        }
        final rawAffine =
            json['affine'] ?? json['textAffine'] ?? json['text_affine'];
        return PocketTextOp(
          x: x,
          y: y,
          width: width,
          height: height,
          text: '${json['text'] ?? ''}',
          size: _number(json['size'], fallback: _fontSlotSize(fontSlot)),
          color: _color(json['color']),
          fontSlot: fontSlot,
          align: (rawAlign as num?)?.toInt() ?? 0,
          tracking: (rawTracking as num?)?.toDouble() ?? 0.0,
          affine: _optionalNumbers(
            rawAffine,
            expected: 4,
            fieldLabel: 'Pocket text affine',
          ),
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
          surfaceHandle: (json['surfaceHandle'] as num?)?.toInt() ?? 0,
          focused: json['focused'] == true,
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
    this.borderWidth = 0,
    super.clip,
  });

  final int color;
  final double radius;

  /// Zero paints a fill; a positive width paints an inward hollow ring.
  /// The painter clamps it to half the shortest side.
  final double borderWidth;
}

/// A screen-space stroked arc. Angles are degrees from 12 o'clock, with
/// positive sweeps moving clockwise; full sweeps are closed rings.
class PocketArcOp extends PocketOp {
  const PocketArcOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.color,
    required this.radius,
    required this.strokeWidth,
    required this.startAngle,
    required this.sweepAngle,
    super.clip,
  });

  final int color;

  /// Radius to the stroke centerline, in logical screen pixels.
  final double radius;

  final double strokeWidth;
  final double startAngle;
  final double sweepAngle;
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

class PocketRoundedGradientOp extends PocketOp {
  const PocketRoundedGradientOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.radius,
    required this.fromColor,
    required this.toColor,
    required this.direction,
    this.viaColor,
    this.viaPosition,
    super.clip,
  });

  final double radius;
  final int fromColor;
  final int toColor;
  final int direction;
  final int? viaColor;
  final double? viaPosition;
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
    required List<PocketPoint> points,
    required List<int> colors,
    super.clip,
  }) : _points = points,
       _colors = colors,
       packedPoints = null,
       packedColors = null;

  const PocketTriangleOp._packed({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required Float32List this.packedPoints,
    required Int32List this.packedColors,
    super.clip,
  }) : _points = null,
       _colors = null;

  final List<PocketPoint>? _points;
  final List<int>? _colors;

  /// Optional flat `[x0, y0, x1, y1, x2, y2]` coordinates populated by PFB1.
  final Float32List? packedPoints;

  /// Optional flat `[c0, c1, c2]` ARGB colors populated by PFB1.
  final Int32List? packedColors;

  List<PocketPoint> get points {
    final existing = _points;
    if (existing != null) return existing;
    final raw = packedPoints!;
    return List<PocketPoint>.unmodifiable(<PocketPoint>[
      PocketPoint(x: raw[0], y: raw[1]),
      PocketPoint(x: raw[2], y: raw[3]),
      PocketPoint(x: raw[4], y: raw[5]),
    ]);
  }

  List<int> get colors {
    final existing = _colors;
    if (existing != null) return existing;
    final raw = packedColors!;
    return List<int>.unmodifiable(<int>[
      raw[0] & 0xffffffff,
      raw[1] & 0xffffffff,
      raw[2] & 0xffffffff,
    ]);
  }
}

class PocketTextureTriangleOp extends PocketOp {
  const PocketTextureTriangleOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.asset,
    required this.color,
    required List<PocketPoint> points,
    required List<double> uvs,
    this.repeatTexture = false,
    super.clip,
  }) : _points = points,
       _uvs = uvs,
       packedGeometry = null;

  const PocketTextureTriangleOp._packed({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.asset,
    required this.color,
    required Float32List this.packedGeometry,
    this.repeatTexture = false,
    super.clip,
  }) : _points = null,
       _uvs = null;

  final String asset;
  final int color;
  final List<PocketPoint>? _points;
  final List<double>? _uvs;

  /// Flat 12-float slice `[x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2]`
  /// decoded directly from PFB1 without boxing intermediate objects.
  final Float32List? packedGeometry;
  final bool repeatTexture;

  int get vertexCount {
    if (packedGeometry != null) return 3;
    return _points!.length;
  }

  List<PocketPoint> get points {
    final existing = _points;
    if (existing != null) return existing;
    final g = packedGeometry!;
    return List<PocketPoint>.unmodifiable(<PocketPoint>[
      PocketPoint(x: g[0], y: g[1]),
      PocketPoint(x: g[2], y: g[3]),
      PocketPoint(x: g[4], y: g[5]),
    ]);
  }

  List<double> get uvs {
    final existing = _uvs;
    if (existing != null) return existing;
    final g = packedGeometry!;
    return List<double>.unmodifiable(<double>[
      g[6],
      g[7],
      g[8],
      g[9],
      g[10],
      g[11],
    ]);
  }
}

/// Begins an isolated Live2D mesh group. RGB tints apply to its target meshes;
/// blend is one of 0 normal, 1 add, 2 multiply or 3 screen.
class PocketMeshLayerBeginOp extends PocketOp {
  const PocketMeshLayerBeginOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.blend,
    required this.multiplyRgb,
    required this.screenRgb,
    super.clip,
  });

  final int blend;
  final List<double> multiplyRgb;
  final List<double> screenRgb;
}

/// Starts a mask pass composited onto the active mesh layer.
class PocketMeshMaskBeginOp extends PocketOp {
  const PocketMeshMaskBeginOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    required this.inverted,
    super.clip,
  });

  final bool inverted;
}

/// Closes the optional mask pass and its enclosing mesh layer.
class PocketMeshLayerRestoreOp extends PocketOp {
  const PocketMeshLayerRestoreOp({
    required super.x,
    required super.y,
    required super.width,
    required super.height,
    super.clip,
  });
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
    this.align = 0,
    this.tracking = 0.0,
    this.affine,
    super.clip,
  });

  final String text;
  final double size;
  final int color;
  final int? fontSlot;

  /// PocketJS TextAlign: 0 left, 1 center, 2 right; never rewrap native lines.
  final int align;

  /// Additional per-glyph tracking in logical pixels.
  final double tracking;

  /// Optional 2x2 linear transform `[a, b, c, d]` anchored at `(x, y)`.
  final List<double>? affine;
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
    this.wireByteLength,
  });

  final String id;
  final String method;
  final Map<String, dynamic> params;
  final int? wireByteLength;

  factory PocketEvent.fromJson(
    Map<String, dynamic> json, {
    int? wireByteLength,
  }) {
    final rawParams = json['params'] ?? json['payload'];
    return PocketEvent(
      id: '${json['id'] ?? ''}',
      method: '${json['method'] ?? json['name'] ?? ''}',
      params: rawParams is Map
          ? Map<String, dynamic>.from(rawParams)
          : <String, dynamic>{},
      wireByteLength: wireByteLength,
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
    this.sequence,
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
      sequence: null,
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
    // Native JSON frames historically called this field `frame`; newer
    // transports use the protocol-neutral `sequence`. Accept both so a
    // frame decoded from the legacy ABI can seed the v2 delta baseline.
    final sequence = _optionalSequence(json['sequence'] ?? json['frame']);
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
      sequence: sequence,
    );
  }

  /// Decodes the compact native frame ABI (PFB1). The format is deliberately
  /// typed: draw geometry and image pixels never pass through JSON maps or
  /// decimal byte arrays. Events and host surface parameters use binary TLV
  /// objects, including their open-ended fields.
  factory PocketFrame.fromBinary(Uint8List source) {
    final reader = _PocketBinaryReader(source);
    if (reader.u32() != 0x31424650) {
      throw const FormatException('Invalid Pocket binary frame magic');
    }
    final version = reader.u16();
    final flags = reader.u16();
    if (flags & ~3 != 0) {
      throw FormatException('Unsupported Pocket binary frame flags: $flags');
    }
    if (version < 1 || version > 6) {
      throw FormatException(
        'Unsupported Pocket binary frame version: $version',
      );
    }
    final sequence = reader.u64();
    final width = reader.f32();
    final height = reader.f32();
    final ops = _binaryOps(reader, reader.count('ops'), flags, version);
    final eventCount = reader.count('events');
    final List<PocketEvent> events;
    if (eventCount == 0) {
      events = const <PocketEvent>[];
    } else {
      final list = <PocketEvent>[];
      for (var index = 0; index < eventCount; index++) {
        final payload = reader.bytes('event', copy: false);
        list.add(PocketBinaryCodec.decodeEvent(payload));
      }
      events = UnmodifiableListView<PocketEvent>(list);
    }
    final resourceCount = reader.count('resources');
    final List<PocketImageResource> resources;
    if (resourceCount == 0) {
      resources = const <PocketImageResource>[];
    } else {
      final list = <PocketImageResource>[];
      for (var index = 0; index < resourceCount; index++) {
        final asset = reader.string('resource asset');
        final revision = reader.u64();
        final resourceWidth = reader.u32();
        final resourceHeight = reader.u32();
        final psm = reader.u32();
        final linear = reader.u8() != 0;
        final pixels = reader.bytes('resource pixels');
        final palette = reader.u8() == 0
            ? null
            : reader.bytes('resource palette');
        list.add(
          PocketImageResource(
            asset: asset,
            revision: revision,
            width: resourceWidth,
            height: resourceHeight,
            psm: psm,
            linear: linear,
            pixels: pixels,
            palette: palette,
          ),
        );
      }
      resources = UnmodifiableListView<PocketImageResource>(list);
    }
    final releasedCount = reader.count('released resources');
    final List<String> releasedResources;
    if (releasedCount == 0) {
      releasedResources = const <String>[];
    } else {
      final list = <String>[];
      for (var index = 0; index < releasedCount; index++) {
        list.add(reader.string('released resource'));
      }
      releasedResources = UnmodifiableListView<String>(list);
    }
    PocketSurfaceFrame? auxiliary;
    if (reader.u8() != 0) {
      auxiliary = PocketSurfaceFrame(
        width: reader.f32(),
        height: reader.f32(),
        ops: _binaryOps(reader, reader.count('auxiliary ops'), flags, version),
      );
    }
    reader.finish();
    return PocketFrame(
      width: width,
      height: height,
      ops: ops,
      events: events,
      resources: resources,
      releasedResources: releasedResources,
      auxiliary: auxiliary,
      sequence: sequence,
    );
  }

  final double width;
  final double height;
  final List<PocketOp> ops;
  final List<PocketEvent> events;
  final List<PocketImageResource> resources;
  final List<String> releasedResources;
  final PocketSurfaceFrame? auxiliary;

  /// Native frame sequence used to validate incremental DrawList deltas.
  ///
  /// Source-only/injected runtimes may omit the field, so it remains nullable
  /// for source compatibility with callers that construct [PocketFrame]
  /// directly. Native PFB1 frames always carry a sequence.
  final int? sequence;
}

const PocketOp _dummyOp = PocketMeshLayerRestoreOp(
  x: 0,
  y: 0,
  width: 0,
  height: 0,
);

List<PocketOp> _binaryOps(
  _PocketBinaryReader reader,
  int count,
  int flags,
  int version,
) {
  if (count == 0) return const <PocketOp>[];
  // Every PFB1 op has at least a 33-byte header before kind-specific fields.
  if (count * 33 > reader.remaining) {
    throw const FormatException(
      'Pocket binary frame truncated while reading ops',
    );
  }
  final result = List<PocketOp>.filled(count, _dummyOp, growable: false);
  PocketClip? lastClip;
  for (var index = 0; index < count; index++) {
    final type = reader.u8();
    final x = reader.f32();
    final y = reader.f32();
    final width = reader.f32();
    final height = reader.f32();
    final cx = reader.f32();
    final cy = reader.f32();
    final cw = reader.f32();
    final ch = reader.f32();
    final PocketClip clip;
    if (lastClip != null &&
        lastClip.x == cx &&
        lastClip.y == cy &&
        lastClip.width == cw &&
        lastClip.height == ch) {
      clip = lastClip;
    } else {
      clip = PocketClip(x: cx, y: cy, width: cw, height: ch);
      lastClip = clip;
    }
    switch (type) {
      case 0:
        result[index] = PocketRectOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: reader.u32(),
          clip: clip,
        );
      case 1:
        result[index] = PocketRoundedOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: reader.u32(),
          radius: reader.f32(),
          borderWidth: 0,
          clip: clip,
        );
      case 15:
        if (version < 3) {
          throw const FormatException(
            'Rounded rectangle rings require Pocket frame version 3',
          );
        }
        final color = reader.u32();
        final radius = reader.f32();
        final borderWidth = reader.f32();
        if (!radius.isFinite ||
            radius < 0 ||
            !borderWidth.isFinite ||
            borderWidth <= 0) {
          throw const FormatException(
            'Invalid rounded rectangle ring geometry',
          );
        }
        result[index] = PocketRoundedOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: color,
          radius: radius,
          borderWidth: borderWidth,
          clip: clip,
        );
      case 16:
        if (version < 4) {
          throw const FormatException(
            'Native arcs require Pocket frame version 4',
          );
        }
        final color = reader.u32();
        final radius = reader.f32();
        final strokeWidth = reader.f32();
        final startAngle = reader.f32();
        final sweepAngle = reader.f32();
        if (!radius.isFinite ||
            radius < 0 ||
            !strokeWidth.isFinite ||
            strokeWidth <= 0 ||
            !startAngle.isFinite ||
            !sweepAngle.isFinite ||
            sweepAngle == 0 ||
            sweepAngle.abs() > 360) {
          throw const FormatException('Invalid native arc geometry');
        }
        result[index] = PocketArcOp(
          x: x,
          y: y,
          width: width,
          height: height,
          color: color,
          radius: radius,
          strokeWidth: strokeWidth,
          startAngle: startAngle,
          sweepAngle: sweepAngle,
          clip: clip,
        );
      case 17:
        if (version < 5) {
          throw const FormatException(
            'Rounded gradients require Pocket frame version 5',
          );
        }
        final fromColor = reader.u32();
        final toColor = reader.u32();
        final direction = reader.u32();
        final radius = reader.f32();
        final hasVia = reader.u8();
        if (hasVia > 1) {
          throw const FormatException(
            'Invalid rounded gradient middle stop flag',
          );
        }
        final viaColor = hasVia == 1 ? reader.u32() : null;
        final viaPosition = hasVia == 1 ? reader.f32() : null;
        if (width <= 0 ||
            height <= 0 ||
            !radius.isFinite ||
            radius <= 0 ||
            direction > 3 ||
            (viaPosition != null && (viaPosition <= 0 || viaPosition >= 1))) {
          throw const FormatException(
            'Invalid rounded gradient geometry or stops',
          );
        }
        result[index] = PocketRoundedGradientOp(
          x: x,
          y: y,
          width: width,
          height: height,
          radius: radius,
          fromColor: fromColor,
          toColor: toColor,
          direction: direction,
          viaColor: viaColor,
          viaPosition: viaPosition,
          clip: clip,
        );
      case 2:
        result[index] = PocketGradientOp(
          x: x,
          y: y,
          width: width,
          height: height,
          fromColor: reader.u32(),
          toColor: reader.u32(),
          direction: reader.u32(),
          clip: clip,
        );
      case 3:
        final packedPts = Float32List(6);
        for (var i = 0; i < 6; i++) {
          packedPts[i] = reader.f32();
        }
        final packedCols = Int32List(3);
        packedCols[0] = reader.u32();
        packedCols[1] = reader.u32();
        packedCols[2] = reader.u32();
        result[index] = PocketTriangleOp._packed(
          x: x,
          y: y,
          width: width,
          height: height,
          packedPoints: packedPts,
          packedColors: packedCols,
          clip: clip,
        );
      case 4 || 14:
        if (type == 14 && version < 2) {
          throw const FormatException(
            'Repeated texture triangles require Pocket frame version 2',
          );
        }
        final asset = reader.assetString('texture triangle asset');
        final color = reader.u32();
        final geom = Float32List(12);
        for (var i = 0; i < 12; i++) {
          geom[i] = reader.f32();
        }
        result[index] = PocketTextureTriangleOp._packed(
          x: x,
          y: y,
          width: width,
          height: height,
          asset: asset,
          color: color,
          packedGeometry: geom,
          repeatTexture: type == 14,
          clip: clip,
        );
      case 5:
        final text = reader.string('text');
        final size = reader.f32();
        final color = reader.u32();
        final fontSlot = reader.u8() == 0 ? null : reader.u8();
        final align = flags & 1 == 0 ? 0 : reader.u8();
        if (align > 2) throw const FormatException('Invalid text alignment');
        result[index] = PocketTextOp(
          x: x,
          y: y,
          width: width,
          height: height,
          text: text,
          size: size,
          color: color,
          fontSlot: fontSlot,
          align: align,
          clip: clip,
        );
      case 18:
        if (version < 6) {
          throw const FormatException(
            'Extended text runs require Pocket frame version 6',
          );
        }
        final text = reader.string('text');
        final size = reader.f32();
        final color = reader.u32();
        final fontSlot = reader.u8() == 0 ? null : reader.u8();
        final align = flags & 1 == 0 ? 0 : reader.u8();
        if (align > 2) throw const FormatException('Invalid text alignment');
        final extFlags = reader.u8();
        if (extFlags & ~0x03 != 0) {
          throw FormatException('Invalid extended text flags: $extFlags');
        }
        final tracking = (extFlags & 0x01) != 0 ? reader.f32() : 0.0;
        final affine = (extFlags & 0x02) == 0
            ? null
            : List<double>.unmodifiable(<double>[
                reader.f32(),
                reader.f32(),
                reader.f32(),
                reader.f32(),
              ]);
        result[index] = PocketTextOp(
          x: x,
          y: y,
          width: width,
          height: height,
          text: text,
          size: size,
          color: color,
          fontSlot: fontSlot,
          align: align,
          tracking: tracking,
          affine: affine,
          clip: clip,
        );
      case 6:
        final asset = reader.assetString('image asset');
        final uv = reader.u8() == 0
            ? null
            : <double>[reader.f32(), reader.f32(), reader.f32(), reader.f32()];
        final tint = reader.u8() == 0 ? null : reader.u32();
        result[index] = PocketImageOp(
          x: x,
          y: y,
          width: width,
          height: height,
          asset: asset,
          uv: uv,
          tint: tint,
          clip: clip,
        );
      case 7:
        final id = reader.string('surface id');
        if (flags & 2 == 0) {
          throw const FormatException(
            'Pocket host surfaces require typed descriptors; rebuild the native SDK',
          );
        }
        final kind = reader.string('surface kind');
        final parameters = PocketBinaryCodec.decodeMessage(
          reader.bytes('surface parameters', copy: false),
        );
        final surfaceHandle = flags & 1 == 0 ? 0 : (reader.u32().toSigned(32));
        final focused = flags & 1 != 0 && reader.u8() != 0;
        result[index] = PocketHostSurfaceOp(
          x: x,
          y: y,
          width: width,
          height: height,
          clip: clip,
          id: id,
          surfaceHandle: surfaceHandle,
          focused: focused,
          kind: kind,
          parameters: parameters,
        );
      case 8:
        final id = reader.string('video id');
        final asset = reader.assetString('video asset');
        final fit = switch (reader.u8()) {
          1 => 'contain',
          2 => 'fill',
          _ => 'cover',
        };
        final autoplay = reader.u8() != 0;
        result[index] = PocketVideoOp(
          x: x,
          y: y,
          width: width,
          height: height,
          id: id,
          asset: asset,
          autoplay: autoplay,
          fit: fit,
          clip: clip,
        );
      case 9:
        if (version < 2) {
          throw const FormatException('Mesh effects require PFB1 version 2');
        }
        final blend = reader.u32();
        final tints = <double>[
          reader.f32(),
          reader.f32(),
          reader.f32(),
          reader.f32(),
          reader.f32(),
          reader.f32(),
        ];
        if (blend > 3 || tints.any((value) => value < 0 || value > 1)) {
          throw const FormatException('Invalid mesh layer parameters');
        }
        result[index] = PocketMeshLayerBeginOp(
          x: x,
          y: y,
          width: width,
          height: height,
          blend: blend,
          multiplyRgb: tints.sublist(0, 3),
          screenRgb: tints.sublist(3, 6),
          clip: clip,
        );
      case 10:
        if (version < 2) {
          throw const FormatException('Mesh effects require PFB1 version 2');
        }
        final inverted = reader.u8();
        if (inverted > 1) {
          throw const FormatException('Invalid mesh mask inversion flag');
        }
        result[index] = PocketMeshMaskBeginOp(
          x: x,
          y: y,
          width: width,
          height: height,
          inverted: inverted != 0,
          clip: clip,
        );
      case 11:
        if (version < 2) {
          throw const FormatException('Mesh effects require PFB1 version 2');
        }
        result[index] = PocketMeshLayerRestoreOp(
          x: x,
          y: y,
          width: width,
          height: height,
          clip: clip,
        );
      default:
        throw FormatException('Unknown Pocket binary operation type: $type');
    }
  }
  return UnmodifiableListView<PocketOp>(result);
}

final class _PocketBinaryReader {
  _PocketBinaryReader(this.data) : view = ByteData.sublistView(data);

  final Uint8List data;
  // One bounded view per frame, rather than one view per scalar read.
  final ByteData view;
  var offset = 0;

  int _lastAssetStart = -1;
  int _lastAssetLength = -1;
  String _lastAssetString = '';

  int get remaining => data.length - offset;

  void _require(int length, String field) {
    if (length < 0 || length > remaining) {
      throw FormatException(
        'Pocket binary frame truncated while reading $field',
      );
    }
  }

  int u8() {
    _require(1, 'u8');
    return data[offset++];
  }

  int u16() {
    _require(2, 'u16');
    final value = view.getUint16(offset, Endian.little);
    offset += 2;
    return value;
  }

  int u32() {
    _require(4, 'u32');
    final value = view.getUint32(offset, Endian.little);
    offset += 4;
    return value;
  }

  int u64() {
    _require(8, 'u64');
    final value = view.getUint64(offset, Endian.little);
    offset += 8;
    return value;
  }

  double f32() {
    _require(4, 'f32');
    final value = view.getFloat32(offset, Endian.little);
    offset += 4;
    if (!value.isFinite)
      throw const FormatException('Pocket binary float is not finite');
    return value;
  }

  int count(String field) {
    final value = u32();
    if (value > 1 << 20)
      throw FormatException('Pocket binary $field count is too large');
    return value;
  }

  Uint8List bytes(String field, {bool copy = true}) {
    final length = u32();
    _require(length, field);
    final slice = Uint8List.sublistView(data, offset, offset + length);
    offset += length;
    return copy ? Uint8List.fromList(slice) : slice;
  }

  String string(String field) {
    final length = u32();
    _require(length, field);
    if (length == 0) return '';
    final start = offset;
    final end = start + length;
    offset = end;
    return _decodeStringSlice(start, end);
  }

  /// Fast-path decoder for repeated asset keys (e.g. hundreds of mesh triangles
  /// or glyph quads referencing the exact same texture name).
  String assetString(String field) {
    final length = u32();
    _require(length, field);
    if (length == 0) return '';
    final start = offset;
    final end = start + length;
    offset = end;
    if (length == _lastAssetLength && _lastAssetStart >= 0) {
      var same = true;
      final prev = _lastAssetStart;
      for (var i = 0; i < length; i++) {
        if (data[start + i] != data[prev + i]) {
          same = false;
          break;
        }
      }
      if (same) return _lastAssetString;
    }
    final decoded = _decodeStringSlice(start, end);
    _lastAssetStart = start;
    _lastAssetLength = length;
    _lastAssetString = decoded;
    return decoded;
  }

  String _decodeStringSlice(int start, int end) {
    for (var i = start; i < end; i++) {
      if (data[i] >= 0x80) {
        return utf8.decode(Uint8List.sublistView(data, start, end));
      }
    }
    return String.fromCharCodes(data, start, end);
  }

  void finish() {
    if (offset != data.length) {
      throw const FormatException('Pocket binary frame has trailing bytes');
    }
  }
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

double _requiredFiniteNumber(Object? value, String field) {
  if (value is! num || !value.isFinite) {
    throw FormatException('Pocket rounded gradient $field must be finite');
  }
  return value.toDouble();
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

int? _optionalSequence(Object? value) {
  if (value == null) return null;
  if (value is! num ||
      !value.isFinite ||
      value < 0 ||
      value.toDouble() != value.toInt().toDouble()) {
    throw const FormatException('Pocket frame sequence must be a uint64');
  }
  return value.toInt();
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

List<double>? _optionalNumbers(
  Object? value, {
  required int expected,
  String fieldLabel = 'Pocket image UVs',
}) {
  if (value == null) return null;
  if (value is! List || value.length != expected) {
    throw FormatException('$fieldLabel must have $expected values');
  }
  final numbers = value.map((item) => _number(item, fallback: double.nan));
  final result = List<double>.unmodifiable(numbers);
  if (result.any((number) => !number.isFinite)) {
    throw FormatException('$fieldLabel must be finite');
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
    this.surfaceHandle = 0,
    this.focused = false,
  });
  final int surfaceHandle;
  final bool focused;
  final String id;
  final String kind;
  final Map<String, dynamic> parameters;
}
