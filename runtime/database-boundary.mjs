// The API can read global controls, but only the separate operator can update
// existing capability records. No database credentials leave this host check.
const runtimeRole = 'claus_network_runtime_v1';
const controlRole = 'claus_network_controls_v1';
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
  if (!facts || facts.role !== runtimeRole || facts.database !== 'claus_network_v1' ||
      facts.rls !== true || facts.safe_role !== true || facts.safe_privileges !== true ||
      !Array.isArray(policies) || policies.length !== expected.length) unavailable();
  for (const [name, role, command, using, check] of expected) {
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
    (SELECT jsonb_agg(jsonb_build_object('policyname',p.policyname,'permissive',p.permissive,
      'roles',p.roles,'cmd',p.cmd,'qual',p.qual,'with_check',p.with_check))
      FROM pg_policies p WHERE p.schemaname='claus_network' AND p.tablename='documents') AS policies
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.rolname=current_user AND n.nspname='claus_network' AND c.relname='documents'`);
  return validateDatabaseBoundary(rows[0], rows[0]?.policies);
}
