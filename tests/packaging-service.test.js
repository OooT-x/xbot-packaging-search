const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PackageDatabase } = require("../bot/lib/package-database");
const { PackagingService, queryPrompt } = require("../bot/lib/packaging-service");

function fixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-service-"));
  const preview = path.join(root, "preview.png");
  const source = path.join(root, "source.zip");
  fs.writeFileSync(preview, "preview");
  fs.writeFileSync(source, "source");

  const database = new PackageDatabase(path.join(root, "packaging.sqlite"));
  database.replaceCatalog(
    [
      {
        project_id: "project-1",
        project_name: "变速箱",
        normalized_name: "变速箱",
        aliases: ["变速箱包装"],
      },
    ],
    [
      {
        package_id: "pkg-1",
        project_id: "project-1",
        package_name: "小标注",
        package_type: "信息条",
        tags: ["重点标注"],
        version: "v01",
        preview_eagle_id: "preview-1",
        source_eagle_id: "source-1",
        preview_path: preview,
        source_path: source,
        ae_comp_name: "小标注",
        dependency_status: "warning",
        status: "active",
      },
      {
        package_id: "pkg-bg",
        project_id: "project-1",
        project_name: "变速箱",
        normalized_name: "变速箱",
        aliases: ["变速箱包装", "齿轮箱项目"],
        package_name: "黑色纹理背景",
        package_type: "背景",
        tags: ["主背景"],
        version: "v01",
        preview_eagle_id: "preview-bg",
        source_eagle_id: "source-bg",
        preview_path: preview,
        source_path: source,
        ae_comp_name: "黑色纹理背景",
        dependency_status: "complete",
        status: "active",
      },
    ]
  );

  const calls = [];
  let counter = 0;
  const replyTargets = new Map();
  const transport = {
    async replyText(messageId, text, key) {
      const message_id = `om_sent_${++counter}`;
      calls.push({ kind: "text", messageId, text, key, message_id });
      return { message_id };
    },
    async replyImage(messageId, filePath, key) {
      const message_id = `om_sent_${++counter}`;
      calls.push({ kind: "image", messageId, filePath, key, message_id });
      return { message_id };
    },
    async replyFile(messageId, filePath, key) {
      const message_id = `om_sent_${++counter}`;
      calls.push({ kind: "file", messageId, filePath, key, message_id });
      return { message_id };
    },
    async uploadImage(filePath) {
      const image_key = `img_${++counter}`;
      calls.push({ kind: "upload", filePath, image_key });
      return image_key;
    },
    async replyPost(messageId, content, key) {
      const message_id = `om_sent_${++counter}`;
      calls.push({ kind: "post", messageId, content, key, message_id });
      return { message_id };
    },
    async uploadToDrive(filePath) {
      const url = `https://example.feishu.cn/file/drive-${++counter}`;
      const token = `token-${counter}`;
      calls.push({ kind: "drive", filePath, url, token });
      return { url, token };
    },
    async getMessage(messageId) {
      return { message_id: messageId, reply_to: replyTargets.get(messageId) || "" };
    },
  };

  const service = new PackagingService({
    database,
    transport,
    aliasesPath: path.join(root, "aliases.json"),
    expiresMinutes: 20,
    ...serviceOptions,
  });
  service.lastSyncAt = Date.now();
  // This fixture owns its temporary catalog; production confirms against Eagle on every send.
  service.refreshCatalog = async () => ({ package_count: database.activePackageCount() });

  return {
    root,
    database,
    service,
    calls,
    replyTargets,
    close() {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("sends a preview, accepts only the requester, and delivers the ZIP once", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-query",
      message_id: "om_root",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const candidatePost = app.calls.find((call) => call.kind === "post");
    assert.ok(candidatePost);
    app.replyTargets.set("om_other_confirmation", candidatePost.message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_other_confirmation",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_other",
        content: "这个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);

    app.replyTargets.set("om_confirmation", candidatePost.message_id);
    const confirmation = {
      message_id: "om_confirmation",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "这个",
    };
    assert.equal(await app.service.tryHandleConfirmation(confirmation), true);

    const fileCalls = app.calls.filter((call) => call.kind === "file");
    assert.equal(fileCalls.length, 1);
    assert.equal(fileCalls[0].messageId, "om_root");
    assert.equal(path.basename(fileCalls[0].filePath), "source.zip");

    assert.equal(await app.service.tryHandleConfirmation(confirmation), true);
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 1);
    assert.equal(app.database.getQueryByRootMessage("om_root").status, "pending");
  } finally {
    app.close();
  }
});

