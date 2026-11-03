import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/src/pocket_config.dart';

void main() {
  group('PocketMemoryLimits', () {
    test('validates bounded optional fields and rejects malformed values', () {
      const limits = PocketMemoryLimits(
        heapLimitBytes: 64 * 1024,
        maxPakBytes: 1,
      );
      expect(limits.toJson(), <String, int>{
        'heapLimitBytes': 64 * 1024,
        'maxPakBytes': 1,
      });
      expect(PocketMemoryLimits.fromJson(<String, dynamic>{}), isNotNull);
      expect(
        PocketMemoryLimits.fromJson(<String, dynamic>{
          'heapLimitBytes': 2 * 1024 * 1024 * 1024,
          'maxPakBytes': 512 * 1024 * 1024,
        }),
        equals(
          const PocketMemoryLimits(
            heapLimitBytes: 2 * 1024 * 1024 * 1024,
            maxPakBytes: 512 * 1024 * 1024,
          ),
        ),
      );

      final invalid = <Map<String, dynamic>>[
        <String, dynamic>{'heapLimitBytes': null},
        <String, dynamic>{'heapLimitBytes': 0},
        <String, dynamic>{'heapLimitBytes': -1},
        <String, dynamic>{'heapLimitBytes': 64 * 1024 - 1},
        <String, dynamic>{'heapLimitBytes': 2 * 1024 * 1024 * 1024 + 1},
        <String, dynamic>{'heapLimitBytes': 64 * 1024.5},
        <String, dynamic>{'maxPakBytes': null},
        <String, dynamic>{'maxPakBytes': 0},
        <String, dynamic>{'maxPakBytes': -1},
        <String, dynamic>{'maxPakBytes': 512 * 1024 * 1024 + 1},
        <String, dynamic>{'maxPakBytes': 1.5},
        <String, dynamic>{'gcThreshold': 1},
      ];
      for (final value in invalid) {
        expect(
          () => PocketMemoryLimits.fromJson(value),
          throwsFormatException,
          reason: 'expected rejection for $value',
        );
      }
    });

    test(
      'host admission only allows tightening and preserves empty requests',
      () {
        const host = PocketMemoryLimits(
          heapLimitBytes: 128 * 1024,
          maxPakBytes: 8 * 1024 * 1024,
        );
        expect(host.admit(const PocketMemoryLimits()), equals(host));
        expect(
          host.admit(
            const PocketMemoryLimits(heapLimitBytes: 64 * 1024, maxPakBytes: 1),
          ),
          equals(
            const PocketMemoryLimits(heapLimitBytes: 64 * 1024, maxPakBytes: 1),
          ),
        );
        expect(
          () => host.admit(
            const PocketMemoryLimits(heapLimitBytes: 128 * 1024 + 1),
          ),
          throwsFormatException,
        );
        expect(
          () => host.admit(
            const PocketMemoryLimits(maxPakBytes: 8 * 1024 * 1024 + 1),
          ),
          throwsFormatException,
        );

        const uncappedByConfig = PocketMemoryLimits();
        expect(
          () => uncappedByConfig.admit(
            const PocketMemoryLimits(heapLimitBytes: 16 * 1024 * 1024 + 1),
          ),
          throwsFormatException,
        );
      },
    );
  });

  test(
    'PocketAppConfig copyWith, equality, hash and validation include memory limits',
    () {
      const limits = PocketMemoryLimits(
        heapLimitBytes: 128 * 1024,
        maxPakBytes: 8 * 1024 * 1024,
      );
      const config = PocketAppConfig(
        appId: 'memory.policy.test',
        memoryLimits: limits,
      );
      final copy = config.copyWith();
      expect(copy.memoryLimits, equals(limits));
      expect(copy, equals(config));
      expect(copy.hashCode, equals(config.hashCode));
      expect(
        config.copyWith(
          memoryLimits: const PocketMemoryLimits(heapLimitBytes: 64 * 1024),
        ),
        isNot(equals(config)),
      );
      expect(config.validate, returnsNormally);
    },
  );
}
