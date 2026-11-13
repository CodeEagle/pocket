import 'dart:async';
import 'dart:convert';

import 'package:pocket_services/pocket_services.dart';

import 'studio_client.dart';
import 'studio_config.dart';
import 'studio_routes.dart';
import 'studio_scrub.dart';

export 'studio_routes.dart'
    show PocketStudioPermissions, pocketStudioCapabilityNames, pocketStudioChunkBytes, pocketStudioMaxResultBytes;

const String pocketStudioPluginId = 'pocket.studio';

const int _maxQueuedEvents = 1024;
const int _maxQueuedBytes = 512 * 1024;
const int _maxBatchEvents = 200;
const int _maxBatchBytes = 128 * 1024;

/// Stateless `studio.*` capability provider.
///
/// It maps a fixed allowlist of capabilities onto the loopback editor service
/// (see [studioCalls]), injects the CSRF credential, scrubs absolute paths
/// from every result and stream event, and maps service failures to structured
/// capability errors. It owns no project, build or transfer state: polling,
/// retries, chunk loops and orchestration live in the guest's JS.
final class PocketStudioPlugin extends PocketPlugin {
  PocketStudioPlugin({
    required PocketStudioConfig config,
    Iterable<String> extraScrubRoots = const <String>[],
    this.flushInterval = const Duration(milliseconds: 25),
  }) : scrubber = StudioPathScrubber() {
    final sdk = config.sdkRoot;
    if (sdk != null) scrubber.addRoot(sdk, '<sdk>');
    final project = config.projectRoot;
    if (project != null) scrubber.addRoot(project, '<project>');
    final workspace = config.effectiveWorkspace;
    if (workspace != null) scrubber.addRoot(workspace, '<workspace>');
    for (final root in config.extraProjectRoots) {
      if (root.isNotEmpty) scrubber.addRoot(root, '<project>');
    }
    for (final root in extraScrubRoots) {
      scrubber.addRoot(root, '<tmp>');
    }
    client = StudioServiceClient(origin: config.origin, scrubber: scrubber);
  }

