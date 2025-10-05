# servers_refactored.py
from dotenv import load_dotenv
load_dotenv()

import os
import json
import asyncio
import ipaddress
import socket
import datetime
from typing import Optional

from fastapi import APIRouter, Query, Request, Body, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import pyodbc
from ..config import get_conn_str

from ..tasks_manager import tasks_manager

from asyncua import Client, ua
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256

from app.utils.crypto_helper import encrypt_password, decrypt_password

router = APIRouter(prefix="/servers", tags=["servers"])

# -----------------------------------------------------------------------------
# DB helper (единый стиль)
# -----------------------------------------------------------------------------
def _db():
    return pyodbc.connect(get_conn_str())


# -----------------------------------------------------------------------------
# Константы по OPC UA безопасности/сертификатам
# -----------------------------------------------------------------------------
OPC_SECURITY_POLICIES = ["Basic256Sha256", "Basic128Rsa15", "None"]
OPC_SECURITY_MODES = ["None", "Sign", "SignAndEncrypt"]
DEFAULT_OPC_SECURITY_POLICY = "Basic256Sha256"
DEFAULT_OPC_SECURITY_MODE = "Sign"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень /app
CLIENT_CERT_PATH = os.path.join(BASE_DIR, "client.der")
CLIENT_KEY_PATH = os.path.join(BASE_DIR, "client_private.der")
SERVER_CERT_PATH = os.path.join(BASE_DIR, "pki", "trusted", "certs", "PLC-PE_OPCUA.der")  # не обязателен

# -----------------------------------------------------------------------------
# МОДЕЛИ API
# -----------------------------------------------------------------------------
class TagInfo(BaseModel):
    node_id: str
    browse_name: str = ""
    data_type: str = ""
    description: str = ""
    polling_interval: int = 1

class PollingRequest(BaseModel):
    endpoint_url: str
    tags: list[TagInfo]
    interval: float = 1.0
    username: str | None = None
    password: str | None = None
    security_policy: str = "Basic256Sha256"  # По умолчанию Siemens
    security_mode: str = "Sign"              # Можно также: None, SignAndEncrypt

class StopPollingRequest(BaseModel):
    task_id: str

# Pydantic DTO для ответа/запроса по серверам (чтобы не конфликтовать с .models)
class OpcServerDTO(BaseModel):
    id: Optional[int] = None
    name: str
    endpoint_url: str
    description: Optional[str] = ""
    opcUsername: Optional[str] = ""
    opcPassword: Optional[str] = ""   # хранится шифровкой в БД
    securityPolicy: Optional[str] = ""
    securityMode: Optional[str] = ""

# -----------------------------------------------------------------------------
# Вспомогательные функции
# -----------------------------------------------------------------------------
@router.get("/opc_security_options")
def get_opc_security_options():
    return {
        "policies": OPC_SECURITY_POLICIES,
        "modes": OPC_SECURITY_MODES,
        "defaultPolicy": DEFAULT_OPC_SECURITY_POLICY,
        "defaultMode": DEFAULT_OPC_SECURITY_MODE,
    }