test("candidate snapshots reject replaced, revised, withdrawn, legacy and overwritten source files", async () => {
  for (const change of ["id", "revision", "archive", "legacy", "source-content", "preview-content", "resource-key", "offline"]) {
    const app = fixture();
    try {
      await app.service.tryHandleQuery({ message_id: `snapshot-${change}`, message_type: "text", chat_id: "chat",
        sender_id: "owner", content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
      const query = app.database.getQueryByRootMessage(`snapshot-${change}`);
      const selected = app.database.getQueryWithCandidates(query.request_id).candidates[0];
      if (change === "id") app.database.db.prepare("UPDATE packages SET source_eagle_id = 'replacement' WHERE package_id = ?").run(selected.package_id);
      if (change === "revision") app.database.db.prepare("UPDATE packages SET catalog_revision = 'new' WHERE package_id = ?").run(selected.package_id);
      if (change === "archive") app.database.replaceCatalog([], []);
      if (change === "legacy") app.database.db.prepare("UPDATE query_candidates SET snapshot_json = NULL WHERE request_id = ?").run(query.request_id);
      if (change === "source-content") fs.writeFileSync(selected.source_path, "changed source");
      if (change === "preview-content") fs.writeFileSync(selected.preview_path, "changed preview");
      if (change === "resource-key") {
        app.database.claimDelivery(query.request_id, selected.package_id, `cached-${change}`);
        app.database.markDeliveryUploaded(query.request_id, selected.package_id, { url: "https://example.test/old", token: "old" });
        app.database.markDeliveryFailed(query.request_id, selected.package_id, "interrupted before dispatch");
        app.database.db.prepare("UPDATE deliveries SET snapshot_key = NULL").run();
      }
      if (change === "offline") app.service.refreshCatalog = async () => null;
      app.replyTargets.set("confirm-snapshot", query.prompt_message_id);
      await app.service.handleConfirmation({ message_id: "confirm-snapshot", message_type: "text", chat_id: "chat", sender_id: "owner", content: "确认" });
      assert.equal(app.calls.filter(call => call.kind === "file" || call.kind === "drive").length, 0, change);
      assert.equal(app.calls.some(call => call.text?.includes("传到云盘")), false, change);
    } finally { app.close(); }
  }
});

test("uploads a verified private ZIP copy, cleans it, and checks withdrawal after Drive upload", async () => {
  for (const drive of [false, true]) {
    const app = fixture(drive ? { driveUploadThresholdBytes: 1 } : {});
    let stagedPath;
    try {
      await app.service.tryHandleQuery({ message_id: "copy-root", message_type: "text", chat_id: "chat",
        sender_id: "owner", content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
      const query = app.database.getQueryByRootMessage("copy-root");
      if (drive) app.service.transport.uploadToDrive = async file => {
        stagedPath = file;
        app.database.replaceCatalog([], []);
        return { token: "uploaded", url: "https://example.test/uploaded" };
      };
      else app.service.transport.replyFile = async (_id, file) => {
        stagedPath = file;
        fs.writeFileSync(path.join(app.root, "source.zip"), "overwritten during upload");
        assert.equal(fs.readFileSync(file, "utf8"), "source");
        return { message_id: "copy-sent" };
      };
      app.replyTargets.set("copy-confirm", query.prompt_message_id);
      await app.service.handleConfirmation({ message_id: "copy-confirm", message_type: "text", chat_id: "chat", sender_id: "owner", content: "确认" });
      assert.ok(stagedPath);
      assert.notEqual(path.dirname(stagedPath), app.root);
      assert.equal(fs.existsSync(path.dirname(stagedPath)), false);
      assert.equal(app.calls.some(call => call.text?.includes("传到云盘")), false);
      const delivery = app.database.db.prepare("SELECT status, phase FROM deliveries").get();
      assert.equal(delivery.status, drive ? "failed" : "completed");
      assert.equal(delivery.phase, drive ? "uploaded" : "delivered");
    } finally { app.close(); }
  }
});

test("confirmation rereads the Eagle directory and refuses a withdrawn item despite its cached active index", async () => {
  const app = fixture();
  try {
    app.database.db.exec("DELETE FROM packages; DELETE FROM projects;");
    fs.writeFileSync(path.join(app.root, "metadata.json"), JSON.stringify({ name: "test-library" }));
    const common = "package_id: live-pair\n项目: 变速箱\n包装名称: 信息条\n包装类型: 信息条\n版本: v01\n状态: 启用";
    for (const ext of ["png", "zip"]) {
      const dir = path.join(app.root, "images", ext + ".info");
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "asset." + ext), ext);
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id: ext, ext, annotation: common }));
    }
    app.service.libraryPath = app.root;
    app.service.lastSyncAt = 0;
    app.service.refreshCatalog = PackagingService.prototype.refreshCatalog.bind(app.service);
    await app.service.tryHandleQuery({ message_id: "live-root", message_type: "text", chat_id: "chat",
      sender_id: "owner", content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
    const query = app.database.getQueryByRootMessage("live-root");
    assert.equal(app.database.getPackage("live-pair").status, "active");
    const metadata = path.join(app.root, "images", "zip.info", "metadata.json");
    fs.writeFileSync(metadata, JSON.stringify({ id: "zip", ext: "zip", annotation: common.replace("状态: 启用", "状态: 已取代") }));
    app.replyTargets.set("live-confirm", query.prompt_message_id);
    await app.service.handleConfirmation({ message_id: "live-confirm", message_type: "text", chat_id: "chat", sender_id: "owner", content: "确认" });
    assert.equal(app.database.getPackage("live-pair").status, "archived");
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
    assert.ok(app.calls.some(call => call.text?.includes("已撤下")));
  } finally { app.close(); }
});

test("returns image-only backgrounds without creating a confirmation query", async () => {
  const app = fixture();
  try {
    const preview = path.join(app.root, "image-only-background.png");
    fs.writeFileSync(preview, "background");
    app.database.replaceCatalog(
      [{
        project_id: "project-1",
        project_name: "变速箱",
        normalized_name: "变速箱",
        aliases: ["变速箱包装"],
      }],
      [{
        package_id: "pkg-image-only",
        project_id: "project-1",
        package_name: "纯图片背景",
        package_type: "背景",
        tags: ["背景"],
        version: "v01",
        preview_eagle_id: "preview-image-only",
        source_eagle_id: null,
        preview_path: preview,
        source_path: null,
        ae_comp_name: "纯图片背景",
        dependency_status: "complete",
        status: "active",
      }]
    );

    const handled = await app.service.tryHandleQuery(
      {
        event_id: "event-image-only",
        message_id: "om_image_query",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "@X.bot 找变速箱背景",
      },
      { mentioned: true }
    );

    assert.equal(handled, true);
    const post = app.calls.find((call) => call.kind === "post");
    assert.ok(post);
    const postText = JSON.stringify(post.content);
    assert.match(postText, /仅图片背景/);
    assert.match(postText, /没有对应工程 ZIP/);
    assert.match(postText, /不进入源文件确认流程/);
    assert.equal(app.database.listActivePackages().length, 1);
    assert.equal(app.database.db.prepare("SELECT COUNT(*) AS count FROM queries").get().count, 0);
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
  } finally {
    app.close();
  }
});

test("ignores a bare confirmation without a reply reference", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-query-bare",
      message_id: "om_root_bare",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    app.replyTargets.set("om_bare_confirmation", "");
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_bare_confirmation",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "这个",
      }),
      false
    );

    const fileCalls = app.calls.filter((call) => call.kind === "file");
    assert.equal(fileCalls.length, 0);
    assert.equal(app.database.getQueryByRootMessage("om_root_bare").status, "pending");
  } finally {
    app.close();
  }
});

