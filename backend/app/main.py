#main.py
from fastapi import FastAPI
from .routers import servers, db, tags, polling, analytics, reports, telegram_reports, telegram_channels
from fastapi.middleware.cors import CORSMiddleware
from .routers import report_styles
from .routers import report_templates

app = FastAPI(
    title="FactoryIQ API",
    description="OPC-UA Historian Backend for FactoryIQ",
    version="1.1.0"
)

# Добавлять CORS только после создания app!
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Можно указать ["http://localhost:5173"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(servers.router)
app.include_router(db.router)
app.include_router(tags.router)
app.include_router(polling.router)
app.include_router(analytics.router)
app.include_router(reports.router)
app.include_router(telegram_reports.router)
app.include_router(report_styles.router)
app.include_router(report_templates.router)
app.include_router(telegram_channels.router)

@app.get("/")
def root():
    return {"msg": "FactoryIQ backend is running!"}
