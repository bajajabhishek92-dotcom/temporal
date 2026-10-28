import os from 'node:os';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { TASK_QUEUE, temporalCloudConfig } from './shared';

async function run(): Promise<void> {
  const { namespace, connectionOptions } = temporalCloudConfig();
  const workerLabel = process.env.WORKER_LABEL?.trim();

  const connection = await NativeConnection.connect(connectionOptions);

  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    console.log(
      `Worker polling task queue "${TASK_QUEUE}" on namespace "${namespace}"`,
    );
    console.log(
      `  identity: host=${os.hostname()} pid=${process.pid}` +
        (workerLabel ? ` label=${workerLabel}` : ''),
    );
    console.log(
      '  tip: start a second worker (optionally WORKER_LABEL=B) to see activity fan-out',
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
