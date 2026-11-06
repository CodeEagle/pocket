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

  test('structured endpoint resolves the canonical Pocket release layout', () {
    const config = PocketUpdateConfig(
      baseUrl: 'https://cdn.example.com/releases',
      hostVersion: '3.2.0',
      packageVersion: '1.4.7',
      keyId: 'release-key',
      publicKey: 'AA==',
    );

    expect(config.configured, isTrue);
    expect(
      config.manifestUri('com.example.notes').toString(),
      'https://cdn.example.com/releases/pocket/3.2.0/com.example.notes/1.4.7/latest.json',
    );
  });

  test('structured endpoint rejects partial or mixed configuration', () {
    const partial = PocketUpdateConfig(
      baseUrl: 'https://cdn.example.com',
      hostVersion: '3.2.0',
      keyId: 'release-key',
      publicKey: 'AA==',
    );
    const mixed = PocketUpdateConfig(
      url: 'https://cdn.example.com/latest.json',
      baseUrl: 'https://cdn.example.com',
      hostVersion: '3.2.0',
      packageVersion: '1.4.7',
      keyId: 'release-key',
      publicKey: 'AA==',
    );

    expect(() => partial.validate(), throwsFormatException);
    expect(() => mixed.validate(), throwsFormatException);
  });

  test('trust-only update configuration validates without legacy keys', () {
    const config = PocketUpdateConfig(
      url: 'https://updates.example.test/manifest.json',
      trustRootKeyId: 'host-root-1',
      trustRootPublicKey: 'AA==',
      trustPolicyUrl: 'https://updates.example.test/trust-policy.json',
    );
    expect(config.trustPolicyConfigured, isTrue);
    expect(config.configured, isTrue);
    expect(() => config.validate(), returnsNormally);
  });

  test('partial trust configuration fails closed even with legacy keys', () {
    const mixed = PocketUpdateConfig(
      url: 'https://updates.example.test/manifest.json',
      keyId: 'legacy-key',
      publicKey: 'AA==',
      trustRootKeyId: 'host-root-1',
    );
    expect(() => mixed.validate(), throwsFormatException);

    const urlOnly = PocketUpdateConfig(
      url: 'https://updates.example.test/manifest.json',
    );
    expect(() => urlOnly.validate(), throwsFormatException);
  });
}
