import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _defaultCatalogAsset = 'assets/apps/official/catalog.json';
const _catalogAsset = String.fromEnvironment(
  'OFFICIAL_DEMOS_FPS_CATALOG_ASSET',
  defaultValue: _defaultCatalogAsset,
);
const _windowSecondsValue = String.fromEnvironment(
  'OFFICIAL_DEMOS_FPS_SECONDS',
  defaultValue: '3',
);
const _defaultWindowSeconds = 3;
const _buttonProbeMask = 0x80000000;

final class _OfficialDemo {
  const _OfficialDemo({
    required this.id,
    required this.title,
    required this.motion,
    required this.qjbcAsset,
    required this.pakAsset,
    required this.metadataAsset,
    required this.viewport,
    required this.auxiliaryViewport,
    required this.hasAuxiliaryCapability,
    required this.motionFromCatalog,
  });

  final String id;
  final String title;
  final String motion;
  final String qjbcAsset;
  final String pakAsset;
  final String metadataAsset;
  final Size? viewport;
  final Size? auxiliaryViewport;
  final bool hasAuxiliaryCapability;
  final bool motionFromCatalog;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('official demo Flutter host FPS acceptance', (tester) async {
    // Catalog and artifact reads use Flutter's staged asset bundle so the
    // macOS profile app does not depend on host filesystem sandbox access.
    // Catalog load/shape errors are harness errors; individual guest failures
    // are captured below so the full catalog still completes.
    final decoded = jsonDecode(await rootBundle.loadString(_catalogAsset));
    if (decoded is! Map || decoded['demos'] is! List) {
      throw const FormatException(
        'official demos FPS catalog must contain a demos array',
      );
    }

    final results = <Map<String, Object?>>[];
    final excluded = <Map<String, Object?>>[];
    final runnable = <_OfficialDemo>[];
    for (final raw in decoded['demos'] as List) {
      if (raw is! Map) {
        excluded.add(<String, Object?>{
          'status': 'excluded_invalid_catalog_entry',
          'reason': 'entry is not an object',
        });
        continue;
      }
      final entry = <String, Object?>{
        for (final item in raw.entries)
          if (item.key is String) item.key as String: item.value,
      };
      final id =
          _catalogString(entry, const ['id', 'name', 'title']) ??
          'entry-${excluded.length + runnable.length + 1}';
      if (entry['status'] != 'passed') {
        excluded.add(<String, Object?>{
          'id': id,
          'status': 'excluded_not_passed',
          'catalogStatus': entry['status'],
        });
        continue;
      }
      if (entry['launchability'] == 'platform_limited') {
        results.add(<String, Object?>{
          'id': id,
          'title': _catalogString(entry, const ['title']) ?? id,
          'motion': _motion(entry['motion']).$1,
          'status': 'skipped_platform_limited',
          'reason': entry['statusReason'] ??
              'Required host capabilities are not available in this Flutter build.',
        });
        continue;
      }

      final qjbcPath = _catalogString(entry, const [
        'qjbcAsset',
        'qjbcPath',
        'qjbc',
      ]);
      final pakPath = _catalogString(entry, const [
        'pakAsset',
        'pakPath',
        'pak',
      ]);
      final metadataPath = _catalogString(entry, const [
        'metadataAsset',
        'metadataPath',
        'metadata',
      ]);
      if (qjbcPath == null || pakPath == null || metadataPath == null) {
        excluded.add(<String, Object?>{
          'id': id,
          'status': 'excluded_missing_artifact_path',
        });
        continue;
      }
      late final String qjbcAsset;
      late final String pakAsset;
      late final String metadataAsset;
      try {
        qjbcAsset = _resolveAsset(qjbcPath, id);
        pakAsset = _resolveAsset(pakPath, id);
        metadataAsset = _resolveAsset(metadataPath, id);
      } on FormatException catch (error) {
        results.add(<String, Object?>{
          'id': id,
          'title': _catalogString(entry, const ['title']) ?? id,
          'motion': _motion(entry['motion']).$1,
          'status': 'failed',
          'error': _shortError(error),
        });
        continue;
      }

      final hasAuxiliaryCapability = _hasAuxiliaryCapability(
        entry['capabilities'],
      );
      final auxiliaryViewport = _catalogSize(entry['auxiliaryViewport']);
      if (hasAuxiliaryCapability && auxiliaryViewport == null) {
        results.add(<String, Object?>{
          'id': id,
          'title': _catalogString(entry, const ['title']) ?? id,
          'motion': _motion(entry['motion']).$1,
          'status': 'skipped_platform_limited',
          'reason': 'display.auxiliary requires auxiliaryViewport',
        });
        continue;
      }
      final (motion, motionFromCatalog) = _motion(entry['motion']);
      runnable.add(
        _OfficialDemo(
          id: id,
          title: _catalogString(entry, const ['title']) ?? id,
          motion: motion,
          qjbcAsset: qjbcAsset,
          pakAsset: pakAsset,
          metadataAsset: metadataAsset,
          viewport: _catalogSize(entry['viewport']),
          auxiliaryViewport: auxiliaryViewport,
          hasAuxiliaryCapability: hasAuxiliaryCapability,
          motionFromCatalog: motionFromCatalog,
        ),
      );
    }

    // Keep the small hero artifact as the first end-to-end smoke check while
    // preserving the source catalog order for every other guest.
    runnable.sort((a, b) {
      final aHero = a.id.toLowerCase() == 'hero' ? 0 : 1;
      final bHero = b.id.toLowerCase() == 'hero' ? 0 : 1;
      return aHero.compareTo(bHero);
    });
    if (runnable.isEmpty && results.isEmpty) {
      throw StateError(
        'official demos FPS catalog has no passed demos with all three artifacts',
      );
    }

    final windowSeconds = _positiveInt(
      _windowSecondsValue,
      fallback: _defaultWindowSeconds,
      minimum: 2,
      maximum: 20,
    );
    for (final demo in runnable) {
      results.add(await _measureDemo(tester, demo, windowSeconds));
    }

    final report = <String, Object?>{
      'schemaVersion': 1,
      'mode': 'profile',
      'catalogAsset': _catalogAsset,
      'windowSeconds': windowSeconds,
      'frameTimingMeaning':
          'Flutter FrameTiming pipeline cadence; physical compositor presents are not directly instrumented.',
      'guestTicksMeaning':
          'guestTicksPerSec counts PocketView ticker/native turns and is not physical present FPS.',
      'thresholdPolicy':
          'Only catalog motion=continuous demos are threshold-checked; static demos are reported as event-driven idle.',
      'thresholdRefreshCapHz': 60,
      'results': results,
      'excluded': excluded,
    };
    binding.reportData = <String, dynamic>{
      ...?binding.reportData,
      'officialDemosFps': report,
    };

    // This single line is the stable machine-readable stdout contract.
    // ignore: avoid_print
    print('OFFICIAL_DEMO_FPS ${jsonEncode(report)}');

    final failed = results.where((row) => row['status'] == 'failed').toList();
    expect(
      failed,
      isEmpty,
      reason: 'official demo FPS failures were recorded after the full run',
    );
  });
}

