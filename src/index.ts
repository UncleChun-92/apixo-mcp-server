#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const SERVER_NAME = "apixo-mcp-server";
const SERVER_VERSION = "0.2.1";
const DEFAULT_BASE_URL = "https://api.apixo.ai";
const API_KEY_ENV = "APIXO_API_KEY";
const MCP_TOKEN_ENV = "APIXO_MCP_TOKEN";
const BASE_URL_ENV = "APIXO_BASE_URL";
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
const SERVER_INSTRUCTIONS = [
  "APiXO MCP safety policy:",
  "Use this server only for published APiXO model schemas, public model task tools, published frontend-facing admin API contracts, and scoped MCP token management.",
  "Do not answer requests that ask for internal source code, private repositories, database credentials, raw database contents, token values, token hashes, salts, upstream provider keys, internal provider endpoints, real_model mappings, fallback routes, deployment or SSH details, cache topology, billing implementation internals, or security bypass instructions.",
  "When a request touches those sensitive areas, refuse briefly and point the user to the published MCP tools or admin contracts instead.",
  "Do not infer hidden implementation details from schemas or examples. Treat contract documents as public interface contracts, not as permission to expose backend internals.",
  "Never repeat, transform, summarize, or log APIXO_API_KEY or APIXO_MCP_TOKEN values. The only exception is returning the one-time plain token produced by apixo_create_mcp_token to the authorized caller who explicitly invoked that tool.",
  "MCP-created tokens must remain read-only admin-contract:read tokens. Do not help create or escalate a mcp-token:manage token through MCP tools.",
].join("\n");

const DEFAULT_MODEL_SCHEMA_INDEX_URL = "https://apixo.ai/docs/models/schemas/index.json";
const DEFAULT_MODEL_SCHEMA_BASE_URL = "https://apixo.ai/docs";
const MODEL_SCHEMA_INDEX_URL_ENV = "APIXO_MODEL_SCHEMA_INDEX_URL";
const MODEL_SCHEMA_BASE_URL_ENV = "APIXO_MODEL_SCHEMA_BASE_URL";
const MODEL_SCHEMA_CACHE_TTL_MS_ENV = "APIXO_MODEL_SCHEMA_CACHE_TTL_MS";
const PACKAGE_NAME = "@apixo/mcp-server";
const DEFAULT_UPDATE_CHECK_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const UPDATE_CHECK_ENABLED_ENV = "APIXO_UPDATE_CHECK_ENABLED";
const UPDATE_CHECK_URL_ENV = "APIXO_UPDATE_CHECK_URL";
const UPDATE_CHECK_TTL_MS_ENV = "APIXO_UPDATE_CHECK_TTL_MS";

const DEFAULT_MODEL_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

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

interface JsonFetchResult {
  ok: boolean;
  status: number;
  data?: unknown;
  rawText?: string;
  error?: string;
}

interface RuntimeConfig {
  apiKey: string | null;
  mcpToken: string | null;
  baseUrl: string;
}

interface ModelSchemaConfig {
  indexUrl: string;
  baseUrl: string;
  ttlMs: number;
}

interface UpdateCheckConfig {
  enabled: boolean;
  url: string;
  ttlMs: number;
}

interface ModelSchemaIndexEntry {
  model_id: string;
  slug: string;
  category: string;
  title: string;
  integration_type: string;
  schema_path: string;
  doc_path: string;
}

interface ModelSchemaIndexDoc {
  schema_version?: string;
  generated_at?: string;
  total_models: number;
  models: ModelSchemaIndexEntry[];
}

interface CachedModelSchemaIndex {
  expiresAt: number;
  payload: ModelSchemaIndexDoc;
}

interface UpdateStatusPayload {
  enabled: boolean;
  package_name: string;
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  checked_at: string;
  source: string;
  update_command: string | null;
  npx_hint: string;
}

interface CachedUpdateStatus {
  expiresAt: number;
  payload: UpdateStatusPayload;
}

let modelSchemaIndexCache: CachedModelSchemaIndex | null = null;
let updateStatusCache: CachedUpdateStatus | null = null;