def get_server_credentials(endpoint_url: str):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT OpcUsername, OpcPassword, SecurityPolicy, SecurityMode
            FROM OpcServers WHERE EndpointUrl=?
        """, endpoint_url)
        row = cur.fetchone()
        if row:
            username, enc_password, policy, mode = row
            password = decrypt_password(enc_password) if enc_password else None
            return username, password, policy, mode
        return None, None, None, None

async def get_configured_client(
    endpoint_url: str,
    username: str | None = None,
    password: str | None = None,
    security_policy: str | None = None,
    security_mode: str | None = None
) -> Client:
    # Если что-то не передали — добираем из БД
    if not username or not password or not security_policy or not security_mode:
        db_username, db_password, db_policy, db_mode = get_server_credentials(endpoint_url)
        username = username or db_username
        password = password or db_password
        security_policy = security_policy or db_policy or "Basic256Sha256"
        security_mode = security_mode or db_mode or "Sign"

    # Для Siemens (и большинства) этого достаточно
    policy_class = SecurityPolicyBasic256Sha256
    mode_enum = getattr(ua.MessageSecurityMode, security_mode or "Sign")

    client = Client(endpoint_url)
    await client.set_security(
        policy=policy_class,
        certificate=CLIENT_CERT_PATH,
        private_key=CLIENT_KEY_PATH,
        server_certificate=None,
        mode=mode_enum,
    )
    if username and password:
        client.set_user(username)
        client.set_password(password)
    return client

def is_valid_opc_tag(tag: dict) -> bool:
    if tag.get("node_class", "").lower() != "variable":
        return False
    banned_prefixes = (
        "Server", "Namespace", "UrisVersion", "Session", "Status",
        "Aggregate", "Password", "Certificate", "User", "Array", "Vendor", "LastChange"
    )
    browse_name = str(tag.get("browse_name", ""))
    if any(browse_name.startswith(bp) for bp in banned_prefixes):
        return False
    if browse_name.lower() in ("identities", "applications", "endpoints", "configuration"):
        return False

    dt = str(tag.get("data_type") or "")
    if dt.startswith("urn:") or "structure" in dt.lower() or "array" in dt.lower():
        return False

    val = tag.get("value")
    if isinstance(val, list) or (isinstance(val, str) and val.startswith("urn:")):
        return False

    return True

def ensure_tags_and_get_ids(conn: pyodbc.Connection, server_id: int, tags: list[dict]) -> dict[str, int]:
    """
    Гарантирует наличие тегов в OpcTags и возвращает мапу node_id -> tag_id.
    Работает на ПЕРЕДАННОМ соединении (без внутренних _db()).
    """
    nodeid_to_tagid: dict[str, int] = {}
    node_ids = [t['node_id'] for t in tags]
    if not node_ids:
        return nodeid_to_tagid

    cur = conn.cursor()
    placeholders = ",".join("?" for _ in node_ids)
    cur.execute(
        f"SELECT Id, NodeId FROM OpcTags WHERE ServerId=? AND NodeId IN ({placeholders})",
        [server_id, *node_ids]
    )
    for row in cur.fetchall():
        nodeid_to_tagid[row[1]] = row[0]

    for tag in tags:
        if tag['node_id'] in nodeid_to_tagid:
            continue
        try:
            cur.execute(
                """INSERT INTO OpcTags
                   (ServerId, BrowseName, NodeId, DataType, Description)
                   OUTPUT INSERTED.Id
                   VALUES (?, ?, ?, ?, ?)""",
                server_id,
                tag.get('browse_name', ''),
                tag['node_id'],
                tag.get('data_type', ''),
                tag.get('description', ''),
            )
            inserted_id = cur.fetchone()[0]
            nodeid_to_tagid[tag['node_id']] = inserted_id
        except Exception:
            # если дубликат — достанем Id
            cur.execute("SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?", server_id, tag['node_id'])
            r2 = cur.fetchone()
            if r2:
                nodeid_to_tagid[tag['node_id']] = r2[0]

    conn.commit()
    return nodeid_to_tagid


# -----------------------------------------------------------------------------
# CRUD
# -----------------------------------------------------------------------------
@router.put("/servers/{server_id}")
def update_server(server_id: int, server: dict):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE OpcServers SET Name=?, EndpointUrl=?, Description=? WHERE Id=?",
            server.get("name"), server.get("endpoint_url"), server.get("description", ""), server_id
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}

@router.delete("/servers/{server_id}")
def delete_server(server_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM PollingTasks WHERE server_url = (SELECT EndpointUrl FROM OpcServers WHERE Id=?)", server_id)
        count = cur.fetchone()[0]
        if count > 0:
            raise HTTPException(status_code=400, detail="Сначала удалите все задачи, связанные с этим сервером")
        cur.execute("DELETE FROM OpcServers WHERE Id=?", server_id)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}

@router.get("/servers", response_model=list[OpcServerDTO])
def list_servers():
    servers: list[OpcServerDTO] = []
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, EndpointUrl, Description FROM OpcServers")
        for row in cursor.fetchall():
            servers.append(OpcServerDTO(
                id=row[0], name=row[1], endpoint_url=row[2], description=row[3]
            ))
    return servers

@router.post("/servers", response_model=OpcServerDTO)
def create_server(server: OpcServerDTO):
    encrypted_password = encrypt_password(server.opcPassword)
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO OpcServers (Name, EndpointUrl, Description, OpcUsername, OpcPassword, SecurityPolicy, SecurityMode)
            OUTPUT INSERTED.Id
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, server.name, server.endpoint_url, server.description,
           server.opcUsername, encrypted_password, server.securityPolicy, server.securityMode)
        new_id = cursor.fetchone()[0]
        conn.commit()
    return OpcServerDTO(id=new_id, name=server.name, endpoint_url=server.endpoint_url, description=server.description)

def get_server_config(endpoint_url: str):
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT OpcUsername, OpcPassword, SecurityPolicy, SecurityMode
            FROM OpcServers WHERE EndpointUrl = ?
        """, endpoint_url)
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "username": row[0],
            "password": row[1],
            "security_policy": row[2],
            "security_mode": row[3],
        }

