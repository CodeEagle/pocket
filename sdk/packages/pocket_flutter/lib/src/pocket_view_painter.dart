part of 'pocket_view.dart';

const int _pocketMeshSupersampleScale = int.fromEnvironment(
  'POCKET_MESH_SUPERSAMPLE',
  defaultValue: 1,
);

final class _PocketGestureRegion {
  const _PocketGestureRegion({
    required this.id,
    required this.surface,
    required this.rect,
    required this.axis,
  });

  final String id;
  final int surface;
  final Rect rect;
  final String axis;

  static _PocketGestureRegion? fromJson(Map<String, dynamic> json) {
    final rawRect = json['rect'];
    final rawSurface = json['surface'];
    final id = json['id'];
    final axis = json['axis'];
    if (rawRect is! Map ||
        rawSurface is! num ||
        id is! String ||
        id.isEmpty ||
        axis != 'x' && axis != 'y' && axis != 'any') {
      return null;
    }
    final rect = Map<String, dynamic>.from(rawRect);
    final x = rect['x'];
    final y = rect['y'];
    final width = rect['width'];
    final height = rect['height'];
    if (x is! num ||
        y is! num ||
        width is! num ||
        height is! num ||
        !x.isFinite ||
        !y.isFinite ||
        !width.isFinite ||
        !height.isFinite ||
        width <= 0 ||
        height <= 0) {
      return null;
    }
    final surface = rawSurface.toInt();
    if (surface != 0 && surface != 1) return null;
    return _PocketGestureRegion(
      id: id,
      surface: surface,
      rect: Rect.fromLTWH(
        x.toDouble(),
        y.toDouble(),
        width.toDouble(),
        height.toDouble(),
      ),
      axis: axis as String,
    );
  }

  bool accepts(Offset point, Offset travel) {
    if (!rect.contains(point)) return false;
    if (axis == 'any') return true;
    final dx = travel.dx.abs();
    final dy = travel.dy.abs();
    return axis == 'x' ? dx >= dy : dy >= dx;
  }
}

typedef _PocketSurfacePointerHandler =
    bool Function(String phase, PointerEvent event);
typedef _PocketSurfaceGestureProbe =
    bool Function(int pointer, Offset localPosition, Offset travel);

final class _PocketGestureSequence {
  _PocketGestureSequence(this.startPosition, this.startLocalPosition);

  final Offset startPosition;
  final Offset startLocalPosition;
  PointerEvent? lastEvent;
  bool forwarded = false;
  bool arenaResolved = false;
  bool hostRejected = false;
  bool probed = false;
  bool held = false;
}

/// Defers a surface's arena decision until the guest has declared ownership
/// for the down point. The recognizer is generic: it never knows a component
/// or screen rectangle, only the logical region table emitted by PocketJS.
final class _PocketSurfaceGestureRecognizer
    extends OneSequenceGestureRecognizer {
  _PocketSurfaceGestureRecognizer({
    required this.surface,
    required this.size,
    required this.onPointer,
    required this.onProbe,
  });

  final int surface;
  final Size size;
  final _PocketSurfacePointerHandler onPointer;
  final _PocketSurfaceGestureProbe onProbe;
  final Map<int, _PocketGestureSequence> _sequences =
      <int, _PocketGestureSequence>{};

  @override
  String get debugDescription => 'PocketJS surface gesture';

  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event);
    final sequence = _PocketGestureSequence(
      event.position,
      event.localPosition,
    );
    sequence.lastEvent = event;
    _sequences[event.pointer] = sequence;
    GestureBinding.instance.gestureArena.hold(event.pointer);
    sequence.held = true;
    sequence.forwarded = onPointer('down', event);
    if (!sequence.forwarded) {
      _rejectHost(event.pointer);
    } else if (onProbe(event.pointer, event.localPosition, Offset.zero)) {
      // A declared guest region owns the contact from down. Holding an arena
      // cannot postpone an ancestor's explicit acceptance on its first move.
      _acceptGuest(event.pointer);
    }
  }

  @override
  void handleEvent(PointerEvent event) {
    final sequence = _sequences[event.pointer];
    if (sequence == null) return;
    sequence.lastEvent = event;

    if (event is PointerMoveEvent) {
      if (sequence.hostRejected || !sequence.forwarded) return;
      final inside =
          event.localPosition.dx >= 0 &&
          event.localPosition.dx <= size.width &&
          event.localPosition.dy >= 0 &&
          event.localPosition.dy <= size.height;
      final sent = onPointer('move', event);
      if (!inside) {
        sequence.forwarded = false;
        _rejectHost(event.pointer);
        return;
      }
      if (!sent) {
        sequence.forwarded = false;
        _rejectHost(event.pointer);
        return;
      }
      if (!sequence.probed &&
          (event.position - sequence.startPosition).distance > kTouchSlop) {
        sequence.probed = true;
        final guestOwns = onProbe(
          event.pointer,
          sequence.startLocalPosition,
          event.position - sequence.startPosition,
        );
        if (guestOwns) {
          _acceptGuest(event.pointer);
        } else {
          // Cancel the JS contact before releasing the arena to the ancestor
          // Scrollable. This is the handoff that prevents double scrolling.
          onPointer('cancel', event);
          sequence.forwarded = false;
          _rejectHost(event.pointer);
        }
      }
      return;
    }

    if (event is PointerUpEvent) {
      if (!sequence.hostRejected && sequence.forwarded) {
        onPointer('up', event);
        if (!sequence.arenaResolved) _acceptGuest(event.pointer);
      }
      stopTrackingPointer(event.pointer);
      return;
    }

    if (event is PointerCancelEvent) {
      if (sequence.forwarded) onPointer('cancel', event);
      if (!sequence.hostRejected) _rejectHost(event.pointer);
      stopTrackingPointer(event.pointer);
    }
  }

  void _acceptGuest(int pointer) {
    final sequence = _sequences[pointer];
    if (sequence == null || sequence.arenaResolved) return;
    sequence.arenaResolved = true;
    resolvePointer(pointer, GestureDisposition.accepted);
    if (sequence.held) {
      sequence.held = false;
      GestureBinding.instance.gestureArena.release(pointer);
    }
  }

  void _rejectHost(int pointer) {
    final sequence = _sequences[pointer];
    if (sequence == null || sequence.arenaResolved) return;
    sequence.arenaResolved = true;
    sequence.hostRejected = true;
    resolvePointer(pointer, GestureDisposition.rejected);
    if (sequence.held) {
      sequence.held = false;
      GestureBinding.instance.gestureArena.release(pointer);
    }
  }

  @override
  void acceptGesture(int pointer) {}

  @override
  void rejectGesture(int pointer) {
    final sequence = _sequences[pointer];
    if (sequence != null && sequence.forwarded) {
      onPointer('cancel', sequence.lastEvent!);
      sequence.forwarded = false;
    }
    if (sequence != null) {
      sequence.hostRejected = true;
      sequence.arenaResolved = true;
      if (sequence.held) {
        sequence.held = false;
        GestureBinding.instance.gestureArena.release(pointer);
      }
    } else {
      GestureBinding.instance.gestureArena.release(pointer);
    }
  }

  @override
  void dispose() {
    for (final entry in _sequences.entries.toList(growable: false)) {
      final sequence = entry.value;
      if (sequence.forwarded && sequence.lastEvent != null) {
        onPointer('cancel', sequence.lastEvent!);
      }
      if (sequence.held) {
        sequence.held = false;
        GestureBinding.instance.gestureArena.release(entry.key);
      }
    }
    _sequences.clear();
    super.dispose();
  }

  @override
  void didStopTrackingLastPointer(int pointer) {
    _sequences.remove(pointer);
  }
}

