import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  test('font family fallbacks participate in config copies and identity', () {
    final first = PocketAppConfig(
      appId: 'font.fallback.test',
      fontFamilyFallback: const <String>['LanternSerif'],
    );
    final equal = PocketAppConfig(
      appId: 'font.fallback.test',
      fontFamilyFallback: const <String>['LanternSerif'],
    );
    final changed = first.copyWith(
      fontFamilyFallback: const <String>['DifferentSerif'],
    );

    expect(PocketAppConfig(appId: 'font.default').fontFamilyFallback, isEmpty);
    expect(first.copyWith().fontFamilyFallback, <String>['LanternSerif']);
    expect(first, equal);
    expect(first.hashCode, equal.hashCode);
    expect(first, isNot(changed));
  });

  test('equal permission and capability sets have equal hashes', () {
    final first = PocketAppConfig(
      appId: 'hash.test',
      allowedPermissions: {'camera', 'network'},
      additionalCapabilities: {'one', 'two'},
    );
    final reordered = PocketAppConfig(
      appId: 'hash.test',
      allowedPermissions: {'network', 'camera'},
      additionalCapabilities: {'two', 'one'},
    );
    expect(first, reordered);
    expect(first.hashCode, reordered.hashCode);
    expect({first: 'session'}[reordered], 'session');
  });

  test(
    'download-on-open survives host copies and changes configuration identity',
    () {
      const updates = PocketUpdateConfig(
        url: 'https://updates.example.test/profile/latest.json',
        keyId: 'release',
        publicKey: 'AA==',
      );
      const remote = PocketAppConfig(
        appId: 'remote.profile',
        updates: updates,
        downloadOnOpen: true,
      );
      const embedded = PocketAppConfig(
        appId: 'remote.profile',
        updates: updates,
      );
      expect(() => remote.validate(), returnsNormally);
      expect(remote, isNot(embedded));
      final copied = remote.copyWith(
        additionalCapabilities: {'example.capability'},
      );
      expect(copied.downloadOnOpen, isTrue);
      expect(copied.updates, updates);
      expect(remote.withPlugins([]).downloadOnOpen, isTrue);
      expect(remote.copyWith(), remote);
      expect(remote.copyWith().hashCode, remote.hashCode);
      expect(
        () => const PocketAppConfig(
          appId: 'remote.missing',
          downloadOnOpen: true,
        ).validate(),
        throwsFormatException,
      );
    },
  );
}
