# servers_refactored.py
from dotenv import load_dotenv
load_dotenv()

import os
import json
import asyncio
import ipaddress
import datetime
import base64
from typing import Optional, List, Dict, Tuple

from fastapi import APIRouter, Query, Request, Body, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import time
import pyodbc
from ..config import get_conn_str
from ..tasks_manager import tasks_manager

# === ВАЖНО: используем синхронный клиент ===
from opcua import Client, ua

from app.utils.crypto_helper import encrypt_password, decrypt_password

router = APIRouter(prefix="/servers", tags=["servers"])


# -----------------------------------------------------------------------------
# DB helper
# -----------------------------------------------------------------------------
def _db():
    return pyodbc.connect(get_conn_str())


# -----------------------------------------------------------------------------
# OPC UA security / certs
# -----------------------------------------------------------------------------
OPC_SECURITY_POLICIES = ["Basic256Sha256", "Basic128Rsa15", "None"]
OPC_SECURITY_MODES = ["None", "Sign", "SignAndEncrypt"]
DEFAULT_OPC_SECURITY_POLICY = "Basic256Sha256"
DEFAULT_OPC_SECURITY_MODE = "Sign"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # /app

# Предпочтительно читать из .env, иначе дефолт
CLIENT_CERT_PATH = os.getenv("OPC_CLIENT_CERT", os.path.join(BASE_DIR, "client.pem"))
CLIENT_KEY_PATH  = os.getenv("OPC_CLIENT_KEY",  os.path.join(BASE_DIR, "client_private.pem"))

# Namespace по умолчанию для коротких NodeId без ';'
DEFAULT_NS = int(os.getenv("OPC_DEFAULT_NS", "2"))


# -----------------------------------------------------------------------------
# Pydantic models (DTO)
# -----------------------------------------------------------------------------
class TagInfo(BaseModel):
    node_id: str
    browse_name: str = ""
    data_type: str = ""
    description: str = ""
    polling_interval: float = 1.0


class PollingRequest(BaseModel):
    endpoint_url: str
    tags: List[TagInfo]
    interval: float = 1.0
    username: Optional[str] = None
    password: Optional[str] = None
    security_policy: str = DEFAULT_OPC_SECURITY_POLICY
    security_mode: str = DEFAULT_OPC_SECURITY_MODE


class StopPollingRequest(BaseModel):
    task_id: str


class OpcServerDTO(BaseModel):
    id: Optional[int] = None
    name: str
    endpoint_url: str
    description: Optional[str] = ""
    opcUsername: Optional[str] = ""
    opcPassword: Optional[str] = ""   # в БД хранится шифром
    securityPolicy: Optional[str] = DEFAULT_OPC_SECURITY_POLICY
    securityMode: Optional[str] = DEFAULT_OPC_SECURITY_MODE


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
@router.get("/opc_security_options")
def get_opc_security_options():
    return {
        "policies": OPC_SECURITY_POLICIES,
        "modes": OPC_SECURITY_MODES,
        "defaultPolicy": DEFAULT_OPC_SECURITY_POLICY,
        "defaultMode": DEFAULT_OPC_SECURITY_MODE,
    }


def _require_pem_if_secure(policy: str, mode: str):
    if (policy or "").lower() != "none" and (mode or "").lower() != "none":
        # нужна пара PEM
        if not (os.path.isfile(CLIENT_CERT_PATH) and os.path.isfile(CLIENT_KEY_PATH)):
            raise RuntimeError(
                f"Security requires PEM keys: OPC_CLIENT_CERT={CLIENT_CERT_PATH}, OPC_CLIENT_KEY={CLIENT_KEY_PATH}"
            )


def build_security_string(policy: str, mode: str) -> str:
    """
    Формат для opcua.Client.set_security_string:
    - "None,None,,"  (аноним/без шифрования)
    - "Basic256Sha256,Sign,<cert.pem>,<key.pem>"
    - "Basic256Sha256,SignAndEncrypt,<cert.pem>,<key.pem>"
    - "Basic128Rsa15,Sign,<cert.pem>,<key.pem>"
    """
    p = (policy or "None").strip()
    m = (mode or "None").strip()

    if p.lower() == "none" or m.lower() == "none":
        return "None,None,,"

    _require_pem_if_secure(p, m)
    return f"{p},{m},{CLIENT_CERT_PATH},{CLIENT_KEY_PATH}"

