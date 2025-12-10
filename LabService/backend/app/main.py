from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers.health import router as health_router
from app.routers.db_init import router as db_router
from app.routers.samples import router as samples_router
from app.routers.analyses import router as analyses_router

app = FastAPI(title="LabService API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(db_router)
app.include_router(samples_router)
app.include_router(analyses_router)
