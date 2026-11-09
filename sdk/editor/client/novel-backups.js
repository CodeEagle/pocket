const node = (tag, className = "", text) => {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

export async function mount(container, context) {
  let disposed = false;
  let busy = false;
  let backups = [];
  let schedule = { intervalMinutes: 0 };
  let message = "";
  const dirty = () => context.hasUnsavedChanges();
  const button = (label, action, disabled = false) => {
    const value = node("button", "nv-button secondary", label);
    value.type = "button";
    value.disabled = busy || disabled;
    value.addEventListener("click", action);
    return value;
  };
  const request = async action => {
    busy = true;
    render();
    try { await action(); }
    catch (error) { message = error.message; }
    finally { busy = false; if (!disposed) render(); }
  };
  const refresh = async () => {
    const [history, policy] = await Promise.all([
      context.api(`${context.base}/backups`),
      context.api(`${context.base}/backups/schedule`),
    ]);
    backups = history.backups;
    schedule = policy;
  };
  const restore = backup => {
    if (busy || dirty() || !backup.manifestValid) return;
    if (!window.confirm(`恢复 ${new Date(backup.createdAt).toLocaleString()} 的 ${backup.fileCount} 个项目文件和素材？当前磁盘内容会先保留为恢复点。恢复后需要重新构建游戏。`)) return;
    void request(async () => {
      await context.api(`${context.base}/backups/restore`, { method: "POST", body: JSON.stringify({ backupId: backup.id }) });
      window.location.reload();
    });
  };
  function render() {
    if (disposed) return;
    const section = node("section", "nv-backup-panel");
    section.append(node("h1", "", "项目备份与恢复"));
    section.append(node("p", "nv-field-help", "备份包含磁盘上已保存的剧本、资源、字体、模型和自定义项目文件，存放在项目之外。未保存草稿不会进入备份。"));
    if (dirty()) section.append(node("p", "nv-backup-warning", "请先保存修改并处理文本剧本草稿，再创建或恢复备份。"));
    const actions = node("div", "nv-inline-actions");
    actions.append(button("备份已保存项目", () => { void request(async () => {
      const result = await context.api(`${context.base}/backups`, { method: "POST" });
      message = `已备份 ${result.backup.fileCount} 个文件。`;
      await refresh();
    }); }, dirty()));
    actions.append(button("刷新备份", () => { void request(refresh); }));
    section.append(actions);
    const policy = node("label", "nv-backup-policy");
    policy.append(node("span", "", "自动备份间隔"));
    const interval = node("select", "nv-input");
    interval.setAttribute("aria-label", "自动备份间隔");
    for (const minutes of [0, 1, 5, 10, 30, 60]) {
      const option = node("option", "", minutes ? `每 ${minutes} 分钟` : "关闭");
      option.value = String(minutes);
      interval.append(option);
    }
    interval.value = String(schedule.intervalMinutes);
    interval.disabled = busy;
    interval.addEventListener("change", () => { void request(async () => {
      schedule = await context.api(`${context.base}/backups/schedule`, { method: "POST", body: JSON.stringify({ intervalMinutes: Number(interval.value) }) });
      message = schedule.intervalMinutes ? "Editor 服务运行期间自动备份已保存文件；相同内容不会重复保存。" : "已关闭自动备份。";
    }); });
    policy.append(interval);
    section.append(policy);
    section.append(node("p", "nv-field-help", "自动备份在打开过本项目的 Editor 服务中运行；重启服务后再次打开项目即可恢复计时。最多保留 20 份，恢复前会额外保存当前版本。"));
    const status = node("p", "nv-backup-status", busy ? "正在处理项目备份…" : message || schedule.error || "");
    status.setAttribute("role", "status");
    section.append(status);
    const list = node("div", "nv-backup-list");
    if (!backups.length) list.append(node("p", "nv-field-help", "尚无项目备份。"));
    for (const backup of backups) {
      const row = node("article", "nv-backup-row");
      row.dataset.backupId = backup.id;
      row.append(node("strong", "", new Date(backup.createdAt).toLocaleString()));
      row.append(node("span", "nv-field-help", `${backup.fileCount} 个文件 · ${(backup.totalBytes / 1024).toFixed(1)} KiB`));
      if (!backup.manifestValid) row.append(node("p", "nv-backup-warning", `备份无法读取：${backup.error || "清单无效"}`));
      row.append(button("恢复这个版本", () => restore(backup), dirty() || !backup.manifestValid));
      list.append(row);
    }
    section.append(list);
    container.replaceChildren(section);
  }
  render();
  await request(refresh);
  return () => { disposed = true; };
}
