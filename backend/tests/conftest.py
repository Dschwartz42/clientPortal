import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://portal_app:app_pw@localhost:5432/portal_test"
)
os.environ["MIGRATION_DATABASE_URL"] = os.environ.get(
    "TEST_MIGRATION_DATABASE_URL",
    "postgresql+psycopg://portal_owner:owner_pw@localhost:5432/portal_test",
)
os.environ["JWT_SECRET"] = "test-secret-0123456789-0123456789-0123456789"