Future<Map<String, Object?>> _measureDemo(
  WidgetTester tester,
  _OfficialDemo demo,
  int windowSeconds,
) async {
  final result = <String, Object?>{
    'id': demo.id,
    'title': demo.title,
    'motion': demo.motion,
    'motionFromCatalog': demo.motionFromCatalog,
    'qjbcAsset': demo.qjbcAsset,
    'pakAsset': demo.pakAsset,
    'metadataAsset': demo.metadataAsset,
    'hasAuxiliaryCapability': demo.hasAuxiliaryCapability,
  };
  final controller = PocketViewController();
  final ready = Completer<void>();
  final firstRuntimeError = Completer<void>();
  final errors = <String>[];
  final timings = <FrameTiming>[];
  final pocketSamples = <PocketPerformanceSample>[];
  void timingCollector(List<FrameTiming> frames) => timings.addAll(frames);
  var registeredTimingCollector = false;
  var buttonsHeld = false;
  final sentInputs = <String>[];

  try {
    final qjbcBytes = await _loadAssetBytes(demo.qjbcAsset);
    final pakBytes = await _loadAssetBytes(demo.pakAsset);
    final metadataSource = await rootBundle.loadString(demo.metadataAsset);
    final metadata = PocketBytecodeMetadata.fromJsonString(metadataSource);
    if (metadata.bytecodeBytes != qjbcBytes.length) {
      throw FormatException(
        'metadata bytecodeBytes ${metadata.bytecodeBytes} does not match qjbc size ${qjbcBytes.length}',
      );
    }
    final viewport = demo.viewport ?? const Size(390, 760);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: viewport.width,
              height: viewport.height,
              child: PocketView(
                key: ValueKey<String>('official-demo-${demo.id}'),
                controller: controller,
                bytecodeBytes: qjbcBytes,
                bytecodeMetadata: metadataSource,
                pakBytes: pakBytes,
                viewport: demo.viewport,
                auxiliaryViewport: demo.hasAuxiliaryCapability
                    ? demo.auxiliaryViewport
                    : null,
                tickHz: metadata.tickHz,
                showDebugFps: false,
                onReady: (_) {
                  if (!ready.isCompleted) ready.complete();
                },
                onError: (error) {
                  errors.add(error.toString());
                  if (!firstRuntimeError.isCompleted) {
                    firstRuntimeError.complete();
                  }
                },
                onPerformanceSample: pocketSamples.add,
              ),
            ),
          ),
        ),
      ),
    );
    await Future.any<void>(<Future<void>>[
      ready.future,
      firstRuntimeError.future.then<void>(
        (_) => throw StateError('guest runtime error: ${errors.first}'),
      ),
    ]).timeout(const Duration(seconds: 30));
    // Ignore load settling but collect both engine timing and guest samples
    // while canonical input wakes the actual compiled guest.
    await Future<void>.delayed(const Duration(milliseconds: 250));
    SchedulerBinding.instance.addTimingsCallback(timingCollector);
    registeredTimingCollector = true;
    final clock = Stopwatch()..start();

    void send(String name, String method, Map<String, dynamic> params) {
      if (!controller.send(method: method, params: params)) {
        throw StateError('PocketView rejected canonical $method input');
      }
      sentInputs.add(name);
    }

    send('input.buttons.down', 'input.buttons', <String, dynamic>{
      'buttons': _buttonProbeMask,
    });
    buttonsHeld = true;
    final x = (viewport.width * .5).clamp(0.0, viewport.width - 1).toDouble();
    final y = (viewport.height * .70)
        .clamp(0.0, viewport.height - 1)
        .toDouble();
    send('input.pointer.down', 'input.pointer', <String, dynamic>{
      'phase': 'down',
      'id': 0,
      'x': x,
      'y': y,
    });
    send('input.pointer.move', 'input.pointer', <String, dynamic>{
      'phase': 'move',
      'id': 0,
      'x': (x + 4).clamp(0.0, viewport.width - 1).toDouble(),
      'y': (y - 4).clamp(0.0, viewport.height - 1).toDouble(),
    });
    send('input.pointer.up', 'input.pointer', <String, dynamic>{
      'phase': 'up',
      'id': 0,
      'x': (x + 4).clamp(0.0, viewport.width - 1).toDouble(),
      'y': (y - 4).clamp(0.0, viewport.height - 1).toDouble(),
    });

    final total = Duration(seconds: windowSeconds);
    final holdMs = math.min(1300, math.max(1000, windowSeconds * 500)).toInt();
    await Future<void>.delayed(Duration(milliseconds: holdMs));
    send('input.buttons.up', 'input.buttons', const <String, dynamic>{
      'buttons': 0,
    });
    buttonsHeld = false;
    final remaining = total - clock.elapsed;
    if (remaining > Duration.zero) await Future<void>.delayed(remaining);
    clock.stop();

    final refreshHz = tester.view.display.refreshRate;
    final timingStats = _timingStats(timings, refreshHz);
    final sampleFrames = pocketSamples
        .where((sample) => sample.durationMs > 0)
        .fold<int>(0, (total, sample) => total + sample.frames);
    final sampleDurationMs = pocketSamples
        .where((sample) => sample.durationMs > 0)
        .fold<double>(0, (total, sample) => total + sample.durationMs);
    final guestTicksPerSec = sampleDurationMs <= 0
        ? null
        : sampleFrames * 1000 / sampleDurationMs;
    final nativeP95Values = pocketSamples
        .where((sample) => sample.durationMs > 0)
        .map((sample) => sample.nativeMsP95)
        .toList();
    final slowFrames = pocketSamples.fold<int>(
      0,
      (total, sample) => total + sample.slowFrames,
    );
    final thresholdRefreshHz = math.min(_validRefreshRate(refreshHz), 60.0);
    final thresholdHz = thresholdRefreshHz * .75;
    final observedHz = timingStats['observedHz'] as double?;
    final enoughFrames = (timingStats['frames'] as int) >= 10;
    final thresholdPassed =
        demo.motion != 'continuous' ||
        (enoughFrames && observedHz != null && observedHz >= thresholdHz);

    result.addAll(<String, Object?>{
      'status': errors.isNotEmpty
          ? 'failed'
          : demo.motion == 'static'
          ? 'idle'
          : thresholdPassed
          ? 'passed'
          : 'failed',
      'classification': demo.motion == 'static'
          ? 'idle_event_driven'
          : 'continuous_animation',
      'refreshHz': refreshHz,
      'observedHz': observedHz,
      'frameTimingFrames': timingStats['frames'],
      'buildMsP95': timingStats['buildMsP95'],
      'rasterMsP95': timingStats['rasterMsP95'],
      'flutterSlowFrames': timingStats['slowFrames'],
      'slowFrames': slowFrames,
      'guestSampleCount': pocketSamples.length,
      'guestTicksPerSec': guestTicksPerSec,
      'guestTicksDisclaimer':
          'Guest ticks/s is PocketView ticker/native turns, not physical present FPS.',
      'nativeMsP95': nativeP95Values.isEmpty
          ? null
          : _percentile(nativeP95Values, .95),
      'continuousThresholdHz': demo.motion == 'continuous' ? thresholdHz : null,
      'continuousThresholdPassed': demo.motion == 'continuous'
          ? thresholdPassed
          : null,
      'sampleWindowMs': clock.elapsedMilliseconds,
      'inputSent': sentInputs,
      'guestPerformanceSamples': pocketSamples
          .map((sample) => sample.toJson())
          .toList(growable: false),
      if (errors.isNotEmpty) 'errors': errors,
    });
  } catch (error, stackTrace) {
    result.addAll(<String, Object?>{
      'status': 'failed',
      'classification': demo.motion == 'static'
          ? 'idle_event_driven'
          : 'continuous_animation',
      'error': _shortError(error),
      'stack': _shortError(stackTrace, limit: 2000),
      'inputSent': sentInputs,
      if (errors.isNotEmpty) 'runtimeErrors': errors,
    });
  } finally {
    if (buttonsHeld) {
      controller.send(
        method: 'input.buttons',
        params: const <String, dynamic>{'buttons': 0},
      );
    }
    if (registeredTimingCollector) {
      SchedulerBinding.instance.removeTimingsCallback(timingCollector);
    }
    try {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      final flutterException = tester.takeException();
      if (flutterException != null && result['status'] != 'failed') {
        result['status'] = 'failed';
        result['error'] = _shortError(flutterException);
      }
    } catch (error) {
      if (result['status'] != 'failed') {
        result['status'] = 'failed';
        result['error'] = 'teardown: ${_shortError(error)}';
      }
    }
  }

  if (errors.isNotEmpty) {
    result['status'] = 'failed';
    result['runtimeErrors'] = errors;
  }
  return result;
}

