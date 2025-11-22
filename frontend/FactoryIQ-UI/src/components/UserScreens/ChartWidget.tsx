// src/components/UserScreens/ChartWidget.tsx
import React, {
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  MouseEvent,
  DragEvent,
} from "react";
import Draggable, {
  DraggableData,
  DraggableEvent,
} from "react-draggable";
import { ResizableBox, ResizeCallbackData } from "react-resizable";
import { Settings, Plus, Trash2 } from "lucide-react";
import Plot from "react-plotly.js";
import type { Layout, PlotData } from "plotly.js";
import { createPortal } from "react-dom";

import { useApi } from "../../shared/useApi";
import TrendTagSelector from "./TrendTagSelector";
import useTrendsAutoUpdate from "./hooks/widgetsupdates";
import styles from "./ChartWidget.module.css";
import { formatLiveDataValue } from "./UserScreensModule";
import { useTimeContext } from "./TimeContext";

import "react-resizable/css/styles.css";

/* ============================== types & utils ============================== */

const COLORS = ["#1976d2", "#EF476F", "#06D6A0", "#FFD166", "#118AB2", "#8D4EDD"];

const normalizeColor = (color: string): string => {
  if (/^#[\da-f]{3}$/i.test(color)) {
    return (
      "#" +
      color[1] + color[1] +
      color[2] + color[2] +
      color[3] + color[3]
    );
  }
  return color;
};

const chartTypes = [
  { value: "line", label: "Линия" },
  { value: "area", label: "Площадь" },
  { value: "bar", label: "Столбцы" },
];

const intervalOptions = [
  { value: 60000, label: "1 минута" },
  { value: 180000, label: "3 минуты" },
  { value: 300000, label: "5 минут" },
  { value: 600000, label: "10 минут" },
  { value: 1800000, label: "30 минут" },
  { value: 3600000, label: "1 час" },
];

export interface ChartLinesSettings {
  color?: string;
  lineWidth?: number;
}

export interface ChartWidgetStyle {
  chartType: "line" | "area" | "bar";
  color: string;
  bgColor: string;
  lineWidth: number;
  rangeHours: number;
  width: number;
  height: number;
  tags: string[];
  intervalMs: number;
  alignScales: boolean;
  aliases: Record<string, string>;
  lines: Record<string, ChartLinesSettings>;
}

const defaultStyle: ChartWidgetStyle = {
  chartType: "line",
  color: "#1976d2",
  bgColor: "#ffffff",
  lineWidth: 2,
  rangeHours: 8,
  width: 320,
  height: 140,
  tags: [],
  intervalMs: 180000,
  alignScales: false,
  aliases: {},
  lines: {},
};

interface TrendPoint {
  timestamp: string;
  value: number | null;
}

type TrendSeries = TrendPoint[];

// ответ нового эндпоинта /user-screens/{id}/trends
interface ScreenTrendItem {
  screen_object_id: number;
  tag_id: number;
  tag_name?: string;
  timestamp: string;
  value: number | null;
}

interface ScreenTrendResponse {
  ok: boolean;
  items: ScreenTrendItem[];
}

const toSQLLocal = (dt: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ` +
    `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
  );
};

const extractTagName = (raw: unknown): string => {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    return String(
      r.TagName ?? r.tagName ?? r.name ?? r.id ?? r.ID ?? ""
    ).trim();
  }
  return String(raw ?? "").trim();
};

// Быстрая равномерная «усечка» до maxPoints
const capPoints = (arr: TrendSeries | undefined, maxPoints = 2000): TrendSeries => {
  const src: TrendSeries = Array.isArray(arr) ? arr : [];
  const n = src.length;
  if (n <= maxPoints) return src;
  const step = (n - 1) / (maxPoints - 1);
  const out: TrendSeries = new Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    out[i] = src[Math.round(i * step)];
  }
  return out;
};

// «requestIdleCallback» нам не принципиален – достаточно таймаута
const ric = (cb: () => void): number => window.setTimeout(cb, 0);

/* ============================== props ============================== */

export interface ChartWidgetProps {
  id: string;
  tag?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  label: string;
  style?: Partial<ChartWidgetStyle>;
  onMove?: (id: string, patch: { x: number; y: number }) => void;
  onStyleChange?: (id: string, style: ChartWidgetStyle) => void;
  serverName?: string | null;
  serverId?: number | null;
  onDelete?: (id: string) => void;
  editable?: boolean;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>, id: string) => void;
  screenId: number;
}

