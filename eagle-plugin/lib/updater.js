const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const RELEASES_API_URL = "https://api.github.com/repos/OooT-x/xbot-packaging-search/releases?per_page=100";
const MAX_RELEASE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_PACKAGE_BYTES = 180 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function parseStableVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error("插件版本号必须使用 MAJOR.MINOR.PATCH 格式。");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error("GitHub 更新信息中的下载地址无效。");
  }
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
    || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("更新地址不是受支持的 GitHub HTTPS 地址。");
  }
  return url;
}

function requestBuffer(value, options = {}) {
  const url = validateHttpsUrl(value);
  const maxBytes = options.maxBytes || MAX_RELEASE_RESPONSE_BYTES;
  const redirectsRemaining = options.redirectsRemaining ?? 4;
  const headers = {
    "User-Agent": "Xbot-Eagle-Plugin-Updater",
    Accept: options.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error("GitHub 下载跳转次数过多。"));
          return;
        }
        Promise.resolve().then(() => requestBuffer(new URL(location, url).toString(), {
          ...options,
          redirectsRemaining: redirectsRemaining - 1,
        })).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        const message = status === 403 || status === 429
          ? "GitHub 暂时限制了更新查询频率，请稍后重试。"
          : status === 404
            ? "GitHub 尚未发布可用的插件更新。"
            : `GitHub 更新请求失败（HTTP ${status}）。`;
        response.resume();
        const error = new Error(message);
        error.statusCode = status;
        reject(error);
        return;
      }

      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > maxBytes) {
        response.destroy();
        reject(new Error("插件安装包超过允许的下载大小。"));
        return;
      }

      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(new Error("下载内容超过允许的大小。"));
          return;
        }
        chunks.push(chunk);
        options.onProgress?.({ received, total: contentLength || options.expectedSize || 0 });
      });
      response.on("aborted", () => reject(new Error("GitHub 下载连接中断，请重试。")));
      response.on("end", () => resolve(Buffer.concat(chunks, received)));
      response.on("error", reject);
    });

    request.setTimeout(20000, () => request.destroy(new Error("GitHub 更新请求超时。")));
    request.on("error", reject);
  });
}

async function fetchLatestRelease(options = {}) {
  let latest = null;
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(RELEASES_API_URL);
    url.searchParams.set("page", String(page));
    let response;
    try {
      response = await (options.request || requestBuffer)(url.toString(), { maxBytes: MAX_RELEASE_RESPONSE_BYTES });
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }

    let releases;
    try {
      releases = JSON.parse(response.toString("utf8"));
    } catch (_) {
      throw new Error("GitHub 返回的版本信息无法读取。");
    }
    if (!Array.isArray(releases)) throw new Error("GitHub 返回的 Release 列表格式无效。");

    latest = selectLatestPluginRelease([latest, ...releases]);
    if (releases.length < 100) return latest;
  }
  throw new Error("GitHub Release 数量超过查询范围，无法定位插件版本。");
}

function selectLatestPluginRelease(releases) {
  if (!Array.isArray(releases)) throw new Error("GitHub 返回的 Release 列表格式无效。");
  return releases
    .filter((release) => (
      !release?.draft
      && !release?.prerelease
      && /^eagle-plugin-v\d+\.\d+\.\d+$/.test(String(release?.tag_name || ""))
    ))
    .sort((left, right) => compareVersions(
      String(right.tag_name).slice("eagle-plugin-v".length),
      String(left.tag_name).slice("eagle-plugin-v".length),
    ))[0] || null;
}

