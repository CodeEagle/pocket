import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_platform/pocket_platform.dart';
import 'package:pocket_services/pocket_services.dart';

final class _FakeTransport implements PocketPlatformTransport {
  final Map<String, Object?> responses = <String, Object?>{
    'configureDeepLinks': <String, dynamic>{
      'enabled': true,
      'scheme': 'pocketapp',
    },
    'getInitialLink': <String, dynamic>{'uri': 'pocketapp://cold'},
    'getLatestLink': <String, dynamic>{'uri': 'pocketapp://cold'},
  };
  final List<String> calls = <String>[];
  final List<Map<String, dynamic>> arguments = <Map<String, dynamic>>[];
  PocketPlatformMethodCallHandler? handler;
  Future<void>? configureGate;
  Object? configureError;

  @override
  Future<Object?> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    this.arguments.add(Map<String, dynamic>.from(arguments));
    if (method == 'configureDeepLinks') {
      final gate = configureGate;
      if (gate != null) await gate;
      final error = configureError;
      if (error != null) throw error;
    }
    return responses[method];
  }

  @override
  void setMethodCallHandler(PocketPlatformMethodCallHandler? handler) {
    this.handler = handler;
  }

  Future<void> emit(String method, Object? arguments) async {
    await handler?.call(method, arguments);
  }
}

final class _FakeClock implements PocketPlatformClock {
  int micros = 0;

  @override
  int get elapsedMicroseconds => micros;

  void advance(Duration duration) => micros += duration.inMicroseconds;
}

final class _FakeUi implements PocketPlatformUi {
  final List<SystemUiOverlayStyle> styles = <SystemUiOverlayStyle>[];
  final List<String> haptics = <String>[];

  @override
  Future<void> setSystemUi(SystemUiOverlayStyle style) async {
    styles.add(style);
  }

  @override
  Future<void> performHaptic(String type) async {
    haptics.add(type);
  }
}

({PocketPluginManager manager, PocketHost host}) _managerFor(
  PocketPlugin plugin,
  Set<String> capabilities, {
  List<Map<String, dynamic>>? sent,
}) {
  bool send(String method, Map<String, dynamic> params) {
    sent?.add(<String, dynamic>{'method': method, ...params});
    return true;
  }

  final host = PocketHost(
    registry: PocketHostRegistry(),
    streams: PocketStreamBridge(send: send),
    allowedCapabilities: capabilities,
    send: send,
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.platform',
    sessionId: 'platform-session',
  )..register(plugin);
  return (manager: manager, host: host);
}

({PocketPluginManager manager, PocketHost host}) _managerForPlugins(
  Iterable<PocketPlugin> plugins,
  Set<String> capabilities, {
  List<Map<String, dynamic>>? sent,
}) {
  bool send(String method, Map<String, dynamic> params) {
    sent?.add(<String, dynamic>{'method': method, ...params});
    return true;
  }

  final host = PocketHost(
    registry: PocketHostRegistry(),
    streams: PocketStreamBridge(send: send),
    allowedCapabilities: capabilities,
    send: send,
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.platform',
    sessionId: 'platform-session',
  );
  for (final plugin in plugins) {
    manager.register(plugin);
  }
  return (manager: manager, host: host);
}

