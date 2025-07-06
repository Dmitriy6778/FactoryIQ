# servers.py
from dotenv import load_dotenv
load_dotenv()
from fastapi import APIRouter, Query, Request, Body
from fastapi.responses import StreamingResponse
from .models import OpcServer
from ..db import get_db_connection
import asyncio
import ipaddress
import socket
import json
from ..tasks_manager import tasks_manager
from fastapi import BackgroundTasks
from fastapi import HTTPException
from asyncua import Client
from app.utils.crypto_helper import encrypt_password, decrypt_password
from pydantic import BaseModel
from typing import Optional
from asyncua import ua
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256
import os
router = APIRouter(prefix="/servers", tags=["servers"])

# ----------------------
# CRUD Эндпоинты OPC UA серверов
# ----------------------

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

class OpcServer(BaseModel):
    id: Optional[int] = None
    name: str
    endpoint_url: str
    description: Optional[str] = ""
    opcUsername: Optional[str] = ""
    opcPassword: Optional[str] = ""   # <--- добавь это!
    securityPolicy: Optional[str] = ""
    securityMode: Optional[str] = ""

OPC_SECURITY_POLICIES = [
    "Basic256Sha256",
    "Basic128Rsa15",
    "None",
]
OPC_SECURITY_MODES = [
    "None",
    "Sign",
    "SignAndEncrypt",
]
DEFAULT_OPC_SECURITY_POLICY = "Basic256Sha256"
DEFAULT_OPC_SECURITY_MODE = "Sign"


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень /app

CLIENT_CERT_PATH = os.path.join(BASE_DIR, "client.der")
CLIENT_KEY_PATH = os.path.join(BASE_DIR, "client_private.der")
SERVER_CERT_PATH = os.path.join(BASE_DIR, "pki", "trusted", "certs", "PLC-PE_OPCUA.der")
@router.get("/opc_security_options")
def get_opc_security_options():
    return {
        "policies": OPC_SECURITY_POLICIES,
        "modes": OPC_SECURITY_MODES,
        "defaultPolicy": DEFAULT_OPC_SECURITY_POLICY,
        "defaultMode": DEFAULT_OPC_SECURITY_MODE,
    }