/// Paints the non-video portion of a PocketJS frame onto a Flutter canvas.
///
/// Video ops remain sibling texture widgets in [PocketView], while this
/// painter keeps every Canvas op in the frame's original order. Exposing the
/// painter also lets host tests render a frame through the same code path
/// without starting a runtime ticker.
final class PocketCanvasPainter extends CustomPainter {
  PocketCanvasPainter({
    required this.width,
    required this.height,
    required this.ops,
    required this.images,
    this.meshImageLevels = const <String, List<ui.Image>>{},
    this.renderedSize,
    this.devicePixelRatio = 1,
    this.fontFamilyFallback = const <String>[],
    this.textLayoutCache,
    this.onPaintMicroseconds,
  }) : _imageIdentities = _pocketImageIdentities(ops, images),
       _meshLevelIdentities = _pocketMeshLevelIdentities(ops, meshImageLevels);

  final double width;
  final double height;
  final List<PocketOp> ops;
  final Map<String, ui.Image> images;

  /// Resource-owned, descending-resolution variants for mesh minification.
  /// Ordinary image ops always retain the original decoded image.
  final Map<String, List<ui.Image>> meshImageLevels;
  final Map<String, List<ui.Image>> _meshLevelIdentities;
  final Size? renderedSize;

  /// Device pixels per Flutter logical pixel at the canvas surface. Image
  /// quads are snapped against this grid after the logical surface scale is
  /// applied. Keeping this explicit is important on fractional-DPR devices:
  /// snapping only to the guest/logical grid still leaves a half-device-pixel
  /// edge and the filtered tile sampler can expose a dark seam.
  final double devicePixelRatio;
  final List<String> fontFamilyFallback;

  /// View-owned painters share one bounded cache across retained blocks. Tests
  /// may omit it to exercise the original one-shot TextPainter path without
  /// creating a process-global cache.
  final PocketTextLayoutCache? textLayoutCache;

  /// Optional per-paint attribution sink supplied by [PocketView] only when
  /// performance sampling is enabled.
  final ValueSetter<int>? onPaintMicroseconds;
  // The render map is intentionally shared so an image upload can become
  // visible without rebuilding every op object. Keep only identities used by
  // this block as an immutable snapshot for visual equality checks.
  final Map<String, ui.Image?> _imageIdentities;

  /// A stable diagnostic counter used by widget tests and profiling builds.
  /// It counts actual [paint] calls, not frame/ticker callbacks. A retained
  /// static segment therefore does not increment it on every unchanged frame.
  static int paintInvocationCount = 0;
  static int drawOpInvocationCount = 0;
  static int textureTriangleBatchDrawCount = 0;

  static void resetPaintInvocationCount() {
    paintInvocationCount = 0;
    drawOpInvocationCount = 0;
    textureTriangleBatchDrawCount = 0;
  }

  @override
  void paint(Canvas canvas, Size size) {
    _paintWithDevicePixelRatio(canvas, size, devicePixelRatio);
  }

  void _paintWithDevicePixelRatio(
    Canvas canvas,
    Size size,
    double paintDevicePixelRatio,
  ) {
    final paintCallback = onPaintMicroseconds;
    final stopwatch = paintCallback == null ? null : (Stopwatch()..start());
    try {
      developer.Timeline.timeSync(
        'pocket.paint',
        () =>
            _paintWithDevicePixelRatioBody(canvas, size, paintDevicePixelRatio),
      );
    } finally {
      if (stopwatch != null) {
        stopwatch.stop();
        paintCallback!(stopwatch.elapsedMicroseconds);
      }
    }
  }

