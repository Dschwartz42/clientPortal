from fastapi.testclient import TestClient

from app import main
from app.main import app


def test_health_ok():
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "db": "ok"}


def test_health_reports_db_failure(monkeypatch):
    class Broken:
        def connect(self):
            raise RuntimeError("db down")

    monkeypatch.setattr(main, "engine", Broken())
    r = TestClient(app).get("/health")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "db": "error"}