test("routes an explicit project query past expired pending confirmations", async () => {
  const app = fixture();
  try {
    const oldQueryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-old-query",
      message_id: "om_old_root",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(oldQueryEvent, { mentioned: true }), true);

    const oldQuery = app.database.getQueryByRootMessage("om_old_root");
    app.database.db
      .prepare("UPDATE queries SET expires_at = ? WHERE request_id = ?")
      .run(Date.now() - 1, oldQuery.request_id);

    const newQueryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-new-query",
      message_id: "om_new_root",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 给我变速箱的背景",
    };

    assert.equal(
      await app.service.tryHandleConfirmation(newQueryEvent, { mentioned: true }),
      false
    );
    assert.equal(
      app.calls.some((call) => call.kind === "text" && call.text.includes("超过 20 分钟")),
      false
    );
    assert.equal(await app.service.tryHandleQuery(newQueryEvent, { mentioned: true }), true);
    assert.equal(app.database.getQueryByRootMessage("om_new_root").status, "pending");
    assert.equal(app.calls.filter((call) => call.kind === "post").length, 2);
  } finally {
    app.close();
  }
});

test("ignores a bare confirmation from a non-requester without a reply reference", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-query-bare-other",
      message_id: "om_root_bare_other",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    app.replyTargets.set("om_bare_confirmation_other", "");
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_bare_confirmation_other",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_other",
        content: "这个",
      }),
      false
    );

    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
    assert.equal(app.database.getQueryByRootMessage("om_root_bare_other").status, "pending");
    assert.equal(app.calls.filter((call) => call.kind === "text").length, 0);
  } finally {
    app.close();
  }
});

test("triggers a query with a project name and only a domain word", async () => {
  const app = fixture();
  try {
    const result = await app.service.tryHandleQuery(
      {
        type: "im.message.receive_v1",
        event_id: "event-domain-only",
        message_id: "om_domain_only",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "@X.bot 变速箱小标注",
      },
      { mentioned: true }
    );
    assert.equal(result, true);
    assert.equal(app.calls.filter((call) => call.kind === "post").length, 1);
  } finally {
    app.close();
  }
});

test("triggers a query with natural wording like 我要", async () => {
  const app = fixture();
  try {
    const result = await app.service.tryHandleQuery(
      {
        type: "im.message.receive_v1",
        event_id: "event-natural",
        message_id: "om_natural",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "@X.bot 我要变速箱的信息条",
      },
      { mentioned: true }
    );
    assert.equal(result, true);
    assert.equal(app.calls.filter((call) => call.kind === "post").length, 1);
  } finally {
    app.close();
  }
});

test("lists available projects when a packaging request names an unknown project", async () => {
  const app = fixture();
  try {
    const result = await app.service.tryHandleQuery(
      {
        type: "im.message.receive_v1",
        event_id: "event-unknown-project",
        message_id: "om_unknown_project",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "@X.bot 给我openai的包装",
      },
      { mentioned: true }
    );

    assert.equal(result, true);
    const replies = app.calls.filter((call) => call.kind === "text");
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /项目暂时不在我这边的包装库里/);
    assert.match(replies[0].text, /现在能直接查到的是：变速箱/);
    assert.match(replies[0].text, /@X\.bot 看看变速箱的包装/);
    assert.equal(app.calls.filter((call) => call.kind === "post").length, 0);
    assert.equal(app.database.getQueryByRootMessage("om_unknown_project") ?? null, null);
  } finally {
    app.close();
  }
});

test("answers a project catalog question when it replies to the missing-project prompt", async () => {
  const app = fixture();
  try {
    assert.equal(
      await app.service.tryHandleQuery(
        {
          type: "im.message.receive_v1",
          event_id: "event-catalog-seed",
          message_id: "om_catalog_seed",
          message_type: "text",
          chat_id: "oc_chat",
          sender_id: "ou_requester",
          content: "@X.bot 给我openai的包装",
        },
        { mentioned: true }
      ),
      true
    );

    const missingProjectReply = app.calls.find((call) => call.kind === "text");
    assert.ok(missingProjectReply);
    app.replyTargets.set("om_catalog_followup", missingProjectReply.message_id);

    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_catalog_followup",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "你有哪些项目",
      }),
      true
    );

    const replies = app.calls.filter((call) => call.kind === "text");
    assert.equal(replies.length, 2);
    assert.match(replies[1].text, /有，目前我这边能直接查到：变速箱/);
    assert.match(replies[1].text, /挑一个项目名发我就行/);
  } finally {
    app.close();
  }
});

test("accepts rich-text post replies when they reference a candidate message", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      event_id: "evt-post-query",
      message_id: "om_post_query",
      message_type: "post",
      sender_id: "ou_user",
      chat_id: "oc_chat",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);
    const previewMessageId = app.calls.find((item) => item.kind === "post").message_id;
    app.replyTargets.set("om_post_confirm", previewMessageId);

    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_post_confirm",
        message_type: "post",
        sender_id: "ou_user",
        chat_id: "oc_chat",
        content: "确认",
      }),
      true
    );
  } finally {
    app.close();
  }
});

test("does not hijack ordinary conversation that only mentions a domain word", async () => {
  const app = fixture();
  try {
    const result = await app.service.tryHandleQuery(
      {
        type: "im.message.receive_v1",
        event_id: "event-ordinary",
        message_id: "om_ordinary",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "今天的背景资料整理好了",
      },
      { mentioned: true }
    );
    assert.equal(result, false);
  } finally {
    app.close();
  }
});

test("triggers a query from an AI hint when no rule keywords match", async () => {
  const app = fixture();
  try {
    const result = await app.service.tryHandleQuery(
      {
        type: "im.message.receive_v1",
        event_id: "event-ai-hint",
        message_id: "om_ai_hint",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "@X.bot 我想要那种氛围感的东西",
      },
      {
        mentioned: true,
        aiHint: { project_name: "变速箱", package_type: "信息条" },
      }
    );
    assert.equal(result, true);
    assert.equal(app.calls.filter((call) => call.kind === "post").length, 1);
  } finally {
    app.close();
  }
});

test("continues from a preview reply and switches to another package type", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-followup",
      message_id: "om_root_followup",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const candidatePost = app.calls.find((call) => call.kind === "post");
    assert.ok(candidatePost);
    app.replyTargets.set("om_followup", candidatePost.message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_followup",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "看看背景",
      }),
      true
    );

    const posts = app.calls.filter((call) => call.kind === "post");
    assert.equal(posts.length, 2);
    assert.ok(JSON.stringify(posts[1].content).includes("黑色纹理背景"));
    assert.equal(app.database.getQueryByRootMessage("om_root_followup").status, "pending");
  } finally {
    app.close();
  }
});

