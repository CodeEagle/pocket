#!/usr/bin/env python3
"""Finite, explicit on-device captures. Never changes refresh/power settings.

Raw system traces are evidence; Flutter callbacks alone are not an energy meter.
"""
import argparse
import datetime as dt
import json
import pathlib
import re
import subprocess
import tempfile


def run(args, timeout=30, check=True):
    value = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and value.returncode:
        raise RuntimeError(f"{args[0]} failed ({value.returncode}): {value.stderr[-3000:] or value.stdout[-3000:]}")
    return value.stdout


def android_facts(serial):
    command = ["adb", "-s", serial, "shell"]
    display = run(command + ["dumpsys", "display"])
    selected = [line.strip() for line in display.splitlines() if any(key in line for key in (
        "mSupportedModesByDisplay", "mDefaultModeByDisplay", "mDisplayState=", "mIsDisplayActive=",
        "mActiveSfDisplayMode", "mActiveModeId", "mDefaultRefreshRate:", "mLowPowerModeEnabled:",
        "0 -> [{id=", "mDisplayInfo=", "mThermalStatus"))]
    rates = [float(x) for x in re.findall(r"\bfps=([\d.]+)", display)]
    battery = run(command + ["dumpsys", "battery"])
    return {"platform": "android", "model": run(command + ["getprop", "ro.product.model"]).strip(),
            "sdk": run(command + ["getprop", "ro.build.version.sdk"]).strip(),
            "maxSupportedRefreshHz": max(rates, default=None),
            "displayFacts": selected,
            "batteryFacts": [line.strip() for line in battery.splitlines() if re.match(
                r"\s*(AC powered|USB powered|Wireless powered|status|level|temperature):", line)]}


def inventory():
    with tempfile.TemporaryDirectory(prefix="pocket-devices-") as directory:
        path = pathlib.Path(directory) / "devices.json"
        run(["xcrun", "devicectl", "list", "devices", "--json-output", str(path)])
        ios = json.loads(path.read_text()).get("result", {}).get("devices", [])
        # Keep hardware/availability facts, omit unrelated capability inventory.
        apple = [{"name": d.get("deviceProperties", {}).get("name"),
                  "identifier": d.get("identifier"),
                  "model": d.get("hardwareProperties", {}).get("marketingName"),
                  "os": d.get("deviceProperties", {}).get("osVersionNumber"),
                  "connection": d.get("connectionProperties", {}).get("tunnelState")} for d in ios]
    serials = [line.split()[0] for line in run(["adb", "devices"]).splitlines()[1:]
               if len(line.split()) > 1 and line.split()[1] == "device"]
    return {"ios": apple, "android": [android_facts(s) for s in serials]}


