const test = require("node:test");
const assert = require("node:assert/strict");

const {
  confirmationIntent,
  isPackagingQueryText,
  isProjectCatalogInquiry,
  searchPackages,
} = require("../bot/lib/package-intent");

const packages = [
  {
    package_id: "pkg-label",
    project_id: "project-1",
    project_name: "变速箱",
    normalized_name: "变速箱",
    aliases: ["变速箱包装", "齿轮箱项目"],
    package_name: "小标注",
    package_type: "信息条",
    tags: ["重点标注"],
    eagle_modified_at: 10,
  },
  {
    package_id: "pkg-bg",
    project_id: "project-1",
    project_name: "变速箱",
    normalized_name: "变速箱",
    aliases: ["变速箱包装", "齿轮箱项目"],
    package_name: "背景",
    package_type: "背景",
    tags: [],
    eagle_modified_at: 20,
  },
];

test("treats action or domain words as packaging query signals", () => {
  assert.equal(isPackagingQueryText("@X.bot 找变速箱项目的信息条"), true);
  assert.equal(isPackagingQueryText("我要变速箱的信息条"), true);
  assert.equal(isPackagingQueryText("变速箱小标注"), true);
  assert.equal(isPackagingQueryText("今天天气不错"), false);
  assert.equal(isPackagingQueryText("找一下这个项目的时间轴"), true);
  assert.equal(isPackagingQueryText("有没有分Part板和报道"), true);
});

test("recognizes the extended packaging types and aliases", () => {
  const { extractPackageType } = require("../bot/lib/package-intent");
  assert.equal(extractPackageType("时间线"), "时间轴");
  assert.equal(extractPackageType("分P板"), "分Part板");
  assert.equal(extractPackageType("报道板"), "报道");
});

test("recognizes project catalog questions without matching ordinary project talk", () => {
  assert.equal(isProjectCatalogInquiry("你有哪些项目"), true);
  assert.equal(isProjectCatalogInquiry("目前库里能查哪些项目"), true);
  assert.equal(isProjectCatalogInquiry("项目进度怎么样"), false);
});

test("searches project aliases before filtering by package type", () => {
  const result = searchPackages(packages, "@X.bot 找齿轮箱项目的人名条");
  assert.equal(result.project.project_name, "变速箱");
  assert.equal(result.package_type, "信息条");
  assert.deepEqual(result.candidates.map((item) => item.package_id), ["pkg-label"]);
});

test("prefers the current derived version unless the user asks for history", () => {
  const versioned = [
    { ...packages[1], package_id: "pkg-v01", version: "v01", base_package_id: null, eagle_modified_at: 20 },
    { ...packages[1], package_id: "pkg-v02", version: "v02", base_package_id: "pkg-v01", eagle_modified_at: 10 },
  ];
  assert.deepEqual(searchPackages(versioned, "找变速箱背景").candidates.map((item) => item.package_id), ["pkg-v02"]);
  assert.deepEqual(searchPackages(versioned, "找变速箱背景 v01").candidates.map((item) => item.package_id).sort(), ["pkg-v01", "pkg-v02"]);
});

test("parses candidate confirmation from prompt or a replied preview", () => {
  assert.deepEqual(confirmationIntent("第二个", 3), { kind: "select", position: 2 });
  assert.deepEqual(confirmationIntent("就是这个", 3, 3), { kind: "select", position: 3 });
  assert.deepEqual(confirmationIntent("确认", 3), { kind: "ambiguous" });
  assert.deepEqual(confirmationIntent("都不对", 3), { kind: "reject" });
});
