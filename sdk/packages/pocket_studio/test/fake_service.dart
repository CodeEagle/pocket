import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// A real loopback HTTP server that serves the editor service's route shapes.
final class FakeService {
  FakeService._(this.server);
  final HttpServer server;
  final List<FakeRequest> requests = <FakeRequest>[];
  final List<HttpResponse> sseOpen = <HttpResponse>[];
  int sseClosed = 0;
  String csrf = 'csrf-token-0123456789';
  Map<String, Object?> health = <String, Object?>{};
  Future<FakeReply> Function(FakeRequest request)? handler;

  int get port => server.port;

  static Future<FakeService> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final service = FakeService._(server);
    service.health = <String, Object?>{
      'ok': true,
      'service': 'pocket-editor',
      'pid': 1,
      'version': '1.2.3',
      'csrfToken': service.csrf,
      'bluetooth': {'local': false},
      'workspace': '/Users/dev/ws',
      'projectRoot': '/Users/dev/app',
      'flutterRoot': '/Users/dev/flutter',
    };
    server.listen(service._handle);
    return service;
  }

  Future<void> _handle(HttpRequest request) async {
    final body = await utf8.decodeStream(request);
    final fake = FakeRequest(request.method, request.uri, request.headers, body);
    requests.add(fake);
    if (request.uri.path == '/health') {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(<String, Object?>{...health, 'csrfToken': csrf}));
      await request.response.close();
      return;
    }
    final reply = await (handler?.call(fake) ?? Future.value(const FakeReply(404, {'error': 'not found'})));
    if (reply.sse != null) {
      final response = request.response;
      response.headers.set('content-type', 'text/event-stream');
      response.bufferOutput = false;
      sseOpen.add(response);
      response.write(': open\n\n');
      for (final event in reply.sse!) {
        response.write('data: ${jsonEncode(event)}\n\n');
      }
      await response.flush();
      if (reply.sseClose) {
        await response.close();
      } else {
        var closed = false;
        void gone() {
          if (!closed) sseClosed++;
          closed = true;
        }
        unawaited(response.done.then((_) => gone(), onError: (_) => gone()));
        Timer.periodic(const Duration(milliseconds: 40), (timer) {
          if (closed) return timer.cancel();
          try {
            response.write(': ping\n\n');
          } on Object {
            gone();
          }
        });
      }
      return;
    }
    request.response.statusCode = reply.status;
    if (reply.raw != null) {
      request.response.headers.set('content-type', reply.contentType);
      request.response.add(reply.raw!);
    } else {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(reply.json));
    }
    await request.response.close();
  }

  Future<void> close() => server.close(force: true);
}

final class FakeRequest {
  FakeRequest(this.method, this.uri, this.headers, this.body);
  final String method;
  final Uri uri;
  final HttpHeaders headers;
  final String body;
  Object? get json => body.isEmpty ? null : jsonDecode(body);
}

final class FakeReply {
  const FakeReply(this.status, this.json, {this.raw, this.contentType = 'application/octet-stream', this.sse, this.sseClose = true});
  final int status;
  final Object? json;
  final List<int>? raw;
  final String contentType;
  final List<Object?>? sse;
  final bool sseClose;
}
