import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _LifecycleProvider implements PocketOffloadProvider {
  _LifecycleProvider({this.onExecute});

  final Future<String> Function(
    PocketOffloadRequest request,
    PocketOffloadCancellationToken cancellation,
  )?
  onExecute;
  bool closeCalled = false;
  final List<PocketOffloadRequest> cancellations = <PocketOffloadRequest>[];

  @override
  int get session => 17;

  @override
  Set<String> get methods => const <String>{'compute.sum'};

  @override
  Future<String> execute(
    PocketOffloadRequest request,
    PocketOffloadCancellationToken cancellation,
  ) =>
      onExecute?.call(request, cancellation) ??
      Future<String>.value('unexpected request');

  @override
  void cancel(PocketOffloadRequest request) => cancellations.add(request);

  @override
  Future<void> close() async {
    closeCalled = true;
  }
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  test(
    'offload binding configures before use and closes its provider before native teardown',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      addTearDown(runtime.dispose);
      final provider = _LifecycleProvider();
      var wakeCalls = 0;
      runtime.configureOffload(provider, onWake: () => wakeCalls++);
      expect(provider.closeCalled, isFalse);
      expect(wakeCalls, 0);

      runtime.dispose();
      expect(provider.closeCalled, isTrue);
      expect(provider.cancellations, isEmpty);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'dispatches a submitted native request and wakes the host after completion',
    () async {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      addTearDown(runtime.dispose);
      final firstDispatched = Completer<PocketOffloadRequest>();
      final secondDispatched = Completer<PocketOffloadRequest>();
      final completed = Completer<void>();
      final provider = _LifecycleProvider(
        onExecute: (request, cancellation) async {
          if (request.id == 1) {
            firstDispatched.complete(request);
            return '3';
          }
          secondDispatched.complete(request);
          await cancellation.whenCancelled;
          throw const PocketOffloadCancelled();
        },
      );
      runtime.configureOffload(
        provider,
        onWake: () {
          if (!completed.isCompleted) completed.complete();
        },
      );

      runtime.eval('''
        globalThis.offload.submit(JSON.stringify({
          v: 1,
          id: 1,
          method: 'compute.sum',
          payload: '[1,2]'
        }));
        globalThis.offload.submit(JSON.stringify({
          v: 1,
          id: 2,
          method: 'compute.sum',
          payload: '[4,5]'
        }));
      ''');

      final request = await firstDispatched.future.timeout(
        const Duration(seconds: 2),
      );
      expect(request.key.generation, 1);
      expect(request.key.session, 17);
      expect(request.key.id, 1);
      expect(request.method, 'compute.sum');
      expect(request.payload, '[1,2]');
      final pendingRequest = await secondDispatched.future.timeout(
        const Duration(seconds: 2),
      );
      expect(pendingRequest.key.id, 2);
      await completed.future.timeout(const Duration(seconds: 2));
      runtime.dispose();
      expect(provider.closeCalled, isTrue);
      expect(provider.cancellations.single.key.id, 2);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'records provider offload facts and replays repeatedly without the provider',
    () async {
      final controller = PocketRecordingController(retainReplayAssets: true);
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 480,
        recording: controller,
      );
      addTearDown(runtime.dispose);

      final dispatched = Completer<PocketOffloadRequest>();
      final wake = Completer<void>();
      var providerCalls = 0;
      final provider = _LifecycleProvider(
        onExecute: (request, _) async {
          providerCalls++;
          if (!dispatched.isCompleted) dispatched.complete(request);
          return '5';
        },
      );
      runtime.configureOffload(
        provider,
        onWake: () {
          if (!wake.isCompleted) wake.complete();
        },
      );
      runtime.eval(r'''
        if (!offload.submit(JSON.stringify({
          v: 1,
          id: 1,
          method: 'compute.sum',
          payload: '[2,3]'
        }))) throw new Error('offload submit failed');
        globalThis.frame = () => {
          const reply = offload.take();
          if (reply) {
            pocket._emit(JSON.stringify({
              method: 'offload.result',
              params: JSON.parse(reply)
            }));
          }
        };
      ''');

      final request = await dispatched.future.timeout(
        const Duration(seconds: 5),
      );
      expect(request.method, 'compute.sum');
      expect(request.payload, '[2,3]');
      await wake.future.timeout(const Duration(seconds: 5));
      final frame = runtime.frameAt(0);
      expect(
        frame.events.any(
          (event) =>
              event.method == 'offload.result' &&
              event.params['payload'] == '5',
        ),
        isTrue,
      );

      runtime.dispose();
      expect(provider.closeCalled, isTrue);
      expect(providerCalls, 1);
      final recording = controller.recording!;
      expect(recording.incomplete, isFalse);
      expect(recording.entries.first.kind, 'offloadConfigure');
      expect(recording.entries.last.kind, 'asyncStop');
      final eventKinds = <String>{
        for (final entry in recording.entries)
          if (entry.result['traceClock'] case final Map trace)
            for (final event in (trace['offloadEvents'] as List? ?? const []))
              (event as Map)['kind'] as String,
      };
      expect(
        eventKinds,
        containsAll(<String>{
          'offload.submit',
          'offload.provider.take',
          'offload.provider.complete',
          'offload.reply.take',
          'offload.shutdown',
        }),
      );

      final assets = controller.replayAssets;
      for (var attempt = 0; attempt < 3; attempt++) {
        final replay = await replayPocketRecording(recording, assets: assets);
        expect(
          replay.matched,
          isTrue,
          reason: 'offline replay $attempt did not match: $replay',
        );
        expect(replay.firstMismatch, isNull);
      }
      expect(providerCalls, 1, reason: 'replay must not execute the provider');
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
