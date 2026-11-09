import 'package:flutter_test/flutter_test.dart';

import '../test_driver/integration_test.dart'
    show validatePocketAcceptanceCheckpoints;

void main() {
  group('pocketAcceptance driver checkpoints', () {
    test('complete required checkpoints pass', () {
      expect(
        () => validatePocketAcceptanceCheckpoints({
          'pocketAcceptance': {
            'required': ['model-showcase'],
            'completed': ['model-showcase'],
          },
        }),
        returnsNormally,
      );
    });

    test('legacy response without checkpoint declaration remains optional', () {
      expect(
        () => validatePocketAcceptanceCheckpoints({'legacyReport': true}),
        returnsNormally,
      );
    });

    test('missing required checkpoint fails', () {
      expect(
        () => validatePocketAcceptanceCheckpoints({
          'pocketAcceptance': {
            'required': ['model-showcase'],
            'completed': <String>[],
          },
        }),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('model-showcase'),
          ),
        ),
      );
    });

    test('malformed checkpoint declaration fails', () {
      expect(
        () => validatePocketAcceptanceCheckpoints({
          'pocketAcceptance': {
            'required': ['model-showcase', 4],
            'completed': ['model-showcase'],
          },
        }),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('non-empty strings'),
          ),
        ),
      );
      expect(
        () => validatePocketAcceptanceCheckpoints({
          'pocketAcceptance': {
            'required': ['model-showcase'],
          },
        }),
        throwsA(isA<StateError>()),
      );
    });
  });
}
