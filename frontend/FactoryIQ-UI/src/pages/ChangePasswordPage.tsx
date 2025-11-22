// client/src/pages/ChangePasswordPage.tsx
import React, { useState, useCallback } from "react";
import { useApi } from "../shared/useApi";

const ChangePasswordPage: React.FC = () => {
    const api = useApi();

    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newPassword2, setNewPassword2] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const onSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setError(null);
            setSuccess(null);

            if (!newPassword || newPassword.length < 6) {
                setError("Новый пароль должен быть не короче 6 символов");
                return;
            }
            if (newPassword !== newPassword2) {
                setError("Пароли не совпадают");
                return;
            }

            setSubmitting(true);
            try {
                await api.post("/auth/password/change", {
                    old_password: oldPassword || undefined,
                    new_password: newPassword,
                });
                setSuccess("Пароль успешно изменён");
                setOldPassword("");
                setNewPassword("");
                setNewPassword2("");
            } catch (err: any) {
                const d = err?.detail;
                if (typeof d === "string") setError(d);
                else if (typeof d?.detail === "string") setError(d.detail);
                else setError(err?.message || "Не удалось изменить пароль");
            } finally {
                setSubmitting(false);
            }
        },
        [api, oldPassword, newPassword, newPassword2]
    );

    return (
        <div style={{ padding: 24, maxWidth: 480 }}>
            <h2>Смена пароля</h2>
            <p style={{ opacity: 0.7, fontSize: 14 }}>
                Если ранее пароль не задавался, поле «Текущий пароль» можно оставить пустым.
            </p>

            <form onSubmit={onSubmit}>
                <label style={{ display: "block", marginBottom: 6 }}>Текущий пароль</label>
                <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    style={{
                        width: "100%",
                        height: 40,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        marginBottom: 12,
                    }}
                />

                <label style={{ display: "block", marginBottom: 6 }}>Новый пароль</label>
                <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    style={{
                        width: "100%",
                        height: 40,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        marginBottom: 12,
                    }}
                />

                <label style={{ display: "block", marginBottom: 6 }}>Повторите новый пароль</label>
                <input
                    type="password"
                    value={newPassword2}
                    onChange={(e) => setNewPassword2(e.target.value)}
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
                    <div style={{ color: "#d63031", marginBottom: 12, fontSize: 14 }}>{error}</div>
                )}
                {success && (
                    <div style={{ color: "#27ae60", marginBottom: 12, fontSize: 14 }}>{success}</div>
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
                    {submitting ? "Сохраняем…" : "Сохранить пароль"}
                </button>
            </form>
        </div>
    );
};

export default ChangePasswordPage;