function getRuntimeConfig(): RuntimeConfig {
  const apiKey = process.env[API_KEY_ENV]?.trim() ?? null;
  const mcpToken = process.env[MCP_TOKEN_ENV]?.trim() ?? null;
  const baseUrlRaw = process.env[BASE_URL_ENV]?.trim();
  const baseUrl = (baseUrlRaw && baseUrlRaw.length > 0 ? baseUrlRaw : DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    apiKey,
    mcpToken,
    baseUrl,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function getModelSchemaConfig(): ModelSchemaConfig {
  const indexUrlRaw = process.env[MODEL_SCHEMA_INDEX_URL_ENV]?.trim();
  const baseUrlRaw = process.env[MODEL_SCHEMA_BASE_URL_ENV]?.trim();
  const ttlRaw = process.env[MODEL_SCHEMA_CACHE_TTL_MS_ENV]?.trim();

  return {
    indexUrl: indexUrlRaw && indexUrlRaw.length > 0 ? indexUrlRaw : DEFAULT_MODEL_SCHEMA_INDEX_URL,
    baseUrl: (baseUrlRaw && baseUrlRaw.length > 0 ? baseUrlRaw : DEFAULT_MODEL_SCHEMA_BASE_URL).replace(/\/+$/, ""),
    ttlMs: parsePositiveInt(ttlRaw, DEFAULT_MODEL_SCHEMA_CACHE_TTL_MS),
  };
}

function getUpdateCheckConfig(): UpdateCheckConfig {
  const enabledRaw = process.env[UPDATE_CHECK_ENABLED_ENV]?.trim();
  const urlRaw = process.env[UPDATE_CHECK_URL_ENV]?.trim();
  const ttlRaw = process.env[UPDATE_CHECK_TTL_MS_ENV]?.trim();

  return {
    enabled: parseBoolean(enabledRaw, true),
    url: urlRaw && urlRaw.length > 0 ? urlRaw : DEFAULT_UPDATE_CHECK_URL,
    ttlMs: parsePositiveInt(ttlRaw, DEFAULT_UPDATE_CHECK_TTL_MS),
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

async function missingKeyResult() {
  return toTextResultWithUpdate(
    {
      ok: false,
      error: `Missing API key. Set ${API_KEY_ENV} before starting the MCP server.`,
    },
    true,
  );
}

async function missingMcpTokenResult() {
  return toTextResultWithUpdate(
    {
      ok: false,
      error: `Missing MCP token. Set ${MCP_TOKEN_ENV} before calling admin contract or MCP token management tools.`,
    },
    true,
  );
}

async function fetchJson(url: string): Promise<JsonFetchResult> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        rawText,
        error: `HTTP ${response.status}`,
      };
    }

    try {
      const parsed = JSON.parse(rawText) as unknown;
      return {
        ok: true,
        status: response.status,
        data: parsed,
        rawText,
      };
    } catch {
      return {
        ok: false,
        status: response.status,
        rawText,
        error: "Invalid JSON response.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Unknown network error",
    };
  }
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }

  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i += 1) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    if (aPart == null) {
      return -1;
    }
    if (bPart == null) {
      return 1;
    }
    if (aPart === bPart) {
      continue;
    }

    const aNum = Number.parseInt(aPart, 10);
    const bNum = Number.parseInt(bPart, 10);
    const aIsNum = Number.isFinite(aNum) && `${aNum}` === aPart;
    const bIsNum = Number.isFinite(bNum) && `${bNum}` === bPart;

    if (aIsNum && bIsNum) {
      return aNum > bNum ? 1 : -1;
    }
    if (aIsNum && !bIsNum) {
      return -1;
    }
    if (!aIsNum && bIsNum) {
      return 1;
    }

    return aPart > bPart ? 1 : -1;
  }

  return 0;
}

function compareVersions(a: string, b: string): number {
  const aParsed = parseSemver(a);
  const bParsed = parseSemver(b);

  if (!aParsed || !bParsed) {
    if (a === b) {
      return 0;
    }
    return a > b ? 1 : -1;
  }

  if (aParsed.major !== bParsed.major) {
    return aParsed.major > bParsed.major ? 1 : -1;
  }
  if (aParsed.minor !== bParsed.minor) {
    return aParsed.minor > bParsed.minor ? 1 : -1;
  }
  if (aParsed.patch !== bParsed.patch) {
    return aParsed.patch > bParsed.patch ? 1 : -1;
  }

  return comparePrerelease(aParsed.prerelease, bParsed.prerelease);
}

function buildUpdateCommand(): string {
  return `npm install -g ${PACKAGE_NAME}@latest`;
}

async function loadUpdateStatus(forceRefresh = false): Promise<
  | { ok: true; payload: UpdateStatusPayload; cacheExpiresAt: number }
  | { ok: false; error: string; status: number; source: string; response?: unknown }
