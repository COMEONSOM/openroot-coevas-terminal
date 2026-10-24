import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildFormatTiers,
  classifyError,
  runVideoStrategies,
  spawnAttempt,
  validateOutputResolution,
} from "./youtube.js";

function makeApp() {
  return { locals: { cancelRequested: false }, logs: [], log(message) { this.logs.push(message); } };
}

function fakeYtDlp({ exitCode = 0, resolution = "3840x2160", stderr = "", partial = false } = {}) {
  return (_client, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      const outputTemplate = args[args.indexOf("-o") + 1];
      const outputPath = outputTemplate
        .replace("%(title).80s", "sample")
        .replace("%(resolution)s", resolution)
        .replace("%(format_id)s", "137+140")
        .replace("%(id)s", "id")
        .replace("%(ext)s", "mp4");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      if (partial) fs.writeFileSync(`${outputPath}.part`, Buffer.alloc(2048));
      if (exitCode === 0) fs.writeFileSync(outputPath, Buffer.alloc(2048));
      child.stdout.write("[download] 50.0%\n");
      if (stderr) child.stderr.write(`${stderr}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
}

test("Best selector preserves the probed minimum and excludes AV1 when disabled", () => {
  const [format] = buildFormatTiers(2160, false, false, true);
  assert.match(format, /height>=2160/);
  assert.equal((format.match(/vcodec!\^=av01/g) || []).length, 2);
  assert.doesNotMatch(format, /height<=1080|worst/);
});

test("explicit and H.264 selections stay within the requested resolution and codec", () => {
  const [explicit] = buildFormatTiers(1080, false, false, false);
  const [h264] = buildFormatTiers(2160, true, true, false);
  assert.match(explicit, /height=1080/);
  assert.doesNotMatch(explicit, /height<=/);
  assert.match(h264, /height=2160/);
  assert.equal((h264.match(/vcodec\^=avc1/g) || []).length, 2);
  assert.doesNotMatch(h264, /av01/);
});

test("HTTP 403 is classified for yt-dlp's common error wording", () => {
  assert.equal(classifyError("ERROR: unable to download video data: HTTP Error 403: Forbidden", 1), "HTTP_403");
  assert.equal(classifyError("HTTP 403 Forbidden", 1), "HTTP_403");
});

test("spawned 403 retains its partial file and keeps FFmpeg merge arguments", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  const app = makeApp();
  const observed = {};
  app.locals.progressRes = {
    writableEnded: false,
    writes: [],
    write(chunk) { this.writes.push(chunk); },
    flush() {},
  };
  try {
    await assert.rejects(spawnAttempt({
      client: "tv_embedded",
      formatStr: "bv*[height>=2160]+ba",
      url: "https://www.youtube.com/watch?v=sample",
      tmpDir,
      app,
      isAudio: false,
      minHeight: 2160,
      spawnProcess: (client, args, options) => {
        observed.client = client;
        observed.args = args;
        observed.options = options;
        return fakeYtDlp({ exitCode: 1, stderr: "HTTP Error 403: Forbidden", partial: true })(client, args);
      },
    }), error => error.type === "HTTP_403");

    assert.equal(observed.client, "tv_embedded");
    assert.ok(observed.args.includes("--merge-output-format"));
    assert.ok(observed.args.includes("mp4"));
    assert.ok(observed.args.includes("--progress"));
    assert.equal(fs.readdirSync(tmpDir).some(name => name.endsWith(".part")), true);
    assert.deepEqual(app.locals.progressRes.writes, ["data: 50\n\n"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("completed lower-resolution output is rejected by the process wrapper", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  try {
    await assert.rejects(spawnAttempt({
      client: "tv_embedded",
      formatStr: "bv*[height>=2160]+ba",
      url: "https://www.youtube.com/watch?v=sample",
      tmpDir,
      app: makeApp(),
      isAudio: false,
      minHeight: 2160,
      spawnProcess: fakeYtDlp({ resolution: "1920x1080" }),
    }), error => error.type === "QUALITY_MISMATCH");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("repeated 403s make three bounded same-quality attempts, then fail", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  const calls = [];
  try {
    const result = await runVideoStrategies({
      url: "https://www.youtube.com/watch?v=sample",
      targetHeight: 2160,
      bestQuality: true,
      allowAV1: false,
      playerClient: "tv_embedded",
      tmpDir,
      app: makeApp(),
      attempt: async options => {
        calls.push(options);
        throw { type: "HTTP_403" };
      },
    });

    assert.deepEqual(result, { failure: true, type: "HTTP_403" });
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map(call => call.formatStr)).size, 1);
    assert.ok(calls.every(call => call.client === "tv_embedded"));
    assert.deepEqual(calls.map(call => call.noContinue), [false, false, true]);
    assert.notEqual(calls[0].attemptDir, calls[2].attemptDir);
    assert.ok(calls.every(call => call.formatStr.includes("height>=2160")));
    assert.ok(calls.every(call => call.formatStr.includes("vcodec!^=av01")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh same-quality attempt can succeed and quality validation rejects a downgrade", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  const app = makeApp();
  try {
    const result = await runVideoStrategies({
      url: "https://www.youtube.com/watch?v=sample",
      targetHeight: 2160,
      bestQuality: true,
      allowAV1: true,
      playerClient: "web",
      tmpDir,
      app,
      attempt: async options => {
        const file = path.join(options.attemptDir, "sample [3840x2160] [137+140] [id].mp4");
        fs.mkdirSync(options.attemptDir, { recursive: true });
        fs.writeFileSync(file, Buffer.alloc(2048));
        return file;
      },
    });

    assert.equal(result, path.join(tmpDir, "sample [3840x2160] [137+140] [id].mp4"));
    assert.deepEqual(validateOutputResolution("sample [1920x1080] [137+140] [id].mp4", { minHeight: 2160 }), {
      valid: false,
      height: 1080,
    });
    assert.deepEqual(validateOutputResolution("sample [3840x2160] [137+140] [id].mp4", { minHeight: 2160 }), {
      valid: true,
      height: 2160,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cancellation stops before another same-quality attempt", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  const app = makeApp();
  app.locals.cancelRequested = true;
  let calls = 0;
  try {
    const result = await runVideoStrategies({
      url: "https://www.youtube.com/watch?v=sample",
      targetHeight: 2160,
      bestQuality: true,
      allowAV1: false,
      tmpDir,
      app,
      attempt: async () => { calls++; throw new Error("should not run"); },
    });
    assert.equal(result, null);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