# -----------------------------------------------------------------------------
# SSE: скан сети
# -----------------------------------------------------------------------------
@router.get("/netscan_stream")
async def netscan_stream(
    request: Request,
    ip_start: str,
    ip_end: str,
    ports: str = "4840"
):
    ports_list = [int(p) for p in ports.split(",") if p.strip().isdigit()]
    ips = [str(ipaddress.IPv4Address(ip)) for ip in range(
        int(ipaddress.IPv4Address(ip_start)),
        int(ipaddress.IPv4Address(ip_end)) + 1
    )]

    async def event_generator():
        found = []
        for ip in ips:
            for port in ports_list:
                yield f"data: {json.dumps({'type':'log','ip':ip,'port':port})}\n\n"
                url, ok = await probe_opcua_endpoint(ip, port)
                if ok:
                    found.append(url)
                    yield f"data: {json.dumps({'type':'found','url':url})}\n\n"
                await asyncio.sleep(0.01)
                if await request.is_disconnected():
                    return
        yield f"data: {json.dumps({'type':'finish','found':found})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# -----------------------------------------------------------------------------
# Простой сетевой скан
# -----------------------------------------------------------------------------
async def probe_opcua_endpoint(
    ip, port=4840, timeout=1.5,
    username=None, password=None,
    security_policy="Basic256Sha256",
    security_mode="Sign"
):
    url = f"opc.tcp://{ip}:{port}"
    try:
        client = await get_configured_client(
            url,
            username=username,
            password=password,
            security_policy=security_policy,
            security_mode=security_mode
        )
        async with client:
            await client.connect()
            await client.nodes.root.get_children()
        return url, True
    except Exception:
        return url, False

@router.get("/netscan")
async def netscan(
    ip_start: str = Query(..., example="192.168.11.1"),
    ip_end: str = Query(..., example="192.168.11.135"),
    ports: str = Query("4840", example="4840,4849"),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query("Basic256Sha256", alias="securityPolicy"),
    securityMode: str = Query("Sign", alias="securityMode"),
):
    ports_list = [int(p) for p in ports.split(",") if p.strip().isdigit()]
    ips = [str(ipaddress.IPv4Address(ip)) for ip in range(
        int(ipaddress.IPv4Address(ip_start)),
        int(ipaddress.IPv4Address(ip_end)) + 1
    )]
    tasks = [
        probe_opcua_endpoint(
            ip, port=port,
            username=opcUsername or None,
            password=opcPassword or None,
            security_policy=securityPolicy,
            security_mode=securityMode,
        )
        for ip in ips for port in ports_list
    ]
    found = [url for url, ok in await asyncio.gather(*tasks) if ok]
    return {
        "ok": bool(found),
        "found_endpoints": found,
        "message": "Найдены OPC UA серверы" if found else "Сервера не найдены"
    }

# -----------------------------------------------------------------------------
# Проверка конкретного endpoint
# -----------------------------------------------------------------------------
async def check_opc(
    endpoint: str,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str
) -> bool | str:
    try:
        policy_class = SecurityPolicyBasic256Sha256
        mode_enum = getattr(ua.MessageSecurityMode, mode, ua.MessageSecurityMode.Sign)

        client = Client(endpoint)
        await client.set_security(
            policy=policy_class,
            certificate=CLIENT_CERT_PATH,
            private_key=CLIENT_KEY_PATH,
            server_certificate=None,
            mode=mode_enum,
        )
        if username and password:
            client.set_user(username)
            client.set_password(password)

        await client.connect()
        await client.nodes.root.get_children()
        await client.disconnect()
        return True

    except Exception as ex:
        import traceback
        return traceback.format_exc()

@router.get("/probe")
async def probe_server(
    endpoint_url: str = Query(...),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query("Basic256Sha256", alias="securityPolicy"),
    securityMode: str = Query("Sign", alias="securityMode"),
):
    if not endpoint_url:
        raise HTTPException(status_code=400, detail="Не передан endpoint_url")

    res = await check_opc(
        endpoint_url,
        opcUsername or None,
        opcPassword or None,
        securityPolicy,
        securityMode,
    )

    if res is True:
        return {"ok": True, "endpoint_url": endpoint_url, "message": "✅ OPC UA сервер доступен"}
    else:
        return {"ok": False, "endpoint_url": endpoint_url, "message": f"❌ Ошибка: {res}"}

