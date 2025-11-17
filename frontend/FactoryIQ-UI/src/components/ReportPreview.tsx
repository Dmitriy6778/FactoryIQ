// src/components/ReportPreview.tsx
import React, { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import styles from "../styles/ReportPreview.module.css";
import { useApi } from "../shared/useApi";

type PreviewPayload = {
  template_id: number;
  format: "chart" | "table" | "file" | "text";
  period_type: string;           // every_5m|every_10m|every_30m|hourly|shift|daily|weekly|monthly|once
  time_of_day?: string | null;
  aggregation_type?: string | null;
  window_minutes?: number | null;
  avg_seconds?: number | null;
  text_template?: string | null; // опционально, для text-режима
};

type View =
  | { type: "image"; payload: { src: string; title?: string } }
  | { type: "text"; payload: { text: string; title?: string } }
  | { type: "table"; payload: { columns: string[]; rows: any[] } }
  | null;

const API_PREVIEW = "/telegram/preview"; // ← только бэк решает, какую хранимку дергать

function normalizeResponse(data: any): View {
  if (!data) return null;
  const r = data.render ?? data;

  const img64 = r.chart_png || r.image_base64 || r.base64;
  const dataUrl = r.data_url;
  if (img64 || dataUrl) {
    const src = dataUrl || (img64?.startsWith("data:") ? img64 : `data:image/png;base64,${img64}`);
    return { type: "image", payload: { src, title: r.title } };
  }

  // бэк может вернуть либо text, либо text_table
  if (typeof r.text === "string") {
    return { type: "text", payload: { text: r.text, title: r.title } };
  }
  if (typeof r.text_table === "string") {
    return { type: "text", payload: { text: r.text_table, title: r.title } };
  }

  const rows = r.rows || [];
  const columns = r.columns || (rows[0] ? Object.keys(rows[0]) : []);
  if (rows.length) {
    return { type: "table", payload: { rows, columns } };
  }
  return null;
}

const ReportPreview: React.FC<{ payload: PreviewPayload }> = ({ payload }) => {
  const api = useApi();
  const [state, setState] = useState<{ loading: boolean; error?: string | null; view: View }>({
    loading: true,
    error: null,
    view: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ loading: true, error: null, view: null });

      try {
        const templateId = Number((payload as any).template_id ?? (payload as any).templateId);
        if (!templateId || Number.isNaN(templateId)) {
          setState({ loading: false, error: "template_id не задан", view: null });
          return;
        }

        // НИЧЕГО не вычисляем на фронте — просто пробрасываем то, что выбрал пользователь
        // (бэк сам достанет meta по шаблону и решит proc/params/map_*)
        const resp = await api.post(API_PREVIEW, payload);
        if (cancelled) return;

        const view = normalizeResponse(resp);
        setState({
          loading: false,
          error: view ? null : null,
          view: view ?? { type: "text", payload: { text: "нет данных" } },
        });
      } catch (e: any) {
        if (cancelled) return;
        setState({ loading: false, error: e?.message || "Ошибка предпросмотра", view: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, payload]);

  if (state.loading) {
    return (
      <div className={styles.center}>
        <Spin />
      </div>
    );
  }
  if (state.error) return <Alert type="error" message={state.error} />;
  if (!state.view) return <div className={styles.textBox}>нет данных</div>;

  if (state.view.type === "image") {
    return (
      <div className={styles.imgBox}>
        <img src={state.view.payload.src} alt="preview" />
      </div>
    );
  }
if (state.view.type === "text") {
  return (
    <div className={styles.textBox}>
      <pre className={styles.textPre}>{state.view.payload.text || "нет данных"}</pre>
    </div>
  );
}


  const cols: string[] = state.view.payload.columns || [];
  const rows: any[] = state.view.payload.rows || [];
  if (!rows.length) return <div className={styles.textBox}>нет данных</div>;

  return (
    <div className={styles.textBox}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} style={{ padding: "6px 8px", borderBottom: "1px solid #f5f5f5" }}>
                  {r?.[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ReportPreview;