def get_server_credentials(endpoint_url):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT OpcUsername, OpcPassword, SecurityPolicy, SecurityMode
            FROM OpcServers WHERE EndpointUrl=?
        """, endpoint_url)
        row = cursor.fetchone()
        if row:
            username, enc_password, policy, mode = row
            password = decrypt_password(enc_password) if enc_password else None
            return username, password, policy, mode
        return None, None, None, None
    

async def get_configured_client(
    endpoint_url: str,
    username: str | None = None,
    password: str | None = None,
    security_policy: str = None,
    security_mode: str = None
) -> Client:
    # Игнорируем SECURITY_POLICY_MAP — всегда используем класс политики!
    if not username or not password or not security_policy or not security_mode:
        db_username, db_password, db_policy, db_mode = get_server_credentials(endpoint_url)
        username = username or db_username
        password = password or db_password
        security_policy = security_policy or db_policy or "Basic256Sha256"
        security_mode = security_mode or db_mode or "Sign"

    # Только такой класс для Siemens и большинства OPC UA!
    policy_class = SecurityPolicyBasic256Sha256
    mode_enum = getattr(ua.MessageSecurityMode, security_mode or "Sign")

    print(f"CONNECTING with policy_class={policy_class}, security_mode={mode_enum}")  # debug
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
    # 1. Оставляем только переменные
    if tag.get("node_class", "").lower() != "variable":
        return False

    # 2. Явно отбрасываем служебные browse_name/NodeId
    banned_prefixes = (
        "Server", "Namespace", "UrisVersion", "Session", "Status",
        "Aggregate", "Password", "Certificate", "User", "Array", "Vendor", "LastChange"
    )
    browse_name = str(tag.get("browse_name", ""))
    if any(browse_name.startswith(bp) for bp in banned_prefixes):
        return False
    if browse_name.lower() in ("identities", "applications", "endpoints", "configuration"):
        return False

    # 3. Исключаем все, что похоже на urn или массивы/структуры
    dt = str(tag.get("data_type") or "")
    if dt.startswith("urn:") or "structure" in dt.lower() or "array" in dt.lower():
        return False

    # 4. Значение не должно быть списком или urn-строкой
    val = tag.get("value")
    if isinstance(val, list) or (isinstance(val, str) and val.startswith("urn:")):
        return False

    return True


# Функция для проверки/создания тегов и возврата словаря node_id -> tag_id
def ensure_tags_and_get_ids(conn, server_id, tags):
    try:
        nodeid_to_tagid = {}
        node_ids = [t['node_id'] for t in tags]
        print(f"===> [ENSURE] Проверяем теги: {node_ids}")

        if not node_ids:
            print("===> [ENSURE] node_ids пустой!")
            return nodeid_to_tagid

        # Получаем уже существующие теги по server_id и node_id
        format_strings = ','.join('?' for _ in node_ids)
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT Id, NodeId FROM OpcTags WHERE ServerId=? AND NodeId IN ({format_strings})",
            [server_id] + node_ids
        )
        for row in cursor.fetchall():
            nodeid_to_tagid[row[1]] = row[0]

        # Вставляем только те, которых нет в базе
        for tag in tags:
            if tag['node_id'] not in nodeid_to_tagid:
                try:
                    cursor.execute(
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
                    inserted_id = cursor.fetchone()[0]
                    nodeid_to_tagid[tag['node_id']] = inserted_id
                except Exception as insert_ex:
                    # Если дубль (уникальный ключ) - получаем ID из базы
                    print(f"[ENSURE] Дубль для {tag['node_id']}: {insert_ex}")
                    cursor.execute(
                        "SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?",
                        server_id, tag['node_id']
                    )
                    row = cursor.fetchone()
                    if row:
                        nodeid_to_tagid[tag['node_id']] = row[0]
        conn.commit()
        print(f"===> [ENSURE] Итоговая мапа тегов: {nodeid_to_tagid}")
        return nodeid_to_tagid
    except Exception as e:
        print(f"===> [ENSURE] Ошибка в ensure_tags_and_get_ids: {e}")
        raise



@router.put("/servers/{server_id}")
def update_server(server_id: int, server: dict):
    from ..db import get_db_connection
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE OpcServers SET Name=?, EndpointUrl=?, Description=? WHERE Id=?",
            server.get("name"), server.get("endpoint_url"), server.get("description", ""), server_id
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}

@router.delete("/servers/{server_id}")
def delete_server(server_id: int):
    from ..db import get_db_connection
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Проверка что нет задач
        cursor.execute("SELECT COUNT(*) FROM PollingTasks WHERE server_url = (SELECT EndpointUrl FROM OpcServers WHERE Id=?)", server_id)
        count = cursor.fetchone()[0]
        if count > 0:
            raise HTTPException(status_code=400, detail="Сначала удалите все задачи, связанные с этим сервером")
        cursor.execute("DELETE FROM OpcServers WHERE Id=?", server_id)
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Server not found")
        conn.commit()
    return {"ok": True}


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
        print("====> [DEBUG] poll_and_save стартовал!")

        from ..db import get_db_connection
        tag_dicts = [t.dict() for t in tags]

        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT Id FROM OpcServers WHERE EndpointUrl = ?", endpoint_url)
            row = cursor.fetchone()
            if not row:
                print(f"===> [POLL] Сервер {endpoint_url} не найден в базе!")
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
                            print(f"Ошибка чтения {t.node_id}: {e}")
                    with get_db_connection() as conn:
                        cursor = conn.cursor()
                        for node_id, val, dt in values:
                            tag_id = nodeid_to_tagid[node_id]
                            cursor.execute(
                                "INSERT INTO OpcData (TagId, Value, Timestamp) VALUES (?, ?, ?)",
                                tag_id, val, dt)
                        conn.commit()
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    break
                except Exception as ex:
                    print(f"===> Polling error: {ex}")
                    await asyncio.sleep(interval)

    if not tasks_manager.start(task_id, poll_and_save()):
        return {"ok": False, "message": "Уже выполняется"}
    return {"ok": True, "message": "Циклический опрос запущен"}

@router.post("/stop_polling")
async def stop_polling(req: StopPollingRequest):
    tasks_manager.stop(req.task_id)
    return {"ok": True, "message": "Опрос остановлен"}

@router.get("/servers", response_model=list[OpcServer])
def list_servers():
    servers = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, EndpointUrl, Description FROM OpcServers")
        for row in cursor.fetchall():
            servers.append(OpcServer(
                id=row[0], name=row[1], endpoint_url=row[2], description=row[3] 
            ))
    return servers
# routers/servers.py

@router.post("/servers", response_model=OpcServer)
def create_server(server: OpcServer):
    encrypted_password = encrypt_password(server.opcPassword)
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO OpcServers (Name, EndpointUrl, Description, OpcUsername, OpcPassword, SecurityPolicy, SecurityMode)
            OUTPUT INSERTED.Id
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, server.name, server.endpoint_url, server.description,
             server.opcUsername, encrypted_password, server.securityPolicy, server.securityMode)
        new_id = cursor.fetchone()[0]
    return OpcServer(id=new_id, name=server.name, endpoint_url=server.endpoint_url)


def get_server_config(endpoint_url: str):
    with get_db_connection() as conn:
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

# ----------------------
# SSE (лог поиска серверов по сети)
# ----------------------
@router.get("/netscan_stream")
async def netscan_stream(
    request: Request,
    ip_start: str,
    ip_end: str,
    ports: str = "4840"
):
    ports = [int(p) for p in ports.split(",") if p.strip().isdigit()]
    ips = [str(ipaddress.IPv4Address(ip)) for ip in range(
        int(ipaddress.IPv4Address(ip_start)),
        int(ipaddress.IPv4Address(ip_end)) + 1
    )]

    async def event_generator():
        found = []
        for ip in ips:
            for port in ports:
                # Лог: проверяем IP:port
                log_msg = {"type": "log", "ip": ip, "port": port}
                yield f"data: {json.dumps(log_msg)}\n\n"
                url, ok = await probe_opcua_endpoint(ip, port)
                if ok:
                    found.append(url)
                    found_msg = {"type": "found", "url": url}
                    yield f"data: {json.dumps(found_msg)}\n\n"
                await asyncio.sleep(0.01)
                if await request.is_disconnected():
                    return
        finish_msg = {"type": "finish", "found": found}
        yield f"data: {json.dumps(finish_msg)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ----------------------
# Классический однократный поиск (без лога, обычный ответ)
# ----------------------

async def probe_opcua_endpoint(
    ip, port=4840, timeout=1.5,
    username=None, password=None,
    security_policy="Basic256Sha256",
    security_mode="Sign"
):
    url = f"opc.tcp://{ip}:{port}"
    print(f"[DEBUG] probe_opcua_endpoint: {url} | {username=} {password=} {security_policy=} {security_mode=}")
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
    ports = [int(p) for p in ports.split(",") if p.strip().isdigit()]
    ips = [str(ipaddress.IPv4Address(ip)) for ip in range(
        int(ipaddress.IPv4Address(ip_start)),
        int(ipaddress.IPv4Address(ip_end)) + 1
    )]

    tasks = []
    for ip in ips:
        for port in ports:
            tasks.append(probe_opcua_endpoint(
                ip, port=port,
                username=opcUsername or None,
                password=opcPassword or None,
                security_policy=securityPolicy,
                security_mode=securityMode,
            ))

    found = []
    results = await asyncio.gather(*tasks)
    for url, ok in results:
        if ok:
            found.append(url)

    return {
        "ok": bool(found),
        "found_endpoints": found,
        "message": "Найдены OPC UA серверы" if found else "Сервера не найдены"
    }

# ----------------------
# Проверка конкретного endpoint
# ----------------------



async def check_opc(
    endpoint: str,
    username: Optional[str],
    password: Optional[str],
    policy: str,
    mode: str
) -> bool | str:
    try:
        from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256
        from asyncua import ua

        # ТОЛЬКО поддержка Basic256Sha256
        policy_class = SecurityPolicyBasic256Sha256
        mode_enum = getattr(ua.MessageSecurityMode, mode, ua.MessageSecurityMode.Sign)
        print(f"[DEBUG] endpoint={endpoint}")
        print(f"[DEBUG] CLIENT_CERT_PATH={CLIENT_CERT_PATH}")
        print(f"[DEBUG] CLIENT_KEY_PATH={CLIENT_KEY_PATH}")

        client = Client(endpoint)
        await client.set_security(
            policy=policy_class,
            certificate=CLIENT_CERT_PATH,
            private_key=CLIENT_KEY_PATH,
            server_certificate=None,  # <<< вот это КРИТИЧНО!
            mode=mode_enum,
        )
        print("[DEBUG] Application URI:", client.application_uri)

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
    """
    Пробует подключиться к OPC UA endpoint с заданными параметрами безопасности.
    """
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
        return {
            "ok": True,
            "endpoint_url": endpoint_url,
            "message": "✅ OPC UA сервер доступен"
        }
    else:
        return {
            "ok": False,
            "endpoint_url": endpoint_url,
            "message": f"❌ Ошибка: {res}"
        }
@router.post("/start_with_browse")
async def start_with_browse(req: PollingRequest):
    endpoint_url = req.endpoint_url
    interval = req.interval
    task_tags = []

    # node_id можно брать из запроса или по умолчанию "i=85"
    node_id = getattr(req, "node_id", "i=85")
    print(f"===> [BROWSE] Подключаемся к {endpoint_url} и ищем ВСЕ теги, начиная с {node_id}...")

    try:
        # ПРАВИЛЬНО передаем security_policy и security_mode!
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
            print(f"===> [BROWSE] Пройдена фильтрация: {len(filtered_tags)} из {len(found_tags)}")
            for tag in filtered_tags:  # БЕРЁМ filtered_tags, а не found_tags!
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
        print(f"===> [BROWSE] Ошибка: {e}")
        return {"ok": False, "message": f"Ошибка при browse: {str(e)}"}


async def browse_all_tags(client, node=None, level=0):
   
    result = []
    if node is None:
        node = client.get_node("i=85")  # Корень OPC UA
    try:
        bname = await node.read_browse_name()
        print("  " * level + f"[browse] {bname.Name} ({node.nodeid.to_string()})")
    except Exception as e:
        print("  " * level + f"[browse] [ERROR READ NAME] {node.nodeid.to_string()} | {e}")

    children = await node.get_children()
    for child in children:
        try:
            nodeclass = await child.read_node_class()
            bname = await child.read_browse_name()
            print("  " * (level+1) + f"- {bname.Name} [{str(nodeclass).replace('NodeClass.', '')}] {child.nodeid.to_string()}")
            if nodeclass == ua.NodeClass.Variable:
                dtype = str(await child.read_data_type_as_variant_type())
                result.append({
                    "browse_name": bname.Name,
                    "node_id": child.nodeid.to_string(),
                    "data_type": dtype
                })
            elif nodeclass == ua.NodeClass.Object:
                result += await browse_all_tags(client, child, level+1)
        except Exception as e:
            print("  " * (level+1) + f"[ERROR CHILD] {e}")
            continue
    return result


@router.post("/browse")
async def browse_node_api(
    endpoint_url: str = Body(...),
    node_id: str = Body("i=85"),
    username: str = Body(None),
    password: str = Body(None),
    security_policy: str = Body("Basic256Sha256"),
    security_mode: str = Body("Sign"),
):
    """
    Возвращает детей указанного node_id (по умолчанию i=85) + признак has_children и node_class как строку.
    """
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
                    # Преобразуем node_class в строку
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
                    # Проверяем есть ли у узла дети (лениво, быстро)
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
    
@router.post("/scan_full_tree")
async def scan_full_tree(
    server_id: int = Body(...),
    endpoint_url: str = Body(...),
    opcUsername: str = Body(""),
    opcPassword: str = Body(""),
    securityPolicy: str = Body("Basic256Sha256"),
    securityMode: str = Body("Sign"),
):
    """
    Полностью рекурсивно обходит все дерево OPC UA, сохраняет карту тегов (все переменные) в базу OpcTags.
    После этого фронт работает только с базой, а не с ПЛК!
    """
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


    async def browse_all(client, node, parent_path=""):
        result = []
        try:
            bname = safe_to_str((await node.read_browse_name()).Name)
        except Exception:
            bname = "<error>"
        path = (parent_path + "/" + bname).strip("/") if parent_path else bname
        children = await node.get_children()
        print(f"[SCAN_TREE] Node: {path} | children: {len(children)}")
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
                    print(f"[SCAN_TREE]  VAR: {bname} {child.nodeid.to_string()} dtype={dtype} path={path}")
                    result.append({
                        "browse_name": bname,
                        "node_id": safe_to_str(child.nodeid.to_string()),
                        "data_type": dtype,
                        "path": path
                    })
                elif nodeclass == ua.NodeClass.Object:
                    try:
                        object_type = await child.read_type_definition()
                        print(f"[SCAN_TREE]  OBJ: {bname} {child.nodeid.to_string()} ObjectType={object_type.to_string()}")
                    except Exception as ex:
                        print(f"[SCAN_TREE]  OBJ: {bname} {child.nodeid.to_string()} [ObjectType не определен]: {ex}")
                    result += await browse_all(client, child, path)
                else:
                    print(f"[SCAN_TREE]  SKIP: {bname} {child.nodeid.to_string()} class={nodeclass}")
            except Exception as ex:
                print(f"[SCAN_TREE] Ошибка на {getattr(child, 'nodeid', '?')}: {ex}")
                continue
        return result


    # Основная логика
    try:
        print("[SCAN_TREE] === СТАРТ ===")
        print(f"[SCAN_TREE] server_id: {server_id}, endpoint_url: {endpoint_url}")
        print(f"[SCAN_TREE] securityPolicy: {securityPolicy}, securityMode: {securityMode}")
        print(f"[SCAN_TREE] opcUsername: {opcUsername}, opcPassword: {'***' if opcPassword else ''}")

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

        print(f"[SCAN_TREE] === ОБХОД ЗАВЕРШЕН ===")
        print(f"[SCAN_TREE] Всего найдено: {len(tags)}")
        for t in tags[:10]:
            print("[SCAN_TREE] Первый тег:", t)

        # --- Сохраняем всё в базу ---
        with get_db_connection() as conn:
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
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        server_id,
                        tag.get("browse_name", ""),
                        node_id,
                        tag.get("data_type", ""),
                        tag.get("path", ""),
                        ""
                    )
                    inserted += 1
                except Exception as ex:
                    print(f"[SCAN_TREE] Ошибка при вставке: {ex}")
            conn.commit()

        print(f"[SCAN_TREE] === СОХРАНЕНО В БАЗУ: {inserted} ===")
        return {
            "ok": True,
            "found": len(tags),
            "inserted": inserted,
            "debug_first_tags": tags[:5],
            "debug_server_id": server_id
        }
    except Exception as ex:
        import traceback
        tb = traceback.format_exc()
        print("[SCAN_TREE] ГЛОБАЛЬНАЯ ОШИБКА:", tb)
        return {"ok": False, "error": str(ex), "trace": tb}
