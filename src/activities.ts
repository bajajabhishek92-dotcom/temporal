import { Context, log } from '@temporalio/activity';
import os from 'node:os';

export interface ResearchBrief {
  topic: string;
  bullets: string[];
  sources: string[];
}

/** Identity of the worker process that executed an activity. */
export interface WorkerIdentity {
  step: number;
  hostname: string;
  pid: number;
  taskQueue: string;
  timestamp: string;
  /** Optional label from WORKER_LABEL env — useful when two workers share a host. */
  workerLabel?: string;
}

export interface ReportWorkerIdentityInput {
  step: number;
  /** Simulated work duration so you can kill a worker mid-activity. */
  workMs?: number;
}

export interface AgentSummary {
  topic: string;
  summary: string;
  mode: 'openai' | 'stub';
  model?: string;
}

/**
 * Logs and returns which worker process ran this activity.
 * Run two workers on the same task queue to see different pid/hostname values.
 */
export async function reportWorkerIdentity(
  input: ReportWorkerIdentityInput,
): Promise<WorkerIdentity> {
  const workMs = Math.max(0, input.workMs ?? 2000);
  const info = Context.current().info;
  const workerLabel = process.env.WORKER_LABEL?.trim() || undefined;

  const identity: WorkerIdentity = {
    step: input.step,
    hostname: os.hostname(),
    pid: process.pid,
    taskQueue: info.taskQueue,
    timestamp: new Date().toISOString(),
    workerLabel,
  };

  log.info('Activity running on worker', {
    step: identity.step,
    hostname: identity.hostname,
    pid: identity.pid,
    taskQueue: identity.taskQueue,
    workerLabel,
  });
  console.log(
    `[reportWorkerIdentity] step=${identity.step}` +
      ` host=${identity.hostname} pid=${identity.pid}` +
      ` queue=${identity.taskQueue}` +
      (workerLabel ? ` label=${workerLabel}` : '') +
      ` workMs=${workMs}`,
  );

  if (workMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, workMs));
  }

  // Re-stamp after work so the returned time reflects completion on this process.
  identity.timestamp = new Date().toISOString();
  return identity;
}

/** Simulated research step — durable because Temporal retries the activity on failure. */
export async function researchTopic(topic: string): Promise<ResearchBrief> {
  log.info('Researching topic', { topic });

  const normalized = topic.trim() || 'Temporal durability';
  return {
    topic: normalized,
    bullets: [
      `${normalized}: Temporal workflows survive process restarts by replaying event history.`,
      'Activities run outside the workflow sandbox and should carry retries / timeouts.',
      'Signals and queries let you interact with a running workflow without breaking determinism.',
      'Timers (sleep) are durable — the Worker can go away and the timer still fires.',
    ],
    sources: [
      'https://docs.temporal.io/workflows',
      'https://docs.temporal.io/activities',
      'https://docs.temporal.io/develop/typescript/core-application',
    ],
  };
}

/**
 * Lightweight “agent” summarization activity.
 * Uses OpenAI when OPENAI_API_KEY is set; otherwise returns a deterministic stub.
 */
export async function summarizeFindings(brief: ResearchBrief): Promise<AgentSummary> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

  if (!apiKey) {
    log.info('OPENAI_API_KEY not set — using stub summary');
    return {
      topic: brief.topic,
      mode: 'stub',
      summary: [
        `Stub agent summary for “${brief.topic}”:`,
        ...brief.bullets.map((b) => `• ${b}`),
        '',
        'Set OPENAI_API_KEY to replace this stub with a live model call.',
      ].join('\n'),
    };
  }

  log.info('Calling OpenAI for summary', { model, topic: brief.topic });

  const prompt = [
    `Summarize the following research brief on “${brief.topic}” in 3 short paragraphs for engineers new to Temporal.`,
    '',
    'Bullets:',
    ...brief.bullets.map((b) => `- ${b}`),
    '',
    'Sources:',
    ...brief.sources.map((s) => `- ${s}`),
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'You are a concise technical writer explaining Temporal to colleagues.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error('OpenAI response missing summary content');
  }

  return {
    topic: brief.topic,
    summary,
    mode: 'openai',
    model,
  };
}
