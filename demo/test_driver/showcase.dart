import 'dart:convert';
import 'dart:io';
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver(
  writeResponseOnFailure: true,
  responseDataCallback: (data) async {
    final performance = data?['performance'];
    if (performance != null) {
      await Directory('artifacts/performance').create(recursive: true);
      await File(
        'artifacts/performance/sdk-iphone-duo.json',
      ).writeAsString(const JsonEncoder.withIndent('  ').convert(performance));
    }
    final geometry = data?['geometry'];
    if (geometry != null) {
      await Directory('artifacts/showcase').create(recursive: true);
      await File(
        'artifacts/showcase/duo-geometry.json',
      ).writeAsString(const JsonEncoder.withIndent('  ').convert(geometry));
    }
    final captures = data?['captures'];
    if (captures is! Map) return;
    final directory = Directory('artifacts/showcase');
    await directory.create(recursive: true);
    for (final entry in captures.entries) {
      final name = entry.key.toString();
      if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(name)) continue;
      await File(
        '${directory.path}/$name.png',
      ).writeAsBytes(base64Decode(entry.value as String));
    }
  },
);
