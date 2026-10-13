import assert from "node:assert/strict";
import test from "node:test";
import { enumInputErrors, findModelIndexEntry, suggestModels, type ModelSchemaIndexEntry } from "../src/models.js";
import { sanitizeTaskStatus } from "../src/task-status.js";
import { SetupPoller, setupPollDelay, type SetupCheck } from "../src/setup-poller.js";

const entry = (model_id: string, slug = model_id): ModelSchemaIndexEntry => ({
  model_id, slug, title: model_id, category: "video", integration_type: "task_api", schema_path: "schema.json", doc_path: "/model",
});
const models = [entry("veo-3-1"), entry("hailuo-2-3-fast"), entry("seedance-2-0-fast"), entry("gpt-image-2.5-flare", "gpt-image-2-5-flare")];

test("mode-like names are suggestions, while real fast variants remain independent IDs", () => {
  assert.equal(findModelIndexEntry(models, "veo-3-1-fast"), null);
  assert.equal(suggestModels(models, "Veo 3.1 Fast")[0].model_id, "veo-3-1");
  assert.equal(findModelIndexEntry(models, " HAILUO-2-3-FAST ")?.model_id, "hailuo-2-3-fast");
  assert.equal(findModelIndexEntry(models, "seedance-2-0-fast")?.model_id, "seedance-2-0-fast");
  assert.equal(findModelIndexEntry(models, "gpt-image-2-5-flare")?.model_id, "gpt-image-2.5-flare");
});

test("explicit invalid enums are actionable without rejecting unknown or conditional fields", () => {
  const schema = { request_schema: { input: { properties: [
    { name: "mode", enum: ["fast", "quality"] },
    { name: "duration", type: "integer", enum: ["4", "6", "8"] },
    { name: "taskId", required: true },
    { name: "resolution", enum: ["720p", "1080p"], description: "Numeric aliases 720 and 1080 are accepted and normalized." },
  ] } } };
  assert.deepEqual(enumInputErrors(schema, { mode: "fast", duration: 4, extra: "ignored" }), []);
  assert.deepEqual(enumInputErrors(schema, { mode: "fast", duration: "6" }), []);
  assert.equal(enumInputErrors(schema, { mode: "turbo" })[0].field, "input.mode");
  assert.deepEqual(enumInputErrors(schema, { resolution: 720 }), []);
  assert.equal(enumInputErrors(schema, { resolution: 480 })[0].field, "input.resolution");
});

test("task filtering removes only nonterminal completion times and does not mutate the API payload", () => {
  const original = { code: 200, data: { state: "processing", completeTime: 34, createTime: 0, costTime: 34 } };
  assert.deepEqual(sanitizeTaskStatus(original), { code: 200, data: { state: "processing", createTime: 0, costTime: 34 } });
  assert.equal(original.data.completeTime, 34);
  for (const state of ["pending", "PROCESSING_R2"]) {
    assert.deepEqual(sanitizeTaskStatus({ state, completeTime: 34 }), { state });
  }
  for (const state of ["success", "failed", "new-unknown-state"]) {
    assert.deepEqual(sanitizeTaskStatus({ state, completeTime: 34 }), { state, completeTime: 34 });
  }
  assert.deepEqual(sanitizeTaskStatus({ items: [{ state: "processing", completeTime: 34 }, { state: "success", completeTime: 99 }] }),
    { items: [{ state: "processing" }, { state: "success", completeTime: 99 }] });
});

test("background and manual setup checks share one in-flight request", async () => {
  let finish!: (result: SetupCheck) => void;
  let calls = 0;
  const poller = new SetupPoller(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = poller.pollOnce();
  const second = poller.pollOnce();
  await Promise.resolve();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish({ ok: true, status: "CONFIGURED", message: "done" });
  assert.equal((await second).status, "CONFIGURED");
  poller.stop();
});

test("background setup follows server intervals and stops after completion", async () => {
  let calls = 0;
  let configured!: () => void;
  const done = new Promise<void>((resolve) => { configured = resolve; });
  const poller = new SetupPoller(async () => {
    calls++;
    if (calls === 1) return { ok: true, status: "PENDING_APPROVAL", message: "waiting", pollIntervalSeconds: 0.01 };
    configured();
    return { ok: true, status: "CONFIGURED", message: "done" };
  });
  poller.start();
  poller.start();
  // A referenced timeout keeps the test alive; production polling timers deliberately do not keep a closed stdio process alive.
  const timeout = setTimeout(() => configured(), 1000);
  await done;
  clearTimeout(timeout);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 2);
  poller.stop();
  assert.equal(setupPollDelay(3), 3000);
  assert.equal(setupPollDelay(undefined), 2000);
});
