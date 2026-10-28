import { Client, Connection } from '@temporalio/client';
import { temporalCloudConfig } from './shared';
import { approveSignal, getStatusQuery } from './workflows';

async function run(): Promise<void> {
  const workflowId = process.argv[2];
  if (!workflowId) {
    console.error('Usage: npx tsx src/signal-approve.ts <workflowId>');
    process.exit(1);
  }

  const { namespace, connectionOptions } = temporalCloudConfig();
  const connection = await Connection.connect(connectionOptions);
  const client = new Client({ connection, namespace });
  const handle = client.workflow.getHandle(workflowId);

  const before = await handle.query(getStatusQuery);
  console.log('Status before approve:', before);

  await handle.signal(approveSignal);
  console.log(`Signaled approve on ${workflowId}`);

  const result = await handle.result();
  console.log('\nWorkflow result:');
  console.log(JSON.stringify(result, null, 2));

  await connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
