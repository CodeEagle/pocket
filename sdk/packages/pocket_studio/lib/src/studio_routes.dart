import 'dart:convert';

import 'package:pocket_services/pocket_services.dart';

import 'studio_paths.dart';

/// Permissions granted by the trusted host (host scope) and declared by the
/// Studio guest manifest. Reads and writes are separate grants.
abstract final class PocketStudioPermissions {
  static const String read = 'studio.read';
  static const String write = 'studio.write';
  static const String build = 'studio.build';
  static const String deploy = 'studio.deploy';
  static const String publish = 'studio.publish';
  static const Set<String> all = <String>{read, write, build, deploy, publish};
}

/// Largest raw payload per transfer chunk (service limit; keeps every control
/// message below 256 KiB once base64 encoded).
const int pocketStudioChunkBytes = 128 * 1024;

/// Largest request/response result the provider returns in one capability
/// call (framework quota is 256 KiB; leave headroom).
const int pocketStudioMaxResultBytes = 240 * 1024;

const Set<String> _configKeys = <String>{
  'name', 'title', 'appId', 'version', 'build', 'tickHz', 'reusePublishedPackages',
};

/// One service request derived from validated guest params.
final class StudioRequest {
  const StudioRequest(this.method, this.segments, {this.query, this.body, this.write = false});
  final String method;
  final List<String> segments;
  final Map<String, String>? query;
  final Object? body;
  final bool write;
}

typedef StudioRequestBuilder = StudioRequest Function(Map<String, dynamic> params);

/// A fixed allowlist entry: capability name -> (method, route template).
final class StudioCall {
  const StudioCall(
    this.name,
    this.permission,
    this.description,
    this.params,
    this.required,
    this.build, {
    this.stream = false,
    this.assets = false,
  });
  final String name;
  final String permission;
  final String description;
  final Map<String, PocketPluginSchema> params;
  final Set<String> required;
  final StudioRequestBuilder build;
  final bool stream;
  final bool assets;
}

const PocketPluginSchema _s = PocketPluginSchema.string();
const PocketPluginSchema _i = PocketPluginSchema.integer();
const PocketPluginSchema _b = PocketPluginSchema.boolean();
const PocketPluginSchema _o = PocketPluginSchema.unknown();

List<String> _project(Map<String, dynamic> p) => <String>['api', 'projects', studioProjectId(p['project'])];
List<String> _file(Map<String, dynamic> p, String route, [String key = 'path']) =>
    <String>[..._project(p), route, ...studioRelativePath(p[key], key)];

int _nonNegative(Object? v, String name) {
  if (v is! int || v < 0) throw PocketCapabilityException('invalid_params', '$name must be a non-negative integer');
  return v;
}

String _channel(Object? v) {
  if (v == null) return 'test';
  if (v != 'test' && v != 'release') throw const PocketCapabilityException('invalid_params', 'channel must be test or release');
  return v as String;
}

Map<String, Object?> _config(Object? source, {required bool create}) {
  if (source is! Map) throw const PocketCapabilityException('invalid_params', 'settings must be an object');
  final body = <String, Object?>{};
  for (final entry in source.entries) {
    final key = '${entry.key}';
    if (_configKeys.contains(key)) {
      body[key] = entry.value;
    } else if (!(create && (key == 'id' || key == 'template'))) {
      throw PocketCapabilityException('invalid_params', 'unknown setting: $key');
    }
  }
  return body;
}

int _base64RawLength(String data) {
  var padding = 0;
  if (data.endsWith('==')) {
    padding = 2;
  } else if (data.endsWith('=')) {
    padding = 1;
  }
  return data.length * 3 ~/ 4 - padding;
}

const Set<String> pocketStudioArtifactNames = <String>{
  'app.js', 'app.qjbc', 'app.bytecode.json', 'app.pak', 'guest-manifest.json',
  'build.json', 'resources.json', 'app.worker.qjbc', 'app.worker.bytecode.json',
};

Map<String, PocketPluginSchema> _p({Map<String, PocketPluginSchema> extra = const {}, bool project = true}) =>
    <String, PocketPluginSchema>{if (project) 'project': _s, ...extra};

