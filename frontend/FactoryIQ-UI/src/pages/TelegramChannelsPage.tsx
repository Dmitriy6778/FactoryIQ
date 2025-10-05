import React, { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
} from "lucide-react";
import BackButton from "../components/BackButton";
import styles from "../styles/TelegramChannelsPage.module.css";

/** ---------- Типы ---------- */
type TgChannel = {
  id: number;
  channelId: string; // показываем как строку в UI, но шлём числом
  channelName: string;
  active: boolean;
  createdAt?: string | null;
};

type ApiList = TgChannel[] | { items: TgChannel[] };

/** ---------- API ---------- */
const API = {
  list: "http://localhost:8000/tg/channels",
  create: "http://localhost:8000/tg/channels",
  update: (id: number) => `http://localhost:8000/tg/channels/${id}`,
  remove: (id: number) => `http://localhost:8000/tg/channels/${id}`,
};

async function fetchJSON<T = any>(
  input: RequestInfo,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(input, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data?.detail ?? data ?? {}));
  return data as T;
}

/** Бэкенд отдаёт PascalCase; нормализуем к нашему типу */
const normalize = (r: any): TgChannel => ({
  id: r.Id ?? r.id,
  channelId: String(r.ChannelId ?? r.channelId ?? ""),
  channelName: r.ChannelName ?? r.channelName ?? "",
  active: Boolean(r.Active ?? r.active ?? 1),
  createdAt: r.CreatedAt ?? r.createdAt ?? null,
});

/** Пэйлоад под упрощённый бэкенд */
const toApiPayload = (v: TgChannel) => ({
  ChannelId: Number(v.channelId),
  ChannelName: v.channelName,
  Active: v.active ? 1 : 0,
});

const emptyForm: TgChannel = {
  id: 0,
  channelId: "",
  channelName: "",
  active: true,
  createdAt: null,
};

/** ---------- Компонент ---------- */
const TelegramChannelsPage: React.FC = () => {
  const [rows, setRows] = useState<TgChannel[]>([]);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<TgChannel | null>(null);
  const [form, setForm] = useState<TgChannel>(emptyForm);
  const [open, setOpen] = useState(false);

  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.channelName.toLowerCase().includes(q) ||
        r.channelId.toLowerCase().includes(q)
    );
  }, [rows, search]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchJSON<ApiList>(API.list);
      const list = Array.isArray(data) ? data : data.items ?? [];
      setRows(list.map(normalize));
    } catch (e) {
      console.error("load:", e);
      alert("Не удалось загрузить список каналов");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const startCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setOpen(true);
  };

  const startEdit = (r: TgChannel) => {
    setEditing(r);
    setForm({ ...r });
    setOpen(true);
  };

  const save = async () => {
    try {
      if (!form.channelId?.trim()) return alert("Укажи ChannelId");
      if (Number.isNaN(Number(form.channelId)))
        return alert("ChannelId должен быть числом (например -100...)");
      if (!form.channelName?.trim()) return alert("Укажи название");

      const payload = toApiPayload(form);
      if (editing) {
        await fetchJSON(API.update(editing.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await fetchJSON(API.create, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      setOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      console.error("save:", e);
      alert("Ошибка сохранения");
    }
  };

  const removeRow = async (r: TgChannel) => {
    if (!confirm(`Удалить канал "${r.channelName}"?`)) return;
    try {
      await fetchJSON(API.remove(r.id), { method: "DELETE" });
      await load();
    } catch (e) {
      console.error("delete:", e);
      alert("Ошибка удаления");
    }
  };

  const toggleActive = async (r: TgChannel) => {
    try {
      const next: TgChannel = { ...r, active: !r.active };
      await fetchJSON(API.update(r.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toApiPayload(next)),
      });
      setRows((prev) => prev.map((x) => (x.id === r.id ? next : x)));
    } catch {
      alert("Не удалось изменить статус");
    }
  };

  return (
    <div className={styles.page}>
      <BackButton />
      <div className={styles.header}>
        <h2 className={styles.title}>Телеграм-каналы</h2>
        <div className={styles.actions}>
          <button
            className="btn"
            onClick={load}
            disabled={loading}
            title="Обновить"
          >
            <RefreshCw size={18} /> Обновить
          </button>
          <button className="btn" onClick={startCreate}>
            <Plus size={18} /> Добавить канал
          </button>
        </div>
      </div>

      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="Поиск по названию или ChannelId…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>ID</th>
              <th className={styles.th}>ChannelId</th>
              <th className={styles.th}>Название</th>
              <th className={styles.th}>Статус</th>
              <th className={styles.th}>Создано</th>
              <th className={styles.th} style={{ width: 180 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className={styles.tdCenter}>{r.id}</td>
                <td className={styles.td}>
                  <code>{r.channelId}</code>
                </td>
                <td className={styles.td}>{r.channelName}</td>
                <td className={styles.tdCenter}>
                  {r.active ? (
                    <span className={styles.statusOn}>
                      <CheckCircle size={16} /> Активен
                    </span>
                  ) : (
                    <span className={styles.statusOff}>
                      <XCircle size={16} /> Отключен
                    </span>
                  )}
                </td>
                <td className={styles.tdCenter}>
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                </td>
                <td className={styles.tdRight}>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      className="btn"
                      onClick={() => toggleActive(r)}
                      title="Вкл/Выкл"
                    >
                      {r.active ? "Отключить" : "Включить"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => startEdit(r)}
                      title="Редактировать"
                    >
                      <Edit size={16} />
                    </button>
                    <button
                      className="btn"
                      onClick={() => removeRow(r)}
                      title="Удалить"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  {loading ? "Загрузка…" : "Пусто"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard}>
            <h3 style={{ marginTop: 0 }}>
              {editing ? "Редактировать канал" : "Добавить канал"}
            </h3>

            <div className={styles.formGrid}>
              <label>ChannelId</label>
              <input
                value={form.channelId}
                onChange={(e) =>
                  setForm({ ...form, channelId: e.target.value })
                }
                placeholder="-1002668981848"
              />

              <label>Название</label>
              <input
                value={form.channelName}
                onChange={(e) =>
                  setForm({ ...form, channelName: e.target.value })
                }
                placeholder="AltaiMai – Мониторинг"
              />
            </div>

            <div className={styles.switches}>
              <label>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                />{" "}
                Активен
              </label>
            </div>

            <div className={styles.modalActions}>
              <button
                className="btn"
                onClick={() => {
                  setOpen(false);
                  setEditing(null);
                }}
              >
                Отмена
              </button>
              <button className="btn" onClick={save}>
                {editing ? "Сохранить" : "Добавить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TelegramChannelsPage;
