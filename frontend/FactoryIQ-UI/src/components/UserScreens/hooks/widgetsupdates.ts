// src/components/UserScreens/hooks/widgetsupdates.ts
import { useEffect, useRef } from "react";
import dayjs from "dayjs";
import { useApi } from "../../../shared/useApi";

export interface TrendPoint {
  timestamp: string;
  value: number | null;
}

type MultiData = Record<string, TrendPoint[]>;

interface UseTrendsAutoUpdateArgs {
  serverName?: string | null;
  tags: string[];
  rangeHours?: number;
  setMultiData: React.Dispatch<React.SetStateAction<MultiData>>;
  intervalMinutes?: number;
  intervalMs?: number; // шаг усреднения
  enabled?: boolean;   // можно выключать снаружи
}

// формат для SQL Server (без T и Z)
const toSqlLocal = (d: Date | string | number) =>
  dayjs(d).format("YYYY-MM-DD HH:mm:ss");

// нормализуем since к "YYYY-MM-DD HH:mm:ss"
const normalizeSince = (s?: string | null) => {
  if (!s) return null;
  const cleaned = String(s).replace("T", " ").replace("Z", "").trim();
  return cleaned.length >= 19 ? cleaned.slice(0, 19) : cleaned;
};

export const useTrendsAutoUpdate = ({
  serverName,
  tags,
  rangeHours = 8,
  setMultiData,
  intervalMinutes = 4,
  intervalMs = 180000,
  enabled = true,
}: UseTrendsAutoUpdateArgs) => {
  const api = useApi();

  const intervalIdRef = useRef<number | null>(null);
  const lastTsMapRef = useRef<Record<string, string | null>>({});
  const runningRef = useRef(false);

  useEffect(() => {
    if (
      !enabled ||
      !serverName ||
      !Array.isArray(tags) ||
      tags.length === 0
    ) {
      // если нет сервера/тегов — чистим данные и таймер
      setMultiData({});
      lastTsMapRef.current = {};
      if (intervalIdRef.current !== null) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const fetchOnce = async () => {
      if (runningRef.current) return;
      runningRef.current = true;

      try {
        const now = new Date();
        const start = new Date(
          now.getTime() - (rangeHours || 8) * 3600 * 1000
        );

        await Promise.all(
          tags.map(async (t) => {
            const since = lastTsMapRef.current[t] || null;

            const params: Record<string, any> = {
              tag_name: t,
              server_name: serverName,
              start_date: toSqlLocal(start),
              end_date: toSqlLocal(now),
              interval_ms: intervalMs,
            };
            if (since) params.since = normalizeSince(since);

            // useApi возвращает сразу payload, поэтому тип any и без res.data
            const res = await api.get<any>("/trend", { params });

            const raw: TrendPoint[] = Array.isArray(res?.data)
              ? res.data
              : Array.isArray(res)
              ? (res as TrendPoint[])
              : Array.isArray(res?.items)
              ? res.items
              : [];

            const fresh: TrendPoint[] = (raw || []).map((d) => ({
              timestamp: d.timestamp,
              value:
                d.value !== undefined && d.value !== null
                  ? Number(d.value)
                  : null,
            }));

            if (cancelled) return;

            setMultiData((prev) => {
              const existed = prev[t] || [];
              const seen = new Set(existed.map((x) => x.timestamp));
              const merged = [
                ...existed,
                ...fresh.filter((x) => !seen.has(x.timestamp)),
              ];

              const cutoff = dayjs(now).subtract(
                rangeHours || 8,
                "hour"
              );
              const trimmed = merged.filter((x) =>
                dayjs(
                  x.timestamp
                    .replace("T", " ")
                    .replace("Z", "")
                ).isAfter(cutoff)
              );

              if (trimmed.length) {
                lastTsMapRef.current[t] =
                  trimmed[trimmed.length - 1].timestamp;
              }

              return { ...prev, [t]: trimmed };
            });
          })
        );
      } catch {
        // при ошибке график не опустошаем
      } finally {
        runningRef.current = false;
      }
    };

    // первый запрос сразу
    fetchOnce();
    // дальнейший опрос по таймеру
    const intervalId = window.setInterval(
      fetchOnce,
      intervalMinutes * 60 * 1000
    );
    intervalIdRef.current = intervalId;

    return () => {
      cancelled = true;
      if (intervalIdRef.current !== null) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      runningRef.current = false;
    };
  }, [
    api,
    serverName,
    enabled,
    rangeHours,
    intervalMinutes,
    intervalMs,
    setMultiData,
    // tags — через строку, чтобы не ловить бесконечные эффекты
    JSON.stringify(tags),
  ]);
};

export default useTrendsAutoUpdate;
