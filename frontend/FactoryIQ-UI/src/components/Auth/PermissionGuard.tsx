// client/src/components/Auth/PermissionGuard.tsx
import React from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

type GuardProps = {
    anyOf?: string[];
    allOf?: string[];
    redirectTo?: string;
    fallback?: React.ReactNode;
    children: React.ReactNode;
};

function checkPerms(has: (p: string) => boolean, anyOf?: string[], allOf?: string[]) {
    const okAny = !anyOf || anyOf.length === 0 || anyOf.some(has);
    const okAll = !allOf || allOf.length === 0 || allOf.every(has);
    return okAny && okAll;
}

export const ProtectedRoute: React.FC<GuardProps> = ({
    anyOf,
    allOf,
    redirectTo,
    fallback = null,
    children,
}) => {
    const { isAuthenticated, loading, hasPerm, logout } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();

    if (loading) return <>{fallback}</>;

    if (!isAuthenticated) {
        return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }

    const allowed = checkPerms(hasPerm, anyOf, allOf);
    if (!allowed) {
        if (redirectTo) return <Navigate to={redirectTo} replace />;
        return (
            <div style={{ padding: 24 }}>
                <h3 style={{ margin: 0 }}>403 • Недостаточно прав</h3>
                <div style={{ opacity: 0.7, marginTop: 6, fontSize: 14 }}>
                    Обратитесь к администратору для выдачи доступа.
                </div>
                <div style={{ marginTop: 16 }}>
                    <button
                        onClick={() => {
                            logout();
                            navigate("/login", { replace: true });
                        }}
                        style={{
                            height: 36,
                            padding: "0 14px",
                            borderRadius: 8,
                            border: "1px solid #ddd",
                            cursor: "pointer",
                            background: "#fff",
                        }}
                    >
                        Сменить пользователя
                    </button>
                </div>
            </div>
        );
    }

    return <>{children}</>;
};

export const PermissionGuard: React.FC<GuardProps> = ({
    anyOf,
    allOf,
    fallback = null,
    children,
}) => {
    const { loading, isAuthenticated, hasPerm } = useAuth();

    if (loading) return <>{fallback}</>;
    if (!isAuthenticated) return <>{fallback}</>;

    const allowed = checkPerms(hasPerm, anyOf, allOf);
    if (!allowed) return <>{fallback}</>;

    return <>{children}</>;
};
