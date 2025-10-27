# backend/app/routers/auth.py
import time
from typing import List, Optional, Dict

import pyodbc
from fastapi import APIRouter, Depends, HTTPException, Header, Body
from pydantic import BaseModel
from jose import jwt, JWTError

from ..config import get_env, get_conn_str

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------- ENV / JWT ----------------
JWT_SECRET = get_env("JWT_SECRET_KEY") or ""
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET_KEY is not set")

JWT_ALG = get_env("JWT_ALG", "HS256")
JWT_TTL_SECONDS = int(get_env("JWT_TTL_SECONDS", "43200"))

SETUP_TOKEN = get_env("FABRIQ_SETUP_TOKEN", "")

# ---------------- DB ----------------
def _db():
    return pyodbc.connect(get_conn_str())

# ---------------- Permission catalog ----------------
# по модулям из твоего меню: View/Manage/Run где уместно
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

# Пресеты ролей (просто словарь -> набор ключей из каталога)
ROLE_PRESETS: Dict[str, List[str]] = {
    "Admin": PERMISSIONS_CATALOG[:],  # всё
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
    username: str
    email: Optional[str] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int

class MeResponse(BaseModel):
    user: Dict
    permissions: List[str]

class PermissionChange(BaseModel):
    user_id: int
    permission: str

class RoleApplyBody(BaseModel):
    user_id: int
    role: str

class SetupBootstrapBody(BaseModel):
    setup_token: str
    admin_username: str
    admin_email: Optional[str] = None

# ---------------- JWT helpers ----------------
def _issue_token(user_id: int, username: str) -> TokenResponse:
    now = int(time.time())
    payload = {"sub": str(user_id), "username": username, "iat": now, "exp": now + JWT_TTL_SECONDS}
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return TokenResponse(access_token=token, expires_in=JWT_TTL_SECONDS)

def _decode_token(token: str) -> Dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

def get_current_user(authorization: Optional[str] = Header(None)) -> Dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authorization header missing or invalid")
    token = authorization.split(" ", 1)[1].strip()
    payload = _decode_token(token)
    user_id = int(payload.get("sub", "0") or "0")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT Id, Username, Email, [Role], CreatedAt FROM dbo.Users WHERE Id = ?", user_id)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        return {
            "id": row.Id,
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
        perms = set(get_user_permissions(user["id"]))
        ok_any = (not any_of) or bool(perms & any_of)
        ok_all = (not all_of) or all_of.issubset(perms)
        if not (ok_any and ok_all):
            raise HTTPException(status_code=403, detail={"need_any_of": list(any_of), "need_all_of": list(all_of)})
        return user
    return dependency

# ---------------- Endpoints ----------------
@router.post("/login", response_model=TokenResponse)
def login(body: LoginBody):
    username = (body.username or "").strip()
    email = (body.email or None)
    if not username:
        raise HTTPException(status_code=400, detail="username is required")

    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT TOP 1 Id FROM dbo.Users WHERE Username = ?", username)
        row = cur.fetchone()
        if row:
            user_id = row.Id
        else:
            cur.execute("INSERT INTO dbo.Users (Username, Email, CreatedAt) OUTPUT INSERTED.Id VALUES (?, ?, GETDATE())",
                        username, email)
            user_id = cur.fetchone()[0]
            conn.commit()

    return _issue_token(user_id, username)

@router.get("/me", response_model=MeResponse)
def me(user=Depends(get_current_user)):
    perms = get_user_permissions(user["id"])
    return {"user": user, "permissions": perms}

@router.get("/permissions/{user_id}", response_model=List[str])
def list_permissions(user_id: int, _=Depends(require_permissions(any_of=["Users.Manage", "Admin"]))):
    return get_user_permissions(user_id)

@router.post("/permissions/grant")
def grant_permission(body: PermissionChange, admin=Depends(require_permissions(any_of=["Users.Manage", "Admin"]))):
    perm = (body.permission or "").strip()
    if perm not in PERMISSIONS_CATALOG:
        raise HTTPException(status_code=400, detail=f"Unknown permission '{perm}'")
    with _db() as conn, conn.cursor() as cur:
        cur.execute("""
            IF NOT EXISTS (SELECT 1 FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?)
                INSERT INTO dbo.UserPermissions(UserId, Permission, GrantedAt, GrantedByUser)
                VALUES (?, ?, SYSUTCDATETIME(), ?)
        """, body.user_id, perm, body.user_id, perm, admin["id"])
        conn.commit()
    return {"status": "ok"}

@router.post("/permissions/revoke")
def revoke_permission(body: PermissionChange, _=Depends(require_permissions(any_of=["Users.Manage", "Admin"]))):
    perm = (body.permission or "").strip()
    with _db() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?", body.user_id, perm)
        conn.commit()
    return {"status": "ok"}

@router.get("/permissions/catalog", response_model=List[str])
def permissions_catalog(_=Depends(require_permissions(any_of=["Users.Manage", "Admin"]))):
    return PERMISSIONS_CATALOG

@router.post("/roles/apply")
def apply_role(body: RoleApplyBody, admin=Depends(require_permissions(any_of=["Users.Manage", "Admin"]))):
    role = (body.role or "").strip()
    perms = ROLE_PRESETS.get(role)
    if not perms:
        raise HTTPException(status_code=400, detail=f"Unknown role '{role}'")
    with _db() as conn, conn.cursor() as cur:
        for p in perms:
            cur.execute("""
                IF NOT EXISTS (SELECT 1 FROM dbo.UserPermissions WHERE UserId = ? AND Permission = ?)
                    INSERT INTO dbo.UserPermissions(UserId, Permission, GrantedAt, GrantedByUser)
                    VALUES (?, ?, SYSUTCDATETIME(), ?)
            """, body.user_id, p, body.user_id, p, admin["id"])
        conn.commit()
    return {"status": "ok", "role": role, "count": len(perms)}

# ---------- Setup: первый запуск ----------
@router.get("/setup/status")
def setup_status():
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM dbo.Users")
        n = cur.fetchone()[0]
    return {"users_count": int(n), "initialized": n > 0}

@router.post("/setup/bootstrap", response_model=TokenResponse)
def setup_bootstrap(payload: SetupBootstrapBody = Body(...)):
    # Разрешено ТОЛЬКО если пользователей нет
    with _db() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM dbo.Users")
        n = cur.fetchone()[0]
        if n > 0:
            raise HTTPException(status_code=400, detail="Already initialized")

    if not SETUP_TOKEN:
        raise HTTPException(status_code=500, detail="FABRIQ_SETUP_TOKEN is not configured on server")

    if (payload.setup_token or "").strip() != SETUP_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid setup token")

    admin_username = (payload.admin_username or "").strip()
    if not admin_username:
        raise HTTPException(status_code=400, detail="admin_username is required")

    # создаём первого юзера и выдаём все права (роль Admin)
    with _db() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO dbo.Users (Username, Email, CreatedAt) OUTPUT INSERTED.Id VALUES (?, ?, GETDATE())",
                    admin_username, (payload.admin_email or None))
        admin_id = cur.fetchone()[0]
        # массовый grant
        for p in ROLE_PRESETS["Admin"]:
            cur.execute("""
                INSERT INTO dbo.UserPermissions(UserId, Permission, GrantedAt, GrantedByUser)
                VALUES (?, ?, SYSUTCDATETIME(), NULL)
            """, admin_id, p)
        conn.commit()

    # сразу логиним и отдаём токен
    return _issue_token(admin_id, admin_username)
