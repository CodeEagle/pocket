import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('default policy keeps the legacy native configuration contract', () {
    const policy = PocketGuestSecurityPolicy();
    expect(policy.isDefault, isTrue);
    expect(policy.toJson(), <String, Object>{'hardenBuiltins': false});
    expect(policy.toJsonString(), '{"hardenBuiltins":false}');
  });

  test('guest security limits require positive integers up to one million', () {
    expect(
      () => const PocketGuestSecurityPolicy(maxNodes: 0).validate(),
      throwsFormatException,
    );
    expect(
      () => const PocketGuestSecurityPolicy(maxDrawOps: -1).validate(),
      throwsFormatException,
    );
    expect(
      () => const PocketGuestSecurityPolicy(maxNodes: 1000001).validate(),
      throwsFormatException,
    );
    expect(
      () => const PocketGuestSecurityPolicy(maxDrawOps: 1000001).validate(),
      throwsFormatException,
    );
    const policy = PocketGuestSecurityPolicy(
      hardenBuiltins: true,
      maxNodes: 1000000,
      maxDrawOps: 1,
    );
    expect(policy.isDefault, isFalse);
    expect(policy.toJson(), <String, Object>{
      'hardenBuiltins': true,
      'maxNodes': 1000000,
      'maxDrawOps': 1,
    });
  });

  test(
    'non-default policy is configured before the guest is loaded',
    () {
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 480,
        guestSecurity: const PocketGuestSecurityPolicy(
          hardenBuiltins: true,
          maxNodes: 1000,
          maxDrawOps: 1000,
        ),
      );
      try {
        expect(runtime.guestSecurity.hardenBuiltins, isTrue);
        expect(runtime.guestSecurity.maxNodes, 1000);
        final frame = runtime.eval('globalThis.frame = function() {};');
        expect(frame, isA<PocketFrame>());
      } finally {
        runtime.dispose();
      }
    },
    skip: Platform.environment['POCKET_NATIVE_LIBRARY'] == null
        ? 'Set POCKET_NATIVE_LIBRARY to a native library with guest security ABI.'
        : false,
  );
}