# helpers (добавьте, если нет)
def resolve_creds(endpoint_url: str, u: Optional[str], p: Optional[str],
                  pol: Optional[str], mode: Optional[str]):
    dbu, dbp, dbpol, dbmode = get_server_credentials(endpoint_url)
    return (
        u or dbu,
        p or dbp,
        (pol or dbpol or DEFAULT_OPC_SECURITY_POLICY),
        (mode or dbmode or DEFAULT_OPC_SECURITY_MODE),
    )

def get_server_credentials(endpoint_url: str) -> Tuple[Optional[str], Optional[str], str, str]:
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT OpcUsername, OpcPassword, SecurityPolicy, SecurityMode FROM OpcServers WHERE EndpointUrl=?",
            endpoint_url,
        )
        row = cur.fetchone()
        if row:
            username, enc_password, policy, mode = row
            password = decrypt_password(enc_password) if enc_password else None
            return username, password, policy or DEFAULT_OPC_SECURITY_POLICY, mode or DEFAULT_OPC_SECURITY_MODE
        return None, None, DEFAULT_OPC_SECURITY_POLICY, DEFAULT_OPC_SECURITY_MODE


def make_client_sync(
    endpoint_url: str,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str,
) -> Client:
    """
    Возвращает готовый синхронный Client (НЕ подключённый).
    """
    sec = build_security_string(policy, mode)
    cl = Client(endpoint_url, timeout=10)
    cl.set_security_string(sec)
    if username and password:
        cl.set_user(username)
        cl.set_password(password)
    return cl


def ensure_full_nodeid(node_id: str, default_ns: int = DEFAULT_NS) -> str:
    """
    Если NodeId без ';' (например TEST.TAG1), добавим "ns=2;s=".
    """
    if ";" in node_id:
        return node_id
    return f"ns={default_ns};s={node_id}"


def is_valid_opc_tag(tag: Dict) -> bool:
    # Фильтрация "служебных" и неудобных типов
    cls = (tag.get("node_class") or "").lower()
    if cls != "variable":
        return False

    banned_prefixes = (
        "Server", "Namespace", "UrisVersion", "Session", "Status",
        "Aggregate", "Password", "Certificate", "User", "Array", "Vendor", "LastChange"
    )
    browse_name = str(tag.get("browse_name") or "")
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


def ensure_tags_and_get_ids(conn: pyodbc.Connection, server_id: int, tags: List[Dict]) -> Dict[str, int]:
    nodeid_to_tagid: Dict[str, int] = {}
    node_ids = [t["node_id"] for t in tags]
    if not node_ids:
        return nodeid_to_tagid

    cur = conn.cursor()
    placeholders = ",".join("?" for _ in node_ids)
    cur.execute(
        f"SELECT Id, NodeId FROM OpcTags WHERE ServerId=? AND NodeId IN ({placeholders})",
        [server_id, *node_ids],
    )
    for row in cur.fetchall():
        nodeid_to_tagid[row[1]] = row[0]

    for tag in tags:
        if tag["node_id"] in nodeid_to_tagid:
            continue
        try:
            cur.execute(
                """INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Description)
                   OUTPUT INSERTED.Id
                   VALUES (?, ?, ?, ?, ?)""",
                server_id,
                tag.get("browse_name", ""),
                tag["node_id"],
                tag.get("data_type", ""),
                tag.get("description", ""),
            )
            inserted_id = cur.fetchone()[0]
            nodeid_to_tagid[tag["node_id"]] = inserted_id
        except Exception:
            cur.execute("SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?", server_id, tag["node_id"])
            r2 = cur.fetchone()
            if r2:
                nodeid_to_tagid[tag["node_id"]] = r2[0]

    conn.commit()
    return nodeid_to_tagid


def _safe_to_str(val) -> str:
    if isinstance(val, bytes):
        for enc in ("utf-8", "cp1251", "latin1"):
            try:
                return val.decode(enc)
            except Exception:
                continue
        return base64.b64encode(val).decode("ascii")
    return str(val) if val is not None else ""


