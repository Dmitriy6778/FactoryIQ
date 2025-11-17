# app/routers/tags.py
from dotenv import load_dotenv
load_dotenv()

from fastapi import APIRouter, Query, Body, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Tuple
import os
import base64

from opcua import Client, ua

from .models import OpcTag
from ..db import get_db_connection

router = APIRouter(prefix="/tags", tags=["tags"])

# ==============================
# Конфигурация OPC UA (sync)
# ==============================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень /app

CLIENT_CERT_PATH = os.getenv("OPC_CLIENT_CERT", os.path.join(BASE_DIR, "client.pem"))
CLIENT_KEY_PATH  = os.getenv("OPC_CLIENT_KEY",  os.path.join(BASE_DIR, "client_private.pem"))
DEFAULT_NS       = int(os.getenv("OPC_DEFAULT_NS", "2"))

def _require_pem_if_secure(policy: str, mode: str):
    if (policy or "").lower() != "none" and (mode or "").lower() != "none":
        if not (os.path.isfile(CLIENT_CERT_PATH) and os.path.isfile(CLIENT_KEY_PATH)):
            raise RuntimeError(
                f"Security requires PEM keys: OPC_CLIENT_CERT={CLIENT_CERT_PATH}, OPC_CLIENT_KEY={CLIENT_KEY_PATH}"
            )

def build_security_string(policy: str, mode: str) -> str:
    p = (policy or "None").strip()
    m = (mode or "None").strip()
    if p.lower() == "none" or m.lower() == "none":
        return "None,None,,"
    _require_pem_if_secure(p, m)
    return f"{p},{m},{CLIENT_CERT_PATH},{CLIENT_KEY_PATH}"

def make_client_sync(
    endpoint_url: str,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str,
) -> Client:
    sec = build_security_string(policy, mode)
    cl = Client(endpoint_url, timeout=10)
    cl.set_security_string(sec)
    if username and password:
        cl.set_user(username)
        cl.set_password(password)
    return cl

def ensure_full_nodeid(node_id: str, default_ns: int = DEFAULT_NS) -> str:
    """Если пришёл 'TEST.TAG', вернём 'ns=2;s=TEST.TAG'."""
    if ";" in node_id:
        return node_id
    return f"ns={default_ns};s={node_id}"

def _safe_to_str(val):
    if isinstance(val, bytes):
        for enc in ("utf-8", "cp1251", "latin1"):
            try:
                return val.decode(enc)
            except Exception:
                continue
        return base64.b64encode(val).decode("ascii")
    return str(val) if val is not None else ""

# ==============================
# Модели
# ==============================
class TagInfo(BaseModel):
    node_id: str
    browse_name: str = ""
    data_type: str = ""
    description: str = ""
    path: str = ""

class AddTagsRequest(BaseModel):
    server_id: int
    tags: List[TagInfo]

class TagDescUpdate(BaseModel):
    description: str

class LiveRequest(BaseModel):
    """Чтение последнего значения из БД по id тегов (OpcTags.Id)."""
    tag_ids: List[int]
    server_id: Optional[int] = None

# ==============================
# LIVE из БД
# ==============================
@router.post("/live")
def get_live_from_db(req: LiveRequest):
    if not req.tag_ids:
        return {"ok": False, "error": "Не переданы tag_ids"}
    tag_ids = tuple(req.tag_ids)

    sql = f"""
    SELECT d.TagId, d.Value, d.Timestamp, d.Status
    FROM OpcData d
    INNER JOIN (
        SELECT TagId, MAX(Timestamp) as MaxTime
        FROM OpcData
        WHERE TagId IN ({','.join(['?'] * len(tag_ids))})
        GROUP BY TagId
    ) last
    ON d.TagId = last.TagId AND d.Timestamp = last.MaxTime
    """

    params = tag_ids

    if req.server_id:
        sql = f"""
        SELECT d.TagId, d.Value, d.Timestamp, d.Status
        FROM OpcData d
        INNER JOIN OpcTags t ON d.TagId = t.Id
        INNER JOIN (
            SELECT TagId, MAX(Timestamp) as MaxTime
            FROM OpcData
            WHERE TagId IN ({','.join(['?'] * len(tag_ids))})
            GROUP BY TagId
        ) last ON d.TagId = last.TagId AND d.Timestamp = last.MaxTime
        WHERE t.ServerId = ?
        """
        params = tag_ids + (req.server_id,)

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(sql, params)
        values = {
            row[0]: {"value": row[1], "timestamp": str(row[2]), "status": row[3]}
            for row in cursor.fetchall()
        }
    return {"ok": True, "values": values}

