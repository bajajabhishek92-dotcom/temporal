/**
 * Deterministic business rules for colleagueShowcaseWorkflow.
 *
 * These must stay pure (no I/O, Date.now, random, or env) so Temporal
 * workflow replay remains correct. Risk, approval, agent gating, and
 * skip/compensation decisions belong here — not in the LLM.
 */

import type { ResearchBrief } from '../activities';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ApprovalDecision =
  | 'auto_approved_low_risk'
  | 'requires_human_approval'
  | 'human_approved'
  | 'rejected_timeout'
  | 'rejected_explicit';

export type AgentDecision =
  | 'run_gemini_child'
  | 'skip_low_risk'
  | 'skip_flag'
  | 'skip_after_reject'
  | 'skipped_max_one_enforced';

export type BranchPath =
  | 'identity'
  | 'research'
  | 'review_timer'
  | 'auto_approve'
  | 'await_approval'
  | 'escalation'
  | 'rejected'
  | 'agent_child'
  | 'agent_skipped'
  | 'compensation'
  | 'finalize';

/** Topics / phrases that raise risk in the deterministic scorer. */
const HIGH_RISK_TERMS = [
  'production',
  'prod ',
  'security',
  'pii',
  'gdpr',
  'hipaa',
  'billing',
  'payment',
  'migration',
  'delete',
  'destructive',
  'compliance',
  'incident',
];

const MEDIUM_RISK_TERMS = [
  'cloud',
  'deploy',
  'scale',
  'customer',
  'sla',
  'multi-tenant',
  'multitenant',
  'rollup',
  'cost',
];

/** Topics that need the Gemini child even at low risk (product/demo interest). */
const AGENT_TOPIC_TERMS = [
  'agent',
  'agents',
  'gemini',
  'llm',
  'openai',
  'durable ai',
  'tool calling',
  'mcp',
];

export interface RiskScoreResult {
  level: RiskLevel;
  score: number;
  matchedTerms: string[];
  rationale: string;
}

export interface ApprovalPolicyResult {
  requiresApproval: boolean;
  decision: ApprovalDecision;
  rationale: string;
}

export interface AgentGateResult {
  shouldRunAgent: boolean;
  decision: AgentDecision;
  rationale: string;
  topicNeedsAgent: boolean;
}

export interface ColleagueRuleSnapshot {
  risk: RiskScoreResult;
  approval: ApprovalPolicyResult;
  agent: AgentGateResult;
  escalated: boolean;
  branchesTaken: BranchPath[];
}

function haystackFromBrief(brief: ResearchBrief): string {
  return [brief.topic, ...brief.bullets, ...brief.sources].join('\n').toLowerCase();
}

function matchTerms(haystack: string, terms: string[]): string[] {
  const hit: string[] = [];
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) {
      hit.push(term.trim());
    }
  }
  return hit;
}

/**
 * Score research output into low / medium / high.
 * Pure function of the brief text — no LLM.
 */
export function scoreRiskFromResearch(brief: ResearchBrief): RiskScoreResult {
  const haystack = haystackFromBrief(brief);
  const highHits = matchTerms(haystack, HIGH_RISK_TERMS);
  const mediumHits = matchTerms(haystack, MEDIUM_RISK_TERMS);

  let score = 10;
  score += highHits.length * 35;
  score += mediumHits.length * 15;
  // Slight bump for longer briefs (more surface area).
  score += Math.min(20, brief.bullets.length * 3);

  let level: RiskLevel;
  if (score >= 70 || highHits.length >= 2) {
    level = 'high';
  } else if (score >= 40 || highHits.length >= 1 || mediumHits.length >= 2) {
    level = 'medium';
  } else {
    level = 'low';
  }

  const matchedTerms = [...new Set([...highHits, ...mediumHits])];
  const rationale =
    matchedTerms.length === 0
      ? `No elevated risk terms in research; score=${score} → ${level}.`
      : `Matched [${matchedTerms.join(', ')}]; score=${score} → ${level}.`;

  return { level, score, matchedTerms, rationale };
}