> {
  const cfg = getUpdateCheckConfig();
  const now = Date.now();

  if (!cfg.enabled) {
    return {
      ok: true,
      payload: {
        enabled: false,
        package_name: PACKAGE_NAME,
        current_version: SERVER_VERSION,
        latest_version: null,
        update_available: false,
        checked_at: new Date(now).toISOString(),
        source: cfg.url,
        update_command: null,
        npx_hint: "Update checks are disabled by configuration.",
      },
      cacheExpiresAt: now + cfg.ttlMs,
    };
  }

  if (!forceRefresh && updateStatusCache && updateStatusCache.expiresAt > now) {
    return {
      ok: true,
      payload: updateStatusCache.payload,
      cacheExpiresAt: updateStatusCache.expiresAt,
    };
  }

  const fetched = await fetchJson(cfg.url);
  if (!fetched.ok) {
    if (Number(fetched.status) === 404) {
      const payload: UpdateStatusPayload = {
        enabled: true,
        package_name: PACKAGE_NAME,
        current_version: SERVER_VERSION,
        latest_version: null,
        update_available: false,
        checked_at: new Date(now).toISOString(),
        source: cfg.url,
        update_command: null,
        npx_hint: "Package is not published to npm yet. Update reminders will activate after first publish.",
      };

      const expiresAt = now + cfg.ttlMs;
      updateStatusCache = {
        expiresAt,
        payload,
      };

      return {
        ok: true,
        payload,
        cacheExpiresAt: expiresAt,
      };
    }

    return {
      ok: false,
      error: fetched.error ?? "Failed to fetch latest package version.",
      status: fetched.status,
      source: cfg.url,
      response: fetched.rawText ?? null,
    };
  }

  const rawData = fetched.data;
  const latestVersion =
    rawData && typeof rawData === "object" && "version" in rawData && typeof rawData.version === "string"
      ? rawData.version
      : null;

  if (!latestVersion) {
    return {
      ok: false,
      error: "Latest package metadata does not include a version field.",
      status: fetched.status,
      source: cfg.url,
      response: rawData ?? fetched.rawText ?? null,
    };
  }

  const updateAvailable = compareVersions(latestVersion, SERVER_VERSION) > 0;
  const payload: UpdateStatusPayload = {
    enabled: true,
    package_name: PACKAGE_NAME,
    current_version: SERVER_VERSION,
    latest_version: latestVersion,
    update_available: updateAvailable,
    checked_at: new Date(now).toISOString(),
    source: cfg.url,
    update_command: updateAvailable ? buildUpdateCommand() : null,
    npx_hint: updateAvailable
      ? "If the server is launched with npx, restart your MCP client session to pick up the new version."
      : "Current version is up to date.",
  };

  const expiresAt = now + cfg.ttlMs;
  updateStatusCache = {
    expiresAt,
    payload,
  };

  return {
    ok: true,
    payload,
    cacheExpiresAt: expiresAt,
  };
}

