import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRepositories, CODEX_PERMISSION_RELAY_COMMAND, registeredWorktrees, verifyHarness } from "./harness.ts";
import {
  atomicWrite, expireQuestionPacket, listQuestionPackets, portfolioHarnessProvider,
  PortfolioError, readHumanDecision, submitQuestionPacket, withLock,
} from "./lib.ts";
import { CodexRpc } from "./codex-rpc.ts";

interface Hook {
  key: string;
  currentHash: string;
  sourcePath: string;
  source: string;
  eventName: string;
  handlerType: string;
  command?: string;
  server?: string;
  tool?: string;
  matcher?: string | null;
  timeoutSec: number;
  enabled: boolean;
  isManaged: boolean;
  trustStatus: string;
}
interface Review {
  schemaVersion: 1;
  root: string;
  project: string;
  intent: string;
  worktree: string;
  canonical: string;
  codexHome: string;
  codexVersion: string;
  manifestRevision: string;
  files: Record<string, string>;
  hooks: Array<Omit<Hook, "trustStatus">>;
}
interface Proposal { id: string; revision: string; review: Review }
export interface WorkerConnection {
  root: string;
  project: string;
  intent: string;
  worktree: string;
  callbackTerminal: string;
  reviewId: string;
  relayHash: string;
}

const relayFile = fileURLToPath(new URL("./codex-permission.ts", import.meta.url));
const workerProfile = "aidlc_portfolio_worker.config.toml";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fileDigest(path: string, text: string): string {
  if (!path.endsWith(`/${workerProfile}`)) return digest(text);
  // Codex persists first-run screen-reader and model-menu preferences here.
  // Bind the runtime policy/settings while leaving those TUI preferences free.
  const profile: any = Bun.TOML.parse(text);
  delete profile.tui;
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return digest(JSON.stringify(stable(profile)));
}
const reviewDirectory = (root: string) => join(root, "portfolio/codex-reviews");
const receiptPath = (root: string, project: string, intent: string) => join(reviewDirectory(root), "receipts", intent, `${project}.json`);
export const connectionPath = (worktree: string) => join(worktree, "aidlc/portfolio-relay/worker.json");

async function regularFile(path: string): Promise<string> {
  // Trust identities cannot silently follow a swapped symlink.
  if ((await realpath(path)) !== resolve(path) || !(await lstat(path)).isFile()) {
    throw new PortfolioError(`expected a regular, unsymlinked file: ${path}`);
  }
  return readFile(path, "utf8");
}

async function target(rootInput: string, project: string, intent: string) {
  const root = await realpath(rootInput);
  if (await portfolioHarnessProvider(root) !== "codex") throw new PortfolioError("Codex portfolio required");
  const matches = await registeredWorktrees(root, project, intent);
  if (matches.length !== 1) throw new PortfolioError("expected one registered Codex worktree");
  const item = matches[0]!;
  if (await realpath(item.path) !== item.path) throw new PortfolioError("worktree path contains a symlink");
  const canonical = (await canonicalRepositories(root, matches))[0] ?? item.path;
  if (await realpath(canonical) !== canonical) throw new PortfolioError("canonical repository contains a symlink");
  const verification = await verifyHarness(root, "codex", project, intent);
  if (!verification.ok || !verification.manifestRevision) throw new PortfolioError("sync and verify the pinned Codex harness before reviewing trust");
  return { root, worktree: item.path, canonical, manifestRevision: verification.manifestRevision };
}

