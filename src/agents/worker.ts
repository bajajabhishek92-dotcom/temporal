import os from 'node:os';
import { NativeConnection, Worker } from '@temporalio/worker';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { OpenAIProvider } from '@openai/agents-openai';
import * as activities from './activities';
import { AGENTS_TASK_QUEUE, requireEnv, temporalCloudConfig } from '../shared';

/**
 * Worker for durable OpenAI Agents workflows.
 * Requires OPENAI_API_KEY — model calls run as Activities via OpenAIAgentsPlugin.
 */
async function run(): Promise<void> {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const { namespace, connectionOptions } = temporalCloudConfig();
  const workerLabel = process.env.WORKER_LABEL?.trim();

  const connection = await NativeConnection.connect(connectionOptions);

  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: AGENTS_TASK_QUEUE,
      workflowsPath: require.resolve('./workflows'),
      activities,
      plugins: [
        new OpenAIAgentsPlugin({
          modelProvider: new OpenAIProvider({ apiKey }),
          // Local Activities keep short model calls on the same Worker process.
          modelParams: { useLocalActivity: true },
        }),
      ],
      // Required so the Workflow bundle can resolve OpenAI Agents SDK browser/default conditions.
      bundlerOptions: {
        webpackConfigHook: (config) => ({
          ...config,
          resolve: {
            ...config.resolve,
            conditionNames: ['require', 'browser', 'default'],
          },
        }),
      },
    });

    console.log(
      `Agent worker polling task queue "${AGENTS_TASK_QUEUE}" on namespace "${namespace}"`,
    );
    console.log(
      `  identity: host=${os.hostname()} pid=${process.pid}` +
        (workerLabel ? ` label=${workerLabel}` : ''),
    );
    console.log(
      `  Cloud Agents UI: https://cloud.temporal.io/namespaces/${namespace}/agents`,
    );
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
