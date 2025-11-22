// src/components/UserScreens/ScadaTagSidebar.tsx
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  CSSProperties,
  UIEvent,
  DragEvent,
} from "react";
import { LineChart, Tag as TagIcon } from "lucide-react";
import styles from "./ScadaTagSidebar.module.css";
import { useApi } from "../../shared/useApi";

const ITEM_HEIGHT = 44;
const WINDOW_OVERSCAN = 10;

type AddType = "tag" | "chart";

export interface TagItem {
  id?: number | string;
  TagName?: string;
  description?: string | null;
  path?: string | null;

  // возможные поля для фильтров по зонам/типам (оставляем, но больше не используем в UI)
  area_name?: string | null;
  workshop?: string | null;
  section?: string | null;

  signal_type?: string | null;
  io_type?: string | null;
  data_type?: string | null;

  // источник / таблица (для нового фильтра)
  table_name?: string | null;
  source_table?: string | null;
  table?: string | null;

  // чтобы TS не ругался на дополнительные поля
  [key: string]: unknown;
}

export interface ScadaTagSidebarProps {
  serverId?: number;
  addChartToArea: (tagName: string, pos?: { x: number; y: number }) => void;
  addTagToArea: (tag: TagItem, pos?: { x: number; y: number }) => void;

  style?: CSSProperties;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const ScadaTagSidebar: React.FC<ScadaTagSidebarProps> = ({
  serverId,
  addChartToArea,
  addTagToArea,
  style = {},
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
}) => {
  const isControlled = typeof collapsedProp === "boolean";
  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(
    !!defaultCollapsed
  );
  const collapsed = isControlled ? (collapsedProp as boolean) : internalCollapsed;

  const api = useApi();

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    if (!isControlled) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  }, [collapsed, isControlled, onCollapsedChange]);

  // ----- данные о тегах -----
  const [tags, setTags] = useState<TagItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // пагинация
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [offset, setOffset] = useState<number>(0);
  const LIMIT = 500;

  // режим добавления
  const [addType, setAddType] = useState<AddType>("tag");

  // фильтры
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [tableFilter, setTableFilter] = useState<string>(""); // фильтр по таблице / источнику

  const listRef = useRef<HTMLDivElement | null>(null);

  // если сменился serverId — сбрасываем состояние и грузим заново
  useEffect(() => {
    setTags([]);
    setOffset(0);
    setHasMore(true);
  }, [serverId]);

  // загрузка очередной страницы тегов
  const fetchPage = useCallback(
    async (opts: { append: boolean } = { append: true }) => {
      if (collapsed || loading || !hasMore) return;

      setLoading(true);
      setError(null);

      try {
        const params: Record<string, any> = {
          limit: LIMIT,
          offset,
        };

        if (serverId) {
          params.server_id = serverId; // фильтр по серверу / фабрике
        }

        const res = await api.get("/user-screens/all-tags", params);

        let list: TagItem[] = [];
        if (Array.isArray(res)) {
          list = res;
        } else if (Array.isArray((res as any)?.data)) {
          list = (res as any).data;
        } else if (Array.isArray((res as any)?.items)) {
          list = (res as any).items;
        }

        setTags((prev) => (opts.append ? [...prev, ...list] : list));

        if (list.length < LIMIT) {
          setHasMore(false);
        } else {
          setOffset((prev) => prev + list.length);
        }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("Ошибка загрузки тегов:", err?.response?.data || err);
        setError("Не удалось загрузить теги.");
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [collapsed, loading, hasMore, serverId, offset, api]
  );

  // первая загрузка при раскрытии панели
  useEffect(() => {
    if (!collapsed && tags.length === 0 && hasMore && !loading) {
      fetchPage({ append: true });
    }
  }, [collapsed, fetchPage, hasMore, loading, tags.length]);

  // подгрузка при прокрутке + данные для виртуализации
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(600);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
  }, [collapsed]);

  const onListScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
        fetchPage({ append: true });
      }
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    },
    [fetchPage]
  );

  // ----- вычисление опций таблиц из тегов -----
  const tableOptions = useMemo(() => {
    const s = new Set<string>();
    tags.forEach((t) => {
      const val =
        (t.table_name as string | null | undefined) ??
        (t.source_table as string | null | undefined) ??
        (t.table as string | null | undefined) ??
        "";
      if (val) s.add(String(val));
    });
    return Array.from(s).sort();
  }, [tags]);

  // ----- фильтрация по поиску/таблице (локально) -----
  const filteredTags = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();

    return tags.filter((t) => {
      const name = String(t.TagName ?? "").toLowerCase();
      const desc = String(t.description ?? "").toLowerCase();
      const table = String(
        (t.table_name ?? t.source_table ?? t.table ?? "") as string
      );

      if (term) {
        const match = name.includes(term) || desc.includes(term);
        if (!match) return false;
      }

      if (tableFilter && table !== tableFilter) return false;

      return true;
    });
  }, [tags, searchTerm, tableFilter]);

  // ----- виртуализация -----
  const totalHeight = useMemo(
    () => filteredTags.length * ITEM_HEIGHT,
    [filteredTags.length]
  );

  const firstIndex = Math.max(
    0,
    Math.floor(scrollTop / ITEM_HEIGHT) - WINDOW_OVERSCAN
  );
  const lastIndex = Math.min(
    filteredTags.length,
    Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + WINDOW_OVERSCAN
  );

  const visible = useMemo(
    () => filteredTags.slice(firstIndex, lastIndex),
    [filteredTags, firstIndex, lastIndex]
  );

  const translateY = firstIndex * ITEM_HEIGHT;

  // ----- drag & click -----
  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, tag: TagItem, addTypeArg: AddType) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ tag, addType: addTypeArg })
      );
    },
    []
  );

  const handleClickTag = useCallback(
    (tag: TagItem) => {
      if (!tag || !tag.TagName) return;
      if (addType === "chart") addChartToArea(tag.TagName);
      else addTagToArea(tag);
    },
    [addType, addChartToArea, addTagToArea]
  );

  return (
    <div
      className={`${styles.sidebarWrap} ${
        collapsed ? styles.isCollapsed : ""
      }`}
      style={style}
    >
      <button
        className={styles.collapseHandle}
        onClick={toggleCollapsed}
        title={collapsed ? "Показать панель" : "Скрыть панель"}
        type="button"
      >
        {collapsed ? "›" : "‹"}
      </button>

      {!collapsed && (
        <div className={styles.sidebarContainer}>
          {/* Режим добавления */}
          <div className={styles.typeSelector}>
            <div className={styles.title}>Добавить тег</div>
            <span className={styles.smallLabel}>Добавлять как:</span>
            <div className={styles.typeBtnsRow}>
              <button
                className={`${styles.typeBtn} ${
                  addType === "tag" ? styles.activeType : ""
                }`}
                onClick={() => setAddType("tag")}
                type="button"
                title="Индикатор"
              >
                <TagIcon fontSize="small" />
                <span>Индикатор</span>
              </button>
              <button
                className={`${styles.typeBtn} ${
                  addType === "chart" ? styles.activeType : ""
                }`}
                onClick={() => setAddType("chart")}
                type="button"
                title="Тренд"
              >
                <LineChart fontSize="small" />
                <span>Тренд</span>
              </button>
            </div>
          </div>

          {/* Поиск + фильтр по таблице */}
          <div className={styles.filtersBlock}>
            <input
              type="text"
              placeholder="Поиск по имени или описанию"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={styles.searchInput}
            />

            <div className={styles.filtersRow}>
              <div className={styles.filterCol}>
                <span className={styles.filterLabel}>Таблица</span>
                <select
                  className={styles.filterSelect}
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                >
                  <option value="">Все</option>
                  {tableOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {loading && tags.length === 0 && (
            <p className={styles.loading}>Загрузка тегов...</p>
          )}
          {error && <p className={styles.error}>{error}</p>}

          {/* Список тегов (виртуализованный) */}
          <div
            className={styles.listViewport}
            ref={listRef}
            onScroll={onListScroll}
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              <div
                style={{
                  transform: `translateY(${translateY}px)`,
                  willChange: "transform",
                }}
              >
                {visible.map((tag, idx) => {
                  const key =
                    tag.id ?? tag.TagName ?? `row-${firstIndex + idx}`;

                  const tooltipLines: string[] = [];
                  if (tag.TagName) tooltipLines.push(String(tag.TagName));
                  if (tag.path) tooltipLines.push(String(tag.path));
                  if (tag.description)
                    tooltipLines.push(String(tag.description));
                  const tooltip = tooltipLines.join("\n");

                  const tableName =
                    (tag.table_name ??
                      tag.source_table ??
                      tag.table ??
                      "") as string;

                  return (
                    <div
                      key={key}
                      className={styles.tagItem}
                      draggable
                      onDragStart={(e) => handleDragStart(e, tag, addType)}
                      onClick={() => handleClickTag(tag)}
                      title={tooltip || "Добавить тег"}
                      style={{ height: ITEM_HEIGHT }}
                    >
                      <div className={styles.tagInfo}>
                        <span className={styles.tagName}>{tag.TagName}</span>
                        {tag.description && (
                          <span className={styles.tagDescription}>
                            {tag.description}
                          </span>
                        )}
                        {tableName && (
                          <span className={styles.tagMeta}>
                            <span>{tableName}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {loading && tags.length > 0 && (
              <div className={styles.loadingMore}>Загружаем ещё…</div>
            )}
          </div>

          <div className={styles.footerNote}>
            Кликните по тегу или перетащите его на рабочую область.
          </div>
        </div>
      )}
    </div>
  );
};

export default ScadaTagSidebar;
