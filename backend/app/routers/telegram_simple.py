# app/routers/telegram_simple.py
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timedelta
import io, json, base64

import pyodbc
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from ..config import get_conn_str

router = APIRouter(prefix="/telegram2", tags=["telegram2"])

# ---------- DB utils ----------
def _db() -> pyodbc.Connection:
    return pyodbc.connect(get_conn_str())

class PreviewIn(BaseModel):  # ← оставить ТОЛЬКО ЭТУ версию модели
     proc: str                                   # имя хранимой процедуры
     params: Dict[str, Any] = Field(default_factory=dict)  # параметры для EXEC
     mode: str = Field("chart", description="chart|text")
     chart: Optional[str] = Field("line", description="line|bar")
     map_x: str = Field(..., description="имя колонки для X (время/категория)")
     map_y: str = Field(..., description="имя колонки для Y (число)")
     map_series: Optional[str] = Field(None, description="имя колонки, задающей серийность (например TagName)")
     unit: Optional[str] = None                  # подпись единиц (ось Y / легенда)
     title: Optional[str] = None   
     table: Optional[TableFormat] = None         # настройки текст-таблицы
     # ВАЖНО: нужно для текстового режима предпросмотра
     text_template: Optional[str] = Field(
        None, description="Шаблон текста с подстановками по колонкам")
     expand_weekly_shifts: Optional[bool] = False
     


# --- Param normalization helpers ---
_CANON = {
    "tagids": "@tag_ids",
    "tag_ids": "@tag_ids",
    "@tagids": "@tag_ids",
    "@tag_ids": "@tag_ids",
    "datefrom": "@date_from",
    "date_from": "@date_from",
    "@datefrom": "@date_from",
    "@date_from": "@date_from",
    "dateto": "@date_to",
    "date_to": "@date_to",
    "@dateto": "@date_to",
    "@date_to": "@date_to",
    "weekmonday": "@week_monday",
    "week_monday": "@week_monday",
    "@weekmonday": "@week_monday",
    "@week_monday": "@week_monday",
}


_TAG_ALIASES = {"@TagIds", "@tag_ids", "TagIds", "tag_ids"}

def _soft_normalize(params: Dict[str, Any]) -> Dict[str, Any]:
    """
    - Не меняем уже заданные имена (сохраняем @TagIds, если так прислали).
    - Добавляем @ впереди, если забыли.
    - Для tag ids: если прислали без @, добавим с @ тем же именем.
    """
    out: Dict[str, Any] = {}
    for k, v in (params or {}).items():
        k0 = (k or "").strip()
        if not k0:
            continue
        if not k0.startswith("@"):
            k_at = "@" + k0
        else:
            k_at = k0
        out[k_at] = v

    # Спец-случай: если прислали только один из алиасов тегов — оставляем как есть.
    # Ничего не переименовываем насильно.
    return out

def _retry_hint_from_odbc(e: Exception) -> Tuple[str, bool]:
    """
    Если в тексте есть 'expects parameter "@Param"' — возвращаем имя параметра и флаг, что стоит ретраить.
    """
    msg = str(e) or ""
    # типичный фрагмент: expects parameter "@TagIds"
    import re
    m = re.search(r'expects parameter\s+"(@[A-Za-z0-9_]+)"', msg)
    if m:
        return m.group(1), True
    return "", False

