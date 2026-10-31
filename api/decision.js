// Experiment decision state (PulseWorkerV2 /api/research-lab/registry `decision`, decision-state-v1).
// Formatting only: the state, owner decision, proposal and production use all come from the backend, so
// V2 and V3 show the same thing. Nothing is derived here, and a missing `decision` stays "not reported".

export const DECISION_BADGE = {
  COLLECTING: 'status-neutral', READY_FOR_EVALUATION: 'status-neutral', BLOCKED: 'status-error',
  EVALUATED_DECISION_PENDING: 'status-warning', REJECTED: 'status-error', IMPLEMENTED_RESEARCH_ONLY: 'status-neutral',
  IMPLEMENTED_PRODUCTION: 'status-ok', PROPOSED: 'status-neutral', STAGING_ONLY: 'status-neutral', ON_DEMAND: 'status-neutral',
};
const DECIDED = new Set(['REJECTED', 'IMPLEMENTED_RESEARCH_ONLY', 'IMPLEMENTED_PRODUCTION']);

/**
 * View model of an entry's decision. `reported: false` when the backend did not send one.
 * A proposal never sets `decided`, and production use is shown separately from the state.
 */
export function decisionView(entry) {
  const d = entry && entry.decision;
  if (!d || typeof d !== 'object' || !d.state) {
    return { reported: false, label: 'Decision: not reported by API', badge: 'status-neutral', decided: false,
      basis: 'The registry predates decision-state-v1. Nothing is inferred.', owner: null, proposal: null, production: null };
  }
  const decided = DECIDED.has(d.state) && !!d.owner_decided;
  const owner = d.owner_decision
    ? `${d.owner_decision.decision}${d.owner_decision.decided_ts ? ' on ' + new Date(d.owner_decision.decided_ts).toISOString().slice(0, 10) : ''}${d.owner_decision.decided_by ? ' by ' + d.owner_decision.decided_by : ''}${d.owner_decision.rationale ? ': ' + d.owner_decision.rationale : ''}`
    : (d.owner_decided ? 'Recorded by registry status.' : 'None recorded: pending with the owner.');
  const proposal = d.proposal
    ? { text: `Proposed ${d.proposal.proposal} (not a decision)`, basis: d.proposal.basis || '', ref: d.proposal.evidence_ref || null }
    : null;
  const production = d.production_use
    ? { text: d.production_use.decision_recorded ? 'Used in production' : 'Used in production, no decision recorded',
        where: d.production_use.where || '', since: d.production_use.since || null, note: d.production_use.note || null,
        warn: !d.production_use.decision_recorded }
    : null;
  return {
    reported: true, state: d.state, label: d.label || d.state, badge: DECISION_BADGE[d.state] || 'status-neutral',
    decided, basis: d.basis || '', owner, proposal, production,
    scope: d.state === 'IMPLEMENTED_PRODUCTION' ? 'Production (owner decision)' : production ? 'Research, with production use outside the registry' : 'Research only',
    model: d.model_version || null,
  };
}
