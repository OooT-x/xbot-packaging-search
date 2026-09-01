const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  confirmationIntent,
  findProject,
  hasPackagingAction,
  hasPackagingDomain,
  isPackagingQueryText,
  isPotentialConfirmation,
  searchPackages,
} = require("./package-intent");
const { syncEagleCatalog } = require("./eagle-sync");

function candidateLabel(item) {
  return `${item.project_name} · ${item.package_name}（${item.version}）`;
}

function queryPrompt(candidates, expiresMinutes) {
  const intro =
    candidates.length === 1 ? "找到一个候选：" : `找到 ${candidates.length} 个候选：`;
  const selectHint =
    candidates.length === 1
      ? "预览图就是这一个，请直接回复这条消息说“这个”。"
      : "预览图按上面的顺序发了，请直接回复这条消息，用数字（比如“第二个”）选一个。";
  return [
    intro,
    "",
    ...candidates.map(
      (item, index) =>
        `${index + 1}. ${candidateLabel(item)}`
    ),
    "",
    selectHint,
    `${expiresMinutes} 分钟内有效，只有你能确认。`,
  ].join("\n");
}

function buildCandidatePost(candidates, imageKeys, expiresMinutes) {
  const rows = [
    [
      {
        tag: "text",
        text:
          candidates.length === 1
            ? "找到一个候选："
            : `找到 ${candidates.length} 个候选：`,
      },
    ],
  ];
  candidates.forEach((item, index) => {
    rows.push([{ tag: "text", text: `${index + 1}. ${candidateLabel(item)}` }]);
    rows.push([{ tag: "img", image_key: imageKeys[index] }]);
  });
  rows.push([
    {
      tag: "text",
      text:
        candidates.length === 1
          ? "请直接回复这条消息说“这个”，我再发送源文件。"
          : "请直接回复这条消息，用数字（比如“第二个”）选择候选。",
    },
  ]);
  rows.push([
    {
      tag: "text",
      text: `${expiresMinutes} 分钟内有效，只有原查询人可以确认。`,
    },
  ]);
  return { zh_cn: { content: rows } };
}

function safeMessageId(result) {
  return String(result?.message_id || result?.data?.message_id || "").trim();
}

