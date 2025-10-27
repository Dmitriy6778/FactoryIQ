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
  Palette,
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
import StyleModal from "../components/StyleModal";
import { useApi } from "../shared/useApi";
const DEBUG = false;

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
/* ------------------------------------------- */

// ====== словари отображения ======
const PERIOD_LABELS: Record<string, string> = {
  shift: "Смена",
  daily: "Сутки",
  weekly: "Неделя",
  monthly: "Месяц",
  once: "Однократно",
  hourly: "Каждый час",
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
type Task = {
  id: number;
  template_id: number;
  template_name: string;
  period_type: string;
  time_of_day: string | null;
  next_run: string | null;
  last_run: string | null;
  active: boolean;
  target_type: string;
  target_value: string; // хранит Id записи из TelegramReportTarget
  aggregation_type: string | null;
  send_format: string | null;
};

type Template = { id: number; name: string };

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
  options?: { value: string; label: string }[];
};

const EditableCell: React.FC<EditableCellProps> = ({
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  inputType,
  options = [],
  ...restProps
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<any>(null);
  const form = React.useContext(EditableContext)!;

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current?.focus?.();
  }, [editing]);

  const toggleEdit = () => {
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
          style={{ minWidth: 180 }}
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
        <div style={{ minHeight: 24, cursor: "pointer" }} onClick={toggleEdit}>
          {children}
          <Edit2 size={12} style={{ marginLeft: 6, color: "#3e75d6" }} />
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
  const [channels, setChannels] = useState<TgChannel[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewProps, setPreviewProps] = useState<any>(null);

  const [sendFormat, setSendFormat] = useState<string>("chart");
  const [aggregationType, setAggregationType] = useState<string[]>([]);

  const [styleModalOpen, setStyleModalOpen] = useState(false);
  const [styleTemplateId, setStyleTemplateId] = useState<number | null>(null);
  const [stylePreview, setStylePreview] = useState<any>(null);

  // ====== загрузка заданий ======
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ tasks: Task[] }>("/telegram/tasks");
      if (DEBUG) console.log("Загруженные задания (tasks):", data?.tasks);
      setTasks(data?.tasks || []);
    } catch {
      message.error("Ошибка загрузки заданий");
    }
    setLoading(false);
  }, [api]);


  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // ====== шаблоны ======
  const loadTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ templates: Template[] }>("/reports/templates");
      setTemplates(data?.templates || []);
    } catch {
      message.error("Ошибка загрузки шаблонов");
    }
  }, [api]);


  // ====== каналы ======
  const loadChannels = useCallback(async () => {
    try {
      const data = await api.get<TgChannel[]>("/tg/channels");
      setChannels((data || []).filter((c) => c.Active));
    } catch {
      message.error("Ошибка загрузки Telegram-каналов");
    }
  }, [api]);


  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

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

  // ====== обработчики ======
  const openStyleModal = useCallback((r: Task) => {
    if (DEBUG) console.log("openStyleModal", r);
    setStyleTemplateId(r.template_id);
    setStylePreview({
      format: (r.send_format as any) || "chart",
      period_type: r.period_type,
      time_of_day:
        r.period_type === "shift" ? r.time_of_day || "08:00:00" : null,
      aggregation_type: r.aggregation_type || undefined,
    });
    setStyleModalOpen(true);
  }, []);

  const handleSave = useCallback(
    async (row: Task) => {
      setLoading(true);
      try {
        const prepared = {
          id: row.id,
          template_id: row.template_id,
          period_type: row.period_type,
          time_of_day: row.time_of_day ?? null,
          target_type: row.target_type,
          target_value: row.target_value,
          aggregation_type: Array.isArray(row.aggregation_type)
            ? row.aggregation_type.join(",")
            : row.aggregation_type,
          send_format: row.send_format,
        };
        await api.put(`/telegram/tasks/${row.id}`, prepared);
        message.success("Задание обновлено");
        await loadTasks();
      } catch {
        message.error("Ошибка при обновлении задания");
      }
      setLoading(false);
    },
    [api, loadTasks]
  );


  const handlePreview = useCallback((record: Task) => {
    if (DEBUG) console.log("Открытие предпросмотра, задача:", record);
    setPreviewProps({
      templateId: record.template_id,
      format: record.send_format || "chart",
      scheduleType: record.period_type,
      scheduleTime:
        record.period_type === "shift"
          ? record.time_of_day || "08:00:00"
          : null,
      aggregationType: record.aggregation_type,
    });
    setPreviewOpen(true);
  }, []);

  const openModal = useCallback(() => {
    loadTemplates();
    loadChannels();
    setModalOpen(true);
  }, [loadTemplates, loadChannels]);

  const handleActivate = useCallback(
    async (id: number) => {
      setLoading(true);
      try {
        await api.post(`/telegram/tasks/${id}/activate`, {});
        message.success("Задание включено");
        await loadTasks();
      } catch {
        message.error("Ошибка при включении задания");
      }
      setLoading(false);
    },
    [api, loadTasks]
  );


  const handleDelete = useCallback(
    async (id: number) => {
      setLoading(true);
      try {
        await api.del(`/telegram/tasks/${id}`);
        message.success("Задание удалено");
        await loadTasks();
      } catch {
        message.error("Ошибка при удалении");
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
        } = values;

        const aggValue = Array.isArray(aggregation_type)
          ? aggregation_type.join(",")
          : aggregation_type || null;

        if (period_type === "shift") {
          const shiftTimes = ["08:00:00", "20:00:00"];
          const results: any[] = [];
          for (const time of shiftTimes) {
            const res = await api.post("/telegram/tasks", {
              template_id,
              period_type,
              time_of_day: time,
              target_type,
              target_value: String(target_value),
              aggregation_type: aggValue,
              send_format,
            });
            results.push(res);
          }
          if (results.every((r: any) => r?.ok)) {
            message.success("Задания по сменам успешно созданы");
            setModalOpen(false);
            form.resetFields();
            await loadTasks();
          } else if (
            results.some((r: any) => String(r?.detail || "").includes("существует"))
          ) {
            message.warning("Некоторые сменные расписания уже существуют");
          } else {
            message.error("Ошибка при создании одного из сменных расписаний");
          }
        } else {
          let timeStr = "";
          if (period_type === "daily" || period_type === "once") {
            timeStr =
              normalizeTimeStr(typeof time_of_day === "string" ? time_of_day : "") ||
              "08:00:00";
          } else if (period_type === "hourly") {
            timeStr = "00:00:00";
          } else {
            timeStr = normalizeTimeStr(time_of_day) || "08:00:00";
          }

          try {
            const res = await api.post("/telegram/tasks", {
              template_id,
              period_type,
              time_of_day: timeStr,
              target_type,
              target_value: String(target_value),
              aggregation_type: aggValue,
              send_format,
            });
            if (res?.status === 409 || String(res?.detail || "").includes("существует")) {
              message.warning("Такое расписание уже существует");
            } else if (res?.ok === false) {
              message.error("Ошибка при добавлении задания");
            } else {
              message.success("Задание добавлено");
              setModalOpen(false);
              form.resetFields();
              await loadTasks();
            }
          } catch {
            message.error("Ошибка при добавлении задания");
          }
        }
      } catch {
        message.error("Ошибка при добавлении задания");
      }
      setLoading(false);
    },
    [api, form, loadTasks]
  );


  // ====== конфиг мультиселекта ======

  // ====== колонки ======
  const columns: ColumnsType<Task> = useMemo(
    () => [
      { title: "ID", dataIndex: "id", width: 60 },
      { title: "Шаблон", dataIndex: "template_name" },
      {
        title: "Время",
        dataIndex: "time_of_day",
        editable: true as any,
        inputType: "time" as const,
        render: (t: string) => t || <span className={styles.gray}>—</span>,
      },
      {
        title: "Период",
        dataIndex: "period_type",
        render: (t: string) => PERIOD_LABELS[t] || t,
      },
      {
        title: "Канал",
        dataIndex: "target_value",
        editable: true as any,
        inputType: "select" as const,
        options: channelOptions,
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
        dataIndex: "next_run",
        render: (t: string | null) =>
          t || <span className={styles.gray}>—</span>,
      },
      {
        title: "Статус",
        align: "center",
        render: (_: any, r: Task) =>
          r.active ? (
            <Tag color="green">Активно</Tag>
          ) : (
            <Tag color="red">Отключено</Tag>
          ),
      },
      {
        title: "Операции",
        align: "center",
        width: 180,
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
              icon={<Palette size={16} />}
              onClick={() => openStyleModal(r)}
              title="Настроить стиль"
            />
            <Button size="small" icon={<Edit2 size={16} />} />
            {r.active ? (
              <Popconfirm
                title="Удалить задание?"
                onConfirm={() => handleDelete(r.id)}
              >
                <Button size="small" icon={<Trash2 size={16} />} danger />
              </Popconfirm>
            ) : (
              <Button
                size="small"
                icon={<Power size={16} color="#229ED9" />}
                onClick={() => handleActivate(r.id)}
                title="Включить задание"
              />
            )}
            <Button size="small" icon={<Copy size={16} />} />
          </Space>
        ),
      },
    ],
    [
      channelOptions,
      channelById,
      handleActivate,
      handleDelete,
      handlePreview,
      openStyleModal,
    ]
  );

  const mergedColumns = useMemo(
    () =>
      columns.map((col: any) =>
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

      <Modal
        open={previewOpen}
        title="Предпросмотр отчёта"
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={720}
        className={styles.previewModal}
        destroyOnClose
      >
        {previewProps && (
          <div className={styles.previewBody}>
            <ReportPreview
              templateId={previewProps.templateId}
              format={previewProps.format}
              scheduleType={previewProps.scheduleType}
              scheduleTime={previewProps.scheduleTime}
              aggregationType={previewProps.aggregationType}
            />
          </div>
        )}
      </Modal>

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
            period_type: "shift",
            send_format: "chart",
            target_type: "telegram",
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
                { value: "shift", label: "Смена" },
                { value: "daily", label: "Сутки" },
                { value: "weekly", label: "Неделя" },
                { value: "monthly", label: "Месяц" },
                { value: "once", label: "Однократно" },
                { value: "hourly", label: "Каждый час" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="time_of_day"
            label="Время"
            rules={[
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (getFieldValue("period_type") === "shift")
                    return Promise.resolve();
                  return isValidTimeStr(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error("Формат HH:mm:ss"));
                },
              }),
            ]}
          >
            <Input placeholder="HH:mm:ss" />
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
        </Form>
      </Modal>

      <StyleModal
        open={styleModalOpen}
        onClose={() => setStyleModalOpen(false)}
        templateId={styleTemplateId || 0}
        preview={stylePreview || { format: "chart", period_type: "weekly" }}
      />
    </div>
  );
};

export default SchedulePage;
