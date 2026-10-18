CREATE OR REPLACE FUNCTION claus_resource_admin.provision(resource_id text, secret_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE schema_id text; role_id text; existing claus_resource_admin.databases%ROWTYPE;
BEGIN
 IF resource_id !~ '^res_[a-f0-9]{24}$' OR secret_password !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'invalid_resource'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(resource_id,0));
 SELECT * INTO existing FROM claus_resource_admin.databases d WHERE d.resource_id=provision.resource_id;
 IF FOUND THEN RETURN jsonb_build_object('schema',existing.schema_name,'role',existing.role_name,'database',current_database()); END IF;
 schema_id := 'app_' || substring(resource_id from 5);
 role_id := 'claus_' || schema_id;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_id) OR EXISTS(SELECT FROM pg_namespace WHERE nspname=schema_id) THEN RAISE EXCEPTION 'resource_name_conflict'; END IF;
 EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD %L',role_id,secret_password);
 EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE',role_id,current_user);
 EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I',schema_id,role_id);
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),role_id);
 EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path TO %I, extensions',role_id,current_database(),schema_id);
 EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout TO %L',role_id,current_database(),'30s');
 EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout TO %L',role_id,current_database(),'30s');
 EXECUTE format('CREATE TABLE %I._claus_migrations(id text PRIMARY KEY,source_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())',schema_id);
 EXECUTE format('ALTER TABLE %I._claus_migrations OWNER TO %I',schema_id,role_id);
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='claus_recovery_applications_v1' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls) THEN RAISE EXCEPTION 'backup_reader_unavailable'; END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO claus_recovery_applications_v1',schema_id);
 EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO claus_recovery_applications_v1',schema_id);
 EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO claus_recovery_applications_v1',role_id,schema_id);
 EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON SEQUENCES TO claus_recovery_applications_v1',role_id,schema_id);
 EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET FALSE',role_id,current_user);
 INSERT INTO claus_resource_admin.databases(resource_id,schema_name,role_name) VALUES(resource_id,schema_id,role_id);
 RETURN jsonb_build_object('schema',schema_id,'role',role_id,'database',current_database());
END;
$$;
