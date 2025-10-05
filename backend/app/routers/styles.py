# backend/app/routers/styles.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json
import pyodbc
from ..config import get_conn_str

router = APIRouter(prefix="/styles", tags=["styles"])

def _db():
    return pyodbc.connect(get_conn_str())

@router.get("/{style_id}")
def get_style(style_id: int):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, Name, ChartStyle, TableStyle, ExcelStyle, IsDefault, UserId, CreatedAt, UpdatedAt
                FROM ReportStyles WHERE Id=?
            """, style_id)
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Style not found")

            def _parse(s):
                if not s:
                    return None
                try:
                    return json.loads(s)
                except Exception:
                    return None

            return {
                "ok": True,
                "style": {
                    "id": row.Id,
                    "name": row.Name,
                    "chart": _parse(row.ChartStyle) or {},   # <--- уже объект
                    "table": _parse(row.TableStyle) or {},
                    "excel": _parse(getattr(row, "ExcelStyle", None)) or {},
                    "is_default": bool(row.IsDefault),
                }
            }
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
