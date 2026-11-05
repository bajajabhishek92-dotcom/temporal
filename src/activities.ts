import { Context, log } from '@temporalio/activity';
import os from 'node:os';
import type {
  AgentDecision,
  ApprovalDecision,
  BranchPath,
  RiskScoreResult,
} from './rules/colleague-showcase';

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
  mode: 'gemini' | 'stub';
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
  const lower = normalized.toLowerCase();

  const bullets = [
    `${normalized}: Temporal workflows survive process restarts by replaying event history.`,
    'Activities run outside the workflow sandbox and should carry retries / timeouts.',
    'Signals and queries let you interact with a running workflow without breaking determinism.',
    'Timers (sleep) are durable — the Worker can go away and the timer still fires.',
  ];

  // Deterministic topic-flavored notes (rules score these; the LLM does not).
  if (/(production|security|pii|billing|migration|compliance|incident)/i.test(lower)) {
    bullets.push(
      `Elevated-care note: “${normalized}” touches production/security/compliance language — treat changes carefully.`,
    );
  }
  if (/(agent|gemini|llm|openai|durable ai|mcp)/i.test(lower)) {
    bullets.push(
      'Agent note: durable agents keep the loop in a Workflow; model/tool I/O runs as Activities on a Worker.',
    );
  }
  if (/(cloud|deploy|customer|sla|scale)/i.test(lower)) {
    bullets.push(
      'Ops note: Cloud task queues + Worker identity matter when demos show handoff across processes.',
    );
  }

  return {
    topic: normalized,
    bullets,
    sources: [
      'https://docs.temporal.io/workflows',
      'https://docs.temporal.io/activities',
      'https://docs.temporal.io/develop/typescript/core-application',
      'https://docs.temporal.io/ai',
    ],
  };
}

/**
 * Lightweight summarization activity (not a full agent loop).
 * Uses Gemini when GEMINI_API_KEY or GOOGLE_API_KEY is set; otherwise a stub.
 */
export async function summarizeFindings(brief: ResearchBrief): Promise<AgentSummary> {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

  if (!apiKey) {
    log.info('GEMINI_API_KEY / GOOGLE_API_KEY not set — using stub summary');
    return {
      topic: brief.topic,
      mode: 'stub',
      summary: [
        `Stub agent summary for “${brief.topic}”:`,
        ...brief.bullets.map((b) => `• ${b}`),
        '',
        'Set GEMINI_API_KEY (or GOOGLE_API_KEY) to replace this stub with a live Gemini call.',
      ].join('\n'),
    };
  }

  log.info('Calling Gemini for summary', { model, topic: brief.topic });

  const prompt = [
    `Summarize the following research brief on “${brief.topic}” in 3 short paragraphs for engineers new to Temporal.`,
    '',
    'Bullets:',
    ...brief.bullets.map((b) => `- ${b}`),
    '',
    'Sources:',
    ...brief.sources.map((s) => `- ${s}`),
  ].join('\n');

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
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
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error('Gemini response missing summary content');
  }

  return {
    topic: brief.topic,
    summary,
    mode: 'gemini',
    model,
  };
}

export interface EscalationInput {
  topic: string;
  risk: RiskScoreResult;
  slaMs: number;
  waitedMs: number;
}

export interface EscalationRecord {
  escalatedAt: string;
  message: string;
  topic: string;
  riskLevel: RiskScoreResult['level'];
}

/** SLA breach while waiting for approval — visible Activity in history. */
export async function escalateApproval(input: EscalationInput): Promise<EscalationRecord> {
  const escalatedAt = new Date().toISOString();
  const message =
    `Escalation: approval SLA ${input.slaMs}ms exceeded for “${input.topic}” ` +
    `(risk=${input.risk.level}). Paging reviewer / continuing to wait until approval timeout.`;
  log.warn(message, {
    topic: input.topic,
    risk: input.risk.level,
    slaMs: input.slaMs,
    waitedMs: input.waitedMs,
  });
  console.log(`[escalateApproval] ${message}`);
  return {
    escalatedAt,
    message,
    topic: input.topic,
    riskLevel: input.risk.level,
  };
}

