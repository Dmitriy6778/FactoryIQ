from fastapi import APIRouter, Query
from .models import OpcTag
from ..db import get_db_connection
from asyncua import Client, ua
import asyncio
from pydantic import BaseModel
from typing import List
from fastapi import Body
from fastapi import HTTPException
from app.routers.servers import get_configured_client  # убедись что он доступен
import base64

router = APIRouter(prefix="/tags", tags=["tags"])

class LiveRequest(BaseModel):
    endpoint_url: str
    node_ids: List[str]

class TagInfo(BaseModel):
    node_id: str
    browse_name: str = ""
    data_type: str = ""
    description: str = ""

class AddTagsRequest(BaseModel):
    server_id: int
    tags: list[TagInfo]

class TagDescUpdate(BaseModel):
    description: str

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
                """INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Description)
                OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?)""",
                req.server_id,
                tag.browse_name,
                tag.node_id,
                tag.data_type,
                tag.description or "",
            )
        conn.commit()
    return {"ok": True, "message": "Теги добавлены"}

@router.post("/live")
def get_live_values(req: LiveRequest):
    async def read_all():
        async with Client(req.endpoint_url, timeout=5) as client:
            vals = {}
            for node_id in req.node_ids:
                try:
                    node = client.get_node(node_id)
                    val = await node.read_value()
                    if isinstance(val, bytes):
                        try:
                            val = base64.b64encode(val).decode('ascii')
                        except Exception:
                            val = str(val)
                    vals[node_id] = val
                except:
                    vals[node_id] = None
            return vals

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        values = loop.run_until_complete(read_all())
        return {"ok": True, "values": values}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}

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

@router.get("/all")
def get_all_tags():
    tags = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT Id, BrowseName, NodeId, DataType, Description
            FROM OpcTags
        """)
        for row in cursor.fetchall():
            tags.append({
                "id": row[0],
                "browse_name": row[1],
                "node_id": row[2],
                "data_type": row[3],
                "description": row[4],
            })
    return {"items": tags}

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
            try:
                return val.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    return base64.b64encode(val).decode('ascii')
                except Exception:
                    return str(val)
        return val

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
                bname = await child.read_browse_name()
                nodeclass = await child.read_node_class()
                dtype = None
                val = None
                if nodeclass == ua.NodeClass.Variable:
                    try:
                        dtype = str(await child.read_data_type_as_variant_type())
                        val = await child.read_value()
                        val = safe_to_str(val)
                    except Exception:
                        pass
                # Если хочешь еще и description брать — получай его из NodeAttributes/Description (опционально)
                result.append({
                    "browse_name": safe_to_str(bname.Name),
                    "node_id": safe_to_str(child.nodeid.to_string()),
                    "node_class": safe_to_str(str(nodeclass).replace("NodeClass.", "")),
                    "data_type": safe_to_str(dtype),
                    "value": val,
                })
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