# ==============================
# Пагинация/фильтры (ТОЛЬКО опрашиваемые теги)
# ==============================
# ==============================
# Пагинация/фильтры (ТОЛЬКО опрашиваемые теги)
# ==============================
@router.get("/all-tags")
def get_all_opc_tags(
    page: int = Query(1, gt=0),
    page_size: int = Query(100, le=500),
    search: str = Query("", alias="search"),
    server_id: Optional[int] = Query(None),
):
    tags = []
    params: list = []
    filters: list = []

    # фильтр по серверу
    if server_id:
        filters.append("t.ServerId=?")
        params.append(server_id)

    # 🔍 фильтр только по описанию
    if search:
        filters.append("t.Description LIKE ?")
        params.append(f"%{search}%")

    # если фильтров нет — просто берём все
    where = "WHERE " + " AND ".join(filters) if filters else ""

    query = f"""
        SELECT t.Id, t.BrowseName, t.NodeId, t.DataType, t.Description, t.Path
        FROM OpcTags t
        {where}
        ORDER BY t.Id OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    """
    params_q = params + [(page - 1) * page_size, page_size]

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params_q)
        for row in cursor.fetchall():
            tags.append({
                "id": row[0],
                "browse_name": row[1],
                "node_id": row[2],
                "data_type": row[3],
                "description": row[4],
                "path": row[5],
            })

        # считаем общее количество строк
        count_query = f"SELECT COUNT(*) FROM OpcTags t {where}"
        cursor.execute(count_query, params)
        total = cursor.fetchone()[0]

    return {"items": tags, "total": total}


# ==============================
# Полн. список для страницы OPCtags
# ==============================
@router.get("/all-tags")
def get_all_opc_tags(
    page: int = Query(1, gt=0),
    page_size: int = Query(100, le=500),
    browse_name: str = Query("", alias="browse_name"),
    node_id: str = Query("", alias="node_id"),
    data_type: str = Query("", alias="data_type"),
    path: str = Query("", alias="path"),
    description: str = Query("", alias="description"),
    server_id: Optional[int] = Query(None),
):
    tags = []
    params: list = []
    filters: list = []
    if server_id:
        filters.append("t.ServerId=?")
        params.append(server_id)
    if browse_name:
        filters.append("t.BrowseName LIKE ?")
        params.append(f"%{browse_name}%")
    if node_id:
        filters.append("t.NodeId LIKE ?")
        params.append(f"%{node_id}%")
    if data_type:
        filters.append("t.DataType LIKE ?")
        params.append(f"%{data_type}%")
    if path:
        filters.append("t.Path LIKE ?")
        params.append(f"%{path}%")
    if description:
        filters.append("t.Description LIKE ?")
        params.append(f"%{description}%")

    where = "WHERE " + " AND ".join(filters) if filters else ""
    query = f"""
        SELECT t.Id, t.BrowseName, t.NodeId, t.DataType, t.Description, t.Path
        FROM OpcTags t
        {where}
        ORDER BY t.Id OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    """
    params_q = params + [(page - 1) * page_size, page_size]

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params_q)
        for row in cursor.fetchall():
            tags.append({
                "id": row[0],
                "browse_name": row[1],
                "node_id": row[2],
                "data_type": row[3],
                "description": row[4],
                "path": row[5],
            })
        count_query = f"SELECT COUNT(*) FROM OpcTags t {where}"
        cursor.execute(count_query, params)
        total = cursor.fetchone()[0]
    return {"items": tags, "total": total}

