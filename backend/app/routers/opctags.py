# app/routers/opctags.py
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict

from ..db import get_db_connection

router = APIRouter(prefix="/opctags", tags=["opctags"])


# ---------- Модели ----------
class TagDescUpdate(BaseModel):
    description: str


# ---------- Список с фильтрами/пагинацией ----------
@router.get("/list")
def list_opc_tags(
    page: int = Query(1, gt=0),
    page_size: int = Query(100, le=500),
    server_id: Optional[int] = Query(None, description="Фильтр по серверу"),
    browse_name: str = Query("", alias="browse_name"),
    node_id: str = Query("", alias="node_id"),
    data_type: str = Query("", alias="data_type"),
    path: str = Query("", alias="path"),
    description: str = Query("", alias="description"),
):
    filters = []
    params: List = []

    if server_id is not None:
        filters.append("t.ServerId = ?")
        params.append(server_id)
    if browse_name:
        filters.append("t.BrowseName LIKE ?")
        params.append(f"%{browse_name}%")
    if node_id:
        filters.append("t.NodeId LIKE ?")
        params.append(f"%{node_id}%")
    if data_type:
        filters.append("t.DataType LIKE ?")
        params.append(f"%{data_type}%")
    if path:
        filters.append("t.Path LIKE ?")
        params.append(f"%{path}%")
    if description:
        filters.append("t.Description LIKE ?")
        params.append(f"%{description}%")

    where = f"WHERE {' AND '.join(filters)}" if filters else ""

    sql = f"""
        SELECT t.Id, t.BrowseName, t.NodeId, t.DataType, t.Description, t.Path
        FROM OpcTags t
        {where}
        ORDER BY t.Id
        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    """
    params_page = params + [(page - 1) * page_size, page_size]

    count_sql = f"SELECT COUNT(*) FROM OpcTags t {where}"

    with get_db_connection() as conn:
        cur = conn.cursor()

        # total
        cur.execute(count_sql, params)
        total = int(cur.fetchone()[0])

        # page
        cur.execute(sql, params_page)
        rows = cur.fetchall()

    items = [
        {
            "id": r[0],
            "browse_name": r[1],
            "node_id": r[2],
            "data_type": r[3],
            "description": r[4],
            "path": r[5],
        }
        for r in rows
    ]

    return {"items": items, "total": total}


# ---------- Обновление описания ----------
@router.put("/{tag_id}")
def update_opc_tag_desc(tag_id: int, data: TagDescUpdate):
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE OpcTags SET Description=? WHERE Id=?", data.description, tag_id)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
        cur.execute("SELECT Id, BrowseName, NodeId, DataType, Description, Path FROM OpcTags WHERE Id=?", tag_id)
        row = cur.fetchone()
    return {
        "id": row[0],
        "browse_name": row[1],
        "node_id": row[2],
        "data_type": row[3],
        "description": row[4],
        "path": row[5],
    }


# ---------- Удаление ----------
@router.delete("/{tag_id}")
def delete_opc_tag(tag_id: int):
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM OpcTags WHERE Id=?", tag_id)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.commit()
    return {"ok": True, "deleted": tag_id}