Map<String, Object?> _timingStats(List<FrameTiming> timings, double refreshHz) {
  final ordered = timings.toList()
    ..sort(
      (a, b) => a
          .timestampInMicroseconds(FramePhase.vsyncStart)
          .compareTo(b.timestampInMicroseconds(FramePhase.vsyncStart)),
    );
  final starts = ordered
      .map((frame) => frame.timestampInMicroseconds(FramePhase.vsyncStart))
      .where((timestamp) => timestamp > 0)
      .toList();
  final observedHz = starts.length < 2 || starts.last <= starts.first
      ? null
      : (starts.length - 1) * 1000000 / (starts.last - starts.first);
  final build = ordered
      .map((frame) => frame.buildDuration.inMicroseconds / 1000)
      .toList();
  final raster = ordered
      .map((frame) => frame.rasterDuration.inMicroseconds / 1000)
      .toList();
  final budgetMs = 1000 / _validRefreshRate(refreshHz);
  return <String, Object?>{
    'frames': ordered.length,
    'observedHz': observedHz,
    'buildMsP95': _nullablePercentile(build, .95),
    'rasterMsP95': _nullablePercentile(raster, .95),
    'slowFrames': ordered
        .where(
          (frame) =>
              frame.buildDuration.inMicroseconds / 1000 > budgetMs ||
              frame.rasterDuration.inMicroseconds / 1000 > budgetMs,
        )
        .length,
  };
}

