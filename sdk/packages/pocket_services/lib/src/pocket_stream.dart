import 'dart:async';
import 'dart:convert';

import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;

typedef PocketStreamSend =
    bool Function(String method, Map<String, dynamic> params);

abstract interface class PocketDuplexStream {
  String get streamId;
  String? get topic;
  Map<String, dynamic> get parameters;
  Stream<Object?> get data;
  bool get isClosed;
  bool send(Object? value);
  bool close([String? reason]);
  bool cancel([String? reason]);
}

/// Bounded bidirectional stream bridge over the existing PocketJS event wire.
/// It deliberately does not introduce another transport or isolate.
final class PocketStreamBridge {
  PocketStreamBridge({
    required this.send,
    this.maxBufferedMessages = 64,
    this.idPrefix = 'host-stream',
  }) : assert(maxBufferedMessages > 0) {
    _incomingController = StreamController<PocketDuplexStream>.broadcast(
      sync: true,
    );
  }

  final PocketStreamSend send;
  final int maxBufferedMessages;
  final String idPrefix;
  late final StreamController<PocketDuplexStream> _incomingController;
  final Map<String, _StreamState> _states = <String, _StreamState>{};
  int _nextId = 0;
  bool _disposed = false;

  // Keep the Dart-side wire admission in step with the public JS adapter and
  // the native event boundary.  Batches are deliberately one level deep:
  // accepting nested batches here would make a small outer packet an
  // unbounded recursive work item.
  static const int maxBatchMessages = 256;
  static const int maxMessageBytes = 256 * 1024;

  Stream<PocketDuplexStream> get incoming => _incomingController.stream;

  /// Reports a provider failure on the existing wire, then closes its local
  /// port. A remote failure must not be disguised as a successful stream end.
  bool fail(PocketDuplexStream port, Map<String, dynamic> error) {
    final state = _states[port.streamId];
    if (state == null || !identical(state.port, port)) return false;
    final sent = send('stream.error', <String, dynamic>{
      'streamId': port.streamId,
      'error': error,
    });
    state.finish();
    return sent;
  }

  PocketDuplexStream open({
    String? topic,
    Map<String, dynamic> parameters = const <String, dynamic>{},
  }) {
    _ensureOpen();
    final id = '$idPrefix-${++_nextId}';
    final state = _StreamState(
      this,
      id,
      topic,
      Map<String, dynamic>.from(parameters),
      maxBufferedMessages,
    );
    _states[id] = state;
    if (!send('stream.open', <String, dynamic>{
      'streamId': id,
      if (topic != null) 'topic': topic,
      if (parameters.isNotEmpty) 'params': parameters,
    })) {
      _states.remove(id);
      state.finish(
        const PocketStreamProtocolException('', 'stream.open was not sent'),
      );
      throw const PocketStreamProtocolException('', 'stream.open was not sent');
    }
    return state.port;
  }

  /// Delivers a packet decoded by the renderer's PocketEvent model.
  void handle(PocketEvent event) {
    if (_disposed) return;
    if (!_fitsWireLimit(event)) {
      _rejectOversized(event);
      return;
    }
    if (event.method == 'stream.batch') {
      final raw = event.params['events'];
      if (raw is! List || raw.length > maxBatchMessages) return;
      for (final item in raw) {
        if (item is! Map) continue;
        Map<String, dynamic> json;
        try {
          json = Map<String, dynamic>.from(item);
        } on Object {
          continue;
        }
        // A nested batch is rejected rather than recursively expanded.  This
        // keeps work bounded even when a hostile packet is deeply nested.
        final method = '${json['method'] ?? json['name'] ?? ''}';
        if (method == 'stream.batch') continue;
        try {
          _handleSingle(PocketEvent.fromJson(json));
        } on Object {
          // Malformed batch members are rejected as a whole member; they do
          // not abort delivery of the other bounded members.
        }
      }
      return;
    }
    try {
      _handleSingle(event);
    } on Object {
      // Malformed direct events are ignored without tearing down the host
      // event pump.  Structured stream failures are emitted only when a
      // stream id can be trusted by the admission checks above.
    }
  }

