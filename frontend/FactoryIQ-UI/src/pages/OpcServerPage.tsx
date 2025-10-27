import React, { useEffect, useState } from "react";
import styles from "../styles/OpcServerPage.module.css";
import {
  Server,
  ListChecks,
  CloudCog,
  RefreshCw,
  Plus,
  Search,
} from "lucide-react";
import BackButton from "../components/BackButton";
import { Tree } from "antd";
import { useApi } from "../shared/useApi";

const API_BASE = ((import.meta as any).env?.VITE_API_BASE || "") as string;

type TreeNode = {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: TreeNode[];
  data?: OpcTag;
};

type OpcTag = {
  browse_name: string;
  node_id: string;
  node_class: string;
  data_type?: string;
  value?: any;
  description?: string;
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

const DEFAULT_POLICIES = ["Basic256Sha256", "None"];
const DEFAULT_MODES = ["Sign", "SignAndEncrypt", "None"];

const OpcServerPage: React.FC = () => {
  // --- STATES ---
  const [servers, setServers] = useState<OpcServer[]>([]);
  const [newServer, setNewServer] = useState<OpcServer>({
    name: "",
    endpoint_url: "",
    opcUsername: "",
    opcPassword: "",
    securityPolicy: DEFAULT_POLICIES[0],
    securityMode: DEFAULT_MODES[0],
  });
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<OpcServer | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [foundServers, setFoundServers] = useState<string[]>([]);
  const [ipStart, setIpStart] = useState("192.168.0.1");
  const [ipEnd, setIpEnd] = useState("192.168.0.254");
  const [isScanning, setIsScanning] = useState(false);
  const [editingServer, setEditingServer] = useState<OpcServer | null>(null);
  const [securityPolicies, setSecurityPolicies] = useState<string[]>(DEFAULT_POLICIES);
  const [securityModes, setSecurityModes] = useState<string[]>(DEFAULT_MODES);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [selectedTag, setSelectedTag] = useState<OpcTag | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<React.Key[]>([]);
  const [intervals, setIntervals] = useState<{ id: number; name: string; intervalSeconds: number }[]>([]);
  const [selectedIntervalId, setSelectedIntervalId] = useState<number>(1);
  const [recording, setRecording] = useState(false);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [isScanningFullTree, setIsScanningFullTree] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);

  const api = useApi();

  // --- Tree загрузка/подгрузка ---
  useEffect(() => {
    if (selectedServer) loadChildren("i=85", null);
    else setTreeData([]);
    setCheckedKeys([]);
    setSelectedTag(null);
    setSelectedNodeKey(null);
  }, [selectedServer]);

  const loadChildren = async (nodeId: string, parentKey: string | null) => {
    if (!selectedServer) return;
    const params = new URLSearchParams({
      endpoint_url: selectedServer.endpoint_url,
      node_id: nodeId,
      username: selectedServer.opcUsername || "",
      password: selectedServer.opcPassword || "",
      security_policy: selectedServer.securityPolicy || "Basic256Sha256",
      security_mode: selectedServer.securityMode || "Sign",
    }).toString();
    const data = await api.get<{ items: OpcTag[] }>("/tags/browse_full", Object.fromEntries(new URLSearchParams(params)));
    const nodes = (data.items || []).map((tag: OpcTag) => ({
      title: tag.browse_name,
      key: tag.node_id,
      isLeaf: String(tag.node_class).toLowerCase() === "variable" || String(tag.node_class) === "2",
      data: tag,
    }));
    if (!parentKey) setTreeData(nodes);
    else setTreeData((origin) => updateNodeChildren(origin, parentKey, nodes));
  };

  const handleScanFullTree = async (srv: OpcServer) => {
    if (!window.confirm("Создать полную карту тегов для этого сервера? Это может занять несколько минут.")) return;
    setIsScanningFullTree(true);   // включаем лоадер!
    try {
      const data = await api.post<{ count: number; inserted: number; debug_first_tags?: any[] }>(
        "/servers/scan_full_tree",
        {
          server_id: srv.id,
          endpoint_url: srv.endpoint_url,
          opcUsername: srv.opcUsername || "",
          opcPassword: srv.opcPassword || "",
          securityPolicy: srv.securityPolicy || "Basic256Sha256",
          securityMode: srv.securityMode || "Sign",
        }
      );


      console.log("[FRONT] Ответ на карту тегов:", data);
      alert(
        `Готово! Найдено ${data.count}, сохранено ${data.inserted} тегов.\n\nПервые теги:\n` +
        JSON.stringify(data.debug_first_tags || [], null, 2)
      );
    } catch (err) {
      alert("Ошибка соединения: " + err);
    }
    setIsScanningFullTree(false);  // отключаем лоадер!
  };



  function updateNodeChildren(nodes: TreeNode[], key: string, children: TreeNode[]): TreeNode[] {
    return nodes.map((node) => {
      if (node.key === key) return { ...node, children };
      if (node.children) return { ...node, children: updateNodeChildren(node.children, key, children) };
      return node;
    });
  }

  // Собирает все leaf-узлы под выбранным key
  const collectLeafTagsByKey = (nodes: TreeNode[], key: string): OpcTag[] => {
    let result: OpcTag[] = [];
    const visit = (node: TreeNode) => {
      if (node.key === key) {
        collectAllLeafs(node, result);
        return true;
      }
      if (node.children) {
        for (const child of node.children) {
          if (visit(child)) return true;
        }
      }
      return false;
    };
    for (const node of nodes) {
      if (visit(node)) break;
    }
    return result;
  };

  const collectAllLeafs = (node: TreeNode, result: OpcTag[]) => {
    if (node.isLeaf && node.data) result.push(node.data);
    if (node.children) node.children.forEach(child => collectAllLeafs(child, result));
  };

  // --- Получение справочников, серверов и т.д. ---
  useEffect(() => {
    api.get<any>("/servers/opc_security_options")
      .then((opts) => {
        setSecurityPolicies(opts.policies && opts.policies.length > 0 ? opts.policies : DEFAULT_POLICIES);
        setSecurityModes(opts.modes && opts.modes.length > 0 ? opts.modes : DEFAULT_MODES);
        setNewServer((s) => ({
          ...s,
          securityPolicy: opts.defaultPolicy || DEFAULT_POLICIES[0],
          securityMode: opts.defaultMode || DEFAULT_MODES[0],
        }));
      })
      .catch(() => {
        setSecurityPolicies(DEFAULT_POLICIES);
        setSecurityModes(DEFAULT_MODES);
        setNewServer((s) => ({
          ...s,
          securityPolicy: DEFAULT_POLICIES[0],
          securityMode: DEFAULT_MODES[0],
        }));
      });
  }, []);
  useEffect(() => {
    api.get<{ items: { id: number; name: string; intervalSeconds: number }[] }>("/polling/polling-intervals")
      .then((data) => setIntervals(data.items || []));

  }, []);
  useEffect(() => { fetchServers(); }, []);

  const fetchServers = async () => {
    const data = await api.get<OpcServer[]>("/servers/servers");
    setServers(data || []);
  };


  // --- Функции работы с серверами (добавление/удаление/изменение) ---
  const checkServer = async () => {
    const queryParams = new URLSearchParams({
      endpoint_url: newServer.endpoint_url,
      opcUsername: newServer.opcUsername || "",
      opcPassword: newServer.opcPassword || "",
      securityPolicy: newServer.securityPolicy || DEFAULT_POLICIES[0],
      securityMode: newServer.securityMode || DEFAULT_MODES[0],
    }).toString();
    setProbeResult("Проверка...");
    const data = await api.get<{ message?: string }>("/servers/probe", Object.fromEntries(new URLSearchParams(queryParams)));
    setProbeResult(data?.message || "Ошибка проверки");
  };

  const handleAddServer = async () => {
    const data = await api.post<{ id?: number }>("/servers/servers", newServer);

    if (data.id) {
      fetchServers();
      setNewServer({
        name: "",
        endpoint_url: "",
        opcUsername: "",
        opcPassword: "",
        securityPolicy: securityPolicies[0],
        securityMode: securityModes[0],
      });
    }
  };

  const handleSaveServer = async (srv: OpcServer) => {
    await api.put(`/servers/servers/${srv.id}`, srv);
    setEditingServer(null);
    fetchServers();
  };

  const handleDeleteServer = async (id?: number) => {
    if (!id || !window.confirm("Удалить этот сервер?")) return;
    try {
      await api.del(`/servers/servers/${id}`);
      fetchServers();
    } catch {
      alert("Ошибка удаления. Возможно, есть связанные задачи.");
    }

  };

  // --- Сканирование сети ---
  const startScan = () => {
    setScanLog([]);
    setFoundServers([]);
    setIsScanning(true);
    const base = API_BASE ? API_BASE.replace(/\/$/, "") : "";
    const eventSource = new EventSource(
      `${base}/servers/netscan_stream?ip_start=${encodeURIComponent(ipStart)}&ip_end=${encodeURIComponent(ipEnd)}&ports=4840,4841,4849`
    );

    eventSource.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "log") {
        setScanLog((prev) => [...prev, `Проверяю ${msg.ip}:${msg.port}...`]);
      } else if (msg.type === "found") {
        setFoundServers((prev) => [...prev, msg.url]);
        setScanLog((prev) => [...prev, `→ Найден OPC UA сервер: ${msg.url}`]);
      } else if (msg.type === "finish") {
        setScanLog((prev) => [
          ...prev,
          `Сканирование завершено. Найдено: ${msg.found.length}`,
        ]);
        setIsScanning(false);
        eventSource.close();
      }
    };
    eventSource.onerror = () => {
      setScanLog((prev) => [...prev, "Ошибка соединения."]);
      setIsScanning(false);
      eventSource.close();
    };
  };

  const handleBrowse = (url: string) => {
    setNewServer((s) => ({ ...s, endpoint_url: url }));
  };

  const getLeafKeys = (nodes: TreeNode[], checkedKeys: React.Key[]): string[] => {
    let result: string[] = [];
    nodes.forEach((node) => {
      if (node.isLeaf && checkedKeys.includes(node.key)) {
        result.push(node.key as string);
      }
      if (node.children) {
        result = result.concat(getLeafKeys(node.children, checkedKeys));
      }
    });
    return result;
  };

  // --- Кнопка "Запустить опрос" выбранных тегов
  const handleStartSelectedPolling = async () => {
    if (!selectedServer) {
      alert("Сначала выберите сервер!");
      return;
    }
    if (!checkedKeys.length) {
      alert("Выберите хотя бы один тег (чекбокс) для опроса.");
      return;
    }
    const leafKeys = getLeafKeys(treeData, checkedKeys);
    let selectedTags: OpcTag[] = [];
    const gatherTags = (nodes: TreeNode[]) => {
      nodes.forEach((node) => {
        if (leafKeys.includes(node.key as string) && node.data && node.isLeaf) {
          selectedTags.push(node.data);
        }
        if (node.children) gatherTags(node.children);
      });
    };
    gatherTags(treeData);
    if (!selectedTags.length) {
      alert("Выберите хотя бы один тег Variable для опроса (чекбокс должен стоять на переменных, а не на папках)!");
      return;
    }
    try {
      const data = await api.post<{ ok: boolean; task_id?: number; message?: string }>(
        "/polling/start_selected_polling",
        {
          server_id: selectedServer.id,
          endpoint_url: selectedServer.endpoint_url,
          tags: selectedTags.map((t) => ({
            node_id: t.node_id,
            browse_name: t.browse_name,
            data_type: t.data_type || "",
            description: t.description || "",
          })),
          interval_id: selectedIntervalId,
        }
      );


      if (data.ok) {
        alert(`Опрос выбранных тегов запущен (task_id=${data.task_id})`);
        setRecording(true);
      } else {
        alert("Ошибка запуска: " + (data.message || "Неизвестная ошибка"));
      }
    } catch (err) {
      alert("Ошибка соединения: " + err);
    }
  };

  // --- Опрос всей ветки (использует collectLeafTagsByKey) ---
  const handleStartPollingForBranch = async () => {
    if (!selectedServer) {
      alert("Сначала выберите сервер!");
      return;
    }
    if (!selectedNodeKey) {
      alert("Выделите узел (папку или любой объект в дереве) для опроса всей ветки");
      return;
    }
    const tagsInBranch = collectLeafTagsByKey(treeData, selectedNodeKey);
    if (!tagsInBranch.length) {
      alert("В этой ветке не найдено ни одной переменной (Variable)");
      return;
    }
    try {
      const data = await api.post<{ ok: boolean; task_id?: number; message?: string }>(
        "/polling/start_selected_polling",
        {
          server_id: selectedServer.id,
          endpoint_url: selectedServer.endpoint_url,
          tags: tagsInBranch.map((t) => ({
            node_id: t.node_id,
            browse_name: t.browse_name,
            data_type: t.data_type || "",
            description: t.description || "",
          })),
          interval_id: selectedIntervalId,
        }
      );

      if (data.ok) {
        alert(`Опрос всей ветки запущен (task_id=${data.task_id})`);
        setRecording(true);
      } else {
        alert("Ошибка запуска: " + (data.message || "Неизвестная ошибка"));
      }
    } catch (err) {
      alert("Ошибка соединения: " + err);
    }
  };

  const onLoadData = ({ key, children }: any) =>
    children ? Promise.resolve() : loadChildren(key, key);


  // --- Основной return ---
  return (
    <div className={styles.startPage}>
      {isScanningFullTree && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loader}></div>
          <div>Идёт построение карты тегов...</div>
        </div>
      )}
      <div className={styles.centerWrapper}>
        <div className={styles.card}>
          <BackButton />
          <h1 className={styles.title}>
            <Server size={32} className={styles.titleIcon} />
            OPC UA Серверы
          </h1>


          {/* --- СВОРРАЧИВАЕМАЯ СЕКЦИЯ: Поиск/добавление OPC UA серверов --- */}
          <div style={{ marginBottom: 18 }}>
            <div className={styles.foldTitle} onClick={() => setShowAddPanel(v => !v)}>
              {showAddPanel ? "▼" : "►"} Поиск/добавление OPC UA серверов
            </div>

            {showAddPanel && (
              <>
                <div className={styles.sectionTitle}>
                  <CloudCog size={20} style={{ marginRight: 6, color: "#35e6ff" }} />
                  Поиск OPC UA серверов в сети
                </div>
                <div className={styles.scanPanel}>
                  <input
                    className={styles.input}
                    value={ipStart}
                    onChange={(e) => setIpStart(e.target.value)}
                    placeholder="Начальный IP"
                  />
                  <input
                    className={styles.input}
                    value={ipEnd}
                    onChange={(e) => setIpEnd(e.target.value)}
                    placeholder="Конечный IP"
                  />
                  <button className={styles.btnPrimary} onClick={startScan} disabled={isScanning}>
                    {isScanning ? "Поиск..." : "Искать"}
                  </button>
                </div>
                <div className={styles.logPanel}>
                  {scanLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
                {foundServers.length > 0 && (
                  <div className={styles.foundBlock}>
                    <div className={styles.sectionTitleMini}>Найдено:</div>
                    <ul>
                      {foundServers.map((url) => (
                        <li key={url}>
                          <b>{url}</b>
                          <button className={styles.btnMini} onClick={() => handleBrowse(url)}>Обзор</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {/* Добавление сервера */}
                <div
                  className={styles.addServerBlock}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    maxWidth: 320,
                  }}
                >
                  <input
                    className={styles.input}
                    placeholder="Название"
                    value={newServer.name}
                    onChange={(e) =>
                      setNewServer((s) => ({ ...s, name: e.target.value }))
                    }
                  />
                  <input
                    className={styles.input}
                    placeholder="opc.tcp://..."
                    value={newServer.endpoint_url}
                    onChange={(e) =>
                      setNewServer((s) => ({
                        ...s,
                        endpoint_url: e.target.value,
                      }))
                    }
                  />
                  <input
                    className={styles.input}
                    placeholder="Логин OPC UA"
                    value={newServer.opcUsername}
                    onChange={(e) =>
                      setNewServer((s) => ({
                        ...s,
                        opcUsername: e.target.value,
                      }))
                    }
                  />
                  <input
                    className={styles.input}
                    type="password"
                    placeholder="Пароль OPC UA"
                    value={newServer.opcPassword}
                    onChange={(e) =>
                      setNewServer((s) => ({
                        ...s,
                        opcPassword: e.target.value,
                      }))
                    }
                  />
                  <select
                    className={styles.input}
                    value={newServer.securityPolicy}
                    onChange={(e) =>
                      setNewServer((s) => ({
                        ...s,
                        securityPolicy: e.target.value,
                      }))
                    }
                  >
                    {securityPolicies.length === 0 ? (
                      <option>Нет доступных политик</option>
                    ) : (
                      securityPolicies.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))
                    )}
                  </select>
                  <select
                    className={styles.input}
                    value={newServer.securityMode}
                    onChange={(e) =>
                      setNewServer((s) => ({
                        ...s,
                        securityMode: e.target.value,
                      }))
                    }
                  >
                    {securityModes.length === 0 ? (
                      <option>Нет доступных режимов</option>
                    ) : (
                      securityModes.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>
                  <div className={styles.actionsRow}>
                    <button className={styles.iconBtnSolid} title="Проверить доступность" onClick={checkServer}>
                      <RefreshCw size={20} />
                    </button>
                    <button className={styles.iconBtnSolid} title="Добавить сервер" onClick={handleAddServer}>
                      <Plus size={22} />
                    </button>

                  </div>
                </div>
                {probeResult && <div className={styles.status}>{probeResult}</div>}
              </>
            )}
          </div>

          {/* --- ТАБЛИЦА добавленных OPC UA серверов --- */}
          <div className={styles.sectionTitle} style={{ marginTop: 26 }}>
            Добавленные OPC UA серверы
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Endpoint URL</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((srv) =>
                editingServer && editingServer.id === srv.id ? (
                  <tr key={srv.id}>
                    <td>
                      <input
                        value={editingServer.name}
                        className={styles.input}
                        onChange={(e) =>
                          setEditingServer((s) =>
                            s ? { ...s, name: e.target.value } : s
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={editingServer.endpoint_url}
                        className={styles.input}
                        onChange={(e) =>
                          setEditingServer((s) =>
                            s ? { ...s, endpoint_url: e.target.value } : s
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        onClick={() => handleSaveServer(editingServer)}
                        className={styles.smallBtn}
                      >
                        💾
                      </button>
                      <button
                        onClick={() => setEditingServer(null)}
                        className={styles.smallBtn}
                      >
                        ✖️
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={srv.id}>
                    <td>{srv.name}</td>
                    <td className={styles.ellipsis}>{srv.endpoint_url}</td>
                    <td>
                      <button className={styles.btnMini} onClick={() => setEditingServer(srv)}>✏️</button>
                      <button className={styles.btnMini} onClick={() => handleDeleteServer(srv.id!)}>🗑️</button>
                      <button className={styles.btnMini} onClick={() => handleScanFullTree(srv)} title="Создать карту тегов">🗺️</button>
                      <button className={styles.btnMini} onClick={() => setSelectedServer(srv)}>
                        <Search size={16} /> Обзор
                      </button>

                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>

          {/* --- Остальной функционал (браузер тегов, кнопки) --- */}
          {selectedServer && (
            <div>
              <div className={styles.sectionTitle}>
                <ListChecks
                  size={20}
                  style={{ marginRight: 6, color: "#22d7c7" }}
                />
                Теги OPC UA сервера
              </div>
              <div
                style={{
                  background: "#fff",
                  borderRadius: 8,
                  padding: 12,
                  border: "1px solid #eee",
                  marginTop: 20,
                  maxHeight: 600,
                  height: 600,
                  overflow: "auto",
                }}
              >
                <div className={styles.treePanel}>
                  <Tree
                    treeData={treeData}
                    loadData={onLoadData}
                    showLine
                    checkable
                    selectable
                    checkStrictly={true}
                    height={550}
                    virtual
                    onSelect={(_, info) => {
                      setSelectedNodeKey(info.node.key);
                      if (info.node && info.node.data) setSelectedTag(info.node.data);
                    }}
                    onCheck={(checked, info) => {
                      setCheckedKeys(Array.isArray(checked) ? checked : checked.checked);
                      if (info.node && info.node.key) setSelectedNodeKey(info.node.key);
                      if (info.node && info.node.data) setSelectedTag(info.node.data);
                    }}
                    checkedKeys={checkedKeys}
                    defaultExpandAll={false}
                  />
                  {selectedTag && (
                    <div className={styles.tagInfo}>
                      <div><b>Имя:</b> {selectedTag.browse_name}</div>
                      <div><b>Node ID:</b> {selectedTag.node_id}</div>
                      <div><b>Тип:</b> {selectedTag.node_class}</div>
                      <div><b>DataType:</b> {selectedTag.data_type}</div>
                      <div><b>Value:</b> {selectedTag.value ? String(selectedTag.value) : "–"}</div>
                    </div>
                  )}
                </div>

              </div>
              {/* Кнопки для тегов */}
              <div className={styles.tagBtnsRow}>
                <button className={styles.btnGhost} onClick={() => setCheckedKeys([])}>Снять выбор</button>
              </div>
              <div className={styles.tagBtnsRow}>
                <select
                  className={styles.input}
                  style={{ width: 150, marginRight: 8 }}
                  value={selectedIntervalId}
                  onChange={(e) => setSelectedIntervalId(Number(e.target.value))}
                  title="Интервал опроса"
                >
                  {intervals.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.intervalSeconds} сек)
                    </option>
                  ))}
                </select>
                <button onClick={handleStartSelectedPolling}>
                  Запустить опрос
                </button>
                <button
                  onClick={() => handleStartPollingForBranch()}
                  disabled={!selectedTag}
                >
                  Опросить всю ветку
                </button>
                {recording && (
                  <span style={{ color: "green", marginLeft: 10 }}>
                    Активен опрос
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Быстрый переход */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
            <button className={styles.btnPrimary} onClick={() => (window.location.href = "/polling-tasks")}>
              🗂 Задачи опроса
            </button>
          </div>
        </div>
      </div>
    </div >
  );

};

export default OpcServerPage;
