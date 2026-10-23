# Harness Lifecycle

The portfolio utility owns AI-DLC harness staging and projection. Use its
commands for runtime changes rather than copying harness directories directly.
Commands default to the portfolio's persisted `harnessProvider` (`claude` for
existing portfolios without the field); initialization accepts
`--provider claude|codex`.

## Stage

`harness stage` reads one matching distribution, hashes its runtime files and
workspace seeds, records the Git revision when available, and writes
`harness/<provider>/manifest.json`. Claude owns `.claude/` and `aidlc/`;
Codex owns `.codex/`, `.agents/`, and `aidlc/`.

The Claude overlay maps `opus[1m]` to
`global.anthropic.claude-opus-5[1m]`. Codex keeps the operator's model settings
and rejects the Claude-only `--opus-model` option. Its versioned overlay adds
the supervisor permission relay to `.codex/hooks.json`. Staging leaves the source
distribution unchanged. Repeating it with identical source bytes and overlay
is a no-op.

## Sync

`harness sync` verifies the staged files before projecting them into registered
worktrees. It replaces the provider's runtime directories transactionally,
writes a worktree receipt under `.aidlc-portfolio/`, and adds a marked block
to the repository-local Git exclude file. Workspace synchronization updates
immutable seed files while retaining child intents, audit records,
active-space selection, and existing project/team memory. Source upgrades
remove retired immutable seed files recorded in the previous receipt.

Codex synchronization also mirrors `.codex/hooks.json` into each owned
canonical checkout: Codex 0.164 discovers linked-worktree hooks there. It
preserves other canonical configuration and refuses a tracked hook manifest.

Sync refuses tracked files in the selected provider's owned paths or
`.aidlc-portfolio/`. Project-owned configuration must be reconciled explicitly
rather than overwritten. Symlinks in runtime sources or seed destinations are
refused.

## Verify

`harness verify` compares:

1. Current source revision and hashes against the staged manifest.
2. Current staged files and model configuration against the manifest.
3. Every selected worktree's runtime, immutable workspace seeds, and receipt
   against the staged revision. New child state and mutable project/team
   memory are not runtime drift; separate portfolio memory gates govern them.
4. Repository-local exclusion state.
5. Codex's canonical hook copies against the staged runtime.

Any source upgrade, staged mutation, local runtime mutation, stale receipt,
missing file, model drift, or missing exclusion fails verification and names
the affected worktree.
