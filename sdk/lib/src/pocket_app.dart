import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'pocket_config.dart';
import 'pocket_session.dart';

/// Standalone Flutter entry point. Its only page is the JS rendering surface.
/// Use [PocketGuest] inside an existing MaterialApp instead.
final class PocketApp extends StatelessWidget {
  const PocketApp({super.key, required this.config});
  final PocketAppConfig config;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    home: Scaffold(body: PocketGuest(config: config)),
  );
}

/// Embeddable SDK surface with verified bytecode/update/plugin lifetime.
///
/// Layout follows the parent constraints. Safe areas and reserved system
/// regions are sent to JS, which owns component layout and navigation.
final class PocketGuest extends StatelessWidget {
  const PocketGuest({super.key, required this.config});
  final PocketAppConfig config;

  @override
  Widget build(BuildContext context) =>
      _PocketGuestSession(key: ValueKey<String>(config.appId), config: config);
}

@visibleForTesting
final class PocketGuestSession extends StatefulWidget {
  const PocketGuestSession({super.key, required this.config});
  final PocketAppConfig config;
  @override
  State<PocketGuestSession> createState() => PocketGuestSessionState();
}

typedef _PocketGuestSession = PocketGuestSession;

@visibleForTesting
final class PocketGuestSessionState extends State<PocketGuestSession> {
  late PocketSession session;
  Object? startupError;

  @override
  void initState() {
    super.initState();
    _startSession();
  }

  void _startSession() {
    final created = PocketSession(config: widget.config);
    session = created;
    created.addListener(_changed);
    unawaited(
      created.initialize().catchError((Object error) {
        created.removeListener(_changed);
        created.dispose();
        if (mounted && identical(session, created)) {
          setState(() => startupError = error);
        }
      }),
    );
  }

  @override
  void didUpdateWidget(covariant PocketGuestSession oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.config != widget.config) {
      session.removeListener(_changed);
      session.dispose();
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
    session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    final error = startupError ?? session.failure;
    final epoch = session.generation;
    if (error != null)
      return Center(child: SelectableText('Pocket startup failed: $error'));
    if (!session.ready) return const Center(child: CircularProgressIndicator());
    return PocketView(
      key: ValueKey(epoch),
      controller: session.controller,
      bytecodeAsset: config.bytecodeAsset,
      pakAsset: config.pakAsset,
      showDebugFps: config.showFps,
      packageSource: session.active?.source,
      onPerformanceSample: (sample) {
        if (epoch == session.generation) session.onPerformanceSample(sample);
      },
      onReady: (controller) {
        if (epoch == session.generation) session.onReady(controller);
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