test("ignores a bare follow-up without a reply reference", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-followup-bare",
      message_id: "om_root_followup_bare",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    app.replyTargets.set("om_followup_bare", "");
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_followup_bare",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "看看背景",
      }),
      false
    );

    const posts = app.calls.filter((call) => call.kind === "post");
    assert.equal(posts.length, 1);
  } finally {
    app.close();
  }
});

test("merges multiple previews into one post message and keeps number selection", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-merged",
      message_id: "om_root_merged",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的包装",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const postCalls = app.calls.filter((call) => call.kind === "post");
    const imageCalls = app.calls.filter((call) => call.kind === "image");
    const uploadCalls = app.calls.filter((call) => call.kind === "upload");
    const promptCalls = app.calls.filter(
      (call) => call.kind === "text" && call.text.includes("找到 2 个候选")
    );
    assert.equal(postCalls.length, 1);
    assert.equal(imageCalls.length, 0);
    assert.equal(uploadCalls.length, 2);
    assert.equal(promptCalls.length, 0);
    assert.ok(JSON.stringify(postCalls[0].content).includes("找到 2 个候选"));
    assert.ok(JSON.stringify(postCalls[0].content).includes("第二个"));

    const imageElements = postCalls[0].content.zh_cn.content.filter(
      (row) => row.length === 1 && row[0].tag === "img"
    );
    assert.equal(imageElements.length, 2);
    assert.equal(
      postCalls[0].content.zh_cn.content.some(
        (row) => row[0]?.tag === "text" && row[0].text.includes("预览按上面的顺序")
      ),
      false
    );

    const query = app.database.findQueryByReplyMessage("oc_chat", postCalls[0].message_id);
    assert.ok(query);
    assert.equal(query.candidates.length, 2);
    assert.equal(query.replied_position, null);
    assert.equal(query.candidates[0].preview_message_id, null);
    assert.equal(query.candidates[1].preview_message_id, null);
    const queryByPrompt = app.database.findQueryByReplyMessage(
      "oc_chat",
      postCalls[0].message_id
    );
    assert.ok(queryByPrompt);
    assert.equal(queryByPrompt.replied_position, null);

    app.replyTargets.set("om_merged_this_post", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_merged_this_post",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "这个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
    assert.ok(
      app.calls.some((call) => call.kind === "text" && call.text.includes("多个候选"))
    );

    app.replyTargets.set("om_merged_select", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_merged_select",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "第二个",
      }),
      true
    );
    const fileCalls = app.calls.filter((call) => call.kind === "file");
    assert.equal(fileCalls.length, 1);
  } finally {
    app.close();
  }
});

test("candidate prompt labels only show project, name, and version", () => {
  const prompt = queryPrompt(
    [
      {
        project_name: "变速箱",
        package_name: "背景",
        package_type: "背景",
        version: "v01",
      },
      {
        project_name: "变速箱",
        package_name: "小标注",
        package_type: "信息条",
        version: "v01",
      },
    ],
    20
  );
  assert.ok(prompt.includes("1. 变速箱 · 背景（v01）"));
  assert.ok(!prompt.includes("背景（背景"));
  assert.ok(prompt.includes("2. 变速箱 · 小标注（v01）"));
  assert.ok(!prompt.includes("信息条 · v01"));
});

test("sends a different source for each candidate of the same query", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-multi-deliver",
      message_id: "om_root_multi",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的包装",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const postCalls = app.calls.filter((call) => call.kind === "post");
    assert.equal(postCalls.length, 1);
    app.replyTargets.set("om_multi_first", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_multi_first",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "第一个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 1);

    app.replyTargets.set("om_multi_second", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_multi_second",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "第二个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 2);

    app.replyTargets.set("om_multi_first_again", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_multi_first_again",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "第一个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 2);
    assert.ok(
      app.calls.some((call) => call.kind === "text" && call.text.includes("已经发过"))
    );
    assert.equal(app.database.getQueryByRootMessage("om_root_multi").status, "pending");
  } finally {
    app.close();
  }
});

test("blocks candidates of a completed legacy query", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-legacy-completed",
      message_id: "om_root_legacy",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的包装",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const latest = app.database.getQueryByRootMessage("om_root_legacy");
    assert.ok(latest);
    app.database.db
      .prepare("UPDATE queries SET status = 'completed' WHERE request_id = ?")
      .run(latest.request_id);

    const postCalls = app.calls.filter((call) => call.kind === "post");
    app.replyTargets.set("om_legacy_select", postCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_legacy_select",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "第二个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
    assert.ok(
      app.calls.some((call) => call.kind === "text" && call.text.includes("已经完成"))
    );
  } finally {
    app.close();
  }
});

test("uploads oversized source files to Drive and replies with a link", async () => {
  const app = fixture({ driveUploadThresholdBytes: 1 });
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-drive",
      message_id: "om_root_drive",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const candidatePost = app.calls.find((call) => call.kind === "post");
    app.replyTargets.set("om_drive_confirm", candidatePost.message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_drive_confirm",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "这个",
      }),
      true
    );

    const driveCalls = app.calls.filter((call) => call.kind === "drive");
    assert.equal(driveCalls.length, 1);
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
    assert.ok(
      app.calls.some(
        (call) =>
          call.kind === "text" &&
          call.text.includes("云盘") &&
          call.text.includes(driveCalls[0].url) &&
          call.messageId === queryEvent.message_id
      )
    );
    const delivery = app.database.db
      .prepare("SELECT status, source_message_id FROM deliveries WHERE request_id = ?")
      .all(app.database.getQueryByRootMessage("om_root_drive").request_id);
    assert.equal(delivery.length, 1);
    assert.equal(delivery[0].status, "completed");
    assert.equal(delivery[0].source_message_id, `drive:${driveCalls[0].token}`);
  } finally {
    app.close();
  }
});

test("keeps previous query confirmable after a follow-up", async () => {
  const app = fixture();
  try {
    const queryEvent = {
      type: "im.message.receive_v1",
      event_id: "event-keep-prev",
      message_id: "om_root_keep",
      message_type: "text",
      chat_id: "oc_chat",
      sender_id: "ou_requester",
      content: "@X.bot 找变速箱项目的信息条",
    };
    assert.equal(await app.service.tryHandleQuery(queryEvent, { mentioned: true }), true);

    const firstPost = app.calls.find((call) => call.kind === "post");
    assert.ok(firstPost);
    app.replyTargets.set("om_followup_keep", firstPost.message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_followup_keep",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "看看背景",
      }),
      true
    );

    const oldQuery = app.database.getQueryByRootMessage("om_root_keep");
    assert.equal(oldQuery.status, "pending");

    app.replyTargets.set("om_old_preview", firstPost.message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_old_preview",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "这个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 1);
  } finally {
    app.close();
  }
});

