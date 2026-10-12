// Standalone outcome vs pool contribution: two independent dimensions of an
// experiment, kept apart on purpose.
//
//   Standalone -- did the experiment's own frozen hypothesis/plan show value?
//   Pool       -- does its component add value to a defined pool of components?
//
// Neither is ever derived from the other: a standalone failure is not a pool
// failure, a standalone success is not a pool success, and a pool result never
// rewrites a standalone record. Both arrive from the PulseWorkerV2 registry
// (standalone_evaluations / pool_component / pool_evaluations, migration 0022
// plus the worker's code-defined records); a registry that predates them
// yields "not reported", never a default outcome.
//
// A conclusive pool state (validated / redundant / degrading) is accepted only
// when it cites an APPROVED pool protocol (id + sha256), carries complete
// provenance and evidence, and the recorded state matches what that
// protocol's own decision rule gives on the recorded numbers. Anything else
// is shown as Blocked with the reason, and the claim it made is kept in the
// history. No universal threshold lives here: every number used by the rule
// comes from the protocol.
//
// Pure functions only (no DOM, no network). Returned strings are plain text.

export const STANDALONE_STATUSES = ['NOT_RUN', 'BLOCKED', 'INCOMPLETE', 'EVALUATED'];
export const STANDALONE_OUTCOMES = ['SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE', 'NOT_APPLICABLE'];
export const POOL_STATES = ['NOT_TESTED', 'CANDIDATE', 'VALIDATED_INCREMENTAL_VALUE', 'REDUNDANT', 'DEGRADING', 'INCONCLUSIVE', 'BLOCKED'];
export const CONCLUSIVE_POOL_STATES = new Set(['VALIDATED_INCREMENTAL_VALUE', 'REDUNDANT', 'DEGRADING']);

export const STANDALONE_STATUS_LABEL = { NOT_RUN: 'Not run', BLOCKED: 'Blocked', INCOMPLETE: 'Incomplete', EVALUATED: 'Evaluated', NOT_REPORTED: 'Not reported' };
export const STANDALONE_OUTCOME_LABEL = { SUPPORTED: 'Supported', NOT_SUPPORTED: 'Not supported', INCONCLUSIVE: 'Inconclusive',
  NOT_APPLICABLE: 'Not applicable (no hypothesis test)', NONE: 'No outcome yet' };
export const POOL_STATE_LABEL = {
  NOT_TESTED: 'Not tested', CANDIDATE: 'Candidate — not evidence of value', VALIDATED_INCREMENTAL_VALUE: 'Validated incremental value',
  REDUNDANT: 'Redundant', DEGRADING: 'Degrading', INCONCLUSIVE: 'Inconclusive', BLOCKED: 'Blocked', NOT_REPORTED: 'Not reported',
};

// Approved pool-contribution protocols, keyed by protocol_id. NONE is approved
// today: no frozen pool evaluation plan exists in PulseWorkerV2 or V3, so no
// pool state can be conclusive. An entry is added only with the approved,
// frozen protocol document's sha256 -- never to make a record pass.
// Shape: { sha256, pool_id, pool_version, metric, higher_is_better,
//          min_effect, equivalence_margin, min_sample, ci_level }
export const APPROVED_POOL_PROTOCOLS = Object.freeze({});

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const strOrNull = (v) => (isStr(v) ? v : null);
const refsOf = (v) => (Array.isArray(v) ? v.filter(isStr) : []);

function windowOf(w) {
  if (!isObj(w)) return null;
  return { start_ts: isNum(w.start_ts) ? w.start_ts : null, end_ts: isNum(w.end_ts) ? w.end_ts : null, label: strOrNull(w.label) };
}
const windowValid = (w) => w && isNum(w.start_ts) && isNum(w.end_ts) && w.start_ts < w.end_ts;

