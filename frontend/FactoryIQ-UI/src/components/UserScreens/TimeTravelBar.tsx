// src/components/UserScreens/TimeTravelBar.tsx
import React, { useMemo } from "react";
import { DatePicker, Slider, Button, InputNumber, Tooltip, Space } from "antd";
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  FieldTimeOutlined,
} from "@ant-design/icons";
import { useTimeContext } from "./TimeContext";
import dayjs, { Dayjs } from "dayjs";

const { RangePicker } = DatePicker;

const TimeTravelBar: React.FC = () => {
  const {
    mode,
    range,
    cursor,
    windowMinutes,
    setMode,
    setRange,
    setCursor,
    setWindowMinutes,
  } = useTimeContext();

  const min = range.from ? range.from.getTime() : null;
  const max = range.to ? range.to.getTime() : null;

  const sliderValue = useMemo(() => {
    if (!min || !max || !cursor) return 0;
    if (max === min) return 0;
    const cur = cursor.getTime();
    const pct = ((cur - min) / (max - min)) * 100;
    return Math.min(100, Math.max(0, Math.round(pct)));
  }, [min, max, cursor]);

  const handleSliderChange = (val: number) => {
    if (!min || !max) return;
    const ts = min + ((max - min) * val) / 100;
    setCursor(new Date(ts));
  };

  // важное изменение — сигнатура совместима с onChange RangePicker
  const handleRangeChange = (
    vals: [Dayjs | null, Dayjs | null] | null,
    _dateStrings: [string, string]
  ) => {
    if (!vals || vals.length !== 2 || !vals[0] || !vals[1]) {
      setRange({ from: null, to: null });
      setCursor(null);
      return;
    }

    const from = vals[0].toDate();
    const to = vals[1].toDate();
    setRange({ from, to });

    // если курсор вне диапазона — ставим в начало
    if (!cursor || cursor < from || cursor > to) {
      setCursor(from);
    }
  };

  const canReplay = !!(range.from && range.to);

  return (
    <div
      style={{
        borderTop: "1px solid #e0e6f5",
        padding: "6px 12px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#f8faff",
      }}
    >
      <Space align="center">
        <FieldTimeOutlined style={{ color: "#1976d2" }} />
        <b>Временная шкала</b>
      </Space>

      <RangePicker
        showTime
        allowClear
        size="small"
        style={{ minWidth: 320 }}
        value={
          range.from && range.to
            ? [dayjs(range.from), dayjs(range.to)]
            : null
        }
        onChange={handleRangeChange}
      />

      <span style={{ whiteSpace: "nowrap" }}>Окно, мин:</span>
      <InputNumber
        min={1}
        max={1440}
        size="small"
        value={windowMinutes}
        onChange={(v) => setWindowMinutes(Number(v) || 60)}
        style={{ width: 70 }}
      />

      <div style={{ flex: 1, padding: "0 8px" }}>
        <Slider
          min={0}
          max={100}
          value={sliderValue}
          onChange={handleSliderChange}
          disabled={!canReplay || mode === "live"}
        />
        <div
          style={{
            fontSize: 11,
            opacity: 0.7,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {range.from ? range.from.toLocaleString() : "Начало не задано"}
          </span>
          <span>
            {cursor
              ? cursor.toLocaleString()
              : canReplay
              ? "Курсор не выбран"
              : ""}
          </span>
          <span>{range.to ? range.to.toLocaleString() : "Конец не задан"}</span>
        </div>
      </div>

      <Space>
        <Tooltip title="Живые данные">
          <Button
            size="small"
            type={mode === "live" ? "primary" : "default"}
            onClick={() => setMode("live")}
          >
            Live
          </Button>
        </Tooltip>

        <Tooltip title="Режим просмотра архива">
          <Button
            size="small"
            type={mode === "range" ? "primary" : "default"}
            disabled={!canReplay}
            onClick={() => setMode("range")}
          >
            Archive
          </Button>
        </Tooltip>

        {/* Шаг назад */}
        <Tooltip title="Шаг назад">
          <Button
            size="small"
            icon={<StepBackwardOutlined />}
            disabled={mode !== "range" || !cursor || !min || !max}
            onClick={() => {
              if (!cursor || !min || !max) return;
              const stepMs = (windowMinutes || 60) * 60 * 1000;
              const next = new Date(cursor.getTime() - stepMs);
              setCursor(next < range.from! ? range.from! : next);
            }}
          />
        </Tooltip>

        {/* Шаг вперёд */}
        <Tooltip title="Шаг вперёд">
          <Button
            size="small"
            icon={<StepForwardOutlined />}
            disabled={mode !== "range" || !cursor || !min || !max}
            onClick={() => {
              if (!cursor || !min || !max) return;
              const stepMs = (windowMinutes || 60) * 60 * 1000;
              const next = new Date(cursor.getTime() + stepMs);
              setCursor(next > range.to! ? range.to! : next);
            }}
          />
        </Tooltip>

        {/* Плей/пауза — задел на будущее, пока выключено */}
        <Tooltip title="(на будущее) Автовоспроизведение">
          <Button
            size="small"
            icon={
              mode === "range" ? (
                <PauseCircleOutlined />
              ) : (
                <PlayCircleOutlined />
              )
            }
            disabled
          />
        </Tooltip>
      </Space>
    </div>
  );
};

export default TimeTravelBar;
