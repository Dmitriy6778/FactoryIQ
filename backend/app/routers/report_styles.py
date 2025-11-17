# app/routers/report_styles.py
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal, Union
import pyodbc
import json
from ..config import get_conn_str

router = APIRouter(prefix="/report_styles", tags=["report_styles"])

def _db():
    # autocommit удобнее для INSERT/UPDATE
    return pyodbc.connect(get_conn_str(), autocommit=True)

# =========================
# Pydantic модели (в синхроне с фронтом)
# =========================

class ChartLine(BaseModel):
    width: int = 2
    smooth: bool = False
    showPoints: bool = True
    pointRadius: int = 3
    valuePrecision: int = 1
    class Config: extra = "allow"

class ChartBars(BaseModel):
    width: float = 0.9
    gap: float = 0.1
    rounded: bool = True
    showValueInside: bool = True
    valuePrecision: int = 1
    class Config: extra = "allow"

class ChartAxesX(BaseModel):
    rotation: int = 30
    tickFont: int = 10
    wrap: int = 13
    grid: bool = False
    class Config: extra = "allow"

class ChartAxesY(BaseModel):
    tickFont: int = 10
    grid: bool = True
    label: str = "Всего, тонн"
    class Config: extra = "allow"

class ChartAxes(BaseModel):
    x: ChartAxesX = ChartAxesX()
    y: ChartAxesY = ChartAxesY()
    class Config: extra = "allow"

class ChartLayoutTitle(BaseModel):
    show: bool = True
    align: Literal["left","center","right"] = "center"
    fontSize: int = 18
    upper: bool = True
    class Config: extra = "allow"

class ChartLayoutLegend(BaseModel):
    show: bool = True
    position: Literal["top","bottom","left","right"] = "bottom"
    class Config: extra = "allow"

class ChartLayout(BaseModel):
    title: ChartLayoutTitle = ChartLayoutTitle()
    legend: ChartLayoutLegend = ChartLayoutLegend()
    class Config: extra = "allow"

class ChartPalette(BaseModel):
    type: Literal["single","multi","single-or-multi"] = "single-or-multi"
    singleColor: str = "#2176C1"
    multi: List[str] = [
        "#2176C1","#FFB100","#FF6363","#7FDBB6","#6E44FF","#F25F5C",
        "#007F5C","#F49D37","#A259F7","#3A86FF","#FF5C8A","#FFC43D"
    ]
    class Config: extra = "allow"

class ChartBackground(BaseModel):
    color: str = "#FFFFFF"
    class Config: extra = "allow"

class ChartWatermark(BaseModel):
    text: str = ""
    opacity: float = 0.0
    position: Literal["tl","tr","bl","br"] = "br"
    class Config: extra = "allow"

class ChartSize(BaseModel):
    w: int = 1280
    h: int = 600
    class Config: extra = "allow"

class ChartStyle(BaseModel):
    type: Literal["bar","line"] = "bar"
    dpi: int = 140
    size: ChartSize = ChartSize()
    fontFamily: str = ""
    fontWeight: int = 400
    fontStyle: Literal["normal","italic","oblique"] = "normal"
    layout: ChartLayout = ChartLayout()
    axes: ChartAxes = ChartAxes()
    bars: ChartBars = ChartBars()
    line: ChartLine = ChartLine()
    palette: ChartPalette = ChartPalette()
    background: ChartBackground = ChartBackground()
    watermark: ChartWatermark = ChartWatermark()
    class Config: extra = "allow"

class TableHeader(BaseModel):
    bg: str = "#F7F9FC"
    color: str = "#0F172A"
    bold: bool = True
    align: Literal["left","center","right"] = "center"
    italic: bool = False
    class Config: extra = "allow"

class TableBody(BaseModel):
    zebra: bool = True
    zebraColor: str = "#FAFBFC"
    borderColor: str = "#EEF1F6"
    numberPrecision: int = 1
    thousandSep: str = " "
    decimalSep: str = ","
    alignNumbersRight: bool = True
    color: str = "#0F172A"
    align: Literal["left","center","right"] = "left"
    italic: bool = False
    class Config: extra = "allow"

class TableColumns(BaseModel):
    autoWidth: bool = True
    maxWidthPx: int = 980
    firstColWidthPct: int = 68
    class Config: extra = "allow"

class TableTotals(BaseModel):
    show: bool = False
    label: str = "Итого"
    class Config: extra = "allow"

class TableStyle(BaseModel):
    density: Literal["compact","normal","comfortable"] = "compact"
    fontSize: int = 13
    fontFamily: str = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,Ubuntu,sans-serif"
    fontWeight: int = 400
    fontStyle: Literal["normal","italic","oblique"] = "normal"
    header: TableHeader = TableHeader()
    body: TableBody = TableBody()
    columns: TableColumns = TableColumns()
    totals: TableTotals = TableTotals()
    class Config: extra = "allow"

class ExcelStyle(BaseModel):
    sheetName: str = "Отчет"
    freezeHeader: bool = True
    autoWidth: bool = True
    numberFormat: str = "# ##0.0"
    dateFormat: str = "yyyy-mm-dd hh:mm"
    class Config: extra = "allow"

