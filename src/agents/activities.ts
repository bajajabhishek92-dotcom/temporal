/**
 * Activity-backed tools for the durable Temporal agent.
 * These run outside the Workflow sandbox (I/O / non-deterministic work).
 */

export interface LookupTemporalConceptInput {
  concept: string;
}

export interface LookupTemporalConceptResult {
  concept: string;
  matched: string;
  summary: string;
  docsUrl: string;
}

const CONCEPTS: Array<{
  keys: string[];
  matched: string;
  summary: string;
  docsUrl: string;
}> = [
  {
    keys: ['workflow', 'workflows'],
    matched: 'Workflow',
    summary:
      'A Workflow is durable, deterministic orchestration code. Temporal records its Event History so it can resume after Worker crashes.',
    docsUrl: 'https://docs.temporal.io/workflows',
  },
  {
    keys: ['activity', 'activities'],
    matched: 'Activity',
    summary:
      'Activities perform non-deterministic work (API calls, LLM calls, DB). They have timeouts and retries; completed attempts are not re-executed on replay.',
    docsUrl: 'https://docs.temporal.io/activities',
  },
  {
    keys: ['worker', 'workers', 'task queue', 'taskqueue'],
    matched: 'Worker / Task Queue',
    summary:
      'Workers poll a Task Queue and execute your Workflow and Activity code. Temporal Cloud stores state and schedules tasks; it does not run your business code.',
    docsUrl: 'https://docs.temporal.io/workers',
  },
  {
    keys: ['agent', 'agents', 'openai agents'],
    matched: 'Durable AI agent',
    summary:
      'With @temporalio/openai-agents, the agent loop runs in a Workflow while each model call (and MCP/sandbox op) runs as a retryable Activity via OpenAIAgentsPlugin. This showcase points the provider at Gemini’s OpenAI-compatible API.',
    docsUrl: 'https://docs.temporal.io/develop/typescript/integrations/openai-agents',
  },
  {
    keys: ['signal', 'query', 'update', 'human', 'approval'],
    matched: 'Signals / Queries / Updates',
    summary:
      'Signals and Updates let external callers interact with a running Workflow; Queries read state without changing it. Common for human-in-the-loop agent steps.',
    docsUrl: 'https://docs.temporal.io/encyclopedia/workflow-message-passing',
  },
];

/** Curated Temporal concept lookup — used as an agent tool via activityAsTool. */
export async function lookupTemporalConcept(
  input: LookupTemporalConceptInput,
): Promise<LookupTemporalConceptResult> {
  const needle = (input.concept ?? '').trim().toLowerCase();
  const hit =
    CONCEPTS.find((c) => c.keys.some((k) => needle.includes(k) || k.includes(needle))) ??
    CONCEPTS[0];

  return {
    concept: input.concept,
    matched: hit.matched,
    summary: hit.summary,
    docsUrl: hit.docsUrl,
  };
}

export interface NamespaceSnapshot {
  namespace: string;
  taskQueue: string;
  agentsUi: string;
  note: string;
}

/** Returns Cloud namespace / queue context for the agent (no secrets). */
export async function getShowcaseNamespaceInfo(
  _input: Record<string, never> = {},
): Promise<NamespaceSnapshot> {
  const namespace =
    process.env.TEMPORAL_NAMESPACE?.trim() || 'quickstart-abhishek-b8746e8b.jftpi';
  const taskQueue = process.env.TEMPORAL_AGENTS_TASK_QUEUE?.trim() || 'showcase-agents';

  return {
    namespace,
    taskQueue,
    agentsUi: `https://cloud.temporal.io/namespaces/${namespace}/agents`,
    note: 'Model provider credentials stay on the Worker; Temporal Cloud stores Workflow history and schedules tasks.',
  };
}
