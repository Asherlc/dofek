-- dofek: deployment-mode=maintenance
-- This journal boundary stops old Recovery readers before ClickHouse migration
-- 0112 removes their Healthspan inputs. No PostgreSQL schema change is needed.
SELECT 1;
