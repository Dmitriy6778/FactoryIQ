// components/UserScreens/UserScreensModule.tsx (или useUserScreen.tsx)
import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  MouseEvent,
} from "react";
import { toast } from "react-toastify";
import { useApi } from "../../shared/useApi";

/* ---------- utils ---------- */
const normalizeKey = (s: unknown): string => {
  const v = String(s ?? "").trim();
  return (v as any).normalize ? (v as any).normalize("NFC") : v;
};

/* ---------- defaults ---------- */
export type TagSettings = { showLabel: boolean; showTagName: boolean };
export type TagSettingsMap = Record<string, TagSettings>;

export interface TagStyle {
  bgColor: string;
  textColor: string;
  valueColor: string;
  headerFontPx: number;
  valueFontPx: number;
}

const DEFAULT_TAG_SETTINGS: TagSettings = { showLabel: true, showTagName: true };

const DEFAULT_TAG_STYLE: TagStyle = {
  bgColor: "#f3f9fe",
  textColor: "#234060",
  valueColor: "#1976d2",
  headerFontPx: 16,
  valueFontPx: 28,
};

export const getTagSettings = (
  tagSettingsMap: TagSettingsMap | undefined,
  tag: string,
  defaultScadaSettings?: TagSettings
): TagSettings => {
  const base = defaultScadaSettings ?? DEFAULT_TAG_SETTINGS;
  const s = tagSettingsMap?.[tag] ?? {};
  const showLabel = "showLabel" in s ? (s as any).showLabel : base.showLabel;
  const showTagName =
    "showTagName" in s ? (s as any).showTagName : base.showTagName;
  return {
    showLabel: !!(typeof showLabel === "string" ? Number(showLabel) : showLabel),
    showTagName: !!(
      typeof showTagName === "string" ? Number(showTagName) : showTagName
    ),
  };
};

/* ---------- value formatting ---------- */
export const formatLiveDataValue = (
  tagName: string | null | undefined,
  rawValue: unknown
): string => {
  if (rawValue == null) return "Нет данных";
  const name = String(tagName || "").trim();
  const v = Number(rawValue);
  if (!Number.isFinite(v)) return "Нет данных";

  const fmt = (x: number) => Number(x).toFixed(2);
  const isZero = Math.abs(v) < 1e-9 || fmt(v) === "0.00";

  if (/Power(_[A-Za-z0-9]*)?$/i.test(name)) {
    if (isZero) return fmt(0);
    return `${fmt(v)} кВт`;
  }
  if (name.endsWith("Current")) return `${fmt(v)} A`;
  if (name.endsWith("CurrentShift") || name.endsWith("CurrentMonth"))
    return `${fmt(v)} t`;

  return fmt(v);
};

/* ---------- типы ---------- */
export type WidgetType = "tag" | "chart";

export interface Widget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  style?: TagStyle;
  chartConfig?: Record<string, any>;
}

export interface LiveTag {
  tag_name: string;
  value: number | null;
  timestamp: string;
  quality?: string | number | null;
}

/* --- внутренние типы для ref-ов --- */
type SaveSnapshot = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  label: string;
  type: WidgetType;
  chartConfigJSON: string | null;
};

type IntervalHandle = ReturnType<typeof setInterval>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

/* ================================================================== */
/*                               HOOK                                  */
/* ================================================================== */

export interface UseUserScreenResult {
  isLoaded: boolean;
  liveTags: LiveTag[];
  widgets: Record<string, Widget>;
  setWidgets: React.Dispatch<React.SetStateAction<Record<string, Widget>>>;
  tagSettings: TagSettingsMap;
  defaultScadaSettings: TagSettings;

  moveWidget: (
    id: string,
    patch: Partial<Pick<Widget, "x" | "y" | "width" | "height">>
  ) => void;
  saveWidget: (id: string, widget: Widget) => void;

  addTagToArea: (rawTag: unknown, pos?: { x?: number; y?: number }) => void;
  addChartToArea: (
    rawTag: unknown,
    coords?: { x?: number; y?: number }
  ) => void;
  convertWidgetType: (idRaw: string) => void;
  updateChartConfig: (idRaw: string, config: Record<string, any>) => void;

  deleteWidget: (idRaw: string) => Promise<void>;
  handleRename: (objectNameRaw: string) => Promise<void>;

