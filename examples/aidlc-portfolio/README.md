# AI-DLC Portfolio Example

This example shows how CAO can coordinate several AI-DLC workflows across
repositories, or several independent intents in one repository, without
changing the child AI-DLC engine.

## The Problem This Addresses

AI-DLC is effective at driving one development intent through its lifecycle.
Real product changes, however, often cross repository boundaries:

- an API change in one repository requires a client change in another;
- a data migration must complete before an application release;
- infrastructure and application repositories must agree on deployment order;
- two business capabilities share a contract or operational dependency.

A child agent can inspect another repository or retrieve relevant facts from a
knowledge system such as CodeKB. That improves what the agent knows, but
knowledge is not coordination. It does not determine:

- which project owns a change;
- which intent should wait for another;
- whether a contract change is compatible;
- who accepts an unresolved cross-project risk;
- when independently successful branches are safe to integrate.

A single AI-DLC workflow is not a portfolio scheduler. Asking one child workflow
to jump between repositories also mixes ownership, lifecycle state, and
verification evidence. Parallel child workflows solve the execution bottleneck,
but they still need a durable parent that understands project relationships.

### Parallel Work In One Repository

Independent changes in one repository can run as separate AI-DLC intents in
separate Git worktrees. With one worktree and one AI-DLC state area per intent,
the children do not inherently share one execution cursor.

The remaining conflict is at the shared project boundary. Children can produce
divergent `project.md` or `team.md` updates, make incompatible assumptions about
the same component, or reach integration in the wrong order. If workflows share
an intent directory or mutable AI-DLC state instead of isolating it, they can
also overwrite each other's lifecycle position.

This example addresses both cases:

- isolate child execution by project, intent, branch, and worktree;
- keep AI-DLC authoritative inside each child workflow;
- add one portfolio supervisor for dependencies, human decisions, shared
  memory, and integration convergence.

## Architecture

```mermaid
flowchart TD
    H[Human portfolio owner] --> S[aidlc_portfolio_supervisor]
    S --> C[Portfolio catalog and parent lifecycle]
    S -->|CAO assign| R1[aidlc_runner: project A / intent 1]
    S -->|CAO assign| R2[aidlc_runner: project B / intent 2]
    S -->|CAO assign| R3[aidlc_runner: project A / intent 3]
    R1 --> W1[Isolated Git worktree]
    R2 --> W2[Isolated Git worktree]
    R3 --> W3[Isolated Git worktree]
    W1 --> A1[Existing AI-DLC workflow]
    W2 --> A2[Existing AI-DLC workflow]
    W3 --> A3[Existing AI-DLC workflow]
    R1 --> X[Structured child results]
    R2 --> X
    R3 --> X
    X --> G[Dependency convergence gate]
    G --> H
```

The parent lifecycle is:

```text
Bootstrap -> Discover -> Confirm -> Plan -> Dispatch -> Integrate -> Learn
```

It does not replace or infer child AI-DLC stages.

## What The Example Provides

- `aidlc_portfolio_supervisor.md`: Opus supervisor that discovers portfolio
  context and launches child sessions with CAO `assign`.
- `aidlc_runner.md`: Opus worker that owns exactly one AI-DLC intent and
  worktree.
- `skills/aidlc-portfolio/`: managed skill containing schemas, templates,
  reference guidance, and a deterministic portfolio CLI.
- `tests/`: focused tests for workspace validation, harness projection,
  lifecycle gates, shared-memory serialization, and dependency convergence.

The deterministic utility provides:

- a catalog of business outcomes, capabilities, projects, components, and
  eight dependency types;
- revision-bound human confirmation before dispatch;
- one Git worktree and child session record per project/intent pair;
- unanswered Markdown question packets for child design decisions;
- a single-writer proposal model for shared AI-DLC memory;
- structured child completion results and cycle-safe upstream/downstream
  convergence checks.

## Prerequisites

