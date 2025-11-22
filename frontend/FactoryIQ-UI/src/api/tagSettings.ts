// src/api/tagSettings.ts
import { useApi } from "../shared/useApi";

export interface TagSettings {
  ShowLabel: number;    // 0/1
  ShowTagName: number;  // 0/1
  UserId?: number;
}

export type TagSettingsMap = Record<
  string,
  {
    ShowLabel: number;
    ShowTagName: number;
  }
>;

export function useTagSettingsApi() {
  const api = useApi();

  return {
    // upsert одной записи
    saveTagSettings: (payload: {
      ServerId: number;
      ScreenName: string;
      ObjectName: string;
      ShowLabel?: boolean | number | string;
      ShowTagName?: boolean | number | string;
    }) => api.post<{ ok: boolean }>("/tag-settings", payload),

    // batch
    fetchTagSettingsBatch: (payload: {
      serverId: number;
      screenName: string;
      tags: string[];
    }) => api.post<TagSettingsMap>("/tag-settings/batch", payload),

    // получить одну (через query)
    fetchTagSettings: (params: {
      ServerId: number;
      ScreenName: string;
      ObjectName: string;
    }) =>
      api.get<TagSettings>("/tag-settings", {
        ServerId: params.ServerId,
        ScreenName: params.ScreenName,
        ObjectName: params.ObjectName,
      }),

    // переименование метки
    renameScreenObject: (payload: {
      object_name: string;
      new_label: string;
      server_id: number;
      screen_name: string;
    }) => api.put<{ message: string }>("/screen-objects/rename", payload),

    // удаление по screen_name / object_name
    deleteScreenObject: (params: {
      screen_name: string;
      object_name: string;
      server_id?: number;
    }) =>
      api.del<{ message: string }>(
        `/screen-objects/${encodeURIComponent(
          params.screen_name
        )}/${encodeURIComponent(params.object_name)}${
          params.server_id ? `?server_id=${params.server_id}` : ""
        }`
      ),
  };
}
