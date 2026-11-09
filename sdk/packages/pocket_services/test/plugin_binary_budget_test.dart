import 'dart:convert';
import 'dart:typed_data';

import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

final class _PayloadPlugin extends PocketPlugin {
  _PayloadPlugin(this.result);
  final Object? result;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.payload',
    version: '1',
    capabilities: {
      'test.payload.read': PocketPluginCapability(
        name: 'test.payload.read',
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('test.payload.read', (_) => result);
  }
}

Future<Object?> _invoke(Object? value, int maxBytes) async {
  final host = PocketHost(
    registry: PocketHostRegistry(),
    streams: PocketStreamBridge(send: (_, __) => true),
    allowedCapabilities: {'test.payload.read'},
    sendRaw: (_) => true,
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.image',
    sessionId: 'budget-test',
    allowedPermissions: {},
    budget: PocketPluginBudget(maxResponseBytes: maxBytes),
  );
  manager.register(_PayloadPlugin(value));
  try {
    await manager.activate(manager.negotiate(required: ['test.payload.read']));
    return await manager.invoke('test.payload.read');
  } finally {
    await manager.dispose();
    host.dispose();
  }
}

Matcher _code(String code) => throwsA(
  isA<PocketCapabilityException>().having((error) => error.code, 'code', code),
);

void main() {
  test(
    'typed image bytes fit their binary budget without numeric expansion',
    () async {
      final bytes = Uint8List(40)..fillRange(0, 40, 255);
      final value = <String, Object?>{'img': bytes};
      expect(utf8.encode(jsonEncode(value)).length, greaterThan(64));
      final result = await _invoke(value, 64) as Map;
      expect(
        identical(result['img'], bytes),
        isTrue,
        reason: 'quota validation must not copy the resource buffer',
      );
      await expectLater(
        _invoke({'img': bytes.toList()}, 64),
        _code('plugin_payload_quota'),
      );
    },
  );

  test('nested buffers share one bounded envelope budget', () async {
    final value = {
      'parts': [Uint8List(20), Uint8List(20)],
    };
    await expectLater(_invoke(value, 48), _code('plugin_payload_quota'));
    expect(await _invoke(value, 80), same(value));
    await expectLater(
      _invoke(Uint8List(65), 64),
      _code('plugin_payload_quota'),
    );
  });

  test(
    'ordinary JSON retains exact UTF-8 escaping and boundary accounting',
    () async {
      final value = {
        'text': '海港\n"🌙',
        'values': [false, 3.5, null],
      };
      final encodedBytes = utf8.encode(jsonEncode(value)).length;
      expect(await _invoke(value, encodedBytes), same(value));
      await expectLater(
        _invoke(value, encodedBytes - 1),
        _code('plugin_payload_quota'),
      );
    },
  );

  test('cyclic and invalid values remain rejected', () async {
    final cycle = <Object?>[];
    cycle.add(cycle);
    await expectLater(_invoke(cycle, 1024), _code('plugin_payload_invalid'));
    await expectLater(
      _invoke({1: Uint8List(4)}, 1024),
      _code('plugin_payload_invalid'),
    );
    await expectLater(
      _invoke(double.nan, 1024),
      _code('plugin_payload_invalid'),
    );
  });
}
