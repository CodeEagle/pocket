import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

final _surfaceFacts = <int, List<String>>{};
late PocketBundledApplicationCatalog _bundledApplications;

const _showcase = 'pocket.host.demo';
const _profile = 'pocket.demo.profile';
const _lobby = 'pocket.demo.lobby';
const _officialHero = 'dev.pocket-nexus.hero';

Future<PocketSystemInstanceSnapshot> _instance(
  WidgetTester tester,
  PocketSystemHostController host,
  String appId, {
  bool? presented,
}) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final matches = host.instances.where(
      (entry) =>
          entry.appId == appId &&
          entry.firstFrameReady &&
          (presented == null || entry.isPresented == presented),
    );
    if (matches.isNotEmpty) return matches.single;
  }
  fail(
    'No ready instance $appId; facts=${host.instances.map((e) => '${e.appId}:${e.instanceId}:${e.ready}:${e.firstFrameReady}:${e.isPresented}:foreground=${e.foreground}:pending=${e.session.controller.pendingMessageCount}').toList()}; surfaces=$_surfaceFacts; texts=${guest.texts(tester)}',
  );
}

void _hiddenTickerStopped(WidgetTester tester, PocketSession session) {
  final finder = find.byWidgetPredicate(
    (widget) =>
        widget is PocketView &&
        identical(widget.controller, session.controller),
    skipOffstage: false,
  );
  final dynamic state = tester.state(finder);
  expect(
    state.isTickerActive,
    isFalse,
    reason: 'hidden app must stop its ticker',
  );
  expect(session.foreground, isFalse);
}

Future<int> _openLatency(
  WidgetTester tester,
  PocketSystemHostController host, {
  bool revealFromBelow = false,
}) async {
  final point = revealFromBelow
      ? await _revealLobbyFromBelow(tester)
      : await guest.reveal(tester, 'Open lobby app');
  final down = await tester.startGesture(point);
  await tester.pump(const Duration(milliseconds: 50));
  final clock = Stopwatch()..start();
  await down.up();
  await _instance(tester, host, _lobby, presented: true);
  return clock.elapsedMilliseconds;
}