test("Drive deliveries use candidate keys, original thread and no duplicate upload", async () => {
  const app = fixture({driveUploadThresholdBytes: 1});
  try {
    await app.service.tryHandleQuery({message_id:"drive-multi", message_type:"text", chat_id:"oc_chat",
      sender_id:"ou_requester", content:"@X.bot 找变速箱的包装"}, {mentioned:true});
    const prompt = app.calls.find(c => c.kind === "post").message_id;
    for (const [id, content] of [["d1","第一个"],["d2","第二个"],["d3","第一个"]]) {
      app.replyTargets.set(id, prompt);
      await app.service.tryHandleConfirmation({message_id:id, message_type:"text", chat_id:"oc_chat",
        sender_id:"ou_requester", content});
    }
    const links = app.calls.filter(c => c.kind === "text" && c.text.includes("传到云盘"));
    assert.equal(app.calls.filter(c => c.kind === "drive").length, 2);
    assert.equal(links.length, 2);
    assert.ok(links.every(c => c.messageId === "drive-multi"));
    assert.equal(new Set(links.map(c => c.key)).size, 2);
  } finally { app.close(); }
});

test("restart retries pre-dispatch work and holds uncertain dispatch for reconciliation", async () => {
  const app = fixture({driveUploadThresholdBytes: 1});
  try {
    await app.service.tryHandleQuery({message_id:"restart-root", message_type:"text", chat_id:"oc_chat",
      sender_id:"ou_requester", content:"@X.bot 找变速箱的包装"}, {mentioned:true});
    const query = app.database.getQueryWithCandidates(app.database.getQueryByRootMessage("restart-root").request_id);
    const [first, second] = query.candidates;
    const key = id => `package-delivery-${query.request_id}-${id}`;
    app.database.claimDelivery(query.request_id, first.package_id, key(first.package_id));
    app.database.markDeliveryUploaded(query.request_id, first.package_id, {url:"https://example.test/saved",token:"saved"});
    app.database.claimDelivery(query.request_id, second.package_id, key(second.package_id));
    app.database.markDeliveryDispatching(query.request_id, second.package_id);
    const event = {message_id:"restart-confirm", message_type:"text", chat_id:"oc_chat", sender_id:"ou_requester"};
    app.replyTargets.set(event.message_id, app.calls.find(c => c.kind === "post").message_id);
    app.database.close();
    app.database.db = new PackageDatabase(path.join(app.root, "packaging.sqlite")).db;
    assert.equal(app.database.recoverInterruptedWork().deliveries, 2);
    await app.service.tryHandleConfirmation({...event, content:"第一个"});
    assert.equal(app.calls.filter(c => c.kind === "drive").length, 0, "reuse saved upload");
    await app.service.tryHandleConfirmation({...event, content:"第二个"});
    assert.ok(app.calls.some(c => c.text?.includes("结果尚未确认")));
    assert.equal(app.calls.filter(c => c.text?.includes("传到云盘")).length, 1);
    app.database.reconcileDelivery(query.request_id, second.package_id, null);
    await app.service.tryHandleConfirmation({...event, content:"第二个"});
    assert.equal(app.calls.filter(c => c.kind === "drive").length, 1);
  } finally { app.close(); }
});


test("repair/negated requests do not start packaging queries and missing AI projects ask first", async () => {
  const app = fixture();
  try {
    for (const content of ["帮我修理变速箱", "不要找变速箱的包装"]) {
      assert.equal(await app.service.tryHandleQuery({ content, message_id: content }, { mentioned: true }), false);
    }
    for (const project_name of ["", "虚构项目"]) {
      assert.equal(await app.service.tryHandleQuery({ content: "给我那种氛围感的东西", message_id: `missing-${project_name}` },
        { mentioned: true, aiHint: { project_name, package_type: "背景" } }), true);
    }
    assert.equal(app.calls.filter(call => call.kind === "post").length, 0);
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
    assert.equal(app.calls.filter(call => call.kind === "text").length, 2);
  } finally { app.close(); }
});

test("negated candidate selection never sends source or cancels the pending query", async () => {
  const app = fixture();
  try {
    const event = { message_id: "neg-root", content: "找变速箱信息条", chat_id: "oc_chat", sender_id: "requester", message_type: "text" };
    await app.service.tryHandleQuery(event, { mentioned: true });
    const post = app.calls.find(call => call.kind === "post");
    app.replyTargets.set("neg-reply", post.message_id);
    assert.equal(await app.service.tryHandleConfirmation({ ...event, message_id: "neg-reply", content: "不要第一个" }), true);
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
    assert.equal(app.database.getQueryByRootMessage("neg-root").status, "pending");
  } finally { app.close(); }
});


test("validated semantic type wins over a negated type mentioned in the request", async () => {
  const app = fixture();
  try {
    const event = { message_id: "semantic-type", content: "不要变速箱的信息条，我要背景", chat_id: "oc_chat", sender_id: "requester", message_type: "text" };
    assert.equal(await app.service.tryHandleQuery(event, { mentioned: true }), false);
    assert.equal(await app.service.tryHandleQuery(event, { mentioned: true, aiHint: { project_name: "变速箱", package_type: "背景" } }), true);
    assert.equal(app.database.findQueryByReplyMessage(event.chat_id, app.calls.find(call => call.kind === "post").message_id).candidates[0].package_type, "背景");
  } finally { app.close(); }
});


