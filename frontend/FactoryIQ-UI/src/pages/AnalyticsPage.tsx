import React, { useState, useEffect, useRef } from "react";
import styles from "../styles/AnalyticsPage.module.css";
import { BarChart2 } from "lucide-react";
import Charts from "../components/Charts";
import TagChipList from "../components/TagChipList";
import BackButton from "../components/BackButton";

// Типы
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
    { key: "trend", label: "Тренд (сырые значения)", description: "Показывает тренд изменения тега за период." },
    { key: "daily_delta", label: "Суточный прирост", description: "Показывает разницу между начальным и конечным значением за сутки." },
    { key: "shift_delta", label: "Сменный прирост", description: "Показывает разницу между начальным и конечным значением за каждую смену." },
    { key: "aggregate", label: "Агрегация (SUM, AVG, MIN, MAX)", description: "Показывает выбранную агрегированную функцию за период." },
];

const AGGREGATES = [
    { key: "SUM", label: "Сумма (SUM)" },
    { key: "AVG", label: "Среднее (AVG)" },
    { key: "MIN", label: "Минимум (MIN)" },
    { key: "MAX", label: "Максимум (MAX)" },
];

const defaultColors = [
    "#00ffc6", "#0089fc", "#ffae00", "#ff6464", "#8c54ff",
    "#50fa7b", "#ffb86c", "#f1fa8c", "#ff79c6", "#bd93f9",
];

function getRandomColorHex() {
    let hex = Math.floor(Math.random() * 16777215).toString(16);
    while (hex.length < 6) hex = "0" + hex;
    return "#" + hex;
}

