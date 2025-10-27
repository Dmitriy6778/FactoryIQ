// src/components/StyleModal.tsx
import React from "react";
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Slider,
  Tabs,
  Button,
  Space,
  Divider,
  ColorPicker,
  message,
} from "antd";
import ReportPreview from "./ReportPreview";
import styles from "./StyleModal.module.css";
import { useApi } from "../shared/useApi";
/** ================================
 *  Props
 *  ================================ */
type Props = {
  open: boolean;
  onClose: () => void;
  templateId: number;
  preview: {
    format: "chart" | "table" | "file" | "text";
    period_type: string;
    time_of_day?: string | null;
    aggregation_type?: string | string[] | null;
  };
  zIndex?: number;
};

/** ================================
 *  Константы: шрифты / веса / стили
 *  ================================ */
const FONT_FAMILIES = [
  { label: "Roboto", value: "Roboto" },
  { label: "Roboto Condensed", value: "Roboto Condensed" },
  { label: "Roboto Mono", value: "Roboto Mono" },
  { label: "Montserrat", value: "Montserrat" },
  { label: "Open Sans", value: "Open Sans" },
  { label: "Poppins", value: "Poppins" },
  { label: "Raleway", value: "Raleway" },
  { label: "Lato", value: "Lato" },
  { label: "Inconsolata", value: "Inconsolata" },
  { label: "Inter", value: "Inter" },
  {
    label: "System / Sans-serif",
    value:
      "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,Ubuntu,sans-serif",
  },
];

const WEIGHTS = [
  { label: "100 Thin", value: 100 },
  { label: "200 ExtraLight", value: 200 },
  { label: "300 Light", value: 300 },
  { label: "400 Regular", value: 400 },
  { label: "500 Medium", value: 500 },
  { label: "600 SemiBold", value: 600 },
  { label: "700 Bold", value: 700 },
  { label: "800 ExtraBold", value: 800 },
  { label: "900 Black", value: 900 },
];

const STYLES = [
  { label: "Обычный", value: "normal" },
  { label: "Курсив", value: "italic" },
  { label: "Наклонный", value: "oblique" },
];

/** ================================
 *  Дефолты стилей (chart/table/excel)
 *  ================================ */
const DEFAULT_CHART = {
  /** тип визуализации */
  type: "bar" as "bar" | "line",

  dpi: 140,
  size: { w: 1280, h: 600 },

  fontFamily: "",
  fontWeight: 400 as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
  fontStyle: "normal" as "normal" | "italic" | "oblique",

  layout: {
    title: { show: true, align: "center" as const, fontSize: 18, upper: true },
    legend: { show: true, position: "bottom" as const },
  },
  axes: {
    x: { rotation: 30, tickFont: 10, wrap: 13, grid: false },
    y: { tickFont: 10, grid: true, label: "Всего, тонн" },
  },

  /** настройки столбцов (видны только при type='bar') */
  bars: {
    width: 0.9,
    gap: 0.1,
    rounded: true,
    showValueInside: true,
    valuePrecision: 1,
  },

  /** настройки линии (видны только при type='line') */
  line: {
    width: 2,
    smooth: false,
    showPoints: true,
    pointRadius: 3,
    valuePrecision: 1,
  },

  palette: {
    type: "single-or-multi" as const,
    singleColor: "#2176C1",
    multi: [
      "#2176C1",
      "#FFB100",
      "#FF6363",
      "#7FDBB6",
      "#6E44FF",
      "#F25F5C",
      "#007F5C",
      "#F49D37",
      "#A259F7",
      "#3A86FF",
      "#FF5C8A",
      "#FFC43D",
    ],
  },
  background: { color: "#FFFFFF" },
  watermark: { text: "", opacity: 0, position: "br" as const },
};

