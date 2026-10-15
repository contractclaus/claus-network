var labDefaults = { enabled: false, publicFeed: false, autonomous: false, paidResearch: false, webSearch: false, developments: false, experiments: false, maxActiveIdeas: 3, maxConcurrentJobs: 1, maxStepsPerIdea: 24, modelReservationMicroUsdc: "3000000", modelDailyBudgetMicroUsdc: "0", modelIdeaBudgetMicroUsdc: "0", imdDailyBudgetAtomic: "0", imdIdeaBudgetAtomic: "0", pollSeconds: 60, socialReserveSeconds: 120 };
function labSettings(value) {
  const v = { ...labDefaults, ...value };
  if (Object.keys(v).some((k) => !(k in labDefaults))) throw Error("lab_unknown_setting");
  for (const key of ["enabled", "publicFeed", "autonomous", "paidResearch", "webSearch", "developments", "experiments"]) if (typeof v[key] !== "boolean") throw Error("lab_invalid_setting");
  for (const [key, min, max] of [["maxActiveIdeas", 1, 10], ["maxConcurrentJobs", 1, 3], ["maxStepsPerIdea", 1, 80], ["pollSeconds", 30, 3600], ["socialReserveSeconds", 60, 900]]) if (!Number.isSafeInteger(v[key]) || v[key] < min || v[key] > max) throw Error("lab_invalid_setting");
  for (const key of ["modelReservationMicroUsdc", "modelDailyBudgetMicroUsdc", "modelIdeaBudgetMicroUsdc", "imdDailyBudgetAtomic", "imdIdeaBudgetAtomic"]) if (typeof v[key] !== "string" || !/^\d{1,24}$/.test(v[key])) throw Error("lab_invalid_budget");
  if (BigInt(v.modelReservationMicroUsdc) > 3000000n || BigInt(v.modelReservationMicroUsdc) < 1n) throw Error("lab_invalid_model_reservation");
  if (v.paidResearch && (!v.enabled || !v.autonomous || BigInt(v.imdDailyBudgetAtomic) === 0n || BigInt(v.imdIdeaBudgetAtomic) === 0n)) throw Error("lab_paid_budget_required");
  return v;
}

import { createHash, timingSafeEqual } from "node:crypto";



var nonempty = (v, max) => typeof v === "string" && !!v.trim() && v.length <= max;
var timestamp = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
function validateKnowledge(value) {
  const v = value;
  if (!v || v.version !== 1 || !Array.isArray(v.topics) || v.topics.length > 64 || JSON.stringify(v).length > 8e4) throw Error("invalid_knowledge");
  const ids = /* @__PURE__ */ new Set();
  for (const t of v.topics) {
    if (!t || !/^[a-z][a-z0-9-]{1,63}$/.test(t.id) || ids.has(t.id) || !nonempty(t.title, 120) || !nonempty(t.summary, 400) || typeof t.body !== "string" || t.body.length > 16e3 || !["current", "historical", "proposed"].includes(t.status) || !["public", "internal"].includes(t.visibility) || !timestamp(t.updatedAt) || t.reviewAfter !== void 0 && !timestamp(t.reviewAfter)) throw Error("invalid_knowledge_topic");
    ids.add(t.id);
    if (t.hookStatus !== void 0 && !["active", "retired"].includes(t.hookStatus)) throw Error("invalid_knowledge_hook_status");
    if (!Array.isArray(t.sources) || !t.sources.length || t.sources.length > 16 || t.sources.some((s) => !s || !["configuration", "publication", "reference", "url"].includes(s.kind) || !nonempty(s.ref, 500))) throw Error("invalid_knowledge_source");
    for (const s of t.sources) {
      if (s.sha256 !== void 0 && (s.kind !== "reference" || !/^[a-f0-9]{64}$/.test(s.sha256))) throw Error("invalid_knowledge_source_hash");
    }
    for (const s of t.sources) if (s.kind === "url") {
      let u;
      try {
        u = new URL(s.ref);
      } catch {
        throw Error("invalid_knowledge_url");
      }
      if (u.protocol !== "https:" || u.username || u.password) throw Error("invalid_knowledge_url");
    }
    if (!Array.isArray(t.relatedRules) || t.relatedRules.some((r) => typeof r !== "string" || !/^[a-z0-9-]{1,64}$/.test(r)) || new Set(t.relatedRules).size !== t.relatedRules.length) throw Error("invalid_knowledge_rule_links");
    if (!Array.isArray(t.hookPaths) || t.hookPaths.some((p) => typeof p !== "string" || !/^\/Hooks\/[A-Za-z]+$/.test(p)) || new Set(t.hookPaths).size !== t.hookPaths.length) throw Error("invalid_knowledge_hook_paths");
    if (!t.body.trim() && !t.relatedRules.length) throw Error("knowledge_topic_has_no_content");
  }
}

