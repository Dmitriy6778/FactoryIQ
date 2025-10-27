// client/src/shared/http.ts
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const API_BASE = (import.meta as any).env?.VITE_API_BASE || "";

function joinUrl(base: string, path: string) {
    if (!base) return path;
    if (base.endsWith("/") && path.startsWith("/")) return base.slice(0, -1) + path;
    if (!base.endsWith("/") && !path.startsWith("/")) return base + "/" + path;
    return base + path;
}

export function buildQuery(params?: Record<string, any>) {
    if (!params) return "";
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        sp.append(k, String(v));
    });
    const s = sp.toString();
    return s ? `?${s}` : "";
}

export async function http<T = any>(
    path: string,
    method: HttpMethod = "GET",
    opts: { token?: string | null; body?: any; headers?: Record<string, string> } = {}
): Promise<T> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
    };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

    const res = await fetch(joinUrl(API_BASE, path), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
        let detail: any = undefined;
        try { detail = await res.json(); } catch { /* ignore */ }
        const err = new Error(`HTTP ${res.status}`);
        (err as any).status = res.status;
        (err as any).detail = detail;
        throw err;
    }

    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") || "";
    return (ct.includes("application/json") ? await res.json() : (await res.text())) as T;
}
