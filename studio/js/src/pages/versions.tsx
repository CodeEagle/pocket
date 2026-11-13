import { For, Show, onMount } from "solid-js";
import { MobileButton, MobileListTile, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";

/**
 * Version history and slots from the service's journal. The service records what was PUBLISHED; whether a device
 * is on trial, promoted or rolled back is decided by each device's update coordinator and is not visible here.
 */
export function VersionsPage(props: { studio: Studio }) {
  const s = props.studio;
  const v = fromStore(s.versions.store);
  const project = () => s.projects.current();
  onMount(() => { if (project()) void s.versions.refresh(); });
  const copy = (text: string, what: string) => { void s.copy(text, what); };
  const selected = () => v().history.find((e) => e.id === v().selected);
  const isCurrent = (id: string, slot: string) => v().slots.some((x) => x.name === slot && x.releaseId === id);
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-3">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`版本 · ${project() ?? "请选择项目"}`}</Text>
        <MobileButton label="刷新" kind="text" compact disabled={!project()} onPress={() => void s.versions.refresh()} />
        <Show when={v().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取…</Text></Show>
      </View>
      <Show when={v().error}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取版本记录失败：${v().error}`}</Text></Show>
      <Show when={project() === undefined}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col flex-1">
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Panel title="本地版本后端" note="只读：提供已签名的测试 / 稳定版本给模拟器和局域网设备。">
                <Line label="服务地址" value={v().origin} />
                <Line label="宿主版本" value={v().hostVersion} />
                <Line label="兼容分支" value={v().packageVersion} />
                <Line label="网络" value={v().loaded ? (v().lan ? "局域网可访问" : "仅本机（127.0.0.1）") : undefined} />
                <Show when={v().backendError}><Text class="text-xs" style={{ textColor: C.warn }}>{v().backendError}</Text></Show>
                <Field label="App 接入地址（固定频道 latest.json）" value={v().appConfigUrl} copyLabel="App 接入地址" onCopy={copy} />
              </Panel>
              <For each={v().slots}>{(slot) => (
                <Panel title={slot.label}>
                  <Show when={slot.version} fallback={<Text class="text-xs" style={{ textColor: C.muted }}>此槽位还没有发布。</Text>}>
                    <Line label="当前版本" value={`v${slot.version}${slot.build !== undefined ? ` · 构建 ${slot.build}` : ""}`} tone="ok" />
                    <Show when={slot.archiveUrl}><Field label="归档下载" value={slot.archiveUrl} copyLabel="归档地址" onCopy={copy} /></Show>
                    <For each={slot.packages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>}</For>
                    <For each={slot.reusedPackages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build} · 复用${p.ownerProjectId ? `（所有者 ${p.ownerProjectId}）` : ""}`}</Text>}</For>
                  </Show>
                </Panel>
              )}</For>
              <Panel title={`已发布版本（${v().history.length}）`}>
                <Show when={v().loaded && v().history.length === 0}><Text class="text-xs" style={{ textColor: C.muted }}>还没有发布记录。在“发布”页发布一个测试包。</Text></Show>
                <For each={v().history}>{(e) => (
                  <MobileListTile
                    title={`v${e.version} · 构建 ${e.build}${isCurrent(e.releaseId, e.slot) ? " · 当前" : ""}`}
                    detail={`${e.slot === "test" ? "测试" : "稳定版"} · ${formatTime(e.publishedAt) ?? "时间未知"}`}
                    selected={v().selected === e.id}
                    onPress={() => s.versions.select(e.id)}
                  />
                )}</For>
              </Panel>
              <Text class="text-xs" style={{ textColor: C.faint }}>
                试用 / 已提升 / 已回滚：这些状态由各设备上的更新协调器按签名、ABI 和健康检查决定，本地服务不记录，所以这里不显示。此处只列出已发布的版本。
              </Text>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-2" style={{ width: 340 }}>
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Show when={selected()} fallback={<Text class="text-xs" style={{ textColor: C.muted }}>选择一个已发布版本查看详情。</Text>}>
                {(e) => (
                  <Panel title={`v${e().version} · 构建 ${e().build}`}>
                    <Line label="频道" value={e().slot === "test" ? "测试" : "稳定版"} />
                    <Line label="源码修订" value={e().revision !== undefined ? `r${e().revision}` : undefined} />
                    <Line label="发布时间" value={formatTime(e().publishedAt)} />
                    <Line label="宿主版本" value={e().hostVersion} />
                    <Field label="发布 ID" value={e().releaseId} onCopy={copy} />
                    <Field label="payload SHA-256" value={e().payloadSha256} shown={e().payloadSha256 ? shortHash(e().payloadSha256!, 20, 8) : undefined} onCopy={copy} />
                    <Field label="归档下载（.tar.gz）" value={e().archiveUrl} copyLabel="归档地址" onCopy={copy} />
                    <Field label="host.json 地址" value={e().appConfigUrl} copyLabel="host.json 地址" onCopy={copy} />
                    <For each={e().packages}>{(p) => (
                      <View class="flex-col w-full">
                        <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>
                        <Show when={p.manifestUrl}><Field label="清单" value={p.manifestUrl} copyLabel="清单地址" onCopy={copy} /></Show>
                      </View>
                    )}</For>
                  </Panel>
                )}
              </Show>
            </View>
          </ScrollablePage>
        </View>
      </View>
    </View>
  );
}
