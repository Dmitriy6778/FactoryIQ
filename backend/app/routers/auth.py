# backend/app/routers/auth.py
import time
from typing import List, Optional, Dict, Any

import pyodbc
from fastapi import APIRouter, Depends, HTTPException, Header, Body, status
from pydantic import BaseModel, Field
from jose import jwt, JWTError

from ..config import get_env
from .db import _conn_for  # используем твою функцию подключения

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------- ENV / JWT ----------------
JWT_SECRET = get_env("JWT_SECRET_KEY") or ""
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET_KEY is not set")

JWT_ALG = get_env("JWT_ALG", "HS256")
try:
    JWT_TTL_SECONDS = int(get_env("JWT_TTL_SECONDS", "43200"))
except Exception:
    JWT_TTL_SECONDS = 43200

SETUP_TOKEN = get_env("FABRIQ_SETUP_TOKEN", "")

# ---------------- DB ----------------
def _db() -> pyodbc.Connection:
    """
    Соединение с БД через твою инфраструктуру (db._conn_for), autocommit=True.
    """
    return _conn_for()  # берет текущую БД из .env / get_conn_str

# ---------------- Permission catalog ----------------
PERMISSIONS_CATALOG: List[str] = [
    "Servers.View", "Servers.Manage",
    "Polling.View", "Polling.Manage",
    "Tags.View", "Tags.Manage",
    "Analytics.View", "Analytics.Run",
    "Reports.View", "Reports.Manage",
    "Settings.Manage",
    "TelegramReports.View", "TelegramReports.Manage",
    "TelegramChannels.View", "TelegramChannels.Manage",
    "Users.Manage",
]

ROLE_PRESETS: Dict[str, List[str]] = {
    "Admin": PERMISSIONS_CATALOG[:],
    "Engineer": [
        "Servers.View", "Servers.Manage",
        "Polling.View", "Polling.Manage",
        "Tags.View", "Tags.Manage",
        "Analytics.Run",
        "Reports.View",
        "TelegramReports.View",
        "TelegramChannels.View",
    ],
    "Analyst": [
        "Analytics.View", "Analytics.Run",
        "Reports.View",
        "TelegramReports.View",
    ],
    "Reporter": [
        "Reports.Manage",
        "TelegramReports.Manage",
        "TelegramChannels.View",
    ],
    "Viewer": [
        "Servers.View", "Polling.View", "Tags.View",
        "Analytics.View", "Reports.View",
        "TelegramReports.View", "TelegramChannels.View",
    ],
}

# ---------------- Models ----------------
class LoginBody(BaseModel):
    username: str = Field(..., min_length=1)
    email: Optional[str] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int

class MeResponse(BaseModel):
    user: Dict[str, Any]
    permissions: List[str]

class PermissionChange(BaseModel):
    user_id: int
    permission: str

class RoleApplyBody(BaseModel):
    user_id: int
    role: str

class SetupBootstrapBody(BaseModel):
    setup_token: str
    admin_username: str = Field(..., min_length=1)
    admin_email: Optional[str] = None

class PromoteAdminBody(BaseModel):
    user_id: int

# ---------------- Helpers ----------------
def _grant_admin_permissions(conn: pyodbc.Connection, user_id: int, granted_by: Optional[int] = None):
    """
    Выдать все права пользователю и проставить роль 'admin'.
    Все запросы параметризованные. Работает в autocommit, но оставляем commit для совместимости.
    """
    if not user_id:
        return
    with conn.cursor() as cur:
        cur.execute("UPDATE dbo.Users SET [Role] = 'admin' WHERE Id = ?", user_id)
        for p in ROLE_PRESETS["Admin"]:
            cur.execute(
                """
                IF NOT EXISTS (SELECT 1 FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?)
                    INSERT INTO dbo.UserPermissions (UserId, Permission, GrantedAt, GrantedByUser)
                    VALUES (?, ?, SYSUTCDATETIME(), ?)
                """,
                user_id, p, user_id, p, granted_by
            )
        try:
            conn.commit()
        except Exception:
            pass  # autocommit может быть включён

