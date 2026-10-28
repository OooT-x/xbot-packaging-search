const crypto = require("crypto");
const { findProject, extractPackageType, searchPackages, confirmationIntent, isBrowseMore, preferCurrentVersions } = require("./package-intent");
const { stageFile, fileDigest } = require("./candidate-snapshot");
const { buildSessionCard } = require("./packaging-card");

class PackagingCardFlow {
  constructor(service) { this.service = service; this.db = service.database; this.queues = new Map(); }
  read(where, value) {
    const row = this.db.db.prepare(`SELECT * FROM card_sessions WHERE ${where} = ?`).get(value);
    return row ? { ...row, ...JSON.parse(row.state_json) } : null;
  }
  save(s) {
    this.db.db.prepare("UPDATE card_sessions SET card_message_id=?, state_json=? WHERE session_id=?")
      .run(s.card_message_id || null, JSON.stringify(s), s.session_id);
  }
  async serial(id, fn) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  catalog(s) {
    const packages = this.db.listActivePackages();
    return { projects: [...new Map(packages.map(p => [p.project_id, { id: p.project_id, name: p.project_name }])).values()],
      types: [...new Set(packages.filter(p => p.project_id === s.project_id).map(p => p.package_type))], packages };
  }
  async render(s) {
    if (s.status !== "active") this.db.db.prepare("UPDATE queries SET status=? WHERE source_root_message_id=? AND status='pending'").run(s.status, s.root_message_id);
    s.syncPending = true; this.save(s);
    await this.service.transport.updateCard(s.card_message_id, buildSessionCard(s, this.catalog(s), this.db));
    delete s.syncPending; this.save(s);
  }
  async start(event, hint) {
    if (this.read("root_message_id", event.message_id)) return true;
    await this.service.refreshCatalog(false);
    const packages = this.db.listActivePackages();
    const project = findProject(packages, event.content) || (hint?.project_name && findProject(packages, hint.project_name));
    const s = { session_id: crypto.randomUUID(), root_message_id: event.message_id, chat_id: event.chat_id,
      requester_id: event.sender_id, expires_at: Date.now() + this.service.expiresMinutes * 60000,
      revision: 0, status: "active", stage: project ? "type" : "project", project_id: project?.project_id || "",
      package_type: extractPackageType(event.content) || hint?.package_type || "", search: String(event.content || ""), pages: [], page: 0, notice: "" };
    this.db.db.prepare("INSERT INTO card_sessions(session_id,root_message_id,chat_id,requester_id,expires_at,state_json) VALUES(?,?,?,?,?,?)")
      .run(s.session_id, s.root_message_id, s.chat_id, s.requester_id, s.expires_at, JSON.stringify(s));
    await this.page(s);
    const reply = await this.service.transport.replyCard(event.message_id, buildSessionCard(s, this.catalog(s), this.db), `card-session-${s.session_id}`);
    s.card_message_id = reply?.message_id || reply?.data?.message_id;
    if (!s.card_message_id) throw new Error("card session did not return message_id");
    this.save(s);

    return true;
  }
  viewKey(s) { return JSON.stringify([s.project_id, s.package_type, s.search, s.filters || {}]); }
  remember(s) {
    if (s.pages.length) { s.views ||= {}; s.views[this.viewKey(s)] = { pages: s.pages, page: s.page, end: Boolean(s.end) }; }
  }
  async restoreOrPage(s) {
    const saved = s.views?.[this.viewKey(s)];
    if (saved) { s.pages = saved.pages; s.page = saved.page; s.end = saved.end; s.stage = "results"; s.notice = ""; }
    else await this.page(s);
  }
  async page(s, suppliedResult) {
    const { packages } = this.catalog(s);
    const project = packages.find(p => p.project_id === s.project_id);
    if (!project && s.project_id) { s.stage = "project"; s.notice = "该项目暂无可用素材，请重新选择。"; return; }
    const seen = s.pages.flatMap(p => p.items.map(item => item.package_id));
    const pool = Array.isArray(s.filters?.allowedIds) ? packages.filter(p => s.filters.allowedIds.includes(p.package_id)) : packages;
    const result = suppliedResult || (project
      ? searchPackages(pool, `${project.project_name} ${s.search}`, 3, { packageType: s.package_type, excludePackageIds: seen })
      : { candidates: preferCurrentVersions(pool, s.search).filter(item => !seen.includes(item.package_id) && (!s.package_type || item.package_type === s.package_type))
        .sort((a, b) => Number(b.eagle_modified_at || 0) - Number(a.eagle_modified_at || 0) || a.package_id.localeCompare(b.package_id)).slice(0, 3) });
    if (!result.candidates.length) { s.notice = "已看完当前条件下的包装，可返回上一批或重新筛选。"; s.end = true; return; }
    const requestId = crypto.randomUUID();
    // Each page has an internal unique query key; the real source reply target is stored explicitly.
    const hasSource = result.candidates.some(item => item.source_path);
    if (hasSource) this.db.createPreparingQuery({ request_id: requestId, requester_id: s.requester_id, chat_id: s.chat_id,
      root_message_id: `${s.root_message_id}#page:${requestId}`, created_at: Date.now(), expires_at: s.expires_at,
      search_type: s.package_type, followup_filters: {}, seen_package_ids: seen }, result.candidates);
    if (hasSource) this.db.db.prepare("UPDATE queries SET source_root_message_id=? WHERE request_id=?").run(s.root_message_id, requestId);
    try {
      const query = hasSource ? this.db.getQueryWithCandidates(requestId) : { candidates: result.candidates };
      const keys = [];
      for (const item of query.candidates) {
        const file = stageFile(item.preview_path, item.snapshot_json ? JSON.parse(item.snapshot_json).preview_hash : fileDigest(item.preview_path));
        try { keys.push(await this.service.transport.uploadImage(file.path)); } finally { file.cleanup(); }
      }
      if (hasSource) this.db.markQueryPending(requestId, `${s.session_id}#page:${requestId}`);
      s.pages.push({ request_id: hasSource ? requestId : null, items: result.candidates, imageKeys: keys });
      s.page = s.pages.length - 1; s.stage = "results"; s.notice = ""; s.end = false;
    } catch (error) { if (hasSource) this.db.markQueryFailed(requestId, error.message); throw error; }
  }
  async action(event) {
    if (event.type !== "card.action.trigger" || !event.event_id || !event.operator_id || !event.chat_id) return false;
    let value;
    try { value = typeof event.action_value === "string" ? JSON.parse(event.action_value) : event.action_value; } catch { return false; }
    if (value?.scope !== "packaging-session") return false;
    return this.serial(value.session_id, async () => {
      const s = this.read("session_id", value.session_id);
      if (!s || s.card_message_id !== event.message_id || s.chat_id !== event.chat_id) return true;
      if (s.requester_id !== event.operator_id) return true;
      if (s.expires_at <= Date.now()) s.status = "expired";
      if (s.status !== "active" || value.revision !== s.revision) { await this.render(s); return true; }
      if (event.action_tag !== "button" && event.action_tag !== "select_static") return true;
      const catalog = this.catalog(s);
      const action = value.action;
      if (action === "project" && event.action_tag === "select_static") {
        if (!catalog.projects.some(p => p.id === event.option)) return true;
        this.remember(s);
        s.project_id = event.option; s.package_type = ""; s.search = ""; s.filters = {}; s.stage = "type"; s.pages = []; s.page = 0;
      } else if (action === "type" && event.action_tag === "select_static") {
        if (event.option !== "__all__" && !catalog.types.includes(event.option)) return true;
        this.remember(s);
        s.package_type = event.option === "__all__" ? "" : event.option; s.search = ""; s.filters = {}; s.pages = []; s.page = 0;
        await this.restoreOrPage(s);
      } else if (action === "next") {
        if (s.page < s.pages.length - 1) { s.page++; s.notice = ""; }
        else await this.page(s);
      } else if (action === "previous") { s.page = Math.max(0, s.page - 1); s.notice = ""; }
      else if (action === "projects") { s.stage = "project"; }
      else if (action === "types") { s.stage = "type"; }
      else if (action === "cancel") { s.status = "cancelled"; }
      else if (action === "select" && event.action_tag === "button") {
        const page = s.pages[s.page];
        if (s.stage !== "results" || !page || value.request_id !== page.request_id ||
            !Number.isInteger(value.position) || !page.items[value.position - 1]?.source_path) return true;
        s.revision++; s.notice = "正在核验并发送源文件…"; s.sending = value.position;
        try { await this.render(s); } catch (error) {
          delete s.sending; s.notice = "卡片更新失败，尚未发送源文件，请重试。"; this.save(s); throw error;
        }
        await this.confirm(s, event, `第${value.position}个`);
        delete s.sending; s.revision++; await this.render(s); return true;
      } else return true;
      s.revision++; await this.render(s); return true;
    });
  }
  async confirm(s, event, content) {
    const page = s.pages[s.page];
    if (!page.request_id) { s.notice = "这些素材仅提供图片，没有工程 ZIP。"; return; }
    const query = this.db.getQueryWithCandidates(page.request_id);
    const intent = confirmationIntent(content, page.items.length);
    if (intent.kind === "select") {
      const item = page.items[intent.position - 1];
      const prior = this.db.db.prepare("SELECT d.status,d.phase FROM deliveries d JOIN queries q USING(request_id) WHERE q.source_root_message_id=? AND d.package_id=? AND (d.status IN ('completed','sending') OR d.phase='uncertain') LIMIT 1").get(s.root_message_id, item.package_id);
      if (prior) { s.notice = prior.status === "completed" ? "这份源文件已经发送，不重复领取。" : "该素材正在发送或结果待核对，暂不重复领取。"; return; }
    }
    const worker = Object.create(this.service);
    worker.cardFlow = null;
    worker.transport = Object.create(this.service.transport);
    worker.transport.replyText = async (target, text, key) => {
      // Drive link dispatch is an actual delivery and must retain the real reply/idempotency contract.
      if (key.endsWith("-drive-link")) return this.service.transport.replyText(s.root_message_id, text, key);
      s.notice = text; this.save(s);
      try { await this.render(s); } catch (error) { this.service.log(`card progress update failed: ${error.message}`); }
      return { message_id: s.card_message_id };
    };
    worker.startQueryFromResult = async (_event, result) => {
      s.package_type = result.package_type || ""; s.filters = result.followup_filters || {};
      s.pages = []; s.page = 0; await this.page(s, result); return true;
    };
    await worker.tryHandleConfirmation({ ...event, message_id: s.card_message_id, chat_id: s.chat_id,
      sender_id: s.requester_id, message_type: "text", content }, { cardQuery: query });
    const sent = this.db.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE request_id=? AND status='completed'").get(query.request_id).n;
    if (sent && intent.kind === "select") s.notice = "源文件已发送到最初的查询消息下，可继续浏览。";
    this.save(s);
  }
  async text(event, replyTo) {
    const s = this.read("card_message_id", replyTo);
    if (!s || s.chat_id !== event.chat_id) return false;
    return this.serial(s.session_id, async () => {
      const current = this.read("session_id", s.session_id);
      if (current.requester_id !== event.sender_id) return true;
      if (current.expires_at <= Date.now()) current.status = "expired";
      if (current.status !== "active") { await this.render(current); return true; }
      const intent = confirmationIntent(event.content, current.pages[current.page]?.items.length || 0);
      if (intent.kind === "select" && current.stage === "results") await this.confirm(current, event, event.content);
      else if (intent.kind === "reject" && !isBrowseMore(event.content)) current.status = "cancelled";
      else if (isBrowseMore(event.content) && current.stage === "results") {
        if (current.page < current.pages.length - 1) current.page++; else await this.page(current);
      } else if (current.stage === "results" && this.service.judgeFollowUp) {
        await this.confirm(current, event, event.content);
      } else {
        const catalog = this.catalog(current);
        const project = findProject(catalog.packages, event.content);
        if (project) current.project_id = project.project_id;
        if (!current.project_id) { current.stage = "project"; current.notice = "请先选择项目。"; }
        else {
          current.package_type = extractPackageType(event.content) || current.package_type;
          current.search = String(event.content || ""); current.pages = []; current.page = 0;
          await this.page(current);
        }
      }
      current.revision++; await this.render(current); return true;
    });
  }
  async recover() {
    for (const row of this.db.db.prepare("SELECT session_id FROM card_sessions").all()) {
      const s = this.read("session_id", row.session_id);
      if (!s.card_message_id || (!s.sending && !s.syncPending)) continue;
      delete s.sending; s.notice = "服务已恢复，领取结果以素材按钮状态为准。";
      if (s.expires_at <= Date.now()) s.status = "expired";
      try { await this.render(s); } catch (error) { this.service.log(`card recovery update failed: ${error.message}`); }
    }
  }
  async expire() {
    const rows = this.db.db.prepare("SELECT session_id FROM card_sessions WHERE expires_at<=?").all(Date.now());
    for (const row of rows) await this.serial(row.session_id, async () => {
      const s = this.read("session_id", row.session_id);
      if ((s.status !== "active" && !s.syncPending) || !s.card_message_id) return;
      s.status = "expired"; s.revision++; await this.render(s);
    });
  }
}
module.exports = { PackagingCardFlow };
