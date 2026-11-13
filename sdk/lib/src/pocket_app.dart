import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'pocket_config.dart';
import 'pocket_session.dart';
import 'pocket_startup_indicator.dart';

/// Standalone Flutter entry point. Its only page is the JS rendering surface.
/// Use [PocketGuest] inside an existing MaterialApp instead.
final class PocketApp extends StatelessWidget {
  const PocketApp({
    super.key,
    required this.config,
    this.backgroundColor = const Color(0xFF000000),
    this.loadingBuilder,
  });
  final PocketAppConfig config;
  final Color backgroundColor;

  /// Replaces Pocket's startup presentation with host-owned rendering of the
  /// observed package/runtime progress. The default UI shows a loader only
  /// while a signed remote package is being prepared; local startup stays
  /// quiet until its first PocketView frame. Errors remain visible.
  final PocketLoadingBuilder? loadingBuilder;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    home: Scaffold(
      // PocketGuest/PocketView owns the only effective root fill. Keep the
      // scaffold transparent so a standalone surface does not paint a second
      // retained layer beneath it while preserving Scaffold's IME/layout role.
      backgroundColor: Colors.transparent,
      body: PocketGuest(
        config: config,
        backgroundColor: backgroundColor,
        loadingBuilder: loadingBuilder,
      ),
    ),
  );
}

/// Embeddable SDK surface with verified bytecode/update/plugin lifetime.
///
/// Layout follows the parent constraints. Safe areas and reserved system
/// regions are sent to JS, which owns component layout and navigation.
final class PocketGuest extends StatelessWidget {
  const PocketGuest({
    super.key,
    required this.config,
    this.backgroundColor,
    this.loadingBuilder,
  });
  final PocketAppConfig config;
  final Color? backgroundColor;

  /// Replaces Pocket's startup presentation with host-owned rendering of the
  /// observed package/runtime progress. The default UI shows a loader only
  /// while a signed remote package is being prepared; local startup stays
  /// quiet until its first PocketView frame. Errors remain visible.
  final PocketLoadingBuilder? loadingBuilder;

  @override
  Widget build(BuildContext context) => _PocketGuestSession(
    key: ValueKey<String>(config.appId),
    config: config,
    backgroundColor: backgroundColor,
    loadingBuilder: loadingBuilder,
  );
}

@visibleForTesting
final class PocketGuestSession extends StatefulWidget {
  const PocketGuestSession({
    super.key,
    required this.config,
    this.session,
    this.onFirstFrame,
    this.hostSurfaceBuilder,
    this.hostSurfaceResidents = const {},
    this.inputEnabled = true,
    this.viewport,
    this.geometryRevision = 0,
    this.backgroundColor,
    this.compositorBounds,
    this.compositorViewport,
    this.preserveCompositorDisplayGeometry = false,
    this.enableSceneCapture = false,
    this.loadingBuilder,
  });
  final PocketAppConfig config;
  final PocketHostSurfaceBuilder? hostSurfaceBuilder;
  final Set<int> hostSurfaceResidents;
  final bool inputEnabled;
  final Size? viewport;
  final Color? backgroundColor;

  /// Increments when a compositor host surface moves or changes clip. The
  /// child PocketView uses this as a post-layout safe-area invalidation token;
  /// it is deliberately not a copied root inset or a second geometry state.
  final int geometryRevision;

  /// Parent compositor geometry used only for the child's environmental
  /// display reference. Physical slot bounds still control clipping/input.
  final Rect? compositorBounds;
  final Size? compositorViewport;
  final bool preserveCompositorDisplayGeometry;

  /// Adds PocketView's bounded capture boundary when an admitted capability
  /// needs the current rendered guest surface. Keep this off for ordinary
  /// surfaces so they do not allocate the extra render layer.
  final bool enableSceneCapture;

  /// Optional host-owned Flutter presentation for startup work. A supplied
  /// builder receives local and remote startup facts; the default UI only
  /// shows a loader during signed remote package preparation. Business state
  /// and app navigation remain in the guest.
  final PocketLoadingBuilder? loadingBuilder;

  /// Optional host-owned Session.  When supplied, this widget only attaches
  /// its PocketView and never disposes the Session.
  final PocketSession? session;

  /// Called after the real PocketView reports its first ready frame.
  final VoidCallback? onFirstFrame;

  @override
  State<PocketGuestSession> createState() => PocketGuestSessionState();
}

typedef _PocketGuestSession = PocketGuestSession;

@visibleForTesting
final class PocketGuestSessionState extends State<PocketGuestSession> {
  late PocketSession session;
  bool _ownsSession = false;
  Object? startupError;

  @override
  void initState() {
    super.initState();
    _startSession();
  }

  void _startSession() {
    final supplied = widget.session;
    final created = supplied ?? PocketSession(config: widget.config);
    final ownsCreated = supplied == null;
    _ownsSession = ownsCreated;
    session = created;
    created.addListener(_changed);
    unawaited(
      created.initialize().catchError((Object error) {
        created.removeListener(_changed);
        if (ownsCreated) created.dispose();
        if (mounted && identical(session, created)) {
          setState(() => startupError = error);
        }
      }),
    );
  }

