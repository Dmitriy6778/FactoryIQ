// src/pages/reports/types.ts

export type AggregateKey = "" | "SUM" | "AVG" | "MIN" | "MAX";

// ---------------------- TAG ----------------------
export interface Tag {
  id: number;
  name: string;
  browse_name?: string;
  description?: string;
  node_id?: string;
  path?: string;
  data_type?: string;
}

// ---------------------- TEMPLATE TAG ----------------------
export interface ReportTemplateTag {
  tag_id: number;
  tag_type: "counter" | "current";
  aggregate: AggregateKey;
  interval_minutes: number;
  display_order: number;
}

// ---------------------- TEMPLATE ----------------------
export interface ReportTemplate {
  id: number;
  name: string;
  description?: string;
  report_type?: string; // 'balance' | 'custom'
  period_type?: string;
  is_shared?: boolean;
  auto_schedule?: boolean;
  target_channel?: string | null;
  tags?: ReportTemplateTag[];
}

// ---------------------- SELECTED TAG SETTINGS ----------------------
export interface ReportTagSettings {
  id: number; // внутренний ключ для React
  tag: Tag;
  type: "counter" | "current";
  aggregate?: AggregateKey;
  intervalMinutes: number;
}
