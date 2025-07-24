from fastapi import APIRouter, Query, Body, HTTPException
from .models import OpcTag
from ..db import get_db_connection
from asyncua import Client, ua
import asyncio
from pydantic import BaseModel
from typing import List, Optional
from app.routers.servers import get_configured_client
import base64
import os
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256
import math

router = APIRouter(prefix="/tags", tags=["tags"])

class LiveRequest(BaseModel):
    endpoint_url: str
    node_ids: List[str]
    opcUsername: Optional[str] = ""
    opcPassword: Optional[str] = ""
    securityPolicy: Optional[str] = "Basic256Sha256"
    securityMode: Optional[str] = "Sign"

class TagInfo(BaseModel):
    node_id: str
    browse_name: str = ""
    data_type: str = ""
    description: str = ""
    path: str = ""

class AddTagsRequest(BaseModel):
    server_id: int
    tags: list[TagInfo]

class TagDescUpdate(BaseModel):
    description: str

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень /app

CLIENT_CERT_PATH = os.path.join(BASE_DIR, "client.der")
CLIENT_KEY_PATH = os.path.join(BASE_DIR, "client_private.der")
SERVER_CERT_PATH = os.path.join(BASE_DIR, "pki", "trusted", "certs", "PLC-PE_OPCUA.der")

def get_policy_class(policy_name):
    # Можно расширить при необходимости
    if policy_name == "Basic256Sha256":
        return SecurityPolicyBasic256Sha256
    # Добавить другие по необходимости
    raise ValueError(f"Неизвестная политика безопасности: {policy_name}")
class LiveRequest(BaseModel):
    tag_ids: List[int]  # список id из OpcTags
    server_id: Optional[int] = None   # если фильтруем по серверу

@router.post("/live")
def get_live_from_db(req: LiveRequest):
    """
    Возвращает актуальные значения для заданных тегов (по id) из таблицы OpcData.
    """
    if not req.tag_ids:
        return {"ok": False, "error": "Не переданы tag_ids"}
    tag_ids = tuple(req.tag_ids)

    # Составляем запрос: получить последнее значение для каждого tag_id
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

    # Можно добавить фильтр по server_id, если нужно
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
        values = {row[0]: {"value": row[1], "timestamp": str(row[2]), "status": row[3]} for row in cursor.fetchall()}
    return {"ok": True, "values": values}

# --- ПАГИНАЦИЯ + ФИЛЬТРЫ ---
@router.get("/all")
def get_all_tags(
    page: int = Query(1, gt=0),
    page_size: int = Query(100, le=500),
    search: str = Query("", alias="search"),
    server_id: Optional[int] = Query(None),
):
    tags = []
    params = []
    filters = ["t.Id IN (SELECT tag_id FROM PollingTaskTags)"]  # Только опрашиваемые теги
    if server_id:
        filters.append("t.ServerId=?")
        params.append(server_id)
    if search:
        filters.append("(t.BrowseName LIKE ? OR t.NodeId LIKE ? OR t.Path LIKE ?)")
        s = f"%{search}%"
        params += [s, s, s]
    where = "WHERE " + " AND ".join(filters) if filters else ""
    query = f"""
        SELECT t.Id, t.BrowseName, t.NodeId, t.DataType, t.Description, t.Path
        FROM OpcTags t
        {where}
        ORDER BY t.Id OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    """
    params += [(page - 1) * page_size, page_size]

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        for row in cursor.fetchall():
            tags.append({
                "id": row[0],
                "browse_name": row[1],
                "node_id": row[2],
                "data_type": row[3],
                "description": row[4],
                "path": row[5],
            })
        # Get total count for pagination
        count_query = f"SELECT COUNT(*) FROM OpcTags t {where}"
        cursor.execute(count_query, params[:-2])
        total = cursor.fetchone()[0]
    return {"items": tags, "total": total}

# Для страницы OPCtags
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
    params = []
    filters = []
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
    params += [(page - 1) * page_size, page_size]

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        for row in cursor.fetchall():
            tags.append({
                "id": row[0],
                "browse_name": row[1],
                "node_id": row[2],
                "data_type": row[3],
                "description": row[4],
                "path": row[5],
            })
        # Get total count for pagination
        count_query = f"SELECT COUNT(*) FROM OpcTags t {where}"
        cursor.execute(count_query, params[:-2])
        total = cursor.fetchone()[0]
    return {"items": tags, "total": total}