# -----------------------------------------------------------------------------
# CRUD
# -----------------------------------------------------------------------------
@router.put("/servers/{server_id}")
def update_server(server_id: int, server: dict):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE OpcServers SET Name=?, EndpointUrl=?, Description=? WHERE Id=?",
            server.get("name"),
            server.get("endpoint_url"),
            server.get("description", ""),
            server_id,
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}


@router.delete("/servers/{server_id}")
def delete_server(server_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM PollingTasks WHERE server_url = (SELECT EndpointUrl FROM OpcServers WHERE Id=?)",
            server_id,
        )
        count = cur.fetchone()[0]
        if count > 0:
            raise HTTPException(status_code=400, detail="Сначала удалите все задачи, связанные с этим сервером")
        cur.execute("DELETE FROM OpcServers WHERE Id=?", server_id)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}


@router.get("/servers", response_model=List[OpcServerDTO])
def list_servers():
    servers: List[OpcServerDTO] = []
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, EndpointUrl, Description FROM OpcServers")
        for row in cursor.fetchall():
            servers.append(OpcServerDTO(id=row[0], name=row[1], endpoint_url=row[2], description=row[3]))
    return servers


@router.post("/servers", response_model=OpcServerDTO)
def create_server(server: OpcServerDTO):
    encrypted_password = encrypt_password(server.opcPassword)
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO OpcServers (Name, EndpointUrl, Description, OpcUsername, OpcPassword, SecurityPolicy, SecurityMode)
            OUTPUT INSERTED.Id
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            server.name,
            server.endpoint_url,
            server.description,
            server.opcUsername,
            encrypted_password,
            server.securityPolicy,
            server.securityMode,
        )
        new_id = cursor.fetchone()[0]
        conn.commit()
    return OpcServerDTO(
        id=new_id,
        name=server.name,
        endpoint_url=server.endpoint_url,
        description=server.description,
        opcUsername=server.opcUsername,
        securityPolicy=server.securityPolicy,
        securityMode=server.securityMode,
    )


