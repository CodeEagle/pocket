import 'dart:async';

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

  Stream<PocketDuplexStream> get incoming => _incomingController.stream;

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
    if (event.method == 'stream.batch') {
      final raw = event.params['events'];
      if (raw is List) {
        for (final item in raw.whereType<Map>()) {
          handle(PocketEvent.fromJson(Map<String, dynamic>.from(item)));
        }
      }
      return;
    }
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
  }

  final PocketStreamBridge owner;
  final String streamId;
  final String? topic;
  final Map<String, dynamic> parameters;
  final int limit;
  final StreamController<Object?> _controller;
  late final _Port port;
  int _buffered = 0;
  bool _closed = false;

  void add(Object? value) {
    if (_closed) return;
    if (_buffered >= limit) {
      finish(PocketStreamBufferOverflowException(streamId, limit));
      return;
    }
    _buffered++;
    _controller.add(value);
    if (_buffered > 0) _buffered--;
  }

  void finish([Object? error]) {
    if (_closed) return;
    _closed = true;
    if (error != null && !_controller.isClosed) _controller.addError(error);
    if (!_controller.isClosed) unawaited(_controller.close());
    owner._remove(streamId);
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
  Stream<Object?> get data => state._controller.stream;

  @override
  bool get isClosed => state._closed;

  @override
  bool send(Object? value) => state.send(value);

  @override
  bool close([String? reason]) => state.close(reason);

  @override
  bool cancel([String? reason]) => state.cancel(reason);
}
