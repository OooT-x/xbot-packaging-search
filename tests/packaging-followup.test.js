const test = require("node:test");
const assert = require("node:assert/strict");
const { followUpState, parseFollowUp, judgePackagingFollowUp, versionFamily } = require("../bot/lib/packaging-followup");
const packages = [
  { package_id: "a", package_name: "简洁人名条", package_type: "信息条", tags: ["简洁"], version: "v01", project_name: "阿宝", preview_path: "private.png" },
  { package_id: "b", package_name: "人名条新版", package_type: "信息条", tags: ["简洁"], version: "v02", base_package_id: "a" },
];
const query = { search_type: "信息条", candidates: [{ ...packages[0], position: 1 }] };

test("semantic protocol sends only metadata and validates IDs, confidence and permitted actions", async () => {
  const state = followUpState("简洁一点", query, packages);
  assert.equal(JSON.stringify(state).includes("private.png"), false);
  for (const answer of [
    { action: "send", confidence: 1 },
    { action: "more", confidence: 0.3 },
    { action: "refine", confidence: 0.95, package_ids: ["invented"] },
    { action: "version", confidence: 0.95, candidate_position: 8 },
  ]) assert.equal(parseFollowUp(JSON.stringify(answer), state), null);
  const decision = await judgePackagingFollowUp("简洁一点", query, packages,
    { enabled: true, provider: "deepseek", baseUrl: "https://example.test", apiKey: "test", model: "existing", timeoutMs: 50 },
    async (url, options) => {
      assert.equal(url, "https://example.test/chat/completions");
      const body = JSON.parse(options.body);
      assert.equal(body.thinking.type, "disabled");
      assert.equal(JSON.parse(body.messages[1].content).shown[0].position, 1);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"refine","confidence":0.95,"package_ids":["a","b"]}' } }] }) };
    });
  assert.deepEqual(decision.package_ids, ["a", "b"]);
});

test("semantic timeout/service failure returns null; version family follows stable IDs only", async () => {
  const config = { enabled: true, provider: "deepseek", baseUrl: "https://example.test", timeoutMs: 5 };
  assert.equal(await judgePackagingFollowUp("更简洁", query, packages, config, async () => ({ ok: false })), null);
  assert.equal(await judgePackagingFollowUp("更简洁", query, packages, config, (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("timeout"))))), null);
  assert.deepEqual(versionFamily([...packages, { ...packages[0], package_id: "unrelated" }], "a").map(item => item.package_id), ["a", "b"]);
});
