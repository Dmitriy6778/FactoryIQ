// src/pages/SchedulePage.tsx
import React, {
  useEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
} from "react";
import styles from "../styles/SchedulePage.module.css";
import {
  Send,
  Edit2,
  Trash2,
  Plus,
  Copy,
  RefreshCw,
  Power,
  Eye,
} from "lucide-react";
import {
  Modal,
  Form,
  Input,
  Select,
  Table,
  Button,
  Popconfirm,
  Space,
  Tag,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { FormInstance } from "antd/es/form";

import BackButton from "../components/BackButton";
import ReportPreview from "../components/ReportPreview";
import { useApi } from "../shared/useApi";
import ScheduleStyleModal from "../components/ScheduleStyleModal";
const DEBUG = false;

/* ---------------- API endpoints ---------------- */
const TG = "/telegram";
const API = {
  SCHEDULE_LIST: `${TG}/schedule`,
  SCHEDULE_CREATE: `${TG}/schedule`,
  SCHEDULE_UPDATE: (id: number) => `${TG}/schedule/${id}`,
  SCHEDULE_TOGGLE: (id: number) => `${TG}/schedule/${id}/toggle`,
  SCHEDULE_DELETE: (id: number) => `${TG}/schedule/${id}`,
  SCHEDULE_RUNNOW: (id: number) => `${TG}/schedule/${id}/run-now`,
  // справочники
  TEMPLATES: "/reports/templates",
  CHANNELS: `${TG}/channels`,
};

/* -------- time utils (вместо dayjs) -------- */
const TIME_RX = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/;
function normalizeTimeStr(v?: string | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(TIME_RX);
  if (!m) return null;
  let hh = Math.max(0, Math.min(23, parseInt(m[1] || "0", 10)));
  let mm = Math.max(0, Math.min(59, parseInt(m[2] || "0", 10)));
  let ss = Math.max(0, Math.min(59, parseInt(m[3] || "0", 10)));
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}
function isValidTimeStr(v?: string | null): boolean {
  return normalizeTimeStr(v) !== null;
}

/** Вспомогательные флаги по периодам */
const isMinutePeriod = (p?: string) =>
  p === "every_5m" || p === "every_10m" || p === "every_30m";

/** Минутное окно по типу периода */
const windowByPeriod = (p?: string): number | null => {
  if (p === "every_5m") return 5;
  if (p === "every_10m") return 10;
  if (p === "every_30m") return 30;
  return null;
};

// ====== словари отображения ======
const PERIOD_LABELS: Record<string, string> = {
  shift: "Смена",
  daily: "Сутки",
  weekly: "Неделя",
  monthly: "Месяц",
  once: "Однократно",
  hourly: "Каждый час",
  every_5m: "Каждые 5 минут",
  every_10m: "Каждые 10 минут",
  every_30m: "Каждые 30 минут",
};

const FORMAT_LABELS: Record<string, string> = {
  chart: "График",
  table: "Таблица",
  file: "Файл",
  text: "Текст",
};

const AGGREGATION_LABELS: Record<string, string> = {
  avg: "Среднее",
  min: "Минимум",
  max: "Максимум",
  sum: "Сумма",
  current: "Текущее",
  delta: "Прирост",
  alerts: "Аварии",
  null: "—",
};

// ====== типы ======
// PATCH: расширяем Task
type Task = {
  id: number;
  template_id: number;
  template_name?: string;
  period_type: string;
  time_of_day: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  is_active: boolean;
  target_type: string;
  target_value: string;
  aggregation_type: string | null;
  send_format: string | null;

  trend_window_minutes?: number | null;
  trend_avg_seconds?: number | null;

  // новое:
  window_minutes?: number | null;
  avg_seconds?: number | null;
  style_id?: number | null;
  style_override?: any | null;
};


type Template = {
  id: number;
  name: string;
  preview?: {
    proc: string;
    baseParams?: Record<string, any>;
    map_x: string;
    map_y: string;
    map_series?: string | null;
    unit?: string | null;
    title?: string | null;
    defaultChart?: "line" | "bar";
  };
};
type TgChannel = {
  Id: number;
  ChannelId: number;
  ChannelName: string;
  Active: number;
  ThreadId?: number | null;
};

// ====== редактируемые ячейки ======
const EditableContext = React.createContext<FormInstance<any> | null>(null);

const EditableRow: React.FC<React.HTMLAttributes<HTMLTableRowElement>> = (
  props
) => {
  const [form] = Form.useForm();
  return (
    <Form form={form} component={false}>
      <EditableContext.Provider value={form}>
        <tr {...props} />
      </EditableContext.Provider>
    </Form>
  );
};

type EditableCellProps = {
  title: React.ReactNode;
  editable: boolean;
  children: React.ReactNode;
  dataIndex: keyof Task;
  record: Task;
  handleSave: (row: Task) => void;
  inputType?: "input" | "select" | "multiselect" | "time";
  options?: { value: string | number; label: string }[];
  disabled?: boolean;
};



const EditableCell: React.FC<EditableCellProps> = ({
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  inputType,
  options = [],
  disabled = false,
  ...restProps
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<any>(null);
  const form = React.useContext(EditableContext)!;

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current?.focus?.();
  }, [editing]);

  const toggleEdit = () => {
    if (disabled) return;
    setEditing((e) => !e);
    if (inputType === "time") {
      form.setFieldsValue({ [dataIndex]: record[dataIndex] || "" });
    } else {
      form.setFieldsValue({ [dataIndex]: record[dataIndex] });
    }
  };

  const save = async () => {
    try {
      const values = await form.validateFields();
      if (inputType === "time") {
        const norm = normalizeTimeStr(values[dataIndex]);
        if (!norm) throw new Error("bad time");
        values[dataIndex] = norm;
      }
      setEditing(false);
      handleSave({ ...record, ...values });
    } catch {
      /* ignore */
    }
  };

  const { title: _ignoredTitle, ...cellTdProps } = restProps as any;

  if (!editable) {
    return <td {...cellTdProps}>{children}</td>;
  }

  let inputNode: React.ReactNode = null;
  switch (inputType) {
    case "select":
      inputNode = (
        <Select
          ref={inputRef}
          style={{ minWidth: 160 }}
          onBlur={save}
          options={options}
        />
      );
      break;
    case "multiselect":
      inputNode = (
        <Select
          ref={inputRef}
          mode="multiple"
          allowClear
          style={{ minWidth: 160 }}
          onBlur={save}
          options={options}
        />
      );
      break;
    case "time":
      inputNode = (
        <Input
          ref={inputRef}
          placeholder="HH:mm:ss"
          onPressEnter={save}
          onBlur={save}
        />
      );
      break;
    default:
      inputNode = <Input ref={inputRef} onPressEnter={save} onBlur={save} />;
  }

  return (
    <td {...cellTdProps}>
      {editing ? (
        <Form.Item
          style={{ margin: 0 }}
          name={dataIndex as string}
          rules={
            inputType === "time"
              ? [
                  {
                    validator: (_, v) =>
                      isValidTimeStr(v)
                        ? Promise.resolve()
                        : Promise.reject(new Error("Формат HH:mm:ss")),
                  },
                ]
              : undefined
          }
        >
          {inputNode}
        </Form.Item>
      ) : (
        <div
          style={{
            minHeight: 24,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
          }}
          onClick={toggleEdit}
          title={disabled ? "Недоступно для этого периода" : "Редактировать"}
        >
          {children}
          {!disabled && (
            <Edit2 size={12} style={{ marginLeft: 6, color: "#3e75d6" }} />
          )}
        </div>
      )}
    </td>
  );
};