def capture(options):
    out = pathlib.Path(options.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    facts = {"utc": dt.datetime.now(dt.timezone.utc).isoformat(), "scene": options.scene,
             "seconds": options.seconds, "mode": options.mode, "platform": options.platform,
             "app": options.app, "recording": options.recording, "worker": options.worker,
             "note": "No refresh/battery/brightness/thermal settings changed. Capture overhead is present; compare equal scenes/windows."}
    (out / "conditions.json").write_text(json.dumps(facts, ensure_ascii=False, indent=2))
    if options.platform == "ios":
        args = ["xcrun", "xctrace", "record", "--device", options.device,
                "--template", options.template, "--time-limit", f"{options.seconds}s",
                "--output", str(out / "system.trace"), "--attach", options.app, "--no-prompt"]
        log = run(args, timeout=options.seconds + 60)
        (out / "capture.log").write_text(log)
        toc = run(["xcrun", "xctrace", "export", "--input", str(out / "system.trace"), "--toc"], timeout=45)
        (out / "trace-toc.xml").write_text(toc)
    else:
        facts["deviceFacts"] = android_facts(options.device)
        (out / "conditions.json").write_text(json.dumps(facts, ensure_ascii=False, indent=2))
        app = options.app
        if not re.fullmatch(r"[A-Za-z0-9_.]+", app):
            raise ValueError("Android app must be a package ID")
        config = f'''buffers {{ size_kb: 16384 fill_policy: RING_BUFFER }}
duration_ms: {options.seconds * 1000}
data_sources {{ config {{ name: "linux.ftrace" ftrace_config {{
 ftrace_events: "sched/sched_switch" ftrace_events: "sched/sched_wakeup"
 ftrace_events: "power/cpu_frequency" ftrace_events: "power/cpu_idle"
 atrace_categories: "gfx" atrace_categories: "view" atrace_categories: "input"
 atrace_apps: "{app}"
}} }} }}
data_sources {{ config {{ name: "android.surfaceflinger.frametimeline" }} }}
data_sources {{ config {{ name: "android.power" android_power_config {{
 battery_poll_ms: 1000 collect_power_rails: true
}} }} }}
'''
        local = out / "perfetto.pbtxt"
        local.write_text(config)
        token = out.name + "-" + str(int(dt.datetime.now().timestamp()))
        token = re.sub(r"[^A-Za-z0-9_-]", "_", token)
        remote = f"/data/local/tmp/pocket-{token}.pbtxt"
        trace = f"/data/misc/perfetto-traces/pocket-{token}.trace"
        adb = ["adb", "-s", options.device]
        try:
            run(adb + ["push", str(local), remote])
            log = run(adb + ["shell", "perfetto", "--txt", "-c", remote, "-o", trace], timeout=options.seconds + 30)
            (out / "capture.log").write_text(log)
            run(adb + ["pull", trace, str(out / "system.perfetto-trace")])
        finally:
            run(adb + ["shell", "rm", "-f", remote, trace], check=False)
    return {"capture": str(out), "energyClaim": "none; inspect actual available system counters/rails"}


def extract_metrics(path):
    content = pathlib.Path(path).read_text()
    samples = []
    for match in re.finditer(r"POCKET_PERF\s+", content):
        try:
            value, _ = json.JSONDecoder().raw_decode(content[match.end():])
            samples.extend(value if isinstance(value, list) else [value])
        except json.JSONDecodeError:
            continue
    if not samples:
        raise ValueError(f"No POCKET_PERF metrics in {path}")
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inventory")
    trace = commands.add_parser("capture")
    trace.add_argument("--platform", choices=["ios", "android"], required=True)
    trace.add_argument("--device", required=True)
    trace.add_argument("--app", required=True, help="iOS process name/PID; Android package ID")
    trace.add_argument("--output", required=True, help="New output directory")
    trace.add_argument("--scene", required=True)
    trace.add_argument("--seconds", type=int, choices=range(1, 61), default=20)
    trace.add_argument("--mode", choices=["profile", "release"], required=True)
    trace.add_argument("--template", default="Power Profiler")
    trace.add_argument("--recording", choices=["on", "off"], default="off")
    trace.add_argument("--worker", choices=["on", "off"], default="off")
    compare = commands.add_parser("compare")
    compare.add_argument("baseline")
    compare.add_argument("variant")
    options = parser.parse_args()
    if options.command == "inventory":
        value = inventory()
    elif options.command == "capture":
        value = capture(options)
    else:
        baseline = {s["scene"]: s for s in extract_metrics(options.baseline)}
        variant = {s["scene"]: s for s in extract_metrics(options.variant)}
        value = {"scenes": [{"scene": name, "baseline": before, "variant": variant[name],
                  "delta": {key: variant[name][key] - before[key] for key in
                            ("nativeFrameCalls", "buildMsP95", "rasterMsP95", "observedHz")
                            if isinstance(before.get(key), (int, float)) and isinstance(variant[name].get(key), (int, float))}}
                  for name, before in baseline.items() if name in variant],
                 "energyClaim": "none; FPS/callback counts are not power measurements"}
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