const DEFAULT_TABLE = {
  density: "compact" as const,
  fontSize: 13,
  fontFamily:
    "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,Ubuntu,sans-serif",
  fontWeight: 400 as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
  fontStyle: "normal" as "normal" | "italic" | "oblique",
  header: {
    bg: "#F7F9FC",
    color: "#0F172A",
    bold: true,
    align: "center" as const,
    italic: false,
  },
  body: {
    zebra: true,
    zebraColor: "#FAFBFC",
    borderColor: "#EEF1F6",
    numberPrecision: 1,
    thousandSep: " ",
    decimalSep: ",",
    alignNumbersRight: true,
    color: "#0F172A",
    align: "left" as const,
    italic: false,
  },
  columns: { autoWidth: true, maxWidthPx: 980, firstColWidthPct: 68 },
  totals: { show: false, label: "Итого" },
};

const DEFAULT_EXCEL = {
  sheetName: "Отчет",
  freezeHeader: true,
  autoWidth: true,
  numberFormat: "# ##0.0",
  dateFormat: "yyyy-mm-dd hh:mm",
};

/** ================================
 *  Утилиты
 *  ================================ */
const toColorString = (v: any, def?: string): string | undefined => {
  if (!v && def) return def;
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v?.toHexString === "function") {
    try {
      return v.toHexString();
    } catch {
      /* noop */
    }
  }
  if (v && typeof v === "object") {
    if (typeof v.value === "string") return v.value;
    if (typeof v.hex === "string") return v.hex;
    if (typeof v.color === "string") return v.color;
  }
  return def ?? undefined;
};

const deepMerge = (dst: any, src: any) => {
  if (!src) return dst;
  Object.keys(src).forEach((k) => {
    const sv = (src as any)[k];
    const dv = (dst as any)[k];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      dv &&
      typeof dv === "object" &&
      !Array.isArray(dv)
    ) {
      deepMerge(dv, sv);
    } else {
      (dst as any)[k] = sv;
    }
  });
  return dst;
};