// ====== страница ======
const SchedulePage: React.FC = () => {
  const api = useApi();
  const [tasks, setTasks] = useState<Task[]>([]);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesMap, setTemplatesMap] = useState<Record<number, string>>({});
  const [channels, setChannels] = useState<TgChannel[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  // Предпросмотр
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<any>(null);

  // Параметры формы добавления
  const [sendFormat, setSendFormat] = useState<string>("chart");
  const [aggregationType, setAggregationType] = useState<string[]>([]);
const [styleOpen, setStyleOpen] = useState(false);
const [styleRecord, setStyleRecord] = useState<Task | null>(null);
const [previewTitle, setPreviewTitle] = useState<string>("Предпросмотр отчёта");

function parseStyleOverride(v: any): any {
  if (!v) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}



  // ====== шаблоны ======
  const loadTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ templates: Template[] }>(API.TEMPLATES);
      const list = data?.templates || [];
      setTemplates(list);
      const map: Record<number, string> = {};
      list.forEach((t) => (map[t.id] = t.name));
      setTemplatesMap(map);
    } catch {
      message.error("Ошибка загрузки шаблонов");
    }
  }, [api]);

  // ====== каналы ======
  const loadChannels = useCallback(async () => {
    try {
      const data = await api.get<{ ok: boolean; channels: any[] }>(API.CHANNELS);
      const list = (data?.channels ?? []).map((c) => ({
        Id: c.id,
        ChannelId: c.channel_id,
        ChannelName: c.channel_name,
        Active: c.active ? 1 : 0,
        ThreadId: c.thread_id ?? null,
      }));
      setChannels(list.filter((c) => c.Active));
    } catch {
      message.error("Ошибка загрузки Telegram-каналов");
    }
  }, [api]);

  const channelOptions = useMemo(
    () =>
      channels.map((c) => ({
        value: String(c.Id),
        label: `${c.ChannelName} (${c.ChannelId})`,
      })),
    [channels]
  );



  const channelById = useMemo(() => {
    const map: Record<string, TgChannel> = {};
    channels.forEach((c) => (map[String(c.Id)] = c));
    return map;
  }, [channels]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ ok: boolean; items: any[] }>(API.SCHEDULE_LIST);
      const items = res?.items || [];
      if (DEBUG) console.log("schedule items:", items);

     // PATCH: маппинг данных из /telegram/schedule — добавляем style_* и «сырые» окна