void main() {
  test(
    'foreground provider exposes no deep links by default',
    () async {
      final ui = _FakeUi();
      final plugin = PocketPlatformPlugin(ui: ui);
      expect(
        plugin.descriptor.capabilities.keys,
        containsAll(PocketPlatformCapabilities.experience),
      );
      expect(
        plugin.descriptor.capabilities.keys,
        isNot(contains(PocketPlatformCapabilities.linksInitial)),
      );

      final pair = _managerFor(plugin, PocketPlatformCapabilities.experience);
      final availability = pair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.experience,
      );
      await pair.manager.activate(availability);

      final haptic = await pair.manager.invoke(
        PocketPlatformCapabilities.hapticsPerform,
        const <String, dynamic>{'type': PocketPlatformHaptics.selection},
      );
      expect((haptic as Map)['performed'], isTrue);
      expect(ui.haptics, <String>[PocketPlatformHaptics.selection]);

      await pair.manager.dispose();
      pair.host.dispose();
    },
  );

  test(
    'links stay active while foreground-only UI providers are hidden',
    () async {
      final transport = _FakeTransport();
      final clock = _FakeClock();
      final ui = _FakeUi();
      final sent = <Map<String, dynamic>>[];
      final links = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: transport,
        clock: clock,
        deepLinkDedupeWindow: const Duration(milliseconds: 100),
      );
      final platform = PocketPlatformPlugin(ui: ui, clock: clock);
      expect(links.backgroundSafe, isTrue);
      expect(platform.backgroundSafe, isFalse);
      expect(
        links.descriptor.capabilities.keys,
        containsAll(PocketPlatformCapabilities.links),
      );
      expect(
        platform.descriptor.capabilities.keys,
        containsAll(PocketPlatformCapabilities.experience),
      );

      final pair = _managerForPlugins(
        <PocketPlugin>[platform, links],
        <String>{
          ...PocketPlatformCapabilities.experience,
          ...PocketPlatformCapabilities.links,
        },
        sent: sent,
      );
      final availability = pair.manager.negotiate(
        required: const <String>[],
        optional: <String>{
          ...PocketPlatformCapabilities.experience,
          ...PocketPlatformCapabilities.links,
        },
      );
      await pair.manager.activate(availability);
      await pair.manager.invoke(
        PocketPlatformCapabilities.hapticsPerform,
        const <String, dynamic>{'type': PocketPlatformHaptics.selection},
      );
      await pair.host.handle(
        PocketEvent(
          id: 'links-open',
          method: 'stream.open',
          params: <String, dynamic>{
            'streamId': 'links-test',
            'topic': PocketPlatformCapabilities.linksEvents,
          },
        ),
      );
      expect(transport.calls, <String>[
        'configureDeepLinks',
        'getInitialLink',
        'getLatestLink',
      ]);

      final initial =
          await pair.manager.invoke(PocketPlatformCapabilities.linksInitial)
              as Map;
      final latest =
          await pair.manager.invoke(PocketPlatformCapabilities.linksLatest)
              as Map;
      expect(initial['uri'], 'pocketapp://cold');
      expect(latest['uri'], 'pocketapp://cold');

      // Priming initial/latest must not seed callback coalescing: a real
      // callback for the same URI is observable after activation.
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'pocketapp://cold',
      });
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'https://not-accepted.example',
      });
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'pocketapp://next',
      });
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'pocketapp://next',
      });
      clock.advance(const Duration(milliseconds: 101));
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'pocketapp://next',
      });
      expect(links.recentDeepLinks, <String>[
        'pocketapp://cold',
        'pocketapp://cold',
        'pocketapp://next',
        'pocketapp://next',
      ]);

      await pair.manager.deactivate(foregroundOnly: true);
      expect(transport.calls, isNot(contains('disableDeepLinks')));
      expect(transport.handler, isNotNull);
      await expectLater(
        pair.manager.invoke(
          PocketPlatformCapabilities.hapticsPerform,
          const <String, dynamic>{'type': PocketPlatformHaptics.selection},
        ),
        throwsA(isA<PocketCapabilityException>()),
      );
      await expectLater(
        pair.manager.invoke(
          PocketPlatformCapabilities.systemUiSet,
          const <String, dynamic>{'statusBarColor': 0xff315deb},
        ),
        throwsA(isA<PocketCapabilityException>()),
      );

      // A URL received while hidden reaches the still-open links stream.
      await transport.emit('onDeepLink', <String, dynamic>{
        'uri': 'pocketapp://background',
      });
      final hiddenInitial =
          await pair.manager.invoke(PocketPlatformCapabilities.linksInitial)
              as Map;
      final hiddenLatest =
          await pair.manager.invoke(PocketPlatformCapabilities.linksLatest)
              as Map;
      expect(hiddenInitial['uri'], 'pocketapp://cold');
      expect(hiddenLatest['uri'], 'pocketapp://background');
      expect(
        sent
            .where((event) => event['method'] == 'stream.data')
            .map((event) => (event['data'] as Map)['uri'])
            .toList()
            .last,
        'pocketapp://background',
      );
      expect(sent.where((event) => event['method'] == 'stream.done'), isEmpty);

      await pair.manager.activate(availability);
      expect(
        transport.calls.where((call) => call == 'configureDeepLinks').length,
        1,
      );
      final resumedHaptic =
          await pair.manager.invoke(
                PocketPlatformCapabilities.hapticsPerform,
                const <String, dynamic>{
                  'type': PocketPlatformHaptics.selection,
                },
              )
              as Map;
      expect(resumedHaptic['performed'], isTrue);

      await pair.manager.dispose();
      expect(transport.calls.last, 'disableDeepLinks');
      expect(transport.handler, isNull);
      pair.host.dispose();
    },
  );

  test('all five platform capabilities expose bounded generation schemas', () {
    final platform = PocketPlatformPlugin();
    final links = PocketDeepLinkPlugin(deepLinkScheme: 'pocketapp');
    final platformCapabilities = platform.descriptor.capabilities;
    final linkCapabilities = links.descriptor.capabilities;
    expect(platform.descriptor.id, pocketPlatformPluginId);
    expect(links.descriptor.id, pocketDeepLinkPluginId);
    expect(
      platformCapabilities.keys,
      containsAll(PocketPlatformCapabilities.experience),
    );
    expect(
      linkCapabilities.keys,
      containsAll(PocketPlatformCapabilities.links),
    );
    expect(
      platformCapabilities.keys,
      isNot(contains(PocketPlatformCapabilities.linksInitial)),
    );
    expect(
      linkCapabilities.keys,
      isNot(contains(PocketPlatformCapabilities.systemUiSet)),
    );
    for (final name in <String>[
      PocketPlatformCapabilities.systemUiSet,
      PocketPlatformCapabilities.hapticsPerform,
    ]) {
      expect(platformCapabilities[name]!.schema, isNotNull, reason: name);
    }
    for (final name in PocketPlatformCapabilities.links) {
      expect(linkCapabilities[name]!.schema, isNotNull, reason: name);
    }
    expect((platform.descriptor.toJson()['capabilities'] as List).length, 2);
    expect((links.descriptor.toJson()['capabilities'] as List).length, 3);
  });

  test(
    'links admit only one process-local owner and a non-owner cannot disable it',
    () async {
      final firstTransport = _FakeTransport();
      final secondTransport = _FakeTransport();
      final first = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: firstTransport,
      );
      final second = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: secondTransport,
      );
      final firstPair = _managerFor(first, PocketPlatformCapabilities.links);
      final secondPair = _managerFor(second, PocketPlatformCapabilities.links);
      final availability = firstPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.links,
      );
      final secondAvailability = secondPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.links,
      );
      await firstPair.manager.activate(availability);
      await expectLater(
        secondPair.manager.activate(secondAvailability),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'links_owner_busy',
          ),
        ),
      );
      expect(secondTransport.calls, isEmpty);
      expect(firstTransport.handler, isNotNull);

      await secondPair.manager.dispose();
      expect(secondTransport.calls, isEmpty);
      expect(firstTransport.handler, isNotNull);
      await firstPair.manager.dispose();
      expect(firstTransport.calls.last, 'disableDeepLinks');
      firstPair.host.dispose();
      secondPair.host.dispose();
    },
  );

  test(
    'failed or late link activation releases its owner and native state',
    () async {
      final failedTransport = _FakeTransport()
        ..configureError = const PocketCapabilityException(
          'platform_configure_failed',
          'configure failed',
        );
      final failed = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: failedTransport,
      );
      final failedPair = _managerFor(failed, PocketPlatformCapabilities.links);
      final failedAvailability = failedPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.links,
      );
      await expectLater(
        failedPair.manager.activate(failedAvailability),
        throwsA(isA<PocketCapabilityException>()),
      );
      expect(failedTransport.calls, <String>[
        'configureDeepLinks',
        'disableDeepLinks',
      ]);
      expect(failedTransport.handler, isNull);

      final lateTransport = _FakeTransport();
      final gate = Completer<void>();
      lateTransport.configureGate = gate.future;
      final late = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: lateTransport,
      );
      final latePair = _managerFor(late, PocketPlatformCapabilities.links);
      final lateAvailability = latePair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.links,
      );
      final activation = latePair.manager.activate(lateAvailability);
      await Future<void>.delayed(Duration.zero);
      final disposal = late.dispose();
      gate.complete();
      await activation;
      await disposal;
      expect(lateTransport.calls, contains('disableDeepLinks'));
      expect(lateTransport.handler, isNull);

      final nextTransport = _FakeTransport();
      final next = PocketDeepLinkPlugin(
        deepLinkScheme: 'pocketapp',
        transport: nextTransport,
      );
      final nextPair = _managerFor(next, PocketPlatformCapabilities.links);
      final nextAvailability = nextPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.links,
      );
      await nextPair.manager.activate(nextAvailability);
      expect(nextTransport.calls, contains('configureDeepLinks'));
      await nextPair.manager.dispose();
      failedPair.host.dispose();
      latePair.host.dispose();
      nextPair.host.dispose();
    },
  );

  test(
    'system UI owners restore the real host base after older owner removal',
    () async {
      final base = SystemChrome.latestStyle ?? const SystemUiOverlayStyle();
      final firstUi = _FakeUi();
      final secondUi = _FakeUi();
      final first = PocketPlatformPlugin(ui: firstUi);
      final second = PocketPlatformPlugin(ui: secondUi);
      final firstPair = _managerFor(
        first,
        PocketPlatformCapabilities.experience,
      );
      final secondPair = _managerFor(
        second,
        PocketPlatformCapabilities.experience,
      );
      final firstAvailability = firstPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.experience,
      );
      final secondAvailability = secondPair.manager.negotiate(
        required: const <String>[],
        optional: PocketPlatformCapabilities.experience,
      );
      await firstPair.manager.activate(firstAvailability);
      await secondPair.manager.activate(secondAvailability);
      await firstPair.manager.invoke(
        PocketPlatformCapabilities.systemUiSet,
        const <String, dynamic>{
          'statusBarColor': 0xff123456,
          'statusBarIconBrightness': 'light',
        },
      );
      await secondPair.manager.invoke(
        PocketPlatformCapabilities.systemUiSet,
        const <String, dynamic>{
          'statusBarColor': 0xffabcdef,
          'statusBarIconBrightness': 'dark',
        },
      );
      expect(firstUi.styles.single.statusBarColor, const Color(0xff123456));
      expect(secondUi.styles.single.statusBarColor, const Color(0xffabcdef));
      await firstPair.manager.dispose();
      // Removing a non-top owner cannot restore its stale style over B.
      expect(secondUi.styles.last.statusBarColor, const Color(0xffabcdef));
      await secondPair.manager.dispose();
      expect(secondUi.styles.length, 2);
      expect(secondUi.styles.last.statusBarColor, base.statusBarColor);
      expect(
        secondUi.styles.last.statusBarIconBrightness,
        base.statusBarIconBrightness,
      );
      firstPair.host.dispose();
      secondPair.host.dispose();
    },
  );

  test('haptics validate enum and rate limit calls without polling', () async {
    final ui = _FakeUi();
    final clock = _FakeClock()..micros = 1000000;
    final plugin = PocketPlatformPlugin(
      ui: ui,
      clock: clock,
      hapticMinInterval: const Duration(seconds: 1),
    );
    final pair = _managerFor(plugin, PocketPlatformCapabilities.experience);
    final availability = pair.manager.negotiate(
      required: const <String>[],
      optional: PocketPlatformCapabilities.experience,
    );
    await pair.manager.activate(availability);
    final first =
        await pair.manager.invoke(
              PocketPlatformCapabilities.hapticsPerform,
              const <String, dynamic>{'type': PocketPlatformHaptics.medium},
            )
            as Map;
    final second =
        await pair.manager.invoke(
              PocketPlatformCapabilities.hapticsPerform,
              const <String, dynamic>{'type': PocketPlatformHaptics.medium},
            )
            as Map;
    // A backwards wall-clock jump must not make a prior haptic permanently
    // rate-limit the provider. The production clock is monotonic; this fake
    // explicitly exercises the defensive branch.
    clock.micros = 0;
    final afterClockRollback =
        await pair.manager.invoke(
              PocketPlatformCapabilities.hapticsPerform,
              const <String, dynamic>{'type': PocketPlatformHaptics.medium},
            )
            as Map;
    expect(first['performed'], isTrue);
    expect(second['performed'], isFalse);
    expect(afterClockRollback['performed'], isTrue);
    expect(ui.haptics, <String>[
      PocketPlatformHaptics.medium,
      PocketPlatformHaptics.medium,
    ]);
    await expectLater(
      pair.manager.invoke(
        PocketPlatformCapabilities.hapticsPerform,
        const <String, dynamic>{'type': 'unknown'},
      ),
      throwsA(isA<PocketCapabilityException>()),
    );
    await pair.manager.dispose();
    pair.host.dispose();
  });

  test('custom URL schemes reject web, file and script schemes', () {
    for (final scheme in <String>[
      '',
      'http',
      'https',
      'file',
      'data',
      'javascript',
      'content',
      'intent',
      'Intent',
      ' pocketapp',
      'bad scheme',
      '1pocket',
      List<String>.filled(33, 'a').join(),
    ]) {
      expect(
        () => PocketDeepLinkPlugin(deepLinkScheme: scheme),
        throwsArgumentError,
        reason: scheme,
      );
    }
    expect(
      () => PocketDeepLinkPlugin(
        deepLinkScheme: List<String>.filled(32, 'a').join(),
      ),
      returnsNormally,
    );
    expect(
      () => PocketDeepLinkPlugin(
        deepLinkSchemes: const <String>{'pocketapp', 'other'},
      ),
      throwsArgumentError,
    );
  });
}
