import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchIosMinimum } from "../../pocket.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-ios-archive-output-test-"));
try {
  const ios = join(root, "ios");
  const pocketSupport = join(ios, "Pods/Target Support Files/pocket_flutter");
  const otherSupport = join(ios, "Pods/Target Support Files/other_pod");
  const podfile = join(ios, "Podfile");
  const pocketOutputs = join(pocketSupport, "pocket_flutter-xcframeworks-output-files.xcfilelist");
  const otherOutputs = join(otherSupport, "other_pod-xcframeworks-output-files.xcfilelist");
  const oldOutput = "${PODS_XCFRAMEWORKS_BUILD_DIR}/pocket_flutter/PocketFlutter.framework";
  const newOutput = "${PODS_XCFRAMEWORKS_BUILD_DIR}/pocket_flutter/libpocket_flutter.a";
  const unrelatedPocketOutput = "${PODS_XCFRAMEWORKS_BUILD_DIR}/other_pod/Other.framework";
  const originalPocketOutputs = `${oldOutput}\n${oldOutput}-must-stay\n${unrelatedPocketOutput}\n`;
  const originalOtherOutputs = `${oldOutput}\n`;

  mkdirSync(pocketSupport, { recursive: true });
  mkdirSync(otherSupport, { recursive: true });
  writeFileSync(podfile, `platform :ios, '15.0'

post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings["KEEP_CONSUMER_SETTING"] = "yes"
      if config.build_settings["KEEP_CONSUMER_SETTING"] == "yes"
        $consumer_logic_ran = true
        ignored = "# do end"
      end
    end
  end
end
`);
  writeFileSync(pocketOutputs, originalPocketOutputs);
  writeFileSync(otherOutputs, originalOtherOutputs);

  patchIosMinimum(ios);
  const once = readFileSync(podfile, "utf8");
  assert.equal((once.match(/POCKET_STATIC_XCFRAMEWORK_OUTPUTS_BEGIN/g) ?? []).length, 1);
  assert.equal((once.match(/POCKET_STATIC_XCFRAMEWORK_OUTPUTS_END/g) ?? []).length, 1);
  assert.match(once, /File\.join\(__dir__, "Pods", "Target Support Files", "pocket_flutter"/);

  patchIosMinimum(ios);
  assert.equal(readFileSync(podfile, "utf8"), once, "Podfile patch must be byte-for-byte idempotent");

  const rubyRunner = join(root, "run_post_install.rb");
  writeFileSync(rubyRunner, `class PocketConfig
  attr_reader :build_settings

  def initialize
    @build_settings = {}
  end
end

class PocketTarget
  def build_configurations
    [PocketConfig.new]
  end
end

class PocketPodsProject
  def targets
    [PocketTarget.new]
  end
end

class PocketInstaller
  attr_reader :pods_project

  def initialize
    @pods_project = PocketPodsProject.new
  end
end

def platform(*)
end

def post_install(&block)
  $pocket_post_install = block
end

$consumer_logic_ran = false
load ARGV.fetch(0)
raise "post_install hook was not registered" unless $pocket_post_install
$pocket_post_install.call(PocketInstaller.new)
if ARGV[1] == "check-consumer" && !$consumer_logic_ran
  raise "consumer post_install logic did not run"
end
`);

  const runPostInstall = (targetPodfile: string, checkConsumerLogic = false): void => {
    const args = [rubyRunner, targetPodfile];
    if (checkConsumerLogic) args.push("check-consumer");
    const result = spawnSync("ruby", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };

  runPostInstall(podfile, true);
  assert.equal(
    readFileSync(pocketOutputs, "utf8"),
    `${newOutput}\n${oldOutput}-must-stay\n${unrelatedPocketOutput}\n`,
    "only the exact stale pocket_flutter output line may change",
  );
  assert.equal(readFileSync(otherOutputs, "utf8"), originalOtherOutputs, "other pods must remain untouched");

  const alreadyCorrect = readFileSync(pocketOutputs, "utf8");
  runPostInstall(podfile, true);
  assert.equal(readFileSync(pocketOutputs, "utf8"), alreadyCorrect, "correct output list must remain unchanged");

  const noHookRoot = mkdtempSync(join(tmpdir(), "pocket-ios-archive-no-hook-test-"));
  try {
    const noHookIos = join(noHookRoot, "ios");
    const noHookSupport = join(noHookIos, "Pods/Target Support Files/pocket_flutter");
    const noHookPodfile = join(noHookIos, "Podfile");
    const noHookOutputs = join(noHookSupport, "pocket_flutter-xcframeworks-output-files.xcfilelist");
    mkdirSync(noHookSupport, { recursive: true });
    writeFileSync(noHookPodfile, "platform :ios, '15.0'\n");
    writeFileSync(noHookOutputs, `${oldOutput}\n`);
    patchIosMinimum(noHookIos);
    const noHookText = readFileSync(noHookPodfile, "utf8");
    assert.equal((noHookText.match(/post_install do \|installer\|/g) ?? []).length, 1);
    assert.equal((noHookText.match(/POCKET_STATIC_XCFRAMEWORK_OUTPUTS_BEGIN/g) ?? []).length, 1);
    runPostInstall(noHookPodfile);
    assert.equal(readFileSync(noHookOutputs, "utf8"), `${newOutput}\n`);
  } finally {
    rmSync(noHookRoot, { recursive: true, force: true });
  }

  const unsupportedRoot = mkdtempSync(join(tmpdir(), "pocket-ios-archive-unsupported-test-"));
  try {
    const unsupportedIos = join(unsupportedRoot, "ios");
    const unsupportedSupport = join(unsupportedIos, "Pods/Target Support Files/pocket_flutter");
    const unsupportedPodfile = join(unsupportedIos, "Podfile");
    const unsupportedOutputs = join(unsupportedSupport, "pocket_flutter-xcframeworks-output-files.xcfilelist");
    const unsupportedProject = join(unsupportedIos, "Runner.xcodeproj/project.pbxproj");
    mkdirSync(unsupportedSupport, { recursive: true });
    mkdirSync(join(unsupportedIos, "Runner.xcodeproj"), { recursive: true });
    writeFileSync(unsupportedPodfile, `platform :ios, '13.0'

post_install { |installer|
  installer.pods_project.targets.each { |target| }
}
`);
    writeFileSync(unsupportedOutputs, `${oldOutput}\n`);
    writeFileSync(unsupportedProject, "IPHONEOS_DEPLOYMENT_TARGET = 13.0;\n");
    const beforePodfile = readFileSync(unsupportedPodfile, "utf8");
    const beforeOutputs = readFileSync(unsupportedOutputs, "utf8");
    const beforeProject = readFileSync(unsupportedProject, "utf8");
    assert.throws(() => patchIosMinimum(unsupportedIos), /manual integration required/);
    assert.equal(readFileSync(unsupportedPodfile, "utf8"), beforePodfile);
    assert.equal(readFileSync(unsupportedOutputs, "utf8"), beforeOutputs);
    assert.equal(readFileSync(unsupportedProject, "utf8"), beforeProject);
  } finally {
    rmSync(unsupportedRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("ios_archive_outputs.test: CocoaPods static XCFramework output correction and idempotence passed");
