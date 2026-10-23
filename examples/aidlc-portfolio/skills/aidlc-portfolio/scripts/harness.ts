import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export type HarnessProvider = "claude" | "codex";
export const CODEX_PERMISSION_RELAY_COMMAND = 'bun "${CAO_HOME_DIR:-$HOME/.aws/cli-agent-orchestrator}/skills/aidlc-portfolio/scripts/codex-permission.ts" || printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Portfolio approval relay unavailable; report the blocker to the supervisor."}}}\'';

interface HarnessManifest {
  schemaVersion: 1;
  provider: HarnessProvider;
  source: {
    path: string;
    revision: string;
    files: Record<string, string>;
  };
  overlay: {
    opusModel?: string;
    portfolioPermissionRelay?: number;
    revision: string;
  };
  staged: {
    files: Record<string, string>;
  };
  stagedAt: string;
}

interface HarnessReceipt {
  schemaVersion: 1;
  provider: HarnessProvider;
  manifestRevision: string;
  files: Record<string, string>;
  syncedAt: string;
}

interface RegisteredWorktree {
  project: string;
  intent: string;
  path: string;
}

export interface HarnessVerification {
  ok: boolean;
  provider: HarnessProvider;
  manifestPath: string;
  manifestRevision: string | null;
  errors: string[];
  worktrees: Array<{
    project: string;
    intent: string;
    path: string;
    ok: boolean;
    errors: string[];
  }>;
}

const DEFAULT_OPUS_MODEL = "global.anthropic.claude-opus-5[1m]";
const MANIFEST_FILE = "manifest.json";
const RECEIPT_FILE = join(".aidlc-portfolio", "harness-manifest.json");
const DISTRIBUTION_PATHS: Record<HarnessProvider, string[]> = {
  claude: [".claude", "aidlc"],
  codex: [".codex", ".agents", "aidlc"],
};

export class HarnessError extends Error {}

