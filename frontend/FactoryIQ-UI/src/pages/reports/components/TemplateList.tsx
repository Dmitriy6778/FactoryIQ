import styles from "../../../styles/CreateReportPage.module.css";
import { ReportTemplate } from "../types";

interface Props {
  templates: ReportTemplate[];
  selectedTemplateId: number | null;

  onSelectTemplate: (id: number) => void;
  onShowTags: (id: number) => void;
  onDelete: (id: number) => void;

  // 👉 важно: только id
  onBuild: (id: number) => void;
}

export default function TemplateList({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onShowTags,
  onDelete,
  onBuild
}: Props) {
  return (
    <table className={styles.reportWideTable}>
      <thead>
        <tr>
          <th>ID</th>
          <th>Название</th>
          <th>Тип</th>
          <th>Теги</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>
        {templates.map((tpl) => (
          <tr
            key={tpl.id}
            onClick={() => onSelectTemplate(tpl.id)}
            style={{
              background: tpl.id === selectedTemplateId ? "#eaf6fc" : undefined,
              cursor: "pointer",
            }}
          >
            <td>{tpl.id}</td>
            <td>{tpl.name}</td>
            <td>{tpl.report_type || "-"}</td>

            <td>
              <button
                className={styles.reportSmallBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onShowTags(tpl.id);
                }}
              >
                Показать теги
              </button>
            </td>

            <td>
              <button
                className={styles.reportSmallBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(tpl.id);
                }}
              >
                Удалить
              </button>

              <button
                className={styles.reportSmallBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onBuild(tpl.id); // ← теперь корректно
                }}
              >
                Построить
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