double _validRefreshRate(double value) =>
    value.isFinite && value > 0 ? value : 60.0;

double? _nullablePercentile(List<double> values, double fraction) =>
    values.isEmpty ? null : _percentile(values, fraction);

double _percentile(List<double> values, double fraction) {
  final ordered = values.toList()..sort();
  final index = ((ordered.length - 1) * fraction).ceil();
  return ordered[index.clamp(0, ordered.length - 1).toInt()];
}

Future<Uint8List> _loadAssetBytes(String assetPath) async {
  final data = await rootBundle.load(assetPath);
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

String _resolveAsset(String path, String id) {
  final normalized = path.trim().replaceAll('\\', '/');
  if (normalized.isEmpty ||
      normalized.startsWith('/') ||
      RegExp(r'^[A-Za-z]:/').hasMatch(normalized)) {
    throw FormatException('artifact path must be a Flutter asset key: $path');
  }
  final parts = normalized.split('/').where((part) => part.isNotEmpty).toList();
  if (parts.contains('..')) {
    throw FormatException(
      'artifact asset path cannot traverse directories: $path',
    );
  }
  if (parts.isEmpty) {
    throw FormatException('artifact asset path is empty: $path');
  }
  final cleanPath = parts.where((part) => part != '.').join('/');
  if (cleanPath.startsWith('assets/')) return cleanPath;
  if (cleanPath.startsWith('apps/official/')) return 'assets/$cleanPath';

  // The build catalog historically stores paths relative to its output root
  // (`demos/<id>/...`). The asset stager places those files directly under
  // `assets/apps/official/<id>/...`; already staged relative paths remain valid.
  final demoRelative = cleanPath.startsWith('demos/')
      ? cleanPath.substring('demos/'.length)
      : cleanPath;
  final guestRelative = demoRelative.startsWith('$id/')
      ? demoRelative
      : '$id/$demoRelative';
  return 'assets/apps/official/$guestRelative';
}

String? _catalogString(Map<String, Object?> entry, List<String> keys) {
  for (final key in keys) {
    final value = entry[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

(String, bool) _motion(Object? value) {
  if (value == 'continuous') return ('continuous', true);
  if (value == 'static') return ('static', true);
  // Unknown/missing catalog annotation is conservatively event-driven. It
  // never receives an animation FPS floor without explicit evidence.
  return ('static', false);
}

Size? _catalogSize(Object? value) {
  double? dimension(Object? raw) =>
      raw is num && raw.isFinite ? raw.toDouble() : null;
  double? width;
  double? height;
  if (value is Map) {
    width = dimension(value['width']);
    height = dimension(value['height']);
  } else if (value is List && value.length >= 2) {
    width = dimension(value[0]);
    height = dimension(value[1]);
  }
  if (width == null || height == null || width <= 0 || height <= 0) {
    return null;
  }
  return Size(width, height);
}

bool _hasAuxiliaryCapability(Object? capabilities) {
  if (capabilities is Iterable) {
    return capabilities.any((item) => item == 'display.auxiliary');
  }
  if (capabilities is! Map) return false;
  if (capabilities['display.auxiliary'] == true) return true;
  final display = capabilities['display'];
  return display is Map &&
      (display['auxiliary'] == true || display['auxiliary'] == 1);
}

int _positiveInt(
  String? value, {
  required int fallback,
  required int minimum,
  required int maximum,
}) {
  final parsed = int.tryParse(value ?? '');
  if (parsed == null) return fallback;
  return parsed.clamp(minimum, maximum).toInt();
}

String _shortError(Object error, {int limit = 1200}) {
  final value = error.toString();
  return value.length <= limit ? value : '${value.substring(0, limit)}…';
}
