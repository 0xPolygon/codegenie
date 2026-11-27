import { ROLES } from './blind-inputs.mjs';

const severity = { low: 0, medium: 1, high: 2, critical: 3 };
const validHash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
const unique = (items) => new Set(items).size === items.length;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const armResult = () => ({ E1: { published: 0, required: 0 }, E2: { lower: 0, upper: 0, reviews: 0 }, E3: { lower: 0, upper: 0 }, optionalPublished: 0, sentinelHits: 0, classes: {}, classReviews: {}, roles: {}, unscored: [], survivingMediumPlus: { measured: 0, unavailable: 0, classes: {} }, distinctDefects: [] });
const counter = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
export function gatePasses(t, c) {
  if (!t || !c || !Number.isSafeInteger(t.upper) || !Number.isSafeInteger(c.lower) || t.upper < 0 || c.lower < 0) throw new Error('invalid gate bounds');
  return t.upper <= c.lower;
}

// Bundles are authenticated by the caller before entry; every join is checked
// again against the frozen assignment, including the selected receipt hash.
export function scoreCampaign({ schedule, inventory, dispositions, bundles }) {
  check(Array.isArray(schedule) && Array.isArray(inventory) && Array.isArray(dispositions) && Array.isArray(bundles), 'invalid scoring inputs');
  check(unique(schedule.map((s) => s.slotId)) && unique(inventory.map((s) => s.caseId)) && unique(dispositions.map((s) => s.slotId)), 'duplicate scoring identity');
  const cases = new Map(inventory.map((item) => [item.caseId, item]));
  const dispositionsBySlot = new Map(dispositions.map((item) => [item.slotId, item]));
  check(dispositions.length === schedule.length, 'disposition coverage mismatch');
  const sheetsBySlot = new Map();
  for (const [bundleIndex, bundle] of bundles.entries()) {
    const { manifest, mapping, reconciliation, reveal, sheets } = bundle ?? {};
    check(Array.isArray(mapping?.selections) && Array.isArray(manifest?.sheets) && Array.isArray(reconciliation?.grades) && Array.isArray(reveal?.reviews) && Array.isArray(sheets), 'invalid verified scoring bundle');
    check(unique(mapping.selections.map((item) => item.slotId)) && unique(mapping.selections.map((item) => item.id)), 'duplicate bundle selection');
    check(mapping.selections.length === manifest.sheets.length && mapping.selections.length === reconciliation.grades.length && mapping.selections.length === reveal.reviews.length && mapping.selections.length === sheets.length, 'bundle coverage mismatch');
    for (const item of mapping.selections) {
      const assignment = schedule.find((slot) => slot.slotId === item.slotId), disposition = dispositionsBySlot.get(item.slotId);
      const entry = manifest.sheets.find((sheet) => sheet.id === item.id), grade = reconciliation.grades.find((row) => row.id === item.id),
        visible = sheets.find((sheet) => sheet.id === item.id), revealed = reveal.reviews.find((row) => row.id === item.id);
      check(assignment && disposition?.state === 'selected' && disposition.bundleIndex === bundleIndex && !sheetsBySlot.has(item.slotId), 'unexpected or duplicate graded slot');
      check(Number.isSafeInteger(item.attempt) && item.attempt > 0 && validHash(item.receiptSHA256) && disposition.attempt === item.attempt && disposition.receiptSHA256 === item.receiptSHA256 &&
        assignment.caseId === disposition.caseId && assignment.arm === disposition.arm && assignment.draw === disposition.draw &&
        assignment.arm === item.arm && assignment.draw === item.draw && (cases.get(assignment.caseId)?.caseLabel ?? assignment.caseId) === item.caseId && entry && grade && visible && revealed &&
        revealed.arm === item.arm && revealed.draw === item.draw && revealed.case === item.caseId && entry.case === item.caseId && visible.case === item.caseId, 'selected receipt tuple mismatch');
      sheetsBySlot.set(item.slotId, { entry, grade, visible });
    }
  }
  const arms = { control: armResult(), treatment: armResult() }, perDraw = {}, defectSets = { control: new Set(), treatment: new Set() }, drawDefects = {};
  let complete = true;
  for (const slot of schedule) {
    check(['control', 'treatment'].includes(slot.arm) && Number.isSafeInteger(slot.draw) && slot.draw > 0, 'invalid schedule slot');
    const inv = cases.get(slot.caseId), disposition = dispositionsBySlot.get(slot.slotId), a = arms[slot.arm];
    check(inv && ROLES.includes(inv.role) && Array.isArray(inv.causes) && Array.isArray(inv.rejects) && unique(inv.causes.map((c) => c.id)) && unique(inv.rejects.map((r) => typeof r === 'string' ? r : r.id)) && disposition && ['selected', 'failed', 'unrun', 'ungraded'].includes(disposition.state), 'invalid inventory or disposition');
    check(disposition.caseId === slot.caseId && disposition.arm === slot.arm && disposition.draw === slot.draw, 'disposition tuple mismatch');
    const draw = perDraw[slot.draw] ??= { control: armResult(), treatment: armResult() }, targets = [a, draw[slot.arm]];
    const drawSet = (drawDefects[slot.draw] ??= { control: new Set(), treatment: new Set() })[slot.arm];
    for (const dest of targets) counter(dest.roles, inv.role);
    if (disposition.state === 'unrun' || disposition.state === 'ungraded') {
      complete = false; for (const dest of targets) dest.unscored.push({ slotId: slot.slotId, state: disposition.state }); continue;
    }
    const required = inv.role === 'positive' ? inv.causes.filter((cause) => cause.optional === false) : [];
    for (const dest of targets) { dest.E1.required += required.length; if (inv.role === 'negative-control') dest.E2.reviews++; }
    if (disposition.state === 'failed') { for (const dest of targets) dest.unscored.push({ slotId: slot.slotId, state: 'failed' }); continue; }
    const selected = sheetsBySlot.get(slot.slotId); check(selected, 'selected grade missing');
    const { entry, grade, visible } = selected;
    check(JSON.stringify(entry.causes) === JSON.stringify(inv.causes.map(({ id, optional }) => ({ id, optional }))) && (entry.role === undefined || entry.role === inv.role) &&
      JSON.stringify((entry.rejects ?? []).map((x) => x.id)) === JSON.stringify(inv.rejects.map((x) => typeof x === 'string' ? x : x.id)), 'inventory does not match grade');
    const byCause = new Map((grade.causes ?? []).map((item) => [item.causeId, item]));
    check(byCause.size === inv.causes.length && inv.causes.every((cause) => byCause.has(cause.id)), 'grade cause mismatch');
    const publishedCauses = inv.causes.filter((cause) => ['finding', 'summary_only'].includes(byCause.get(cause.id).publication));
    for (const dest of targets) { dest.E1.published += publishedCauses.filter((cause) => !cause.optional && inv.role === 'positive').length; dest.optionalPublished += publishedCauses.filter((cause) => cause.optional).length; }
    const published = [...(visible.published?.findings ?? []), ...(visible.published?.summaryOnly ?? [])];
    const items = new Map(published.map((item) => [item.id, item])); check(items.size === published.length, 'duplicate published id');
    const lower = new Set(), uncertain = new Set(), seenClasses = new Set();
    for (const item of grade.otherClaims?.published ?? []) {
      check(items.has(item.id), 'foreign claim');
      if (item.class === 'introduced_real_defect') { defectSets[slot.arm].add(item.slug); drawSet.add(item.slug); }
      seenClasses.add(item.class);
      for (const dest of targets) counter(dest.classes, `${inv.role}:${item.class}`);
      if ((severity[items.get(item.id).severity] ?? -1) >= 1) { if (item.class === 'wholly_false') lower.add(item.id); if (item.class === 'unresolved') uncertain.add(item.id); }
    }
    for (const assertion of grade.assertions ?? []) {
      const item = items.get(assertion.publishedId); check(item, 'foreign assertion');
      if ((severity[item.severity] ?? -1) >= 1) { if (assertion.status === 'refuted') lower.add(item.id); if (assertion.status === 'unresolved') uncertain.add(item.id); }
    }
    const upper = new Set([...lower, ...uncertain]);
    for (const dest of targets) {
      for (const category of seenClasses) counter(dest.classReviews, `${inv.role}:${category}`);
      dest.E3.lower += lower.size; dest.E3.upper += upper.size;
      if (inv.role === 'negative-control') { dest.E2.lower += Number(lower.size > 0); dest.E2.upper += Number(upper.size > 0); }
      dest.sentinelHits += (grade.rejects ?? []).filter((reject) => reject.publishedIds.length > 0).length;
      if (!Array.isArray(visible.verification)) dest.survivingMediumPlus.unavailable++;
      else { dest.survivingMediumPlus.measured++; for (const item of grade.otherClaims?.survivingMediumPlus ?? []) counter(dest.survivingMediumPlus.classes, item.class); }
    }
  }
  check(sheetsBySlot.size === dispositions.filter((item) => item.state === 'selected').length, 'selected disposition coverage mismatch');
  for (const arm of Object.keys(arms)) arms[arm].distinctDefects = [...defectSets[arm]].sort();
  for (const [draw, values] of Object.entries(perDraw)) for (const arm of Object.keys(arms)) values[arm].distinctDefects = [...(drawDefects[draw]?.[arm] ?? [])].sort();
  return { version: 1, rule: 'clean-control.v2', complete, arms, perDraw };
}
