# backend/app/routers/telegram_reports.py
# Модуль для работы с отчётами в Telegram: создание, предпросмотр, расписания

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from collections import defaultdict
from datetime import datetime, date, timedelta

import io
import base64

import matplotlib
matplotlib.use("Agg")  # важно: выбрать backend ДО импорта pyplot
import matplotlib.pyplot as plt

import numpy as np
import pandas as pd
import pyodbc

from ..config import get_conn_str
import json
from .report_styles import ChartStyle, TableStyle, ExcelStyle  # модели стиля

# >>> Шрифты
from .fonts_loader import ensure_fonts_ready, pick_font_family, apply_matplotlib_font
from .fonts_loader import resolve_font
print(resolve_font("Roboto Condensed"))  # -> ('Roboto Condensed', '/.../RobotoCondensed-Regular.ttf')

from matplotlib.font_manager import FontProperties
import matplotlib as mpl
from matplotlib.colors import is_color_like
# <<< Шрифты

# --------------------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------------------
router = APIRouter(prefix="/telegram", tags=["telegram"])


# --------------------------------------------------------------------------------------
# Pydantic модели
# --------------------------------------------------------------------------------------
class ChannelCreate(BaseModel):
    channel_id: str
    channel_name: str
    thread_id: Optional[int] = None
    send_as_file: bool = True
    send_as_text: bool = False
    send_as_chart: bool = False
    active: bool = True


class ChannelUpdate(ChannelCreate):
    id: int


class PreviewRequest(BaseModel):
    template_id: int
    format: str  # "file" | "table" | "chart" | "text"
    period_type: str
    time_of_day: Optional[str] = None
    aggregation_type: Optional[str] = None
    style_override: Optional[dict] = None  # <- разовый стиль из модалки


class ReportScheduleCreate(BaseModel):
    template_id: int
    period_type: str
    time_of_day: str
    target_type: str
    target_value: str
    aggregation_type: Optional[str] = None
    send_format: Optional[str] = None


class ReportTaskCreate(BaseModel):
    template_id: int
    period_type: str
    time_of_day: str
    target_type: str
    target_value: str
    aggregation_type: Optional[str] = None
    send_format: Optional[str] = None


class ReportTaskUpdate(ReportTaskCreate):
    id: int


# --------------------------------------------------------------------------------------
# Утилиты БД/дат
# --------------------------------------------------------------------------------------
def _db() -> pyodbc.Connection:
    """Подключение к БД с автокоммитом выключенным (используем вручную)."""
    return pyodbc.connect(get_conn_str())


def _rows_to_dicts(cursor: pyodbc.Cursor) -> Tuple[List[str], List[Dict[str, Any]]]:
    cols = [col[0] for col in cursor.description]
    data = [dict(zip(cols, row)) for row in cursor.fetchall()]
    return cols, data


def _as_date_str(v: Any) -> str:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "")
    return s[:10]


def _fmt_tons(v: Any) -> str:
    try:
        f = float(v or 0.0)
    except Exception:
        f = 0.0
    return f"{f:,.1f}".replace(",", " ")


# --------------------------------------------------------------------------------------
# Каналы Telegram
# --------------------------------------------------------------------------------------
@router.get("/channels")
def get_channels():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, ChannelId, ChannelName, ThreadId,
                       SendAsFile, SendAsText, SendAsChart, Active
                FROM TelegramReportTarget
                WHERE Active = 1
            """)
            channels: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                channels.append({
                    "id": row.Id,
                    "channel_id": row.ChannelId,
                    "channel_name": row.ChannelName,
                    "thread_id": row.ThreadId,
                    "send_as_file": bool(row.SendAsFile),
                    "send_as_text": bool(row.SendAsText),
                    "send_as_chart": bool(row.SendAsChart),
                    "active": bool(row.Active),
                })
            return {"ok": True, "channels": channels}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.post("/channels")
def add_channel(channel: ChannelCreate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO TelegramReportTarget
                    (ChannelId, ChannelName, ThreadId, SendAsFile, SendAsText, SendAsChart, Active)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, channel.channel_id, channel.channel_name, channel.thread_id,
                         int(channel.send_as_file), int(channel.send_as_text),
                         int(channel.send_as_chart), int(channel.active))
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.put("/channels/{id}")
def update_channel(id: int, channel: ChannelUpdate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE TelegramReportTarget
                SET ChannelId=?, ChannelName=?, ThreadId=?,
                    SendAsFile=?, SendAsText=?, SendAsChart=?, Active=?
                WHERE Id=?
            """, channel.channel_id, channel.channel_name, channel.thread_id,
                         int(channel.send_as_file), int(channel.send_as_text),
                         int(channel.send_as_chart), int(channel.active), id)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.delete("/channels/{id}")
