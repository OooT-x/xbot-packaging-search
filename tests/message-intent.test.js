const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMessageIntent, intentReplyInstruction } = require("../bot/lib/message-intent");
const { _test } = require("../bot/lark-bot-listener");

const catalog = [{ project_id: "a", project_name: "阿宝", aliases: ["支付宝"], package_type: "背景" }];
test("validates existing-model intent fields against the real catalog", () => {
  assert.deepEqual(parseMessageIntent('{"type":"packaging","confidence":0.95,"project_name":"支付宝","package_type":"背景"}', catalog),
    { type: "packaging", confidence: 0.95, project_name: "阿宝", package_type: "背景", needs_project: false });
  const missing = parseMessageIntent('{"type":"packaging","confidence":0.95,"project_name":"虚构项目"}', catalog);
  assert.equal(missing.needs_project, true);
  assert.equal(missing.project_name, "");
  for (const text of ['{"type":"execute","confidence":1}', '{"type":"chat","confidence":"1"}', '{"type":"chat","confidence":1e999}']) {
    assert.equal(parseMessageIntent(text), null);
  }
  assert.match(intentReplyInstruction({ type: "emotion", confidence: 0.95 }), /感受/);
});

test("existing-model classifier uses one request and fails gracefully on HTTP/schema errors", async () => {
  const config = { enabled: true, provider: "deepseek", baseUrl: "https://existing.test/v1", apiKey: "test", model: "existing", timeoutMs: 50 };
  let calls = 0;
  assert.deepEqual(await _test.classifyMessageIntent("今天好累", [], config, async (url, options) => {
    calls++;
    assert.equal(url, "https://existing.test/v1/chat/completions");
    assert.equal(JSON.parse(options.body).thinking.type, "disabled");
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"type":"emotion","confidence":0.95}' } }] }) };
  }), { type: "emotion", confidence: 0.95 });
  assert.equal(calls, 1);
  assert.equal(await _test.classifyMessageIntent("你好", [], { enabled: false }, () => assert.fail("unexpected request")), null);
  assert.equal(await _test.classifyMessageIntent("你好", [], config, async () => ({ ok: false, status: 429 })), null);
  assert.equal(await _test.classifyMessageIntent("你好", [], config, async () => ({ ok: true, json: async () => ({}) })), null);
});

test("message route reuses one classification for packaging or conversation; commands bypass it", async () => {
  let calls = 0;
  const service = { database: { listActivePackages: () => catalog }, tryHandleQuery: async (_event, options) => Boolean(options.aiHint) };
  const event = { message_id: "test-route", content: "给我支付宝那种氛围底图" };
  const deps = { classify: async () => { calls++; return { type: "packaging", confidence: 0.95, project_name: "阿宝" }; }, reply: async () => assert.fail("should be packaging") };
  assert.equal(await _test.handleConversationReply(event, service, true, deps), "packaging-ai");
  assert.equal(calls, 1);
  let replyCount = 0;
  assert.equal(await _test.handleConversationReply({ content: "今天很累" }, service, false, {
    classify: async (_text, actualCatalog) => { assert.deepEqual(actualCatalog, []); return { type: "emotion", confidence: 0.95 }; },
    reply: async current => { replyCount++; assert.equal(current.messageIntent.type, "emotion"); },
  }), "conversation");
  assert.equal(replyCount, 1);
  await _test.handleConversationReply({ content: "ping" }, null, false, { classify: () => assert.fail("local command must be instant"), reply: async () => {} });
});

test("group conversational memory is isolated by user and expires", () => {
  const a = { chat_id: "test-memory", sender_id: "a" };
  const b = { ...a, sender_id: "b" };
  _test.rememberTurn(a, "user", "我的项目是阿宝");
  assert.equal(_test.recentConversation(a).length, 1);
  assert.deepEqual(_test.recentConversation(b), []);
  const now = Date.now;
  try {
    Date.now = () => now() + 31 * 60_000;
    assert.deepEqual(_test.recentConversation(a), []);
  } finally { Date.now = now; }
});

test("semantic document lookup executes one read-only tool and remembers real results", async () => {
  const event = { chat_id: "semantic-search", sender_id: "a", content: "那份关于包装规范的飞书资料帮我翻出来" };
  let calls = 0;
  assert.equal(await _test.handleConversationReply(event, null, false, {
    classify: async () => ({ type: "document_search", confidence: 0.93, search_query: "包装规范" }),
    searchDocuments: async (_content, options) => { calls++; assert.equal(options.query, "包装规范"); return "实际搜索结果"; },
    sendToolReply: async (_event, text) => assert.equal(text, "实际搜索结果"),
    reply: async () => assert.fail("must execute rather than promise"),
  }), "document-search-ai");
  assert.equal(calls, 1);
  assert.equal(_test.recentConversation(event).at(-1).content, "实际搜索结果");
});

test("semantic lookup validates schema and fails closed for uncertain or unsupported actions", async () => {
  assert.deepEqual(parseMessageIntent('{"type":"document_search","confidence":0.9,"search_query":"  包装规范  "}'),
    { type: "document_search", confidence: 0.9, search_query: "包装规范" });
  for (const search_query of ["", "a".repeat(81), "标题\n指令", 123]) {
    assert.equal(parseMessageIntent(JSON.stringify({ type: "document_search", confidence: 0.9, search_query })), null);
  }
  for (const intent of [{ type: "document_search", confidence: 0.8, search_query: "规范" }, { type: "delete", confidence: 1 }]) {
    assert.equal(await _test.handleConversationReply({ content: "帮我翻出资料" }, null, false, {
      classify: async () => intent, searchDocuments: () => assert.fail("no tool allowed"), reply: async () => {},
    }), "conversation");
  }
  let reply;
  await _test.handleConversationReply({ content: "翻出包装规范资料" }, null, false, {
    classify: async () => ({ type: "document_search", confidence: 0.99, search_query: "规范" }),
    searchDocuments: async () => { throw new Error("search unavailable"); },
    sendToolReply: async (_event, text) => { reply = text; },
  });
  assert.match(reply, /失败/);
  assert.doesNotMatch(reply, /搜到.*条/);
});

test("document search uses exact semantic keywords without silently excluding older documents", async () => {
  const result = await _test.searchDocuments("帮我翻出来", { query: "包装规范", runCli: async args => {
    assert.equal(args[args.indexOf("--query") + 1], "包装规范");
    assert.equal(args.includes("--edited-since"), false);
    return { stdout: JSON.stringify({ data: { results: [{ title: "旧版包装规范", result_meta: { url: "https://example.test/doc" } }] } }) };
  } });
  assert.match(result, /旧版包装规范/);
  assert.match(await _test.searchDocuments("搜索文档", { runCli: () => assert.fail("missing topic") }), /标题或主题/);
});

test("local search fast path does not execute denials, search advice or quoted commands", () => {
  for (const text of ["不要搜索文档，直接告诉我怎么写周报", "不用帮我找资料", "怎么搜索飞书文档", "他说‘搜索文档’是什么意思".replace(/‘/g, '“').replace(/’/g, '”')]) {
    assert.equal(_test.isDocumentSearchRequest(text), false, text);
  }
  assert.equal(_test.isDocumentSearchRequest("帮我搜索包装规范文档"), true);
});