  void _paintWithDevicePixelRatioBody(
    Canvas canvas,
    Size size,
    double paintDevicePixelRatio,
  ) {
    paintInvocationCount++;
    if (width <= 0 || height <= 0) return;
    final sx = size.width / width;
    final sy = size.height / height;
    final pixelScale =
        (sx * sy).abs() * paintDevicePixelRatio * paintDevicePixelRatio;
    canvas.save();
    canvas.scale(sx, sy);

    final rectPaint = Paint()..isAntiAlias = false;
    final shapePaint = Paint()..isAntiAlias = true;
    final strokePaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..isAntiAlias = true;
    final shaderPaint = Paint();
    final verticesPaint = Paint();
    final imagePaint = Paint()..filterQuality = FilterQuality.low;

    PocketClip? activeClip;
    var clipSaveOpen = false;
    void closeActiveClip() {
      if (clipSaveOpen) {
        canvas.restore();
        clipSaveOpen = false;
        activeClip = null;
      }
    }

    void syncClip(PocketClip? nextClip) {
      if (_samePocketClip(activeClip, nextClip)) return;
      if (clipSaveOpen) {
        canvas.restore();
        clipSaveOpen = false;
      }
      activeClip = nextClip;
      if (nextClip != null) {
        canvas.save();
        canvas.clipRect(
          Rect.fromLTWH(nextClip.x, nextClip.y, nextClip.width, nextClip.height),
          doAntiAlias: false,
        );
        clipSaveOpen = true;
      }
    }

    PocketMeshLayerBeginOp? meshLayer;
    var meshMaskActive = false;
    var index = 0;
    while (index < ops.length) {
      final op = ops[index];
      drawOpInvocationCount++;
      if (op is PocketMeshLayerBeginOp) {
        if (meshLayer == null) {
          closeActiveClip();
          meshLayer = op;
          canvas.save();
          _clipPocketOp(canvas, op);
          canvas.saveLayer(
            Rect.fromLTWH(op.x, op.y, op.width, op.height),
            Paint()..blendMode = _pocketMeshBlendMode(op.blend),
          );
        }
        index++;
        continue;
      }
      if (op is PocketMeshMaskBeginOp) {
        if (meshLayer != null && !meshMaskActive) {
          closeActiveClip();
          meshMaskActive = true;
          canvas.save();
          _clipPocketOp(canvas, op);
          canvas.saveLayer(
            Rect.fromLTWH(op.x, op.y, op.width, op.height),
            Paint()
              ..blendMode = op.inverted ? BlendMode.dstOut : BlendMode.dstIn,
          );
        }
        index++;
        continue;
      }
      if (op is PocketMeshLayerRestoreOp) {
        if (meshLayer != null) {
          closeActiveClip();
          if (meshMaskActive) {
            canvas.restore();
            canvas.restore();
            meshMaskActive = false;
          }
          canvas.restore();
          canvas.restore();
          meshLayer = null;
        }
        index++;
        continue;
      }
      if (op is PocketHostSurfaceOp || op is PocketVideoOp) {
        index++;
        continue;
      }
      syncClip(op.clip);
      if (op is PocketTextureTriangleOp) {
        final next = _drawTextureTriangleBatch(
          canvas,
          index,
          image: images[op.asset],
          pixelScale: pixelScale,
          layer: meshMaskActive ? null : meshLayer,
        );
        index = next;
        continue;
      }
      final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      switch (op) {
        case PocketHostSurfaceOp():
        case PocketVideoOp():
        case PocketTextureTriangleOp():
        case PocketMeshLayerBeginOp():
        case PocketMeshMaskBeginOp():
        case PocketMeshLayerRestoreOp():
          break;
        case PocketRectOp():
          rectPaint.color = Color(op.color);
          canvas.drawRect(
            _pocketPixelAlignedRect(
              rect,
              sx: sx,
              sy: sy,
              devicePixelRatio: paintDevicePixelRatio,
            ),
            rectPaint,
          );
        case PocketRoundedOp():
          final radius = op.radius.clamp(0.0, rect.shortestSide / 2).toDouble();
          final outer = RRect.fromRectAndRadius(rect, Radius.circular(radius));
          final borderWidth = op.borderWidth
              .clamp(0.0, rect.shortestSide / 2)
              .toDouble();
          shapePaint.color = Color(op.color);
          if (borderWidth == 0.0) {
            canvas.drawRRect(outer, shapePaint);
          } else {
            final innerRect = rect.deflate(borderWidth);
            if (innerRect.width <= 0 || innerRect.height <= 0) {
              canvas.drawRRect(outer, shapePaint);
            } else {
              final innerRadius = (radius - borderWidth)
                  .clamp(0.0, innerRect.shortestSide / 2)
                  .toDouble();
              final inner = RRect.fromRectAndRadius(
                innerRect,
                Radius.circular(innerRadius),
              );
              canvas.drawDRRect(outer, inner, shapePaint);
            }
          }
        case PocketArcOp():
          strokePaint
            ..color = Color(op.color)
            ..strokeWidth = op.strokeWidth;
          if (op.sweepAngle.abs() >= 360.0) {
            canvas.drawCircle(rect.center, op.radius, strokePaint);
          } else {
            final oval = Rect.fromCircle(
              center: rect.center,
              radius: op.radius,
            );
            final start = (op.startAngle - 90.0) * math.pi / 180.0;
            final sweep = op.sweepAngle * math.pi / 180.0;
            canvas.drawArc(oval, start, sweep, false, strokePaint);
          }
        case PocketGradientOp():
          final (begin, end) = _gradientAlignment(op.direction);
          final shader = LinearGradient(
            begin: begin,
            end: end,
            colors: <Color>[Color(op.fromColor), Color(op.toColor)],
          ).createShader(rect);
          shaderPaint.shader = shader;
          canvas.drawRect(rect, shaderPaint);
        case PocketRoundedGradientOp():
          final (begin, end) = _gradientAlignment(op.direction);
          final colors = op.viaColor == null
              ? <Color>[Color(op.fromColor), Color(op.toColor)]
              : <Color>[
                  Color(op.fromColor),
                  Color(op.viaColor!),
                  Color(op.toColor),
                ];
          final stops = op.viaPosition == null
              ? null
              : <double>[0, op.viaPosition!, 1];
          final shader = LinearGradient(
            begin: begin,
            end: end,
            colors: colors,
            stops: stops,
          ).createShader(rect);
          final radius = op.radius.clamp(0.0, rect.shortestSide / 2).toDouble();
          final roundedRect = RRect.fromRectAndRadius(
            rect,
            Radius.circular(radius),
          );
          shaderPaint.shader = shader;
          canvas.drawRRect(roundedRect, shaderPaint);
        case PocketTriangleOp():
          final packedPts = op.packedPoints;
          final packedCols = op.packedColors;
          final ui.Vertices vertices;
          if (packedPts != null && packedCols != null) {
            vertices = ui.Vertices.raw(
              ui.VertexMode.triangles,
              packedPts,
              colors: packedCols,
            );
          } else {
            final pts = op.points;
            final cols = op.colors;
            final rawPts = Float32List(pts.length * 2);
            final rawCols = Int32List(cols.length);
            for (var i = 0; i < pts.length; i++) {
              rawPts[i * 2] = pts[i].x;
              rawPts[i * 2 + 1] = pts[i].y;
              rawCols[i] = cols[i];
            }
            vertices = ui.Vertices.raw(
              ui.VertexMode.triangles,
              rawPts,
              colors: rawCols,
            );
          }
          try {
            canvas.drawVertices(vertices, BlendMode.srcOver, verticesPaint);
          } finally {
            vertices.dispose();
          }
        case PocketTextOp():
          final hasNewline = op.text.contains('\n');
          final lines = hasNewline ? op.text.split('\n') : null;
          final textLines = lines == null ? 1 : lines.length;
          final lineHeight = op.size > 0 && op.height > 0
              ? op.height / textLines / op.size
              : null;
          final textStyle = pocketTextStyleForSlot(
            slot: op.fontSlot,
            fontSize: op.size,
            color: Color(op.color),
            fontFamilyFallback: fontFamilyFallback,
            height: lineHeight,
            letterSpacing: op.tracking,
          );
          TextPainter layoutLine(String value) =>
              textLayoutCache?.obtain(
                text: value,
                style: textStyle,
                textDirection: TextDirection.ltr,
              ) ??
              (TextPainter(
                text: TextSpan(text: value, style: textStyle),
                textDirection: TextDirection.ltr,
                textScaler: TextScaler.noScaling,
              )..layout());
          final affine = op.affine;
          final originX = affine == null ? op.x : 0.0;
          final originY = affine == null ? op.y : 0.0;
          if (affine != null) {
            canvas.save();
            canvas.translate(op.x, op.y);
            canvas.transform(
              Float64List.fromList(<double>[
                affine[0],
                affine[1],
                0,
                0,
                affine[2],
                affine[3],
                0,
                0,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                1,
              ]),
            );
          }
          try {
            if (op.align == 1 || op.align == 2) {
              final alignFactor = op.align == 1 ? 0.5 : 1.0;
              if (lines == null) {
                final text = layoutLine(op.text);
                final offset = (op.width - text.width) * alignFactor;
                text.paint(canvas, Offset(originX + offset, originY));
                if (textLayoutCache == null) text.dispose();
              } else {
                final advance = op.height / lines.length;
                for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                  final text = layoutLine(lines[lineIdx]);
                  final offset = (op.width - text.width) * alignFactor;
                  text.paint(
                    canvas,
                    Offset(originX + offset, originY + lineIdx * advance),
                  );
                  if (textLayoutCache == null) text.dispose();
                }
              }
            } else {
              final text = layoutLine(op.text);
              text.paint(canvas, Offset(originX, originY));
              if (textLayoutCache == null) text.dispose();
            }
          } finally {
            if (affine != null) canvas.restore();
          }
        case PocketImageOp():
          final image = images[op.asset];
          if (image != null) {
            final uv = op.uv;
            final tint = op.tint;
            imagePaint.colorFilter = tint == null
                ? null
                : ColorFilter.mode(Color(tint), BlendMode.modulate);
            final destination = _pocketPixelAlignedRect(
              rect,
              sx: sx,
              sy: sy,
              devicePixelRatio: paintDevicePixelRatio,
            );
            canvas.drawImageRect(
              image,
              uv == null
                  ? Rect.fromLTWH(
                      0,
                      0,
                      image.width.toDouble(),
                      image.height.toDouble(),
                    )
                  : Rect.fromLTRB(
                      uv[0] * image.width,
                      uv[1] * image.height,
                      uv[2] * image.width,
                      uv[3] * image.height,
                    ),
              destination,
              imagePaint,
            );
          }
      }
      index++;
    }
    closeActiveClip();
    if (meshLayer != null) {
      if (meshMaskActive) {
        canvas.restore();
        canvas.restore();
      }
      canvas.restore();
      canvas.restore();
    }
    canvas.restore();
  }

  int _drawTextureTriangleBatch(
    Canvas canvas,
    int start, {
    required ui.Image? image,
    required double pixelScale,
    required PocketMeshLayerBeginOp? layer,
  }) {
    final first = ops[start] as PocketTextureTriangleOp;
    var end = start + 1;
    var vertexCount = first.vertexCount;
    while (end < ops.length) {
      final candidate = ops[end];
      if (candidate is! PocketTextureTriangleOp) break;
      drawOpInvocationCount++;
      if (candidate.asset != first.asset ||
          candidate.color != first.color ||
          candidate.repeatTexture != first.repeatTexture ||
          !_samePocketClip(candidate.clip, first.clip)) {
        drawOpInvocationCount--;
        break;
      }
      vertexCount += candidate.vertexCount;
      end++;
    }
    final sourceImage = image;
    if (sourceImage == null || vertexCount == 0) return end;
    var sampledImage = sourceImage;
    final levels = meshImageLevels[first.asset];
    // Clamped meshes also carry pixel-preserving nine-slice UI skins. Keep
    // their original sampling even when a repeated mesh shares the image.
    if (first.repeatTexture &&
        levels != null &&
        levels.isNotEmpty &&
        pixelScale > 0) {
      var textureArea = 0.0;
      var screenArea = 0.0;
      final texPixels = sourceImage.width * sourceImage.height;
      for (var opIdx = start; opIdx < end; opIdx++) {
        final op = ops[opIdx] as PocketTextureTriangleOp;
        final g = op.packedGeometry;
        if (g != null) {
          final area =
              ((g[2] - g[0]) * (g[5] - g[1]) - (g[3] - g[1]) * (g[4] - g[0]))
                  .abs();
          if (area <= 1e-9) continue;
          final du1 = g[8] - g[6];
          final dv1 = g[9] - g[7];
          final du2 = g[10] - g[6];
          final dv2 = g[11] - g[7];
          textureArea += (du1 * dv2 - dv1 * du2).abs() * texPixels;
          screenArea += area * pixelScale;
        } else {
          final pts = op.points;
          final uvs = op.uvs;
          for (var i = 0; i + 2 < pts.length; i += 3) {
            final a = pts[i], b = pts[i + 1], c = pts[i + 2];
            final area = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
                .abs();
            if (area <= 1e-9) continue;
            final u = i * 2;
            final du1 = uvs[u + 2] - uvs[u];
            final dv1 = uvs[u + 3] - uvs[u + 1];
            final du2 = uvs[u + 4] - uvs[u];
            final dv2 = uvs[u + 5] - uvs[u + 1];
            textureArea += (du1 * dv2 - dv1 * du2).abs() * texPixels;
            screenArea += area * pixelScale;
          }
        }
      }
      if (screenArea > 0 && textureArea.isFinite) {
        final density = math.sqrt(textureArea / screenArea);
        final original = sourceImage;
        for (final level in levels) {
          if (level.width < original.width &&
              level.height < original.height &&
              level.width * original.height == level.height * original.width &&
              level.width <= sampledImage.width &&
              level.width * density + 1e-6 >= original.width &&
              level.height * density + 1e-6 >= original.height) {
            sampledImage = level;
          }
        }
      }
    }
    final positions = Float32List(vertexCount * 2);
    final textureCoordinates = Float32List(vertexCount * 2);
    final colors = Int32List(vertexCount)..fillRange(0, vertexCount, first.color);
    final imgW = sampledImage.width.toDouble();
    final imgH = sampledImage.height.toDouble();
    var out = 0;
    for (var opIdx = start; opIdx < end; opIdx++) {
      final op = ops[opIdx] as PocketTextureTriangleOp;
      final g = op.packedGeometry;
      if (g != null) {
        positions[out] = g[0];
        positions[out + 1] = g[1];
        positions[out + 2] = g[2];
        positions[out + 3] = g[3];
        positions[out + 4] = g[4];
        positions[out + 5] = g[5];
        textureCoordinates[out] = g[6] * imgW;
        textureCoordinates[out + 1] = g[7] * imgH;
        textureCoordinates[out + 2] = g[8] * imgW;
        textureCoordinates[out + 3] = g[9] * imgH;
        textureCoordinates[out + 4] = g[10] * imgW;
        textureCoordinates[out + 5] = g[11] * imgH;
        out += 6;
      } else {
        final pts = op.points;
        final uvs = op.uvs;
        for (var vertex = 0; vertex < pts.length; vertex++) {
          final point = pts[vertex];
          positions[out] = point.x;
          positions[out + 1] = point.y;
          textureCoordinates[out] = uvs[vertex * 2] * imgW;
          textureCoordinates[out + 1] = uvs[vertex * 2 + 1] * imgH;
          out += 2;
        }
      }
    }
    final vertices = ui.Vertices.raw(
      ui.VertexMode.triangles,
      positions,
      colors: colors,
      textureCoordinates: textureCoordinates,
    );
    try {
      final shader = ui.ImageShader(
        sampledImage,
        first.repeatTexture ? TileMode.repeated : TileMode.clamp,
        first.repeatTexture ? TileMode.repeated : TileMode.clamp,
        _identityMatrix,
      );
      try {
        final paint = Paint()
          ..shader = shader
          ..filterQuality = FilterQuality.low;
        if (layer != null) paint.colorFilter = _meshTintFilter(layer);
        // Active scissor clip for `first.clip` is already synchronized by caller.
        canvas.drawVertices(vertices, BlendMode.modulate, paint);
        textureTriangleBatchDrawCount++;
      } finally {
        shader.dispose();
      }
    } finally {
      vertices.dispose();
    }
    return end;
  }

  /// Canvas blocks are full-size Stack siblings so retained layers can keep
  /// their original DrawOps order. A full-size CustomPaint is otherwise a
  /// full-size hit target too, which hides a focused host surface that is
  /// painted before a sparse root overlay (the mini-app close control is one
  /// such overlay). Restrict hit testing to the actual painted op bounds and
  /// let Flutter continue its Stack walk for uncovered points.
  @override
  bool hitTest(Offset position) {
    if (width <= 0 || height <= 0) return false;
    final rendered = renderedSize;
    final scaleX = rendered == null ? 1.0 : rendered.width / width;
    final scaleY = rendered == null ? 1.0 : rendered.height / height;
    if (!scaleX.isFinite || !scaleY.isFinite || scaleX <= 0 || scaleY <= 0) {
      return false;
    }
    final logical = Offset(position.dx / scaleX, position.dy / scaleY);
    return ops.any((op) => _pocketOpPaintsAt(op, logical));
  }

  @override
  bool shouldRepaint(PocketCanvasPainter oldDelegate) {
    // Structural comparison already covers all painted fields and can stop
    // at the first changed op. A full-block hash before it duplicates work.
    return !_pocketCanvasEquals(oldDelegate, this);
  }
}

