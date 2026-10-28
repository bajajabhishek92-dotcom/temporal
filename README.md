# Temporal Cloud Showcase

A small TypeScript demo for colleagues covering:

- Temporal Cloud workflows & workers
- A **worker handoff / identity** demo (hostname + PID per activity, kill & resume)
- Activities with retries
- Durable timers (`sleep`)
- Signals & queries
- A lightweight durable “agent” activity (OpenAI or stub)
- An MCP server (stdio) that lists / describes / starts demo workflows

**Target namespace:** `quickstart-abhishek-b8746e8b.jftpi`

## Prerequisites

- Node.js 20+
- A Temporal Cloud API key for the namespace above
- The API-key gRPC endpoint for your region (Cloud UI → Namespace → Endpoints), e.g. `us-west-2.aws.api.temporal.io:7233`

## Setup

```bash
cp .env.example .env
# edit .env — set TEMPORAL_ADDRESS and TEMPORAL_API_KEY
npm install
```

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | yes | Cloud API-key endpoint, e.g. `us-west-2.aws.api.temporal.io:7233` |
| `TEMPORAL_NAMESPACE` | yes | Default in `.env.example`: `quickstart-abhishek-b8746e8b.jftpi` |
| `TEMPORAL_API_KEY` | yes | Temporal Cloud API key |
| `TEMPORAL_TASK_QUEUE` | no | Defaults to `showcase` |
| `OPENAI_API_KEY` | no | If unset, the summarize activity returns a deterministic stub |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini` |

Do not commit `.env` or secrets.

## Run the worker

In one terminal (must stay running while you start workflows):

```bash
npm run worker
```

This polls the `showcase` task queue on Temporal Cloud.

## Start the demo workflow

In another terminal:

```bash
# Starts workflow, waits for approve signal (default)
npm run start-workflow -- --topic "Temporal retries"

# Start and auto-approve after the research + sleep step
npm run start-workflow -- --topic "Durable agents" --auto-approve

# Skip the approval gate entirely
npm run start-workflow -- --topic "Quick path" --no-approval
```

If you started without `--auto-approve` / `--no-approval`, approve from another shell:

```bash
npx tsx src/signal-approve.ts <workflowId>
```

### What the demo shows

`agentResearchWorkflow`:

1. **`researchTopic` activity** — simulated research with Temporal retries
2. **`sleep('3 seconds')`** — durable timer
3. **`approve` signal** (optional) — gate before summarization; **`getStatus` query** while running
4. **`summarizeFindings` activity** — stub agent summary, or OpenAI when `OPENAI_API_KEY` is set

## MCP server (Cursor)

The stdio MCP server exposes:

| Tool | Purpose |
| --- | --- |
| `list_recent_workflows` | List recent executions in the Cloud namespace |
| `describe_workflow` | Describe a run by `workflowId` (+ optional `runId`) |
| `start_demo_workflow` | Start `agentResearchWorkflow` on `showcase` |

Run manually:

```bash
npm run mcp
```

### Wire into Cursor

Add to your Cursor MCP settings (User or Project). Point `cwd` / `args` at this repo and load the same env vars:

```json
{
  "mcpServers": {
    "temporal-showcase": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/temporal",
      "env": {
        "TEMPORAL_ADDRESS": "us-west-2.aws.api.temporal.io:7233",
        "TEMPORAL_NAMESPACE": "quickstart-abhishek-b8746e8b.jftpi",
        "TEMPORAL_API_KEY": "<your-api-key>",
        "TEMPORAL_TASK_QUEUE": "showcase"
      }
    }
  }
}
```

Keep a worker running (`npm run worker`) so started workflows can execute.

## Demo: how workers work

This demo makes the **task queue** tangible: activities report which worker process
ran them (`hostname`, `pid`, `taskQueue`, timestamp). The same worker binary polls
`TEMPORAL_TASK_QUEUE` (default `showcase`) for both demos.

### What Temporal is doing (honest semantics)

- Workers **poll** a named task queue. Any idle worker on that queue can take the next
  workflow task or activity task — there is no sticky “this workflow always runs here”
  for activities.
- **`sleep` in a workflow is a durable timer.** If you kill every worker during a sleep,
  the timer still fires on the server; when a worker comes back, it continues the
  workflow from history (replay), then schedules the next activity.
- **If you kill a worker mid-activity**, that attempt fails when the activity’s
  `startToCloseTimeout` elapses (~15s in this demo). Temporal then **retries** the
  activity on another (or the same) polling worker. Failover is not instant without
  heartbeats — this demo keeps timeouts short so the wait is visible but short.
- Running **two workers** on the same queue usually shows **different PIDs** across
  steps (fan-out). Same host is fine; use `WORKER_LABEL=A` / `WORKER_LABEL=B` to label
  terminals.

### A — Two workers, activity fan-out

Terminal 1:

```bash
WORKER_LABEL=A npm run worker
```

Terminal 2:

```bash
WORKER_LABEL=B npm run worker
```

Terminal 3:

```bash
npm run start-worker-demo -- --steps 5 --poll
```

Each step runs `reportWorkerIdentity` (~2s of simulated work) then a durable
`sleep(3000)`. The client prints `uniqueWorkers` — you should often see both
A and B PIDs. Watch the `[reportWorkerIdentity]` lines in the worker terminals.

### B — Kill a worker mid-run (handoff)

1. Start **only worker A**: `WORKER_LABEL=A npm run worker`
2. Start the demo with longer steps so you have time to act:

   ```bash
   npm run start-worker-demo -- --steps 5 --work-ms 5000 --sleep-ms 4000 --poll
   ```

3. After step 1 or 2 prints in A’s terminal, **Ctrl-C worker A** while either:
   - an activity is still “working” (`work-ms` window), or
   - between steps (during the durable sleep).
4. Start **worker B**: `WORKER_LABEL=B npm run worker`
5. Observe:
   - If you killed during **sleep**, B typically continues soon after the timer fires.
   - If you killed mid-**activity**, expect a wait up to the activity
     `startToCloseTimeout` (~15s), then a **retry** on B (same step number, new pid).
6. The workflow result lists every successful attempt’s identity; `uniqueWorkers`
   should include B after the handoff.

Optional flags for `npm run start-worker-demo`:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--steps N` | `5` | How many identity activities to run |
| `--work-ms N` | `2000` | Simulated work inside each activity |
| `--sleep-ms N` | `3000` | Durable workflow sleep between steps (ms) |
| `--poll` | off | Print query progress while waiting |
| `--id <workflowId>` | auto | Override workflow id |

## Project layout

```
src/
  activities.ts         # research + summarize + reportWorkerIdentity
  workflows.ts          # agentResearchWorkflow + workerHandoffWorkflow
  worker.ts             # polls TEMPORAL_TASK_QUEUE (logs host/pid/label)
  client.ts             # CLI: start agentResearchWorkflow
  start-worker-demo.ts  # CLI: start workerHandoffWorkflow
  signal-approve.ts     # CLI to send the approve signal
  shared.ts             # Cloud connection helpers
  mcp/server.ts         # MCP stdio server
```


## Typecheck / build

```bash
npm run lint
npm run build
```
