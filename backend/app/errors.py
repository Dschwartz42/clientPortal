import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

HTTP_CODES = {404: "not_found", 405: "method_not_allowed"}


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _envelope(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"error": {"code": code, "message": message}}
    )


async def catch_unexpected(request: Request, call_next):
    """Turn an unexpected exception into the 500 envelope from inside the CORS middleware.

    The catch-all exception handler runs in Starlette's outermost middleware, so its
    response would carry no CORS headers and a browser would report a network error.
    """
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return _envelope(500, "internal_error", "Internal server error")


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _envelope(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        return _envelope(422, "validation_error", f"{location}: {first['msg']}")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTP_CODES.get(exc.status_code, "http_error")
        return _envelope(exc.status_code, code, str(exc.detail))

    @app.exception_handler(DataError)
    async def _data_error(request: Request, exc: DataError) -> JSONResponse:
        # Backstop for values the database rejects that schema validation did not catch.
        logger.warning("Database rejected a value on %s %s", request.method, request.url.path)
        return _envelope(422, "validation_error", "Request contains a value the database rejects")

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        # Route errors are handled by the catch_unexpected middleware; this only covers
        # failures outside it. Generic on purpose: nothing about the failure is revealed to the client.
        return _envelope(500, "internal_error", "Internal server error")
