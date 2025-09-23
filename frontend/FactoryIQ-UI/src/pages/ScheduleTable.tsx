import React, { useEffect, useState } from "react";
import styles from "../styles/SchedulePage.module.css";
import { Send } from "lucide-react";
import { Modal, Form, Input, Select, TimePicker, Table, Button, Popconfirm, Space, Tag, message } from "antd";
import { Edit2, Trash2, Plus, Copy, RefreshCw, Power, Eye } from "lucide-react";
import BackButton from "../components/BackButton";
import ReportPreview from "../components/ReportPreview"; // путь поправь под свой проект
import { Modal as AntdModal } from "antd";
// Словари для отображения на русском
const PERIOD_LABELS: Record<string, string> = {
    shift: "Смена",
    daily: "Сутки",
    weekly: "Неделя",
    monthly: "Месяц",
    custom: "Период",
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
    null: "—"
};

const CHANNEL_LABELS: Record<string, string> = {
    telegram: "Telegram",
    // Можно добавить другие типы при необходимости
};

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
    target_value: string;
    aggregation_type: string | null;
    send_format: string | null;
};

type Template = {
    id: number;
    name: string;
};

const SchedulePage: React.FC = () => {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [form] = Form.useForm();
    const [scheduleType, setScheduleType] = useState<string>("shift");
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewProps, setPreviewProps] = useState<any>(null);

    useEffect(() => {
        loadTasks();
    }, []);

    const loadTasks = async () => {
        setLoading(true);
        try {
            const resp = await fetch("http://localhost:8000/telegram/tasks");
            const data = await resp.json();
            setTasks(data.tasks || []);
        } catch (e) {
            message.error("Ошибка загрузки заданий");
        }
        setLoading(false);
    };

    const handlePreview = (record: Task) => {
        setPreviewProps({
            templateId: record.template_id,
            format: record.send_format || "chart",
            scheduleType: record.period_type,
            scheduleTime: record.time_of_day || "08:00:00"
        });
        setPreviewOpen(true);
    };


    const loadTemplates = async () => {
        try {
            const resp = await fetch("http://localhost:8000/reports/templates");
            const data = await resp.json();
            setTemplates(data.templates || []);
        } catch {
            message.error("Ошибка загрузки шаблонов");
        }
    };

    const openModal = () => {
        loadTemplates();
        setModalOpen(true);
    };

    const handleActivate = async (id: number) => {
        setLoading(true);
        try {
            await fetch(`http://localhost:8000/telegram/tasks/${id}/activate`, { method: "POST" });
            message.success("Задание включено");
            await loadTasks();
        } catch {
            message.error("Ошибка при включении задания");
        }
        setLoading(false);
    };

    const handleDelete = async (id: number) => {
        setLoading(true);
        try {
            await fetch(`http://localhost:8000/telegram/tasks/${id}`, { method: "DELETE" });
            message.success("Задание удалено");
            await loadTasks();
        } catch {
            message.error("Ошибка при удалении");
        }
        setLoading(false);
    };

    const handleAddTask = async (values: any) => {
        setLoading(true);
        try {
            const {
                template_id,
                period_type,
                time_of_day,
                target_type,
                target_value,
                send_format,
                aggregation_type
            } = values;

            if (period_type === "shift") {
                const shiftTimes = ["08:00:00", "20:00:00"];
                let results = [];
                for (const time of shiftTimes) {
                    const resp = await fetch("http://localhost:8000/telegram/schedule", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            template_id,
                            period_type,
                            time_of_day: time,
                            target_type,
                            target_value: String(target_value),
                            aggregation_type: aggregation_type || null,
                            send_format,
                        }),
                    });
                    const result = await resp.json();
                    results.push(result);
                }
                if (results.every(res => res.ok)) {
                    message.success("Задания по сменам успешно созданы");
                    setModalOpen(false);
                    form.resetFields();
                    await loadTasks();
                } else if (results.some(res => res.detail?.includes("существует"))) {
                    message.warning("Некоторые сменные расписания уже существуют.");
                } else {
                    message.error("Ошибка при создании одного из сменных расписаний.");
                }
            } else {
                let timeOfDay = "";
                if (period_type === "daily") {
                    timeOfDay = typeof time_of_day === "string"
                        ? (time_of_day.length === 5 ? (time_of_day + ":00") : time_of_day)
                        : time_of_day.format("HH:mm:ss");
                } else if (period_type === "hourly") {
                    timeOfDay = "00:00:00";
                } else if (period_type === "once") {
                    timeOfDay = new Date().toISOString().slice(11, 19);
                } else {
                    timeOfDay = time_of_day.format("HH:mm:ss");
                }

                const resp = await fetch("http://localhost:8000/telegram/schedule", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        template_id,
                        period_type,
                        time_of_day: timeOfDay,
                        target_type,
                        target_value: String(target_value),
                        aggregation_type: aggregation_type || null,
                        send_format,
                    }),
                });
                if (resp.status === 409) {
                    message.warning("Такое расписание уже существует.");
                } else if (!resp.ok) {
                    message.error("Ошибка при добавлении задания");
                } else {
                    message.success("Задание добавлено");
                    setModalOpen(false);
                    form.resetFields();
                    await loadTasks();
                }
            }
        } catch (e) {
            message.error("Ошибка при добавлении задания");
        }
        setLoading(false);
    };


    return (
        <div className={styles.page}>
            <BackButton />
            <div className={styles.header}>
                <Send size={30} style={{ color: "#229ED9", marginRight: 10 }} />
                <span>Задания на отправку в Telegram</span>
            </div>
            <div className={styles.toolbar}>
                <Button
                    type="primary"
                    icon={<Plus size={18} />}
                    style={{ marginRight: 12 }}
                    onClick={openModal}
                >
                    Добавить задание
                </Button>
                <Button icon={<RefreshCw size={18} />} onClick={loadTasks} disabled={loading}>
                    Обновить
                </Button>
            </div>
            <div className={styles.tableBlock}>
                <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={tasks}
                    locale={{ emptyText: "Нет заданий" }}
                    size="middle"
                    bordered
                    pagination={false}
                    columns={[
                        { title: "ID", dataIndex: "id", width: 60, align: "center" },
                        { title: "Шаблон", dataIndex: "template_name" },
                        { title: "Время", dataIndex: "time_of_day" },
                        {
                            title: "Период",
                            dataIndex: "period_type",
                            render: (t) => PERIOD_LABELS[t] || t
                        },
                        {
                            title: "Канал",
                            render: (_: any, r: Task) => `${CHANNEL_LABELS[r.target_type] || r.target_type}: ${r.target_value}`
                        },
                        {
                            title: "Формат",
                            dataIndex: "send_format",
                            render: (t: string) => (t ? FORMAT_LABELS[t] : <span className={styles.gray}>—</span>)
                        },
                        {
                            title: "Агрегация",
                            dataIndex: "aggregation_type",
                            render: (t: string) =>
                                t
                                    ? AGGREGATION_LABELS[t.toLowerCase?.() || t] || t
                                    : <span className={styles.gray}>—</span>
                        },
                        {
                            title: "След. запуск",
                            dataIndex: "next_run",
                            render: (t: string | null) => t || <span className={styles.gray}>—</span>
                        },
                        {
                            title: "Статус",
                            render: (_: any, r: Task) =>
                                r.active ? (
                                    <Tag color="green">Активно</Tag>
                                ) : (
                                    <Tag color="red">Отключено</Tag>
                                ),
                            align: "center"
                        },
                        {
                            title: "Операции",
                            align: "center",
                            width: 148,
                            render: (_: any, r: Task) => (
                                <Space>
                                    <Button
                                        size="small"
                                        icon={<Eye size={16} />}
                                        onClick={() => handlePreview(r)}
                                        title="Предпросмотр"
                                        style={{ color: "#3e75d6" }}
                                    />
                                    <Button size="small" icon={<Edit2 size={16} />} />
                                    {r.active ? (
                                        <Popconfirm title="Удалить задание?" onConfirm={() => handleDelete(r.id)}>
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
                        }
                    ]}
                />

                <AntdModal
                    open={previewOpen}
                    title="Предпросмотр отчёта"
                    onCancel={() => setPreviewOpen(false)}
                    footer={null}
                    width={780}
                    destroyOnClose
                >
                    {previewProps && (
                        <ReportPreview
                            templateId={previewProps.templateId}
                            format={previewProps.format}
                            scheduleType={previewProps.scheduleType}
                            scheduleTime={previewProps.scheduleTime}
                        />
                    )}
                </AntdModal>
            </div>

            {/* === МОДАЛКА ДОБАВЛЕНИЯ === */}
            <Modal
                title="Добавить задание"
                open={modalOpen}
                onCancel={() => setModalOpen(false)}
                onOk={() => form.submit()}
                okText="Сохранить"
                cancelText="Отмена"
                confirmLoading={loading}
                destroyOnClose
            >
                <Form
                    form={form}
                    layout="vertical"
                    onFinish={handleAddTask}
                    initialValues={{
                        period_type: "shift",
                        send_format: "chart",
                        target_type: "telegram"
                    }}
                >
                    <Form.Item
                        name="template_id"
                        label="Шаблон"
                        rules={[{ required: true, message: "Выберите шаблон" }]}
                    >
                        <Select
                            placeholder="Выберите шаблон"
                            showSearch
                            optionFilterProp="children"
                            filterOption={(input, option) => {
                                const label = typeof option?.children === "string"
                                    ? option.children
                                    : Array.isArray(option?.children)
                                        ? option.children.join(" ")
                                        : "";
                                return label.toLowerCase().includes(input.toLowerCase());
                            }}
                        >
                            {templates.map(t => (
                                <Select.Option key={t.id} value={t.id}>
                                    {t.name}
                                </Select.Option>
                            ))}
                        </Select>
                    </Form.Item>
                    <Form.Item
                        name="period_type"
                        label="Период"
                        rules={[{ required: true, message: "Выберите период" }]}
                    >
                        <Select onChange={setScheduleType}>
                            <Select.Option value="shift">Смена</Select.Option>
                            <Select.Option value="daily">Сутки</Select.Option>
                            <Select.Option value="weekly">Неделя</Select.Option>
                            <Select.Option value="monthly">Месяц</Select.Option>
                            <Select.Option value="custom">Период</Select.Option>
                        </Select>
                    </Form.Item>
                    <Form.Item
                        name="time_of_day"
                        label="Время"
                        rules={[
                            ({ getFieldValue }) => ({
                                validator(_, value) {
                                    if (getFieldValue("period_type") === "shift") {
                                        return Promise.resolve();
                                    }
                                    if (!value) return Promise.reject(new Error("Укажите время"));
                                    return Promise.resolve();
                                }
                            })
                        ]}
                    >
                        <TimePicker format="HH:mm:ss" />
                    </Form.Item>
                    <Form.Item
                        name="target_type"
                        label="Канал"
                        rules={[{ required: true, message: "Выберите канал" }]}
                    >
                        <Select>
                            <Select.Option value="telegram">Telegram</Select.Option>
                        </Select>
                    </Form.Item>
                    <Form.Item
                        name="target_value"
                        label="Значение канала"
                        rules={[{ required: true, message: "Введите ID или имя канала" }]}
                    >
                        <Input placeholder="ID или имя канала" />
                    </Form.Item>
                    <Form.Item
                        name="send_format"
                        label="Формат"
                        rules={[{ required: true, message: "Выберите формат" }]}
                    >
                        <Select>
                            <Select.Option value="chart">График</Select.Option>
                            <Select.Option value="table">Таблица</Select.Option>
                            <Select.Option value="file">Файл</Select.Option>
                            <Select.Option value="text">Текст</Select.Option>
                        </Select>
                    </Form.Item>
                    <Form.Item name="aggregation_type" label="Агрегация">
                        <Select allowClear placeholder="Не выбрано">
                            <Select.Option value="avg">Среднее</Select.Option>
                            <Select.Option value="min">Минимум</Select.Option>
                            <Select.Option value="max">Максимум</Select.Option>
                            <Select.Option value="sum">Сумма</Select.Option>
                            <Select.Option value="current">Текущее</Select.Option>
                            <Select.Option value="delta">Прирост</Select.Option>
                            <Select.Option value="alerts">Аварии</Select.Option>
                        </Select>
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};

export default SchedulePage;