function validateBlockedXAccounts(value) {
  if (!Array.isArray(value) || value.length > 1e3) throw Error("invalid_x_blocklist");
  const names = /* @__PURE__ */ new Set();
  for (const account of value) {
    if (!account || typeof account.username !== "string" || !/^[a-z0-9_]{1,15}$/.test(account.username) || names.has(account.username) || account.id !== void 0 && (typeof account.id !== "string" || !/^[1-9][0-9]{0,18}$/.test(account.id))) throw Error("invalid_x_blocklist_account");
    names.add(account.username);
  }
}

var originalPostIntervalMs = 2 * 60 * 60 * 1e3;

function validateConfiguration(value) {
  if (!value || typeof value.identity !== "string" || value.identity.length > 2e4) throw new Error("Invalid identity");
  if (value.knowledge !== void 0) validateKnowledge(value.knowledge);
  if (!Array.isArray(value.policy?.rules) || !value.policy.capabilities) throw new Error("Invalid policy");
  if (Object.values(value.policy.capabilities).some((v) => typeof v !== "boolean")) throw new Error("Invalid capability value");
  const ids = /* @__PURE__ */ new Set();
  for (const rule of value.policy.rules) {
    if (!/^[a-z0-9-]{1,64}$/.test(rule.id) || ids.has(rule.id) || typeof rule.enabled !== "boolean" || typeof rule.text !== "string" || !rule.text.trim()) throw new Error("Invalid or duplicate rule ID");
    ids.add(rule.id);
  }
  const s = value.settings;
  if (s?.club !== void 0 && (!s.club || typeof s.club.enabled !== "boolean" || Object.keys(s.club).some((k) => k !== "enabled"))) throw Error("Invalid Club settings");
  if (s?.builder !== void 0 && (!s.builder || typeof s.builder.enabled !== "boolean" || s.builder.solidityEnabled !== void 0 && typeof s.builder.solidityEnabled !== "boolean" || Object.keys(s.builder).some((k) => !["enabled", "solidityEnabled"].includes(k)))) throw Error("Invalid Builder settings");
  if (s?.siteEditor !== void 0 && (!s.siteEditor || typeof s.siteEditor.enabled !== "boolean" || s.siteEditor.autonomyEnabled !== void 0 && typeof s.siteEditor.autonomyEnabled !== "boolean" || Object.keys(s.siteEditor).some((k) => !["enabled", "autonomyEnabled"].includes(k)))) throw Error("Invalid site editor settings");
  for (const key of ["workspaces", "continuity", "packages", "adaptation", "networkOperations"]) if (s?.[key] !== void 0 && (!s[key] || typeof s[key].enabled !== "boolean" || Object.keys(s[key]).some((k) => k !== "enabled"))) throw Error("Invalid ecosystem settings");
  if (s?.lab !== void 0) labSettings(s.lab);
  if (!s || typeof s.enabled !== "boolean" || typeof s.model !== "string" || !/^gpt-[a-z0-9.-]{1,80}$/.test(s.model) || s.provider !== "openai" || s.xHandle !== "contractclaus") throw new Error("Invalid model or account configuration");
  if (!["low", "medium", "high", "xhigh", "max"].includes(s.reasoningEffort) || !["test", "production"].includes(s.mode) || s.site !== "https://claus.si" || typeof s.initialAgenda !== "string" || s.initialAgenda.length > 12e3) throw new Error("Invalid reasoning or runtime configuration");
  if (!Number.isInteger(s.maxActionsPerTurn) || s.maxActionsPerTurn < 1 || s.maxActionsPerTurn > 24 || !Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 256 || s.maxOutputTokens > 8192) throw new Error("Invalid execution chunk size");
  if (s.priorityXAuthorIds !== void 0 && (!Array.isArray(s.priorityXAuthorIds) || s.priorityXAuthorIds.length > 16 || s.priorityXAuthorIds.some((id) => typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id)) || new Set(s.priorityXAuthorIds).size !== s.priorityXAuthorIds.length)) throw Error("Invalid priority account IDs");
  if (s.blockedXAccounts !== void 0) validateBlockedXAccounts(s.blockedXAccounts);
  if (s.role !== void 0 && s.role !== "twitter") throw Error("Invalid agent role");
  if (s.mode === "test" && (value.policy.capabilities.chainWrite || value.policy.capabilities.externalTransfer)) throw new Error("Production signer is not enabled in this test runtime");
  if (s.role === "twitter" && (!Number.isFinite(Date.parse(s.socialStartedAt ?? "")) || ["chainWrite", "externalTransfer", "sandbox", "publicPublish"].some((k) => value.policy.capabilities[k]))) throw Error("Twitter role cannot hold engineering or wallet capabilities");
}
var digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export {
  digest,
  validateConfiguration
};