# -----------------------------------------------------------------------------
# Browse + запуск опроса
# -----------------------------------------------------------------------------
@router.post("/start_with_browse")
async def start_with_browse(req: PollingRequest):
    endpoint_url = req.endpoint_url
    interval = req.interval
    task_tags: list[TagInfo] = []

    node_id = getattr(req, "node_id", "i=85")
    try:
        client = await get_configured_client(
            endpoint_url,
            username=req.username,
            password=req.password,
            security_policy=getattr(req, "security_policy", None),
            security_mode=getattr(req, "security_mode", None)
        )
        async with client:
            start_node = client.get_node(node_id)
            found_tags = await browse_all_tags(client, start_node)
            filtered_tags = [tag for tag in found_tags if is_valid_opc_tag(tag)]
            for tag in filtered_tags:
                task_tags.append(TagInfo(
                    node_id=tag["node_id"],
                    browse_name=tag["browse_name"],
                    data_type=tag["data_type"],
                    polling_interval=interval
                ))

        if not task_tags:
            return {"ok": False, "message": "Не найдено ни одного тега"}

        polling_request = PollingRequest(
            endpoint_url=endpoint_url,
            tags=task_tags,
            interval=interval,
            username=req.username,
            password=req.password,
            security_policy=getattr(req, "security_policy", None),
            security_mode=getattr(req, "security_mode", None)
        )
        return await start_polling(polling_request)

    except Exception as e:
        return {"ok": False, "message": f"Ошибка при browse: {str(e)}"}

async def browse_all_tags(client: Client, node=None, level=0):
    result = []
    if node is None:
        node = client.get_node("i=85")
    try:
        bname = await node.read_browse_name()
    except Exception:
        bname = type("B", (), {"Name": "<error>"})()
    children = await node.get_children()
    for child in children:
        try:
            nodeclass = await child.read_node_class()
            bname = await child.read_browse_name()
            if nodeclass == ua.NodeClass.Variable:
                dtype = str(await child.read_data_type_as_variant_type())
                result.append({
                    "browse_name": bname.Name,
                    "node_id": child.nodeid.to_string(),
                    "data_type": dtype,
                    "node_class": "variable",
                })
            elif nodeclass == ua.NodeClass.Object:
                result += await browse_all_tags(client, child, level+1)
        except Exception:
            continue
    return result

@router.post("/browse")
async def browse_node_api(
    endpoint_url: str = Body(...),
    node_id: str = Body("i=85"),
    username: str | None = Body(None),
    password: str | None = Body(None),
    security_policy: str = Body("Basic256Sha256"),
    security_mode: str = Body("Sign"),
):
    client = await get_configured_client(
        endpoint_url,
        username=username,
        password=password,
        security_policy=security_policy,
        security_mode=security_mode
    )
    result = []
    try:
        async with client:
            node = client.get_node(node_id)
            children = await node.get_children()
            for child in children:
                try:
                    nodeclass = await child.read_node_class()
                    bname = await child.read_browse_name()
                    node_class_str = {
                        ua.NodeClass.Object: "Object",
                        ua.NodeClass.Variable: "Variable",
                        ua.NodeClass.Method: "Method",
                        ua.NodeClass.ObjectType: "ObjectType",
                        ua.NodeClass.VariableType: "VariableType",
                        ua.NodeClass.ReferenceType: "ReferenceType",
                        ua.NodeClass.DataType: "DataType",
                        ua.NodeClass.View: "View"
                    }.get(nodeclass, str(nodeclass))
                    has_children = False
                    try:
                        child_children = await child.get_children()
                        has_children = len(child_children) > 0
                    except Exception:
                        has_children = False
                    result.append({
                        "browse_name": bname.Name,
                        "node_id": child.nodeid.to_string(),
                        "node_class": node_class_str,
                        "has_children": has_children
                    })
                except Exception as e:
                    result.append({
                        "browse_name": "<error>",
                        "node_id": child.nodeid.to_string(),
                        "node_class": "Error",
                        "has_children": False,
                        "error": str(e)
                    })
        return {"ok": True, "children": result}
    except Exception as e:
        return {"ok": False, "message": f"Ошибка при browse: {str(e)}"}