async function toTextResultWithUpdate(payload: JsonObject, isError = false) {
  const resultPayload: JsonObject = { ...payload };
  const updateStatus = await loadUpdateStatus(false);

  if (updateStatus.ok) {
    if (updateStatus.payload.update_available) {
      resultPayload.update_notice = {
        ...updateStatus.payload,
        cache_expires_at: new Date(updateStatus.cacheExpiresAt).toISOString(),
      };
    }
  }

  return toTextResult(resultPayload, isError);
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

async function apixoMcpRequest(
  cfg: RuntimeConfig,
  path: string,
  options?: {
    query?: Record<string, string>;
  },
): Promise<ApixoRequestResult> {
  return apixoMcpApiRequest(cfg, "GET", path, options);
}

async function apixoMcpApiRequest(
  cfg: RuntimeConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options?: {
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<ApixoRequestResult> {
  if (!cfg.mcpToken) {
    return {
      ok: false,
      status: 0,
      error: `Missing ${MCP_TOKEN_ENV}`,
    };
  }

  const url = new URL(path, `${cfg.baseUrl}/`);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value.trim().length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        "X-MCP-TOKEN": cfg.mcpToken,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: method === "GET" ? undefined : JSON.stringify(options?.body ?? {}),
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

async function loadModelSchemaIndex(forceRefresh = false): Promise<
  | { ok: true; payload: ModelSchemaIndexDoc; sourceUrl: string; cacheExpiresAt: number }
  | { ok: false; error: string; status?: number; sourceUrl: string; response?: unknown }
> {
  const cfg = getModelSchemaConfig();
  const now = Date.now();

  if (!forceRefresh && modelSchemaIndexCache && modelSchemaIndexCache.expiresAt > now) {
    return {
      ok: true,
      payload: modelSchemaIndexCache.payload,
      sourceUrl: cfg.indexUrl,
      cacheExpiresAt: modelSchemaIndexCache.expiresAt,
    };
  }

  const fetched = await fetchJson(cfg.indexUrl);
  if (!fetched.ok) {
    return {
      ok: false,
      error: fetched.error ?? "Failed to fetch model schema index.",
      status: fetched.status,
      sourceUrl: cfg.indexUrl,
      response: fetched.rawText ?? null,
    };
  }

  const data = fetched.data;
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      error: "Model schema index payload is not an object.",
      status: fetched.status,
      sourceUrl: cfg.indexUrl,
      response: fetched.rawText ?? null,
    };
  }

  const payload = data as ModelSchemaIndexDoc;
  if (!Array.isArray(payload.models)) {
    return {
      ok: false,
      error: "Model schema index is missing models array.",
      status: fetched.status,
      sourceUrl: cfg.indexUrl,
      response: data,
    };
  }

  const expiresAt = now + cfg.ttlMs;
  modelSchemaIndexCache = {
    expiresAt,
    payload,
  };

  return {
    ok: true,
    payload,
    sourceUrl: cfg.indexUrl,
    cacheExpiresAt: expiresAt,
  };
}

function findModelIndexEntry(index: ModelSchemaIndexDoc, model: string): ModelSchemaIndexEntry | null {
  const lookup = model.trim().toLowerCase();
  if (lookup.length === 0) {
    return null;
  }

  for (const item of index.models) {
    if (item.model_id.toLowerCase() === lookup) {
      return item;
    }
  }

  for (const item of index.models) {
    if (item.slug.toLowerCase() === lookup) {
      return item;
    }
  }

  return null;
}

async function loadModelSchemaByPath(schemaPath: string): Promise<JsonFetchResult> {
  const cfg = getModelSchemaConfig();
  const fullUrl = /^https?:\/\//i.test(schemaPath)
    ? schemaPath
    : new URL(schemaPath.replace(/^\/+/, ""), `${cfg.baseUrl}/`).toString();

  return fetchJson(fullUrl);
}

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

server.registerTool(
  "apixo_list_models",
  {
    title: "List Models",
    description: "List APiXO models from the published model schema index.",
    inputSchema: {
      category: z.string().optional().describe("Optional category filter, e.g. image, video, audio, text."),
      integration_type: z.string().optional().describe("Optional filter, e.g. task_api or llm_gateway."),
      force_refresh: z.boolean().optional().describe("When true, bypass in-memory cache and fetch latest index."),
    },
  },
  async ({ category, integration_type, force_refresh }) => {
    const loaded = await loadModelSchemaIndex(force_refresh ?? false);
    if (!loaded.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: loaded.error,
          status: loaded.status ?? 0,
          source: loaded.sourceUrl,
          response: loaded.response ?? null,
        },
        true,
      );
    }

    const normalizedCategory = category?.trim().toLowerCase();
    const normalizedIntegrationType = integration_type?.trim().toLowerCase();

    const filtered = loaded.payload.models.filter((model) => {
      if (normalizedCategory && model.category.toLowerCase() !== normalizedCategory) {
        return false;
      }

      if (normalizedIntegrationType && model.integration_type.toLowerCase() !== normalizedIntegrationType) {
        return false;
      }

      return true;
    });

    return toTextResultWithUpdate({
      ok: true,
      source: loaded.sourceUrl,
      cache_expires_at: new Date(loaded.cacheExpiresAt).toISOString(),
      total_models: loaded.payload.total_models,
      returned_models: filtered.length,
      models: filtered,
    });
  },
);

