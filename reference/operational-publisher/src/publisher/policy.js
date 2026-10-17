import { createHash } from "node:crypto";
const OPS_TARGETS = {
  web: { project: "prj_3EPhg3tuhf5oHU9sw2Butj9eRegy", name: "claus", origin: "https://claus.si", probe: "/Network", paths: [/^docs\/[a-z0-9-]+\.(?:html|md)$/, /^assets\/network-[a-z0-9-]+\.(?:css|js)$/] },
  api: { project: "prj_rGom8c2zwC8zztmqsSFPaAJj7fXs", name: "claus-network-api", origin: "https://claus-network-api.vercel.app", probe: "/health", paths: [/^src\/isolated\/network\.json$/, /^src\/application\/main\.js$/] },
  native: { project: "prj_JQEQJQb3Obhgas8Dtx0FIe1Zokah", name: "claus-agent", origin: "https://claus-agent.vercel.app", probe: "/health", paths: [/^src\/isolated\/(?:network|work)\.json$/, /^src\/application\/main\.js$/] }
};
function target(value) {
  if (!Object.hasOwn(OPS_TARGETS, value)) throw Error("operations_target_invalid");
  return OPS_TARGETS[value];
}
const sha = (v) => createHash("sha1").update(v).digest("hex");
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function validateManifest(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2500 || new Set(v.map((f) => f.path)).size !== v.length || v.some((f) => !f || typeof f.path !== "string" || f.path.length > 240 || f.path.startsWith("/") || f.path.split("/").some((p) => p === ".." || p === ".") || !/^[a-f0-9]{40}$/.test(f.sha) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 25e6)) throw Error("operations_manifest_invalid");
}
function validateChanges(scope, changes) {
  const p = target(scope);
  if (!Array.isArray(changes) || !changes.length || changes.length > 8 || new Set(changes.map((x) => x.path)).size !== changes.length) throw Error("operations_changes_invalid");
  for (const c of changes) if (!c || typeof c.path !== "string" || !p.paths.some((r) => r.test(c.path)) || typeof c.before !== "string" || !c.before || typeof c.after !== "string" || c.before === c.after || Buffer.byteLength(c.before) + Buffer.byteLength(c.after) > 4e4) throw Error("operations_path_or_change_denied");
}
function patch(content, c) {
  const at = content.indexOf(c.before);
  if (at < 0 || content.indexOf(c.before, at + c.before.length) >= 0) throw Error("operations_patch_not_unique");
  const result = content.slice(0, at) + c.after + content.slice(at + c.before.length);
  if (Buffer.byteLength(result) > 4e5) throw Error("operations_source_too_large");
  return result;
}
function denyNewAuthority(before, after) {
  const dangerous = [/process\s*\.\s*env/g, /\b(?:eval|Function)\s*\(/g, /\b(?:child_process|node:fs|node:net|node:tls|node:vm|node:module)\b/g, /\b(?:WALLET_SECRET|SIGNER_PRIVATE_KEY|RELEASE_SECRET|OPERATOR_SECRET)\b/g];
  for (const r of dangerous) if ([...after.matchAll(r)].length > [...before.matchAll(r)].length) throw Error("operations_authority_expansion_denied");
}
export {
  OPS_TARGETS,
  denyNewAuthority,
  hash,
  patch,
  sha,
  target,
  validateChanges,
  validateManifest
};
