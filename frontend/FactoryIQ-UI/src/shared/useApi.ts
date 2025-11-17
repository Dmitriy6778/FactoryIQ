import { useMemo } from "react";
import { useAuth } from "../components/Auth/AuthContext";
import { http, buildQuery } from "./http";

export function useApi() {
    const { token } = useAuth();

    // ВОТ ЭТО ГЛАВНОЕ: api-объект стабилен между рендерами
    return useMemo(() => {
        return {
            get: <T = any>(path: string, params?: Record<string, any>) =>
                http<T>(path + (params ? buildQuery(params) : ""), "GET", { token }),
            post: <T = any>(path: string, body?: any) =>
                http<T>(path, "POST", { token, body }),
            put: <T = any>(path: string, body?: any) =>
                http<T>(path, "PUT", { token, body }),
            patch: <T = any>(path: string, body?: any) =>
                http<T>(path, "PATCH", { token, body }),
            del: <T = any>(path: string, body?: any) =>
                http<T>(path, "DELETE", { token, body }),
            buildQuery,
        };
    }, [token]);
}