/// Paints adjacent original mesh partitions into one temporary high-resolution
/// surface, then composites the crop once. The partitions remain intact so
/// their mesh batches and source order do not change.
final class PocketMeshSpanPainter extends CustomPainter {
  PocketMeshSpanPainter({
    required List<PocketCanvasPainter> partitions,
    this.sampleScale = 1,
  }) : partitions = List<PocketCanvasPainter>.unmodifiable(partitions);

  /// Original DrawOp partitions retained in source order for drawing and
  /// diagnostics. This list is immutable, but each painter remains the actual
  /// painter used by the span.
  final List<PocketCanvasPainter> partitions;

  /// Multiplier applied after the physical device pixel ratio.
  final int sampleScale;

  static int spanPaintCount = 0;
  static int snapshotCount = 0;
  static int disposedSnapshotCount = 0;
  static int snapshottedPixelCount = 0;
  static int budgetBypassCount = 0;
  static int ineligibleBypassCount = 0;
  static int snapshotFailureBypassCount = 0;

  static void resetDiagnostics() {
    spanPaintCount = 0;
    snapshotCount = 0;
    disposedSnapshotCount = 0;
    snapshottedPixelCount = 0;
    budgetBypassCount = 0;
    ineligibleBypassCount = 0;
    snapshotFailureBypassCount = 0;
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (partitions.isEmpty) return;
    spanPaintCount++;
    if (sampleScale <= 1) {
      _paintPartitions(canvas, size);
      return;
    }
    if (!_isEligibleMeshSpan(partitions)) {
      ineligibleBypassCount++;
      _paintPartitions(canvas, size);
      return;
    }

    final first = partitions.first;
    final bounds = _meshSpanCropBounds(
      partitions,
      size,
      first.devicePixelRatio,
    );
    if (bounds == null) {
      ineligibleBypassCount++;
      _paintPartitions(canvas, size);
      return;
    }
    final targetWidth = (bounds.width * sampleScale).round();
    final targetHeight = (bounds.height * sampleScale).round();
    final targetPixels = targetWidth * targetHeight;
    if (targetWidth <= 0 ||
        targetHeight <= 0 ||
        targetWidth > 4096 ||
        targetHeight > 4096 ||
        targetPixels > 2097152) {
      budgetBypassCount++;
      _paintPartitions(canvas, size);
      return;
    }

    final physicalDpr = first.devicePixelRatio;
    final destination = Rect.fromLTRB(
      bounds.left / physicalDpr,
      bounds.top / physicalDpr,
      bounds.right / physicalDpr,
      bounds.bottom / physicalDpr,
    );
    ui.PictureRecorder? recorder;
    ui.Picture? picture;
    ui.Image? image;
    void disposeRecordedResources() {
      final snapshot = image;
      if (snapshot != null) {
        snapshot.dispose();
        disposedSnapshotCount++;
        image = null;
      }
      final recordedPicture = picture;
      if (recordedPicture != null) {
        recordedPicture.dispose();
        picture = null;
      } else if (recorder?.isRecording ?? false) {
        recorder!.endRecording().dispose();
      }
    }

    try {
      final activeRecorder = ui.PictureRecorder();
      recorder = activeRecorder;
      final offscreen = Canvas(
        activeRecorder,
        Rect.fromLTWH(0, 0, targetWidth.toDouble(), targetHeight.toDouble()),
      );
      offscreen
        ..scale(physicalDpr * sampleScale)
        ..translate(-destination.left, -destination.top);
      for (final partition in partitions) {
        partition._paintWithDevicePixelRatio(
          offscreen,
          size,
          physicalDpr * sampleScale,
        );
      }
      final completedPicture = activeRecorder.endRecording();
      picture = completedPicture;
      image = completedPicture.toImageSync(targetWidth, targetHeight);
      snapshotCount++;
      snapshottedPixelCount += targetPixels;
    } catch (_) {
      snapshotFailureBypassCount++;
      disposeRecordedResources();
      _paintPartitions(canvas, size);
      return;
    }

    final snapshot = image!;
    var canvasSaved = false;
    try {
      canvas.save();
      canvasSaved = true;
      canvas.clipRect(
        Rect.fromLTWH(0, 0, size.width, size.height),
        doAntiAlias: false,
      );
      canvas.drawImageRect(
        snapshot,
        Rect.fromLTWH(0, 0, targetWidth.toDouble(), targetHeight.toDouble()),
        destination,
        Paint()..filterQuality = FilterQuality.medium,
      );
    } finally {
      try {
        if (canvasSaved) canvas.restore();
      } finally {
        disposeRecordedResources();
      }
    }
  }