  @override
  void didUpdateWidget(covariant PocketGuestSession oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.config != widget.config ||
        !identical(oldWidget.session, widget.session)) {
      session.removeListener(_changed);
      if (_ownsSession) session.dispose();
      startupError = null;
      _startSession();
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    session.removeListener(_changed);
    if (_ownsSession) session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final error = startupError ?? session.failure;
    final content = _buildContent(context);
    final backgroundColor = widget.backgroundColor;
    // PocketView owns the single backing layer once its real surface exists.
    // Before that point, keep startup and failure states opaque here as well;
    // otherwise the pre-surface Center would expose the surrounding host scene.
    if (backgroundColor == null || (session.ready && error == null)) {
      return content;
    }
    return ColoredBox(color: backgroundColor, child: content);
  }

  Widget _buildContent(BuildContext context) {
    final config = widget.config;
    final error = startupError ?? session.failure;
    final epoch = session.generation;
    if (error != null) {
      final background = widget.backgroundColor;
      return Center(
        child: SelectableText(
          'Pocket 启动失败：$error',
          style: background == null
              ? null
              : TextStyle(
                  color: background.computeLuminance() > 0.179
                      ? Colors.black
                      : Colors.white,
                ),
        ),
      );
    }
    if (!session.ready) {
      final progress = session.transferProgress;
      final background = widget.backgroundColor;
      final loadingBuilder = widget.loadingBuilder;
      if (loadingBuilder != null) {
        return loadingBuilder(
          context,
          PocketStartupProgress(
            stage: PocketStartupStage.preparingPackage,
            packageStage: session.stage,
            downloadedBytes: progress?.downloadedBytes,
            totalBytes: progress?.totalBytes,
            packagePreparationStage: progress?.preparationProgress?.stage.name,
            packageProcessedBytes:
                progress?.preparationProgress?.processedBytes,
            packageProcessingTotalBytes:
                progress?.preparationProgress?.totalBytes,
            packageProcessedFiles:
                progress?.preparationProgress?.processedFiles,
            packageProcessingTotalFiles:
                progress?.preparationProgress?.totalFiles,
          ),
        );
      }
      if (!session.remotePackagePreparationInProgress) {
        return const SizedBox.expand();
      }
      return PocketStartupIndicator(
        stage: session.stage,
        preparationProgress: progress?.preparationProgress,
        downloadedBytes: progress?.downloadedBytes,
        totalBytes: progress?.totalBytes,
        foregroundColor: background == null
            ? null
            : background.computeLuminance() > 0.179
            ? Colors.black
            : Colors.white,
      );
    }
    return PocketView(
      key: ValueKey(epoch),
      controller: session.controller,
      recordingFactory: config.recordingFactory,
      memoryLimits: session.memoryLimits,
      active: session.foreground,
      inputEnabled: widget.inputEnabled,
      enableSceneCapture: widget.enableSceneCapture,
      keyboardInputEnabled: config.keyboardInputEnabled,
      keyboardAutofocus: config.keyboardAutofocus,
      rawTextInputEnabled: config.rawTextInputEnabled,
      textLayoutCacheCapacity: config.textLayoutCacheCapacity,
      keyboardButtonMap: config.keyboardButtonMap,
      backgroundColor: widget.backgroundColor,
      viewport: widget.viewport,
      geometryRevision: widget.geometryRevision,
      compositorBounds: widget.compositorBounds,
      compositorViewport: widget.compositorViewport,
      preserveCompositorDisplayGeometry:
          widget.preserveCompositorDisplayGeometry,
      hostSurfaceBuilder: widget.hostSurfaceBuilder,
      hostSurfaceResidents: widget.hostSurfaceResidents,
      loadingBuilder: widget.loadingBuilder,
      compositorSurfaces: config.compositorSurfaces,
      workerProgram: session.workerProgram,
      offloadProviderFactory: config.offloadProviderFactory,
      tickHz: session.tickHz,
      fontFamilyFallback: config.fontFamilyFallback,
      bytecodeAsset: config.bytecodeAsset,
      bytecodeMetadataAsset: config.metadataAsset,
      pakAsset: config.pakAsset,
      showDebugFps: config.showFps,
      packageSource: session.active?.source,
      initialEvents: session.initialEvents,
      onPerformanceSample: (sample) {
        if (epoch == session.generation) session.onPerformanceSample(sample);
      },
      onReady: (controller) {
        if (epoch == session.generation) {
          session.onReady(controller);
          widget.onFirstFrame?.call();
        }
      },
      onEvent: (event) {
        if (epoch == session.generation) session.onEvent(event);
      },
      onError: (error) {
        if (epoch == session.generation) unawaited(session.onError(error));
      },
    );
  }
}
