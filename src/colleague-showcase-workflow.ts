import {
  condition,
  defineQuery,
  defineSignal,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities';
import {
  buildAgentPrompt,
  buildInitialRules,
  decideAgentGating,
  type AgentDecision,
  type ApprovalDecision,
  type BranchPath,
  type ColleagueRuleSnapshot,
} from './rules/colleague-showcase';

/** Default agents queue — must stay workflow-safe (no process.env). */
export const DEFAULT_AGENTS_TASK_QUEUE = 'showcase-agents';

const {
  researchTopic,
  escalateApproval,
  recordBranchPath,
  summarizeColleagueShowcase,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
  },
});

const { reportWorkerIdentity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '10s',
    maximumAttempts: 8,
  },
});

export interface ColleagueShowcaseInput {
  topic: string;
  /** Force-skip the Gemini child even when rules would run it. */
  skipAgent?: boolean;
  /** Task queue for durableTemporalAgent (default showcase-agents). */
  agentsTaskQueue?: string;
  /** Durable sleep after research, ms (default 2000). */
  reviewSleepMs?: number;
  /** Simulated identity activity work, ms (default 800). */
  identityWorkMs?: number;
  /**
   * Max wait for approve signal after any SLA wait, total budget in ms
   * (default 90_000). Timeout → rejected path.
   */
  approvalTimeoutMs?: number;
  /**
   * SLA while waiting for approval, ms (default 30_000).
   * Breach records an escalation Activity, then continues waiting.
   */
  approvalSlaMs?: number;
}

export type ColleaguePhase =
  | 'identity'
  | 'researching'
  | 'reviewing'
  | 'rules_applied'
  | 'awaiting_approval'
  | 'escalated'
  | 'rejected'
  | 'running_agent'
  | 'agent_skipped'
  | 'compensating'
  | 'finalizing'
  | 'done';

export interface ColleagueShowcaseStatus {
  phase: ColleaguePhase;
  topic: string;
  approved: boolean;
  rejected: boolean;
  escalated: boolean;
  briefReady: boolean;
  riskLevel?: ColleagueRuleSnapshot['risk']['level'];
  riskScore?: number;
  approvalDecision?: ApprovalDecision;
  agentDecision?: AgentDecision;
  requiresApproval?: boolean;
  shouldRunAgent?: boolean;
  childrenStarted: number;
  branchesTaken: BranchPath[];
  summaryPreview?: string;
}

export interface ColleagueShowcaseResult {
  topic: string;
  brief: activities.ResearchBrief;
  rules: ColleagueRuleSnapshot;
  approved: boolean;
  rejected: boolean;
  workerIdentities: activities.WorkerIdentity[];
  branchMarkers: activities.BranchMarker[];
  escalation?: activities.EscalationRecord;
  agentOutput?: string;
  finalSummary: activities.ColleagueFinalSummary;
}

/** Same signal name as the simpler demo — `npx tsx src/signal-approve.ts` works. */
export const colleagueApproveSignal = defineSignal('approve');
export const colleagueGetStatusQuery =
  defineQuery<ColleagueShowcaseStatus>('getStatus');

/**
 * Unified colleague showcase:
 * worker identity → research (+retries) → durable sleep → deterministic rules →
 * approval / SLA escalation / reject → optional Gemini child on showcase-agents →
 * finalize summary with rule decisions + agent output.
 */
