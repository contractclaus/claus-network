ALTER TABLE claus_resource_admin.databases ADD COLUMN IF NOT EXISTS retirement_plan_id text;
ALTER TABLE claus_resource_admin.databases ADD COLUMN IF NOT EXISTS retirement_phase text;
ALTER TABLE claus_resource_admin.databases ADD COLUMN IF NOT EXISTS retirement_frozen_at timestamptz;
ALTER TABLE claus_resource_admin.databases ADD COLUMN IF NOT EXISTS retirement_revision integer NOT NULL DEFAULT 0;
ALTER TABLE claus_resource_admin.databases ADD COLUMN IF NOT EXISTS retirement_proof jsonb;

CREATE OR REPLACE FUNCTION claus_resource_admin.retirement_status(resource_id text, plan_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d claus_resource_admin.databases%ROWTYPE;
BEGIN
 IF resource_id IS NULL OR plan_id IS NULL OR resource_id !~ '^res_[a-f0-9]{24}$' OR plan_id !~ '^ret_[a-f0-9]{24}$' THEN RAISE EXCEPTION 'resource_retirement_identity_invalid'; END IF;
 SELECT * INTO d FROM claus_resource_admin.databases x WHERE x.resource_id=retirement_status.resource_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource_retirement_database_missing'; END IF;
 IF d.retirement_plan_id IS NOT NULL AND d.retirement_plan_id<>plan_id THEN RAISE EXCEPTION 'resource_retirement_different_plan'; END IF;
 RETURN jsonb_build_object('resourceId',d.resource_id,'planId',d.retirement_plan_id,'schema',d.schema_name,'role',d.role_name,'phase',d.retirement_phase,'frozenAt',d.retirement_frozen_at,'fenceRevision',d.retirement_revision,'proof',d.retirement_proof,'credentialRevision',d.credential_revision);
END;
$$;

CREATE OR REPLACE FUNCTION claus_resource_admin.retirement_start(resource_id text, plan_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d claus_resource_admin.databases%ROWTYPE;
BEGIN
 IF resource_id IS NULL OR plan_id IS NULL OR resource_id !~ '^res_[a-f0-9]{24}$' OR plan_id !~ '^ret_[a-f0-9]{24}$' THEN RAISE EXCEPTION 'resource_retirement_identity_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(resource_id,0));
 SELECT * INTO d FROM claus_resource_admin.databases x WHERE x.resource_id=retirement_start.resource_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource_retirement_database_missing'; END IF;
 IF d.retirement_plan_id IS NOT NULL THEN RETURN claus_resource_admin.retirement_status(resource_id,plan_id); END IF;
 IF d.status NOT IN ('active','revoked') OR d.schema_name<>'app_'||substring(resource_id from 5) OR d.role_name<>'claus_app_'||substring(resource_id from 5) THEN RAISE EXCEPTION 'resource_retirement_identity_invalid'; END IF;
 EXECUTE format('ALTER ROLE %I NOLOGIN',d.role_name);
 UPDATE claus_resource_admin.databases x SET status='retiring',retirement_plan_id=plan_id,retirement_phase='draining',credential_revision=credential_revision+1 WHERE x.resource_id=retirement_start.resource_id;
 RETURN claus_resource_admin.retirement_status(resource_id,plan_id);
END;
$$;

CREATE OR REPLACE FUNCTION claus_resource_admin.retirement_drain(resource_id text, plan_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d claus_resource_admin.databases%ROWTYPE; target_oid oid; admin_oid oid; session_pid integer;
BEGIN
 IF resource_id IS NULL OR plan_id IS NULL OR resource_id !~ '^res_[a-f0-9]{24}$' OR plan_id !~ '^ret_[a-f0-9]{24}$' THEN RAISE EXCEPTION 'resource_retirement_identity_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(resource_id,0));
 SELECT * INTO d FROM claus_resource_admin.databases x WHERE x.resource_id=retirement_drain.resource_id FOR UPDATE;
 IF NOT FOUND OR d.retirement_plan_id IS DISTINCT FROM plan_id THEN RAISE EXCEPTION 'resource_retirement_different_plan'; END IF;
 IF d.retirement_phase IN ('retained','removed') THEN RETURN claus_resource_admin.retirement_status(resource_id,plan_id); END IF;
 SELECT oid INTO target_oid FROM pg_roles WHERE rolname=d.role_name AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls;
 SELECT oid INTO admin_oid FROM pg_roles WHERE rolname=current_user;
 IF target_oid IS NULL THEN RAISE EXCEPTION 'resource_retirement_login_fence_changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=target_oid AND member<>admin_oid) THEN RAISE EXCEPTION 'resource_retirement_shared_role_membership'; END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=d.schema_name AND a.privilege_type='CREATE' AND a.grantee NOT IN (target_oid,admin_oid)) THEN RAISE EXCEPTION 'resource_retirement_external_writer'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE n.nspname=d.schema_name AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','USAGE') AND a.grantee NOT IN (target_oid,admin_oid)) THEN RAISE EXCEPTION 'resource_retirement_external_writer'; END IF;
 FOR session_pid IN SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usesysid=target_oid AND pid<>pg_backend_pid() LOOP
  IF NOT pg_terminate_backend(session_pid,5000) THEN RETURN claus_resource_admin.retirement_status(resource_id,plan_id)||jsonb_build_object('reason','session_shutdown_pending'); END IF;
 END LOOP;
 PERFORM pg_stat_clear_snapshot();
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usesysid=target_oid) OR EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database() AND owner=d.role_name) THEN
  RETURN claus_resource_admin.retirement_status(resource_id,plan_id)||jsonb_build_object('reason','original_session_or_prepared_transaction_pending');
 END IF;
 IF d.retirement_phase='draining' THEN
  UPDATE claus_resource_admin.databases x SET retirement_phase='frozen',retirement_frozen_at=clock_timestamp(),retirement_revision=retirement_revision+1 WHERE x.resource_id=retirement_drain.resource_id;
 END IF;
 RETURN claus_resource_admin.retirement_status(resource_id,plan_id);
