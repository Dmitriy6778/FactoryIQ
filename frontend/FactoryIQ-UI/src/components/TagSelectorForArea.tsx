import React, { useState, useEffect, useCallback } from "react";
import {
  CloseOutlined,
  PlusOutlined,
  LineChartOutlined,
  TagOutlined,
} from "@ant-design/icons";
import { Input, Spin, Alert, Tooltip } from "antd";

import { useApi } from "../shared/useApi";
import s from "../styles/TagSelectorForArea.module.css";

type AddType = "tag" | "chart";

export interface TagItem {
  id?: number | string;
  TagName: string;
  description?: string;
  [key: string]: any;
}

interface TagSelectorForAreaProps {
  serverId?: number;
  screenName?: string;
  onTagAdd?: (tag: TagItem, addType: AddType) => void;
  onClose?: () => void;
  defaultAddType?: AddType;
  /** Имена тегов, которые уже использованы и не должны предлагаться повторно */
  existingTagNames?: string[];
}

const TagSelectorForArea: React.FC<TagSelectorForAreaProps> = ({
  serverId,
  screenName,
  onTagAdd,
  onClose,
  defaultAddType = "tag",
  existingTagNames = [],
}) => {
  const api = useApi();

  const [tags, setTags] = useState<TagItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addType, setAddType] = useState<AddType>(defaultAddType);

  useEffect(() => {
    setAddType(defaultAddType);
  }, [defaultAddType]);

  const fetchTags = useCallback(async () => {
    if (!serverId) {
      setTags([]);
      setError("Не выбран сервер");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // предполагаем, что useApi.get возвращает "data" сразу
      const data: any = await api.get("/all-tags", {
        server_id: serverId,
        tagname: searchTerm || undefined,
        screen_name: screenName || undefined,
      });

      const raw: TagItem[] = Array.isArray(data) ? data : data?.items || [];
      if (!raw.length) {
        setTags([]);
        setError("Теги не найдены.");
        return;
      }

      const excluded = new Set(
        (existingTagNames || []).map((t) => String(t).trim())
      );
      const filtered = raw.filter(
        (t) => !excluded.has(String(t.TagName || "").trim())
      );

      setTags(filtered);
      if (!filtered.length) {
        setError("Все найденные теги уже добавлены.");
      }
    } catch (e) {
      console.warn("Ошибка при загрузке тегов", e);
      setError("Не удалось загрузить теги.");
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, [api, serverId, searchTerm, screenName, existingTagNames]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const handleAddTag = (tag: TagItem) => {
    if (!tag || !tag.TagName) {
      // чтобы не тащить сюда message/alert — просто тихо выходим
      return;
    }
    onTagAdd?.(tag, addType);
    setTags((prev) =>
      prev.filter((t) => String(t.TagName) !== String(tag.TagName))
    );
  };

  const handleDragStart = (
    e: React.DragEvent<HTMLLIElement>,
    tag: TagItem,
    type: AddType
  ) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ tag, addType: type })
    );
  };

  return (
    <div className={s.container}>
      <div className={s.header}>
        <h3>Выбор тега</h3>
        {onClose && (
          <button
            className={s.closeButton}
            type="button"
            onClick={onClose}
            title="Закрыть"
          >
            <CloseOutlined style={{ fontSize: 12 }} />
          </button>
        )}
      </div>

      {/* Селектор режима добавления */}
      <div className={s.typeSelector}>
        <span className={s.typeLabel}>Добавлять как:</span>
        <button
          type="button"
          className={`${s.typeBtn} ${
            addType === "tag" ? s.activeType : ""
          }`}
          onClick={() => setAddType("tag")}
          title="Добавить как метку на экран"
        >
          <TagOutlined style={{ fontSize: 14, marginRight: 4 }} />
          <span>Метка</span>
        </button>
        <button
          type="button"
          className={`${s.typeBtn} ${
            addType === "chart" ? s.activeType : ""
          }`}
          onClick={() => setAddType("chart")}
          title="Добавить в тренд"
        >
          <LineChartOutlined style={{ fontSize: 14, marginRight: 4 }} />
          <span>Тренд</span>
        </button>
      </div>

      <Input
        placeholder="Введите имя тега"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className={s.searchInput}
        allowClear
      />

      {loading && (
        <div className={s.loading}>
          <Spin size="small" /> <span>Загрузка тегов…</span>
        </div>
      )}

      {!loading && error && (
        <div className={s.error}>
          <Alert type="warning" message={error} showIcon />
        </div>
      )}

      <ul className={s.tagList}>
        {tags.map((tag) => (
          <li
            key={tag.id ?? tag.TagName}
            className={s.tagItem}
            draggable
            onDragStart={(e) => handleDragStart(e, tag, addType)}
            title="Перетащите тег на рабочую область"
          >
            <div className={s.tagInfo}>
              <span className={s.tagName}>{tag.TagName}</span>
              {!!tag.description && (
                <span className={s.tagDescription}>
                  {tag.description}
                </span>
              )}
            </div>
            <Tooltip title="Добавить тег">
              <button
                type="button"
                className={s.addButton}
                onClick={() => handleAddTag(tag)}
              >
                <PlusOutlined style={{ fontSize: 12 }} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>

      <div className={s.hint}>
        Совет: перетащите тег мышкой на нужное место рабочей области!
      </div>
    </div>
  );
};

export default TagSelectorForArea;
