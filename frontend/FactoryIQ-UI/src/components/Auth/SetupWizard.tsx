// client/src/components/Auth/SetupWizard.tsx
import React, { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { http } from "../../shared/http";

type TokenResponse = { access_token: string; expires_in: number };
type SetupStatus = { users_count: number; initialized: boolean };

function pickErrorMessage(err: any): string {
    const d = err?.detail;
    if (!d) return err?.message || "Неизвестная ошибка";
    if (typeof d === "string") return d;
    if (typeof d?.detail === "string") return d.detail;
    if (typeof d?.error === "string") return d.error;
    if (Array.isArray(d?.detail) && d.detail[0]?.msg) return d.detail[0].msg;
    try { return JSON.stringify(d); } catch { return String(d); }
}

const SetupWizard: React.FC = () => {
    const navigate = useNavigate();
    const { fetchMe } = useAuth();

    const [setupToken, setSetupToken] = useState("");
    const [adminUsername, setAdminUsername] = useState("");
    const [adminEmail, setAdminEmail] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);

    // если уже инициализировано — сразу на login
    useEffect(() => {
        (async () => {
            try {
                const st = await http<SetupStatus>("/auth/setup/status", "GET");
                if (st?.initialized) {
                    navigate("/login", { replace: true });
                }
            } catch {
                // молча — страница всё равно даст сабмит
            }
        })();
    }, [navigate]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!setupToken.trim() || !adminUsername.trim()) {
            setError("Укажите код и имя администратора");
            return;
        }
        setLoading(true);
        setError(null);

        try {
            const resp = await http<TokenResponse>("/auth/setup/bootstrap", "POST", {
                body: {
                    setup_token: setupToken.trim(),
                    admin_username: adminUsername.trim(),
                    admin_email: adminEmail.trim() || undefined,
                },
            });

            const token = resp?.access_token;
            if (!token) throw new Error("Сервер не вернул токен");

            localStorage.setItem("fabrIQ_token", token);
            await fetchMe();

            setDone(true);
            setTimeout(() => navigate("/", { replace: true }), 1200);
        } catch (err: any) {
            const msg = pickErrorMessage(err);
            // если система уже инициализирована — входим обычным способом
            if (msg.toLowerCase().includes("already initialized")) {
                navigate("/login", { replace: true });
                return;
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, [setupToken, adminUsername, adminEmail, fetchMe, navigate]);

    if (done) {
        return (
            <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
                <div style={{ textAlign: "center" }}>
                    <h2>Готово ✅</h2>
                    <p>Первый администратор создан. Сейчас произойдёт вход…</p>
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "#f9fafb" }}>
            <form onSubmit={handleSubmit} style={{
                background: "white", borderRadius: 12, padding: 28,
                width: "100%", maxWidth: 480, boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            }}>
                <h2 style={{ marginTop: 0 }}>Первичная настройка FabrIQ</h2>
                <p style={{ color: "#666" }}>
                    В системе пока нет пользователей. Для завершения установки введите код настройки (<code>FABRIQ_SETUP_TOKEN</code>) и создайте администратора.
                </p>

                <label style={{ display: "block", marginBottom: 6, marginTop: 12 }}>Код настройки (из .env)</label>
                <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="FABRIQ_SETUP_TOKEN" required
                    style={{ width: "100%", height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #ddd", marginBottom: 12 }} />

                <label style={{ display: "block", marginBottom: 6 }}>Имя администратора</label>
                <input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)}
                    placeholder="admin" required
                    style={{ width: "100%", height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #ddd", marginBottom: 12 }} />

                <label style={{ display: "block", marginBottom: 6 }}>Email (необязательно)</label>
                <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="admin@company.com" type="email"
                    style={{ width: "100%", height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #ddd", marginBottom: 16 }} />

                {error && <div style={{ color: "#d63031", marginBottom: 12, fontSize: 14 }}>{error}</div>}

                <button type="submit" disabled={loading}
                    style={{
                        width: "100%", height: 42, border: 0, borderRadius: 10, fontWeight: 600, cursor: "pointer",
                        background: "linear-gradient(90deg, rgba(255,184,77,1) 0%, rgba(255,136,0,1) 100%)", color: "#222"
                    }}>
                    {loading ? "Создание…" : "Создать администратора"}
                </button>
            </form>
        </div>
    );
};

export default SetupWizard;