def get_server_config(endpoint_url: str):
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT OpcUsername, OpcPassword, SecurityPolicy, SecurityMode
            FROM OpcServers WHERE EndpointUrl = ?
            """,
            endpoint_url,
        )
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
# Low-level sync ops (to be run in threads)
# -----------------------------------------------------------------------------
def _probe_sync(endpoint: str, username: Optional[str], password: Optional[str],
                policy: str, mode: str) -> bool:
    cl = make_client_sync(endpoint, username, password, policy, mode)
    try:
        cl.connect()
        _ = cl.nodes.root.get_children()
        return True
    finally:
        try:
            cl.disconnect()
        except Exception:
            pass


def _browse_children_sync(endpoint: str, node_id: str,
                          username: Optional[str], password: Optional[str],
                          policy: str, mode: str) -> List[Dict]:
    cl = make_client_sync(endpoint, username, password, policy, mode)
    res: List[Dict] = []
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
                res.append({
                    "browse_name": _safe_to_str(getattr(bname, "Name", bname)),
                    "node_id": ch.nodeid.to_string(),
                    "node_class": node_class_str,
                    "has_children": has_children,
                })
            except Exception:
                # пропускаем проблемные ноды
                continue
        return res
    finally:
        try:
            cl.disconnect()
        except Exception:
            pass


def _browse_all_vars_sync(endpoint: str, start_node_id: str,
                          username: Optional[str], password: Optional[str],
                          policy: str, mode: str) -> List[Dict]:
    cl = make_client_sync(endpoint, username, password, policy, mode)
    out: List[Dict] = []

    def walk(node, path: str):
        try:
            bname = node.get_browse_name()
            name = _safe_to_str(getattr(bname, "Name", bname))
        except Exception as e:
            name = "<error>"
        cur_path = (path + "/" + name).strip("/") if path else name

        try:
            children = node.get_children()
        except Exception as e:
            # ВАЖНО: не проглатываем – добавим в out для диагностики
            out.append({"browse_name": cur_path, "node_id": node.nodeid.to_string(),
                        "node_class": "Error", "data_type": "", "path": path,
                        "error": f"get_children failed: {e}"})
            return

        for ch in children:
            try:
                nclass = ch.get_node_class()
                bn = ch.get_browse_name()
                nm = _safe_to_str(getattr(bn, "Name", bn))
                if nclass == ua.NodeClass.Variable:
                    try:
                        dtype = str(ch.get_data_type_as_variant_type())
                    except Exception:
                        dtype = ""
                    out.append({
                        "browse_name": nm,
                        "node_id": ch.nodeid.to_string(),
                        "data_type": dtype,
                        "node_class": "variable",
                        "path": cur_path,
                    })
                elif nclass == ua.NodeClass.Object:
                    walk(ch, cur_path)
            except Exception:
                continue

    try:
        cl.connect()
        # Стартуем с ObjectsFolder (устойчивее, чем «i=85»)
        try:
            start = cl.get_objects_node()
        except Exception:
            # фоллбек: явный идентификатор
            start = cl.get_node(ensure_full_nodeid(start_node_id))
        walk(start, "")
        return out
    finally:
        try:
            cl.disconnect()
        except Exception:
            pass


@router.get("/whoami")
def whoami():
    import sys
    return {
        "python": sys.executable,
        "cwd": os.getcwd(),
        "client_cert": CLIENT_CERT_PATH,
        "client_key": CLIENT_KEY_PATH,
    }


# -----------------------------------------------------------------------------
# SSE: сетевой скан
# -----------------------------------------------------------------------------
@router.get("/netscan_stream")
async def netscan_stream(
    request: Request,
    ip_start: str,
    ip_end: str,
    ports: str = "4840",
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query(DEFAULT_OPC_SECURITY_POLICY, alias="securityPolicy"),
    securityMode: str = Query(DEFAULT_OPC_SECURITY_MODE, alias="securityMode"),
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
                url = f"opc.tcp://{ip}:{port}"
                try:
                    ok = await asyncio.to_thread(
                        _probe_sync, url,
                        opcUsername or None, opcPassword or None,
                        securityPolicy, securityMode
                    )
                except Exception:
                    ok = False
                if ok:
                    found.append(url)
                    yield f"data: {json.dumps({'type':'found','url':url})}\n\n"
                await asyncio.sleep(0.01)
                if await request.is_disconnected():
                    return
        yield f"data: {json.dumps({'type':'finish','found':found})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/netscan")
async def netscan(
    ip_start: str = Query(..., example="192.168.11.1"),
    ip_end: str = Query(..., example="192.168.11.135"),
    ports: str = Query("4840", example="4840,4849"),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query(DEFAULT_OPC_SECURITY_POLICY, alias="securityPolicy"),
    securityMode: str = Query(DEFAULT_OPC_SECURITY_MODE, alias="securityMode"),
):
    ports_list = [int(p) for p in ports.split(",") if p.strip().isdigit()]
    ips = [str(ipaddress.IPv4Address(ip)) for ip in range(
        int(ipaddress.IPv4Address(ip_start)),
        int(ipaddress.IPv4Address(ip_end)) + 1
    )]

    async def probe_one(ip: str, port: int) -> Tuple[str, bool]:
        url = f"opc.tcp://{ip}:{port}"
        try:
            ok = await asyncio.to_thread(
                _probe_sync, url,
                opcUsername or None, opcPassword or None,
                securityPolicy, securityMode
            )
            return url, ok
        except Exception:
            return url, False

    tasks = [probe_one(ip, port) for ip in ips for port in ports_list]
    results = await asyncio.gather(*tasks)
    found = [url for url, ok in results if ok]
    return {"ok": bool(found), "found_endpoints": found,
            "message": "Найдены OPC UA серверы" if found else "Сервера не найдены"}


# -----------------------------------------------------------------------------
# Проверка конкретного endpoint
# -----------------------------------------------------------------------------
@router.get("/probe")
async def probe_server(
    endpoint_url: str = Query(...),
    opcUsername: str = Query("", alias="opcUsername"),
    opcPassword: str = Query("", alias="opcPassword"),
    securityPolicy: str = Query(DEFAULT_OPC_SECURITY_POLICY, alias="securityPolicy"),
    securityMode: str = Query(DEFAULT_OPC_SECURITY_MODE, alias="securityMode"),
):
    if not endpoint_url:
        raise HTTPException(status_code=400, detail="Не передан endpoint_url")
    try:
        ok = await asyncio.to_thread(
            _probe_sync, endpoint_url,
            opcUsername or None, opcPassword or None,
            securityPolicy, securityMode
        )
        if ok:
            return {"ok": True, "endpoint_url": endpoint_url, "message": "✅ OPC UA сервер доступен"}
        else:
            return {"ok": False, "endpoint_url": endpoint_url, "message": "❌ Нет доступа"}
    except Exception as ex:
        return {"ok": False, "endpoint_url": endpoint_url, "message": f"❌ Ошибка: {ex}"}


# -----------------------------------------------------------------------------
# Browse API
# -----------------------------------------------------------------------------
@router.post("/browse")
async def browse_node_api(
    endpoint_url: str = Body(...),
    node_id: str = Body("i=85"),
    username: Optional[str] = Body(None),
    password: Optional[str] = Body(None),
    security_policy: str = Body(DEFAULT_OPC_SECURITY_POLICY),
    security_mode: str = Body(DEFAULT_OPC_SECURITY_MODE),
):
    try:
        u, p, pol, mode = resolve_creds(endpoint_url, username, password, security_policy, security_mode)
        res = await asyncio.to_thread(
            _browse_children_sync, endpoint_url, node_id,
            u, p, pol, mode
        )

        return {"ok": True, "children": res}
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
    securityPolicy: str = Body(DEFAULT_OPC_SECURITY_POLICY),
    securityMode: str = Body(DEFAULT_OPC_SECURITY_MODE),
):
    try:
        u, p, pol, mode = resolve_creds(endpoint_url, opcUsername or None, opcPassword or None, securityPolicy, securityMode)
        tags = await asyncio.to_thread(
            _browse_all_vars_sync, endpoint_url, "i=85",
            u, p, pol, mode
        )


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
                        "",
                    )
                    inserted += 1
                except Exception:
                    pass
            conn.commit()

        return {"ok": True, "found": len(tags), "inserted": inserted,
                "debug_first_tags": tags[:5], "debug_server_id": server_id}
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


def _poll_and_save_sync(
    endpoint_url: str,
    tags: List[TagInfo],
    interval: float,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str,
):
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

    cl = make_client_sync(endpoint_url, username, password, policy, mode)
    cl.connect()
    try:
        while True:
            values: List[Tuple[str, float, datetime.datetime]] = []
            now = datetime.datetime.now()
            for t in tags:
                nodeid = ensure_full_nodeid(t.node_id)
                try:
                    val = cl.get_node(nodeid).get_value()
                    values.append((t.node_id, val, now))
                except Exception:
                    # просто пропускаем проблемный тег
                    continue
            if values:
                with _db() as conn:
                    cur = conn.cursor()
                    for node_id, val, dt in values:
                        tag_id = nodeid_to_tagid.get(node_id)
                        if tag_id is not None:
                            cur.execute(
                                "INSERT INTO OpcData (TagId, Value, Timestamp) VALUES (?, ?, ?)",
                                tag_id, val, dt
                            )
                    conn.commit()
            # сон
            time.sleep(interval)
    finally:
        try:
            cl.disconnect()
        except Exception:
            pass


@router.post("/start_polling")
async def start_polling(req: PollingRequest):
    endpoint_url = req.endpoint_url
    tags = req.tags
    interval = req.interval
    task_id = f"{endpoint_url}:" + ",".join([t.node_id for t in tags])

    # Запускаем sync-задачу (функцию) через tasks_manager
    def runner():
        _poll_and_save_sync(
            endpoint_url=endpoint_url,
            tags=tags,
            interval=interval,
            username=req.username,
            password=req.password,
            policy=req.security_policy,
            mode=req.security_mode,
        )

    if not tasks_manager.start(task_id, runner):
        return {"ok": False, "message": "Уже выполняется"}
    return {"ok": True, "message": "Циклический опрос запущен", "task_id": task_id}


@router.post("/stop_polling")
async def stop_polling(req: StopPollingRequest):
    tasks_manager.stop(req.task_id)
    return {"ok": True, "message": "Опрос остановлен"}
