# app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import (
    servers,
    db,
    tags,
    polling,
    analytics,
    reports,
    telegram_reports,
    telegram_simple,
    telegram_channels,
    report_styles,
    auth as auth_router,
)
from app.routers import opctags
from app.routers import system_router  
from app.routers import maintenance_router
from app.routers import user_screens
from app.routers import tag_settings
from app.routers import analytics_trend
from app.routers import weighbridge 

app = FastAPI(
    title="FabrIQ API",
    description="OPC-UA Historian Backend for FactoryIQ",
    version="1.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",  # ← важно
)


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost",            # если открываешь без порта
    "https://factoryiq.local",
    "http://factoryiq.local", 
    ],        
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Роуты
app.include_router(servers.router)
app.include_router(db.router)
app.include_router(tags.router)
app.include_router(polling.router)
app.include_router(analytics.router)
app.include_router(reports.router)
app.include_router(telegram_reports.router)
app.include_router(report_styles.router)
app.include_router(telegram_channels.router)
app.include_router(auth_router.router)
app.include_router(opctags.router)
app.include_router(system_router.router)  # ✅ используем system_router
app.include_router(maintenance_router.router)
app.include_router(telegram_simple.router)
app.include_router(user_screens.router)
app.include_router(user_screens.objects_router)
app.include_router(tag_settings.router)
app.include_router(analytics_trend.router)
app.include_router(weighbridge.router)

@app.get("/")
def root():
    return {"msg": "Fabriq backend is running!"}
