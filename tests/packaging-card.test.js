const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPackagingCard, buildPackagingNotice } = require("../bot/lib/packaging-card");
test("card 2.0 keeps each image and action paired, with no source action for image-only", () => {
  const items = [1, 2, 3].map(n => ({ project_name: "项目", package_name: `包装${n}<at id=all>`, version: "v01" }));
  const card = buildPackagingCard(items, ["img1", "img2", "img3"], { requestId: "req" });
  assert.equal(card.schema, "2.0");
  assert.equal(card.body.elements.length, 4);
  card.body.elements.slice(0, 3).forEach((group, i) => {
    const elements = group.columns[0].elements;
    assert.equal(elements[1].img_key, `img${i + 1}`);
    assert.equal(elements[2].behaviors[0].value.position, i + 1);
    assert.ok(!elements[0].content.includes("<at"));
  });
  const imageOnly = buildPackagingCard(items, ["img1", "img2", "img3"]);
  assert.equal(JSON.stringify(imageOnly).includes('"callback"'), false);
});
test("packaging notices escape injected markup and retain clickable download links", () => {
  const card = buildPackagingNotice("下载 https://example.com/file/test\n<at id=all> *名称*");
  const content = card.body.elements[1].columns[0].elements[0].content;
  assert.ok(content.includes("[打开链接](https://example.com/file/test)"));
  assert.ok(!content.includes("<at"));
});