async function inspect(root: string, project: string, intent: string): Promise<Review> {
  const current = await target(root, project, intent);
  const rpc = new CodexRpc(current.root, [current.worktree, current.canonical]);
  try {
    const init = await rpc.initialize();
    const config = await rpc.call("config/read", { includeLayers: true, cwd: current.worktree });
    const profilePath = join(init.codexHome, workerProfile);
    const policy: any = Bun.TOML.parse(await regularFile(profilePath));
    if (policy.sandbox_mode !== "workspace-write" || policy.approval_policy !== "on-request" || policy.approvals_reviewer !== "user" || policy.hooks) {
      throw new PortfolioError("install aidlc_portfolio_worker.config.toml with workspace-write, on-request approvals and user review");
    }
    for (const layer of config.layers ?? []) {
      if (layer.name.type !== "project") continue;
      for (const key of ["sandbox_mode", "approval_policy", "approvals_reviewer"]) {
        if (layer.config[key] !== undefined && layer.config[key] !== policy[key]) throw new PortfolioError(`project configuration overrides the worker's ${key}`);
      }
    }
    const listed = await rpc.call("hooks/list", { cwds: [current.worktree] });
    const entry = listed.data?.[0];
    if (!entry || entry.errors.length) throw new PortfolioError("Codex could not load the worker hooks");
    const hooks: Hook[] = entry.hooks;
    if (!hooks.some((hook) => hook.eventName === "permissionRequest" && hook.sourcePath === join(current.canonical, ".codex/hooks.json") && hook.command === CODEX_PERMISSION_RELAY_COMMAND && hook.enabled)) {
      throw new PortfolioError("sync the pinned portfolio PermissionRequest relay before dispatch");
    }
    const files: Record<string, string> = {};
    for (const path of [relayFile, profilePath, join(current.worktree, ".codex/config.toml"), join(current.canonical, ".codex/hooks.json")]) {
      files[path] = fileDigest(path, await regularFile(path));
    }
    const installedScripts = join(resolve(process.env.CAO_HOME_DIR ?? join(homedir(), ".aws/cli-agent-orchestrator")), "skills/aidlc-portfolio/scripts");
    for (const name of ["codex-permission.ts", "codex.ts", "codex-rpc.ts", "lib.ts", "harness.ts"]) {
      const path = join(installedScripts, name);
      const expected = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
      if (await regularFile(path) !== expected) throw new PortfolioError("install the current portfolio skill before reviewing worker trust");
      files[path] = digest(expected);
    }
    // Include any other project config or hook source in the review. User config
    // is edited by Codex below, so bind its hook definitions through native hashes.
    for (const layer of config.layers ?? []) {
      if (layer.name.type === "project") {
        const path = join(layer.name.dotCodexFolder, "config.toml");
        try { files[path] = digest(await regularFile(path)); } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    for (const hook of hooks) {
      if (hook.source === "project") files[hook.sourcePath] = digest(await regularFile(hook.sourcePath));
    }
    return {
      schemaVersion: 1, ...current, project, intent,
      codexHome: init.codexHome, codexVersion: init.userAgent,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
      hooks: hooks.map(({ trustStatus, ...definition }) => definition).sort((a, b) => a.key.localeCompare(b.key)),
    };
  } finally { rpc.close(); }
}

export async function reviewCodexStartup(root: string, project: string, intent: string) {
  const review = await inspect(root, project, intent);
  const revision = digest(JSON.stringify(review));
  const prefix = `codex-${intent}-${project}-${revision.slice(0, 16)}`;
  const packets = await listQuestionPackets(review.root, project, intent);
  const previous = packets.filter((packet) => packet.id.startsWith(prefix)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  let id = previous?.id ?? prefix;
  if (previous?.status === "expired" || (previous?.status === "answered" && (await readHumanDecision(review.root, previous.id)).decision === "reject")) {
    id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  } else if (previous?.status === "answered") {
    let applied = false;
    try { applied = JSON.parse(await readFile(receiptPath(review.root, project, intent), "utf8")).id === id; } catch { /* Not applied yet. */ }
    if (applied) {
      try { await verifyCodexStartup(review.root, project, intent); }
      catch { id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`; }
    }
  }
  const proposal: Proposal = { id, revision, review };
  await mkdir(reviewDirectory(review.root), { recursive: true });
  const path = join(reviewDirectory(review.root), `${id}.json`);
  // Immutable review identity: a changed runtime receives a new packet.
  try { await writeFile(path, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  if (!packets.some((packet) => packet.id === id)) {
    for (const previous of packets.filter((packet) => packet.kind === "startup" && packet.status === "pending")) {
      await expireQuestionPacket(review.root, previous.id);
    }
    const document = join(reviewDirectory(review.root), `${id}.md`);
    const commands = review.hooks.map((hook) => `- ${hook.eventName}; source ${JSON.stringify(hook.sourcePath)}; matcher ${JSON.stringify(hook.matcher ?? null)}; timeout ${hook.timeoutSec}s; ${hook.enabled ? "enabled" : "disabled"}; ${hook.currentHash}\n  ${JSON.stringify(hook.command ?? { server: hook.server, tool: hook.tool })}`).join("\n");
    await atomicWrite(document, `# Codex startup approval: ${project} / ${intent}\n\nReview: ${id}\nRuntime: ${review.manifestRevision}\nWorktree: ${review.worktree}\nCanonical repository: ${review.canonical}\nUser configuration: ${join(review.codexHome, "config.toml")}\n\nTrust these exact project directories and the enabled hook definitions below. This includes the command approval relay: later permission requests come back to this supervisor and require a separate, single-use human decision. Project configuration and scripts are pinned in the accompanying review JSON.\n\n${commands}\n\nApprove this startup configuration? Answer exactly approve or reject.\n\n[Answer]:\n`);
    await submitQuestionPacket(review.root, id, project, intent, "codex-startup", document, "startup");
  }
  return { id, path, questionPath: join(review.root, "portfolio/questions", `${id}.md`), review };
}

async function proposal(root: string, id: string): Promise<Proposal> {
  if (!/^codex-[a-z0-9-]+$/.test(id)) throw new PortfolioError("invalid Codex review ID");
  const value: Proposal = JSON.parse(await regularFile(join(reviewDirectory(root), `${id}.json`)));
  if (value.id !== id || value.revision !== digest(JSON.stringify(value.review)) || value.review.root !== await realpath(root)) {
    throw new PortfolioError("Codex startup review was altered");
  }
  return value;
}

export async function trustCodexStartup(rootInput: string, id: string, callbackTerminal: string) {
  const root = await realpath(rootInput);
  if (!/^[a-zA-Z0-9_-]+$/.test(callbackTerminal)) throw new PortfolioError("callback terminal ID required");
  const reviewed = await proposal(root, id);
  const human = await readHumanDecision(root, id);
  if (human.decision !== "approve") throw new PortfolioError("human rejected Codex startup; worker remains stopped");
  const current = await inspect(root, reviewed.review.project, reviewed.review.intent);
  if (digest(JSON.stringify(current)) !== reviewed.revision) throw new PortfolioError("startup configuration changed; generate a fresh Codex review");
  let applied = false;
  try { applied = JSON.parse(await readFile(receiptPath(root, current.project, current.intent), "utf8")).id === id; } catch { /* First application. */ }
  if (applied) {
    // A supervisor restart can rebind its callback, but cannot silently restore
    // trust that an operator subsequently revoked.
    await verifyCodexStartup(root, current.project, current.intent, true);
    const path = connectionPath(current.worktree);
    const connection = JSON.parse(await regularFile(path));
    await atomicWrite(path, `${JSON.stringify({ ...connection, callbackTerminal }, null, 2)}\n`);
    return { id, ready: true, project: current.project, intent: current.intent };
  }
  const rpc = new CodexRpc(root);
  try {
    await rpc.initialize();
    const config = await rpc.call("config/read", { includeLayers: true });
    const user = config.layers.find((layer: any) => layer.name.type === "user" && !layer.name.profile);
    if (!user) throw new PortfolioError("Codex user config layer not found");
    // Codex edits only the approved keys, preserves comments and unrelated
    // settings, and rejects writes if another process changed the file.
    const edits = [current.canonical, current.worktree].map((path) => ({
      keyPath: `projects.${JSON.stringify(path)}.trust_level`, value: "trusted", mergeStrategy: "replace",
    }));
    for (const hook of current.hooks.filter((hook) => !hook.isManaged && hook.enabled)) {
      edits.push({ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" });
    }
    await rpc.call("config/batchWrite", { filePath: user.name.file, expectedVersion: user.version, edits });
  } finally { rpc.close(); }
  await withLock(root, async () => {
    await atomicWrite(receiptPath(root, current.project, current.intent), `${JSON.stringify({ id, revision: reviewed.revision, ...human }, null, 2)}\n`);
    const connection: WorkerConnection = {
      root, project: current.project, intent: current.intent, worktree: current.worktree,
      callbackTerminal, reviewId: id, relayHash: current.files[relayFile]!,
    };
    await atomicWrite(connectionPath(current.worktree), `${JSON.stringify(connection, null, 2)}\n`);
  });
  await verifyCodexStartup(root, current.project, current.intent, true);
  return { id, ready: true, project: current.project, intent: current.intent };
}

export async function verifyCodexStartup(rootInput: string, project: string, intent: string, native = false) {
  const root = await realpath(rootInput);
  let receipt: { id: string; revision: string };
  try { receipt = JSON.parse(await regularFile(receiptPath(root, project, intent))); }
  catch { throw new PortfolioError(`supervisor startup approval required for ${intent}:${project}; run codex review`); }
  const approved = await proposal(root, receipt.id);
  const current = await target(root, project, intent);
  if (approved.revision !== receipt.revision || approved.review.manifestRevision !== current.manifestRevision || approved.review.worktree !== current.worktree || approved.review.canonical !== current.canonical) {
    throw new PortfolioError("Codex startup approval is stale; run codex review");
  }
  if ((await readHumanDecision(root, receipt.id)).decision !== "approve") throw new PortfolioError("Codex startup was not approved");
  const expectedHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (approved.review.codexHome !== expectedHome) throw new PortfolioError("Codex home changed; review worker startup in the effective environment");
  for (const [path, hash] of Object.entries(approved.review.files)) {
    if (fileDigest(path, await regularFile(path)) !== hash) throw new PortfolioError(`approved Codex configuration changed: ${path}`);
  }
  const config: any = Bun.TOML.parse(await regularFile(join(expectedHome, "config.toml")));
  for (const path of [current.worktree, current.canonical]) {
    if (config.projects?.[path]?.trust_level !== "trusted") throw new PortfolioError(`Codex project trust missing: ${path}`);
  }
  for (const hook of approved.review.hooks.filter((hook) => hook.enabled && !hook.isManaged)) {
    const state = config.hooks?.state?.[hook.key];
    if (state?.trusted_hash !== hook.currentHash || state?.enabled === false) throw new PortfolioError(`Codex hook trust missing: ${hook.key}`);
  }
  const connection: WorkerConnection = JSON.parse(await regularFile(connectionPath(current.worktree)));
  if (connection.reviewId !== receipt.id || connection.root !== root || connection.project !== project || connection.intent !== intent || connection.worktree !== current.worktree || !connection.callbackTerminal) {
    throw new PortfolioError("worker supervisor connection is missing or stale; repeat codex trust with the current callback terminal");
  }
  if (native) {
    if (digest(JSON.stringify(await inspect(root, project, intent))) !== approved.revision) throw new PortfolioError("effective Codex startup changed; run codex review");
    const rpc = new CodexRpc(root);
    try {
      await rpc.initialize();
      const listed = await rpc.call("hooks/list", { cwds: [current.worktree] });
      const entry = listed.data?.[0];
      if (!entry || entry.errors.length || entry.hooks.some((hook: Hook) => hook.enabled && !["trusted", "managed"].includes(hook.trustStatus))) {
        throw new PortfolioError("native Codex hook trust verification failed");
      }
    } finally { rpc.close(); }
  }
  return { ready: true, id: receipt.id, worktree: current.worktree };
}
