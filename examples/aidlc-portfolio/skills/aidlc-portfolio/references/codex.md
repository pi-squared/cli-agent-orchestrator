# Codex Operation

Use `aidlc_portfolio_supervisor_codex` and `aidlc_runner_codex` together. Both
select CAO's existing `codex` provider. The child AI-DLC engine is unchanged.

## Bootstrap

Initialize a new workspace with `init --provider codex`. The utility stores
`harnessProvider: codex` in `portfolio/portfolio.yaml`; dispatch and lifecycle
gates use this persisted value. Existing portfolios without the field use
Claude. Reinitialization cannot silently switch providers.

Locate the operator-supplied Codex distribution, then the
`AIDLC_CODEX_DISTRIBUTION` environment variable, then
`$HOME/Project/aidlc-workflows/dist/codex`. Stage it through the same `harness
stage --source <path>`, `harness sync`, and `harness verify` commands. Provider
flags on those commands are optional after initialization.

The Codex projection owns `.codex/`, `.agents/`, and the `aidlc/` workspace
shell. It refuses tracked files in these paths and preserves the project's
root instructions. Runtime configuration, hooks, and skills are hashed;
Codex's provider, credentials, model, and effort remain operator settings.
The `--opus-model` option applies only to Claude.

Codex 0.164 discovers linked-worktree hooks from the primary Git checkout.
Synchronization therefore also mirrors the pinned `.codex/hooks.json` into
each owned canonical repository under `repositories/`. Other canonical Codex
configuration is preserved, tracked hook manifests are refused, and verification
checks this shared hook copy as well as the child runtime. Hook commands run in
the child's working directory using that worktree's projected AI-DLC tools.
Pause affected children before upgrading a shared canonical hook manifest.

After initial projection, inspect `project` and `team` memory for each child.
If a shipped seed differs from canonical project memory, use `memory refresh`
before dispatch. After a child has started, resolve its learning proposals
before refreshing or cleaning memory. Re-sync preserves intent state, audit
records, active-space selection, and child project/team memory.

## Codex Configuration

Both profiles select `codexProfile: aidlc_portfolio`. Install the example's
`codex/aidlc_portfolio.config.toml` beside the operator's Codex config, under
the same name. It uses the workspace sandbox and automatic escalation review
so CAO does not stall at interactive shell-approval prompts. Do not add
unrestricted `allowedTools: ["*"]` or launch with `--yolo`: those override the
named profile. Container isolation is an independent deployment choice.

CAO sets `developer_instructions` to the role prompt. The runner must therefore
read `.codex/onboarding.md` before loading the project's
`.agents/skills/aidlc/SKILL.md` and starting `$aidlc`. This retains the AI-DLC
onboarding that the project config would otherwise supply.

The operator must trust the project and review its exact AI-DLC hooks in
Codex's `/hooks` screen before the first unattended run. For linked worktrees,
the listed hook source is the canonical repository's `.codex/hooks.json`.
A runtime upgrade can
change hook definitions and require review again. Workers report missing hook
trust and wait; tool permissions are separate from human workflow decisions.
See the upstream [Codex runtime guide](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/harnesses/codex-cli.md).

## Dispatch and Human Decisions

Pass profile `aidlc_runner_codex` and the registered absolute worktree to each
CAO `assign`; the worker profile selects Codex. Follow the shared assignment template and record
the returned terminal ID after the dispatch readiness check.

Workers submit unchanged question packets and stop. The supervisor gathers
`question list --status pending`, presents the human's preferred interaction
mode, records the supplied answers, and messages the corresponding runner.
The utility persists the packet, answer, project, intent, and waiting status;
CAO messages carry the continuation signal. On recovery, inspect those records
before creating a replacement terminal for the same worktree and child intent.

Keep local relay packets and result files in the worktree's excluded
`.aidlc-portfolio/` directory. If the native engine assigns a dated intent
directory at initialization, update that project's `aidlcIntent` mapping
through `intent create` with the complete existing intent document and the
reported native identity. Preserve other project mappings and session records.

For large engine directives, redirect stdout to an excluded file and parse the
complete JSON there. Piping a large steering payload through the terminal can
produce Bun `EAGAIN` writes or truncated output. Failed or incomplete output
requires native recovery before a continuation receipt can be consumed.

This gives one conversational decision queue while the supervisor is running.
The example does not install a browser decision inbox or an external
notification service.
