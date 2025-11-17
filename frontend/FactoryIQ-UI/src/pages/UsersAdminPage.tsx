// client/src/pages/UsersAdminPage.tsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useApi } from "../shared/useApi";
import { useAuth } from "../components/Auth/AuthContext";
import { ProtectedRoute } from "../components/Auth/PermissionGuard";

type User = {
    id: number;
    username: string;
    email?: string | null;
    role?: string | null;
    created_at?: string | null;
};

const ROLE_PRESETS = ["Admin", "Engineer", "Analyst", "Reporter", "Viewer"] as const;

/* ---------- UI helpers ---------- */
const Section: React.FC<React.PropsWithChildren<{ title: string; right?: React.ReactNode }>> = ({
    title,
    right,
    children,
}) => (
    <div
        style={{
            background: "#fff",
            borderRadius: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            padding: 16,
        }}
    >
        <div
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
            }}
        >
            <h3 style={{ margin: 0 }}>{title}</h3>
            {right}
        </div>
        {children}
    </div>
);

const Chip: React.FC<
    React.PropsWithChildren<{ active?: boolean; onClick?: () => void }>
> = ({ active, onClick, children }) => (
    <button
        onClick={onClick}
        style={{
            padding: "6px 10px",
            borderRadius: 999,
            border: active ? "1px solid #ffa500" : "1px solid #ddd",
            background: active ? "rgba(255,165,0,.15)" : "#fff",
            cursor: onClick ? "pointer" : "default",
            fontSize: 13,
            marginRight: 8,
            marginBottom: 8,
        }}
    >
        {children}
    </button>
);

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
    <input
        {...props}
        style={{
            width: "100%",
            height: 40,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid #ddd",
            ...(props.style || {}),
        }}
    />
);

const Btn: React.FC<
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
        tone?: "primary" | "ghost" | "danger";
    }
> = ({ tone = "primary", style, children, ...rest }) => {
    const styles: Record<string, React.CSSProperties> = {
        primary: {
            background:
                "linear-gradient(90deg, rgba(255,184,77,1) 0%, rgba(255,136,0,1) 100%)",
            color: "#222",
            border: 0,
        },
        ghost: {
            background: "#fff",
            color: "#333",
            border: "1px solid #ddd",
        },
        danger: {
            background: "#fff5f5",
            color: "#c0392b",
            border: "1px solid #f5b7b1",
        },
    };
    return (
        <button
            {...rest}
            style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 10,
                fontWeight: 600,
                cursor: "pointer",
                ...styles[tone],
                ...(style || {}),
            }}
        >
            {children}
        </button>
    );
};
/* ---------- /UI helpers ---------- */