export async function colleagueShowcaseWorkflow(
  input: ColleagueShowcaseInput,
): Promise<ColleagueShowcaseResult> {
  const topic = input.topic?.trim() || 'Temporal colleague showcase';
  const skipAgent = Boolean(input.skipAgent);
  const agentsTaskQueue = input.agentsTaskQueue?.trim() || DEFAULT_AGENTS_TASK_QUEUE;
  const reviewSleepMs = Math.max(0, input.reviewSleepMs ?? 2000);
  const identityWorkMs = input.identityWorkMs ?? 800;
  const approvalTimeoutMs = Math.max(5_000, input.approvalTimeoutMs ?? 90_000);
  const approvalSlaMs = Math.min(
    Math.max(1_000, input.approvalSlaMs ?? 30_000),
    approvalTimeoutMs,
  );

  let phase: ColleaguePhase = 'identity';
  let approved = false;
  let rejected = false;
  let brief: activities.ResearchBrief | undefined;
  let rules: ColleagueRuleSnapshot | undefined;
  let escalation: activities.EscalationRecord | undefined;
  let agentOutput: string | undefined;
  let finalSummary: activities.ColleagueFinalSummary | undefined;
  let childrenStarted = 0;

  const workerIdentities: activities.WorkerIdentity[] = [];
  const branchMarkers: activities.BranchMarker[] = [];

  const pushBranch = async (
    path: BranchPath,
    reason: string,
    detail?: Record<string, string | number | boolean | null>,
  ): Promise<void> => {
    if (rules && !rules.branchesTaken.includes(path)) {
      rules.branchesTaken.push(path);
    }
    const marker = await recordBranchPath({ path, reason, detail });
    branchMarkers.push(marker);
  };

  setHandler(colleagueGetStatusQuery, () => ({
    phase,
    topic,
    approved,
    rejected,
    escalated: Boolean(rules?.escalated),
    briefReady: Boolean(brief),
    riskLevel: rules?.risk.level,
    riskScore: rules?.risk.score,
    approvalDecision: rules?.approval.decision,
    agentDecision: rules?.agent.decision,
    requiresApproval: rules?.approval.requiresApproval,
    shouldRunAgent: rules?.agent.shouldRunAgent,
    childrenStarted,
    branchesTaken: rules?.branchesTaken ?? [],
    summaryPreview: finalSummary?.summary?.slice(0, 160),
  }));

  setHandler(colleagueApproveSignal, () => {
    if (!rejected) {
      approved = true;
    }
  });

  // --- 1. Worker identity (handoff demo building block) ---
  workerIdentities.push(
    await reportWorkerIdentity({ step: 1, workMs: identityWorkMs }),
  );

  // --- 2. Research with retries ---
  phase = 'researching';
  brief = await researchTopic(topic);

  // --- 3. Durable review timer ---
  phase = 'reviewing';
  if (reviewSleepMs > 0) {
    await sleep(reviewSleepMs);
  }

  // --- 4. Deterministic business rules (not the LLM) ---
  phase = 'rules_applied';
  rules = buildInitialRules(brief, skipAgent);
  if (!rules.approval.requiresApproval) {
    approved = true;
    await pushBranch('auto_approve', rules.approval.rationale, {
      risk: rules.risk.level,
    });
  }

  // --- 5. Approval + SLA escalation / timeout reject ---
  if (rules.approval.requiresApproval) {
    phase = 'awaiting_approval';
    await pushBranch('await_approval', rules.approval.rationale, {
      slaMs: approvalSlaMs,
      timeoutMs: approvalTimeoutMs,
    });

    const approvedWithinSla = await condition(() => approved, approvalSlaMs);
    if (!approvedWithinSla && !approved) {
      phase = 'escalated';
      rules.escalated = true;
      escalation = await escalateApproval({
        topic,
        risk: rules.risk,
        slaMs: approvalSlaMs,
        waitedMs: approvalSlaMs,
      });
      await pushBranch('escalation', escalation.message, {
        risk: rules.risk.level,
      });

      const remaining = Math.max(0, approvalTimeoutMs - approvalSlaMs);
      const gotApproval = remaining > 0 ? await condition(() => approved, remaining) : false;
      if (!gotApproval && !approved) {
        rejected = true;
        rules.approval = {
          requiresApproval: true,
          decision: 'rejected_timeout',
          rationale: `No approve signal within ${approvalTimeoutMs}ms — taking rejected path.`,
        };
      }
    }
  }

  if (rejected) {
    phase = 'rejected';
    await pushBranch('rejected', rules.approval.rationale, {
      escalated: rules.escalated,
    });

    phase = 'compensating';
    await pushBranch(
      'compensation',
      'Compensation/skip path after approval timeout — no Gemini child, finalize with reject digest.',
      { agent: 'skipped' },
    );

    rules.agent = decideAgentGating({
      risk: rules.risk.level,
      topic: brief.topic,
      skipAgent,
      rejected: true,
      childrenStarted,
    });
  } else {
    if (rules.approval.requiresApproval && approved) {
      rules.approval = {
        requiresApproval: true,
        decision: 'human_approved',
        rationale: rules.escalated
          ? 'Approve signal received after SLA escalation.'
          : 'Approve signal received within SLA.',
      };
    }

    // Recompute agent gate with final approval outcome (max 1 child).
    rules.agent = decideAgentGating({
      risk: rules.risk.level,
      topic: brief.topic,
      skipAgent,
      rejected: false,
      childrenStarted,
    });

    if (rules.agent.shouldRunAgent && childrenStarted < 1) {
      phase = 'running_agent';
      await pushBranch('agent_child', rules.agent.rationale, {
        queue: agentsTaskQueue,
        child: 'durableTemporalAgent',
      });

      const prompt = buildAgentPrompt(brief, rules.risk);
      const childId = `${workflowInfo().workflowId}/gemini-agent`;
      // String name: child is registered on the agent-worker bundle, not this one.
      const childHandle = await startChild('durableTemporalAgent', {
        workflowId: childId,
        taskQueue: agentsTaskQueue,
        args: [prompt],
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
      });
      childrenStarted += 1;
      agentOutput = await childHandle.result();
      rules.agent = {
        shouldRunAgent: true,
        decision: 'run_gemini_child',
        topicNeedsAgent: rules.agent.topicNeedsAgent,
        rationale: `Completed durableTemporalAgent on ${agentsTaskQueue} (max 1 child).`,
      };
    } else {
      phase = 'agent_skipped';
      await pushBranch('agent_skipped', rules.agent.rationale, {
        decision: rules.agent.decision,
      });
    }
  }

  // Closing identity step — shows queue fan-out / same worker continuity.
  workerIdentities.push(
    await reportWorkerIdentity({ step: 2, workMs: Math.min(identityWorkMs, 500) }),
  );

  phase = 'finalizing';
  await pushBranch('finalize', 'Summarize rule decisions + optional agent output', {
    rejected,
    agentRan: Boolean(agentOutput),
  });

  finalSummary = await summarizeColleagueShowcase({
    topic,
    brief,
    risk: rules.risk,
    approvalDecision: rules.approval.decision,
    agentDecision: rules.agent.decision,
    escalated: rules.escalated,
    branchesTaken: rules.branchesTaken,
    workerIdentities,
    agentOutput,
    rejected,
    escalation,
  });

  phase = 'done';

  return {
    topic,
    brief,
    rules,
    approved,
    rejected,
    workerIdentities,
    branchMarkers,
    escalation,
    agentOutput,
    finalSummary,
  };
}
