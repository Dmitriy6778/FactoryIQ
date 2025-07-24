import React from "react";
import styles from "../styles/CustomReportTable.module.css"; // путь под себя

type Tag = {
    id: number;
    name: string;
    browse_name?: string;
    description?: string;
};

type ReportTagSettings = {
    id: number;
    tag: Tag;
    type: "counter" | "current";
    aggregate?: "" | "SUM" | "AVG" | "MIN" | "MAX";
    intervalMinutes: number;
};

type CustomReportTableProps = {
    rows: any[];
    selectedTags: ReportTagSettings[];
};

function getShiftFromTimeGroup(timeGroup: string | undefined): string {
    if (!timeGroup) return "-";
    const hour = Number(timeGroup.slice(11, 13));
    if (hour >= 8 && hour < 20) return "Дневная";
    return "Ночная";
}

function formatDateTime(dt: string): string {
    if (!dt) return "";
    let s = dt.replace("T", " ").slice(0, 19);
    const [date, time] = s.split(" ");
    if (!date || !time) return s;
    const [y, m, d] = date.split("-");
    if (!y || !m || !d) return s;
    return `${d}.${m}.${y} ${time}`;
}

const CustomReportTable: React.FC<CustomReportTableProps> = ({
    rows,
    selectedTags,
}) => {
    if (!rows.length) return <div>Нет данных для отображения</div>;
    if (!selectedTags.length) return <div>Нет выбранных тегов</div>;

    return (
        <div className={styles.tableWrapper}>
            <table className={styles.customReportTable}>
                <thead>
                    <tr>
                        <th>Дата и время</th>
                        <th>Смена</th>
                        {selectedTags.map((t) => (
                            <th key={t.tag.id}>
                                {t.tag.description || t.tag.browse_name || t.tag.name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, idx) => (
                        <tr key={idx}>
                            <td>{formatDateTime(row.TimeGroup)}</td>
                            <td>{getShiftFromTimeGroup(row.TimeGroup)}</td>
                            {selectedTags.map((t) => {
                                const val = row[`Value_${t.tag.id}`];
                                return (
                                    <td key={t.tag.id}>
                                        {val == null || val === "" ? "-" : Number(val).toLocaleString("ru-RU", { maximumFractionDigits: 3 })}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default CustomReportTable;