# ==============================
# CRUD тегов
# ==============================
@router.get("/", response_model=List[OpcTag])
def list_tags(server_id: int = Query(..., description="ID OPC сервера")):
    tags = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT Id, ServerId, BrowseName, NodeId, DataType
            FROM OpcTags WHERE ServerId = ?
        """, server_id)
        for row in cursor.fetchall():
            tags.append(OpcTag(
                id=row[0], server_id=row[1], browse_name=row[2],
                node_id=row[3], data_type=row[4]
            ))
    return tags

@router.put("/{tag_id}")
def update_tag_desc(tag_id: int, data: TagDescUpdate):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE OpcTags SET Description=? WHERE Id=?", data.description, tag_id)
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
        cursor.execute("SELECT Id, BrowseName, NodeId, DataType, Description, Path FROM OpcTags WHERE Id=?", tag_id)
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Tag not found")
    return {
        "id": row[0],
        "browse_name": row[1],
        "node_id": row[2],
        "data_type": row[3],
        "description": row[4],
        "path": row[5],
    }

@router.delete("/{tag_id}")
def delete_tag(tag_id: int):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM OpcTags WHERE Id=?", tag_id)
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
    return {"ok": True, "deleted": tag_id}

@router.post("/add_tags")
def add_tags(req: AddTagsRequest):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        for tag in req.tags:
            cursor.execute(
                "SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?",
                req.server_id, tag.node_id
            )
            if cursor.fetchone():
                continue
            cursor.execute(
                """INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Path, Description)
                   OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?, ?)""",
                req.server_id,
                tag.browse_name,
                tag.node_id,
                tag.data_type,
                getattr(tag, "path", "") or "",
                tag.description or "",
            )
        conn.commit()
    return {"ok": True, "message": "Теги добавлены"}

# ==============================
# Browse (sync opcua)
# ==============================
def _browse_children_sync(
    endpoint_url: str,
    node_id: str,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str,
) -> List[Dict]:
    cl = make_client_sync(endpoint_url, username, password, policy, mode)
    out: List[Dict] = []
    try:
        cl.connect()
        node = cl.get_node(ensure_full_nodeid(node_id))
        children = node.get_children()
        for ch in children:
            try:
                nodeclass = ch.get_node_class()
                bname = ch.get_browse_name()
                node_class_str = {
                    ua.NodeClass.Object: "Object",
                    ua.NodeClass.Variable: "Variable",
                    ua.NodeClass.Method: "Method",
                    ua.NodeClass.ObjectType: "ObjectType",
                    ua.NodeClass.VariableType: "VariableType",
                    ua.NodeClass.ReferenceType: "ReferenceType",
                    ua.NodeClass.DataType: "DataType",
                    ua.NodeClass.View: "View",
                }.get(nodeclass, str(nodeclass))
                has_children = False
                try:
                    has_children = len(ch.get_children()) > 0
                except Exception:
                    has_children = False
                out.append({
                    "browse_name": _safe_to_str(getattr(bname, "Name", bname)),
                    "node_id": ch.nodeid.to_string(),
                    "node_class": node_class_str,
                    "has_children": has_children,
                })
            except Exception:
                continue
        return out
    finally:
        try:
            cl.disconnect()
        except Exception:
            pass

@router.get("/browse_tree")
def browse_tree(
    endpoint_url: str = Query(...),
    node_id: str = Query("i=85"),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query("Basic256Sha256", alias="securityPolicy"),
    securityMode: str = Query("Sign", alias="securityMode"),
):
    try:
        items = _browse_children_sync(
            endpoint_url, node_id,
            opcUsername or None, opcPassword or None,
            securityPolicy, securityMode
        )
        return {"ok": True, "items": items}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}

@router.get("/browse_full")
def browse_full(
    endpoint_url: str = Query(...),
    node_id: str = Query("i=85"),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query("Basic256Sha256", alias="securityPolicy"),
    securityMode: str = Query("Sign", alias="securityMode"),
):
    def browse_all_vars() -> List[Dict]:
        cl = make_client_sync(endpoint_url, opcUsername or None, opcPassword or None, securityPolicy, securityMode)
        out: List[Dict] = []
        try:
            cl.connect()
            start = cl.get_node(ensure_full_nodeid(node_id))
            def walk(node, path: str):
                try:
                    bname = node.get_browse_name()
                    name = _safe_to_str(getattr(bname, "Name", bname))
                except Exception:
                    name = "<error>"
                cur_path = (path + "/" + name).strip("/") if path else name
                try:
                    children = node.get_children()
                except Exception:
                    children = []
                for ch in children:
                    try:
                        nclass = ch.get_node_class()
                        bname = ch.get_browse_name()
                        nm = _safe_to_str(getattr(bname, "Name", bname))
                        if nclass == ua.NodeClass.Variable:
                            try:
                                dtype = str(ch.get_data_type_as_variant_type())
                                val = ch.get_value()
                                sval = _safe_to_str(val)
                            except Exception:
                                dtype, sval = "", None
                            out.append({
                                "browse_name": nm,
                                "node_id": ch.nodeid.to_string(),
                                "node_class": "Variable",
                                "data_type": dtype,
                                "value": sval,
                                "path": cur_path,
                            })
                        elif nclass == ua.NodeClass.Object:
                            walk(ch, cur_path)
                    except Exception:
                        continue
            walk(start, "")
            return out
        finally:
            try:
                cl.disconnect()
            except Exception:
                pass

    try:
        items = browse_all_vars()
        return {"ok": True, "items": items}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
