part of 'pocket_view.dart';

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
    this.renderedSize,
    this.devicePixelRatio = 1,
    this.fontFamilyFallback = const <String>[],
    this.textLayoutCache,
  }) : _imageIdentities = _pocketImageIdentities(ops, images);

  final double width;
  final double height;
  final List<PocketOp> ops;
  final Map<String, ui.Image> images;
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
  // The render map is intentionally shared so an image upload can become
  // visible without rebuilding every op object. Keep only identities used by
  // this block as an immutable snapshot for shouldRepaint's collision path.
  final Map<String, ui.Image?> _imageIdentities;
  late final int _fingerprint = _pocketCanvasFingerprint(
    width,
    height,
    ops,
    _imageIdentities,
    renderedSize,
    devicePixelRatio,
    fontFamilyFallback,
  );

  /// A stable diagnostic counter used by widget tests and profiling builds.
  /// It counts actual [paint] calls, not frame/ticker callbacks. A retained
  /// static segment therefore does not increment it on every unchanged frame.
  static int paintInvocationCount = 0;
  static int drawOpInvocationCount = 0;

  static void resetPaintInvocationCount() {
    paintInvocationCount = 0;
    drawOpInvocationCount = 0;
  }

  @override
  void paint(Canvas canvas, Size size) {
    paintInvocationCount++;
    if (width <= 0 || height <= 0) return;
    final sx = size.width / width;
    final sy = size.height / height;
    canvas.save();
    canvas.scale(sx, sy);
    for (final op in ops) {
      drawOpInvocationCount++;
      final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      canvas.save();
      final clip = op.clip;
      if (clip != null) {
        // PocketJS SCISSOR is a hard rectangular boundary. Flutter defaults
        // to antialiased clipping; repeating that per op caused Android
        // Impeller/Vulkan raster time to rise from ~3ms to ~56ms in device
        // tests. Keep shape/image antialiasing, but never antialias scissor.
        // Evidence and reproduction: sdk/docs/ANDROID_IMPELLER_SCISSOR.md.
        canvas.clipRect(
          Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
          doAntiAlias: false,
        );
      }
      switch (op) {
        case PocketHostSurfaceOp():
          // Rendered between retained canvas blocks by PocketView.
          break;
        case PocketRectOp():
          canvas.drawRect(
            _pocketPixelAlignedRect(
              rect,
              sx: sx,
              sy: sy,
              devicePixelRatio: devicePixelRatio,
            ),
            Paint()
              ..color = Color(op.color)
              ..isAntiAlias = false,
          );
        case PocketRoundedOp():
          final radius = op.radius.clamp(0.0, rect.shortestSide / 2).toDouble();
          canvas.drawRRect(
            RRect.fromRectAndRadius(rect, Radius.circular(radius)),
            Paint()..color = Color(op.color),
          );
        case PocketGradientOp():
          final (begin, end) = _gradientAlignment(op.direction);
          final shader = LinearGradient(
            begin: begin,
            end: end,
            colors: <Color>[Color(op.fromColor), Color(op.toColor)],
          ).createShader(rect);
          canvas.drawRect(rect, Paint()..shader = shader);
        case PocketTriangleOp():
          final vertices = ui.Vertices(
            ui.VertexMode.triangles,
            op.points
                .map((point) => Offset(point.x, point.y))
                .toList(growable: false),
            colors: op.colors.map(Color.new).toList(growable: false),
          );
          canvas.drawVertices(vertices, BlendMode.srcOver, Paint());
        case PocketTextureTriangleOp():
          final image = images[op.asset];
          if (image != null) {
            final textureCoordinates = <Offset>[
              for (var index = 0; index < op.points.length; index++)
                Offset(
                  op.uvs[index * 2] * image.width,
                  op.uvs[index * 2 + 1] * image.height,
                ),
            ];
            final vertices = ui.Vertices(
              ui.VertexMode.triangles,
              op.points
                  .map((point) => Offset(point.x, point.y))
                  .toList(growable: false),
              colors: List<Color>.filled(op.points.length, Color(op.color)),
              textureCoordinates: textureCoordinates,
            );
            final shader = ui.ImageShader(
              image,
              TileMode.clamp,
              TileMode.clamp,
              _identityMatrix,
            );
            try {
              canvas.drawVertices(
                vertices,
                BlendMode.modulate,
                Paint()..shader = shader,
              );
            } finally {
              shader.dispose();
            }
          }
        case PocketTextOp():
          final textLines = op.text.split('\n').length;
          final lineHeight = op.size > 0 && op.height > 0
              ? op.height / textLines / op.size
              : null;
          final textStyle = TextStyle(
            color: Color(op.color),
            fontSize: op.size,
            fontFamily: _fontFamilyForSlot(op.fontSlot),
            fontFamilyFallback: fontFamilyFallback.isEmpty
                ? null
                : fontFamilyFallback,
            fontWeight: _fontWeightForSlot(op.fontSlot),
            height: lineHeight,
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
              )..layout());
          // PocketJS supplies line breaks. Align each line inside the native
          // box without a second wrapping pass or truncating overflowing text.
          if (op.align == 1 || op.align == 2) {
            final lines = op.text.split('\n');
            final advance = op.height / lines.length;
            for (var index = 0; index < lines.length; index++) {
              final text = layoutLine(lines[index]);
              final offset = (op.width - text.width) * (op.align == 1 ? .5 : 1);
              text.paint(canvas, Offset(op.x + offset, op.y + index * advance));
              if (textLayoutCache == null) text.dispose();
            }
          } else {
            final text = layoutLine(op.text);
            text.paint(canvas, Offset(op.x, op.y));
            if (textLayoutCache == null) text.dispose();
          }
        case PocketImageOp():
          final image = images[op.asset];
          if (image != null) {
            final uv = op.uv;
            // Bilinear sampling preserves smooth scaling without per-tile
            // mipmaps. Medium filtering exposed texture/atlas boundaries
            // on the Android GPU; both image and fill geometry share the
            // same physical pixel grid below.
            final paint = Paint()..filterQuality = FilterQuality.low;
            final tint = op.tint;
            if (tint != null) {
              paint.colorFilter = ColorFilter.mode(
                Color(tint),
                BlendMode.modulate,
              );
            }
            // DeepZoom emits adjacent TEX_QUADs whose transformed edges can
            // land between device pixels.  Flutter's filtered image draw
            // then coverage-blends each tile independently, exposing a
            // one-pixel dark/colour seam even when the source tiles are
            // opaque. Snap both edges to one shared physical pixel grid;
            // independently rounding the near/far edges (rather than
            // extending the far edge with ceil) preserves exact adjacency
            // without transparent overlap or alpha darkening.
            final destination = _pocketPixelAlignedRect(
              rect,
              sx: sx,
              sy: sy,
              devicePixelRatio: devicePixelRatio,
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
              paint,
            );
          }
        case PocketVideoOp():
          // The video texture is a sibling below this painter. Keeping this op
          // in the frame preserves ordering without painting a second frame.
          break;
      }
      canvas.restore();
    }
    canvas.restore();
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
    if (oldDelegate._fingerprint != _fingerprint) return true;
    // The hash is only a fast reject. Keep a structural equality fallback so
    // a theoretical 32-bit hash collision can never retain stale pixels.
    return !_pocketCanvasEquals(oldDelegate, this);
  }
}

