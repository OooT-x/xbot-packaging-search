const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../bot/lark-bot-listener");

function withEnv(overrides, callback) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    callback();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("extracts quoted literal speech before keyword replies", () => {
  assert.equal(_test.extractLiteralSpeech("说“我是章鱼哥”"), "我是章鱼哥");
  assert.equal(_test.extractLiteralSpeech('请用语音说："今天开工"'), "今天开工");
  assert.equal(_test.extractLiteralSpeech("朗读：第一行\n第二行"), "第一行\n第二行");
  assert.equal(_test.extractLiteralSpeech("说，今天是星期一"), "今天是星期一");
  assert.equal(_test.extractLiteralSpeech("说我是派大星"), "我是派大星");
  assert.equal(_test.extractLiteralSpeech("用语音说今天是星期一"), "今天是星期一");
});

test("does not treat general conversation as literal speech", () => {
  assert.equal(_test.extractLiteralSpeech("说句话"), "");
  assert.equal(_test.extractLiteralSpeech("你说章鱼哥是谁"), "");
});

test("voice audio contains only the requested reply text", () => {
  assert.equal(_test.speechTextFor("我是章鱼哥"), "我是章鱼哥");
  assert.equal(_test.speechTextFor("看这个 https://example.com"), "看这个 这里有一个链接。");
});

test("normalizes model-only reply artifacts", () => {
  assert.equal(
    _test.normalizeAiReplyText("<think>这里是隐藏推理</think>\n\n作为一个AI语言模型，可以。"),
    "可以。"
  );
});

test("parses AI packaging hint JSON", () => {
  assert.deepEqual(
    _test.parseAiPackagingHint('{"is_packaging_query":true,"project_name":"变速箱","package_type":"背景"}'),
    { project_name: "变速箱", package_type: "背景" }
  );
  assert.deepEqual(
    _test.parseAiPackagingHint('解释：{"is_packaging_query":true,"project_name":"变速箱","package_type":""}'),
    { project_name: "变速箱", package_type: "" }
  );
  assert.equal(
    _test.parseAiPackagingHint('{"is_packaging_query":false,"project_name":"","package_type":""}'),
    null
  );
  assert.equal(_test.parseAiPackagingHint("不是 JSON"), null);
});

test("detects explicit voice-only requests", () => {
  assert.deepEqual(_test.voiceRequestFor("请用语音说：今天开工"), {
    kind: "literal",
    content: "今天开工",
  });
  assert.deepEqual(_test.voiceRequestFor("用语音回答 你是谁"), {
    kind: "reply",
    content: "你是谁",
  });
  assert.deepEqual(_test.voiceRequestFor("用语音回答你是谁"), {
    kind: "reply",
    content: "你是谁",
  });
  assert.equal(_test.voiceRequestFor("语音回复配置怎么弄"), null);
});

test("detects explicit original song requests", () => {
  assert.deepEqual(_test.voiceRequestFor("唱首歌"), {
    kind: "song",
    content: "",
  });
  assert.deepEqual(_test.voiceRequestFor("唱一首关于今天开工的歌"), {
    kind: "song",
    content: "今天开工",
  });
  assert.deepEqual(_test.voiceRequestFor("用语音唱：今天状态不错"), {
    kind: "song",
    content: "今天状态不错",
  });
  assert.equal(_test.voiceRequestFor("我想让 bot 能唱歌"), null);
});

test("song text uses original structured lyrics", () => {
  const song = _test.songTextForRequest("今天开工");

  assert.match(song, /今天开工/);
  assert.match(song, /\[Verse\]/);
  assert.match(song, /\[Chorus\]/);
  assert.match(song, /啦啦啦/);
  assert.doesNotMatch(song, /唱一首|用语音/);
});

test("infers DeepSeek provider from API key", () => {
  withEnv(
    {
      LARK_BOT_AI_PROVIDER: undefined,
      DEEPSEEK_API_KEY: "test-key",
      OLLAMA_BASE_URL: undefined,
      LARK_BOT_MODEL: undefined,
      DEEPSEEK_MODEL: undefined,
    },
    () => {
      assert.equal(_test.inferAiProvider(), "deepseek");
      assert.equal(_test.baseUrlForProvider("deepseek"), "https://api.deepseek.com");
      assert.equal(_test.modelForProvider("deepseek"), "deepseek-v4-flash");
    }
  );
});

