const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const IDENTITY_FIELDS = ["package_id", "project_id", "package_name", "package_type", "version",
  "preview_eagle_id", "source_eagle_id", "preview_path", "source_path", "catalog_revision"];

function identity(item) {
  return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, String(item[key] || "")]));
}

function fileDigest(file) {
  const fd = fs.openSync(file, "r"), hash = crypto.createHash("sha256");
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("候选文件不是普通文件");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("候选文件读取期间发生变化，请重新查询");
    }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

function captureSnapshot(item) {
  return { identity: identity(item), preview_hash: fileDigest(item.preview_path),
    source_hash: item.source_path ? fileDigest(item.source_path) : "" };
}

function matchesSnapshot(item, snapshot) {
  return snapshot?.identity && JSON.stringify(identity(item)) === JSON.stringify(snapshot.identity);
}

function snapshotKey(snapshotJson) {
  return crypto.createHash("sha256").update(snapshotJson).digest("hex");
}

// Only a private, verified copy is handed to asynchronous uploaders.
function stageFile(file, expectedHash) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-delivery-"));
  const target = path.join(directory, path.basename(file));
  const cleanup = () => {
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.rmdirSync(directory);
  };
  try {
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    if (!expectedHash || fileDigest(target) !== expectedHash) throw new Error("候选文件内容已变化，请重新查询");
    return { path: target, cleanup };
  } catch (error) { cleanup(); throw error; }
}

module.exports = { captureSnapshot, matchesSnapshot, snapshotKey, stageFile, fileDigest };
