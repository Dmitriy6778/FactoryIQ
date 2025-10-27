import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from "../styles/SettingsPage.module.css";
import logo from "../../assets/images/logo.jpeg";
import { CheckCircle, XCircle, FileDown, FileUp, RefreshCw, Database } from "lucide-react";
import BackButton from "../components/BackButton";
import { useApi } from "../shared/useApi";
/** ================================
 *  Типы
 *  ================================ */
type DbConfig = {
  server: string;
  database: string;
  user: string;
  password: string;
  driver: string;
};

type Status = { ok: boolean; message: string } | null;

type StatusMap = Record<
  "servers" | "databases" | "connection" | "initDb" | "saveConfig" | "certs" | "dbStructure",
  Status
>;

type VerifyResult = {
  ok: boolean;
  message: string;
  missing?: string[];     // отсутствующие объекты (таблицы/процедуры/вьюхи)
  extra?: string[];       // лишние объекты
  migrations?: string[];  // доступные миграции/патчи
  details?: Record<string, any>;
};

const defaultDbConfig: DbConfig = {
  server: "localhost",
  database: "OpcUaSystem",
  user: "",
  password: "",
  driver: "ODBC Driver 18 for SQL Server",
};


function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** ================================
 *  Компонент
 *  ================================ */
const SettingsPage: React.FC = () => {
  const api = useApi();
  const [config, setConfig] = useState<DbConfig>(defaultDbConfig);

  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [servers, setServers] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<string[]>([]);
  const [dbList, setDbList] = useState<string[]>([]);
  const [statusMap, setStatusMap] = useState<StatusMap>({
    servers: null,
    databases: null,
    connection: null,
    initDb: null,
    saveConfig: null,
    certs: null,
    dbStructure: null,
  });
  const [log, setLog] = useState<string[]>([]);
  const [verifyReport, setVerifyReport] = useState<VerifyResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pushLog = (msg: string) => {
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
  };

  const setStatus = (key: keyof StatusMap, ok: boolean, message: string) => {
    setStatusMap((prev) => ({ ...prev, [key]: { ok, message } }));
    pushLog(`${ok ? "✅" : "❌"} ${message}`);
  };

  // ODBC драйверы — при монтировании
  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<{ drivers?: string[] }>("/db/odbc-drivers");

        setDrivers(data?.drivers || []);
      } catch {
        setDrivers([]);
      }
    })();
  }, []);

  /** ---------- API handlers ---------- */
  const fetchSqlInstances = async () => {
    setIsLoading("servers");
    try {
      const data = await api.get<{ ok: boolean; servers: string[]; message?: string }>("/db/sql-instances");

      if (data.ok && data.servers?.length) {
        setServers(data.servers);
        setConfig((cfg) => ({ ...cfg, server: data.servers[0] }));
        setStatus("servers", true, `Найдено серверов: ${data.servers.length}`);
      } else {
        setStatus("servers", false, data.message || "Серверы не найдены");
      }
    } catch (e) {
      setStatus("servers", false, "Ошибка при поиске серверов");
    }
    setIsLoading(null);
  };

  const fetchDatabases = async () => {
    setIsLoading("databases");
    try {
      const data = await api.post<{ ok: boolean; databases: string[]; message?: string }>("/db/list-databases", config);

      if (data.ok) {
        setDbList(data.databases || []);
        setStatus("databases", true, `Найдено баз: ${data.databases.length}`);
      } else {
        setStatus("databases", false, data.message || "Не удалось получить список БД");
      }
    } catch {
      setStatus("databases", false, "Ошибка соединения");
    }
    setIsLoading(null);
  };

  const checkConnection = async () => {
    setIsLoading("connection");
    try {
      const data = await api.get<{ ok: boolean; message: string }>("/db/check");

      setStatus("connection", data.ok, data.message || (data.ok ? "Соединение успешно" : "Нет соединения"));
    } catch {
      setStatus("connection", false, "Ошибка сети или сервера");
    }
    setIsLoading(null);
  };

  const initDb = async () => {
    setIsLoading("initDb");
    try {
      const data = await api.post<{ ok: boolean; message: string }>("/db/init-full", {
        database: config.database,
        with_procs: true,
        create_if_missing: true,
        dry_run: false,
        elevate_with_windows_auth: true,
      });

      setStatus("initDb", data.ok, data.message || (data.ok ? "Структура БД инициализирована" : "Инициализация не выполнена"));
    } catch {
      setStatus("initDb", false, "Ошибка инициализации");
    }
    setIsLoading(null);
  };


  const verifyDbStructure = async () => {
    setIsLoading("dbStructure");
    setVerifyReport(null);
    try {
      const data = await api.post<VerifyResult>("/db/verify-structure", {
        database: config.database,
        deep: true,
      });

      const ok = !!data.ok;
      setVerifyReport(data);
      const msgBase = data.message || (ok ? "Структура БД в порядке" : "Найдены несоответствия структуры");
      const suffix =
        !ok && (data.missing?.length || data.migrations?.length)
          ? ` (отсутствует: ${data.missing?.length || 0}, миграций: ${data.migrations?.length || 0})`
          : "";
      setStatus("dbStructure", ok, msgBase + suffix);
    } catch (e: any) {
      let text = "Ошибка";
      try {
        const det = JSON.parse(e.message);
        const msg = det?.error || det?.message || String(e);
        text = msg;
        if (det?.debug) {
          console.group("DEBUG");
          console.table(det.debug);
          console.groupEnd();
          // + в лог UI:
          pushLog("DEBUG: " + JSON.stringify(det.debug));
        }
      } catch {
        text = e?.message || String(e);
      }
      setStatus("dbStructure", false, text);
    }
    setIsLoading(null);
  };


  const saveConfig = async () => {
    setIsLoading("saveConfig");
    try {
      const data = await api.post<{ ok: boolean; message?: string }>("/db/config", config);

      setStatus("saveConfig", !!data.ok, data.message || (data.ok ? "Конфигурация сохранена" : "Ошибка сохранения"));
    } catch (e: any) {
      setStatus("saveConfig", false, "Ошибка сохранения");
    }
    setIsLoading(null);
  };

  const generateCerts = async () => {
    setIsLoading("certs");
    try {
      const data = await api.post<{ ok: boolean; message: string }>("/opcua/gen-client-cert", {});

      setStatus("certs", data.ok, data.message || (data.ok ? "Сертификаты сгенерированы" : "Ошибка генерации сертификатов"));
    } catch {
      setStatus("certs", false, "Ошибка генерации сертификатов");
    }
    setIsLoading(null);
  };

  const initAll = async () => {
    pushLog("🚀 Инициализация системы с нуля...");
    await checkConnection();
    await initDb();
    await verifyDbStructure(); // сразу проверяем, что всё на месте
    await saveConfig();
    await generateCerts();
    pushLog("✅ Инициализация завершена");
  };

  /** ---------- Конфиг: ввод/вывод ---------- */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setConfig((prev) => ({ ...prev, [name]: value }));
  };

  const handleExport = () => {
    downloadText("factoryiq_db_config.json", JSON.stringify(config, null, 2));
    pushLog("⬇ Конфигурация выгружена в factoryiq_db_config.json");
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result || "{}"));
        // валидация ключей по-минимуму
        const merged: DbConfig = {
          server: obj.server ?? config.server,
          database: obj.database ?? config.database,
          user: obj.user ?? config.user,
          password: obj.password ?? config.password,
          driver: obj.driver ?? config.driver,
        };
        setConfig(merged);
        pushLog(`⬆ Загружена конфигурация из файла "${file.name}"`);
      } catch {
        pushLog("❌ Ошибка чтения JSON из файла");
      }
    };
    reader.readAsText(file);
    // сбрасываем value, чтобы можно было загружать один и тот же файл повторно
    e.target.value = "";
  };

  /** ---------- UI helpers ---------- */
  const renderStatusIcon = (st: Status) => {
    if (!st) return <XCircle className={styles.statusIconErr} size={20} />;
    return st.ok ? <CheckCircle className={styles.statusIconOk} size={20} /> : <XCircle className={styles.statusIconErr} size={20} />;
  };

  const summary = useMemo(
    () => [
      { key: "connection", label: "Соединение с SQL" },
      { key: "dbStructure", label: "Структура БД" },
      { key: "saveConfig", label: "Конфигурация" },
      { key: "certs", label: "Сертификаты OPC UA" },
    ] as { key: keyof StatusMap; label: string }[],
    []
  );

  return (
    <div className={styles.startPage}>
      <div className={styles.centerWrapper}>
        <div className={styles.card}>
          <BackButton />
          <div className={styles.logoWrap}>
            <img src={logo} alt="FabrIQ" className={styles.logo} />
          </div>
          <h1 className={styles.title}>FabrIQ — Настройки</h1>
          <div className={styles.subtitle}>Проверка и начальная конфигурация системы</div>

          {/* Сводная панель */}
          <div className={styles.summaryPanel}>
            {summary.map(({ key, label }) => (
              <div key={key} className={styles.summaryItem}>
                {renderStatusIcon(statusMap[key])}
                <span>{label}</span>
              </div>
            ))}
          </div>

          {/* Основная сетка */}
          <div className={styles.mainGrid3col}>
            {/* SQL */}
            <div className={styles.block}>
              <h3><Database size={18} style={{ marginRight: 6 }} /> SQL Server</h3>

              <div className={styles.inputGroup}>
                <label>Сервер</label>
                <input name="server" value={config.server} onChange={handleChange} className={styles.input} />
                <button onClick={fetchSqlInstances} disabled={isLoading === "servers"}>
                  Найти
                </button>
              </div>

              {servers.length > 0 && (
                <select name="server" value={config.server} onChange={handleChange} className={styles.input}>
                  {servers.map((srv) => (
                    <option key={srv} value={srv}>{srv}</option>
                  ))}
                </select>
              )}

              <div className={styles.inputGroup}>
                <label>База</label>
                <input name="database" value={config.database} onChange={handleChange} className={styles.input} />
                <button onClick={fetchDatabases} disabled={isLoading === "databases"}>
                  Список
                </button>
              </div>

              {dbList.length > 0 && (
                <select name="database" value={config.database} onChange={handleChange} className={styles.input}>
                  {dbList.map((db) => (
                    <option key={db} value={db}>{db}</option>
                  ))}
                </select>
              )}

              <div className={styles.inputGroup}>
                <label>Пользователь</label>
                <input name="user" value={config.user} onChange={handleChange} className={styles.input} />
              </div>
              <div className={styles.inputGroup}>
                <label>Пароль</label>
                <input type="password" name="password" value={config.password} onChange={handleChange} className={styles.input} />
              </div>
              <div className={styles.inputGroup}>
                <label>ODBC драйвер</label>
                <select name="driver" value={config.driver} onChange={handleChange} className={styles.input}>
                  {(drivers.length ? drivers : [config.driver]).map((drv) => (
                    <option key={drv} value={drv}>{drv}</option>
                  ))}
                </select>
              </div>

              <div className={styles.actionRow}>
                <button onClick={checkConnection} disabled={isLoading === "connection"}>
                  Проверить соединение
                </button>
                <button onClick={verifyDbStructure} disabled={isLoading === "dbStructure"}>
                  Проверить структуру БД
                </button>
                {/* Новая кнопка: создание и инициализация выбранной БД */}
                <button onClick={initDb} disabled={isLoading === "initDb"}>
                  Создать и инициализировать БД
                </button>
              </div>

              {/* Результат проверки структуры */}
              {verifyReport && (
                <div className={styles.verifyBox}>
                  <div className={verifyReport.ok ? styles.okTitle : styles.errTitle}>
                    {verifyReport.ok ? "Структура корректна" : "Найдены проблемы структуры"}
                  </div>
                  {verifyReport.message && <div className={styles.verifyMsg}>{verifyReport.message}</div>}

                  {!verifyReport.ok && (
                    <>
                      {!!(verifyReport.missing?.length) && (
                        <div className={styles.verifySection}>
                          <b>Отсутствуют ({verifyReport.missing.length}):</b>
                          <ul className={styles.compactList}>
                            {verifyReport.missing.map((x, i) => <li key={`miss-${i}`}>{x}</li>)}
                          </ul>
                        </div>
                      )}
                      {!!(verifyReport.migrations?.length) && (
                        <div className={styles.verifySection}>
                          <b>Доступные миграции ({verifyReport.migrations.length}):</b>
                          <ul className={styles.compactList}>
                            {verifyReport.migrations.map((x, i) => <li key={`mig-${i}`}>{x}</li>)}
                          </ul>
                        </div>
                      )}
                      {!!(verifyReport.extra?.length) && (
                        <div className={styles.verifySection}>
                          <b>Лишние объекты ({verifyReport.extra.length}):</b>
                          <ul className={styles.compactList}>
                            {verifyReport.extra.map((x, i) => <li key={`ext-${i}`}>{x}</li>)}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Конфиг */}
            <div className={styles.block}>
              <h3>Конфигурация</h3>
              <textarea readOnly value={JSON.stringify(config, null, 2)} className={styles.textarea} />
              <div className={styles.actionRow}>
                <button onClick={saveConfig} disabled={isLoading === "saveConfig"}>
                  Сохранить
                </button>
                <button onClick={handleExport} title="Сохранить конфиг в JSON">
                  <FileDown size={18} /> Выгрузить
                </button>
                <button onClick={handleImportClick} title="Загрузить конфиг из JSON">
                  <FileUp size={18} /> Загрузить
                </button>
                <input
                  type="file"
                  accept=".json,application/json"
                  ref={fileInputRef}
                  onChange={handleImport}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            {/* OPC UA */}
            <div className={styles.block}>
              <h3>OPC UA</h3>
              <button onClick={generateCerts} disabled={isLoading === "certs"}>
                Сгенерировать сертификаты
              </button>
              <button onClick={() => (window.location.href = "/opc-servers")}>
                Перейти к серверам
              </button>
            </div>

            {/* Система */}
            <div className={styles.block}>
              <h3>Система</h3>
              <div className={styles.subtitle} style={{ marginBottom: 8 }}>
                Полный конвейер: проверить соединение → создать/инициализировать БД → сверить структуру →
                сохранить конфиг → сгенерировать сертификаты.
              </div>
              <button onClick={initAll} disabled={!!isLoading}>
                <RefreshCw size={18} /> Инициализация с нуля
              </button>
            </div>
          </div>

          {/* Лог */}
          <div className={styles.logBlock}>
            <h3>Лог действий</h3>
            <div className={styles.logArea}>
              {log.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

};

export default SettingsPage;