  @override
  bool? hitTest(Offset position) =>
      partitions.any((partition) => partition.hitTest(position));

  @override
  bool shouldRepaint(PocketMeshSpanPainter oldDelegate) {
    if (sampleScale != oldDelegate.sampleScale ||
        partitions.length != oldDelegate.partitions.length) {
      return true;
    }
    for (var index = 0; index < partitions.length; index++) {
      if (!_pocketCanvasEquals(
        oldDelegate.partitions[index],
        partitions[index],
      )) {
        return true;
      }
    }
    return false;
  }

  void _paintPartitions(Canvas canvas, Size size) {
    for (final partition in partitions) {
      partition.paint(canvas, size);
    }
  }
}

bool _isEligibleMeshSpan(List<PocketCanvasPainter> partitions) {
  if (partitions.isEmpty) return false;
  final first = partitions.first;
  final dpr = first.devicePixelRatio;
  if (first.width <= 0 || first.height <= 0 || !dpr.isFinite || dpr <= 0) {
    return false;
  }
  var foundTriangle = false;
  for (final partition in partitions) {
    if (partition.width != first.width ||
        partition.height != first.height ||
        partition.devicePixelRatio != dpr) {
      return false;
    }
    var layerOpen = false;
    var maskOpen = false;
    var layerTriangleSeen = false;
    var maskTriangleSeen = false;
    for (final op in partition.ops) {
      if (op is PocketTextureTriangleOp) {
        if (partition.images[op.asset] == null || op.vertexCount == 0) {
          return false;
        }
        foundTriangle = true;
        if (layerOpen) {
          if (maskOpen) {
            maskTriangleSeen = true;
          } else {
            layerTriangleSeen = true;
          }
        } else if (!op.repeatTexture) {
          // Clamped mesh quads can represent pixel-preserving UI skins. They
          // only join supersampled work when part of a complete model layer.
          return false;
        }
        continue;
      }
      if (op is PocketMeshLayerBeginOp) {
        if (layerOpen || op.blend != 0) return false;
        layerOpen = true;
        layerTriangleSeen = false;
        maskOpen = false;
        maskTriangleSeen = false;
        continue;
      }
      if (op is PocketMeshMaskBeginOp) {
        if (!layerOpen || maskOpen || !layerTriangleSeen) return false;
        maskOpen = true;
        maskTriangleSeen = false;
        continue;
      }
      if (op is PocketMeshLayerRestoreOp) {
        if (!layerOpen ||
            !layerTriangleSeen ||
            (maskOpen && !maskTriangleSeen)) {
          return false;
        }
        layerOpen = false;
        maskOpen = false;
        continue;
      }
      return false;
    }
    // PocketCanvasPainter owns layer saveLayer state per partition. A group
    // split across partitions would not preserve its original composition.
    if (layerOpen || maskOpen) return false;
  }
  return foundTriangle;
}

