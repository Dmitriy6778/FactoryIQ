# backend/app/routers/report_templates.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import pyodbc
from ..config import get_conn_str

router = APIRouter(prefix="/reports", tags=["reports"])

def _db() -> pyodbc.Connection:
    return pyodbc.connect(get_conn_str())

class BindStylePayload(BaseModel):
    style_id: int

@router.get("/templates/{template_id}")
def get_template(template_id: int):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
          SELECT Id, Name, ReportType, StyleId
          FROM ReportTemplates WHERE Id=?
        """, template_id)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template not found")
        return {"ok": True, "template": {
            "id": row.Id, "name": row.Name, "report_type": row.ReportType, "style_id": row.StyleId
        }}

@router.put("/templates/{template_id}/style")
def bind_style_to_template(template_id: int, payload: BindStylePayload):
    """
    Жёстко привязываем стиль к шаблону: ReportTemplates.StyleId = payload.style_id
    """
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("UPDATE ReportTemplates SET StyleId=? WHERE Id=?", payload.style_id, template_id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Template not found")
            conn.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

