import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _CompositorRuntime implements PocketRuntime {
  _CompositorRuntime(this.frameValue, {this.cloneFrames = false});

  PocketFrame frameValue;
  final bool cloneFrames;
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  int frameCalls = 0;

  @override
  PocketFrame eval(String source) => frameValue;

  @override
  PocketFrame load(String source, Uint8List pak) => frameValue;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls++;
    if (!cloneFrames) return frameValue;
    return PocketFrame(
      width: frameValue.width,
      height: frameValue.height,
      ops: frameValue.ops,
      events: frameValue.events,
      resources: frameValue.resources,
      releasedResources: frameValue.releasedResources,
      auxiliary: frameValue.auxiliary,
    );
  }

  @override
  bool resizeViewport(double width, double height) => true;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    messages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _ChildMounts {
  int initialized = 0;
  int disposed = 0;
  final List<Offset> pointerDowns = <Offset>[];
}

final class _CompositorChild extends StatefulWidget {
  const _CompositorChild({
    super.key,
    required this.mounts,
    required this.color,
  });

  final _ChildMounts mounts;
  final Color color;

  @override
  State<_CompositorChild> createState() => _CompositorChildState();
}

final class _CompositorChildState extends State<_CompositorChild> {
  @override
  void initState() {
    super.initState();
    widget.mounts.initialized++;
  }