Rect? _meshSpanCropBounds(
  List<PocketCanvasPainter> partitions,
  Size size,
  double devicePixelRatio,
) {
  final first = partitions.first;
  if (size.width <= 0 ||
      size.height <= 0 ||
      first.width <= 0 ||
      first.height <= 0 ||
      !devicePixelRatio.isFinite ||
      devicePixelRatio <= 0) {
    return null;
  }
  final sx = size.width / first.width;
  final sy = size.height / first.height;
  var left = double.infinity;
  var top = double.infinity;
  var right = double.negativeInfinity;
  var bottom = double.negativeInfinity;
  for (final partition in partitions) {
    for (final op in partition.ops) {
      if (op is! PocketTextureTriangleOp) continue;
      final g = op.packedGeometry;
      if (g != null) {
        for (var i = 0; i < 6; i += 2) {
          final x = g[i] * sx * devicePixelRatio;
          final y = g[i + 1] * sy * devicePixelRatio;
          if (!x.isFinite || !y.isFinite) return null;
          left = math.min(left, x);
          top = math.min(top, y);
          right = math.max(right, x);
          bottom = math.max(bottom, y);
        }
      } else {
        for (final point in op.points) {
          final x = point.x * sx * devicePixelRatio;
          final y = point.y * sy * devicePixelRatio;
          if (!x.isFinite || !y.isFinite) return null;
          left = math.min(left, x);
          top = math.min(top, y);
          right = math.max(right, x);
          bottom = math.max(bottom, y);
        }
      }
    }
  }
  if (!left.isFinite || !top.isFinite || !right.isFinite || !bottom.isFinite) {
    return null;
  }
  const margin = 2;
  final viewportWidth = (size.width * devicePixelRatio).ceil();
  final viewportHeight = (size.height * devicePixelRatio).ceil();
  final cropLeft = math.max(0, left.floor() - margin);
  final cropTop = math.max(0, top.floor() - margin);
  final cropRight = math.min(viewportWidth, right.ceil() + margin);
  final cropBottom = math.min(viewportHeight, bottom.ceil() + margin);
  if (cropRight <= cropLeft || cropBottom <= cropTop) return null;
  return Rect.fromLTRB(
    cropLeft.toDouble(),
    cropTop.toDouble(),
    cropRight.toDouble(),
    cropBottom.toDouble(),
  );
}

void _clipPocketOp(Canvas canvas, PocketOp op) {
  final clip = op.clip;
  if (clip == null) return;
  // PocketJS SCISSOR is a hard rectangular boundary. Flutter defaults to
  // antialiased clipping; retaining this false setting avoids a measured
  // Impeller cost increase on ordinary frames (see ANDROID_IMPELLER_SCISSOR).
  canvas.clipRect(
    Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
    doAntiAlias: false,
  );
}

BlendMode _pocketMeshBlendMode(int blend) => switch (blend) {
  1 => BlendMode.plus,
  2 => BlendMode.multiply,
  3 => BlendMode.screen,
  _ => BlendMode.srcOver,
};

ColorFilter _meshTintFilter(PocketMeshLayerBeginOp layer) {
  final multiply = layer.multiplyRgb;
  final screen = layer.screenRgb;
  double scale(int channel) => (1 - screen[channel]) * multiply[channel];
  double offset(int channel) => screen[channel] * multiply[channel];
  return ColorFilter.matrix(<double>[
    scale(0),
    0,
    0,
    0,
    offset(0) * 255,
    0,
    scale(1),
    0,
    0,
    offset(1) * 255,
    0,
    0,
    scale(2),
    0,
    offset(2) * 255,
    0,
    0,
    0,
    1,
    0,
  ]);
}

bool _samePocketClip(PocketClip? first, PocketClip? second) {
  if (identical(first, second)) return true;
  if (first == null || second == null) return false;
  return first.x == second.x &&
      first.y == second.y &&
      first.width == second.width &&
      first.height == second.height;
}

bool _pocketArgbPaints(int color) => (color >>> 24) != 0;

bool _pocketRoundedPaintsAt(PocketRoundedOp op, Offset point) {
  if (!_pocketArgbPaints(op.color)) return false;
  final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
  final radius = op.radius.clamp(0.0, rect.shortestSide / 2).toDouble();
  if (!RRect.fromRectAndRadius(rect, Radius.circular(radius)).contains(point)) {
    return false;
  }
  final borderWidth = op.borderWidth
      .clamp(0.0, rect.shortestSide / 2)
      .toDouble();
  if (borderWidth == 0.0) return true;
  final innerRect = rect.deflate(borderWidth);
  if (innerRect.width <= 0 || innerRect.height <= 0) return true;
  final innerRadius = (radius - borderWidth)
      .clamp(0.0, innerRect.shortestSide / 2)
      .toDouble();
  return !RRect.fromRectAndRadius(
    innerRect,
    Radius.circular(innerRadius),
  ).contains(point);
}

bool _pocketArcPaintsAt(PocketArcOp op, Offset point) {
  if (!_pocketArgbPaints(op.color)) return false;
  final center = Offset(op.x + op.width * 0.5, op.y + op.height * 0.5);
  final dx = point.dx - center.dx;
  final dy = point.dy - center.dy;
  final half = op.strokeWidth * 0.5;
  final distance = math.sqrt(dx * dx + dy * dy);
  final onStroke = (distance - op.radius).abs() <= half;
  if (op.sweepAngle.abs() >= 360.0) return onStroke;
  final angle = (math.atan2(dx, -dy) * 180.0 / math.pi + 360.0) % 360.0;
  final start = (op.startAngle % 360.0 + 360.0) % 360.0;
  final delta = op.sweepAngle > 0
      ? (angle - start + 360.0) % 360.0
      : (start - angle + 360.0) % 360.0;
  if (onStroke && delta <= op.sweepAngle.abs()) return true;
  Offset endpoint(double degrees) {
    final radians = degrees * math.pi / 180.0;
    return Offset(
      center.dx + math.sin(radians) * op.radius,
      center.dy - math.cos(radians) * op.radius,
    );
  }

  final first = endpoint(op.startAngle);
  final last = endpoint(op.startAngle + op.sweepAngle);
  return (point - first).distance <= half || (point - last).distance <= half;
}

