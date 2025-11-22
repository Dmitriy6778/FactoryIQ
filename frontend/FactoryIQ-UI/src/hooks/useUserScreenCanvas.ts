// src/hooks/useUserScreenCanvas.ts
import { useEffect, useState, useCallback } from "react";
import {
  useUserScreensApi,
  ScreenMeta,
  ScreenObject,
  ScreenObjectItemInput,
} from "../api/userScreens";
import {
  useTagSettingsApi,
  TagSettingsMap,
} from "../api/tagSettings";

interface UseUserScreenCanvasOptions {
  screenId: number;
}

export function useUserScreenCanvas({ screenId }: UseUserScreenCanvasOptions) {
  const {
    fetchScreenMeta,
    fetchScreenObjectsById,
    saveScreenObjectsBulk,
  } = useUserScreensApi();
  const {
    fetchTagSettingsBatch,
    saveTagSettings,
  } = useTagSettingsApi();

  const [meta, setMeta] = useState<ScreenMeta | null>(null);
  const [objects, setObjects] = useState<ScreenObject[]>([]);
  const [tagSettings, setTagSettings] = useState<TagSettingsMap>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const m = await fetchScreenMeta(screenId);
        if (cancelled) return;
        setMeta(m);

        const objs = await fetchScreenObjectsById(screenId);
        if (cancelled) return;
        setObjects(objs);

        const tagIds = objs
          .filter((o) => o.Type === "tag")
          .map((o) => o.ObjectName);

        if (tagIds.length && m.server_id && m.screen_name) {
          const settings = await fetchTagSettingsBatch({
            serverId: m.server_id,
            screenName: m.screen_name,
            tags: tagIds,
          });
          if (cancelled) return;
          setTagSettings(settings);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || "Ошибка загрузки экрана");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [screenId, fetchScreenMeta, fetchScreenObjectsById, fetchTagSettingsBatch]);

  const saveLayout = useCallback(
    async (items: ScreenObjectItemInput[], deleteMissing = false) => {
      if (!meta?.server_id || !meta?.screen_name) return;
      try {
        setSaving(true);
        setError(null);

        await saveScreenObjectsBulk({
          server_id: meta.server_id,
          screen_name: meta.screen_name,
          items,
          delete_missing: deleteMissing,
        });

        const objs = await fetchScreenObjectsById(screenId);
        setObjects(objs);
      } catch (e: any) {
        setError(e.message || "Ошибка сохранения расположения");
      } finally {
        setSaving(false);
      }
    },
    [meta, screenId, saveScreenObjectsBulk, fetchScreenObjectsById]
  );

  const toggleLabel = useCallback(
    async (objectName: string) => {
      if (!meta?.server_id || !meta?.screen_name) return;
      const current = tagSettings[objectName] || {
        ShowLabel: 0,
        ShowTagName: 0,
      };
      const next = { ...current, ShowLabel: current.ShowLabel ? 0 : 1 };

      await saveTagSettings({
        ServerId: meta.server_id,
        ScreenName: meta.screen_name,
        ObjectName: objectName,
        ShowLabel: !!next.ShowLabel,
        ShowTagName: !!next.ShowTagName,
      });

      setTagSettings((prev) => ({
        ...prev,
        [objectName]: next,
      }));
    },
    [meta, tagSettings, saveTagSettings]
  );

  const toggleTagName = useCallback(
    async (objectName: string) => {
      if (!meta?.server_id || !meta?.screen_name) return;
      const current = tagSettings[objectName] || {
        ShowLabel: 0,
        ShowTagName: 0,
      };
      const next = { ...current, ShowTagName: current.ShowTagName ? 0 : 1 };

      await saveTagSettings({
        ServerId: meta.server_id,
        ScreenName: meta.screen_name,
        ObjectName: objectName,
        ShowLabel: !!next.ShowLabel,
        ShowTagName: !!next.ShowTagName,
      });

      setTagSettings((prev) => ({
        ...prev,
        [objectName]: next,
      }));
    },
    [meta, tagSettings, saveTagSettings]
  );

  return {
    meta,
    objects,
    tagSettings,
    loading,
    saving,
    error,
    saveLayout,
    toggleLabel,
    toggleTagName,
  };
}
