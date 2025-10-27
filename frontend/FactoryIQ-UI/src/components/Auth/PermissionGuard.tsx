// client/src/components/Auth/PermissionGuard.tsx
import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

type GuardProps = {
    /** Достаточно хотя бы одного разрешения */
    anyOf?: string[];
    /** Нужны все перечисленные разрешения */
    allOf?: string[];
    /** Куда редиректить при отсутствии прав (если не указан — покажем 403-блок) */
    redirectTo?: string;
    /** Что показывать, пока авторизация определяется */
    fallback?: React.ReactNode;
    children: React.ReactNode;
};

function checkPerms(has: (p: string) => boolean, anyOf?: string[], allOf?: string[]) {
    const okAny = !anyOf || anyOf.length === 0 || anyOf.some(has);
    const okAll = !allOf || allOf.length === 0 || allOf.every(has);
    return okAny && okAll;
}

/**
 * ProtectedRoute — используем внутри <Route element={...}>, чтобы
 * не пускать незалогиненных и/или без прав на страницу.
 */
export const ProtectedRoute: React.FC<GuardProps> = ({
    anyOf,
    allOf,
    redirectTo,
    fallback = null,
    children,
}) => {
    const { isAuthenticated, loading, hasPerm } = useAuth();
    const location = useLocation();

    if (loading) return <>{fallback}</>;

    if (!isAuthenticated) {
        // редиректим на /login и сохраняем "откуда пришёл" — чтобы вернуться после входа
        return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }

    const allowed = checkPerms(hasPerm, anyOf, allOf);
    if (!allowed) {
        if (redirectTo) return <Navigate to={redirectTo} replace />;
        // дефолтный компактный 403
        return (
            <div style={{ padding: 24 }}>
                <h3 style={{ margin: 0 }}>403 • Недостаточно прав</h3>
                <div style={{ opacity: 0.7, marginTop: 6, fontSize: 14 }}>
                    Обратитесь к администратору для выдачи доступа.
                </div>
            </div>
        );
    }

    return <>{children}</>;
};

/**
 * PermissionGuard — обёртка для кусочков UI (кнопки/панели),
 * скрывает содержимое, если прав нет.
 * По умолчанию просто ничего не рендерит; можно передать fallback.
 */
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