const UsersAdminPageInner: React.FC = () => {
    const api = useApi();
    const { user: me } = useAuth();

    const [users, setUsers] = useState<User[]>([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [usersError, setUsersError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");

    const [catalog, setCatalog] = useState<string[]>([]);
    const [catalogLoading, setCatalogLoading] = useState(false);

    const [selected, setSelected] = useState<User | null>(null);
    const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
    const [selectedLoading, setSelectedLoading] = useState(false);

    const [newLogin, setNewLogin] = useState("");
    const [newEmail, setNewEmail] = useState("");

    /* --- список пользователей (один раз и по кнопке) --- */
    const reloadUsers = useCallback(async () => {
        setUsersLoading(true);
        setUsersError(null);
        try {
            const list = await api.get<User[]>("/auth/users");
            setUsers(list || []);
        } catch {
            setUsersError(
                "Список пользователей недоступен (GET /auth/users)."
            );
            setUsers([]);
        } finally {
            setUsersLoading(false);
        }
    }, [api]);

    useEffect(() => {
        reloadUsers();
    }, [reloadUsers]);

    /* --- каталог прав (один раз) --- */
    const loadCatalog = useCallback(async () => {
        setCatalogLoading(true);
        try {
            const list = await api.get<string[]>("/auth/permissions/catalog");
            setCatalog(list || []);
        } finally {
            setCatalogLoading(false);
        }
    }, [api]);

    useEffect(() => {
        loadCatalog();
    }, [loadCatalog]);

    /* --- права выбранного пользователя --- */
    const loadUserPerms = useCallback(
        async (u: User) => {
            setSelectedLoading(true);
            try {
                // маршрут соответствует бекенду: GET /auth/permissions/{user_id}
                const perms = await api.get<string[]>(`/auth/permissions/${u.id}`);
                setSelectedPerms(perms || []);
            } finally {
                setSelectedLoading(false);
            }
        },
        [api]
    );

    const filteredUsers = useMemo(
        () =>
            users.filter(
                (u) =>
                    !filter ||
                    u.username.toLowerCase().includes(filter.toLowerCase()) ||
                    (u.email || "").toLowerCase().includes(filter.toLowerCase())
            ),
        [users, filter]
    );

    const selectUser = useCallback(
        (u: User) => {
            setSelected(u);
            loadUserPerms(u);
        },
        [loadUserPerms]
    );

    const onCreateUser = useCallback(async () => {
        if (!newLogin.trim()) return;
        await api.post("/auth/login", {
            username: newLogin.trim(),
            email: newEmail.trim() || undefined,
        });
        const createdLogin = newLogin.trim();
        setNewLogin("");
        setNewEmail("");
        await reloadUsers();
        const created = (await api.get<User[]>("/auth/users"))?.find(
            (x) => x.username === createdLogin
        );
        if (created) selectUser(created);
    }, [api, newLogin, newEmail, reloadUsers, selectUser]);

    const applyRole = useCallback(
        async (role: string) => {
            if (!selected) return;
            await api.post("/auth/roles/apply", { user_id: selected.id, role });
            await loadUserPerms(selected);
        },
        [api, selected, loadUserPerms]
    );

    const togglePerm = useCallback(
        async (perm: string) => {
            if (!selected) return;
            const has = selectedPerms.includes(perm);
            if (has) {
                await api.post("/auth/permissions/revoke", {
                    user_id: selected.id,
                    permission: perm,
                });
            } else {
                await api.post("/auth/permissions/grant", {
                    user_id: selected.id,
                    permission: perm,
                });
            }
            await loadUserPerms(selected);
        },
        [api, selected, selectedPerms, loadUserPerms]
    );

    return (
        <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
            <h2 style={{ marginTop: 0 }}>Пользователи и права</h2>

            <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 16 }}>
                {/* Левая колонка */}
                <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
                    <Section title="Пользователи" right={<Btn tone="ghost" onClick={reloadUsers}>Обновить</Btn>}>
                        <Input
                            placeholder="Поиск по логину/email…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                        {usersError && (
                            <div style={{ marginTop: 8, color: "#b33", fontSize: 13 }}>
                                {usersError}
                            </div>
                        )}
                        <div
                            style={{
                                marginTop: 12,
                                maxHeight: 420,
                                overflow: "auto",
                                border: "1px solid #eee",
                                borderRadius: 8,
                            }}
                        >
                            {usersLoading ? (
                                <div style={{ padding: 12 }}>Загрузка…</div>
                            ) : filteredUsers.length === 0 ? (
                                <div style={{ padding: 12, opacity: 0.7 }}>Нет пользователей</div>
                            ) : (
                                filteredUsers.map((u) => (
                                    <div
                                        key={u.id}
                                        onClick={() => selectUser(u)}
                                        style={{
                                            padding: 10,
                                            display: "grid",
                                            gap: 2,
                                            borderBottom: "1px solid #f2f2f2",
                                            background:
                                                selected?.id === u.id ? "rgba(255,165,0,.1)" : "#fff",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <div style={{ fontWeight: 600 }}>
                                            {u.username}{" "}
                                            {u.id === me?.id && (
                                                <span style={{ fontWeight: 400, opacity: 0.6 }}>
                                                    (это вы)
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                                            {u.email || "—"}
                                        </div>
                                        <div style={{ fontSize: 12, opacity: 0.6 }}>
                                            Роль: {u.role || "—"} {u.created_at && `• ${u.created_at}`}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </Section>

                    <Section title="Добавить пользователя">
                        <div style={{ display: "grid", gap: 8 }}>
                            <label>Логин</label>
                            <Input
                                value={newLogin}
                                onChange={(e) => setNewLogin(e.target.value)}
                                placeholder="ivan.petrov"
                            />
                            <label>Email (необязательно)</label>
                            <Input
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                                placeholder="ivan@company.com"
                            />
                            <div style={{ marginTop: 8 }}>
                                <Btn onClick={onCreateUser} disabled={!newLogin.trim()}>
                                    Создать
                                </Btn>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.65 }}>
                                Пользователь создаётся через <code>/auth/login</code> (без
                                пароля). Права и роль назначаются ниже.
                            </div>
                        </div>
                    </Section>
                </div>

                {/* Правая колонка */}
                <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
                    <Section
                        title={selected ? `Настройка: ${selected.username}` : "Выберите пользователя"}
                        right={
                            selected ? (
                                <div style={{ display: "flex", alignItems: "center" }}>
                                    <span style={{ marginRight: 8, opacity: 0.7, fontSize: 13 }}>
                                        Назначить роль:
                                    </span>
                                    {ROLE_PRESETS.map((r) => (
                                        <Chip
                                            key={r}
                                            onClick={() => applyRole(r)}
                                            active={selected.role?.toLowerCase() === r.toLowerCase()}
                                        >
                                            {r}
                                        </Chip>
                                    ))}
                                </div>
                            ) : null
                        }
                    >
                        {!selected ? (
                            <div style={{ opacity: 0.7 }}>
                                Слева выберите пользователя, чтобы выдать роль и права.
                            </div>
                        ) : (
                            <>
                                <div style={{ marginBottom: 12, fontSize: 13, opacity: 0.7 }}>
                                    Текущая роль: <b>{selected.role || "—"}</b>
                                </div>

                                <div style={{ marginBottom: 8, fontWeight: 600 }}>Права</div>
                                {catalogLoading ? (
                                    <div>Загрузка каталога…</div>
                                ) : (
                                    <div style={{ display: "flex", flexWrap: "wrap" }}>
                                        {catalog.map((perm) => {
                                            const has = selectedPerms.includes(perm);
                                            return (
                                                <Chip
                                                    key={perm}
                                                    active={has}
                                                    onClick={() => togglePerm(perm)}
                                                >
                                                    {has ? "✔ " : ""}
                                                    {perm}
                                                </Chip>
                                            );
                                        })}
                                    </div>
                                )}

                                {selectedLoading && <div style={{ marginTop: 8 }}>Применяем…</div>}
                            </>
                        )}
                    </Section>
                </div>
            </div>
        </div>
    );
};

const UsersAdminPage: React.FC = () => (
    <ProtectedRoute anyOf={["Users.Manage"]} fallback={<div style={{ padding: 16 }}>Загрузка…</div>}>
        <UsersAdminPageInner />
    </ProtectedRoute>
);

export default UsersAdminPage;
