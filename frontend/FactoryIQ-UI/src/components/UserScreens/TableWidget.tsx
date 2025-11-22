// src/components/Widgets/TableWidget.tsx (или как у тебя называется)
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
} from "react";
import {
  Card,
  Button,
  Space,
  Table,
  Modal,
  Form,
  DatePicker,
  Select,
  Input,
  Tag,
  InputNumber,
  Divider,
  Tooltip,
  Switch,
  message,
  Slider, // <-- добавили
} from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PlayCircleOutlined,   // <-- добавили
  PauseCircleOutlined,  // <-- добавили
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";

import TagSelectorForArea from "../TagSelectorForArea";
import { useApi } from "../../shared/useApi";
import s from "./TableWidget.module.css";

const { RangePicker } = DatePicker;

/* ---------- types ---------- */

type TableColumnKind = "datetime" | "tag";

type TableColumnDef = {
  kind: TableColumnKind | "datatime"; // учитываем опечатку
  tag?: string;
  title?: string;
  unit?: string;
  group?: string;
  decimals?: number;
  scale?: number;
  width?: number;
};

type TableDefinition = {
  name?: string;
  server_id?: number;
  server_name?: string;
  timezone?: string;
  time?: {
    from: string | null;
    to: string | null;
  };
  interval?: "1m" | "10m" | "1h" | "1d" | string;
  columns: TableColumnDef[];
  saved_table_id?: number;
};

type TableConfig = {
  title?: string;
  name?: string;
  definition?: TableDefinition;
  definition_source?: string;
  saved_table_id?: number;
  autoRefresh?: boolean;
  rangePreset?: string;
  [k: string]: any;
};

type LongRow = {
  dt?: string;
  DateTime?: string;
  row_key?: string;
  date?: string;
  TagName?: string;
  Value?: number;
  [key: string]: any;
};

type WideRow = {
  dt: string;
  [key: string]: any;
};

type RangePreset = {
  value: string;
  label: string;
  hours?: number;
};

interface TableWidgetProps {
  id: string;
  serverId?: number;
  serverName?: string;
  title?: string;
  config?: TableConfig;
  width?: number;
  height?: number;
  editable?: boolean;
  onConfigChange?: (cfg: TableConfig) => void;
  onDelete?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onResizeStop?: (id: string, size: { width: number; height: number }) => void;

  /** Колбэк для синхронизации проигрывания с другими виджетами */
  onPlaybackTick?: (dt: string, row: WideRow) => void;
}

/* ---------- utils ---------- */

const fmtNum = (v: unknown, decimals?: number) => {
  if (v == null || Number.isNaN(v as number)) return "";
  const n = typeof v === "number" ? v : Number(v);
  return n.toFixed(typeof decimals === "number" ? decimals : 1);
};

const toLocalIsoNoTZ = (d: Date | Dayjs | null | undefined) =>
  d ? dayjs(d).format("YYYY-MM-DDTHH:mm:ss") : null;

const keepAsIsDt = (value: unknown): string => {
  if (value == null) return "—";
  const s = String(value);
  if (/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(:\d{2})?$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return s.replace("T", " ").replace(/Z$/i, "").slice(0, 19);
  }
  return s;
};

function pivotLongToWide(longRows: LongRow[], tagCols: TableColumnDef[]) {
  const idxByTag = new Map(
    tagCols.map((c, i) => [String(c.tag || "").trim(), i])
  );
  const byDt = new Map<string, WideRow>();

  for (const r of longRows) {
    const dt = (r.dt ?? r.DateTime ?? r.row_key ?? r.date) as string | undefined;
    const tag = String(r.TagName || "").trim();
    const val = r.Value;
    if (!dt || !idxByTag.has(tag)) continue;
    const i = idxByTag.get(tag)!;
    if (!byDt.has(dt)) byDt.set(dt, { dt });
    (byDt.get(dt) as any)[`c_${i}`] = val;
  }
  return Array.from(byDt.values());
}

// renderFactory — чтобы не создавать новый render на каждую колонку
const buildRenderFactory = () => {
  const cache = new Map<number, (v: unknown) => string>();
  return (decimals?: number) => {
    const k = Number.isFinite(decimals) ? (decimals as number) : -1;
    if (cache.has(k)) return cache.get(k)!;
    const fn = (v: unknown) => fmtNum(v, decimals);
    cache.set(k, fn);
    return fn;
  };
};

function buildAntdColumns(
  definition: TableDefinition,
  renderFactory: (decimals?: number) => (v: unknown) => string
): ColumnsType<any> {
  const cols = definition?.columns || [];
  const dtDef = cols.find((c) => c.kind === "datetime");
  const dtCol: any = {
    key: "dt",
    dataIndex: "dt",
    title: dtDef?.title || "Дата/Время",
    fixed: "left",
    width: 180,
  };

  const leaves = cols
    .filter((c) => c.kind === "tag")
    .map((c, idx) => ({
      key: `c_${idx}`,
      dataIndex: `c_${idx}`,
      title: `${c.title || c.tag}${c.unit ? `, ${c.unit}` : ""}`,
      group: c.group || null,
      align: "right" as const,
      render: renderFactory(c.decimals),
    }));

  const groups: Record<string, any[]> = {};
  leaves.forEach((col) => {
    if (col.group) (groups[col.group] ||= []).push(col);
  });
  const grouped = Object.keys(groups).map((g) => ({
    title: g,
    children: groups[g],
  }));
  const noGroup = leaves.filter((c) => !c.group);

  return [dtCol, ...grouped, ...noGroup];
}

