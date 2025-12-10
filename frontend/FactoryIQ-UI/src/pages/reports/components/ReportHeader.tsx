// src/pages/reports/components/ReportHeader.tsx
import styles from "../../../styles/CreateReportPage.module.css";
import { ReportTemplate } from "../types";

interface Props {
  templates: ReportTemplate[];
  selectedTemplateId: number | null;
  onSelectTemplate: (id: number | null) => void;

  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;

  mode: "shifts" | "days" | "all";
  onModeChange: (m: "shifts" | "days" | "all") => void;

  onBuild: () => void;
  loading: boolean;
}

/* -----------------------------------------------------
   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (ТОЛЬКО ЛОКАЛЬНОЕ ВРЕМЯ!)
----------------------------------------------------- */

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

// Формат для <input type="datetime-local">: YYYY-MM-DDTHH:mm (ЛОКАЛЬНО)
function fmtLocal(d: Date): string {
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

// Начало дня (00:00) в локальном времени
function dayStartLocal(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return fmtLocal(x);
}

// Конец дня (23:59) в локальном времени
function dayEndLocal(d: Date): string {
  const x = new Date(d);
  x.setHours(23, 59, 0, 0);
  return fmtLocal(x);
}

export default function ReportHeader({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  mode,
  onModeChange,
  onBuild,
  loading,
}: Props) {
  /* -----------------------------------------------------
     БАЗОВЫЕ ДАТЫ (ЛОКАЛЬНЫЕ)
  ----------------------------------------------------- */

  const now = new Date();

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  const yesterday0 = new Date(today0);
  yesterday0.setDate(yesterday0.getDate() - 1);

  const minusHours = (h: number): string => {
    const d = new Date(now.getTime() - h * 60 * 60 * 1000);
    return fmtLocal(d);
  };

  // начало недели — понедельник, 00:00
  const weekStart = new Date(today0);
  weekStart.setDate(today0.getDate() - ((today0.getDay() + 6) % 7));

  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const lastWeekEnd = new Date(weekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1); // воскресенье прошлой недели

  const monthStart = new Date(today0.getFullYear(), today0.getMonth(), 1);
  const prevMonthStart = new Date(today0.getFullYear(), today0.getMonth() - 1, 1);
  const prevMonthEnd = new Date(today0.getFullYear(), today0.getMonth(), 0);

  /* -----------------------------------------------------
     ПРЕСЕТЫ
  ----------------------------------------------------- */

  const PRESET_OPTIONS = [
    { label: "—", from: "", to: "" },

    // День
    {
      label: "Сегодня",
      from: dayStartLocal(today0), // 00:00 сегодня
      to: fmtLocal(now),           // текущее локальное время
    },
    {
      label: "Вчера",
      from: dayStartLocal(yesterday0), // 00:00 вчера
      to: dayEndLocal(yesterday0),     // 23:59 вчера
    },

    // Последние часы
    {
      label: "Последние 24 часа",
      from: minusHours(24),
      to: fmtLocal(now),
    },
    {
      label: "Последние 48 часов",
      from: minusHours(48),
      to: fmtLocal(now),
    },

    // Последние 7/30 дней: от 00:00 N дней назад до текущего времени
    {
      label: "Последние 7 дней",
      from: dayStartLocal(new Date(today0.getTime() - 7 * 86400000)),
      to: fmtLocal(now),
    },
    {
      label: "Последние 30 дней",
      from: dayStartLocal(new Date(today0.getTime() - 30 * 86400000)),
      to: fmtLocal(now),
    },

    // Недели
    {
      label: "Текущая неделя",
      from: dayStartLocal(weekStart),
      to: fmtLocal(now),
    },
    {
      label: "Прошлая неделя",
      from: dayStartLocal(lastWeekStart),
      to: dayEndLocal(lastWeekEnd),
    },

    // Месяцы
    {
      label: "Текущий месяц",
      from: dayStartLocal(monthStart),
      to: fmtLocal(now),
    },
    {
      label: "Прошлый месяц",
      from: dayStartLocal(prevMonthStart),
      to: dayEndLocal(prevMonthEnd),
    },
  ];

  /* -----------------------------------------------------
     ОБРАБОТКА ПРЕСЕТА
  ----------------------------------------------------- */

  const handlePreset = (idx: number) => {
    const p = PRESET_OPTIONS[idx];
    if (!p.from || !p.to) return;
    onDateFromChange(p.from);
    onDateToChange(p.to);
  };

  /* -----------------------------------------------------
     RENDER
  ----------------------------------------------------- */

  return (
    <>
      {/* Шаблон + кнопка построения */}
      <div className={styles.reportSaveRow}>
        <select
          className={styles.reportSelect}
          style={{ minWidth: 260 }}
          value={selectedTemplateId ?? ""}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            onSelectTemplate(id);
          }}
        >
          <option value="">Без шаблона</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>

        <button
          className={styles.reportButton}
          onClick={onBuild}
          disabled={loading}
        >
          {loading ? "Строим..." : "Построить отчёт"}
        </button>
      </div>

      {/* Период отчёта */}
      <div className={styles.reportSectionTitleMini}>Период отчёта</div>

      {/* Пресеты */}
      <div style={{ marginBottom: 8 }}>
        <select
          className={styles.reportSelect}
          onChange={(e) => handlePreset(Number(e.target.value))}
        >
          {PRESET_OPTIONS.map((p, idx) => (
            <option key={idx} value={idx}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Ручной ввод даты / времени */}
      <div className={styles.reportPeriodRow}>
        <label>
          <span className={styles.reportPeriodLabel}>с&nbsp;</span>
          <input
            type="datetime-local"
            className={styles.reportInput}
            value={dateFrom}
            onChange={(e) => onDateFromChange(e.target.value)}
          />
        </label>

        <label>
          <span className={styles.reportPeriodLabel}>по&nbsp;</span>
          <input
            type="datetime-local"
            className={styles.reportInput}
            value={dateTo}
            onChange={(e) => onDateToChange(e.target.value)}
          />
        </label>
      </div>

      {/* Режим отображения строк */}
      <div className={styles.reportSectionTitleMini}>Отображение строк</div>
      <div style={{ marginBottom: 10 }}>
        <select
          className={styles.reportSelect}
          value={mode}
          onChange={(e) =>
            onModeChange(e.target.value as "shifts" | "days" | "all")
          }
        >
          <option value="all">Смена + сутки</option>
          <option value="shifts">Только смены</option>
          <option value="days">Только сутки</option>
        </select>
      </div>
    </>
  );
}
