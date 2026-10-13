const NONTERMINAL_STATES = new Set(["pending", "processing", "processing_r2"]);

// 只修改 MCP 输出，保留后端原始对象及终态/未知状态的字段。
export function sanitizeTaskStatus(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTaskStatus);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const processing = typeof record.state === "string"
    && NONTERMINAL_STATES.has(record.state.trim().toLowerCase());
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(processing && key === "completeTime"))
    .map(([key, item]) => [key, sanitizeTaskStatus(item)]));
}