export interface BranchMarkerInput {
  path: BranchPath;
  reason: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface BranchMarker {
  path: BranchPath;
  reason: string;
  recordedAt: string;
}

/**
 * Marks a skipped / compensation / alternate branch in history so demos
 * show the path Temporal took (not only the happy path).
 */
export async function recordBranchPath(input: BranchMarkerInput): Promise<BranchMarker> {
  const recordedAt = new Date().toISOString();
  log.info('Branch path recorded', {
    path: input.path,
    reason: input.reason,
    detail: input.detail,
  });
  console.log(
    `[recordBranchPath] path=${input.path} reason=${input.reason}` +
      (input.detail ? ` detail=${JSON.stringify(input.detail)}` : ''),
  );
  return { path: input.path, reason: input.reason, recordedAt };
}

export interface ColleagueFinalizeInput {
  topic: string;
  brief: ResearchBrief;
  risk: RiskScoreResult;
  approvalDecision: ApprovalDecision;
  agentDecision: AgentDecision;
  escalated: boolean;
  branchesTaken: BranchPath[];
  workerIdentities: WorkerIdentity[];
  agentOutput?: string;
  rejected: boolean;
  escalation?: EscalationRecord;
}

export interface ColleagueFinalSummary {
  topic: string;
  summary: string;
  mode: 'gemini' | 'stub';
  model?: string;
  ruleDigest: string;
}

/** Final write-up that includes rule decisions + optional Gemini child output. */
export async function summarizeColleagueShowcase(
  input: ColleagueFinalizeInput,
): Promise<ColleagueFinalSummary> {
  const ruleDigest = [
    `risk=${input.risk.level} (score ${input.risk.score})`,
    `approval=${input.approvalDecision}`,
    `agent=${input.agentDecision}`,
    `escalated=${input.escalated}`,
    `rejected=${input.rejected}`,
    `branches=${input.branchesTaken.join(' → ')}`,
  ].join('; ');

  const apiKey =
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';

  const stubBody = [
    `Colleague showcase summary for “${input.topic}”:`,
    '',
    `Rules: ${ruleDigest}`,
    `Risk rationale: ${input.risk.rationale}`,
    '',
    'Research:',
    ...input.brief.bullets.map((b) => `• ${b}`),
    '',
    input.agentOutput
      ? `Gemini child output:\n${input.agentOutput}`
      : 'Gemini child: not run on this path.',
    '',
    input.escalation ? `Escalation: ${input.escalation.message}` : null,
    input.workerIdentities.length
      ? `Workers seen: ${input.workerIdentities
          .map((w) => `pid:${w.pid}@${w.hostname}`)
          .join(', ')}`
      : null,
    '',
    'Set GEMINI_API_KEY on the showcase worker to replace this stub finalize with a live Gemini call.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  if (!apiKey) {
    log.info('GEMINI_API_KEY / GOOGLE_API_KEY not set — stub colleague finalize');
    return {
      topic: input.topic,
      summary: stubBody,
      mode: 'stub',
      ruleDigest,
    };
  }

  log.info('Calling Gemini for colleague finalize', { model, topic: input.topic });

  const prompt = [
    'Write a short colleague-facing wrap-up (3 short paragraphs) for a Temporal demo.',
    'Include what the deterministic rules decided and what (if anything) the durable agent said.',
    'Do not invent approvals or agent output that is not provided.',
    '',
    `Topic: ${input.topic}`,
    `Rule digest: ${ruleDigest}`,
    `Risk rationale: ${input.risk.rationale}`,
    '',
    'Research bullets:',
    ...input.brief.bullets.map((b) => `- ${b}`),
    '',
    'Agent child output:',
    input.agentOutput?.trim() || '(none — agent branch skipped or rejected)',
    '',
    input.escalation ? `Escalation note: ${input.escalation.message}` : 'No escalation.',
  ].join('\n');

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
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
            content:
              'You are a concise technical writer explaining a Temporal colleague demo. Prefer clarity over hype.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error('Gemini response missing summary content');
  }

  return {
    topic: input.topic,
    summary,
    mode: 'gemini',
    model,
    ruleDigest,
  };
}