# ---------------- JWT helpers ----------------
def _issue_token(user_id: int, username: str) -> TokenResponse:
    now = int(time.time())
    payload = {"sub": str(user_id), "username": username, "iat": now, "exp": now + JWT_TTL_SECONDS}
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return TokenResponse(access_token=token, expires_in=JWT_TTL_SECONDS)

def _decode_token(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        # не раскрываем детали криптоошибок наружу
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

def get_current_user(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authorization header missing or invalid")
    token = authorization.split(" ", 1)[1].strip()
    payload = _decode_token(token)
    user_id = int(payload.get("sub", "0") or "0")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT Id, Username, Email, [Role], CreatedAt FROM dbo.Users WHERE Id = ?", user_id)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        return {
            "id": int(row.Id),
            "username": row.Username,
            "email": row.Email,
            "role": row.Role,
            "created_at": row.CreatedAt.isoformat() if row.CreatedAt else None,
        }

def get_user_permissions(user_id: int) -> List[str]:
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT Permission FROM dbo.UserPermissions WHERE UserId = ?", user_id)
        return [r[0] for r in cur.fetchall()]

def require_permissions(any_of: Optional[List[str]] = None, all_of: Optional[List[str]] = None):
    any_of = set(any_of or [])
    all_of = set(all_of or [])

    def dependency(user=Depends(get_current_user)):
        # Роль admin — проход без проверок
        if (user.get("role") or "").lower() == "admin":
            return user

        perms = set(get_user_permissions(user["id"]))
        ok_any = (not any_of) or bool(perms & any_of)
        ok_all = (not all_of) or all_of.issubset(perms)
        if not (ok_any and ok_all):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"need_any_of": list(any_of), "need_all_of": list(all_of)},
            )
        return user

    return dependency

# ---------------- Endpoints ----------------

