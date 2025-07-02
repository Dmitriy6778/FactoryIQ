import React, { useEffect, useState } from "react";
import styles from "../styles/PollingTasksPage.module.css";
import BackButton from "../components/BackButton"; // Импортируем кнопку назад

type OpcTag = {
  id: number;
  browse_name: string;
  node_id: string;
  data_type?: string;
};

type PollingTask = {
  id: number;
  server_url: string;
  interval_id: number;
  interval_name: string;
  interval_seconds: number;
  is_active: boolean;
  started_at?: string;
  tags: OpcTag[];
};

type PollingInterval = {
  id: number;
  name: string;
  interval_seconds: number;
  type: string;
};


const API = "http://localhost:8000/polling/polling-tasks";

const PollingTasksPage: React.FC = () => {
  const [tasks, setTasks] = useState<PollingTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [intervals, setIntervals] = useState<PollingInterval[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);

  // Получить интервалы
  const fetchIntervals = async () => {
    const res = await fetch("http://localhost:8000/polling/polling-intervals");
    const data = await res.json();
    setIntervals(data.items || []);
  };


  // Получить список задач
  const fetchTasks = async () => {
    setLoading(true);
    const res = await fetch(API);
    const data = await res.json();
    // Обеспечиваем наличие массива tags у каждой задачи
    const fixedTasks = (data.tasks || []).map((task: any) => ({
      ...task,
      tags: Array.isArray(task.tags) ? task.tags : [],
    }));
    setTasks(fixedTasks);
    setLoading(false);
  };


  useEffect(() => {
    fetchIntervals();
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  const stopTask = async (id: number) => {
    await fetch("http://localhost:8000/polling/polling-tasks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: id }),
    });
    fetchTasks();
  };

  const deleteTask = async (id: number) => {
    await fetch("http://localhost:8000/polling/polling-tasks/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: id }),
    });
    fetchTasks();
  };

  const startTask = async (id: number) => {
    await fetch("http://localhost:8000/polling/polling-tasks/start-by-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: id }),
    });
    fetchTasks();
  };



  const stopAll = async () => {
    await fetch("http://localhost:8000/polling/stop_all", { method: "POST" });
    fetchTasks();
  };

  const startAll = async () => {
    await fetch("http://localhost:8000/polling/start_all", { method: "POST" });
    fetchTasks();
  };

  const changeInterval = async (taskId: number, intervalId: number) => {
    await fetch("http://localhost:8000/polling/polling-tasks/update-interval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, interval_id: intervalId }),
    });
    fetchTasks();
  };

  const handleShowTags = (taskId: number) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <BackButton />
        <div className={styles.title}>
          <span className={styles.iconMain}>
            <svg width="27" height="27" viewBox="0 0 26 26" fill="none">
              <rect x="3" y="6" width="6" height="14" rx="2.5" fill="#00ffc6" />
              <rect x="11" y="2" width="6" height="18" rx="2.5" fill="#34c6ff" />
              <rect x="19" y="10" width="6" height="10" rx="2.5" fill="#11e7f4" />
            </svg>
          </span>
          Мониторинг задач опроса OPC UA
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.btn} onClick={startAll}>
            <span className={styles.iconBtn}>▶️</span> Запустить все
          </button>
          <button className={styles.btn} onClick={stopAll}>
            <span className={styles.iconBtn}>⏹️</span> Остановить все
          </button>
        </div>
        {loading && <div className={styles.loader}>Загрузка...</div>}
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <span className={styles.iconTh}>#</span> ID
              </th>
              <th>
                <span className={styles.iconTh}>🔗</span> Сервер
              </th>
              <th>
                <span className={styles.iconTh}>⏱</span> Интервал
              </th>
              <th>
                <span className={styles.iconTh}>🏷</span> Теги
              </th>
              <th>
                <span className={styles.iconTh}>⏲</span> Старт
              </th>
              <th>
                <span className={styles.iconTh}>🟢</span> Статус
              </th>
              <th>
                <span className={styles.iconTh}>⚙️</span> Действия
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task, idx) => (
              <React.Fragment key={task.id}>
                <tr
                  data-active={task.is_active}
                  style={{
                    animation: `fadeInRow 0.9s cubic-bezier(.52,.11,.46,.90)`,
                    animationDelay: `${0.04 * idx}s`,
                  }}
                  className={styles.row}
                >
                  <td>{task.id}</td>
                  <td>
                    <span
                      className={styles.serverLink}
                      onClick={() => handleShowTags(task.id)}
                      title="Показать/скрыть теги"
                    >
                      {task.server_url}
                    </span>
                  </td>
                  <td>
                    <select
                      className={styles.select}
                      value={task.interval_id}
                      onChange={e => changeInterval(task.id, Number(e.target.value))}
                      disabled={!task.is_active}
                    >
                      {intervals.map(iv => (
                        <option key={iv.id} value={iv.id}>
                          {iv.name} ({iv.interval_seconds}s)
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className={styles.btnMini} onClick={() => handleShowTags(task.id)}>
                      {expandedTaskId === task.id ? "Скрыть" : "Показать"} <b>({task.tags.length})</b>
                    </button>
                  </td>
                  <td>{task.started_at?.replace("T", " ").slice(0, 19)}</td>
                  <td>
                    <span className={task.is_active ? `${styles.status} ${styles.active}` : `${styles.status} ${styles.stopped}`}>
                      {task.is_active ? "Активна" : "Остановлена"}
                    </span>
                  </td>
                  <td className={styles.actionBtns}>
                    {task.is_active ? (
                      <button className={styles.btnMini} onClick={() => stopTask(task.id)}>
                        ⏹️ Остановить
                      </button>
                    ) : (
                      <button className={styles.btnMini} onClick={() => startTask(task.id)}>
                        ▶️ Запустить
                      </button>
                    )}
                    <button
                      className={styles.btnMini}
                      style={{ background: "#fa4d4d", color: "#fff" }}
                      onClick={() => deleteTask(task.id)}
                    >
                      🗑 Удалить
                    </button>
                  </td>
                </tr>
                {expandedTaskId === task.id && (
                  <tr>
                    <td colSpan={7}>
                      <div className={styles.collapse}>
                        <b>Теги задачи:</b>
                        {task.tags.length === 0 ? (
                          <div style={{ color: "#888" }}>Нет тегов</div>
                        ) : (
                          <ul className={styles.tagList}>
                            {task.tags.map(t => (
                              <li key={t.id}>
                                <b>{t.browse_name}</b>{" "}
                                <span style={{ color: "#888" }}>
                                  [{t.node_id}] {t.data_type ? `(${t.data_type})` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

};

export default PollingTasksPage;
