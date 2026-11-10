// Standalone macOS Release acceptance probe; see release_lan_http_probe.md.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_archive/pocket_archive.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final result = <String, Object?>{
    'release': kReleaseMode,
    'debug': kDebugMode,
  };
  final temp = await Directory.systemTemp.createTemp('pocket-release-lan-');
  final uri = Uri.parse(Platform.environment['POCKET_LAN_HTTP_URL'] ?? '');
  try {
    if (!kReleaseMode || kDebugMode)
      throw StateError('Requires actual Release');
    if (uri.scheme != 'http' || uri.host.isEmpty) {
      throw ArgumentError('Set POCKET_LAN_HTTP_URL to a LAN HTTP host index');
    }
    var rejected = false;
    try {
      await PocketHostConfig.load(uri, trustAnchorDirectory: temp);
    } on FormatException {
      rejected = true;
    }
    if (!rejected) throw StateError('Unapproved HTTP was accepted');
    result['unapprovedHttpRejected'] = true;
    final host = await PocketHostConfig.load(
      uri,
      allowInsecureHttpHosts: {uri.host},
      trustAnchorDirectory: temp,
    );
    result['systemUI'] = host.systemUI.appId;
    for (final app in [host.systemUI, ...host.applications.values]) {
      if (!app.updates!.debugHttpHosts.contains(uri.host)) {
        throw StateError('Lost explicit HTTP permission: ${app.appId}');
      }
    }
    result['childPermissionCount'] = host.applications.length;
    final catalog = await PocketSystemHost.fromHostConfig(
      config: host,
    ).catalogLoader!(null);
    if (catalog?.systemUI.appId != host.systemUI.appId)
      throw StateError('Default reload lost root');
    result['releaseDefaultCatalogReload'] = true;
    final update = host.systemUI.updates!;
    final transport = HttpPocketUpdateTransport();
    try {
      final coordinator = PocketUpdateCoordinator(
        manifestUri: update.manifestUri(host.systemUI.appId),
        appId: host.systemUI.appId,
        trustedKeys: {update.keyId: base64Decode(update.publicKey)},
        store: PocketPackageStore(
          Directory('${temp.path}/packages'),
          archiveExtractor: PocketNativeArchive.extract,
        ),
        transport: transport,
        debugHttpHosts: update.debugHttpHosts,
        requireBytecode: true,
      );
      await coordinator.prepare();
      result['signedPackagePrepared'] = true;
    } finally {
      transport.close();
    }
    final sessionConfig = host.systemUI.copyWith(
      updates: PocketUpdateConfig(
        indexUrl: update.indexUrl,
        baseUrl: update.baseUrl,
        hostVersion: update.hostVersion,
        packageVersion: update.packageVersion,
        keyId: update.keyId,
        publicKey: update.publicKey,
        namespace:
            'release_http_probe_${DateTime.now().microsecondsSinceEpoch}',
        debugHttpHosts: update.debugHttpHosts,
      ),
    );
    final session = PocketSession(config: sessionConfig);
    try {
      try {
        await session.initialize(prepareForOpen: true);
      } on PocketCapabilityException catch (error) {
        if (error.code != 'permission_not_declared') rethrow;
        result['bridgeLimitation'] =
            'Scratch host omits Showcase hardware permissions; signed preparation completed before bridge negotiation';
      }
      result['releaseSessionReachedBridge'] = true;
    } finally {
      try {
        await session.close();
      } on PocketCapabilityException catch (error) {
        if (error.code != 'permission_not_declared') rethrow;
      }
    }
    result['success'] = true;
  } catch (error, stack) {
    result['error'] = '$error';
    result['stack'] = '$stack';
    exitCode = 1;
  } finally {
    final report = const JsonEncoder.withIndent('  ').convert(result);
    stdout.writeln(report);
    final output = Platform.environment['POCKET_RELEASE_PROBE_RESULT'];
    if (output != null) await File(output).writeAsString(report);
    await temp.delete(recursive: true);
  }
  exit(exitCode);
}