@router.post("/setup/bootstrap", response_model=TokenResponse)
def setup_bootstrap(payload: SetupBootstrapBody = Body(...)):
    """
    Первый запуск: доступно только когда нет пользователей.
    Требует FABRIQ_SETUP_TOKEN. Создаёт admin и выдаёт все права.
    """
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM dbo.Users")
        n = cur.fetchone()[0]
        if n > 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Already initialized")

    if not SETUP_TOKEN:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Setup token not configured on server")
    if (payload.setup_token or "").strip() != SETUP_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid setup token")

    admin_username = (payload.admin_username or "").strip()
    if not admin_username:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="admin_username is required")

    with _db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO dbo.Users (Username, Email, [Role], CreatedAt)
            OUTPUT INSERTED.Id
            VALUES (?, ?, 'admin', SYSUTCDATETIME())
            """,
            admin_username, (payload.admin_email or None)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create admin user")
        admin_id = int(row[0])
        try:
            conn.commit()
        except Exception:
            pass
        _grant_admin_permissions(conn, admin_id, None)

    return _issue_token(admin_id, admin_username)

@router.post("/setup/promote-admin")
def promote_admin(body: PromoteAdminBody = Body(...), x_setup_token: Optional[str] = Header(None)):
    """
    Служебный эндпоинт: поднять существующего юзера до admin (раздаёт все права).
    Требует заголовок X-Setup-Token = FABRIQ_SETUP_TOKEN.
    """
    if not SETUP_TOKEN:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Setup token not configured on server")
    if (x_setup_token or "").strip() != SETUP_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid setup token")
    if body.user_id <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid user_id")

    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM dbo.Users WHERE Id = ?", body.user_id)
        if not cur.fetchone():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        _grant_admin_permissions(conn, body.user_id, None)

    return {"status": "ok", "user_id": body.user_id, "granted": len(ROLE_PRESETS["Admin"])}

@router.post("/login", response_model=TokenResponse)
def login(body: LoginBody = Body(...)):
    """
    Логин / автосоздание пользователя.
    Если это первый пользователь (<=1 в dbo.Users) или в системе ещё нет прав (0 в UserPermissions),
    текущий пользователь автоматически получает роль admin и все права.
    """
    username = (body.username or "").strip()
    email = (body.email or None)
    if not username:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="username is required")

    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT TOP 1 Id FROM dbo.Users WHERE Username = ?", username)
        row = cur.fetchone()
        if row:
            user_id = int(row.Id)
        else:
            cur.execute(
                """
                INSERT INTO dbo.Users (Username, Email, CreatedAt)
                OUTPUT INSERTED.Id
                VALUES (?, ?, SYSUTCDATETIME())
                """,
                username, email
            )
            row2 = cur.fetchone()
            if not row2:
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create user")
            user_id = int(row2[0])
            try:
                conn.commit()
            except Exception:
                pass

        cur.execute("SELECT COUNT(1) FROM dbo.Users")
        users_cnt = int(cur.fetchone()[0] or 0)

        cur.execute("SELECT COUNT(1) FROM dbo.UserPermissions")
        grants_cnt = int(cur.fetchone()[0] or 0)

        if users_cnt <= 1 or grants_cnt == 0:
            _grant_admin_permissions(conn, user_id, user_id)

    return _issue_token(user_id, username)

@router.get("/me", response_model=MeResponse)
def me(user=Depends(get_current_user)):
    """
    Возвращает текущего пользователя и его права.
    Доп.страховка: если в системе ещё нет ни одного гранта,
    текущему пользователю сразу выдаются права администратора.
    """
    # 1) страховка: если глобально нет грантов — поднять текущего пользователя в админы
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM dbo.UserPermissions")
        total_grants = int(cur.fetchone()[0] or 0)
        if total_grants == 0:
            _grant_admin_permissions(conn, user["id"], user["id"])

    # 2) прочитать актуальные права после возможного авто-гранта
    perms = get_user_permissions(user["id"])
    return {"user": user, "permissions": perms}


@router.get("/permissions/{user_id}", response_model=List[str])
def list_permissions(user_id: int, _=Depends(require_permissions(any_of=["Users.Manage"]))):
    return get_user_permissions(user_id)

@router.post("/permissions/grant")
def grant_permission(body: PermissionChange = Body(...), admin=Depends(require_permissions(any_of=["Users.Manage"]))):
    perm = (body.permission or "").strip()
    if not perm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="permission is required")
    if perm not in PERMISSIONS_CATALOG:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown permission")
    with _db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            IF NOT EXISTS (SELECT 1 FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?)
                INSERT INTO dbo.UserPermissions(UserId, Permission, GrantedAt, GrantedByUser)
                VALUES (?, ?, SYSUTCDATETIME(), ?)
            """,
            body.user_id, perm, body.user_id, perm, admin["id"]
        )
        try:
            conn.commit()
        except Exception:
            pass
    return {"status": "ok"}

@router.post("/permissions/revoke")
def revoke_permission(body: PermissionChange = Body(...), _=Depends(require_permissions(any_of=["Users.Manage"]))):
    perm = (body.permission or "").strip()
    if not perm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="permission is required")
    with _db() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?", body.user_id, perm)
        try:
            conn.commit()
        except Exception:
            pass
    return {"status": "ok"}

@router.get("/permissions/catalog", response_model=List[str])
def permissions_catalog(_=Depends(require_permissions(any_of=["Users.Manage"]))):
    return PERMISSIONS_CATALOG

@router.post("/roles/apply")
def apply_role(body: RoleApplyBody = Body(...), admin=Depends(require_permissions(any_of=["Users.Manage"]))):
    role = (body.role or "").strip()
    if not role:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="role is required")
    perms = ROLE_PRESETS.get(role)
    if not perms:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown role")
    with _db() as conn, conn.cursor() as cur:
        for p in perms:
            cur.execute(
                """
                IF NOT EXISTS (SELECT 1 FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?)
                    INSERT INTO dbo.UserPermissions(UserId, Permission, GrantedAt, GrantedByUser)
                    VALUES (?, ?, SYSUTCDATETIME(), ?)
                """,
                body.user_id, p, body.user_id, p, admin["id"]
            )
        try:
            conn.commit()
        except Exception:
            pass
    return {"status": "ok", "role": role, "count": len(perms)}

@router.get("/setup/status")
def setup_status():
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM dbo.Users")
        n = int(cur.fetchone()[0] or 0)
    return {"users_count": n, "initialized": n > 0}
