// client/src/components/Auth/AuthContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type User = {
    id: number;
    username: string;
    email?: string | null;
    role?: string | null;
    created_at?: string | null;
};

type AuthState = {
    isAuthenticated: boolean;
    loading: boolean;
    user: User | null;
    permissions: string[];
    token: string | null;

    // actions
    login: (params: { username: string; email?: string }) => Promise<void>;
    logout: () => void;
    fetchMe: () => Promise<void>;

    // permission helpers
    hasPerm: (p: string) => boolean;
    hasAny: (list: string[]) => boolean;
    hasAll: (list: string[]) => boolean;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

// --- конфиг API из ENV (никаких хардкодов) ---
const API_BASE = (import.meta as any).env?.VITE_API_BASE || ""; // например: "http://localhost:8000"

// --- хранилище токена ---
const TOKEN_KEY = "fabrIQ_token";

async function apiFetch<T = any>(
    path: string,
    options: RequestInit = {},
    token: string | null = null
): Promise<T> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string> | undefined),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (!resp.ok) {
        // попытаемся отдать тело ошибки если есть
        let detail: any = undefined;
        try {
            detail = await resp.json();
        } catch {
            /* ignore */
        }
        const err = new Error(`HTTP ${resp.status}`);
        (err as any).status = resp.status;
        (err as any).detail = detail;
        throw err;
    }
    // некоторые ручки возвращают пусто
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
}

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
    const [user, setUser] = useState<User | null>(null);
    const [permissions, setPermissions] = useState<string[]>([]);
    const [loading, setLoading] = useState<boolean>(true);

    const isAuthenticated = !!token;

    const saveToken = useCallback((t: string | null) => {
        setToken(t);
        if (t) localStorage.setItem(TOKEN_KEY, t);
        else localStorage.removeItem(TOKEN_KEY);
    }, []);

    const fetchMe = useCallback(async () => {
        if (!token) {
            setUser(null);
            setPermissions([]);
            return;
        }
        try {
            const data = await apiFetch<{ user: User; permissions: string[] }>("/auth/me", {}, token);
            setUser(data.user || null);
            setPermissions(Array.isArray(data.permissions) ? data.permissions : []);
        } catch (e: any) {
            // при 401 — выходим
            if (e?.status === 401) {
                saveToken(null);
                setUser(null);
                setPermissions([]);
            } else {
                // оставляем токен, но очищаем состояние
                console.error("auth/me failed:", e);
            }
        }
    }, [token, saveToken]);

    const login = useCallback(
        async ({ username, email }: { username: string; email?: string }) => {
            const data = await apiFetch<{ access_token: string }>(
                "/auth/login",
                { method: "POST", body: JSON.stringify({ username, email }) },
                null
            );
            saveToken(data.access_token);
            await fetchMe();
        },
        [fetchMe, saveToken]
    );

    const logout = useCallback(() => {
        saveToken(null);
        setUser(null);
        setPermissions([]);
    }, [saveToken]);

    // helper’ы прав
    const hasPerm = useCallback((p: string) => permissions.includes(p), [permissions]);
    const hasAny = useCallback((list: string[]) => list.some((p) => permissions.includes(p)), [permissions]);
    const hasAll = useCallback((list: string[]) => list.every((p) => permissions.includes(p)), [permissions]);

    // первичная загрузка
    useEffect(() => {
        (async () => {
            try {
                if (token) await fetchMe();
            } finally {
                setLoading(false);
            }
        })();
    }, [token, fetchMe]);

    const value = useMemo<AuthState>(
        () => ({
            isAuthenticated,
            loading,
            user,
            permissions,
            token,
            login,
            logout,
            fetchMe,
            hasPerm,
            hasAny,
            hasAll,
        }),
        [isAuthenticated, loading, user, permissions, token, login, logout, fetchMe, hasPerm, hasAny, hasAll]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthState {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}
