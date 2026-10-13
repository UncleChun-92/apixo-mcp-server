import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio resumes setup automatically, guards generation, canonicalizes IDs and sanitizes task status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apixo-workflow-test-"));
  const credentialsPath = join(directory, "credentials.json");
  const mockKey = "mock-private-key-for-test";
  let polls = 0;
  let submits = 0;
  let submittedPath = "";
  const submittedBodies: Array<Record<string, any>> = [];
  const states: string[] = [];
  const backend = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/index.json") {
      response.end(JSON.stringify({ total_models: 2, models: [
        { model_id: "veo-3-1", slug: "veo-slug", title: "Veo 3.1", category: "video", integration_type: "task_api", schema_path: "schema.json", doc_path: "/veo" },
        { model_id: "image-model", slug: "image-model", title: "Image Model", category: "image", integration_type: "task_api", schema_path: "schema.json", doc_path: "/image" },
      ] }));
    } else if (url.pathname === "/schema.json") {
      response.end(JSON.stringify({ request_schema: { input: { properties: [{ name: "mode", enum: ["fast", "quality"] }] } } }));
    } else if (url.pathname === "/api/mcp/device-authorization/start") {
      response.end(JSON.stringify({ code: 200, data: { deviceCode: "mock-device-code", pollToken: "mock-poll-token",
        verificationUrl: "mock-test://no-browser", expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 60,
        pollIntervalSeconds: 0.01 } }));
    } else if (url.pathname === "/api/mcp/device-authorization/poll") {
      polls++;
      response.end(JSON.stringify({ code: 200, data: polls === 1 ? { status: "PENDING", pollIntervalSeconds: 0.01 } : { status: "AUTHORIZED", apiKey: mockKey } }));
    } else if (url.pathname === "/api/v1/web/generations/mcp") {
      submits++;
      submittedPath = url.pathname;
      assert.equal(request.headers.authorization, `Bearer ${mockKey}`);
      assert.equal(request.headers["x-user-id"], undefined);
      const submitted = JSON.parse(body);
      submittedBodies.push(submitted);
      if (submitted.session_id === "missing-session") {
        response.writeHead(404).end(JSON.stringify({ code: 404, message: "Session not found" }));
        return;
      }
      if (submitted.session_id === "unconfirmed-session") {
        response.end(JSON.stringify({ code: 200, data: { taskId: "may-have-been-accepted" } }));
        return;
      }
      if (submitted.session_id === "wrong-session") {
        response.end(JSON.stringify({ code: 200, data: { sessionId: "different-project", runId: "run-other", taskId: "task-other" } }));
        return;
      }
      if (submitted.session_id === "business-error") {
        response.end(JSON.stringify({ code: 403, message: "Session access denied", data: { sessionId: "business-error", runId: "untrusted-run", taskId: "untrusted-task" } }));
        return;
      }
      response.end(JSON.stringify({ code: 200, data: { status: "RUNNING", taskId: `mock-task-${submits}`,
        sessionId: submitted.session_id ?? `mock-session-${submits}`, runId: `mock-run-${submits}`,
        resultMeta: { data: { state: "processing", completeTime: 34 } } } }));
    } else if (url.pathname.startsWith("/api/v1/statusTask/")) {
      const state = states.shift() ?? "processing";
      response.end(JSON.stringify({ code: 200, data: { state, taskId: "mock-task", completeTime: 34 } }));
    } else {
      response.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const credentials = (expires: number) => ({ version: 1, installationId: "mock-installation", pendingSetup: {
    deviceCode: "mock-device-code", pollToken: "mock-poll-token", verificationUrl: base,
    expiresAtEpochSeconds: expires, clientType: "test", hostLabel: "test-host", pollIntervalSeconds: 0.01,
  } });
  await writeFile(credentialsPath, JSON.stringify(credentials(Math.floor(Date.now() / 1000) + 60)));
  const env = { ...process.env, APIXO_API_KEY: "", APIXO_MCP_TOKEN: "", APIXO_UPDATE_CHECK_ENABLED: "false",
    APIXO_BASE_URL: base, APIXO_MODEL_SCHEMA_INDEX_URL: `${base}/index.json`, APIXO_MODEL_SCHEMA_BASE_URL: base,
    APIXO_MCP_CREDENTIALS_PATH: credentialsPath };
  const connect = async () => {
    const client = new Client({ name: "mock-workflow-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: process.env.APIXO_TEST_ENTRY ? [resolve(process.env.APIXO_TEST_ENTRY)]
        : [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/index.ts")], env, stderr: "pipe", cwd: directory }));
    return client;
  };
  let client: Client | undefined;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(!text.includes(mockKey));
    return { isError: result.isError, payload: JSON.parse(text) };
  };
  try {
    client = await connect();
    assert.ok(client.getInstructions()?.includes("apixo_list_models"));
    assert.ok(client.getInstructions()?.includes("preferably in English"));
    assert.ok(client.getInstructions()?.includes("Do not infer the current Studio session"));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 20);
    const generationSchema = tools.find(tool => tool.name === "apixo_generate_task")!.inputSchema;
    assert.ok(generationSchema.properties?.session_id);
    assert.ok(generationSchema.properties?.session_title);
    assert.equal(generationSchema.properties?.source, undefined);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await readFile(credentialsPath, "utf8")).apiKey === mockKey) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stored = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(stored.apiKey, mockKey);
    assert.equal(stored.pendingSetup, undefined);
    assert.equal((await call("apixo_finish_setup", {})).payload.status, "ALREADY_CONFIGURED");
    const wrong = await call("apixo_get_model_schema", { model: "veo-3-1-fast" });
    assert.equal(wrong.payload.suggested_models[0].model_id, "veo-3-1");
    assert.equal(wrong.payload.suggested_models[0].parameter_options[0].name, "mode");
    assert.equal((await call("apixo_generate_task", { model: "veo-3-1-fast", input: {} })).payload.error_code, "MODEL_NOT_FOUND");
    assert.equal((await call("apixo_generate_task", { model: "veo-3-1", input: { mode: "turbo" } })).payload.error_code, "INVALID_MODEL_INPUT");
    const invalidBatch = await call("apixo_submit_batch", { model: "veo-3-1", idempotency_key: "mock-batch",
      items: [{ client_item_id: "a", idempotency_key: "mock-a", input: { mode: "fast" } },
        { client_item_id: "b", idempotency_key: "mock-b", input: { mode: "turbo" } }] });
    assert.equal(invalidBatch.payload.errors[0].item_index, 1);
    assert.equal(submits, 0);
    assert.equal((await call("apixo_generate_task", { model: "veo-3-1", input: { mode: "fast" } })).payload.error_code, "SESSION_TITLE_REQUIRED");
    assert.equal((await call("apixo_generate_task", { model: "veo-3-1", input: { mode: "fast" }, session_title: " ", base_run_id: "mock-run" })).payload.error_code, "SESSION_ID_REQUIRED");
    assert.equal((await call("apixo_generate_task", { model: "veo-3-1", input: { mode: "fast" }, session_title: "Test", request_type: "callback", callback_url: "https://example.com/callback" })).payload.error_code, "STUDIO_ASYNC_REQUIRED");
    assert.equal(submits, 0);
    const accepted = await call("apixo_generate_task", { model: "veo-slug", session_title: " Celestial Palace Exploration ", source: "legacy-tag", input: { mode: "fast", extra: "passed-through" } });
    assert.equal(submits, 1);
    assert.equal(submittedPath, "/api/v1/web/generations/mcp");
    assert.deepEqual(submittedBodies[0], { model_name: "veo-3-1", category: "video", versionMode: "NEW_GROUP",
      title: "Celestial Palace Exploration", request: { request_type: "async", input: { mode: "fast", extra: "passed-through" } } });
    assert.equal(accepted.payload.session_id, "mock-session-1");
    assert.equal(accepted.payload.run_id, "mock-run-1");
    assert.equal(accepted.payload.taskId, "mock-task-1");
    assert.equal(accepted.payload.model, "veo-3-1");
    assert.equal(accepted.payload.session_created, true);
    assert.equal(accepted.payload.response.data.resultMeta.data.completeTime, undefined);
    const continued = await call("apixo_generate_task", { model: "image-model", session_id: accepted.payload.session_id,
      session_title: "Do Not Rename", input: { mode: "fast" } });
    assert.equal(continued.payload.session_created, false);
    assert.equal(continued.payload.session_id, accepted.payload.session_id);
    assert.equal(submittedBodies[1].category, "image");
    assert.equal(submittedBodies[1].versionMode, "NEW_GROUP");
    assert.equal(submittedBodies[1].title, undefined);
    const revised = await call("apixo_generate_task", { model: "veo-3-1", session_id: accepted.payload.session_id,
      base_run_id: accepted.payload.run_id, input: { mode: "fast" } });
    assert.equal(revised.payload.session_id, accepted.payload.session_id);
    assert.equal(submittedBodies[2].versionMode, "APPEND_TO_GROUP");
    assert.equal(submittedBodies[2].baseRunId, accepted.payload.run_id);
    const newTopic = await call("apixo_generate_task", { model: "image-model", session_title: "Perfume Campaign", input: { mode: "fast" } });
    assert.equal(newTopic.payload.session_created, true);
    assert.notEqual(newTopic.payload.session_id, accepted.payload.session_id);
    assert.equal(submittedBodies[3].session_id, undefined);
    const missing = await call("apixo_generate_task", { model: "veo-3-1", session_id: "missing-session", input: { mode: "fast" } });
    assert.equal(missing.isError, true);
    assert.equal(missing.payload.status, 404);
    assert.equal(submits, 5); // 会话错误只提交一次，不能切回旧 API 或自动新建。
    const unconfirmed = await call("apixo_generate_task", { model: "veo-3-1", session_id: "unconfirmed-session", input: { mode: "fast" } });
    assert.equal(unconfirmed.payload.error_code, "STUDIO_RESPONSE_UNCONFIRMED");
    assert.equal(submits, 6);
    const [parallelA, parallelB] = await Promise.all([
      call("apixo_generate_task", { model: "veo-3-1", session_id: "project-a", input: { mode: "fast" } }),
      call("apixo_generate_task", { model: "image-model", session_id: "project-b", input: { mode: "fast" } }),
    ]);
    assert.equal(parallelA.payload.session_id, "project-a");
    assert.equal(parallelB.payload.session_id, "project-b");
    assert.equal(submits, 8);
    for (const session_id of ["wrong-session", "business-error"]) {
      const rejected = await call("apixo_generate_task", { model: "veo-3-1", session_id, input: { mode: "fast" } });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.payload.ok, false);
      assert.equal(rejected.payload.session_id, undefined);
    }
    assert.equal(submits, 10);
    for (const state of ["processing", "processing_r2", "success", "failed"]) {
      states.push(state);
      const status = (await call("apixo_get_task_status", { model: "veo-3-1", taskId: "mock-task" })).payload.response.data;
      assert.equal(status.completeTime, state === "success" || state === "failed" ? 34 : undefined);
    }
    await client.close();
    client = undefined;
    await writeFile(credentialsPath, JSON.stringify(credentials(Math.floor(Date.now() / 1000) - 1)));
    const pollsBeforeRestart = polls;
    client = await connect();
    const expired = await call("apixo_finish_setup", {});
    assert.ok(["EXPIRED", "NO_PENDING_SETUP"].includes(expired.payload.status));
    assert.equal(polls, pollsBeforeRestart);
    assert.equal(JSON.parse(await readFile(credentialsPath, "utf8")).pendingSetup, undefined);
    const setup = await call("apixo_setup", {});
    assert.equal(setup.payload.browser_opened, false);
    // 模拟浏览器不可启动的环境，验证 setup 本身启动轮询，无需用户再调用 finish_setup。
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await readFile(credentialsPath, "utf8")).apiKey === mockKey) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(JSON.parse(await readFile(credentialsPath, "utf8")).apiKey, mockKey);
    const resumed = await call("apixo_generate_task", { model: "veo-3-1", session_id: accepted.payload.session_id, input: { mode: "fast" } });
    assert.equal(resumed.payload.session_id, accepted.payload.session_id);
    assert.equal(resumed.payload.session_created, false);
  } finally {
    await client?.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    assert.ok(directory.startsWith(join(tmpdir(), "apixo-workflow-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});