def delete_channel(id: int):
    """
    Физическое удаление канала из TelegramReportTarget.
    Если есть ссылки из ReportSchedule.TargetValue на этот канал —
    либо запретить удаление (вернуть 409), либо предварительно очистить ссылки.
    Ниже — вариант «запретить, если используется».
    """
    try:
        with _db() as conn:
            cur = conn.cursor()

            # Проверим, используется ли канал в заданиях (TargetType='telegram' и TargetValue=Id канала)
            cur.execute("""
                SELECT COUNT(*) 
                FROM ReportSchedule 
                WHERE TargetType = 'telegram' AND TRY_CAST(TargetValue AS INT) = ?
            """, id)
            in_use = cur.fetchone()[0] or 0
            if in_use > 0:
                raise HTTPException(
                    status_code=409,
                    detail="Канал используется в заданиях, сперва удалите/обновите связанные задания"
                )

            cur.execute("DELETE FROM TelegramReportTarget WHERE Id = ?", id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Канал не найден")
            conn.commit()
            return {"ok": True, "deleted": id}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


# --------------------------------------------------------------------------------------
# Вспомогательные функции отчётов
# --------------------------------------------------------------------------------------
def get_tag_ids_for_template(template_id: int, *, as_list: bool = False):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT TagId FROM ReportTemplateTags WHERE TemplateId=?
        """, template_id)
        ids = [row[0] for row in cur.fetchall()]
        return ids if as_list else (",".join(str(x) for x in ids) if ids else None)


def compute_preview_period(period_type: str, time_of_day: Optional[str] = None
                           ) -> Tuple[str, str, str]:
    """Возвращает (date_from, date_to, group_type)."""
    now = datetime.now()
    if period_type in ("once", "hourly"):
        dt_to = now.replace(minute=0, second=0, microsecond=0)
        dt_from = dt_to - timedelta(hours=1)
        return (dt_from.strftime("%Y-%m-%d %H:%M:%S"),
                dt_to.strftime("%Y-%m-%d %H:%M:%S"),
                "hour")
    if period_type in ("day", "daily"):
        return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"), "day"
    if period_type == "shift":
        return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"), "shift"
    # fallback
    return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"), "hour"


def get_balance_proc_and_period(period_type: str) -> Tuple[str, str, str]:
    now = datetime.now()
    if period_type == "shift":
        return "sp_Telegram_BalanceReport_Shift", now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
    if period_type in ("day", "daily"):
        return "sp_Telegram_BalanceReport_Daily", now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
    if period_type == "weekly":
        date_to = (now - timedelta(days=now.weekday() + 1)).strftime("%Y-%m-%d")
        date_from = (datetime.strptime(date_to, "%Y-%m-%d") - timedelta(days=6)).strftime("%Y-%m-%d")
        return "sp_Telegram_BalanceReport_Weekly", date_from, date_to
    if period_type == "monthly":
        first_day_this_month = now.replace(day=1)
        last_day_last_month = first_day_this_month - timedelta(days=1)
        return ("sp_Telegram_BalanceReport_Monthly",
                last_day_last_month.replace(day=1).strftime("%Y-%m-%d"),
                last_day_last_month.strftime("%Y-%m-%d"))
    # fallback
    return "sp_Telegram_BalanceReport_Daily", now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------------------
# Текстовая «моно» таблица для Telegram (фолбэк)
# --------------------------------------------------------------------------------------
def make_telegram_table(columns: List[str], rows: List[Dict[str, Any]]) -> str:
    """
    Группировка по дате → внутри список «Продукт | Выход, т».
    Итоги убраны. Таблица моноширинная.
    """
    if not rows:
        return "Нет данных для предпросмотра"

    sample = rows[0]
    date_key = "Date" if "Date" in sample else ("Период" if "Период" in sample else None)
    shift_key = "Смена" if "Смена" in sample else None
    product_key = "TagName" if "TagName" in sample else None
    value_key = ("Выход, т" if "Выход, т" in sample else
                 ("Прирост" if "Прирост" in sample else
                  ("Value" if "Value" in sample else None)))

    if not date_key or not product_key or not value_key:
        header = " | ".join(columns)
        body = "\n".join(" | ".join(str(r.get(c, "")) for c in columns) for r in rows)
        return "Предпросмотр отчёта\n" + header + "\n" + "-" * len(header) + "\n" + body

    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[_as_date_str(r.get(date_key))].append(r)

    out = ["Предпросмотр отчёта", ""]
    for d in sorted(groups.keys()):
        rows_d = groups[d]

        shift_label = None
        if shift_key:
            uniq = {str(r.get(shift_key) or "") for r in rows_d if r.get(shift_key)}
            if len(uniq) == 1:
                only = next(iter(uniq))
                if only and only != "Сутки":
                    shift_label = only

        out.append(f"Дата: {d}" + (f" — Смена: {shift_label}" if shift_label else ""))

        head_l, head_r = "Продукт", "Выход, т"
        prod_vals = [str(r.get(product_key) or "") for r in rows_d]
        val_vals = [_fmt_tons(r.get(value_key)) for r in rows_d]
        w_prod = max(len(head_l), *(len(s) for s in prod_vals)) if prod_vals else len(head_l)
        w_val = max(len(head_r), *(len(s) for s in val_vals)) if val_vals else len(head_r)

        out.append("─" * w_prod + " " + "─" * (w_val + 2))
        out.append(f"{head_l.ljust(w_prod)} | {head_r.rjust(w_val)}")
        out.append("─" * w_prod + " " + "─" * (w_val + 2))

        for p, v in zip(prod_vals, val_vals):
            out.append(f"{p.ljust(w_prod)} | {v.rjust(w_val)}")

        out.append("")

    return "\n".join(out).rstrip()


# --------------------------------------------------------------------------------------
# Генерация PNG‑графика
# --------------------------------------------------------------------------------------

def _clean_color(c):
    """Вернёт валидный цвет (строку) либо None."""
    if not c:
        return None
    if isinstance(c, str):
        s = c.strip()
        return s if is_color_like(s) else None
    return None

def generate_bar_chart_png(series: List[Dict[str, Any]], title: str, style: Dict[str, Any] | None = None) -> Optional[str]:
    if not series:
        return None

    style = style or {}

    # ---------- ШРИФТ ----------
    chart_font = pick_font_family(style.get("fontFamily") or style.get("_tableFont"))
    mpl.rcParams["font.family"] = chart_font

    # ---------- SIZE / DPI ----------
    try:
        dpi = int(float(style.get("dpi", 140) or 140))
    except Exception:
        dpi = 140
    size = style.get("size") or {"w": 1280, "h": 600}
    try:
        w_px = int(float(size.get("w", 1280) or 1280))
        h_px = int(float(size.get("h", 600) or 600))
    except Exception:
        w_px, h_px = 1280, 600
    W, H = max(1, w_px) / dpi, max(1, h_px) / dpi

    # ---------- Утилиты цветов ----------
    from matplotlib.colors import is_color_like

    def _to_color(val, default="#FFFFFF"):
        if val is None:
            return default
        if isinstance(val, dict):
            if "color" in val:
                return _to_color(val["color"], default)
            for k in ("value", "hex", "bg", "fg"):
                if k in val:
                    return _to_color(val[k], default)
            return default
        if isinstance(val, (list, tuple)):
            if len(val) in (3, 4):
                try:
                    return tuple(float(x) for x in val)
                except Exception:
                    return default
            return default
        if isinstance(val, str):
            s = val.strip()
            return s if is_color_like(s) else default
        return default

    def _clean_colors(seq, fallback):
        out = []
        if isinstance(seq, (list, tuple)):
            for c in seq:
                cc = _to_color(c, None)
                if cc is not None and is_color_like(cc):
                    out.append(cc)
        return out if out else fallback[:]

    # ---------- Фигура / оси ----------
    fig, ax = plt.subplots(figsize=(W, H), dpi=dpi)

    pal = style.get("palette") or {}
    mode = (pal.get("type") or "single-or-multi").strip()
    single_color = _to_color(pal.get("singleColor"), "#2176C1")
    default_multi = ["#2176C1","#FFB100","#FF6363","#7FDBB6","#6E44FF",
                     "#F25F5C","#007F5C","#F49D37","#A259F7","#3A86FF",
                     "#FF5C8A","#FFC43D"]
    multi = _clean_colors(pal.get("multi"), default_multi)

    # Фон
    bg = _to_color((style.get("background") or {}).get("color"), "#FFFFFF")
    fig.patch.set_facecolor(bg)
    ax.set_facecolor(bg)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # ---------- Оси / подписи ----------
    axes = style.get("axes") or {}
    x_cfg = axes.get("x") or {}
    y_cfg = axes.get("y") or {}

    def _int(v, d):
        try:
            return int(float(v if v is not None else d))
        except Exception:
            return d

    rot    = _int(x_cfg.get("rotation", 30), 30)
    x_tick = _int(x_cfg.get("tickFont", 10), 10)
    wrap   = _int(x_cfg.get("wrap", 13), 13)
    y_tick = _int(y_cfg.get("tickFont", 10), 10)

    y_grid  = bool(y_cfg.get("grid", True))
    y_label = y_cfg.get("label") or "Всего, т"

    # единица измерения из подписи оси Y ("Всего, т" → "т")
    y_unit = None
    if isinstance(y_label, str) and "," in y_label:
        tail = y_label.split(",", 1)[1].strip()
        if tail:
            y_unit = tail

    layout = style.get("layout") or {}
    title_cfg  = layout.get("title")  or {"show": True, "upper": True, "fontSize": 18, "align": "center"}
    legend_cfg = layout.get("legend") or {"show": True, "position": "bottom"}

    # перенос подписей X
    def _wrap_text(text: str, max_len: int = 13) -> str:
        words = str(text).split()
        lines, line = [], ""
        for w in words:
            trial = (line + " " + w).strip()
            if len(trial) <= max_len:
                line = trial
            else:
                if line:
                    lines.append(line)
                line = w
        if line:
            lines.append(line)
        return "\n".join(lines)

    # ---------- Подготовка данных ----------
    x_domain: List[str] = []
    for s in series:
        for pt in s.get("data", []):
            lab = _wrap_text(str(pt["x"]), wrap)
            if lab not in x_domain:
                x_domain.append(lab)

    ser_names: List[str] = []
    ser_values: List[List[float]] = []
    for idx, s in enumerate(series):
        base_label = s.get("description") or s.get("label") or s.get("tag") or f"Серия {idx+1}"
        unit = s.get("unit") or y_unit
        label = f"{base_label}, {unit}" if unit else str(base_label)
        ser_names.append(label)

        m = {_wrap_text(str(pt["x"]), wrap): float(pt["y"]) for pt in s.get("data", [])}
        vals = [m.get(xlab, 0.0) for xlab in x_domain]
        ser_values.append(vals)

    n_series = max(1, len(ser_names))
    x = np.arange(len(x_domain))

    # ---------- Ширина и зазор ----------
    bars_cfg = style.get("bars") or {}

    # ширина категории (доля от шага по X; можно задавать 0.2..1.5 или процентами >3)
    try:
        raw_width = float(bars_cfg.get("width", 0.9) or 0.9)
    except Exception:
        raw_width = 0.9
    cat_width = raw_width / 100.0 if raw_width > 3 else raw_width
    cat_width = min(1.5, max(0.2, cat_width))

    # внутренний зазор между столбиками одной категории (доля от ширины категории)
    try:
        gap_ratio = float(bars_cfg.get("gap", 0.10) or 0.10)
    except Exception:
        gap_ratio = 0.10
    gap_ratio = min(0.5, max(0.0, gap_ratio))

    if n_series == 1:
        barw = cat_width
        offsets = [0.0]
    else:
        # общий «зазор» = gap_px * (n_series - 1)
        gap_px = cat_width * gap_ratio / max(1, n_series)  # скейлим к числу серий
        usable = max(0.05, cat_width - gap_px * (n_series - 1))
        barw = max(0.01, usable / n_series)

        # центры баров внутри категории
        start = -cat_width / 2 + barw / 2
        offsets = [start + i * (barw + gap_px) for i in range(n_series)]

    # ---------- Цвета ----------
    if mode == "single":
        colors = [single_color for _ in range(n_series)]
    elif mode == "single-or-multi" and n_series <= 1:
        colors = [single_color]
    else:
        colors = [multi[i % len(multi)] for i in range(n_series)]

    # ---------- Рендер ----------
    rects_all = []
    for i in range(n_series):
        rects = ax.bar(x + offsets[i], ser_values[i], barw, label=ser_names[i], color=colors[i])
        rects_all.append(rects)

    # значения внутри
    if bars_cfg.get("showValueInside", True):
        try:
            prec = int(float(bars_cfg.get("valuePrecision", 1) or 1))
        except Exception:
            prec = 1
        for rects in rects_all:
            for r in rects:
                h = r.get_height()
                if h:
                    ax.text(r.get_x() + r.get_width() / 2, h * 0.5, f"{h:.{prec}f}",
                            ha="center", va="center", fontsize=10, color="white", fontweight="bold")

    # оси/сетка
    ax.set_xticks(x)
    ax.set_xticklabels(x_domain, fontsize=x_tick, rotation=rot, ha="right", linespacing=1.2, fontweight="bold")
    ax.tick_params(axis='y', labelsize=y_tick)
    ax.set_ylabel(y_label)
    if y_grid:
        ax.yaxis.grid(True, linestyle="--", alpha=0.25)
    if (axes.get("x") or {}).get("grid", False):
        ax.xaxis.grid(True, linestyle="--", alpha=0.25)

    # фиксируем X-пределы, чтобы ширина и зазоры были видимы даже при 1 категории
    ax.set_xlim(-0.5, len(x_domain) - 0.5)

    # легенда
    if legend_cfg.get("show", True):
        loc = {
            "top": "upper center",
            "bottom": "lower center",
            "left": "center left",
            "right": "center right",
        }.get(legend_cfg.get("position", "bottom"), "lower center")
        ax.legend(loc=loc, ncols=max(1, min(3, n_series)), frameon=False)

    # заголовок
    if title_cfg.get("show", True):
        t = title.upper() if title_cfg.get("upper", True) else title
        align = {"left": "left", "center": "center", "right": "right"}.get(title_cfg.get("align", "center"), "center")
        ax.set_title(t, fontsize=int(title_cfg.get("fontSize", 18)), loc=align)

    # вывод
    buf = io.BytesIO()
    plt.tight_layout()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


  

def _ha(v: str) -> str:
    return {"left": "left", "center": "center", "right": "right"}.get((v or "left").lower(), "left")


def _fmt_num(v: Any, prec: int, th: str, dec: str) -> str:
    try:
        f = float(v)
    except Exception:
        return "-"
    s = f"{f:,.{prec}f}"
    return s.replace(",", "X").replace(".", dec).replace("X", th)

def load_style_for_template(cur, template_id: int, override: dict | None = None) -> dict:
    """
    1) Берём StyleId из ReportTemplates.
    2) Если есть — читаем json стиля из ReportStyles.
    3) Если нет — дефолты.
    4) Поверх — глубокий merge override (если пришёл).
    """
    cur.execute("SELECT StyleId FROM ReportTemplates WHERE Id=?", template_id)
    row = cur.fetchone()

    if row and getattr(row, "StyleId", None):
        style_id = row.StyleId
        cur.execute("SELECT ChartStyle, TableStyle, ExcelStyle FROM ReportStyles WHERE Id=?", style_id)
        s = cur.fetchone()
        base = {
            "chart": (json.loads(s.ChartStyle) if s and s.ChartStyle else ChartStyle().dict()),
            "table": (json.loads(s.TableStyle) if s and s.TableStyle else TableStyle().dict()),
            "excel": (json.loads(getattr(s, "ExcelStyle", None)) if s and getattr(s, "ExcelStyle", None) else ExcelStyle().dict())
        }
    else:
        base = {
            "chart": ChartStyle().dict(),
            "table": TableStyle().dict(),
            "excel": ExcelStyle().dict()
        }

    if override:
        for k in ("chart", "table", "excel"):
            if isinstance(override.get(k), dict):
                _deep_merge(base[k], override[k])

    return base


def generate_table_pngs_for_balance(
    rows: List[Dict[str, Any]],
    date_key: str,
    product_key: str = "TagName",
    value_key: str = "Выход, тонн",
    style: Dict[str, Any] | None = None
) -> List[str]:
    """
    Рендерит PNG-таблицы по каждой дате. Возвращает список base64 PNG.
    Жёстко применяет шрифт через FontProperties(fname=...).
    """
    style = (style or {})
    if not rows:
        return []

    # --- ШРИФТ
    fam, fpath = resolve_font(style.get("fontFamily"))
    mpl.rcParams["font.family"] = fam
    fp_header_base = FontProperties(fname=fpath) if fpath else FontProperties(family=fam)
    fp_body_base   = FontProperties(fname=fpath) if fpath else FontProperties(family=fam)

    font_size   = int(style.get("fontSize", 13))
    density     = (style.get("density") or "compact").lower()
    dens_scale  = {"compact": 0.85, "normal": 1.0, "comfortable": 1.15}.get(density, 0.85)

    # --- header/body/columns/totals
    header = style.get("header", {}) or {}
    head_bg    = _clean_color(header.get("bg"))    or "#F7F9FC"
    head_color = _clean_color(header.get("color")) or "#0F172A"
    head_bold  = bool(header.get("bold", True))
    head_align = _ha(header.get("align", "center"))

    body = style.get("body", {}) or {}
    zebra      = bool(body.get("zebra", True))
    zebra_col  = _clean_color(body.get("zebraColor"))  or "#FAFBFC"
    border_col = _clean_color(body.get("borderColor")) or "#EEF1F6"
    num_prec   = int(body.get("numberPrecision", 1))
    thousand   = body.get("thousandSep", " ")
    decimal    = body.get("decimalSep", ",")
    body_align = _ha(body.get("align", "left"))
    align_nums_right = bool(body.get("alignNumbersRight", True))
    text_color = _clean_color(body.get("color")) or "#0F172A"

    cols_cfg     = style.get("columns", {}) or {}
    first_w_pct  = int(cols_cfg.get("firstColWidthPct", 68))
    max_w_px     = int(cols_cfg.get("maxWidthPx", 980))
    auto_width   = bool(cols_cfg.get("autoWidth", True))

    totals = style.get("totals", {}) or {}
    show_totals  = bool(totals.get("show", False))
    totals_label = totals.get("label", "Итого")

    # --- Группировка по дате
    by_date: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        d = r.get(date_key)
        if hasattr(d, "strftime"):
            d = d.strftime("%Y-%m-%d")
        elif isinstance(d, str):
            d = d[:10]
        by_date[str(d)].append(r)

    images: List[str] = []
    for d, items in sorted(by_date.items()):
        dict_rows = []
        total_val = 0.0
        for it in items:
            val = it.get(value_key)
            try:
                f = float(val)
            except Exception:
                f = 0.0
            total_val += f
            dict_rows.append({
                "Продукт": str(it.get(product_key, "")),
                "Выход, т": _fmt_num(f, num_prec, thousand, decimal),
            })

        if show_totals:
            dict_rows.append({
                "Продукт": totals_label,
                "Выход, т": _fmt_num(total_val, num_prec, thousand, decimal),
            })

        df = pd.DataFrame(dict_rows)
        n_rows = len(df)

        # --- размеры фигуры
        fig_w = min(max_w_px / 150.0, 7.5)
        base_h = max(1.6, 0.42 * n_rows + 0.8)
        fig_h = base_h * dens_scale

        fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=150)
        ax.axis("off")

        # --- заголовок
        ax.text(
            0.0, 1.04, f"Дата: {d}",
            fontsize=max(10, int(font_size * 0.9)),
            fontproperties=fp_body_base,
            color=text_color,
            transform=ax.transAxes
        )

        # --- ширины колонок
        if auto_width:
            max_l = max([len(str(x)) for x in df["Продукт"].values] + [7])
            max_r = max([len(str(x)) for x in df["Выход, т"].values] + [7])
            sum_lr = max(1, max_l + max_r)
            cw1 = max(0.4, min(0.85, max_l / sum_lr))
            cw2 = 1.0 - cw1
        else:
            cw1 = max(0.4, min(0.9, first_w_pct / 100.0))
            cw2 = 1.0 - cw1

        tbl = ax.table(
            cellText=df.values,
            colLabels=df.columns,
            cellLoc="center",
            colLoc="center",
            loc="upper left",
            bbox=[0.0, 0.0, 1.0, 0.92],
            colWidths=[cw1, cw2],
        )
        tbl.auto_set_font_size(False)
        base_font = max(8, int(font_size * 0.92))
        tbl.set_fontsize(base_font)
        tbl.scale(1.0, 0.88 if density == "compact" else (1.0 if density == "normal" else 1.12))

        # --- подготавливаем свойства шрифта с актуальным размером
        fp_header = fp_header_base.copy()
        fp_header.set_size(base_font)
        if head_bold:
            fp_header.set_weight("bold")

        fp_body = fp_body_base.copy()
        fp_body.set_size(base_font)

        # --- стиль ячеек
        for (ri, ci), cell in tbl.get_celld().items():
            cell.set_edgecolor(border_col)
            text = cell.get_text()
            if ri == 0:
                cell.set_facecolor(head_bg)
                text.set_color(head_color)
                text.set_fontproperties(fp_header)
                text.set_ha(head_align)
            else:
                text.set_color(text_color)
                text.set_fontproperties(fp_body)
                if zebra and ri % 2 == 1:
                    cell.set_facecolor(zebra_col)
                # выравнивание текста
                if ci == 0:
                    text.set_ha(body_align)
                else:
                    text.set_ha("right" if align_nums_right else body_align)

        # --- вывод
        buf = io.BytesIO()
        plt.tight_layout(pad=0.2)
        fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
        plt.close(fig)
        buf.seek(0)
        images.append(base64.b64encode(buf.read()).decode("utf-8"))

    return images



def _deep_merge(dst: dict, src: dict) -> dict:
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def load_style_for_template(cur, template_id: int, override: dict | None = None) -> dict:
    cur.execute("SELECT StyleId FROM ReportTemplates WHERE Id=?", template_id)
    row = cur.fetchone()
    base = None
    if row and getattr(row, "StyleId", None):
        cur.execute("SELECT ChartStyle, TableStyle, ExcelStyle FROM ReportStyles WHERE Id=?", row.StyleId)
        s = cur.fetchone()
        base = {
            "chart": (json.loads(s.ChartStyle) if s and s.ChartStyle else ChartStyle().dict()),
            "table": (json.loads(s.TableStyle) if s and s.TableStyle else TableStyle().dict()),
            "excel": (json.loads(getattr(s, "ExcelStyle", None)) if s and getattr(s, "ExcelStyle", None) else ExcelStyle().dict())
        }
    if not base:
        base = {"chart": ChartStyle().dict(), "table": TableStyle().dict(), "excel": ExcelStyle().dict()}

    if override:
        for k in ("chart", "table", "excel"):
            if isinstance(override.get(k), dict):
                _deep_merge(base[k], override[k])

    return base


# --------------------------------------------------------------------------------------
# Предпросмотр отчёта
# --------------------------------------------------------------------------------------
@router.post("/preview")
def preview_report(payload: PreviewRequest):
    try:
        # 0) Подготовим шрифты (одноразовая регистрация на процесс)
        ensure_fonts_ready()

        table_pngs: Optional[List[str]] = None
        with _db() as conn:
            cur = conn.cursor()

            # 1) Тип отчёта и имя шаблона
            cur.execute("SELECT ReportType, Name FROM ReportTemplates WHERE Id=?", payload.template_id)
            row = cur.fetchone()
            if not row:
                return {"ok": False, "detail": "Не найден шаблон отчёта."}
            report_type = row.ReportType or "custom"
            template_name = row.Name or "Предпросмотр отчёта"

            # 1.1) Стили + глобальный шрифт (важно сделать до рендера)
            styles = load_style_for_template(cur, payload.template_id, payload.style_override)
            chart_style = styles["chart"].copy()
            if "fontFamily" not in chart_style and styles.get("table", {}).get("fontFamily"):
                chart_style["_tableFont"] = styles["table"]["fontFamily"]
            table_style = styles["table"]
            excel_style = styles.get("excel", {})

            # Глобально применим семейство: table → chart → дефолт
            base_font_family = table_style.get("fontFamily") or chart_style.get("fontFamily") or "Roboto Condensed"
            fam, fpath = resolve_font(base_font_family)
            apply_matplotlib_font(fam)  # глобально
            _base_font_props = FontProperties(fname=fpath) if fpath else FontProperties(family=fam)

            # 2) Теги для шаблона
            if report_type == "balance":
                tag_ids = get_tag_ids_for_template(payload.template_id, as_list=False)
            else:
                tag_ids = get_tag_ids_for_template(payload.template_id, as_list=True)
            if not tag_ids:
                return {"ok": False, "detail": "Не выбраны теги для шаблона."}

            # 3) Подписи тегов (будем использовать как description в легенде)
            cur.execute("""
                SELECT t.BrowseName, ISNULL(t.Description, t.BrowseName) AS Label
                FROM OpcTags t
                WHERE t.Id IN (SELECT TagId FROM ReportTemplateTags WHERE TemplateId = ?)
            """, payload.template_id)
            tag_label_map = {r.BrowseName: r.Label for r in cur.fetchall()}

            # 4) Данные отчёта
            if report_type == "balance":
                if payload.period_type == "weekly":
                    now = datetime.now()
                    this_mon_8 = (now - timedelta(days=now.weekday())).replace(hour=8, minute=0, second=0, microsecond=0)
                    week_end = this_mon_8.date()
                    week_start = (this_mon_8 - timedelta(days=7)).date()
                    proc = "sp_Telegram_BalanceReport_Daily"
                    cur.execute(f"EXEC {proc} ?, ?, ?", week_start, week_end - timedelta(days=1), tag_ids)
                    columns, data = _rows_to_dicts(cur)
                    period = {"date_from": str(week_start), "date_to": str(week_end - timedelta(days=1))}
                else:
                    proc, date_from, date_to = get_balance_proc_and_period(payload.period_type)
                    cur.execute(f"EXEC {proc} ?, ?, ?", date_from, date_to, tag_ids)
                    columns, data = _rows_to_dicts(cur)
                    period = {"date_from": date_from, "date_to": date_to}
            else:
                date_from, date_to, group_type = compute_preview_period(payload.period_type, payload.time_of_day)
                agg_list = [a.strip().upper() for a in (payload.aggregation_type or "CURR").split(",") if a.strip()]
                import json as _json
                tags_json = _json.dumps([
                    {"tag_id": int(tid), "aggregates": agg_list, "interval_minutes": 60}
                    for tid in tag_ids  # type: ignore[arg-type]
                ])
                cur.execute("EXEC sp_Telegram_TagValues_MultiAgg ?, ?, ?, ?",
                            date_from, date_to, tags_json, group_type)
                columns, data = _rows_to_dicts(cur)
                period = {"date_from": date_from, "date_to": date_to}

        # 5) Фильтр по смене — только для shift
        if payload.period_type == "shift" and payload.time_of_day:
            t5 = payload.time_of_day[:5]
            shift_no = 1 if t5 == "08:00" else 2 if t5 == "20:00" else None
            if shift_no is not None:
                data = [r for r in data if str(r.get("ShiftNo", "")) == str(shift_no)]
                time_target = datetime.strptime(payload.time_of_day, "%H:%M:%S").time()

                def is_shift_match(row: Dict[str, Any]) -> bool:
                    start = row.get("Начало") or row.get("Start")
                    if isinstance(start, datetime):
                        return start.time().hour == time_target.hour
                    return True

                data = [r for r in data if is_shift_match(r)]

        # 6) Series для графика (важно: используем description и unit="т", НЕ добавляем 'Value' в легенду)
        chart_series: List[Dict[str, Any]] = []
        if report_type == "balance" and payload.period_type == "weekly":
            # суммируем по дням, переводим в тонны
            by_date = defaultdict(float)
            for r in data:
                dt = r.get("Date") or r.get("Дата")
                dkey = dt.date() if isinstance(dt, datetime) else datetime.strptime(str(dt), "%Y-%m-%d").date()
                try:
                    by_date[dkey] += float(r.get("Прирост") or 0)
                except Exception:
                    pass

            now = datetime.now()
            this_mon_8 = (now - timedelta(days=now.weekday())).replace(hour=8, minute=0, second=0, microsecond=0)
            ordered_days = [(this_mon_8 - timedelta(days=7) + timedelta(days=i)).date() for i in range(7)]
            chart_series = [{
                "tag": "Всего за день",
                "description": "Всего за день",
                "unit": "т",
                "data": [{
                    "x": f"{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][d.weekday()]} {d.day:02d}.{d.month:02d}",
                    "y": (by_date.get(d, 0.0) or 0.0) / 1000.0
                } for d in ordered_days],
            }]
        else:
            if data:
                # группируем точки по человеческой метке тега (description)
                series_dict: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
                for row in data:
                    tag_name = row.get("TagName")
                    label = tag_label_map.get(tag_name, tag_name)  # человекочитаемое имя
                    y_raw = row.get("Прирост") if "Прирост" in row else row.get("Value")
                    try:
                        y = float(y_raw) if y_raw is not None else None
                    except Exception:
                        y = None
                    if y is None:
                        continue
                    y = y / 1000.0  # в тонны
                    x = row.get("Date") or row.get("Начало") or row.get("Start") or label
                    if isinstance(x, datetime):
                        x = x.strftime("%d.%m %H:%M")
                    series_dict[str(label)].append({"x": x, "y": y})

                for label, points in series_dict.items():
                    chart_series.append({
                        "tag": label,             # на всякий случай оставим
                        "description": label,     # именно это уйдёт в легенду
                        "unit": "т",
                        "data": points
                    })

        # 7) Форматирование таблиц и PNG-таблицы (балансовые)
        fmt = (payload.format or "").lower()
        is_table_or_text = fmt in ("table", "text")

        if is_table_or_text and report_type == "balance" and data:
            sample = data[0]
            date_key = "Date" if "Date" in sample else ("Период" if "Период" in sample else None)
            shift_key = "Смена" if "Смена" in sample else None

            out_cols = [c for c in [date_key, shift_key, "TagName", "Выход, т"] if c]
            out_rows: List[Dict[str, Any]] = []
            for r in data:
                browse = r.get("TagName")
                label = tag_label_map.get(browse, browse)
                growth = r.get("Прирост") if "Прирост" in r else r.get("Value")
                try:
                    val_t = float(growth or 0) / 1000.0
                except Exception:
                    val_t = None

                newr: Dict[str, Any] = {}
                if date_key:
                    newr[date_key] = r.get(date_key)
                if shift_key:
                    newr["Смена"] = r.get(shift_key)
                newr["TagName"] = label
                newr["Выход, т"] = val_t
                out_rows.append(newr)

            columns = out_cols
            data = out_rows

            date_key_for_img = "Date" if "Date" in columns else "Период"
            table_pngs = generate_table_pngs_for_balance(
                data,
                date_key=date_key_for_img,
                product_key="TagName",
                value_key="Выход, т",
                style=table_style,
            )

        # 8) PNG-график
        chart_png = generate_bar_chart_png(chart_series, title=template_name, style=chart_style) if chart_series else None

        # 9) Обрезаем лишние ключи в данных под текущие columns
        if columns:
            data = [{k: row.get(k) for k in columns} for row in data]

        return {
            "ok": True,
            "data": data,
            "columns": columns,
            "chart_series": chart_series,
            "chart_png": chart_png,
            "table_pngs": table_pngs,
            "text_table": make_telegram_table(columns, data),
            "period": period,
            "effective_style": {
                "chart": chart_style,
                "table": table_style,
                "excel": excel_style,
            },
        }

    except Exception as ex:
        import traceback
        print("Ошибка в preview_report:\n", traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Ошибка генерации превью: {ex}")


# --------------------------------------------------------------------------------------
# Расчёт первичного NextRun (для /schedule)
# --------------------------------------------------------------------------------------
def compute_initial_nextrun(period_type: str, time_of_day: Optional[str]) -> datetime:
    now = datetime.now()
    hh, mm, ss = 8, 0, 0
    if time_of_day:
        parts = [int(p) for p in time_of_day.split(":")]
        if len(parts) == 3:
            hh, mm, ss = parts
        elif len(parts) == 2:
            hh, mm = parts
            ss = 0

    if period_type in ("day", "daily"):
        run = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if run <= now:
            run += timedelta(days=1)
    elif period_type == "shift":
        run = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if run <= now:
            run += timedelta(hours=12 if hh in (8, 20) else 12)
    elif period_type == "weekly":
        target = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        days_ahead = (7 - now.weekday()) % 7
        if days_ahead == 0 and target <= now:
            days_ahead = 7
        run = (now + timedelta(days=days_ahead)).replace(hour=hh, minute=mm, second=ss, microsecond=0)
    elif period_type == "monthly":
        if now.month == 12:
            run = now.replace(year=now.year + 1, month=1, day=1, hour=hh, minute=mm, second=ss, microsecond=0)
        else:
            run = now.replace(month=now.month + 1, day=1, hour=hh, minute=mm, second=ss, microsecond=0)
    elif period_type == "hourly":
        run = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    elif period_type == "once":
        run = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if run <= now:
            run = now
    else:
        run = (now + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)

    return run


# --------------------------------------------------------------------------------------
# Задачи (grid в UI)
# --------------------------------------------------------------------------------------
@router.get("/tasks")
def get_report_tasks():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT
                    rs.Id,
                    rs.TemplateId,
                    t.Name as TemplateName,
                    rs.PeriodType,
                    rs.TimeOfDay,
                    rs.NextRun,
                    rs.LastRun,
                    rs.Active,
                    rs.TargetType,
                    rs.TargetValue,
                    rs.AggregationType,
                    rs.SendFormat
                FROM OpcUaSystem.dbo.ReportSchedule rs
                LEFT JOIN OpcUaSystem.dbo.ReportTemplates t ON rs.TemplateId = t.Id
                ORDER BY rs.Id DESC
            """)
            tasks: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                tasks.append({
                    "id": row.Id,
                    "template_id": row.TemplateId,
                    "template_name": row.TemplateName,
                    "period_type": row.PeriodType,
                    "time_of_day": str(row.TimeOfDay) if row.TimeOfDay else None,
                    "next_run": str(row.NextRun) if row.NextRun else None,
                    "last_run": str(row.LastRun) if row.LastRun else None,
                    "active": bool(row.Active),
                    "target_type": row.TargetType,
                    "target_value": row.TargetValue,
                    "aggregation_type": row.AggregationType,
                    "send_format": row.SendFormat,
                })
            return {"ok": True, "tasks": tasks}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.post("/tasks")
