import { Client, Connection } from '@temporalio/client';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { OpenAIProvider } from '@openai/agents-openai';
import { AGENTS_TASK_QUEUE, temporalCloudConfig } from '../shared';
import { durableTemporalAgent } from './workflows';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

/**
 * Starts durableTemporalAgent on Temporal Cloud.
 * Client registers OpenAIAgentsPlugin so modelParams reach the Workflow
 * (the Client never calls the model — Worker credentials are what matter).
 */
async function run(): Promise<void> {
  const { namespace, connectionOptions } = temporalCloudConfig();
  // Client plugin needs a ModelProvider instance but does not invoke it.
  const clientApiKey = process.env.OPENAI_API_KEY?.trim() || 'unused-on-client';

  const prompt =
    argValue('--prompt') ??
    process.argv.find((a, i) => i > 1 && !a.startsWith('-')) ??
    'In one short paragraph: how do Temporal Agents relate to Workflows and Workers? Use tools if helpful.';

  const workflowId = argValue('--id') ?? `durable-temporal-agent-${Date.now()}`;

  const connection = await Connection.connect(connectionOptions);
  const client = new Client({
    connection,
    namespace,
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new OpenAIProvider({ apiKey: clientApiKey }),
        modelParams: { useLocalActivity: true },
      }),
    ],
  });

  console.log(`Starting ${durableTemporalAgent.name}`);
  console.log(`  workflowId: ${workflowId}`);
  console.log(`  taskQueue:  ${AGENTS_TASK_QUEUE}`);
  console.log(`  namespace:  ${namespace}`);
  console.log(`  prompt:     ${prompt}`);
  console.log(
    `  view:       https://cloud.temporal.io/namespaces/${namespace}/workflows/${encodeURIComponent(workflowId)}`,
  );
  console.log(
    `  agents UI:  https://cloud.temporal.io/namespaces/${namespace}/agents`,
  );

  const handle = await client.workflow.start(durableTemporalAgent, {
    taskQueue: AGENTS_TASK_QUEUE,
    workflowId,
    args: [prompt],
  });

  const result = await handle.result();
  console.log('\nAgent final output:\n');
  console.log(result);

  await connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