server.registerTool(
  "apixo_get_model_schema",
  {
    title: "Get Model Schema",
    description: "Fetch one APiXO model schema document by model_id or slug.",
    inputSchema: {
      model: z.string().min(1).describe("Model ID or slug, e.g. kling-2-6 or nano-banana."),
      force_refresh: z.boolean().optional().describe("When true, refresh schema index before lookup."),
    },
  },
  async ({ model, force_refresh }) => {
    const loaded = await loadModelSchemaIndex(force_refresh ?? false);
    if (!loaded.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: loaded.error,
          status: loaded.status ?? 0,
          source: loaded.sourceUrl,
          response: loaded.response ?? null,
        },
        true,
      );
    }

    const matched = findModelIndexEntry(loaded.payload, model);
    if (!matched) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: `Model not found in schema index: ${model}`,
          source: loaded.sourceUrl,
          hint: "Use apixo_list_models to inspect available model_id and slug values.",
        },
        true,
      );
    }

    const fetched = await loadModelSchemaByPath(matched.schema_path);
    if (!fetched.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: fetched.error ?? "Failed to fetch model schema file.",
          status: fetched.status,
          schema_path: matched.schema_path,
          response: fetched.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      index_source: loaded.sourceUrl,
      model: matched,
      schema: fetched.data,
    });
  },
);