const intervalToMs = (s: string | undefined): number => {
  switch (s) {
    case "1m":
      return 60_000;
    case "10m":
      return 600_000;
    case "1h":
      return 3_600_000;
    case "1d":
      return 86_400_000;
    default:
      return 60_000;
  }
};

const getRangeDurationMs = (time: TableDefinition["time"]): number => {
  const from = dayjs(time?.from);
  const to = dayjs(time?.to);
  if (!from.isValid() || !to.isValid()) return 6 * 60 * 60 * 1000;
  return Math.max(60_000, to.valueOf() - from.valueOf());
};

/* ---------- пресеты периода ---------- */

const RANGE_PRESETS: RangePreset[] = [
  { value: "custom", label: "По диапазону" },
  { value: "last_1h", label: "Последний 1 час", hours: 1 },
  { value: "last_2h", label: "Последние 2 часа", hours: 2 },
  { value: "last_6h", label: "Последние 6 часов", hours: 6 },
  { value: "last_8h", label: "Последние 8 часов", hours: 8 },
  { value: "last_12h", label: "Последние 12 часов", hours: 12 },
];

const presetToHours = (preset: string) =>
  RANGE_PRESETS.find((p) => p.value === preset)?.hours ?? null;

const computeOverrideByPreset = (preset: string) => {
  const h = presetToHours(preset);
  if (!h) return null;
  const to = new Date();
  const from = new Date(to.getTime() - h * 3600_000);
  return { from: toLocalIsoNoTZ(from), to: toLocalIsoNoTZ(to) };
};

/* ---------- component ---------- */

