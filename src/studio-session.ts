export interface StudioSessionInput {
  session_id?: string;
  session_title?: string;
  base_run_id?: string;
  request_type?: "async" | "callback";
  callback_url?: string;
}

// 话题由宿主 AI 判断；服务只执行明确的 ID，不维护账号或进程级“当前会话”。
export function studioSessionFields(input: StudioSessionInput):
  | { ok: true; created: boolean; fields: Record<string, unknown> }
  | { ok: false; error_code: string; error: string } {
  if (input.request_type === "callback" || input.callback_url !== undefined) {
    return { ok: false, error_code: "STUDIO_ASYNC_REQUIRED",
      error: "Studio generation uses asynchronous task polling. Omit callback_url and use request_type=async; callback generation remains available through the published REST API. No task was submitted." };
  }
  const sessionId = input.session_id?.trim();
  const baseRunId = input.base_run_id?.trim();
  const title = input.session_title?.trim();
  if ((input.session_id !== undefined && !sessionId) || (input.base_run_id !== undefined && !baseRunId)) {
    return { ok: false, error_code: "INVALID_SESSION_REFERENCE", error: "Session and base run IDs must be nonblank server-returned IDs. No task was submitted." };
  }
  if (baseRunId && !sessionId) {
    return { ok: false, error_code: "SESSION_ID_REQUIRED",
      error: "base_run_id requires the session_id returned for that same project. No task was submitted." };
  }
  if (!sessionId && (!title || title.length > 255)) {
    return { ok: false, error_code: "SESSION_TITLE_REQUIRED",
      error: "For a new topic, provide a concise session_title (1–255 characters), preferably in English unless the user specifies a name. To continue a project, pass its returned session_id instead. No task was submitted." };
  }
  return { ok: true, created: !sessionId, fields: {
    versionMode: baseRunId ? "APPEND_TO_GROUP" : "NEW_GROUP",
    ...(sessionId ? { session_id: sessionId } : { title }),
    ...(baseRunId ? { baseRunId } : {}),
  } };
}

export function studioRunReferences(envelope: unknown, expectedSessionId?: string):
  { sessionId: string; runId: string; taskId: string } | null {
  if (!envelope || typeof envelope !== "object") return null;
  const result = envelope as { code?: unknown; data?: unknown };
  if (result.code !== 200 || !result.data || typeof result.data !== "object") return null;
  const data = result.data as Record<string, unknown>;
  if (![data.sessionId, data.runId, data.taskId].every(value => typeof value === "string" && value.trim())) return null;
  if (expectedSessionId && data.sessionId !== expectedSessionId.trim()) return null;
  return { sessionId: data.sessionId as string, runId: data.runId as string, taskId: data.taskId as string };
}