  final StudioPathScrubber scrubber;
  late final StudioServiceClient client;
  final Duration flushInterval;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: pocketStudioPluginId,
    version: '0.1.0',
    description: 'Stateless Pocket Studio editor-service capabilities',
    optionalPermissions: PocketStudioPermissions.all,
    limits: const PocketPluginLimits(
      maxConcurrentRequests: 8,
      maxActiveStreams: 4,
      maxResponseBytes: 256 * 1024,
      maxStreamEventBytes: 256 * 1024,
    ),
    capabilities: <String, PocketPluginCapability>{
      for (final call in studioCalls)
        call.name: PocketPluginCapability(
          name: call.name,
          kind: call.stream ? PocketCapabilityKind.stream : PocketCapabilityKind.request,
          description: call.description,
          permissions: <String>{call.permission},
          schema: PocketPluginCapabilitySchema(
            parameters: PocketPluginSchema.object(properties: call.params, required: call.required),
          ),
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    for (final call in studioCalls) {
      if (call.stream) {
        context.registerStream(call.name, (remote) => openStream(call.name, remote.params));
      } else {
        context.registerRequest(call.name, (params) => invoke(call.name, params));
      }
    }
  }

  @override
  Future<void> dispose() async => client.close();

  /// Executes one request capability. Also used directly by tests.
  Future<Object?> invoke(String name, Map<String, dynamic> params) async {
    final call = studioCallsByName[name];
    if (call == null || call.stream) {
      throw PocketCapabilityException('capability_not_found', 'unknown studio capability $name');
    }
    for (final key in call.required) {
      if (!params.containsKey(key)) {
        throw PocketCapabilityException('invalid_params', '$key is required');
      }
    }
    final request = call.build(params);
    final result = name == 'studio.artifacts.inspect'
        ? await _inspect(request, params['name'] as String)
        : _shape(name, (await client.send(request.method, request.segments,
                query: request.query, body: request.body, write: request.write,
                verbatimKeys: call.verbatimKeys)).json);
    final extra = call.assets && params['assets'] == true
        ? await _assets(request.segments.sublist(0, 3))
        : null;
    final shaped = extra == null ? result : <String, Object?>{...(result as Map), 'assets': extra};
    final size = utf8.encode(jsonEncode(shaped)).length;
    if (size > pocketStudioMaxResultBytes) {
      throw PocketCapabilityException('too_large',
          'result is $size bytes; use studio.fs.readChunk for large files');
    }
    return shaped;
  }

  Future<Object?> _assets(List<String> project) async {
    final response = await client.send('GET', <String>[...project, 'assets']);
    final json = response.json;
    return json is Map ? json['assets'] : const <Object?>[];
  }

  Future<Object?> _inspect(StudioRequest request, String name) async {
    final response = await client.send('GET', request.segments, raw: true);
    final bytes = response.bytes ?? const <int>[];
    final text = name.endsWith('.js') || name.endsWith('.json');
    if (!text) {
      return <String, Object?>{'name': name, 'bytes': bytes.length, 'encoding': 'binary'};
    }
    const limit = 128 * 1024;
    var view = bytes;
    if (name.endsWith('.json') && bytes.length > limit) {
      // Pretty-printed snapshots (resources.json) carry mostly whitespace: re-encode compactly so the guest
      // can still parse the whole document. `bytes` stays the artifact's real size.
      try {
        final compact = utf8.encode(jsonEncode(jsonDecode(utf8.decode(bytes))));
        if (compact.length <= limit) view = compact;
      } on FormatException {
        // not valid JSON: fall through to the byte cut
      }
    }
    final cut = view.length > limit ? limit : view.length;
    return <String, Object?>{
      'name': name,
      'bytes': bytes.length,
      'encoding': 'utf8',
      'truncated': cut < view.length,
      'data': scrubber.scrubString(utf8.decode(view.sublist(0, cut), allowMalformed: true)),
    };
  }

  Object? _shape(String name, Object? json) {
    switch (name) {
      case 'studio.project.list':
        final list = json is List ? json : const <Object?>[];
        return <String, Object?>{'projects': [for (final p in list) _slimProject(p)]};
      case 'studio.project.open':
      case 'studio.project.create':
        return _slimProject(json);
      case 'studio.build.start':
        // The service wraps the status as {status:{...}}; the contract is the flat status.
        final inner = json is Map ? json['status'] : null;
        return _capLogs(inner is Map ? inner : json);
      case 'studio.build.status':
        return _capLogs(json);
      case 'studio.logs.tail':
        return _capLogs(json, key: 'logs');
      case 'studio.artifacts.list':
        final map = json is Map ? json : const <String, Object?>{};
        return <String, Object?>{
          'revision': map['revision'],
          'builtRevision': map['builtRevision'],
          'artifacts': map['artifacts'],
        };
      case 'studio.publish.publish':
        // The signed envelope carries the whole base64 payload (every blob URL), which can exceed the 256 KiB
        // result quota for large projects and would fail an already completed publish. Keep the public
        // identity (keyId, signature, size) and drop the payload body; the signed bytes are served at
        // `manifestUrl` for anything that needs them.
        if (json is Map && json['manifest'] is Map) {
          final manifest = json['manifest'] as Map;
          final payload = manifest['payload'];
          return <String, Object?>{
            ...json.cast<String, Object?>(),
            'manifest': <String, Object?>{
              for (final e in manifest.entries)
                if (e.key != 'payload') '${e.key}': e.value,
              if (payload is String) 'payloadBase64Bytes': payload.length,
            },
          };
        }
        return json;
      case 'studio.service.health':
        final map = json is Map ? json : const <String, Object?>{};
        return <String, Object?>{
          for (final k in const ['ok', 'service', 'version', 'projectId', 'updatePackageVersion', 'bluetooth'])
            if (map.containsKey(k)) k: map[k],
        };
      default:
        return json;
    }
  }

  static Object? _slimProject(Object? project) {
    if (project is! Map) return project;
    final copy = <String, Object?>{for (final e in project.entries) '${e.key}': e.value};
    final status = copy['status'];
    if (status is Map) copy['status'] = _capLogs(<String, Object?>{...status, 'logs': const <Object?>[]});
    return copy;
  }

  /// Keeps the newest log lines whose encoded size fits the result budget.
  static Object? _capLogs(Object? json, {String key = 'logs'}) {
    if (json is! Map) return json;
    final copy = <String, Object?>{for (final e in json.entries) '${e.key}': e.value};
    final logs = copy[key];
    if (logs is List) {
      var used = 0;
      final kept = <Object?>[];
      for (final line in logs.reversed) {
        used += utf8.encode(jsonEncode(line)).length + 1;
        if (used > 100 * 1024) break;
        kept.add(line);
      }
      copy[key] = kept.reversed.toList();
    }
    return copy;
  }

  /// SSE route -> capability stream. Events are scrubbed, queued, and sent as
  /// `{events:[...]}` batches (<=200 events / 128 KiB) so the guest receives at
  /// most one message per flush interval. When the queue overflows the oldest
  /// `log` events (then oldest others) are dropped and a
  /// `{type:"gap", dropped:n}` event is placed first in the next batch: the
  /// guest must re-list/re-read status.
  Stream<Object?> openStream(String name, Map<String, dynamic> params) {
    final call = studioCallsByName[name];
    if (call == null || !call.stream) {
      throw PocketCapabilityException('capability_not_found', 'unknown studio stream $name');
    }
    final request = call.build(params);
    final source = client.sse(request.segments);
    final queue = <Object?>[];
    final sizes = <int>[];
    var queuedBytes = 0;
    var dropped = 0;
    Timer? timer;
    StreamSubscription<Object?>? subscription;
    late StreamController<Object?> controller;

    bool isLog(Object? e) => e is Map && e['type'] == 'log';

    void dropOldest() {
      var index = queue.indexWhere(isLog);
      if (index < 0) index = 0;
      queuedBytes -= sizes.removeAt(index);
      queue.removeAt(index);
      dropped++;
    }

    void flush() {
      timer = null;
      if (controller.isClosed || (queue.isEmpty && dropped == 0)) return;
      final batch = <Object?>[];
      if (dropped > 0) {
        batch.add(<String, Object?>{'type': 'gap', 'dropped': dropped});
        dropped = 0;
      }
      var bytes = 0;
      while (queue.isNotEmpty && batch.length < _maxBatchEvents && bytes + sizes.first <= _maxBatchBytes) {
        bytes += sizes.first;
        queuedBytes -= sizes.removeAt(0);
        batch.add(queue.removeAt(0));
      }
      if (batch.isEmpty && queue.isNotEmpty) {
        queuedBytes -= sizes.removeAt(0);
        queue.removeAt(0);
        batch.add(<String, Object?>{'type': 'gap', 'dropped': 1});
      }
      controller.add(<String, Object?>{'events': batch});
      if (queue.isNotEmpty) timer = Timer(flushInterval, flush);
    }

    controller = StreamController<Object?>(
      onListen: () {
        subscription = source.listen(
          (event) {
            final size = utf8.encode(jsonEncode(event)).length;
            queue.add(event);
            sizes.add(size);
            queuedBytes += size;
            while (queue.length > _maxQueuedEvents || queuedBytes > _maxQueuedBytes) {
              dropOldest();
            }
            timer ??= Timer(flushInterval, flush);
          },
          onError: (Object error, StackTrace stack) {
            timer?.cancel();
            controller.addError(error, stack);
            controller.close();
          },
          onDone: () {
            timer?.cancel();
            while (queue.isNotEmpty || dropped > 0) {
              flush();
              timer?.cancel();
            }
            controller.close();
          },
          cancelOnError: true,
        );
      },
      onCancel: () async {
        timer?.cancel();
        await subscription?.cancel();
      },
    );
    return controller.stream;
  }
}
