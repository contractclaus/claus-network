import {readAppReceiptBoundary} from './app-receipt-boundary.mjs';
// The API can read global controls, but only the separate operator can update
// existing capability records. No database credentials leave this host check.
const runtimeRole = 'claus_network_runtime_v1';
const controlRole = 'claus_network_controls_v1';
const recoveryRole = 'claus_recovery_network_v1';
const ordinary = "collection <> ALL (ARRAY['network'::text, 'network-capabilities'::text])";
const controls = "collection = ANY (ARRAY['network'::text, 'network-capabilities'::text])";
const capability = "collection = 'network-capabilities'::text";
const expected = [
  ['network_runtime_read', runtimeRole, 'SELECT', 'true', null],
  ['network_runtime_insert', runtimeRole, 'INSERT', null, ordinary],
  ['network_runtime_update', runtimeRole, 'UPDATE', ordinary, ordinary],
  ['network_controls_read', controlRole, 'SELECT', controls, null],
  ['network_controls_update', controlRole, 'UPDATE', capability, capability]
];
const expression = value => (value ?? '').replace(/[\s()]/g, '');
const unavailable = () => { throw Error('network_database_boundary_unavailable'); };

export function validateDatabaseBoundary(facts, policies) {
  const recovery = Array.isArray(policies) && policies.find(row => row.policyname === 'claus_recovery_read_v1');
  const allowed = recovery ? [...expected, ['claus_recovery_read_v1', recoveryRole, 'SELECT', 'true', null]] : expected;
  if (!facts || facts.role !== runtimeRole || facts.database !== 'claus_network_v1' ||
      facts.rls !== true || facts.safe_role !== true || facts.safe_privileges !== true ||
      (recovery && facts.safe_backup_role !== true) ||
      !Array.isArray(policies) || policies.length !== allowed.length) unavailable();
  for (const [name, role, command, using, check] of allowed) {
    const policy = policies.find(row => row.policyname === name);
    if (!policy || policy.permissive !== 'PERMISSIVE' || policy.cmd !== command ||
        policy.roles?.length !== 1 || policy.roles[0] !== role ||
        expression(policy.qual) !== expression(using) ||
        expression(policy.with_check) !== expression(check)) unavailable();
  }
  return { profile: 'network-controls-v1', verified: true };
}

export async function readDatabaseBoundary(pool) {
  const { rows } = await pool.query(`SELECT current_user AS role, current_database() AS database,
    c.relrowsecurity AS rls,
    NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR c.relowner=r.oid
      OR EXISTS (SELECT 1 FROM pg_auth_members a WHERE a.member=r.oid)) AS safe_role,
    NOT (has_schema_privilege(current_user,'claus_network','CREATE')
      OR has_table_privilege(current_user,'claus_network.documents','DELETE,TRUNCATE,TRIGGER')
      OR has_table_privilege(current_user,'claus_network.events','UPDATE,DELETE,TRUNCATE,TRIGGER')) AS safe_privileges,
    EXISTS (SELECT 1 FROM pg_roles backup WHERE backup.rolname='claus_recovery_network_v1'
      AND NOT (backup.rolsuper OR backup.rolcreaterole OR backup.rolcreatedb OR backup.rolreplication OR backup.rolbypassrls)
      AND backup.oid<>c.relowner
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members a WHERE a.member=backup.oid)
      AND NOT has_schema_privilege(backup.oid,'claus_network','CREATE')
      AND NOT has_table_privilege(backup.oid,'claus_network.documents','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(backup.oid,'claus_network.events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(backup.oid,'claus_network.documents','SELECT')) AS safe_backup_role,
    (SELECT jsonb_agg(jsonb_build_object('policyname',p.policyname,'permissive',p.permissive,
      'roles',p.roles,'cmd',p.cmd,'qual',p.qual,'with_check',p.with_check))
      FROM pg_policies p WHERE p.schemaname='claus_network' AND p.tablename='documents') AS policies
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.rolname=current_user AND n.nspname='claus_network' AND c.relname='documents'`);
  const boundary=validateDatabaseBoundary(rows[0], rows[0]?.policies);
  return {...boundary,receipts:await readAppReceiptBoundary(pool)};
}
