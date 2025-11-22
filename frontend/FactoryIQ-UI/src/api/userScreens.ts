// src/api/userScreens.ts
import { useApi } from "../shared/useApi";

export type ScreenObjectType = "tag" | "table" | "analytic" | "chart";

export interface UserScreen {
  ScreenId: number;
  ScreenName: string;
  Title: string;
  Description: string | null;
  IsPublic: boolean;
  IsReadonly: boolean;
  CreatedAt: string;
  BgColor: string | null;
  AreaWidth?: number | null;
  AreaHeight?: number | null;
  UserId: number;
  ServerId?: number | null;
  ServerName?: string;
  OwnerUsername?: string;
}

export interface ScreenMeta {
  screen_id: number;
  screen_name: string;
  title: string;
  description: string | null;
  bg_color: string | null;
  area_width?: number | null;
  area_height?: number | null;
  is_public: boolean;
  is_readonly: boolean;
  created_at: string;
  user_id: number;
  owner_username?: string;
  server_id?: number | null;
  server_name?: string;
  is_owner: boolean;
}

export interface ScreenObject {
  ServerId: number;
  ObjectName: string;
  Label: string;
  X: number;
  Y: number;
  DateCreated: string;
  User_id: number;
  ScreenName: string;
  Type: ScreenObjectType;
  ChartConfig?: string | null;
  Width?: number | null;
  Height?: number | null;
}

export interface ScreenObjectItemInput {
  id: string;
  type?: ScreenObjectType;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  chartConfig?: any;
  settings?: {
    showLabel?: boolean;
    showTagName?: boolean;
  };
}

export interface BulkSavePayload {
  server_id: number;
  screen_name: string;
  items: ScreenObjectItemInput[];
  delete_missing?: boolean;
}

export interface CreateScreenDto {
  title: string;
  description?: string;
  bgColor?: string;
  isPublic?: boolean;
  isReadonly?: boolean;
  serverId?: number;
  screenName?: string;
  areaWidth?: number;
  areaHeight?: number;
}

export function useUserScreensApi() {
  const api = useApi();

  return {
    // список экранов
    fetchUserScreens: () =>
      api.get<UserScreen[]>("/user-screens"),

    // метаданные одного экрана
    fetchScreenMeta: (screenId: number) =>
      api.get<ScreenMeta>(`/user-screens/${screenId}`),

    // создание
    createScreen: (payload: CreateScreenDto) =>
      api.post<UserScreen>("/user-screens", payload),

    // обновление заголовка/описания/цвета
    updateScreen: (
      screenId: number,
      payload: { title?: string; description?: string; bgColor?: string }
    ) => api.put<{ message: string }>(`/user-screens/${screenId}`, payload),

    // удаление
    deleteScreen: (screenId: number) =>
      api.del<{ message: string }>(`/user-screens/${screenId}`),

    // клон
    cloneScreen: (screenId: number) =>
      api.post<{ message: string; ScreenId: number }>(
        `/user-screens/${screenId}/clone`
      ),

    // props: публичность, readonly, размеры, фон
    updateScreenProps: (
      screenId: number,
      payload: {
        is_public?: boolean;
        is_readonly?: boolean;
        area_width?: number;
        area_height?: number;
        bg_color?: string;
      }
    ) => api.put(`/user-screens/${screenId}/props`, payload),

    setScreenPublic: (screenId: number, isPublic: boolean) =>
      api.post(`/user-screens/${screenId}/share`, { isPublic }),

    setScreenReadonly: (screenId: number, isReadonly: boolean) =>
      api.post(`/user-screens/${screenId}/readonly`, { isReadonly }),

    // объекты экрана по id
    fetchScreenObjectsById: (screenId: number) =>
      api.get<ScreenObject[]>(`/user-screens/${screenId}/objects`),

    // объекты по ServerId + ScreenName
    fetchScreenObjectsByName: (serverId: number, screenName: string) =>
      api.get<ScreenObject[]>(
        `/screen-objects/${serverId}/${encodeURIComponent(screenName)}`
      ),

    // bulk сохранение
    saveScreenObjectsBulk: (payload: BulkSavePayload) =>
      api.post<{ status: string; saved: number; deleted: boolean }>(
        "/screen-objects/bulk",
        payload
      ),

    // удалить объект по screen_id + object_name
    deleteObjectByScreenId: (screenId: number, objectName: string) =>
      api.del<{ message: string }>(
        `/user-screens/${screenId}/objects/${encodeURIComponent(objectName)}`
      ),
  };
}
