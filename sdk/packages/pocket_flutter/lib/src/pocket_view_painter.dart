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
  }) : _imageIdentities = _pocketImageIdentities(ops, images),
       _meshLevelIdentities = <String, List<ui.Image>>{
         for (final entry in meshImageLevels.entries)
           entry.key: List<ui.Image>.of(entry.value),
       };

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
    paintInvocationCount++;
    if (width <= 0 || height <= 0) return;
    final sx = size.width / width;
    final sy = size.height / height;
    canvas.save();
    canvas.scale(sx, sy);
    PocketMeshLayerBeginOp? meshLayer;
    var meshMaskActive = false;
    var index = 0;
    while (index < ops.length) {
      final op = ops[index];
      drawOpInvocationCount++;
      if (op is PocketMeshLayerBeginOp) {
        if (meshLayer == null) {
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
      if (op is PocketTextureTriangleOp) {
        final next = _drawTextureTriangleBatch(
          canvas,
          index,
          image: images[op.asset],
          pixelScale:
              (sx * sy).abs() * paintDevicePixelRatio * paintDevicePixelRatio,
          layer: meshMaskActive ? null : meshLayer,
        );
        index = next;
        continue;
      }
      final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      canvas.save();
      _clipPocketOp(canvas, op);
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
          try {
            canvas.drawVertices(vertices, BlendMode.srcOver, Paint());
          } finally {
            vertices.dispose();
          }
        case PocketTextureTriangleOp():
        case PocketMeshLayerBeginOp():
        case PocketMeshMaskBeginOp():
        case PocketMeshLayerRestoreOp():
          // These operations are consumed before the ordinary per-op path.
          break;
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
              paint,
            );
          }
        case PocketVideoOp():
          // The video texture is a sibling below this painter. Keeping this op
          // in the frame preserves ordering without painting a second frame.
          break;
      }
      canvas.restore();
      index++;
    }
    if (meshLayer != null) {
      // Malformed injected/legacy JSON must not leak a saveLayer into Flutter's
      // canvas stack. Native DrawOps rejects unbalanced mesh groups earlier.
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
    final batch = <PocketTextureTriangleOp>[first];
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
      batch.add(candidate);
      end++;
    }
    final sourceImage = image;
    if (sourceImage == null) return end;
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
      for (final op in batch) {
        for (var i = 0; i + 2 < op.points.length; i += 3) {
          final a = op.points[i], b = op.points[i + 1], c = op.points[i + 2];
          final area = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
              .abs();
          if (area <= 1e-9) continue;
          final u = i * 2;
          final du1 = op.uvs[u + 2] - op.uvs[u];
          final dv1 = op.uvs[u + 3] - op.uvs[u + 1];
          final du2 = op.uvs[u + 4] - op.uvs[u];
          final dv2 = op.uvs[u + 5] - op.uvs[u + 1];
          textureArea +=
              (du1 * dv2 - dv1 * du2).abs() *
              sourceImage.width *
              sourceImage.height;
          screenArea += area * pixelScale;
        }
      }
      if (screenArea > 0 && textureArea.isFinite) {
        final density = math.sqrt(textureArea / screenArea);
        final original = sourceImage;
        for (final level in levels) {
          // Keep at least one source texel per output pixel. Magnified meshes
          // keep the original; normalized UVs remain unchanged at every LOD.
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
    final positions = <Offset>[];
    final textureCoordinates = <Offset>[];
    final colors = <Color>[];
    for (final op in batch) {
      for (var vertex = 0; vertex < op.points.length; vertex++) {
        final point = op.points[vertex];
        positions.add(Offset(point.x, point.y));
        textureCoordinates.add(
          Offset(
            op.uvs[vertex * 2] * sampledImage.width,
            op.uvs[vertex * 2 + 1] * sampledImage.height,
          ),
        );
        colors.add(Color(op.color));
      }
    }
    final vertices = ui.Vertices(
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
        canvas.save();
        try {
          _clipPocketOp(canvas, first);
          canvas.drawVertices(vertices, BlendMode.modulate, paint);
        } finally {
          canvas.restore();
        }
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
        if (partition.images[op.asset] == null || op.points.isEmpty) {
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
    for (final op in partition.ops.whereType<PocketTextureTriangleOp>()) {
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
          first.repeatTexture == other.repeatTexture &&
          _pocketPointListEquals(first.points, other.points) &&
          _pocketDoubleListEquals(first.uvs, other.uvs) &&
          identical(firstImages[first.asset], secondImages[other.asset]);
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
