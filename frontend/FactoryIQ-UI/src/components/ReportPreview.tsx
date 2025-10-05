import React from "react";
import Charts from "./Charts";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { Button } from "antd";


type ReportPreviewProps = {
    templateId: number;
    format: string;
    scheduleType: string;
    scheduleTime?: string | null;
    aggregationType?: string | string[];
    onSuccess?: () => void;
    styleOverride?: any;           // <--- ДОБАВИЛИ
};


const ReportPreview: React.FC<ReportPreviewProps> = ({
    templateId,
    format,
    scheduleType,
    scheduleTime,
    aggregationType,
    onSuccess,
    styleOverride,
}) => {
    const styleKey = React.useMemo(
        () => JSON.stringify(styleOverride || {}),
        [styleOverride]
    );
    const [isLoading, setIsLoading] = React.useState(false);
    const [previewData, setPreviewData] = React.useState<any>(null);
    const [error, setError] = React.useState<string>("");

    const aggType =
        Array.isArray(aggregationType) ? aggregationType.join(",") : aggregationType || "";

    React.useEffect(() => {
        const controller = new AbortController();
        setIsLoading(true);
        setError("");
        setPreviewData(null);

        fetch("http://localhost:8000/telegram/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                template_id: templateId,
                format,
                period_type: scheduleType,
                time_of_day: scheduleTime,
                aggregation_type: aggType,
                style_override: styleOverride,
            }),
            signal: controller.signal,
        })
            .then(async (resp) => {
                setIsLoading(false);
                if (!resp.ok) {
                    setError("Ошибка сервера: " + resp.status);
                    return;
                }
                const data = await resp.json();
                if (data.ok) {
                    setPreviewData(data);
                    onSuccess?.();
                } else {
                    setError(data.detail || "Не удалось получить предпросмотр");
                }
            })
            .catch((e) => {
                if (e.name !== "AbortError") setError("Ошибка соединения: " + e?.message);
                setIsLoading(false);
            });

        return () => controller.abort();
    }, [templateId, format, scheduleType, scheduleTime, aggType, onSuccess, styleKey]);

    // Удобные шорткаты
    const columns: string[] = previewData?.columns;
    const rows: any[] = previewData?.data;
    const tablePngs: string[] = previewData?.table_pngs || [];
    const textBlock: string | undefined = previewData?.text_table;
    const hasAnyData =
        (format === "chart" && (previewData?.chart_png || (columns && rows?.length))) ||
        ((format === "table" || format === "file") &&
            (tablePngs.length > 0 || (columns && rows?.length))) ||
        (format === "text" && (tablePngs.length > 0 || !!textBlock || (columns && rows?.length)));

    // ===== helpers =====
    function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
        return arr.reduce((acc, item) => {
            const key = keyFn(item);
            (acc[key] ||= []).push(item);
            return acc;
        }, {} as Record<string, T[]>);
    }

    function renderChartPreviewImage() {
        if (!previewData?.chart_png) return null;
        return (
            <div
                style={{
                    background: "#fff",
                    borderRadius: 12,
                    boxShadow: "0 1px 8px #c7d1e7",
                    padding: 14,
                    marginBottom: 12,
                    textAlign: "center",
                }}
            >
                <div style={{ marginBottom: 10, fontWeight: 500 }}>
                    Вот так будет выглядеть предпросмотр в Telegram:
                </div>
                <img
                    key={previewData.chart_png.slice(0, 20)}
                    src={`data:image/png;base64,${previewData.chart_png}`}
                    alt="Telegram Chart Preview"
                    style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 10, background: "#fafbfc" }}
                />
            </div>
        );
    }

    // Мульти-графики по тегам/агрегациям (fallback когда chart_png нет)
    function renderMultiCharts(cols: string[], rs: any[]) {
        if (!cols || !rs || !rs.length) return null;

        const groupKey = cols.includes("TagName") ? "TagName" : cols.includes("TagId") ? "TagId" : null;
        const aggKey = cols.includes("Aggregate") ? "Aggregate" : null;

        if (groupKey && cols.includes("Value")) {
            const byTag = groupBy(rs, (row) => row[groupKey]);
            return (
                <>
                    {Object.entries(byTag).map(([tag, tagRows]) => (
                        <div
                            key={tag}
                            style={{
                                marginBottom: 32,
                                background: "#fff",
                                borderRadius: 12,
                                boxShadow: "0 1px 8px #dde1ed",
                                padding: 18,
                            }}
                        >
                            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 16 }}>
                                {groupKey === "TagName" ? `Тег: ${tag}` : `TagId: ${tag}`}
                            </div>
                            {aggKey ? (
                                <Charts
                                    chartType="bar"
                                    data={Object.entries(groupBy(tagRows, (row) => row[aggKey])).map(
                                        ([agg, aggRows]) => ({
                                            label: String(agg),
                                            data: aggRows.map((row) => ({
                                                x: row.Period || row.Date || row[cols[0]],
                                                y: Number(row.Value),
                                            })),
                                        })
                                    )}
                                    height={320}
                                    xTitle={cols.includes("Period") ? "Период" : cols[0]}
                                    yTitle="Value"
                                    showLegend
                                />
                            ) : (
                                <Charts
                                    chartType="bar"
                                    data={[
                                        {
                                            label: "Value",
                                            data: tagRows.map((row) => ({
                                                x: row.Period || row.Date || row[cols[0]],
                                                y: Number(row.Value),
                                            })),
                                        },
                                    ]}
                                    height={320}
                                    xTitle={cols.includes("Period") ? "Период" : cols[0]}
                                    yTitle="Value"
                                    showLegend={false}
                                />
                            )}
                        </div>
                    ))}
                </>
            );
        }

        // Совсем общий fallback
        return (
            <Charts
                chartType="bar"
                data={
                    cols && rs
                        ? cols.slice(1).map((col) => ({
                            label: col,
                            data: rs.map((row) => ({ x: row[cols[0]], y: row[col] })),
                        }))
                        : []
                }
                height={340}
                xTitle={cols?.[0]}
                yTitle={cols?.[cols.length - 1]}
                showLegend
            />
        );
    }

    function renderPreviewTable(columns: string[], rows: any[]) {
        if (!columns?.length || !rows?.length) return null;

        // какие колонки числовые — чтобы форматировать и выравнивать
        const numCols = columns.filter((c) => typeof rows[0][c] === "number");

        // если 2–3 столбца — делаем фиксированную компактную ширину
        const maxWidth =
            columns.length <= 3 ? 520 : columns.length <= 5 ? 720 : 960;

        return (
            <div style={{ display: "flex", justifyContent: "center" }}>
                <div
                    style={{
                        maxWidth,
                        width: "100%",
                        background: "#fff",
                        borderRadius: 12,
                        boxShadow: "0 1px 8px #c7d1e7",
                        padding: 8,
                    }}
                >
                    <div style={{ overflowX: "auto" }}>
                        <table
                            style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                tableLayout: columns.length <= 3 ? "fixed" : "auto",
                                fontSize: 13, // компактный шрифт
                            }}
                        >
                            {/* Узкая первая колонка для названия и компактная числовая */}
                            {columns.length <= 3 && (
                                <colgroup>
                                    <col style={{ width: "68%" }} />
                                    <col style={{ width: "32%" }} />
                                    {columns.length === 3 && <col />}
                                </colgroup>
                            )}

                            <thead>
                                <tr>
                                    {columns.map((col) => (
                                        <th
                                            key={col}
                                            style={{
                                                padding: "6px 8px",
                                                borderBottom: "2px solid #eef1f6",
                                                background: "#f7f9fc",
                                                whiteSpace: "nowrap",
                                                textAlign: "center",
                                                fontWeight: 600,
                                            }}
                                        >
                                            {col}
                                        </th>
                                    ))}
                                </tr>
                            </thead>

                            <tbody>
                                {rows.map((row: any, i: number) => (
                                    <tr key={i}>
                                        {columns.map((col: string) => {
                                            let v = row[col];
                                            if (v === undefined || v === null) v = "-";
                                            if (numCols.includes(col) && typeof v === "number") {
                                                v = Number.isInteger(v) ? v : v.toFixed(1);
                                            }
                                            return (
                                                <td
                                                    key={col}
                                                    style={{
                                                        padding: "4px 8px", // меньше паддинги
                                                        borderBottom: "1px solid #f0f2f6",
                                                        textAlign:
                                                            typeof row[col] === "number" ? "right" : "left",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {v}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        );
    }


    function handleExportExcel() {
        if (!columns || !rows) return;
        const worksheet = XLSX.utils.json_to_sheet(
            rows.map((row: any) => {
                const obj: any = {};
                columns.forEach((col: string) => {
                    let val = row[col];
                    if (val === undefined || val === null) val = "";
                    if (typeof val === "number") val = +val.toFixed(1);
                    obj[col] = val;
                });
                return obj;
            })
        );
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Отчёт");
        const wbout = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
        saveAs(new Blob([wbout], { type: "application/octet-stream" }), "report.xlsx");
    }

    return (
        <div>
            {isLoading && <div>Загрузка предпросмотра...</div>}
            {error && <div style={{ color: "#f33", margin: 8 }}>{error}</div>}

            {/* === CHART === */}
            {format === "chart" && (
                <>
                    {renderChartPreviewImage()}
                    {!previewData?.chart_png && columns && rows?.length > 0 && renderMultiCharts(columns, rows)}
                </>
            )}

            {/* === TABLE / FILE === */}
            {(format === "table" || format === "file") && (
                <>
                    {tablePngs.length > 0 && (
                        <div style={{ display: "grid", gap: 12 }}>
                            {tablePngs.map((b64, i) => (
                                <div
                                    key={i}
                                    style={{ background: "#fff", borderRadius: 12, boxShadow: "0 1px 8px #c7d1e7", padding: 12 }}
                                >
                                    <img
                                        src={`data:image/png;base64,${b64}`}
                                        alt={`Таблица ${i + 1}`}
                                        style={{ maxWidth: "100%", display: "block", borderRadius: 8 }}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    {tablePngs.length === 0 && columns && rows?.length > 0 && (
                        <>
                            <div style={{ marginBottom: 10 }}>
                                <Button onClick={handleExportExcel}>Экспорт в Excel</Button>
                            </div>
                            {renderPreviewTable(columns, rows)}
                        </>
                    )}
                </>
            )}

            {/* === TEXT === */}
            {format === "text" && (
                <>
                    {tablePngs.length > 0 && (
                        <div style={{ display: "grid", gap: 12 }}>
                            {tablePngs.map((b64, i) => (
                                <div
                                    key={i}
                                    style={{ background: "#fff", borderRadius: 12, boxShadow: "0 1px 8px #c7d1e7", padding: 12 }}
                                >
                                    <img
                                        src={`data:image/png;base64,${b64}`}
                                        alt={`Таблица ${i + 1}`}
                                        style={{ maxWidth: "100%", display: "block", borderRadius: 8 }}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    {tablePngs.length === 0 && textBlock && (
                        <div
                            style={{
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                                whiteSpace: "pre-wrap",
                                background: "#fff",
                                borderRadius: 12,
                                boxShadow: "0 1px 8px #dde1ed",
                                padding: 14,
                                marginTop: 12,
                            }}
                        >
                            {textBlock}
                        </div>
                    )}

                    {/* Самый последний fallback — HTML-таблица из columns/rows */}
                    {tablePngs.length === 0 && !textBlock && columns && rows?.length > 0 && (
                        renderPreviewTable(columns, rows)
                    )}
                </>
            )}

            {/* Нет данных */}
            {!isLoading && !error && !hasAnyData && (
                <div
                    style={{
                        background: "#fafbfc",
                        padding: 16,
                        borderRadius: 12,
                        fontFamily: "monospace",
                        color: "#777",
                    }}
                >
                    Нет данных для предпросмотра
                </div>
            )}

            {/* Период отчёта */}
            {previewData?.period && (
                <div style={{ marginTop: 10, color: "#39714e", fontWeight: 500 }}>
                    Период: {previewData.period.date_from} — {previewData.period.date_to}
                </div>
            )}
        </div>
    );
};

export default ReportPreview;
