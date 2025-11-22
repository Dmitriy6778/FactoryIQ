// client/src/components/Auth/LoginPage.tsx
import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import { useNavigate, useLocation } from "react-router-dom";
import { http } from "../../shared/http";

type SetupStatus = { users_count: number; initialized: boolean };

const LoginPage: React.FC = () => {
    const { login, isAuthenticated } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [username, setUsername] = useState("");
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkingSetup, setCheckingSetup] = useState(true);
const [password, setPassword] = useState("");
    useEffect(() => {
        let ignore = false;
        (async () => {
            try {
                const data = await http<SetupStatus>("/auth/setup/status", "GET");
                if (!ignore && data && !data.initialized) {
                    navigate("/setup", { replace: true });
                    return;
                }
            } catch {
                // сервер может быть без /setup/status — игнор
            } finally {
                if (!ignore) setCheckingSetup(false);
            }
        })();
        return () => { ignore = true; };
    }, [navigate]);

    useEffect(() => {
        if (isAuthenticated) {
            const from = (location.state as any)?.from || "/";
            navigate(from, { replace: true });
        }
    }, [isAuthenticated, location.state, navigate]);

   const onSubmit = useCallback(
    async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username.trim()) {
            setError("Введите логин");
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            await login({
                username: username.trim(),
                email: email.trim() || undefined,
                password: password || undefined,
            });
        } catch (err: any) {
            setError(err?.detail?.error || err?.message || "Не удалось войти");
        } finally {
            setSubmitting(false);
        }
    },
    [username, email, password, login]
);


    if (checkingSetup) {
        return (
            <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
                <div>Загрузка…</div>
            </div>
        );
    }

    return (
        <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 16 }}>
            <form
                onSubmit={onSubmit}
                style={{
                    width: "100%",
                    maxWidth: 420,
                    background: "white",
                    borderRadius: 12,
                    padding: 24,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
                }}
            >
                <h2 style={{ marginTop: 0, marginBottom: 8 }}>Вход</h2>
                <p style={{ marginTop: 0, color: "rgba(0,0,0,0.55)" }}>
                    Введите имя пользователя (email опционально)
                </p>

                <label style={{ display: "block", marginBottom: 6 }}>Логин</label>
                <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="user.name"
                    autoFocus
                    style={{
                        width: "100%",
                        height: 40,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        marginBottom: 12,
                    }}
                />
<label style={{ display: "block", marginBottom: 6 }}>Пароль (если задан)</label>
<input
    value={password}
    onChange={(e) => setPassword(e.target.value)}
    placeholder="••••••••"
    type="password"
    style={{
        width: "100%",
        height: 40,
        padding: "0 12px",
        borderRadius: 8,
        border: "1px solid #ddd",
        marginBottom: 12,
    }}
/>

                <label style={{ display: "block", marginBottom: 6 }}>Email (необязательно)</label>
                <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@company.com"
                    type="email"
                    style={{
                        width: "100%",
                        height: 40,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        marginBottom: 16,
                    }}
                />

                {error && (
                    <div style={{ color: "#d63031", marginBottom: 12, fontSize: 14 }}>
                        {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={submitting}
                    style={{
                        width: "100%",
                        height: 42,
                        border: 0,
                        borderRadius: 10,
                        fontWeight: 600,
                        cursor: "pointer",
                        background:
                            "linear-gradient(90deg, rgba(255,184,77,1) 0%, rgba(255,136,0,1) 100%)",
                        color: "#222",
                    }}
                >
                    {submitting ? "Входим…" : "Войти"}
                </button>
            </form>
        </div>
    );
};

export default LoginPage;