  void _handleSingle(PocketEvent event) {
    final id = '${event.params['streamId'] ?? event.params['id'] ?? ''}';
    if (id.isEmpty) return;
    if (event.method == 'stream.open') {
      if (_states.containsKey(id)) return;
      final state = _StreamState(
        this,
        id,
        event.params['topic'] as String?,
        event.params['params'] is Map
            ? Map<String, dynamic>.from(event.params['params'] as Map)
            : <String, dynamic>{},
        maxBufferedMessages,
      );
      _states[id] = state;
      _incomingController.add(state.port);
      return;
    }
    final state = _states[id];
    if (state == null) return;
    switch (event.method) {
      case 'stream.data':
        state.add(event.params['data'] ?? event.params['value']);
      case 'stream.end':
        state.finish();
      case 'stream.error':
        state.finish(
          PocketStreamRemoteException(
            id,
            event.params['error'] ?? event.params['value'],
          ),
        );
      case 'stream.cancel':
        state.finish(
          PocketStreamRemoteException(
            id,
            event.params['reason'] ?? 'cancelled',
          ),
        );
    }
  }

  bool _fitsWireLimit(PocketEvent event) {
    final sink = _BoundedJsonSink(maxMessageBytes);
    try {
      final converter = JsonUtf8Encoder(
        null,
        (Object? _) => throw const FormatException('non-JSON event value'),
      ).startChunkedConversion(sink);
      converter.add(<String, dynamic>{
        'id': event.id,
        'method': event.method,
        'params': event.params,
      });
      converter.close();
      return true;
    } on _JsonSizeLimitExceeded {
      return false;
    } on Object {
      // A non-JSON event is not allowed to enter the stream controller.  The
      // event may already have been decoded by a trusted native boundary, but
      // this guard keeps the public Dart bridge safe for direct callers too.
      return false;
    }
  }

  void _rejectOversized(PocketEvent event) {
    final id = '${event.params['streamId'] ?? event.params['id'] ?? ''}';
    if (id.isEmpty) return;
    final state = _states[id];
    if (state == null) return;
    state.failProtocol(
      code: 'stream_message_too_large',
      message: 'Stream message exceeds $maxMessageBytes bytes',
    );
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final state in _states.values.toList(growable: false)) {
      state.finish(
        const PocketStreamProtocolException('', 'stream bridge disposed'),
      );
    }
    _states.clear();
    _incomingController.close();
  }

  void _remove(String id) => _states.remove(id);

  void _ensureOpen() {
    if (_disposed) throw StateError('PocketStreamBridge is disposed');
  }
}

final class PocketStreamProtocolException implements Exception {
  const PocketStreamProtocolException(this.streamId, this.message);

  final String streamId;
  final String message;

  @override
  String toString() => 'PocketStreamProtocolException($streamId): $message';
}

final class PocketStreamRemoteException implements Exception {
  const PocketStreamRemoteException(this.streamId, this.value);

  final String streamId;
  final Object? value;

  @override
  String toString() => 'PocketStreamRemoteException($streamId): $value';
}

final class PocketStreamBufferOverflowException implements Exception {
  const PocketStreamBufferOverflowException(this.streamId, this.limit);

  final String streamId;
  final int limit;

  @override
  String toString() =>
      'PocketStreamBufferOverflowException($streamId): limit $limit';
}

final class _StreamState {
  _StreamState(
    this.owner,
    this.streamId,
    this.topic,
    this.parameters,
    this.limit,
  ) : _controller = StreamController<Object?>(sync: true) {
    port = _Port(this);
    _dataStream = _controller.stream.transform(
      StreamTransformer<Object?, Object?>.fromHandlers(
        handleData: (value, sink) {
          _markDelivered();
          try {
            sink.add(value);
          } finally {
            _deliveringData = false;
          }
        },
        handleError: (error, stackTrace, sink) {
          sink.addError(error, stackTrace);
        },
      ),
    );

    // The only lifecycle callback needed here is cancellation: it is the
    // controller's signal that its internal queue has been discarded.
    _controller.onCancel = _onCancel;
  }

  final PocketStreamBridge owner;
  final String streamId;
  final String? topic;
  final Map<String, dynamic> parameters;
  final int limit;
  final StreamController<Object?> _controller;
  late final _Port port;
  late final Stream<Object?> _dataStream;
  // Number of data events still held by the controller or its active
  // subscription.  The controller has no public queue length, so the
  // transform marks events only when they actually leave that queue.
  int _pendingData = 0;
  bool _deliveringData = false;
  bool _closed = false;

