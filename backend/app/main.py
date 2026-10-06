from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.db import engine
from app.errors import catch_unexpected, register_error_handlers
from app.routers import accounts, analytics, audit, auth, transactions, users

app = FastAPI(title="Client Portal API")
# Added before CORS so it sits inside it: later-added middleware is outer in Starlette.
app.add_middleware(BaseHTTPMiddleware, dispatch=catch_unexpected)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)
register_error_handlers(app)
app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(analytics.router)
app.include_router(audit.router)
app.include_router(transactions.router)
app.include_router(users.router)


@app.get("/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(status_code=503, content={"status": "degraded", "db": "error"})
    return {"status": "ok", "db": "ok"}
