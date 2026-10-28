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

/**
 * Short startToClose so killing a worker mid-activity fails over in ~15s
 * (Temporal retries after the attempt times out — no heartbeats in this demo).
 */
const { reportWorkerIdentity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '10s',
    maximumAttempts: 8,
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

export interface WorkerHandoffInput {
  /** How many times to run reportWorkerIdentity (default 5). */
  steps?: number;
  /** Durable sleep between steps, in milliseconds (default 3000). */
  sleepBetweenMs?: number;
  /** Simulated activity work so you can Ctrl-C a worker mid-step (default 2000). */
  workMs?: number;
}

export interface WorkerHandoffResult {
  steps: activities.WorkerIdentity[];
  uniqueWorkers: Array<{ hostname: string; pid: number; workerLabel?: string }>;
}

export type WorkerHandoffPhase = 'running' | 'done';

export interface WorkerHandoffStatus {
  phase: WorkerHandoffPhase;
  completedSteps: number;
  totalSteps: number;
  lastIdentity?: activities.WorkerIdentity;
}

export const getWorkerHandoffStatusQuery =
  defineQuery<WorkerHandoffStatus>('getWorkerHandoffStatus');

/**
 * Multi-step demo: same activity N times with durable sleeps between.
 * With 2+ workers on the task queue you often see different pid/hostname values.
 * Kill a worker mid-run — after the durable timer (or activity timeout + retry),
 * another worker polling the same queue continues the workflow.
 */
export async function workerHandoffWorkflow(
  input: WorkerHandoffInput = {},
): Promise<WorkerHandoffResult> {
  const totalSteps = Math.max(1, Math.min(input.steps ?? 5, 20));
  const sleepBetweenMs = Math.max(0, input.sleepBetweenMs ?? 3000);
  const workMs = input.workMs ?? 2000;

  const steps: activities.WorkerIdentity[] = [];
  let phase: WorkerHandoffPhase = 'running';

  setHandler(getWorkerHandoffStatusQuery, () => ({
    phase,
    completedSteps: steps.length,
    totalSteps,
    lastIdentity: steps[steps.length - 1],
  }));

  for (let step = 1; step <= totalSteps; step++) {
    const identity = await reportWorkerIdentity({ step, workMs });
    steps.push(identity);

    if (step < totalSteps && sleepBetweenMs > 0) {
      // Durable timer — survives worker death; any polling worker resumes after it fires.
      await sleep(sleepBetweenMs);
    }
  }

  phase = 'done';

  const seen = new Map<string, { hostname: string; pid: number; workerLabel?: string }>();
  for (const s of steps) {
    const key = `${s.hostname}:${s.pid}`;
    if (!seen.has(key)) {
      seen.set(key, {
        hostname: s.hostname,
        pid: s.pid,
        workerLabel: s.workerLabel,
      });
    }
  }

  return {
    steps,
    uniqueWorkers: [...seen.values()],
  };
}