const TableWidget: React.FC<TableWidgetProps> = ({
  id,
  serverId,
  title,
  serverName = "",
  config,
  width,
  height,
  editable,
  onConfigChange,
  onDelete,
  onContextMenu,
  onResizeStop,
  onPlaybackTick, // <-- для внешней синхронизации
}) => {
  const api = useApi();

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rows, setRows] = useState<WideRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [, setTotalCells] = useState(0);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 200;

  // autoRefresh — контролируемый, храним в конфиге
  const [_autoRefresh, _setAutoRefresh] = useState<boolean>(
    !!config?.autoRefresh
  );
  const setAutoRefresh = useCallback(
    (next: boolean) => {
      _setAutoRefresh(next);
      onConfigChange?.({ ...(config || {}), autoRefresh: !!next });
    },
    [config, onConfigChange]
  );
  const autoRefresh = _autoRefresh;

  const [openDesigner, setOpenDesigner] = useState(false);
  const [form] = Form.useForm();

  const [draftDef, setDraftDef] = useState<TableDefinition | null>(null);
  const [draftRangePreset, setDraftRangePreset] = useState<string>(
    config?.rangePreset || "custom"
  );
  const [rangePreset, setRangePreset] = useState<string>(
    config?.rangePreset || "custom"
  );

  // размеры
  const [widthPx, setWidthPx] = useState<number>(width || 760);
  const [heightPx, setHeightPx] = useState<number>(height || 360);
  const [resizing, setResizing] = useState(false);
  const isResizingRef = useRef(false);
  const syncLockRef = useRef(0);

  // refs
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const rowsLenRef = useRef(0);
  const totalRowsRef = useRef(0);
  const offsetRef = useRef(0);
  const autoScrollPendingRef = useRef(false);
  const autoTickTimeoutRef = useRef<number | null>(null);
  const autoTickIntervalRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyHostRef = useRef<HTMLDivElement | null>(null);
  const openDesignerRef = useRef(false);

  // ---------- состояние проигрывателя ----------
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const playTimerRef = useRef<number | null>(null);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);
  useEffect(() => {
    rowsLenRef.current = rows.length;
  }, [rows.length]);
  useEffect(() => {
    totalRowsRef.current = totalRows;
  }, [totalRows]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  useEffect(() => {
    openDesignerRef.current = openDesigner;
  }, [openDesigner]);

  // синк размеров из props (без лишних перерисовок)
  useEffect(() => {
    if (isResizingRef.current || syncLockRef.current) return;
    if (Number.isFinite(width) && Math.abs((width ?? 760) - widthPx) > 0) {
      setWidthPx(width ?? 760);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);
  useEffect(() => {
    if (isResizingRef.current || syncLockRef.current) return;
    if (Number.isFinite(height) && Math.abs((height ?? 360) - heightPx) > 0) {
      setHeightPx(height ?? 360);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  /* --- безопасная схема --- */
  const safeDefinition = useMemo<TableDefinition | null>(() => {
    const src = config?.definition
      ? (JSON.parse(JSON.stringify(config.definition)) as TableDefinition)
      : null;
    if (!src) return null;

    // опечатки kind
    src.columns = (src.columns || []).map((c) =>
      c?.kind === "datatime" ? { ...c, kind: "datetime" } : c
    );

    if (!src.columns.some((c) => c.kind === "datetime")) {
      src.columns.unshift({
        kind: "datetime",
        title: "Дата/Время",
        format: "DD.MM.YYYY HH:mm",
      } as any);
    }

    const seen = new Set<string>();
    src.columns = src.columns.filter((c) => {
      if (c.kind !== "tag") return true;
      const key = String(c.tag || "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!src.time || (!src.time.from && !src.time.to)) {
      const to = dayjs();
      const from = to.add(-6, "hour");
      src.time = {
        from: toLocalIsoNoTZ(from),
        to: toLocalIsoNoTZ(to),
      };
    }
    src.interval = (src.interval as any) || "1h";
    return src;
  }, [config?.definition]);

  const renderFactory = useMemo(buildRenderFactory, []);
  const antColumns = useMemo(
    () =>
      safeDefinition
        ? buildAntdColumns(safeDefinition, renderFactory)
        : [],
    [safeDefinition, renderFactory]
  );

  const tagColumns = useMemo(
    () => (safeDefinition?.columns || []).filter((c) => c.kind === "tag"),
    [safeDefinition]
  );

  useEffect(() => {
    setTotalCells((totalRows || 0) * (tagColumns.length || 0));
  }, [totalRows, tagColumns.length]);

  const getOverrideTime = useCallback(() => {
    const ov = computeOverrideByPreset(rangePreset);
    if (ov) return ov;
    return null;
  }, [rangePreset]);

  /* ---------- загрузка данных ---------- */
  const fetchPage = useCallback(
    async (
      pageOffset = 0,
      append = false,
      cancelRef?: { current: boolean },
      overrideTime?: { from: string | null; to: string | null } | null
    ) => {
      if (!safeDefinition) return;
      if (openDesignerRef.current) return;
      if (tagColumns.length === 0) {
        setRows([]);
        setTotalRows(0);
        setTotalCells(0);
        return;
      }

      const effOverride = overrideTime ?? getOverrideTime();

      const defForQuery: TableDefinition = {
        ...safeDefinition,
        server_name: safeDefinition.server_name || serverName || "",
        ...(effOverride ? { time: effOverride } : {}),
      };

      const body = {
        definition: defForQuery,
        timezone: safeDefinition.timezone || "Asia/Almaty",
        forceRefresh: false,
        table_id: safeDefinition?.saved_table_id || undefined,
        offset: pageOffset,
        limit: PAGE_SIZE,
      };

      append ? setLoadingMore(true) : setLoading(true);
      try {
        const data: any = await api.post("/ias-tables/preview", body);
        if (cancelRef?.current || openDesignerRef.current) return;

        const rawRows: LongRow[] = Array.isArray(data?.rows) ? data.rows : [];

        const rawTotal = Number.isFinite(data?.total)
          ? (data.total as number)
          : rawRows.length;
        const colsCount = tagColumns.length || 0;
        const isLong =
          rawRows.length > 0 &&
          "TagName" in rawRows[0] &&
          "Value" in rawRows[0];
        const effTotalRows =
          isLong && colsCount > 0
            ? Math.ceil(rawTotal / colsCount)
            : rawTotal;
        setTotalRows(effTotalRows);
        setTotalCells(effTotalRows * colsCount);

        const needPivot =
          rawRows.length > 0 &&
          "TagName" in rawRows[0] &&
          "Value" in rawRows[0];
        const baseRows: any[] = needPivot
          ? pivotLongToWide(rawRows, tagColumns)
          : rawRows;

        const scaled: WideRow[] = baseRows.map((r: any) => {
          const out: any = { ...r };
          const dtRaw =
            r.dt ?? r.DateTime ?? r.row_key ?? r.date ?? null;
          out.dt = keepAsIsDt(dtRaw);
          tagColumns.forEach((c, i) => {
            const key = `c_${i}`;
            if (out[key] == null) return;
            const num = Number(out[key]);
            if (Number.isNaN(num)) return;
            let val = num;
            if (typeof c.scale === "number" && c.scale && c.scale !== 1) {
              val = val / c.scale;
            }
            if (typeof c.decimals === "number") {
              val = +val.toFixed(c.decimals);
            }
            out[key] = val;
          });
          return out as WideRow;
        });

        setRows((prev) => (append ? [...prev, ...scaled] : scaled));
        setOffset(pageOffset + PAGE_SIZE);

        // при полном обновлении — сбрасываем/подстраиваем позицию проигрывателя
        if (!append) {
          if (scaled.length > 0) {
            setPlayIndex((prev) => {
              if (prev == null) return 0;
              return Math.min(prev, scaled.length - 1);
            });
          } else {
            setPlayIndex(null);
          }
        }
      } catch (e: any) {
        console.warn(
          "[TableWidget] preview error",
          e?.response?.data || e?.message,
          { sent: body }
        );
        message.error("Не удалось получить данные таблицы");
        if (!append) {
          setRows([]);
          setTotalRows(0);
          setTotalCells(0);
          setPlayIndex(null);
        }
      } finally {
        if (!cancelRef?.current && !openDesignerRef.current) {
          append ? setLoadingMore(false) : setLoading(false);
        }
      }
    },
    [safeDefinition, serverName, tagColumns, getOverrideTime, api]
  );

  const fetchAll = useCallback(
    async (cancelRef?: { current: boolean }) => {
      setOffset(0);
      await fetchPage(0, false, cancelRef);
    },
    [fetchPage]
  );

  useEffect(() => {
    const cancelRef = { current: false };
    fetchAll(cancelRef);
    return () => {
      cancelRef.current = true;
    };
  }, [serverId, serverName, fetchAll, rangePreset]);

  /* ---------- автообновление ---------- */
  const scheduleAutoRefresh = useCallback(() => {
    if (!safeDefinition) return;

    const ms = intervalToMs(safeDefinition.interval);

    const clearTimers = () => {
      if (autoTickTimeoutRef.current) {
        window.clearTimeout(autoTickTimeoutRef.current);
        autoTickTimeoutRef.current = null;
      }
      if (autoTickIntervalRef.current) {
        window.clearInterval(autoTickIntervalRef.current);
        autoTickIntervalRef.current = null;
      }
    };
    clearTimers();

    const doTick = () => {
      if (openDesignerRef.current) return;
      const presetOverride = getOverrideTime();
      let override = presetOverride;
      if (!override) {
        const durationMs = getRangeDurationMs(safeDefinition.time);
        const to = new Date();
        const from = new Date(to.getTime() - durationMs);
        override = {
          from: toLocalIsoNoTZ(from),
          to: toLocalIsoNoTZ(to),
        };
      }
      const cancelRef = { current: false };
      autoScrollPendingRef.current = true;
      fetchPage(0, false, cancelRef, override);
    };

    // немедленный тик
    doTick();

    const now = Date.now();
    const delay = ms - (now % ms);

    autoTickTimeoutRef.current = window.setTimeout(() => {
      doTick();
      autoTickIntervalRef.current = window.setInterval(doTick, ms);
    }, delay);

    return clearTimers;
  }, [safeDefinition, fetchPage, getOverrideTime]);

  useEffect(() => {
    if (openDesignerRef.current) return;
    if (!autoRefresh) {
      if (autoTickTimeoutRef.current) {
        window.clearTimeout(autoTickTimeoutRef.current);
        autoTickTimeoutRef.current = null;
      }
      if (autoTickIntervalRef.current) {
        window.clearInterval(autoTickIntervalRef.current);
        autoTickIntervalRef.current = null;
      }
      return;
    }
    const clear = scheduleAutoRefresh();
    return () => {
      if (clear) clear();
    };
  }, [autoRefresh, scheduleAutoRefresh]);

  // автоскролл вниз после авто-тиков
  useEffect(() => {
    if (!autoScrollPendingRef.current || openDesignerRef.current) return;
    const el = document.querySelector(
      `#tbl-${id}-body .ant-table-body`
    ) as HTMLElement | null;
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight;
      autoScrollPendingRef.current = false;
    });
  }, [rows, id]);

  /* ---------- дозагрузка по скроллу ---------- */
  useEffect(() => {
    const el = document.querySelector(
      `#tbl-${id}-body .ant-table-body`
    ) as HTMLElement | null;
    if (!el) return;

    const THRESHOLD_PX = 120;
    const onScroll = () => {
      if (openDesignerRef.current) return;
      const hasMore = rowsLenRef.current < totalRowsRef.current;
      if (!hasMore || loadingRef.current || loadingMoreRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollTop + clientHeight >= scrollHeight - THRESHOLD_PX) {
        const nextOffset = offsetRef.current;
        const cancelRef = { current: false };
        fetchPage(nextOffset, true, cancelRef);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [id, fetchPage]);

  /* ---------- экспорт ---------- */
  const exportAll = useCallback(async () => {
    if (!safeDefinition) return;

    const PAGE_SIZE = 200;
    const MAX_PAGES = 5000;
    const all: LongRow[] = [];
    let off = 0;
    const hide = message.loading("Готовим экспорт…", 0);

    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const defForExport: TableDefinition = {
          ...safeDefinition,
          server_name: safeDefinition.server_name || serverName || "",
          ...(getOverrideTime() ? { time: getOverrideTime()! } : {}),
        };
        const data: any = await api.post("/ias-tables/preview", {
          definition: defForExport,
          timezone: safeDefinition.timezone || "Asia/Almaty",
          forceRefresh: false,
          table_id: safeDefinition?.saved_table_id || undefined,
          offset: off,
          limit: PAGE_SIZE,
        });
        const page: LongRow[] = Array.isArray(data?.rows) ? data.rows : [];
        if (!page.length) break;
        all.push(...page);
        off += PAGE_SIZE;
        if (Number.isFinite(data?.total) && off >= data.total) break;
      }

      const needPivot =
        all.length > 0 &&
        "TagName" in all[0] &&
        "Value" in all[0];
      const baseRows: any[] = needPivot
        ? pivotLongToWide(
            all,
            (safeDefinition.columns || []).filter(
              (c) => c.kind === "tag"
            )
          )
        : all;

      const cols = safeDefinition.columns || [];
      const dtCol = cols.find((c) => c.kind === "datetime");
      const tagColsConf = cols.filter((c) => c.kind === "tag");

      const headerRow1: (string | null)[] = [
        dtCol?.title || "Дата/Время",
      ];
      const headerRow2: (string | null)[] = [""];
      const leaves = tagColsConf.map((c, idx) => {
        const width = Number(c.width);
        const rawDec = Number(c.decimals);
        const rawScale = Number(c.scale);
        return {
          key: `c_${idx}`,
          title: `${c.title || c.tag}${
            c.unit ? `, ${c.unit}` : ""
          }`,
          group: c.group || "",
          width:
            Number.isFinite(width) && width > 0 ? width : 140,
          decimals: Number.isFinite(rawDec)
            ? (rawDec as number)
            : undefined,
          scale:
            Number.isFinite(rawScale) && rawScale !== 0
              ? (rawScale as number)
              : 1,
        };
      });

      leaves.forEach((l) => {
        headerRow1.push(l.group || "");
        headerRow2.push(l.title);
      });

      const dataRows = baseRows.map((r: any) => {
        const out: (string | number | null)[] = [
          keepAsIsDt(
            r.dt ?? r.DateTime ?? r.row_key ?? r.date ?? ""
          ),
        ];
        leaves.forEach((l, i) => {
          const raw = r[`c_${i}`];
          const num = Number(raw);
          if (Number.isNaN(num)) {
            out.push(null);
            return;
          }
          let val = num;
          if (Number.isFinite(l.scale) && l.scale !== 1) {
            val = val / (l.scale as number);
          }
          if (typeof l.decimals === "number") {
            val = +val.toFixed(l.decimals);
          }
          out.push(val);
        });
        return out;
      });

      const payload = {
        file_name: (safeDefinition.name || "Таблица") + ".xlsx",
        sheet_name: "Данные",
        header_row_1: headerRow1,
        header_row_2: headerRow2,
        data: dataRows,
        auto_width: true,
        number_formats: leaves.map((l) =>
          Number.isFinite(l.decimals)
            ? `0.${"0".repeat(l.decimals as number)}`
            : "0.0"
        ),
        date_format: "dd.mm.yyyy hh:mm",
      };

      // экспорт через fetch, чтобы получить blob
      const resp = await fetch("/api/ias-tables/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        console.warn("export error", txt);
        message.error("Ошибка экспорта: " + txt);
        return;
      }

      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const txt = await resp.text();
        console.warn("export error json:", txt);
        message.error("Ошибка экспорта: " + txt);
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = payload.file_name || "export.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success("Файл Excel сформирован");
    } catch (e: any) {
      console.warn("export error", e?.message);
      message.error("Не удалось сформировать Excel");
    } finally {
      hide?.();
    }
  }, [safeDefinition, serverName, getOverrideTime, api]);

  /* ---------- модалка настроек ---------- */
  const draftTagColumns = useMemo(
    () => (draftDef?.columns || []).filter((c) => c.kind === "tag"),
    [draftDef]
  );

  const openDesignerWithDraft = useCallback(() => {
    if (!safeDefinition) return;
    const draft = JSON.parse(
      JSON.stringify(safeDefinition)
    ) as TableDefinition;
    setDraftDef(draft);
    setDraftRangePreset(rangePreset);
    setOpenDesigner(true);

    const from = draft.time?.from ? dayjs(draft.time.from) : null;
    const to = draft.time?.to ? dayjs(draft.time.to) : null;
    form.setFieldsValue({
      name: draft.name || config?.title || "Таблица",
      interval: draft.interval || "1h",
      period: from && to ? [from, to] : undefined,
      periodPreset: rangePreset,
    });
  }, [safeDefinition, form, config?.title, rangePreset]);

  const mutateDraft = useCallback(
    (mutate: (def: TableDefinition) => void) => {
      setDraftDef((prev) => {
        const next: TableDefinition = prev
          ? JSON.parse(JSON.stringify(prev))
          : { columns: [], interval: "1h" };
        mutate(next);
        return next;
      });
    },
    []
  );

  const addTagColumnDraft = useCallback(
    (tag: any) => {
      const tagName = tag?.TagName || tag;
      if (!tagName) return;
      mutateDraft((def) => {
        const exists = (def.columns || []).some(
          (c) =>
            c.kind === "tag" &&
            String(c.tag).trim() === String(tagName).trim()
        );
        if (exists) return;
        def.columns = def.columns || [];
        if (!def.columns.some((c) => c.kind === "datetime")) {
          def.columns.unshift({
            kind: "datetime",
            title: "Дата/Время",
            format: "DD.MM.YYYY HH:mm",
          } as any);
        }
        def.columns.push({
          kind: "tag",
          tag: tagName,
          group: "Конв 1",
          title: tagName.includes("Current")
            ? "Ток"
            : tagName.includes("Power")
            ? "Мощность"
            : "Среднее (интервал)",
          agg: "avg",
          decimals: 1,
          unit: "",
          scale: 1,
        } as any);
      });
    },
    [mutateDraft]
  );

  const removeTagColumnDraft = useCallback(
    (tagName: string) =>
      mutateDraft((def) => {
        def.columns = (def.columns || []).filter(
          (c) => !(c.kind === "tag" && c.tag === tagName)
        );
      }),
    [mutateDraft]
  );

  const changeTagFieldDraft = useCallback(
    (tagName: string, field: string, value: any) =>
      mutateDraft((def) => {
        const col = (def.columns || []).find(
          (c) => c.kind === "tag" && c.tag === tagName
        );
        if (col) (col as any)[field] = value;
      }),
    [mutateDraft]
  );

  const moveTagDraft = useCallback(
    (tagName: string, dir: "up" | "down") =>
      mutateDraft((def) => {
        const cols = def.columns || [];
        const i = cols.findIndex(
          (c) => c.kind === "tag" && c.tag === tagName
        );
        if (i < 0) return;
        const firstTagIndex = cols.findIndex(
          (c) => c.kind === "tag"
        );
        const j = dir === "up" ? i - 1 : i + 1;
        if (j < firstTagIndex || j >= cols.length) return;
        [cols[i], cols[j]] = [cols[j], cols[i]];
        def.columns = [...cols];
      }),
    [mutateDraft]
  );

  const onDesignerOk = useCallback(() => {
    if (!draftDef) {
      setOpenDesigner(false);
      return;
    }
    const values = form.getFieldsValue();
    const nextDef: TableDefinition = JSON.parse(
      JSON.stringify(draftDef)
    );
    const [from, to] = (values.period || []) as Dayjs[];
    nextDef.name =
      values.name || nextDef.name || "Таблица";
    nextDef.interval =
      values.interval || nextDef.interval || "1h";
    nextDef.time = {
      from: toLocalIsoNoTZ(from),
      to: toLocalIsoNoTZ(to),
    };
    nextDef.server_name ||= serverName;

    const nextConfig: TableConfig = { ...(config || {}) };
    nextConfig.definition = nextDef;
    nextConfig.rangePreset = draftRangePreset;

    onConfigChange?.(nextConfig);

    setOpenDesigner(false);
    setDraftDef(null);
    setRangePreset(draftRangePreset);
  }, [
    draftDef,
    form,
    serverName,
    config,
    onConfigChange,
    draftRangePreset,
  ]);

  // гидратация по id
  useEffect(() => {
    const needHydrate =
      !!config?.saved_table_id && !config?.definition;
    if (!needHydrate || openDesignerRef.current) return;

    let cancelled = false;
    (async () => {
      try {
        const data: any = await api.get(
          `/ias-tables/${config!.saved_table_id}`
        );
        const def = data?.definition || data;
        if (!cancelled && def) {
          const next: TableConfig = { ...(config || {}) };
          next.definition = def;
          next.definition_source = "loaded";
          onConfigChange?.(next);
          message.success("Конфигурация таблицы загружена");
        }
      } catch (e: any) {
        if (!cancelled) {
          console.warn(
            "load definition by id error",
            e?.response?.data || e?.message
          );
          message.error(
            "Не удалось загрузить конфигурацию таблицы"
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.saved_table_id, !!config?.definition]);

  /* ---------- ресайзер ---------- */
  const startRef = useRef({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  });

  const onResizeStart = (
    e: React.MouseEvent<HTMLDivElement, MouseEvent>
  ) => {
    e.preventDefault();
    isResizingRef.current = true;
    setResizing(true);
    startRef.current = {
      x: e.clientX,
      y: e.clientY,
      w: widthPx,
      h: heightPx,
    };
    document.addEventListener("mousemove", onResizing);
    document.addEventListener("mouseup", onResizeEnd);
  };

  const onResizing = (e: MouseEvent) => {
    if (!isResizingRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    const w = Math.max(520, startRef.current.w + dx);
    const h = Math.max(260, startRef.current.h + dy);
    const el = containerRef.current;
    if (el) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
  };

  const onResizeEnd = () => {
    document.removeEventListener("mousemove", onResizing);
    document.removeEventListener("mouseup", onResizeEnd);
    isResizingRef.current = false;
    setResizing(false);

    const el = containerRef.current;
    const w = Math.round(el?.offsetWidth || widthPx);
    const h = Math.round(el?.offsetHeight || heightPx);
    setWidthPx(w);
    setHeightPx(h);
    onResizeStop?.(id, { width: w, height: h });
  };

  /* ---------- динамический scroll.y ---------- */
  const [scrollY, setScrollY] = useState(200);
  const scrollX = Math.max(320, (widthPx ?? 760) - 40);

  useLayoutEffect(() => {
    if (openDesignerRef.current) return;
    if (!bodyHostRef.current) return;

    const host = bodyHostRef.current;
    let raf = 0;

    const calc = () => {
      const total = host.clientHeight;

      const headerEl =
        (host.querySelector(
          ".ant-table-header"
        ) as HTMLElement | null) ??
        (host.querySelector(
          ".ant-table thead"
        ) as HTMLElement | null);

      const headerH = headerEl
        ? headerEl.getBoundingClientRect().height
        : 56;

      const reserve = 8;
      const y = Math.max(48, total - headerH - reserve);

      setScrollY((prev) => (prev !== y ? y : prev));
    };

    const calcRAF = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(calc);
    };

    calc();
    calcRAF();

    const ro = new ResizeObserver(calcRAF);
    if (containerRef.current) ro.observe(containerRef.current);
    ro.observe(host);
    window.addEventListener("resize", calcRAF);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", calcRAF);
    };
  }, [widthPx, heightPx, rows.length, antColumns.length]);

  /* ---------- логика проигрывателя ---------- */

  const stopPlayback = useCallback(() => {
    setIsPlaying(false);
    if (playTimerRef.current) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  const startPlayback = useCallback(() => {
    if (!rows.length) return;
    // если позиция не выбрана — стартуем с начала
    setPlayIndex((prev) => (prev == null ? 0 : prev));

    // шаг по умолчанию: 500мс, можно потом завести в конфиг
    const STEP_MS = 500;

    if (playTimerRef.current) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }

    setIsPlaying(true);
    playTimerRef.current = window.setInterval(() => {
      setPlayIndex((prev) => {
        if (prev == null) return 0;
        const next = prev + 1;
        if (next >= rowsLenRef.current) {
          // достигли конца диапазона — останавливаемся
          stopPlayback();
          return rowsLenRef.current - 1;
        }
        return next;
      });
    }, STEP_MS);
  }, [rows.length, stopPlayback]);

  // очистка таймера при размонтировании
  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, []);

  // при изменении данных — если играем, корректируем индекс.
  useEffect(() => {
    if (!rows.length) {
      stopPlayback();
      setPlayIndex(null);
      return;
    }
    setPlayIndex((prev) => {
      if (prev == null) return 0;
      return Math.min(prev, rows.length - 1);
    });
  }, [rows.length, stopPlayback]);

  // реальный тик проигрывателя: подсветка, скролл, внешний колбэк
  useEffect(() => {
    if (playIndex == null || !rows.length) return;
    const idx = Math.min(playIndex, rows.length - 1);
    const row = rows[idx];
    if (!row) return;

    // внешний колбэк — для SCADA/глобального бегунка
    if (onPlaybackTick && row.dt) {
      onPlaybackTick(String(row.dt), row);
    }

    // скроллим таблицу, чтобы текущая строка была видна
    const bodyEl = document.querySelector(
      `#tbl-${id}-body .ant-table-body`
    ) as HTMLElement | null;
    if (!bodyEl) return;
    const trs = Array.from(bodyEl.querySelectorAll("tr")) as HTMLElement[];
    const target = trs.find(
      (tr) => tr.dataset && tr.dataset.rowKey === String(row.dt)
    );
    if (!target) return;

    const { offsetTop, offsetHeight } = target;
    const { scrollTop, clientHeight } = bodyEl;

    if (offsetTop < scrollTop || offsetTop + offsetHeight > scrollTop + clientHeight) {
      bodyEl.scrollTop = offsetTop - clientHeight / 2;
    }
  }, [playIndex, rows, onPlaybackTick, id]);

  // Заголовок
  const headerTitle =
    [title, config?.title, config?.name, safeDefinition?.name].find(
      (v) => typeof v === "string" && v.trim().length > 0
    ) || "Таблица";

  const extraControls = useMemo(
    () => (
      <Space>
        <Tooltip title="Автообновление по интервалу агрегации">
          <Switch checked={autoRefresh} onChange={setAutoRefresh} />
        </Tooltip>
        <Button
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            const cancelRef = { current: false };
            autoScrollPendingRef.current = true;
            fetchAll(cancelRef);
          }}
          disabled={loading}
        >
          Обновить
        </Button>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            exportAll();
          }}
        >
          Экспорт
        </Button>
        {editable && (
          <>
            <Button
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                openDesignerWithDraft();
              }}
            >
              Настроить
            </Button>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.();
              }}
            />
          </>
        )}
      </Space>
    ),
    [
      autoRefresh,
      loading,
      editable,
      fetchAll,
      exportAll,
      openDesignerWithDraft,
      onDelete,
      setAutoRefresh,
    ]
  );

  const playbackBar = useMemo(() => {
    if (!rows.length) return null;
    const currentIdx =
      playIndex != null ? Math.min(playIndex, rows.length - 1) : rows.length - 1;
    const currentRow = rows[currentIdx];
    return (
      <div className={s.playbackBar}>
        <Space style={{ width: "100%" }}>
          <Button
            size="small"
            icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={() => {
              if (isPlaying) stopPlayback();
              else startPlayback();
            }}
          />
          <Slider
            min={0}
            max={Math.max(rows.length - 1, 0)}
            value={currentIdx}
            onChange={(v) => {
              setPlayIndex(v as number);
              // ручной перетаскивание — без автоплей
              if (isPlaying) {
                stopPlayback();
              }
            }}
            style={{ flex: 1 }}
          />
          <span className={s.playbackDt}>
            {currentRow?.dt || ""}
          </span>
        </Space>
      </div>
    );
  }, [rows, playIndex, isPlaying, stopPlayback, startPlayback]);

  return (
    <div
      ref={containerRef}
      className={s.container}
      style={{ width: widthPx, height: heightPx }}
    >
      <Card
        size="small"
        title={headerTitle}
        extra={extraControls}
        onContextMenu={onContextMenu}
        className={s.card}
      >
        <div id={`tbl-${id}-body`} ref={bodyHostRef} className={s.body}>
          {resizing ? (
            <div className={s.resizePlaceholder}>
              Режим изменения размера…
            </div>
          ) : (
            <>
              <Table
                size="small"
                bordered
                loading={loading}
                rowKey="dt"
                columns={antColumns}
                dataSource={(rows || []).map((r) => ({
                  key: r.dt,
                  ...r,
                }))}
                rowClassName={(_, idx) => {
                  const isLast = idx === (rows?.length || 0) - 1;
                  const isPlay = idx === (playIndex ?? -1);
                  if (isPlay) return `${s.playRow}${isLast ? " " + s.latestRow : ""}`;
                  return isLast ? s.latestRow : "";
                }}
                pagination={false}
                sticky={false}
                scroll={{ x: scrollX, y: scrollY }}
              />
              {playbackBar}
            </>
          )}
        </div>

        <Modal
          title="Настройка таблицы"
          open={openDesigner}
          onOk={onDesignerOk}
          onCancel={() => {
            setOpenDesigner(false);
            setDraftDef(null);
          }}
          width={950}
          okText="Сохранить изменения"
          cancelText="Отмена"
          destroyOnClose
        >
          <Form form={form} layout="vertical">
            <Form.Item label="Название отчёта" name="name">
              <Input placeholder="Отчёт по конвейерам" />
            </Form.Item>

            <Form.Item
              label="Период (режим)"
              name="periodPreset"
              initialValue={draftRangePreset}
            >
              <Select
                value={draftRangePreset}
                onChange={setDraftRangePreset}
                options={RANGE_PRESETS}
              />
            </Form.Item>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Form.Item
                label="Период (диапазон дат/времени)"
                name="period"
              >
                <RangePicker
                  showTime
                  style={{ width: "100%" }}
                  format="DD.MM.YYYY HH:mm"
                  disabled={draftRangePreset !== "custom"}
                />
              </Form.Item>
              <Form.Item
                label="Интервал агрегации"
                name="interval"
                initialValue="1h"
              >
                <Select
                  options={[
                    { value: "1m", label: "1 мин" },
                    { value: "10m", label: "10 мин" },
                    { value: "1h", label: "1 час" },
                    { value: "1d", label: "1 сутки" },
                  ]}
                />
              </Form.Item>
            </div>
            {draftRangePreset !== "custom" && (
              <div
                style={{
                  color: "#888",
                  marginTop: -4,
                  marginBottom: 8,
                }}
              >
                Выбран быстрый период "
                {
                  RANGE_PRESETS.find(
                    (p) => p.value === draftRangePreset
                  )?.label
                }
                ". Поля дат выше будут проигнорированы.
              </div>
            )}

            <Divider style={{ margin: "8px 0 14px" }} />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: 500,
                    marginBottom: 6,
                  }}
                >
                  Добавить колонку (тег)
                </div>
                <TagSelectorForArea
                  serverId={serverId}
                  onTagAdd={(t: any) => addTagColumnDraft(t)}
                />
              </div>

              <div>
                <div
                  style={{
                    fontWeight: 500,
                    marginBottom: 6,
                  }}
                >
                  Колонки таблицы
                </div>
                {(!draftTagColumns ||
                  draftTagColumns.length === 0) && (
                  <div style={{ color: "#888" }}>
                    Колонки не выбраны
                  </div>
                )}
                {(draftTagColumns || []).map((c) => (
                  <Card
                    key={c.tag}
                    size="small"
                    style={{ marginBottom: 8 }}
                    bodyStyle={{ padding: 10 }}
                    title={
                      <Space>
                        <Tag color="blue">{c.tag}</Tag>
                        <Tooltip title="Поднять">
                          <Button
                            size="small"
                            icon={<ArrowUpOutlined />}
                            onClick={() =>
                              moveTagDraft(c.tag!, "up")
                            }
                          />
                        </Tooltip>
                        <Tooltip title="Опустить">
                          <Button
                            size="small"
                            icon={<ArrowDownOutlined />}
                            onClick={() =>
                              moveTagDraft(c.tag!, "down")
                            }
                          />
                        </Tooltip>
                        <Tooltip title="Удалить колонку">
                          <Button
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() =>
                              removeTagColumnDraft(c.tag!)
                            }
                          />
                        </Tooltip>
                      </Space>
                    }
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 10,
                      }}
                    >
                      <Input
                        addonBefore="Группа"
                        value={c.group || ""}
                        onChange={(e) =>
                          changeTagFieldDraft(
                            c.tag!,
                            "group",
                            e.target.value
                          )
                        }
                      />
                      <Input
                        addonBefore="Заголовок"
                        value={c.title || ""}
                        onChange={(e) =>
                          changeTagFieldDraft(
                            c.tag!,
                            "title",
                            e.target.value
                          )
                        }
                      />
                      <InputNumber
                        addonBefore="Точность"
                        min={0}
                        max={6}
                        value={
                          typeof c.decimals === "number"
                            ? c.decimals
                            : 1
                        }
                        onChange={(v) =>
                          changeTagFieldDraft(
                            c.tag!,
                            "decimals",
                            v ?? 1
                          )
                        }
                      />
                      <Input
                        addonBefore="Единица"
                        value={c.unit || ""}
                        onChange={(e) =>
                          changeTagFieldDraft(
                            c.tag!,
                            "unit",
                            e.target.value
                          )
                        }
                      />
                      <InputNumber
                        addonBefore="Scale ÷"
                        min={0}
                        value={
                          typeof c.scale === "number"
                            ? c.scale
                            : 1
                        }
                        onChange={(v) =>
                          changeTagFieldDraft(
                            c.tag!,
                            "scale",
                            v ?? 1
                          )
                        }
                      />
                      <Input
                        addonBefore="Агрегат"
                        disabled
                        value="avg (по аналитике)"
                      />
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          </Form>
        </Modal>
      </Card>

      {editable && (
        <div
          className={s.resizer}
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart(e);
          }}
          title="Изменить размер"
        />
      )}
    </div>
  );
};

export default TableWidget;