Future<Offset> _revealLobbyFromBelow(WidgetTester tester) async {
  for (var attempt = 0; attempt < 12; attempt++) {
    if (guest.pointFor(tester, 'Open lobby app') != null) {
      return guest.reveal(tester, 'Open lobby app', scroll: false);
    }
    final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
    final gesture = await tester.startGesture(
      box.localToGlobal(Offset(box.size.width * .35, box.size.height * .4)),
    );
    for (var sample = 0; sample < 10; sample++) {
      await gesture.moveBy(const Offset(0, 23));
      await tester.pump(const Duration(milliseconds: 16));
      if (guest.pointFor(tester, 'Open lobby app') != null) break;
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
  }
  return guest.reveal(tester, 'Open lobby app', scroll: false);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  setUp(() async {
    _bundledApplications = await PocketBundledApplicationCatalog.loadFromBundle(
      'assets/apps/official/catalog.json',
      assetPrefix: 'assets/',
      firstCompositorHandle: 4,
      lastCompositorHandle: 62,
      reservedAppIds: const <String>{'pocket.host.demo'},
    );
    _surfaceFacts.clear();
    debugPocketFrameDeltaAtOverride = (runtime, delta) {
      final frame = pocketFrameDeltaAt(runtime, delta);
      if (frame != null) {
        _surfaceFacts[identityHashCode(runtime)] = [
          for (final op in frame.ops.whereType<PocketHostSurfaceOp>())
            '${op.kind}:${op.surfaceHandle}:${op.x},${op.y},${op.width},${op.height}:focus=${op.focused}',
        ];
      }
      return frame;
    };
  });
  tearDown(() => debugPocketFrameDeltaAtOverride = null);

  testWidgets(
    'JS SystemUI opens real A/B guests, shares identity, returns results and messages',
    (tester) async {
      final host = PocketSystemHostController();
      try {
        await tester.pumpWidget(
          pocketHostApp(
            systemController: host,
            bundledApplications: _bundledApplications,
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '+1');
        await guest.waitFor(tester, '01');
        final root = await _instance(tester, host, _showcase, presented: true);
        await guest.tapGuest(tester, 'Open profile app');
        final profile = await _instance(
          tester,
          host,
          _profile,
          presented: true,
        );
        await guest.waitFor(tester, 'Pocket Profile');
        expect(profile.instanceId, isNot(root.instanceId));
        expect(
          root.session.foreground,
          isTrue,
          reason: 'SystemUI control realm stays available',
        );
        expect(
          host.instances.singleWhere((e) => e.appId == _showcase).isPresented,
          isTrue,
          reason:
              'SystemUI remains the compositor root beneath its child surface',
        );

        expect(profile.compositorFocused, isTrue);

        await guest.tapGuest(tester, 'Lin Mei (VIP 7)');
        await guest.tapGuest(tester, 'Save identity & open Lobby');
        await guest.waitFor(tester, 'Pocket Lobby');
        await guest.waitFor(tester, 'Lin Mei');
        final lobby = await _instance(tester, host, _lobby, presented: true);
        expect(lobby.instanceId, isNot(profile.instanceId));
        expect(host.instances, hasLength(3));
        _hiddenTickerStopped(tester, profile.session);
        await Future<void>.delayed(const Duration(milliseconds: 300));
        _hiddenTickerStopped(tester, profile.session);

        await guest.tapGuest(tester, 'Increment lobby counter');
        await guest.waitForContaining(tester, 'visits=1');
        await guest.tapGuest(tester, 'Return visits to caller');
        // Profile resumes with its selected/stored identity intact. Returning
        // from Profile to SystemUI remains an explicit user action, without a
        // Dart-owned navigation stack.
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.waitForContaining(tester, 'Last shared value: Lin Mei');
        await guest.waitForContaining(tester, 'Profile remains available');
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.reveal(tester, 'Prewarm lobby');
        await guest.waitForContaining(tester, 'App result:');
        await guest.waitForContaining(tester, 'Lin Mei');
        await guest.waitForContaining(tester, 'Message from pocket.demo.lobby');
        expect(
          guest.texts(tester).any((text) => text.contains('visits=1')),
          isTrue,
        );
        expect(
          host.instances.singleWhere((e) => e.appId == _showcase).instanceId,
          root.instanceId,
        );
        await guest.tapGuest(tester, 'Gallery');
        await guest.waitFor(tester, 'Official building blocks');
        await guest.tapGuest(tester, 'Home');
        await guest.waitFor(tester, '01');
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        host.dispose();
      }
    },
  );

  testWidgets(
    'prewarm ablation reuses a real hidden realm within the resident bound',
    (tester) async {
      final host = PocketSystemHostController();
      try {
        await tester.pumpWidget(
          pocketHostApp(
            systemController: host,
            bundledApplications: _bundledApplications,
          ),
        );
        await guest.waitFor(tester, '00');
        final coldMs = await _openLatency(tester, host);
        await guest.waitFor(tester, 'Pocket Lobby');
        final cold = await _instance(tester, host, _lobby, presented: true);
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.reveal(tester, 'Prewarm lobby');
        await guest.waitForContaining(tester, 'App result:');
        await guest.tapGuest(tester, 'Prewarm lobby');
        await guest.waitForContaining(tester, 'Lobby prewarmed');
        final warm = await _instance(tester, host, _lobby, presented: false);
        expect(
          warm.instanceId,
          isNot(cold.instanceId),
          reason: 'closed realm must not be resurrected',
        );
        _hiddenTickerStopped(tester, warm.session);
        expect(host.instances.length, lessThanOrEqualTo(3));
        final warmMs = await _openLatency(tester, host, revealFromBelow: true);
        final opened = await _instance(tester, host, _lobby, presented: true);
        expect(
          opened.instanceId,
          warm.instanceId,
          reason: 'prewarm must avoid a second runtime creation',
        );
        expect(identical(opened.session, warm.session), isTrue);
        await guest.waitFor(tester, 'Pocket Lobby');
        // Timing is an observed debug-simulator fact, not a brittle speed threshold.
        // The ablation's functional criterion is reuse vs a new cold instance.
        // ignore: avoid_print
        print(
          'Pocket SystemUI prewarm ablation: cold=${coldMs}ms warm=${warmMs}ms residents=${host.instances.length} reused=${opened.instanceId == warm.instanceId}',
        );
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.reveal(tester, 'Prewarm lobby');
        await guest.waitForContaining(tester, 'App result:');
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        host.dispose();
      }
    },
  );
  testWidgets(
    'Showcase opens the staged official Hero through platform.openApp',
    (tester) async {
      final host = PocketSystemHostController();
      try {
        await tester.pumpWidget(
          pocketHostApp(
            systemController: host,
            bundledApplications: _bundledApplications,
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, 'Open hero demo');
        final hero = await _instance(
          tester,
          host,
          _officialHero,
          presented: true,
        );
        await guest.waitFor(tester, 'PocketJS: Hero');
        await guest.waitFor(tester, 'Count: 0');
        expect(hero.session.failure, isNull);
        expect(hero.compositorFocused, isTrue);

        // Flutter pointer input activates the guest's Focusable. This verifies
        // the pointer fallback path without claiming physical button support.
        await guest.tapGuest(tester, 'Press Circle');
        await guest.waitFor(tester, 'Count: 1');
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        host.dispose();
      }
    },
  );
  testWidgets(
    'runtime failure releases native slots and owner failure retires children',
    (tester) async {
      final host = PocketSystemHostController();
      Future<void> waitUntilClosed(PocketSystemInstanceSnapshot entry) async {
        for (var attempt = 0; attempt < 200; attempt++) {
          await tester.pump(const Duration(milliseconds: 30));
          if (!host.instances.any(
                (item) => item.instanceId == entry.instanceId,
              ) &&
              !entry.session.controller.isReady) {
            return;
          }
        }
        fail('Failed realm was not released: ${entry.instanceId}');
      }

      try {
        await tester.pumpWidget(
          pocketHostApp(
            systemController: host,
            bundledApplications: _bundledApplications,
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, 'Open lobby app');
        await guest.waitFor(tester, 'Pocket Lobby');
        final failed = await _instance(tester, host, _lobby, presented: true);
        // Inject through the same production Session error callback used by
        // PocketView.onError, after a real QJBC guest has produced its frame.
        await failed.session.onError(StateError('integration child failure'));
        await guest.waitForContaining(tester, 'Cancelled: runtime_failed');
        await waitUntilClosed(failed);
        expect(host.instances, hasLength(1));
        expect(failed.session.foreground, isFalse);

        await guest.tapGuest(tester, 'Open lobby app');
        await guest.waitFor(tester, 'Pocket Lobby');
        final replacement = await _instance(
          tester,
          host,
          _lobby,
          presented: true,
        );
        expect(replacement.instanceId, isNot(failed.instanceId));
        final root = host.instances.singleWhere((entry) => entry.isSystemUI);
        await root.session.onError(StateError('integration owner failure'));
        await waitUntilClosed(replacement);
        expect(host.instances, hasLength(1));
        expect(replacement.session.foreground, isFalse);
        expect(
          find.textContaining('integration owner failure'),
          findsOneWidget,
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        host.dispose();
      }
    },
  );
}
