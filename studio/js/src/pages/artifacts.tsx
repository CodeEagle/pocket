import { For, Show, createSignal, onMount } from "solid-js";
import { MobileButton, MobileListTile, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { formatBytes, formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";

const MAX_RAW_LINES = 400;

/**
 * Inspector for the build outputs of the current revision. Text artifacts are shown as the service returns
 * them (scrubbed); binaries (.qjbc, .pak) are metadata only: they embed debug paths the provider cannot scrub.
 */
export function ArtifactsPage(props: { studio: Studio }) {
  const s = props.studio;
  const a = fromStore(s.artifacts.store);
  const project = () => s.projects.current();
  onMount(() => { if (project()) void s.artifacts.refresh(); });
  const copy = (text: string, what: string) => { void s.copy(text, what); };
  const rawLines = () => (a().selected?.text ?? "").split("\n");
  // Which overview section is open (view-only choice; the data itself lives in the artifacts store).
  const [section, setSection] = createSignal<"bytecode" | "manifest" | "pack" | "build">("bytecode");
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-3">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`产物 · ${project() ?? "请选择项目"}`}</Text>
        <MobileButton label="刷新" kind="text" compact disabled={!project()} onPress={() => void s.artifacts.refresh()} />
        <Show when={a().loaded && a().built}>
          <Text class="text-xs" style={{ textColor: a().builtRevision === a().revision ? C.ok : C.warn }}>
            {a().builtRevision === a().revision ? `当前构建 r${a().builtRevision}` : `构建 r${a().builtRevision} · 源码已更改到 r${a().revision}`}
          </Text>
        </Show>
      </View>
      <Show when={a().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取产物…</Text></Show>
      <Show when={a().error}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取失败：${a().error}`}</Text></Show>
      <Show when={project() === undefined}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
      <Show when={a().loaded && !a().built && !a().error}><Text class="text-xs" style={{ textColor: C.muted }}>完成一次成功的构建后，产物会显示在这里。</Text></Show>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col gap-1" style={{ width: 270 }}>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={a().files}>{(f) => (
                <MobileListTile
                  title={f.label}
                  detail={`${f.role}${f.bytes !== undefined ? ` · ${formatBytes(f.bytes)}` : f.lazy ? " · 点击查看" : f.available ? "" : " · 不可用"}`}
                  selected={a().selected?.name === f.name}
                  onPress={() => void s.artifacts.select(f.name)}
                />
              )}</For>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col flex-1">
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Show when={a().selected} fallback={
                <>
                  <Show when={a().built}>
                    <MobileSegmentedControl
                      items={[{ id: "bytecode", label: "字节码" }, { id: "manifest", label: "来宾清单" }, { id: "pack", label: "包内容" }, { id: "build", label: "构建信息" }]}
                      active={section()}
                      onChange={(id) => setSection(id as "bytecode" | "manifest" | "pack" | "build")}
                    />
                  </Show>
                  <Show when={section() === "bytecode" && a().bytecode}>{(b) => (
                    <Panel title="字节码" note="来自 app.bytecode.json">
                      <Field label="运行时 ABI" value={b().runtimeAbi} shown={b().runtimeAbi ? shortHash(b().runtimeAbi!, 26, 8) : undefined} onCopy={copy} />
                      <Line label="绑定代数" value={b().bindingGeneration} />
                      <Line label="入口格式" value={b().entryFormat} />
                      <Line label="帧率 (tickHz)" value={b().tickHz} />
                      <Line label="字节码大小" value={b().bytecodeBytes !== undefined ? formatBytes(b().bytecodeBytes!) : undefined} />
                      <Field label="payload SHA-256" value={b().payloadSha256} shown={b().payloadSha256 ? shortHash(b().payloadSha256!, 20, 8) : undefined} onCopy={copy} />
                      <Field label="源码 SHA-256" value={b().sourceSha256} shown={b().sourceSha256 ? shortHash(b().sourceSha256!, 20, 8) : undefined} onCopy={copy} />
                      <Field label="引擎 ABI" value={b().engineAbi} shown={b().engineAbi ? shortHash(b().engineAbi!, 20, 8) : undefined} onCopy={copy} />
                      <Line label="版本" value={b().version !== undefined ? `v${b().version}${b().build !== undefined ? ` · 构建 ${b().build}` : ""}` : undefined} />
                    </Panel>
                  )}</Show>
                  <Show when={section() === "manifest" && a().manifest}>{(m) => (
                    <Panel title="来宾清单" note="来自 guest-manifest.json">
                      <Line label="协议版本" value={m().protocolVersion} />
                      <Line label="必需能力" value={m().requires.length ? m().requires.join("、") : "无"} />
                      <Line label="可选能力" value={`${m().optional.length} 项`} />
                      <Line label="必需权限" value={m().permissionsRequired.length ? m().permissionsRequired.join("、") : "无"} />
                      <Line label="可选权限" value={m().permissionsOptional.length ? m().permissionsOptional.join("、") : "无"} />
                      <Line label="内存" value={m().memory ? [m().memory!.heapLimitBytes !== undefined ? `堆上限 ${formatBytes(m().memory!.heapLimitBytes!)}` : "", m().memory!.maxPakBytes !== undefined ? `资源包上限 ${formatBytes(m().memory!.maxPakBytes!)}` : ""].filter(Boolean).join(" · ") : m().memoryPolicy ? `策略 ${m().memoryPolicy}` : "默认"} />
                    </Panel>
                  )}</Show>
                  <Show when={section() === "pack" && a().built}>
                    <Panel title="包内容" note="按资源快照 (resources.json) 汇总；.pak 本身只提供大小，不在 Studio 内展开。">
                      <Show when={a().packNote}><Text class="text-xs" style={{ textColor: C.warn }}>{a().packNote}</Text></Show>
                      <For each={a().packages}>{(p) => (
                        <View class="flex-col w-full">
                          <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`${p.title ?? p.id} · ${p.id}${p.version ? ` · v${p.version}` : ""}`}</Text>
                          <Text class="text-xs" style={{ textColor: C.muted }}>{`共 ${p.total} 项 · ${formatBytes(p.totalBytes)}（其中图片/资产 ${p.assets} 项）`}</Text>
                          <Text class="text-xs" style={{ textColor: C.muted }}>{`随包 ${p.inPak} 项 · ${formatBytes(p.inPakBytes)} ｜ 网络下载 ${p.network} 项 · ${formatBytes(p.networkBytes)}`}</Text>
                        </View>
                      )}</For>
                    </Panel>
                  </Show>
                  <Show when={section() === "build" && a().buildInfo}>{(b) => (
                    <Panel title="构建信息" note="来自 build.json">
                      <Line label="应用" value={b().appId} />
                      <Line label="版本" value={b().version !== undefined ? `v${b().version}${b().build !== undefined ? ` · 构建 ${b().build}` : ""}` : undefined} />
                      <Line label="修订" value={b().revision !== undefined ? `r${b().revision}` : undefined} />
                      <Line label="生成时间" value={formatTime(b().generatedAt)} />
                      <Field label="构建代 (generation)" value={b().generation} onCopy={copy} />
                      <Line label="包" value={b().packages.length ? b().packages.map((p) => `${p.id}${p.version ? ` v${p.version}` : ""}`).join("、") : undefined} />
                    </Panel>
                  )}</Show>
                </>
              }>
                {(sel) => (
                  <Panel title={sel().name}>
                    <MobileButton label="返回概览" kind="tonal" compact onPress={() => s.artifacts.closeSelected()} />
                    <Show when={sel().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取…</Text></Show>
                    <Show when={sel().error}><Text class="text-xs" style={{ textColor: C.danger }}>{sel().error}</Text></Show>
                    <Show when={sel().bytes !== undefined}><Text class="text-xs" style={{ textColor: C.muted }}>{`大小 ${formatBytes(sel().bytes!)}`}</Text></Show>
                    <Show when={!sel().loading && !sel().error && sel().text === undefined}>
                      <Text class="text-xs" style={{ textColor: C.warn }}>二进制产物只显示元数据：其中嵌有调试路径，Studio 不展示内容。</Text>
                    </Show>
                    <Show when={sel().truncated}><Text class="text-xs" style={{ textColor: C.warn }}>内容已截断（只显示前 128 KiB）。</Text></Show>
                    <Show when={sel().text !== undefined}>
                      <For each={rawLines().slice(0, MAX_RAW_LINES)}>{(line) => <Text class="text-xs" style={{ textColor: C.body }}>{line.length ? line : " "}</Text>}</For>
                      <Show when={rawLines().length > MAX_RAW_LINES}><Text class="text-xs" style={{ textColor: C.warn }}>{`… 还有 ${rawLines().length - MAX_RAW_LINES} 行未显示`}</Text></Show>
                    </Show>
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
