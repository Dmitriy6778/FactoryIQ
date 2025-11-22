// src/components/UserScreens/ResizableTagLabel.tsx
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  MouseEvent as ReactMouseEvent,
  SyntheticEvent,
} from "react";
import Draggable, {
  DraggableData,
  DraggableEvent,
} from "react-draggable";
import { ResizableBox } from "react-resizable";
import type { ResizeCallbackData } from "react-resizable";
import "react-resizable/css/styles.css";
import { createPortal } from "react-dom";

import type { TagStyle } from "./UserScreensModule";

/* ====== Типы, завязанные на TagStyle ====== */

type TagStylePatch = Partial<TagStyle>;
type TagStyleFull = TagStyle;

type Size = {
  width: number;
  height: number;
};

export interface ResizableTagLabelProps {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;

  mainLabel?: string;
  tagName?: string;
  value?: string | number | null | undefined;
  unit?: string;

  editable?: boolean;
  showLabel?: boolean;
  showTagName?: boolean;

  onMove?: (id: string, pos: { x: number; y: number }) => void;
  onResizeStop?: (id: string, size: Size) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;

  /** Полный стиль тега из UserScreensModule (widget.style) */
  initialStyle?: TagStylePatch;
  /** Локальное изменение стиля одного тега */
  onStyleChange?: (id: string, patch: TagStylePatch) => void;
  /** Применить текущие стили ко всем тегам на экране */
  onApplyStyleToAll?: (patch: TagStylePatch) => void;
}

/* ====== Константы размеров ====== */
const defaultLabelStyle = {
  width: 200,
  height: 80,
  minWidth: 120,
  minHeight: 50,
  maxWidth: 600,
  maxHeight: 200,
} as const;

/* ====== Утилиты ====== */
const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

const asNum = (v: unknown, d: number = 0): number => {
  const num = Number(v);
  return Number.isFinite(num) ? num : d;
};

/**
 * Индикатор-метка с перетаскиванием/ресайзом и настройками.
 * Работает поверх TagStyle из UserScreensModule.
 */
