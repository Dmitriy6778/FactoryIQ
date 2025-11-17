import React, { useEffect, useState, useRef } from "react";
import styles from "../styles/OpcTagsPage.module.css";
import BackButton from "../components/BackButton";
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { useApi } from "../shared/useApi";



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
  const api = useApi();
  // Загрузка серверов и интервалов при инициализации
   // =========================
  // ЛОГИКА
  // =========================

  // загрузка серверов и интервалов
  useEffect(() => {
    api.get<OpcServer[]>("/servers/servers").then((data) => {
      setServers(data || []);
      if (data && data.length > 0) setSelectedServer(data[0]);
    });
    api.get<{ items: PollingInterval[] }>("/polling/polling-intervals").then((data) => {
      const items = data?.items || [];
      setIntervals(items);
      if (items.length > 0) setSelectedIntervalId(items[0].id);
    });
  }, []);

  // формирование query-параметров
  function makeQueryParams(forPage = page) {
    const params = new URLSearchParams();
    params.set("page", forPage.toString());
    params.set("page_size", PAGE_SIZE.toString());
    if (selectedServer?.id) params.set("server_id", String(selectedServer.id));
    Object.entries(filters).forEach(([k, v]) => {
      if (v.trim() !== "") params.set(k, v);
    });
    return params;
  }

  // получение списка тегов с фильтрами
  function fetchTags(newPage = page) {
    setLoading(true);
    const params = makeQueryParams(newPage);
    const q = Object.fromEntries(params as any);
    api
      .get<{ items: OpcTag[]; total: number }>("/opctags/list", q)
      .then((data) => {
        setTags(data?.items || []);
        setTotal(data?.total || 0);
        setPage(newPage);
        setCheckedTagIds([]);
      })
      .catch((e) => console.error("[OpcTagsPage] Ошибка загрузки тегов:", e))
      .finally(() => setLoading(false));
  }

  // проверка соединения с сервером
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
    api
      .get<{ ok?: boolean }>(
        "/servers/probe",
        Object.fromEntries(new URLSearchParams(queryParams))
      )
      .then((data) => setPlcStatus(data?.ok ? "online" : "offline"))
      .catch(() => setPlcStatus("offline"));
  };

  // обновление живых значений
  function fetchLiveValues(tagIds: number[]) {
    if (!selectedServer || tagIds.length === 0) return;
    setLoading(true);
    api
      .post<{ ok: boolean; values?: Record<string, any> }>("/tags/live", {
        tag_ids: tagIds,
        server_id: selectedServer.id,
      })
      .then((data) => {
        if (data?.ok) setLiveValues(data.values || {});
        else setLiveValues({});
      })
      .catch(() => setLiveValues({}))
      .finally(() => setLoading(false));
  }

  // изменение фильтров
  function handleFilterChange(field: keyof TagFilters, value: string) {
    setFilters((f) => ({ ...f, [field]: value }));
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    debounceTimeout.current = setTimeout(() => fetchTags(1), 300);
  }

  function handleFilterKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") fetchTags(1);
  }

  function resetFilters() {
    setFilters({ ...emptyFilters });
    setTimeout(() => fetchTags(1), 100);
  }

  // обновление описания тега
  async function handleDescriptionChange(tag: OpcTag, newDesc: string) {
    try {
      await api.put(`/opctags/${tag.id}`, { description: newDesc });
      setTags((ts) =>
        ts.map((t) => (t.id === tag.id ? { ...t, description: newDesc } : t))
      );
    } catch (e) {
      console.error("[OpcTagsPage] Ошибка обновления описания тега:", e);
    }
  }

  // удаление тега
  async function handleDelete(id: number) {
    if (!window.confirm("Удалить этот тег?")) return;
    try {
      await api.del(`/opctags/${id}`);
      fetchTags();
    } catch (e) {
      console.error("[OpcTagsPage] Ошибка удаления тега:", e);
    }
  }

  // запуск опроса
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
      const data = await api.post<{
        ok: boolean;
        task_id?: number;
        added_tags?: any[];
        message?: string;
      }>("/polling/start_selected_polling", body);

      if (data.ok) {
        if (data.added_tags && data.added_tags.length > 0) {
          alert(
            `Теги добавлены к существующей задаче (task_id=${data.task_id}).\nДобавлено: ${data.added_tags.length}`
          );
        } else if (
          data.message &&
          data.message.includes("уже есть в текущей задаче")
        ) {
          alert(
            "Все выбранные теги уже присутствуют в активной задаче — ничего не изменено."
          );
        } else if (
          data.message &&
          data.message.includes("Создана новая задача")
        ) {
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

  // подгрузка при смене сервера
  useEffect(() => {
    if (selectedServer) {
      probePlc();
      fetchTags(1);
    }
    // eslint-disable-next-line
  }, [selectedServer]);

  // автообновление Live-значений
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const tagIds = tags.map((t) => t.id);
    fetchLiveValues(tagIds);
    intervalRef.current = window.setInterval(
      () => fetchLiveValues(tagIds),
      10000
    );
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line
  }, [autoRefresh, tags, selectedServer]);

  // очистка при размонтировании
  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);




  return (
    <div className={styles.page}>
      {/* --- ХЕДЕР --- */}
      <div className={styles.header}>
        <BackButton />
        <span className={styles.headerIcon}>🏷️</span>
        Управление OPC UA тегами
        <span className={styles.status}>
          {plcStatus === "online" && (
            <>
              <CheckCircle size={22} className={styles.statusIconOnline} />
              <span className={styles.statusTextOnline}>PLC: Online</span>
            </>
          )}
          {plcStatus === "offline" && (
            <>
              <XCircle size={22} className={styles.statusIconOffline} />
              <span className={styles.statusTextOffline}>PLC: Offline</span>
            </>
          )}
          {plcStatus === "pending" && (
            <>
              <AlertTriangle size={22} className={styles.statusIconPending} />
              <span className={styles.statusTextPending}>PLC: Проверка...</span>
            </>
          )}
        </span>
      </div>

      {/* --- ВЫБОР СЕРВЕРА --- */}
      <div className={styles.field}>
        <label>
          Сервер:&nbsp;
          <select
            value={selectedServer?.id || ""}
            onChange={e => {
              const srv = servers.find(s => s.id === Number(e.target.value));
              setSelectedServer(srv || null);
            }}
            className={styles.select}
          >
            {servers.map(server => (
              <option key={server.id} value={server.id}>
                {server.name} ({server.endpoint_url})
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* --- ИНТЕРВАЛ --- */}
      <div className={styles.field}>
        <label>
          Интервал опроса:&nbsp;
          <select
            value={selectedIntervalId}
            onChange={e => setSelectedIntervalId(Number(e.target.value))}
            className={styles.select}
          >
            {intervals.map(i => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.intervalSeconds} сек)
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.desc}>
        Просмотр, поиск, редактирование и удаление тегов <b>OpcTags</b>
      </div>

      {/* --- КНОПКИ LIVE --- */}
      <div className={styles.actions}>
        <button className={`${styles.button} ${styles.buttonRefresh}`} onClick={() => {
          const tagIds = tags.map(t => t.id);
          fetchLiveValues(tagIds);
        }}>
          🔄 Обновить значения (ручной запрос)
        </button>
        <button
          className={`${styles.button} ${autoRefresh ? styles.buttonAutoOn : styles.buttonAutoOff}`}
          onClick={() => setAutoRefresh(v => !v)}
        >
          {autoRefresh ? "⏸ Остановить автообновление" : "▶️ Включить автообновление (10 сек)"}
        </button>
      </div>

      {/* --- КНОПКА ОПРОСА --- */}
      <div className={styles.actions}>
        <button className={`${styles.button} ${styles.buttonStart}`} onClick={handleStartPolling}>
          ▶️ Запустить опрос выбранных тегов
        </button>
      </div>

      {/* --- ФИЛЬТРЫ --- */}
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

      {/* --- ТАБЛИЦА --- */}
      <div className={styles.tableViewport}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
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
              <th>Имя</th>
              <th>Node ID</th>
              <th>Тип</th>
              <th>Путь</th>
              <th>Значение</th>
              <th>Дата/Время</th>
              <th>Описание</th>
              <th></th>
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
                <td className={styles.cellTruncate}>{tag.browse_name}</td>
                <td className={styles.cellTruncate}>{tag.node_id}</td>
                <td>{tag.data_type}</td>
                <td className={styles.cellTruncate}>{tag.path}</td>
                <td className={styles.valueCell}>
                  {liveValues[tag.id] !== undefined && liveValues[tag.id] !== null
                    ? (typeof liveValues[tag.id].value === "number"
                      ? liveValues[tag.id].value.toFixed(2)
                      : String(liveValues[tag.id].value))
                    : <span className={styles.valueEmpty}>–</span>
                  }
                </td>
                <td className={styles.timestampCell}>
                  {liveValues[tag.id] && liveValues[tag.id].timestamp
                    ? new Date(liveValues[tag.id].timestamp).toLocaleString()
                    : ""}
                </td>
                <td>
                  <input
                    className={styles.input}
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
                  <button
                    className={`${styles.button} ${styles.buttonDelete}`}
                    onClick={() => handleDelete(tag.id)}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {tags.length === 0 && (
              <tr>
                <td colSpan={9} className={styles.noData}>Нет тегов</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* --- ПАГИНАЦИЯ --- */}
      <div className={styles.pagination}>
        <button className={styles.button} onClick={() => fetchTags(1)}>Обновить</button>
        <button className={styles.button} onClick={resetFilters}>Сбросить фильтры</button>
        <span>Показано: {tags.length} из {total}</span>
        <button className={styles.button} disabled={page <= 1} onClick={() => fetchTags(page - 1)}>{"<"}</button>
        <span>Страница {page}</span>
        <button className={styles.button} disabled={(page * PAGE_SIZE) >= total} onClick={() => fetchTags(page + 1)}>{">"}</button>
      </div>

      {loading && <div className={styles.loading}>Загрузка...</div>}
    </div>
  );

};

export default OpcTagsPage;
