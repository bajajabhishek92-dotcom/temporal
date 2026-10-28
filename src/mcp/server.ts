import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client, Connection } from '@temporalio/client';
import { z } from 'zod';
import { TASK_QUEUE, temporalCloudConfig } from '../shared';
import {
  agentResearchWorkflow,
  type DemoWorkflowInput,
} from '../workflows';

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { namespace, connectionOptions } = temporalCloudConfig();
  const connection = await Connection.connect(connectionOptions);
  try {
    const client = new Client({ connection, namespace });
    return await fn(client);
  } finally {
    await connection.close();
  }
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * MCP SDK Zod generics can exceed TS recursion limits; register tools via a
 * narrow helper so runtime validation still uses Zod shapes.
 */
function addTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof textResult>>,
): void {
  // Cast keeps tsc away from deep Zod/MCP inference while preserving runtime behavior.
  (server.registerTool as (n: string, c: unknown, h: unknown) => void)(
    name,
    { description, inputSchema },
    handler,
  );
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'temporal-showcase',
    version: '1.0.0',
  });

  addTool(
    server,
    'list_recent_workflows',
    'List recent workflow executions in the Temporal Cloud namespace',
    {
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max executions to return (default 10)'),
      query: z
        .string()
        .optional()
        .describe(
          'Optional Visibility query, e.g. WorkflowType="agentResearchWorkflow"',
        ),
    },
    async (args) => {
      const pageSize = typeof args.pageSize === 'number' ? args.pageSize : 10;
      const query = typeof args.query === 'string' ? args.query : undefined;
      try {
        const items = await withClient(async (client) => {
          const executions = [];
          for await (const exec of client.workflow.list({
            query: query || undefined,
            pageSize,
          })) {
            executions.push({
              workflowId: exec.workflowId,
              runId: exec.runId,
              type: exec.type,
              status: exec.status.name,
              startTime: exec.startTime.toISOString(),
              closeTime: exec.closeTime?.toISOString(),
            });
            if (executions.length >= pageSize) break;
          }
          return executions;
        });
        return textResult({ count: items.length, workflows: items });
      } catch (err) {
        return textResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  addTool(
    server,
    'describe_workflow',
    'Describe a workflow run by workflowId (and optional runId)',
    {
      workflowId: z.string().describe('Workflow ID'),
      runId: z.string().optional().describe('Optional run ID'),
    },
    async (args) => {
      const workflowId = String(args.workflowId ?? '');
      const runId = typeof args.runId === 'string' ? args.runId : undefined;
      try {
        const description = await withClient(async (client) => {
          const handle = client.workflow.getHandle(workflowId, runId);
          const desc = await handle.describe();
          return {
            workflowId: desc.workflowId,
            runId: desc.runId,
            type: desc.type,
            status: desc.status.name,
            taskQueue: desc.taskQueue,
            startTime: desc.startTime.toISOString(),
            closeTime: desc.closeTime?.toISOString(),
            historyLength: desc.historyLength,
            memo: desc.memo,
          };
        });
        return textResult(description);
      } catch (err) {
        return textResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  addTool(
    server,
    'start_demo_workflow',
    'Start the agentResearchWorkflow demo on the showcase task queue',
    {
      topic: z
        .string()
        .optional()
        .describe('Research topic (default: Temporal durable agents)'),
      requireApproval: z
        .boolean()
        .optional()
        .describe('Wait for approve signal before summarizing (default true)'),
      workflowId: z.string().optional().describe('Optional workflow ID override'),
    },
    async (args) => {
      const topic =
        typeof args.topic === 'string' ? args.topic : 'Temporal durable agents';
      const requireApproval =
        typeof args.requireApproval === 'boolean' ? args.requireApproval : true;
      const workflowId =
        typeof args.workflowId === 'string' ? args.workflowId : undefined;
      try {
        const started = await withClient(async (client) => {
          const id = workflowId ?? `agent-research-mcp-${Date.now()}`;
          const input: DemoWorkflowInput = { topic, requireApproval };
          const handle = await client.workflow.start(agentResearchWorkflow, {
            taskQueue: TASK_QUEUE,
            workflowId: id,
            args: [input],
          });
          return {
            workflowId: handle.workflowId,
            runId: handle.firstExecutionRunId,
            taskQueue: TASK_QUEUE,
            input,
            note: requireApproval
              ? 'Workflow will pause for an approve signal after research. Use the CLI signal helper or Temporal UI.'
              : 'Workflow will complete without an approve signal (worker must be running).',
          };
        });
        return textResult(started);
      } catch (err) {
        return textResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  // Validate env early so Cursor logs a clear stderr message.
  temporalCloudConfig();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('temporal-showcase MCP server running on stdio');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