  toggleTagSetting: (tagNameRaw: string, setting: keyof TagSettings) => void;
  updateTagStyle: (idRaw: string, patch: Partial<TagStyle>) => void;
  applyTagStyleToAll: (patch: Partial<TagStyle>) => void;

  tagContextMenu: {
    x: number;
    y: number;
    tagName: string;
  } | null;
  handleTagContextMenu: (
    e: MouseEvent<HTMLDivElement>,
    tagName: string
  ) => void;
  handleCloseMenu: () => void;
  renderContextMenu: () => JSX.Element | null;
}

/**
 * Хук управления одним пользовательским экраном.
 * ВАЖНО: теперь нужен serverId.
 */
export const useUserScreen = (
  screenId: number,
  screenName: string,
  serverId: number
): UseUserScreenResult => {
  const api = useApi();

  const [userId, setUserId] = useState<number | null>(null);

  const [widgets, setWidgets] = useState<Record<string, Widget>>({});
  const [liveTags, setLiveTags] = useState<LiveTag[]>([]);
  const [tagSettings, setTagSettings] = useState<TagSettingsMap>({});

  const [defaultScadaSettings, setDefaultScadaSettings] =
    useState<TagSettings>({
      showTagName: true,
      showLabel: true,
    });
  const [refreshInterval, setRefreshInterval] = useState<number>(10000);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);

  const [tagContextMenu, setTagContextMenu] = useState<{
    x: number;
    y: number;
    tagName: string;
  } | null>(null);

  const livePollRef = useRef<{ timer: IntervalHandle | null; active: boolean }>(
    { timer: null, active: false }
  );

  const saveLocksRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const lastSavedRef = useRef<Map<string, SaveSnapshot>>(new Map());
  const saveDebounceRef = useRef<Map<string, TimeoutHandle>>(new Map());
  const tombstonesRef = useRef<Set<string>>(new Set());

  /* --- загрузка дефолтных SCADA настроек --- */
  useEffect(() => {
    const fetchDefaults = async () => {
      try {
        const res = await api.get<any>("/scada-settings");
        setDefaultScadaSettings({
          showTagName:
            res.showTagName === "true" ||
            res.showTagName === true ||
            res.showTagName === 1,
          showLabel:
            res.showLabel === "true" ||
            res.showLabel === true ||
            res.showLabel === 1,
        });
        let ms = parseInt(
          String(res.refresh_interval ?? res.refreshInterval ?? "10000"),
          10
        );
        if (Number.isNaN(ms) || ms < 1000) ms = 10000;
        setRefreshInterval(ms);
      } catch {
        setDefaultScadaSettings({ showTagName: true, showLabel: true });
        setRefreshInterval(10000);
      }
    };
    fetchDefaults();
  }, [api]);

  /* --- получение userId --- */
  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const res = await api.get<any>("/auth/user-info");
        const uid = res?.user_id ?? res?.id;
        if (!uid) throw new Error("no uid");
        setUserId(Number(uid));
      } catch {
        toast.error("Сессия истекла. Войдите снова.");
        (window as any).globalLogout?.();
      }
    };
    fetchUserInfo();
  }, [api]);

  /* --- helper для имени тега --- */
  const extractTagName = (raw: unknown): string => {
    if (!raw) return "";
    if (typeof raw === "string") return raw.trim();
    if (typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      return String(
        r.TagName ??
          r.tagName ??
          r.name ??
          r.Name ??
          r.id ??
          r.ID ??
          ""
      ).trim();
    }
    return String(raw ?? "").trim();
  };

  /* --- последовательный upsert объекта экрана через /screen-objects/bulk --- */
  const upsertScreenObject = useCallback(
    async (payload: Record<string, unknown>) => {
      const key = String(payload.ObjectName);
      if (!key || tombstonesRef.current.has(key)) return;

      const prev = saveLocksRef.current.get(key) || Promise.resolve();

      const next = prev
        .catch(() => {})
        .then(async () => {
          if (tombstonesRef.current.has(key)) return;

          // Приводим конфиг к объекту
          const chartConfigRaw = payload.ChartConfig;
          let chartConfig: any = null;
          if (typeof chartConfigRaw === "string" && chartConfigRaw) {
            try {
              chartConfig = JSON.parse(chartConfigRaw);
            } catch {
              chartConfig = null;
            }
          } else if (chartConfigRaw && typeof chartConfigRaw === "object") {
            chartConfig = chartConfigRaw;
          }

          const item = {
            id: String(payload.ObjectName || ""),
            type: (payload.Type as WidgetType) || "tag",
            label: String(payload.Label || payload.ObjectName || ""),
            x: Number(payload.X || 0),
            y: Number(payload.Y || 0),
            width: Number(payload.Width || 0) || undefined,
            height: Number(payload.Height || 0) || undefined,
            chartConfig,
            settings: undefined as any, // пока не трогаем; можно позже прокинуть showLabel/showTagName
          };

          return api.post("/screen-objects/bulk", {
            server_id: serverId,
            screen_name: screenName,
            items: [item],
            delete_missing: false,
          });
        });

      saveLocksRef.current.set(key, next);

      try {
        const res = await next;
        if (!res) return;
        lastSavedRef.current.set(key, {
          x: payload.X as number,
          y: payload.Y as number,
          width: payload.Width as number | undefined,
          height: payload.Height as number | undefined,
          label: (payload.Label as string) ?? key,
          type: (payload.Type as WidgetType) ?? "tag",
          chartConfigJSON:
            (payload.ChartConfig as string | null | undefined) ?? null,
        });
        return res;
      } finally {
        if (saveLocksRef.current.get(key) === next) {
          saveLocksRef.current.delete(key);
        }
      }
    },
    [api, screenName, serverId]
  );

  const scheduleSave = (
    id: string,
    payload: Record<string, unknown>,
    delay = 450
  ) => {
    const t = saveDebounceRef.current.get(id);
    if (t) clearTimeout(t);

    const tid: TimeoutHandle = setTimeout(() => {
      if (tombstonesRef.current.has(id)) {
        saveDebounceRef.current.delete(id);
        return;
      }
      upsertScreenObject(payload).catch(() =>
        toast.error("Ошибка сохранения объекта экрана")
      );
      saveDebounceRef.current.delete(id);
    }, delay);

    saveDebounceRef.current.set(id, tid);
  };

  /* --- загрузка объектов экрана и настроек тегов --- */
  useEffect(() => {
    if (!userId || !screenId || !screenName || !serverId) return;

    const loadObjects = async () => {
      try {
        const objs = await api.get<any[]>(`/user-screens/${screenId}/objects`);
        const widgetsData: Record<string, Widget> = {};
        const tagsList: string[] = [];

        (objs || []).forEach((obj) => {
          const id = normalizeKey(
            obj.ObjectName ?? obj.object_name ?? obj.TagName ?? obj.tag_name
          );
          if (!id) return;

          let chartConfig: Record<string, any> = {};
          const rawCfg = obj.ChartConfig ?? obj.chart_config;
          if (rawCfg != null) {
            try {
              chartConfig =
                typeof rawCfg === "string" ? JSON.parse(rawCfg) : rawCfg || {};
            } catch {
              chartConfig = {};
            }
          }

          delete (chartConfig as any).width;
          delete (chartConfig as any).height;

          const type: WidgetType = (obj.Type ?? obj.type ?? "tag") as WidgetType;
          const wDb = Number(obj.Width ?? obj.width);
          const hDb = Number(obj.Height ?? obj.height);

          const width =
            Number.isFinite(wDb) && wDb > 0
              ? wDb
              : type === "chart"
              ? 320
              : 180;
          const height =
            Number.isFinite(hDb) && hDb > 0
              ? hDb
              : type === "chart"
              ? 140
              : 68;

          const widget: Widget = {
            id,
            type,
            x: Number(obj.X ?? obj.x) || 0,
            y: Number(obj.Y ?? obj.y) || 0,
            width,
            height,
            label: obj.Label ?? obj.label ?? id,
          };

          if (type === "tag") {
            const savedStyle =
              (chartConfig as any).__tagStyle || (chartConfig as any).tagStyle;
            widget.style =
              savedStyle && typeof savedStyle === "object"
                ? { ...DEFAULT_TAG_STYLE, ...savedStyle }
                : { ...DEFAULT_TAG_STYLE };
          }

          if (type === "chart") {
            widget.chartConfig = chartConfig;
          }

          widgetsData[id] = widget;
          if (type === "tag" || type === "chart") tagsList.push(id);
        });

        setWidgets(widgetsData);

        const tagSettingsData: TagSettingsMap = {};
        if (tagsList.length > 0) {
          try {
            const resp = await api.post<
              Record<string, { ShowLabel: unknown; ShowTagName: unknown }>
            >("/tag-settings/batch", {
              serverId,
              screenName,
              tags: tagsList,
            });

            tagsList.forEach((tag) => {
              const v = resp?.[tag];
              tagSettingsData[tag] = v
                ? {
                    showLabel: Boolean(v.ShowLabel),
                    showTagName: Boolean(v.ShowTagName),
                  }
                : undefined!;
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("Ошибка загрузки настроек меток:", err);
          }
        }

        setTagSettings(tagSettingsData);
        setIsLoaded(true);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
        toast.error("Ошибка при загрузке объектов экрана");
      }
    };

    loadObjects();
  }, [api, screenId, screenName, serverId, userId]);

  /* --- live-данные --- */
  useEffect(() => {
    if (!screenId) return;

    const fetchLiveData = async () => {
      try {
        const data = await api.get<any[]>(`/user-screens/${screenId}/live-data`);
        setLiveTags(Array.isArray(data) ? (data as any as LiveTag[]) : []);
      } catch (e) {
        console.error("LIVE error", e);
        setLiveTags([]);
      }
    };

    fetchLiveData();

    livePollRef.current.active = true;
    livePollRef.current.timer = setInterval(() => {
      if (livePollRef.current.active) fetchLiveData();
    }, refreshInterval);

    return () => {
      livePollRef.current.active = false;
      if (livePollRef.current.timer) clearInterval(livePollRef.current.timer);
    };
  }, [api, screenId, refreshInterval]);

  /* ----- сохранение одного виджета ----- */
  const saveWidget = (id: string, widget: Widget) => {
    if (tombstonesRef.current.has(id)) return;

    const last = lastSavedRef.current.get(id);

    const cfg: Record<string, any> = { ...(widget.chartConfig || {}) };
    if (widget.type === "tag" && widget.style) {
      (cfg as any).__tagStyle = widget.style;
    }
    delete (cfg as any).width;
    delete (cfg as any).height;

    const cfgJSON =
      Object.keys(cfg).length > 0 ? JSON.stringify(cfg) : null;

    const W = Number(widget.width);
    const H = Number(widget.height);

    if (
      last &&
      last.x === widget.x &&
      last.y === widget.y &&
      last.label === widget.label &&
      last.type === widget.type &&
      Number(last.width) === Number(W) &&
      Number(last.height) === Number(H) &&
      last.chartConfigJSON === cfgJSON
    )
      return;

    const payload: Record<string, unknown> = {
      ObjectName: id,
      Label: widget.label || id,
      X: widget.x,
      Y: widget.y,
      ScreenName: screenName,
      User_id: userId,
      Type: widget.type,
      Width: Number.isFinite(W) ? W : undefined,
      Height: Number.isFinite(H) ? H : undefined,
      ChartConfig: cfgJSON,
    };

    scheduleSave(id, payload, 450);
  };

  /* ----- move/resize ----- */
  const moveWidget = (
    idRaw: string,
    patch: Partial<Pick<Widget, "x" | "y" | "width" | "height">>
  ) => {
    const id = normalizeKey(idRaw);
    setWidgets((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const nx = typeof patch.x === "number" ? patch.x : cur.x;
      const ny = typeof patch.y === "number" ? patch.y : cur.y;
      const nw = typeof patch.width === "number" ? patch.width : cur.width;
      const nh = typeof patch.height === "number" ? patch.height : cur.height;
      if (nx === cur.x && ny === cur.y && nw === cur.width && nh === cur.height)
        return prev;
      const next: Widget = { ...cur, x: nx, y: ny, width: nw, height: nh };
      const updated = { ...prev, [id]: next };
      saveWidget(id, next);
      return updated;
    });
  };

  /* ----- добавить метку на экран ----- */
  const addTagToArea = async (
    rawTag: unknown,
    pos?: { x?: number; y?: number }
  ) => {
    const base = extractTagName(rawTag);
    const tagName = normalizeKey(base);
    if (!tagName) return;

    const id = tagName;
    if (widgets[id]) return toast.warn(`Объект "${id}" уже есть на экране.`);

    const x = Math.round(pos?.x ?? 100);
    const y = Math.round(pos?.y ?? 100);

    const widgetObj: Widget = {
      id,
      type: "tag",
      x,
      y,
      width: 180,
      height: 68,
      label: tagName,
      style: { ...DEFAULT_TAG_STYLE },
      chartConfig: {},
    };

    setWidgets((prev) => ({ ...prev, [id]: widgetObj }));
    setTagSettings((prev) => ({
      ...prev,
      [id]: {
        showLabel: !!(defaultScadaSettings?.showLabel ?? true),
        showTagName: !!(defaultScadaSettings?.showTagName ?? true),
      },
    }));

    try {
      const payload: Record<string, unknown> = {
        ObjectName: id,
        Label: widgetObj.label,
        X: widgetObj.x,
        Y: widgetObj.y,
        ScreenName: screenName,
        User_id: userId,
        Type: "tag",
        Width: widgetObj.width,
        Height: widgetObj.height,
        ChartConfig: JSON.stringify({ __tagStyle: widgetObj.style }),
      };
      await upsertScreenObject(payload);

      await api.post("/tag-settings", {
        ServerId: serverId,
        ScreenName: String(screenName),
        ObjectName: id,
        ShowLabel: defaultScadaSettings?.showLabel ? 1 : 0,
        ShowTagName: defaultScadaSettings?.showTagName ? 1 : 0,
      });

      lastSavedRef.current.set(id, {
        x: payload.X as number,
        y: payload.Y as number,
        width: payload.Width as number | undefined,
        height: payload.Height as number | undefined,
        label: payload.Label as string,
        type: "tag",
        chartConfigJSON: payload.ChartConfig as string | null,
      });
    } catch (e: any) {
      console.warn("[addTagToArea] fail:", e?.detail || e?.message);
    }
  };

  /* ----- добавить тренд по тегу ----- */
  const addChartToArea = async (
    rawTag: unknown,
    coords?: { x?: number; y?: number }
  ) => {
    const tagNameRaw = extractTagName(rawTag);
    const tagName = normalizeKey(tagNameRaw);
    if (!tagName)
      return toast.warn("Не удалось определить имя тега для тренда.");

    const objectId = normalizeKey(tagName);
    if (widgets[objectId])
      return toast.warn(`График по тегу "${tagName}" уже добавлен.`);

    const x = Math.round(coords?.x ?? 120);
    const y = Math.round(coords?.y ?? 120);

    const chartObj: Widget = {
      id: objectId,
      type: "chart",
      x,
      y,
      width: 320,
      height: 140,
      label: tagName,
      chartConfig: {
        chartType: "line",
        rangeHours: 8,
        bgColor: "#ffffff",
        lineWidth: 2,
        tags: [tagName],
      },
    };

    setWidgets((prev) => ({ ...prev, [objectId]: chartObj }));

    try {
      const cfg = { ...(chartObj.chartConfig || {}) };
      delete (cfg as any).width;
      delete (cfg as any).height;

      const payload: Record<string, unknown> = {
        ObjectName: objectId,
        Label: chartObj.label,
        X: chartObj.x,
        Y: chartObj.y,
        ScreenName: screenName,
        User_id: userId,
        Type: "chart",
        Width: chartObj.width,
        Height: chartObj.height,
        ChartConfig: JSON.stringify(cfg),
      };
      await upsertScreenObject(payload);

      lastSavedRef.current.set(objectId, {
        x: payload.X as number,
        y: payload.Y as number,
        width: payload.Width as number | undefined,
        height: payload.Height as number | undefined,
        label: payload.Label as string,
        type: "chart",
        chartConfigJSON: payload.ChartConfig as string | null,
      });

      toast.success(`График по "${tagName}" добавлен.`);
    } catch (e: any) {
      setWidgets((prev) => {
        const u = { ...prev };
        delete u[objectId];
        return u;
      });
      console.warn("[addChartToArea] fail:", e?.detail || e?.message);
      toast.error("Ошибка добавления графика.");
    }
  };

  /* ----- конвертация tag ↔ chart ----- */
  const convertWidgetType = (idRaw: string) => {
    const normId = normalizeKey(idRaw);
    setWidgets((prev) => {
      const widget = prev[normId];
      if (!widget) return prev;
      const isTag = widget.type === "tag";

      const next: Widget = {
        ...widget,
        type: isTag ? "chart" : "tag",
        ...(isTag
          ? {
              width: widget.width ?? 320,
              height: widget.height ?? 140,
              chartConfig: {
                chartType: "line",
                rangeHours: 8,
                bgColor: "#ffffff",
                lineWidth: 2,
                tags: [normId],
              },
            }
          : {
              chartConfig: undefined,
              width: widget.width ?? 180,
              height: widget.height ?? 68,
              style: widget.style || { ...DEFAULT_TAG_STYLE },
            }),
      };

      const updated = { ...prev, [normId]: next };
      saveWidget(normId, next);
      return updated;
    });
    toast.success("Тип объекта изменён.");
  };

  /* ----- обновить конфиг графика ----- */
  const updateChartConfig = (idRaw: string, config: Record<string, any>) => {
    const normId = normalizeKey(idRaw);
    setWidgets((prev) => {
      const cur = prev[normId];
      if (!cur) return prev;
      const width =
        typeof config.width === "number" ? config.width : cur.width;
      const height =
        typeof config.height === "number" ? config.height : cur.height;
      const clean = { ...config };
      delete (clean as any).width;
      delete (clean as any).height;
      const updatedWidget: Widget = {
        ...cur,
        chartConfig: clean,
        width,
        height,
      };
      saveWidget(normId, updatedWidget);
      return { ...prev, [normId]: updatedWidget };
    });
  };

  /* ----- удалить объект ----- */
  const deleteWidget = async (idRaw: string): Promise<void> => {
    const id = normalizeKey(idRaw);
    try {
      // Используем эндпоинт из user_screens: DELETE /user-screens/{screen_id}/objects/{object_name}
      await api.del(
        `/user-screens/${screenId}/objects/${encodeURIComponent(id)}`
      );

      setWidgets((prev) => {
        const u = { ...prev };
        delete u[id];
        return u;
      });
      setTagSettings((prev) => {
        if (!(id in prev)) return prev;
        const u = { ...prev };
        delete u[id];
        return u;
      });

      tombstonesRef.current.add(id);
      lastSavedRef.current.delete(id);
      const t = saveDebounceRef.current.get(id);
      if (t) {
        clearTimeout(t);
        saveDebounceRef.current.delete(id);
      }

      toast.success(`Объект "${id}" удалён.`);
    } catch (e: any) {
      console.warn("deleteWidget:", e?.detail || e?.message);
      toast.error("Ошибка удаления!");
    }
  };

  /* ----- rename ----- */
  const handleRename = async (objectNameRaw: string): Promise<void> => {
    const objectName = normalizeKey(objectNameRaw);
    const currentLabel = widgets[objectName]?.label || objectName;
    const newLabel = window.prompt("Введите новое имя для метки:", currentLabel);
    if (!newLabel?.trim())
      return void toast.warn("Имя не может быть пустым!");

    try {
      await api.put("/tag-settings/screen-objects/rename", {
        object_name: objectName,
        new_label: newLabel,
        screen_name: screenName,
        server_id: serverId,
      });
      setWidgets((prev) => ({
        ...prev,
        [objectName]: { ...prev[objectName], label: newLabel },
      }));
      toast.success(
        `Метка "${objectName}" переименована в "${newLabel}".`
      );
    } catch {
      toast.error("Ошибка переименования метки!");
    } finally {
      setTagContextMenu(null);
    }
  };

  /* ----- настройки отображения тега ----- */
  const toggleTagSetting = (
    tagNameRaw: string,
    setting: keyof TagSettings
  ) => {
    const tagName = normalizeKey(tagNameRaw);
    if (!tagName) return;
    setTagSettings((prev) => {
      const current = getTagSettings(prev, tagName, defaultScadaSettings);
      const updatedEntry: TagSettings = {
        ...current,
        [setting]: !current[setting],
      };
      const updated: TagSettingsMap = { ...prev, [tagName]: updatedEntry };

      api
        .post("/tag-settings", {
          ServerId: serverId,
          ScreenName: screenName,
          ObjectName: tagName,
          ShowLabel: updatedEntry.showLabel ? 1 : 0,
          ShowTagName: updatedEntry.showTagName ? 1 : 0,
        })
        .catch(() => toast.error("Ошибка сохранения настроек!"));

      return updated;
    });
  };

  /* ----- контекстное меню ----- */
  const handleTagContextMenu = (
    e: MouseEvent<HTMLDivElement>,
    tagName: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const container = document.querySelector(".pid-container");
    const rect = container?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setTagContextMenu({ x, y, tagName: normalizeKey(tagName) });
  };

  const handleCloseMenu = () => setTagContextMenu(null);

  const getMenuPositionInContainer = (
    x: number,
    y: number,
    menuWidth = 210,
    menuHeight = 240,
    containerSelector = ".pid-container"
  ) => {
    const padding = 8;
    const container = document.querySelector(containerSelector);
    if (!container) return { left: x, top: y };
    const rect = container.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + menuWidth > rect.width) {
      left = Math.max(rect.width - menuWidth - padding, padding);
    }
    if (top + menuHeight > rect.height) {
      top = Math.max(rect.height - menuHeight - padding, padding);
    }
    return { left, top };
  };

  const handleMenuAction = async (action: string, tagName: string) => {
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
      case "close":
        return handleCloseMenu();
      default:
        return;
    }
  };

  const ScadaContextMenu: React.FC<{
    position: { x: number; y: number };
    tagName: string;
  }> = ({ position, tagName }) => {
    const conf = getTagSettings(tagSettings, tagName, defaultScadaSettings);
    const items: {
      action: string;
      label: string;
      danger?: boolean;
    }[] = [
      { action: "rename", label: "Переименовать" },
      { action: "delete", label: "Удалить", danger: true },
      {
        action: "toggle_label",
        label: conf.showLabel ? "Скрыть метку" : "Показать метку",
      },
      {
        action: "toggle_tagname",
        label: conf.showTagName ? "Скрыть имя" : "Показать имя",
      },
      {
        action: "toggle_type",
        label:
          widgets[tagName]?.type === "chart"
            ? "Сделать меткой"
            : "Сделать трендом",
      },
      { action: "close", label: "Закрыть" },
    ];

    const { left, top } = getMenuPositionInContainer(
      position.x,
      position.y,
      210,
      240,
      ".pid-container"
    );

    return (
      <div
        className="context-menu"
        style={{
          top,
          left,
          position: "absolute",
          zIndex: 999,
          maxWidth: 210,
          maxHeight: 240,
          minWidth: 180,
        }}
      >
        {items.map((item) => (
          <button
            key={item.action}
            onClick={() => handleMenuAction(item.action, tagName)}
            className="context-menu-button"
            style={{ color: item.danger ? "red" : "black" }}
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  };

  const renderContextMenu = () => {
    if (!tagContextMenu) return null;
    return (
      <ScadaContextMenu
        position={tagContextMenu}
        tagName={tagContextMenu.tagName}
      />
    );
  };

  /* ----- стили тегов ----- */
  const updateTagStyle = (idRaw: string, patch: Partial<TagStyle>) => {
    const id = normalizeKey(idRaw);
    setWidgets((prev) => {
      const w = prev[id];
      if (!w) return prev;
      const style: TagStyle = {
        ...(w.style || DEFAULT_TAG_STYLE),
        ...(patch || {}),
      };
      const next: Widget = { ...w, style };
      saveWidget(id, next);
      return { ...prev, [id]: next };
    });
  };

  const applyTagStyleToAll = (patch: Partial<TagStyle>) => {
    setWidgets((prev) => {
      const next: Record<string, Widget> = { ...prev };
      Object.values(next).forEach((w) => {
        if (w.type !== "tag") return;
        w.style = {
          ...DEFAULT_TAG_STYLE,
          ...(w.style || {}),
          ...(patch || {}),
        };
        saveWidget(w.id, w);
      });
      return next;
    });
  };

  /* ----- public API ----- */
  return {
    isLoaded,
    liveTags,
    widgets,
    setWidgets,
    tagSettings,
    defaultScadaSettings,

    moveWidget,
    saveWidget,

    addTagToArea,
    addChartToArea,
    convertWidgetType,
    updateChartConfig,

    deleteWidget,
    handleRename,

    toggleTagSetting,
    updateTagStyle,
    applyTagStyleToAll,

    tagContextMenu,
    handleTagContextMenu,
    handleCloseMenu,
    renderContextMenu,
  };
};
