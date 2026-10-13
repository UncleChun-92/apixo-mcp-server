export interface ModelSchemaIndexEntry {
  model_id: string;
  slug: string;
  category: string;
  title: string;
  integration_type: string;
  schema_path: string;
  doc_path: string;
}

export function findModelIndexEntry(models: ModelSchemaIndexEntry[], query: string): ModelSchemaIndexEntry | null {
  const lookup = query.trim().toLowerCase();
  return models.find((model) => model.model_id.toLowerCase() === lookup)
    ?? models.find((model) => model.slug.toLowerCase() === lookup)
    ?? null;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// 候选只供客户端 AI 判断；不能替用户自动切换模型或付费模式。
export function suggestModels(models: ModelSchemaIndexEntry[], query: string): ModelSchemaIndexEntry[] {
  const lookup = normalized(query).slice(0, 128);
  if (!lookup) return [];
  return models.map((model) => {
    const names = [model.model_id, model.slug, model.title].map(normalized);
    const score = Math.max(...names.map((name) => {
      if (name === lookup) return 100;
      if (name.length >= 4 && lookup.startsWith(name)) return 80 + name.length / 100;
      const difference = distance(lookup, name);
      return difference <= Math.max(2, Math.floor(name.length / 4)) ? 60 - difference : 0;
    }));
    return { model, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
    .slice(0, 3).map(({ model }) => model);
}

type Property = { name?: string; type?: string; enum?: unknown[]; description?: string };

export function schemaProperties(schema: unknown): Property[] {
  const properties = (schema as { request_schema?: { input?: { properties?: unknown } } } | null)
    ?.request_schema?.input?.properties;
  return Array.isArray(properties) ? properties.filter((item) => item && typeof item === "object") : [];
}

// 只检查已发布且明确给出的枚举；条件必填、未知字段等仍由模型后端校验。
export function enumInputErrors(schema: unknown, input: Record<string, unknown>) {
  return schemaProperties(schema).flatMap((property) => {
    if (!property.name || !Array.isArray(property.enum) || property.enum.length === 0) return [];
    const value = input[property.name];
    if (value === undefined || value === null || Array.isArray(value) || typeof value === "object") return [];
    const comparable = (item: unknown) => String(item).trim().toLowerCase();
    if (property.enum.some((item) => comparable(item) === comparable(value))) return [];
    // 部分公开 schema 明写数字分辨率别名；不能把后端正式支持的别名误判为错误。
    if (property.name === "resolution" && /numeric aliases/i.test(property.description ?? "")
      && property.enum.some((item) => comparable(item) === `${comparable(value)}p`)) return [];
    return [{ field: `input.${property.name}`, allowed_values: property.enum, description: property.description }];
  });
}
