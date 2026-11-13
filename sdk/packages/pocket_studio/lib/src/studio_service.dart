import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'dart:ui' show AppExitResponse;

import 'studio_config.dart';

/// Thrown when the Studio service cannot be started or attached.
final class PocketStudioServiceException implements Exception {
  const PocketStudioServiceException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => 'PocketStudioServiceException($code): $message';
}

/// Host-side lifecycle helper: attach to a healthy editor service on the
/// configured loopback port or start one as a child process, wait for
/// `GET /health`, and stop it on exit if this host started it. It holds no
/// project state and is not reachable from the guest.
final class PocketStudioService {
  PocketStudioService(this.config, {this.pollInterval = const Duration(milliseconds: 200), this.stopOnExit = true});

  /// Registers an app-exit hook (needs an initialized Flutter binding).
  final bool stopOnExit;

  final PocketStudioConfig config;
  final Duration pollInterval;
  Process? _process;
  AppLifecycleListener? _listener;
  final List<String> _log = <String>[];
  bool _exited = false;

  bool get ownsProcess => _process != null;
  List<String> get recentLog => List<String>.unmodifiable(_log);

  /// Returns when the service answered `/health` with `ok`.
  Future<void> start() async {
    if (await _healthy()) return; // attach: never start a second service
    if (!config.autoStart) {
      throw const PocketStudioServiceException('service_unavailable', 'Studio service is not running and autoStart is off');
    }
    final sdk = config.sdkRoot;
    final project = config.projectRoot;
    if (sdk == null || project == null) {
      throw const PocketStudioServiceException('config_missing', 'sdkRoot and projectRoot are required to start the service');
    }
    final arguments = <String>[
      '$sdk/pocket.ts',
      'editor',
      project,
      '--port=${config.port}',
      '--update-host-version=${config.hostVersion}',
      '--provision-update-key',
      for (final root in config.extraProjectRoots) '--extra-project-root=$root',
      if (config.effectiveWorkspace != null) '--workspace=${config.effectiveWorkspace}',
    ];
    try {
      _process = await Process.start(
        config.bunExecutable,
        arguments,
        workingDirectory: sdk,
        environment: config.environment,
      );
    } on ProcessException catch (error) {
      throw PocketStudioServiceException('spawn_failed', 'cannot start ${config.bunExecutable}: ${error.message}');
    }
    final process = _process!;
    void collect(Stream<List<int>> stream) => stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          _log.add(line);
          if (_log.length > 50) _log.removeAt(0);
        }, onError: (_) {});
    collect(process.stdout);
    collect(process.stderr);
    unawaited(process.exitCode.then((_) => _exited = true));
    if (stopOnExit) {
      _listener = AppLifecycleListener(
      onExitRequested: () async {
        await stop();
        return AppExitResponse.exit;
      },
      );
    }
    final deadline = DateTime.now().add(config.startTimeout);
    while (DateTime.now().isBefore(deadline)) {
      if (_exited) {
        _process = null;
        throw PocketStudioServiceException('service_exited', 'Studio service exited during startup: ${_log.join(' | ')}');
      }
      if (await _healthy()) return;
      await Future<void>.delayed(pollInterval);
    }
    await stop();
    throw PocketStudioServiceException('start_timeout', 'Studio service was not healthy within ${config.startTimeout.inSeconds}s');
  }

  /// Stops the child process if (and only if) this helper started it.
  Future<void> stop() async {
    final process = _process;
    _process = null;
    _listener?.dispose();
    _listener = null;
    if (process == null || _exited) return;
    process.kill(ProcessSignal.sigterm);
    await process.exitCode.timeout(const Duration(seconds: 5), onTimeout: () {
      process.kill(ProcessSignal.sigkill);
      return -1;
    });
  }

  Future<bool> _healthy() async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 2)
      ..findProxy = ((_) => 'DIRECT');
    try {
      final request = await client.getUrl(config.origin.replace(path: '/health'));
      final response = await request.close().timeout(const Duration(seconds: 3));
      final body = await utf8.decodeStream(response);
      if (response.statusCode != 200) return false;
      final json = jsonDecode(body);
      return json is Map && json['ok'] == true && json['service'] == 'pocket-editor';
    } on Object {
      return false;
    } finally {
      client.close(force: true);
    }
  }
}
