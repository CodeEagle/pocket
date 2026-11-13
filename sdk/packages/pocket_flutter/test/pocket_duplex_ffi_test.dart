import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter_test/flutter_test.dart';

typedef _CreateNative = Pointer<Void> Function(Double width, Double height);
typedef _CreateDart = Pointer<Void> Function(double width, double height);
typedef _EvalNative = Int32 Function(Pointer<Void>, Pointer<Utf8> source);
typedef _EvalDart = int Function(Pointer<Void>, Pointer<Utf8> source);
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);
typedef _EndpointAcquireNative = Pointer<Void> Function(Pointer<Void>);
typedef _EndpointAcquireDart = Pointer<Void> Function(Pointer<Void>);
typedef _EndpointReleaseNative = Void Function(Pointer<Void>);
typedef _EndpointReleaseDart = void Function(Pointer<Void>);
typedef _ReserveNative =
    Pointer<Uint8> Function(
      Pointer<Void>,
      Uint32 maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _ReserveDart =
    Pointer<Uint8> Function(
      Pointer<Void>,
      int maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _CommitNative = Int32 Function(Pointer<Void>, Uint32 count);
typedef _CommitDart = int Function(Pointer<Void>, int count);
typedef _StepNative = Int32 Function(Pointer<Void>);
typedef _StepDart = int Function(Pointer<Void>);
typedef _U32Native = Uint32 Function();
typedef _U32Dart = int Function();

/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  requireReal(libraryPath == null ? 'POCKET_NATIVE_LIBRARY is not set' : null);
  test(
    'native v2 retained endpoint publishes and drains without raw cursors',
    () {
      final library = DynamicLibrary.open(libraryPath!);
      final create = library.lookupFunction<_CreateNative, _CreateDart>(
        'pocket_create',
      );
      final eval = library.lookupFunction<_EvalNative, _EvalDart>(
        'pocket_eval',
      );
      final destroy = library.lookupFunction<_DestroyNative, _DestroyDart>(
        'pocket_destroy',
      );
      final acquire = library
          .lookupFunction<_EndpointAcquireNative, _EndpointAcquireDart>(
            'pocket_duplex_endpoint_acquire',
          );
      final release = library
          .lookupFunction<_EndpointReleaseNative, _EndpointReleaseDart>(
            'pocket_duplex_endpoint_release',
          );
      final reserve = library.lookupFunction<_ReserveNative, _ReserveDart>(
        'pocket_duplex_ingress_reserve',
      );
      final publish = library.lookupFunction<_CommitNative, _CommitDart>(
        'pocket_duplex_ingress_publish',
      );
      final peek = library.lookupFunction<_ReserveNative, _ReserveDart>(
        'pocket_duplex_egress_peek',
      );
      final consume = library.lookupFunction<_CommitNative, _CommitDart>(
        'pocket_duplex_egress_consume',
      );
      final step = library.lookupFunction<_StepNative, _StepDart>(
        'pocket_duplex_step',
      );
      final abiVersion = library.lookupFunction<_U32Native, _U32Dart>(
        'pocket_duplex_abi_version',
      );
      final messageSize = library.lookupFunction<_U32Native, _U32Dart>(
        'pocket_duplex_message_size',
      );
      final capacity = library.lookupFunction<_U32Native, _U32Dart>(
        'pocket_duplex_capacity',
      );
      expect(abiVersion(), 2);
      expect(messageSize(), 16);
      expect(capacity(), 255);

      final handle = create(360, 640);
      expect(handle.address, isNot(0));
      var endpoint = Pointer<Void>.fromAddress(0);
      final count = calloc<Uint32>();
      final egressCount = calloc<Uint32>();
      try {
        final source =
            "globalThis.__pocketDuplexEvent = function(type, flags, target, a0, a1) { pocket.duplex.emit(type + 1, flags, target, a0, a1); };"
                .toNativeUtf8(allocator: calloc);
        try {
          expect(eval(handle, source), 0);
        } finally {
          calloc.free(source);
        }

        endpoint = acquire(handle);
        expect(endpoint.address, isNot(0));
        // Native role claims, rather than a Dart bool, reject a duplicate
        // endpoint for this runtime generation.
        expect(acquire(handle).address, 0);

        final payload = reserve(endpoint, 1, count);
        expect(payload.address, isNot(0));
        expect(count.value, 1);
        final message = ByteData.sublistView(payload.asTypedList(16));
        message.setUint16(0, 20, Endian.little);
        message.setUint16(2, 0, Endian.little);
        message.setUint32(4, 42, Endian.little);
        message.setFloat32(8, 1.5, Endian.little);
        message.setFloat32(12, 2.5, Endian.little);
        expect(publish(endpoint, count.value), 1);
        expect(step(handle), 1);

        final output = peek(endpoint, 1, egressCount);
        expect(output.address, isNot(0));
        expect(egressCount.value, 1);
        final event = ByteData.sublistView(output.asTypedList(16));
        expect(event.getUint16(0, Endian.little), 21);
        expect(event.getUint32(4, Endian.little), 42);
        expect(consume(endpoint, 1), 1);
      } finally {
        calloc.free(count);
        calloc.free(egressCount);
        if (endpoint.address != 0) release(endpoint);
        destroy(handle);
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
