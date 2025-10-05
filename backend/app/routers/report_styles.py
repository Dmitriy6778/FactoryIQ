# app/routers/report_styles.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import pyodbc
import json
from ..config import get_conn_str

router = APIRouter(prefix="/styles", tags=["styles"])



# helpers
def _db():
    return pyodbc.connect(get_conn_str())

def get_style_by_id(style_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault
            FROM ReportStyles WHERE Id=?
        """, style_id)
        r = cur.fetchone()
        if not r:
            return None
        import json
        return {
            "id": r.Id,
            "name": r.Name,
            "chart": (json.loads(r.ChartStyle) if r.ChartStyle else ChartStyle().dict()),
            "table": (json.loads(r.TableStyle) if r.TableStyle else TableStyle().dict()),
            "excel": (json.loads(getattr(r, "ExcelStyle", None)) if getattr(r, "ExcelStyle", None) else ExcelStyle().dict()),
            "is_default": bool(r.IsDefault),
        }

def get_default_style():
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT TOP 1 Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault
            FROM ReportStyles
            WHERE IsDefault=1
            ORDER BY Id
        """)
        r = cur.fetchone()
        import json
        if r:
            return {
                "id": r.Id,
                "name": r.Name,
                "chart": (json.loads(r.ChartStyle) if r.ChartStyle else ChartStyle().dict()),
                "table": (json.loads(r.TableStyle) if r.TableStyle else TableStyle().dict()),
                "excel": (json.loads(getattr(r, "ExcelStyle", None)) if getattr(r, "ExcelStyle", None) else ExcelStyle().dict()),
                "is_default": True,
            }
        # запасной дефолт
        return {
            "id": None, "name": "Built-in default",
            "chart": ChartStyle().dict(),
            "table": TableStyle().dict(),
            "excel": ExcelStyle().dict(),
            "is_default": True,
        }


# --- DTOs ---
class ChartStyle(BaseModel):
    dpi: int = 140
    size: Dict[str, int] = {"w": 1280, "h": 600}
    layout: Dict[str, Any] = {
        "title": {"show": True, "align": "center", "fontSize": 18, "upper": True},
        "legend": {"show": True, "position": "bottom"}
    }
    axes: Dict[str, Any] = {
        "x": {"rotation": 30, "tickFont": 10, "wrap": 13, "grid": False},
        "y": {"tickFont": 10, "grid": True, "label": "Всего, т"}
    }
    bars: Dict[str, Any] = {"width": 0.9, "rounded": True, "showValueInside": True, "valuePrecision": 1}
    palette: Dict[str, Any] = {
        "type": "single-or-multi",  # single | multi | single-or-multi
        "singleColor": "#2176C1",
        "multi": ["#2176C1","#FFB100","#FF6363","#7FDBB6","#6E44FF","#F25F5C",
                  "#007F5C","#F49D37","#A259F7","#3A86FF","#FF5C8A","#FFC43D"]
    }
    background: Dict[str, Any] = {"color": "#FFFFFF"}
    watermark: Dict[str, Any] = {"text": "", "opacity": 0.0, "position": "br"}

class TableStyle(BaseModel):
    density: str = "compact"  # compact|normal|comfortable
    fontSize: int = 13
    header: Dict[str, Any] = {"bg": "#F7F9FC", "color": "#0F172A", "bold": True}
    body: Dict[str, Any] = {
        "zebra": True, "zebraColor": "#FAFBFC", "borderColor": "#EEF1F6",
        "numberPrecision": 1, "thousandSep": " ", "decimalSep": ",",
        "alignNumbersRight": True
    }
    columns: Dict[str, Any] = {"autoWidth": True, "maxWidthPx": 980, "firstColWidthPct": 68}
    totals: Dict[str, Any] = {"show": False, "label": "Итого"}

class ExcelStyle(BaseModel):
    sheetName: str = "Отчет"
    freezeHeader: bool = True
    autoWidth: bool = True
    numberFormat: str = "# ##0.0"
    dateFormat: str = "yyyy-mm-dd hh:mm"

class ReportStyleDTO(BaseModel):
    id: Optional[int] = None
    name: str
    chart: ChartStyle = ChartStyle()
    table: TableStyle = TableStyle()
    excel: ExcelStyle = ExcelStyle()
    is_default: bool = False


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
        cur.execute("SELECT Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault FROM ReportStyles ORDER BY Name")
        out = []
        for r in cur.fetchall():
            out.append(ReportStyleDTO(
                id=r.Id, name=r.Name,
                chart=(json.loads(r.ChartStyle) if r.ChartStyle else ChartStyle().dict()),
                table=(json.loads(r.TableStyle) if r.TableStyle else TableStyle().dict()),
                excel=(json.loads(getattr(r, "ExcelStyle", None)) if getattr(r, "ExcelStyle", None) else ExcelStyle().dict()),
                is_default=bool(r.IsDefault)
            ))
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
            json.dumps(dto.chart.dict(), ensure_ascii=False),
            json.dumps(dto.table.dict(), ensure_ascii=False),
            json.dumps(dto.excel.dict(), ensure_ascii=False),
            int(dto.is_default)
        )
        new_id = int(cur.fetchone()[0])
        conn.commit()
        dto.id = new_id
        return dto


@router.put("/{style_id}", response_model=ReportStyleDTO)
def update_style(style_id: int, dto: ReportStyleDTO):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE ReportStyles
            SET Name=?, ChartStyle=?, TableStyle=?, ExcelStyle=?, IsDefault=?
            WHERE Id=?
        """, dto.name, json.dumps(dto.chart.dict()), json.dumps(dto.table.dict()),
             json.dumps(dto.excel.dict()), int(dto.is_default), style_id)
        conn.commit()
        dto.id = style_id
        return dto

@router.delete("/{style_id}")
def delete_style(style_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ReportStyles WHERE Id=?", style_id)
        conn.commit()
        return {"ok": True}