function provenanceProblems(r) {
  const p = [];
  if (!isNum(r.recorded_ts)) p.push('recorded_ts missing');
  if (!isStr(r.recorded_by)) p.push('recorded_by missing');
  return p;
}

const byRecorded = (a, b) => (a.recorded_ts - b.recorded_ts) || String(a.record_id).localeCompare(String(b.record_id));

// ---- Standalone ---------------------------------------------------------------

/**
 * One standalone evaluation record, validated. Never reads pool fields.
 * @returns {{ok:true, record:object} | {ok:false, reason:string, raw:any}}
 */
export function normalizeStandaloneRecord(raw) {
  if (!isObj(raw)) return { ok: false, reason: 'record is not an object', raw };
  const problems = provenanceProblems(raw);
  if (!STANDALONE_STATUSES.includes(raw.evaluation_status)) problems.push(`unknown evaluation_status ${JSON.stringify(raw.evaluation_status)}`);
  const outcome = raw.scientific_outcome == null ? null : raw.scientific_outcome;
  if (outcome != null && !STANDALONE_OUTCOMES.includes(outcome)) problems.push(`unknown scientific_outcome ${JSON.stringify(outcome)}`);
  if (raw.evaluation_status === 'EVALUATED') {
    if (outcome == null) problems.push('EVALUATED without a scientific_outcome');
    if (!refsOf(raw.evidence_refs).length) problems.push('EVALUATED without evidence_refs');
    if (!isStr(raw.spec_ref)) problems.push('EVALUATED without spec_ref');
  } else if (outcome != null && outcome !== 'NOT_APPLICABLE') {
    problems.push(`scientific_outcome ${outcome} requires evaluation_status EVALUATED`);
  }
  if (!isStr(raw.reason)) problems.push('reason missing');
  const s = isObj(raw.sample) ? raw.sample : null;
  if (s && s.count != null && !isCount(s.count)) problems.push(`invalid sample count ${JSON.stringify(s.count)}`);
  if (problems.length) return { ok: false, reason: problems.join('; '), raw };
  return {
    ok: true,
    record: {
      record_id: raw.record_id ?? `${raw.recorded_ts}`,
      evaluation_version: strOrNull(raw.evaluation_version),
      spec_ref: strOrNull(raw.spec_ref), spec_sha256: isSha(raw.spec_sha256) ? raw.spec_sha256 : null,
      plan_sha256: isSha(raw.plan_sha256) ? raw.plan_sha256 : null,
      evaluation_status: raw.evaluation_status, scientific_outcome: outcome, reason: raw.reason,
      sample: s ? { count: isCount(s.count) ? s.count : null, required: isCount(s.required) ? s.required : null, meaning: strOrNull(s.meaning) } : null,
      window: windowOf(raw.window), out_of_sample: typeof raw.out_of_sample === 'boolean' ? raw.out_of_sample : null,
      baseline: strOrNull(raw.baseline), metrics: isObj(raw.metrics) ? raw.metrics : null, uncertainty: isObj(raw.uncertainty) ? raw.uncertainty : null,
      checks: Array.isArray(raw.checks) ? raw.checks.filter(isStr) : [],
      limitations: Array.isArray(raw.limitations) ? raw.limitations.filter(isStr) : [],
      evaluator_version: strOrNull(raw.evaluator_version), evidence_refs: refsOf(raw.evidence_refs),
      recorded_ts: raw.recorded_ts, recorded_by: raw.recorded_by, record_source: strOrNull(raw.record_source),
    },
  };
}

/**
 * Standalone dimension of a registry entry: current record + full history.
 * Old payloads (no standalone_evaluations) -> NOT_REPORTED, with the legacy
 * free-text conclusion passed through as text only.
 */
