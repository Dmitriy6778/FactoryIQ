// client/src/pages/AnalyticsPage.tsx
import React, { useState, useEffect, useRef } from "react";
import styles from "../styles/AnalyticsPage.module.css";
import { BarChart2 } from "lucide-react";
import Charts from "../components/Charts";
import TagChipList from "../components/TagChipList";
import BackButton from "../components/BackButton";
import { useApi } from "../shared/useApi";

type Tag = {
    id: number;
    name: string;
    browse_name?: string;
    TagName?: string;
    description?: string;
};
type ChartDataset = {
    label: string;
    data: { x: any; y: number; shift?: number }[];
    borderColor?: string;
    backgroundColor?: string;
};

const CHART_TYPES = [
    { key: "line", label: "Линия" },
    { key: "bar", label: "Столбцы" },
    { key: "scatter", label: "Точки" },
    { key: "pie", label: "Круговая (Pie)" },
    { key: "doughnut", label: "Кольцевая (Doughnut)" },
    { key: "bubble", label: "Пузыри (Bubble)" },
];

const ANALYTICS_OPTIONS = [
    { key: "trend", label: "Тренд (сырые значения)" },
    { key: "daily_delta", label: "Суточный прирост" },
    { key: "shift_delta", label: "Сменный прирост" },
    { key: "aggregate", label: "Агрегация (SUM, AVG, MIN, MAX)" },
];

const AGGREGATES = [
    { key: "SUM", label: "Сумма (SUM)" },
    { key: "AVG", label: "Среднее (AVG)" },
    { key: "MIN", label: "Минимум (MIN)" },
    { key: "MAX", label: "Максимум (MAX)" },
];

const defaultColors = ["#00ffc6", "#0089fc", "#ffae00", "#ff6464", "#8c54ff", "#50fa7b", "#ffb86c", "#f1fa8c", "#ff79c6", "#bd93f9"];

function getRandomColorHex() {
    let hex = Math.floor(Math.random() * 16777215).toString(16);
    while (hex.length < 6) hex = "0" + hex;
    return "#" + hex;
}

