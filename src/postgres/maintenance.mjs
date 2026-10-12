import { requireThat } from '../shared/index.mjs';

// Run with the migration role. Runtime receives EXECUTE, never table DELETE.
export function maintenanceMigration(schema, runtimeRole) {
  requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(schema) && /^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole), 'invalid_database_identifier');
  return `CREATE OR REPLACE FUNCTION "${schema}".prune_ephemeral() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    DECLARE removed integer;
    BEGIN
      WITH expired AS (
        SELECT collection,id FROM "${schema}".documents
        WHERE collection IN ('auth-challenges','rate-limits')
          AND CASE WHEN body->>'expiresAt' ~ '^[0-9]{1,16}$'
            THEN (body->>'expiresAt')::numeric < extract(epoch FROM clock_timestamp()) * 1000 - 86400000
            ELSE false END
        ORDER BY collection,id LIMIT 2000 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "${schema}".documents d USING expired e WHERE d.collection=e.collection AND d.id=e.id;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END $$;
    REVOKE ALL ON FUNCTION "${schema}".prune_ephemeral() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION "${schema}".prune_ephemeral() TO "${runtimeRole}";
    CREATE INDEX IF NOT EXISTS documents_project_page ON "${schema}".documents (collection,(body->>'projectId'),id);`;
}
