import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('decodes native frame operations and ARGB colors', () {
    final frame = PocketFrame.fromJson('''{
      "width": 320, "height": 480,
      "ops": [
        {"type":"rect","x":1,"y":2,"w":30,"h":40,"color":4281558681},
        {"type":"gradient","x":0,"y":0,"w":10,"h":10,"from":4278190335,"to":4294901760,"direction":1},
        {"type":"text","x":4,"y":8,"w":80,"h":20,"text":"guest","color":4294967295,"fontSlot":2},
        {"type":"image","x":0,"y":0,"w":16,"h":16,"asset":"icon"}
      ], "events": [], "resources": []
    }''');

    expect(frame.width, 320);
    expect(frame.ops[0], isA<PocketRectOp>());
    expect((frame.ops[0] as PocketRectOp).color, 0xff336699);
    expect((frame.ops[1] as PocketGradientOp).direction, 1);
    expect((frame.ops[2] as PocketTextOp).text, 'guest');
    expect((frame.ops[3] as PocketImageOp).asset, 'icon');
  });

  test('decodes a native RGBA texture resource', () {
    final resource = PocketImageResource(
      asset: 'pixel',
      width: 1,
      height: 1,
      psm: 3,
      linear: false,
      pixels: Uint8List.fromList(<int>[255, 0, 0, 255]),
    );
    final image = PocketPakImages.fromResource(resource);
    expect(image, isNotNull);
    expect(image!.rgba, orderedEquals(<int>[255, 0, 0, 255]));
  });

  test('decodes every compact binary draw operation and resource field', () {
    final binary = _BinaryFrameBuilder();
    binary.u32(0x31424650); // PFB1
    binary.u16(1);
    binary.u16(0);
    binary.u64(7);
    binary.f32(320);
    binary.f32(480);
    binary.u32(9);
    void common(int type) {
      binary.u8(type);
      binary.f32(1);
      binary.f32(2);
      binary.f32(30);
      binary.f32(40);
      binary.f32(0);
      binary.f32(0);
      binary.f32(320);
      binary.f32(480);
    }

    common(0);
    binary.u32(0xff112233);
    common(1);
    binary.u32(0xff223344);
    binary.f32(8);
    common(2);
    binary.u32(0xff000000);
    binary.u32(0xffffffff);
    binary.u32(3);
    common(3);
    for (final point in <double>[1, 2, 3, 4, 5, 6]) {
      binary.f32(point);
    }
    for (final color in <int>[1, 2, 3]) {
      binary.u32(color);
    }
    common(4);
    binary.string('sprite');
    binary.u32(0xffabcdef);
    for (final point in <double>[1, 2, 3, 4, 5, 6]) {
      binary.f32(point);
    }
    for (final uv in <double>[0, 0, 1, 0, 1, 1]) {
      binary.f32(uv);
    }
    common(5);
    binary.string('hello');
    binary.f32(18);
    binary.u32(0xff123456);
    binary.u8(1);
    binary.u8(2);
    common(6);
    binary.string('icon');
    binary.u8(1);
    for (final uv in <double>[0, 0, 1, 1]) {
      binary.f32(uv);
    }
    binary.u8(1);
    binary.u32(0xff010203);
    common(7);
    binary.string('surface-id');
    binary.string('{"kind":"glass","parameters":{"radius":12}}');
    common(8);
    binary.string('video-id');
    binary.string('camera');
    binary.u8(1); // contain
    binary.u8(1); // autoplay

    binary.u32(1); // event count
    binary.bytes(
      utf8.encode('{"id":"1","method":"host.response","params":{"ok":true}}'),
    );
    binary.u32(1); // resource count
    binary.string('icon');
    binary.u64(4);
    binary.u32(1);
    binary.u32(1);
    binary.u32(3);
    binary.u8(1);
    binary.bytes(<int>[255, 0, 0, 255]);
    binary.u8(1);
    binary.bytes(<int>[0, 1, 2, 3]);
    binary.u32(1); // released resources
    binary.string('old');
    binary.u8(1); // auxiliary
    binary.f32(100);
    binary.f32(120);
    binary.u32(1);
    common(0);
    binary.u32(0xff556677);

    final frame = PocketFrame.fromBinary(binary.build());
    expect(frame.ops, hasLength(9));
    expect(frame.ops[0], isA<PocketRectOp>());
    expect(frame.ops[1], isA<PocketRoundedOp>());
    expect(frame.ops[2], isA<PocketGradientOp>());
    expect(frame.ops[3], isA<PocketTriangleOp>());
    expect(frame.ops[4], isA<PocketTextureTriangleOp>());
    expect(frame.ops[5], isA<PocketTextOp>());
    expect(frame.ops[6], isA<PocketImageOp>());
    expect(frame.ops[7], isA<PocketHostSurfaceOp>());
    expect(frame.ops[8], isA<PocketVideoOp>());
    expect((frame.ops[7] as PocketHostSurfaceOp).parameters['radius'], 12);
    expect((frame.ops[8] as PocketVideoOp).fit, 'contain');
    expect(frame.events.single.method, 'host.response');
    expect(frame.resources.single.pixels, orderedEquals(<int>[255, 0, 0, 255]));
    expect(frame.resources.single.palette, orderedEquals(<int>[0, 1, 2, 3]));
    expect(frame.releasedResources, <String>['old']);
    expect(frame.auxiliary!.ops.single, isA<PocketRectOp>());
  });

  test('PFB1 metadata preserves text alignment and compositor focus/handle', () {
    final binary = _BinaryFrameBuilder()
      ..u32(0x31424650)..u16(1)..u16(1)..u64(1)..f32(320)..f32(480)..u32(2);
    void common(int kind) {
      binary..u8(kind)..f32(10)..f32(20)..f32(100)..f32(40)
        ..f32(0)..f32(0)..f32(320)..f32(480);
    }
    common(5);
    binary..string('中😀\nright')..f32(16)..u32(0xffffffff)..u8(0)..u8(2);
    common(7);
    binary..string('app.a')..string('{"kind":"application","parameters":{"appId":"app.a"}}')..u32(2)..u8(1)
      ..u32(0)..u32(0)..u32(0)..u8(0);
    final frame = PocketFrame.fromBinary(binary.build());
    expect((frame.ops[0] as PocketTextOp).align, 2);
    final surface = frame.ops[1] as PocketHostSurfaceOp;
    expect(surface.surfaceHandle, 2);
    expect(surface.focused, isTrue);
    final unknown = binary.build();
    unknown[6] = 2;
    expect(() => PocketFrame.fromBinary(unknown), throwsFormatException);
    final json = PocketFrame.fromJson(jsonEncode({'width':320,'height':480,'ops':[
      {'type':'text','x':0,'y':0,'w':100,'h':20,'text':'center','align':1},
      {'type':'hostSurface','x':0,'y':0,'w':100,'h':20,'id':'app.a','surfaceHandle':2,'focused':true,
       'asset':jsonEncode({'kind':'application','parameters':{}})}]}));
    expect((json.ops[0] as PocketTextOp).align, 1);
    expect((json.ops[1] as PocketHostSurfaceOp).focused, isTrue);
  });

  test('rejects truncated and trailing compact binary frames', () {
    expect(
      () => PocketFrame.fromBinary(Uint8List.fromList(<int>[0, 1, 2])),
      throwsA(isA<FormatException>()),
    );
    final binary = _BinaryFrameBuilder()
      ..u32(0x31424650)
      ..u16(1)
      ..u16(0)
      ..u64(1)
      ..f32(1)
      ..f32(1)
      ..u32(0)
      ..u32(0)
      ..u32(0)
      ..u32(0)
      ..u8(0)
      ..u8(0);
    expect(
      () => PocketFrame.fromBinary(
        Uint8List.fromList(<int>[...binary.build(), 0xff]),
      ),
      throwsA(isA<FormatException>()),
    );
  });

  test('PocketBinaryCodec roundtrips 0xB1 messages, Uint8List slices, PFB1 binary events, and 0xB2 offload records', () {
    final original = <String, dynamic>{
      'type': 'event',
      'name': 'host.push',
      'id': 'ev-9',
      'payload': <String, dynamic>{
        'flag': true,
        'none': null,
        'count': -42,
        'ratio': 3.5,
        'bytes': Uint8List.fromList(<int>[1, 99, 250]),
        'nested': <Object?>['hello', 7],
      },
    };
    final encoded = PocketBinaryCodec.encodeMessage(original);
    expect(encoded.first, pocketBinaryMessageMagic);

    final decoded = PocketBinaryCodec.decodeMessage(encoded);
    expect(decoded['name'], 'host.push');
    final payload = decoded['payload'] as Map<String, dynamic>;
    expect(payload['flag'], isTrue);
    expect(payload['none'], isNull);
    expect(payload['count'], -42);
    expect(payload['ratio'], 3.5);
    expect(payload['bytes'], isA<Uint8List>());
    expect(payload['bytes'], Uint8List.fromList(<int>[1, 99, 250]));
    expect(payload['nested'], <Object?>['hello', 7]);

    final binaryFrame = _BinaryFrameBuilder()
      ..u32(0x31424650)
      ..u16(1)
      ..u16(0)
      ..u64(1)
      ..f32(320)
      ..f32(480)
      ..u32(0) // ops
      ..u32(1) // events
      ..bytes(encoded)
      ..u32(0) // resources
      ..u32(0) // releasedResources
      ..u8(0); // auxiliary
    final frame = PocketFrame.fromBinary(binaryFrame.build());
    expect(frame.events, hasLength(1));
    expect(frame.events.single.method, 'host.push');
    expect(frame.events.single.wireByteLength, encoded.length);
    expect(
      frame.events.single.params['bytes'],
      Uint8List.fromList(<int>[1, 99, 250]),
    );

    final completionOk = PocketBinaryCodec.encodeOffloadCompletion(
      const PocketOffloadCompletion.success(
        PocketOffloadKey(generation: 1, session: 5, id: 19),
        '{"ok":true}',
      ),
    );
    expect(completionOk.first, pocketOffloadBinaryMagic);
    expect(completionOk[17], 1);
  });
}

final class _BinaryFrameBuilder {
  final List<int> _bytes = <int>[];

  void u8(int value) => _bytes.add(value & 0xff);

  void u16(int value) {
    final data = ByteData(2)..setUint16(0, value, Endian.little);
    _bytes.addAll(data.buffer.asUint8List());
  }

  void u32(int value) {
    final data = ByteData(4)..setUint32(0, value, Endian.little);
    _bytes.addAll(data.buffer.asUint8List());
  }

  void u64(int value) {
    final data = ByteData(8)..setUint64(0, value, Endian.little);
    _bytes.addAll(data.buffer.asUint8List());
  }

  void f32(double value) {
    final data = ByteData(4)..setFloat32(0, value, Endian.little);
    _bytes.addAll(data.buffer.asUint8List());
  }

  void bytes(Iterable<int> value) {
    final data = Uint8List.fromList(value.toList(growable: false));
    u32(data.length);
    _bytes.addAll(data);
  }

  void string(String value) => bytes(utf8.encode(value));

  Uint8List build() => Uint8List.fromList(_bytes);
}