test("identity reply sounds conversational, not like implementation notes", () => {
  const reply = _test.identityText();
  assert.match(reply, /X\.bot/);
  assert.doesNotMatch(reply, /CLI|DeepSeek|API|模型|本地运行|智能体/);
  assert.equal(reply.includes("\n"), false);
});

test("normal chat prompt keeps the live conversational style", () => {
  const prompt = _test.aiSystemPrompt("你是谁");
  const normalMode = _test.styleModeInstruction("你是谁");

  assert.match(prompt, /清醒、松弛、鲜活/);
  assert.match(prompt, /先办事，再有人味/);
  assert.match(prompt, /犀利/);
  assert.match(prompt, /反驳/);
  assert.match(normalMode, /反差句/);
  assert.match(normalMode, /自己的判断/);
  assert.match(normalMode, /不攻击用户本人/);
  assert.doesNotMatch(normalMode, /用户没有明确要求幽默/);
});

test("only replies in group chats when the bot is mentioned", () => {
  assert.equal(
    _test.shouldReplyToEvent({ chat_type: "p2p", content: "你是谁" }, "ou_bot"),
    true
  );
  assert.equal(
    _test.shouldReplyToEvent({ chat_type: "group", content: "你是谁", mentions: [] }, "ou_bot"),
    false
  );
  assert.equal(
    _test.shouldReplyToEvent(
      {
        chat_type: "group",
        content: "@_user_1 你是谁",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "X.bot" }],
      },
      "ou_bot"
    ),
    true
  );
  assert.equal(
    _test.shouldReplyToEvent(
      {
        chat_type: "group",
        content: "@_user_1 你是谁",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_someone_else" }, name: "别人" }],
      },
      "ou_bot"
    ),
    false
  );
  assert.equal(
    _test.shouldReplyToEvent(
      {
        chat_type: "group",
        content: "@_user_1 你是谁",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_someone_else" }, name: "X.bot" }],
      },
      "ou_bot"
    ),
    false
  );
  assert.equal(
    _test.shouldReplyToEvent(
      { chat_type: "group", content: '<at user_id="ou_bot">X.bot</at> 你是谁' },
      "ou_bot"
    ),
    true
  );
  assert.equal(
    _test.shouldReplyToEvent(
      { chat_type: "group", content: "@X.bot 你好", mentions: [] },
      "ou_bot",
      ["X.bot"]
    ),
    true
  );
  assert.equal(
    _test.shouldReplyToEvent(
      {
        chat_type: "group",
        content: "@_user_1 你是谁",
        mentions: [{ key: "@_user_1", name: "X.bot" }],
      },
      "",
      ["X.bot"]
    ),
    true
  );
});

test("formats recent group messages as context before the current mention", () => {
  const context = _test.formatGroupHistoryContext(
    [
      {
        message_id: "om_new",
        sender: { name: "小王" },
        msg_type: "text",
        content: JSON.stringify({ text: "我觉得这个方案有点绕" }),
      },
      {
        message_id: "om_current",
        sender: { name: "夏旋" },
        msg_type: "text",
        content: "@X.bot 你怎么看",
      },
      {
        message_id: "om_mid",
        sender: { name: "小李" },
        msg_type: "text",
        content: "先别急着定稿",
      },
      {
        message_id: "om_old",
        sender: { name: "小张" },
        msg_type: "text",
        content: "我倾向于第二版",
      },
    ],
    { chat_type: "group", message_id: "om_current" },
    { limit: 50, maxChars: 2000 }
  );

  assert.match(context, /最近 3 条消息/);
  assert.match(context, /只作为理解上下文的参考/);
  assert.equal(context.includes("@X.bot 你怎么看"), false);
  assert.ok(context.indexOf("小张: 我倾向于第二版") < context.indexOf("小李: 先别急着定稿"));
  assert.ok(context.indexOf("小李: 先别急着定稿") < context.indexOf("小王: 我觉得这个方案有点绕"));
});
