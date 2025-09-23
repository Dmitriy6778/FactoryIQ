import React, { useState, useEffect } from "react";
import styles from "../styles/SettingsPage.module.css";
import logo from "../../assets/images/logo.jpeg";
import { CheckCircle, Loader, ChevronRight, Search } from "lucide-react";
import BackButton from "../components/BackButton"; // Импортируем кнопку назад

type DbConfig = {
  server: string;
  database: string;
  user: string;
  password: string;
  driver: string;
};

const defaultDbConfig: DbConfig = {
  server: "localhost",
  database: "OpcUaSystem",
  user: "",
  password: "",
  driver: "ODBC Driver 18 for SQL Server",
};

const stepsData = [
  { label: "Полная установка SQL", desc: "Создаём пользователя, БД и права" },
  { label: "Проверить соединение", desc: "Проверяем параметры подключения" },
  { label: "Создать структуру", desc: "Создаём таблицы для хранения данных" },
  { label: "Сохранить", desc: "Фиксируем параметры в системе" },
  { label: "Сгенерировать сертификаты", desc: "Создание клиентских ключей OPC UA" },

  {
    label: "Перейти к OPC UA серверам",
    desc: "Дальнейшая работа с источниками данных",
  },
];

const StartPage: React.FC = () => {
  const [config, setConfig] = useState<DbConfig>(defaultDbConfig);
  const [status, setStatus] = useState<null | { ok: boolean; message: string }>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState(1); // шаг (1..5)
  const [completed, setCompleted] = useState<number[]>([]); // завершённые шаги
  const [servers, setServers] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<string[]>([]);
  const [dbList, setDbList] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);

  // 2. Загрузка доступных ODBC драйверов
  useEffect(() => {
    fetch("http://localhost:8000/db/odbc-drivers")
      .then((res) => res.json())
      .then((data) => setDrivers(data.drivers || []))
      .catch(() => setDrivers([]));
  }, []);

  // 3. Прогресс-бар: обновление по шагу
  useEffect(() => {
    setProgress(((step - 1) / (stepsData.length - 1)) * 100);
  }, [step]);

  // --- Хэндлеры ---
  const generateCerts = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch("http://localhost:8000/opcua/gen-client-cert", {
        method: "POST",
      });
      const data = await res.json();
      setStatus({ ok: data.ok, message: data.message });
      if (data.ok) {
        setCompleted((prev) => [...prev, 5]);
        setStep(6);
      }
    } catch (e) {
      setStatus({ ok: false, message: "Ошибка при генерации сертификатов" });
    }
    setIsLoading(false);
  };

  const fetchSqlInstances = async () => {
    setServers([]);
    try {
      const res = await fetch("http://localhost:8000/db/sql-instances");
      const data = await res.json();
      if (data.ok && data.servers.length) {
        setServers(data.servers);
        setConfig((cfg) => ({
          ...cfg,
          server: data.servers[0],
        }));
      } else {
        setServers([]);
        alert(data.message || "Экземпляры SQL Server не найдены");
      }
    } catch {
      setServers([]);
      alert("Ошибка поиска экземпляров SQL Server");
    }
  };

  const fetchDatabases = async () => {
    setDbList([]);
    try {
      const res = await fetch("http://localhost:8000/db/list-databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.ok) setDbList(data.databases);
      else alert(data.message);
    } catch {
      alert("Ошибка соединения с сервером");
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setConfig((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  // --- Логика шагов ---

  // 1. Полная установка SQL
  const initFullWindowsAuth = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch(
        "http://localhost:8000/db/init-full-windows-auth",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            server: config.server,
            database: config.database,
            new_user: config.user,
            new_password: config.password,
            driver: config.driver,
          }),
        }
      );
      const data = await res.json();
      setStatus({ ok: data.ok, message: data.message });
      if (data.ok) {
        setCompleted((prev) => [...prev, 1]);
        setStep(2);
      }
    } catch (e) {
      setStatus({ ok: false, message: "Ошибка сети или сервера" });
    }
    setIsLoading(false);
  };

  // 2. Проверка соединения
  const checkConnection = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch("http://localhost:8000/db/check", {
        method: "GET",
      });
      const data = await res.json();
      setStatus({ ok: data.ok, message: data.message });
      if (data.ok) {
        setCompleted((prev) => [...prev, 2]);
        setStep(3);
      }
    } catch (e) {
      setStatus({ ok: false, message: "Ошибка сети или сервера" });
    }
    setIsLoading(false);
  };

  // 3. Создать структуру
  const initDb = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch("http://localhost:8000/db/init", {
        method: "POST",
      });
      const data = await res.json();
      setStatus({ ok: data.ok, message: data.message });
      if (data.ok) {
        setCompleted((prev) => [...prev, 3]);
        setStep(4);
      }
    } catch (e) {
      setStatus({ ok: false, message: "Ошибка сети или сервера" });
    }
    setIsLoading(false);
  };

  // 4. Сохранить параметры
  const saveConfig = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch("http://localhost:8000/db/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      setStatus({
        ok: data.ok,
        message: data.message || "Настройки сохранены",
      });
      if (data.ok) {
        setCompleted((prev) => [...prev, 4]);
        setStep(5);
      }
    } catch (e) {
      setStatus({ ok: false, message: "Ошибка сети или сервера" });
    }
    setIsLoading(false);
  };

  // 5. Перейти к серверам
  const goToServers = () => {
    setCompleted((prev) => [...prev, 5]);
    window.location.href = "/opc-servers";
  };


  return (
    <div className={styles.startPage}>
      <div className={styles.centerWrapper}>
        <div className={styles.card}>
          <BackButton />
          <div className={styles.logoWrap}>
            <img src={logo} alt="FactoryIQ" className={styles.logo} />
          </div>
          <h1 className={styles.title}>FactoryIQ</h1>
          <div className={styles.subtitle}>
            Промышленная платформа нового поколения для сбора, анализа и
            визуализации данных
            <br />с OPC UA
          </div>
          <div className={styles.mainGrid3col}>
            {/* 1. Левая колонка — шаги */}
            <div className={styles.stepsColumn}>
              <div className={styles.stepperWrap}>
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressInner}
                    style={{
                      width: `${progress}%`,
                      transition: "width 0.5s cubic-bezier(.5,2,.5,1)",
                    }}
                  />
                </div>
                <ul className={styles.stepsList}>
                  {stepsData.map((stepInfo, idx) => {
                    const isActive = step === idx + 1;
                    const isDone = completed.includes(idx + 1);
                    return (
                      <li
                        key={idx}
                        className={`
                                            ${styles.stepItem}
                                            ${isActive ? styles.active : ""}
                                            ${isDone ? styles.done : ""}
                                        `}
                      >
                        {isDone ? (
                          <CheckCircle size={22} className={styles.iconDone} />
                        ) : (
                          <span className={styles.stepNum}>{idx + 1}</span>
                        )}
                        <div>
                          <div className={styles.stepLabel}>
                            {stepInfo.label}
                          </div>
                          <div className={styles.stepDesc}>{stepInfo.desc}</div>
                        </div>
                        {isActive && (
                          <ChevronRight className={styles.chevron} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            {/* 2. Средняя колонка — поля формы */}
            <div className={styles.formColumn}>
              <form
                className={styles.formArea}
                autoComplete="off"
                onSubmit={(e) => e.preventDefault()}
              >
                <div className={styles.fieldsGrid}>
                  {/* Сервер SQL */}
                  <div className={styles.inputGroup}>
                    <label>Сервер SQL</label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        name="server"
                        value={config.server}
                        onChange={handleChange}
                        autoFocus
                        disabled={step !== 1}
                        className={styles.input}
                        placeholder="localhost или instance"
                      />
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={fetchSqlInstances}
                        disabled={step !== 1}
                        title="Найти SQL Server в сети"
                        style={{
                          background: "#e6f3fd",
                          boxShadow: "0 2px 8px #00cfff10",
                          border: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "0.40rem 0.58rem",
                        }}
                      >
                        <Search size={22} color="#0596ff" strokeWidth={2.2} />
                      </button>
                    </div>
                  </div>

                  {/* Выбор найденных серверов */}
                  {servers.length > 0 && (
                    <div className={styles.inputGroup}>
                      <label>Найденные серверы</label>
                      <select
                        name="server"
                        value={config.server}
                        onChange={handleChange}
                        disabled={step !== 1}
                        className={styles.input}
                      >
                        {servers.map((srv, idx) => (
                          <option key={idx} value={srv}>
                            {srv}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* База данных */}
                  <div className={styles.inputGroup}>
                    <label>База данных</label>
                    <input
                      name="database"
                      value={config.database}
                      onChange={handleChange}
                      disabled={step !== 1}
                      className={styles.input}
                      placeholder="OpcUaSystem"
                    />
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={fetchDatabases}
                      disabled={
                        step !== 1 ||
                        !config.server ||
                        !config.user ||
                        !config.driver
                      }
                      style={{ marginTop: 6, marginLeft: 0 }}
                    >
                      Показать базы
                    </button>
                    {dbList.length > 0 && (
                      <select
                        name="database"
                        value={config.database}
                        onChange={handleChange}
                        className={styles.input}
                      >
                        {dbList.map((db) => (
                          <option key={db} value={db}>
                            {db}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Пользователь */}
                  <div className={styles.inputGroup}>
                    <label>Пользователь</label>
                    <input
                      name="user"
                      value={config.user}
                      onChange={handleChange}
                      disabled={step !== 1}
                      className={styles.input}
                      placeholder="sa / tg_user / ..."
                    />
                  </div>

                  {/* Пароль */}
                  <div className={styles.inputGroup}>
                    <label>Пароль</label>
                    <input
                      name="password"
                      type="password"
                      value={config.password}
                      onChange={handleChange}
                      disabled={step !== 1}
                      className={styles.input}
                      placeholder="••••••••"
                      autoComplete="new-password"
                    />
                  </div>

                  {/* ODBC драйвер */}
                  <div className={styles.inputGroup}>
                    <label>ODBC Драйвер</label>
                    <select
                      name="driver"
                      value={config.driver}
                      onChange={handleChange}
                      disabled={step !== 1}
                      className={styles.input}
                    >
                      {drivers.map((drv) => (
                        <option key={drv} value={drv}>
                          {drv}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </form>
            </div>

            {/* 3. Правая колонка — только кнопки и статус */}
            <div className={styles.buttonsColumn}>
              <div className={styles.stepBtnsRow}>
                <button
                  className={`${styles.bigBtn} ${step !== 1 ? styles.disabled : ""
                    }`}
                  type="button"
                  onClick={initFullWindowsAuth}
                  disabled={isLoading || step !== 1}
                >
                  {isLoading && step === 1 ? (
                    <Loader className={styles.loader} />
                  ) : (
                    "Полная установка SQL"
                  )}
                </button>
                <button
                  className={`${styles.bigBtn} ${step !== 2 ? styles.disabled : ""
                    }`}
                  type="button"
                  onClick={checkConnection}
                  disabled={isLoading || step !== 2}
                >
                  {isLoading && step === 2 ? (
                    <Loader className={styles.loader} />
                  ) : (
                    "Проверить соединение"
                  )}
                </button>
                <button
                  className={`${styles.bigBtn} ${step !== 3 ? styles.disabled : ""
                    }`}
                  type="button"
                  onClick={initDb}
                  disabled={isLoading || step !== 3}
                >
                  {isLoading && step === 3 ? (
                    <Loader className={styles.loader} />
                  ) : (
                    "Создать структуру"
                  )}
                </button>
                <button
                  className={`${styles.bigBtn} ${step !== 4 ? styles.disabled : ""
                    }`}
                  type="button"
                  onClick={saveConfig}
                  disabled={isLoading || step !== 4}
                >
                  {isLoading && step === 4 ? (
                    <Loader className={styles.loader} />
                  ) : (
                    "Сохранить"
                  )}
                </button>
                <button
                  className={`${styles.bigBtn} ${step !== 5 ? styles.disabled : ""}`}
                  type="button"
                  onClick={generateCerts}
                  disabled={isLoading || step !== 5}
                >
                  {isLoading && step === 5 ? (
                    <Loader className={styles.loader} />
                  ) : (
                    "Сгенерировать сертификаты"
                  )}
                </button>

                <button
                  className={`${styles.bigBtn} ${step !== 6 ? styles.disabled : ""
                    }`}
                  type="button"
                  onClick={goToServers}
                  disabled={step !== 6}
                >
                  Перейти к OPC UA серверам
                </button>
              </div>
              {/* Сообщение о статусе */}
              {status && (
                <div
                  className={status.ok ? styles.statusOk : styles.statusError}
                >
                  {status.message}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
export default StartPage;
