// src/components/ReportPreview.tsx
import React, { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import styles from "../styles/ReportPreview.module.css";
import { useApi } from "../shared/useApi";

type PreviewPayload = {
  template_id: number;
  format: "chart" | "table" | "file" | "text";
  period_type: string;
  time_of_day?: string | null;
  aggregation_type?: string | null;
  window_minutes?: number | null;
  avg_seconds?: number | null;
  text_template?: string | null;

  // style
  style_override?: any;

  // weekly-подсказки (могут прилететь как в корне, так и в style_override)
  weekly_y_mode?: "delta" | "cum";
  weekly_y?: "Delta" | "CumValue";
  weekly_scale?: number | null;
  weekly_unit?: string | null;
};

type View =
  | { type: "image"; payload: { src: string; title?: string } }
  | { type: "text"; payload: { text: string; title?: string } }
  | { type: "table"; payload: { columns: string[]; rows: any[] } }
  | null;

const API_PREVIEW = "/telegram/preview";

/* ---------- utils ---------- */
const fmtRu = (x: any, prec = 1) => {
  const n = Number(x);
  if (!isFinite(n)) return x ?? "";
  return n
    .toLocaleString("ru-RU", {
      minimumFractionDigits: prec,
      maximumFractionDigits: prec,
    })
    .replace(/\u00A0/g, " ");
};

function resolveWeeklyMode(payload: any): "delta" | "cum" {
  const st =
    payload?.style_override && typeof payload.style_override === "object"
      ? payload.style_override
      : {};

  const raw =
    st.weekly_y_mode ??
    st.weekly_y ?? // "Delta" / "CumValue"
    payload?.weekly_y_mode ??
    payload?.weekly_y ??
    "Delta";

  const v = String(raw).toLowerCase();
  // всё, что начинается на "cum" — считаем накоплением
  return v.startsWith("cum") ? "cum" : "delta";
}

/** Преобразуем ответ бэка к виду View (учитываем weekly-особенности в таблице) */
function normalizeResponse(data: any, payload: PreviewPayload): View {
  if (!data) return null;
  const r = data.render ?? data;

  // 1) картинка из бэка — приоритет
  const img64 = r.chart_png || r.image_base64 || r.base64;
  const dataUrl = r.data_url;
  if (img64 || dataUrl) {
    const src =
      dataUrl ||
      (String(img64).startsWith("data:")
        ? String(img64)
        : `data:image/png;base64,${img64}`);
    return { type: "image", payload: { src, title: r.title } };
  }

  // 2) текст
  if (typeof r.text === "string" && r.text.trim()) {
    return { type: "text", payload: { text: r.text, title: r.title } };
  }
  if (typeof r.text_table === "string" && r.text_table.trim()) {
    return { type: "text", payload: { text: r.text_table, title: r.title } };
  }

  // 3) таблица (фолбэк). Для weekly — показываем масштабированные поля и юнит.
  const rows: any[] = r.data || r.rows || [];
  if (!rows.length) return null;

  const isWeekly = (payload?.period_type || "").toLowerCase() === "weekly";
  if (!isWeekly) {
    const columns = r.columns || (rows[0] ? Object.keys(rows[0]) : []);
    return { type: "table", payload: { rows, columns } };
  }

  // ---------- weekly-режим ----------
  const yMode = resolveWeeklyMode(payload); // "delta" | "cum"

  const baseField = yMode === "cum" ? "CumValue" : "Delta";
  const scaledField = yMode === "cum" ? "CumValueScaled" : "DeltaScaled";

  const st =
    payload?.style_override && typeof payload.style_override === "object"
      ? payload.style_override
      : {};

  const scaleRaw =
    st.weekly_scale ?? payload.weekly_scale ?? payload.style_override?.scale;
  const scale =
    scaleRaw !== undefined && scaleRaw !== null
      ? Number(scaleRaw)
      : 0;

  const baseUnit: string = rows[0]?.Unit || "";
  const unitOverride: string =
    st.weekly_unit ?? payload.weekly_unit ?? baseUnit;
  const unit: string = unitOverride || baseUnit || "";

  const hasScaled = rows.some((rr) => rr[scaledField] != null);

  const tableRows = rows.map((rr) => {
    let num: number | null = null;

    if (hasScaled && rr[scaledField] != null) {
      // Бэк уже посчитал *Scaled — просто берём
      num = Number(rr[scaledField]);
    } else if (rr[baseField] != null) {
      const raw = Number(rr[baseField]);
      if (isFinite(raw)) {
        num = scale && scale > 0 ? raw / scale : raw;
      }
    }

    const valStr =
      num !== null && isFinite(num)
        ? `${fmtRu(num)}${unit ? ` ${unit}` : ""}`
        : "";

    return {
      Period: rr.Period,
      TagName: rr.TagName,
      Value: valStr,
    };
  });

  return {
    type: "table",
    payload: { columns: ["Period", "TagName", "Value"], rows: tableRows },
  };
}

const ReportPreview: React.FC<{ payload: PreviewPayload }> = ({ payload }) => {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setView(null);

      try {
        const templateId = Number(
          (payload as any).template_id ?? (payload as any).templateId
        );
        if (!templateId || Number.isNaN(templateId)) {
          setLoading(false);
          setError("template_id не задан");
          return;
        }

        const resp = await api.post(API_PREVIEW, payload);
        if (cancelled) return;

        const v = normalizeResponse(resp, payload);
        setView(v ?? { type: "text", payload: { text: "нет данных" } });
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(
          e?.response?.data?.detail || e?.message || "Ошибка предпросмотра"
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, payload]);

  if (loading) {
    return (
      <div className={styles.center}>
        <Spin />
      </div>
    );
  }
  if (error) return <Alert type="error" message={error} />;
  if (!view) return <div className={styles.textBox}>нет данных</div>;

  if (view.type === "image") {
    return (
      <div className={styles.imgBox}>
        <img src={view.payload.src} alt={view.payload.title || "preview"} />
      </div>
    );
  }

  if (view.type === "text") {
    return (
      <div className={styles.textBox}>
        <pre className={styles.textPre}>
          {view.payload.text || "нет данных"}
        </pre>
      </div>
    );
  }

  // table
  const cols: string[] = view.payload.columns || [];
  const rows: any[] = view.payload.rows || [];
  if (!rows.length) return <div className={styles.textBox}>нет данных</div>;

  return (
    <div className={styles.textBox}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: "left",
                  padding: "6px 8px",
                  borderBottom: "1px solid #eee",
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td
                  key={c}
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f5f5f5",
                  }}
                >
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
