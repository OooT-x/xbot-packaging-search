const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const WORKER_ENV = "XBOT_AEP_WORKER";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function envValue(name) {
  return typeof process === "undefined" ? "" : String(process.env?.[name] || "").trim();
}

function workerCandidates() {
  const pluginRoot = path.resolve(__dirname, "..");
  return [
    envValue(WORKER_ENV),
    path.join(pluginRoot, "workers", "XbotAepWorker.exe"),
    path.resolve(pluginRoot, "..", "aep-collector", "dist", "XbotAepWorker.exe"),
  ].filter(Boolean);
}

function resolveWorkerPath(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : workerCandidates();
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existing) {
    throw new Error(
      `未找到 XbotAepWorker.exe。请先运行 aep-collector\\build.ps1，或设置 ${WORKER_ENV} 指向 Worker。`
    );
  }
  return path.resolve(existing);
}

function parseWorkerOutput(stdout, stderr) {
  const text = String(stdout || "").trim();
  if (!text) {
    throw new Error(String(stderr || "AEP Worker 没有返回结果。").trim());
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = String(stderr || "").trim();
    throw new Error(`AEP Worker 返回了无法解析的结果。${detail ? `\n${detail}` : ""}`);
  }
}

function terminateWorkerProcess(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref?.();
      return;
    } catch (_error) {
      // Fall back to the child handle if taskkill is unavailable.
    }
  }
  try { child.kill(); } catch (_error) { /* best effort */ }
}

function workerAbortError() {
  const error = new Error("AEP Worker 操作已取消。");
  error.code = "ABORT_ERR";
  return error;
}

function runAepWorker(args, options = {}) {
  const workerPath = resolveWorkerPath(options.workerPath);
  const spawnProcess = options.spawnImpl || spawn;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let child;
    let abortHandler = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal && abortHandler) options.signal.removeEventListener?.("abort", abortHandler);
      callback(value);
    };
    if (options.signal?.aborted) {
      finish(reject, workerAbortError());
      return;
    }
    try {
      child = spawnProcess(workerPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    const append = (target, chunk) => {
      const next = `${target}${chunk.toString()}`;
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        finish(reject, new Error("AEP Worker 输出过大，已中止本次操作。"));
        terminateWorkerProcess(child);
        return target;
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code !== 0) {
        let message = "AEP Worker 执行失败";
        try {
          const payload = parseWorkerOutput(stdout, stderr);
          message = payload?.error || message;
        } catch (_error) {
          message = stderr.trim() || stdout.trim() || message;
        }
        finish(reject, new Error(message));
        return;
      }
      try {
        const payload = parseWorkerOutput(stdout, stderr);
        if (payload && payload.error) {
          finish(reject, new Error(payload.error));
          return;
        }
        finish(resolve, payload);
      } catch (error) {
        finish(reject, error);
      }
    });
    abortHandler = () => {
      terminateWorkerProcess(child);
      finish(reject, workerAbortError());
    };
    options.signal?.addEventListener?.("abort", abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    timer = setTimeout(() => {
      terminateWorkerProcess(child);
      finish(reject, new Error(`AEP Worker 超过 ${Math.round(timeoutMs / 60000)} 分钟仍未完成，已终止。`));
    }, timeoutMs);
  });
}

function inspectAep(aepPath, options = {}) {
  return runAepWorker(["inspect", path.resolve(aepPath)], options);
}

function previewAep(aepPath, compositionId, options = {}) {
  const outputRoot = options.outputRoot || path.join(os.tmpdir(), "xbot-aep-plugin-previews");
  fs.mkdirSync(outputRoot, { recursive: true });
  const digest = crypto.createHash("sha1").update(`${path.resolve(aepPath)}|${compositionId}`).digest("hex").slice(0, 16);
  const outputFile = path.join(outputRoot, `${digest}-${compositionId}.png`);
  const args = ["preview", path.resolve(aepPath), "--comp-id", String(compositionId), "--output", outputFile];
  if (options.time !== undefined && options.time !== "") args.push("--time", String(options.time));
  return runAepWorker(args, options);
}

function collectAep(aepPath, compositionIds, outputRoot, options = {}) {
  const ids = [...new Set((compositionIds || []).map((value) => Number(value)).filter(Number.isInteger))];
  if (!ids.length) throw new Error("请至少选择一个要收集的合成。");
  const args = ["collect", path.resolve(aepPath)];
  ids.forEach((id) => args.push("--comp-id", String(id)));
  Object.entries(options.previewTimes || {}).forEach(([id, seconds]) => {
    if (Number.isFinite(Number(seconds)) && Number(seconds) >= 0) {
      args.push("--preview-time", `${Number(id)}=${Number(seconds)}`);
    }
  });
  args.push("--output", path.resolve(outputRoot));
  return runAepWorker(args, options);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  WORKER_ENV,
  collectAep,
  inspectAep,
  parseWorkerOutput,
  previewAep,
  resolveWorkerPath,
  runAepWorker,
  workerCandidates,
};
