// src/pages/reports/helpers/utils.ts

import { ReportTagSettings } from "../types";

export function toSqlDatetime(dateStr: string): string {
  if (!dateStr) return "";
  // если пришло просто "2025-12-08"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `${dateStr} 00:00:00`;
  }
  // остальное не трогаем
  return dateStr.replace("T", " ").slice(0, 19);
}

// убираем всё после запятой: "Счётчик жмыха, кг" -> "Счётчик жмыха"
export function cleanTagName(name?: string | null): string {
  if (!name) return "";
  return name.split(",")[0].trim();
}

// удобно получать "отображаемое" имя тега
export function getTagKey(t: ReportTagSettings["tag"]): string {
  return (
    t.description?.split(",")[0].trim() ||
    t.browse_name?.split(",")[0].trim() ||
    t.name
  );
}