export async function stageHarness(
  rootInput: string,
  providerInput: string,
  sourceInput: string,
  opusModel?: string,
): Promise<{
  changed: boolean;
  path: string;
  manifestPath: string;
  manifestRevision: string;
}> {
  const provider = requireProvider(providerInput);
  if (provider === "codex" && opusModel !== undefined) {
    throw new HarnessError("--opus-model applies only to the Claude harness");
  }
  const overlay = provider === "claude"
    ? { opusModel: opusModel ?? DEFAULT_OPUS_MODEL }
    : { portfolioPermissionRelay: 1 };
  const root = resolve(rootInput);
  const source = resolve(sourceInput);
  const target = harnessRoot(root, provider);
  if (pathsOverlap(source, target)) {
    throw new HarnessError(
      "harness source and staged target must not contain one another",
    );
  }
  await validateDistribution(source, provider);

  const sourceFiles = await distributionFiles(source, provider);
  const sourceRevision = await sourceRevisionFor(source, sourceFiles);
  const overlayRevision = revisionOf({ provider, ...overlay });
  const existing = await readManifest(target);
  const existingStagedFiles = existing
    ? await optionalDistributionFiles(target, provider)
    : null;
  const existingOpusModel = existing && provider === "claude"
    ? await optionalConfiguredOpusModel(target)
    : undefined;
  if (
    existing &&
    existing.provider === provider &&
    existing.source.path === source &&
    existing.source.revision === sourceRevision &&
    mapsEqual(existing.source.files, sourceFiles) &&
    existing.overlay.opusModel === overlay.opusModel &&
    existing.overlay.revision === overlayRevision &&
    existingStagedFiles &&
    mapsEqual(existing.staged.files, existingStagedFiles) &&
    existingOpusModel === overlay.opusModel
  ) {
    return {
      changed: false,
      path: target,
      manifestPath: join(target, MANIFEST_FILE),
      manifestRevision: revisionOf(existing),
    };
  }

  const parent = dirname(target);
  const temporary = join(parent, `.${provider}-stage-${crypto.randomUUID()}`);
  await mkdir(parent, { recursive: true });
  try {
    for (const name of DISTRIBUTION_PATHS[provider]) {
      await cp(join(source, name), join(temporary, name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    if (overlay.opusModel !== undefined) {
      await applyClaudeOverlay(temporary, overlay.opusModel);
    }
    if (provider === "codex") {
      const path = join(temporary, ".codex/hooks.json");
      const hooks = JSON.parse(await readFile(path, "utf8"));
      hooks.hooks ??= {};
      hooks.hooks.PermissionRequest ??= [];
      hooks.hooks.PermissionRequest.push({ matcher: ".*", hooks: [{
        type: "command",
        command: CODEX_PERMISSION_RELAY_COMMAND,
        timeout: 3600,
        statusMessage: "Waiting for approval through the portfolio supervisor",
      }] });
      await writeFile(path, `${JSON.stringify(hooks, null, 2)}\n`);
    }
    const manifest: HarnessManifest = {
      schemaVersion: 1,
      provider,
      source: {
        path: source,
        revision: sourceRevision,
        files: sourceFiles,
      },
      overlay: {
        ...overlay,
        revision: overlayRevision,
      },
      staged: {
        files: await distributionFiles(temporary, provider),
      },
      stagedAt: new Date().toISOString(),
    };
    await writeJson(join(temporary, MANIFEST_FILE), manifest);
    await replaceDirectory(temporary, target);
    return {
      changed: true,
      path: target,
      manifestPath: join(target, MANIFEST_FILE),
      manifestRevision: revisionOf(manifest),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function syncHarness(
  rootInput: string,
  providerInput: string,
  project?: string,
  intent?: string,
): Promise<{
  changed: boolean;
  manifestRevision: string;
  worktrees: Array<RegisteredWorktree & { changed: boolean }>;
  canonicalHooks: Array<{ path: string; changed: boolean }>;
}> {
  const provider = requireProvider(providerInput);
  const root = resolve(rootInput);
  const staged = harnessRoot(root, provider);
  const manifest = await requireCleanStagedHarness(staged, provider);
  const manifestRevision = revisionOf(manifest);
  const worktrees = await registeredWorktrees(root, project, intent);
  if (worktrees.length === 0) {
    throw new HarnessError("no registered worktrees match the requested filters");
  }

  const results = [];
  for (const worktree of worktrees) {
    results.push({
      ...worktree,
      changed: await syncWorktree(worktree.path, staged, manifest, manifestRevision),
    });
  }
  const canonicalHooks = [];
  if (provider === "codex") {
    for (const repository of await canonicalRepositories(root, worktrees)) {
      canonicalHooks.push({
        path: join(repository, ".codex/hooks.json"),
        changed: await syncCanonicalHooks(repository, staged),
      });
    }
  }
  return {
    changed: canonicalHooks.some((item) => item.changed) || results.some((item) => item.changed),
    manifestRevision,
    worktrees: results,
    canonicalHooks,
  };
}

export async function verifyHarness(
  rootInput: string,
  providerInput: string,
  project?: string,
  intent?: string,
): Promise<HarnessVerification> {
  const provider = requireProvider(providerInput);
  const root = resolve(rootInput);
  const staged = harnessRoot(root, provider);
  const manifestPath = join(staged, MANIFEST_FILE);
  const errors: string[] = [];
  let manifest: HarnessManifest | null = null;

  try {
    manifest = await requireCleanStagedHarness(staged, provider);
    const sourceFiles = await distributionFiles(manifest.source.path, provider);
    const sourceRevision = await sourceRevisionFor(manifest.source.path, sourceFiles);
    if (
      sourceRevision !== manifest.source.revision ||
      !mapsEqual(sourceFiles, manifest.source.files)
    ) {
      errors.push(`source harness changed: ${manifest.source.path}`);
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }

  const manifestRevision = manifest ? revisionOf(manifest) : null;
  const worktreeResults: HarnessVerification["worktrees"] = [];
  if (manifest) {
    const worktrees = await registeredWorktrees(root, project, intent);
    if (worktrees.length === 0) {
      errors.push("no registered worktrees match the requested filters");
    }
    for (const worktree of worktrees) {
      const worktreeErrors = await verifyWorktree(
        worktree.path,
        manifest,
        manifestRevision!,
      );
      worktreeResults.push({
        ...worktree,
        ok: worktreeErrors.length === 0,
        errors: worktreeErrors,
      });
    }
    if (provider === "codex") {
      try {
        for (const repository of await canonicalRepositories(root, worktrees)) {
          const path = ".codex/hooks.json";
          await requireRegularAncestors(repository, path);
          const hash = createHash("sha256").update(await readFile(join(repository, path))).digest("hex");
          if (hash !== manifest.staged.files[path]) {
            errors.push(`canonical Codex hook manifest differs from staged runtime: ${repository}`);
          }
        }
      } catch (error) {
        errors.push(`canonical Codex hooks: ${errorMessage(error)}`);
      }
    }
  }

  return {
    ok: errors.length === 0 && worktreeResults.every((item) => item.ok),
    provider,
    manifestPath,
    manifestRevision,
    errors,
    worktrees: worktreeResults,
  };
}

export async function canonicalRepositories(root: string, worktrees: RegisteredWorktree[]): Promise<string[]> {
  const repositories = new Set<string>();
  for (const { path } of worktrees) {
    const common = resolve(path, (await gitOutput(path, ["rev-parse", "--git-common-dir"])).trim());
    if (common === join(path, ".git")) continue;
    if (basename(common) !== ".git") {
      throw new HarnessError(`unsupported canonical Git directory: ${common}`);
    }
    repositories.add(resolveInside(root, dirname(common), join(root, "repositories")));
  }
  return [...repositories].sort();
}

async function syncCanonicalHooks(repository: string, staged: string): Promise<boolean> {
  // Codex 0.164 discovers linked-worktree hooks in the primary checkout.
  // Hook commands still execute with the child's cwd and projected runtime.
  const path = ".codex/hooks.json";
  await requireRegularAncestors(repository, path);
  const source = await readFile(join(staged, path));
  const tracked = (await gitOutput(repository, ["ls-files", "--", path])).trim();
  if (tracked) {
    throw new HarnessError(`refusing to overwrite tracked canonical Codex hooks: ${repository}/${path}`);
  }
  try {
    if (source.equals(await readFile(join(repository, path)))) return false;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const target = join(repository, path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function syncWorktree(
  worktree: string,
  staged: string,
  manifest: HarnessManifest,
  manifestRevision: string,
): Promise<boolean> {
  await requireGitWorktree(worktree);
  const tracked = await gitOutput(worktree, [
    "ls-files",
    "--",
    ...DISTRIBUTION_PATHS[manifest.provider],
    ".aidlc-portfolio",
  ]);
  if (tracked.trim()) {
    throw new HarnessError(
      `refusing to overwrite tracked harness paths in ${worktree}: ${tracked
        .trim()
        .split(/\r?\n/)
        .join(", ")}`,
    );
  }

  const verification = await verifyWorktree(worktree, manifest, manifestRevision);
  if (verification.length === 0 && (await hasExcludeBlock(worktree, manifest.provider))) {
    return false;
  }

  const temporary = join(worktree, `.aidlc-portfolio-sync-${crypto.randomUUID()}`);
  try {
    for (const name of DISTRIBUTION_PATHS[manifest.provider]) {
      await cp(join(staged, name), join(temporary, name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    await preserveWorkspace(staged, temporary, worktree, manifest);
    const prepared = await distributionFiles(temporary, manifest.provider, manifest.staged.files);
    if (!mapsEqual(prepared, immutableFiles(manifest.staged.files))) {
      throw new HarnessError("prepared runtime differs from the staged manifest");
    }
    await replaceWorktreeDistribution(temporary, worktree, manifest.provider);
    const receipt: HarnessReceipt = {
      schemaVersion: 1,
      provider: manifest.provider,
      manifestRevision,
      files: manifest.staged.files,
      syncedAt: new Date().toISOString(),
    };
    await writeJson(join(worktree, RECEIPT_FILE), receipt);
    await ensureExcludeBlock(worktree, manifest.provider);
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyWorktree(
  worktree: string,
  manifest: HarnessManifest,
  manifestRevision: string,
): Promise<string[]> {
  const errors: string[] = [];
  try {
    await requireGitWorktree(worktree);
    const files = await distributionFiles(worktree, manifest.provider, manifest.staged.files);
    const expected = immutableFiles(manifest.staged.files);
    if (!mapsEqual(files, expected)) {
      errors.push("projected harness files differ from the staged manifest");
    }
    if (manifest.provider === "claude" &&
        (await configuredOpusModel(worktree)) !== manifest.overlay.opusModel) {
      errors.push(`Claude model overlay differs from ${manifest.overlay.opusModel}`);
    }
    const receipt = await readJson<HarnessReceipt>(join(worktree, RECEIPT_FILE));
    if (receipt.provider !== manifest.provider) {
      errors.push("worktree receipt references a different harness provider");
    }
    if (receipt.manifestRevision !== manifestRevision) {
      errors.push("worktree receipt references a different harness manifest");
    }
    if (!mapsEqual(receipt.files, manifest.staged.files)) {
      errors.push("worktree receipt file hashes differ from the staged manifest");
    }
    if (!(await hasExcludeBlock(worktree, manifest.provider))) {
      errors.push("repository-local harness exclusions are missing");
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return errors;
}

async function requireCleanStagedHarness(
  staged: string,
  provider: HarnessProvider,
): Promise<HarnessManifest> {
  const manifest = await readManifest(staged);
  if (!manifest) {
    throw new HarnessError(`staged harness manifest not found: ${staged}`);
  }
  if (manifest.provider !== provider) {
    throw new HarnessError(`staged harness provider is not ${provider}`);
  }
  const files = await distributionFiles(staged, provider);
  if (!mapsEqual(files, manifest.staged.files)) {
    throw new HarnessError(`staged harness files do not match ${join(staged, MANIFEST_FILE)}`);
  }
  if (provider === "claude" &&
      (await configuredOpusModel(staged)) !== manifest.overlay.opusModel) {
    throw new HarnessError(
      `staged Claude model does not match overlay ${manifest.overlay.opusModel}`,
    );
  }
  return manifest;
}

export async function registeredWorktrees(
  root: string,
  projectFilter?: string,
  intentFilter?: string,
): Promise<RegisteredWorktree[]> {
  const directory = join(root, "portfolio", "intents");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  const worktrees: RegisteredWorktree[] = [];
  const owners = new Map<string, string>();
  for (const name of names) {
    const document = parse(await readFile(join(directory, name), "utf8")) as {
      id?: string;
      projects?: Array<{ project?: string; worktree?: string }>;
    };
    for (const mapping of document.projects ?? []) {
      if (!document.id || !mapping.project || !mapping.worktree) continue;
      if (projectFilter && mapping.project !== projectFilter) continue;
      if (intentFilter && document.id !== intentFilter) continue;
      const path = resolveInside(root, mapping.worktree, join(root, "worktrees"));
      const owner = `${document.id}:${mapping.project}`;
      const previousOwner = owners.get(path);
      if (previousOwner && previousOwner !== owner) {
        throw new HarnessError(
          `registered worktree ${path} is shared by ${previousOwner} and ${owner}`,
        );
      }
      owners.set(path, owner);
      worktrees.push({
        project: mapping.project,
        intent: document.id,
        path,
      });
    }
  }
  return worktrees;
}

async function validateDistribution(root: string, provider: HarnessProvider): Promise<void> {
  const requiredFiles = provider === "claude"
    ? [".claude/settings.json", ".claude/skills/aidlc/SKILL.md"]
    : [".codex/config.toml", ".codex/hooks.json", ".agents/skills/aidlc/SKILL.md"];
  for (const required of [...DISTRIBUTION_PATHS[provider], ...requiredFiles]) {
    try {
      const entry = await lstat(join(root, required));
      if (entry.isSymbolicLink() ||
          (DISTRIBUTION_PATHS[provider].includes(required) ? !entry.isDirectory() : !entry.isFile())) {
        throw new HarnessError(`invalid runtime entry: ${required}`);
      }
    } catch {
      throw new HarnessError(`${provider} distribution is missing a regular ${required}: ${root}`);
    }
  }
}

async function distributionFiles(
  root: string,
  provider: HarnessProvider,
  seeds?: Record<string, string>,
): Promise<Record<string, string>> {
  await validateDistribution(root, provider);
  const files: Record<string, string> = {};
  for (const name of DISTRIBUTION_PATHS[provider]) {
    if (name === "aidlc" && seeds) {
      // The workspace shell grows intents, audit logs and memory during a run.
      // Verify its immutable seed files without treating child state as drift.
      for (const path of Object.keys(seeds).filter((path) => path.startsWith("aidlc/")).sort()) {
        if (mutableWorkspacePath(path)) continue;
        await requireRegularAncestors(root, path);
        files[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
      }
    } else {
      await collectFiles(root, name, files);
    }
  }
  return files;
}

function mutableWorkspacePath(path: string): boolean {
  return path === "aidlc/active-space" ||
    /^aidlc\/spaces\/[^/]+\/memory\/(project|team)\.md$/.test(path);
}

function immutableFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !mutableWorkspacePath(path)));
}

async function preserveWorkspace(
  staged: string,
  temporary: string,
  worktree: string,
  manifest: HarnessManifest,
): Promise<void> {
  const workspace = join(worktree, "aidlc");
  try {
    const entry = await lstat(workspace);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HarnessError(`workspace shell is not a regular directory: ${workspace}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  await rm(join(temporary, "aidlc"), { recursive: true });
  await cp(workspace, join(temporary, "aidlc"), { recursive: true });

  let previous: HarnessReceipt | null = null;
  try {
    previous = await readJson<HarnessReceipt>(join(worktree, RECEIPT_FILE));
  } catch {
    // First projection can encounter a pre-existing, untracked workspace shell.
  }
  for (const path of Object.keys(previous?.files ?? {})) {
    if (!path.startsWith("aidlc/") || mutableWorkspacePath(path) || path in manifest.staged.files) continue;
    await requireRegularAncestors(temporary, path);
    await rm(resolveInside(temporary, path, join(temporary, "aidlc")), { force: true });
  }
  for (const path of Object.keys(manifest.staged.files).filter((path) => path.startsWith("aidlc/"))) {
    await requireRegularAncestors(temporary, path);
    const destination = resolveInside(temporary, path, join(temporary, "aidlc"));
    if (mutableWorkspacePath(path)) {
      try {
        await lstat(destination);
        continue;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        // Missing project/team memory can be intentional after memory clean.
        if (path !== "aidlc/active-space") continue;
      }
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(staged, path), destination);
  }
}

async function requireRegularAncestors(root: string, path: string): Promise<void> {
  resolveInside(root, path, root);
  const parts = path.split("/");
  for (let end = 1; end <= parts.length; end++) {
    const current = join(root, ...parts.slice(0, end));
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HarnessError(`refusing to follow workspace symbolic link: ${current}`);
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

async function collectFiles(
  root: string,
  relativePath: string,
  files: Record<string, string>,
): Promise<void> {
  const path = join(root, relativePath);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = join(relativePath, entry.name);
    const child = join(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new HarnessError(`symbolic links are not supported in harnesses: ${child}`);
    }
    if (entry.isDirectory()) {
      await collectFiles(root, childRelative, files);
    } else if (entry.isFile()) {
      files[toPortablePath(childRelative)] = createHash("sha256")
        .update(await readFile(child))
        .digest("hex");
    }
  }
}

async function applyClaudeOverlay(root: string, opusModel: string): Promise<void> {
  if (!opusModel.trim()) {
    throw new HarnessError("Opus model overlay must not be empty");
  }
  const settingsPath = join(root, ".claude", "settings.json");
  const settings = await readJson<Record<string, unknown>>(settingsPath);
  const env =
    settings.env && typeof settings.env === "object"
      ? (settings.env as Record<string, unknown>)
      : {};
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
  settings.env = env;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

async function configuredOpusModel(root: string): Promise<string | null> {
  const settings = await readJson<{ env?: Record<string, string> }>(
    join(root, ".claude", "settings.json"),
  );
  return settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null;
}

async function optionalDistributionFiles(
  root: string,
  provider: HarnessProvider,
): Promise<Record<string, string> | null> {
  try {
    return await distributionFiles(root, provider);
  } catch {
    return null;
  }
}

async function optionalConfiguredOpusModel(root: string): Promise<string | null> {
  try {
    return await configuredOpusModel(root);
  } catch {
    return null;
  }
}

async function readManifest(root: string): Promise<HarnessManifest | null> {
  try {
    return await readJson<HarnessManifest>(join(root, MANIFEST_FILE));
  } catch {
    return null;
  }
}

async function sourceRevisionFor(
  source: string,
  files: Record<string, string>,
): Promise<string> {
  try {
    return (await gitOutput(source, ["rev-parse", "HEAD"])).trim();
  } catch {
    return `sha256:${revisionOf(files)}`;
  }
}

async function requireGitWorktree(worktree: string): Promise<void> {
  try {
    await gitOutput(worktree, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new HarnessError(`registered worktree is not a Git checkout: ${worktree}`);
  }
}

function excludeBlock(provider: HarnessProvider): string {
  return [
    "# aidlc-portfolio runtime begin",
    ...DISTRIBUTION_PATHS[provider].map((name) => `/${name}/`),
    "/.aidlc-portfolio/",
    "# aidlc-portfolio runtime end",
  ].join("\n");
}

async function ensureExcludeBlock(worktree: string, provider: HarnessProvider): Promise<void> {
  if (await hasExcludeBlock(worktree, provider)) return;
  const exclude = await excludePath(worktree);
  let content = "";
  try {
    content = await readFile(exclude, "utf8");
  } catch {
    // Git may not have created the repository-local exclude file yet.
  }
  const next = `${content.replace(/\s+$/, "")}${content.trim() ? "\n\n" : ""}${excludeBlock(provider)}\n`;
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, next);
}

async function hasExcludeBlock(worktree: string, provider: HarnessProvider): Promise<boolean> {
  try {
    return (await readFile(await excludePath(worktree), "utf8")).includes(excludeBlock(provider));
  } catch {
    return false;
  }
}

async function excludePath(worktree: string): Promise<string> {
  const path = (await gitOutput(worktree, ["rev-parse", "--git-path", "info/exclude"]))
    .trim();
  return resolve(worktree, path);
}

async function replaceDirectory(source: string, target: string): Promise<void> {
  const backup = `${target}.backup-${crypto.randomUUID()}`;
  let hadTarget = false;
  try {
    await lstat(target);
    hadTarget = true;
    await rename(target, backup);
  } catch (error) {
    if (hadTarget || !isMissingPathError(error)) throw error;
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget) await rename(backup, target);
    throw error;
  }
}

async function replaceWorktreeDistribution(
  temporary: string,
  worktree: string,
  provider: HarnessProvider,
): Promise<void> {
  const backup = join(worktree, `.aidlc-portfolio-backup-${crypto.randomUUID()}`);
  const names = DISTRIBUTION_PATHS[provider];
  const backedUp: string[] = [];
  const installed: string[] = [];
  await mkdir(backup);
  try {
    for (const name of names) {
      const target = join(worktree, name);
      try {
        await lstat(target);
        await rename(target, join(backup, name));
        backedUp.push(name);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    for (const name of names) {
      await rename(join(temporary, name), join(worktree, name));
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) {
      await rm(join(worktree, name), { recursive: true, force: true });
    }
    for (const name of backedUp) {
      await rename(join(backup, name), join(worktree, name));
    }
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

async function gitOutput(worktree: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", worktree, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new HarnessError(
      `git ${args.join(" ")} failed in ${worktree}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new HarnessError(`cannot read JSON ${path}: ${errorMessage(error)}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function harnessRoot(root: string, provider: HarnessProvider): string {
  return join(root, "harness", provider);
}

export function requireProvider(value: string): HarnessProvider {
  if (value !== "claude" && value !== "codex") {
    throw new HarnessError(`unsupported harness provider: ${value}`);
  }
  return value;
}

function resolveInside(root: string, value: string, boundary: string): string {
  const resolved = resolve(root, value);
  const relativePath = relative(resolve(boundary), resolved);
  if (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  ) {
    return resolved;
  }
  throw new HarnessError(`${value} must resolve inside ${resolve(boundary)}`);
}

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function revisionOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key]);
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