test("replying 看看其他的 pages unseen packages durably, keeps old choices and ends without repeating", async () => {
  const app = fixture();
  try {
    const base = app.database.listActivePackages();
    app.database.replaceCatalog([{ project_id: "project-1", project_name: "变速箱", normalized_name: "变速箱", aliases: [] }],
      Array.from({ length: 7 }, (_, i) => ({ ...base[0], package_id: `page-${i}`, package_name: `包装${i}`,
        preview_eagle_id: `page-preview-${i}`, source_eagle_id: `page-source-${i}`, eagle_modified_at: i })));
    const root = { message_id: "browse-root", content: "找变速箱包装", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    let post = app.calls.find(call => call.kind === "post");
    const seen = new Set();
    for (let page = 0; page < 3; page++) {
      const query = app.database.findQueryByReplyMessage("chat", post.message_id);
      for (const item of query.candidates) { assert.equal(seen.has(item.package_id), false); seen.add(item.package_id); }
      const replyId = `browse-next-${page}`;
      app.replyTargets.set(replyId, post.message_id);
      assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: replyId, content: "看看其他的" }), true);
      post = app.calls.filter(call => call.kind === "post").at(-1);
    }
    assert.equal(seen.size, 7);
    assert.equal(app.calls.filter(call => call.kind === "post").length, 3);
    assert.match(app.calls.filter(call => call.kind === "text").at(-1).text, /没有更多未展示/);
    assert.equal(app.database.getQueryByRootMessage(root.message_id).status, "pending");
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
  } finally { app.close(); }
});

test("browsing follows an explicit clarification reply chain but source confirmation never does", async () => {
  const app = fixture();
  try {
    const root = { message_id: "chain-root", content: "找变速箱包装", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const post = app.calls.find(call => call.kind === "post");
    app.replyTargets.set("first-more", post.message_id);
    app.replyTargets.set("bot-clarification", "first-more");
    app.replyTargets.set("second-more", "bot-clarification");
    assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: "second-more", content: "变速箱其他的包装" }), true);
    assert.match(app.calls.filter(call => call.kind === "text").at(-1).text, /没有更多未展示/);
    app.replyTargets.set("indirect-confirm", "bot-clarification");
    assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: "indirect-confirm", content: "确认" }), false);
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
    assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: "no-reference", content: "看看其他的" }), false);
  } finally { app.close(); }
});

test("more-results replies preserve requester and expiry gates", async () => {
  const app = fixture();
  try {
    const root = { message_id: "guard-root", content: "找变速箱包装", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const post = app.calls.find(call => call.kind === "post");
    app.replyTargets.set("other-more", post.message_id);
    assert.equal(await app.service.tryHandleConfirmation({ ...root, sender_id: "other", message_id: "other-more", content: "看看其他的" }), true);
    assert.match(app.calls.filter(call => call.kind === "text").at(-1).text, /原查询人/);
    app.database.db.prepare('UPDATE queries SET expires_at=0 WHERE root_message_id=?').run(root.message_id);
    app.replyTargets.set("expired-more", post.message_id);
    assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: "expired-more", content: "看看其他的" }), true);
    assert.match(app.calls.filter(call => call.kind === "text").at(-1).text, /超过/);
    assert.equal(app.calls.filter(call => call.kind === "post").length, 1);
  } finally { app.close(); }
});


test("semantic follow-up receives scoped metadata, routes indirect natural type requests, and bypasses confirmations", async () => {
  let requests = 0;
  const app = fixture({ judgeFollowUp: async (text, query, packages) => {
    requests++;
    assert.equal(text, "我想要放人物名字的");
    assert.equal(query.candidates[0].project_name, "变速箱");
    assert.ok(packages.every(item => item.project_id === "project-1"));
    return { action: "refine", confidence: 0.95, package_type: "信息条", package_ids: [] };
  }});
  try {
    const root = { message_id: "semantic-root", content: "找变速箱背景", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const first = app.calls.find(call => call.kind === "post");
    app.replyTargets.set("bridge", first.message_id);
    app.replyTargets.set("natural-reply", "bridge");
    assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: "natural-reply", content: "我想要放人物名字的" }), true);
    const latest = app.calls.filter(call => call.kind === "post").at(-1);
    assert.equal(app.database.findQueryByReplyMessage("chat", latest.message_id).search_type, "信息条");
    app.replyTargets.set("explicit-confirm", latest.message_id);
    await app.service.tryHandleConfirmation({ ...root, message_id: "explicit-confirm", content: "第一个" });
    assert.equal(requests, 1);
    assert.equal(app.calls.filter(call => call.kind === "file").length, 1);
    await app.service.tryHandleConfirmation({ ...root, message_id: "unquoted", content: "我想要放人物名字的" });
    assert.equal(requests, 1);
  } finally { app.close(); }
});

