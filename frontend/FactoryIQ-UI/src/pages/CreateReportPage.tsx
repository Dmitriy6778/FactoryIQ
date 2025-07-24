import React, { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import styles from "../styles/CreateReportPage.module.css";
import BackButton from "../components/BackButton";
import CustomReportTable from "../components/CustomReportTable";

// Типы тегов
type Tag = {
  id: number;
  name: string;
  browse_name?: string;
  description?: string;
};

type ReportTagSettings = {
  id: number; // внутренний ключ (для React, уникальный)
  tag: Tag;
  type: "counter" | "current";
  aggregate?: "" | "SUM" | "AVG" | "MIN" | "MAX";
  intervalMinutes: number;
};

type ReportTemplateTag = {
  tag_id: number;
  tag_type: string;
  aggregate: "" | "SUM" | "AVG" | "MIN" | "MAX";
  interval_minutes: number;
  display_order: number;
};

type ReportTemplate = {
  id: number;
  name: string;
  description?: string;
  report_type?: string;
  period_type?: string;
  is_shared?: boolean;
  auto_schedule?: boolean;
  target_channel?: string;
  tags?: ReportTemplateTag[];
};

// Утилита для корректного ключа (без undefined!)
function getTagKey(tag: Tag): string {
  return tag.browse_name || tag.name;
}

function getShiftFromTimeGroup(timeGroup: string | undefined): string {
  if (!timeGroup) return "-";
  const hour = Number(timeGroup.slice(11, 13)); // "2025-06-01T08:00:00"
  if (hour >= 8 && hour < 20) return "Дневная";
  return "Ночная";
}


const AGGREGATE_OPTIONS = [
  { key: "", label: "Без агрегации (сырое/последнее)" },
  { key: "SUM", label: "Сумма (SUM)" },
  { key: "AVG", label: "Среднее (AVG)" },
  { key: "MIN", label: "Минимум (MIN)" },
  { key: "MAX", label: "Максимум (MAX)" },
];

const REPORT_TYPES = [
  { key: "balance", label: "Балансовый отчёт (по сменам и суткам)" },
  { key: "custom", label: "Настраиваемый отчёт" },
];

const API_BASE = "http://localhost:8000";

const CreateReportPage: React.FC = () => {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedTags, setSelectedTags] = useState<ReportTagSettings[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [reportType, setReportType] = useState<"balance" | "custom">("balance");
  const [reportBuilt, setReportBuilt] = useState(false);
  const [reportTableRows, setReportTableRows] = useState<any[]>([]);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [templateTags, setTemplateTags] = useState<ReportTemplateTag[]>([]);
  const [showTemplateTags, setShowTemplateTags] = useState(false);

  const [aggregate, setAggregate] = useState<"" | "SUM" | "AVG" | "MIN" | "MAX">(""); // или "AVG" по дефолту
  const [interval, setInterval] = useState<number>(10); // дефолтный шаг
  const [showDailySum, setShowDailySum] = useState(true);

  const handleReportTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setReportType(e.target.value as "balance" | "custom");
    setSelectedTags([]);
  };

  // Получение всех тегов
  useEffect(() => {
    fetch(`${API_BASE}/tags/all`)
      .then((res) => res.json())
      .then((data) => setAllTags(data.items || []));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/reports/templates`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) setTemplates(data.templates || []);
      });
  }, []);

  const handleShowTags = (templateId: number) => {
    setSelectedTemplateId(templateId);
    setShowTemplateTags(false);
    fetch(`${API_BASE}/reports/templates/${templateId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.template) {
          setTemplateTags(data.template.tags || []);
          setShowTemplateTags(true);
        }
      });
  };

  const handleDeleteTemplate = (templateId: number) => {
    if (!window.confirm("Удалить этот шаблон?")) return;
    fetch(`${API_BASE}/reports/templates/${templateId}`, {
      method: "DELETE",
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          setTemplates(templates.filter((t) => t.id !== templateId));
          setShowTemplateTags(false);
        } else {
          alert("Ошибка удаления");
        }
      });
  };

  // Фильтрация тегов
  const filteredTags = allTags
    .filter((t) => !selectedTags.some((sel) => sel.tag.id === t.id))
    .filter((t) =>
      (t.browse_name || t.name || "")
        .toLowerCase()
        .includes(filter.toLowerCase())
    );

  const handleInputFocus = () => setDropdownOpen(true);
  const handleInputBlur = () => setTimeout(() => setDropdownOpen(false), 150);

  const handleTagSelect = (tag: Tag) => {
    addTag(tag);
    setFilter("");
    setDropdownOpen(true);
    inputRef.current?.focus();
  };

  const addTag = (tag: Tag) => {
    if (selectedTags.some((st) => st.tag.id === tag.id)) return;
    setSelectedTags([
      ...selectedTags,
      {
        id: Date.now() + Math.random(),
        tag,
        type: reportType === "custom" ? "current" : "counter",
        aggregate: "",
        intervalMinutes: 1,
      },
    ]);
  };

  // Загрузка тегов шаблона по ID (чтобы заполнять selectedTags)
  async function loadTemplateTagsForReport(templateId: number): Promise<ReportTagSettings[]> {
    const res = await fetch(`${API_BASE}/reports/templates/${templateId}`);
    const data = await res.json();
    if (data.ok && data.template) {
      const selectedTagsFromTemplate: ReportTagSettings[] = (data.template.tags || []).map((t: ReportTemplateTag) => {
        const tagInfo = allTags.find((at) => at.id === t.tag_id);
        return {
          id: Date.now() + Math.random(),
          tag: tagInfo || { id: t.tag_id, name: t.tag_id.toString() },
          type: t.tag_type as "counter" | "current",
          aggregate: (t.aggregate || "") as "" | "SUM" | "AVG" | "MIN" | "MAX",
          intervalMinutes: t.interval_minutes,
        };
      });
      setSelectedTags(selectedTagsFromTemplate);
      return selectedTagsFromTemplate;
    }
    return [];
  }

  const removeTag = (id: number) => {
    setSelectedTags(selectedTags.filter((t) => t.id !== id));
  };

  // Сохранить шаблон
  const saveTemplate = () => {
    if (!templateName.trim()) {
      alert("Введите название шаблона");
      return;
    }
    if (selectedTags.length === 0) {
      alert("Добавьте хотя бы один тег!");
      return;
    }
    setLoading(true);

    // Для custom — все теги получают одинаковые агрегацию/интервал из формы
    const tagsToSave: ReportTagSettings[] = reportType === "custom"
      ? selectedTags.map((t) => ({
        ...t,
        aggregate: aggregate,
        intervalMinutes: interval,
      }))
      : selectedTags;

    fetch(`${API_BASE}/reports/templates/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: templateName,
        description: "",
        report_type: reportType,
        period_type: "",
        tags: tagsToSave.map((t) => ({
          tag_id: t.tag.id,
          tag_type: t.type,
          aggregate: t.aggregate ?? null,
          interval_minutes: t.intervalMinutes,
        })),
        is_shared: false,
        auto_schedule: false,
        target_channel: null,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          alert("Шаблон сохранён!");
          setTemplateName("");
        } else {
          alert("Ошибка сохранения: " + (data.detail || "Неизвестно"));
        }
      })
      .catch((e) => alert("Ошибка: " + e.message))
      .finally(() => setLoading(false));
  };


  const handleBuildByTemplate = async (templateId: number, tplReportType: string) => {
    setReportType(tplReportType as "balance" | "custom");
    if (!dateFrom || !dateTo) {
      alert("Укажите период!");
      return;
    }
    setLoading(true);

    const loadedTags = await loadTemplateTagsForReport(templateId);
    if (!loadedTags.length) {
      alert("В шаблоне нет тегов");
      setLoading(false);
      return;
    }

    let tagsForBuild: ReportTagSettings[] = loadedTags;
    if (tplReportType === "custom") {
      tagsForBuild = loadedTags.map(t => ({
        ...t,
        aggregate: aggregate,
        intervalMinutes: interval,
      }));
    }

    // КРИТИЧНО: подставить теги из шаблона как выбранные для баланса!
    if (tplReportType === "balance") {
      setSelectedTags(loadedTags);
    }

    const url =
      tplReportType === "balance"
        ? `${API_BASE}/reports/build`
        : `${API_BASE}/reports/build_custom`;

    const payload =
      tplReportType === "balance"
        ? {
          template_id: templateId,
          date_from: toSqlDatetime(dateFrom),
          date_to: toSqlDatetime(dateTo),
        }
        : {
          tags: tagsForBuild.map((t) => ({
            tag_id: t.tag.id,
            aggregate: t.aggregate || "",
            interval_minutes: t.intervalMinutes,
          })),
          date_from: toSqlDatetime(dateFrom),
          date_to: toSqlDatetime(dateTo),
        };

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          if (tplReportType === "custom") {
            const grouped = groupRowsForTable(data.data || [], tagsForBuild);
            setReportTableRows(grouped);
            setReportBuilt(true);
          } else {
            // balance
            const groupedRows: Record<string, any> = {};
            (data.data || []).forEach((row: any) => {
              const key = `${row.Date}_${row["Смена"]}`;
              if (!groupedRows[key]) {
                groupedRows[key] = {
                  Date: row.Date,
                  Смена: row["Смена"],
                };
              }
              const rawVal = row["Прирост"] ?? row["Value"] ?? row["Значение"];
              groupedRows[key][row.TagName] =
                rawVal !== undefined
                  ? +(parseFloat(String(rawVal)) / 1000).toFixed(1)
                  : "-";
            });
            setReportTableRows(Object.values(groupedRows));
            setReportBuilt(true);
          }
        } else {
          alert("Ошибка построения: " + (data.detail || "Неизвестно"));
        }
      })
      .catch((e) => alert("Ошибка: " + e.message))
      .finally(() => setLoading(false));
  };




  // --- Конвертация даты в формат SQL ---
  function toSqlDatetime(dateStr: string): string {
    if (!dateStr) return "";
    let d = dateStr.length >= 19 ? dateStr.slice(0, 19) : dateStr;
    d = d.replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d + " 00:00:00";
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d)) return d + ":00";
    return d;
  }

  // --- Группировка строк по времени и тегу (универсальная, с типами) ---


  function groupRowsForTable(
    rows: { TagId: number; TimeGroup: string; Value: number | null }[],
    selectedTags: ReportTagSettings[]
  ): any[] {
    // Собираем все уникальные TimeGroup
    const timeGroups = Array.from(new Set(rows.map((r) => r.TimeGroup))).sort();

    return timeGroups.map((tg) => {
      const row: any = { TimeGroup: tg };
      selectedTags.forEach((tag) => {
        // ищем строку с нужным TagId и TimeGroup
        const entry = rows.find(
          (r) => r.TimeGroup === tg && String(r.TagId) === String(tag.tag.id)
        );
        row[`Value_${tag.tag.id}`] = entry ? entry.Value : null;
      });
      return row;
    });
  }



  // --- Построить отчёт вручную ---
  const buildReport = () => {
    if (selectedTags.length === 0) {
      alert("Выберите хотя бы один тег");
      return;
    }
    if (!dateFrom || !dateTo) {
      alert("Укажите период отчёта");
      return;
    }
    setLoading(true);
    setReportBuilt(false);

    // Для custom-отчёта
    if (reportType === "custom") {
      fetch(`${API_BASE}/reports/build_custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: selectedTags.map((t) => ({
            tag_id: t.tag.id,
            aggregate,
            interval_minutes: interval,
          })),
          date_from: toSqlDatetime(dateFrom),
          date_to: toSqlDatetime(dateTo),
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.ok) {
            console.log('raw rows:', data.data) // до groupRowsForTable
            const grouped = groupRowsForTable(data.data || [], selectedTags);
            setReportTableRows(grouped);
            console.log('grouped:', grouped); // <- вот так можно!
            setReportBuilt(true);
          } else {
            alert("Ошибка построения: " + (data.detail || "Неизвестно"));
            setReportTableRows([]);
            setReportBuilt(false);
          }
        })
        .catch((e) => {
          alert("Ошибка: " + e.message);
          setReportTableRows([]);
          setReportBuilt(false);
        })
        .finally(() => setLoading(false));
      return;
    }

    // Для балансового отчёта
    fetch(`${API_BASE}/reports/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags: selectedTags.map((t) => ({
          tag_id: t.tag.id,
          tag_type: t.type,
          aggregate: t.aggregate,
          interval_minutes: t.intervalMinutes,
        })),
        date_from: toSqlDatetime(dateFrom),
        date_to: toSqlDatetime(dateTo),
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          const groupedRows: Record<string, any> = {};
          (data.data || []).forEach((row: any) => {
            const key = `${row.Date}_${row["Смена"]}`;
            if (!groupedRows[key]) {
              groupedRows[key] = {
                Date: row.Date,
                Смена: row["Смена"],
              };
            }
            const rawVal = row["Прирост"] ?? row["Value"] ?? row["Значение"];
            const parsed = parseFloat(String(rawVal).replace(",", "."));
            groupedRows[key][row.TagName] = !isNaN(parsed)
              ? +(parsed / 1000).toFixed(1)
              : "-";
          });
          setReportTableRows(Object.values(groupedRows));
          setReportBuilt(true);
        } else {
          alert("Ошибка построения: " + (data.detail || "Неизвестно"));
          setReportTableRows([]);
          setReportBuilt(false);
        }
      })
      .catch((e) => {
        alert("Ошибка: " + e.message);
        setReportTableRows([]);
        setReportBuilt(false);
      })
      .finally(() => setLoading(false));
  };

  // --- Формат даты для таблицы ---
  function formatDateTimeCustom(dt: string): string {
    if (!dt) return "";
    let s = dt.replace("T", " ").slice(0, 19); // убирает "T", если есть
    const [date, time] = s.split(" ");
    if (!date || !time) return s;
    const [y, m, d] = date.split("-");
    if (!y || !m || !d) return s;
    return `${d}.${m}.${y} ${time}`;
  }

  // --- Экспорт в Excel ---
  const exportToExcel = () => {
    if (!reportTableRows.length || selectedTags.length === 0) return;

    let headers: string[] = [];
    let dataRows: any[][] = [];

    if (reportType === "balance") {
      headers = [
        "Дата",
        "Смена",
        ...selectedTags.map(
          (t) => `${t.tag.description || t.tag.browse_name || t.tag.name}`
        ),
      ];
      dataRows = reportTableRows.map((row) => [
        row.Date,
        row["Смена"],
        ...selectedTags.map((tag) => {
          const val = row[getTagKey(tag.tag)];
          const num =
            typeof val === "string" ? parseFloat(val.replace(",", ".")) : val;
          return !isNaN(num) ? +(+num).toFixed(3) : "-";
        }),
      ]);
    } else {
      // Для custom отчёта
      headers = [
        "Дата и время",
        "Смена",
        ...selectedTags.map(
          (t) => `${t.tag.description || t.tag.browse_name || t.tag.name}`
        ),
      ];
      dataRows = reportTableRows.map((row) => [
        formatDateTimeCustom(row.TimeGroup),
        getShiftFromTimeGroup(row.TimeGroup),
        ...selectedTags.map((tag) => {
          const key = `Value_${tag.tag.id}`;
          const val = row[key];
          const num =
            typeof val === "string" ? parseFloat(val.replace(",", ".")) : val;
          return !isNaN(num) && num !== null && num !== undefined ? +(+num).toFixed(3) : "-";
        }),
      ]);
    }

    let ws_data: any[][] = [];
    if (reportType === "balance") {
      // Считаем итог только по "Сутки"
      const dailyRows = reportTableRows.filter(
        (row) => row["Смена"] === "Сутки"
      );
      const totals: Record<string, number> = {};
      selectedTags.forEach((t) => {
        const key = getTagKey(t.tag);
        totals[key] = dailyRows.reduce((sum, row) => {
          const val = row[key];
          const num =
            typeof val === "string" ? parseFloat(val.replace(",", ".")) : val;
          return !isNaN(num) ? sum + num : sum;
        }, 0);
      });
      const totalRow = [
        "Итого",
        "",
        ...selectedTags.map((tag) => +totals[getTagKey(tag.tag)].toFixed(3)),
      ];
      ws_data = [headers, ...dataRows, totalRow];
    } else {
      ws_data = [headers, ...dataRows];
    }

    const ws = XLSX.utils.aoa_to_sheet(ws_data);

    // Заголовки жирным и по центру
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell = XLSX.utils.encode_cell({ c: C, r: 0 });
      if (ws[cell]) {
        ws[cell].s = {
          font: { bold: true },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "E8F4FF" } },
        };
      }
    }
    // Автоширина
    ws["!cols"] = headers.map((_, i) => {
      const colValues = ws_data.map((row) => String(row[i] ?? ""));
      const maxLen = Math.max(...colValues.map((val) => val.length));
      return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    const buf = XLSX.write(wb, {
      bookType: "xlsx",
      type: "array",
      cellStyles: true,
    });
    saveAs(
      new Blob([buf], { type: "application/octet-stream" }),
      "report.xlsx"
    );
  };


  // --- Итоги по тегам для балансового отчёта (вычисляются на лету) ---
  const dailyRows = reportTableRows.filter((row) => row["Смена"] === "Сутки");
  const totals: Record<string, number> = {};
  selectedTags.forEach((t) => {
    const tagKey = getTagKey(t.tag);
    totals[tagKey] = dailyRows.reduce((sum, row) => {
      const value = row[tagKey];
      if (typeof value === "number") return sum + value;
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        !isNaN(Number(value))
      )
        return sum + Number(value);
      return sum;
    }, 0);
  });



  return (
    <div className={styles.pageContainer}>
      {/* Список шаблонов */}
      <div className={styles.reportCard}>
        <BackButton />
        <div className={styles.reportTitle}>Список шаблонов</div>
        <table className={styles.reportWideTable}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Название</th>
              <th>Описание</th>
              <th>Тип</th>
              <th>Период</th>
              <th>Общие</th>
              <th>Теги</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((tpl) => (
              <tr
                key={tpl.id}
                style={{
                  background:
                    tpl.id === selectedTemplateId ? "#eaf6fc" : undefined,
                }}
              >
                <td>{tpl.id}</td>
                <td>{tpl.name}</td>
                <td>{tpl.description}</td>
                <td>{tpl.report_type}</td>
                <td>{tpl.period_type}</td>
                <td>{tpl.is_shared ? "Да" : "Нет"}</td>
                <td>
                  <button
                    className={styles.reportSmallBtn}
                    onClick={() => handleShowTags(tpl.id)}
                  >
                    Показать теги
                  </button>
                </td>
                <td>
                  <button
                    className={styles.reportSmallBtn}
                    onClick={() => handleDeleteTemplate(tpl.id)}
                  >
                    Удалить
                  </button>
                  <button
                    className={styles.reportSmallBtn}
                    onClick={() =>
                      tpl.report_type
                        ? handleBuildByTemplate(tpl.id, tpl.report_type)
                        : alert("Тип отчёта не задан!")
                    }
                  >
                    Построить по шаблону
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Список тегов выбранного шаблона */}
        {showTemplateTags && (
          <div style={{ marginTop: 10 }}>
            <b>Теги шаблона #{selectedTemplateId}</b>
            <table className={styles.reportWideTable}>
              <thead>
                <tr>
                  <th>Имя тега</th>
                  <th>Описание</th>
                  <th>Тип</th>
                  <th>Агрегация</th>
                  <th>Интервал (мин)</th>
                  <th>Порядок</th>
                </tr>
              </thead>
              <tbody>
                {templateTags.map((tag, idx) => {
                  const tagInfo = allTags.find((t) => t.id === tag.tag_id);
                  return (
                    <tr key={idx}>
                      <td>
                        {tagInfo
                          ? tagInfo.browse_name || tagInfo.name
                          : tag.tag_id}
                      </td>
                      <td>{tagInfo?.description || "-"}</td>
                      <td>{tag.tag_type}</td>
                      <td>{tag.aggregate}</td>
                      <td>{tag.interval_minutes}</td>
                      <td>{tag.display_order}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Создание отчёта */}
      <div className={styles.reportCard}>
        <div className={styles.reportTitle}>Создание отчёта</div>

        {/* Выбор типа отчёта */}
        <div className={styles.reportSectionTitle}>Тип отчёта</div>
        <div style={{ marginBottom: "14px" }}>
          <select
            className={styles.reportSelect}
            value={reportType}
            onChange={handleReportTypeChange}
            style={{ width: 320, maxWidth: "100%" }}
          >
            {REPORT_TYPES.map((rt) => (
              <option key={rt.key} value={rt.key}>
                {rt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Поиск и добавление тегов */}
        <div className={styles.reportSectionTitle}>Добавление тегов в отчёт</div>
        <div className={styles.tagSearchBlock}>
          <input
            ref={inputRef}
            type="text"
            className={styles.reportInput}
            placeholder="Поиск тега..."
            value={filter}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onChange={(e) => {
              setFilter(e.target.value);
              setDropdownOpen(true);
            }}
            autoComplete="off"
          />
          {dropdownOpen && (
            <div className={styles.dropdownList}>
              {filteredTags.length === 0 && filter && (
                <div className={styles.dropdownEmpty}>Теги не найдены</div>
              )}
              {filteredTags.slice(0, 50).map((tag) => (
                <div
                  key={tag.id}
                  className={styles.dropdownItem}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleTagSelect(tag);
                  }}
                >
                  <span className={styles.dropdownTagName}>
                    {tag.browse_name || tag.name}
                  </span>
                  {tag.description && (
                    <span
                      className={styles.dropdownTagDesc}
                      title={tag.description}
                    >
                      {tag.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Список выбранных тегов */}
        <div className={styles.reportTagRow}>
          {selectedTags.length === 0 && (
            <div className={styles.reportTagsEmpty}>Теги не выбраны</div>
          )}
          {selectedTags.map((t) => (
            <div key={t.id} className={styles.reportTagBox}>
              {t.tag.description || t.tag.browse_name || t.tag.name}
              <span onClick={() => removeTag(t.id)}>×</span>
            </div>
          ))}
        </div>

        {/* --- Блок общих настроек для отчёта --- */}
        {reportType === "custom" && (
          <>
            <div className={styles.reportSectionTitleMini}>
              Параметры отчёта для всех тегов
            </div>
            <div className={styles.reportSettingsRow}>
              <label>
                Агрегация:&nbsp;
                <select
                  className={styles.reportSelect}
                  value={aggregate}
                  onChange={(e) => setAggregate(e.target.value as "" | "SUM" | "AVG" | "MIN" | "MAX")}

                >
                  {AGGREGATE_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* Показывать только если aggregate выбрана */}
              {aggregate && (
                <label>
                  Интервал (мин):&nbsp;
                  <input
                    className={styles.reportInput}
                    type="number"
                    min={1}
                    max={1440}
                    value={interval}
                    onChange={(e) => setInterval(Number(e.target.value))}
                  />
                </label>
              )}
            </div>
          </>
        )}

        {/* --- КОНЕЦ блока общих настроек --- */}

        {/* Период отчёта */}
        <div className={styles.reportSectionTitleMini}>Период отчёта</div>
        <div className={styles.reportPeriodRow}>
          <label>
            <span className={styles.reportPeriodLabel}>с&nbsp;</span>
            <input
              type="date"
              className={styles.reportInput}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label>
            <span className={styles.reportPeriodLabel}>по&nbsp;</span>
            <input
              type="date"
              className={styles.reportInput}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
        </div>

        {/* Сохранение шаблона */}
        <div className={styles.reportSectionTitleMini}>Сохранить шаблон</div>
        <div className={styles.reportSaveRow}>
          <input
            type="text"
            className={styles.reportInput}
            placeholder="Название шаблона отчёта"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
          />
          <button
            className={styles.reportButton}
            onClick={saveTemplate}
            disabled={loading}
          >
            Сохранить шаблон
          </button>
        </div>

        {/* Кнопки построения и экспорта */}
        <div className={styles.reportActionRow}>
          {reportType === "balance" && (
            <div style={{ margin: "12px 0 8px 0" }}>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showDailySum}
                  onChange={(e) => setShowDailySum(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Включать итоговую суточную сумму в таблицу и экспорт
              </label>
            </div>
          )}

          <button
            className={styles.reportButton}
            onClick={buildReport}
            disabled={loading}
          >
            Построить отчёт
          </button>
          {reportBuilt && reportTableRows.length > 0 && (
            <button className={styles.reportButton} onClick={exportToExcel}>
              Экспорт в Excel
            </button>
          )}
        </div>

        {/* Итоговая таблица */}

        {reportBuilt && reportTableRows.length > 0 && (
          <>
            <div
              className={
                styles.reportSectionTitle + " " + styles.reportResultTableTitle
              }
            >
              Таблица отчёта
            </div>
            <div className={styles.reportWideTableBlock}>
              {reportType === "custom" ? (
                <CustomReportTable
                  rows={reportTableRows}
                  selectedTags={selectedTags}
                />
              ) : (
                <table className={styles.reportWideTable}>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Смена</th>
                      {selectedTags.map((t, i) => (
                        <th key={i}>
                          {t.tag.description || t.tag.browse_name || t.tag.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reportTableRows.map((row, idx) => (
                      <tr key={idx}>
                        <td>{row.Date || "-"}</td>
                        <td>{row["Смена"] ?? "-"}</td>
                        {selectedTags.map((t, i) => {
                          const key = t.tag.browse_name;
                          const val = row[`Value_${t.tag.id}`] ?? row[key];
                          return (
                            <td key={i}>
                              {val == null || val === "" ? "-" : val}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {/* Итоги только для балансового */}
                    {showDailySum && (
                      <tr style={{ fontWeight: "bold", background: "#e3fbfa" }}>
                        <td colSpan={2}>Итого</td>
                        {selectedTags.map((t, i) => {
                          const tagKey = t.tag.browse_name;
                          return (
                            <td key={i}>
                              {totals[tagKey]?.toLocaleString("ru-RU", {
                                maximumFractionDigits: 3,
                              })}
                            </td>
                          );
                        })}
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
export default CreateReportPage;