bool _pocketRoundedGradientPaintsAt(PocketRoundedGradientOp op, Offset point) {
  if (!_pocketArgbPaints(op.fromColor) &&
      !_pocketArgbPaints(op.toColor) &&
      (op.viaColor == null || !_pocketArgbPaints(op.viaColor!))) {
    return false;
  }
  final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
  final radius = op.radius.clamp(0.0, rect.shortestSide / 2).toDouble();
  return RRect.fromRectAndRadius(rect, Radius.circular(radius)).contains(point);
}

/// Conservative visual hit approximation for a DrawOp. The native Guest
/// remains the authority for JS activation; this is only the Flutter sibling
/// hit-test needed to choose between a host surface and later root paint.
bool _pocketOpPaintsAt(PocketOp op, Offset point) {
  if (op is PocketHostSurfaceOp || op.width <= 0 || op.height <= 0) {
    return false;
  }
  final clip = op.clip;
  if (clip != null &&
      !Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height).contains(point)) {
    return false;
  }
  if (op is PocketTextOp && op.affine != null) {
    if (!_pocketArgbPaints(op.color)) return false;
    final m = op.affine!;
    final det = m[0] * m[3] - m[1] * m[2];
    if (!det.isFinite || det.abs() <= 1e-9) return false;
    final dx = point.dx - op.x;
    final dy = point.dy - op.y;
    final lx = (m[3] * dx - m[2] * dy) / det;
    final ly = (m[0] * dy - m[1] * dx) / det;
    return lx >= 0 && lx <= op.width && ly >= 0 && ly <= op.height;
  }
  if (!Rect.fromLTWH(op.x, op.y, op.width, op.height).contains(point)) {
    return false;
  }
  return switch (op) {
    PocketRectOp(:final color) => _pocketArgbPaints(color),
    PocketRoundedOp() => _pocketRoundedPaintsAt(op, point),
    PocketRoundedGradientOp() => _pocketRoundedGradientPaintsAt(op, point),
    PocketArcOp() => _pocketArcPaintsAt(op, point),
    PocketGradientOp(:final fromColor, :final toColor) =>
      _pocketArgbPaints(fromColor) || _pocketArgbPaints(toColor),
    PocketTriangleOp(:final packedColors) =>
      packedColors != null
          ? (_pocketArgbPaints(packedColors[0]) ||
                _pocketArgbPaints(packedColors[1]) ||
                _pocketArgbPaints(packedColors[2]))
          : op.colors.any(_pocketArgbPaints),
    PocketTextureTriangleOp(:final color) => _pocketArgbPaints(color),
    PocketTextOp(:final color) => _pocketArgbPaints(color),
    // A loaded image/video may contain transparent pixels, but its DrawOp is
    // still the only host-visible sibling at this point. Keep the hit region
    // conservative; JS performs the precise semantic hit test afterwards.
    PocketImageOp(:final tint) => tint == null || _pocketArgbPaints(tint),
    PocketVideoOp() => true,
    PocketMeshLayerBeginOp() ||
    PocketMeshMaskBeginOp() ||
    PocketMeshLayerRestoreOp() => false,
    PocketHostSurfaceOp() => false,
  };
}

/// Align rectangle fills and image quads to the device-pixel grid after the
/// painter's logical surface transform. Both near and far edges are rounded
/// independently, so two quads sharing an edge receive the same boundary.
/// This intentionally does not ceil the far edge: extending a translucent
/// tile would overlap its neighbour and make the seam darker.
Rect _pocketPixelAlignedRect(
  Rect rect, {
  required double sx,
  required double sy,
  required double devicePixelRatio,
}) {
  final pixelScaleX = sx * devicePixelRatio;
  final pixelScaleY = sy * devicePixelRatio;
  if (![
        pixelScaleX,
        pixelScaleY,
      ].every((value) => value.isFinite && value > 0) ||
      ![
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
      ].every((value) => value.isFinite)) {
    return rect;
  }

  double snap(double value, double scale) =>
      (value * scale).roundToDouble() / scale;

  // Do not collapse a sub-device-pixel image to an empty rect. Such a quad
  // is not a DeepZoom tile and retaining the original coverage is the least
  // surprising behaviour for icons/sprites.
  final snapped = Rect.fromLTRB(
    snap(rect.left, pixelScaleX),
    snap(rect.top, pixelScaleY),
    snap(rect.right, pixelScaleX),
    snap(rect.bottom, pixelScaleY),
  );
  if (snapped.width <= 0 || snapped.height <= 0) return rect;
  return snapped;
}

bool _pocketCanvasEquals(
  PocketCanvasPainter oldPainter,
  PocketCanvasPainter newPainter,
) {
  if (oldPainter.width != newPainter.width ||
      oldPainter.height != newPainter.height ||
      oldPainter.devicePixelRatio != newPainter.devicePixelRatio ||
      !_pocketSizeEquals(oldPainter.renderedSize, newPainter.renderedSize) ||
      !_pocketStringListEquals(
        oldPainter.fontFamilyFallback,
        newPainter.fontFamilyFallback,
      ) ||
      oldPainter.ops.length != newPainter.ops.length) {
    return false;
  }
  if (oldPainter._meshLevelIdentities.length !=
      newPainter._meshLevelIdentities.length)
    return false;
  for (final entry in oldPainter._meshLevelIdentities.entries) {
    if (!listEquals(entry.value, newPainter._meshLevelIdentities[entry.key]))
      return false;
  }
  if (identical(oldPainter.ops, newPainter.ops) &&
      _pocketImageIdentityMapsEqual(
        oldPainter._imageIdentities,
        newPainter._imageIdentities,
      )) {
    return true;
  }
  for (var index = 0; index < oldPainter.ops.length; index++) {
    if (!_pocketOpEquals(
      oldPainter.ops[index],
      newPainter.ops[index],
      oldPainter._imageIdentities,
      newPainter._imageIdentities,
    )) {
      return false;
    }
  }
  return true;
}

bool _pocketSizeEquals(Size? first, Size? second) {
  if (first == null || second == null) return first == second;
  return first.width == second.width && first.height == second.height;
}

bool _pocketStringListEquals(List<String> first, List<String> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

bool _pocketClipEquals(PocketClip? first, PocketClip? second) {
  if (identical(first, second)) return true;
  if (first == null || second == null) return false;
  return first.x == second.x &&
      first.y == second.y &&
      first.width == second.width &&
      first.height == second.height;
}

bool _pocketPointListEquals(List<PocketPoint> first, List<PocketPoint> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index].x != second[index].x ||
        first[index].y != second[index].y) {
      return false;
    }
  }
  return true;
}

