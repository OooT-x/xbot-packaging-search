const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectAep,
  inspectAep,
  previewAep,
  runAepWorker,
} = require("../eagle-plugin/lib/aep-worker.js");

function fakeSpawn(payload, exitCode = 0, stderr = "") {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (payload !== null) child.stdout.emit("data", Buffer.from(JSON.stringify(payload)));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

function workerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-aep-worker-test-"));
  const executable = path.join(root, "XbotAepWorker.exe");
  fs.writeFileSync(executable, "test worker");
  return { root, executable };
}

test("runs inspect through the local Worker and parses its JSON project snapshot", async () => {
  const fixture = workerFixture();
  const calls = [];
  const result = await inspectAep("C:\\projects\\demo.aep", {
    workerPath: fixture.executable,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeSpawn({ composition_count: 2, compositions: [] });
    },
  });

  assert.equal(result.composition_count, 2);
  assert.equal(calls[0].command, fixture.executable);
  assert.deepEqual(calls[0].args.slice(0, 1), ["inspect"]);
  assert.equal(calls[0].args[1], "C:\\projects\\demo.aep");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("deduplicates selected composition IDs and uses the collect protocol", async () => {
  const fixture = workerFixture();
  let args = [];
  const result = await collectAep("C:\\projects\\demo.aep", [12, 12, 9], "C:\\output", {
    workerPath: fixture.executable,
    previewTimes: { 12: 3.5 },
    spawnImpl: (_command, workerArgs) => {
      args = workerArgs;
      return fakeSpawn([{ composition_id: 12 }, { composition_id: 9 }]);
    },
  });

  assert.deepEqual(result.map((item) => item.composition_id), [12, 9]);
  assert.deepEqual(args, [
    "collect",
    "C:\\projects\\demo.aep",
    "--comp-id",
    "12",
    "--comp-id",
    "9",
    "--preview-time",
    "12=3.5",
    "--output",
    "C:\\output",
  ]);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("cancels a running Worker through AbortSignal", async () => {
  const fixture = workerFixture();
  const controller = new AbortController();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const pending = runAepWorker(["collect", "demo.aep"], {
    workerPath: fixture.executable,
    signal: controller.signal,
    spawnImpl: () => child,
  });

  controller.abort();
  await assert.rejects(pending, (error) => error.code === "ABORT_ERR");
  assert.equal(killed, true);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("streams Worker progress events without corrupting the final result", async () => {
  const fixture = workerFixture();
  const progress = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("XBOT_PROGRESS {\"command\":\"collect\",\"completed\":1}\n{\"ok\":true}"));
    child.emit("close", 0);
  });
  const result = await runAepWorker(["collect", "demo.aep"], {
    workerPath: fixture.executable,
    spawnImpl: () => child,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(progress, [{ command: "collect", completed: 1 }]);
  assert.deepEqual(result, { ok: true });
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("preview protocol writes to an isolated preview cache and reports Worker failures", async () => {
  const fixture = workerFixture();
  const result = await previewAep("C:\\projects\\demo.aep", 21, {
    workerPath: fixture.executable,
    outputRoot: fixture.root,
    spawnImpl: (_command, args) => {
      assert.equal(args[0], "preview");
      assert.equal(args[args.indexOf("--comp-id") + 1], "21");
      return fakeSpawn({ preview_file: "C:\\temp\\preview.png" });
    },
  });
  assert.equal(result.preview_file, "C:\\temp\\preview.png");

  await assert.rejects(
    () => runAepWorker(["inspect", "bad.aep"], {
      workerPath: fixture.executable,
      spawnImpl: () => fakeSpawn({ error: "无法解析 AEP" }, 2),
    }),
    /无法解析 AEP/
  );
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
