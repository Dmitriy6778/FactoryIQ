// src/pages/reports/components/ReportTable.tsx
import styles from "../../../styles/CreateReportPage.module.css";
import { ReportTagSettings } from "../types";
import { getTagKey } from "../helpers/utils";

interface Props {
  rows: any[];
  selectedTags: ReportTagSettings[];
  showTotals: boolean;
}

export default function ReportTable({
  rows,
  selectedTags,
  showTotals,
}: Props) {
  // строки с "Сутки" для подсчёта итогов
  const dailyRows = rows.filter((r) => r["Смена"] === "Сутки");

  const totals: Record<string, number> = {};
  selectedTags.forEach((t) => {
    const key = getTagKey(t.tag);
    totals[key] = dailyRows.reduce((sum, row) => {
      const val = row[key];
      if (val === null || val === undefined || val === "" || val === "-") {
        return sum;
      }
      const num = Number(val);
      return isNaN(num) ? sum : sum + num;
    }, 0);
  });

  return (
    <>
      <div
        className={`${styles.reportSectionTitle} ${styles.reportResultTableTitle}`}
      >
        Таблица отчёта
      </div>
      <div className={styles.reportWideTableBlock}>
        <table className={styles.reportWideTable}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Смена</th>
              {selectedTags.map((t) => (
                <th key={t.id}>{getTagKey(t.tag)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx}>
                <td>{row.Date || "-"}</td>
                <td>{row["Смена"] ?? "-"}</td>
                {selectedTags.map((t) => {
                  const key = getTagKey(t.tag);
                  const val = row[key];
                  return <td key={t.id}>{val == null ? "-" : val}</td>;
                })}
              </tr>
            ))}

            {showTotals && (
              <tr style={{ fontWeight: "bold", background: "#e3fbfa" }}>
                <td colSpan={2}>Итого (по строкам &quot;Сутки&quot;)</td>
                {selectedTags.map((t) => {
                  const key = getTagKey(t.tag);
                  const total = totals[key];
                  return (
                    <td key={t.id}>
                      {total?.toLocaleString("ru-RU", {
                        maximumFractionDigits: 3,
                      })}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
