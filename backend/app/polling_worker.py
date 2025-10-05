# app/opc_polling_worker.py
import os
import threading
import time
import pyodbc
import asyncio
from asyncua import Client
from cryptography.fernet import Fernet
from dotenv import load_dotenv

# Загружаем .env (config.get_conn_str тоже подхватывает .env из корня)
load_dotenv()

from config import get_conn_str, get_env

# Пути к клиентским сертификатам (если используются)
CERT_PATH = os.path.abspath("app/client_cert.pem")
KEY_PATH  = os.path.abspath("app/client_private.pem")

# Таймаут OPC-клиента в секундах (можно переопределить в .env)
OPC_TIMEOUT_SEC = int(get_env("OPC_TIMEOUT_SEC", "15"))

# Ключ для расшифровки паролей
FERNET_KEY = os.getenv("FERNET_KEY")
if FERNET_KEY is None:
    raise RuntimeError("FERNET_KEY not set in environment!")
fernet = Fernet(FERNET_KEY.encode())


# ----------------------------- УТИЛИТЫ -----------------------------
def get_task_tags(conn, polling_task_id):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT t.Id, t.NodeId, t.BrowseName, t.DataType
        FROM PollingTaskTags pt
        JOIN OpcTags t ON pt.tag_id = t.Id
        WHERE pt.polling_task_id = ?
        """,
        polling_task_id,
    )
    return cur.fetchall()


def safe_float(val):
    try:
        if val is None:
            return None
        s = str(val).strip()
        if s == "" or s.lower() in ("nan", "inf", "-inf"):
            return None
        return float(val)
    except Exception:
        return None


def build_security_string(security_policy: str | None,
                          security_mode: str | None,
                          have_cert: bool) -> str:
    """
    Формирует строку безопасности для asyncua.Client.set_security_string.
    Примеры:
      "Basic256Sha256,SignAndEncrypt,client_cert.pem,client_key.pem"
      "None,None,,"
    """
    pol = (security_policy or "None").strip()
    mode = (security_mode or "None").strip()
    if pol.lower() == "none" or mode.lower() == "none":
        return "None,None,,"
    if have_cert:
        return f"{pol},{mode},{CERT_PATH},{KEY_PATH}"
    # Если сертификатов нет — оставим пустые пути (сервер сам решит).
    return f"{pol},{mode},,"


def bulk_fetch_tag_ids(conn, nodeids):
    """
    Получает маппинг NodeId -> TagId одним запросом (WHERE IN (...)).
    """
    if not nodeids:
        return {}
    # Уберём дубликаты и None
    uniq = [n for n in dict.fromkeys(nodeids) if n]
    if not uniq:
        return {}
    placeholders = ",".join("?" for _ in uniq)
    sql = f"SELECT Id, NodeId FROM OpcTags WHERE NodeId IN ({placeholders})"
    cur = conn.cursor()
    cur.execute(sql, uniq)
    mapping = {}
    for tid, node in cur.fetchall():
        mapping[str(node)] = int(tid)
    return mapping


# --------------------------- ОСНОВНОЙ ОПРОС ---------------------------
def poll_task(task_id, server_url, tag_nodeids, interval_seconds, stop_event,
              username, password, security_policy, security_mode):
    async def do_poll():
        notified_stop = False
        backoff = 5  # сек, экспоненциальный рост до 60

        while not stop_event.is_set():
            try:
                print(
                    f"[POLL WORKER] Connecting to {server_url} "
                    f"(policy={security_policy}, mode={security_mode}, user={'<set>' if username else 'anonymous'})"
                )
                client = Client(server_url, timeout=OPC_TIMEOUT_SEC)

                # Безопасность
                have_cert = os.path.isfile(CERT_PATH) and os.path.isfile(KEY_PATH)
                security_str = build_security_string(security_policy, security_mode, have_cert)
                # ВАЖНО: в твоей версии asyncua это КОРУТИНА — нужен await
                await client.set_security_string(security_str)

                # Аутентификация
                if username:
                    client.set_user(username)
                if password:
                    client.set_password(password)

                # Диагностика доступных endpoint'ов — через отдельный «пробный» клиент
                try:
                    async with Client(server_url, timeout=OPC_TIMEOUT_SEC) as probe:
                        eps = await probe.get_endpoints()
                        print("=== Endpoint Descriptions ===")
                        for ep in eps:
                            tokens = [getattr(t, "TokenType", None) for t in (ep.UserIdentityTokens or [])]
                            print(f"PolicyUri={ep.SecurityPolicyUri} | Mode={ep.SecurityMode} | Tokens={tokens}")
                except Exception as ex:
                    print(f"[DEBUG] Не удалось получить endpoint descriptions: {type(ex).__name__}: {repr(ex)}")

                # Устанавливаем сессию
                try:
                    await client.connect()
                except Exception as ex:
                    print(f"[POLL WORKER] Ошибка при client.connect(): {type(ex).__name__}: {repr(ex)}")
                    # ПЛК может быть офлайн — не валимся, ждём и пробуем снова (с бэкофом)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60)
                    continue

                # Успешно подключились — сбросим бэкоф
                backoff = 5

                # Основной цикл чтения в рамках установленной сессии
                try:
                    while not stop_event.is_set():
                        # Проверим активность задачи (одним запросом)
                        try:
                            with pyodbc.connect(get_conn_str()) as conn:
                                cur = conn.cursor()
                                cur.execute("SELECT is_active FROM PollingTasks WHERE id=?", task_id)
                                row = cur.fetchone()
                                if not row or not bool(row[0]):
                                    if not notified_stop:
                                        print(f"[POLL WORKER] Task {task_id} остановлена.")
                                        notified_stop = True
                                    stop_event.set()
                                    break

                                # Маппинг NodeId -> TagId одним батчем
                                tag_id_map = bulk_fetch_tag_ids(conn, tag_nodeids)

                                # Чтение значений OPC и запись в БД
                                inserted = 0
                                for nodeid in tag_nodeids:
                                    try:
                                        val = await client.get_node(nodeid).get_value()
                                        float_val = safe_float(val)
                                        if float_val is None:
                                            continue  # пропускаем пустые/NaN/inf
                                        tag_id = tag_id_map.get(nodeid)
                                        if not tag_id:
                                            continue
                                        cur.execute(
                                            "INSERT INTO OpcData (TagId, Value, Timestamp, Status) "
                                            "VALUES (?, ?, GETDATE(), 'Good')",
                                            tag_id, float_val
                                        )
                                        inserted += 1
                                    except Exception as read_ex:
                                        print(f"[POLL WORKER] Ошибка чтения {nodeid}: {type(read_ex).__name__}: {repr(read_ex)}")

                                if inserted:
                                    conn.commit()

                        except pyodbc.Error as db_ex:
                            print(f"[POLL WORKER] DB error: {type(db_ex).__name__}: {repr(db_ex)}")

                        # Пауза между циклами опроса
                        await asyncio.sleep(interval_seconds)

                finally:
                    try:
                        await client.disconnect()
                    except Exception as disc_ex:
                        print(f"[POLL WORKER] Ошибка при disconnect(): {type(disc_ex).__name__}: {repr(disc_ex)}")

            except Exception as e:
                # Ошибка верхнего уровня по подключению/безопасности/и т.п.
                print(f"[POLL WORKER] Ошибка подключения к серверу {server_url}: {type(e).__name__}: {repr(e)}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

        print(f"[POLL WORKER] Task {task_id} polling loop завершён.")

    # Запускаем отдельный event-loop в этом потоке
    asyncio.run(do_poll())


# ----------------------- ДИСПЕТЧЕР ПОТОКОВ ------------------------
def polling_worker():
    print("[POLL WORKER] Старт фонового воркера polling_worker")
    running_tasks = {}
    # счётчик «пропусков» для задач
    missing_counts = {}

    while True:
        active_ids = set()
        try:
            with pyodbc.connect(get_conn_str()) as conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT t.id, t.server_url, i.IntervalSeconds,
                           s.OpcUsername, s.OpcPassword, s.SecurityPolicy, s.SecurityMode
                    FROM PollingTasks t
                    JOIN PollingIntervals i ON t.interval_id = i.Id
                    JOIN OpcServers s ON t.server_url = s.EndpointUrl
                    WHERE t.is_active = 1
                """)
                rows = cur.fetchall()
                for row in rows:
                    task_id, server_url, interval_seconds, username, password, security_policy, security_mode = row
                    active_ids.add(task_id)
                    missing_counts[task_id] = 0  # видим задачу — сбрасываем пропуски

                    # Теги задачи
                    tag_rows = get_task_tags(conn, task_id)
                    tag_nodeids = [r[1] for r in tag_rows]  # берем NodeId

                    # Расшифровка пароля (если хранится зашифрованным)
                    if password:
                        try:
                            password = fernet.decrypt(password.encode()).decode()
                        except Exception as e:
                            # Возможно, пароль уже в открытом виде
                            print(f"[POLL WORKER] Ошибка расшифровки пароля (task={task_id}): {type(e).__name__}: {repr(e)}")
                            # Оставим как есть

                    need_start = (
                        task_id not in running_tasks
                        or not running_tasks[task_id]["thread"].is_alive()
                    )

                    if need_start:
                        stop_event = threading.Event()
                        t = threading.Thread(
                            target=poll_task,
                            args=(
                                task_id,
                                server_url,
                                tag_nodeids,
                                interval_seconds,
                                stop_event,
                                username or "",
                                password or "",
                                security_policy or "None",
                                security_mode or "None",
                            ),
                            daemon=True,
                            name=f"opc-poll-{task_id}",
                        )
                        t.start()
                        running_tasks[task_id] = {"thread": t, "stop_event": stop_event}
                        print(
                            f"[POLL WORKER] Запущен polling для задачи #{task_id} "
                            f"({server_url}, interval={interval_seconds}s, tags={len(tag_nodeids)})"
                        )
        except pyodbc.Error as db_err:
            print(f"[POLL WORKER] Ошибка загрузки активных задач: {type(db_err).__name__}: {repr(db_err)}")

        # Остановка потоков для неактивных/пропавших задач с дебаунсом
        for old_id in list(running_tasks.keys()):
            if old_id not in active_ids:
                missing_counts[old_id] = missing_counts.get(old_id, 0) + 1
                if missing_counts[old_id] >= 3:  # только если пропала 3 цикла подряд
                    print(f"[POLL WORKER] Завершаем polling для задачи #{old_id}")
                    running_tasks[old_id]["stop_event"].set()
                    running_tasks[old_id]["thread"].join(timeout=2)
                    del running_tasks[old_id]
                    missing_counts.pop(old_id, None)

        time.sleep(5)


if __name__ == "__main__":
    polling_worker()
