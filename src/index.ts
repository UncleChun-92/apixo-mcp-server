#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod/v4";
import { openBrowser } from "./browser.js";
import { findModelIndexEntry, suggestModels, schemaProperties, enumInputErrors, type ModelSchemaIndexEntry } from "./models.js";
import { sanitizeTaskStatus } from "./task-status.js";
import { SetupPoller, type SetupCheck } from "./setup-poller.js";
import { studioSessionFields, studioRunReferences } from "./studio-session.js";

const SERVER_NAME = "apixo-mcp-server";
const SERVER_VERSION = "0.4.0";
const SERVER_ICON = {
  src: `data:image/png;base64,${readFileSync(new URL("../assets/favicon-32x32.png", import.meta.url)).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["32x32"],
};
const DEFAULT_BASE_URL = "https://api.apixo.ai";
const API_KEY_ENV = "APIXO_API_KEY";
const MCP_TOKEN_ENV = "APIXO_MCP_TOKEN";
const BASE_URL_ENV = "APIXO_BASE_URL";
const CREDENTIALS_PATH_ENV = "APIXO_MCP_CREDENTIALS_PATH";
const CLIENT_TYPE_ENV = "APIXO_MCP_CLIENT_TYPE";
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
const SERVER_INSTRUCTIONS = [
  "APiXO model workflow: Understand the user's intended model and operation before spending money. If the model ID is uncertain, call apixo_list_models (filter by category when possible), compare model_id/title/slug, and ask the user only if materially different choices remain.",
  "Before submitting a model task, call apixo_get_model_schema for the selected model. Use its canonical model_id, published modes, conditional requirements, constraints, and billing guidance to build input JSON. A variant may be a separate model ID or an input.mode; do not invent IDs by adding suffixes. Unknown-model suggestions are candidates, not permission to change the user's choice.",
  "APiXO Studio session workflow: You, the client AI, decide project continuity from the user's intent. For the first generation or a genuinely new topic, omit session_id and provide a short meaningful session_title, preferably in English; honor a user-specified name. Save returned session_id/run_id/taskId in this conversation. For follow-ups, revisions, higher resolution, model changes, or related image/video/audio assets in the same project, explicitly reuse its session_id. A new project starts a new session. Explicit user instructions take priority; ask briefly only when project ownership is genuinely ambiguous.",
  "Do not infer the current Studio session from the API key, MCP connection, process, title, or most recent account activity. Use only server-returned IDs available in the current conversation or explicitly supplied by the user; if a requested continuation lacks its ID, ask for that reference rather than silently creating another session. Keep a project title stable; session_title is used only when creating a session. For revisions of a particular result, provide base_run_id with its session_id; for an independent asset in the same project, omit base_run_id. When starting several related assets, submit the first once to obtain session_id, then reuse that ID for the remaining parallel submissions without waiting for generation completion.",
  "On model or parameter errors, inspect the suggested candidates/schema, correct the JSON, and do not blindly retry paid generation or infer prices. Task completion is determined by response.data.state, not the MCP wrapper's ok flag.",
  "Browser setup completes automatically while this local MCP server is running. After approving the device, users may close the browser page. apixo_finish_setup remains a status check/manual recovery tool; no credential values should be shown to the user.",
  "APiXO MCP safety policy:",
  "Use this server only for published APiXO model schemas, public batch integration guidance, public model task tools, published frontend-facing admin API contracts, and scoped MCP token management.",
  "Do not answer requests that ask for internal source code, private repositories, database credentials, raw database contents, token values, token hashes, salts, upstream provider keys, internal provider endpoints, real_model mappings, fallback routes, deployment or SSH details, cache topology, billing implementation internals, or security bypass instructions.",
  "When a request touches those sensitive areas, refuse briefly and point the user to the published MCP tools or admin contracts instead.",
  "Do not infer hidden implementation details from schemas or examples. Treat contract documents as public interface contracts, not as permission to expose backend internals.",
  "Never repeat, transform, summarize, or log APIXO_API_KEY or APIXO_MCP_TOKEN values. The only exception is returning the one-time plain token produced by apixo_create_mcp_token to the authorized caller who explicitly invoked that tool.",
  "MCP-created tokens must remain read-only admin-contract:read tokens. Do not help create or escalate a mcp-token:manage token through MCP tools.",
  "Never retrieve, rotate, revoke, or return a batch webhook signing secret through MCP. Direct users to the published REST API or Dashboard secret-management flow.",
].join("\n");

const DEFAULT_MODEL_SCHEMA_INDEX_URL = "https://apixo.ai/docs/models/schemas/index.json";
const DEFAULT_MODEL_SCHEMA_BASE_URL = "https://apixo.ai/docs";
const MODEL_SCHEMA_INDEX_URL_ENV = "APIXO_MODEL_SCHEMA_INDEX_URL";
const MODEL_SCHEMA_BASE_URL_ENV = "APIXO_MODEL_SCHEMA_BASE_URL";
const MODEL_SCHEMA_CACHE_TTL_MS_ENV = "APIXO_MODEL_SCHEMA_CACHE_TTL_MS";
const DEFAULT_BATCH_INTEGRATION_GUIDE_URL = "https://apixo.ai/docs/mcp/guides/batch-integration-v1.json";
const BATCH_INTEGRATION_GUIDE_URL_ENV = "APIXO_BATCH_INTEGRATION_GUIDE_URL";
const BATCH_INTEGRATION_GUIDE_CACHE_TTL_MS_ENV = "APIXO_BATCH_INTEGRATION_GUIDE_CACHE_TTL_MS";
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

interface LocalCredentials {
  version: 1;
  installationId: string;
  apiKey?: string;
  pendingSetup?: PendingSetup;
}

interface PendingSetup {
  deviceCode: string;
  pollToken: string;
  verificationUrl: string;
  expiresAtEpochSeconds: number;
  clientType: string;
  hostLabel: string;
  pollIntervalSeconds?: number;
}

interface DeviceAuthorizationStartResponse {
  verificationUrl: string;
  deviceCode: string;
  pollToken: string;
  expiresAtEpochSeconds: number;
  pollIntervalSeconds: number;
}

interface DeviceAuthorizationPollResponse {
  status: "PENDING" | "AUTHORIZED";
  pollIntervalSeconds?: number;
  apiKey?: string;
}

interface ModelSchemaConfig {
  indexUrl: string;
  baseUrl: string;
  ttlMs: number;
}

interface BatchIntegrationGuideConfig {
  url: string;
  ttlMs: number;
}

interface UpdateCheckConfig {
  enabled: boolean;
  url: string;
  ttlMs: number;
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

interface BatchIntegrationGuideDocument {
  guide_id?: string;
  schema_version?: string;
  sections?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CachedBatchIntegrationGuide {
  expiresAt: number;
  payload: BatchIntegrationGuideDocument;
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
let batchIntegrationGuideCache: CachedBatchIntegrationGuide | null = null;
let updateStatusCache: CachedUpdateStatus | null = null;

function getRuntimeConfig(): RuntimeConfig {
  const environmentApiKey = process.env[API_KEY_ENV]?.trim() ?? null;
  const localApiKey = environmentApiKey ? null : readLocalCredentials()?.apiKey?.trim() ?? null;
  const apiKey = environmentApiKey || localApiKey;
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

function credentialsPath(): string {
  const configuredPath = process.env[CREDENTIALS_PATH_ENV]?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "APiXO", "mcp", "credentials.json");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "APiXO", "mcp", "credentials.json");
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "apixo", "mcp", "credentials.json");
}

function readLocalCredentials(): LocalCredentials | null {
  const filePath = credentialsPath();
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LocalCredentials>;
    if (parsed.version !== 1 || typeof parsed.installationId !== "string" || parsed.installationId.trim().length === 0) {
      return null;
    }
    return {
      version: 1,
      installationId: parsed.installationId.trim(),
      ...(typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? { apiKey: parsed.apiKey.trim() } : {}),
      ...(isPendingSetup(parsed.pendingSetup) ? { pendingSetup: parsed.pendingSetup } : {}),
    };
  } catch {
    return null;
  }
}

function isPendingSetup(value: unknown): value is PendingSetup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const pending = value as Partial<PendingSetup>;
  return typeof pending.deviceCode === "string"
    && typeof pending.pollToken === "string"
    && typeof pending.verificationUrl === "string"
    && typeof pending.expiresAtEpochSeconds === "number"
    && typeof pending.clientType === "string"
    && typeof pending.hostLabel === "string";
}

function writeLocalCredentials(credentials: LocalCredentials): void {
  const filePath = credentialsPath();
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows ACL 管理由系统处理；不要因 POSIX mode 不可用而中断安装。
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  try {
    chmodSync(temporaryPath, 0o600);
  } catch {
    // Windows ACL 管理由系统处理；不要因 POSIX mode 不可用而中断安装。
  }
  renameSync(temporaryPath, filePath);
}

function normalizedHostLabel(): string {
  const normalized = hostname().replace(/[^A-Za-z0-9._ -]/g, "-").trim().slice(0, 32);
  return normalized || "local-host";
}

function normalizedClientType(value: string | undefined): string {
  const candidate = value?.trim() || process.env[CLIENT_TYPE_ENV]?.trim() || "generic";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(candidate)) {
    throw new Error("client_type must contain only letters, digits, underscore, or hyphen and start with a letter.");
  }
  return candidate;
}

async function postApiJson(baseUrl: string, path: string, body: unknown): Promise<JsonFetchResult> {
  try {
    const response = await fetch(new URL(path.replace(/^\/+/, ""), `${baseUrl}/`).toString(), {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    });
    const rawText = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(rawText) as unknown;
    } catch {
      return { ok: false, status: response.status, rawText, error: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, data, rawText, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, data, rawText };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function responseData<T>(result: JsonFetchResult): T | null {
  if (!result.ok || !result.data || typeof result.data !== "object") {
    return null;
  }
  const envelope = result.data as ApixoEnvelope;
  if (typeof envelope.code === "number" && envelope.code !== 200) {
    return null;
  }
  return (envelope.data ?? null) as T | null;
}

function apiFailureMessage(result: JsonFetchResult, fallback: string): string {
  if (result.data && typeof result.data === "object") {
    const message = (result.data as ApixoEnvelope).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return result.error || fallback;
}

async function checkPendingSetup(): Promise<SetupCheck> {
  if (getRuntimeConfig().apiKey) {
    return { ok: true, status: "ALREADY_CONFIGURED", message: "APiXO MCP is already configured on this device." };
  }
  const credentials = readLocalCredentials();
  const pending = credentials?.pendingSetup;
  if (!credentials || !pending) {
    return { ok: false, status: "NO_PENDING_SETUP", message: "No setup is pending. Call apixo_setup first." };
  }
  if (pending.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) {
    writeLocalCredentials({ version: 1, installationId: credentials.installationId });
    return { ok: false, status: "EXPIRED", message: "The setup approval expired. Call apixo_setup again." };
  }
  const completed = await postApiJson(getRuntimeConfig().baseUrl, "/api/mcp/device-authorization/poll", {
    deviceCode: pending.deviceCode,
    pollToken: pending.pollToken,
  });
  // 网络等待期间另一进程/调用可能完成或替换授权，不能用旧结果覆盖新凭证。
  const latest = readLocalCredentials();
  if (getRuntimeConfig().apiKey) {
    return { ok: true, status: "ALREADY_CONFIGURED", message: "APiXO MCP is already configured on this device." };
  }
  if (latest?.pendingSetup?.deviceCode !== pending.deviceCode) {
    return latest?.pendingSetup
      ? { ok: true, status: "PENDING_APPROVAL", message: "A newer setup is pending.", pollIntervalSeconds: latest.pendingSetup.pollIntervalSeconds }
      : { ok: false, status: "NO_PENDING_SETUP", message: "No setup is pending. Call apixo_setup first." };
  }
  const data = responseData<DeviceAuthorizationPollResponse>(completed);
  if (!data || (data.status !== "PENDING" && data.status !== "AUTHORIZED")) {
    const retry = completed.status === 0 || completed.status === 429 || completed.status >= 500;
    return { ok: false, status: retry ? "RETRY" : "FAILED",
      message: retry ? "Setup could not be checked yet. Automatic completion will retry."
        : "Setup could not be completed. Call apixo_setup or apixo_finish_setup to retry.",
      pollIntervalSeconds: pending.pollIntervalSeconds };
  }
  if (data.status === "PENDING") {
    return { ok: true, status: "PENDING_APPROVAL", message: "Approve this device in the browser. This running MCP server will finish setup automatically.",
      pollIntervalSeconds: data.pollIntervalSeconds ?? pending.pollIntervalSeconds };
  }
  if (typeof data.apiKey !== "string" || !data.apiKey.trim()) {
    return { ok: false, status: "FAILED", message: "Setup returned an invalid credential response. Call apixo_finish_setup to retry." };
  }
  writeLocalCredentials({ version: 1, installationId: latest.installationId, apiKey: data.apiKey.trim() });
  return { ok: true, status: "CONFIGURED", client_type: pending.clientType, host_label: pending.hostLabel,
    message: "APiXO MCP is configured. The credential was saved privately on this device." };
}

const setupPoller = new SetupPoller(checkPendingSetup, () => {
  const pending = readLocalCredentials()?.pendingSetup;
  return pending ? pending.expiresAtEpochSeconds * 1000 : undefined;
});
let setupStartInFlight: Promise<Awaited<ReturnType<typeof toTextResultWithUpdate>>> | undefined;

function startSetupOnce(operation: () => Promise<Awaited<ReturnType<typeof toTextResultWithUpdate>>>) {
  if (!setupStartInFlight) {
    setupStartInFlight = operation().finally(() => { setupStartInFlight = undefined; });
  }
  return setupStartInFlight;
}

function getBatchIntegrationGuideConfig(): BatchIntegrationGuideConfig {
  const urlRaw = process.env[BATCH_INTEGRATION_GUIDE_URL_ENV]?.trim();
  const ttlRaw = process.env[BATCH_INTEGRATION_GUIDE_CACHE_TTL_MS_ENV]?.trim();

  return {
    url: urlRaw && urlRaw.length > 0 ? urlRaw : DEFAULT_BATCH_INTEGRATION_GUIDE_URL,
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
      error: `Missing API key. Run apixo_setup to sign in through APiXO, or set ${API_KEY_ENV} for an explicit local override.`,
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
      signal: AbortSignal.timeout(15000),
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
    headers?: Record<string, string>;
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
        ...options?.headers,
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

async function loadBatchIntegrationGuide(forceRefresh = false): Promise<
  | { ok: true; payload: BatchIntegrationGuideDocument; guideUrl: string; cacheExpiresAt: number }
  | { ok: false; error: string; status?: number; guideUrl: string; response?: unknown }
> {
  const cfg = getBatchIntegrationGuideConfig();
  const now = Date.now();

  if (!forceRefresh && batchIntegrationGuideCache && batchIntegrationGuideCache.expiresAt > now) {
    return {
      ok: true,
      payload: batchIntegrationGuideCache.payload,
      guideUrl: cfg.url,
      cacheExpiresAt: batchIntegrationGuideCache.expiresAt,
    };
  }

  const fetched = await fetchJson(cfg.url);
  if (!fetched.ok) {
    return {
      ok: false,
      error: fetched.error ?? "Failed to fetch the batch integration guide.",
      status: fetched.status,
      guideUrl: cfg.url,
      response: fetched.rawText ?? null,
    };
  }

  const data = fetched.data;
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      error: "Batch integration guide payload is not an object.",
      status: fetched.status,
      guideUrl: cfg.url,
      response: data,
    };
  }

  const payload = data as BatchIntegrationGuideDocument;
  if (typeof payload.guide_id !== "string" || !payload.sections || typeof payload.sections !== "object") {
    return {
      ok: false,
      error: "Batch integration guide is missing guide_id or sections.",
      status: fetched.status,
      guideUrl: cfg.url,
      response: data,
    };
  }

  const expiresAt = now + cfg.ttlMs;
  batchIntegrationGuideCache = { expiresAt, payload };
  return { ok: true, payload, guideUrl: cfg.url, cacheExpiresAt: expiresAt };
}

async function loadModelSchemaByPath(schemaPath: string): Promise<JsonFetchResult> {
  const cfg = getModelSchemaConfig();
  const fullUrl = /^https?:\/\//i.test(schemaPath)
    ? schemaPath
    : new URL(schemaPath.replace(/^\/+/, ""), `${cfg.baseUrl}/`).toString();

  return fetchJson(fullUrl);
}

async function modelNotFoundResult(index: ModelSchemaIndexDoc, model: string) {
  const suggestions = await Promise.all(suggestModels(index.models, model).map(async (candidate) => {
    const schema = await loadModelSchemaByPath(candidate.schema_path);
    return {
      model_id: candidate.model_id, title: candidate.title, category: candidate.category,
      parameter_options: schema.ok ? schemaProperties(schema.data)
        .filter((field) => field.name === "mode" || field.name === "resolution") : [],
    };
  }));
  return toTextResultWithUpdate({
    ok: false, error_code: "MODEL_NOT_FOUND", error: `Model not found in schema index: ${model}`,
    suggested_models: suggestions,
    next_step: { tool: "apixo_list_models" },
    hint: "Compare the user's intent with apixo_list_models, then call apixo_get_model_schema for the chosen canonical model_id. Variants can be modes or separate IDs. Do not automatically select a candidate or submit a paid task.",
  }, true);
}

async function prepareGeneration(model: string, inputs: JsonObject[]): Promise<
  | { ok: true; modelId: string; category: string }
  | { ok: false; result: Awaited<ReturnType<typeof toTextResultWithUpdate>> }
> {
  let loaded = await loadModelSchemaIndex();
  if (!loaded.ok) {
    return { ok: false, result: await toTextResultWithUpdate({ ok: false, error_code: "MODEL_INDEX_UNAVAILABLE",
      error: "Cannot verify the published model directory. Retry apixo_list_models before generation." }, true) };
  }
  let matched = findModelIndexEntry(loaded.payload.models, model);
  // 模型刚上架时，刷新一次目录，避免旧缓存造成误报。
  if (!matched) {
    const refreshed = await loadModelSchemaIndex(true);
    if (refreshed.ok) {
      loaded = refreshed;
      matched = findModelIndexEntry(refreshed.payload.models, model);
    }
  }
  if (!matched) return { ok: false, result: await modelNotFoundResult(loaded.payload, model) };
  const schema = await loadModelSchemaByPath(matched.schema_path);
  if (!schema.ok) {
    return { ok: false, result: await toTextResultWithUpdate({ ok: false, error_code: "MODEL_SCHEMA_UNAVAILABLE",
      error: "Cannot read the selected model's published schema. Retry apixo_get_model_schema before generation.",
      model: matched.model_id }, true) };
  }
  const errors = inputs.flatMap((input, index) => enumInputErrors(schema.data, input)
    .map((error) => ({ ...error, ...(inputs.length > 1 ? { item_index: index } : {}) })));
  if (errors.length) {
    return { ok: false, result: await toTextResultWithUpdate({ ok: false, error_code: "INVALID_MODEL_INPUT", model: matched.model_id,
      errors, next_step: { tool: "apixo_get_model_schema", arguments: { model: matched.model_id } },
      hint: "Correct these fields using the schema and the user's intent. No generation was submitted." }, true) };
  }
  return { ok: true, modelId: matched.model_id, category: matched.category };
}

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    icons: [SERVER_ICON],
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

server.registerTool(
  "apixo_list_models",
  {
    title: "List Models",
    description: "Discover canonical model IDs, titles, categories, and schema locations. Call this when the user's model name is uncertain; compare candidates with the user's intent, then read apixo_get_model_schema before generation.",
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
    description: "Read the selected model's published modes, input fields, constraints, and available billing guidance before building generation JSON. Use the returned canonical model.model_id; a display-name suffix may be an input.mode rather than a separate model.",
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

    const matched = findModelIndexEntry(loaded.payload.models, model);
    if (!matched) {
      return modelNotFoundResult(loaded.payload, model);
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
  "apixo_get_batch_integration_guide",
  {
    title: "Get Batch Integration Guide",
    description:
      "Read the public APiXO guide for batch submission, batch status, and signed webhooks. This is documentation-only: it does not require an API key and never returns a webhook secret.",
    inputSchema: {
      section: z
        .enum(["all", "overview", "generate", "status", "webhooks"])
        .optional()
        .describe("Guide section to return. Defaults to all."),
      force_refresh: z.boolean().optional().describe("When true, bypass the in-memory guide cache."),
    },
  },
  async ({ section, force_refresh }) => {
    const loaded = await loadBatchIntegrationGuide(force_refresh ?? false);
    if (!loaded.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: loaded.error,
          status: loaded.status ?? 0,
          guide_url: loaded.guideUrl,
          response: loaded.response ?? null,
        },
        true,
      );
    }

    const selectedSection = section ?? "all";
    const content = selectedSection === "all" ? loaded.payload : loaded.payload.sections?.[selectedSection];
    if (selectedSection !== "all" && content === undefined) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: `Batch integration guide section is unavailable: ${selectedSection}`,
          guide_url: loaded.guideUrl,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      guide_id: loaded.payload.guide_id,
      schema_version: loaded.payload.schema_version ?? null,
      section: selectedSection,
      guide_url: loaded.guideUrl,
      cache_expires_at: new Date(loaded.cacheExpiresAt).toISOString(),
      content,
    });
  },
);

server.registerTool(
  "apixo_setup",
  {
    title: "Set Up APiXO",
    description:
      "Open APiXO in your browser, sign in, and approve this local MCP installation. The API key is saved only in this MCP server's private local credential file and is never returned in the tool response.",
    inputSchema: {
      client_type: z
        .string()
        .optional()
        .describe("Optional installing client identifier, e.g. codexCli, claudeCli, or claudeDesktop."),
    },
  },
  ({ client_type }) => startSetupOnce(async () => {
    const cfg = getRuntimeConfig();
    if (cfg.apiKey) {
      return toTextResultWithUpdate({
        ok: true,
        status: "ALREADY_CONFIGURED",
        message: "APiXO MCP already has a local credential or an APIXO_API_KEY override.",
      });
    }

    try {
      const existing = readLocalCredentials();
      const installationId = existing?.installationId || randomUUID().replace(/-/g, "");
      const selectedClientType = normalizedClientType(client_type);
      const hostLabel = normalizedHostLabel();
      const nowEpochSeconds = Math.floor(Date.now() / 1000);
      const pending = existing?.pendingSetup;
      if (pending && pending.expiresAtEpochSeconds > nowEpochSeconds) {
        setupPoller.start();
        const opened = await openBrowser(pending.verificationUrl);
        return toTextResultWithUpdate({
          ok: true,
          status: "PENDING_APPROVAL",
          verification_url: pending.verificationUrl,
          browser_opened: opened,
          message: opened
            ? "A setup approval is pending. Approve the device; this running MCP server finishes configuration automatically. You may close the browser after approval."
            : "Open verification_url and approve the device. This running MCP server finishes configuration automatically; apixo_finish_setup is available for recovery.",
        });
      }

      const started = await postApiJson(cfg.baseUrl, "/api/mcp/device-authorization/start", {
        clientType: selectedClientType,
        hostLabel,
        installationId,
      });
      const data = responseData<DeviceAuthorizationStartResponse>(started);
      if (!data
        || typeof data.verificationUrl !== "string"
        || typeof data.deviceCode !== "string"
        || typeof data.pollToken !== "string"
        || typeof data.expiresAtEpochSeconds !== "number") {
        return toTextResultWithUpdate(
          {
            ok: false,
            error: apiFailureMessage(started, "APiXO setup could not start."),
          },
          true,
        );
      }

      const nextCredentials: LocalCredentials = {
        version: 1,
        installationId,
        pendingSetup: {
          deviceCode: data.deviceCode,
          pollToken: data.pollToken,
          verificationUrl: data.verificationUrl,
          expiresAtEpochSeconds: data.expiresAtEpochSeconds,
          clientType: selectedClientType,
          hostLabel,
          pollIntervalSeconds: data.pollIntervalSeconds,
        },
      };
      writeLocalCredentials(nextCredentials);
      setupPoller.start();
      const opened = await openBrowser(data.verificationUrl);
      return toTextResultWithUpdate({
        ok: true,
        status: "PENDING_APPROVAL",
        verification_url: data.verificationUrl,
        browser_opened: opened,
        expires_at: new Date(data.expiresAtEpochSeconds * 1000).toISOString(),
        message: opened
          ? "Sign in and approve this device in the browser. This running MCP server will save the credential automatically; you may close the browser after approval."
          : "Open verification_url and approve this device. This running MCP server will save the credential automatically; apixo_finish_setup is available for recovery.",
      });
    } catch (error) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: error instanceof Error ? error.message : "APiXO setup could not start.",
        },
        true,
      );
    }
  }),
);

server.registerTool(
  "apixo_finish_setup",
  {
    title: "Finish APiXO Setup",
    description:
      "Check setup status or manually recover setup. Browser approval normally completes automatically while this MCP server runs. No credential is returned.",
    inputSchema: {},
  },
  async () => {
    const result = await setupPoller.pollOnce();
    if (result.status === "PENDING_APPROVAL" || result.status === "RETRY") setupPoller.start();
    else setupPoller.stop();
    return toTextResultWithUpdate({ ...result, ...(!result.ok ? { error: result.message } : {}) }, !result.ok);
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
    description: "Submit one paid asynchronous generation visible in Studio Recent after model discovery and apixo_get_model_schema. Decide from the user's intent: first generation/new topic = omit session_id and supply a concise preferably English session_title; related follow-ups/model changes = reuse the returned session_id. For revising a result also supply base_run_id; omit it for an independent asset. Keep returned IDs in this conversation, never infer a globally current session, and do not automatically resubmit after an uncertain response. A taskId means accepted, not completed.",
    inputSchema: {
      model: z.string().min(1).describe("Canonical model_id selected using apixo_list_models and apixo_get_model_schema."),
      input: z
        .record(z.string(), z.unknown())
        .describe("Model-specific input payload. Example: { mode, prompt, aspect_ratio }."),
      session_title: z.string().optional().describe("Required when creating a session: a short project name, preferably English (e.g. Celestial Palace Exploration), or the user's chosen name. Used only when session_id is omitted; never rename a continuing project implicitly."),
      session_id: z.string().trim().min(1).optional().describe("Server-returned sessionId for the project being continued. Reuse for related assets and model changes; omit only for the first generation or a new topic."),
      base_run_id: z.string().trim().min(1).optional().describe("Server-returned runId being revised or regenerated. Requires its session_id and appends a version to that result; omit for an independent asset in the same project."),
      request_type: z.enum(["async", "callback"]).optional().describe("Studio generation supports async (default). Legacy callback values return guidance without submitting a task."),
      callback_url: z.string().url().optional().describe("Legacy compatibility parameter. Studio generation does not support callback_url; use asynchronous task polling."),
    },
  },
  async ({ model, input, session_title, session_id, base_run_id, request_type, callback_url }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const prepared = await prepareGeneration(model, [input]);
    if (!prepared.ok) return prepared.result;
    const session = studioSessionFields({ session_title, session_id, base_run_id, request_type, callback_url });
    if (!session.ok) return toTextResultWithUpdate(session, true);
    if (!["image", "video", "audio", "text"].includes(prepared.category)) {
      return toTextResultWithUpdate({ ok: false, error_code: "MODEL_CATEGORY_UNSUPPORTED",
        error: "The published model category is not supported by Studio generation. No task was submitted.", model: prepared.modelId }, true);
    }

    const payload: JsonObject = {
      ...session.fields,
      model_name: prepared.modelId,
      category: prepared.category,
      request: { request_type: "async", input },
    };
    const endpoint = "/api/v1/web/generations/mcp";
    const result = await apixoRequest(cfg, "POST", endpoint, {
      body: payload,
    });

    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to call APiXO Studio generation endpoint.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
          hint: "Inspect this error. Do not automatically submit a replacement task or create a new session; after a network/server error, acceptance may be unknown.",
        },
        true,
      );
    }
    const references = studioRunReferences(result.envelope, session_id);
    if (!references) {
      return toTextResultWithUpdate({ ok: false, error_code: "STUDIO_RESPONSE_UNCONFIRMED", endpoint,
        response: sanitizeTaskStatus(result.envelope ?? result.rawText ?? null),
        hint: "The response does not confirm the requested session and task references. A task may already have been accepted; do not automatically resubmit or create another session." }, true);
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint,
      model: prepared.modelId,
      session_id: references.sessionId,
      run_id: references.runId,
      taskId: references.taskId,
      session_created: session.created,
      ...(session.created ? { session_title: session.fields.title } : {}),
      hint: "Save these IDs for this project. Reuse session_id for related follow-ups; include run_id as base_run_id only when revising this result. Poll apixo_get_task_status using model and taskId; accepted does not mean completed.",
      response: sanitizeTaskStatus(result.envelope ?? result.rawText ?? null),
    });
  },
);

server.registerTool(
  "apixo_submit_batch",
  {
    title: "Submit Batch",
    description:
      "Submit 1 to 50 paid asynchronous tasks for one model after model discovery and apixo_get_model_schema. Use its canonical model_id and schema-defined input. Provide stable batch and item idempotency keys; use webhook_url only after configuring the signing secret through the REST API or Dashboard.",
    inputSchema: {
      model: z.string().min(1).describe("Public model ID for every item in the batch."),
      idempotency_key: z
        .string()
        .min(1)
        .describe("Stable batch-level idempotency key. Reuse it only when retrying the same business batch."),
      items: z
        .array(
          z.object({
            client_item_id: z.string().min(1).describe("Your unique business locator within this batch."),
            idempotency_key: z
              .string()
              .min(1)
              .describe("Stable account-level idempotency key for this item."),
            input: z
              .record(z.string(), z.unknown())
              .describe("Normal public model input. Use apixo_get_model_schema for fields and constraints."),
          }),
        )
        .min(1)
        .max(50)
        .describe("One to fifty items for the same model."),
      webhook_url: z
        .string()
        .url()
        .optional()
        .describe("Optional public HTTPS endpoint for signed terminal item webhooks."),
    },
  },
  async ({ model, idempotency_key, items, webhook_url }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const prepared = await prepareGeneration(model, items.map((item) => item.input));
    if (!prepared.ok) return prepared.result;
    const body: JsonObject = { items };
    if (webhook_url) {
      body.webhook_url = webhook_url;
    }

    const result = await apixoRequest(cfg, "POST", `/api/v1/generateTask/${encodeURIComponent(prepared.modelId)}/batches`, {
      body,
      headers: { "Idempotency-Key": idempotency_key },
    });

    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to submit APiXO batch.",
          status: result.status,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: `/api/v1/generateTask/${prepared.modelId}/batches`,
      response: sanitizeTaskStatus(result.envelope ?? result.rawText ?? null),
    });
  },
);

server.registerTool(
  "apixo_get_batch_status",
  {
    title: "Get Batch Status",
    description:
      "Fetch the current state, item states, and terminal public results for one APiXO batch. Uses the configured APIXO_API_KEY; the batch must belong to that API key's account.",
    inputSchema: {
      model: z.string().min(1).describe("Public model ID used when the batch was submitted."),
      batchId: z.string().min(1).describe("Batch ID returned by apixo_submit_batch or the Batch Generate API."),
    },
  },
  async ({ model, batchId }) => {
    const cfg = getRuntimeConfig();
    if (!cfg.apiKey) {
      return missingKeyResult();
    }

    const result = await apixoRequest(
      cfg,
      "GET",
      `/api/v1/generateTask/${encodeURIComponent(model)}/batches/${encodeURIComponent(batchId)}`,
    );
    if (!result.ok) {
      return toTextResultWithUpdate(
        {
          ok: false,
          error: result.error ?? "Failed to fetch APiXO batch status.",
          status: result.status,
          batchId,
          response: result.envelope ?? result.rawText ?? null,
        },
        true,
      );
    }

    return toTextResultWithUpdate({
      ok: true,
      endpoint: `/api/v1/generateTask/${model}/batches/${batchId}`,
      batchId,
      response: sanitizeTaskStatus(result.envelope ?? result.rawText ?? null),
    });
  },
);

server.registerTool(
  "apixo_get_task_status",
  {
    title: "Get Task Status",
    description: "Fetch APiXO task status and result for a taskId from a single task or an accepted batch item.",
    inputSchema: {
      model: z.string().min(1).describe("Model ID used to submit the task."),
      taskId: z.string().min(1).describe("Task ID returned by generate_task or an accepted batch item."),
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
      response: sanitizeTaskStatus(result.envelope ?? result.rawText ?? null),
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
    console.error(`[${SERVER_NAME}] Run apixo_setup for browser sign-in. Pending setup resumes automatically while this server runs.`);
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
  server.server.onclose = () => setupPoller.stop();
  if (!getRuntimeConfig().apiKey && readLocalCredentials()?.pendingSetup) setupPoller.start();
  console.error(`${SERVER_NAME} started on stdio`);
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
