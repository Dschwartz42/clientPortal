CREATE ROLE portal_owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE portal_app LOGIN PASSWORD 'app_pw';
CREATE DATABASE portal OWNER portal_owner;
CREATE DATABASE portal_test OWNER portal_owner;
\connect portal
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\connect portal_test
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
