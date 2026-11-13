import { For, Show } from "solid-js";
import { MobileButton, MobileListTile, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { PreviewSurface, PREVIEW_PHASE_LABEL } from "../components/preview-surface.tsx";
import { ACTIVE_JOB, JOB_LABELS } from "../state/deploy.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";

/** Live preview (signed child) plus deploy to a simulator or device. */
export function PreviewPage(props: { studio: Studio }) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const deploy = fromStore(s.deploy.store);
  const project = () => s.projects.current();
  const job = () => deploy().job;
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">预览</Text>
        <Text class="text-xs" style={{ textColor: preview().phase === "error" ? C.danger : preview().phase === "running" ? C.ok : C.warn }}>{PREVIEW_PHASE_LABEL[preview().phase]}</Text>
        <Show when={preview().version}><Text class="text-xs" style={{ textColor: C.faint }}>{`${preview().version}`}</Text></Show>
        <Show when={preview().lastLatencyMs !== undefined}><Text class="text-xs" style={{ textColor: C.faint }}>{`上次耗时 ${preview().lastLatencyMs} ms`}</Text></Show>
      </View>
      <View class="flex-row items-center gap-2">
        <MobileButton label="构建并刷新预览" compact disabled={!project()} onPress={() => void s.preview.run({ build: true })} />
        <MobileButton label="重新加载" compact kind="tonal" disabled={!project()} onPress={() => void s.preview.run({ build: false })} />
        <MobileButton label="关闭预览" compact kind="text" disabled={preview().instanceId === undefined} onPress={() => void s.preview.reset()} />
      </View>
      <Show when={preview().message}><Text class="text-xs" style={{ textColor: preview().phase === "error" ? C.danger : C.muted }}>{preview().message}</Text></Show>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col gap-1 flex-1">
          {/* Pages are exclusive, so this is the only mounted surface while the Preview page is open. */}
          <PreviewSurface studio={s} />
        </View>
        <View class="flex-col gap-2" style={{ width: 300 }}>
          <Text class="text-sm font-bold" style={{ textColor: C.body }}>部署到模拟器 / 设备</Text>
          <View class="flex-row gap-2">
            <MobileButton label="刷新设备" compact kind="text" onPress={() => void s.deploy.loadDevices()} />
            <MobileButton label={job() && ACTIVE_JOB.includes(job()!.status) ? (job()!.status === "running" ? "已运行" : "部署中…") : "部署"} compact disabled={!project() || !deploy().selected || deploy().starting || (job() !== undefined && ACTIVE_JOB.includes(job()!.status))} onPress={() => void s.deploy.start()} />
            <Show when={job() && ACTIVE_JOB.includes(job()!.status)}><MobileButton label="停止" compact kind="outlined" onPress={() => void s.deploy.cancel()} /></Show>
          </View>
          <Show when={deploy().devicesError}><Text class="text-xs" style={{ textColor: C.danger }}>{`设备发现不可用：${deploy().devicesError}`}</Text></Show>
          <Show when={deploy().devicesLoaded && !deploy().devicesError && deploy().devices.length === 0}><Text class="text-xs" style={{ textColor: C.muted }}>没有可用的模拟器或已连接设备。</Text></Show>
          <Show when={!deploy().devicesLoaded}><Text class="text-xs" style={{ textColor: C.muted }}>点击“刷新设备”以发现目标。</Text></Show>
          <For each={deploy().devices}>{(device) => (
            <MobileListTile
              title={device.name}
              detail={`${device.platform} · ${device.emulator ? "模拟器" : "已连接设备"}${device.supported ? "" : " · 不支持"}`}
              selected={deploy().selected === device.id}
              onPress={() => device.supported && s.deploy.select(device.id)}
            />
          )}</For>
          <Show when={job()}>
            {(j) => (
              <View class="flex-col gap-1 flex-1">
                <Text class="text-xs font-bold" style={{ textColor: ["failed", "error"].includes(j().status) ? C.danger : C.ok }}>{`部署：${JOB_LABELS[j().status] ?? j().status}`}</Text>
                <ScrollablePage>
                  <View class="flex-col w-full">
                    <For each={j().logs.slice(-60)}>{(line) => <Text class="text-xs" style={{ textColor: C.body }}>{line.length ? line : " "}</Text>}</For>
                    <Show when={j().error}><Text class="text-xs" style={{ textColor: C.danger }}>{j().error}</Text></Show>
                  </View>
                </ScrollablePage>
              </View>
            )}
          </Show>
        </View>
      </View>
    </View>
  );
}
