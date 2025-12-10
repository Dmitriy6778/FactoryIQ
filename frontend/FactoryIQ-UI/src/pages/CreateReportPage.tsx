// src/pages/reports/CreateReportPage.tsx
import { useState, useEffect } from "react";
import styles from "../styles/CreateReportPage.module.css";

import BackButton from "../components/BackButton";
import { useApi } from "../shared/useApi";
import ReportHeader from "./reports/components/ReportHeader";
import TemplateList from "./reports/components/TemplateList";
import TagSelector from "./reports/components/TagSelector";
import ReportTable from "./reports/components/ReportTable";

import {
  Tag,
  ReportTemplate,
  ReportTagSettings,
  ReportTemplateTag,
} from "./reports/types";

import { toSqlDatetime, cleanTagName } from "./reports/helpers/utils";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";

const CreateReportPage = () => {
  const api = useApi();

  // State
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [selectedTags, setSelectedTags] = useState<ReportTagSettings[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);

  const [templateTags, setTemplateTags] = useState<ReportTemplateTag[]>([]);
  const [showTemplateTags, setShowTemplateTags] = useState(false);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // режим строк
  const [mode, setMode] = useState<"shifts" | "days" | "all">("all");

  const [reportBuilt, setReportBuilt] = useState(false);
  const [reportRows, setReportRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  /* ------------------------ LOAD TAGS ------------------------ */
  useEffect(() => {
    api
      .get<{ items: Tag[] }>("/tags/all-tags-reports", {
        page: 1,
        page_size: 500,
      })
      .then((r) => setAllTags(r.items || []))
      .catch(() => {});
  }, [api]);

  /* ------------------------ LOAD TEMPLATES ------------------------ */
  useEffect(() => {
    api
      .get<{ ok: boolean; templates: ReportTemplate[] }>("/reports/templates")
      .then((r) => r.ok && setTemplates(r.templates || []))
      .catch(() => {});
  }, [api]);

  /* ------------------------ LOAD TEMPLATE TAGS ------------------------ */
 async function loadTemplateTags(templateId: number): Promise<ReportTagSettings[]> {
  const r = await api.get<{ ok: boolean; template: ReportTemplate }>(
    `/reports/templates/${templateId}`
  );

  if (!r.ok || !r.template?.tags) return [];

  const mapped: ReportTagSettings[] = r.template.tags.map((t) => {
    const realTag = allTags.find((x) => x.id === t.tag_id);

    return {
      id: Date.now() + Math.random(),
      tag: {
        id: t.tag_id,
        name: realTag?.name || realTag?.browse_name || String(t.tag_id),
        browse_name: realTag?.browse_name,
        description: realTag?.description,
        path: realTag?.path,
        node_id: realTag?.node_id,
        data_type: realTag?.data_type,
      },
      type: t.tag_type,
      aggregate: t.aggregate,
      intervalMinutes: t.interval_minutes,
    };
  });

  setSelectedTags(mapped);
  return mapped;
}


  /* ------------------------ SHOW TEMPLATE TAGS TABLE ------------------------ */
  const handleShowTemplateTags = async (templateId: number) => {
    setSelectedTemplateId(templateId);
    setShowTemplateTags(false);

    const r = await api.get<{ ok: boolean; template: ReportTemplate }>(
      `/reports/templates/${templateId}`
    );

    if (r.ok && r.template) {
      setTemplateTags(r.template.tags || []);
      setShowTemplateTags(true);
    }
  };

  /* ------------------------ BUILD REPORT ------------------------ */
  const buildReport = async () => {
    if (!selectedTags.length) {
      alert("Добавьте теги!");
      return;
    }
    if (!dateFrom || !dateTo) {
      alert("Выберите период!");
      return;
    }

    setLoading(true);
    setReportBuilt(false);

    const payload = {
      tags: selectedTags.map((t) => ({
        tag_id: t.tag.id,
        tag_type: t.type,
        aggregate: t.aggregate,
        interval_minutes: t.intervalMinutes,
      })),
      date_from: toSqlDatetime(dateFrom),
      date_to: toSqlDatetime(dateTo),
      mode,
    };

    const r = await api.post<{ ok: boolean; data: any[] }>(
      "/reports/build",
      payload
    );

    if (!r.ok) {
      alert("Ошибка построения отчёта");
      setLoading(false);
      return;
    }

    // группировка строк
    const grouped: Record<string, any> = {};

    (r.data || []).forEach((row) => {
      const key = `${row.Date}_${row["Смена"]}`;

      if (!grouped[key]) {
        grouped[key] = {
          Date: row.Date,
          Смена: row["Смена"],
        };
      }

      const tagName = cleanTagName(row.TagName);
      const raw = row["Прирост_кг"] ?? row["Прирост"] ?? row["Value"];
      const num = Number(raw);

      grouped[key][tagName] = isNaN(num) ? "-" : num;
    });

    let rows = Object.values(grouped);

    // apply mode filter
    if (mode === "shifts") {
      rows = rows.filter((r) => r.Смена !== "Сутки");
    }
    if (mode === "days") {
      rows = rows.filter((r) => r.Смена === "Сутки");
    }

    setReportRows(rows);
    setReportBuilt(true);
    setLoading(false);
  };

  /* ------------------------ BUILD BY TEMPLATE ------------------------ */
  const handleBuildByTemplate = async (templateId: number) => {
    setSelectedTemplateId(templateId);

    const tags = await loadTemplateTags(templateId);
    if (!tags.length) {
      alert("В шаблоне нет тегов");
      return;
    }

    setSelectedTags(tags);
    await buildReport();
  };

  /* ------------------------ ADD TAG ------------------------ */
  const addTag = (tag: Tag) => {
    if (selectedTags.some((t) => t.tag.id === tag.id)) return;

    setSelectedTags((old) => [
      ...old,
      {
        id: Date.now() + Math.random(),
        tag,
        type: "counter",
        aggregate: "",
        intervalMinutes: 1,
      },
    ]);
  };

  /* ------------------------ REMOVE TAG ------------------------ */
  const removeTag = (id: number) => {
    setSelectedTags((old) => old.filter((t) => t.id !== id));
  };

  /* ------------------------ EXPORT TO EXCEL ------------------------ */
  const exportToExcel = () => {
    if (!reportRows.length || selectedTags.length === 0) return;

    const headers = [
      "Дата",
      "Смена",
      ...selectedTags.map((t) =>
        cleanTagName(t.tag.description || t.tag.browse_name || t.tag.name)
      ),
    ];

    const dataRows = reportRows.map((row) => [
      row.Date,
      row["Смена"],
      ...selectedTags.map((t) => {
        const tagKey = cleanTagName(
          t.tag.description || t.tag.browse_name || t.tag.name
        );
        const val = row[tagKey];

        const num =
          typeof val === "string" ? parseFloat(val.replace(",", ".")) : val;

        return !isNaN(num) ? Math.round(num) : "-";
      }),
    ]);

    // итог — только по суткам
    const daily = reportRows.filter((r) => r["Смена"] === "Сутки");

    const totals = selectedTags.map((t) => {
      const tagKey = cleanTagName(
        t.tag.description || t.tag.browse_name || t.tag.name
      );
      const sum = daily.reduce((acc, row) => {
        const v = Number(row[tagKey]);
        return isNaN(v) ? acc : acc + v;
      }, 0);
      return sum;
    });

    const totalRow = ["Итого", "", ...totals];

    const ws_data = [headers, ...dataRows, totalRow];
    const ws = XLSX.utils.aoa_to_sheet(ws_data);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");

    const buf = XLSX.write(wb, {
      bookType: "xlsx",
      type: "array",
    });

    saveAs(new Blob([buf]), "report.xlsx");
  };

  /* ------------------------ RENDER ------------------------ */
  return (
    <div className={styles.pageContainer}>
      {/* TEMPLATES */}
      <div className={styles.reportCard}>
        <BackButton />
        <div className={styles.reportTitle}>Список шаблонов</div>

        <TemplateList
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={(id) => setSelectedTemplateId(id)}
          onShowTags={handleShowTemplateTags}
          onDelete={async (id) => {
            if (!window.confirm("Удалить шаблон?")) return;
            await api.del(`/reports/templates/${id}`);
            setTemplates((old) => old.filter((t) => t.id !== id));
            if (selectedTemplateId === id) setSelectedTemplateId(null);
          }}
          onBuild={handleBuildByTemplate}
        />

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
                  <th>Интервал</th>
                  <th>Порядок</th>
                </tr>
              </thead>
              <tbody>
                {templateTags.map((t, idx) => {
                  const tagInfo = allTags.find((x) => x.id === t.tag_id);
                  return (
                    <tr key={idx}>
                      <td>{tagInfo?.browse_name || tagInfo?.name || t.tag_id}</td>
                      <td>{tagInfo?.description || "-"}</td>
                      <td>{t.tag_type}</td>
                      <td>{t.aggregate}</td>
                      <td>{t.interval_minutes}</td>
                      <td>{t.display_order}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* REPORT BUILDER */}
      <div className={styles.reportCard}>
        <div className={styles.reportTitle}>Создание отчёта</div>

        <ReportHeader
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={async (id) => {
            setSelectedTemplateId(id);
            if (id) {
              const t = await loadTemplateTags(id);
              setSelectedTags(t);
            } else {
              setSelectedTags([]);
            }
          }}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          mode={mode}
          onModeChange={setMode}
          onBuild={buildReport}
          loading={loading}
        />

        <TagSelector
          allTags={allTags}
          selectedTags={selectedTags}
          onAdd={addTag}
          onRemove={removeTag}
        />

        {reportBuilt && (
          <>
            <div className={styles.exportRow}>
              <button className={styles.exportButton} onClick={exportToExcel}>
                📊 Экспорт в Excel
              </button>
            </div>

            <ReportTable
              rows={reportRows}
              selectedTags={selectedTags}
              showTotals={true}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default CreateReportPage;