const AnalyticsPage: React.FC = () => {
    const api = useApi();

    // --- Теги и поиск ---
    const [allTags, setAllTags] = useState<Tag[]>([]);
    const [tagFilter, setTagFilter] = useState("");
    const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const PAGE_SIZE = 200;

    // начальная порция тегов
    useEffect(() => {
        api.get<{ items: Tag[] }>("/tags/all-tags", { page: 1, page_size: PAGE_SIZE })
           .then((res) => setAllTags(res.items || []))
           .catch(() => setAllTags([]));
    }, [api]);

    // дебаунс-поиск по описанию на сервере (параметр search)
    useEffect(() => {
        const q = tagFilter.trim();
        abortRef.current?.abort();

        if (!q) {
            // если строка пустая — просто показываем последнюю загруженную страницу
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;

        const t = setTimeout(() => {
            api.get<{ items: Tag[] }>("/tags/all-tags", {
                page: 1,
                page_size: PAGE_SIZE,
                search: q, // бэк ищет ТОЛЬКО по description
            })
            .then((res) => setAllTags(res.items || []))
            .catch(() => {})
        }, 250);

        return () => {
            clearTimeout(t);
            controller.abort();
        };
    }, [tagFilter, api]);

    // локально исключаем уже выбранные
    const filteredTags = allTags.filter(t => !selectedTags.some(sel => sel.id === t.id));

    // --- Остальные состояния/параметры графиков ---
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [data, setData] = useState<ChartDataset[]>([]);
    const [loading, setLoading] = useState(false);

    const [analyticType, setAnalyticType] = useState("trend");
    const [chartType, setChartType] = useState("line");
    const [aggregateType, setAggregateType] = useState("SUM");
    const [averageInterval, setAverageInterval] = useState(10);

    const [showPoints, setShowPoints] = useState(true);
    const [showGrid, setShowGrid] = useState(true);
    const [fillArea, setFillArea] = useState(false);
    const [gradient, setGradient] = useState(false);
    const [animation, setAnimation] = useState(true);

    const pointStyle = "circle";
    const lineStyle = "solid";
    const lineWidth = 3;
    const pointSize = 4;

    const [maxBarThickness, setMaxBarThickness] = useState(40);
    const [barPercentage, setBarPercentage] = useState(1.0);
    const [categoryPercentage, setCategoryPercentage] = useState(1.0);

    const [seriesColors, setSeriesColors] = useState<string[]>([]);

    // цвета серий
    useEffect(() => {
        const count = analyticType === "shift_delta" ? selectedTags.length * 2 : selectedTags.length;
        setSeriesColors(Array(count).fill(0).map(() => getRandomColorHex()));
    }, [selectedTags, analyticType]);

    const handleInputFocus = () => setDropdownOpen(true);
    const handleInputBlur = () => setTimeout(() => setDropdownOpen(false), 180);

    const handleTagSelect = (tag: Tag) => {
        setSelectedTags((prev) => [...prev, tag]);
        setTagFilter("");
        setDropdownOpen(true);
        inputRef.current?.focus();
    };
const handleRandomColors = React.useCallback(() => {
  setSeriesColors(Array(data.length).fill(0).map(() => getRandomColorHex()));
}, [data.length]);

const removeTag = React.useCallback((id: number) => {
  setSelectedTags((prev) => prev.filter((t) => t.id !== id));
}, []);
    function toSqlDatetime(dt: string): string {
        if (!dt) return "";
        return dt.replace("T", " ") + ":00";
    }

    function groupShiftsForChart(apiData: any[], tagLabel = ""): ChartDataset[] {
        const grouped: Record<string, { day: number | null; night: number | null }> = {};
        (apiData || []).forEach((row) => {
            const date = (row.shift_start || "").substring(0, 10);
            if (!grouped[date]) grouped[date] = { day: null, night: null };
            if (row.shift_no === 1) grouped[date].day = row.delta;
            if (row.shift_no === 2) grouped[date].night = row.delta;
        });

        const labels = Object.keys(grouped);
        return [
            { label: `${tagLabel} — Дневная смена`, data: labels.map((d) => ({ x: d, y: grouped[d].day as number, shift: 1 })) },
            { label: `${tagLabel} — Ночная смена`, data: labels.map((d) => ({ x: d, y: grouped[d].night as number, shift: 2 })) },
        ];
    }

    function hexToRgba(hex: string, alpha = 1): string {
        let c = hex.replace("#", "");
        if (c.length === 3) c = c.split("").map((ch) => ch + ch).join("");
        if (c.length !== 6) return hex;
        const num = parseInt(c, 16);
        const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    }

 
    // --- Загрузка данных графиков ---
    const fetchData = async () => {
        if (selectedTags.length === 0 || !dateFrom || !dateTo) return;
        setLoading(true);
        try {
            const allData: ChartDataset[] = [];
            const fromSql = toSqlDatetime(dateFrom);
            const toSql = toSqlDatetime(dateTo);

            for (const tag of selectedTags) {
                if (analyticType === "trend") {
                    const res = await api.get<{ items: any[] }>("/analytics/trend", { tag_id: tag.id, date_from: fromSql, date_to: toSql });
                    allData.push({ label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`, data: (res.items || []).map(r => ({ x: r.timestamp, y: r.value })) });
                } else if (analyticType === "daily_delta") {
                    const res = await api.get<{ items: any[] }>("/analytics/daily-delta", { tag_id: tag.id, date_from: fromSql, date_to: toSql });
                    allData.push({ label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`, data: (res.items || []).map(r => ({ x: r.day, y: r.delta })) });
                } else if (analyticType === "shift_delta") {
                    const res = await api.get<{ items: any[] }>("/analytics/shift-delta", { tag_id: tag.id, date_from: fromSql, date_to: toSql });
                    const label = tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`;
                    allData.push(...groupShiftsForChart(res.items || [], label));
                } else if (analyticType === "aggregate") {
                    if (aggregateType === "AVG") {
                        const res = await api.get<{ items: any[] }>("/analytics/avg-trend", { tag_id: tag.id, date_from: fromSql, date_to: toSql, interval_minutes: averageInterval });
                        allData.push({ label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`, data: (res.items || []).map(r => ({ x: r.timestamp, y: r.value })) });
                    } else {
                        const res = await api.get<{ items: any[] }>("/analytics/aggregate", { agg_type: aggregateType, tag_id: tag.id, date_from: fromSql, date_to: toSql });
                        allData.push({ label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`, data: (res.items || []).map(r => ({ x: fromSql + " - " + toSql, y: r.result })) });
                    }
                }
            }

            setData(allData.map((ds, i) => ({
                ...ds,
                borderColor: seriesColors[i] || "#00ffc6",
                backgroundColor: chartType === "bar" ? hexToRgba(seriesColors[i] || "#00ffc6", 0.5) : seriesColors[i] || "#00ffc6",
            })));
        } catch (e: any) {
            alert("Network error: " + (e?.message || e));
        }
        setLoading(false);
    };

    useEffect(() => {
        if (!data?.length) return;
        setData(prev => Array.isArray(prev) ? prev.map((ds, i) => ({
            ...ds,
            borderColor: seriesColors[i] || "#00ffc6",
            backgroundColor: chartType === "bar" ? hexToRgba(seriesColors[i] || "#00ffc6", 0.5) : seriesColors[i] || "#00ffc6",
        })) : prev as any);
    }, [seriesColors, chartType]);

    return (
        <div className={styles.page}>
            <header className={styles.header} aria-label="Аналитика — Тренды по тегам">
                <BackButton />
                <BarChart2 size={34} style={{ marginRight: 10, color: "var(--oil-300)" }} />
                <span>Аналитика — Тренды по тегам</span>
            </header>

            <section className={styles.controls} style={{ flexWrap: "wrap" }}>
                {/* Поиск по описанию (серверный) */}
                <div className={styles.inputWrapper} style={{ flex: "0 0 320px" }}>
                    <input
                        ref={inputRef}
                        className={styles.input}
                        type="text"
                        placeholder="Поиск по описанию тега..."
                        value={tagFilter}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        onChange={(e) => { setTagFilter(e.target.value); setDropdownOpen(true); }}
                        autoComplete="off"
                    />
                    {dropdownOpen && (
                        <div className={styles.tagDropdown} role="listbox" aria-label="Список тегов">
                            {filteredTags.length === 0 && tagFilter && <div className={styles.dropdownEmpty}>Теги не найдены</div>}
                            {filteredTags.slice(0, 50).map((tag) => (
                                <div key={tag.id} onMouseDown={(e) => { e.preventDefault(); handleTagSelect(tag); }}>
                                    {/* Сначала описание — по нему ищем */}
                                    <div style={{ fontWeight: 600, color: "var(--seed-900)", fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={tag.description || ""}>
                                        {tag.description || <i>— нет описания —</i>}
                                    </div>
                                    {/* Ниже — системное имя */}
                                    <div style={{ fontSize: 12, color: "color-mix(in oklab, var(--seed-900) 45%, #888)", marginTop: 2, maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                         title={tag.browse_name || tag.name || tag.TagName || ""}>
                                        {tag.browse_name || tag.name || tag.TagName}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className={styles.inputHint}>Введите текст из описания</div>
                </div>

                {/* Выбранные теги */}
                <div className={styles.selectedTagsContainer} style={{ width: "100%", border: "1px solid var(--border-warm)", borderRadius: "var(--radius-s)", background: "var(--paper)", padding: 6 }}>
           <TagChipList
  tags={selectedTags}
  seriesColors={seriesColors}
  analyticType={analyticType}
  defaultColors={defaultColors}
  setSeriesColors={setSeriesColors}
  removeTag={removeTag}
/>

                 <button  onClick={handleRandomColors}
                            className={styles.button}
                            style={{ margin: "4px 0 0 12px", padding: "4px 16px", fontSize: 16, lineHeight: 1.2 }}>
                        🎲 Рандом цвета
                    </button>
                </div>

                {/* Остальные элементы управления */}
                <div className={styles.controls} style={{ marginTop: 4 }}>
                    <input type="datetime-local" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={styles.input} />
                    <input type="datetime-local" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={styles.input} />

                    <select className={styles.input} value={analyticType} onChange={(e) => setAnalyticType(e.target.value)} style={{ flex: "1 1 200px" }}>
                        {ANALYTICS_OPTIONS.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
                    </select>

                    {analyticType === "aggregate" && (
                        <>
                            <select className={styles.input} value={aggregateType} onChange={(e) => setAggregateType(e.target.value)} style={{ flex: "1 1 140px" }}>
                                {AGGREGATES.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
                            </select>
                            {aggregateType === "AVG" && (
                                <input className={styles.input} type="number" min={1} max={1440} value={averageInterval}
                                       onChange={(e) => setAverageInterval(Number(e.target.value))}
                                       placeholder="Интервал усреднения (мин)" style={{ flex: "1 1 160px" }} />
                            )}
                        </>
                    )}

                    <select className={styles.input} value={chartType} onChange={(e) => setChartType(e.target.value)} style={{ flex: "1 1 140px" }}>
                        {CHART_TYPES.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
                    </select>
                </div>

                {chartType === "bar" && (
                    <div className={styles.controls} style={{ marginTop: 12 }}>
                        <label className={styles.checkboxLabel}><span style={{ marginRight: 4 }}>Толщина (max):</span>
                            <input type="number" min={1} max={120} value={maxBarThickness} onChange={(e) => setMaxBarThickness(Number(e.target.value))} className={styles.input} style={{ width: 90 }} />
                        </label>
                        <label className={styles.checkboxLabel}><span style={{ marginRight: 4 }}>bar %:</span>
                            <input type="number" min={0.1} max={1} step={0.1} value={barPercentage} onChange={(e) => setBarPercentage(Number(e.target.value))} className={styles.input} style={{ width: 90 }} />
                        </label>
                        <label className={styles.checkboxLabel}><span style={{ marginRight: 4 }}>cat %:</span>
                            <input type="number" min={0.1} max={1} step={0.1} value={categoryPercentage} onChange={(e) => setCategoryPercentage(Number(e.target.value))} className={styles.input} style={{ width: 90 }} />
                        </label>
                    </div>
                )}

                <div style={{ marginTop: 16 }}>
                    <label className={styles.checkboxLabel}><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> Точки</label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Сетка</label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}><input type="checkbox" checked={fillArea} onChange={(e) => setFillArea(e.target.checked)} /> Заливка</label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}><input type="checkbox" checked={gradient} onChange={(e) => setGradient(e.target.checked)} /> Градиент</label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}><input type="checkbox" checked={animation} onChange={(e) => setAnimation(e.target.checked)} /> Анимация</label>
                </div>

                <button className={styles.button} style={{ minWidth: 180, marginTop: 20 }} onClick={fetchData} disabled={loading || selectedTags.length === 0 || !dateFrom || !dateTo}>
                    {loading ? "Загрузка..." : "Построить график"}
                </button>
            </section>

            <section className={styles.chartBlock} aria-label="График">
                <Charts
                    data={data}
                    chartType={chartType as any}
                    showPoints={showPoints}
                    showGrid={showGrid}
                    xTitle="Время"
                    yTitle="Значение"
                    fillArea={fillArea}
                    gradient={gradient}
                    animation={animation}
                    pointStyle={pointStyle as any}
                    lineStyle={lineStyle as any}
                    lineWidth={lineWidth}
                    pointSize={pointSize}
                    title=""
                    height={400}
                    width={"100%"}
                    maxBarThickness={maxBarThickness}
                    barPercentage={barPercentage}
                    categoryPercentage={categoryPercentage}
                    seriesColors={seriesColors}
                />
            </section>

            <div style={{ height: 20 }} />
        </div>
    );
};

export default AnalyticsPage;
