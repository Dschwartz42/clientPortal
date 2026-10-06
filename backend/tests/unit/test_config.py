import pytest
from pydantic import ValidationError

from app.config import Settings


def test_short_jwt_secret_fails_validation():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, database_url="postgresql://x", jwt_secret="too-short")


def test_32_char_jwt_secret_is_accepted():
    s = Settings(_env_file=None, database_url="postgresql://x", jwt_secret="x" * 32)
    assert len(s.jwt_secret) == 32