server.registerTool(
  "apixo_list_admin_contracts",
  {
    title: "List Admin API Contracts",
    description:
      "List published frontend-facing admin API contracts from APiXO. Uses APIXO_MCP_TOKEN and does not affect public model API tools.",
    inputSchema: {
      module: z.string().optional().describe("Optional admin module filter, e.g. api-key-admin."),
      query: z.string().optional().describe("Optional text search across contract key, module, title, and description."),
    },
  },
  async ({ module, query }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const q: Record<string, string> = {};
    if (module) {
      q.module = module;
    }
    if (query) {
      q.q = query;
    }

    const result = await apixoMcpRequest(cfg, "/api/mcp/contracts", { query: q });
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to list APiXO admin API contracts.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: "/api/mcp/contracts",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_get_admin_contract",
  {
    title: "Get Admin API Contract",
    description:
      "Fetch one published frontend-facing admin API contract by contract key. Uses APIXO_MCP_TOKEN.",
    inputSchema: {
      contract_key: z.string().min(1).describe("Contract key, e.g. admin.api-key.status."),
    },
  },
  async ({ contract_key }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const result = await apixoMcpRequest(cfg, `/api/mcp/contracts/${encodeURIComponent(contract_key)}`);
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to fetch APiXO admin API contract.",
          status: result.status,
          contract_key,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: `/api/mcp/contracts/${contract_key}`,
      contract_key,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_search_admin_contracts",
  {
    title: "Search Admin API Contracts",
    description:
      "Search published frontend-facing admin API contracts. Uses APIXO_MCP_TOKEN and returns only contracts allowed for that MCP key.",
    inputSchema: {
      query: z.string().min(1).describe("Search text."),
      module: z.string().optional().describe("Optional admin module filter."),
    },
  },
  async ({ query, module }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const q: Record<string, string> = { q: query };
    if (module) {
      q.module = module;
    }

    const result = await apixoMcpRequest(cfg, "/api/mcp/contracts/search", { query: q });
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to search APiXO admin API contracts.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: "/api/mcp/contracts/search",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_list_mcp_users",
  {
    title: "List MCP Users",
    description:
      "List MCP admin users. Requires APIXO_MCP_TOKEN with mcp-token:manage scope.",
  },
  async () => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const result = await apixoMcpApiRequest(cfg, "GET", "/api/mcp/admin/users");
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to list APiXO MCP users.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: "/api/mcp/admin/users",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_create_mcp_user",
  {
    title: "Create MCP User",
    description:
      "Create an MCP admin user. Requires APIXO_MCP_TOKEN with mcp-token:manage scope.",
    inputSchema: {
      name: z.string().min(1).describe("MCP admin user name."),
      email: z.string().optional().describe("Optional email."),
      department: z.string().optional().describe("Optional department or team."),
      remark: z.string().optional().describe("Optional note."),
    },
  },
  async ({ name, email, department, remark }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const result = await apixoMcpApiRequest(cfg, "POST", "/api/mcp/admin/users", {
      body: {
        name,
        email,
        department,
        remark,
      },
    });
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to create APiXO MCP user.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: "/api/mcp/admin/users",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_list_mcp_user_keys",
  {
    title: "List MCP User Keys",
    description:
      "List MCP keys for one MCP admin user. Requires APIXO_MCP_TOKEN with mcp-token:manage scope.",
    inputSchema: {
      user_id: z.string().min(1).describe("MCP admin user id."),
    },
  },
  async ({ user_id }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const path = `/api/mcp/admin/users/${encodeURIComponent(user_id)}/keys`;
    const result = await apixoMcpApiRequest(cfg, "GET", path);
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to list APiXO MCP user keys.",
          status: result.status,
          user_id,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: path,
      user_id,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_create_mcp_token",
  {
    title: "Create MCP Token",
    description:
      "Create a read-only MCP token for one MCP admin user. Requires APIXO_MCP_TOKEN with mcp-token:manage scope. The plain token is returned once.",
    inputSchema: {
      user_id: z.string().min(1).describe("MCP admin user id."),
      name: z.string().min(1).describe("Key name, e.g. frontend-codex."),
      allowed_modules: z
        .array(z.string().min(1))
        .optional()
        .describe("Contract modules this token can read. Defaults to ['*']."),
      expires_at: z
        .string()
        .optional()
        .describe("Optional ISO local datetime, e.g. 2026-12-31T23:59:59."),
    },
  },
  async ({ user_id, name, allowed_modules, expires_at }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const path = `/api/mcp/admin/users/${encodeURIComponent(user_id)}/keys`;
    const result = await apixoMcpApiRequest(cfg, "POST", path, {
      body: {
        name,
        scopes: ["admin-contract:read"],
        allowedModules: allowed_modules && allowed_modules.length > 0 ? allowed_modules : ["*"],
        expiresAt: expires_at,
      },
    });
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to create APiXO MCP token.",
          status: result.status,
          user_id,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: path,
      user_id,
      response: result.envelope ?? result.rawText ?? null,
      granted_scopes: ["admin-contract:read"],
      warning: "plainToken is visible once. Store it securely and do not commit it.",
    });
  },
);

server.registerTool(
  "apixo_revoke_mcp_token",
  {
    title: "Revoke MCP Token",
    description:
      "Revoke one MCP token by key id. Requires APIXO_MCP_TOKEN with mcp-token:manage scope. The current calling token cannot revoke itself.",
    inputSchema: {
      key_id: z.string().min(1).describe("MCP key id to revoke."),
    },
  },
  async ({ key_id }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const path = `/api/mcp/admin/keys/${encodeURIComponent(key_id)}/revoke`;
    const result = await apixoMcpApiRequest(cfg, "PATCH", path);
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to revoke APiXO MCP token.",
          status: result.status,
          key_id,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: path,
      key_id,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_disable_mcp_user",
  {
    title: "Disable MCP User",
    description:
      "Disable one MCP admin user and evict that user's token caches. Requires APIXO_MCP_TOKEN with mcp-token:manage scope. The current calling user cannot disable itself.",
    inputSchema: {
      user_id: z.string().min(1).describe("MCP admin user id to disable."),
    },
  },
  async ({ user_id }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const path = `/api/mcp/admin/users/${encodeURIComponent(user_id)}/disable`;
    const result = await apixoMcpApiRequest(cfg, "PATCH", path);
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to disable APiXO MCP user.",
          status: result.status,
          user_id,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: path,
      user_id,
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

server.registerTool(
  "apixo_list_mcp_access_logs",
  {
    title: "List MCP Access Logs",
    description:
      "List recent MCP contract and token-management access logs. Requires APIXO_MCP_TOKEN with mcp-token:manage scope.",
  },
  async () => {
    const cfg = getRuntimeConfig();
    if (!cfg.mcpToken) {
      return missingMcpTokenResult();
    }

    const result = await apixoMcpApiRequest(cfg, "GET", "/api/mcp/admin/access-logs");
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to list APiXO MCP access logs.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: "/api/mcp/admin/access-logs",
      response: result.envelope ?? result.rawText ?? null,
    });
  },
);

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
      return toTextResultWithUpdate(
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
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO generate task endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
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
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO status endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
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
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO balance endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
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

  const schemaCfg = getModelSchemaConfig();
  console.error(`[${SERVER_NAME}] Model schema index source: ${schemaCfg.indexUrl} (cache ${schemaCfg.ttlMs}ms)`);

  const updateStatus = await loadUpdateStatus(false);
  if (updateStatus.ok && updateStatus.payload.update_available) {
    console.error(
      `[${SERVER_NAME}] Update available: ${updateStatus.payload.current_version} -> ${updateStatus.payload.latest_version}.`,
    );
    if (updateStatus.payload.update_command) {
      console.error(`[${SERVER_NAME}] Recommended update command: ${updateStatus.payload.update_command}`);
    }
    console.error(`[${SERVER_NAME}] ${updateStatus.payload.npx_hint}`);
  }
  if (!updateStatus.ok) {
    console.error(
      `[${SERVER_NAME}] Version check failed (${updateStatus.status}): ${updateStatus.error}. Source: ${updateStatus.source}`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} started on stdio`);
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
