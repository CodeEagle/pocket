import 'dart:io';

import 'package:test/test.dart';

import 'package:pocket_sdk/src/pocket_platform_data.dart';

void main() {
  late Directory directory;
  late PocketPlatformData store;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('pocket-platform-data-');
    store = PocketPlatformData(directory: directory);
    await store.initialize();
  });

  tearDown(() async {
    await store.close();
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test('isolates private values and enforces shared namespace ACL', () async {
    store.registerApp('app.a', sharedNamespaces: {'account'});
    store.registerApp('app.b', sharedNamespaces: {'account'});

    final value = <String, Object?>{
      'name': 'Ada',
      'roles': <Object?>['admin'],
    };
    await store.write('app.a', 'profile', value);
    value['name'] = 'mutated-after-write';
    expect(await store.read('app.a', 'profile'), {
      'name': 'Ada',
      'roles': ['admin'],
    });
    expect(await store.read('app.b', 'profile'), isNull);
    expect(await store.keys('app.b'), isEmpty);

    await store.write('app.a', 'user', 'Ada', namespace: 'account');
    expect(await store.read('app.b', 'user', namespace: 'account'), 'Ada');
    expect(
      () => store.read('app.b', 'user', namespace: 'private'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'shared_namespace_denied',
        ),
      ),
    );
    expect(await store.keys('app.a'), ['profile']);
    expect(await store.keys('app.a', namespace: 'account'), ['user']);
  });

  test('rejects non-JSON values and path-like identifiers', () async {
    store.registerApp('app.a');
    final cyclic = <String, Object?>{};
    cyclic['self'] = cyclic;
    expect(
      () => store.write('app.a', 'date', DateTime.now()),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_value',
        ),
      ),
    );
    expect(
      () => store.write('app.a', '../escape', 1),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_key',
        ),
      ),
    );
    expect(
      () => store.registerApp('../app'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_app_id',
        ),
      ),
    );
    expect(
      () => store.write('app.a', 'nan', double.nan),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(
      () => store.write('app.a', 'cycle', cyclic),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('recovers app and shared values after restart', () async {
    store.registerApp('app.a', sharedNamespaces: {'account'});
    await store.write('app.a', 'counter', 7);
    await store.write('app.a', 'user', 'Ada', namespace: 'account');
    await store.close();
    final reopened = PocketPlatformData(directory: directory);
    await reopened.initialize();
    reopened.registerApp('app.a', sharedNamespaces: {'account'});
    expect(await reopened.read('app.a', 'counter'), 7);
    expect(await reopened.read('app.a', 'user', namespace: 'account'), 'Ada');
    await reopened.close();
  });

  test(
    'quota failures preserve old values and shared quota is per namespace',
    () async {
      await store.close();
      store = PocketPlatformData(
        directory: directory,
        maxValueBytes: 128,
        maxAppBytes: 80,
      );
      await store.initialize();
      store.registerApp('app.a', sharedNamespaces: {'common'});
      store.registerApp('app.b', sharedNamespaces: {'common'});
      await store.write('app.a', 'value', 'old');
      expect(
        store.write('app.a', 'value', 'x' * 200),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'value_too_large',
          ),
        ),
      );
      expect(await store.read('app.a', 'value'), 'old');

      await store.write('app.a', 'one', 'x' * 20, namespace: 'common');
      expect(
        store.write('app.b', 'two', 'y' * 80, namespace: 'common'),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'quota_exceeded',
          ),
        ),
      );
      expect(await store.read('app.a', 'one', namespace: 'common'), 'x' * 20);
      expect(await store.read('app.b', 'two', namespace: 'common'), isNull);
    },
  );

  test(
    'serializes concurrent writes and rejects late calls after close',
    () async {
      store.registerApp('app.a');
      await Future.wait([
        store.write('app.a', 'a', 1),
        store.write('app.a', 'b', 2),
        store.write('app.a', 'c', 3),
      ]);
      expect(await store.keys('app.a'), ['a', 'b', 'c']);
      await store.close();
      expect(
        store.read('app.a', 'a'),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'closed',
          ),
        ),
      );
      expect(
        () => store.registerApp('app.b'),
        throwsA(isA<PocketCapabilityException>()),
      );
    },
  );

  test('lets operations already queued before close finish', () async {
    store.registerApp('app.a');
    final queuedWrite = store.write('app.a', 'beforeClose', true);
    final closeFuture = store.close();
    await queuedWrite;
    await closeFuture;
  });

  test(
    'concurrent initialize calls share one startup and close follows it',
    () async {
      await store.close();
      final concurrent = PocketPlatformData(directory: directory);
      final first = concurrent.initialize();
      final second = concurrent.initialize();
      final closeFuture = concurrent.close();
      await Future.wait([first, second, closeFuture]);
    },
  );
}
