import assert from "node:assert/strict";
import test from "node:test";
import { studioSessionFields, studioRunReferences } from "../src/studio-session.js";

test("a new project requires a title, while the user's chosen language remains valid", () => {
  assert.equal(studioSessionFields({}).ok, false);
  assert.equal(studioSessionFields({ session_title: " " }).ok, false);
  assert.equal(studioSessionFields({ session_title: "x".repeat(256) }).ok, false);
  assert.deepEqual(studioSessionFields({ session_title: "  用户指定名称  " }),
    { ok: true, created: true, fields: { title: "用户指定名称", versionMode: "NEW_GROUP" } });
});

test("continuations and revisions use explicit IDs without implicit renaming or ambient session state", () => {
  assert.deepEqual(studioSessionFields({ session_id: " session-a ", session_title: "Ignored" }),
    { ok: true, created: false, fields: { session_id: "session-a", versionMode: "NEW_GROUP" } });
  assert.deepEqual(studioSessionFields({ session_id: "session-b", base_run_id: "run-b" }),
    { ok: true, created: false, fields: { session_id: "session-b", baseRunId: "run-b", versionMode: "APPEND_TO_GROUP" } });
  assert.deepEqual(studioSessionFields({ session_title: "Another Topic" }),
    { ok: true, created: true, fields: { title: "Another Topic", versionMode: "NEW_GROUP" } });
  for (const input of [{ session_id: " " }, { base_run_id: "run-a" }, { session_id: "session-a", base_run_id: " " },
    { request_type: "callback" as const }, { callback_url: "https://example.com/callback" }]) {
    assert.equal(studioSessionFields(input).ok, false);
  }
});

test("only server-confirmed references are returned; business errors and wrong sessions cannot imply acceptance", () => {
  const data = { sessionId: "session-a", runId: "run-a", taskId: "task-a", status: "RUNNING" };
  assert.deepEqual(studioRunReferences({ code: 200, data }, "session-a"),
    { sessionId: "session-a", runId: "run-a", taskId: "task-a" });
  assert.equal(studioRunReferences({ code: 403, data }), null);
  assert.equal(studioRunReferences({ code: 200, data }, "session-b"), null);
  assert.equal(studioRunReferences({ code: 200, data: { ...data, taskId: " " } }), null);
  assert.equal(studioRunReferences({ code: 200, data: { taskId: "possibly-accepted" } }), null);
});
