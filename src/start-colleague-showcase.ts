import { Client, Connection } from '@temporalio/client';
import { AGENTS_TASK_QUEUE, TASK_QUEUE, temporalCloudConfig } from './shared';
import {
  colleagueApproveSignal,
  colleagueGetStatusQuery,
  colleagueShowcaseWorkflow,
  type ColleagueShowcaseInput,
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

/**
 * Preset topics that steer the deterministic risk / agent rules.
 * Rules still score the research brief — presets only pick the topic string.
 */
function topicFromFlags(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (hasFlag('--demo-low')) {
    return 'Temporal timers for beginners';
  }
  if (hasFlag('--demo-medium')) {
    return 'Temporal Cloud deploy and customer SLA runbooks';
  }
  if (hasFlag('--demo-high')) {
    return 'Production security migration with PII billing compliance';
  }
  if (hasFlag('--demo-agent')) {
    return 'Durable Gemini agents and MCP tool calling';
  }
  return (
    process.argv.find((a, i) => i > 1 && !a.startsWith('-')) ??
    'Temporal Cloud durable Gemini agents'
  );
}

function printUsage(): void {
  console.log(`Usage: npm run start-colleague-showcase -- [flags]

Flags:
  --topic <text>           Research topic (drives deterministic risk scoring)
  --demo-low|medium|high   Preset topics for risk demos
  --demo-agent             Preset topic that needs the Gemini child at low/med
  --skip-agent             Force-skip durableTemporalAgent child
  --auto-approve           Send approve after research/rules (for medium/high)
  --wait                   Wait for workflow result (default with --auto-approve /
                           --demo-low, or when approval is not expected)
  --poll                   Query getStatus while waiting
  --approval-timeout-ms N  Total approval wait budget (default 90000)
  --approval-sla-ms N      Escalation SLA inside that budget (default 30000)
  --review-sleep-ms N      Durable sleep after research (default 2000)
  --identity-work-ms N     Worker identity activity work (default 800)
  --agents-queue <name>    Child task queue (default ${AGENTS_TASK_QUEUE})
  --id <workflowId>        Override workflow id
  --help                   Show this help

Examples:
  npm run start-colleague-showcase -- --demo-low --wait
  npm run start-colleague-showcase -- --demo-high --auto-approve --poll
  npm run start-colleague-showcase -- --demo-medium --approval-sla-ms 5000 --approval-timeout-ms 15000
`);
}

async function run(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }

  const { namespace, connectionOptions } = temporalCloudConfig();
  const topic = topicFromFlags(argValue('--topic'));
  const skipAgent = hasFlag('--skip-agent');
  const autoApprove = hasFlag('--auto-approve');
  const poll = hasFlag('--poll');
  const approvalTimeoutMs = parseIntArg('--approval-timeout-ms', 90_000);
  const approvalSlaMs = parseIntArg('--approval-sla-ms', 30_000);
  const reviewSleepMs = parseIntArg('--review-sleep-ms', 2000);
  const identityWorkMs = parseIntArg('--identity-work-ms', 800);
  const agentsTaskQueue = argValue('--agents-queue') ?? AGENTS_TASK_QUEUE;
  const workflowId = argValue('--id') ?? `colleague-showcase-${Date.now()}`;

  // Low-risk demos auto-approve in-workflow; wait by default for those / auto-approve.
  const likelyNeedsSignal =
    !hasFlag('--demo-low') &&
    /(production|security|pii|billing|migration|compliance|incident|cloud|deploy|customer|sla|scale|agent|gemini|llm)/i.test(
      topic,
    );
  const wait =
    hasFlag('--wait') ||
    autoApprove ||
    hasFlag('--demo-low') ||
    !likelyNeedsSignal;

  const input: ColleagueShowcaseInput = {
    topic,
    skipAgent,
    agentsTaskQueue,
    approvalTimeoutMs,
    approvalSlaMs,
    reviewSleepMs,
    identityWorkMs,
  };

  const connection = await Connection.connect(connectionOptions);
  const client = new Client({ connection, namespace });

  console.log(`Starting ${colleagueShowcaseWorkflow.name}`);
  console.log(`  workflowId:     ${workflowId}`);
  console.log(`  parent queue:   ${TASK_QUEUE}`);
  console.log(`  agents queue:   ${agentsTaskQueue}`);
  console.log(`  topic:          ${topic}`);
  console.log(`  skipAgent:      ${skipAgent}`);
  console.log(`  approval SLA:   ${approvalSlaMs}ms / timeout ${approvalTimeoutMs}ms`);
  console.log(
    `  view:           https://cloud.temporal.io/namespaces/${namespace}/workflows/${encodeURIComponent(workflowId)}`,
  );
  console.log(
    '\nRequires BOTH workers: `npm run worker` and `npm run agent-worker` (for Gemini child).\n',
  );

  const handle = await client.workflow.start(colleagueShowcaseWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [input],
  });

  if (autoApprove) {
    // Research + review sleep + rules, then signal.
    const delay = reviewSleepMs + identityWorkMs + 2500;
    await new Promise((r) => setTimeout(r, delay));
    try {
      const status = await handle.query(colleagueGetStatusQuery);
      console.log('Status before approve:', status);
      if (status.requiresApproval && !status.approved && !status.rejected) {
        await handle.signal(colleagueApproveSignal);
        console.log('Sent approve signal');
      } else {
        console.log(
          `Skipping signal (requiresApproval=${status.requiresApproval}, approved=${status.approved}, phase=${status.phase})`,
        );
      }
    } catch (err) {
      console.warn('Auto-approve probe failed (workflow may have finished):', err);
    }
  } else if (likelyNeedsSignal && !hasFlag('--demo-low')) {
    console.log(
      `\nIf risk is medium/high, approve with:\n` +
        `  npx tsx src/signal-approve.ts ${workflowId}\n` +
        `Or re-run with --auto-approve. Use --demo-low for the auto-approve path.\n`,
    );
  }

  if (wait || poll) {
    if (poll) {
      for (;;) {
        let status;
        try {
          status = await handle.query(colleagueGetStatusQuery);
        } catch {
          break;
        }
        console.log(
          `  status: phase=${status.phase}` +
            (status.riskLevel ? ` risk=${status.riskLevel}` : '') +
            (status.approvalDecision ? ` approval=${status.approvalDecision}` : '') +
            (status.agentDecision ? ` agent=${status.agentDecision}` : '') +
            (status.escalated ? ' ESCALATED' : '') +
            (status.rejected ? ' REJECTED' : ''),
        );
        if (status.phase === 'done') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    const result = await handle.result();
    console.log('\nColleague showcase result:');
    console.log(
      JSON.stringify(
        {
          topic: result.topic,
          approved: result.approved,
          rejected: result.rejected,
          risk: result.rules.risk,
          approval: result.rules.approval,
          agent: result.rules.agent,
          escalated: result.rules.escalated,
          branchesTaken: result.rules.branchesTaken,
          workerIdentities: result.workerIdentities.map((w) => ({
            step: w.step,
            pid: w.pid,
            host: w.hostname,
            label: w.workerLabel,
          })),
          agentOutputPreview: result.agentOutput?.slice(0, 400),
          finalSummary: result.finalSummary,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nWorkflow started. Track it with id: ${workflowId}`);
    console.log('Query status anytime; approve with signal-approve when needed.');
  }

  await connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
