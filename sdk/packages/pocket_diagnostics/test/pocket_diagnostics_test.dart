import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show
        ErrorDescription,
        FlutterError,
        FlutterErrorDetails,
        PlatformDispatcher;
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_diagnostics/pocket_diagnostics.dart';

void main() {
  group('pocket_diagnostics normalization & schema', () {
    test(
      'normalizes nested causes, circular objects, and Flutter/Platform errors',
      () {
        final rootCause = FormatException('bad token at line 4');
        final midError = _ErrorWithCause(
          'MidFailure',
          'parse failed',
          rootCause,
        );
        final topError = _ErrorWithCause('TopFailure', 'load failed', midError);

        final normalized = normalizeDiagnosticError(topError);
        expect(normalized.name, 'TopFailure');
        expect(normalized.message, 'load failed');
        expect(normalized.cause, isNotNull);
        expect(normalized.cause!.name, 'MidFailure');
        expect(normalized.cause!.cause, isNotNull);
        expect(normalized.cause!.cause!.name, 'FormatException');
        expect(
          normalized.cause!.cause!.message,
          contains('bad token at line 4'),
        );

        final cyclicMap = <String, Object?>{'a': 1};
        cyclicMap['self'] = cyclicMap;
        final normalizedData =
            normalizeDiagnosticData(<String, Object?>{
                  'nested': cyclicMap,
                  'list': List<int>.generate(120, (i) => i),
                })
                as Map<String, Object?>?;
        expect(normalizedData, isNotNull);
        final nested = normalizedData!['nested']! as Map<String, Object?>;
        expect(nested['self'], '[Circular]');
        final list = normalizedData['list']! as List<Object?>;
        expect(list.length, defaultMaxArrayLength + 1);
        expect(list.last, '... [56 more items]');

        final platformErr = PlatformException(
          code: 'E_IO',
          message: 'disk full',
          details: <String, Object?>{'freeBytes': 0},
        );
        final normPlatform = normalizeDiagnosticError(platformErr);
        expect(normPlatform.name, 'PlatformException');
        expect(normPlatform.code, 'E_IO');
        expect(normPlatform.message, 'disk full');
        expect(normPlatform.details, <String, Object?>{
          'details': <String, Object?>{'freeBytes': 0},
        });

        final flutterDetails = FlutterErrorDetails(
          exception: StateError('widget unmounted'),
          library: 'widgets library',
          context: ErrorDescription('while building MyWidget'),
        );
        final normFlutter = normalizeDiagnosticError(flutterDetails);
        expect(normFlutter.name, 'StateError');
        expect(normFlutter.message, contains('widget unmounted'));
        expect(normFlutter.details, isA<Map<String, Object?>>());
      },
    );

    test('DiagnosticRecord round-trips the canonical JS schema', () async {
      final collector = createDiagnosticsCollector(
        context: const DiagnosticContext(
          source: 'pocket.test',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          runtimeId: 'rt-1',
          revision: 7,
        ),
      );

      final log = await collector.recordLog(
        const DiagnosticLogInput(
          severity: DiagnosticSeverity.warn,
          tag: 'boot',
          message: 'slow asset decode',
          durationMs: 42.5,
          data: <String, Object?>{'asset': 'hero.png'},
        ),
      );

      expect(log.schemaVersion, diagnosticsSchemaVersion);
      expect(log.kind, DiagnosticRecordKind.log);
      expect(log.severity, DiagnosticSeverity.warn);
      expect(log.context.projectId, 'proj-1');
      expect(log.context.sessionId, 'sess-1');
      expect(log.context.runtimeId, 'rt-1');
      expect(log.context.revision, 7);

      final crash = await collector.recordCrash(
        StateError('fatal render fault'),
        const DiagnosticCrashInput(tag: 'session.error', unhandled: true),
      );
      expect(crash.kind, DiagnosticRecordKind.crash);
      expect(crash.severity, DiagnosticSeverity.fatal);
      expect(crash.recentLogIds, contains(log.id));
      expect(crash.error.message, contains('fatal render fault'));

      final jsonMap = crash.toJson();
      expect(jsonMap['schemaVersion'], 1);
      expect(jsonMap['kind'], 'crash');
      final roundTrip = DiagnosticRecord.tryFromJson(jsonMap);
      expect(roundTrip, isA<DiagnosticCrashRecord>());
      expect(roundTrip!.id, crash.id);
    });
  });

  group('FileDiagnosticsStorage durable JSONL persistence', () {
    late Directory tempDir;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('pocket_diag_test_');
    });

    tearDown(() async {
      if (tempDir.existsSync()) {
        await tempDir.delete(recursive: true);
      }
    });

    test(
      'persists logs and crashes to disk and reopens across instances',
      () async {
        final first = createFileDiagnostics(
          directory: tempDir,
          context: const DiagnosticContext(
            source: 'pocket.host',
            projectId: 'demo.app',
            sessionId: 'guest-0',
            runtimeId: 'demo.app',
            revision: 'rev-1',
          ),
        );

        final log1 = await first.info(
          'session ready',
          const DiagnosticLogInput(
            message: 'session ready',
            tag: 'session.ready',
          ),
        );
        final log2 = await first.warn(
          'frame spike',
          const DiagnosticLogInput(
            message: 'frame spike',
            tag: 'session.perf',
            durationMs: 38,
          ),
        );
        final crash = await first.recordCrash(
          StateError('guest JS unhandled trap'),
          const DiagnosticCrashInput(
            tag: 'session.error',
            unhandled: true,
            data: <String, Object?>{'stage': 'ready'},
          ),
        );
        await first.close();

        expect(File(first.journalPath).existsSync(), isTrue);

        final reopened = createFileDiagnostics(directory: tempDir);
        final records = await reopened.listRecords();
        expect(records.length, 3);
        expect(records[0].id, log1.id);
        expect(records[1].id, log2.id);
        expect(records[2].id, crash.id);

        final crashes = await reopened.listCrashes();
        expect(crashes.length, 1);
        expect(
          crashes.single.error.message,
          contains('guest JS unhandled trap'),
        );
        expect(crashes.single.recentLogIds, <String>[log1.id, log2.id]);

        final recentForCrash = await reopened.getCrashRecentLogs(crash.id);
        expect(recentForCrash.map((r) => r.id).toList(), <String>[
          log1.id,
          log2.id,
        ]);

        final bundle = await reopened.exportRecords();
        expect(bundle.format, 'pocket-diagnostics-export');
        expect(bundle.schemaVersion, 1);
        expect(bundle.totalRecords, 3);
        expect(bundle.logCount, 2);
        expect(bundle.crashCount, 1);

        final rawJson = await reopened.exportJson(pretty: true);
        final decoded = jsonDecode(rawJson) as Map<String, Object?>;
        expect(decoded['format'], 'pocket-diagnostics-export');
        await reopened.close();
      },
    );

    test('heals truncated/corrupt trailing JSONL lines on reopen', () async {
      final first = createFileDiagnostics(directory: tempDir);
      final validLog = await first.info('persisted before power loss');
      await first.close();

      final journalFile = File(first.journalPath);
      await journalFile.writeAsString(
        '{"schemaVersion":1,"id":"broken","kind":"crash","timestamp":',
        mode: FileMode.append,
        flush: true,
      );

      final reopened = createFileDiagnostics(directory: tempDir);
      final records = await reopened.listRecords();
      expect(records.length, 1);
      expect(records.single.id, validLog.id);

      final afterLog = await reopened.info('persisted after recovery');
      await reopened.flush();
      final lines = await journalFile.readAsLines().then(
        (l) => l.where((s) => s.trim().isNotEmpty).toList(),
      );
      expect(lines.length, 2);
      final parsedSecond = jsonDecode(lines[1]) as Map<String, Object?>;
      expect(parsedSecond['id'], afterLog.id);
      await reopened.close();
    });

    test('rotates bounded JSONL files and enforces maxRecords', () async {
      final diag = createFileDiagnostics(
        directory: tempDir,
        maxFileBytes: 1024,
        maxRotatedFiles: 2,
        maxRecords: 8,
      );

      for (var i = 0; i < 20; i++) {
        await diag.info(
          'entry-$i-${'x' * 90}',
          DiagnosticLogInput(
            message: 'entry-$i-${'x' * 90}',
            projectId: i.isEven ? 'app-even' : 'app-odd',
          ),
        );
      }
      await diag.flush();

      final rotated1 = File('${diag.journalPath}.1');
      expect(rotated1.existsSync(), isTrue);

      final listed = await diag.listRecords();
      expect(listed.length, lessThanOrEqualTo(8));
      expect(listed.last.message, startsWith('entry-19-'));

      // Selective clear by projectId
      await diag.clear(const DiagnosticClearFilter(projectId: 'app-even'));
      final remaining = await diag.listRecords();
      expect(remaining.every((r) => r.projectId == 'app-odd'), isTrue);
      await diag.close();
    });

    test(
      'serializes concurrent writes without interleaving corruption',
      () async {
        final diag = createFileDiagnostics(directory: tempDir, maxRecords: 100);
        await Future.wait(
          List<Future<DiagnosticRecord>>.generate(
            25,
            (i) => i % 5 == 0
                ? diag.recordCrash(StateError('crash-$i'))
                : diag.info('log-$i'),
          ),
        );
        await diag.close();

        final verify = createFileDiagnostics(
          directory: tempDir,
          maxRecords: 100,
        );
        final records = await verify.listRecords();
        expect(records.length, 25);
        await verify.close();
      },
    );

    test('rejects symlinked diagnostics directory', () async {
      final realDir = Directory('${tempDir.path}/real')..createSync();
      final linkDir = Link('${tempDir.path}/linked')..createSync(realDir.path);
      final diag = createFileDiagnostics(directory: Directory(linkDir.path));
      await expectLater(
        diag.info('should fail on symlink'),
        throwsA(isA<FileSystemException>()),
      );
    });
  });

  group('attachFlutterErrorCollector opt-in error handler chaining', () {
    test(
      'flushes crash before handing an unhandled error back to the engine',
      () async {
        final dispatcher = PlatformDispatcher.instance;
        final previous = dispatcher.onError;
        final directory = await Directory.systemTemp.createTemp(
          'pocket_fatal_handoff_',
        );
        final diagnostics = createFileDiagnostics(directory: directory);
        var persistedAtHandoff = false;
        dispatcher.onError = (error, stack) {
          final journal = File(diagnostics.journalPath);
          persistedAtHandoff =
              journal.existsSync() &&
              journal.readAsStringSync().contains('fatal handoff regression');
          return false;
        };
        final handle = attachFlutterErrorCollector(
          collector: diagnostics,
          captureFlutterErrors: false,
        );
        try {
          expect(
            dispatcher.onError!(
              StateError('fatal handoff regression'),
              StackTrace.current,
            ),
            isFalse,
          );
          expect(
            persistedAtHandoff,
            isTrue,
            reason:
                'The engine may terminate immediately after an unhandled callback returns.',
          );
        } finally {
          handle.detach();
          dispatcher.onError = previous;
          await diagnostics.close();
          await directory.delete(recursive: true);
        }
      },
    );

    test(
      'chains FlutterError.onError and PlatformDispatcher.onError preserving return semantics',
      () async {
        final originalFlutterOnError = FlutterError.onError;
        final dispatcher = PlatformDispatcher.instance;
        final originalDispatcherOnError = dispatcher.onError;

        addTearDown(() {
          FlutterError.onError = originalFlutterOnError;
          dispatcher.onError = originalDispatcherOnError;
        });

        final tempDir = await Directory.systemTemp.createTemp(
          'pocket_flutter_err_',
        );
        addTearDown(() async {
          if (tempDir.existsSync()) {
            await tempDir.delete(recursive: true);
          }
        });

        final diag = createFileDiagnostics(
          directory: tempDir,
          context: const DiagnosticContext(
            source: 'pocket.host',
            projectId: 'pocket.host.demo',
            sessionId: 'root',
          ),
        );

        final chainedFlutterCalls = <FlutterErrorDetails>[];
        FlutterError.onError = (FlutterErrorDetails details) {
          chainedFlutterCalls.add(details);
        };

        var dispatcherReturnValue = false;
        final chainedDispatcherCalls = <Object>[];
        dispatcher.onError = (Object error, StackTrace stack) {
          chainedDispatcherCalls.add(error);
          return dispatcherReturnValue;
        };

        final recordedCrashes = <DiagnosticCrashRecord>[];
        final recordedCompleter = Completer<void>();
        final handle = attachFlutterErrorCollector(
          collector: diag,
          onCrashRecorded: (record) {
            recordedCrashes.add(record);
            if (recordedCrashes.length == 3 && !recordedCompleter.isCompleted) {
              recordedCompleter.complete();
            }
          },
        );
        expect(handle.active, isTrue);

        // 1. Trigger FlutterError.onError
        final details = FlutterErrorDetails(
          exception: ArgumentError('invalid layout constraint'),
          stack: StackTrace.current,
          library: 'rendering library',
        );
        FlutterError.onError!(details);
        expect(chainedFlutterCalls.length, 1);
        expect(identical(chainedFlutterCalls.single, details), isTrue);

        // 2. Trigger PlatformDispatcher.onError when previous handler returns false (unhandled)
        dispatcherReturnValue = false;
        final handledFalse = dispatcher.onError!(
          StateError('unhandled async zone error'),
          StackTrace.current,
        );
        expect(handledFalse, isFalse);
        expect(chainedDispatcherCalls.length, 1);

        // 3. Trigger PlatformDispatcher.onError when previous handler returns true (handled)
        dispatcherReturnValue = true;
        final handledTrue = dispatcher.onError!(
          StateError('handled async error'),
          StackTrace.current,
        );
        expect(handledTrue, isTrue);
        expect(chainedDispatcherCalls.length, 2);

        await recordedCompleter.future.timeout(const Duration(seconds: 5));
        await diag.flush();

        final persistedCrashes = await diag.listCrashes();
        expect(persistedCrashes.length, 3);
        expect(persistedCrashes[0].tag, 'FlutterError.onError');
        expect(
          persistedCrashes[0].error.message,
          contains('invalid layout constraint'),
        );
        expect(persistedCrashes[1].tag, 'PlatformDispatcher.onError');
        expect(
          persistedCrashes[1].error.message,
          contains('unhandled async zone error'),
        );

        // Detach restores exact previous handlers
        handle.detach();
        expect(handle.active, isFalse);
        FlutterError.onError!(details);
        expect(chainedFlutterCalls.length, 2);
        await diag.close();
      },
    );
  });
}

final class _ErrorWithCause implements Exception {
  _ErrorWithCause(this.name, this.message, [this.cause]);

  final String name;
  final String message;
  final Object? cause;

  @override
  String toString() => '$name: $message';
}
