const plain = content => ({ tag: "plain_text", content: String(content || "") });
const escape = value => String(value || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/[\\`*_\[\]]/g, "\\$&");
function group(elements) {
  return { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, vertical_spacing: "8px", padding: "12px", background_style: "grey-50", elements }] };
}
function button(label, action, requestId, position) {
  return { tag: "button", text: plain(label), type: action === "select" ? "primary" : "default", width: "fill", behaviors: [{ type: "callback", value: { scope: "packaging", action, request_id: requestId, ...(position ? { position } : {}) } }] };
}
function buildPackagingCard(candidates, imageKeys, { requestId, expiresMinutes = 20 } = {}) {
  const elements = candidates.map((item, index) => group([
    { tag: "markdown", content: `**${index + 1}. ${escape(item.package_name)}**\n<font color='grey'>${escape(item.package_type || "包装素材")} · ${escape(item.version)}</font>` },
    { tag: "img", img_key: imageKeys[index], alt: plain(item.package_name), scale_type: "fit_horizontal", corner_radius: "4px", preview: true },
    ...(requestId ? [button("领取源文件", "select", requestId, index + 1)] : []),
  ]));
  elements.push(group([
    { tag: "markdown", content: requestId
      ? `也可回复卡片编号领取。\n<font color='grey'>${expiresMinutes} 分钟内有效 · 仅原查询人可操作</font>`
      : "**仅图片背景**\n没有对应工程 ZIP，不提供源文件领取。" },
    ...(requestId ? [{ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [button("换一批", "more", requestId), button("取消", "cancel", requestId)].map(action => ({ tag: "column", width: "weighted", weight: 1, elements: [action] })) }] : []),
  ]));
  return { schema: "2.0", config: { update_multi: true, width_mode: "default", enable_forward: false },
    header: { title: plain(`${candidates[0]?.project_name || "包装素材"} · 包装候选`), subtitle: plain(`${candidates.length} 个候选 · 点击预览查看大图`), template: "blue" },
    body: { padding: "12px", direction: "vertical", vertical_spacing: "12px", elements } };
}
function buildPackagingNotice(text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>]+)/g);
  const content = parts.map(part => /^https?:\/\//.test(part)
    ? `[打开链接](${part.replace(/[()]/g, c => c === "(" ? "%28" : "%29")})` : escape(part)).join("");
  return { schema: "2.0", config: { update_multi: true, width_mode: "default" },
    header: { title: plain("X.bot · 包装素材"), template: "blue" },
    body: { padding: "12px", vertical_spacing: "8px", elements: [{ tag: "markdown", content: "**查询与领取进度**" }, group([{ tag: "markdown", content }])] } };
}
function buildSessionCard(session, catalog, database) {
  const closed = session.status !== "active";
  const value = action => ({ scope: "packaging-session", session_id: session.session_id, revision: session.revision, action });
  const actionButton = (label, action, extra = {}, disabled = false) => ({ tag: "button", text: plain(label),
    type: action === "select" ? "primary" : "default", width: "fill", disabled: closed || disabled,
    behaviors: [{ type: "callback", value: { ...value(action), ...extra } }] });
  const row = buttons => ({ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns:
    buttons.map(b => ({ tag: "column", width: "weighted", weight: 1, elements: [b] })) });
  const select = (name, label, options, initial) => ({ tag: "select_static", name, width: "fill", disabled: closed,
    placeholder: plain(label), options: options.map(o => ({ text: plain(o.name), value: o.id })),
    ...(initial ? { initial_option: initial } : {}), behaviors: [{ type: "callback", value: value(name) }] });
  const elements = [];
  const project = catalog.projects.find(p => p.id === session.project_id);
  if (closed) {
    elements.push(group([{ tag: "markdown", content: session.status === "expired" ? "**查询已过期**\n请重新 @X.bot 找包装。" : "**本次查询已结束**\n已发送的文件仍保留在原查询下。" }]));
  } else if (session.stage === "project") {
    elements.push(group([{ tag: "markdown", content: "**先选一个项目**\n选好后可继续筛选包装类型。" },
      ...(catalog.projects.length ? [select("project", "选择项目", catalog.projects)] : [{ tag: "markdown", content: "当前没有可用项目，请稍后重试。" }])]));
  } else if (session.stage === "type") {
    elements.push(group([{ tag: "markdown", content: `**${escape(project?.name || "项目")} · 选择包装类型**` },
      select("type", "选择类型", [{ id: "__all__", name: "全部类型" }, ...catalog.types.map(t => ({ id: t, name: t }))]) ]));
  } else {
    const page = session.pages[session.page];
    if (page) page.items.forEach((item, index) => {
      const delivery = database.db.prepare("SELECT d.status,d.phase,d.last_error FROM deliveries d JOIN queries q USING(request_id) WHERE q.source_root_message_id=? AND d.package_id=? ORDER BY CASE WHEN d.status='completed' THEN 0 WHEN d.phase='uncertain' THEN 1 WHEN d.status='sending' THEN 2 ELSE 3 END LIMIT 1")
        .get(session.root_message_id, item.package_id);
      const uncertain = delivery?.phase === "uncertain";
      const busy = delivery?.status === "sending" || session.sending === index + 1;
      const sent = delivery?.status === "completed";
      const label = uncertain ? "结果待核对" : sent ? "已发送" : busy ? "发送中…" : delivery?.status === "failed" ? "重试领取" : "领取源文件";
      elements.push(group([
        { tag: "markdown", content: `**${index + 1}. ${escape(item.package_name)}**\n<font color='grey'>${!session.project_id ? `${escape(item.project_name)} · ` : ""}${escape(item.package_type)} · ${escape(item.version)}</font>` },
        { tag: "img", img_key: page.imageKeys[index], alt: plain(item.package_name), scale_type: "fit_horizontal", preview: true },
        ...(item.source_path ? [actionButton(label, "select", { request_id: page.request_id, position: index + 1 }, uncertain || sent || busy)]
          : [{ tag: "markdown", content: "<font color='grey'>仅图片 · 无工程 ZIP</font>" }]),
      ]));
    });
    elements.push(row([actionButton("上一批", "previous", {}, session.page === 0),
      actionButton("下一批", "next", {}, session.end && session.page === session.pages.length - 1)]));
  }
  if (!closed) elements.push(group([
    ...(session.notice ? [{ tag: "markdown", content: escape(session.notice) }] : []),
    { tag: "markdown", content: `<font color='grey'>仅原查询人可操作 · 有效至 ${new Date(session.expires_at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}${session.stage === "results" ? ` · 第 ${session.page + 1} 批` : ""}</font>` },
    row([actionButton("换项目", "projects"), actionButton("换类型", "types", {}, !session.project_id), actionButton("结束查询", "cancel")]),
  ]));
  return { schema: "2.0", config: { update_multi: true, width_mode: "default", enable_forward: false },
    header: { title: plain(project ? `${project.name} · ${session.package_type || "全部包装"}` : "X.bot · 找包装"), template: closed ? "grey" : "blue" },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "12px", elements } };
}
module.exports = { buildPackagingCard, buildPackagingNotice, buildSessionCard };
