import 'package:flutter/widgets.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_model.dart';
import 'package:pocket_flutter/src/pocket_semantics.dart';

void main() {
  test(
    'parses bounded JS semantic snapshots and preserves explicit fields',
    () {
      final event = PocketEvent(
        id: 'guest-event',
        method: pocketAccessibilitySnapshotEvent,
        params: <String, dynamic>{
          'generation': 7,
          'controls': <Map<String, dynamic>>[
            <String, dynamic>{
              'guestId': 'apple.save',
              'nativeId': 42,
              'label': 'Save',
              'role': 'button',
              'selected': true,
              'disabled': false,
              'enabled': true,
              'checked': false,
              'rect': <String, double>{
                'x': 10,
                'y': 20,
                'width': 80,
                'height': 40,
              },
            },
          ],
        },
      );

      final snapshot = PocketSemanticsSnapshot.fromEvent(event);
      expect(snapshot.generation, 7);
      expect(snapshot.nodes, hasLength(1));
      final node = snapshot.nodes.single;
      expect(node.guestId, 'apple.save');
      expect(node.nativeId, 42);
      expect(node.label, 'Save');
      expect(node.button, isTrue);
      expect(node.selected, isTrue);
      expect(node.checked, isFalse);
      expect(node.rect, const Rect.fromLTWH(10, 20, 80, 40));

      final wrongEvent = PocketEvent(
        id: 'wrong',
        method: 'other.event',
        params: const <String, dynamic>{},
      );
      expect(PocketSemanticsSnapshot.tryFromEvent(wrongEvent), isNull);
    },
  );

  test('parser caps controls and drops malformed or duplicate guest ids', () {
    final controls = <Map<String, dynamic>>[
      <String, dynamic>{
        'guestId': 'same',
        'nativeId': 1,
        'label': 'First',
        'role': 'tab',
        'rect': <String, num>{'x': 0, 'y': 0, 'w': 10, 'h': 10},
      },
      <String, dynamic>{
        'guestId': 'same',
        'nativeId': 2,
        'label': 'Duplicate',
        'role': 'button',
        'rect': <String, num>{'x': 0, 'y': 0, 'w': 10, 'h': 10},
      },
      <String, dynamic>{'guestId': 'malformed'},
    ];
    for (var index = 0; index < PocketSemanticsSnapshot.maxNodes + 4; index++) {
      controls.add(<String, dynamic>{
        'guestId': 'node-$index',
        'nativeId': index + 10,
        'label': 'Node $index',
        'role': 'button',
        'rect': <String, num>{'x': 0, 'y': 0, 'w': 10, 'h': 10},
      });
    }
    final snapshot = PocketSemanticsSnapshot.fromDynamic(<String, dynamic>{
      'generation': 2,
      'controls': controls,
    });
    expect(snapshot.nodes.length, PocketSemanticsSnapshot.maxNodes);
    expect(snapshot.nodes.first.guestId, 'same');
    expect(
      snapshot.nodes.where((node) => node.guestId == 'same'),
      hasLength(1),
    );
  });

  testWidgets(
    'overlay keeps pointer input pass-through and sends semantic tap',
    (tester) async {
      final semanticsHandle = tester.ensureSemantics();
      var pointerTaps = 0;
      final sent = <Map<String, dynamic>>[];
      const snapshot = PocketSemanticsSnapshot(
        generation: 9,
        nodes: <PocketSemanticsNode>[
          PocketSemanticsNode(
            guestId: 'apple.save',
            nativeId: 42,
            label: 'Save',
            role: 'button',
            rect: Rect.fromLTWH(10, 20, 40, 30),
            selected: false,
            disabled: false,
            enabled: true,
            checked: false,
          ),
        ],
      );

      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 120,
            height: 100,
            child: PocketSemanticsOverlay(
              snapshot: snapshot,
              scaleX: 2,
              scaleY: 1.5,
              sendEvent: (method, params) {
                sent.add(<String, dynamic>{'method': method, 'params': params});
                return true;
              },
              child: GestureDetector(
                onTap: () => pointerTaps++,
                child: const SizedBox.expand(
                  child: ColoredBox(color: Color(0xff123456)),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(
        tester.getSemantics(find.byKey(const ValueKey<String>('apple.save'))),
        matchesSemantics(
          label: 'Save',
          // SemanticsNode.rect is local to the positioned node; the scaled
          // offset/transform is carried by its parent Stack.
          rect: const Rect.fromLTWH(0, 0, 80, 45),
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          hasToggledState: true,
          isToggled: false,
          hasTapAction: true,
        ),
      );

      await tester.tapAt(const Offset(25, 35));
      expect(
        pointerTaps,
        1,
        reason: 'IgnorePointer must leave ordinary guest input intact',
      );

      tester.semantics.performAction(
        find.semantics.byLabel('Save'),
        SemanticsAction.tap,
      );
      expect(sent, <Map<String, dynamic>>[
        <String, dynamic>{
          'method': pocketAccessibilityActionEvent,
          'params': <String, dynamic>{
            'action': 'activate',
            'guestId': 'apple.save',
            'nativeId': 42,
            'generation': 9,
          },
        },
      ]);
      semanticsHandle.dispose();
    },
  );
}