const clone = <T,>(obj: T): T => {
  if (typeof (globalThis as any).structuredClone === "function") {
    return (globalThis as any).structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
};

/** Санитайзеры */
const sanitizeChart = (input: any) => {
  const c = deepMerge(clone(DEFAULT_CHART), input || {});
  c.type =
    c.type === "line" || c.type === "bar" ? (c.type as "line" | "bar") : "bar";

  // страховки по блокам
  if (!c.bars) c.bars = clone(DEFAULT_CHART.bars);
  if (!c.line) c.line = clone(DEFAULT_CHART.line);

  c.palette.singleColor = toColorString(c.palette.singleColor, "#2176C1");
  c.background.color = toColorString(c.background.color, "#FFFFFF");

  if (!Array.isArray(c.palette.multi)) c.palette.multi = [];
  c.palette.multi = c.palette.multi
    .map((x: any) => toColorString(x))
    .filter(Boolean);

  c.dpi = Number(c.dpi ?? 140);
  c.size = { w: Number(c.size?.w ?? 1280), h: Number(c.size?.h ?? 600) };
  return c;
};

const sanitizeTable = (input: any) => {
  const t = deepMerge(clone(DEFAULT_TABLE), input || {});
  t.header.bg = toColorString(t.header.bg, "#F7F9FC");
  t.header.color = toColorString(t.header.color, "#0F172A");
  t.body.zebraColor = toColorString(t.body.zebraColor, "#FAFBFC");
  t.body.borderColor = toColorString(t.body.borderColor, "#EEF1F6");
  t.body.color = toColorString(t.body.color, "#0F172A");
  return t;
};

const sanitizeExcel = (input: any) =>
  deepMerge(clone(DEFAULT_EXCEL), input || {});

/** Ответ /styles/:id может быть в разных форматах */
function normalizeStyleResponse(sjson: any) {
  const src = sjson?.style ?? sjson ?? {};
  const styleName = src?.Name || src?.name || sjson?.Name || sjson?.name || "";

  const read = (obj: any, lowKey: string, capKey: string) => {
    const v = obj?.[lowKey] ?? obj?.[capKey];
    if (v == null) return undefined;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    return v;
  };

  const chart = read(src, "chart", "ChartStyle") ?? {};
  const table = read(src, "table", "TableStyle") ?? {};
  const excel = read(src, "excel", "ExcelStyle") ?? {};

  return { chart, table, excel, styleName };
}

/** ================================
 *  Компонент
 *  ================================ */
const StyleModal: React.FC<Props> = ({
  open,
  onClose,
  templateId,
  preview,
  zIndex = 1100,
}) => {
  const [form] = Form.useForm();
  const api = useApi();
  // состояние, которое уходит в предпросмотр и сохранение
  const [styleOverride, setStyleOverride] = React.useState<any>({
    chart: DEFAULT_CHART,
    table: DEFAULT_TABLE,
    excel: DEFAULT_EXCEL,
    text: {
      fontFamily: "",
      fontWeight: 400,
      fontStyle: "normal",
      fontSize: 14,
      color: "#0F172A",
    },
  });

  /** Текущий тип графика для адаптивных секций */
  const chartType = Form.useWatch(["chart", "type"], form) || "bar";

  /** Загрузка стиля из шаблона */
  React.useEffect(() => {
    if (!open || !templateId) return;

    (async () => {
      try {
        const tjson = await api.get<any>(`/reports/templates/${templateId}`);

        let chart = DEFAULT_CHART;
        let table = DEFAULT_TABLE;
        let excel = DEFAULT_EXCEL;
        let styleName = "";

        if (tjson?.template?.style_id) {
          const sid = tjson.template.style_id;

          const sjson = await api.get<any>(`/styles/${sid}`);
          if (sjson?.ok) {
            const norm = normalizeStyleResponse(sjson);
            chart = sanitizeChart(norm.chart);
            table = sanitizeTable(norm.table);
            excel = sanitizeExcel(norm.excel);
            styleName = norm.styleName || "";
          } else {
            chart = sanitizeChart({});
            table = sanitizeTable({});
            excel = sanitizeExcel({});
            styleName = "";
          }
        } else {
          chart = sanitizeChart({});
          table = sanitizeTable({});
          excel = sanitizeExcel({});
          styleName = "";
        }

        form.setFieldsValue({
          chart: {
            ...chart,
            palette: {
              ...chart.palette,
              multi: Array.isArray(chart.palette?.multi) ? [...chart.palette.multi] : [],
            },
          },
          table: { ...table },
          excel: { ...excel },
          text: styleOverride.text,
          __styleName: styleName,
        });

        setStyleOverride({ chart, table, excel, text: styleOverride.text });
      } catch {
        const chart = sanitizeChart({});
        const table = sanitizeTable({});
        const excel = sanitizeExcel({});
        form.setFieldsValue({
          chart: {
            ...chart,
            palette: {
              ...chart.palette,
              multi: Array.isArray(chart.palette?.multi) ? [...chart.palette.multi] : [],
            },
          },
          table: { ...table },
          excel: { ...excel },
          text: styleOverride.text,
          __styleName: "",
        });
        setStyleOverride({ chart, table, excel, text: styleOverride.text });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId]);



  /** Любое изменение формы → чистим цвета и кладём в state */
  const handleValuesChange = (_: any, all: any) => {
    const safe = JSON.parse(JSON.stringify(all || {}));

    const setIfExists = (
      obj: any,
      path: string[],
      transform?: (x: any) => any
    ) => {
      if (!obj) return;
      let parent = obj;
      for (let i = 0; i < path.length - 1; i++) {
        parent = parent?.[path[i]];
        if (!parent) return;
      }
      const k = path[path.length - 1];
      if (parent && Object.prototype.hasOwnProperty.call(parent, k)) {
        parent[k] = transform ? transform(parent[k]) : parent[k];
      }
    };

    const toHex = (v: any) => {
      if (!v) return v;
      if (typeof v === "string") return v;
      try {
        return typeof v.toHexString === "function" ? v.toHexString() : v;
      } catch {
        return v;
      }
    };

    // chart → цвета
    setIfExists(safe, ["chart", "palette", "singleColor"], toHex);
    setIfExists(safe, ["chart", "background", "color"], toHex);
    if (Array.isArray(safe?.chart?.palette?.multi)) {
      safe.chart.palette.multi = safe.chart.palette.multi
        .map((c: any) => toHex(c))
        .filter(Boolean);
    }

    // table → цвета
    setIfExists(safe, ["table", "header", "bg"], toHex);
    setIfExists(safe, ["table", "header", "color"], toHex);
    setIfExists(safe, ["table", "body", "zebraColor"], toHex);
    setIfExists(safe, ["table", "body", "borderColor"], toHex);
    setIfExists(safe, ["table", "body", "color"], toHex);

    // text → цвет
    setIfExists(safe, ["text", "color"], toHex);

    setStyleOverride(safe);
  };

  const agg = Array.isArray(preview.aggregation_type)
    ? preview.aggregation_type.join(",")
    : preview.aggregation_type || "";

  /** Сохранить стиль и привязать к шаблону */
  const handleSaveStyle = async () => {
    try {
      const values = form.getFieldsValue(true);
      const payload = JSON.parse(JSON.stringify(styleOverride));
      const name =
        values?.__styleName?.trim() || `Стиль от ${new Date().toLocaleDateString()}`;

      const ChartStyle = JSON.stringify(payload.chart ?? {});
      const TableStyle = JSON.stringify(payload.table ?? {});
      const ExcelStyle = JSON.stringify(payload.excel ?? {});

      const data = await api.post<any>("/styles", {
        name,
        is_default: false,
        // текущее API
        ChartStyle,
        TableStyle,
        ExcelStyle,
        // и на будущее
        chart: payload.chart,
        table: payload.table,
        excel: payload.excel,
      });

      const styleId = data.id;
      await api.put(`/reports/templates/${templateId}/style`, { style_id: styleId });

      message.success("Стиль сохранён и привязан к шаблону");
      onClose();
    } catch (e: any) {
      message.error(e?.message || "Ошибка сохранения");
    }
  };


  /** Показываем только нужные вкладки по текущему предпросмотру */
  const visibleKeys =
    preview.format === "chart"
      ? ["chart"]
      : preview.format === "table"
        ? ["table"]
        : preview.format === "text"
          ? ["text"]
          : ["chart", "table", "excel"];

  /** Вкладки формы */
  const tabs = [
    {
      key: "chart",
      label: "График",
      children: (
        <>
          <Divider>Тип графика</Divider>
          <Form.Item label="Тип" name={["chart", "type"]}>
            <Select
              options={[
                { value: "bar", label: "Столбцы" },
                { value: "line", label: "Линия" },
              ]}
            />
          </Form.Item>

          <Divider>Шрифт</Divider>
          <Form.Item label="Семейство" name={["chart", "fontFamily"]}>
            <Select
              options={FONT_FAMILIES}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Жирность"
              name={["chart", "fontWeight"]}
              style={{ flex: 1 }}
            >
              <Select options={WEIGHTS} />
            </Form.Item>
            <Form.Item
              label="Начертание"
              name={["chart", "fontStyle"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <Select options={STYLES} />
            </Form.Item>
          </Space.Compact>

          <Divider>DPI и размеры</Divider>
          <Form.Item label="DPI" name={["chart", "dpi"]}>
            <InputNumber min={72} max={300} />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Ширина, px"
              name={["chart", "size", "w"]}
              style={{ flex: 1 }}
            >
              <InputNumber min={640} max={4000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="Высота, px"
              name={["chart", "size", "h"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <InputNumber min={320} max={3000} style={{ width: "100%" }} />
            </Form.Item>
          </Space.Compact>

          <Divider>Заголовок</Divider>
          <Form.Item
            label="Показывать заголовок"
            name={["chart", "layout", "title", "show"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Выравнивание"
              name={["chart", "layout", "title", "align"]}
              style={{ flex: 1 }}
            >
              <Select
                options={[
                  { value: "left", label: "Слева" },
                  { value: "center", label: "По центру" },
                  { value: "right", label: "Справа" },
                ]}
              />
            </Form.Item>
            <Form.Item
              label="Размер шрифта"
              name={["chart", "layout", "title", "fontSize"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <InputNumber min={10} max={28} style={{ width: "100%" }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item
            label="UPPERCASE"
            name={["chart", "layout", "title", "upper"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Divider>Оси</Divider>
          <Form.Item
            label="Подписи X — наклон"
            name={["chart", "axes", "x", "rotation"]}
          >
            <Slider min={0} max={75} />
          </Form.Item>
          <Form.Item
            label="Подписи X — размер шрифта"
            name={["chart", "axes", "x", "tickFont"]}
          >
            <Slider min={8} max={14} />
          </Form.Item>
          <Form.Item
            label="Перенос X (символов в строке)"
            name={["chart", "axes", "x", "wrap"]}
          >
            <InputNumber min={8} max={24} />
          </Form.Item>
          <Form.Item
            label="Сетка по Y"
            name={["chart", "axes", "y", "grid"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item label="Подпись оси Y" name={["chart", "axes", "y", "label"]}>
            <Input />
          </Form.Item>

          {chartType === "bar" && (
            <>
              <Divider>Столбцы</Divider>
              <Form.Item
                label="Ширина столбца"
                name={["chart", "bars", "width"]}
              >
                <Slider min={0.2} max={1.5} step={0.05} />
              </Form.Item>
              <Form.Item
                label="Зазор между столбцами (в долях категории)"
                name={["chart", "bars", "gap"]}
              >
                <Slider min={0} max={0.5} step={0.02} />
              </Form.Item>
              <Form.Item
                label="Скруглять углы"
                name={["chart", "bars", "rounded"]}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Показывать значения внутри"
                name={["chart", "bars", "showValueInside"]}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Точность значения"
                name={["chart", "bars", "valuePrecision"]}
              >
                <InputNumber min={0} max={3} />
              </Form.Item>
            </>
          )}

          {chartType === "line" && (
            <>
              <Divider>Линия</Divider>
              <Form.Item label="Толщина линии (px)" name={["chart", "line", "width"]}>
                <Slider min={1} max={8} />
              </Form.Item>
              <Form.Item
                label="Сглаживание линии"
                name={["chart", "line", "smooth"]}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Показывать точки"
                name={["chart", "line", "showPoints"]}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Радиус точки (px)"
                name={["chart", "line", "pointRadius"]}
              >
                <Slider min={1} max={10} />
              </Form.Item>
              <Form.Item
                label="Точность значения"
                name={["chart", "line", "valuePrecision"]}
              >
                <InputNumber min={0} max={3} />
              </Form.Item>
            </>
          )}

          <Divider>Палитра</Divider>
          <Form.Item label="Режим" name={["chart", "palette", "type"]}>
            <Select
              options={[
                { value: "single", label: "Один цвет" },
                { value: "multi", label: "Много цветов" },
                { value: "single-or-multi", label: "Авто (1 серия — 1 цвет)" },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Один цвет"
            name={["chart", "palette", "singleColor"]}
          >
            <ColorPicker format="hex" allowClear />
          </Form.Item>
          <Form.List name={["chart", "palette", "multi"]}>
            {(fields, { add, remove }) => (
              <>
                <div style={{ marginBottom: 6, fontWeight: 500 }}>
                  Набор цветов (multi)
                </div>
                {fields.map((f) => (
                  <Space key={f.key} align="center" style={{ marginBottom: 8 }}>
                    <Form.Item name={[f.name]} style={{ margin: 0 }}>
                      <ColorPicker format="hex" />
                    </Form.Item>
                    <Button size="small" onClick={() => remove(f.name)}>
                      Удалить
                    </Button>
                  </Space>
                ))}
                <Button size="small" onClick={() => add("#2176C1")}>
                  + добавить цвет
                </Button>
              </>
            )}
          </Form.List>

          <Divider>Фон</Divider>
          <Form.Item label="Цвет фона" name={["chart", "background", "color"]}>
            <ColorPicker format="hex" />
          </Form.Item>

          <Divider>Легенда</Divider>
          <Form.Item
            label="Показывать легенду"
            name={["chart", "layout", "legend", "show"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Позиция легенды"
            name={["chart", "layout", "legend", "position"]}
          >
            <Select
              options={[
                { value: "top", label: "Сверху" },
                { value: "bottom", label: "Снизу" },
                { value: "left", label: "Слева" },
                { value: "right", label: "Справа" },
              ]}
            />
          </Form.Item>
        </>
      ),
    },
    {
      key: "table",
      label: "Таблица",
      children: (
        <>
          <Divider>Шрифт</Divider>
          <Form.Item label="Семейство" name={["table", "fontFamily"]}>
            <Select
              options={FONT_FAMILIES}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Жирность"
              name={["table", "fontWeight"]}
              style={{ flex: 1 }}
            >
              <Select options={WEIGHTS} />
            </Form.Item>
            <Form.Item
              label="Начертание"
              name={["table", "fontStyle"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <Select options={STYLES} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Размер шрифта" name={["table", "fontSize"]}>
            <InputNumber min={10} max={18} />
          </Form.Item>

          <Divider>Общее</Divider>
          <Form.Item label="Плотность" name={["table", "density"]}>
            <Select
              options={[
                { value: "compact", label: "Компактная" },
                { value: "normal", label: "Обычная" },
                { value: "comfortable", label: "Просторная" },
              ]}
            />
          </Form.Item>

          <Divider>Шапка</Divider>
          <Form.Item label="Фон шапки" name={["table", "header", "bg"]}>
            <ColorPicker format="hex" />
          </Form.Item>
          <Form.Item label="Цвет текста шапки" name={["table", "header", "color"]}>
            <ColorPicker format="hex" />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Жирный заголовок"
              name={["table", "header", "bold"]}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="Курсив"
              name={["table", "header", "italic"]}
              valuePropName="checked"
              style={{ marginLeft: 16 }}
            >
              <Switch />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Выравнивание шапки" name={["table", "header", "align"]}>
            <Select
              options={[
                { value: "left", label: "Слева" },
                { value: "center", label: "По центру" },
                { value: "right", label: "Справа" },
              ]}
            />
          </Form.Item>

          <Divider>Тело</Divider>
          <Form.Item label="Цвет текста" name={["table", "body", "color"]}>
            <ColorPicker format="hex" />
          </Form.Item>
          <Form.Item label="Выравнивание текста" name={["table", "body", "align"]}>
            <Select
              options={[
                { value: "left", label: "Слева" },
                { value: "center", label: "По центру" },
                { value: "right", label: "Справа" },
              ]}
            />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Зебра"
              name={["table", "body", "zebra"]}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="Курсив"
              name={["table", "body", "italic"]}
              valuePropName="checked"
              style={{ marginLeft: 16 }}
            >
              <Switch />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Цвет зебры" name={["table", "body", "zebraColor"]}>
            <ColorPicker format="hex" />
          </Form.Item>
          <Form.Item label="Цвет границ" name={["table", "body", "borderColor"]}>
            <ColorPicker format="hex" />
          </Form.Item>

          <Divider>Числа</Divider>
          <Form.Item
            label="Точность чисел"
            name={["table", "body", "numberPrecision"]}
          >
            <InputNumber min={0} max={3} />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Разделитель тысяч"
              name={["table", "body", "thousandSep"]}
              style={{ flex: 1 }}
            >
              <Input maxLength={2} />
            </Form.Item>
            <Form.Item
              label="Десятичный разделитель"
              name={["table", "body", "decimalSep"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <Input maxLength={2} />
            </Form.Item>
          </Space.Compact>
          <Form.Item
            label="Выравнивать числа вправо"
            name={["table", "body", "alignNumbersRight"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Divider>Колонки</Divider>
          <Form.Item
            label="Авто-ширина колонок"
            name={["table", "columns", "autoWidth"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Макс. ширина (px)"
              name={["table", "columns", "maxWidthPx"]}
              style={{ flex: 1 }}
            >
              <InputNumber min={600} max={1600} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="Ширина 1-й колонки (%)"
              name={["table", "columns", "firstColWidthPct"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <InputNumber min={30} max={85} style={{ width: "100%" }} />
            </Form.Item>
          </Space.Compact>

          <Divider>Итоги</Divider>
          <Form.Item
            label="Показывать итоги"
            name={["table", "totals", "show"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item label="Подпись в итогах" name={["table", "totals", "label"]}>
            <Input placeholder="Итого" />
          </Form.Item>
        </>
      ),
    },
    {
      key: "excel",
      label: "Excel",
      children: (
        <>
          <Form.Item label="Имя листа" name={["excel", "sheetName"]}>
            <Input />
          </Form.Item>
          <Form.Item
            label="Фиксировать заголовок"
            name={["excel", "freezeHeader"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Авто-ширина"
            name={["excel", "autoWidth"]}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item label="Формат числа" name={["excel", "numberFormat"]}>
            <Input />
          </Form.Item>
          <Form.Item label="Формат даты" name={["excel", "dateFormat"]}>
            <Input />
          </Form.Item>
        </>
      ),
    },
    {
      key: "text",
      label: "Текст",
      children: (
        <>
          <Form.Item label="Семейство шрифта (текст)" name={["text", "fontFamily"]}>
            <Select
              options={FONT_FAMILIES}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              label="Жирность"
              name={["text", "fontWeight"]}
              style={{ flex: 1 }}
            >
              <Select options={WEIGHTS} />
            </Form.Item>
            <Form.Item
              label="Начертание"
              name={["text", "fontStyle"]}
              style={{ flex: 1, marginLeft: 8 }}
            >
              <Select options={STYLES} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Размер шрифта" name={["text", "fontSize"]}>
            <InputNumber min={10} max={22} />
          </Form.Item>
          <Form.Item label="Цвет текста" name={["text", "color"]}>
            <ColorPicker format="hex" />
          </Form.Item>
        </>
      ),
    },
  ].filter((t) => visibleKeys.includes(t.key));

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Настройка стиля отчёта"
      footer={null}
      zIndex={zIndex}
      width={1300}
      className={styles.modal}
      destroyOnClose
    >
      <div className={styles.layout}>
        {/* Левая колонка: форма */}
        <div className={styles.formCol}>
          <Form
            form={form}
            layout="vertical"
            onValuesChange={handleValuesChange}
          >
            <Form.Item
              label="Название стиля (для сохранения)"
              name="__styleName"
            >
              <Input placeholder="Например: Corporate Light" />
            </Form.Item>

            <Tabs defaultActiveKey={visibleKeys[0] ?? "chart"} items={tabs as any} />

            <div className={styles.formActions}>
              <Button type="primary" onClick={handleSaveStyle}>
                Сохранить стиль
              </Button>
              <Button onClick={onClose}>Закрыть</Button>
            </div>
          </Form>
        </div>

        {/* Правая колонка: предпросмотр */}
        <div className={styles.previewCol}>
          <div className={styles.previewTitle}>
            Вот так будет выглядеть предпросмотр в Telegram:
          </div>
          <ReportPreview
            templateId={templateId}
            format={preview.format}
            scheduleType={preview.period_type}
            scheduleTime={preview.time_of_day ?? null}
            aggregationType={agg}
            // @ts-ignore
            styleOverride={styleOverride}
          />
        </div>
      </div>
    </Modal>
  );
};

export default StyleModal;