/// The frozen capability table. Each entry is a fixed (method, route) pair.
final List<StudioCall> studioCalls = <StudioCall>[
  StudioCall('studio.project.list', PocketStudioPermissions.read, 'List projects',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'projects'])),
  StudioCall('studio.project.create', PocketStudioPermissions.write, 'Create a project from an SDK template',
      _p(project: false, extra: {'id': _s, 'template': _s, 'settings': _o}), const {'id'}, (p) {
    final id = studioProjectId(p['id'], 'id');
    final template = p['template'] ?? 'app';
    if (template != 'app' && template != 'game') {
      throw const PocketCapabilityException('invalid_params', 'template must be app or game');
    }
    return StudioRequest('POST', const ['api', 'projects'], write: true, body: <String, Object?>{
      ..._config(p['settings'] ?? const <String, Object?>{}, create: true),
      'id': id,
      'template': template,
    });
  }),
  StudioCall('studio.project.open', PocketStudioPermissions.read, 'Read project configuration and status',
      _p(), const {'project'}, (p) => StudioRequest('GET', _project(p))),
  StudioCall('studio.project.settings.get', PocketStudioPermissions.read, 'Read project settings',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'config'])),
  StudioCall('studio.project.settings.set', PocketStudioPermissions.write, 'Update project settings',
      _p(extra: {'settings': _o}), const {'project', 'settings'},
      (p) => StudioRequest('PUT', [..._project(p), 'config'], write: true, body: _config(p['settings'], create: false))),
  StudioCall('studio.fs.tree', PocketStudioPermissions.read, 'List editable files (flat)',
      _p(extra: {'assets': _b}), const {'project'},
      (p) => StudioRequest('GET', [..._project(p), 'files']), assets: true),
  StudioCall('studio.fs.read', PocketStudioPermissions.read, 'Read a small UTF-8 file',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('GET', _file(p, 'files'))),
  StudioCall('studio.fs.write', PocketStudioPermissions.write, 'Write a small UTF-8 file',
      _p(extra: {'path': _s, 'content': _s}), const {'project', 'path', 'content'}, (p) {
    final content = p['content'];
    if (content is! String) throw const PocketCapabilityException('invalid_params', 'content must be a string');
    if (utf8.encode(content).length > 192 * 1024) {
      throw const PocketCapabilityException('too_large', 'content exceeds 192 KiB; use studio.fs.upload.*');
    }
    return StudioRequest('PUT', _file(p, 'files'), write: true, body: <String, Object?>{'content': content});
  }),
  StudioCall('studio.fs.rename', PocketStudioPermissions.write, 'Move or rename a file',
      _p(extra: {'from': _s, 'to': _s, 'overwrite': _b}), const {'project', 'from', 'to'}, (p) {
    studioRelativePath(p['from'], 'from');
    studioRelativePath(p['to'], 'to');
    return StudioRequest('POST', [..._project(p), 'files-move'], write: true, body: <String, Object?>{
      'from': p['from'], 'to': p['to'], if (p['overwrite'] == true) 'overwrite': true,
    });
  }),
  StudioCall('studio.fs.delete', PocketStudioPermissions.write, 'Delete a file',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('DELETE', _file(p, 'files'), write: true)),
  StudioCall('studio.fs.stat', PocketStudioPermissions.read, 'Stat a file or directory',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('GET', _file(p, 'stat'))),
  StudioCall('studio.fs.mkdir', PocketStudioPermissions.write, 'Create a folder',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) {
    studioRelativePath(p['path']);
    return StudioRequest('POST', [..._project(p), 'folders'], write: true, body: <String, Object?>{'path': p['path']});
  }),
  StudioCall('studio.fs.rmdir', PocketStudioPermissions.write, 'Remove an empty folder',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('DELETE', _file(p, 'folders'), write: true)),
  StudioCall('studio.fs.readChunk', PocketStudioPermissions.read, 'Read a base64 chunk (<=128 KiB)',
      _p(extra: {'path': _s, 'offset': _i, 'length': _i}), const {'project', 'path', 'offset'}, (p) {
    final offset = _nonNegative(p['offset'], 'offset');
    final length = p['length'] == null ? pocketStudioChunkBytes : _nonNegative(p['length'], 'length');
    if (length < 1) throw const PocketCapabilityException('invalid_params', 'length must be positive');
    return StudioRequest('GET', _file(p, 'chunks'), query: <String, String>{
      'offset': '$offset',
      'length': '${length > pocketStudioChunkBytes ? pocketStudioChunkBytes : length}',
    });
  }),
  StudioCall('studio.fs.upload.begin', PocketStudioPermissions.write, 'Begin a chunked upload',
      _p(extra: {'path': _s, 'totalBytes': _i, 'sha256': _s}), const {'project', 'path', 'totalBytes', 'sha256'}, (p) {
    studioRelativePath(p['path']);
    final sha = p['sha256'];
    if (sha is! String || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(sha)) {
      throw const PocketCapabilityException('invalid_params', 'sha256 must be 64 hex characters');
    }
    return StudioRequest('POST', [..._project(p), 'uploads'], write: true, body: <String, Object?>{
      'path': p['path'], 'totalBytes': _nonNegative(p['totalBytes'], 'totalBytes'), 'sha256': sha,
    });
  }),
  StudioCall('studio.fs.upload.chunk', PocketStudioPermissions.write, 'Upload one base64 chunk (<=128 KiB raw)',
      _p(extra: {'uploadId': _s, 'offset': _i, 'data': _s}), const {'project', 'uploadId', 'offset', 'data'}, (p) {
    final data = p['data'];
    if (data is! String || data.isEmpty) throw const PocketCapabilityException('invalid_params', 'data must be base64');
    if (_base64RawLength(data) > pocketStudioChunkBytes) {
      throw const PocketCapabilityException('too_large', 'chunk exceeds 131072 raw bytes');
    }
    return StudioRequest('PUT', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId')],
        write: true, body: <String, Object?>{'offset': _nonNegative(p['offset'], 'offset'), 'data': data});
  }),
  StudioCall('studio.fs.upload.commit', PocketStudioPermissions.write, 'Commit an upload',
      _p(extra: {'uploadId': _s}), const {'project', 'uploadId'},
      (p) => StudioRequest('POST', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId'), 'commit'],
          write: true, body: const <String, Object?>{})),
  StudioCall('studio.fs.upload.abort', PocketStudioPermissions.write, 'Abort an upload',
      _p(extra: {'uploadId': _s}), const {'project', 'uploadId'},
      (p) => StudioRequest('DELETE', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId')], write: true)),
  StudioCall('studio.fs.watch', PocketStudioPermissions.read, 'Stream file changes',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'watch']), stream: true),
  StudioCall('studio.build.start', PocketStudioPermissions.build, 'Queue a build',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'build'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.build.cancel', PocketStudioPermissions.build, 'Cancel the running build',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'build', 'cancel'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.build.status', PocketStudioPermissions.read, 'Build status',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'status'])),
  StudioCall('studio.build.events', PocketStudioPermissions.read, 'Stream build events',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'build', 'events']), stream: true),
  StudioCall('studio.logs.tail', PocketStudioPermissions.read, 'Recent build log lines',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'logs'])),
  StudioCall('studio.preview.publish', PocketStudioPermissions.build, 'Publish the current build to the signed preview slot',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'preview-publish'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.preview.devices', PocketStudioPermissions.read, 'List deployment devices',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'devices'])),
  StudioCall('studio.preview.deploy', PocketStudioPermissions.deploy, 'Start a device deployment',
      _p(extra: {'deviceId': _s}), const {'project', 'deviceId'}, (p) {
    final device = p['deviceId'];
    if (device is! String || device.isEmpty || device.length > 200) {
      throw const PocketCapabilityException('invalid_params', 'deviceId must be a non-empty string');
    }
    return StudioRequest('POST', [..._project(p), 'deploy'], write: true, body: <String, Object?>{'deviceId': device});
  }),
  StudioCall('studio.preview.deployStatus', PocketStudioPermissions.read, 'Deployment job status',
      _p(extra: {'job': _s}), const {'project', 'job'},
      (p) => StudioRequest('GET', [..._project(p), 'deploy', studioOpaqueId(p['job'], 'job')])),
  StudioCall('studio.preview.deployCancel', PocketStudioPermissions.deploy, 'Cancel a deployment job',
      _p(extra: {'job': _s}), const {'project', 'job'},
      (p) => StudioRequest('DELETE', [..._project(p), 'deploy', studioOpaqueId(p['job'], 'job')], write: true)),
  StudioCall('studio.publish.plan', PocketStudioPermissions.read, 'Publish target summary',
      _p(extra: {'channel': _s}), const {'project'},
      (p) => StudioRequest('GET', [..._project(p), 'publish-targets'], query: <String, String>{'channel': _channel(p['channel'])})),
  StudioCall('studio.publish.publish', PocketStudioPermissions.publish, 'Publish a signed package',
      _p(extra: {'channel': _s}), const {'project'},
      (p) => StudioRequest('POST', [..._project(p), 'publish'], write: true, body: <String, Object?>{'channel': _channel(p['channel'])})),
  StudioCall('studio.publish.history', PocketStudioPermissions.read, 'Version backend snapshot',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'versions'])),
  StudioCall('studio.publish.offline', PocketStudioPermissions.publish, 'Build an offline package',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'package-offline'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.artifacts.list', PocketStudioPermissions.read, 'List build artifacts',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'status'])),
  StudioCall('studio.artifacts.inspect', PocketStudioPermissions.read, 'Inspect one build artifact (text only)',
      _p(extra: {'name': _s}), const {'project', 'name'}, (p) {
    final name = p['name'];
    if (name is! String || !pocketStudioArtifactNames.contains(name)) {
      throw const PocketCapabilityException('invalid_params', 'unknown artifact name');
    }
    return StudioRequest('GET', [..._project(p), 'artifacts', name]);
  }),
  StudioCall('studio.service.health', PocketStudioPermissions.read, 'Service health (scrubbed)',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['health'])),
  StudioCall('studio.service.upgrade.status', PocketStudioPermissions.read, 'Studio self-upgrade status',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'studio', 'upgrade'])),
];

final Map<String, StudioCall> studioCallsByName = <String, StudioCall>{
  for (final call in studioCalls) call.name: call,
};

/// Every capability name of the frozen table.
final Set<String> pocketStudioCapabilityNames = studioCallsByName.keys.toSet();
