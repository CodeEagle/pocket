import 'dart:convert';

import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test('legacy descriptors omit schema fields byte-for-byte in JSON shape', () {
    const descriptor = PocketPluginDescriptor(
      id: 'legacy.plugin',
      version: '1.0.0',
      capabilities: <String, PocketPluginCapability>{
        'legacy.echo': PocketPluginCapability(
          name: 'legacy.echo',
          kind: PocketCapabilityKind.request,
        ),
      },
    );

    expect(descriptor.toJson(), <String, dynamic>{
      'protocolVersion': 1,
      'id': 'legacy.plugin',
      'version': '1.0.0',
      'kind': 'capability',
      'capabilities': <Map<String, dynamic>>[
        <String, dynamic>{'name': 'legacy.echo', 'kind': 'request'},
      ],
    });
  });

  test(
    'schema descriptors serialize deterministic references and optional fields',
    () {
      const descriptor = PocketPluginDescriptor(
        id: 'sensor.plugin',
        version: '1.0.0',
        types: <String, PocketPluginSchema>{
          'Reading': PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'unit': PocketPluginSchema.enumValue(<Object?>['c', 'f']),
              'value': PocketPluginSchema.number(),
            },
            required: <String>{'value'},
          ),
        },
        capabilities: <String, PocketPluginCapability>{
          'sensor.readings': PocketPluginCapability(
            name: 'sensor.readings',
            kind: PocketCapabilityKind.stream,
            schema: PocketPluginCapabilitySchema(
              parameters: PocketPluginSchema.object(
                properties: <String, PocketPluginSchema>{
                  'sampleRate': PocketPluginSchema.integer(),
                },
                required: <String>{'sampleRate'},
              ),
              streamItem: PocketPluginSchema.reference('Reading'),
            ),
          ),
        },
      );

      final json = descriptor.toJson();
      expect(json['types'], <String, dynamic>{
        'Reading': <String, dynamic>{
          'type': 'object',
          'properties': <String, dynamic>{
            'unit': <String, dynamic>{
              'type': 'enum',
              'values': <Object?>['c', 'f'],
            },
            'value': <String, dynamic>{'type': 'number'},
          },
          'required': <String>['value'],
        },
      });
      expect((json['capabilities'] as List).single['schema'], <String, dynamic>{
        'parameters': <String, dynamic>{
          'type': 'object',
          'properties': <String, dynamic>{
            'sampleRate': <String, dynamic>{'type': 'integer'},
          },
          'required': <String>['sampleRate'],
        },
        'streamItem': <String, dynamic>{'type': 'ref', 'ref': 'Reading'},
      });
      expect(
        jsonEncode(json),
        jsonEncode(descriptor.toJson()),
        reason: 'serializing the same descriptor must be deterministic',
      );

      final parsed = PocketPluginSchema.fromJson(
        (json['types'] as Map)['Reading'],
      );
      expect(parsed.toJson(), (json['types'] as Map)['Reading']);
    },
  );

  test(
    'schema bounds and unresolved references are rejected at descriptor export',
    () {
      expect(
        () => const PocketPluginDescriptor(
          id: 'bad.plugin',
          version: '1.0.0',
          capabilities: <String, PocketPluginCapability>{
            'bad.request': PocketPluginCapability(
              name: 'bad.request',
              kind: PocketCapabilityKind.request,
              schema: PocketPluginCapabilitySchema(
                result: PocketPluginSchema.reference('Missing'),
              ),
            ),
          },
        ).toJson(),
        throwsArgumentError,
      );
      expect(
        () => PocketPluginSchema.fromJson(<String, dynamic>{
          'type': 'object',
          'properties': <String, dynamic>{
            'x': <String, dynamic>{'type': 'wat'},
          },
        }),
        throwsFormatException,
      );
    },
  );
}
