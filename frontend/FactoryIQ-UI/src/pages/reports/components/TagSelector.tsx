// src/pages/reports/components/TagSelector.tsx
import { useState, useRef } from "react";
import styles from "../../../styles/CreateReportPage.module.css";
import { Tag, ReportTagSettings } from "../types";

interface Props {
  allTags: Tag[];
  selectedTags: ReportTagSettings[];
  onAdd: (tag: Tag) => void;
  onRemove: (id: number) => void;
}

function normalize(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я _./-]/gi, "");
}

export default function TagSelector({
  allTags,
  selectedTags,
  onAdd,
  onRemove,
}: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = normalize(filter);

  const filtered = allTags
    .filter((t) => !selectedTags.some((s) => s.tag.id === t.id))
    .filter((t) => {
      if (!q) return true;

      const haystack = normalize(
        `${t.browse_name} ${t.name} ${t.description} ${t.path} ${t.node_id}`
      );

      return haystack.includes(q);
    });

  const handleSelect = (tag: Tag) => {
    onAdd(tag);

    // не закрываем dropdown
    setOpen(true);

    // не очищаем текст поиска
    // setFilter(filter); ← оставляем как есть

    // повторный фокус на input для быстрого выбора нескольких тегов
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <>
      <div className={styles.reportSectionTitle}>Добавление тегов в отчёт</div>

      <div className={styles.tagSearchBlock}>
        <input
          ref={inputRef}
          type="text"
          className={styles.reportInput}
          placeholder="Поиск тега..."
          value={filter}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
          }}
          autoComplete="off"
        />

        {open && (
          <div className={styles.dropdownList}>
            {filtered.length === 0 && filter && (
              <div className={styles.dropdownEmpty}>Теги не найдены</div>
            )}

            {filtered.slice(0, 100).map((tag) => (
              <div
                key={tag.id}
                className={styles.dropdownItem}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(tag);
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

      {/* выбранные теги */}
      <div className={styles.reportTagRow}>
        {selectedTags.length === 0 && (
          <div className={styles.reportTagsEmpty}>Теги не выбраны</div>
        )}

        {selectedTags.map((t) => (
          <div key={t.id} className={styles.reportTagBox}>
            {t.tag.description || t.tag.browse_name || t.tag.name}
            <span
              onClick={() => onRemove(t.id)}
              role="button"
              aria-label="Удалить тег"
            >
              ×
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