def _shift_windows_for_week(now: datetime) -> List[Tuple[datetime, datetime, str]]:
    # неделя: ПН 00:00…ВС 23:59:59; разбиваем по сменам 08-20 и 20-08
    # берём «текущую» неделю, но не создаём окна в будущем
    start = now - timedelta(days=(now.weekday()))  # понедельник
    start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    end_cap = now  # обрезаем будущие смены
    out = []
    cur = start
    while cur < end_cap:
      day = cur.replace(hour=8, minute=0, second=0, microsecond=0)
      d1 = day
      d2 = day.replace(hour=20)
      # 08-20
      if d1 < end_cap:
          out.append((d1, min(d2, end_cap), d1.strftime("%a 08-20")))
      # 20-08
      n08 = (d1 + timedelta(days=1)).replace(hour=8)
      if d2 < end_cap:
          out.append((d2, min(n08, end_cap), d1.strftime("%a 20-08")))
      cur = (cur + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return out

def _concat_shift_rows(proc: str, base_params: Dict[str, Any], label_col: str) -> Tuple[List[str], List[Dict[str, Any]]]:
    cols_all: List[str] = []
    rows_all: List[Dict[str, Any]] = []
    now = datetime.now()
    base_params = _soft_normalize(base_params or {})

    # убедимся, что какое-то значение тегов есть (в ЛЮБОМ алиасе)
    has_tags = any(k in base_params for k in _TAG_ALIASES.union({a[1:] for a in _TAG_ALIASES}))
    if not has_tags:
        raise HTTPException(status_code=422, detail="Для weekly/shift требуется список тегов (@TagIds/@tag_ids)")

    for dt_from, dt_to, label in _shift_windows_for_week(now):
        p = dict(base_params)
        p["@date_from"] = dt_from.strftime("%Y-%m-%d")
        p["@date_to"]   = dt_to.strftime("%Y-%m-%d")
        c, r = _exec_proc(proc, p)
        if not c:
            continue
        if not cols_all:
            cols_all = c[:]
        for it in r:
            it[label_col] = label
            rows_all.append(it)
    return (cols_all, rows_all)



def _try_parse_dt(v):
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        s = v.strip().replace("T", " ").replace("Z", "")
        try:
            # поддержим ISO с микросекундами
            return datetime.fromisoformat(s)
        except Exception:
            pass
    return None

def _render_text_from_template(rows: List[Dict[str, Any]], tmpl: str) -> str:
    """
    Подстановка по первому ряду данных.
    Поддержка формата: {Field} или {Field|fmt=%Y-%m-%d %H:%M}
    По умолчанию для Timestamp убираем секунды -> %Y-%m-%d %H:%M
    """
    if not tmpl:
        return ""
    ctx = rows[0] if rows else {}

    import re
    rx = re.compile(r"{\s*([A-Za-z0-9_]+)(?:\|fmt=([^}]+))?\s*}")

    def repl(m):
        key = m.group(1)
        fmt = m.group(2)
        val = ctx.get(key)

        # дата/время
        dt = _try_parse_dt(val)
        if dt:
            if fmt:
                try:
                    return dt.strftime(fmt)
                except Exception:
                    return dt.strftime("%Y-%m-%d %H:%M")
            # дефолт без секунд
            return dt.strftime("%Y-%m-%d %H:%M")

        # просто число/строка
        return "" if val is None else str(val)

    return rx.sub(repl, tmpl)
# app/routers/telegram_simple.py

def _exec_proc(proc: str, params: Dict[str, Any]) -> tuple[list[str], list[dict]]:
    with _db() as conn:
        cur = conn.cursor()

        def _run(p: Dict[str, Any]):
            parts, vals = [], []
            for k, v in p.items():
                parts.append(f"{k}=?")
                vals.append(v)
            sql = f"EXEC {proc} {', '.join(parts)}" if parts else f"EXEC {proc}"
            cur.execute(sql, *vals)

        # 1) мягкая нормализация (добавляем @ где забыли, остальное не трогаем)
        nparams = _soft_normalize(params or {})

        try:
            _run(nparams)
        except Exception as e1:
            # 2) если SQL явно сказал, какого параметра ждёт — ретраим с переименованием
            param_name, should_retry = _retry_hint_from_odbc(e1)
            if should_retry:
                # попробуем найти значение в известных алиасах и подставить под ожидаемое имя
                if param_name.lower() in ("@tagids", "@tag_ids"):
                    # найдём значение из любого алиаса
                    val = None
                    for a in _TAG_ALIASES:
                        if a in nparams: 
                            val = nparams[a]
                            break
                        if a.startswith("@") and a[1:] in nparams:
                            val = nparams[a[1:]]
                            break
                    if val is not None:
                        nparams[param_name] = val
                        try:
                            _run(nparams)
                        except Exception:
                            raise
                    else:
                        raise
                else:
                    raise
            else:
                raise

        captured: list[tuple[list[str], list[dict]]] = []
        while True:
            cols = [c[0] for c in (cur.description or [])]
            rows = []
            if cols:
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
                if rows:
                    captured.append((cols, rows))
            if not cur.nextset():
                break

        return captured[-1] if captured else ([], [])


# ---------- Formatting helpers ----------
def _num(v) -> Optional[float]:
    try:
        if v is None: return None
        return float(str(v).replace(",", "."))
    except Exception:
        return None

def _fmt_num(v: Any, prec: int = 1, th: str = " ", dec: str = ",") -> str:
    n = _num(v)
    if n is None: return "-"
    s = f"{n:,.{prec}f}"
    return s.replace(",", "X").replace(".", dec).replace("X", th)

def _as_dt_label(v: Any) -> str:
    if isinstance(v, datetime): return v.strftime("%Y-%m-%d %H:%M:%S")
    s = str(v or "")
    return s[:19] if len(s) >= 19 else s

# ---------- Pydantic ----------
class TableFormat(BaseModel):
    order: Optional[List[str]] = None           # порядок колонок
    rename: Optional[Dict[str, str]] = None     # отображаемое имя по оригинальному
    enabled: Optional[Dict[str, bool]] = None   # включить/выключить колонку
    number_precision: int = 1
    thousand_sep: str = " "
    decimal_sep: str = ","
    show_header: bool = True
    title: Optional[str] = None   

class SendIn(PreviewIn):
    target_type: str = "telegram"
    target_value: str

# ---------- Chart renderers ----------
def _render_line(series: List[Dict[str, Any]], title: str) -> str:
    if not series: return ""
    # Размер/шрифт — минималистично, без внешних зависимостей
    fig, ax = plt.subplots(figsize=(8, 4), dpi=140)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for s in series:
        xs = list(range(len(s["x"])))
        ax.plot(xs, s["y"], linewidth=2, label=s.get("name","Серия"))
        ax.scatter(xs, s["y"], s=9)
    ax.set_xticks(range(len(series[0]["x"])))
    ax.set_xticklabels(s["x"] for s in series for _ in () )  # silence linter
    ax.set_xticklabels(series[0]["x"], rotation=30, ha="right", fontsize=9)
    ax.grid(axis="y", linestyle="--", alpha=0.25)
    ax.legend(frameon=False, loc="lower center", ncols=min(3, len(series)))
    ax.set_title(title)
    buf = io.BytesIO()
    plt.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()

def _render_bar(series: List[Dict[str, Any]], title: str) -> str:
    """
    Улучшенная bar-диаграмма:
    - толщина столбцов зависит от числа серий (без налезания)
    - подписи только для достаточно «заметных» значений (мелкие ~0 не подписываем)
    - небольшой запас сверху по Y для цифр
    """
    if not series:
        return ""

    x_labels = series[0]["x"]
    n = len(x_labels)
    m = max(1, len(series))  # кол-во серий

    idx = np.arange(n)

    # --- ширина бара в зависимости от числа серий ---
    if m == 1:
        bar_width = 0.6   # жирные одиночные
    elif m == 2:
        bar_width = 0.38
    elif m == 3:
        bar_width = 0.30
    else:
        bar_width = 0.24  # 4+ серий

    group_width = bar_width * m  # суммарная ширина пучка на категорию

    # Чуть растягиваем картинку, если очень много колонок
    if n <= 15:
        fig_w = 8.5
    elif n <= 25:
        fig_w = 10
    else:
        fig_w = 12

    fig, ax = plt.subplots(figsize=(fig_w, 4.5), dpi=140)  # было 4

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # общий максимум по всем сериям
    all_vals: List[float] = []
    for s in series:
        for v in s["y"]:
            try:
                all_vals.append(float(v))
            except Exception:
                pass

    global_max = max(all_vals) if all_vals else 1.0
    if global_max <= 0:
        global_max = 1.0

    y_top = global_max * 1.2
    ax.set_ylim(0, y_top)

    def fontsize_for(val: float) -> int:
        s = f"{val:.1f}"
        L = len(s)
        if L <= 3:
            return 11
        if L <= 5:
            return 10
        if L <= 7:
            return 9
        return 8

    # порог, ниже которого подписи не выводим (и «0.0» исчезнут)
    label_threshold = max(global_max * 0.03, 0.1)

    # --- рисуем серии ---
    for i, s in enumerate(series):
        # центрируем пучок вокруг каждой позиции idx
        xs = idx - group_width / 2 + (i + 0.5) * bar_width
        ys = s["y"]

        ax.bar(xs, ys, bar_width, label=s.get("name", "Серия"))

        # подписи над столбцами
        for x, v in zip(xs, ys):
            try:
                val = float(v)
            except Exception:
                continue

            # мелкие/нулевые не подписываем
            if abs(val) < label_threshold:
                continue

            label = f"{val:.1f}"
            fs = fontsize_for(val)

            y_text = val + global_max * 0.04
            if y_text > y_top * 0.96:
                y_text = y_top * 0.96

            ax.text(
                x,
                y_text,
                label,
                ha="center",
                va="bottom",
                fontsize=fs,
                color="#333",
                fontweight="bold",
            )

    ax.set_xticks(idx)
    ax.set_xticklabels(x_labels, rotation=0, fontsize=10)

    ax.grid(axis="y", linestyle="--", alpha=0.25)

    if m > 1:
        # Легенда: каждый тег с новой строки (одна колонка)
        ax.legend(
            frameon=False,
            loc="upper center",
            bbox_to_anchor=(0.5, -0.18),  # чуть ниже графика
            ncol=1,                       # <-- один столбец: по одной серии в строке
            fontsize=9,
            handlelength=1.6,
            handletextpad=0.6,
        )


    ax.set_title(title or "")

    buf = io.BytesIO()
    plt.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


# ---------- Table renderer (mono text) ----------
def _make_text_table(columns: List[str], rows: List[Dict[str, Any]], fmt: Optional[TableFormat]) -> str:
    if not rows: return "Нет данных"
    fmt = fmt or TableFormat()

    order = fmt.order or columns[:]
    enabled = fmt.enabled or {}
    rename = fmt.rename or {}
    order = [c for c in order if enabled.get(c, True)]

    out = [fmt.title] if fmt.title else []
    if fmt.show_header:
        hdr = " | ".join([rename.get(c, c) for c in order])
        out += [hdr, "-"*len(hdr)]

    for r in rows:
        vals = []
        for c in order:
            v = r.get(c)
            if isinstance(v, (int, float)) or (isinstance(v, str) and v.replace(",",".").replace("-","").replace(".","",1).isdigit()):
                vals.append(_fmt_num(v, fmt.number_precision, fmt.thousand_sep, fmt.decimal_sep))
            elif isinstance(v, datetime):
                vals.append(v.strftime("%Y-%m-%d %H:%M:%S"))
            else:
                vals.append("" if v is None else str(v))
        out.append(" | ".join(vals))
    return "\n".join(out)

# ---------- Series builder ----------
def _build_series(
    cols: List[str],
    rows: List[Dict[str, Any]],
    *,
    map_x: str,
    map_y: str,
    map_series: Optional[str],
    unit: Optional[str],
) -> List[Dict[str, Any]]:
    if not rows:
        return []

    def as_x(v):
        return _as_dt_label(v)

    series: Dict[str, Dict[str, Any]] = {}

    for r in rows:
        # имя серии: сначала Description, потом поле map_series (обычно TagName)
        if map_series:
            base_name = r.get(map_series)
            desc = (
                r.get("Description")
                or r.get("Descr")
                or r.get("TagDescription")
            )
            name = str(desc or base_name or "Серия")
        else:
            name = "Серия"

        x = as_x(r.get(map_x))
        y = _num(r.get(map_y))
        if y is None:
            continue

        key = name  # ключ по понятному имени
        if key not in series:
            label = name if not unit else f"{name}, {unit}"
            series[key] = {"name": label, "x": [], "y": []}

        series[key]["x"].append(x)
        series[key]["y"].append(y)

    # сохраняем порядок появления X внутри каждой серии
    for s in series.values():
        zipped = list(zip(s["x"], s["y"]))
        seen = set()
        ordered = []
        for xx, yy in zipped:
            if xx in seen:
                continue
            seen.add(xx)
            ordered.append((xx, yy))
        s["x"] = [p[0] for p in ordered]
        s["y"] = [p[1] for p in ordered]

    return list(series.values())


# ---------- API ----------
@router.post("/preview")
def preview(payload: PreviewIn = Body(...)):
    try:
        params = _soft_normalize(payload.params or {})
        if payload.expand_weekly_shifts:
            cols, data = _concat_shift_rows(payload.proc, params, payload.map_x)
        else:
            cols, data = _exec_proc(payload.proc, params)

        if payload.mode == "text":
            tmpl = getattr(payload, "text_template", None)
            if tmpl:
                txt = _render_text_from_template(data, tmpl)
                # если шаблон пустой — вернём и text_table для fallback
                if txt and txt.strip():
                    return {"ok": True, "text": txt, "columns": cols, "rows": data}
                tbl = _make_text_table(cols, data, payload.table)
                return {"ok": True, "text": txt, "text_table": tbl, "columns": cols, "data": data}
            # без шаблона — как и было
            txt = _make_text_table(cols, data, payload.table)
            return {"ok": True, "text_table": txt, "columns": cols, "data": data}

        ser = _build_series(cols, data, map_x=payload.map_x, map_y=payload.map_y,
                            map_series=payload.map_series, unit=payload.unit)

        title = payload.title or ""   # пустой заголовок допустим
        img = _render_line(ser, title) if payload.chart == "line" else _render_bar(ser, title)
        return {"ok": True, "chart_png": img, "series": ser, "columns": cols, "rows": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    

@router.post("/send")
def send(payload: SendIn = Body(...)):
    """
    По факту — тот же preview, плюс запись «что бы отправили» в ReportExports.
    """
    if isinstance(payload, dict):
        payload = SendIn(**payload)
    res = preview(payload)  # type: ignore


    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                IF OBJECT_ID('dbo.ReportExports') IS NOT NULL
                INSERT INTO ReportExports(ExportedAt, TargetType, TargetId, PayloadJson)
                VALUES (GETDATE(), ?, ?, ?)
            """, payload.target_type, int(payload.target_value),
                 json.dumps(res, ensure_ascii=False))
            conn.commit()
    except Exception:
        pass
    return {"ok": True, "delivered": True, "preview": res}
