// src/components/UserScreens/TrendTagSelector.tsx
import React, { useState, useEffect } from "react";
import { X, Plus, } from "lucide-react";
import styles from "../../styles/TrendTagSelector.module.css";
import { useApi } from "../../shared/useApi";

export interface TrendTag {
  TagName: string;
  description?: string;
  [key: string]: any;
}

interface TrendTagSelectorProps {
  serverId?: number | null;
  onTagsAdd: (tags: string[]) => void;
  onClose: () => void;
  excludeTags?: string[];
  maxSelect?: number;
}

const TrendTagSelector: React.FC<TrendTagSelectorProps> = ({
  serverId,
  onTagsAdd,
  onClose,
  excludeTags = [],
  maxSelect = 5,
}) => {
  const api = useApi();

  const [tags, setTags] = useState<TrendTag[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    // если сервер не выбран — ничего не грузим
    if (!serverId) {
      setTags([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<any>("/all-tags", {
          params: { server_id: serverId, tagname: searchTerm },
        });

        const data: TrendTag[] = Array.isArray(res?.data)
          ? res.data
          : Array.isArray(res)
          ? (res as TrendTag[])
          : [];

        if (cancelled) return;

        if (data.length > 0) {
          const filtered = data.filter(
            (t: TrendTag) => !excludeTags.includes(t.TagName)
          );
          setTags(filtered);
          setError(null);
        } else {
          setTags([]);
          setError("Теги не найдены.");
        }
      } catch {
        if (!cancelled) {
          setTags([]);
          setError("Ошибка загрузки тегов.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [api, serverId, searchTerm, excludeTags]);

  // Клик по тегу
  const toggleTag = (tag: TrendTag) => {
    if (!tag || !tag.TagName) return;
    setSelected((sel) =>
      sel.includes(tag.TagName)
        ? sel.filter((t) => t !== tag.TagName)
        : sel.length < maxSelect
        ? [...sel, tag.TagName]
        : sel
    );
  };

  // Подтвердить добавление
  const handleAdd = () => {
    if (selected.length > 0) {
      onTagsAdd(selected);
      setSelected([]);
    }
  };

  // Если сервер не выбран — показываем подсказку
  if (!serverId) {
    return (
      <div className={styles.trendTagSelectorContainer}>
        <div className={styles.header}>
          <span className={styles.title}>Добавить теги на график</span>
          <button className={styles.closeBtn} onClick={onClose}>
            <X fontSize="small" />
          </button>
        </div>
        <div className={styles.footer}>
          <p style={{ padding: 16, color: "#888" }}>
            Сначала выберите сервер, чтобы искать теги.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.trendTagSelectorContainer}>
      <div className={styles.header}>
        <span className={styles.title}>Добавить теги на график</span>
        <button className={styles.closeBtn} onClick={onClose}>
          <X fontSize="small" />
        </button>
      </div>

      <input
        className={styles.searchInput}
        placeholder="Введите название тега"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        autoFocus
      />

      {loading && <p className={styles.loading}>Загрузка...</p>}
      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.tagList}>
        {tags.map((tag) => (
          <li
            key={tag.TagName}
            className={`${styles.tagItem} ${
              selected.includes(tag.TagName) ? styles.selected : ""
            }`}
            onClick={() => toggleTag(tag)}
            tabIndex={0}
          >
            <span className={styles.tagName}>{tag.TagName}</span>
            {selected.includes(tag.TagName) && <Plus fontSize="small" />}
            {tag.description && (
              <span className={styles.tagDescription}>
                {tag.description}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className={styles.footer}>
        <button
          className={styles.addBtn}
          disabled={selected.length === 0}
          onClick={handleAdd}
        >
          Добавить выбранные ({selected.length})
        </button>
      </div>
    </div>
  );
};

export default TrendTagSelector;
