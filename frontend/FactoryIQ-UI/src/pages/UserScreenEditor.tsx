import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import Draggable from "react-draggable";
import { toast } from "react-toastify";
import {
  InputNumber,
  Row,
  Col,
  Button,
  Tag,
  Popconfirm,
  Divider,
  Switch,
} from "antd";
import {
  BgColorsOutlined,
  DeleteOutlined,
  EyeOutlined,
  UnlockOutlined,
  SaveOutlined,
} from "@ant-design/icons";

import ChartWidget from "../components/UserScreens/ChartWidget";
import TableWidget from "../components/UserScreens/TableWidget";
import ScadaTagSidebar from "../components/UserScreens/ScadaTagSidebar";
import ResizableTagLabel from "../components/UserScreens/ResizableTagLabel";

import { formatLiveDataValue } from "../components/UserScreens/UserScreensModule";
import { useApi } from "../shared/useApi";

import styles from "../styles/UserScreenEditor.module.css";
import TimeTravelBar from "../components/UserScreens/TimeTravelBar";
import { TimeContextProvider, TimeMode } from "../components/UserScreens/TimeContext";

/* ===== Типы ===== */

type ScreenInfo = {
  screen_id: number;
  screen_name: string;
  title: string;
  description: string | null;
  bg_color: string | null;
  area_width?: number | null;
  area_height?: number | null;
  is_public: boolean;
  is_readonly: boolean;
  created_at?: string;
  user_id: number;
  owner_username?: string | null;
  server_id?: number | null;
  server_name?: string | null;
};

type WidgetType = "tag" | "chart" | "analytic" | "table";

type Widget = {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  label?: string;
  chartConfig?: any;
  style?: Record<string, any>;
};

type TagSettings = {
  showLabel?: boolean | string | number | null;
  showTagName?: boolean | string | number | null;
};

type WidgetsMap = Record<string, Widget>;

type TagContextMenuState = {
  x: number;
  y: number;
  tagName: string;
} | null;

type LiveTag = {
  TagName: string;
  Value: any;
};

type ContextMenuProps = {
  position: { x: number; y: number };
  tagName: string;
  onAction: (action: string) => void;
  widgets?: WidgetsMap | null;
};

/* ===== Константы ===== */
const MENU_WIDTH = 210;
const MENU_HEIGHT = 240;

/* ===== Утилиты ===== */
const getMenuPosition = (
  x: number,
  y: number,
  menuWidth = MENU_WIDTH,
  menuHeight = MENU_HEIGHT
) => {
  const padding = 8;
  let left = x;
  let top = y;
  if (left + menuWidth > window.innerWidth) {
    left = window.innerWidth - menuWidth - padding;
  }
  if (top + menuHeight > window.innerHeight) {
    top = window.innerHeight - menuHeight - padding;
  }
  return { left, top };
};

const toConfigObject = (cfg: any): any => {
  if (!cfg) return {};
  if (typeof cfg === "string") {
    try {
      return JSON.parse(cfg);
    } catch {
      return {};
    }
  }
  // уже объект
  return { ...cfg };
};

const normalizeKey = (s: unknown): string => {
  const v = String(s ?? "").trim();
  return typeof v.normalize === "function" ? v.normalize("NFC") : v;
};

const canon = (s: unknown): string => {
  const v = String(s ?? "").trim();
  // @ts-ignore
  const n = typeof v.normalize === "function" ? v.normalize("NFC") : v;
  return n.toLowerCase();
};

const tagKey = (s: unknown): string => {
  const v = normalizeKey(s);
  const i = v.lastIndexOf(":");
  return i >= 0 ? v.slice(i + 1) : v;
};

const buildLiveIndex = (liveTags: LiveTag[] | null | undefined) => {
  const idx = new Map<string, LiveTag>();
  for (const t of Array.isArray(liveTags) ? liveTags : []) {
    const original = String(t?.TagName ?? "");
    const raw = normalizeKey(original);
    if (!raw) continue;

    idx.set(canon(raw), t);
    idx.set(canon(tagKey(raw)), t);

    const bi = original.indexOf("__");
    if (bi > 0) {
      const tail = original.slice(bi + 2);
      if (tail) {
        const tailNorm = normalizeKey(tail);
        idx.set(canon(tailNorm), t);
        idx.set(canon(tagKey(tailNorm)), t);
      }
    }
  }
  return idx;
};

const safeParseJson = (src: any, fallback: any = {}) => {
  if (!src) return fallback;
  if (typeof src === "object") return src;
  if (typeof src !== "string") return fallback;
  try {
    return JSON.parse(src);
  } catch {
    return fallback;
  }
};

// простой генератор уникальных хвостов
let widgetSeq = 1;
const nextSeq = () => widgetSeq++;

// универсальный помощник
const makeWidgetId = (prefix: string, tagId?: number | string | null) => {
  const base = tagId != null ? `${prefix}_${tagId}` : prefix;
  return `${base}_${nextSeq()}`;
};

const buildWidgetIdForTag = (tag: any): string => {
  const tagId = tag?.TagId ?? tag?.id ?? null;
  if (tagId != null) {
    // tag_33553_1, tag_33553_2 и т.п.
    return makeWidgetId("tag", tagId);
  }

  const rawName = String(tag?.TagName ?? tag ?? "").trim() || "tag";
  // если TagId нет (теоретически) — завяжемся на имя
  return makeWidgetId(`tag_${tagKey(rawName)}`);
};

