import 'dart:convert';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'frame_timing_collector.dart';

double _durationMs(Duration duration) => duration.inMicroseconds / 1000.0;

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final sorted = List<double>.of(values)..sort();
  return sorted[((sorted.length - 1) * fraction).round()];
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('pure Flutter keyboard control baseline', (tester) async {
    final timingCollector = FrameTimingCollector();
    final results = <Map<String, dynamic>>[];
    try {
      await tester.pumpWidget(const _FlutterKeyboardControlApp());
      await tester.pump();

      Future<void> measure(String scene, {required bool open}) async {
        await timingCollector.flushBeforeWindow();
        final startedWallTimeUs = DateTime.now().toUtc().microsecondsSinceEpoch;
        final stopwatch = Stopwatch()..start();
        await tester.tap(find.byKey(_FlutterKeyboardControlApp.toggleKey));
        await Future<void>.delayed(const Duration(milliseconds: 1400));
        stopwatch.stop();
        final endedWallTimeUs = DateTime.now().toUtc().microsecondsSinceEpoch;
        await timingCollector.waitForDelayedBatch();
        final frameTimings = timingCollector.timingsInBuildWindow(
          startWallTimeUs: startedWallTimeUs,
          endWallTimeUs: endedWallTimeUs,
        );
        expect(
          frameTimings,
          isNotEmpty,
          reason: '$scene must produce at least one sane source frame timing',
        );

        final build = frameTimings
            .map((timing) => _durationMs(timing.buildDuration))
            .toList(growable: false);
        final raster = frameTimings
            .map((timing) => _durationMs(timing.rasterDuration))
            .toList(growable: false);
        final refreshHz = tester.view.display.refreshRate;
        final frameBudgetMs = refreshHz > 0 ? 1000 / refreshHz : null;
        final inset = tester.view.viewInsets.bottom;
        if (open) {
          expect(
            inset,
            greaterThan(0),
            reason: '$scene must open the real system keyboard',
          );
          expect(
            find.byType(EditableText),
            findsOneWidget,
            reason: '$scene must mount the Flutter editor',
          );
        } else {
          expect(
            inset,
            lessThanOrEqualTo(0),
            reason: '$scene must close the real system keyboard',
          );
          expect(
            find.byType(EditableText),
            findsNothing,
            reason: '$scene must unmount the Flutter editor',
          );
        }
        results.add(<String, dynamic>{
          'scene': scene,
          'frameCount': frameTimings.length,
          'refreshHz': refreshHz > 0 ? refreshHz : null,
          'frameBudgetMs': frameBudgetMs,
          'buildMaxMs': build.isEmpty ? 0 : build.reduce(_max),
          'buildP95Ms': _percentile(build, .95),
          'rasterMaxMs': raster.isEmpty ? 0 : raster.reduce(_max),
          'rasterP95Ms': _percentile(raster, .95),
          'phaseOverBudget': frameBudgetMs == null
              ? null
              : frameTimings
                    .where(
                      (timing) =>
                          _durationMs(timing.buildDuration) > frameBudgetMs ||
                          _durationMs(timing.rasterDuration) > frameBudgetMs,
                    )
                    .length,
          'timingWindow': 'buildStartWallTimeProjectedFromRasterFinish',
          'timingWindowStartWallUs': startedWallTimeUs,
          'timingWindowEndWallUs': endedWallTimeUs,
          'rawWallSanity': frameTimings.every(
            FrameTimingCollector.hasSaneRawWallClock,
          ),
          'frameTimings': [
            for (final timing in frameTimings)
              {
                'frameNumber': timing.frameNumber,
                'vsyncUs': timing.timestampInMicroseconds(
                  FramePhase.vsyncStart,
                ),
                'buildStartUs': timing.timestampInMicroseconds(
                  FramePhase.buildStart,
                ),
                'buildUs': timing.buildDuration.inMicroseconds,
                'rasterUs': timing.rasterDuration.inMicroseconds,
                'rasterFinishUs': timing.timestampInMicroseconds(
                  FramePhase.rasterFinish,
                ),
                'rasterFinishWallUs': timing.timestampInMicroseconds(
                  FramePhase.rasterFinishWallTime,
                ),
                'buildStartWallUs':
                    FrameTimingCollector.projectedBuildStartWallTimeUs(timing),
              },
          ],
          'imeInsetBottom': inset,
          'wallClockMs': stopwatch.elapsedMicroseconds / 1000.0,
        });
      }

      await measure('keyboard_first_open', open: true);
      await measure('keyboard_first_close', open: false);
      await measure('keyboard_warm_open', open: true);
      await measure('keyboard_warm_close', open: false);

      // ignore: avoid_print
      print('FLUTTER_KEYBOARD_CONTROL ${jsonEncode(results)}');
      binding.reportData = <String, dynamic>{
        ...?binding.reportData,
        'flutterKeyboardControl': results,
      };
    } finally {
      timingCollector.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}

double _max(double first, double second) => first > second ? first : second;

final class _FlutterKeyboardControlApp extends StatelessWidget {
  const _FlutterKeyboardControlApp();

  static const toggleKey = ValueKey<String>('flutter-keyboard-control-toggle');

  @override
  Widget build(BuildContext context) => const MaterialApp(
    debugShowCheckedModeBanner: false,
    home: _FlutterKeyboardControlPage(),
  );
}

final class _FlutterKeyboardControlPage extends StatefulWidget {
  const _FlutterKeyboardControlPage();

  @override
  State<_FlutterKeyboardControlPage> createState() =>
      _FlutterKeyboardControlPageState();
}

final class _FlutterKeyboardControlPageState
    extends State<_FlutterKeyboardControlPage> {
  TextEditingController? _controller;
  FocusNode? _focusNode;
  bool _editorVisible = false;

  void _openEditor() {
    final controller = TextEditingController();
    final focusNode = FocusNode(debugLabel: 'Flutter keyboard control');
    setState(() {
      _controller = controller;
      _focusNode = focusNode;
      _editorVisible = true;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !identical(_focusNode, focusNode)) return;
      focusNode.requestFocus();
    });
  }

  void _closeEditor() {
    final controller = _controller;
    final focusNode = _focusNode;
    focusNode?.unfocus();
    setState(() {
      _controller = null;
      _focusNode = null;
      _editorVisible = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      controller?.dispose();
      focusNode?.dispose();
    });
  }

  @override
  void dispose() {
    _controller?.dispose();
    _focusNode?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    final focusNode = _focusNode;
    return Scaffold(
      resizeToAvoidBottomInset: true,
      appBar: AppBar(title: const Text('Flutter keyboard control')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              ElevatedButton(
                key: _FlutterKeyboardControlApp.toggleKey,
                onPressed: _editorVisible ? _closeEditor : _openEditor,
                child: Text(
                  _editorVisible ? 'Close keyboard' : 'Open keyboard',
                ),
              ),
              if (_editorVisible && controller != null && focusNode != null)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Material(
                    type: MaterialType.transparency,
                    child: TextField(
                      key: const ValueKey<String>(
                        'flutter-keyboard-control-input',
                      ),
                      controller: controller,
                      focusNode: focusNode,
                      keyboardType: TextInputType.text,
                      textInputAction: TextInputAction.done,
                      obscureText: false,
                      autocorrect: true,
                      enableSuggestions: true,
                      maxLines: 1,
                      minLines: 1,
                      scrollPadding: EdgeInsets.zero,
                      onEditingComplete: () {},
                      onSubmitted: (_) {},
                      style: const TextStyle(
                        color: Color(0xff283444),
                        fontSize: 14,
                        fontWeight: FontWeight.normal,
                        height: 1.2,
                      ),
                      cursorColor: const Color(0xff2676cb),
                      decoration: InputDecoration(
                        isDense: true,
                        filled: true,
                        fillColor: Colors.white,
                        hintText: 'Tap to type',
                        hintStyle: const TextStyle(
                          color: Color(0xff667485),
                          fontSize: 14,
                          fontWeight: FontWeight.normal,
                          height: 1.2,
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                        border: const OutlineInputBorder(
                          gapPadding: 0,
                          borderRadius: BorderRadius.all(Radius.circular(8)),
                          borderSide: BorderSide(color: Color(0xff9aa5b2)),
                        ),
                        enabledBorder: const OutlineInputBorder(
                          gapPadding: 0,
                          borderRadius: BorderRadius.all(Radius.circular(8)),
                          borderSide: BorderSide(color: Color(0xff9aa5b2)),
                        ),
                        focusedBorder: const OutlineInputBorder(
                          gapPadding: 0,
                          borderRadius: BorderRadius.all(Radius.circular(8)),
                          borderSide: BorderSide(
                            color: Color(0xff2676cb),
                            width: 1,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