export function standaloneView(entry) {
  const raw = entry && entry.standalone_evaluations;
  if (!Array.isArray(raw)) {
    return { reported: false, status: 'NOT_REPORTED', outcome: 'NONE', current: null, history: [], rejected: [],
      legacy_conclusion: strOrNull(entry && entry.conclusion) };
  }
  const history = [], rejected = [];
  for (const r of raw) { const n = normalizeStandaloneRecord(r); if (n.ok) history.push(n.record); else rejected.push(n); }
  history.sort(byRecorded);
  const current = history.length ? history[history.length - 1] : null;
  return {
    reported: true,
    status: current ? current.evaluation_status : 'NOT_RUN',
    outcome: current && current.scientific_outcome ? current.scientific_outcome : 'NONE',
    current, history, rejected, legacy_conclusion: strOrNull(entry.conclusion),
  };
}

// ---- Pool ---------------------------------------------------------------------

/**
 * The protocol's own decision rule on the recorded numbers.
 * incremental = candidate - baseline, oriented so that > 0 is "better".
 */
export function decideUnderProtocol(protocol, baselineValue, candidateValue, ci) {
  const sign = protocol.higher_is_better ? 1 : -1;
  const diff = (candidateValue - baselineValue) * sign;
  const lo = Math.min(ci.lo * sign, ci.hi * sign), hi = Math.max(ci.lo * sign, ci.hi * sign);
  let state;
  if (lo > protocol.min_effect) state = 'VALIDATED_INCREMENTAL_VALUE';
  else if (hi < -protocol.equivalence_margin) state = 'DEGRADING';
  else if (lo >= -protocol.equivalence_margin && hi <= protocol.min_effect) state = 'REDUNDANT';
  else state = 'INCONCLUSIVE';
  return { state, diff, ci_oriented: { lo, hi } };
}

function protocolProblems(p) {
  const out = [];
  if (!isSha(p.sha256)) out.push('protocol sha256');
  if (!isStr(p.pool_id) || !isStr(p.pool_version)) out.push('protocol pool id/version');
  if (!isStr(p.metric) || typeof p.higher_is_better !== 'boolean') out.push('protocol metric/direction');
  for (const k of ['min_effect', 'equivalence_margin']) if (!isNum(p[k]) || p[k] < 0) out.push(`protocol ${k}`);
  if (!isCount(p.min_sample) || p.min_sample < 1) out.push('protocol min_sample');
  return out;
}

