import { Client, Connection } from '@temporalio/client';
import { TASK_QUEUE, temporalCloudConfig } from './shared';
import {
  agentResearchWorkflow,
  approveSignal,
  getStatusQuery,
  type DemoWorkflowInput,
} from './workflows';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function run(): Promise<void> {
  const { namespace, connectionOptions } = temporalCloudConfig();
  const topic =
    argValue('--topic') ??
    process.argv.find((a, i) => i > 1 && !a.startsWith('-')) ??
    'Temporal durable agents';
  const requireApproval = !hasFlag('--no-approval');
  const autoApprove = hasFlag('--auto-approve');
  const workflowId =
    argValue('--id') ?? `agent-research-${Date.now()}`;

  const connection = await Connection.connect(connectionOptions);
  const client = new Client({ connection, namespace });

  const input: DemoWorkflowInput = { topic, requireApproval };

  console.log(`Starting ${agentResearchWorkflow.name}`);
  console.log(`  workflowId: ${workflowId}`);
  console.log(`  taskQueue:  ${TASK_QUEUE}`);
  console.log(`  topic:      ${topic}`);
  console.log(`  approval:   ${requireApproval ? 'required (signal: approve)' : 'skipped'}`);

  const handle = await client.workflow.start(agentResearchWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [input],
  });

  if (requireApproval && autoApprove) {
    // Give the worker a moment to hit awaiting_approval, then signal.
    await new Promise((r) => setTimeout(r, 4500));
    const status = await handle.query(getStatusQuery);
    console.log('Status before approve:', status);
    await handle.signal(approveSignal);
    console.log('Sent approve signal');
  } else if (requireApproval) {
    console.log(
      `\nWorkflow is waiting for approval. In another shell:\n` +
        `  npx tsx src/signal-approve.ts ${workflowId}\n` +
        `Or re-run with --auto-approve.`,
    );
  }

  if (!requireApproval || autoApprove) {
    const result = await handle.result();
    console.log('\nWorkflow result:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nWorkflow started. Track it with id: ${workflowId}`);
  }

  await connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