function inspectLatestRelease(release, currentVersion) {
  if (!parseStableVersion(currentVersion)) throw new Error("本地插件版本号无效。");
  if (!release || typeof release !== "object" || release.draft || release.prerelease) {
    return { releaseFound: false, updateAvailable: false, currentVersion };
  }

  const tagMatch = String(release.tag_name || "").match(/^eagle-plugin-v(\d+\.\d+\.\d+)$/);
  if (!tagMatch) return { releaseFound: false, updateAvailable: false, currentVersion };
  const version = tagMatch[1];
  const expectedAssetName = `xbot-eagle-plugin-v${version}.eagleplugin`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === expectedAssetName)
    : null;
  if (!asset) throw new Error(`版本 ${version} 的 Release 缺少 ${expectedAssetName} 安装包。`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error("GitHub Release 中的插件安装包大小无效或超过限制。");
  }
  const digestMatch = String(asset.digest || "").match(/^sha256:([a-f\d]{64})$/i);
  if (asset.digest && !digestMatch) throw new Error("GitHub Release 提供的 SHA-256 摘要格式无效。");

  return {
    releaseFound: true,
    updateAvailable: compareVersions(version, currentVersion) > 0,
    currentVersion,
    version,
    title: String(release.name || `Eagle 插件 v${version}`).slice(0, 180),
    notes: String(release.body || "").slice(0, 12000),
    publishedAt: String(release.published_at || ""),
    releaseUrl: String(release.html_url || ""),
    asset: {
      name: expectedAssetName,
      size: asset.size,
      url: validateHttpsUrl(asset.browser_download_url).toString(),
      digest: digestMatch ? digestMatch[1].toLowerCase() : null,
    },
  };
}

function rebaseUpdateInfo(info, currentVersion) {
  if (!info || typeof info.releaseFound !== "boolean") return null;
  if (!info.releaseFound) return { releaseFound: false, updateAvailable: false, currentVersion };
  if (!parseStableVersion(info.version) || !parseStableVersion(currentVersion)) return null;
  return {
    ...info,
    currentVersion,
    updateAvailable: compareVersions(info.version, currentVersion) > 0,
  };
}

function readUpdateCache(storage, currentVersion, now = Date.now()) {
  try {
    const cached = JSON.parse(storage.getItem("xbot.pluginUpdate.cache.v1") || "null");
    const info = rebaseUpdateInfo(cached?.info, currentVersion);
    const age = now - cached?.checkedAt;
    if (!info || !Number.isFinite(cached.checkedAt) || age < 0) return null;
    return { info, checkedAt: cached.checkedAt, fresh: age < 24 * 60 * 60 * 1000 };
  } catch (_) { return null; }
}

async function checkForUpdate(currentVersion, options = {}) {
  const release = await (options.fetchRelease || fetchLatestRelease)(options);
  return inspectLatestRelease(release, currentVersion);
}

async function downloadPluginUpdate(update, downloadsDirectory, options = {}) {
  if (!update?.updateAvailable || !update.asset) throw new Error("当前没有可下载的插件更新。");
  const version = String(update.version || "");
  if (!parseStableVersion(version)) throw new Error("插件更新版本号无效。");
  const expectedName = `xbot-eagle-plugin-v${version}.eagleplugin`;
  if (update.asset.name !== expectedName) throw new Error("插件安装包文件名与版本信息不匹配。");

  if (!Number.isSafeInteger(update.asset.size) || update.asset.size <= 0 || update.asset.size > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error("插件安装包大小无效。");
  }
  if (!/^[a-f\d]{64}$/i.test(String(update.asset.digest || ""))) {
    throw new Error("该安装包缺少有效的 SHA-256 摘要，请等待发布者补齐后重试。");
  }
  const url = validateHttpsUrl(update.asset.url).toString();
  const buffer = await (options.downloadAsset || ((downloadUrl) => requestBuffer(downloadUrl, {
    accept: "application/octet-stream",
    maxBytes: MAX_PLUGIN_PACKAGE_BYTES,
    expectedSize: update.asset.size,
    onProgress: options.onProgress,
  })))(url);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error("下载的插件安装包为空或超过大小限制。");
  }
  if (update.asset.size && buffer.length !== update.asset.size) {
    throw new Error("下载的插件安装包大小与 GitHub Release 记录不一致。");
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (update.asset.digest && sha256 !== update.asset.digest.toLowerCase()) {
    throw new Error("插件安装包 SHA-256 校验失败，文件未保存。");
  }

  const targetDirectory = path.resolve(downloadsDirectory);
  await fs.promises.mkdir(targetDirectory, { recursive: true });
  const targetPath = path.join(targetDirectory, expectedName);
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
  try {
    await fs.promises.writeFile(temporaryPath, buffer, { flag: "wx" });
    await fs.promises.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { path: targetPath, size: buffer.length, sha256, verified: Boolean(update.asset.digest) };
}

module.exports = {
  MAX_PLUGIN_PACKAGE_BYTES,
  checkForUpdate,
  compareVersions,
  downloadPluginUpdate,
  inspectLatestRelease,
  parseStableVersion,
  rebaseUpdateInfo,
  readUpdateCache,
  selectLatestPluginRelease,
};
