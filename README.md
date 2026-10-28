# Temporal Cloud Showcase

A small TypeScript demo for colleagues covering:

- Temporal Cloud workflows & workers
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

## Project layout

```
src/
  activities.ts      # research + agent summarize (stub / OpenAI)
  workflows.ts       # agentResearchWorkflow (+ signal/query)
  worker.ts          # polls TEMPORAL_TASK_QUEUE
  client.ts          # CLI to start the demo workflow
  signal-approve.ts  # CLI to send the approve signal
  shared.ts          # Cloud connection helpers
  mcp/server.ts      # MCP stdio server
```

## Typecheck / build

```bash
npm run lint
npm run build
```