/* ===== Простые компоненты ===== */
const Clock: React.FC = () => {
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{now.toLocaleTimeString()}</span>;
};

/* ===== Локальный хук состояния экрана (вместо useScada) ===== */

const useUserScreenState = (
  _screenName: string,
  _serverId?: number | null,
  _serverName?: string | null,
  _screenDbId?: number
) => {
  const api = useApi();

  const [widgets, setWidgets] = useState<WidgetsMap>({});
  const [liveTags] = useState<LiveTag[]>([]);
  const [tagSettings, setTagSettings] = useState<Record<string, TagSettings>>(
    {}
  );
  const [isLoaded, setIsLoaded] = useState(false);

  const defaultScadaSettings: TagSettings = useMemo(
    () => ({
      showLabel: true,
      showTagName: true,
    }),
    []
  );

  // ← НОВЫЙ useEffect: грузим объекты экрана из БД
    useEffect(() => {
    if (!_screenDbId) {
      setWidgets({});
      setTagSettings({});
      setIsLoaded(true);
      return;
    }

    let cancelled = false;
    setIsLoaded(false);

    (async () => {
      try {
        const rows = await api.get<any[]>(
          `/user-screens/${_screenDbId}/objects`
        );

        if (cancelled) return;

        const nextWidgets: WidgetsMap = {};
        const nextTagSettings: Record<string, TagSettings> = {};

        for (const r of rows || []) {
          // ChartConfig
          let cfg: any = {};
          if (r.ChartConfig) {
            if (typeof r.ChartConfig === "string") {
              try {
                cfg = JSON.parse(r.ChartConfig);
              } catch {
                cfg = {};
              }
            } else {
              cfg = r.ChartConfig;
            }
          }

          // style для меток лежит в __tagStyle
          let style: any = undefined;
          if (cfg && typeof cfg === "object" && cfg.__tagStyle) {
            style = cfg.__tagStyle;
          }

          const id = String(r.ObjectName ?? "");
          if (!id) continue;

          const widgetType: WidgetType = (r.Type as WidgetType) || "tag";

          nextWidgets[id] = {
            id,
            type: widgetType,
            x: Number(r.X ?? 0),
            y: Number(r.Y ?? 0),
            width: r.Width != null ? Number(r.Width) : undefined,
            height: r.Height != null ? Number(r.Height) : undefined,
            label: r.Label ?? id,
            chartConfig: cfg,
            style,
          };

          // <-- вот тут берём ShowLabel / ShowTagName из строки
          const rawShowLabel = r.ShowLabel ?? r.showLabel;
          const rawShowTagName = r.ShowTagName ?? r.showTagName;

          nextTagSettings[id] = {
            showLabel:
              rawShowLabel == null
                ? defaultScadaSettings.showLabel ?? true
                : !!rawShowLabel,
            showTagName:
              rawShowTagName == null
                ? defaultScadaSettings.showTagName ?? true
                : !!rawShowTagName,
          };
        }

        setWidgets(nextWidgets);
        setTagSettings(nextTagSettings);
      } catch (err) {
        console.error("Не удалось загрузить объекты экрана", err);
      } finally {
        if (!cancelled) {
          setIsLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [_screenDbId, api, defaultScadaSettings]);


 const addTagToArea = useCallback(
  (tag: any, pos?: { x: number; y: number }) => {
    const p = pos ?? { x: 100, y: 100 };

    const tagName: string = tag?.TagName ?? String(tag);
    const description: string =
      tag?.Description || tag?.DisplayName || tagName;

    const tagId = tag?.TagId ?? tag?.id ?? null;

    const id = buildWidgetIdForTag(tag);

    setWidgets((prev) => ({
      ...prev,
      [id]: {
        id,
        type: "tag",
        x: p.x,
        y: p.y,
        width: 180,
        height: 68,
        label: description,
        chartConfig: {
          tag_name: tagName,
          tag_id: tagId,
          node_id: tag?.NodeId ?? null,
          server_id: tag?.ServerId ?? tag?.server_id ?? null,
          server_name: tag?.ServerName ?? tag?.server_name ?? null,
          tags: [tagName],
        },
        style: prev[id]?.style,
      },
    }));
  },
  []
);



const addChartToArea = useCallback(
  (tagNameOrTag: any, pos?: { x: number; y: number }) => {
    const p = pos ?? { x: 100, y: 100 };

    const tagName: string =
      typeof tagNameOrTag === "string"
        ? tagNameOrTag
        : tagNameOrTag?.TagName ?? String(tagNameOrTag);

    const tagId =
      typeof tagNameOrTag === "string"
        ? undefined
        : tagNameOrTag?.TagId ?? tagNameOrTag?.id ?? undefined;

    const id = makeWidgetId(
      "chart",
      tagId != null ? tagId : tagKey(tagName)
    );

    setWidgets((prev) => ({
      ...prev,
      [id]: {
        id,
        type: "chart",
        x: p.x,
        y: p.y,
        width: 320,
        height: 200,
        label: tagName,
        chartConfig: {
          tags: [tagName],
          title: tagName,
          tag_name: tagName,
          tag_id: tagId,
        },
      },
    }));
  },
  []
);


  const addAnalyticToArea = useCallback(
    (w: Widget, _pos: { x: number; y: number }) => {
      setWidgets((prev) => ({ ...prev, [w.id]: w }));
    },
    []
  );

  const addTableToArea = useCallback(
    (w: Widget, _pos: { x: number; y: number }) => {
      setWidgets((prev) => ({ ...prev, [w.id]: w }));
    },
    []
  );

  const moveWidget = useCallback((id: string, patch: Partial<Widget>) => {
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return {
        ...prev,
        [id]: { ...cur, ...patch },
      };
    });
  }, []);

  const deleteWidget = useCallback((id: string) => {
    setWidgets((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateChartConfig = useCallback((id: string, cfgPatch: any) => {
  setWidgets((prev) => {
    const cur = prev[id];
    if (!cur) return prev;

    const currentCfg = toConfigObject(cur.chartConfig);

    return {
      ...prev,
      [id]: {
        ...cur,
        chartConfig: { ...currentCfg, ...cfgPatch },
      },
    };
  });
}, []);


  const updateTableConfig = useCallback((id: string, cfgPatch: any) => {
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return {
        ...prev,
        [id]: {
          ...cur,
          chartConfig: { ...(cur.chartConfig || {}), ...cfgPatch },
        },
      };
    });
  }, []);

  const handleRename = useCallback((id: string) => {
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const nextLabel = window.prompt("Новое имя метки", cur.label || id);
      if (!nextLabel) return prev;
      return {
        ...prev,
        [id]: { ...cur, label: nextLabel },
      };
    });
  }, []);

  const toggleTagSetting = useCallback(
    (id: string, key: keyof TagSettings) => {
      setTagSettings((prev) => {
        const cur = prev[id] || {};
        const raw = cur[key];
        let nextVal: boolean;
        if (typeof raw === "string") {
          nextVal = !Boolean(Number(raw));
        } else {
          nextVal = !Boolean(raw ?? true);
        }
        return {
          ...prev,
          [id]: { ...cur, [key]: nextVal },
        };
      });
    },
    []
  );

  const convertWidgetType = useCallback((id: string) => {
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      if (cur.type === "tag") {
        const tagName = cur.label || id;
        return {
          ...prev,
          [id]: {
            ...cur,
            type: "chart",
            width: cur.width ?? 320,
            height: cur.height ?? 200,
            chartConfig: {
              ...(cur.chartConfig || {}),
              tags: [tagName],
              title: tagName,
            },
          },
        };
      }
      if (cur.type === "chart") {
        const tagName =
          cur.chartConfig?.tags?.[0] || cur.label || tagKey(id) || id;
        return {
          ...prev,
          [id]: {
            ...cur,
            type: "tag",
            width: cur.width ?? 180,
            height: cur.height ?? 68,
            label: tagName,
          },
        };
      }
      return prev;
    });
  }, []);

  const openTagGroupModal = useCallback((_tagName: string) => {
    // заглушка: сюда позже можно повесить модалку групп тегов
    toast.info("Группы тегов пока не реализованы для пользовательских экранов.");
  }, []);

  const updateTagStyle = useCallback((id: string, style: any) => {
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return {
        ...prev,
        [id]: { ...cur, style: { ...(cur.style || {}), ...(style || {}) } },
      };
    });
  }, []);

  const applyTagStyleToAll = useCallback((stylePatch: any) => {
    setWidgets((prev) => {
      const next: WidgetsMap = {};
      for (const [id, w] of Object.entries(prev)) {
        if (w.type === "tag") {
          next[id] = {
            ...w,
            style: { ...(w.style || {}), ...(stylePatch || {}) },
          };
        } else {
          next[id] = w;
        }
      }
      return next;
    });
  }, []);

  return {
    isLoaded,
    liveTags,
    tagSettings,
    widgets,
    addTagToArea,
    addChartToArea,
    addAnalyticToArea,
    addTableToArea,
    moveWidget,
    deleteWidget,
    updateChartConfig,
    updateTableConfig,
    handleRename,
    toggleTagSetting,
    convertWidgetType,
    openTagGroupModal,
    defaultScadaSettings,
    updateTagStyle,
    applyTagStyleToAll,
  };
};

