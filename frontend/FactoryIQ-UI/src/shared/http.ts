// client/src/shared/http.ts
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function inferApiBase(): string {
  const envBase = (import.meta as any).env?.VITE_API_BASE?.trim();
  if (envBase) return envBase;
  if (typeof window !== "undefined") {
    // dev-эвристика: если запущено с Vite на 5173 — считаем API на 8000
    if (window.location.port === "5173") return "http://localhost:8000";
  }
  // пустая база — fetch будет по относительным путям (ровно как передал)
  return "";
}

const API_BASE = inferApiBase();

function joinUrl(base: string, path: string) {
  if (!base) return path;
  if (!path) return base;
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

  const url = joinUrl(API_BASE, path);

  const res = await fetch(url, {
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
  return (ct.includes("application/json")
    ? await res.json()
    : (await res.text())) as T;
}
