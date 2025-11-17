import React, { useEffect, useMemo } from "react";
import { Modal, Tabs, Form, Input, Switch, Select, Tag, Space, Tooltip } from "antd";

type StyleOverride = {
  text_template?: string;
  chart_title?: string;
  chart_kind?: "line" | "bar";
  expand_weekly_shifts?: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  initial?: StyleOverride | null;
  onSave: (style: StyleOverride) => void;
  // опционально: колоноки из предпросмотра, чтобы показать доступные токены
  availableColumns?: string[];
};

const { TextArea } = Input;

const DRAG_TYPE = "text-token";

const ScheduleStyleModal: React.FC<Props> = ({ open, onClose, initial, onSave, availableColumns }) => {
  const [form] = Form.useForm<StyleOverride>();


  const tokens = useMemo<string[]>(
    () => (availableColumns && availableColumns.length ? availableColumns : ["TagName","Value","Timestamp","Description"]),
    [availableColumns]
  );

  

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue(initial || {});
  }, [initial, form, open]);

  const handleDropToTextarea = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const tok = e.dataTransfer.getData(DRAG_TYPE);
    if (!tok) return;
    const val: string = form.getFieldValue("text_template") || "";
    // Вставка плейсхолдера в конец (без усложнения caret-инсерта)
    const next = (val ? val : "") + (val && !val.endsWith(" ") ? " " : "") + `{${tok}}`;
    form.setFieldsValue({ text_template: next });
  };

  return (
    <Modal
      open={open}
      title="Настройки отправки"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Сохранить"
      destroyOnClose
      width={760}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => onSave(values)}
        initialValues={initial || {}}
      >
        <Tabs
          items={[
            {
              key: "text",
              label: "Текст",
              children: (
                <>
                  <p style={{ marginTop: 0 }}>
                    Плейсхолдеры — по именам колонок результата (например: {"{TagName} {Value} {Timestamp}"}).
                    Вставьте токены перетаскиванием ниже.
                  </p>

                  {/* Палитра токенов (d'n'd) */}
                  <Space size={[8, 8]} wrap style={{ marginBottom: 8 }}>
                    {tokens.map((t) => (
                      <Tooltip title={`Перетащите в текст → {${t}}`} key={t}>
                        <Tag
                          color="blue"
                          style={{ cursor: "grab", userSelect: "none" }}
                          draggable
             onDragStart={(e) => {
  e.dataTransfer.setData(DRAG_TYPE, t);
}}
onDragEnd={() => {}}
>
                          {t}
                        </Tag>
                      </Tooltip>
                    ))}
                  </Space>

                  <Form.Item name="text_template" label="Шаблон сообщения">
                    <TextArea
                      rows={8}
                      placeholder="Напр.: {Description}: {Value} ед. на {Timestamp}"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleDropToTextarea}
                    />
                  </Form.Item>
                </>
              ),
            },
            {
              key: "chart",
              label: "График",
              children: (
                <>
                  <Form.Item name="chart_title" label="Заголовок графика">
                    <Input placeholder="Оставьте пустым, чтобы не показывать" />
                  </Form.Item>

                  <Form.Item name="chart_kind" label="Тип">
                    <Select
                      options={[
                        { value: "bar", label: "Столбцы" },
                        { value: "line", label: "Линия" },
                      ]}
                      placeholder="По умолчанию"
                      allowClear
                    />
                  </Form.Item>

                  <Form.Item
                    name="expand_weekly_shifts"
                    label="Недельные сменные бары (накопительно)"
                    valuePropName="checked"
                    tooltip="Для period_type=weekly: включать накопительные бары Д/Н. В текущей реализации включать НЕ нужно — используется готовая хранимка."
                  >
                    <Switch />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
};

export default ScheduleStyleModal;
