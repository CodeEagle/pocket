import { For, Show, onMount } from "solid-js";
import { MobileButton, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";

/**
 * Signed publish. The signing key never reaches the guest: the service signs, and this page only shows the
 * public facts it returns (key id, runtime ABI, payload digest, URLs). A stable (release) publish asks first.
 */
export function PublishPage(props: { studio: Studio }) {
  const s = props.studio;
  const pub = fromStore(s.publish.store);
  const build = fromStore(s.build.store);
  const project = () => s.projects.current();
  const busy = () => pub().phase === "publishing";
  const label = () => (pub().channel === "test" ? "测试" : "稳定版");
  const root = () => pub().targets.find((t) => t.kind === "root");
  const reused = () => pub().targets.filter((t) => t.kind === "reused");
  const logLines = () => { build(); return s.build.tail(8); };
  onMount(() => { if (project()) void s.publish.enter(); });
  const copy = (text: string, what: string) => { void s.copy(text, what); };
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-3">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`发布 · ${project() ?? "请选择项目"}`}</Text>
        <MobileButton label="刷新" kind="text" compact disabled={!project()} onPress={() => void s.publish.enter()} />
      </View>
      <View class="flex-row items-center gap-2">
        <MobileSegmentedControl
          items={[{ id: "test", label: "测试频道" }, { id: "release", label: "稳定版频道" }]}
          active={pub().channel}
          onChange={(id) => void s.publish.setChannel(id === "release" ? "release" : "test")}
        />
        <MobileButton label={busy() ? "发布中…" : pub().channel === "test" ? "发布测试包" : "发布稳定版"} compact disabled={!project() || busy() || root()?.canPublish === false} onPress={() => void s.publish.publish()} />
        <Show when={!busy() && pub().phase === "error" && !build().busy}>
          <MobileButton label="先构建" kind="tonal" compact disabled={!project()} onPress={() => void s.build.start()} />
        </Show>
      </View>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col gap-2" style={{ width: 330 }}>
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Panel title={`发布计划 · ${label()}`} note="发布只签名已保存并已成功构建的版本；密钥保存在本地服务中，Studio 看不到密钥。">
                <Show when={pub().planState === "loading"}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取发布目标…</Text></Show>
                <Show when={pub().planState === "error"}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取发布目标失败：${pub().planError}`}</Text></Show>
                <Show when={project() === undefined}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
                <Show when={root()}>{(t) => (
                  <View class="flex-col gap-1 w-full">
                    <Line label="主应用" value={`${t().title}（${t().appId}）`} />
                    <Line label="版本" value={t().version ? `v${t().version}${t().build !== undefined ? ` · 构建 ${t().build}` : ""}` : undefined} />
                    <Line label="构建状态" value={t().busy ? "正在构建" : t().built ? "已构建（可发布）" : "需先构建"} tone={t().built && !t().busy ? "ok" : "warn"} />
                    <Line label={`${label()}频道现有版本`} value={t().publishedVersion ? `v${t().publishedVersion}${t().publishedBuild !== undefined ? ` · 构建 ${t().publishedBuild}` : ""}` : "尚无发布记录"} />
                    <Line label="槽位所有者" value={`当前项目（${project()}）`} />
                    <Show when={t().reason && !t().canPublish}><Text class="text-xs" style={{ textColor: C.warn }}>{t().reason}</Text></Show>
                  </View>
                )}</Show>
                <Show when={reused().length > 0}>
                  <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`复用的已发布包（${reused().length}）`}</Text>
                  <For each={reused()}>{(t) => (
                    <View class="flex-col w-full">
                      <Text class="text-xs" style={{ textColor: C.body }}>{`${t.title}（${t.appId}）`}</Text>
                      <Text class="text-xs" style={{ textColor: t.canSelect === false || !t.ownerProjectId ? C.warn : C.muted }}>
                        {t.ownerProjectId ? `槽位所有者：${t.ownerTitle ?? t.ownerProjectId} · ${t.publishedVersion ? `v${t.publishedVersion}${t.publishedBuild !== undefined ? ` 构建 ${t.publishedBuild}` : ""}` : "尚无此频道发布版本"}` : (t.reason ?? "无法解析所属项目")}
                      </Text>
                    </View>
                  )}</For>
                </Show>
                <Show when={pub().planState === "ready" && reused().length === 0 && root()}><Text class="text-xs" style={{ textColor: C.faint }}>发布范围：主应用和此项目内的普通子包。</Text></Show>
              </Panel>
              <Panel title="离线包" note="把当前构建打包为完整的 .tar.gz（根包、子应用、签名清单与资源）。不会更改任何频道。">
                <MobileButton label={pub().offline.phase === "working" ? "正在生成…" : "生成离线包"} kind="tonal" compact disabled={!project() || pub().offline.phase === "working"} onPress={() => void s.publish.makeOffline()} />
                <Show when={pub().offline.phase === "done"}>
                  <Field label="离线包" value={pub().offline.filename} />
                  <Field label="下载地址" value={pub().offline.archiveUrl} onCopy={copy} copyLabel="离线包地址" />
                </Show>
                <Show when={pub().offline.phase === "error"}><Text class="text-xs" style={{ textColor: C.danger }}>{pub().offline.error}</Text></Show>
              </Panel>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-2 flex-1">
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Show when={busy()}>
                <Panel title="发布进度">
                  <Text class="text-xs" style={{ textColor: C.warn }}>{pub().step}</Text>
                  <For each={logLines()}>{(line) => <Text class="text-xs" style={{ textColor: C.muted }}>{line.text.length ? line.text : " "}</Text>}</For>
                </Panel>
              </Show>
              <Show when={pub().phase === "error"}>
                <Panel title="发布失败"><Text class="text-xs" style={{ textColor: C.danger }}>{pub().error}</Text></Panel>
              </Show>
              <Show when={pub().info} fallback={<Show when={!busy() && pub().phase !== "error"}><Text class="text-xs" style={{ textColor: C.muted }}>此项目还没有发布记录。构建成功后点击“发布测试包”。</Text></Show>}>
                {(info) => (
                  <Panel title={pub().fresh ? `发布完成 · ${info().channel === "release" ? "稳定版" : "测试"}` : `最近一次发布 · ${info().channel === "release" ? "稳定版" : "测试"}`}>
                    <Line label="版本" value={info().version ? `v${info().version}` : undefined} />
                    <Line label="构建号" value={info().build} />
                    <Line label="源码修订" value={info().revision !== undefined ? `r${info().revision}` : undefined} />
                    <Line label="发布时间" value={formatTime(info().publishedAt)} />
                    <Field label="签名密钥 ID" value={info().keyId} onCopy={copy} />
                    <Field label="运行时 ABI" value={info().runtimeAbi} shown={info().runtimeAbi ? shortHash(info().runtimeAbi!, 26, 8) : undefined} onCopy={copy} />
                    <Field label="payload SHA-256" value={info().payloadSha256} shown={info().payloadSha256 ? shortHash(info().payloadSha256!, 20, 8) : undefined} copyLabel="payload SHA-256" onCopy={copy} />
                    <Field label="清单地址 (latest.json)" value={info().manifestUrl} copyLabel="清单地址" onCopy={copy} />
                    <Field label="host.json 地址" value={info().hostConfigUrl} copyLabel="host.json 地址" onCopy={copy} />
                    <Field label="App 接入地址" value={info().appConfigUrl} copyLabel="App 接入地址" onCopy={copy} />
                    <Field label="归档（.tar.gz）" value={info().archiveUrl} copyLabel="归档地址" onCopy={copy} />
                    <Show when={info().packages.length > 0}>
                      <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`已发布的包（${info().packages.length}）`}</Text>
                      <For each={info().packages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>}</For>
                    </Show>
                    <Show when={info().reusedPackages.length > 0}>
                      <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`复用的包（${info().reusedPackages.length}）`}</Text>
                      <For each={info().reusedPackages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}${p.ownerProjectId ? ` · 所有者 ${p.ownerProjectId}` : ""}`}</Text>}</For>
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
