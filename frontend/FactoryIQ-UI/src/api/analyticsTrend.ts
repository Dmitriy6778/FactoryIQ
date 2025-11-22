// src/api/analyticsTrend.ts
import { useApi } from "../shared/useApi";

export interface TrendPoint {
  tag_name: string;
  value: number | null;
  timestamp: string;
  quality: number | string | null;
}

export interface TrendResponse {
  message: string;
  data: TrendPoint[];
}

export function useTrendApi() {
  const api = useApi();

  return {
    // тех. тренд (sp_GetSensorTrend_Custom)
    fetchSensorTrendTech: (params: {
      tag_name: string;
      server_name: string;
      start_date: string;
      end_date: string;
      interval_ms?: number;
    }) =>
      api.get<TrendResponse>("/sensor-trend-tech", {
        tag_name: params.tag_name,
        server_name: params.server_name,
        start_date: params.start_date,
        end_date: params.end_date,
        ...(params.interval_ms ? { interval_ms: params.interval_ms } : {}),
      }),

    // общий тренд (api_GetOrLoad_Trend)
    fetchTrend: (params: {
      tag_name: string;
      server_name: string;
      start_date: string;
      end_date: string;
      interval_ms?: number;
      since?: string;
    }) =>
      api.get<TrendResponse>("/trend", {
        tag_name: params.tag_name,
        server_name: params.server_name,
        start_date: params.start_date,
        end_date: params.end_date,
        ...(params.interval_ms ? { interval_ms: params.interval_ms } : {}),
        ...(params.since ? { since: params.since } : {}),
      }),
  };
}
