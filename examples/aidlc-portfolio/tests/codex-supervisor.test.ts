import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexFixture } from "./codex-fixture.ts";
import { answer, approveStartup, installFakeCodex } from "./codex-test-runtime.ts";
import { reviewCodexStartup, trustCodexStartup, verifyCodexStartup } from "../skills/aidlc-portfolio/scripts/codex.ts";
import { relayPermission } from "../skills/aidlc-portfolio/scripts/codex-permission.ts";
import { CODEX_PERMISSION_RELAY_COMMAND, stageHarness, syncHarness } from "../skills/aidlc-portfolio/scripts/harness.ts";
import { listQuestionPackets } from "../skills/aidlc-portfolio/scripts/lib.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const fixture = await createCodexFixture();
  cleanups.push(() => rm(fixture.root, { recursive: true, force: true }));
  const restore = await installFakeCodex(fixture.root);
  cleanups.push(async () => restore());
  await writeFile(join(fixture.source, ".codex/hooks.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: "echo pinned-runtime", timeout: 3 }] }],
  } }));
  await stageHarness(fixture.root, "codex", fixture.source);
  await syncHarness(fixture.root, "codex");
  return fixture;
}
async function active(root: string, project = "api") {
  // The ordinary lifecycle/dispatch gates are covered by codex.test.ts. This
  // fixture starts at the native hook boundary with a registered active child.
  const path = join(root, "portfolio/state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.sessions[`feature:${project}`] = { status: "active", terminalId: `worker-${project}`, updatedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(state));
}
const input = (cwd: string, command: string) => ({ cwd, tool_name: "Bash", tool_input: { command, description: "Synthetic permission acceptance test" } });
const behavior = (result: any) => result.hookSpecificOutput.decision.behavior;

describe("supervisor-only Codex approvals", () => {
  test("queues startup before dispatch and requires a real answer before applying trust", async () => {
    const { root } = await setup();
    const review = await reviewCodexStartup(root, "api", "feature");
    expect((await reviewCodexStartup(root, "api", "feature")).id).toBe(review.id);
    expect((await listQuestionPackets(root, "api", "feature", "pending"))[0]?.kind).toBe("startup");
    expect(JSON.parse(await readFile(join(root, "portfolio/state.json"), "utf8")).sessions["feature:api"].status).toBe("pending");
    await expect(trustCodexStartup(root, review.id, "supervisor-test")).rejects.toThrow("requires a human answer");
    await expect(verifyCodexStartup(root, "api", "feature")).rejects.toThrow("supervisor startup approval required");
    await answer(root, review.id, "approve");
    await trustCodexStartup(root, review.id, "supervisor-test");
    expect((await verifyCodexStartup(root, "api", "feature", true)).ready).toBe(true);
    const config = await readFile(join(process.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).toContain("preserved comment");
    expect((Bun.TOML.parse(config) as any).model).toBe("configured-model");
    expect((Bun.TOML.parse(config) as any).projects["/unrelated"].trust_level).toBe("untrusted");
    await trustCodexStartup(root, review.id, "restarted-supervisor");
    expect(JSON.parse(await readFile(join(root, "worktrees/api/feature/aidlc/portfolio-relay/worker.json"), "utf8")).callbackTerminal).toBe("restarted-supervisor");
  }, 15_000);

  test("rejects startup and permits a fresh human reconsideration", async () => {
    const { root } = await setup();
    const original = await readFile(join(process.env.CODEX_HOME!, "config.toml"), "utf8");
    const review = await reviewCodexStartup(root, "api", "feature");
    await answer(root, review.id, "reject");
    await expect(trustCodexStartup(root, review.id, "supervisor-test")).rejects.toThrow("rejected");
    expect(await readFile(join(process.env.CODEX_HOME!, "config.toml"), "utf8")).toBe(original);
    const fresh = await reviewCodexStartup(root, "api", "feature");
    expect(fresh.id).not.toBe(review.id);
    await answer(root, fresh.id, "approve");
    await trustCodexStartup(root, fresh.id, "supervisor-test");
  }, 15_000);

  test("binds human approval to the runtime revision and never carries it to another project", async () => {
    const { root, source } = await setup();
    const review = await reviewCodexStartup(root, "api", "feature");
    await answer(root, review.id, "approve");
    await writeFile(join(source, "aidlc/version.txt"), "runtime-upgrade\n");
    await stageHarness(root, "codex", source); await syncHarness(root, "codex");
    await expect(trustCodexStartup(root, review.id, "supervisor-test")).rejects.toThrow("changed");
    const fresh = await reviewCodexStartup(root, "api", "feature");
    expect(fresh.id).not.toBe(review.id);
    await answer(root, fresh.id, "approve"); await trustCodexStartup(root, fresh.id, "supervisor-test");
    await expect(verifyCodexStartup(root, "web", "feature")).rejects.toThrow("approval required");
  }, 15_000);

  test("detects revoked hook trust and requires fresh consent", async () => {
    const { root } = await setup();
    const review = await approveStartup(root, "api");
    const configPath = join(process.env.CODEX_HOME!, "config.toml");
    await writeFile(configPath, (await readFile(configPath, "utf8")).replaceAll('"sha256:', '"revoked:'));
    await expect(verifyCodexStartup(root, "api", "feature")).rejects.toThrow("hook trust missing");
    await expect(trustCodexStartup(root, review.id, "supervisor-test")).rejects.toThrow("hook trust missing");
    expect((await reviewCodexStartup(root, "api", "feature")).id).not.toBe(review.id);
  }, 15_000);

  test("allows Codex to persist TUI preferences while detecting worker policy changes", async () => {
    const { root } = await setup(); await approveStartup(root, "api");
    const path = join(process.env.CODEX_HOME!, "aidlc_portfolio_worker.config.toml");
    const profile = await readFile(path, "utf8");
    await writeFile(path, `${profile}\n[tui]\nscreen_reader_detection_done = true\n`);
    expect((await verifyCodexStartup(root, "api", "feature", true)).ready).toBe(true);
    await writeFile(path, profile.replace('approval_policy = "on-request"', 'approval_policy = "never"'));
    await expect(verifyCodexStartup(root, "api", "feature")).rejects.toThrow("configuration changed");
  }, 15_000);

  test("returns a single-use native allow only after the supervisor records the exact request", async () => {
    const { root, worktrees } = await setup(); await approveStartup(root, "api"); await active(root);
    const seen: string[] = [];
    const options = { notify: async (_: unknown, id: string) => {
      seen.push(id);
      expect(await readFile(join(root, "portfolio/questions", `${id}.md`), "utf8")).toContain('"command":"echo approved"');
      await answer(root, id, "approve");
    }, pollMs: 1 };
    expect(behavior(await relayPermission(input(worktrees[0]!, "echo approved"), options))).toBe("allow");
    expect(behavior(await relayPermission(input(worktrees[0]!, "echo approved"), options))).toBe("allow");
    expect(seen[0]).not.toBe(seen[1]);
    const receipt = JSON.parse(await readFile(join(worktrees[0]!, "aidlc/portfolio-relay", `${seen[0]}.consumed.json`), "utf8"));
    expect(receipt.answeredBy).toBe("Synthetic test operator");
  }, 15_000);

  test("relays concurrent native subagent requests without resuming the other request", async () => {
    const { root, worktrees } = await setup(); await approveStartup(root, "api"); await active(root);
    const ids: string[] = [];
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => release = resolve);
    const notify = async (_: unknown, id: string) => { ids.push(id); if (ids.length === 2) release(); };
    const one = relayPermission(input(worktrees[0]!, "echo one"), { notify, pollMs: 2 });
    const two = relayPermission(input(worktrees[0]!, "echo two"), { notify, pollMs: 2 });
    await arrived;
    await answer(root, ids[0]!, "approve");
    expect((await listQuestionPackets(root, "api", "feature", "pending"))).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "portfolio/state.json"), "utf8")).sessions["feature:api"].status).toBe("waiting");
    await answer(root, ids[1]!, "reject");
    expect([behavior(await one), behavior(await two)].sort()).toEqual(["allow", "deny"]);
  }, 15_000);

  test("delivers through the installed CAO MCP command without assuming a Python environment", async () => {
    const { root, worktrees } = await setup(); await approveStartup(root, "api"); await active(root);
    const delivered = join(root, "delivered.json");
    const executable = join(root, "bin/cao-mcp-server");
    await writeFile(executable, `#!${process.execPath}\nimport {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs'; createInterface({input:process.stdin}).on('line', line => {const r=JSON.parse(line);if(!r.id)return;if(r.method==='tools/call')writeFileSync(${JSON.stringify(delivered)},JSON.stringify(r.params));console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:{structuredContent:{success:true},content:[]}}));});`);
    await chmod(executable, 0o755);
    const result = relayPermission(input(worktrees[0]!, "echo delivered"), { timeoutMs: 5000, pollMs: 2 });
    let message: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { message = JSON.parse(await readFile(delivered, "utf8")); break; } catch { await Bun.sleep(10); }
    }
    expect(message?.arguments.receiver_id).toBe("supervisor-test");
    const id = message.arguments.message.match(/packet (permission-[a-z0-9-]+)/)[1];
    await answer(root, id, "approve");
    expect(behavior(await result)).toBe("allow");
  }, 15_000);

  test("returns native denial if the installed relay cannot start", async () => {
    const { root } = await setup();
    const child = Bun.spawn(["sh", "-c", CODEX_PERMISSION_RELAY_COMMAND], {
      env: { ...process.env, CAO_HOME_DIR: join(root, "missing-installation") },
      stdin: new Blob(["{}"]), stdout: "pipe", stderr: "ignore",
    });
    const response = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(behavior(response)).toBe("deny");
  }, 15_000);

  test("fails closed on rejection, missing connection, expiry, and delivery failure", async () => {
    const { root, worktrees } = await setup(); await approveStartup(root, "api"); await active(root);
    expect(behavior(await relayPermission(input(worktrees[1]!, "echo missing")))).toBe("deny");
    expect(behavior(await relayPermission(input(worktrees[0]!, "echo rejected"), { notify: async (_, id) => { await answer(root, id, "reject"); } }))).toBe("deny");
    expect(behavior(await relayPermission(input(worktrees[0]!, "echo timeout"), { notify: async () => {}, timeoutMs: 20, pollMs: 2 }))).toBe("deny");
    expect(behavior(await relayPermission(input(worktrees[0]!, "echo delivery"), { notify: async () => { throw new Error("offline"); } }))).toBe("deny");
    const expired = await listQuestionPackets(root, "api", "feature", "expired");
    expect(expired).toHaveLength(2);
    await expect(answer(root, expired[0]!.id, "approve")).rejects.toThrow("already expired");
    expect(await listQuestionPackets(root, "api", "feature", "pending")).toHaveLength(0);
  }, 15_000);
});
