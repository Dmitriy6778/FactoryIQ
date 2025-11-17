# app/routers/system_router.py
from fastapi import APIRouter
import platform, subprocess, sys

try:
    import psutil  # pip install psutil
except Exception:
    psutil = None  # будем жить и без него

router = APIRouter(prefix="/system", tags=["system"])

# Список «наших» служб Windows (NSSM)
FACTORYIQ_SERVICES = [
    "factoryiq-api",
    "factoryiq-opc",
    "factoryiq-reports",
]

def _query_service_state(name: str) -> str:
    """
    Возвращает RUNNING / STOPPED / UNKNOWN.
    Сначала пробуем psutil, затем fallback на `sc query`.
    """
    # 1) Через psutil (надежнее и быстрее)
    if psutil and platform.system() == "Windows":
        try:
            svc = psutil.win_service_get(name)
            st = (svc.status() or "").strip().upper()
            if st == "RUNNING":
                return "RUNNING"
            if st == "STOPPED":
                return "STOPPED"
            # Иногда бывают START_PENDING/STOP_PENDING и т.п.
            return st or "UNKNOWN"
        except Exception:
            pass

    # 2) Fallback: `sc query`
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["sc", "query", name],
                text=True,
                stderr=subprocess.STDOUT,
                timeout=3,
                encoding="utf-8",
                errors="ignore",
            )
            up = "RUNNING" in out
            down = "STOPPED" in out
            if up and not down:
                return "RUNNING"
            if down and not up:
                return "STOPPED"
            # вытащим значение STATE: N  <TEXT>
            for line in out.splitlines():
                if "STATE" in line:
                    # пример: "STATE              : 4  RUNNING"
                    tail = line.split(":")[-1].strip()
                    parts = tail.split()
                    if parts:
                        # возьмём последнее слово как статус
                        return parts[-1].upper()
            return "UNKNOWN"
        except Exception:
            return "UNKNOWN"

    # Не Windows — считаем неизвестно
    return "UNKNOWN"

@router.get("/services")
def get_services_status():
    services = []
    for name in FACTORYIQ_SERVICES:
        state = _query_service_state(name)
        services.append({"name": name, "state": state})
    return {"ok": True, "services": services}
