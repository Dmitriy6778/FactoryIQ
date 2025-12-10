from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])

@router.get("")
def check():
    return {"ok": True, "service": "AltaiMaiLab"}