/* ===== Контекстное меню ===== */
const ScadaContextMenu: React.FC<ContextMenuProps> = React.memo(
  ({ position, tagName, onAction, widgets }) => {
    const pos = useMemo(
      () => getMenuPosition(position.x, position.y),
      [position.x, position.y]
    );
    const wtype: WidgetType | undefined = widgets?.[tagName]?.type;

    const items = useMemo(
      () => [
        { action: "rename", label: "Переименовать" },
        { action: "delete", label: "Удалить", danger: true },
        ...(wtype === "tag"
          ? [
              { action: "toggle_label", label: "Показать/скрыть метку" },
              { action: "toggle_tagname", label: "Показать/скрыть имя" },
              { action: "add_to_group", label: "Добавить в группу" },
            ]
          : []),
        ...(wtype === "tag" || wtype === "chart"
          ? [
              {
                action: "toggle_type",
                label: wtype === "chart" ? "Сделать меткой" : "Сделать трендом",
              },
            ]
          : []),
        { action: "close", label: "Закрыть" },
      ],
      [wtype]
    );

    return createPortal(
      <div
        className="context-menu"
        style={{
          position: "fixed",
          left: pos.left,
          top: pos.top,
          zIndex: 9999,
          maxWidth: MENU_WIDTH,
          maxHeight: MENU_HEIGHT,
          minWidth: 180,
          background: "#fff",
          borderRadius: 13,
          boxShadow: "0 4px 24px rgba(31, 72, 122, 0.11)",
          padding: "7px 0",
          border: "1px solid #dde6f7",
        }}
      >
        {items.map((item) => (
          <button
            key={item.action}
            onClick={() => onAction(item.action)}
            className="context-menu-button"
            style={{
              color: item.danger ? "red" : "black",
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              textAlign: "left",
              padding: "10px 17px",
              fontSize: 15,
              borderRadius: 7,
              transition: "background 0.12s",
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>,
      document.body
    );
  }
);

/* ===== Основной компонент ===== */

const UserScreenEditor: React.FC = () => {
  const { screenId } = useParams<{ screenId: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null);
  const [bgColor, setBgColor] = useState<string>("#ffffff");
  const [isPublic, setIsPublic] = useState<boolean>(false);
  const [isReadonlyFlag, setIsReadonlyFlag] = useState<boolean>(false);

  const readOnly = isReadonlyFlag;


   const [timeMode, setTimeMode] = useState<TimeMode>("live");
  const [timeRange, setTimeRange] = useState<{ from: Date | null; to: Date | null }>({
    from: null,
    to: null,
  });
  const [timeCursor, setTimeCursor] = useState<Date | null>(null);
  const [windowMinutes, setWindowMinutes] = useState<number>(60);

  const timeContextValue = useMemo(
    () => ({
      mode: timeMode,
      range: timeRange,
      cursor: timeCursor,
      windowMinutes,
      setMode: setTimeMode,
      setRange: setTimeRange,
      setCursor: setTimeCursor,
      setWindowMinutes,
    }),
    [timeMode, timeRange, timeCursor, windowMinutes]
  );

  const [areaSize, setAreaSize] = useState<{ width: number; height: number }>(
    {
      width: 1500,
      height: 800,
    }
  );

  const [tagContextMenu, setTagContextMenu] =
    useState<TagContextMenuState>(null);
  const [saving, setSaving] = useState(false);

  const [zoom, setZoom] = useState<number>(1); // 1.0 = 100%
  const zoomIn = useCallback(
    () => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2))),
    []
  );
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2))),
    []
  );
  const zoomReset = useCallback(() => setZoom(1), []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /* ===== Загрузка инфо об экране ===== */
  useEffect(() => {
    if (!screenId) return;
    let alive = true;

    (async () => {
      try {
        const res = await api.get<ScreenInfo>(`/user-screens/${screenId}`);
        if (!alive) return;

        const data = res;
        setScreenInfo(data);
        setBgColor(data.bg_color || "#ffffff");
        setIsPublic(!!data.is_public);
        setIsReadonlyFlag(!!data.is_readonly);

        const w = Number(
          (data as any)?.area_width ?? (data as any)?.width ?? 1500
        );
        const h = Number(
          (data as any)?.area_height ?? (data as any)?.height ?? 800
        );
        setAreaSize({
          width: Number.isFinite(w) && w > 0 ? w : 1500,
          height: Number.isFinite(h) && h > 0 ? h : 800,
        });
      } catch (e) {
        if (!alive) return;
        console.error(e);
        toast.error("Экран не найден");
        navigate("/user-screens");
      }
    })();

    return () => {
      alive = false;
    };
  }, [screenId, api, navigate]);

  // Закрытие контекстного меню при скролле
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      setTagContextMenu(null);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    document.body.classList.add("allow-editor-scroll");
    return () => document.body.classList.remove("allow-editor-scroll");
  }, []);

  /* ===== Хук состояния (бывш. useScada) ===== */
  const {
    isLoaded,
    liveTags,
    tagSettings,
    widgets,
    addTagToArea,
    addChartToArea,
    addAnalyticToArea,
    addTableToArea,
    moveWidget,
    deleteWidget,
    updateChartConfig,
    updateTableConfig,
    handleRename,
    toggleTagSetting,
    convertWidgetType,
    openTagGroupModal,
    defaultScadaSettings,
    updateTagStyle,
    applyTagStyleToAll,
  } = useUserScreenState(
    screenInfo?.screen_name || `user_screen_${screenId}`,
    screenInfo?.server_id || 1,
    screenInfo?.server_name || "",
    screenInfo?.screen_id ?? Number(screenId)
  );

  /* ===== Индекс живых тегов ===== */
  const liveIndex = useMemo(
    () => buildLiveIndex(liveTags as LiveTag[]),
    [liveTags]
  );

  const pickLive = useCallback(
    (nameOrId: string) => {
      const k1 = canon(tagKey(nameOrId));
      const k2 = canon(nameOrId);
      return liveIndex.get(k1) || liveIndex.get(k2) || null;
    },
    [liveIndex]
  );

  /* ===== Настройки виджета ===== */
  const getWidgetSettings = useCallback(
    (id: string) => {
      const base: TagSettings =
        defaultScadaSettings ?? {
          showLabel: true,
          showTagName: true,
        };
      const s: TagSettings = (tagSettings as any)?.[id] ?? {};
      const showLabelRaw =
        "showLabel" in s ? s.showLabel : base.showLabel ?? true;
      const showTagNameRaw =
        "showTagName" in s ? s.showTagName : base.showTagName ?? true;
      return {
        showLabel: !!(typeof showLabelRaw === "string"
          ? Number(showLabelRaw)
          : showLabelRaw),
        showTagName: !!(typeof showTagNameRaw === "string"
          ? Number(showTagNameRaw)
          : showTagNameRaw),
      };
    },
    [tagSettings, defaultScadaSettings]
  );

  

  /* ===== Сохранение ===== */
 const handleSaveScreen = useCallback(
  async (opts: { deleteMissing: boolean } = { deleteMissing: false }) => {
    if (!screenInfo || !widgets) return;
    setSaving(true);
    try {
      const items = Object.values(widgets as WidgetsMap).map((w) => {
        // раскладываем chartConfig в объект
        const rawCfg = safeParseJson(w.chartConfig, {});
        const cleanedCfg: any = {};

        // аккуратно переносим только нужное
        if (Array.isArray(rawCfg.tags)) cleanedCfg.tags = [...rawCfg.tags];
        if (typeof rawCfg.title === "string") cleanedCfg.title = rawCfg.title;

        // тэговая инфа
        if (rawCfg.tag_name) cleanedCfg.tag_name = rawCfg.tag_name;
        if (rawCfg.tag_id != null) cleanedCfg.tag_id = rawCfg.tag_id;
        if (rawCfg.node_id) cleanedCfg.node_id = rawCfg.node_id;
        if (rawCfg.server_id != null) cleanedCfg.server_id = rawCfg.server_id;
        if (rawCfg.server_name) cleanedCfg.server_name = rawCfg.server_name;

        // для таблиц/аналитики, если там будут свои поля
        if (rawCfg.style_template_id)
          cleanedCfg.style_template_id = rawCfg.style_template_id;
        if (rawCfg.style_override)
          cleanedCfg.style_override = rawCfg.style_override;

        // дефолты, если tags отсутствуют
        if (!cleanedCfg.tags && w.type === "chart") {
          const tagName =
            rawCfg.tag_name ||
            rawCfg.tag ||
            w.label ||
            tagKey(w.id) ||
            w.id;
          cleanedCfg.tags = [tagName];
          if (!cleanedCfg.title) cleanedCfg.title = tagName;
        }

        const baseCfg = cleanedCfg;

        // стиль меток (как и было)
        if (w.type === "tag" && w.style && typeof w.style === "object") {
          (baseCfg as any).__tagStyle = w.style;
        }

        const isTable = w.type === "table";
        const isAnalytic = w.type === "analytic";
const settingsForItem = (tagSettings as any)[w.id];
        return {
          id: w.id,
          type: w.type,
          x: Math.round(w.x || 0),
          y: Math.round(w.y || 0),
          width: Math.round(
            w.width || (isTable ? 760 : isAnalytic ? 480 : 180)
          ),
          height: Math.round(
            w.height || (isTable ? 360 : isAnalytic ? 340 : 68)
          ),
          label: w.label || w.id,
          chartConfig: baseCfg,
          settings: settingsForItem ?? undefined,
        };
      });

        // 1) виджеты
        await api.post("/screen-objects/bulk", {
        screen_id: screenInfo.screen_id ?? Number(screenId),
        items,
        delete_missing: !!opts.deleteMissing,
        });

        // 2) размеры рабочей области
        await api.put(`/user-screens/${screenId}/props`, {
          area_width: Number(areaSize.width),
          area_height: Number(areaSize.height),
        });

        toast.success("Экран сохранён");
      } catch (e: any) {
        console.warn("bulk save error", e?.response?.data || e?.message);
        toast.error("Не удалось сохранить экран");
      } finally {
        setSaving(false);
      }
    },
    [api, screenInfo, widgets, tagSettings, areaSize.width, areaSize.height, screenId]
  );

  /* ===== Цвет фона ===== */
  const handleBgColorChange = useCallback(
    async (color: string) => {
      setBgColor(color);
      try {
        await api.put(`/user-screens/${screenId}/bg-color`, {
          bg_color: color,
        });
      } catch {
        /* ignore */
      }
    },
    [api, screenId]
  );

  /* ===== Свойства экрана ===== */
  const updateProps = useCallback(
    async (patch: { is_public?: boolean; is_readonly?: boolean }) => {
      try {
        const data = await api.put(`/user-screens/${screenId}/props`, patch);
        if (typeof patch.is_public === "boolean") setIsPublic(patch.is_public);
        if (typeof patch.is_readonly === "boolean")
          setIsReadonlyFlag(patch.is_readonly);
        setScreenInfo((prev) => ({ ...(prev as any), ...data, ...patch }));
        toast.success("Свойства экрана обновлены");
      } catch (e: any) {
        console.warn("props update error", e?.response?.data || e?.message);
        toast.error("Не удалось обновить свойства экрана");
      }
    },
    [api, screenId]
  );

  const handleTogglePublic = useCallback(
    (checked: boolean) => updateProps({ is_public: checked }),
    [updateProps]
  );
  const handleToggleReadonly = useCallback(
    (checked: boolean) => updateProps({ is_readonly: checked }),
    [updateProps]
  );

  /* ===== Перемещения / меню ===== */
  const handleDrag = useCallback(
    (_e: any, data: { x: number; y: number }, widgetId: string) => {
      if (!readOnly) moveWidget(widgetId, { x: data.x, y: data.y });
    },
    [readOnly, moveWidget]
  );

  const handleTagContextMenu = useCallback(
    (e: React.MouseEvent, tagName: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly) return;
      setTagContextMenu({ x: e.clientX, y: e.clientY, tagName });
    },
    [readOnly]
  );

  const handleCloseMenu = useCallback(() => setTagContextMenu(null), []);

  const handleMenuAction = useCallback(
    async (action: string, tagName: string) => {
      switch (action) {
        case "rename":
          return handleRename(tagName);
        case "delete":
          return deleteWidget(tagName);
        case "toggle_label":
          return toggleTagSetting(tagName, "showLabel");
        case "toggle_tagname":
          return toggleTagSetting(tagName, "showTagName");
        case "toggle_type":
          return convertWidgetType(tagName);
        case "add_to_group":
          return openTagGroupModal(tagName);
        case "close":
        default:
          return handleCloseMenu();
      }
    },
    [
      handleRename,
      deleteWidget,
      toggleTagSetting,
      convertWidgetType,
      openTagGroupModal,
      handleCloseMenu,
    ]
  );

  const renderContextMenu = useCallback(
    () =>
      tagContextMenu ? (
        <ScadaContextMenu
          position={tagContextMenu}
          tagName={tagContextMenu.tagName}
          widgets={widgets as WidgetsMap}
          onAction={(action) =>
            handleMenuAction(action, tagContextMenu.tagName)
          }
        />
      ) : null,
    [tagContextMenu, widgets, handleMenuAction]
  );

  /* ===== Заголовки для таблиц ===== */
  const tableConfigs: Record<string, any> = useMemo(() => {
    if (!widgets) return {};
    const res: Record<string, any> = {};
    for (const w of Object.values(widgets as WidgetsMap)) {
      if (w.type !== "table") continue;
      const effectiveTitle =
        [w.label, w.chartConfig?.title, w.chartConfig?.name].find(
          (v) => typeof v === "string" && v.trim()
        ) || "Таблица";
      res[w.id] = { ...(w.chartConfig || {}), title: effectiveTitle };
    }
    return res;
  }, [widgets]);

  if (!screenInfo) return <div>Загрузка...</div>;
  if (!isLoaded) return <div>Загрузка настроек экрана...</div>;

  return (
    <TimeContextProvider value={timeContextValue}>
    <div className={styles.editorContainer}>
      {/* HEADER */}
      <div className={styles.headerRow}>
        <Button
          type="default"
          icon={<EyeOutlined />}
          onClick={() => navigate("/user-screens")}
        >
          К списку
        </Button>

        <span
          className={styles.title}
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <BgColorsOutlined style={{ color: bgColor, marginRight: 8 }} />
          {screenInfo.title || `Экран #${screenId}`}
          {isPublic && (
            <Tag color="green" style={{ marginLeft: 10 }}>
              <UnlockOutlined /> Публичный
            </Tag>
          )}
          {isReadonlyFlag && (
            <Tag color="gold" style={{ marginLeft: 10 }}>
              ReadOnly
            </Tag>
          )}
        </span>

        <div className={styles.headerClock}>
          <Clock />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            marginLeft: "auto",
          }}
        >
          <span>
            <b>ID:</b> {screenId}
          </span>
          <span>
            <b>Автор:</b> {screenInfo.owner_username || "?"}
          </span>

          <span>
            <b>Фабрика:</b>{" "}
            <span style={{ color: "#1976d2" }}>
              {screenInfo.server_name || "—"}
            </span>
          </span>

          <label>
            <b>Цвет фона:</b>
            <input
              type="color"
              value={bgColor}
              onChange={(e) => handleBgColorChange(e.target.value)}
              style={{
                marginLeft: 7,
                marginRight: 7,
                verticalAlign: "middle",
              }}
              disabled={readOnly}
            />
          </label>

          <>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Публичный{" "}
              <Switch checked={isPublic} onChange={handleTogglePublic} />
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Только чтение{" "}
              <Switch
                checked={isReadonlyFlag}
                onChange={handleToggleReadonly}
              />
            </span>
          </>

  <Button
  type="primary"
  icon={<SaveOutlined />}
  loading={saving}
  // БЫЛО: deleteMissing: false
  onClick={() => handleSaveScreen({ deleteMissing: true })}
  style={{ marginLeft: 8 }}
