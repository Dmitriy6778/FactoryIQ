export type Row = Record<string, any>;

/** Берём X-ось из разных названий колонок (EN/RU + сырые поля). */
export function pickX(row: Row) {
  const r = row ?? {};
  // порядок приоритета + поддержка рус/англ + raw
  const x =
    r.Date ??
    r.Start ??
    r.ts ??        // для LineChart (raw)
    r.Period ??    // для MultiAgg
    r["Начало"] ??
    r["Время"] ??
    r["Период"];

  try {
    // если пришёл ISO-стринг — тоже нормализуем
    const d = x instanceof Date ? x : (typeof x === "string" ? new Date(x) : null);
    if (d && !isNaN(d.getTime())) return d.toLocaleString("ru-RU");
  } catch {}
  return x;
}

/** Достаём числовое Y из возможных колонок. Возвращаем number | null. */
export function pickY(row: Row): number | null {
  const candidates = [
    row.Value, row.AVG, row.CURR, row.MIN, row.MAX,
    row["Среднее"], row["Мин"], row["Макс"], row.value
  ];
  for (const v of candidates) {
    if (v === null || v === undefined || `${v}`.trim() === "") continue;
    const num = Number(v);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

/** Лейбл серии: TagName/описание с фолбэком на Id. */
export function pickLabel(row: Row): string {
  return (
    row.TagName ??
    row.tag_name ??
    row.Description ??
    row.description ??
    row.Name ??
    row.name ??
    (row.TagId ?? row.tag_id ? `Tag ${row.TagId ?? row.tag_id}` : "Параметр")
  );
}

/** Сборка серий из табличных строк, если chart_series отсутствует. */
export function buildSeriesFromTable(rows: Row[]) {
  const byLabel = new Map<string, { x: string; y: number }[]>();
  for (const row of rows ?? []) {
    const y = pickY(row);
    if (y == null) continue;
    const label = String(pickLabel(row));
    const x = String(pickX(row) ?? "");
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ x, y });
  }
  return Array.from(byLabel.entries()).map(([label, data]) => ({
    tag: label,
    description: label,
    unit: "",
    data,
  }));
}
