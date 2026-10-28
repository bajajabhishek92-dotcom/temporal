import { log } from '@temporalio/activity';

export interface ResearchBrief {
  topic: string;
  bullets: string[];
  sources: string[];
}

export interface AgentSummary {
  topic: string;
  summary: string;
  mode: 'openai' | 'stub';
  model?: string;
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