class ReportStyleDTO(BaseModel):
    id: Optional[int] = None
    name: str
    chart: Union[ChartStyle, Dict[str, Any]] = ChartStyle()
    table: Union[TableStyle, Dict[str, Any]] = TableStyle()
    excel: Union[ExcelStyle, Dict[str, Any]] = ExcelStyle()
    is_default: bool = False
    class Config: extra = "allow"

# =========================
# Helpers
# =========================

def _json_load(s, default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default

def _json_dump(obj):
    return json.dumps(obj or {}, ensure_ascii=False)

def _deep_merge(a: dict, b: dict) -> dict:
    """Глубокое слияние словарей без мутации оригиналов."""
    if not isinstance(a, dict):
        a = {}
    if not isinstance(b, dict):
        b = {}
    out = {**a}
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out

def _row_to_style(r) -> Dict[str, Any]:
    def _parse(s, default_obj):
        if not s:
            return default_obj
        try:
            return json.loads(s)
        except Exception:
            return default_obj
    return {
        "id": r.Id,
        "name": r.Name,
        "chart": _parse(r.ChartStyle, ChartStyle().dict()),
        "table": _parse(r.TableStyle, TableStyle().dict()),
        "excel": _parse(getattr(r, "ExcelStyle", None), ExcelStyle().dict()),
        "is_default": bool(r.IsDefault),
    }

def get_style_by_id(style_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault
            FROM ReportStyles WHERE Id=?
        """, style_id)
        r = cur.fetchone()
        return _row_to_style(r) if r else None

def get_default_style():
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT TOP 1 Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault
            FROM ReportStyles WHERE IsDefault=1 ORDER BY Id
        """)
        r = cur.fetchone()
        return _row_to_style(r) if r else {
            "id": None, "name": "Built-in default",
            "chart": ChartStyle().dict(),
            "table": TableStyle().dict(),
            "excel": ExcelStyle().dict(),
            "is_default": True,
        }

def _to_json_blob(v: Union[BaseModel, Dict[str, Any]]) -> str:
    if isinstance(v, BaseModel):
        v = v.dict()
    return json.dumps(v, ensure_ascii=False)

# =========================
# Endpoints: стили (каталог)
# =========================

@router.get("/default")
def get_default():
    return {"ok": True, "style": get_default_style()}

@router.get("/{style_id}")
def get_by_id(style_id: int):
    st = get_style_by_id(style_id)
    if not st:
        raise HTTPException(status_code=404, detail="Style not found")
    return {"ok": True, "style": st}

@router.get("/", response_model=List[ReportStyleDTO])
def list_styles():
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault
            FROM ReportStyles ORDER BY Name
        """)
        out: List[ReportStyleDTO] = []
        for r in cur.fetchall():
            st = _row_to_style(r)
            out.append(ReportStyleDTO(**st))
        return out

@router.post("/", response_model=ReportStyleDTO)
def create_style(dto: ReportStyleDTO):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO ReportStyles (Name, ChartStyle, TableStyle, ExcelStyle, IsDefault)
            OUTPUT INSERTED.Id
            VALUES (?, ?, ?, ?, ?)
        """,
            dto.name,
            _to_json_blob(dto.chart),
            _to_json_blob(dto.table),
            _to_json_blob(dto.excel),
            int(dto.is_default)
        )
        new_id = int(cur.fetchone()[0])
        return ReportStyleDTO(**{**dto.dict(), "id": new_id})

@router.put("/{style_id}", response_model=ReportStyleDTO)
def update_style(style_id: int, dto: ReportStyleDTO):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE ReportStyles
               SET Name=?, ChartStyle=?, TableStyle=?, ExcelStyle=?, IsDefault=?, UpdatedAt=SYSUTCDATETIME()
             WHERE Id=?
        """,
            dto.name,
            _to_json_blob(dto.chart),
            _to_json_blob(dto.table),
            _to_json_blob(dto.excel),
            int(dto.is_default),
            style_id
        )
        return ReportStyleDTO(**{**dto.dict(), "id": style_id})

@router.delete("/{style_id}")
def delete_style(style_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ReportStyles WHERE Id=?", style_id)
        return {"ok": True}

# =========================
# Endpoints: связь стиля с ReportSchedule (пер-задачи)
# =========================

class TaskStyleDTO(BaseModel):
    style_id: Optional[int] = None
    style_override: Optional[Dict[str, Any]] = None

@router.get("/tasks/{schedule_id}/style")
def get_task_style(schedule_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT StyleId, StyleOverride
            FROM ReportSchedule
            WHERE Id=?
        """, schedule_id)
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return {
            "ok": True,
            "style_id": int(r.StyleId) if r.StyleId is not None else None,
            "style_override": _json_load(getattr(r, "StyleOverride", None), {}) or {},
        }

@router.put("/tasks/{schedule_id}/style")
def set_task_style(schedule_id: int, payload: TaskStyleDTO = Body(...)):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE ReportSchedule
               SET StyleId=?, StyleOverride=?
             WHERE Id=?
        """,
            payload.style_id,
            _json_dump(payload.style_override),
            schedule_id
        )
        return {"ok": True}