- CAO installed from the current `main` branch.
- `cao-server` running.
- Bun 1.3 or later.
- Git.
- Claude Code or Codex CLI installed and authenticated.
- The matching built AI-DLC distribution. The original Claude path is
  `$HOME/Project/aidlc-workflows/dist/claude`; see [Codex setup](#codex-setup)
  for the Codex profiles and runtime.

The original profiles use Claude Code's `opus` selector and pin its runtime to
the configured Opus 5 model identifier. The additive Codex profiles inherit
the operator's configured model, provider, credentials, and effort.

Both profiles explicitly allow CAO orchestration, shell execution, and
workspace file access because they must run the deterministic utility and write
inside assigned worktrees. Their prompts provide the narrower supervisor and
single-intent ownership boundaries.

## Install

These commands install the original Claude profiles. Use the next section for
Codex; the portfolio state, dependency checks, and human question relay are shared.

From the CAO repository root:

```bash
cd examples/aidlc-portfolio

# Install dependencies used by the example tests.
bun install --frozen-lockfile

# Install the managed skill, then its runtime-only Bun dependencies.
cao skills add ./skills/aidlc-portfolio
bun install \
  --cwd "$HOME/.aws/cli-agent-orchestrator/skills/aidlc-portfolio" \
  --frozen-lockfile --production

# Install both CAO profiles.
cao install ./aidlc_portfolio_supervisor.md
cao install ./aidlc_runner.md
```

Use `cao skills add ./skills/aidlc-portfolio --force` when intentionally
updating an earlier installation.

Validate the installation source:

```bash
cao profile validate ./aidlc_portfolio_supervisor.md
cao profile validate ./aidlc_runner.md
cao skills list
```

## Codex Setup

Use a checkout containing this example's Codex profiles. CAO must be installed
and its console scripts, including `cao-mcp-server`, must be on `PATH`. Install
the shared portfolio tooling and Codex profiles from the repository root:

```bash
cd examples/aidlc-portfolio
bun install --frozen-lockfile
cao skills add ./skills/aidlc-portfolio
bun install \
  --cwd "$HOME/.aws/cli-agent-orchestrator/skills/aidlc-portfolio" \
  --frozen-lockfile --production
cao skills add ../../skills/cao-worker-protocols
cao install ./aidlc_portfolio_supervisor_codex.md
cao install ./aidlc_runner_codex.md
cao profile validate ./aidlc_portfolio_supervisor_codex.md
cao profile validate ./aidlc_runner_codex.md
```

Use `--force` with `cao skills add` when intentionally updating an existing
copy. The installed skill path above assumes the default CAO home directory.

Both profiles use the named Codex configuration `aidlc_portfolio`. Install
[the sample](codex/aidlc_portfolio.config.toml) beside your Codex `config.toml`:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}"
cp -n ./codex/aidlc_portfolio.config.toml \
  "${CODEX_HOME:-$HOME/.codex}/aidlc_portfolio.config.toml"
```

If that named profile already exists, reconcile its settings with the sample.
It uses the workspace sandbox and automatic escalation review; model and
authentication remain your defaults. This profile avoids interactive shell
approval prompts during CAO delegation. Runtime containers are a separate
deployment choice; these profiles do not create containers.

Obtain a built Codex AI-DLC distribution from
[AI-DLC's Codex installation guide](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/harnesses/codex-cli.md).
For a source checkout the distribution is generated by
`bun scripts/package.ts codex` into `dist/codex/`; keep that source available
for runtime verification. Use the Bun version required by that AI-DLC checkout
when building it; this example's tooling is separately tested with Bun 1.3.10.
Use Codex CLI 0.162.1 or later for the named-profile
layout used here; AI-DLC itself supports earlier Codex releases.

Start `cao-server` in one terminal. In another, create and enter a fresh empty
portfolio root, then launch with the absolute runtime source:

```bash
mkdir -p /absolute/path/to/my-codex-portfolio
cd /absolute/path/to/my-codex-portfolio
cao launch --agents aidlc_portfolio_supervisor_codex --provider codex \
  --env AIDLC_CODEX_DISTRIBUTION=/absolute/path/to/aidlc-workflows/dist/codex
```

Give it the same multi-project request shown below. The supervisor initializes
the portfolio with `--provider codex` and launches `aidlc_runner_codex` workers
in separate registered worktrees. Both the Dispatch lifecycle gate and
`dispatch check` verify Codex using the persisted `harnessProvider` field.
Existing portfolios without that field retain the Claude default.

Review and trust each projected project's AI-DLC hooks in Codex's `/hooks`
screen before unattended execution. Workers report missing hook trust and wait;
an upgrade that changes the hook definitions can require review again.
For linked worktrees, synchronization also puts the pinned hook manifest in
the canonical Git checkout, where Codex 0.164 discovers it. The hook commands
still execute in the child worktree; other canonical configuration is preserved.

The supervisor gathers pending human question packets into the conversation,
records your answers, and notifies the matching worker. Packets and waiting
state survive supervisor replacement; the new supervisor inspects the same
portfolio before resuming. This example does not install an external
notification service or a browser decision inbox. See
[Codex operation](skills/aidlc-portfolio/references/codex.md) for the runtime,
onboarding, memory, and recovery details.

## Launch

This launch command selects the original Claude supervisor. Codex uses the
command in the preceding section and creates the same workspace layout.

Create and enter an empty parent directory. The supervisor owns everything
inside this directory, including repository checkouts, portfolio state, and
worktrees.

```bash
mkdir -p /absolute/path/to/my-portfolio
cd /absolute/path/to/my-portfolio
cao launch --agents aidlc_portfolio_supervisor
```

Do not launch the supervisor from an existing project checkout. It creates this
layout:

```text
my-portfolio/
|-- portfolio/
|   |-- portfolio.yaml
|   |-- state.json
|   |-- projects/
|   |-- dependencies/
|   |-- contracts/
|   |-- intents/
|   |-- questions/
|   |-- learnings/
|   |-- results/
|   `-- convergence-decisions/
|-- repositories/
|-- harness/
`-- worktrees/
```

## Try A Cross-Repository Portfolio

Give the supervisor concrete repositories and work items:

```text
Coordinate these changes as one AI-DLC portfolio:

- checkout-api, issue 142: add the v2 checkout response contract
- checkout-web, issue 87: consume the v2 checkout response
- checkout-infra, issue 31: deploy the API before the web release

Discover the business and technical relationships with me, create one child
intent and worktree per project, and run dependency-ready children in parallel.
Do not accept unknown or breaking integration risks without asking me.
```

The supervisor should:

1. initialize the launch directory;
2. clone fresh canonical repositories under `repositories/`;
3. discover and confirm business, component, contract, and dependency context;
4. create isolated worktrees and project the same AI-DLC harness into each;
5. launch dependency-ready `aidlc_runner` sessions concurrently;
6. relay child design questions to the human without answering them;
7. require structured child results and resolve convergence before completion.

## Try Parallel Intents In One Repository

```text
Coordinate issues 321 and 510 in the same repository as independent AI-DLC
intents. Use a separate branch, worktree, and child session for each. Identify
shared components and integration dependencies before dispatch. Treat project
and team memory as single-writer shared state.
```

The two children have isolated files and AI-DLC state. They submit durable
project or team learnings as proposals; only the supervisor can serialize an
approved update into canonical memory.

## Human Control Points

Tool permission and AI autonomy do not replace product decisions. The sample
keeps the human involved at four boundaries:

1. **Discovery**: confirm organization, outcomes, capabilities, and dependency
   facts before dispatch.
2. **Child questions**: review AI-DLC-generated design questions through an
   unchanged Markdown packet.
3. **Convergence**: accept or resolve revision-bound breaking, deferred, or
   unknown integration risks.
4. **Shared memory**: review project/team learning proposals before the utility
   performs the canonical write.

Missing child results and incomplete dependency ordering cannot be accepted;
they must be remediated.

## Inspect And Recover

The supervisor normally runs these commands through the managed skill. They are
also useful when inspecting a stopped session:

```bash
SKILL_DIR="$HOME/.aws/cli-agent-orchestrator/skills/aidlc-portfolio"
ROOT=/absolute/path/to/my-portfolio

bun "$SKILL_DIR/scripts/portfolio.ts" doctor --root "$ROOT"
bun "$SKILL_DIR/scripts/portfolio.ts" lifecycle status --root "$ROOT"
bun "$SKILL_DIR/scripts/portfolio.ts" status --root "$ROOT"
bun "$SKILL_DIR/scripts/portfolio.ts" convergence check --root "$ROOT"
```

CAO terminals are disposable. Portfolio state, Git worktrees, and child AI-DLC
state are durable, so a replacement terminal resumes the same registered child
instead of creating a new intent.

## Verify The Example

```bash
cd examples/aidlc-portfolio
bun run check
```

The suite does not invoke a provider or perform real project development. It
tests the deterministic portfolio control plane with temporary Git
repositories and worktrees. CAO's main CI workflow runs the same command.

For a live Codex smoke test, use two disposable repositories and the Codex
setup above. Give each child a small change with an undecided wording choice.
Verify that both submit unanswered packets and leave implementation paused.
Answer one packet and verify that only its child resumes. Replace that child's
terminal and verify recovery uses the same worktree, native intent, and stored
answers. Continue through the native engine's human gates, require a verified
`result submit` receipt, and inspect `convergence check`. This exercise requires
authenticated Codex sessions and is separate from the deterministic CI suite.

## Boundaries

This example does not:

- modify the AI-DLC engine or calculate its next stage;
- use CodeKB as a substitute for dependency ownership or integration policy;
- share one mutable AI-DLC state directory between children;
- automatically approve human design or integration decisions;
- reuse, clean, reset, or delete an existing user checkout.
