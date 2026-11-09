import 'package:flutter/material.dart';
import 'package:pocket_services/pocket_services.dart'
    show PocketPackagePreparationProgress, PocketPackagePreparationStage;

/// Lightweight host-only progress for the period before a guest can render.
///
/// Transfer percentages come only from observed byte counts. Once those counts
/// show a completed transfer, verification gets its own indeterminate indicator
/// so the completed download cannot read as completed startup.
final class PocketStartupIndicator extends StatelessWidget {
  const PocketStartupIndicator({
    super.key,
    required this.stage,
    this.preparationProgress,
    this.downloadedBytes,
    this.totalBytes,
    this.foregroundColor,
  });

  final String stage;
  final PocketPackagePreparationProgress? preparationProgress;
  final int? downloadedBytes;
  final int? totalBytes;
  final Color? foregroundColor;

  bool get _isTransferring => stage == 'downloading' || stage == 'retry';

  bool get _isVerifying => stage == 'verifying' || stage == 'verified';

  String get _stageLabel => switch (stage) {
    'index' => '读取应用索引',
    'descriptor' => '读取宿主配置',
    'bootstrapAsset' => '读取启动资源',
    'checking' => '检查更新',
    'downloading' => '下载资源',
    'retry' => '重试下载资源',
    'verifying' || 'verified' => '校验资源',
    'loading' || 'ready' => '准备首帧',
    _ => '初始化',
  };

  String get _processingLabel => switch (preparationProgress?.stage) {
    PocketPackagePreparationStage.decodingArchive => '解包资源',
    PocketPackagePreparationStage.verifyingFiles => '校验资源',
    PocketPackagePreparationStage.assemblingPackage => '组装资源包',
    null => _stageLabel,
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

  double? get _transferFraction {
    final received = downloadedBytes;
    final total = totalBytes;
    if (!_isTransferring ||
        received == null ||
        received < 0 ||
        total == null ||
        total <= 0) {
      return null;
    }
    return (received / total).clamp(0.0, 1.0).toDouble();
  }

  String? get _transferSummary {
    if (!_isTransferring) return null;
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

  /// Only a verifying stage can hand off a transfer completion summary.
  /// Cached starts and missing byte facts therefore never imply a 100% download.
  String? get _completedTransferSummary {
    if (!_isVerifying) return null;
    final received = downloadedBytes;
    final total = totalBytes;
    if (received == null ||
        received < 0 ||
        total == null ||
        total <= 0 ||
        received < total) {
      return null;
    }
    return '已下载 ${_formatBytes(received)} / ${_formatBytes(total)} · 100%';
  }

  /// Displays observed preparation counters without turning ongoing package
  /// work into a determinate whole-startup percentage.
  String? get _preparationSummary {
    final progress = preparationProgress;
    if (progress == null) return null;
    final parts = <String>[];
    final processedBytes = progress.processedBytes;
    if (processedBytes != null && processedBytes >= 0) {
      final totalBytes = progress.totalBytes;
      if (totalBytes != null && totalBytes > 0) {
        final fraction = (processedBytes / totalBytes).clamp(0.0, 1.0);
        final percent = (fraction * 100).round();
        parts.add(
          '已处理 ${_formatBytes(processedBytes)} / ${_formatBytes(totalBytes)} · $percent%',
        );
      } else {
        parts.add('已处理 ${_formatBytes(processedBytes)}');
      }
    }
    final processedFiles = progress.processedFiles;
    if (processedFiles != null && processedFiles >= 0) {
      final totalFiles = progress.totalFiles;
      parts.add(
        totalFiles != null && totalFiles > 0
            ? '文件 $processedFiles / $totalFiles'
            : '已处理 $processedFiles 个文件',
      );
    }
    return parts.isEmpty ? null : parts.join(' · ');
  }

  Widget _section({
    required Key key,
    required Key progressKey,
    required String label,
    required String semanticsLabel,
    required double? fraction,
    required Color foreground,
    String? semanticsValue,
    String? summary,
    bool animateDeterminate = false,
  }) {
    final background = foreground.withValues(alpha: 0.24);

    Widget progressBar(double? value) => LinearProgressIndicator(
      key: progressKey,
      value: value,
      color: foreground,
      backgroundColor: background,
      semanticsLabel: semanticsLabel,
      semanticsValue: semanticsValue,
    );

    final bar = animateDeterminate
        ? TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: 0, end: fraction ?? 0),
            duration: const Duration(milliseconds: 200),
            curve: Curves.linear,
            builder: (context, animatedFraction, _) => progressBar(
              fraction == null
                  ? null
                  : animatedFraction.clamp(0.0, 1.0).toDouble(),
            ),
          )
        : progressBar(fraction);

    return Column(
      key: key,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        bar,
        const SizedBox(height: 12),
        Semantics(
          header: true,
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: foreground,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (summary case final value?) ...[
          const SizedBox(height: 4),
          Text(
            value,
            textAlign: TextAlign.center,
            softWrap: true,
            style: TextStyle(
              color: foreground.withValues(alpha: 0.78),
              fontSize: 12,
            ),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final foreground =
        foregroundColor ?? Theme.of(context).colorScheme.onSurface;
    final completedTransfer = _completedTransferSummary;
    final showTransfer = _isTransferring || completedTransfer != null;
    final transferFraction = completedTransfer == null
        ? _transferFraction
        : 1.0;
    final transferSummary = completedTransfer ?? _transferSummary;
    final transferLabel = completedTransfer == null ? _stageLabel : '下载已完成';
    final transferPercent = transferFraction == null
        ? null
        : '${(transferFraction * 100).round()}%';
    final primaryIsTransfer = _isTransferring || completedTransfer != null;
    final primaryLabel = primaryIsTransfer ? transferLabel : _processingLabel;
    final primarySummary = primaryIsTransfer
        ? transferSummary
        : _isVerifying
        ? _preparationSummary
        : null;

    return LayoutBuilder(
      builder: (context, constraints) {
        final minHeight = constraints.hasBoundedHeight
            ? (constraints.maxHeight - 24)
                  .clamp(0.0, constraints.maxHeight)
                  .toDouble()
            : 0.0;
        return SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 280),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _section(
                      key: const ValueKey<String>(
                        'pocket-startup-primary-section',
                      ),
                      progressKey: const ValueKey<String>(
                        'pocket-startup-progress',
                      ),
                      label: primaryLabel,
                      semanticsLabel: primaryIsTransfer
                          ? '资源下载进度'
                          : '正在$primaryLabel',
                      fraction: primaryIsTransfer ? transferFraction : null,
                      semanticsValue: primaryIsTransfer
                          ? transferPercent
                          : null,
                      foreground: foreground,
                      summary: primarySummary,
                      animateDeterminate: true,
                    ),
                    if (_isVerifying && showTransfer) ...[
                      const SizedBox(height: 18),
                      _section(
                        key: const ValueKey<String>(
                          'pocket-startup-processing-section',
                        ),
                        progressKey: const ValueKey<String>(
                          'pocket-startup-processing-progress',
                        ),
                        label: _processingLabel,
                        semanticsLabel: '正在$_processingLabel',
                        fraction: null,
                        foreground: foreground,
                        summary: _preparationSummary,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
