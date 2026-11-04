import { Agent } from '@openai/agents-core';
import { TemporalOpenAIRunner, activityAsTool } from '@temporalio/openai-agents/workflow';
import type * as activities from './activities';

/**
 * First durable Temporal Agent example (Gemini via OpenAI Agents + Temporal).
 *
 * Official pattern:
 * - Agent loop / tool selection runs inside the Workflow (deterministic)
 * - Model calls run as Activities via OpenAIAgentsPlugin on the Worker
 *   (Worker points OpenAIProvider at Gemini’s OpenAI-compatible endpoint)
 * - I/O tools use activityAsTool so they are durable Activities
 *
 * @see https://docs.temporal.io/develop/typescript/integrations/openai-agents
 * @see https://ai.google.dev/gemini-api/docs/openai
 */
export async function durableTemporalAgent(prompt: string): Promise<string> {
  const lookupTool = activityAsTool<typeof activities.lookupTemporalConcept>(
    {
      name: 'lookupTemporalConcept',
      description:
        'Look up a Temporal concept (workflow, activity, worker, agent, signal/query) and return a short summary plus docs URL.',
      parameters: {
        type: 'object',
        properties: {
          concept: {
            type: 'string',
            description: 'Concept or keyword to look up, e.g. "activity retries" or "worker"',
          },
        },
        required: ['concept'],
        additionalProperties: false,
      },
    },
    { startToCloseTimeout: '1 minute' },
  );

  const namespaceTool = activityAsTool<typeof activities.getShowcaseNamespaceInfo>(
    {
      name: 'getShowcaseNamespaceInfo',
      description:
        'Return this showcase’s Temporal Cloud namespace, agents task queue, and Cloud Agents UI URL.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    { startToCloseTimeout: '30 seconds' },
  );

  // Model name must be a string; Worker’s Gemini OpenAIProvider resolves it.
  // Override at runtime with runConfig.model / GEMINI_MODEL on the Worker default path.
  const agent = new Agent({
    name: 'TemporalShowcaseAgent',
    instructions: [
      'You are a concise Temporal Cloud tutor for engineers.',
      'Prefer tools when the user asks what a Temporal concept means or which namespace/UI to open.',
      'Explain that agents are Workflows: the loop is durable; model/tool I/O runs as Activities on Workers you run.',
      'Keep answers short (a few sentences) unless asked for more detail.',
    ].join(' '),
    model: 'gemini-2.5-flash',
    tools: [lookupTool, namespaceTool],
  });

  const result = await new TemporalOpenAIRunner().run(agent, prompt, {
    runConfig: {
      // Keep model as a name string so the Worker provider can resolve Gemini.
      model: 'gemini-2.5-flash',
    },
  });
  return result.finalOutput ?? '';
}