function formatFileSize(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 1 : 2)}MB`;
}

function generateProactiveSuggestion(result) {
  if (!result?.project || !result?.candidates?.length) return null;
  const allTypes = new Set();
  const queriedType = result.package_type || "";
  for (const c of result.candidates) {
    if (c.package_type) allTypes.add(c.package_type);
  }
  const remaining = [...allTypes].filter((t) => t !== queriedType);
  if (remaining.length === 0) return null;
  if (queriedType) {
    return "要不要也看看" + remaining.join("和") + "？回复对应关键词就行。";
  }
  return null;
}

class PackagingService {
  constructor(options) {
    this.database = options.database;
    this.transport = options.transport;
    this.aliasesPath = options.aliasesPath;
    this.eagleBaseUrl = options.eagleBaseUrl;
    this.libraryPath = options.libraryPath || "";
    this.driveUploadThresholdBytes = Number(
      options.driveUploadThresholdBytes || 25 * 1024 * 1024
    );
    this.log = options.log || (() => {});
    this.expiresMinutes = Number(options.expiresMinutes || 20);
    this.syncIntervalMs = Number(options.syncIntervalMs || 60_000);
    this.lastSyncAt = 0;
    this.lastSyncError = null;
  }

  async initialize() {
    return await this.refreshCatalog(true);
  }

  async refreshCatalog(force = false) {
    if (!force && Date.now() - this.lastSyncAt < this.syncIntervalMs) return null;
    try {
      const report = await syncEagleCatalog(this.database, {
        baseUrl: this.eagleBaseUrl,
        aliasesPath: this.aliasesPath,
        libraryPath: this.libraryPath,
      });
      this.lastSyncAt = Date.now();
      this.lastSyncError = null;
      this.log(
        `packaging catalog synced projects=${report.project_count} packages=${report.package_count} errors=${report.errors.length}`
      );
      report.errors.forEach((message) => this.log(`packaging catalog warning: ${message}`));
      return report;
    } catch (error) {
      this.lastSyncError = error;
      this.log(`packaging catalog sync failed: ${error.message}`);
      if (this.database.activePackageCount() === 0) throw error;
      return null;
    }
  }

  async tryHandleQuery(event, options = {}) {
    const aiHint = options.aiHint || null;
    if (!options.mentioned) return false;
    if (!isPackagingQueryText(event.content) && !aiHint) return false;

    const existing = this.database.getQueryByRootMessage(event.message_id);
    if (existing) {
      if (existing.status === "preparing") {
        await this.transport.replyText(
          event.message_id,
          "这条包装查询还在准备候选，请稍等一下。",
          `package-query-${existing.request_id}-preparing`
        );
      }
      return true;
    }

    const packages = this.database.listActivePackages();
    let effectiveContent = event.content;
    if (aiHint) {
      effectiveContent = [event.content, aiHint.project_name, aiHint.package_type]
        .filter(Boolean)
        .join(" ");
    } else {
      const project = findProject(packages, event.content);
      const hasAction = hasPackagingAction(event.content);
      const hasDomain = hasPackagingDomain(event.content);
      if (!project) {
        if (!hasAction || !hasDomain) return false;
        await this.transport.replyText(
          event.message_id,
          "你是要找包装素材吧？先告诉我项目名，例如：@X.bot 找变速箱项目的信息条。",
          `package-query-${event.event_id || event.message_id}-missing-project`
        );
        return true;
      }
      if (!hasAction && !hasDomain) return false;
    }

    try {
      await this.refreshCatalog(false);
    } catch (error) {
      await this.transport.replyText(
        event.message_id,
        "Eagle 素材库暂时不可用，我现在拿不到包装索引。请确认 Eagle 已启动后再试。",
        `package-query-${event.event_id || event.message_id}-eagle-unavailable`
      );
      return true;
    }

    const result = searchPackages(packages, effectiveContent, 3);
    if (!result.project) {
      await this.transport.replyText(
        event.message_id,
        "先告诉我项目名，例如：@X.bot 找变速箱项目的信息条。",
        `package-query-${event.event_id || event.message_id}-missing-project`
      );
      return true;
    }
    if (result.candidates.length === 0) {
      const typeText = result.package_type ? `的${result.package_type}` : "";
      await this.transport.replyText(
        event.message_id,
        `我识别到项目“${result.project.project_name}”，但没找到${typeText}可发送包装。`,
        `package-query-${event.event_id || event.message_id}-no-candidates`
      );
      return true;
    }

    return await this.startQueryFromResult(event, result);
  }

  async startQueryFromResult(event, result) {
    const requestId = crypto.randomUUID();
    const createdAt = Date.now();
    this.database.createPreparingQuery(
      {
        request_id: requestId,
        requester_id: event.sender_id,
        chat_id: event.chat_id,
        root_message_id: event.message_id,
        created_at: createdAt,
        expires_at: createdAt + this.expiresMinutes * 60_000,
      },
      result.candidates
    );

    try {
      this.log(`packaging dbg: upload phase begin request_id=${requestId} candidates=${result.candidates.length}`);
      const imageKeys = [];
      for (const candidate of result.candidates) {
        if (!fs.existsSync(candidate.preview_path)) {
          throw new Error(`preview file missing: ${candidate.preview_eagle_id}`);
        }
        imageKeys.push(await this.transport.uploadImage(candidate.preview_path));
        this.log(`packaging dbg: uploaded image request_id=${requestId} idx=${imageKeys.length}`);
      }
      this.log(`packaging dbg: upload phase done request_id=${requestId} imageKeys=${imageKeys.length}`);
      const postContent = buildCandidatePost(
        result.candidates,
        imageKeys,
        this.expiresMinutes
      );
      this.log(`packaging dbg: built post request_id=${requestId} postLen=${JSON.stringify(postContent).length}`);
      this.log(`packaging dbg: replyPost begin request_id=${requestId}`);
      const reply = await this.transport.replyPost(
        event.message_id,
        postContent,
        `package-query-${requestId}-candidates`
      );
      this.log(`packaging dbg: replyPost done request_id=${requestId}`);
      const promptMessageId = safeMessageId(reply);
      if (!promptMessageId) throw new Error("candidate post did not return message_id");

      this.database.markQueryPending(requestId, promptMessageId);
      this.log(
        `packaging query pending request_id=${requestId} candidates=${result.candidates.length}`
      );


      const suggestion = generateProactiveSuggestion(result);
      if (suggestion) {
        await this.transport.replyText(
          event.message_id,
          suggestion,
          `package-query-${requestId}-suggestion`
        );
      }
    } catch (error) {
      this.database.markQueryFailed(requestId, error.message);
      this.log(`packaging query failed request_id=${requestId}: ${error.message}`);
      await this.transport.replyText(
        event.message_id,
        "候选预览发送失败了，这次不会进入确认状态。请稍后重新查询。",
        `package-query-${requestId}-failed`
      );
    }
    return true;
  }

  async tryHandleConfirmation(event, options = {}) {
    try {
      return await this.handleConfirmation(event, options);
    } catch (error) {
      this.log(`packaging confirmation error message_id=${event.message_id}: ${error.message}`);
      return false;
    }
  }

  async handleConfirmation(event, options = {}) {
    if (!["text", "post"].includes(event.message_type)) return false;
    const content = String(event.content || "").trim();
    if (!isPotentialConfirmation(content) && !hasPackagingDomain(content)) return false;

    if (options.mentioned) {
      const project = findProject(this.database.listActivePackages(), content);
      if (project && isPackagingQueryText(content)) {
        this.log(
          `packaging confirmation skipped for explicit query message_id=${event.message_id} project=${project.project_name}`
        );
        return false;
      }
    }

    let message;
    try {
      message = await this.transport.getMessage(event.message_id);
    } catch (error) {
      this.log(`packaging confirmation lookup failed message_id=${event.message_id}: ${error.message}`);
      return false;
    }
    const replyTo = String(message?.reply_to || "").trim();
    if (!replyTo) return false;

    const query = this.database.findQueryByReplyMessage(event.chat_id, replyTo);
    if (!query) return false;

    if (event.sender_id !== query.requester_id) {
      await this.transport.replyText(
        event.message_id,
        "这次查询需要由原查询人确认，我先不发源文件。",
        `package-query-${query.request_id}-wrong-requester-${event.sender_id}`
      );
      return true;
    }
    if (query.expires_at <= Date.now()) {
      this.database.expireQuery(query.request_id);
      await this.transport.replyText(
        event.message_id,
        "这次候选已经超过 20 分钟，请重新 @X.bot 查询。",
        `package-query-${query.request_id}-expired`
      );
      return true;
    }
    if (!isPotentialConfirmation(content)) {
      return await this.tryHandleFollowUp(event, query);
    }
    if (["preparing", "failed", "cancelled"].includes(query.status)) {
      await this.transport.replyText(
        event.message_id,
        "这次查询已经失效，请重新 @X.bot 发起查询。",
        `package-query-${query.request_id}-${query.status}`
      );
      return true;
    }
    if (query.status === "completed") {
      await this.transport.replyText(
        event.message_id,
        "这份查询已经完成，请重新 @X.bot 发起查询。",
        `package-query-${query.request_id}-already-completed`
      );
      return true;
    }
    if (query.status === "sending") {
      await this.transport.replyText(
        event.message_id,
        "源文件正在发送，稍等一下。",
        `package-query-${query.request_id}-already-sending`
      );
      return true;
    }

    const intent = confirmationIntent(event.content, query.candidates.length, query.replied_position);
    if (intent.kind === "reject") {
      this.database.cancelQuery(query.request_id);
      await this.transport.replyText(
        event.message_id,
        "好，这次先不发源文件。换项目、类型或关键词后重新 @X.bot 查就行。",
        `package-query-${query.request_id}-cancelled`
      );
      return true;
    }
    if (intent.kind === "ambiguous") {
      await this.transport.replyText(
        event.message_id,
        "这里有多个候选，请回复“第一个”“第二个”或“第三个”。",
        `package-query-${query.request_id}-ambiguous`
      );
      return true;
    }
    if (intent.kind !== "select") return false;

    const selected = query.candidates.find((candidate) => candidate.position === intent.position);
    if (!selected) return false;
    if (!fs.existsSync(selected.source_path)) {
      await this.transport.replyText(
        event.message_id,
        "这个候选的源文件映射失效了，我没有发送。请重新同步 Eagle 索引。",
        `package-query-${query.request_id}-source-missing`
      );
      return true;
    }

    const idempotencyKey = `package-delivery-${query.request_id}-${selected.package_id}`;
    const claim = this.database.claimDelivery(
      query.request_id,
      selected.package_id,
      idempotencyKey
    );
    if (claim.state === "completed" || claim.state === "sending") {
      await this.transport.replyText(
        event.message_id,
        claim.state === "completed" ? "这份源文件已经发过了，不重复上传。" : "源文件正在发送，稍等一下。",
        `package-query-${query.request_id}-${claim.state}`
      );
      return true;
    }
    if (claim.state !== "claimed") {
      await this.transport.replyText(
        event.message_id,
        "这次候选状态已经变化，请重新 @X.bot 查询。",
        `package-query-${query.request_id}-claim-${claim.state}`
      );
      return true;
    }

    try {
      await this.transport.replyText(
        event.message_id,
        `确认：${selected.package_name} ${selected.version}。源文件会回复到最初的查询消息下面。`,
        `package-query-${query.request_id}-confirmed`
      );
      const fileSize = fs.statSync(selected.source_path).size;
      if (fileSize > this.driveUploadThresholdBytes) {
        const drive = await this.transport.uploadToDrive(selected.source_path);
        await this.transport.replyText(
          event.message_id,
          `这份源文件有 ${formatFileSize(fileSize)}，飞书直接发文件会被限制，我传到云盘了：\n${drive.url}\n下载后直接使用。`,
          `package-query-${query.request_id}-drive-link`
        );
        this.database.markDeliveryCompleted(
          query.request_id,
          selected.package_id,
          `drive:${drive.token}`
        );
        this.log(
          `packaging source uploaded request_id=${query.request_id} package_id=${selected.package_id} url=${drive.url}`
        );
      } else {
        const fileReply = await this.transport.replyFile(
          query.root_message_id,
          selected.source_path,
          idempotencyKey
        );
        const sourceMessageId = safeMessageId(fileReply);
        if (!sourceMessageId) throw new Error("source reply did not return message_id");
        this.database.markDeliveryCompleted(
          query.request_id,
          selected.package_id,
          sourceMessageId
        );
        this.log(
          `packaging source sent request_id=${query.request_id} package_id=${selected.package_id} message_id=${sourceMessageId}`
        );
      }
    } catch (error) {
      this.database.markDeliveryFailed(query.request_id, selected.package_id, error.message);
      this.log(`packaging source send failed request_id=${query.request_id}: ${error.message}`);
      await this.transport.replyText(
        event.message_id,
        "源文件发送失败了，查询状态已保留。你可以回复同一候选再试一次。",
        `package-query-${query.request_id}-send-failed`
      );
    }
    return true;
  }

  async tryHandleFollowUp(event, query) {
    const projectName = query.candidates?.[0]?.project_name;
    if (!projectName) return false;

    try {
      await this.refreshCatalog(false);
    } catch (error) {
      await this.transport.replyText(
        event.message_id,
        "Eagle 素材库暂时不可用，我现在拿不到包装索引。请确认 Eagle 已启动后再试。",
        `package-query-${event.event_id || event.message_id}-eagle-unavailable`
      );
      return true;
    }

    const packages = this.database.listActivePackages();
    const effectiveContent = `${projectName} ${event.content}`;
    const result = searchPackages(packages, effectiveContent, 3);
    if (!result.project || result.candidates.length === 0) return false;

    this.log(
      `packaging follow-up request_id=${query.request_id} message_id=${event.message_id} project=${projectName} type=${result.package_type || ""} (previous query kept pending)`
    );
    return await this.startQueryFromResult(event, result);
  }
}

module.exports = { PackagingService, queryPrompt, safeMessageId };
