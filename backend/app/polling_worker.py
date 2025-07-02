import os
import threading
import time
import pyodbc
import asyncio
from asyncua import Client
from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()
from config import get_conn_str


# Пути к сертификату и ключу (указывай абсолютные или относительные пути, если ты из app запускаешь)
CERT_PATH = os.path.abspath("app/client_cert.pem")
KEY_PATH = os.path.abspath("app/client_private.pem")

FERNET_KEY = os.getenv("FERNET_KEY")
if FERNET_KEY is None:
    raise RuntimeError("FERNET_KEY not set in environment!")
fernet = Fernet(FERNET_KEY.encode())

def get_task_tags(conn, polling_task_id):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.Id, t.NodeId, t.BrowseName, t.DataType
        FROM PollingTaskTags pt
        JOIN OpcTags t ON pt.tag_id = t.Id
        WHERE pt.polling_task_id = ?
    """, polling_task_id)
    return cursor.fetchall()
def poll_task(task_id, server_url, tag_ids, interval_seconds, stop_event,
              username, password, security_policy, security_mode):
    async def do_poll():
        notified_stop = False
        while not stop_event.is_set():
            try:
                print(f"[POLL WORKER] Connecting to {server_url} (policy={security_policy}, mode={security_mode}, user={username})")
                client = Client(server_url, timeout=5)

                # Проверим — нужен ли сертификат?
                use_cert = os.path.isfile(CERT_PATH) and os.path.isfile(KEY_PATH)
                if use_cert:
                    security_str = f"{security_policy},{security_mode},{CERT_PATH},{KEY_PATH}"
                else:
                    security_str = f"{security_policy},{security_mode},,"

                # 1. Узнать поддерживаемые политики сервера (debug 1 раз)
                try:
                    endpoints = await client.connect_and_get_server_endpoints()
                    print("=== Доступные endpoint'ы сервера ===")
                    for ep in endpoints:
                        print(f"Policy: {ep.SecurityPolicyUri}, Mode: {ep.SecurityMode}, UserTokens: {[t.TokenType for t in ep.UserIdentityTokens]}")
                except Exception as ex:
                    print(f"[DEBUG] Не удалось получить endpoint descriptions: {ex}")

                # 2. Установить security (обязательно 4 параметра!)
                await client.set_security_string(security_str)

                if username:
                    client.set_user(username)
                if password:
                    client.set_password(password)

                async with client:
                    while not stop_event.is_set():
                        # Проверяем активность задачи
                        with pyodbc.connect(get_conn_str()) as conn:
                            cur = conn.cursor()
                            cur.execute("SELECT is_active FROM PollingTasks WHERE id=?", task_id)
                            row = cur.fetchone()
                            if not row or not row[0]:
                                if not notified_stop:
                                    print(f"[POLL WORKER] Task {task_id} остановлена.")
                                    notified_stop = True
                                stop_event.set()
                                break

                        # Опрос тегов
                        for nodeid in tag_ids:
                            try:
                                val = await client.get_node(nodeid).get_value()
                                with pyodbc.connect(get_conn_str()) as conn:
                                    cur = conn.cursor()
                                    cur.execute("SELECT Id FROM OpcTags WHERE NodeId=?", nodeid)
                                    tag_row = cur.fetchone()
                                    if tag_row:
                                        tag_id = tag_row[0]
                                        cur.execute(
                                            "INSERT INTO OpcData (TagId, Value, Timestamp, Status) VALUES (?, ?, GETDATE(), 'Good')",
                                            tag_id, float(val)
                                        )
                                        conn.commit()
                                    else:
                                        print(f"[POLL WORKER] Не найден тег {nodeid} в OpcTags.")
                            except Exception as e:
                                print(f"[POLL WORKER] Ошибка чтения {nodeid}: {e}")
                        await asyncio.sleep(interval_seconds)
            except Exception as e:
                print(f"[POLL WORKER] Ошибка подключения к серверу {server_url}: {e}")
                await asyncio.sleep(5)
        print(f"[POLL WORKER] Task {task_id} polling loop завершён.")

    asyncio.run(do_poll())

def polling_worker():
    print("[POLL WORKER] Старт фонового воркера polling_worker")
    running_tasks = {}

    while True:
        active_ids = set()
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT t.id, t.server_url, i.IntervalSeconds,
                       s.OpcUsername, s.OpcPassword, s.SecurityPolicy, s.SecurityMode
                FROM PollingTasks t
                JOIN PollingIntervals i ON t.interval_id = i.Id
                JOIN OpcServers s ON t.server_url = s.EndpointUrl
                WHERE t.is_active=1
            """)
            rows = cur.fetchall()

            for row in rows:
                task_id, server_url, interval_seconds, username, password, security_policy, security_mode = row
                active_ids.add(task_id)
                tag_rows = get_task_tags(conn, task_id)
                tag_ids = [r[1] for r in tag_rows]  # NodeId

                # Расшифруем пароль если нужно
                if password:
                    try:
                        password = fernet.decrypt(password.encode()).decode()
                    except Exception as e:
                        print(f"[POLL WORKER] Ошибка расшифровки пароля: {e}")
                        password = ""

                if task_id not in running_tasks or not running_tasks[task_id]["thread"].is_alive():
                    stop_event = threading.Event()
                    t = threading.Thread(
                        target=poll_task,
                        args=(task_id, server_url, tag_ids, interval_seconds, stop_event,
                              username, password, security_policy, security_mode),
                        daemon=True
                    )
                    t.start()
                    running_tasks[task_id] = {"thread": t, "stop_event": stop_event}
                    print(f"[POLL WORKER] Запущен polling для задачи #{task_id} ({server_url}, {interval_seconds} сек)")

        # Останавливаем потоки для неактивных задач
        for old_id in list(running_tasks.keys()):
            if old_id not in active_ids:
                print(f"[POLL WORKER] Завершаем polling для задачи #{old_id}")
                running_tasks[old_id]["stop_event"].set()
                running_tasks[old_id]["thread"].join(timeout=2)
                del running_tasks[old_id]

        time.sleep(5)

if __name__ == "__main__":
    polling_worker()