/* ============================== component ============================== */

const ChartWidget: React.FC<ChartWidgetProps> = ({
  id,
  tag,
  x,
  y,
  width,
  height,
  label,
  style = {},
  onMove,
  onStyleChange,
  serverName,
  serverId,
  onDelete,
  editable = true,
  onContextMenu,
  screenId,
}) => {
  const api = useApi();
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const [showTagSelector, setShowTagSelector] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plotReady, setPlotReady] = useState(false);

  const { mode, range, cursor, windowMinutes } = useTimeContext();

  const initialStyle: ChartWidgetStyle = useMemo(
    () => ({
      ...defaultStyle,
      ...style,
      width: style.width || width || defaultStyle.width,
      height: style.height || height || defaultStyle.height,
      tags:
        Array.isArray(style.tags) && style.tags.length > 0
          ? style.tags
          : tag
          ? [tag]
          : [],
      alignScales:
        typeof style.alignScales === "boolean"
          ? style.alignScales
          : defaultStyle.alignScales,
      aliases: style.aliases || defaultStyle.aliases,
      lines: style.lines || defaultStyle.lines,
    }),
    [style, width, height, tag]
  );

  const [widgetStyle, setWidgetStyle] = useState<ChartWidgetStyle>(initialStyle);
  const [multiData, setMultiData] = useState<Record<string, TrendSeries>>({});
  const [selectedTag, setSelectedTag] = useState<string>(
    (Array.isArray(style.tags) && style.tags[0]) || tag || ""
  );

  // Инициализацию Plotly переносим (уменьшаем LCP)
  useEffect(() => {
    const t = ric(() => setPlotReady(true));
    return () => clearTimeout(t);
  }, []);

  // Первичная/реактивная загрузка трендов ПО ЭКРАНУ с учётом TimeContext
  useEffect(() => {
    if (!widgetStyle.tags?.length || !screenId) return;

    let start: Date;
    let end: Date;

    if (mode === "live") {
      // Живой режим — как раньше: «последние N часов»
      end = new Date();
      start = new Date(
        end.getTime() - (widgetStyle.rangeHours || 8) * 3600_000
      );
    } else {
      // Режим воспроизведения / диапазона
      if (range.from && range.to) {
        start = range.from;
        end = range.to;
      } else if (cursor) {
        const minutes =
          windowMinutes || widgetStyle.rangeHours * 60 || 60;
        const halfMs = (minutes * 60_000) / 2;
        start = new Date(cursor.getTime() - halfMs);
        end = new Date(cursor.getTime() + halfMs);
      } else {
        // запасной вариант — как live
        end = new Date();
        start = new Date(
          end.getTime() - (widgetStyle.rangeHours || 8) * 3600_000
        );
      }
    }

    const startStr = toSQLLocal(start);
    const endStr = toSQLLocal(end);

    let cancelled = false;

    api
      .get<ScreenTrendResponse>(`/user-screens/${screenId}/trends`, {
        start_date: startStr,
        end_date: endStr,
        interval_ms: widgetStyle.intervalMs,
      })
      .then((res) => {
        if (cancelled) return;
        const items = res?.items || [];

        const shaped: Record<string, TrendSeries> = {};

        for (const row of items) {
          const tagName = String(row.tag_name || "").trim();
          if (!tagName) continue;
          // нас интересуют только те теги, которые назначены в этом виджете
          if (!widgetStyle.tags.includes(tagName)) continue;

          if (!shaped[tagName]) shaped[tagName] = [];
          shaped[tagName].push({
            timestamp: row.timestamp,
            value:
              row.value !== undefined && row.value !== null
                ? Number(row.value)
                : null,
          });
        }

        // квантование по maxPoints
        const capped: Record<string, TrendSeries> = {};
        Object.entries(shaped).forEach(([t, arr]) => {
          capped[t] = capPoints(arr, 2000);
        });

        setMultiData(capped);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("screen trends error", err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    screenId,
    widgetStyle.tags,
    widgetStyle.rangeHours,
    widgetStyle.intervalMs,
    mode,
    range.from,
    range.to,
    cursor,
    windowMinutes,
  ]);

  // Автообновление живых данных — пока выключено, чтобы не дёргать старый /trend
  useTrendsAutoUpdate({
    serverName,
    tags: widgetStyle.tags,
    rangeHours: widgetStyle.rangeHours,
    setMultiData,
    intervalMinutes: 4,
    intervalMs: widgetStyle.intervalMs,
    enabled: false,
  });

  // Debounce onStyleChange
  const firstRef = useRef(true);
  const styleDebounce = useRef<number | null>(null);

  useEffect(() => {
    if (!onStyleChange) return;
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (styleDebounce.current !== null) {
      window.clearTimeout(styleDebounce.current);
    }
    styleDebounce.current = window.setTimeout(() => {
      onStyleChange(id, widgetStyle);
    }, 150);
    return () => {
      if (styleDebounce.current !== null) {
        window.clearTimeout(styleDebounce.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetStyle, id]);

  const handleStop = useCallback(
    (_e: DraggableEvent, data: DraggableData) => {
      onMove && onMove(id, { x: data.x, y: data.y });
    },
    [id, onMove]
  );

  const displayName = useCallback(
    (t: string) =>
      widgetStyle.aliases && widgetStyle.aliases[t]
        ? widgetStyle.aliases[t].trim()
        : t,
    [widgetStyle.aliases]
  );

  const removeTag = useCallback((t: string) => {
    setWidgetStyle((w) => {
      if (!w.tags.includes(t)) return w;
      const newTags = w.tags.filter((x) => x !== t);
      const { [t]: _omitLine, ...restLines } = w.lines || {};
      const { [t]: _omitAlias, ...restAliases } = w.aliases || {};
      return { ...w, tags: newTags, lines: restLines, aliases: restAliases };
    });
  }, []);

  const isPowerTag = useCallback(
    (t: string) => /Power(_[A-Za-z0-9]*)?$/i.test(String(t || "")),
    []
  );

  const toAxisValue = useCallback(
    (tagName: string, v: number, sid?: number | null) => {
      if (!Number.isFinite(v)) return null;
      if (!isPowerTag(tagName)) return v;
      if (Number(sid) === 5) return v; // уже кВт
      if (Math.abs(v) <= 10) return v * 1000; // МВт -> кВт
      return v / 1000; // Вт -> кВт
    },
    [isPowerTag]
  );

  const formatHover = useCallback(
    (tagName: string, v: number, sid?: number | null) => {
      if (v == null) return "Нет данных";
      if (isPowerTag(tagName)) {
        const val = toAxisValue(tagName, v, sid);
        return val == null ? "Нет данных" : `${val.toFixed(2)} кВт`;
      }
      return String(formatLiveDataValue(tagName, v));
    },
    [isPowerTag, toAxisValue]
  );

  const extractUnit = useCallback((formatted: string) => {
    const s = String(formatted || "").trim();
    const m = s.match(/\s([A-Za-zА-Яа-яµ°%]+)$/);
    return m ? m[1] : "";
  }, []);

  /* ============================== plot memo ============================== */

  const hasAnyData = useMemo(
    () =>
      widgetStyle.tags.some(
        (t) => Array.isArray(multiData[t]) && multiData[t].length
      ),
    [multiData, widgetStyle.tags]
  );

  const yAxisUnit = useMemo(() => {
    if (widgetStyle.alignScales) return "";
    if (widgetStyle.tags.some(isPowerTag)) return "кВт";
    for (const t of widgetStyle.tags) {
      const arr = multiData[t] || [];
      for (const d of arr) {
        if (d?.value != null) {
          return extractUnit(
            formatLiveDataValue(t, Number(d.value))
          );
        }
      }
    }
    return "";
  }, [
    widgetStyle.alignScales,
    widgetStyle.tags,
    multiData,
    extractUnit,
    isPowerTag,
  ]);

  const traces = useMemo<Partial<PlotData>[]>(() => {
    return widgetStyle.tags.map((t, idx) => {
      const arr = multiData[t] || [];
      const color =
        (widgetStyle.lines?.[t] && widgetStyle.lines[t].color) ||
        COLORS[idx % COLORS.length] ||
        "#1976d2";
      const lw =
        (widgetStyle.lines?.[t] && widgetStyle.lines[t].lineWidth) || 2;

      const xArr = arr.map((d) => d.timestamp);
      const yArr = arr.map((d) =>
        d?.value == null ? null : toAxisValue(t, Number(d.value), serverId)
      );
      const customdata = arr.map((d) =>
        d?.value == null ? "Нет данных" : formatHover(t, Number(d.value), serverId)
      );

      let mode: "lines" | "lines+markers" | undefined = "lines";
      if (widgetStyle.chartType === "area") mode = "lines+markers";
      if (widgetStyle.chartType === "bar") mode = undefined;

      const yaxisName = widgetStyle.alignScales
        ? idx === 0
          ? "y"
          : `y${idx + 1}`
        : "y";

      return {
        x: xArr,
        y: yArr,
        type: widgetStyle.chartType === "bar" ? "bar" : "scatter",
        mode,
        fill: widgetStyle.chartType === "area" ? "tozeroy" : undefined,
        name: displayName(t),
        line: { color, width: lw, shape: "spline" },
        marker: { color },
        customdata,
        hovertemplate:
          `${displayName(t)}<br>%{x|%d.%m.%Y %H:%M}` +
          `<br>Значение: %{customdata}` +
          `<extra></extra>`,
        connectgaps: true,
        yaxis: yaxisName,
      } as Partial<PlotData>;
    });
  }, [
    widgetStyle.tags,
    widgetStyle.lines,
    widgetStyle.chartType,
    widgetStyle.alignScales,
    multiData,
    toAxisValue,
    formatHover,
    displayName,
    serverId,
  ]);

  const yaxesLayout = useMemo<Partial<Layout>>(() => {
    const base: Partial<Layout> = {
      yaxis: {
        showgrid: true,
        automargin: true,
        title: widgetStyle.alignScales
          ? undefined
          : { text: yAxisUnit || undefined },
      },
    };
    if (widgetStyle.alignScales && widgetStyle.tags.length > 1) {
      for (let i = 1; i < widgetStyle.tags.length; i++) {
        const axisKey = `yaxis${i + 1}` as keyof Layout;
        (base as any)[axisKey] = {
          overlaying: "y",
          side: i % 2 === 0 ? "left" : "right",
          showgrid: false,
          showticklabels: false,
          zeroline: false,
        };
      }
    }
    return base;
  }, [widgetStyle.alignScales, widgetStyle.tags.length, yAxisUnit]);

  const plotLayout = useMemo<Partial<Layout>>(
    () => ({
      autosize: true,
      height: widgetStyle.height - 28,
      margin: { l: 28, r: 10, t: 8, b: 28 },
      plot_bgcolor: normalizeColor(widgetStyle.bgColor),
      paper_bgcolor: normalizeColor(widgetStyle.bgColor),
      font: { family: "inherit", size: 13 },
      xaxis: {
        showgrid: true,
        type: "date",
        tickformat: "%H:%M",
        automargin: true,
      },
      showlegend: widgetStyle.tags.length > 1,
      legend: { orientation: "h", y: -0.22, x: 0.5, xanchor: "center" },
      ...yaxesLayout,
    }),
    [widgetStyle.height, widgetStyle.bgColor, widgetStyle.tags.length, yaxesLayout]
  );

  const plotStyle = useMemo<React.CSSProperties>(
    () => ({ width: "100%", height: widgetStyle.height - 28 }),
    [widgetStyle.height]
  );

  /* ============================== handlers ============================== */

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const raw = e.dataTransfer.getData("application/json");
        const data = raw ? JSON.parse(raw) : {};
        const t = extractTagName(
          typeof data.tag === "string" ? data.tag : data.tag || data
        );
        if (t && !widgetStyle.tags.includes(t)) {
          setWidgetStyle((w) => ({ ...w, tags: [...w.tags, t] }));
        }
      } catch {
        // ignore
      }
    },
    [widgetStyle.tags]
  );

  const handleResizeStop = useCallback(
    (_e: React.SyntheticEvent<Element>, { size }: ResizeCallbackData) => {
      setWidgetStyle((w) => {
        if (w.width === size.width && w.height === size.height) return w;
        return { ...w, width: size.width, height: size.height };
      });
    },
    []
  );

  const widgetBgStyle = useMemo(
    () =>
      ({
        "--bg": normalizeColor(widgetStyle.bgColor),
      } as React.CSSProperties),
    [widgetStyle.bgColor]
  );

  /* ============================== render ============================== */

  return (
    <Draggable
      nodeRef={dragNodeRef}
      bounds="parent"
      disabled={!editable}
      handle={`.${styles.dragHandle}`}
      position={{ x, y }}
      onStop={editable ? handleStop : undefined}
    >
      <div
        ref={dragNodeRef}
        style={{ position: "absolute", zIndex: 2 }}
      >
        <ResizableBox
          width={widgetStyle.width}
          height={widgetStyle.height}
          minConstraints={[180, 100]}
          maxConstraints={[1200, 600]}
          resizeHandles={editable ? ["se"] : []}
          onResizeStop={editable ? handleResizeStop : undefined}
          handle={
            editable ? (
              <span className={styles.resizeHandle}>⤡</span>
            ) : undefined
          }
          style={{
            width: widgetStyle.width,
            height: widgetStyle.height,
          }}
        >
          <div
            className={styles.widget}
            style={widgetBgStyle}
            onContextMenu={
              editable
                ? (e) => {
                    e.preventDefault();
                    onContextMenu && onContextMenu(e, id);
                  }
                : undefined
            }
            onDragOver={
              editable ? (e: DragEvent<HTMLDivElement>) => e.preventDefault() : undefined
            }
            onDrop={editable ? handleDrop : undefined}
          >
            {/* Верхняя панель */}
            <div className={styles.dragHandle}>
              <span className={styles.titleLeft}>
                <span className={styles.titleText}>{label}</span>
                {widgetStyle.tags.length > 0 && (
                  <span className={styles.tagsInline}>
                    (
                    {widgetStyle.tags
                      .map((t) => displayName(t))
                      .join(" / ")}
                    )
                  </span>
                )}
                {editable && widgetStyle.tags.length < 5 && (
                  <button
                    className={styles.iconButtonAdd}
                    title="Добавить тег на график"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowTagSelector(true);
                    }}
                  >
                    <Plus size={15} />
                  </button>
                )}
              </span>

              <span className={styles.actionsRight}>
                {editable && onDelete && (
                  <button
                    className={styles.iconButton}
                    onClick={() => onDelete(id)}
                    title="Удалить виджет"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                {editable && (
                  <button
                    className={styles.iconButton}
                    onClick={() => setSettingsOpen((v) => !v)}
                    title="Настройки графика"
                  >
                    <Settings size={16} />
                  </button>
                )}
              </span>
            </div>

            {/* График / плейсхолдер */}
            <div className={styles.plotArea}>
              {!plotReady ? (
                <div className={styles.noData}>Загрузка…</div>
              ) : !hasAnyData ? (
                <div className={styles.noData}>Нет данных</div>
              ) : (
                <Plot
                  data={traces}
                  layout={plotLayout}
                  config={{ displayModeBar: false, responsive: true }}
                  style={plotStyle}
                />
              )}
            </div>
          </div>
        </ResizableBox>

        {/* Окно настроек */}
        {editable &&
          settingsOpen &&
          createPortal(
            <div className={styles.modal}>
              {/* Список тегов */}
              <div className={styles.modalSection}>
                <label className={styles.sectionTitle}>Теги:</label>
                <div className={styles.tagList}>
                  {(widgetStyle.tags || []).map((t) => (
                    <span
                      key={t}
                      className={`${styles.tagPill} ${
                        selectedTag === t ? styles.tagPillActive : ""
                      }`}
                      onClick={() => setSelectedTag(t)}
                      title={t}
                    >
                      {displayName(t)}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTag(t);
                        }}
                        title="Удалить тег из графика"
                        className={styles.tagRemove}
                      >
                        <Trash2 size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Настройки выбранного тега */}
              {selectedTag &&
                (widgetStyle.tags || []).includes(selectedTag) && (
                  <div className={styles.tagSettings}>
                    <div className={styles.fieldRow}>
                      <label>Подпись (алиас):</label>
                      <input
                        type="text"
                        placeholder='например, "Конвейер 4, фаза 2"'
                        value={
                          (widgetStyle.aliases &&
                            widgetStyle.aliases[selectedTag]) ||
                          ""
                        }
                        className={styles.input}
                        onChange={(e) => {
                          const v = e.target.value;
                          setWidgetStyle((w) => ({
                            ...w,
                            aliases: {
                              ...(w.aliases || {}),
                              [selectedTag]: v,
                            },
                          }));
                        }}
                      />
                    </div>
                    <div className={styles.fieldRow}>
                      <label>Цвет линии:</label>
                      <input
                        type="color"
                        value={
                          (widgetStyle.lines?.[selectedTag] &&
                            widgetStyle.lines[selectedTag].color) ||
                          "#1976d2"
                        }
                        onChange={(e) => {
                          const color = e.target.value;
                          setWidgetStyle((w) => ({
                            ...w,
                            lines: {
                              ...(w.lines || {}),
                              [selectedTag]: {
                                ...(w.lines && w.lines[selectedTag]
                                  ? w.lines[selectedTag]
                                  : {}),
                                color,
                              },
                            },
                          }));
                        }}
                      />
                    </div>
                    <div className={styles.fieldRow}>
                      <label>Толщина линии:</label>
                      <input
                        type="number"
                        min={1}
                        max={6}
                        className={styles.inputNumber}
                        value={
                          (widgetStyle.lines?.[selectedTag] &&
                            widgetStyle.lines[selectedTag].lineWidth) || 2
                        }
                        onChange={(e) => {
                          const lw = Number(e.target.value);
                          setWidgetStyle((w) => ({
                            ...w,
                            lines: {
                              ...(w.lines || {}),
                              [selectedTag]: {
                                ...(w.lines && w.lines[selectedTag]
                                  ? w.lines[selectedTag]
                                  : {}),
                                lineWidth: lw,
                              },
                            },
                          }));
                        }}
                      />
                    </div>
                  </div>
                )}

              {/* Общие настройки */}
              <div className={styles.fieldRow}>
                <label>Вид графика:</label>
                <select
                  className={styles.select}
                  value={widgetStyle.chartType}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      chartType: e.target.value as ChartWidgetStyle["chartType"],
                    }))
                  }
                >
                  {chartTypes.map((t) => (
                    <option value={t.value} key={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={!!widgetStyle.alignScales}
                    onChange={(e) =>
                      setWidgetStyle((w) => ({
                        ...w,
                        alignScales: e.target.checked,
                      }))
                    }
                  />
                  <span>Выровнять шкалы (наложение осей)</span>
                </label>
                <div className={styles.hint}>
                  Линии с разными диапазонами будут визуально сопоставимы. В
                  подсказке остаются «реальные» значения.
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label>Фон:</label>
                <input
                  type="color"
                  value={normalizeColor(widgetStyle.bgColor)}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      bgColor: normalizeColor(e.target.value),
                    }))
                  }
                />
              </div>

              <div className={styles.fieldRow}>
                <label>Интервал (часов):</label>
                <input
                  type="number"
                  min={1}
                  max={96}
                  className={styles.inputNumber}
                  value={widgetStyle.rangeHours}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      rangeHours: Number(e.target.value),
                    }))
                  }
                />
              </div>

              <div className={styles.fieldRow}>
                <label>Шаг усреднения:</label>
                <select
                  className={styles.select}
                  value={widgetStyle.intervalMs}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      intervalMs: Number(e.target.value),
                    }))
                  }
                >
                  {intervalOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.fieldRow}>
                <label>Ширина:</label>
                <input
                  type="number"
                  min={180}
                  max={1200}
                  className={styles.inputNumber}
                  value={widgetStyle.width}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      width: Number(e.target.value),
                    }))
                  }
                />
              </div>

              <div className={styles.fieldRow}>
                <label>Высота:</label>
                <input
                  type="number"
                  min={100}
                  max={600}
                  className={styles.inputNumber}
                  value={widgetStyle.height}
                  onChange={(e) =>
                    setWidgetStyle((w) => ({
                      ...w,
                      height: Number(e.target.value),
                    }))
                  }
                />
              </div>

              <button
                className={styles.closeBtn}
                onClick={() => setSettingsOpen(false)}
              >
                Закрыть
              </button>
            </div>,
            document.body
          )}

        {/* модалка выбора тегов */}
        {showTagSelector &&
          createPortal(
            <TrendTagSelector
              serverId={serverId ?? undefined}
              excludeTags={widgetStyle.tags}
              maxSelect={Math.max(1, 5 - widgetStyle.tags.length)}
              onClose={() => setShowTagSelector(false)}
              onTagsAdd={(tags) => {
                setWidgetStyle((w) => ({
                  ...w,
                  tags: [
                    ...w.tags,
                    ...tags.filter((t) => !w.tags.includes(t)),
                  ],
                }));
                setShowTagSelector(false);
              }}
            />,
            document.body
          )}
      </div>
    </Draggable>
  );
};

export default React.memo(ChartWidget);