  void add(Object? value) {
    if (_closed) return;
    // A synchronous controller can have pre-listen events scheduled for
    // delivery even though `isPaused` is already false after listen().  The
    // pending count and the delivery guard cover that short interval too.
    final needsBuffer =
        _controller.isPaused || _pendingData > 0 || _deliveringData;
    if (needsBuffer && _pendingData >= limit) {
      _overflow();
      return;
    }
    if (needsBuffer) _pendingData++;
    try {
      _controller.add(value);
    } on Object {
      if (needsBuffer && _pendingData > 0) _pendingData--;
      rethrow;
    }
  }

  void finish([Object? error]) {
    if (_closed) return;
    _closed = true;
    // No further data can be admitted after terminal transition.  The
    // controller retains at most the already-buffered data and terminal event
    // until a late/paused listener drains or cancels it; our accounting must
    // not retain a second copy of that state.
    _pendingData = 0;
    _deliveringData = false;
    if (error != null && !_controller.isClosed) _controller.addError(error);
    if (!_controller.isClosed) unawaited(_controller.close());
    owner._remove(streamId);
  }

  void failProtocol({required String code, required String message}) {
    if (_closed) return;
    owner.send('stream.error', <String, dynamic>{
      'streamId': streamId,
      'error': <String, dynamic>{'code': code, 'message': message},
    });
    finish(PocketStreamProtocolException(streamId, message));
  }

  void _overflow() {
    final message = 'Stream $streamId exceeded its ${limit}-message buffer';
    owner.send('stream.error', <String, dynamic>{
      'streamId': streamId,
      'error': <String, dynamic>{
        'code': 'stream_buffer_overflow',
        'message': message,
      },
    });
    finish(PocketStreamBufferOverflowException(streamId, limit));
  }

  void _markDelivered() {
    if (_pendingData > 0) _pendingData--;
    _deliveringData = true;
    // The handler calls sink.add synchronously for a synchronous source.  The
    // wrapper clears the flag after the consumer callback has returned, so
    // re-entrant inbound packets remain bounded as well.
  }

  void _onCancel() {
    // A canceled subscription causes the Dart controller to discard its
    // internal pending queue.  Drop only our accounting here; an explicit
    // PocketDuplexStream.cancel() remains available, while cancellation of
    // the only data subscription also releases the remote producer.
    _pendingData = 0;
    _deliveringData = false;
    if (_closed) return;
    _closed = true;
    owner._remove(streamId);
    owner.send('stream.cancel', <String, dynamic>{
      'streamId': streamId,
      'reason': 'listener_cancelled',
    });
  }

  bool send(Object? value) {
    if (_closed) return false;
    return owner.send('stream.data', <String, dynamic>{
      'streamId': streamId,
      'data': value,
    });
  }

  bool close([String? reason]) {
    if (_closed) return false;
    final result = owner.send('stream.end', <String, dynamic>{
      'streamId': streamId,
      if (reason != null) 'reason': reason,
    });
    finish();
    return result;
  }

  bool cancel([String? reason]) {
    if (_closed) return false;
    final result = owner.send('stream.cancel', <String, dynamic>{
      'streamId': streamId,
      if (reason != null) 'reason': reason,
    });
    finish();
    return result;
  }
}

final class _Port implements PocketDuplexStream {
  _Port(this.state);

  final _StreamState state;

  @override
  String get streamId => state.streamId;

  @override
  String? get topic => state.topic;

  @override
  Map<String, dynamic> get parameters =>
      Map<String, dynamic>.unmodifiable(state.parameters);

  @override
  Stream<Object?> get data => state._dataStream;

  @override
  bool get isClosed => state._closed;

  @override
  bool send(Object? value) => state.send(value);

  @override
  bool close([String? reason]) => state.close(reason);

  @override
  bool cancel([String? reason]) => state.cancel(reason);
}

final class _BoundedJsonSink implements Sink<List<int>> {
  _BoundedJsonSink(this.limit);

  final int limit;
  int _bytes = 0;

  @override
  void add(List<int> chunk) {
    _bytes += chunk.length;
    if (_bytes > limit) throw const _JsonSizeLimitExceeded();
  }

  @override
  void close() {}
}

final class _JsonSizeLimitExceeded implements Exception {
  const _JsonSizeLimitExceeded();
}
