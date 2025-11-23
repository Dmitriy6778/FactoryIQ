import React, { useRef } from "react";
import {
  Line,
  Bar,
  Scatter,
  Pie,
  Doughnut,
  Bubble,
  getElementAtEvent,
} from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  BubbleController,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
} from "chart.js";
import "chartjs-adapter-date-fns";
import { saveAs } from "file-saver";
import * as XLSX from "xlsx";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  BubbleController,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler
);

type ChartType = "line" | "bar" | "scatter" | "pie" | "doughnut" | "bubble";
type PointStyle =
  | "circle"
  | "rect"
  | "triangle"
  | "rectRot"
  | "cross"
  | "star"
  | "line"
  | "dash";

interface ChartsProps {
  data:
    | { x?: any; y?: number; value?: number; label?: string; r?: number }[]
    | { label: string; data: { x?: any; y?: number }[] }[];
  chartType?: ChartType;
  showPoints?: boolean;
  showGrid?: boolean;
  showLegend?: boolean;
  showTooltip?: boolean;
  xTitle?: string;
  yTitle?: string;
  showXTicks?: boolean;
  showYTicks?: boolean;
  lineColor?: string;
  barColor?: string;
  backgroundColor?: string;
  gradient?: boolean;
  lineWidth?: number;
  pointSize?: number;
  pointStyle?: PointStyle;
  lineStyle?: "solid" | "dashed" | "dotted";
  fillArea?: boolean;
  animation?: boolean;
  title?: string;
  height?: number | string;
  width?: number | string;
  onPointClick?: (item: any) => void;
  maxBarThickness?: number;
  barPercentage?: number;
  categoryPercentage?: number;
  seriesColors?: string[];
}

const chartComponents: { [k in ChartType]: any } = {
  line: Line,
  bar: Bar,
  scatter: Scatter,
  pie: Pie,
  doughnut: Doughnut,
  bubble: Bubble,
};

const getLineBorderDash = (style?: string) => {
  switch (style) {
    case "dashed":
      return [12, 6];
    case "dotted":
      return [2, 6];
    default:
      return [];
  }
};

function getGradient(
  ctx: CanvasRenderingContext2D,
  area: any,
  color1: string,
  color2: string
) {
  const gradient = ctx.createLinearGradient(0, area.bottom, 0, area.top);
  gradient.addColorStop(0, color1);
  gradient.addColorStop(1, color2);
  return gradient;
}

const defaultColors = [
  "#00ffc6",
  "#0089fc",
  "#ffae00",
  "#ff6464",
  "#8c54ff",
  "#50fa7b",
  "#ffb86c",
  "#f1fa8c",
  "#ff79c6",
  "#bd93f9",
];

/** Максимальное значение Y среди всех точек (для suggestedMax) */
function computeMaxY(
  data:
    | { x?: any; y?: number; value?: number; label?: string; r?: number }[]
    | { label: string; data: { x?: any; y?: number }[] }[]
): number {
  let max = 0;

  if (!Array.isArray(data) || data.length === 0) return max;

  // случай: [{ label, data: [...] }, ...]
  if ("data" in (data[0] as any)) {
    (data as any[]).forEach((set) => {
      (set.data || []).forEach((p: any) => {
        const v =
          typeof p === "number"
            ? p
            : typeof p.y === "number"
            ? p.y
            : typeof p.value === "number"
            ? p.value
            : null;
        if (v != null && isFinite(v) && v > max) max = v;
      });
    });
  } else {
    // случай: [{ x, y }, ...]
    (data as any[]).forEach((p: any) => {
      const v =
        typeof p === "number"
          ? p
          : typeof p.y === "number"
          ? p.y
          : typeof p.value === "number"
          ? p.value
          : null;
      if (v != null && isFinite(v) && v > max) max = v;
    });
  }

  return max;
}

