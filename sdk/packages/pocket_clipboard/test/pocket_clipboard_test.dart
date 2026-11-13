import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_clipboard/pocket_clipboard.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Object? clipboardText;
  var hasStrings = true;
  final calls = <String>[];

  setUp(() {
    clipboardText = null;
    hasStrings = true;
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          calls.add(call.method);
          switch (call.method) {
            case 'Clipboard.getData':
              return clipboardText == null
                  ? null
                  : <String, dynamic>{'text': clipboardText};
            case 'Clipboard.setData':
              clipboardText = (call.arguments as Map)['text'];
              return null;
            case 'Clipboard.hasStrings':
              return <String, dynamic>{'value': hasStrings};
          }
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });


  Future<PocketPluginManager> admit({
    required Set<String> hostAllowed,
    required List<String> optional,
    required List<String> declared,
    PocketClipboardPlugin? plugin,
    String appId = 'dev.test',
  }) async {
    final host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: PocketClipboardCapabilities.all,
      send: (_, __) => true,
    );
    final manager = PocketPluginManager(
      host: host,
      appId: appId,
      sessionId: '1',
      allowedPermissions: hostAllowed,
    );
    manager.register(plugin ?? PocketClipboardPlugin());
    final availability = manager.negotiate(
      required: const <String>[],
      optional: optional,
      requestedPermissions: declared,
    );
    await manager.activate(availability);
    addTearDown(manager.dispose);
    return manager;
  }

  test('descriptor serializes with schemas and per-capability permissions', () {
    final json = PocketClipboardPlugin().descriptor.toJson();
    expect(json['id'], 'flutter.clipboard');
    final caps = (json['capabilities'] as List).cast<Map>();
    expect(caps.map((c) => c['name']), containsAll(PocketClipboardCapabilities.all));
  });

  test('granted read and write round-trip through the platform clipboard', () async {
    final manager = await admit(
      hostAllowed: {'clipboard.read', 'clipboard.write'},
      optional: PocketClipboardCapabilities.all.toList(),
      declared: ['clipboard.read', 'clipboard.write'],
    );
    expect(
      await manager.invoke('clipboard.writeText', {'text': 'héllo'}),
      {'ok': true},
    );
    expect(clipboardText, 'héllo');
    expect(await manager.invoke('clipboard.readText'), {'text': 'héllo'});
    expect(await manager.invoke('clipboard.hasText'), {'hasText': true});
  });

  test('null clipboard reads as text null', () async {
    final manager = await admit(
      hostAllowed: {'clipboard.read'},
      optional: ['clipboard.readText'],
      declared: ['clipboard.read'],
    );
    expect(await manager.invoke('clipboard.readText'), {'text': null});
  });

  test('host scope without read grant denies read, write stays separate', () async {
    clipboardText = 'secret';
    final manager = await admit(
      hostAllowed: {'clipboard.write'},
      optional: PocketClipboardCapabilities.all.toList(),
      declared: ['clipboard.read', 'clipboard.write'],
    );
    await expectLater(
      manager.invoke('clipboard.readText'),
      throwsA(isA<PocketCapabilityException>()),
    );
    await expectLater(
      manager.invoke('clipboard.hasText'),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(calls, isNot(contains('Clipboard.getData')));
    expect(await manager.invoke('clipboard.writeText', {'text': 'ok'}), {'ok': true});
  });

  test('guest that did not declare the permission or capability cannot read', () async {
    clipboardText = 'secret';
    final manager = await admit(
      hostAllowed: {'clipboard.read', 'clipboard.write'},
      optional: ['clipboard.writeText'],
      declared: ['clipboard.write'],
    );
    await expectLater(
      manager.invoke('clipboard.readText'),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(calls, isNot(contains('Clipboard.getData')));

    // Capability declared but its permission was not: revoked at admission.
    final noPermission = await admit(
      hostAllowed: {'clipboard.read'},
      optional: ['clipboard.readText'],
      declared: const <String>[],
    );
    await expectLater(
      noPermission.invoke('clipboard.readText'),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('undeclared permission name is rejected at negotiation', () async {
    final host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: PocketClipboardCapabilities.all,
      send: (_, __) => true,
    );
    final manager = PocketPluginManager(host: host, appId: 'a', sessionId: '1');
    manager.register(PocketClipboardPlugin());
    addTearDown(manager.dispose);
    expect(
      () => manager.negotiate(
        required: const <String>[],
        requestedPermissions: const ['clipboard.admin'],
      ),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('size limits: oversized write refused, oversized read errors, no truncation', () async {
    final plugin = PocketClipboardPlugin(maxTextBytes: 8);
    final manager = await admit(
      hostAllowed: {'clipboard.read', 'clipboard.write'},
      optional: PocketClipboardCapabilities.all.toList(),
      declared: ['clipboard.read', 'clipboard.write'],
      plugin: plugin,
    );
    await manager.invoke('clipboard.writeText', {'text': '12345678'});
    expect(clipboardText, '12345678');
    await expectLater(
      manager.invoke('clipboard.writeText', {'text': '123456789'}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')),
    );
    expect(clipboardText, '12345678', reason: 'refused write left clipboard intact');
    // Multi-byte: 3 chars but 9 bytes.
    await expectLater(
      manager.invoke('clipboard.writeText', {'text': '€€€'}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')),
    );
    clipboardText = 'x' * 9;
    await expectLater(
      manager.invoke('clipboard.readText'),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')),
    );
  });

  test('default limit is 192 KiB and invalid params are rejected', () async {
    expect(pocketClipboardMaxTextBytes, 192 * 1024);
    expect(() => PocketClipboardPlugin(maxTextBytes: pocketClipboardMaxTextBytes + 1), throwsArgumentError);
    final plugin = PocketClipboardPlugin();
    await expectLater(
      plugin.writeText({'text': 'a' * (pocketClipboardMaxTextBytes + 1)}),
      throwsA(isA<PocketCapabilityException>()),
    );
    await plugin.writeText({'text': 'a' * pocketClipboardMaxTextBytes});
    await expectLater(
      plugin.writeText({'text': 7}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'invalid_params')),
    );
  });

  Future<PocketPluginManager> fullAdmit() => admit(
    hostAllowed: {'clipboard.read', 'clipboard.write'},
    optional: PocketClipboardCapabilities.all.toList(),
    declared: ['clipboard.read', 'clipboard.write'],
  );

  test('192 KiB ASCII text written can be read back', () async {
    final manager = await fullAdmit();
    final text = 'a' * pocketClipboardMaxTextBytes;
    expect(await manager.invoke('clipboard.writeText', {'text': text}), {'ok': true});
    final read = await manager.invoke('clipboard.readText') as Map;
    expect((read['text'] as String).length, pocketClipboardMaxTextBytes);
  });

  test('escape-heavy text reads while the encoded form fits, else too_large', () async {
    final manager = await fullAdmit();
    // 100 KiB of quotes encode to 200 KiB + 2: over the raw limit, under quota.
    clipboardText = '"' * (100 * 1024);
    final read = await manager.invoke('clipboard.readText') as Map;
    expect((read['text'] as String).length, 100 * 1024);
    // 192 KiB of quotes (and of control characters) escape far past the budget.
    for (final ch in ['"', '\u0001']) {
      clipboardText = ch * pocketClipboardMaxTextBytes;
      await expectLater(
        manager.invoke('clipboard.readText'),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')),
      );
    }
  });

  test('192 KiB + 1 write is too_large and leaves the clipboard unchanged', () async {
    final manager = await fullAdmit();
    clipboardText = 'keep';
    await expectLater(
      manager.invoke('clipboard.writeText', {'text': 'a' * (pocketClipboardMaxTextBytes + 1)}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')),
    );
    expect(clipboardText, 'keep');
  });

  test('descriptor response quota stays under the 256 KiB bridge message', () {
    final quota = PocketClipboardPlugin().descriptor.limits.maxResponseBytes!;
    expect(quota, greaterThan(pocketClipboardMaxTextBytes + 2 + 9));
    expect(quota, lessThan(256 * 1024));
  });

  test('a child guest without its own grant cannot read although another app has it', () async {
    clipboardText = 'secret';
    final parent = await admit(
      appId: 'dev.parent',
      hostAllowed: {'clipboard.read', 'clipboard.write'},
      optional: PocketClipboardCapabilities.all.toList(),
      declared: ['clipboard.read', 'clipboard.write'],
    );
    final child = await admit(
      appId: 'dev.parent.child',
      hostAllowed: {'clipboard.read', 'clipboard.write'},
      optional: const <String>[],
      declared: const <String>[],
    );
    expect(await parent.invoke('clipboard.readText'), {'text': 'secret'});
    calls.clear();
    await expectLater(
      child.invoke('clipboard.readText'),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(calls, isNot(contains('Clipboard.getData')));
  });
}
