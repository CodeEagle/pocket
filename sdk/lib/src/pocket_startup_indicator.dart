import 'package:flutter/material.dart';

/// Lightweight host-only progress for the period before a guest can render.
///
/// This stays inside `src/` because startup presentation is not part of the
/// public component API. The session supplies observed package-transfer facts;
/// an absent or zero total keeps the bar indeterminate.
final class PocketStartupIndicator extends StatelessWidget {
  const PocketStartupIndicator({
    super.key,
    required this.stage,
    this.downloadedBytes,
    this.totalBytes,
    this.foregroundColor,
  });

  final String stage;
  final int? downloadedBytes;
  final int? totalBytes;
  final Color? foregroundColor;

  String get _stageLabel => switch (stage) {
    'index' => '读取应用索引',
    'descriptor' => '读取宿主配置',
    'bootstrapAsset' => '读取启动资源',
    'checking' => '检查更新',
    'downloading' => '下载资源',
    'verifying' || 'verified' => '校验资源',
    'loading' || 'ready' => '准备首帧',
    _ => '初始化',
  };

  String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    const units = <String>['KB', 'MB', 'GB', 'TB'];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    final decimals = value >= 100
        ? 0
        : value >= 10
        ? 1
        : 2;
    var formatted = value.toStringAsFixed(decimals);
    if (formatted.contains('.')) {
      formatted = formatted
          .replaceFirst(RegExp(r'0+$'), '')
          .replaceFirst(RegExp(r'\.$'), '');
    }
    return '$formatted ${units[unit]}';
  }

  String? get _byteSummary {
    final received = downloadedBytes;
    if (received == null || received < 0) return null;
    final total = totalBytes;
    if (total == null || total <= 0) {
      return '已下载 ${_formatBytes(received)}';
    }

    final fraction = (received / total).clamp(0.0, 1.0);
    final percent = (fraction * 100).round();
    return '已下载 ${_formatBytes(received)} / ${_formatBytes(total)} · $percent%';
  }

  @override
  Widget build(BuildContext context) {
    final foreground =
        foregroundColor ?? Theme.of(context).colorScheme.onSurface;
    final hasKnownTotal = totalBytes != null && totalBytes! > 0;
    final hasKnownReceived = downloadedBytes != null && downloadedBytes! >= 0;
    final double? fraction = hasKnownTotal && hasKnownReceived
        ? (downloadedBytes! / totalBytes!).clamp(0.0, 1.0)
        : null;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 280),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              LinearProgressIndicator(
                key: const ValueKey<String>('pocket-startup-progress'),
                value: fraction,
                color: foreground,
                backgroundColor: foreground.withValues(alpha: 0.24),
              ),
              const SizedBox(height: 16),
              Text(
                _stageLabel,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: foreground,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (_byteSummary case final summary?) ...[
                const SizedBox(height: 6),
                Text(
                  summary,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: foreground.withValues(alpha: 0.78),
                    fontSize: 12,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
