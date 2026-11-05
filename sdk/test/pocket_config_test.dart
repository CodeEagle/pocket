import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  test('debug update hosts are an explicit allowlist and part of identity', () {
    const defaults = PocketUpdateConfig(
      url: 'https://updates.example.test/manifest.json',
      keyId: 'test-key',
      publicKey: 'AA==',
    );
    const explicit = PocketUpdateConfig(
      url: 'http://192.168.50.230:8792/manifest.json',
      keyId: 'test-key',
      publicKey: 'AA==',
      debugHttpHosts: <String>['192.168.50.230'],
    );
    const same = PocketUpdateConfig(
      url: 'http://192.168.50.230:8792/manifest.json',
      keyId: 'test-key',
      publicKey: 'AA==',
      debugHttpHosts: <String>['192.168.50.230'],
    );
    const different = PocketUpdateConfig(
      url: 'http://192.168.50.230:8792/manifest.json',
      keyId: 'test-key',
      publicKey: 'AA==',
      debugHttpHosts: <String>['192.168.50.231'],
    );

    expect(defaults.debugHttpHosts, isEmpty);
    expect(explicit.debugHttpHosts, <String>['192.168.50.230']);
    expect(() => explicit.validate(), returnsNormally);
    expect(explicit, same);
    expect(explicit.hashCode, same.hashCode);
    expect(explicit, isNot(different));
  });

  test('fromEnvironment reserves at most one optional debug host', () {
    const config = PocketUpdateConfig.fromEnvironment();
    final expected = const String.fromEnvironment(
      'POCKET_UPDATE_DEBUG_HTTP_HOST',
    );
    expect(
      config.debugHttpHosts,
      expected.isEmpty ? isEmpty : <String>[expected],
    );
  });
}
