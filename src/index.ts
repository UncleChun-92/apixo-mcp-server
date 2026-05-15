#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const SERVER_NAME = "apixo-mcp-server";
const SERVER_VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://api.apixo.ai";
const API_KEY_ENV = "APIXO_API_KEY";
const BASE_URL_ENV = "APIXO_BASE_URL";
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

type JsonObject = Record<string, unknown>;

interface ApixoEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface ApixoRequestResult {
  ok: boolean;
  status: number;
  envelope?: ApixoEnvelope;
  rawText?: string;
  error?: string;
}

interface RuntimeConfig {
  apiKey: string | null;
  baseUrl: string;
}

function getRuntimeConfig(): RuntimeConfig {
  const apiKey = process.env[API_KEY_ENV]?.trim() ?? null;
  const baseUrlRaw = process.env[BASE_URL_ENV]?.trim();
  const baseUrl = (baseUrlRaw && baseUrlRaw.length > 0 ? baseUrlRaw : DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    apiKey,
    baseUrl,
  };
}

function toTextResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function missingKeyResult() {
  return toTextResult(
    {
      ok: false,
      error: `Missing API key. Set ${API_KEY_ENV} before starting the MCP server.`,
    },
    true,
  );
}

async function apixoRequest(
  cfg: RuntimeConfig,
  method: "GET" | "POST",
  path: string,
  options?: {
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<ApixoRequestResult> {
  if (!cfg.apiKey) {
    return {
      ok: false,
      status: 0,
      error: `Missing ${API_KEY_ENV}`,
    };
  }

  const url = new URL(path, `${cfg.baseUrl}/`);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: method === "POST" ? JSON.stringify(options?.body ?? {}) : undefined,
    });

    const rawText = await response.text();
    let envelope: ApixoEnvelope | undefined;

    if (rawText) {
      try {
        envelope = JSON.parse(rawText) as ApixoEnvelope;
      } catch {
        envelope = undefined;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        envelope,
        rawText,
        error: `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      envelope,
      rawText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Unknown network error",
    };
  }
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "apixo_generate_task",
  {
    title: "Generate Task",
    description: "Submit an APiXO generation task with model-specific input parameters.",
    inputSchema: {
      model: z.string().min(1).describe("Model ID, such as nano-banana, flux-2, or sora-2."),
      input: z
        .record(z.string(), z.unknown())
        .describe("Model-specific input payload. Example: { mode, prompt, aspect_ratio }."),
      request_type: z.enum(["async", "callback"]).optional().describe("Result mode. Defaults to async."),
      callback_url: z.string().url().optional().describe("Required when request_type is callback."),
      source: z.string().optional().describe("Optional source tag."),
    },
  },
  async ({ model, input, request_type, callback_url, source }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const finalRequestType = request_type ?? "async";
    if (finalRequestType === "callback" && !callback_url) {
      return toTextResult(
        {
          ok: false,
          error: "callback_url is required when request_type is callback.",
        },
        true,
      );
    }

    const payload: JsonObject = {
      request_type: finalRequestType,
      input,
    };
    if (callback_url) {
      payload.callback_url = callback_url;
    }
    if (source) {
      payload.source = source;
    }

    const result = await apixoRequest(cfg, "POST", `/api/v1/generateTask/${encodeURIComponent(model)}`, {
      body: payload,
    });

    if (!result.ok) {
      return toTextResult(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO generate task endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResult({
      ok: true,
      endpoint: `/api/v1/generateTask/${model}`,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_get_task_status",
  {
    title: "Get Task Status",
    description: "Fetch APiXO task status and result for a taskId.",
    inputSchema: {
      model: z.string().min(1).describe("Model ID used to submit the task."),
      taskId: z.string().min(1).describe("Task ID returned by generate_task."),
    },
  },
  async ({ model, taskId }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const result = await apixoRequest(cfg, "GET", `/api/v1/statusTask/${encodeURIComponent(model)}`, {
      query: { taskId },
    });

    if (!result.ok) {
      return toTextResult(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO status endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResult({
      ok: true,
      endpoint: `/api/v1/statusTask/${model}`,
      taskId,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_get_balance",
  {
    title: "Get Current Balance",
    description: "Get current APiXO balance for the configured API key.",
  },
  async () => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const result = await apixoRequest(cfg, "GET", "/api/v1/apikeys/current-balance");
    if (!result.ok) {
      return toTextResult(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO balance endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResult({
      ok: true,
      endpoint: "/api/v1/apikeys/current-balance",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

async function main(): Promise<void> {
  const cfg = getRuntimeConfig();
  if (!cfg.apiKey) {
    console.error(`[${SERVER_NAME}] Warning: ${API_KEY_ENV} is not set. Tool calls will fail until it is provided.`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} started on stdio`);
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