@router.put("/{tag_id}")
def update_tag_desc(tag_id: int, data: TagDescUpdate):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE OpcTags SET Description=? WHERE Id=?", data.description, tag_id)
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
        # Вернём обновлённый тег для фронта
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

@router.post("/add_tags")
def add_tags(req: AddTagsRequest):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        for tag in req.tags:
            # Проверка на дубликаты (server_id + node_id)
            cursor.execute(
                "SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?", req.server_id, tag.node_id
            )
            if cursor.fetchone():
                continue  # Уже есть такой тег, пропускаем
            cursor.execute(
                """INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Path, Description)
                OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?, ?)""",
                req.server_id,
                tag.browse_name,
                tag.node_id,
                tag.data_type,
                tag.path if hasattr(tag, "path") else "",
                tag.description or "",
            )
        conn.commit()
    return {"ok": True, "message": "Теги добавлены"}


@router.get("/", response_model=list[OpcTag])
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
    return {"ok": True, "message": "Описание обновлено"}

async def browse_recursive(client, node, depth=0):
    result = []
    children = await node.get_children()
    for child in children:
        try:
            bname = await child.read_browse_name()
            nodeclass = await child.read_node_class()
            dtype = None
            val = None
            if nodeclass == ua.NodeClass.Variable:
                try:
                    dtype = str(await child.read_data_type_as_variant_type())
                    val = await child.read_value()
                    if isinstance(val, bytes):
                        try:
                            val = base64.b64encode(val).decode('ascii')
                        except Exception:
                            val = str(val)
                except Exception:
                    pass
            result.append({
                "browse_name": bname.Name,
                "node_id": child.nodeid.to_string(),
                "node_class": str(nodeclass).replace("NodeClass.", ""),
                "data_type": dtype,
                "value": val,
                "children": []  # можно рекурсивно вызывать
            })
            # Рекурсивно ищем дальше, если это объект/папка
            if nodeclass in [ua.NodeClass.Object, ua.NodeClass.Folder]:
                result[-1]["children"] = await browse_recursive(client, child, depth+1)
        except Exception:
            continue
    return result

@router.get("/browse_tree")
def browse_tree(
    endpoint_url: str = Query(...),
    node_id: str = Query("i=85")
):
    from asyncua import ua
    async def do_browse():
        async with Client(endpoint_url, timeout=10) as client:
            node = client.get_node(node_id)
            return await browse_recursive(client, node)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        tree = loop.run_until_complete(do_browse())
        return {"ok": True, "items": tree}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
    finally:
        loop.close()


@router.get("/browse_full")
def browse_full(
    endpoint_url: str = Query(...),
    node_id: str = Query("i=85"),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query("Basic256Sha256", alias="securityPolicy"),
    securityMode: str = Query("Sign", alias="securityMode"),
):
    def safe_to_str(val):
        if isinstance(val, bytes):
            for enc in ("utf-8", "cp1251", "latin1"):
                try:
                    return val.decode(enc)
                except Exception:
                    continue
            return base64.b64encode(val).decode('ascii')
        return str(val) if val is not None else ""

    async def do_browse():
        client = await get_configured_client(
            endpoint_url,
            username=opcUsername or None,
            password=opcPassword or None,
            security_policy=securityPolicy,
            security_mode=securityMode,
        )
        result = []
        async with client:
            node = client.get_node(node_id)
            refs = await node.get_children()
            for child in refs:
                try:
                    bname = safe_to_str((await child.read_browse_name()).Name)
                    nodeclass = await child.read_node_class()
                    node_class = safe_to_str(str(nodeclass).replace("NodeClass.", ""))
                    dtype = ""
                    val = None
                    if nodeclass == ua.NodeClass.Variable:
                        try:
                            dtype = safe_to_str(str(await child.read_data_type_as_variant_type()))
                            val = await child.read_value()
                            val = safe_to_str(val)
                        except Exception:
                            pass
                    result.append({
                        "browse_name": bname,
                        "node_id": safe_to_str(child.nodeid.to_string()),
                        "node_class": node_class,
                        "data_type": dtype,
                        "value": val,
                    })
                except Exception as ex:
                    print(f"Ошибка на {getattr(child, 'nodeid', '?')}: {ex}")
                    continue
        return result

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        tags = loop.run_until_complete(do_browse())
        return {"ok": True, "items": tags}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
    finally:
        loop.close()


@router.delete("/{tag_id}")
def delete_tag(tag_id: int):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM OpcTags WHERE Id=?", tag_id)
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
    return {"ok": True, "deleted": tag_id}
