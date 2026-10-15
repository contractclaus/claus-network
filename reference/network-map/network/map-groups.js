// Presentation groups for documented Claus-operated records. Public registration and access are unchanged.
export const CLAUS_RECORDS = new Map(Object.entries({
  "prj_5b2c899a-cc6f-413e-a57f-1176782fc33c": "reference",
  "prj_71f1c06c-b93b-4ec3-acb4-8c303fe854da": "reference",
  "prj_75bf7313-4bbb-4895-82a4-3a6e379af590": "infrastructure",
  "prj_b2deb3cb-9404-425e-9fe2-08a4dc39862e": "reference",
  "prj_775ef2ff-81a6-4821-a18f-2bbbe0fab6a5": "infrastructure",
  "prj_6fa11c38-ca5c-4cde-abe6-84a1a1ab70dd": "infrastructure",
  "prj_db2d70a1-244d-4a51-8373-a52ebb3a22b2": "infrastructure",
  "prj_6a2a275a-abc7-4e29-b91e-4e004ebb58ef": "reference",
  "prj_3258ba94-ce81-4024-813b-db7bc714154d": "infrastructure",
  "prj_106ea172-c8a2-4247-ac79-d07a4084be12": "reference",
  "prj_7250aac3-cc31-4a43-8573-f54045cdfa90": "reference",
  "prj_5d89e95c-f729-446b-a227-78ead03a9877": "reference",
  "prj_686ef53c-093c-496b-8071-43048b2b6b44": "infrastructure",
  "prj_3a061980-cdcc-4e18-8321-9cff96c3f11a": "reference",
  "prj_c7420942-0c99-4555-8ff8-57e904ad13ee": "infrastructure",
  "prj_c58f8e93-01f0-4e56-84e9-d45d0d15b87f": "reference",
  "prj_51fcfa1f-21a6-4d48-927e-a399d4e04f56": "reference",
  "prj_427a980b-7a20-4b12-b60c-658da1bbe9cd": "reference",
  "prj_11317081-09c7-4edc-80f3-81aacaf2dbb5": "reference",
  "prj_816402ac-d7b2-48b9-a410-ae972680cf79": "reference",
  "prj_ec7c71ca-a6ea-4e5b-8362-a16324c132ec": "reference"
}));
// These two published records have not been confirmed as genuine independent projects.
// Presentation hold only: their source records and evidence remain accessible.
export const HOME_PROJECT_HOLDS = new Set([
  'prj_9a3ef782-6519-4962-be62-fa3b5321a269',
  'prj_b552c47b-cdc2-401f-8e2b-fbd14a4f760d',
]);
export function isHomeProject(id) {
  return typeof id === 'string' && !CLAUS_RECORDS.has(id) && !HOME_PROJECT_HOLDS.has(id);
}
export function groupProjects(projects) {
  return {
    projects: projects.filter(p => isHomeProject(p.id)),
    infrastructure: projects.filter(p => CLAUS_RECORDS.get(p.id) === 'infrastructure'),
    reference: projects.filter(p => CLAUS_RECORDS.get(p.id) === 'reference'),
  };
}
export function orbitLayout(count) {
  const slots = [];
  for (let ring = 0; slots.length < count; ring++) {
    const capacity = 12 + ring * 6;
    const n = Math.min(capacity, count - slots.length);
    const radius = 180 + ring * 116;
    for (let i = 0; i < n; i++) {
      const position = ring === 0 ? [0,3,6,9,1,4,7,10,2,5,8,11][i] : i;
      const angle = -Math.PI * .75 + position * Math.PI * 2 / capacity;
      slots.push({x:Math.cos(angle)*radius, y:Math.sin(angle)*radius, size:80});
    }
  }
  return slots;
}

// Keep occupied places stable and reuse the nearest gap after a full registry refresh.
export function assignProjectSlots(ids, previous = new Map()) {
  const active = new Set(ids), next = new Map(), used = new Set();
  for (const [id, slot] of previous) {
    if (!active.has(id) || !Number.isSafeInteger(slot) || slot < 0 || slot >= 20000 || used.has(slot)) continue;
    next.set(id, slot); used.add(slot);
  }
  let free = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    while (used.has(free)) free++;
    next.set(id, free); used.add(free);
  }
  return next;
}