>
  Сохранить экран
</Button>


          <Popconfirm
            title="Удалить этот экран?"
            onConfirm={async () => {
              await api.del(`/user-screens/${screenId}`);
              toast.success("Экран удалён");
              navigate("/user-screens");
            }}
            okText="Да"
            cancelText="Нет"
          >
            <Button danger icon={<DeleteOutlined />} style={{ marginLeft: 8 }}>
              Удалить экран
            </Button>
          </Popconfirm>
        </div>
      </div>

      {readOnly && (
        <div className={styles.readonlyBanner}>
          <UnlockOutlined style={{ marginRight: 6, color: "#e6b700" }} />
          Экран переведён в режим &laquo;только чтение&raquo;
        </div>
      )}

      <Divider style={{ margin: "10px 0 20px 0" }} />

      <Row
        gutter={22}
        className={styles.mainRow}
        style={{ flex: 1, minHeight: 0 }}
      >
        {/* SIDEBAR */}
        {!readOnly && (
          <Col
            className={`${styles.sidebarCol} ${
              sidebarCollapsed ? styles.collapsed : ""
            }`}
          >
            <ScadaTagSidebar
              // serverId в типах ScadaTagSidebar нужно добавить как необязательный:
              // serverId?: number;
              serverId={screenInfo.server_id || 1}
              addChartToArea={addChartToArea}
              addTagToArea={addTagToArea}
              defaultCollapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            />
          </Col>
        )}

        {/* WORK AREA */}
        <Col
          span={readOnly ? 24 : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
             <TimeTravelBar />
          {!readOnly && (
            <div className={styles.sizeInputRow}>
              <span>Размер рабочей области:</span>
              <InputNumber
                min={600}
                max={3840}
                value={areaSize.width}
                onChange={(w) =>
                  setAreaSize((a) => ({ ...a, width: Number(w) || a.width }))
                }
                style={{ width: 90 }}
              />
              ×
              <InputNumber
                min={400}
                max={2160}
                value={areaSize.height}
                onChange={(h) =>
                  setAreaSize((a) => ({
                    ...a,
                    height: Number(h) || a.height,
                  }))
                }
                style={{ width: 90 }}
              />
              <Button
                size="small"
                onClick={() =>
                  setAreaSize((a) => ({ width: a.width, height: a.height }))
                }
                style={{ marginLeft: 10 }}
              >
                Применить
              </Button>

              <Divider type="vertical" />
              <span style={{ opacity: 0.8 }}>Масштаб:</span>
              <Button size="small" onClick={zoomOut}>
                –
              </Button>
              <span style={{ width: 48, textAlign: "center" }}>
                {Math.round(zoom * 100)}%
              </span>
              <Button size="small" onClick={zoomIn}>
                +
              </Button>
              <Button size="small" onClick={zoomReset}>
                100%
              </Button>
            </div>
          )}

          <div
            ref={scrollRef}
            className={styles.scrollShell}
            onClick={handleCloseMenu}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (readOnly) return;

              const shell = scrollRef.current;
              if (!shell) return;
              const rect = shell.getBoundingClientRect();
              const x =
                ((e.clientX - rect.left) + shell.scrollLeft) / zoom;
              const y =
                ((e.clientY - rect.top) + shell.scrollTop) / zoom;

              try {
                const raw = e.dataTransfer.getData("application/json");
                if (!raw) return;
                const data = JSON.parse(raw);

                if (data.addType === "analytic") {
                  const analyticId = `analytic_${Date.now()}_${Math.floor(
                    Math.random() * 10000
                  )}`;
                  addAnalyticToArea(
                    {
                      id: analyticId,
                      type: "analytic",
                      x,
                      y,
                      width: 480,
                      height: 340,
                      label: "Аналитика",
                      chartConfig: {},
                    },
                    { x, y }
                  );
                  return;
                }
                if (data.addType === "table") {
                  const id = data.savedTableId
                    ? `ias_table_${data.savedTableId}`
                    : `inline_table_${Date.now()}`;
                  const baseConfig =
                    data.inlineConfig || {
                      definition: {
                        name: "Новая таблица",
                        server_id: screenInfo.server_id,
                        server_name: screenInfo.server_name,
                        timezone: "Asia/Almaty",
                        time: { from: null, to: null },
                        interval: "1h",
                        columns: [
                          {
                            kind: "datetime",
                            title: "Дата/Время",
                            format: "DD.MM.YYYY HH:mm",
                          },
                        ],
                        style_template_id: 1,
                      },
                    };
                  addTableToArea(
                    {
                      id,
                      type: "table",
                      x,
                      y,
                      width: 760,
                      height: 360,
                      label: data.title || "Таблица",
                      chartConfig: baseConfig,
                    },
                    { x, y }
                  );
                  return;
                }
                if (data.addType === "chart") {
                  addChartToArea(data.tag, { x, y });
                  return;
                }
                addTagToArea(data.tag, { x, y });
              } catch (err) {
                console.error("Ошибка drop:", err);
              }
            }}
          >
            {/* Рамка для скролла */}
            <div
              className={styles.zoomFrame}
              style={{
                width: Math.max(1, Math.round(areaSize.width * zoom)),
                height: Math.max(1, Math.round(areaSize.height * zoom)),
              }}
            >
              <div style={{ width: "100%", height: "100%" }} />
              <div
                className={styles.workArea}
                style={{
                  background: bgColor,
                  width: `${areaSize.width}px`,
                  height: `${areaSize.height}px`,
                  position: "absolute",
                  left: 0,
                  top: 0,
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                  transition: "transform 0.12s ease, background 0.2s",
                }}
              >
                {widgets &&
                  Object.values(widgets as WidgetsMap).map((widget) => {
                    if (widget.type === "analytic") {
                      return (
                        <Draggable
                          key={widget.id}
                          bounds="parent"
                          position={{ x: widget.x, y: widget.y }}
                          onStop={
                            readOnly
                              ? undefined
                              : (e, data) => handleDrag(e, data, widget.id)
                          }
                          disabled={readOnly}
                          handle=".ant-card-head"
                          scale={zoom}
                        >
                          <div
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 0,
                              width: widget.width || 450,
                              height: "auto",
                              minHeight: widget.height || 340,
                              zIndex: 2,
                              overflow: "visible",
                              display: "flex",
                              flexDirection: "column",
                            }}
                          >
                            {/* Здесь можно будет подключить AnalyticsWidget */}
                          </div>
                        </Draggable>
                      );
                    }

                   if (widget.type === "chart") {
  const tagName = tagKey(
    widget.chartConfig?.tags?.[0] ?? widget.id
  );

  // всегда объект
  const chartConfigObj =
    safeParseJson(widget.chartConfig, {
      tags: [tagName],
      title: tagName,
    });

  const chartProps: any = {
    ...widget,
    label: widget.label ?? tagName,
    serverId: screenInfo.server_id ?? undefined,
    serverName: screenInfo.server_name ?? undefined,
    tag: tagName,
    // ChartWidget ожидает объект стилей/конфига, а не строку
    style: chartConfigObj,
  };

  return (
    <ChartWidget
      key={widget.id}
      {...chartProps}
      onMove={readOnly ? undefined : moveWidget}
      onStyleChange={readOnly ? undefined : updateChartConfig}
      onDelete={readOnly ? undefined : deleteWidget}
      editable={!readOnly}
      onContextMenu={
        readOnly
          ? undefined
          : (e: React.MouseEvent) =>
              handleTagContextMenu(e, widget.id)
      }
    />
  );
}



                    if (widget.type === "table") {
                      const tableConfig = tableConfigs[widget.id];
                      return (
                        <Draggable
                          key={widget.id}
                          bounds="parent"
                          position={{ x: widget.x, y: widget.y }}
                          onStop={
                            readOnly
                              ? undefined
                              : (e, data) => handleDrag(e, data, widget.id)
                          }
                          disabled={readOnly}
                          handle=".ant-card-head"
                          scale={zoom}
                        >
                          <div
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 0,
                              width: widget.width || 760,
                              zIndex: 2,
                            }}
                          >
                            <TableWidget
                              id={widget.id}
                              serverId={screenInfo.server_id ?? undefined}
                              serverName={
                                screenInfo.server_name ?? undefined
                              }
                              config={tableConfig}
                              width={widget.width || 760}
                              height={widget.height || 360}
                              editable={!readOnly}
                              onConfigChange={(newCfg: any) => {
                                const nextTitle =
                                  [
                                    newCfg?.title,
                                    widget.label,
                                    newCfg?.name,
                                    widget.chartConfig?.title,
                                    widget.chartConfig?.name,
                                  ].find(
                                    (v) =>
                                      typeof v === "string" && v.trim()
                                  ) || "Таблица";
                                updateTableConfig(widget.id, {
                                  ...newCfg,
                                  title: nextTitle,
                                });
                              }}
                              onDelete={
                                readOnly
                                  ? undefined
                                  : () => deleteWidget(widget.id)
                              }
                              onContextMenu={
                                readOnly
                                  ? undefined
                                  : (e: React.MouseEvent) =>
                                      handleTagContextMenu(e, widget.id)
                              }
                              onResizeStop={(
                                id: string,
                                {
                                  width,
                                  height,
                                }: { width: number; height: number }
                              ) => {
                                const w = Math.round(Number(width));
                                const h = Math.round(Number(height));
                                moveWidget(id, {
                                  x: widget.x,
                                  y: widget.y,
                                  width: w,
                                  height: h,
                                });
                              }}
                            />
                          </div>
                        </Draggable>
                      );
                    }

                    // tag / метка
                    const baseId = tagKey(widget.id);
                    const s = getWidgetSettings(widget.id);
                    const rec = pickLive(baseId);
                    const valueText = rec
                      ? formatLiveDataValue(
                          baseId,
                          (rec as any).Value,
                         // screenInfo?.server_id
                        )
                      : "Нет данных";

                    return (
                      <ResizableTagLabel
                        key={widget.id}
                        id={widget.id}
                        x={widget.x ?? 100}
                        y={widget.y ?? 100}
                        width={widget.width ?? 180}
                        height={widget.height ?? 68}
                        showLabel={s.showLabel}
                        showTagName={s.showTagName}
                        mainLabel={widget.label ?? baseId}
                        tagName={s.showTagName ? baseId : ""}
                        value={valueText}
                        unit=""
                        editable={!readOnly}
                        onMove={(
                          id: string,
                          pos: { x: number; y: number }
                        ) =>
                          moveWidget(id, {
                            x: pos.x,
                            y: pos.y,
                            width: widget.width ?? 180,
                            height: widget.height ?? 68,
                          })
                        }
                        onResizeStop={
                          readOnly
                            ? undefined
                            : (
                                id: string,
                                size: { width: number; height: number }
                              ) =>
                                moveWidget(id, {
                                  x: widget.x ?? 100,
                                  y: widget.y ?? 100,
                                  width: size.width ?? widget.width ?? 180,
                                  height:
                                    size.height ?? widget.height ?? 68,
                                })
                        }
                        onContextMenu={
                          readOnly
                            ? undefined
                            : (e: React.MouseEvent) =>
                                handleTagContextMenu(e, widget.id)
                        }
                        initialStyle={widget.style}
                        onStyleChange={(id: string, style: any) =>
                          updateTagStyle(id, style)
                        }
                        onApplyStyleToAll={(stylePatch: any) =>
                          applyTagStyleToAll(stylePatch)
                        }
                      />
                    );
                  })}
                {!readOnly && renderContextMenu()}
              </div>
            </div>
          </div>
        </Col>
      </Row>
    
        </div>
    </TimeContextProvider>

  );
};

export default UserScreenEditor;