const AnalyticsPage: React.FC = () => {

    const [tags, setTags] = useState<Tag[]>([]);
    const [tagFilter, setTagFilter] = useState("");
    const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [data, setData] = useState<ChartDataset[]>([]);
    const [loading, setLoading] = useState(false);

    const [analyticType, setAnalyticType] = useState("trend");
    const [chartType, setChartType] = useState("line");
    const [aggregateType, setAggregateType] = useState("SUM");
    const [averageInterval, setAverageInterval] = useState(10); // Новое: интервал усреднения для AVG

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

    const [dropdownOpen, setDropdownOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetch("http://localhost:8000/tags/all")
            .then(res => res.json())
            .then(res => setTags(res.items || []));
    }, []);

    useEffect(() => {
        let count = analyticType === "shift_delta" ? selectedTags.length * 2 : selectedTags.length;
        setSeriesColors(Array(count).fill(0).map(() => getRandomColorHex()));
    }, [selectedTags, analyticType]);

    const filteredTags = tags
        .filter(t => !(selectedTags.some(sel => sel.id === t.id)))
        .filter(t =>
            (t.browse_name || t.name || t.TagName || "")
                .toLowerCase()
                .includes(tagFilter.toLowerCase())
        );

    const handleInputFocus = () => setDropdownOpen(true);
    const handleInputBlur = () => setTimeout(() => setDropdownOpen(false), 180);

    const handleTagSelect = (tag: Tag) => {
        setSelectedTags(prev => [...prev, tag]);
        setTagFilter("");
        setDropdownOpen(true);
        inputRef.current?.focus();
    };

    const removeTag = (id: number) => {
        setSelectedTags(selectedTags.filter(t => t.id !== id));
    };

    function toSqlDatetime(dt) {
        if (!dt) return "";
        // dt = "2025-07-08T13:45" → "2025-07-08 13:45:00"
        return dt.replace("T", " ") + ":00";
    }

    function groupShiftsForChart(apiData: any[], tagLabel = ""): ChartDataset[] {
        const grouped: Record<string, { day: number | null, night: number | null }> = {};
        (apiData || []).forEach(row => {
            const date = (row.shift_start || "").substring(0, 10);
            if (!grouped[date]) grouped[date] = { day: null, night: null };
            if (row.shift_no === 1) grouped[date].day = row.delta;
            if (row.shift_no === 2) grouped[date].night = row.delta;
        });

        const labels = Object.keys(grouped);

        return [
            {
                label: `${tagLabel} — Дневная смена`,
                data: labels.map(date => ({
                    x: date,
                    y: grouped[date].day as number,
                    shift: 1,
                })),
            },
            {
                label: `${tagLabel} — Ночная смена`,
                data: labels.map(date => ({
                    x: date,
                    y: grouped[date].night as number,
                    shift: 2,
                })),
            }
        ];
    }

    function hexToRgba(hex: string, alpha = 1): string {
        let c = hex.replace('#', '');
        if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
        if (c.length !== 6) return hex;
        const num = parseInt(c, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    }

    const handleRandomColors = () => {
        setSeriesColors(Array(data.length).fill(0).map(() => getRandomColorHex()));
    };

    // --- ГЛАВНАЯ ЛОГИКА FETCH ---
    const fetchData = async () => {
        if (selectedTags.length === 0 || !dateFrom || !dateTo) return;
        setLoading(true);
        try {
            const allData: ChartDataset[] = [];
            const fromSql = toSqlDatetime(dateFrom);
            const toSql = toSqlDatetime(dateTo);
            for (const tag of selectedTags) {
                let url = "";
                // 1. Тренд (сырые значения)
                if (analyticType === "trend") {
                    url = `http://localhost:8000/analytics/trend?tag_id=${tag.id}&date_from=${encodeURIComponent(fromSql)}&date_to=${encodeURIComponent(toSql)}`;
                }
                // 2. Суточные приросты
                else if (analyticType === "daily_delta") {
                    url = `http://localhost:8000/analytics/daily-delta?tag_id=${tag.id}&date_from=${encodeURIComponent(fromSql)}&date_to=${encodeURIComponent(toSql)}`;
                }
                // 3. Сменные приросты
                else if (analyticType === "shift_delta") {
                    url = `http://localhost:8000/analytics/shift-delta?tag_id=${tag.id}&date_from=${encodeURIComponent(fromSql)}&date_to=${encodeURIComponent(toSql)}`;
                }
                // 4. Агрегация
                else if (analyticType === "aggregate") {
                    if (aggregateType === "AVG") {
                        url = `http://localhost:8000/analytics/avg-trend?tag_id=${tag.id}&date_from=${encodeURIComponent(fromSql)}&date_to=${encodeURIComponent(toSql)}&interval_minutes=${averageInterval}`;
                    } else {
                        url = `http://localhost:8000/analytics/aggregate?agg_type=${aggregateType}&tag_id=${tag.id}&date_from=${encodeURIComponent(fromSql)}&date_to=${encodeURIComponent(toSql)}`;
                    }
                }
                const resp = await fetch(url);
                if (!resp.ok) {
                    const text = await resp.text();
                    alert(`Ошибка ${resp.status}: ${text}`);
                    setLoading(false);
                    return;
                }
                const res = await resp.json();
                if (analyticType === "shift_delta") {
                    const label = tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`;
                    const datasets = groupShiftsForChart(res.items || [], label);
                    allData.push(...datasets);
                } else if (analyticType === "aggregate" && aggregateType === "AVG") {
                    allData.push({
                        label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`,
                        data: (res.items || []).map((row: any) => ({
                            x: row.timestamp,
                            y: row.value,
                        })),
                    });
                } else if (analyticType === "aggregate") {
                    // Сумма/минимум/максимум — одна точка!
                    allData.push({
                        label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`,
                        data: (res.items || []).map((row: any) => ({
                            x: fromSql + " - " + toSql,
                            y: row.result,
                        })),
                    });
                } else {
                    // trend, daily_delta
                    allData.push({
                        label: tag.browse_name || tag.name || tag.TagName || `Тег ${tag.id}`,
                        data: (res.items || []).map((row: any) => ({
                            x: row.timestamp || row.day || row.shift_start,
                            y: row.value ?? row.delta ?? row.result,
                        })),
                    });
                }
            }
            const coloredData = allData.map((dataset, i) => ({
                ...dataset,
                borderColor: seriesColors[i] || "#00ffc6",
                backgroundColor:
                    chartType === "bar"
                        ? hexToRgba(seriesColors[i] || "#00ffc6", 0.5)
                        : seriesColors[i] || "#00ffc6",
            }));
            setData(coloredData);

        } catch (err) {
            alert("Network error: " + err);
        }
        setLoading(false);
    };
    useEffect(() => {
        if (!data || data.length === 0) return;
        setData(prevData => {
            if (!Array.isArray(prevData)) return prevData;
            return prevData.map((dataset, i) => ({
                ...dataset,
                borderColor: seriesColors[i] || "#00ffc6",
                backgroundColor:
                    chartType === "bar"
                        ? hexToRgba(seriesColors[i] || "#00ffc6", 0.5)
                        : seriesColors[i] || "#00ffc6",
            }));
        });
    }, [seriesColors, chartType]);


    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <BackButton />
                <BarChart2 size={34} style={{ marginRight: 10, color: "#00ffc6" }} />
                <span>Аналитика — Тренды по тегам</span>
            </div>

            <div className={styles.controls} style={{ flexWrap: "wrap" }}>
                {/* Поиск тега */}
                <div style={{ width: "50%", minWidth: 350, marginBottom: 10, position: "relative" }}>
                    <input
                        ref={inputRef}
                        className={styles.input}
                        type="text"
                        placeholder="Поиск тега..."
                        value={tagFilter}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        onChange={e => {
                            setTagFilter(e.target.value);
                            setDropdownOpen(true);
                        }}
                        autoComplete="off"
                        style={{ width: "100%" }}
                    />
                    {dropdownOpen && (
                        <div
                            className={styles.tagDropdown}
                            style={{
                                maxHeight: 180,
                                overflowY: "auto",
                                border: "1px solid #ccc",
                                background: "#fff",
                                position: "absolute",
                                zIndex: 1000,
                                width: "100%",
                                boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                                top: "100%",
                                left: 0,
                            }}
                        >
                            {filteredTags.length === 0 && tagFilter && (
                                <div style={{ color: "#999", padding: 8 }}>Теги не найдены</div>
                            )}
                            {filteredTags.slice(0, 50).map(tag => (
                                <div
                                    key={tag.id}
                                    style={{
                                        padding: "8px 12px",
                                        cursor: "pointer",
                                        borderBottom: "1px solid #eee",
                                        background: "#fff",
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "flex-start",
                                        gap: 2,
                                    }}
                                    onMouseDown={e => {
                                        e.preventDefault();
                                        handleTagSelect(tag);
                                    }}
                                >
                                    <span
                                        style={{
                                            fontWeight: 600,
                                            color: "#153",
                                            fontSize: 15,
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis"
                                        }}
                                    >
                                        {tag.browse_name || tag.name || tag.TagName}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: "#888",
                                            marginTop: 2,
                                            maxWidth: "100%",
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis"
                                        }}
                                        title={tag.description || ""}
                                    >
                                        {tag.description || <i>— нет описания —</i>}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Выбранные теги и кнопка рандома */}
                <div
                    style={{
                        width: "100%",
                        minHeight: 38,
                        border: "1px solid #e6e6e6",
                        borderRadius: 6,
                        background: "#fff",
                        marginBottom: 10,
                        padding: 6,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        alignItems: "flex-start",
                    }}
                >
                    <TagChipList
                        tags={selectedTags}
                        seriesColors={seriesColors}
                        analyticType={analyticType}
                        defaultColors={defaultColors}
                        setSeriesColors={setSeriesColors}
                        removeTag={removeTag}
                    />
                    <button
                        onClick={handleRandomColors}
                        style={{
                            margin: "4px 0 0 12px",
                            padding: "4px 16px",
                            border: "none",
                            borderRadius: 5,
                            background: "#1fc8db",
                            color: "#fff",
                            fontWeight: 600,
                            fontSize: 16,
                            cursor: "pointer",
                            boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
                            transition: "background 0.2s"
                        }}
                    >
                        🎲 Рандом цвета
                    </button>
                </div>

                {/* Остальные элементы управления */}
                <div style={{ marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                        type="datetime-local"
                        value={dateFrom}
                        onChange={e => setDateFrom(e.target.value)}
                        className={styles.input}
                    />
                    <input
                        type="datetime-local"
                        value={dateTo}
                        onChange={e => setDateTo(e.target.value)}
                        className={styles.input}
                    />


                    <select
                        className={styles.input}
                        value={analyticType}
                        onChange={e => setAnalyticType(e.target.value)}
                        style={{ flex: "1 1 200px" }}
                    >
                        {ANALYTICS_OPTIONS.map(opt => (
                            <option key={opt.key} value={opt.key}>{opt.label}</option>
                        ))}
                    </select>
                    {analyticType === "aggregate" && (
                        <>
                            <select
                                className={styles.input}
                                value={aggregateType}
                                onChange={e => setAggregateType(e.target.value)}
                                style={{ flex: "1 1 140px" }}
                            >
                                {AGGREGATES.map(opt => (
                                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                                ))}
                            </select>
                            {aggregateType === "AVG" && (
                                <input
                                    className={styles.input}
                                    type="number"
                                    min={1}
                                    max={1440}
                                    value={averageInterval}
                                    onChange={e => setAverageInterval(Number(e.target.value))}
                                    placeholder="Интервал усреднения (мин)"
                                    style={{ flex: "1 1 160px" }}
                                />
                            )}
                        </>
                    )}
                    <select
                        className={styles.input}
                        value={chartType}
                        onChange={e => setChartType(e.target.value)}
                        style={{ flex: "1 1 140px" }}
                    >
                        {CHART_TYPES.map(opt => (
                            <option key={opt.key} value={opt.key}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                {/* Бары — только для bar chart */}
                {chartType === "bar" && (
                    <div style={{
                        display: "flex",
                        gap: 16,
                        alignItems: "center",
                        margin: "18px 0 0 0",
                        flexWrap: "wrap",
                    }}>
                        <label>
                            <span style={{ marginRight: 4 }}>Толщина столбца (max):</span>
                            <input
                                type="number"
                                min={1}
                                max={120}
                                value={maxBarThickness}
                                onChange={e => setMaxBarThickness(Number(e.target.value))}
                                style={{ width: 60 }}
                            />
                        </label>
                        <label>
                            <span style={{ marginRight: 4 }}>bar %:</span>
                            <input
                                type="number"
                                min={0.1}
                                max={1}
                                step={0.1}
                                value={barPercentage}
                                onChange={e => setBarPercentage(Number(e.target.value))}
                                style={{ width: 60 }}
                            />
                        </label>
                        <label>
                            <span style={{ marginRight: 4 }}>cat %:</span>
                            <input
                                type="number"
                                min={0.1}
                                max={1}
                                step={0.1}
                                value={categoryPercentage}
                                onChange={e => setCategoryPercentage(Number(e.target.value))}
                                style={{ width: 60 }}
                            />
                        </label>
                    </div>
                )}

                {/* Чекбоксы и кнопка "Построить график" */}
                <div style={{ marginTop: 16 }}>
                    <label className={styles.checkboxLabel}>
                        <input
                            type="checkbox"
                            checked={showPoints}
                            onChange={e => setShowPoints(e.target.checked)}
                        /> Точки
                    </label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}>
                        <input
                            type="checkbox"
                            checked={showGrid}
                            onChange={e => setShowGrid(e.target.checked)}
                        /> Сетка
                    </label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}>
                        <input
                            type="checkbox"
                            checked={fillArea}
                            onChange={e => setFillArea(e.target.checked)}
                        /> Заливка
                    </label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}>
                        <input
                            type="checkbox"
                            checked={gradient}
                            onChange={e => setGradient(e.target.checked)}
                        /> Градиент
                    </label>
                    <label className={styles.checkboxLabel} style={{ marginLeft: 16 }}>
                        <input
                            type="checkbox"
                            checked={animation}
                            onChange={e => setAnimation(e.target.checked)}
                        /> Анимация
                    </label>
                </div>
                <button
                    className={styles.button}
                    style={{ minWidth: 180, marginTop: 20 }}
                    onClick={fetchData}
                    disabled={loading || selectedTags.length === 0 || !dateFrom || !dateTo}
                >
                    {loading ? "Загрузка..." : "Построить график"}
                </button>
            </div>

            {/* График */}
            <div className={styles.chartBlock}>
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
            </div>
            <div style={{ height: 20 }} />
        </div>
    );
}
export default AnalyticsPage;