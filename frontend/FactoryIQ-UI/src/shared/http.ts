// client/src/shared/http.ts
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Универсальное определение API_BASE.
 * Dev: localhost:5173 → http://localhost:8000
 * Prod: любой другой origin → https://origin/api
 * Если в env задан VITE_API_BASE и он не localhost → используем его.
 */
function inferApiBase(): string {
  const raw = (import.meta as any).env?.VITE_API_BASE;
  const envBase = raw ? String(raw).trim() : "";

  // Если явно задан адрес и он НЕ localhost — используем его как абсолютный.
  if (
    envBase &&
    !envBase.startsWith("http://localhost") &&
    !envBase.startsWith("https://localhost")
  ) {
    return envBase;
  }

  if (typeof window !== "undefined") {
    const { hostname, port, origin } = window.location;

    // DEV (vite): localhost:5173 → backend на 8000
    if (hostname === "localhost" && port === "5173") {
      return "http://localhost:8000";
    }

    // PROD: всегда "текущий origin + /api"
    return `${origin}/api`;
  }

  // fallback
  return "/api";
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
    try {
      detail = await res.json();
    } catch {}
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
