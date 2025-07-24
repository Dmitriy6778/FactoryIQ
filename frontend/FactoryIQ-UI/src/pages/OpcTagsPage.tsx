import React, { useEffect, useState, useRef } from "react";
import styles from "../styles/OpcTagsPage.module.css";
import BackButton from "../components/BackButton";
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react";

type PollingInterval = {
  id: number;
  name: string;
  intervalSeconds: number;
};

type OpcTag = {
  id: number;
  browse_name: string;
  node_id: string;
  data_type: string;
  description: string;
  path: string;
};

type OpcServer = {
  id?: number;
  name: string;
  endpoint_url: string;
  description?: string;
  opcUsername?: string;
  opcPassword?: string;
  securityPolicy?: string;
  securityMode?: string;
};

type TagFilters = {
  browse_name: string;
  node_id: string;
  data_type: string;
  path: string;
  description: string;
};

const PAGE_SIZE = 200;
const emptyFilters: TagFilters = {
  browse_name: "",
  node_id: "",
  data_type: "",
  path: "",
  description: "",
};

const OpcTagsPage: React.FC = () => {
  const [tags, setTags] = useState<OpcTag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<TagFilters>({ ...emptyFilters });
  const [loading, setLoading] = useState(false);
  const [liveValues, setLiveValues] = useState<{ [nodeId: string]: any }>({});
  const [checkedTagIds, setCheckedTagIds] = useState<number[]>([]);
  const [plcStatus, setPlcStatus] = useState<"online" | "offline" | "pending">("pending");
  const intervalRef = useRef<number | null>(null);
  const [servers, setServers] = useState<OpcServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<OpcServer | null>(null);

  const DEFAULT_POLICIES = ["Basic256Sha256", "None"];
  const DEFAULT_MODES = ["Sign", "None"];
  const [intervals, setIntervals] = useState<PollingInterval[]>([]);
  const [selectedIntervalId, setSelectedIntervalId] = useState<number>(1);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Загрузка серверов и интервалов при инициализации
  useEffect(() => {
    fetch("http://localhost:8000/servers/servers")
      .then(res => res.json())
      .then(data => {
        setServers(data);
        if (data.length > 0) setSelectedServer(data[0]);
      });
    fetch("http://localhost:8000/polling/polling-intervals")
      .then(res => res.json())
      .then(data => {
        setIntervals(data.items || []);
        if (data.items && data.items.length > 0) setSelectedIntervalId(data.items[0].id);
      });
  }, []);

  function makeQueryParams(forPage = page) {
    const params = new URLSearchParams();
    params.set("page", forPage.toString());
    params.set("page_size", PAGE_SIZE.toString());
    Object.entries(filters).forEach(([k, v]) => {
      if (v.trim() !== "") params.set(k, v);
    });
    return params;
  }

  function fetchTags(newPage = page) {
    setLoading(true);
    const params = makeQueryParams(newPage);
    fetch(`http://localhost:8000/tags/all-tags?${params}`)
      .then(res => res.json())
      .then(data => {
        setTags(data.items || []);
        setTotal(data.total || 0);
        setPage(newPage);
        setCheckedTagIds([]);
      })
      .catch(e => console.error("[OpcTagsPage] Ошибка загрузки тегов:", e))
      .finally(() => setLoading(false));
  }

  // --- ПРОБА СОЕДИНЕНИЯ ---
  const probePlc = () => {
    if (!selectedServer) {
      console.warn("[OpcTagsPage] Нет выбранного сервера для probePlc");
      return;
    }
    setPlcStatus("pending");
    const queryParams = new URLSearchParams({
      endpoint_url: selectedServer.endpoint_url,
      opcUsername: selectedServer.opcUsername || "",
      opcPassword: selectedServer.opcPassword || "",
      securityPolicy: selectedServer.securityPolicy || "Basic256Sha256",
      securityMode: selectedServer.securityMode || "Sign",
    }).toString();
    fetch(`http://localhost:8000/servers/probe?${queryParams}`)
      .then(res => res.json())
      .then(data => setPlcStatus(data.ok ? "online" : "offline"))
      .catch(() => setPlcStatus("offline"));
  };

  function fetchLiveValues(tagIds: number[]) {
    if (!selectedServer || tagIds.length === 0) {
      return;
    }
    setLoading(true);
    fetch("http://localhost:8000/tags/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_ids: tagIds,
        server_id: selectedServer.id,
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.ok) setLiveValues(data.values || {});
        else setLiveValues({});
      })
      .catch(() => setLiveValues({}))
      .finally(() => setLoading(false));
  }

  function handleFilterChange(field: keyof TagFilters, value: string) {
    setFilters(f => ({ ...f, [field]: value }));

    // Debounce-поиск
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    debounceTimeout.current = setTimeout(() => {
      fetchTags(1);
    }, 300); // 300мс задержка, можно больше/меньше
  }

  function handleFilterKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") fetchTags(1);
  }

  function resetFilters() {
    setFilters({ ...emptyFilters });
    setTimeout(() => fetchTags(1), 100);
  }

  async function handleDescriptionChange(tag: OpcTag, newDesc: string) {
    try {
      await fetch(`http://localhost:8000/tags/${tag.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: newDesc }),
      });
      setTags(ts => ts.map(t => (t.id === tag.id ? { ...t, description: newDesc } : t)));
    } catch (e) {
      console.error("[OpcTagsPage] Ошибка обновления описания тега:", e);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Удалить этот тег?")) return;
    try {
      await fetch(`http://localhost:8000/tags/${id}`, { method: "DELETE" });
      fetchTags();
    } catch (e) {
      console.error("[OpcTagsPage] Ошибка удаления тега:", e);
    }
  }

  async function handleStartPolling() {
    if (!checkedTagIds.length || !selectedServer) {
      alert("Выберите сервер и хотя бы один тег для опроса.");
      return;
    }
    const selectedTags = tags.filter((t) => checkedTagIds.includes(t.id));
    const body = {
      server_id: selectedServer.id,
      endpoint_url: selectedServer.endpoint_url,
      opcUsername: selectedServer.opcUsername || "",
      opcPassword: selectedServer.opcPassword || "",
      securityPolicy: selectedServer.securityPolicy || DEFAULT_POLICIES[0],
      securityMode: selectedServer.securityMode || DEFAULT_MODES[0],
      tags: selectedTags.map((t) => ({
        node_id: t.node_id,
        browse_name: t.browse_name,
        data_type: t.data_type,
        description: t.description || "",
      })),
      interval_id: selectedIntervalId,
    };
    try {
      const res = await fetch("http://localhost:8000/polling/start_selected_polling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        if (data.added_tags && data.added_tags.length > 0) {
          alert(`Теги добавлены к существующей задаче (task_id=${data.task_id}).\nДобавлено: ${data.added_tags.length}`);
        } else if (data.message && data.message.includes("уже есть в текущей задаче")) {
          alert("Все выбранные теги уже присутствуют в активной задаче — ничего не изменено.");
        } else if (data.message && data.message.includes("Создана новая задача")) {
          alert(`Создана новая задача опроса! (task_id=${data.task_id})`);
        } else {
          alert("Операция завершена: " + (data.message || ""));
        }
      } else {
        alert("Ошибка запуска: " + (data.message || "Неизвестная ошибка"));
      }
    } catch (err) {
      alert("Ошибка соединения: " + err);
    }
  }

  // Основная подгрузка тегов при изменении сервера
  useEffect(() => {
    if (selectedServer) {
      probePlc();
      fetchTags(1);
    }
    // eslint-disable-next-line
  }, [selectedServer]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const tagIds = tags.map(t => t.id);
    fetchLiveValues(tagIds);
    intervalRef.current = window.setInterval(() => fetchLiveValues(tagIds), 10000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    // eslint-disable-next-line
  }, [autoRefresh, tags, selectedServer]);

  // Отключение автообновления при уходе со страницы
  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);


  return (
    <div className={styles.page} style={{ minWidth: 0 }}>
      <div className={styles.header}>
        <BackButton />
        <span className={styles.headerIcon}>🏷️</span> Управление OPC UA тегами
        {/* --- ИНДИКАТОР СОЕДИНЕНИЯ С PLC --- */}
        <span style={{ marginLeft: 30, display: "flex", alignItems: "center", gap: 7 }}>
          {plcStatus === "online" && (
            <>
              <CheckCircle size={22} color="#4CAF50" style={{ verticalAlign: "middle" }} />
              <span style={{ color: "#3dc668", fontWeight: 600 }}>PLC: Online</span>
            </>
          )}
          {plcStatus === "offline" && (
            <>
              <XCircle size={22} color="#ff4343" style={{ verticalAlign: "middle" }} />
              <span style={{ color: "#ff4343", fontWeight: 600 }}>PLC: Offline</span>
            </>
          )}
          {plcStatus === "pending" && (
            <>
              <AlertTriangle size={22} color="#e4b600" style={{ verticalAlign: "middle" }} />
              <span style={{ color: "#e4b600", fontWeight: 600 }}>PLC: Проверка...</span>
            </>
          )}
        </span>
      </div>



      <div style={{ marginBottom: 16 }}>
        <label>Сервер:&nbsp;
          <select
            value={selectedServer?.id || ""}
            onChange={e => {
              const srv = servers.find(s => s.id === Number(e.target.value));
              setSelectedServer(srv || null);
            }}
            style={{ minWidth: 300, padding: 4 }}
          >
            {servers.map(server => (
              <option key={server.id} value={server.id}>
                {server.name} ({server.endpoint_url})
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* === Интервал перед запуском === */}
      <div style={{ margin: "0 0 12px 0" }}>
        <label>Интервал опроса:&nbsp;
          <select
            value={selectedIntervalId}
            onChange={e => setSelectedIntervalId(Number(e.target.value))}
            style={{ minWidth: 180, padding: 4 }}
          >
            {intervals.map(i => (
              <option key={i.id} value={i.id}>{i.name} ({i.intervalSeconds} сек)</option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.desc}>
        Просмотр, поиск, редактирование и удаление тегов <b>OpcTags</b>
      </div>
      {/* КНОПКИ УПРАВЛЕНИЯ LIVE */}
      <div style={{ margin: "14px 0 12px 0", display: "flex", gap: 14 }}>
        <button
          className={styles.button}
          style={{ background: "#f7faff", color: "#0aa", fontWeight: 700 }}
          onClick={() => {
            const tagIds = tags.map(t => t.id);
            fetchLiveValues(tagIds);
          }}
        >
          🔄 Обновить значения (ручной запрос)
        </button>
        <button
          className={styles.button}
          style={{
            background: autoRefresh ? "#d3ffe4" : "#fff",
            color: autoRefresh ? "#159a52" : "#aaa",
            fontWeight: 700
          }}
          onClick={() => setAutoRefresh(v => !v)}
        >
          {autoRefresh ? "⏸ Остановить автообновление" : "▶️ Включить автообновление (10 сек)"}
        </button>
      </div>
      {/* --- КНОПКА ЗАПУСКА ОПРОСА --- */}
      <div style={{ margin: "18px 0 8px 0" }}>
        <button
          className={styles.button}
          style={{ background: "#e7fff4", color: "#159a52", fontWeight: 700 }}
          onClick={handleStartPolling}
        >
          ▶️ Запустить опрос выбранных тегов
        </button>
      </div>
      {/* -------------------------------- */}

      <div className={styles.tableFilters}>
        <input
          className={styles.input}
          placeholder="Имя..."
          value={filters.browse_name}
          onChange={e => handleFilterChange("browse_name", e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        <input
          className={styles.input}
          placeholder="Node ID..."
          value={filters.node_id}
          onChange={e => handleFilterChange("node_id", e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        <input
          className={styles.input}
          placeholder="Тип..."
          value={filters.data_type}
          onChange={e => handleFilterChange("data_type", e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        <input
          className={styles.input}
          placeholder="Путь..."
          value={filters.path}
          onChange={e => handleFilterChange("path", e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        <input
          className={styles.input}
          placeholder="Описание..."
          value={filters.description || ""}
          onChange={e => handleFilterChange("description", e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        <button className={styles.button} onClick={() => fetchTags(1)}>🔍</button>
        <button className={styles.button} onClick={resetFilters}>Сброс</button>
        <span className={styles.filtersInfo}>
          Показано: {tags.length} из {total}
        </span>
      </div>

      <div style={{ width: "100%", maxWidth: "none" }}>
        <table className={styles.table} style={{ width: "99vw", minWidth: 1280, maxWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 38 }}>
                <input
                  type="checkbox"
                  checked={checkedTagIds.length === tags.length && tags.length > 0}
                  onChange={e =>
                    setCheckedTagIds(
                      e.target.checked ? tags.map(t => t.id) : []
                    )
                  }
                  title="Выбрать все"
                />
              </th>
              <th style={{ minWidth: 80, maxWidth: 140 }}>Имя</th>
              <th style={{ minWidth: 150, maxWidth: 310 }}>Node ID</th>
              <th style={{ width: 80 }}>Тип</th>
              <th style={{ minWidth: 210, maxWidth: 350 }}>Путь</th>
              <th style={{ width: 90 }}>Значение</th>
              <th style={{ width: 150 }}>Дата/Время</th>
              <th style={{ width: 200 }}>Описание</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr key={tag.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={checkedTagIds.includes(tag.id)}
                    onChange={e => {
                      setCheckedTagIds(checked =>
                        e.target.checked
                          ? [...checked, tag.id]
                          : checked.filter(id => id !== tag.id)
                      );
                    }}
                  />
                </td>
                <td style={{
                  maxWidth: 140,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                }}>{tag.browse_name}</td>
                <td style={{
                  maxWidth: 300,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                }}>{tag.node_id}</td>
                <td>{tag.data_type}</td>
                <td style={{
                  maxWidth: 350,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                }}>{tag.path}</td>
                {/* Значение */}
                <td style={{ color: "#22938e", fontWeight: 600, fontFamily: "monospace" }}>
                  {liveValues[tag.id] !== undefined && liveValues[tag.id] !== null
                    ? (typeof liveValues[tag.id].value === "number"
                      ? liveValues[tag.id].value.toFixed(2)
                      : String(liveValues[tag.id].value))
                    : <span style={{ color: "#aaa" }}>–</span>
                  }
                </td>
                {/* Дата/Время */}
                <td style={{ color: "#aaa", fontSize: 12 }}>
                  {liveValues[tag.id] && liveValues[tag.id].timestamp
                    ? new Date(liveValues[tag.id].timestamp).toLocaleString()
                    : ""}
                </td>
                <td>
                  <input
                    className={styles.input}
                    style={{ width: "97%" }}
                    value={tag.description ?? ""}
                    onChange={e => {
                      const value = e.target.value;
                      setTags(tags =>
                        tags.map(t =>
                          t.id === tag.id ? { ...t, description: value } : t
                        )
                      );
                    }}
                    onBlur={e => handleDescriptionChange(tag, e.target.value)}
                    onKeyDown={async e => {
                      if (e.key === "Enter") {
                        await handleDescriptionChange(tag, tag.description);
                      }
                    }}
                    placeholder="—"
                  />
                </td>
                <td>
                  <button className={styles.button} style={{ background: "#ffd6d6", color: "#e12d2d", fontWeight: 700 }}
                    onClick={() => handleDelete(tag.id)}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {tags.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "#aaa", fontStyle: "italic" }}>Нет тегов</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ margin: "20px 0", display: "flex", gap: 14, alignItems: "center" }}>
        <button className={styles.button} onClick={() => fetchTags(1)}>Обновить</button>
        <button className={styles.button} onClick={resetFilters}>Сбросить фильтры</button>
        <span>Показано: {tags.length} из {total}</span>
        <button className={styles.button} disabled={page <= 1} onClick={() => fetchTags(page - 1)}>{"<"}</button>
        <span>Страница {page}</span>
        <button className={styles.button} disabled={(page * PAGE_SIZE) >= total} onClick={() => fetchTags(page + 1)}>{">"}</button>
      </div>
      {loading && <div style={{ color: "#19acac", margin: "18px 0" }}>Загрузка...</div>}
    </div>
  );


};

export default OpcTagsPage;
