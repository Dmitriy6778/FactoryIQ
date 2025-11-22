import React, { useEffect, useMemo } from "react";
import { Modal, Tabs, Form, Input, Switch, Select, Tag, Space, Tooltip, InputNumber, Divider, Alert } from "antd";

type StyleOverride = {
  // Текст
  text_template?: string;
  description_overrides?: Record<string, string> | string;

  // График
  chart_title?: string;
  chart_kind?: "line" | "bar";
  expand_weekly_shifts?: boolean;

  // WEEKLY: единицы и масштаб
  weekly_y?: "Delta" | "CumValue";   // что выводим по оси Y
  weekly_scale?: number;             // на сколько делим (1000 = кг → т)
  weekly_unit?: string;              // подпись единицы (“т”)
};

type Props = {
  open: boolean;
  onClose: () => void;
  initial?: StyleOverride | null;
  onSave: (style: StyleOverride) => void;
  availableColumns?: string[];
};

const { TextArea } = Input;
const DRAG_TYPE = "text-token";

const ScheduleStyleModal: React.FC<Props> = ({ open, onClose, initial, onSave, availableColumns }) => {
  const [form] = Form.useForm<StyleOverride>();

  // Токены для перетаскивания в шаблон
  const tokens = useMemo<string[]>(
    () => {
      const base = availableColumns && availableColumns.length
        ? Array.from(new Set([...availableColumns, "Description"]))
        : ["Timestamp", "Description", "Value", "TagName", "Period", "CumValue"];
      // Добавим weekly-расширения — можно использовать в шаблоне, если это weekly
      const weeklyExtras = ["Delta", "DeltaScaled", "CumValueScaled", "Unit"];
      return Array.from(new Set([...base, ...weeklyExtras]));
    },
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
    const next = (val ? val : "") + (val && !val.endsWith(" ") ? " " : "") + `{${tok}}`;
    form.setFieldsValue({ text_template: next });
  };

  // При сохранении мягко приводим weekly_scale к числу
  const handleFinish = (values: StyleOverride) => {
    const v: StyleOverride = { ...values };
    if (v.weekly_scale !== undefined && v.weekly_scale !== null) {
      // приведение “1000” -> 1000
      const num = Number(v.weekly_scale);
      if (!Number.isNaN(num) && num > 0) v.weekly_scale = num;
      else delete v.weekly_scale;
    }
    onSave(v);
  };

  return (
    <Modal
      open={open}
      title="Настройки отправки"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Сохранить"
      destroyOnClose
      width={820}
    >
      <Form form={form} layout="vertical" onFinish={handleFinish} initialValues={initial || {}}>
        <Tabs
          items={[
            // ====== ТЕКСТ ======
            {
              key: "text",
              label: "Текст",
              children: (
                <>
                  <p style={{ marginTop: 0 }}>
                    Плейсхолдеры подставляются по именам колонок результата. Перетащите токены ниже в поле шаблона.
                    <br />
                    <small>
                      Для <b>weekly</b>: <code>{`{Timestamp} → {Period}`}</code>,{" "}
                      <code>{`{Value} → {CumValue}`}</code>. Дополнительно доступны{" "}
                      <code>{`{Delta}`}</code>, <code>{`{DeltaScaled}`}</code>,{" "}
                      <code>{`{CumValueScaled}`}</code> и <code>{`{Unit}`}</code>.
                      <br />
                      <code>{`{Description}`}</code> берётся из справочника тегов или из «Переопределений» ниже.
                    </small>
                  </p>

                  <Space size={[8, 8]} wrap style={{ marginBottom: 8 }}>
                    {tokens.map((t) => (
                      <Tooltip title={`Перетащите в текст → {${t}}`} key={t}>
                        <Tag
                          color="blue"
                          style={{ cursor: "grab", userSelect: "none" }}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, t)}
                        >
                          {t}
                        </Tag>
                      </Tooltip>
                    ))}
                  </Space>

                  <Form.Item name="text_template" label="Шаблон сообщения">
                    <TextArea
                      rows={8}
                      placeholder="{Period}  {Description}  {CumValueScaled} {Unit}"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleDropToTextarea}
                    />
                  </Form.Item>

                  <Form.Item
                    name="description_overrides"
                    label="Переопределения описаний (JSON: TagName/TagId → Текст)"
                    tooltip='Например: { "AccWeight": "счётчик входящего подсолнечника" }'
                  >
                    <TextArea rows={4} placeholder='{"AccWeight":"счётчик входящего подсолнечника"}' />
                  </Form.Item>
                </>
              ),
            },

            // ====== ГРАФИК ======
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
                    tooltip="Для weekly используется спец. хранимка; флаг влияет лишь на общий превью-движок."
                  >
                    <Switch />
                  </Form.Item>

                  <Divider />

                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Единицы и масштаб (только для weekly)"
                    description={
                      <>
                        <div>— <b>Что рисуем:</b> сменная дельта по счётчику (<code>Delta</code>) или накопление за неделю (<code>CumValue</code>).</div>
                        <div>— <b>Масштаб:</b> делим Y на фиксированное число, например 1000 (кг → т).</div>
                        <div>— <b>Единица:</b> подпись (например, «т»). Для текста доступен токен <code>{`{Unit}`}</code>, а значения — в <code>{`{DeltaScaled}`}</code>/<code>{`{CumValueScaled}`}</code>.</div>
                      </>
                    }
                  />

                  <Form.Item
                    name="weekly_y"
                    label="Weekly: что выводить по оси Y"
                    tooltip="Delta — сменная дельта; CumValue — накопление с начала недели"
                  >
                    <Select
                      allowClear
                      options={[
                        { value: "Delta", label: "Delta (за смену)" },
                        { value: "CumValue", label: "CumValue (накопительно)" },
                      ]}
                      placeholder="По умолчанию: Delta"
                    />
                  </Form.Item>

                  <Form.Item
                    name="weekly_scale"
                    label="Weekly: делитель (масштаб)"
                    tooltip="Например, 1000 чтобы получить тонны из килограммов"
                  >
                    <InputNumber min={0} step={1} placeholder="1000" style={{ width: 200 }} />
                  </Form.Item>

                  <Form.Item
                    name="weekly_unit"
                    label="Weekly: единица измерения"
                    tooltip="Отображается в тексте и (по желанию) в заголовке"
                  >
                    <Input placeholder="т" style={{ width: 200 }} />
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
