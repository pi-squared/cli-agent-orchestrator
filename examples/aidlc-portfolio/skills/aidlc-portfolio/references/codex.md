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

The supervisor selects `codexProfile: aidlc_portfolio`; the worker selects
`codexProfile: aidlc_portfolio_worker`. Install both example files beside the
operator's Codex config. The supervisor uses automatic escalation review; the
worker uses the native permission relay described below. Both keep the workspace
sandbox. Unrestricted `allowedTools: ["*"]` and `--yolo` override named profiles.
Container isolation is an independent deployment choice.

CAO sets `developer_instructions` to the role prompt. The runner must therefore
read `.codex/onboarding.md` before loading the project's
`.agents/skills/aidlc/SKILL.md` and starting `$aidlc`. This retains the AI-DLC
onboarding that the project config would otherwise supply.

The portfolio supervisor uses CAO `assign` to create project runners. Inside
each runner, AI-DLC uses its native Codex topology and agent-role configuration
(`spawn_agent` / `send_input`). Generic CAO developer profiles do not carry
those native roles or guarantee the same provider.

## Supervisor Startup Review

Install both named Codex profiles from the example's `codex/` directory. The
supervisor uses automatic escalation review; the worker uses on-request human
review. The pinned project hook manifest adds a `PermissionRequest` relay,
which runs the installed portfolio
skill from `${CAO_HOME_DIR:-$HOME/.aws/cli-agent-orchestrator}`. Keep the installed
skill and the CLI used for review at the same revision. Codex 0.164.0 is the
verified runtime for the native hook/configuration protocol used here.

After harness synchronization, handle all review in the supervisor conversation:

1. Run `codex review --root <root> --project <project> --intent <intent>`.
   It discovers hooks with the installed Codex, without starting a thread or
   executing hooks, and queues a startup question. Present its exact project
   paths, runtime revision, hook commands, sources, matchers and timeouts. The
   review includes the permission relay and any other loaded hooks.
2. Collect the person's explicit `approve` or `reject` answer. Use the unchanged
   generated Markdown with `question answer --mode chat --answered-by <human>`.
   Review and approval happen here; keep workers stopped until accepted.
3. After approval, run `codex trust --root <root> --id <review-id>
   --callback-terminal <this-supervisor-CAO_TERMINAL_ID>`. Codex's native TOML
   editor writes only the approved project/hook keys, preserves other settings
   and comments, and rejects concurrent config changes. The command records a
   receipt and verifies the effective native hook trust.
4. Run `codex verify --root <root> --project <project> --intent <intent>`, then
   the ordinary dispatch check and CAO assignment. Both project and canonical
   Git checkout trust are covered. Linked-worktree hook identities use the
   canonical checkout, as reported by Codex itself.

The same `question list --status pending` inbox contains startup, permission and
workflow packets. Rejected startup keeps the worker stopped; running `codex review`
again can queue a fresh reconsideration. Runtime/configuration changes require a
new revision-bound review. The staged Codex overlay adds only the approval relay to the hook manifest;
AI-DLC engine code is unchanged. Pause affected children before an upgrade. Revoked
trust cannot be silently restored using an already applied approval.

On supervisor replacement, inspect existing receipts and packets, verify trust,
and repeat `codex trust` for an approved review with the new callback terminal.
This rebinds the portfolio callback without changing trust or replaying a human
decision. CAO still enforces each terminal's recorded caller: when replacing a
supervisor with a different CAO terminal identity, recover children as new
assignments from that supervisor, using the same registered worktrees and
intent state. An existing child is not silently reparented.

## Command Permissions

The worker's native `PermissionRequest` hook persists the exact tool input and
working directory, queues a permission packet, and notifies the supervisor using
CAO's authenticated caller-scoped inbox. Present the command as data, obtain
`approve` or `reject`, and record the human answer through `question answer`.
The waiting hook consumes that answer once and returns Codex's native allow/deny
response automatically. Keep the worker terminal unattended; sending an extra
continuation message is unnecessary for permission packets.

Concurrent native subagent requests remain separate; answering one keeps other
requests waiting. Rejection, notification failure, invalid state and expiry
return denial. Requests expire after 55 minutes, before the native hook's
one-hour timeout; late answers and retries require a fresh request. Existing
managed policies still apply. Initial Codex account sign-in remains an
installation prerequisite.

The engine and its stage gates remain unchanged. See the upstream
[Codex runtime guide](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/harnesses/codex-cli.md)
and [native permission hook contract](https://learn.chatgpt.com/docs/hooks#permissionrequest).

## Dispatch and Human Decisions

Pass profile `aidlc_runner_codex` and the registered absolute worktree to each
CAO `assign`; the worker profile selects Codex. Follow the shared assignment template and record
the returned terminal ID after the dispatch readiness check.

Workers submit unchanged question packets and stop. The supervisor gathers
`question list --status pending`, presents the human's preferred interaction
mode, records the supplied answers, and messages the corresponding runner for ordinary
workflow packets. Startup and permission packets follow the procedures above.
The utility persists the packet, answer, project, intent, and waiting status;
CAO messages carry the continuation signal. On recovery, inspect those records
before creating a replacement terminal for the same worktree and child intent.

Keep local relay packets and result files in `aidlc/portfolio-relay/` in the
worktree. The native engine excludes the `aidlc/` workspace shell from its
source fingerprint; Git ignores alone do not exclude arbitrary directories
from that fingerprint. Keep `.aidlc-portfolio/` for harness receipts.
If the native engine assigns a dated intent
directory at initialization, update that project's `aidlcIntent` mapping
through `intent create` with the complete existing intent document and the
reported native identity. Preserve other project mappings and session records.

Run native engine commands on their own. For large directives, select the
shell tool's PTY mode (`tty: true`) and an output budget large enough to read
the complete JSON. Piped output can produce Bun `EAGAIN` writes; redirection
can conflict with native command guards or change the source being checked.
Failed or incomplete output requires native recovery before a continuation
receipt can be consumed.

This gives one conversational decision queue while the supervisor is running.
The example does not install a browser decision inbox or an external
notification service.
