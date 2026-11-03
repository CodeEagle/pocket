import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('explicit in-memory channel uses reservation protocol', () {
    final channel = PocketDuplexChannel.inMemory();
    expect(channel.isNativeZeroCopy, isFalse);
    expect(
      channel.pushToPocketJs(
        msgType: 10,
        flags: 2,
        targetId: 101,
        arg0: 1.25,
        arg1: -0.5,
      ),
      isTrue,
    );
    expect(
      channel.pushBatch(const [
        PocketDuplexMessage(msgType: 11, targetId: 102),
        PocketDuplexMessage(msgType: 12, targetId: 103),
      ]),
      2,
    );
    expect(channel.isClosed, isFalse);
  });

  test(
    'native endpoint writes and drains payload without exposing cursors',
    () {
      final endpoint = _FakeEndpoint(native: true);
      final runtime = _FakeRuntime(endpoint);
      final channel = PocketDuplexChannel.fromRuntime(runtime);
      expect(channel.isNativeZeroCopy, isTrue);
      expect(
        channel.pushBatch(const [
          PocketDuplexMessage(msgType: 10, targetId: 101, arg0: 1.25),
          PocketDuplexMessage(msgType: 11, targetId: 102, arg0: 2.5),
        ]),
        2,
      );
      expect(endpoint.published, [2]);

      endpoint.seedEgress(
        const PocketDuplexMessage(msgType: 20, targetId: 202),
      );
      endpoint.seedEgress(
        const PocketDuplexMessage(msgType: 21, targetId: 203),
      );
      final events = channel.drainFromPocketJs(maxBatch: 2);
      expect(events.map((event) => event.msgType), [20, 21]);
      expect(endpoint.consumed, [2]);
      expect(channel.step(), 3);
      expect(runtime.stepCalls, 1);
    },
  );

  test('64-message batch uses one reserve and one publish', () {
    final endpoint = _FakeEndpoint(native: true);
    final channel = PocketDuplexChannel.fromRuntime(_FakeRuntime(endpoint));
    final messages = List<PocketDuplexMessage>.generate(
      64,
      (index) => PocketDuplexMessage(msgType: 1, targetId: index),
      growable: false,
    );

    expect(channel.pushBatch(messages), 64);
    expect(endpoint.reserveCalls, 1);
    expect(endpoint.published, [64]);
  });

  test('successful nonempty ingress publication notifies once', () {
    final endpoint = _FakeEndpoint(native: true);
    var wakeCalls = 0;
    final channel = PocketDuplexChannel.fromRuntime(
      _FakeRuntime(endpoint),
      onIngressPublished: () => wakeCalls++,
    );

    expect(channel.pushToPocketJs(msgType: 10, targetId: 101), isTrue);
    expect(wakeCalls, 1);
    expect(channel.pushBatch(const []), 0);
    expect(wakeCalls, 1);

    endpoint.ingressUnavailable = true;
    expect(channel.pushToPocketJs(msgType: 11, targetId: 102), isFalse);
    expect(
      channel.pushBatch(const [
        PocketDuplexMessage(msgType: 12, targetId: 103),
      ]),
      0,
    );
    expect(wakeCalls, 1);

    endpoint.ingressUnavailable = false;
    expect(
      channel.pushBatch(const [
        PocketDuplexMessage(msgType: 13, targetId: 104),
      ]),
      1,
    );
    expect(wakeCalls, 2);
  });

  test('native runtime without atomic endpoint cannot silently fall back', () {
    expect(
      () => PocketDuplexChannel.fromRuntime(_FakeRuntime(null)),
      throwsA(isA<UnsupportedError>()),
    );
    final explicit = PocketDuplexChannel.inMemory();
    expect(explicit.isNativeZeroCopy, isFalse);
  });

  test('channel closes and rejects stale endpoint after runtime dispose', () {
    final endpoint = _FakeEndpoint(native: true);
    final runtime = _FakeRuntime(endpoint);
    final channel = PocketDuplexChannel.fromRuntime(runtime);
    runtime.alive = false;
    expect(
      () => channel.pushToPocketJs(msgType: 1, targetId: 1),
      throwsA(isA<StateError>()),
    );
    expect(channel.isClosed, isTrue);
    expect(endpoint.closed, isTrue);
  });

  test('invalid scalar fields are rejected before reservation', () {
    final endpoint = _FakeEndpoint(native: true);
    final channel = PocketDuplexChannel.fromRuntime(_FakeRuntime(endpoint));
    expect(
      () => channel.pushToPocketJs(msgType: 0x10000, targetId: 1),
      throwsA(isA<RangeError>()),
    );
    expect(endpoint.reserveCalls, 0);
  });

  test(
    'publish failure closes channel so a native reservation cannot linger',
    () {
      final endpoint = _FakeEndpoint(native: true)
        ..publishFailure = StateError('publish failed');
      var wakeCalls = 0;
      final channel = PocketDuplexChannel.fromRuntime(
        _FakeRuntime(endpoint),
        onIngressPublished: () => wakeCalls++,
      );

      expect(
        () => channel.pushToPocketJs(msgType: 1, targetId: 1),
        throwsA(isA<StateError>()),
      );
      expect(channel.isClosed, isTrue);
      expect(endpoint.closed, isTrue);
      expect(wakeCalls, 0);
    },
  );

  test('wake callback errors do not close committed ingress', () {
    final endpoint = _FakeEndpoint(native: true);
    final previousErrorHandler = FlutterError.onError;
    Object? reportedError;
    FlutterError.onError = (details) {
      reportedError = details.exception;
    };
    try {
      final channel = PocketDuplexChannel.fromRuntime(
        _FakeRuntime(endpoint),
        onIngressPublished: () => throw StateError('wake failed'),
      );

      expect(channel.pushToPocketJs(msgType: 10, targetId: 101), isTrue);
      expect(endpoint.published, [1]);
      expect(channel.isClosed, isFalse);
      expect(reportedError, isA<StateError>());
    } finally {
      FlutterError.onError = previousErrorHandler;
    }
  });

  test('consume failure closes channel after an egress peek', () {
    final endpoint = _FakeEndpoint(native: true)
      ..consumeFailure = StateError('consume failed');
    endpoint.seedEgress(const PocketDuplexMessage(msgType: 3, targetId: 9));
    final channel = PocketDuplexChannel.fromRuntime(_FakeRuntime(endpoint));

    expect(() => channel.drainFromPocketJs(), throwsA(isA<StateError>()));
    expect(channel.isClosed, isTrue);
    expect(endpoint.closed, isTrue);
  });
}

