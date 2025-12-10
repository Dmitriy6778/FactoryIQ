// src/pages/reports/helpers/reportTransform.ts

export type BalanceRow = {
  Date: string;
  Смена: string;
  TagName: string;
  Прирост_кг: number | null;
};

export type GroupedRow = {
  Date: string;
  Смена: string;
  [key: string]: any;
};

export type Totals = Record<string, number>;

export function cleanTagName(name: string): string {
  return name.replace(/,.*$/, "").trim();
}

/** Группировка балансового отчёта под таблицу */
export function groupBalanceRows(rows: BalanceRow[]): GroupedRow[] {
  const grouped: Record<string, GroupedRow> = {};

  rows.forEach(row => {
    const key = `${row.Date}_${row.Смена}`;

    if (!grouped[key]) {
      grouped[key] = { Date: row.Date, Смена: row.Смена };
    }

    const cleanName = cleanTagName(row.TagName);

    grouped[key][cleanName] =
      row.Прирост_кг != null && !isNaN(row.Прирост_кг)
        ? Math.round(row.Прирост_кг)
        : null;
  });

  return Object.values(grouped);
}

/** режим отображения таблицы */
export type ViewMode = "shift" | "daily" | "both";

export function filterRowsByMode(rows: GroupedRow[], mode: ViewMode): GroupedRow[] {
  if (mode === "shift") {
    return rows.filter(r => r["Смена"] !== "Сутки");
  }
  if (mode === "daily") {
    return rows.filter(r => r["Смена"] === "Сутки");
  }
  return rows; // both
}

/** Итоги по суточным строкам */
export function calcTotals(rows: GroupedRow[], tagNames: string[]): Totals {
  const totals: Totals = {};

  tagNames.forEach(t => {
    totals[t] = rows.reduce((acc, row) => {
      if (row["Смена"] !== "Сутки") return acc;
      const val = Number(row[t]);
      return isNaN(val) ? acc : acc + val;
    }, 0);
  });

  return totals;
}