def create_report_task(payload: ReportTaskCreate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO ReportSchedule
                    (TemplateId, PeriodType, TimeOfDay, TargetType, TargetValue, AggregationType, SendFormat, Active)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """, payload.template_id, payload.period_type, payload.time_of_day,
                         payload.target_type, payload.target_value,
                         payload.aggregation_type, payload.send_format)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.put("/tasks/{id}")
def update_report_task(id: int, payload: ReportTaskUpdate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE ReportSchedule
                SET TemplateId=?, PeriodType=?, TimeOfDay=?,
                    TargetType=?, TargetValue=?, AggregationType=?, SendFormat=?
                WHERE Id=? 
            """, payload.template_id, payload.period_type, payload.time_of_day,
                         payload.target_type, payload.target_value,
                         payload.aggregation_type, payload.send_format, id)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.delete("/tasks/{id}")
def delete_report_task(id: int):
    """
    Физическое удаление задания из ReportSchedule.
    Если предусмотрены логи/история по заданиям, чистить их здесь же
    (или выставить ON DELETE CASCADE на FK).
    """
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM ReportSchedule WHERE Id = ?", id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Задание не найдено")
            conn.commit()
            return {"ok": True, "deleted": id}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.post("/tasks/{id}/activate")
def activate_report_task(id: int):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("UPDATE ReportSchedule SET Active=1 WHERE Id=?", id)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