bool _pocketArgbPaints(int color) => (color >>> 24) != 0;

/// Conservative visual hit approximation for a DrawOp. The native Guest
/// remains the authority for JS activation; this is only the Flutter sibling
/// hit-test needed to choose between a host surface and later root paint.
bool _pocketOpPaintsAt(PocketOp op, Offset point) {
  if (op is PocketHostSurfaceOp ||
      op.width <= 0 ||
      op.height <= 0 ||
      !Rect.fromLTWH(op.x, op.y, op.width, op.height).contains(point)) {
    return false;
  }
  final clip = op.clip;
  if (clip != null &&
      !Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height).contains(point)) {
    return false;
  }
  return switch (op) {
    PocketRectOp(:final color) => _pocketArgbPaints(color),
    PocketRoundedOp(:final color) => _pocketArgbPaints(color),
    PocketGradientOp(:final fromColor, :final toColor) =>
      _pocketArgbPaints(fromColor) || _pocketArgbPaints(toColor),
    PocketTriangleOp(:final colors) => colors.any(_pocketArgbPaints),
    PocketTextureTriangleOp(:final color) => _pocketArgbPaints(color),
    PocketTextOp(:final color) => _pocketArgbPaints(color),
    // A loaded image/video may contain transparent pixels, but its DrawOp is
    // still the only host-visible sibling at this point. Keep the hit region
    // conservative; JS performs the precise semantic hit test afterwards.
    PocketImageOp(:final tint) => tint == null || _pocketArgbPaints(tint),
    PocketVideoOp() => true,
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
  if (first == null || second == null) return first == second;
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

bool _pocketOpEquals(
  PocketOp first,
  PocketOp second,
  Map<String, ui.Image?> firstImages,
  Map<String, ui.Image?> secondImages,
) {
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
      return other.color == first.color && other.radius == first.radius;
    case PocketGradientOp():
      final other = second as PocketGradientOp;
      return other.fromColor == first.fromColor &&
          other.toColor == first.toColor &&
          other.direction == first.direction;
    case PocketTriangleOp():
      final other = second as PocketTriangleOp;
      return _pocketPointListEquals(first.points, other.points) &&
          _pocketIntListEquals(first.colors, other.colors);
    case PocketTextureTriangleOp():
      final other = second as PocketTextureTriangleOp;
      return first.asset == other.asset &&
          first.color == other.color &&
          _pocketPointListEquals(first.points, other.points) &&
          _pocketDoubleListEquals(first.uvs, other.uvs) &&
          identical(firstImages[first.asset], secondImages[other.asset]);
    case PocketTextOp():
      final other = second as PocketTextOp;
      return first.text == other.text &&
          first.size == other.size &&
          first.color == other.color &&
          first.fontSlot == other.fontSlot &&
          first.align == other.align;
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

int _pocketCanvasFingerprint(
  double width,
  double height,
  List<PocketOp> ops,
  Map<String, ui.Image?> images,
  Size? renderedSize,
  double devicePixelRatio,
  List<String> fontFamilyFallback,
) {
  return Object.hash(
    width,
    height,
    renderedSize?.width,
    renderedSize?.height,
    devicePixelRatio,
    Object.hashAll(fontFamilyFallback),
    Object.hashAll(ops.map<Object>((op) => _pocketOpFingerprint(op, images))),
  );
}

Map<String, ui.Image?> _pocketImageIdentities(
  List<PocketOp> ops,
  Map<String, ui.Image> images,
) {
  final identities = <String, ui.Image?>{};
  for (final op in ops) {
    final asset = switch (op) {
      PocketImageOp() => op.asset,
      PocketTextureTriangleOp() => op.asset,
      _ => null,
    };
    if (asset != null) identities[asset] = images[asset];
  }
  return Map<String, ui.Image?>.unmodifiable(identities);
}

int _pocketOpFingerprint(PocketOp op, Map<String, ui.Image?> images) {
  final clip = op.clip;
  final clipFingerprint = clip == null
      ? null
      : Object.hash(clip.x, clip.y, clip.width, clip.height);
  switch (op) {
    case PocketHostSurfaceOp():
      return Object.hash(
        op.id,
        op.kind,
        op.surfaceHandle,
        op.focused,
        op.x,
        op.y,
        op.width,
        op.height,
        Object.hashAll(
          op.parameters.entries.map(
            (entry) => Object.hash(entry.key, entry.value),
          ),
        ),
        clipFingerprint,
      );
    case PocketRectOp():
      return Object.hash(
        'rect',
        op.x,
        op.y,
        op.width,
        op.height,
        op.color,
        clipFingerprint,
      );
    case PocketRoundedOp():
      return Object.hash(
        'rounded',
        op.x,
        op.y,
        op.width,
        op.height,
        op.color,
        op.radius,
        clipFingerprint,
      );
    case PocketGradientOp():
      return Object.hash(
        'gradient',
        op.x,
        op.y,
        op.width,
        op.height,
        op.fromColor,
        op.toColor,
        op.direction,
        clipFingerprint,
      );
    case PocketTriangleOp():
      return Object.hash(
        'triangle',
        op.x,
        op.y,
        op.width,
        op.height,
        Object.hashAll(
          op.points.map<Object>((point) => Object.hash(point.x, point.y)),
        ),
        Object.hashAll(op.colors),
        clipFingerprint,
      );
    case PocketTextureTriangleOp():
      return Object.hash(
        'textureTriangle',
        op.x,
        op.y,
        op.width,
        op.height,
        op.asset,
        op.color,
        Object.hashAll(
          op.points.map<Object>((point) => Object.hash(point.x, point.y)),
        ),
        Object.hashAll(op.uvs),
        identityHashCode(images[op.asset]),
        clipFingerprint,
      );
    case PocketTextOp():
      return Object.hash(
        'text',
        op.x,
        op.y,
        op.width,
        op.height,
        op.text,
        op.size,
        op.color,
        op.fontSlot,
        op.align,
        clipFingerprint,
      );
    case PocketImageOp():
      return Object.hash(
        'image',
        op.x,
        op.y,
        op.width,
        op.height,
        op.asset,
        op.uv == null ? null : Object.hashAll(op.uv!),
        op.tint,
        identityHashCode(images[op.asset]),
        clipFingerprint,
      );
    case PocketVideoOp():
      // Video ops are split into texture widgets before a painter is built.
      return Object.hash(
        'video',
        op.x,
        op.y,
        op.width,
        op.height,
        op.id,
        op.asset,
        op.autoplay,
        clipFingerprint,
      );
  }
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

String? _fontFamilyForSlot(int? slot) {
  if (slot != null && slot >= 16 && slot <= 18) return 'PocketMono';
  return 'PocketInter';
}

FontWeight? _fontWeightForSlot(int? slot) {
  if (slot == 7 ||
      slot == 8 ||
      slot == 9 ||
      slot == 10 ||
      slot == 11 ||
      slot == 12 ||
      slot == 13 ||
      slot == 15 ||
      slot == 20) {
    return FontWeight.w700;
  }
  return null;
}

(Alignment, Alignment) _gradientAlignment(int direction) {
  return switch (direction) {
    0 => (Alignment.bottomCenter, Alignment.topCenter),
    1 => (Alignment.topCenter, Alignment.bottomCenter),
    2 => (Alignment.centerRight, Alignment.centerLeft),
    _ => (Alignment.centerLeft, Alignment.centerRight),
  };
}
