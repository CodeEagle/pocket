part of 'pocket_view.dart';

double _surfaceNumber(
  Map<String, dynamic> values,
  String key,
  double fallback,
  double minimum,
  double maximum,
) {
  final value = values[key];
  return value is num && value.isFinite
      ? value.toDouble().clamp(minimum, maximum)
      : fallback;
}

/// One generic optical compositor surface. Recipes and geometry live in JS;
/// Flutter supplies backdrop sampling and the original optical shader math.
final class _PocketGlassFilter extends StatefulWidget {
  const _PocketGlassFilter({
    super.key,
    required this.parameters,
    required this.geometry,
    required this.surfaceSize,
    required this.scale,
  });
  final Map<String, dynamic> parameters;
  final Rect geometry;
  final Size surfaceSize;
  final double scale;

  @override
  State<_PocketGlassFilter> createState() => _PocketGlassFilterState();
}

final class _PocketGlassFilterState extends State<_PocketGlassFilter> {
  static Future<ui.FragmentProgram>? _program;
  Future<void>? _shaderLoad;
  ui.FragmentShader? _shader;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _ensureShader();
  }

  @override
  void didUpdateWidget(_PocketGlassFilter oldWidget) {
    super.didUpdateWidget(oldWidget);
    _ensureShader();
  }

  void _ensureShader() {
    if (widget.parameters['effect'] != 'blur' &&
        ui.ImageFilter.isShaderFilterSupported &&
        _shaderLoad == null) {
      _shaderLoad = _load();
    }
  }

  Future<void> _load() async {
    try {
      final program = await (_program ??= ui.FragmentProgram.fromAsset(
        'packages/pocket_flutter/shaders/liquid_glass.frag',
      ));
      if (!mounted) return;
      setState(() => _shader = program.fragmentShader());
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _shader?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.parameters;
    final radius = _surfaceNumber(p, 'radius', 24, 0, 200) * widget.scale;
    final sigma = _surfaceNumber(p, 'blur', 5, 0, 20) * widget.scale;
    final plainBlur = p['effect'] == 'blur';
    final opacity = _surfaceNumber(p, 'opacity', 1, 0, 1);
    final tint = _surfaceNumber(p, 'tintOpacity', .16, 0, 1);
    final materialStrength = _surfaceNumber(p, 'materialStrength', 0, 0, 1);
    final materialVariant = switch (p['material']) {
      'regular' => 1.0,
      'clear' => 2.0,
      _ => 0.0,
    };
    final materialBits = _surfaceNumber(
      p,
      'materialTint',
      0xfff2f2f7,
      0,
      0xffffffff,
    ).toInt();
    final materialColor = Color(materialBits);
    final deformation = p['deformation'] is Map
        ? Map<String, dynamic>.from(p['deformation'] as Map)
        : const <String, dynamic>{};
    // The interaction contract is intentionally local to this surface. JS
    // supplies the contact anchor relative to the glass centre and a bounded
    // logical-pixel offset; Flutter only forwards the immutable paint values.
    final deformationExtent = math.max(
      widget.geometry.width,
      widget.geometry.height,
    );
    final deformationAnchorX = _surfaceNumber(
      deformation,
      'anchorX',
      0,
      -deformationExtent,
      deformationExtent,
    );
    final deformationAnchorY = _surfaceNumber(
      deformation,
      'anchorY',
      0,
      -deformationExtent,
      deformationExtent,
    );
    final deformationOffsetX = _surfaceNumber(
      deformation,
      'offsetX',
      0,
      -12,
      12,
    );
    final deformationOffsetY = _surfaceNumber(
      deformation,
      'offsetY',
      0,
      -12,
      12,
    );
    final deformationRadius = _surfaceNumber(deformation, 'radius', 0, 0, 128);
    final magnification = _surfaceNumber(p, 'magnification', 1, 1, 1.35);
    final shape = p['shape'];
    final rounded = BorderRadius.circular(
      shape == 'pill' || shape == 'circle' ? 10000 : radius,
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        // Modal blur samples the scene without the optical glass material's
        // tint, refraction or rim. JS supplies the animation progress.
        if (plainBlur && opacity == 0) return const SizedBox.expand();
        final shader = plainBlur ? null : _shader;
        ui.ImageFilter filter = ui.ImageFilter.blur(
          sigmaX: sigma,
          sigmaY: sigma,
        );
        if (plainBlur && opacity < 1) {
          // Fade the filtered backdrop itself. An Opacity ancestor would put
          // BackdropFilter in an isolated layer and change what it samples.
          filter = ui.ImageFilter.compose(
            outer: ui.ColorFilter.matrix(<double>[
              1,
              0,
              0,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              0,
              0,
              opacity,
              0,
            ]),
            inner: filter,
          );
        }
        if (shader != null) {
          // First vec2 and sampler 0 are set by ImageFilter.shader itself.
          final values = <double>[
            widget.geometry.center.dx / widget.surfaceSize.width,
            widget.geometry.center.dy / widget.surfaceSize.height,
            widget.surfaceSize.width,
            widget.surfaceSize.height,
            widget.geometry.width / widget.surfaceSize.width,
            widget.geometry.height / widget.surfaceSize.height,
            radius / widget.surfaceSize.width,
            shape == 'circle'
                ? 2
                : shape == 'pill'
                ? 1
                : 0,
            _surfaceNumber(p, 'edgeIntensity', .015, 0, .2),
            _surfaceNumber(p, 'rimIntensity', .05, 0, .3),
            _surfaceNumber(p, 'baseIntensity', .01, 0, .1),
            tint,
            _surfaceNumber(p, 'cornerBoost', .02, 0, .5),
            _surfaceNumber(p, 'rippleEffect', .08, 0, 1),
            p['warp'] == true ? 1 : 0,
            p['pressed'] == true ? 1 : 0,
            sigma,
            materialStrength,
            materialColor.r,
            materialColor.g,
            materialColor.b,
            materialVariant,
            deformationAnchorX,
            deformationAnchorY,
            deformationOffsetX,
            deformationOffsetY,
            deformationRadius,
            magnification,
          ];
          for (var i = 0; i < values.length; i++) {
            shader.setFloat(i + 2, values[i]);
          }
          // The optical shader already samples its own frosted kernel.
          // A preceding blur expands the input texture and shifts its SDF.
          filter = ui.ImageFilter.shader(shader);
        }
        final mode = plainBlur
            ? 'blur'
            : shader != null
            ? 'refractive'
            : _failed
            ? 'failed'
            : ui.ImageFilter.isShaderFilterSupported
            ? 'loading'
            : 'frosted';
        final opticalInset = _surfaceNumber(p, 'opticalInset', 0, 0, 64);
        final backdrop = BackdropFilter(
          key: ValueKey('pocket-glass-$mode'),
          filter: filter,
          child: DecoratedBox(
            // An unavailable shader retains real frost at the original shape.
            decoration: BoxDecoration(
              borderRadius: rounded,
              color: !plainBlur && shader == null
                  ? materialStrength > 0
                        ? materialColor.withValues(alpha: materialStrength)
                        : Colors.white.withValues(alpha: tint)
                  : null,
              border: !plainBlur && shader == null
                  ? Border.all(
                      color: Colors.white.withValues(alpha: .4),
                      width: .75,
                    )
                  : null,
            ),
            child: const SizedBox.expand(),
          ),
        );
        // The optical shader owns the original SDF silhouette and may paint
        // a local shoulder into the rectangular halo. Frost has no such SDF;
        // inset its rounded clip so fallback cannot enlarge the control.
        final surfaceChild = opticalInset > 0.001 && shader != null
            ? ClipRect(child: backdrop)
            : Padding(
                padding: EdgeInsets.all(opticalInset * widget.scale),
                child: ClipRRect(borderRadius: rounded, child: backdrop),
              );
        return surfaceChild;
      },
    );
  }
}
