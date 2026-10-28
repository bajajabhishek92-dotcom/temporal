import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { TASK_QUEUE, temporalCloudConfig } from './shared';

async function run(): Promise<void> {
  const { namespace, connectionOptions } = temporalCloudConfig();

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
      `Worker polling task queue "${TASK_QUEUE}" on namespace "${namespace}"…`,
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
