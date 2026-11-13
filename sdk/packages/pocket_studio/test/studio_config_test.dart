import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_studio/pocket_studio.dart';

void main() {
  test('self-update slot URL follows the channel and host version', () {
    final config = PocketStudioConfig(port: 8800);
    expect(config.updateChannel, 'test');
    expect(config.selfUpdateUrl, 'http://127.0.0.1:8800/test/pocket/studio/dev.pocket.studio/latest.json');
    final stable = PocketStudioConfig(port: 8800, updateChannel: 'stable', hostVersion: 'h1');
    expect(stable.selfUpdateUrl, 'http://127.0.0.1:8800/stable/pocket/h1/dev.pocket.studio/latest.json');
    expect(() => PocketStudioConfig(port: 8800, updateChannel: 'beta'), throwsArgumentError);
  });

  test('public update and preview keys are read from the trusted workspace; private halves are never read', () async {
    final dir = await Directory.systemTemp.createTemp('studio-config-');
    addTearDown(() => dir.delete(recursive: true));
    final config = PocketStudioConfig(port: 8800, workspace: dir.path);
    expect(config.readUpdateKey(), isNull);
    expect(config.readPreviewKey(), isNull);
    Directory('${dir.path}/keys').createSync();
    File('${dir.path}/keys/editor-dev-key.json')
        .writeAsStringSync(jsonEncode({'keyId': 'editor-x', 'publicKeyBase64': 'UFVC', 'privateKeyPem': 'SECRET'}));
    expect(config.readUpdateKey(), (keyId: 'editor-x', publicKey: 'UFVC'));
    expect(config.readPreviewKey(), isNull, reason: 'the preview key is a different file');
    File('${dir.path}/keys/editor-dev-key.json').writeAsStringSync('not json');
    expect(config.readUpdateKey(), isNull);
  });

  test('preview namespace is per signing key', () {
    final config = PocketStudioConfig(port: 8800);
    expect(config.previewNamespace('KEY-A'), matches(RegExp(r'^studio-preview-[0-9a-f]{12}$')));
    expect(config.previewNamespace('KEY-A'), config.previewNamespace('KEY-A'));
    expect(config.previewNamespace('KEY-A'), isNot(config.previewNamespace('KEY-B')));
  });
}
