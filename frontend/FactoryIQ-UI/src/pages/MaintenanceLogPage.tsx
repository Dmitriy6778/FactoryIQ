// client/src/pages/MaintenanceLogPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import { http, buildQuery } from "../shared/http";

type Row = {
  LogId: number;
  LoggedAt: string;
  Author: string;
  ActionType: string;
  Status?: string;
  Comment?: string;
};

function fmt(dt: string) {
  try {
    const d = new Date(dt); // уже локальное +05, как записали в БД
    return d.toLocaleString("ru-RU", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return dt;
  }
}




export default function MaintenanceLogPage() {
  // Берём tag из строки запроса (WinCC открывает так: /maintenance/ui?tag=P01020_1)
  const params = new URLSearchParams(window.location.search);
  const tag = params.get("tag") || "UNKNOWN";

  const [rows, setRows] = useState<Row[]>([]);
  const [actionType, setActionType] = useState("Осмотр");
  const [status, setStatus] = useState("Открыто");
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useMemo(() => buildQuery({ tag, limit: 200 }), [tag]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await http<{ ok: boolean; rows: Row[] }>(`/maintenance/logs${q}`, "GET");
      setRows(res?.rows ?? []);
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim() && actionType === "Осмотр") {
      // не заставляю, просто подсказка
    }
    setLoading(true);
    setErr(null);
    try {
      await http("/maintenance/logs", "POST", {
        body: {
          tag_name: tag,
          action: actionType,
          status,
          comment,
          author: "wincc",
        },
      });
      setComment("");
      await load();
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "Ошибка сохранения");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  return (
    <div style={{ fontFamily: "Segoe UI, Arial, sans-serif", padding: 12, maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          Журнал ремонта <span style={{ color: "#777" }}>•</span>{" "}
          <span style={{ color: "#444" }}>{tag}</span>
        </h3>
        <button type="button" onClick={load} disabled={loading} style={{ marginLeft: "auto" }}>
          Обновить
        </button>
      </div>

      <form onSubmit={save} style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label>Тип:</label>
          <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
            <option>Осмотр</option>
            <option>Ремонт</option>
            <option>Замена</option>
            <option>Прочее</option>
          </select>

          <label>Статус:</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>Открыто</option>
            <option>В работе</option>
            <option>Закрыто</option>
          </select>

          <button type="submit" disabled={loading} style={{ fontWeight: 600 }}>
            Сохранить
          </button>
        </div>

        <textarea
          placeholder="Комментарий..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ width: "100%", height: 90 }}
        />
      </form>

      {err && <div style={{ color: "#b00", marginBottom: 8 }}>{String(err)}</div>}
      {loading && <div style={{ color: "#666", marginBottom: 8 }}>Загрузка…</div>}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Дата/время</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Автор</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Действие</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Статус</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Комментарий</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.LogId}>
              <td style={{ borderBottom: "1px solid #f2f2f2", padding: 6 }}>{fmt(r.LoggedAt)}</td>
              <td style={{ borderBottom: "1px solid #f2f2f2", padding: 6 }}>{r.Author}</td>
              <td style={{ borderBottom: "1px solid #f2f2f2", padding: 6 }}>{r.ActionType}</td>
              <td style={{ borderBottom: "1px solid #f2f2f2", padding: 6 }}>{r.Status}</td>
              <td style={{ borderBottom: "1px solid #f2f2f2", padding: 6, whiteSpace: "pre-wrap" }}>
                {r.Comment}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={5} style={{ padding: 8, color: "#777" }}>
                Нет записей
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
