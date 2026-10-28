import { Client, Connection } from '@temporalio/client';
import { TASK_QUEUE, temporalCloudConfig } from './shared';
import {
  getWorkerHandoffStatusQuery,
  workerHandoffWorkflow,
  type WorkerHandoffInput,
} from './workflows';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseIntArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function run(): Promise<void> {
  const { namespace, connectionOptions } = temporalCloudConfig();

  const steps = parseIntArg('--steps', 5);
  const workMs = parseIntArg('--work-ms', 2000);
  const sleepBetweenMs = parseIntArg('--sleep-ms', 3000);
  const poll = hasFlag('--poll');
  const workflowId = argValue('--id') ?? `worker-handoff-${Date.now()}`;

  const connection = await Connection.connect(connectionOptions);
  const client = new Client({ connection, namespace });

  const input: WorkerHandoffInput = { steps, sleepBetweenMs, workMs };

  console.log(`Starting ${workerHandoffWorkflow.name}`);
  console.log(`  workflowId: ${workflowId}`);
  console.log(`  taskQueue:  ${TASK_QUEUE}`);
  console.log(`  steps:      ${steps}`);
  console.log(`  sleepMs:    ${sleepBetweenMs} between steps (durable timer)`);
  console.log(`  workMs:     ${workMs} per activity (kill a worker during this window)`);
  console.log(
    '\nWatch worker terminals for [reportWorkerIdentity] lines (hostname + pid).\n',
  );

  const handle = await client.workflow.start(workerHandoffWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [input],
  });

  if (poll) {
    for (;;) {
      const status = await handle.query(getWorkerHandoffStatusQuery);
      console.log(
        `  progress: ${status.completedSteps}/${status.totalSteps}` +
          (status.lastIdentity
            ? ` last=pid:${status.lastIdentity.pid}@${status.lastIdentity.hostname}`
            : ''),
      );
      if (status.phase === 'done') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const result = await handle.result();

  console.log('\nWorker handoff result:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\nUnique workers that ran activities:');
  for (const w of result.uniqueWorkers) {
    console.log(
      `  - host=${w.hostname} pid=${w.pid}` +
        (w.workerLabel ? ` label=${w.workerLabel}` : ''),
    );
  }
  if (result.uniqueWorkers.length === 1) {
    console.log(
      '\nOnly one worker process was seen. Start a second `npm run worker` (or WORKER_LABEL=B) and re-run.',
    );
  } else {
    console.log(
      `\nSaw ${result.uniqueWorkers.length} distinct worker processes — task queue fan-out worked.`,
    );
  }

  await connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