const mapped: Task[] = items.map((t: any) => ({
  id: t.id,
  template_id: t.template_id,
  template_name: templatesMap[t.template_id] || `#${t.template_id}`,
  period_type: t.period_type,
  time_of_day: t.time_of_day ?? null,
  next_run_at: t.next_run ?? null,
  last_run_at: t.last_run ?? null,
  is_active: Boolean(t.active),
  target_type: t.target_type,
  target_value: String(t.target_value ?? ""),
  aggregation_type: t.aggregation_type ?? null,
  send_format: t.send_format ?? "chart",

  // сырье с бэка (для сохранения)
  window_minutes: t.window_minutes ?? null,
  avg_seconds: t.avg_seconds ?? null,

  // локальные для UI
  trend_window_minutes: isMinutePeriod(t.period_type)
    ? (t.window_minutes ?? windowByPeriod(t.period_type) ?? null)
    : null,
  trend_avg_seconds: isMinutePeriod(t.period_type)
    ? (t.avg_seconds ?? 10)
    : null,

  // стили
  style_id: t.style_id ?? null,
  style_override: t.style_override ?? null,
}));


      setTasks(mapped);
    } catch (e: any) {
      message.error(`Ошибка загрузки расписаний: ${e?.message || e}`);
    }
    setLoading(false);
  }, [api, templatesMap]);

  // первая загрузка: справочники -> задания
  useEffect(() => {
    (async () => {
      await Promise.all([loadTemplates(), loadChannels()]);
      await loadTasks();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ====== helpers ======
  /** Payload (snake_case) для /preview */
 const buildPreviewPayload = (record: Task): any => {
  const base: any = {
    template_id: Number(record.template_id),
    format: (record.send_format as any) || "chart",
    period_type: record.period_type,
    time_of_day:
      isMinutePeriod(record.period_type) || record.period_type === "hourly"
        ? null
        : record.time_of_day || "08:00:00",
    aggregation_type: record.aggregation_type ?? null,
    window_minutes: isMinutePeriod(record.period_type)
      ? record.trend_window_minutes ?? windowByPeriod(record.period_type) ?? null
      : null,
    avg_seconds: isMinutePeriod(record.period_type)
      ? record.trend_avg_seconds ?? 10
      : null,
  };

  // ВАЖНО: приклеиваем стиль к payload, чтобы бэк применил text_template/chart_title
  const style = parseStyleOverride((record as any).style_override) || {};
  // ⬇️ передаём именно style_override — бэк это ждёт
base.style_override = {
  chart_title: style.chart_title,
  chart_kind: style.chart_kind,
  text_template: style.text_template,
  expand_weekly_shifts: !!style.expand_weekly_shifts,
  description_overrides: style.description_overrides,

  // NEW: недельные опции
  weekly_y_mode: style.weekly_y_mode,       // "delta" | "cum"
  weekly_divisor: style.weekly_divisor,     // число или строка
  weekly_unit: style.weekly_unit,           // подпись
};

  (base as any).__title = style.chart_title || "Предпросмотр отчёта";
  return base;
};
  // ====== обработчики ======
  const handleSave = useCallback(
    async (row: Task) => {
      setLoading(true);
      try {
        const isMinute = isMinutePeriod(row.period_type);
        const isHourly = row.period_type === "hourly";

        // PATCH: handleSave — сохраняем ещё и style_* если есть в record (не обязательно, но корректнее)
const prepared: any = {
  template_id: row.template_id,
  period_type: row.period_type,
  time_of_day: isMinute || isHourly ? "00:00:00" : row.time_of_day || "08:00:00",
  target_type: row.target_type,
  target_value: row.target_value,
  aggregation_type: Array.isArray(row.aggregation_type as any)
    ? (row.aggregation_type as any).join(",")
    : row.aggregation_type || null,
  send_format: row.send_format || null,
  window_minutes: isMinute
    ? Number(row.trend_window_minutes ?? windowByPeriod(row.period_type))
    : null,
  avg_seconds: isMinute ? Number(row.trend_avg_seconds ?? 10) : null,

  // новое (если когда-то прилетит и хранится в row)
  style_id: row.style_id ?? null,
  style_override: row.style_override ?? null,
};


        const res = await api.put(API.SCHEDULE_UPDATE(row.id), prepared);
        if ((res as any)?.ok !== true) {
          throw new Error((res as any)?.detail || "PUT failed");
        }
        message.success("Задание обновлено");
        await loadTasks();
      } catch (e: any) {
        message.error(`Ошибка при обновлении задания: ${e?.message || e}`);
      }
      setLoading(false);
    },
    [api, loadTasks]
  );

  const handlePreview = useCallback((record: Task) => {
  const p = buildPreviewPayload(record);
  setPreviewPayload(p);
  setPreviewTitle(p.__title || "Предпросмотр отчёта"); // заголовок из стиля
  setPreviewOpen(true);
}, []);

  const openModal = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleToggle = useCallback(
    async (id: number, nextState: boolean) => {
      setLoading(true);
      try {
        const res = await api.patch(API.SCHEDULE_TOGGLE(id), {
          is_active: nextState,
        });
        if ((res as any)?.ok !== true) {
          throw new Error((res as any)?.detail || "PATCH failed");
        }
        message.success(nextState ? "Задание включено" : "Задание выключено");
        await loadTasks();
      } catch (e: any) {
        message.error(`Ошибка изменения статуса: ${e?.message || e}`);
      }
      setLoading(false);
    },
    [api, loadTasks]
  );

  const handleDelete = useCallback(
    async (id: number) => {
      setLoading(true);
      try {
        const res = await api.del(API.SCHEDULE_DELETE(id));
        if ((res as any)?.ok !== true) {
          throw new Error((res as any)?.detail || "DELETE failed");
        }
        message.success("Задание удалено");
        await loadTasks();
      } catch (e: any) {
        message.error(`Ошибка при удалении: ${e?.message || e}`);
      }
      setLoading(false);
    },
    [api, loadTasks]
  );

  const handleAddTask = useCallback(
  async (values: any) => {
    setLoading(true);
    try {
      const {
        template_id,
        period_type,
        time_of_day,
        target_type,
        target_value,
        send_format,
        aggregation_type,
        trend_avg_seconds,
      } = values;

      const aggValue = Array.isArray(aggregation_type)
        ? aggregation_type.join(",")
        : aggregation_type || null;

      const windowMinutes = windowByPeriod(period_type) ?? null;

      if (period_type === "shift") {
        // создаём две записи: 08:00 и 20:00 (смены оставляем как есть)
        const shiftTimes = ["08:00:00", "20:00:00"];
        const results: any[] = [];
        for (const time of shiftTimes) {
          const body: any = {
            template_id,
            period_type,
            time_of_day: time,
            target_type,
            target_value: String(target_value),
            aggregation_type: aggValue,
            send_format,
          };
          results.push(await api.post(API.SCHEDULE_CREATE, body));
        }
        if (results.every((r: any) => r?.ok)) {
          message.success("Задания по сменам успешно созданы");
          setModalOpen(false);
          form.resetFields();
          await loadTasks();
        } else if (
          results.some((r: any) =>
            String(r?.detail || "").includes("существует")
          )
        ) {
          message.warning("Некоторые сменные расписания уже существуют");
        } else {
          message.error("Ошибка при создании одного из сменных расписаний");
        }
      } else {
        // ВСЕ остальные периоды, включая weekly, идут сюда
        let timeStr = "";
        if (period_type === "daily" || period_type === "once") {
          timeStr =
            normalizeTimeStr(
              typeof time_of_day === "string" ? time_of_day : ""
            ) || "08:00:00";
        } else if (period_type === "hourly" || isMinutePeriod(period_type)) {
          timeStr = "00:00:00";
        } else {
          // weekly / monthly / и др. — привязываем к 08:00:00, если время не задано
          timeStr = normalizeTimeStr(time_of_day) || "08:00:00";
        }

        const body: any = {
          template_id,
          period_type,
          time_of_day: timeStr,
          target_type,
          target_value: String(target_value),
          aggregation_type: aggValue,
          send_format,
        };

        if (isMinutePeriod(period_type)) {
          body.window_minutes = Number(windowMinutes);
          body.avg_seconds = Number.isFinite(+trend_avg_seconds)
            ? Number(trend_avg_seconds)
            : 10;
        }

        const res = await api.post(API.SCHEDULE_CREATE, body);
        if (
          res?.status === 409 ||
          String((res as any)?.detail || "").includes("существует")
        ) {
          message.warning("Такое расписание уже существует");
        } else if ((res as any)?.ok === false) {
          message.error("Ошибка при добавлении задания");
        } else {
          message.success("Задание добавлено");
          setModalOpen(false);
          form.resetFields();
          await loadTasks();
        }
      }
    } catch (e: any) {
      message.error(`Ошибка при добавлении задания: ${e?.message || e}`);
    }
    setLoading(false);
  },
  [api, form, loadTasks]
);



  // PATCH: handleRunNow — берём meta с бэка, формируем proc/params и отправляем в /telegram2/send
const handleRunNow = useCallback(
  async (id: number) => {
    try {
      const row = tasks.find((t) => t.id === id);
      if (!row) return message.warning("Задание не найдено");

      const isMinute = row.period_type === "every_5m" ||
                       row.period_type === "every_10m" ||
                       row.period_type === "every_30m";
      const isHourly = row.period_type === "hourly";

      // стиль
      const style = parseStyleOverride(row.style_override);
      const chartKind =
        style?.chart_kind ??
        (["shift","daily","weekly","monthly"].includes(row.period_type) ? "bar" : "line");

      // формируем payload для НОВОГО эндпоинта /telegram/send
      const body: any = {
        template_id: row.template_id,
        format: row.send_format || "chart",
        period_type: row.period_type,
        time_of_day: (isMinute || isHourly) ? null : (row.time_of_day || "08:00:00"),
        aggregation_type: row.aggregation_type ?? null,
        window_minutes: isMinute ? (row.trend_window_minutes ?? null) : null,
        avg_seconds: isMinute ? (row.trend_avg_seconds ?? 10) : null,
        target_type: "telegram",
        target_value: String(row.target_value),

        // стили (опционально)
        chart_title: style?.chart_title || "",
        text_template: style?.text_template || undefined,
        chart_kind: chartKind,
        // expand_weekly_shifts можно прокинуть, но бэк weekly всё равно решает сам
        expand_weekly_shifts: !!style?.expand_weekly_shifts,
      };

      // ⛔️ Никаких proc/params здесь НЕ шлём.
      // Бэк сам выберет хранимку:
      //  - weekly → sp_Telegram_WeeklyShiftCumulative(+@week_monday, +@tag_ids)
      //  - иначе → meta.proc из шаблона

      const res = await api.post("/telegram/send", body);
      if ((res as any)?.ok) {
        message.success("Отправлено (см. Телеграм)");
      } else {
        message.error(`Не отправлено: ${res?.detail || "ошибка"}`);
      }
    } catch (e: any) {
      message.error(`Ошибка отправки: ${e?.response?.data?.detail || e?.message || e}`);
    }
  },
  [api, tasks]
);




// PATCH: диалог «Настройки» — сохраняем в schedule.style_override и/или в ReportStyles (как у тебя ниже)
// src/pages/SchedulePage.tsx
const handleStyleSave = useCallback(
  async (style: any) => {
    if (!styleRecord) return;
    try {
      // апсерт единственного стиля для шаблона
      const up = await api.put(`/telegram/templates/${styleRecord.template_id}/style`, {
        name: `Template ${styleRecord.template_id} style`,
        style,
      });
      const styleId = up?.id ?? null;

      const payload: any = {
        template_id: styleRecord.template_id,
        period_type: styleRecord.period_type,
        time_of_day: styleRecord.time_of_day,
        target_type: styleRecord.target_type,
        target_value: styleRecord.target_value,
        aggregation_type: styleRecord.aggregation_type,
        send_format: styleRecord.send_format,
        window_minutes: styleRecord.trend_window_minutes ?? null,
        avg_seconds: styleRecord.trend_avg_seconds ?? null,
        style_id: styleId,
        style_override: style, // для немедленного превью и backward-compat
      };

      const res = await api.put(API.SCHEDULE_UPDATE(styleRecord.id), payload);
      if ((res as any)?.ok !== true) throw new Error((res as any)?.detail || "PUT failed");

      message.success("Настройки сохранены");
      setStyleOpen(false);
      setStyleRecord(null);
      await loadTasks();
    } catch (e: any) {
      message.error(`Ошибка сохранения настроек: ${e?.message || e}`);
    }
  },
  [api, loadTasks, styleRecord]
);



  // ====== колонки ======
  const avgOptions = [
    { value: 0, label: "0 (сырые)" },
    { value: 5, label: "5" },
    { value: 10, label: "10" },
    { value: 30, label: "30" },
    { value: 60, label: "60" },
  ];
  const windowOptions = [
    { value: 5, label: "5" },
    { value: 10, label: "10" },
    { value: 30, label: "30" },
  ];

  const columns: ColumnsType<Task> = useMemo(
    () => [
      { title: "ID", dataIndex: "id", width: 60 },
      {
        title: "Шаблон",
        dataIndex: "template_id",
        render: (id: number) => templatesMap[id] || `#${id}`,
      },
      {
        title: "Время",
        dataIndex: "time_of_day",
        editable: true as any,
        inputType: "time" as const,
      onCell: (record: Task) => ({
        disabled:
          isMinutePeriod(record.period_type) ||
          record.period_type === "hourly" ||
          record.period_type === "weekly", // ← добавили
      }),
      render: (t: string, r: Task) =>
        isMinutePeriod(r.period_type) || r.period_type === "hourly" || r.period_type === "weekly"
          ? <span className={styles.gray}>—</span>
          : (t || <span className={styles.gray}>—</span>),
          
      },
      {
        title: "Период",
        dataIndex: "period_type",
        render: (t: string) => PERIOD_LABELS[t] || t,
      },
      {
        title: "Окно (мин)",
        dataIndex: "trend_window_minutes",
        editable: true as any,
        inputType: "select" as const,
        options: windowOptions,
        render: (_: any, r: Task) =>
          isMinutePeriod(r.period_type) ? (
            r.trend_window_minutes || windowByPeriod(r.period_type) || 5
          ) : (
            <span className={styles.gray}>—</span>
          ),
        onCell: (record: Task) => ({
          disabled: !isMinutePeriod(record.period_type),
        }),
      } as any,
      {
        title: "Усреднение (с)",
        dataIndex: "trend_avg_seconds",
        editable: true as any,
        inputType: "select" as const,
        options: avgOptions,
        render: (_: any, r: Task) =>
          isMinutePeriod(r.period_type) ? (
            r.trend_avg_seconds ?? 10
          ) : (
            <span className={styles.gray}>—</span>
          ),
        onCell: (record: Task) => ({
          disabled: !isMinutePeriod(record.period_type),
        }),
      } as any,
      {
        title: "Канал",
        dataIndex: "target_value",
        editable: true as any,
        inputType: "select" as const,
        options: channels.map((c) => ({
          value: String(c.Id),
          label: `${c.ChannelName} (${c.ChannelId})`,
        })),
        render: (id: string) => {
          const ch = channelById[String(id)];
          return ch ? (
            <span title={String(ch.ChannelId)}>{ch.ChannelName}</span>
          ) : (
            <span className={styles.gray}>—</span>
          );
        },
      },
      {
        title: "Формат",
        dataIndex: "send_format",
        editable: true as any,
        inputType: "select" as const,
        options: [
          { value: "chart", label: "График" },
          { value: "table", label: "Таблица" },
          { value: "file", label: "Файл" },
          { value: "text", label: "Текст" },
        ],
        render: (t: string) =>
          t ? FORMAT_LABELS[t] || t : <span className={styles.gray}>—</span>,
      },
      {
        title: "Агрегация",
        dataIndex: "aggregation_type",
        editable: true as any,
        inputType: "multiselect" as const,
        options: [
          { value: "avg", label: "Среднее" },
          { value: "min", label: "Минимум" },
          { value: "max", label: "Максимум" },
          { value: "current", label: "Текущее" },
        ],
        render: (t: string) =>
          t ? (
            t
              .split(",")
              .map((k) => <Tag key={k}>{AGGREGATION_LABELS[k] || k}</Tag>)
          ) : (
            <span className={styles.gray}>—</span>
          ),
      },
      {
        title: "След. запуск",
        dataIndex: "next_run_at",
        render: (t: string | null) =>
          t || <span className={styles.gray}>—</span>,
      },
      {
        title: "Статус",
        align: "center",
        render: (_: any, r: Task) =>
          r.is_active ? (
            <Tag color="green">Активно</Tag>
          ) : (
            <Tag color="red">Отключено</Tag>
          ),
      },
      {
        title: "Операции",
        align: "center",
        width: 260,
        render: (_: any, r: Task) => (
          <Space>
            <Button
              size="small"
              icon={<Eye size={16} />}
              onClick={() => handlePreview(r)}
              title="Предпросмотр"
              style={{ color: "#3e75d6" }}
            />
            <Button
              size="small"
              icon={<RefreshCw size={16} />}
              onClick={() => handleRunNow(r.id)}
              title="Сгенерировать сейчас"
            />
             <Button
        size="small"
        onClick={() => { setStyleRecord(r); setStyleOpen(true); }}
        title="Настройки отправки"
      >
        Настройки
      </Button>
            {r.is_active ? (
              <Button
                size="small"
                icon={<Power size={16} />}
                onClick={() => handleToggle(r.id, false)}
                title="Выключить"
              />
            ) : (
              <Button
                size="small"
                icon={<Power size={16} color="#229ED9" />}
                onClick={() => handleToggle(r.id, true)}
                title="Включить"
              />
            )}
            <Popconfirm
              title="Удалить задание?"
              onConfirm={() => handleDelete(r.id)}
            >
              <Button size="small" icon={<Trash2 size={16} />} danger />
            </Popconfirm>
            <Button size="small" icon={<Copy size={16} />} disabled />
          </Space>
        ),
      },
    ],
    [channels, channelById, handlePreview, handleRunNow, handleToggle, handleDelete, templatesMap]
  );

  const mergedColumns = useMemo(
    () =>
      (columns as any).map((col: any) =>
        !col.editable
          ? col
          : {
              ...col,
              onCell: (record: Task) => ({
                record,
                editable: col.editable,
                dataIndex: col.dataIndex,
                title: col.title,
                inputType: col.inputType,
                options: col.options,
                disabled: col.onCell ? col.onCell(record).disabled : false,
                handleSave,
              }),
            }
      ),
    [columns, handleSave]
  );

  return (
    <div className={styles.page}>
      <BackButton />
      <div className={styles.header}>
        <Send size={30} className={styles.headerIcon} />
        <span>Задания на отправку в Telegram</span>
      </div>

      <div className={styles.toolbar}>
        <Button
          type="primary"
          icon={<Plus size={18} />}
          className={styles.button}
          onClick={openModal}
        >
          Добавить задание
        </Button>
        <Button
          icon={<RefreshCw size={18} />}
          className={styles.button}
          onClick={loadTasks}
          disabled={loading}
        >
          Обновить
        </Button>
      </div>

      <div className={styles.tableViewport}>
        <Table<Task>
          rowKey="id"
          loading={loading}
          dataSource={tasks}
          locale={{ emptyText: "Нет заданий" }}
          size="middle"
          bordered
          pagination={false}
          columns={mergedColumns as ColumnsType<Task>}
          components={{ body: { row: EditableRow, cell: EditableCell } }}
          className={styles.table}
        />
      </div>

      {/* Модалка предпросмотра */}
      <Modal
  open={previewOpen}
  title={previewTitle}   // ← было "Предпросмотр отчёта"
  onCancel={() => setPreviewOpen(false)}
  footer={null}
  width={720}
  className={styles.previewModal}
  destroyOnClose
>
  {previewPayload && (
    <div className={styles.previewBody}>
      <ReportPreview payload={previewPayload} />
    </div>
  )}
</Modal>

      {/* Модалка добавления */}
      <Modal
        title="Добавить задание"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={loading}
        destroyOnClose
        className={styles.formModal}
        width={720}
        okButtonProps={{ disabled: !channels.length }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleAddTask}
          initialValues={{
            period_type: "every_5m",
            send_format: "chart",
            target_type: "telegram",
            trend_avg_seconds: 10,
          }}
          className={styles.form}
        >
          <Form.Item
            name="template_id"
            label="Шаблон"
            rules={[{ required: true, message: "Выберите шаблон" }]}
          >
            <Select
              placeholder="Выберите шаблон"
              showSearch
              optionFilterProp="label"
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>

          <Form.Item
            name="period_type"
            label="Период"
            rules={[{ required: true, message: "Выберите период" }]}
          >
            <Select
              options={[
                { value: "every_5m", label: "Каждые 5 минут" },
                { value: "every_10m", label: "Каждые 10 минут" },
                { value: "every_30m", label: "Каждые 30 минут" },
                { value: "hourly", label: "Каждый час" },
                { value: "shift", label: "Смена" },
                { value: "daily", label: "Сутки" },
                { value: "weekly", label: "Неделя" },
                { value: "monthly", label: "Месяц" },
                { value: "once", label: "Однократно" },
              ]}
              onChange={() => {
                const p = form.getFieldValue("period_type");
                const win = windowByPeriod(p);
                form.setFieldsValue({ trend_window_minutes: win || undefined });
              }}
            />
          </Form.Item>

          {/* Время только для shift/daily/once */}
          <Form.Item shouldUpdate noStyle>
            {() => {
              const p = form.getFieldValue("period_type");
              const needTime = p === "shift" || p === "daily" || p === "once";
              return needTime ? (
                <Form.Item
                  name="time_of_day"
                  label="Время"
                  rules={[
                    {
                      validator(_, value) {
                        return isValidTimeStr(value)
                          ? Promise.resolve()
                          : Promise.reject(new Error("Формат HH:mm:ss"));
                      },
                    },
                  ]}
                >
                  <Input placeholder="HH:mm:ss" />
                </Form.Item>
              ) : null;
            }}
          </Form.Item>

          <Form.Item name="target_type" style={{ display: "none" }}>
            <Input />
          </Form.Item>

          <Form.Item
            name="target_value"
            label="Канал Telegram"
            rules={[{ required: true, message: "Выберите канал" }]}
          >
            <Select
              placeholder="Выберите канал"
              showSearch
              optionFilterProp="label"
              options={channelOptions}
              notFoundContent="Каналы не найдены"
            />
          </Form.Item>

          <Form.Item
            name="send_format"
            label="Формат"
            rules={[{ required: true, message: "Выберите формат" }]}
          >
            <Select
              value={sendFormat}
              onChange={(val) => {
                setSendFormat(val);
                if (val === "chart" && aggregationType.length > 1) {
                  const first = aggregationType[0] ? [aggregationType[0]] : [];
                  setAggregationType(first);
                  form.setFieldsValue({ aggregation_type: first });
                }
              }}
              options={[
                { value: "chart", label: "График" },
                { value: "table", label: "Таблица" },
                { value: "file", label: "Файл" },
                { value: "text", label: "Текст" },
              ]}
            />
          </Form.Item>

          <Form.Item name="aggregation_type" label="Агрегация">
            <Select
              {...(sendFormat === "chart"
                ? { allowClear: true, maxTagCount: 1 as const }
                : {
                    allowClear: true,
                    maxTagCount: 4 as const,
                    mode: "multiple" as const,
                  })}
              value={aggregationType}
              onChange={(val) => {
                const arr = Array.isArray(val) ? val : [val];
                setAggregationType(arr);
                form.setFieldsValue({ aggregation_type: arr });
              }}
              placeholder="Выберите агрегацию"
              options={[
                { value: "avg", label: "Среднее" },
                { value: "min", label: "Минимум" },
                { value: "max", label: "Максимум" },
                { value: "current", label: "Текущее" },
              ]}
            />
          </Form.Item>

          {/* Настройки для минутных периодов */}
          <Form.Item shouldUpdate noStyle>
            {() => {
              const p = form.getFieldValue("period_type");
              if (!isMinutePeriod(p)) return null;
              const win = windowByPeriod(p);
              return (
                <>
                  <Form.Item label="Окно тренда (мин)">
                    <Input value={win || ""} disabled />
                  </Form.Item>
                  <Form.Item
                    name="trend_avg_seconds"
                    label="Интервал усреднения (сек)"
                    tooltip="0 = сырые значения; 5/10/30/60 — агрегирование на бэке"
                    rules={[{ required: true, message: "Укажите усреднение" }]}
                    initialValue={10}
                  >
                    <Select options={avgOptions} />
                  </Form.Item>
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>
      <ScheduleStyleModal
  open={styleOpen}
  onClose={() => { setStyleOpen(false); setStyleRecord(null); }}
  initial={parseStyleOverride((styleRecord as any)?.style_override)}
  onSave={handleStyleSave}
/>
    </div>
  );
};

export default SchedulePage;