END;
$$;

CREATE OR REPLACE FUNCTION claus_resource_admin.retirement_finish(resource_id text, plan_id text, disposition text, export_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d claus_resource_admin.databases%ROWTYPE; target_oid oid; tables_sql text; sequence_name text; checked jsonb;
BEGIN
 IF disposition IS NULL OR disposition NOT IN ('retain','discard','database-export') THEN RAISE EXCEPTION 'resource_retirement_disposition_invalid'; END IF;
 checked:=claus_resource_admin.retirement_drain(resource_id,plan_id);
 SELECT * INTO d FROM claus_resource_admin.databases x WHERE x.resource_id=retirement_finish.resource_id FOR UPDATE;
 IF d.retirement_phase IN ('retained','removed') THEN RETURN claus_resource_admin.retirement_status(resource_id,plan_id); END IF;
 IF d.retirement_phase<>'frozen' OR checked ? 'reason' THEN RAISE EXCEPTION 'resource_retirement_database_not_frozen'; END IF;
 IF disposition='database-export' AND (export_proof IS NULL OR export_proof->>'resourceId' IS DISTINCT FROM resource_id OR export_proof->>'planId' IS DISTINCT FROM plan_id OR (export_proof->>'fenceRevision')::integer IS DISTINCT FROM d.retirement_revision OR (export_proof->>'frozenAt')::timestamptz IS DISTINCT FROM d.retirement_frozen_at OR export_proof->>'snapshotAt' IS NULL OR export_proof->>'expiresAt' IS NULL OR (export_proof->>'snapshotAt')::timestamptz<d.retirement_frozen_at OR (export_proof->>'expiresAt')::timestamptz<clock_timestamp()+interval '1 day') THEN RAISE EXCEPTION 'resource_retirement_export_proof_invalid'; END IF;
 IF disposition<>'retain' THEN
  SELECT oid INTO target_oid FROM pg_roles WHERE rolname=d.role_name;
  IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=d.schema_name AND nspowner=target_oid) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=d.schema_name AND (c.relowner<>target_oid OR c.relkind NOT IN ('r','i','S'))) THEN RAISE EXCEPTION 'resource_retirement_schema_has_unsupported_objects'; END IF;
  SELECT string_agg(format('%I.%I',n.nspname,c.relname),',' ORDER BY c.relname) INTO tables_sql FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=d.schema_name AND c.relkind='r';
  IF tables_sql IS NOT NULL THEN EXECUTE 'DROP TABLE '||tables_sql||' RESTRICT'; END IF;
  FOR sequence_name IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=d.schema_name AND c.relkind='S' LOOP EXECUTE format('DROP SEQUENCE %I.%I RESTRICT',d.schema_name,sequence_name); END LOOP;
  EXECUTE format('DROP SCHEMA %I RESTRICT',d.schema_name);
 END IF;
 EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),d.role_name);
 UPDATE claus_resource_admin.databases x SET status='retired',retirement_phase=CASE WHEN disposition='retain' THEN 'retained' ELSE 'removed' END,retirement_proof=export_proof WHERE x.resource_id=retirement_finish.resource_id;
 RETURN claus_resource_admin.retirement_status(resource_id,plan_id);
END;
$$;

REVOKE ALL ON FUNCTION claus_resource_admin.retirement_status(text,text),claus_resource_admin.retirement_start(text,text),claus_resource_admin.retirement_drain(text,text),claus_resource_admin.retirement_finish(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claus_resource_admin.retirement_status(text,text),claus_resource_admin.retirement_start(text,text),claus_resource_admin.retirement_drain(text,text),claus_resource_admin.retirement_finish(text,text,text,jsonb) TO claus_application_provisioner;