final class _FakeRuntime implements PocketBinaryDuplexRuntime {
  _FakeRuntime(this.duplexEndpoint);

  @override
  final PocketDuplexEndpoint? duplexEndpoint;

  bool alive = true;
  int stepCalls = 0;

  @override
  int duplexStep() {
    stepCalls++;
    return 3;
  }

  @override
  bool get duplexRuntimeAlive => alive;
}

final class _FakeEndpoint implements PocketDuplexEndpoint {
  _FakeEndpoint({required this.native});

  static const capacity = 256;
  final bool native;
  final _egress = <PocketDuplexMessage>[];
  final published = <int>[];
  final consumed = <int>[];
  var reserveCalls = 0;
  var closed = false;
  var ingressUnavailable = false;
  Object? publishFailure;
  Object? consumeFailure;

  @override
  bool get isNativeZeroCopy => native;

  @override
  Uint8List? reserveIngress(int maxMessages) {
    reserveCalls++;
    if (closed || ingressUnavailable || maxMessages < 1) return null;
    final count = maxMessages > capacity - 1 ? capacity - 1 : maxMessages;
    return Uint8List(count * 16);
  }

  @override
  void publishIngress(int messageCount) {
    final failure = publishFailure;
    if (failure != null) throw failure;
    published.add(messageCount);
  }

  @override
  Uint8List? peekEgress(int maxMessages) {
    if (closed || _egress.isEmpty) return null;
    final count = maxMessages < _egress.length ? maxMessages : _egress.length;
    final bytes = ByteData(count * 16);
    for (var i = 0; i < count; i++) {
      final message = _egress[i];
      final offset = i * 16;
      bytes.setUint16(offset, message.msgType, Endian.little);
      bytes.setUint16(offset + 2, message.flags, Endian.little);
      bytes.setUint32(offset + 4, message.targetId, Endian.little);
      bytes.setFloat32(offset + 8, message.arg0, Endian.little);
      bytes.setFloat32(offset + 12, message.arg1, Endian.little);
    }
    return bytes.buffer.asUint8List();
  }

  @override
  void consumeEgress(int messageCount) {
    final failure = consumeFailure;
    if (failure != null) throw failure;
    consumed.add(messageCount);
    _egress.removeRange(0, messageCount);
  }

  void seedEgress(PocketDuplexMessage message) => _egress.add(message);

  @override
  void close() => closed = true;
}