bool _pocketIntListEquals(List<int> first, List<int> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

bool _pocketDoubleListEquals(List<double> first, List<double> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

bool _pocketImageIdentityMapsEqual(
  Map<String, ui.Image?> first,
  Map<String, ui.Image?> second,
) {
  if (identical(first, second)) return true;
  if (first.length != second.length) return false;
  for (final entry in first.entries) {
    if (!second.containsKey(entry.key) ||
        !identical(entry.value, second[entry.key])) {
      return false;
    }
  }
  return true;
}

bool _pocketFloat32ListEquals(Float32List a, Float32List b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool _pocketInt32ListEquals(Int32List a, Int32List b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool _pocketOpEquals(
  PocketOp first,
  PocketOp second,
  Map<String, ui.Image?> firstImages,
  Map<String, ui.Image?> secondImages,
) {
  if (identical(first, second)) {
    if (identical(firstImages, secondImages)) return true;
    return switch (first) {
      PocketImageOp(:final asset) ||
      PocketTextureTriangleOp(:final asset) =>
        identical(firstImages[asset], secondImages[asset]),
      _ => true,
    };
  }
  if (first.runtimeType != second.runtimeType ||
      first.x != second.x ||
      first.y != second.y ||
      first.width != second.width ||
      first.height != second.height ||
      !_pocketClipEquals(first.clip, second.clip)) {
    return false;
  }
  switch (first) {
    case PocketHostSurfaceOp():
      final other = second as PocketHostSurfaceOp;
      return first.id == other.id &&
          first.kind == other.kind &&
          first.surfaceHandle == other.surfaceHandle &&
          first.focused == other.focused &&
          mapEquals(first.parameters, other.parameters);
    case PocketRectOp():
      return (second as PocketRectOp).color == first.color;
    case PocketRoundedOp():
      final other = second as PocketRoundedOp;
      return other.color == first.color &&
          other.radius == first.radius &&
          other.borderWidth == first.borderWidth;
    case PocketArcOp():
      final other = second as PocketArcOp;
      return other.color == first.color &&
          other.radius == first.radius &&
          other.strokeWidth == first.strokeWidth &&
          other.startAngle == first.startAngle &&
          other.sweepAngle == first.sweepAngle;
    case PocketGradientOp():
      final other = second as PocketGradientOp;
      return other.fromColor == first.fromColor &&
          other.toColor == first.toColor &&
          other.direction == first.direction;
    case PocketRoundedGradientOp():
      final other = second as PocketRoundedGradientOp;
      return other.radius == first.radius &&
          other.fromColor == first.fromColor &&
          other.toColor == first.toColor &&
          other.direction == first.direction &&
          other.viaColor == first.viaColor &&
          other.viaPosition == first.viaPosition;
    case PocketTriangleOp():
      final other = second as PocketTriangleOp;
      final ptsA = first.packedPoints;
      final ptsB = other.packedPoints;
      final colsA = first.packedColors;
      final colsB = other.packedColors;
      if (ptsA != null && ptsB != null && colsA != null && colsB != null) {
        return _pocketFloat32ListEquals(ptsA, ptsB) &&
            _pocketInt32ListEquals(colsA, colsB);
      }
      return _pocketPointListEquals(first.points, other.points) &&
          _pocketIntListEquals(first.colors, other.colors);
    case PocketTextureTriangleOp():
      final other = second as PocketTextureTriangleOp;
      if (first.asset != other.asset ||
          first.color != other.color ||
          first.repeatTexture != other.repeatTexture ||
          !identical(firstImages[first.asset], secondImages[other.asset])) {
        return false;
      }
      final gA = first.packedGeometry;
      final gB = other.packedGeometry;
      if (gA != null && gB != null) {
        return _pocketFloat32ListEquals(gA, gB);
      }
      return _pocketPointListEquals(first.points, other.points) &&
          _pocketDoubleListEquals(first.uvs, other.uvs);
    case PocketMeshLayerBeginOp():
      final other = second as PocketMeshLayerBeginOp;
      return first.blend == other.blend &&
          _pocketDoubleListEquals(first.multiplyRgb, other.multiplyRgb) &&
          _pocketDoubleListEquals(first.screenRgb, other.screenRgb);
    case PocketMeshMaskBeginOp():
      return first.inverted == (second as PocketMeshMaskBeginOp).inverted;
    case PocketMeshLayerRestoreOp():
      return true;
    case PocketTextOp():
      final other = second as PocketTextOp;
      return first.text == other.text &&
          first.size == other.size &&
          first.color == other.color &&
          first.fontSlot == other.fontSlot &&
          first.align == other.align &&
          first.tracking == other.tracking &&
          _pocketDoubleListNullableEquals(first.affine, other.affine);
    case PocketImageOp():
      final other = second as PocketImageOp;
      return first.asset == other.asset &&
          _pocketDoubleListNullableEquals(first.uv, other.uv) &&
          first.tint == other.tint &&
          identical(firstImages[first.asset], secondImages[other.asset]);
    case PocketVideoOp():
      final other = second as PocketVideoOp;
      return first.id == other.id &&
          first.asset == other.asset &&
          first.autoplay == other.autoplay;
  }
}

bool _pocketDoubleListNullableEquals(
  List<double>? first,
  List<double>? second,
) {
  if (first == null || second == null) return first == second;
  return _pocketDoubleListEquals(first, second);
}

Map<String, ui.Image?> _pocketImageIdentities(
  List<PocketOp> ops,
  Map<String, ui.Image> images,
) {
  Map<String, ui.Image?>? identities;
  String? lastAsset;
  for (var i = 0; i < ops.length; i++) {
    final op = ops[i];
    final String? asset;
    if (op is PocketImageOp) {
      asset = op.asset;
    } else if (op is PocketTextureTriangleOp) {
      asset = op.asset;
    } else {
      continue;
    }
    if (asset == lastAsset) continue;
    lastAsset = asset;
    (identities ??= <String, ui.Image?>{})[asset] = images[asset];
  }
  if (identities == null) return const <String, ui.Image?>{};
  return identities;
}

Map<String, List<ui.Image>> _pocketMeshLevelIdentities(
  List<PocketOp> ops,
  Map<String, List<ui.Image>> meshImageLevels,
) {
  if (meshImageLevels.isEmpty) return const <String, List<ui.Image>>{};
  Map<String, List<ui.Image>>? copied;
  String? lastAsset;
  for (var i = 0; i < ops.length; i++) {
    final op = ops[i];
    if (op is! PocketTextureTriangleOp || !op.repeatTexture) continue;
    final asset = op.asset;
    if (asset == lastAsset) continue;
    lastAsset = asset;
    final levels = meshImageLevels[asset];
    if (levels != null && levels.isNotEmpty) {
      (copied ??= <String, List<ui.Image>>{})[asset] = List<ui.Image>.of(levels);
    }
  }
  return copied ?? const <String, List<ui.Image>>{};
}

final Float64List _identityMatrix = Float64List.fromList(<double>[
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
]);



(Alignment, Alignment) _gradientAlignment(int direction) {
  return switch (direction) {
    0 => (Alignment.bottomCenter, Alignment.topCenter),
    1 => (Alignment.topCenter, Alignment.bottomCenter),
    2 => (Alignment.centerRight, Alignment.centerLeft),
    _ => (Alignment.centerLeft, Alignment.centerRight),
  };
}