/** Why a conclusive pool claim cannot stand, or [] when it can. */
function conclusiveProblems(r, protocols) {
  const p = [];
  const prot = isObj(r.protocol) ? r.protocol : {};
  const approved = isStr(prot.protocol_id) && Object.prototype.hasOwnProperty.call(protocols, prot.protocol_id) ? protocols[prot.protocol_id] : null;
  if (!approved) { p.push(`protocol ${JSON.stringify(prot.protocol_id ?? null)} is not an approved pool protocol`); return p; }
  const bad = protocolProblems(approved);
  if (bad.length) { p.push(`approved protocol entry is incomplete (${bad.join(', ')})`); return p; }
  if (prot.sha256 !== approved.sha256) p.push('protocol sha256 does not match the approved protocol');
  const pool = isObj(r.pool) ? r.pool : {};
  if (pool.pool_id !== approved.pool_id) p.push(`pool ${JSON.stringify(pool.pool_id ?? null)} is not the protocol's pool`);
  if (pool.version !== approved.pool_version) p.push(`pool version ${JSON.stringify(pool.version ?? null)} is incompatible with protocol pool version ${approved.pool_version}`);
  const w = windowOf(r.window);
  if (!windowValid(w)) p.push('evaluation window missing or invalid');
  if (r.out_of_sample !== true) p.push('not marked out-of-sample');
  const el = isObj(r.eligible) ? r.eligible : {};
  for (const k of ['baseline_n', 'candidate_n', 'overlap_n']) if (!isCount(el[k])) p.push(`invalid ${k} ${JSON.stringify(el[k] ?? null)}`);
  if (isCount(el.overlap_n) && isCount(el.baseline_n) && isCount(el.candidate_n) && el.overlap_n > Math.min(el.baseline_n, el.candidate_n)) p.push('overlap_n exceeds an eligible count');
  if (isCount(el.overlap_n) && el.overlap_n < approved.min_sample) p.push(`overlap_n ${el.overlap_n} below the protocol's min_sample ${approved.min_sample}`);
  if (isCount(el.baseline_n) && isCount(el.candidate_n) && (el.baseline_n !== el.candidate_n || el.overlap_n !== el.baseline_n) && !isStr(el.composition_change)) {
    p.push('eligible observations differ between baseline and candidate pools and the change is not quantified');
  }
  const bm = isObj(r.baseline_metrics) ? r.baseline_metrics[approved.metric] : undefined;
  const cm = isObj(r.candidate_metrics) ? r.candidate_metrics[approved.metric] : undefined;
  if (!isNum(bm) || !isNum(cm)) p.push(`baseline/candidate ${approved.metric} missing`);
  const ci = isObj(r.uncertainty) && isObj(r.uncertainty.ci) ? r.uncertainty.ci : null;
  if (!ci || !isNum(ci.lo) || !isNum(ci.hi) || ci.lo > ci.hi) p.push('uncertainty interval for the incremental difference missing or invalid');
  if (!isSha(r.evidence_sha256)) p.push('evidence_sha256 missing');
  if (!refsOf(r.evidence_refs).length) p.push('evidence_refs missing');
  if (!isStr(r.evaluator_version)) p.push('evaluator_version missing');
  if (p.length) return p;
  if (isObj(r.incremental) && isNum(r.incremental[approved.metric])) {
    const want = cm - bm;
    if (Math.abs(r.incremental[approved.metric] - want) > 1e-9 * Math.max(1, Math.abs(want))) p.push('recorded incremental difference does not equal candidate − baseline');
  }
  // The CI must contain the point difference it is the interval for.
  if (!(ci.lo <= cm - bm && cm - bm <= ci.hi)) p.push('uncertainty interval does not contain the incremental difference');
  if (p.length) return p;
  const d = decideUnderProtocol(approved, bm, cm, ci);
  if (d.state !== r.pool_state) p.push(`recorded ${r.pool_state} but the protocol's rule gives ${d.state}`);
  return p;
}

/**
 * Validates one pool evaluation record. A record that fails is returned as an
 * explicit BLOCKED entry that keeps the claim it tried to make.
 */
export function normalizePoolRecord(raw, protocols = APPROVED_POOL_PROTOCOLS) {
  if (!isObj(raw)) return { ok: false, reason: 'record is not an object', raw };
  const prov = provenanceProblems(raw);
  if (prov.length) return { ok: false, reason: `missing provenance: ${prov.join(', ')}`, raw };
  const base = {
    record_id: raw.record_id ?? `${raw.recorded_ts}`,
    reason: strOrNull(raw.reason),
    pool: isObj(raw.pool) ? { pool_id: strOrNull(raw.pool.pool_id), version: strOrNull(raw.pool.version) } : null,
    protocol: isObj(raw.protocol) ? { protocol_id: strOrNull(raw.protocol.protocol_id), sha256: isSha(raw.protocol.sha256) ? raw.protocol.sha256 : null } : null,
    evaluator_version: strOrNull(raw.evaluator_version), window: windowOf(raw.window),
    out_of_sample: typeof raw.out_of_sample === 'boolean' ? raw.out_of_sample : null,
    eligible: isObj(raw.eligible) ? raw.eligible : null,
    baseline_metrics: isObj(raw.baseline_metrics) ? raw.baseline_metrics : null,
    candidate_metrics: isObj(raw.candidate_metrics) ? raw.candidate_metrics : null,
    incremental: isObj(raw.incremental) ? raw.incremental : null,
    uncertainty: isObj(raw.uncertainty) ? raw.uncertainty : null,
    evidence_refs: refsOf(raw.evidence_refs), evidence_sha256: isSha(raw.evidence_sha256) ? raw.evidence_sha256 : null,
    recorded_ts: raw.recorded_ts, recorded_by: raw.recorded_by, record_source: strOrNull(raw.record_source),
    claimed_state: null,
  };
  if (!POOL_STATES.includes(raw.pool_state)) {
    return { ok: true, record: { ...base, pool_state: 'BLOCKED', claimed_state: String(raw.pool_state ?? 'null'),
      reason: `Rejected: unknown pool state ${JSON.stringify(raw.pool_state ?? null)}.` } };
  }
  if (!isStr(raw.reason)) {
    return { ok: true, record: { ...base, pool_state: 'BLOCKED', claimed_state: raw.pool_state, reason: 'Rejected: record gives no reason.' } };
  }
  if (CONCLUSIVE_POOL_STATES.has(raw.pool_state)) {
    const p = conclusiveProblems(raw, protocols);
    if (p.length) return { ok: true, record: { ...base, pool_state: 'BLOCKED', claimed_state: raw.pool_state, reason: `Rejected ${POOL_STATE_LABEL[raw.pool_state]} claim: ${p.join('; ')}.` } };
  }
  return { ok: true, record: { ...base, pool_state: raw.pool_state } };
}

