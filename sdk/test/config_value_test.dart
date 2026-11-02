import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
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
}
