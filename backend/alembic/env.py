from logging.config import fileConfig

from sqlalchemy import create_engine, pool

from alembic import context
from app.config import settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# Migrations run as the table owner, not as the API role.
URL = settings.migration_database_url or settings.database_url


def run_migrations_offline() -> None:
    context.configure(url=URL, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(URL, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