/**
 * Pool dimension of a registry entry. Never reads standalone fields.
 * Old payloads (no pool_evaluations) -> NOT_REPORTED.
 */
export function poolView(entry, protocols = APPROVED_POOL_PROTOCOLS) {
  const comp = entry && isObj(entry.pool_component) ? entry.pool_component : null;
  const component = comp ? { component_id: strOrNull(comp.component_id), provenance: strOrNull(comp.provenance), description: strOrNull(comp.description) } : null;
  const raw = entry && entry.pool_evaluations;
  if (!Array.isArray(raw)) return { reported: false, state: 'NOT_REPORTED', current: null, history: [], rejected: [], component, eligibility: eligibilityText('NOT_REPORTED') };
  const history = [], rejected = [];
  for (const r of raw) { const n = normalizePoolRecord(r, protocols); if (n.ok) history.push(n.record); else rejected.push(n); }
  history.sort(byRecorded);
  const current = history.length ? history[history.length - 1] : null;
  const state = current ? current.pool_state : 'NOT_TESTED';
  return { reported: true, state, current, history, rejected, component, eligibility: eligibilityText(state) };
}

/** "Eligible for pool testing?" -- a designation, stated as such. */
export function eligibilityText(state) {
  switch (state) {
    case 'CANDIDATE': return 'Eligible for a future pool test (designation only — not evidence of value)';
    case 'BLOCKED': return 'Not testable now — see reason';
    case 'NOT_TESTED': return 'Not designated for a pool test';
    case 'INCONCLUSIVE': return 'Tested — evidence inadequate; may be re-tested under the protocol';
    case 'NOT_REPORTED': return 'Not reported by the registry';
    default: return 'Tested under an approved protocol';
  }
}

/**
 * Registry-wide pool summary for the Overview. Candidates are counted apart
 * from validated contributors and are never added to them.
 */
export function summarizePool(experiments, protocols = APPROVED_POOL_PROTOCOLS) {
  const counts = Object.fromEntries([...POOL_STATES, 'NOT_REPORTED'].map(s => [s, 0]));
  const byState = Object.fromEntries([...POOL_STATES, 'NOT_REPORTED'].map(s => [s, []]));
  let rejected = 0;
  for (const e of experiments || []) {
    const v = poolView(e, protocols);
    counts[v.state] += 1; byState[v.state].push(e.experiment_id);
    rejected += v.rejected.length + v.history.filter(h => h.claimed_state).length;
  }
  return { counts, byState, rejected, approvedProtocols: Object.keys(protocols).length, reported: (experiments || []).some(e => Array.isArray(e && e.pool_evaluations)) };
}