const ResizableTagLabel: React.FC<ResizableTagLabelProps> = ({
  id,
  x,
  y,
  width,
  height,
  mainLabel = "Метка",
  tagName = "",
  value = "",
  unit = "",
  editable = true,
  onMove,
  onResizeStop,
  onContextMenu,
  showLabel = true,
  showTagName = true,
  initialStyle = {},
  onStyleChange,
  onApplyStyleToAll,
}) => {
  /* ====== Local state ====== */
  const [size, setSize] = useState<Size>({
    width: width ?? defaultLabelStyle.width,
    height: height ?? defaultLabelStyle.height,
  });

  const nodeRef = useRef<HTMLDivElement | null>(null);

  const [styleCfg, setStyleCfg] = useState<TagStyleFull>({
    bgColor: initialStyle.bgColor ?? "#f3f9fe",
    textColor: initialStyle.textColor ?? "#234060",
    valueColor: initialStyle.valueColor ?? "#1976d2",
    headerFontPx: initialStyle.headerFontPx ?? 16,
    valueFontPx: initialStyle.valueFontPx ?? 28,
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showGear, setShowGear] = useState(false);

  // позиция портальной панели
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const panelWidth = 260;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);

  /* ====== Синхронизация входных размеров/стилей ====== */
  useEffect(() => {
    setSize({
      width: width ?? defaultLabelStyle.width,
      height: height ?? defaultLabelStyle.height,
    });
  }, [width, height]);

  useEffect(() => {
    setStyleCfg((prev) => ({
      ...prev,
      bgColor: initialStyle.bgColor ?? prev.bgColor,
      textColor: initialStyle.textColor ?? prev.textColor,
      valueColor: initialStyle.valueColor ?? prev.valueColor,
      headerFontPx: initialStyle.headerFontPx ?? prev.headerFontPx,
      valueFontPx: initialStyle.valueFontPx ?? prev.valueFontPx,
    }));
  }, [
    initialStyle.bgColor,
    initialStyle.textColor,
    initialStyle.valueColor,
    initialStyle.headerFontPx,
    initialStyle.valueFontPx,
  ]);

  /* ====== Позиционирование портальной панели ====== */
  const updatePanelPosition = useCallback(() => {
    if (!nodeRef.current) return;
    const rect = nodeRef.current.getBoundingClientRect();
    const top = Math.max(8, rect.top + 32);
    const left = Math.min(
      window.innerWidth - panelWidth - 8,
      rect.right - panelWidth - 6
    );
    setPanelPos({ top, left });
  }, []);

  const updatePanelPositionRaf = useCallback(() => {
    if (!settingsOpen) return;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      updatePanelPosition();
    });
  }, [settingsOpen, updatePanelPosition]);

  /* ====== Закрытие панели: ESC + клик вне ====== */
  useEffect(() => {
    if (!settingsOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && panelRef.current.contains(e.target as Node)) return;
      setSettingsOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [settingsOpen]);

  /* ====== Сохранение стилей ====== */
  const applyLocal = (patch: TagStylePatch, applyAll = false) => {
    const next: TagStyleFull = { ...styleCfg, ...patch };
    setStyleCfg(next);

    if (applyAll && onApplyStyleToAll) {
      onApplyStyleToAll(patch);
    } else if (onStyleChange) {
      onStyleChange(id, patch);
    }
  };

  const commitHeader = (v: string | number, applyAll = false) =>
    applyLocal(
      {
        headerFontPx: clamp(Math.round(Number(v) || 16), 10, 36),
      },
      applyAll
    );

  const commitValue = (v: string | number, applyAll = false) =>
    applyLocal(
      {
        valueFontPx: clamp(Math.round(Number(v) || 28), 12, 72),
      },
      applyAll
    );

  /* ====== Handlers: Drag/Resize ====== */
  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    if (editable && onMove) onMove(id, { x: data.x, y: data.y });
    updatePanelPositionRaf();
  };

  const handleDrag = () => {
    updatePanelPositionRaf();
  };

  const handleResizeStop = (
    _e: SyntheticEvent<Element>,
    data: ResizeCallbackData
  ) => {
    const w = asNum(data.size?.width, size.width);
    const h = asNum(data.size?.height, size.height);
    const norm: Size = {
      width: clamp(w, defaultLabelStyle.minWidth, defaultLabelStyle.maxWidth),
      height: clamp(h, defaultLabelStyle.minHeight, defaultLabelStyle.maxHeight),
    };
    setSize(norm);
    if (editable && onResizeStop) onResizeStop(id, norm);
    updatePanelPositionRaf();
  };

  /* ====== Тексты и размеры шрифтов ====== */
  const displayLabel = showLabel ? mainLabel : "";
  const displayTag = showTagName ? (tagName || id) : "";

  const headerFontSize = Math.max(10, Number(styleCfg.headerFontPx) || 16);
  const valueFontSize = Math.max(12, Number(styleCfg.valueFontPx) || 28);
  const unitFontSize = Math.round(valueFontSize * 0.7);

  const hasDragHandle = Boolean(displayLabel || displayTag);
  const onlyValueMode = !hasDragHandle;

  const valueStr =
    value === null || value === undefined
      ? "Нет данных"
      : typeof value === "string"
      ? value
      : String(value);

  /* ====== Рендер ====== */
  return (
    <Draggable
      nodeRef={nodeRef}
      bounds="parent"
      disabled={!editable}
      handle={hasDragHandle ? ".draggable-handle" : undefined}
      position={{ x: asNum(x), y: asNum(y) }}
      onStop={handleStop}
      onDrag={handleDrag}
    >
      <div
        ref={nodeRef}
        style={{ position: "absolute", zIndex: 2 }}
        onContextMenu={onContextMenu}
      >
        <ResizableBox
          width={size.width}
          height={size.height}
          minConstraints={[
            defaultLabelStyle.minWidth,
            defaultLabelStyle.minHeight,
          ]}
          maxConstraints={[
            defaultLabelStyle.maxWidth,
            defaultLabelStyle.maxHeight,
          ]}
          resizeHandles={editable ? ["se"] : []}
          onResizeStop={editable ? handleResizeStop : undefined}
          handle={
            editable ? (
              <span
                style={{
                  position: "absolute",
                  right: 8,
                  bottom: 4,
                  cursor: "se-resize",
                  color: "#b4b4b4",
                  fontSize: 18,
                  zIndex: 10,
                  userSelect: "none",
                }}
              >
                ⤡
              </span>
            ) : null
          }
          style={{
            borderRadius: 14,
            border: "1.5px solid #dde7fa",
            background: styleCfg.bgColor,
            boxShadow: "0 2px 10px rgba(34, 90, 170, 0.06)",
            padding: 0,
            userSelect: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: size.width,
            height: size.height,
            position: "relative",
          }}
        >
          {/* “горячая зона” под шестерёнку */}
          {editable && (
            <div
              onMouseEnter={() => setShowGear(true)}
              onMouseLeave={() => setShowGear(false)}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: 28,
                height: 28,
                background: "transparent",
                zIndex: 15,
              }}
            >
              {(showGear || settingsOpen) && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettingsOpen((v) => {
                      const next = !v;
                      if (next) updatePanelPosition();
                      return next;
                    });
                  }}
                  title="Настройки индикатора"
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    border: "1px solid #cfd8ea",
                    background: "#ffffffd8",
                    cursor: "pointer",
                    fontSize: 12,
                    display: "grid",
                    placeItems: "center",
                    lineHeight: 1,
                    zIndex: 16,
                  }}
                >
                  ⚙
                </button>
              )}
            </div>
          )}

          {/* Панель настроек — портал, всегда поверх */}
          {editable &&
            settingsOpen &&
            createPortal(
              <div
                ref={panelRef}
                style={{
                  position: "fixed",
                  top: panelPos.top,
                  left: panelPos.left,
                  zIndex: 2147483647,
                  width: panelWidth,
                  background: "#fff",
                  border: "1px solid #dbe4f5",
                  boxShadow: "0 6px 18px rgba(22, 40, 80, 0.12)",
                  borderRadius: 10,
                  padding: "10px 12px",
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    marginBottom: 8,
                    color: "#234060",
                  }}
                >
                  Настройки индикатора
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  {/* Цвет фона */}
                  <label
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "#324a68",
                      }}
                    >
                      Фон
                    </span>
                    <input
                      type="color"
                      value={styleCfg.bgColor}
                      onChange={(e) =>
                        setStyleCfg((s) => ({
                          ...s,
                          bgColor: e.target.value,
                        }))
                      }
                      onBlur={(e) =>
                        applyLocal({ bgColor: e.target.value })
                      }
                      style={{
                        width: 36,
                        height: 22,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    />
                  </label>

                  {/* Цвет текста */}
                  <label
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "#324a68",
                      }}
                    >
                      Цвет текста
                    </span>
                    <input
                      type="color"
                      value={styleCfg.textColor}
                      onChange={(e) =>
                        setStyleCfg((s) => ({
                          ...s,
                          textColor: e.target.value,
                        }))
                      }
                      onBlur={(e) =>
                        applyLocal({ textColor: e.target.value })
                      }
                      style={{
                        width: 36,
                        height: 22,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    />
                  </label>

                  {/* Цвет значения */}
                  <label
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "#324a68",
                      }}
                    >
                      Цвет значения
                    </span>
                    <input
                      type="color"
                      value={styleCfg.valueColor}
                      onChange={(e) =>
                        setStyleCfg((s) => ({
                          ...s,
                          valueColor: e.target.value,
                        }))
                      }
                      onBlur={(e) =>
                        applyLocal({ valueColor: e.target.value })
                      }
                      style={{
                        width: 36,
                        height: 22,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    />
                  </label>

                  {/* Размер заголовка/имени */}
                  <div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: "#324a68",
                        }}
                      >
                        Размер заголовка/имени
                      </span>
                      <strong style={{ fontSize: 12 }}>
                        {styleCfg.headerFontPx}px
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={36}
                      value={styleCfg.headerFontPx}
                      onChange={(e) =>
                        setStyleCfg((s) => ({
                          ...s,
                          headerFontPx: clamp(
                            Math.round(Number(e.target.value)) || 16,
                            10,
                            36
                          ),
                        }))
                      }
                      onMouseUp={(e) =>
                        commitHeader(e.currentTarget.value)
                      }
                      onTouchEnd={(e) =>
                        commitHeader(e.currentTarget.value)
                      }
                      style={{ width: "100%" }}
                    />
                  </div>

                  {/* Размер значения */}
                  <div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: "#324a68",
                        }}
                      >
                        Размер значения
                      </span>
                      <strong style={{ fontSize: 12 }}>
                        {styleCfg.valueFontPx}px
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={12}
                      max={72}
                      value={styleCfg.valueFontPx}
                      onChange={(e) =>
                        setStyleCfg((s) => ({
                          ...s,
                          valueFontPx: clamp(
                            Math.round(Number(e.target.value)) || 28,
                            12,
                            72
                          ),
                        }))
                      }
                      onMouseUp={(e) =>
                        commitValue(e.currentTarget.value)
                      }
                      onTouchEnd={(e) =>
                        commitValue(e.currentTarget.value)
                      }
                      style={{ width: "100%" }}
                    />
                  </div>

                  {/* Применить ко всем */}
                  {typeof onApplyStyleToAll === "function" && (
                    <button
                      type="button"
                      onClick={() =>
                        onApplyStyleToAll({
                          bgColor: styleCfg.bgColor,
                          textColor: styleCfg.textColor,
                          valueColor: styleCfg.valueColor,
                          headerFontPx: clamp(
                            styleCfg.headerFontPx,
                            10,
                            36
                          ),
                          valueFontPx: clamp(
                            styleCfg.valueFontPx,
                            12,
                            72
                          ),
                        })
                      }
                      style={{
                        marginTop: 4,
                        width: "100%",
                        height: 28,
                        borderRadius: 8,
                        border: "1px solid #cfd8ea",
                        background: "#f7faff",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#234060",
                      }}
                      title="Применить текущие стили ко всем индикаторам на этом экране"
                    >
                      Применить всем на экране
                    </button>
                  )}
                </div>
              </div>,
              document.body
            )}

          {/* Контент индикатора */}
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: onlyValueMode ? "center" : "flex-start",
              paddingTop: onlyValueMode ? 0 : 8,
              paddingBottom: onlyValueMode ? 0 : 8,
            }}
          >
            {/* Заголовок (handle для drag) */}
            {displayLabel && (
              <div
                className="draggable-handle"
                style={{
                  fontWeight: 600,
                  color: styleCfg.textColor,
                  fontSize: headerFontSize,
                  textAlign: "center",
                  width: "100%",
                  cursor: editable ? "move" : "default",
                  userSelect: "none",
                  lineHeight: 1.15,
                  height: headerFontSize + 10,
                  pointerEvents: "auto",
                }}
              >
                {displayLabel}
              </div>
            )}

            {/* Имя тега */}
            {displayTag && (
              <div
                style={{
                  fontSize: headerFontSize,
                  color: styleCfg.textColor + "CC",
                  marginTop: 1,
                  marginBottom: 2,
                  fontWeight: 500,
                  textAlign: "center",
                }}
              >
                {displayTag}
              </div>
            )}

            {/* Значение + единица */}
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "center",
                marginTop: onlyValueMode ? 0 : 6,
                flex: onlyValueMode ? 1 : "unset",
              }}
            >
              <span
                style={{
                  fontSize: valueFontSize,
                  color: styleCfg.valueColor,
                  fontWeight: "bold",
                  letterSpacing: 1.2,
                  lineHeight: 1,
                  textAlign: "center",
                }}
              >
                {valueStr}
              </span>
              {unit && (
                <span
                  style={{
                    fontSize: unitFontSize,
                    marginLeft: 5,
                    color: styleCfg.valueColor,
                    opacity: 0.85,
                    fontWeight: 500,
                  }}
                >
                  {unit}
                </span>
              )}
            </div>
          </div>
        </ResizableBox>
      </div>
    </Draggable>
  );
};

export default ResizableTagLabel;