/** Плагин: подписи значений над барами */
const valueLabelPlugin = {
  id: "valueLabelPlugin",
  afterDatasetsDraw: (chart: any) => {
    const { ctx } = chart;
    ctx.save();

    chart.data.datasets.forEach((dataset: any, datasetIndex: number) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;

      meta.data.forEach((element: any, index: number) => {
        const raw = dataset.data[index];
        const v =
          typeof raw === "number"
            ? raw
            : typeof raw?.y === "number"
            ? raw.y
            : typeof raw?.value === "number"
            ? raw.value
            : null;

        if (v == null || !isFinite(v)) return;

        const label = v.toFixed(1); // либо .toFixed(0) если нужны только целые

        const x = element.x;
        const y = element.y - 4; // чуть выше вершины столбца

        ctx.fillStyle = "#333";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, x, y);
      });
    });

    ctx.restore();
  },
};

const Charts: React.FC<ChartsProps> = ({
  data,
  chartType = "line",
  showPoints = true,
  showGrid = true,
  showLegend = chartType === "pie" || chartType === "doughnut",
  showTooltip = true,
  xTitle = "Время",
  yTitle = "Значение",
  showXTicks = true,
  showYTicks = true,
  lineColor = "#00ffc6",
  barColor = "#0089fc88",
  backgroundColor = "#0089fc22",
  gradient = false,
  lineWidth = 3,
  pointSize = 4,
  pointStyle = "circle",
  lineStyle = "solid",
  fillArea = false,
  animation = true,
  height = 340,
  width = "100%",
  onPointClick,
  maxBarThickness = 60,
  barPercentage = 0.8,
  categoryPercentage = 0.7,
  seriesColors,
}) => {
  const chartRef = useRef<any>(null);

  if (!data || (Array.isArray(data) && data.length === 0)) {
    return (
      <div
        style={{
          minHeight: height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#a9b6c6",
        }}
      >
        Нет данных для отображения
      </div>
    );
  }

  const sampleData =
    Array.isArray(data[0]) ||
    ("data" in (data[0] as any) ? (data[0] as any).data : data);
  const isTime =
    typeof (sampleData as any[])[0]?.x === "string" &&
    /^\d{4}-\d{2}-\d{2}/.test((sampleData as any[])[0]?.x);

  const maxY = computeMaxY(data);

  let datasets: any[] = [];

  if (chartType === "pie" || chartType === "doughnut") {
    datasets = [
      {
        data: Array.isArray(data) ? data.map((d: any) => d.y ?? d.value) : [],
        backgroundColor: Array.isArray(data)
          ? data.map(
              (d: any, i) =>
                d.backgroundColor ||
                (seriesColors?.[i] ?? defaultColors[i % defaultColors.length])
            )
          : [],
        label: "Значение",
      },
    ];
  } else if (chartType === "bubble") {
    datasets =
      Array.isArray(data) && "data" in (data[0] as any)
        ? (data as any[]).map((set: any, i: number) => ({
            label: set.label,
            data: set.data,
            backgroundColor:
              seriesColors?.[i] ??
              defaultColors[i % defaultColors.length] + "88",
            borderColor: "#222",
            borderWidth: 1,
          }))
        : [
            {
              label: "Пузыри",
              data: data as any[],
              backgroundColor: "#50fa7b88",
              borderColor: "#222",
              borderWidth: 1,
            },
          ];
  } else {
    datasets =
      Array.isArray(data) && "data" in (data[0] as any)
        ? (data as any[]).map((set: any, i: number) => ({
            label: set.label,
            data: set.data,
            borderColor:
              seriesColors?.[i] ||
              (gradient && chartType === "line" && chartRef.current?.ctx
                ? getGradient(
                    chartRef.current.ctx,
                    chartRef.current.chartArea,
                    set.borderColor || "#00ffc6",
                    "#0089fc"
                  )
                : set.borderColor || "#00ffc6"),
            borderWidth: lineWidth,
            backgroundColor:
              chartType === "bar"
                ? seriesColors?.[i] || set.backgroundColor || barColor
                : gradient && chartRef.current?.ctx
                ? getGradient(
                    chartRef.current.ctx,
                    chartRef.current.chartArea,
                    seriesColors?.[i] || set.backgroundColor || "#90e0ef",
                    "#1fc8db"
                  )
                : seriesColors?.[i] || set.backgroundColor || backgroundColor,
            showLine: chartType !== "scatter",
            fill: fillArea,
            pointRadius: showPoints ? pointSize : 0,
            pointHoverRadius: showPoints ? pointSize * 1.6 : 0,
            pointStyle: pointStyle,
            borderDash: getLineBorderDash(lineStyle),
            tension: 0.4,
            cubicInterpolationMode: "monotone",
            hoverBackgroundColor: set.backgroundColor || "#00ffc6",
            maxBarThickness: chartType === "bar" ? maxBarThickness : undefined,
            barPercentage: chartType === "bar" ? barPercentage : undefined,
            categoryPercentage:
              chartType === "bar" ? categoryPercentage : undefined,
          }))
        : [
            {
              label: "Значение",
              data: data as any[],
              borderColor: seriesColors?.[0] || lineColor,
              borderWidth: lineWidth,
              backgroundColor:
                chartType === "bar"
                  ? seriesColors?.[0] || barColor
                  : seriesColors?.[0] || backgroundColor,
              showLine: chartType !== "scatter",
              fill: fillArea,
              pointRadius: showPoints ? pointSize : 0,
              pointHoverRadius: showPoints ? pointSize * 1.6 : 0,
              pointStyle: pointStyle,
              borderDash: getLineBorderDash(lineStyle),
              tension: 0.4,
              cubicInterpolationMode: "monotone",
              hoverBackgroundColor: "#00ffc6",
              maxBarThickness:
                chartType === "bar" ? maxBarThickness : undefined,
              barPercentage: chartType === "bar" ? barPercentage : undefined,
              categoryPercentage:
                chartType === "bar" ? categoryPercentage : undefined,
            },
          ];
  }

  const labels =
    chartType === "pie" || chartType === "doughnut"
      ? Array.isArray(data)
        ? data.map((d: any) => d.label ?? String(d.x) ?? "")
        : []
      : undefined;

  const chartJsData = {
    labels,
    datasets,
  };

  const commonOptions: any = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 20, // место над столбцами под подписи
      },
    },
    plugins: {
      legend: {
        display: showLegend,
        position: "bottom",
        align: "center",
        labels: {
          color: "#26384E",
          boxWidth: 12,
          padding: 10,
        },
      },
      tooltip: {
        enabled: showTooltip,
        callbacks: {
          label: function (context: any) {
            const point = context.raw || {};
            const dateObj = new Date(point.x || point.shift_start);
            const dateStr = dateObj.toLocaleDateString();
            const timeStr = dateObj.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            let shiftLabel = "?";
            if (point.shift === 1) shiftLabel = "Дневная (08:00-20:00)";
            else if (point.shift === 2) shiftLabel = "Ночная (20:00-08:00)";
            const value =
              typeof point.y === "number" ? point.y.toFixed(1) : point.y;
            return `Смена: ${shiftLabel}\nДата: ${dateStr} ${timeStr}\nЗначение: ${value}`;
          },
        },
      },
    },
    scales:
      chartType === "pie" || chartType === "doughnut"
        ? {}
        : {
            x: isTime
              ? {
                  type: "time" as const,
                  time: {
                    unit: chartType === "line" ? "minute" : "day",
                    round: false,
                    tooltipFormat: "dd.MM.yyyy HH:mm",
                    displayFormats: {
                      minute: "dd.MM HH:mm",
                      hour: "dd.MM HH:mm",
                      day: "dd.MM.yyyy",
                      second: "dd.MM HH:mm:ss",
                      month: "MM.yyyy",
                    },
                  },
                  grid: { display: showGrid, color: "#e2eef3" },
                  title: { display: !!xTitle, text: xTitle, color: "#26384E" },
                  ticks: {
                    color: "#7b8692",
                    display: showXTicks,
                    source: "auto",
                    autoSkip: true,
                    maxTicksLimit: 18,
                    maxRotation: 45,
                    minRotation: 0,
                  },
                  maxBarThickness,
                  barPercentage,
                  categoryPercentage,
                }
              : {
                  type: "category" as const,
                  grid: { display: showGrid, color: "#e2eef3" },
                  title: { display: !!xTitle, text: xTitle, color: "#26384E" },
                  ticks: { color: "#7b8692", display: showXTicks },
                  maxBarThickness,
                  barPercentage,
                  categoryPercentage,
                },
            y: {
              grid: { display: showGrid, color: "#e2eef3" },
              title: { display: !!yTitle, text: yTitle, color: "#26384E" },
              ticks: { color: "#7b8692", display: showYTicks },
              suggestedMax: maxY ? maxY * 1.15 : undefined, // небольшой запас сверху
            },
          },
    elements: {
      point: {
        radius: showPoints ? pointSize : 0,
        pointStyle: pointStyle,
        backgroundColor: lineColor,
        borderColor: "#FFF",
        borderWidth: 2,
        hoverRadius: showPoints ? pointSize * 1.5 : 0,
      },
      line: {
        borderWidth: lineWidth,
        borderDash: getLineBorderDash(lineStyle),
      },
    },
    animation: animation ? { duration: 800, easing: "easeInOutQuart" } : false,
    onClick: (evt: any) => {
      if (onPointClick && chartRef.current) {
        const points = getElementAtEvent(chartRef.current, evt);
        if (points.length) {
          const i = points[0].index;
          onPointClick((data as any[])[i]);
        }
      }
    },
  };

  const exportPNG = () => {
    const chart = chartRef.current;
    if (chart) {
      const url = chart.toBase64Image();
      const a = document.createElement("a");
      a.href = url;
      a.download = "chart.png";
      a.click();
    }
  };

  const exportXLSX = () => {
    const ws = XLSX.utils.json_to_sheet(
      Array.isArray(data)
        ? (data as any[]).flatMap((set: any) =>
            set.data
              ? set.data.map((d: any) => ({
                  x:
                    typeof d.x === "object" && d.x?.toISOString
                      ? d.x.toISOString()
                      : d.x,
                  y: d.y ?? d.value,
                }))
              : []
          )
        : (data as any[]).map((d: any) => ({
            x:
              typeof d.x === "object" && d.x?.toISOString
                ? d.x.toISOString()
                : d.x,
            y: d.y ?? d.value,
          }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    saveAs(new Blob([buf]), "chart-data.xlsx");
  };

  const ChartComponent = chartComponents[chartType];

  const chartProps = {
    data: chartJsData,
    options: commonOptions,
    ref: chartRef,
    plugins: chartType === "bar" ? [valueLabelPlugin] : [],
  };

  return (
    <div
      style={{
        position: "relative",
        width: typeof width === "number" ? width + "px" : width,
        height: typeof height === "number" ? height + "px" : height,
      }}
    >
      <ChartComponent {...chartProps} />
      <div
        style={{
          position: "absolute",
          right: 12,
          top: 8,
          zIndex: 10,
        }}
      >
        <button
          onClick={exportPNG}
          style={{
            marginRight: 10,
            border: "none",
            background: "#fff",
            cursor: "pointer",
            padding: 4,
            borderRadius: 5,
          }}
        >
          PNG
        </button>
        <button
          onClick={exportXLSX}
          style={{
            border: "none",
            background: "#fff",
            cursor: "pointer",
            padding: 4,
            borderRadius: 5,
          }}
        >
          Excel
        </button>
      </div>
    </div>
  );
};

export default Charts;
