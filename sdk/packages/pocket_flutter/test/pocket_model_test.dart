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
}
