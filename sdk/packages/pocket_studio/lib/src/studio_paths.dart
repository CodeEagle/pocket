import 'package:pocket_services/pocket_services.dart';

final RegExp _projectId = RegExp(r'^[a-z][a-z0-9-]{0,47}$');
final RegExp _opaqueId = RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');
final RegExp _driveLetter = RegExp(r'^[A-Za-z]:');
final RegExp _encodedDanger = RegExp(r'%(?:2[eEfF]|5[cC]|00)');

PocketCapabilityException _invalid(String message) =>
    PocketCapabilityException('invalid_params', message);

/// Project ids use the service's own pattern, checked before any URL is built.
String studioProjectId(Object? value, [String name = 'project']) {
  if (value is! String || !_projectId.hasMatch(value)) {
    throw _invalid('$name must match [a-z][a-z0-9-]{0,47}');
  }
  return value;
}

/// Opaque service-issued ids (upload ids, deployment jobs).
String studioOpaqueId(Object? value, String name) {
  if (value is! String || !_opaqueId.hasMatch(value)) {
    throw _invalid('$name is not a valid identifier');
  }
  return value;
}

/// Validates a project-relative path and returns its segments. Rejects
/// absolute paths, backslashes, NUL/control characters, empty, `.` and `..`
/// segments and percent-encoded separators or dots. Segments are URL-encoded
/// later by [Uri]; the service applies its own (stricter) policy as well.
List<String> studioRelativePath(Object? value, [String name = 'path']) {
  if (value is! String || value.isEmpty) {
    throw _invalid('$name must be a non-empty string');
  }
  if (value.length > 1024) throw _invalid('$name is too long');
  for (final unit in value.codeUnits) {
    if (unit < 0x20 || unit == 0x7f) {
      throw _invalid('$name contains a control character');
    }
  }
  if (value.startsWith('/') || value.contains('\\') || _driveLetter.hasMatch(value)) {
    throw _invalid('$name must be project-relative');
  }
  final segments = value.split('/');
  for (final segment in segments) {
    if (segment.isEmpty || segment == '.' || segment == '..') {
      throw _invalid('$name contains an empty or dot segment');
    }
    if (segment.length > 255 || _encodedDanger.hasMatch(segment)) {
      throw _invalid('$name contains an unsafe segment');
    }
  }
  return segments;
}
