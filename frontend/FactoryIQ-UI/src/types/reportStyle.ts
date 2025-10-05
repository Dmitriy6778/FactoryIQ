// src/types/reportStyle.ts
export type ChartStyle = {
    dpi: number;
    size: { w: number; h: number };
    layout: { title: { show: boolean; align: string; fontSize: number; upper: boolean }; legend: { show: boolean; position: string } };
    axes: { x: { rotation: number; tickFont: number; wrap: number; grid: boolean }; y: { tickFont: number; grid: boolean; label: string } };
    bars: { width: number; rounded: boolean; showValueInside: boolean; valuePrecision: number };
    palette: { type: "single" | "multi" | "single-or-multi"; singleColor: string; multi: string[] };
    background: { color: string };
    watermark: { text: string; opacity: number; position: "br" | "bl" | "tr" | "tl" };
};

export type TableStyle = {
    density: "compact" | "normal" | "comfortable";
    fontSize: number;
    header: { bg: string; color: string; bold: boolean };
    body: { zebra: boolean; zebraColor: string; borderColor: string; numberPrecision: number; thousandSep: string; decimalSep: string; alignNumbersRight: boolean };
    columns: { autoWidth: boolean; maxWidthPx: number; firstColWidthPct: number };
    totals: { show: boolean; label: string };
};

export type ExcelStyle = {
    sheetName: string;
    freezeHeader: boolean;
    autoWidth: boolean;
    numberFormat: string;
    dateFormat: string;
};

export type ReportStyleDTO = {
    id?: number;
    name: string;
    chart: ChartStyle;
    table: TableStyle;
    excel: ExcelStyle;
    is_default: boolean;
};