  @override
  void dispose() {
    widget.mounts.disposed++;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Listener(
    behavior: HitTestBehavior.opaque,
    onPointerDown: (event) =>
        widget.mounts.pointerDowns.add(event.localPosition),
    child: ColoredBox(color: widget.color),
  );
}

PocketHostSurfaceOp _applicationSurface(
  int handle,
  Rect bounds, {
  Rect? clip,
  required bool focused,
}) => PocketHostSurfaceOp(
  x: bounds.left,
  y: bounds.top,
  width: bounds.width,
  height: bounds.height,
  clip: clip == null
      ? null
      : PocketClip(
          x: clip.left,
          y: clip.top,
          width: clip.width,
          height: clip.height,
        ),
  id: 'app-$handle',
  kind: 'application',
  parameters: const <String, dynamic>{},
  surfaceHandle: handle,
  focused: focused,
);

PocketFrame _sceneFrame({
  required PocketHostSurfaceOp first,
  PocketHostSurfaceOp? second,
}) => PocketFrame(
  width: 200,
  height: 120,
  ops: <PocketOp>[
    const PocketRectOp(x: 0, y: 0, width: 200, height: 120, color: 0xff101827),
    first,
    if (second != null) second,
  ],
  events: const <PocketEvent>[],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'DrawOps slots preserve z-order, clipping, focus, resize, and resident state',
    (tester) async {
      final runtime = _CompositorRuntime(
        _sceneFrame(
          first: _applicationSurface(
            2,
            const Rect.fromLTWH(10, 10, 100, 90),
            focused: false,
          ),
          second: _applicationSurface(
            3,
            const Rect.fromLTWH(40, 30, 120, 80),
            clip: const Rect.fromLTWH(60, 45, 50, 40),
            focused: true,
          ),
        ),
      );
      final firstMounts = _ChildMounts();
      final secondMounts = _ChildMounts();
      final firstKey = GlobalKey<_CompositorChildState>(
        debugLabel: 'child-application-2',
      );
      final secondKey = GlobalKey<_CompositorChildState>(
        debugLabel: 'child-application-3',
      );
      final slots = <PocketCompositorSlot>[];
      final viewKey = GlobalKey();

      Widget buildView(Set<int> residents) => MaterialApp(
        home: Center(
          child: SizedBox(
            width: 200,
            height: 150,
            child: PocketView(
              key: viewKey,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              enableDuplexPointerInput: false,
              hostSurfaceResidents: residents,
              hostSurfaceBuilder: (slot) {
                slots.add(slot);
                return switch (slot.surfaceHandle) {
                  2 => _CompositorChild(
                    key: firstKey,
                    mounts: firstMounts,
                    color: const Color(0xffff0000),
                  ),
                  3 => _CompositorChild(
                    key: secondKey,
                    mounts: secondMounts,
                    color: const Color(0xff0000ff),
                  ),
                  _ => null,
                };
              },
            ),
          ),
        ),
      );

      await tester.pumpWidget(buildView(<int>{2, 3}));
      await tester.pump();

      PocketCompositorSlot latestSlot(int handle) =>
          slots.lastWhere((slot) => slot.surfaceHandle == handle);

      final firstSlot = latestSlot(2);
      final secondSlot = latestSlot(3);
      expect(firstSlot.bounds, const Rect.fromLTWH(10, 10, 100, 90));
      expect(firstSlot.visibleClip, const Rect.fromLTWH(10, 10, 100, 90));
      expect(firstSlot.logicalViewport, const Size(200, 120));
      expect(firstSlot.visible, isTrue);
      expect(firstSlot.focused, isFalse);
      expect(firstSlot.drawIndex, 1);
      expect(secondSlot.bounds, const Rect.fromLTWH(40, 30, 120, 80));
      expect(secondSlot.visibleClip, const Rect.fromLTWH(60, 45, 50, 40));
      expect(secondSlot.visible, isTrue);
      expect(secondSlot.focused, isTrue);
      expect(secondSlot.drawIndex, 2);
      expect(firstMounts.initialized, 1);
      expect(secondMounts.initialized, 1);

      final sceneStack = tester.widget<Stack>(
        find.byWidgetPredicate(
          (widget) =>
              widget is Stack &&
              widget.children.any(
                (child) =>
                    child.key ==
                    const ValueKey<String>('surface-application-2'),
              ),
        ),
      );
      final surfaceKeys = sceneStack.children
          .whereType<Positioned>()
          .map((child) => child.key)
          .where(
            (key) =>
                key == const ValueKey<String>('surface-application-2') ||
                key == const ValueKey<String>('surface-application-3'),
          )
          .toList(growable: false);
      expect(
        surfaceKeys,
        const <Key>[
          ValueKey<String>('surface-application-2'),
          ValueKey<String>('surface-application-3'),
        ],
        reason: 'later DrawOps children paint above earlier child surfaces',
      );

      final secondChildFinder = find.byKey(secondKey);
      final secondClipFinder = find
          .ancestor(of: secondChildFinder, matching: find.byType(ClipRect))
          .first;
      final parentSurfaceRect = tester.getRect(
        find.byKey(const ValueKey<String>('pocket-surface-0')),
      );
      final scaleX = parentSurfaceRect.width / secondSlot.logicalViewport.width;
      final scaleY =
          parentSurfaceRect.height / secondSlot.logicalViewport.height;
      expect(
        tester.getRect(secondClipFinder),
        Rect.fromLTWH(
          parentSurfaceRect.left + secondSlot.visibleClip.left * scaleX,
          parentSurfaceRect.top + secondSlot.visibleClip.top * scaleY,
          secondSlot.visibleClip.width * scaleX,
          secondSlot.visibleClip.height * scaleY,
        ),
        reason:
            'the child remains at its full logical size under the viewport clip',
      );

      Offset hostPoint(double x, double y) => Offset(
        parentSurfaceRect.left + x * scaleX,
        parentSurfaceRect.top + y * scaleY,
      );

      await tester.tapAt(hostPoint(45, 40));
      expect(
        firstMounts.pointerDowns,
        isEmpty,
        reason: 'an unfocused child gets no input',
      );
      expect(
        secondMounts.pointerDowns,
        isEmpty,
        reason: 'a point outside the child clip is ignored',
      );
      expect(
        runtime.messages.where((message) => message['name'] == 'input.pointer'),
        isNotEmpty,
        reason: 'the parent retains input outside the focused child clip',
      );

      runtime.messages.clear();
      await tester.tapAt(hostPoint(70, 60));
      expect(
        firstMounts.pointerDowns,
        isEmpty,
        reason: 'unfocused overlap cannot steal input',
      );
      expect(secondMounts.pointerDowns, contains(const Offset(30, 30)));
      expect(
        runtime.messages.where((message) => message['name'] == 'input.pointer'),
        isEmpty,
        reason:
            'focused child input is not also dispatched to the parent realm',
      );

      runtime.frameValue = _sceneFrame(
        first: _applicationSurface(
          2,
          const Rect.fromLTWH(10, 10, 100, 90),
          focused: false,
        ),
        second: _applicationSurface(
          3,
          const Rect.fromLTWH(80, 20, 70, 50),
          clip: const Rect.fromLTWH(90, 25, 30, 25),
          focused: true,
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(runtime.frameCalls, greaterThan(0));
      expect(latestSlot(3).bounds, const Rect.fromLTWH(80, 20, 70, 50));
      expect(latestSlot(3).visibleClip, const Rect.fromLTWH(90, 25, 30, 25));
      expect(latestSlot(3).logicalViewport, const Size(200, 120));
      expect(tester.getSize(find.byKey(secondKey)), const Size(70, 50));
      expect(
        secondMounts.initialized,
        1,
        reason: 'resize preserves the guest element state',
      );
      expect(secondMounts.disposed, 0);

      runtime.frameValue = _sceneFrame(
        first: _applicationSurface(
          2,
          const Rect.fromLTWH(10, 10, 100, 90),
          focused: false,
        ),
        second: _applicationSurface(
          3,
          const Rect.fromLTWH(80, 20, 70, 50),
          clip: const Rect.fromLTWH(300, 200, 30, 25),
          focused: true,
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(latestSlot(3).visible, isFalse);
      expect(latestSlot(3).focused, isFalse);
      expect(latestSlot(3).bounds, const Rect.fromLTWH(80, 20, 70, 50));
      expect(secondMounts.initialized, 1);
      expect(
        secondMounts.disposed,
        0,
        reason: 'a fully clipped child remains resident',
      );
      final retainedFinder = find.byKey(secondKey, skipOffstage: false);
      expect(retainedFinder, findsOneWidget);
      final offstage = tester.widget<Offstage>(
        find
            .ancestor(
              of: retainedFinder,
              matching: find.byType(Offstage, skipOffstage: false),
            )
            .first,
      );
      expect(offstage.offstage, isTrue);

      runtime.frameValue = _sceneFrame(
        first: _applicationSurface(
          2,
          const Rect.fromLTWH(10, 10, 100, 90),
          focused: true,
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(latestSlot(3).visible, isFalse);
      expect(latestSlot(3).focused, isFalse);
      expect(latestSlot(3).drawIndex, -1);
      expect(secondMounts.initialized, 1);
      expect(
        secondMounts.disposed,
        0,
        reason: 'a hidden resident stays mounted Offstage',
      );

      await tester.pumpWidget(buildView(<int>{2}));
      expect(
        secondMounts.disposed,
        1,
        reason: 'destroying the resident releases its keyed subtree',
      );
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'a stable focused child does not cancel a parent pointer sequence',
    (tester) async {
      PocketFrame frameFor({
        required bool focusFirst,
        required bool focusSecond,
      }) => _sceneFrame(
        first: _applicationSurface(
          2,
          const Rect.fromLTWH(130, 10, 55, 55),
          focused: focusFirst,
        ),
        second: _applicationSurface(
          3,
          const Rect.fromLTWH(70, 10, 55, 55),
          focused: focusSecond,
        ),
      );

      final runtime = _CompositorRuntime(
        frameFor(focusFirst: false, focusSecond: true),
        cloneFrames: true,
      );
      final viewKey = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: SizedBox(
              width: 200,
              height: 120,
              child: PocketView(
                key: viewKey,
                runtime: runtime,
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
                enableDuplexPointerInput: false,
                hostSurfaceBuilder: (_) =>
                    const ColoredBox(color: Color(0xff405060)),
              ),
            ),
          ),
        ),
      );
      // Let the view remember the initial focused handle before starting the
      // parent gesture. Each later fake frame is a fresh frame object carrying
      // the same focused child, as a real native frame does.
      await tester.pump(const Duration(milliseconds: 16));

      final parent = tester.getRect(
        find.byKey(const ValueKey<String>('pocket-surface-0')),
      );
      final scaleX = parent.width / 200;
      final scaleY = parent.height / 120;
      Offset hostPoint(double x, double y) =>
          Offset(parent.left + x * scaleX, parent.top + y * scaleY);
      List<String?> pointerPhases() => runtime.messages
          .where((message) => message['name'] == 'input.pointer')
          .map((message) {
            final parameters = message['payload'] ?? message['params'];
            return parameters is Map ? parameters['phase'] as String? : null;
          })
          .toList(growable: false);

      final stableFocusGesture = await tester.startGesture(hostPoint(20, 95));
      expect(pointerPhases(), <String?>['down']);
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        pointerPhases(),
        <String?>['down'],
        reason: 'an unchanged focused app must preserve the parent contact',
      );
      await stableFocusGesture.up();
      expect(pointerPhases(), <String?>['down', 'up']);

      runtime.messages.clear();
      final changingFocusGesture = await tester.startGesture(hostPoint(20, 95));
      expect(pointerPhases(), <String?>['down']);
      runtime.frameValue = frameFor(focusFirst: true, focusSecond: false);
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        pointerPhases(),
        <String?>['down', 'cancel'],
        reason: 'changing focus to another app must retire the parent route',
      );
      await changingFocusGesture.up();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