# -----------------------------------------------------------------------------
# Полный рекурсивный скан и сохранение в БД
# -----------------------------------------------------------------------------
@router.post("/scan_full_tree")
async def scan_full_tree(
    server_id: int = Body(...),
    endpoint_url: str = Body(...),
    opcUsername: str = Body(""),
    opcPassword: str = Body(""),
    securityPolicy: str = Body("Basic256Sha256"),
    securityMode: str = Body("Sign"),
):
    import base64

    def safe_to_str(val):
        if isinstance(val, bytes):
            for enc in ("utf-8", "cp1251", "latin1"):
                try:
                    return val.decode(enc)
                except Exception:
                    continue
            return base64.b64encode(val).decode('ascii')
        return str(val) if val is not None else ""

    async def browse_all(client: Client, node, parent_path=""):
        result = []
        try:
            bname = safe_to_str((await node.read_browse_name()).Name)
        except Exception:
            bname = "<error>"
        path = (parent_path + "/" + bname).strip("/") if parent_path else bname
        children = await node.get_children()
        for child in children:
            try:
                nodeclass = await child.read_node_class()
                bname = safe_to_str((await child.read_browse_name()).Name)
                dtype = ""
                if nodeclass == ua.NodeClass.Variable:
                    try:
                        dtype = safe_to_str(str(await child.read_data_type_as_variant_type()))
                    except Exception:
                        dtype = ""
                    result.append({
                        "browse_name": bname,
                        "node_id": safe_to_str(child.nodeid.to_string()),
                        "data_type": dtype,
                        "path": path
                    })
                elif nodeclass == ua.NodeClass.Object:
                    result += await browse_all(client, child, path)
            except Exception:
                continue
        return result

    try:
        client = await get_configured_client(
            endpoint_url,
            username=opcUsername or None,
            password=opcPassword or None,
            security_policy=securityPolicy,
            security_mode=securityMode,
        )
        async with client:
            root = client.get_node("i=85")
            tags = await browse_all(client, root)

        with _db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT NodeId FROM OpcTags WHERE ServerId=?", server_id)
            existing_nodeids = set(row[0] for row in cursor.fetchall())
            inserted = 0
            for tag in tags:
                node_id = tag.get("node_id", "")
                if node_id in existing_nodeids:
                    continue
                try:
                    cursor.execute(
                        """INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Path, Description)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        server_id,
                        tag.get("browse_name", ""),
                        node_id,
                        tag.get("data_type", ""),
                        tag.get("path", ""),
                        ""
                    )
                    inserted += 1
                except Exception:
                    pass
            conn.commit()

        return {"ok": True, "found": len(tags), "inserted": inserted, "debug_first_tags": tags[:5], "debug_server_id": server_id}
    except Exception as ex:
        import traceback
        return {"ok": False, "error": str(ex), "trace": traceback.format_exc()}

# -----------------------------------------------------------------------------
# Циклический опрос тегов
# -----------------------------------------------------------------------------
@router.post("/is_polling")
async def is_polling(req: PollingRequest):
    task_id = f"{req.endpoint_url}:" + ",".join([t.node_id for t in req.tags])
    running = tasks_manager.is_running(task_id)
    return {"ok": True, "running": running}

@router.post("/start_polling")
async def start_polling(req: PollingRequest):
    endpoint_url = req.endpoint_url
    tags = req.tags
    interval = req.interval
    task_id = f"{endpoint_url}:" + ",".join([t.node_id for t in tags])

    async def poll_and_save():
        # подготовка: сервер и теги в БД
        tag_dicts = [t.dict() for t in tags]
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT Id FROM OpcServers WHERE EndpointUrl = ?", endpoint_url)
            row = cur.fetchone()
            if not row:
                return
            server_id = row[0]
            nodeid_to_tagid = ensure_tags_and_get_ids(conn, server_id, tag_dicts)

        client = await get_configured_client(
            endpoint_url,
            username=req.username,
            password=req.password,
            security_policy=req.security_policy,
            security_mode=req.security_mode
        )

        async with client:
            while True:
                try:
                    values = []
                    for t in tags:
                        try:
                            val = await client.get_node(t.node_id).read_value()
                            values.append((t.node_id, val, datetime.datetime.now()))
                        except Exception as e:
                            # лог и продолжить
                            continue
                    if values:
                        with _db() as conn:
                            cur = conn.cursor()
                            for node_id, val, dt in values:
                                tag_id = nodeid_to_tagid.get(node_id)
                                if tag_id:
                                    cur.execute(
                                        "INSERT INTO OpcData (TagId, Value, Timestamp) VALUES (?, ?, ?)",
                                        tag_id, val, dt)
                            conn.commit()
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(interval)

    # регистрация фоновой задачи
    if not tasks_manager.start(task_id, poll_and_save()):
        return {"ok": False, "message": "Уже выполняется"}
    return {"ok": True, "message": "Циклический опрос запущен"}

@router.post("/stop_polling")
async def stop_polling(req: StopPollingRequest):
    tasks_manager.stop(req.task_id)
    return {"ok": True, "message": "Опрос остановлен"}