/**
 * Approval policy: low risk auto-approves; medium/high need a human signal.
 */
export function decideApprovalPolicy(risk: RiskLevel): ApprovalPolicyResult {
  if (risk === 'low') {
    return {
      requiresApproval: false,
      decision: 'auto_approved_low_risk',
      rationale: 'Low risk research may proceed without a human approve signal.',
    };
  }
  return {
    requiresApproval: true,
    decision: 'requires_human_approval',
    rationale: `${risk} risk requires an approve signal before agent/finalize steps.`,
  };
}

export function topicNeedsAgent(topic: string): boolean {
  const t = topic.toLowerCase();
  return AGENT_TOPIC_TERMS.some((term) => t.includes(term));
}

/**
 * Agent gating: run at most one Gemini child when medium/high OR topic needs agent,
 * unless skipAgent is set. Rejected runs never start the child.
 */
export function decideAgentGating(opts: {
  risk: RiskLevel;
  topic: string;
  skipAgent: boolean;
  rejected: boolean;
  childrenStarted: number;
}): AgentGateResult {
  const needs = topicNeedsAgent(opts.topic);

  if (opts.rejected) {
    return {
      shouldRunAgent: false,
      decision: 'skip_after_reject',
      rationale: 'Approval rejected/timed out — Gemini child is not started.',
      topicNeedsAgent: needs,
    };
  }

  if (opts.skipAgent) {
    return {
      shouldRunAgent: false,
      decision: 'skip_flag',
      rationale: 'Input skipAgent=true — forcing agent branch skip.',
      topicNeedsAgent: needs,
    };
  }

  if (opts.childrenStarted >= 1) {
    return {
      shouldRunAgent: false,
      decision: 'skipped_max_one_enforced',
      rationale: 'Max one Gemini child per parent run (already started).',
      topicNeedsAgent: needs,
    };
  }

  const riskWantsAgent = opts.risk === 'medium' || opts.risk === 'high';
  if (riskWantsAgent || needs) {
    const why = [
      riskWantsAgent ? `risk=${opts.risk}` : null,
      needs ? 'topic needs agent' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    return {
      shouldRunAgent: true,
      decision: 'run_gemini_child',
      rationale: `Start durableTemporalAgent on showcase-agents (${why}).`,
      topicNeedsAgent: needs,
    };
  }

  return {
    shouldRunAgent: false,
    decision: 'skip_low_risk',
    rationale: 'Low risk and topic does not require an agent — skipping Gemini child.',
    topicNeedsAgent: needs,
  };
}

/** Build the initial rule snapshot right after research. */
export function buildInitialRules(
  brief: ResearchBrief,
  skipAgent: boolean,
): ColleagueRuleSnapshot {
  const risk = scoreRiskFromResearch(brief);
  const approval = decideApprovalPolicy(risk.level);
  // Agent decision is provisional until approval outcome is known.
  const agent = decideAgentGating({
    risk: risk.level,
    topic: brief.topic,
    skipAgent,
    rejected: false,
    childrenStarted: 0,
  });

  return {
    risk,
    approval,
    agent,
    escalated: false,
    branchesTaken: ['identity', 'research', 'review_timer'],
  };
}

export function buildAgentPrompt(brief: ResearchBrief, risk: RiskScoreResult): string {
  return [
    `You are advising colleagues on: "${brief.topic}".`,
    `Deterministic risk level: ${risk.level} (score ${risk.score}).`,
    `Risk rationale: ${risk.rationale}`,
    'Research bullets:',
    ...brief.bullets.map((b) => `- ${b}`),
    'Use tools if helpful. Reply in 4-6 sentences covering Temporal mechanics relevant to this topic.',
  ].join('\n');
}
