import {
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  condition,
  sleep,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { researchTopic, summarizeFindings } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
  },
});

export interface DemoWorkflowInput {
  topic: string;
  /** When true, wait for an `approve` signal before summarizing. */
  requireApproval?: boolean;
}

export type DemoPhase = 'researching' | 'awaiting_approval' | 'summarizing' | 'done';

export interface DemoStatus {
  phase: DemoPhase;
  topic: string;
  briefReady: boolean;
  approved: boolean;
  summaryPreview?: string;
}

export interface DemoWorkflowResult {
  topic: string;
  brief: activities.ResearchBrief;
  summary: activities.AgentSummary;
  waitedForApproval: boolean;
}

export const getStatusQuery = defineQuery<DemoStatus>('getStatus');
export const approveSignal = defineSignal('approve');

/**
 * Demo workflow for colleagues:
 * 1. Research activity (with retries)
 * 2. Durable timer / sleep
 * 3. Optional approval signal gate
 * 4. Agent summarize activity (OpenAI or stub)
 * 5. Queryable status throughout
 */
export async function agentResearchWorkflow(
  input: DemoWorkflowInput,
): Promise<DemoWorkflowResult> {
  const topic = input.topic?.trim() || 'Temporal Cloud quickstart';
  const requireApproval = input.requireApproval ?? true;

  let phase: DemoPhase = 'researching';
  let approved = !requireApproval;
  let brief: activities.ResearchBrief | undefined;
  let summary: activities.AgentSummary | undefined;

  setHandler(getStatusQuery, () => ({
    phase,
    topic,
    briefReady: Boolean(brief),
    approved,
    summaryPreview: summary?.summary?.slice(0, 160),
  }));

  setHandler(approveSignal, () => {
    approved = true;
  });

  brief = await researchTopic(topic);

  // Durable timer — survives worker restarts via event history.
  await sleep('3 seconds');

  if (requireApproval) {
    phase = 'awaiting_approval';
    const gotApproval = await condition(() => approved, '10 minutes');
    if (!gotApproval) {
      throw new Error('Timed out waiting for approve signal');
    }
  }

  phase = 'summarizing';
  summary = await summarizeFindings(brief);
  phase = 'done';

  return {
    topic,
    brief,
    summary,
    waitedForApproval: requireApproval,
  };
}
