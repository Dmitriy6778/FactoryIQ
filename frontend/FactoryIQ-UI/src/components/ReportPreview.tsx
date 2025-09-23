import React, { useEffect, useState } from "react";
import Charts from "./Charts";

type ReportPreviewProps = {
    templateId: number;
    format: string;
    scheduleType: string;
    scheduleTime: string;
    onSuccess?: () => void;
};

const ReportPreview: React.FC<ReportPreviewProps> = ({
    templateId,
    format,
    scheduleType,
    scheduleTime,
    onSuccess,
}) => {
    const [isLoading, setIsLoading] = useState(false);
    const [previewData, setPreviewData] = useState<any>(null);
    const [error, setError] = useState<string>("");

    useEffect(() => {
        const controller = new AbortController();
        const fetchPreview = async () => {
            setIsLoading(true);
            setError("");
            setPreviewData(null);
            try {
                const resp = await fetch("http://localhost:8000/telegram/preview", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        template_id: templateId,
                        format,
                        period_type: scheduleType,
                        time_of_day: scheduleTime,
                    }),
                    signal: controller.signal,
                });
                if (!resp.ok) {
                    setError("Ошибка сервера: " + resp.status);
                    setIsLoading(false);
                    return;
                }
                const data = await resp.json();
                if (data.ok) {
                    setPreviewData(data);
                    if (onSuccess) onSuccess();
                } else {
                    setError(data.detail || "Не удалось получить предпросмотр");
                }
            } catch (e: any) {
                if (e.name === "AbortError") {
                    // ничего не делаем, запрос отменён
                } else {
                    setError("Ошибка соединения: " + e?.message);
                }
            }
            setIsLoading(false);
        };
        fetchPreview();
        return () => {
            controller.abort();
        };
    }, [templateId, format, scheduleType, scheduleTime, onSuccess]);

    // Универсальный рендер таблицы предпросмотра
    // Символьная таблица для Telegram-предпросмотра (семечка, лузга, тонны, смена)
    const renderTelegramTable = (data: any[]) => {
        const getShortName = (tag: string) =>
            tag?.toLowerCase().includes("seed") || tag?.toLowerCase().includes("семеч") ? "Семечка"
                : tag?.toLowerCase().includes("huls") || tag?.toLowerCase().includes("лузг") ? "Лузга"
                    : tag || "-";
        return (
            <div style={{ fontFamily: "monospace", marginTop: 12 }}>
                <pre>
                    {`Продукт        | Смена    |   Вес, т
--------------------------------------\n`}
                    {data.map(row => {
                        const tag = getShortName(row.TagName);
                        const shift = row["Смена"] || "";
                        const tons = ((row["Прирост"] ?? 0) / 1000).toFixed(1);
                        return `${tag.padEnd(14)} | ${shift.padEnd(8)} | ${tons.padStart(8)}\n`;
                    }).join("")}
                </pre>
            </div>
        );
    };

    // Преобразование sample-таблицы в наборы для Chart.js (line/bar)
    function toChartData(columns: string[], data: any[]) {
        if (!columns || columns.length < 2 || !data?.length) return [];
        const xKey = columns[0];
        return columns.slice(1).map(col => ({
            label: col,
            data: data.map(row => ({
                x: row[xKey],
                y: row[col]
            }))
        }));
    }

    return (
        <div>
            {isLoading && <div>Загрузка предпросмотра...</div>}

            {error && <div style={{ color: "#f33", margin: 8 }}>{error}</div>}

            {previewData && (
                <div style={{ marginTop: 12 }}>
                    {/* --- Telegram-style PNG предпросмотр --- */}
                    {format === "chart" && previewData.chart_png ? (
                        <div style={{
                            background: "#fff",
                            borderRadius: 12,
                            boxShadow: "0 1px 8px #c7d1e7",
                            padding: 14,
                            marginBottom: 12,
                            textAlign: "center"
                        }}>
                            <div style={{ marginBottom: 10, fontWeight: 500 }}>Вот так будет выглядеть предпросмотр в Telegram:</div>
                            <img
                                src={`data:image/png;base64,${previewData.chart_png}`}
                                alt="Telegram Chart Preview"
                                style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 10, background: "#fafbfc" }}
                            />
                        </div>
                    ) : null}

                    {/* Для десктоп-аналитики — Chart.js */}
                    {format === "chart" && !previewData.chart_png && previewData.columns && previewData.data && previewData.data.length > 0 ? (
                        <Charts
                            chartType="line"
                            data={toChartData(previewData.columns, previewData.data)}
                            height={340}
                            xTitle="Время"
                            yTitle="Значение"
                            showLegend={true}
                        />
                    ) : null}

                    {/* Для таблицы */}
                    {(format === "table" || format === "file") && previewData.data && previewData.data.length > 0 && (
                        renderTelegramTable(previewData.data)
                    )}


                    {/* Текстовый предпросмотр, если нет данных */}
                    {(!previewData.data || !previewData.data.length) && (
                        <div style={{
                            background: "#fafbfc",
                            padding: 16,
                            borderRadius: 12,
                            fontFamily: "monospace",
                            color: "#777"
                        }}>
                            Нет данных для предпросмотра
                        </div>
                    )}

                    {/* Период данных */}
                    {previewData.period && (
                        <div style={{ marginTop: 10, color: "#39714e", fontWeight: 500 }}>
                            Период: {previewData.period.date_from} — {previewData.period.date_to}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ReportPreview;
