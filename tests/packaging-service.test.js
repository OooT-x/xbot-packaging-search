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

    const imageCall = app.calls.find((call) => call.kind === "image");
    assert.ok(imageCall);
    app.replyTargets.set("om_other_confirmation", imageCall.message_id);
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

    app.replyTargets.set("om_confirmation", imageCall.message_id);
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

test("accepts a bare confirmation by falling back to the latest pending query", async () => {
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
      true
    );

    const fileCalls = app.calls.filter((call) => call.kind === "file");
    assert.equal(fileCalls.length, 1);
    assert.equal(fileCalls[0].messageId, "om_root_bare");
    assert.equal(app.database.getQueryByRootMessage("om_root_bare").status, "pending");
  } finally {
    app.close();
  }
});

test("rejects a bare confirmation from a non-requester", async () => {
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
      true
    );

    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);
    assert.equal(app.database.getQueryByRootMessage("om_root_bare_other").status, "pending");
    assert.ok(
      app.calls.some(
        (call) => call.kind === "text" && call.text.includes("原查询人")
      )
    );
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
    assert.equal(app.calls.filter((call) => call.kind === "image").length, 1);
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
    assert.equal(app.calls.filter((call) => call.kind === "image").length, 1);
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
    assert.equal(app.calls.filter((call) => call.kind === "image").length, 1);
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

    const imageCall = app.calls.find((call) => call.kind === "image");
    assert.ok(imageCall);
    app.replyTargets.set("om_followup", imageCall.message_id);
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

    const images = app.calls.filter((call) => call.kind === "image");
    assert.equal(images.length, 2);
    assert.ok(
      app.calls.some(
        (call) => call.kind === "text" && call.text.includes("黑色纹理背景")
      )
    );
    assert.equal(app.database.getQueryByRootMessage("om_root_followup").status, "pending");
    assert.ok(app.database.findLatestPendingQuery("oc_chat"));
  } finally {
    app.close();
  }
});

test("continues from a bare follow-up message using the latest pending query", async () => {
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
      true
    );

    const images = app.calls.filter((call) => call.kind === "image");
    assert.equal(images.length, 2);
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
    assert.equal(promptCalls.length, 1);

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
    assert.equal(query.candidates[0].preview_message_id, postCalls[0].message_id);
    assert.equal(query.candidates[1].preview_message_id, null);
    const queryByPrompt = app.database.findQueryByReplyMessage(
      "oc_chat",
      promptCalls[0].message_id
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

    app.replyTargets.set("om_merged_this_prompt", promptCalls[0].message_id);
    assert.equal(
      await app.service.tryHandleConfirmation({
        message_id: "om_merged_this_prompt",
        message_type: "text",
        chat_id: "oc_chat",
        sender_id: "ou_requester",
        content: "这个",
      }),
      true
    );
    assert.equal(app.calls.filter((call) => call.kind === "file").length, 0);

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

    const latest = app.database.findLatestPendingQuery("oc_chat");
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

    const imageCall = app.calls.find((call) => call.kind === "image");
    app.replyTargets.set("om_drive_confirm", imageCall.message_id);
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
          call.text.includes(driveCalls[0].url)
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

    const firstImage = app.calls.find((call) => call.kind === "image");
    assert.ok(firstImage);
    app.replyTargets.set("om_followup_keep", firstImage.message_id);
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

    app.replyTargets.set("om_old_preview", firstImage.message_id);
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