test("semantic version/explanation/failure keep delivery safe and do not fall into generic chat", async () => {
  let decision = null;
  const app = fixture({ judgeFollowUp: async () => decision });
  try {
    const root = { message_id: "question-root", content: "找变速箱背景", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const post = app.calls.find(call => call.kind === "post");
    for (const [id, content, result] of [
      ["use", "这个怎么用", { action: "explain", reply: "解压ZIP后打开AEP，再检查依赖。" }],
      ["version", "第一个有没有新版", { action: "version", candidate_position: 1 }],
      ["failed", "有轻盈一点的吗", null],
      ["invalid", "简洁一点", { action: "refine", package_ids: ["invented"] }],
    ]) {
      decision = result; app.replyTargets.set(id, post.message_id);
      assert.equal(await app.service.tryHandleConfirmation({ ...root, message_id: id, content }), true);
    }
    assert.equal(app.calls.filter(call => call.kind === "file").length, 0);
    assert.equal(app.calls.filter(call => call.kind === "post").length, 1);
    assert.equal(app.calls.filter(call => call.kind === "text").length, 4);
    assert.equal(app.database.getQueryByRootMessage(root.message_id).status, "pending");
  } finally { app.close(); }
});

test("semantic style candidate pool is persisted and reused when browsing more", async () => {
  const app = fixture({ judgeFollowUp: async () => ({ action: "refine", package_ids: ["pkg-1"], package_type: "信息条" }) });
  try {
    const root = { message_id: "style-root", content: "找变速箱背景", sender_id: "owner", chat_id: "chat", message_type: "text" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    app.replyTargets.set("style-refine", app.calls.find(call => call.kind === "post").message_id);
    await app.service.tryHandleConfirmation({ ...root, message_id: "style-refine", content: "简洁一点" });
    const stylePost = app.calls.filter(call => call.kind === "post").at(-1);
    const query = app.database.findQueryByReplyMessage("chat", stylePost.message_id);
    assert.deepEqual(JSON.parse(query.followup_filters_json).allowedIds, ["pkg-1"]);
    app.replyTargets.set("style-more", stylePost.message_id);
    await app.service.tryHandleConfirmation({ ...root, message_id: "style-more", content: "看看其他的" });
    assert.equal(app.calls.filter(call => call.kind === "post").length, 2);
    assert.match(app.calls.filter(call => call.kind === "text").at(-1).text, /没有更多/);
  } finally { app.close(); }
});


test("interactive card binds callbacks to the card, requester and snapshot; preserves text replies", async () => {
  const app = fixture();
  app.service.transport.replyCard = app.service.transport.replyPost;
  try {
    const root = { message_id: "om_card_root", chat_id: "oc_chat", sender_id: "ou_requester", content: "@X.bot 找变速箱的信息条" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const card = app.calls.find(c => c.kind === "post");
    assert.equal(card.content.schema, "2.0");
    const value = card.content.body.elements[0].columns[0].elements.find(e => e.tag === "button").behaviors[0].value;
    const click = { type: "card.action.trigger", event_id: "click-1", action_tag: "button", action_value: JSON.stringify(value), message_id: card.message_id, chat_id: root.chat_id, operator_id: "ou_other" };
    await app.service.tryHandleCardAction(click);
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    assert.equal(await app.service.tryHandleCardAction({ ...click, operator_id: root.sender_id, action_value: JSON.stringify({ ...value, request_id: "forged" }) }), false);
    assert.equal(await app.service.tryHandleCardAction({ ...click, operator_id: root.sender_id, chat_id: "oc_other" }), false);
    assert.equal(await app.service.tryHandleCardAction({ ...click, operator_id: root.sender_id, action_value: JSON.stringify({ ...value, position: 99 }) }), false);
    assert.equal(await app.service.tryHandleCardAction({ ...click, action_value: "invalid-json" }), false);
    await app.service.tryHandleCardAction({ ...click, operator_id: root.sender_id });
    await app.service.tryHandleCardAction({ ...click, event_id: "click-2", operator_id: root.sender_id });
    const files = app.calls.filter(c => c.kind === "file");
    assert.equal(files.length, 1);
    assert.equal(files[0].messageId, root.message_id);
    // A new card still accepts a direct text reply.
    await app.service.tryHandleQuery({ ...root, message_id: "om_card_text_root" }, { mentioned: true });
    const next = app.calls.filter(c => c.kind === "post").at(-1);
    app.replyTargets.set("om_text", next.message_id);
    await app.service.tryHandleConfirmation({ ...root, message_id: "om_text", message_type: "text", content: "这个" });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 2);
  } finally { app.close(); }
});

test("card more, cancel and expired callbacks retain query gates", async () => {
  const app = fixture();
  app.service.transport.replyCard = app.service.transport.replyPost;
  try {
    const root = { message_id: "om_card_root", chat_id: "oc_chat", sender_id: "ou_requester", content: "@X.bot 找变速箱的信息条" };
    await app.service.tryHandleQuery(root, { mentioned: true });
    const card = app.calls.find(c => c.kind === "post");
    const actions = card.content.body.elements.at(-1).columns[0].elements.find(e => e.tag === "column_set").columns.map(c => c.elements[0]);
    const click = value => ({ type: "card.action.trigger", event_id: `click-${value.action}`, action_tag: "button", action_value: JSON.stringify(value), message_id: card.message_id, chat_id: root.chat_id, operator_id: root.sender_id });
    const more = actions[0].behaviors[0].value;
    await app.service.tryHandleCardAction(click(more));
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    const cancel = actions[1].behaviors[0].value;
    await app.service.tryHandleCardAction(click(cancel));
    assert.equal(app.database.getQueryWithCandidates(cancel.request_id).status, "cancelled");
    await app.service.tryHandleCardAction(click({ ...cancel, action: "select", position: 1 }));
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    await app.service.tryHandleQuery({ ...root, message_id: "om_expire" }, { mentioned: true });
    const last = app.calls.filter(c => c.kind === "post").at(-1);
    const value = last.content.body.elements[0].columns[0].elements.find(e => e.tag === "button").behaviors[0].value;
    app.database.db.prepare("UPDATE queries SET expires_at = 0 WHERE request_id = ?").run(value.request_id);
    await app.service.tryHandleCardAction({ ...click(value), message_id: last.message_id });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
  } finally { app.close(); }
});


function cardFlowFixture() {
  const app = fixture();
  app.service.transport.replyCard = app.service.transport.replyPost;
  app.service.transport.updateCard = async (messageId, content) => { app.calls.push({ kind: "update", messageId, content }); return {}; };
  app.service.cardFlow = new (require("../bot/lib/packaging-card-flow").PackagingCardFlow)(app.service);
  app.rootEvent = { message_id: "om_session_root", chat_id: "oc_session", sender_id: "ou_owner", content: "@X.bot 找包装", message_type: "text" };
  app.current = () => app.service.cardFlow.read("root_message_id", app.rootEvent.message_id);
  app.click = async (action, extra = {}, overrides = {}) => {
    const session = app.current();
    return app.service.tryHandleCardAction({ type: "card.action.trigger", event_id: `click-${Math.random()}`,
      action_tag: ["project", "type"].includes(action) ? "select_static" : "button", operator_id: "ou_owner", chat_id: "oc_session",
      message_id: session.card_message_id, action_value: JSON.stringify({ scope: "packaging-session", session_id: session.session_id, revision: session.revision, action, ...extra }), ...overrides });
  };
  return app;
}

test("card session selects project/type, pages in place, restores history and delivers once to the real root", async () => {
  const app = cardFlowFixture();
  try {
    const packages = app.database.listActivePackages();
    const base = packages.find(p => p.package_type === "信息条");
    const clones = [2,3,4,5].map(i => ({ ...base, package_id: `extra-${i}`, package_name: `小标${i}`, preview_eagle_id: `preview-${i}`, source_eagle_id: `source-${i}` }));
    app.database.replaceCatalog([{ project_id: "project-1", project_name: "变速箱", normalized_name: "变速箱", aliases: [] }], [...packages, ...clones]);
    await app.service.tryHandleQuery(app.rootEvent, { mentioned: true });
    assert.equal(app.current().stage, "results");
    await app.click("project", {}, { option: "project-1", operator_id: "ou_intruder" });
    assert.equal(app.current().stage, "results");
    await app.click("project", {}, { option: "invalid" });
    assert.equal(app.current().stage, "results");
    await app.click("project", {}, { option: "project-1" });
    assert.equal(app.current().stage, "type");
    await app.click("type", {}, { option: "信息条" });
    const first = app.current().pages[0];
    assert.equal(first.items.length, 3);
    const oldRevision = app.current().revision;
    await app.click("next");
    assert.equal(app.current().page, 1);
    assert.equal(app.current().pages[1].items.length, 2);
    assert.equal(app.calls.filter(c => c.kind === "post").length, 1);
    // An old rendered-page callback must not deliver the currently visible item.
    await app.click("select", { revision: oldRevision, request_id: first.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    app.service.cardFlow = new (require("../bot/lib/packaging-card-flow").PackagingCardFlow)(app.service);
    await app.click("previous");
    assert.equal(app.current().pages[0].request_id, first.request_id);
    await Promise.all([app.click("select", { request_id: first.request_id, position: 1 }), app.click("select", { request_id: first.request_id, position: 1 })]);
    assert.equal(app.calls.filter(c => c.kind === "file").length, 1);
    assert.equal(app.calls.find(c => c.kind === "file").messageId, "om_session_root");
    assert.ok(JSON.stringify(app.calls.filter(c => c.kind === "update").at(-1)).includes("已发送"));
    await app.click("select", { request_id: first.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 1);
    await app.click("types");
    await app.click("type", {}, { option: "信息条" });
    await app.click("select", { request_id: app.current().pages[0].request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 1);
    await app.click("cancel");
    assert.equal(app.current().status, "cancelled");
    assert.equal(app.database.db.prepare("SELECT COUNT(*) n FROM queries WHERE source_root_message_id=? AND status='pending'").get("om_session_root").n, 0);
  } finally { app.close(); }
});

test("card sessions support text selection, image-only pages, expiry and uncertain delivery without retry", async () => {
  const app = cardFlowFixture();
  try {
    await app.service.tryHandleQuery({ ...app.rootEvent, content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
    const first = app.current().pages[0];
    const item = first.items[0];
    app.database.claimDelivery(first.request_id, item.package_id, "uncertain-card");
    app.database.markDeliveryDispatching(first.request_id, item.package_id);
    app.database.markDeliveryFailed(first.request_id, item.package_id, "lost connection");
    await app.click("select", { request_id: first.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    assert.ok(JSON.stringify(app.calls.filter(c => c.kind === "update").at(-1)).includes("结果待核对"));
    app.database.db.prepare("UPDATE card_sessions SET expires_at=0 WHERE session_id=?").run(app.current().session_id);
    await app.service.cardFlow.expire();
    assert.equal(app.current().status, "expired");
    assert.ok(JSON.stringify(app.calls.filter(c => c.kind === "update").at(-1)).includes("查询已过期"));
  } finally { app.close(); }
  const text = cardFlowFixture();
  try {
    await text.service.tryHandleQuery({ ...text.rootEvent, content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
    text.replyTargets.set("om_text_session", text.current().card_message_id);
    await text.service.tryHandleConfirmation({ ...text.rootEvent, message_id: "om_text_session", content: "这个" });
    assert.equal(text.calls.filter(c => c.kind === "file").length, 1);
    assert.equal(text.calls.filter(c => c.kind === "post").length, 1);
  } finally { text.close(); }
});


test("image-only card sessions show previews without source controls or deliveries", async () => {
  const app = cardFlowFixture();
  try {
    app.database.db.prepare("UPDATE packages SET source_path=NULL, source_eagle_id=NULL WHERE package_type='背景'").run();
    await app.service.tryHandleQuery({ ...app.rootEvent, content: "@X.bot 找变速箱背景" }, { mentioned: true });
    const card = app.calls.filter(c => c.kind === "post").at(-1).content;
    assert.equal(app.database.db.prepare("SELECT COUNT(*) n FROM queries").get().n, 0);
    assert.ok(JSON.stringify(card).includes("无工程 ZIP"));
    assert.ok(!JSON.stringify(card).includes('"action":"select"'));
    const page = app.current().pages[0];
    await app.click("select", { request_id: page.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
  } finally { app.close(); }
});


test("card update failure and replaced sources never dispatch, Drive still uses the original root", async () => {
  const app = cardFlowFixture();
  try {
    await app.service.tryHandleQuery({ ...app.rootEvent, content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
    const page = app.current().pages[0];
    const originalUpdate = app.service.transport.updateCard;
    app.service.transport.updateCard = async () => { throw new Error("card update offline"); };
    const oldRevision = app.current().revision;
    await assert.rejects(app.click("select", { request_id: page.request_id, position: 1 }), /offline/);
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    app.service.transport.updateCard = originalUpdate;
    await app.click("select", { revision: oldRevision, request_id: page.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    assert.equal(app.current().syncPending, undefined);
    assert.equal(app.current().sending, undefined);
    fs.writeFileSync(page.items[0].source_path, "changed-zip");
    await app.click("select", { request_id: page.request_id, position: 1 });
    assert.equal(app.calls.filter(c => c.kind === "file").length, 0);
    assert.match(app.current().notice, /变化|撤下|未完成/);
  } finally { app.close(); }
  const drive = cardFlowFixture();
  try {
    drive.service.driveUploadThresholdBytes = 1;
    await drive.service.tryHandleQuery({ ...drive.rootEvent, content: "@X.bot 找变速箱的信息条" }, { mentioned: true });
    const page = drive.current().pages[0];
    await drive.click("select", { request_id: page.request_id, position: 1 });
    const link = drive.calls.find(c => c.kind === "text" && c.text.includes("https://example.feishu.cn/file/"));
    assert.equal(link.messageId, "om_session_root");
    assert.equal(drive.calls.filter(c => c.kind === "drive").length, 1);
  } finally { drive.close(); }
});


test("the first reply already includes previews with or without a named project/type", async () => {
  for (const content of ["@X.bot 找包装", "@X.bot 找变速箱包装", "@X.bot 找变速箱信息条"]) {
    const app = cardFlowFixture();
    try {
      await app.service.tryHandleQuery({ ...app.rootEvent, content }, { mentioned: true });
      const first = app.calls.find(c => c.kind === "post");
      assert.equal(app.current().stage, "results");
      assert.ok(JSON.stringify(first.content).includes('"tag":"img"'));
      assert.equal(app.calls.filter(c => c.kind === "update").length, 0);
      assert.ok(app.current().pages[0].items.length <= 3);
    } finally { app.close(); }
  }
});
