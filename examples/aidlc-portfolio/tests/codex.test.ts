import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  stageHarness,
  syncHarness,
  verifyHarness,
} from "../skills/aidlc-portfolio/scripts/harness.ts";
import {
  advanceLifecycle,
  answerQuestionPacket,
  checkDispatch,
  confirmDiscovery,
  createWorktree,
  initializeWorkspace,
  listQuestionPackets,
  portfolioHarnessProvider,
  registerDocument,
  submitQuestionPacket,
  updateSession,
} from "../skills/aidlc-portfolio/scripts/lib.ts";

const roots: string[] = [];
const cli = fileURLToPath(
  new URL("../skills/aidlc-portfolio/scripts/portfolio.ts", import.meta.url),
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex portfolio", () => {
  test("pins all Codex runtime trees, inherits model settings, and detects drift", async () => {
    const { root, source, worktrees } = await fixture();
    const staged = await stageHarness(root, "codex", source);
    expect((await stageHarness(root, "codex", source)).changed).toBe(false);
    expect((await syncHarness(root, "codex")).changed).toBe(true);
    expect((await syncHarness(root, "codex")).changed).toBe(false);
    expect((await verifyHarness(root, "codex")).ok).toBe(true);

    const manifest = JSON.parse(await readFile(staged.manifestPath, "utf8"));
    expect(manifest.provider).toBe("codex");
    expect(manifest.overlay.opusModel).toBeUndefined();
    for (const worktree of worktrees) {
      expect(await readFile(join(worktree, ".codex/config.toml"), "utf8")).toBe(
        await readFile(join(source, ".codex/config.toml"), "utf8"),
      );
      expect(await git(worktree, ["status", "--short"])).toBe("");
    }

    const skill = join(worktrees[0]!, ".agents/skills/aidlc/SKILL.md");
    await writeFile(skill, "drift\n");
    expect((await verifyHarness(root, "codex")).worktrees[0]?.ok).toBe(false);
    await syncHarness(root, "codex");
    expect((await verifyHarness(root, "codex")).ok).toBe(true);
    await writeFile(join(source, ".codex/hooks.json"), '{"hooks":{"Stop":[]}}\n');
    expect((await verifyHarness(root, "codex")).errors.join("\n")).toContain(
      "source harness changed",
    );
    await expect(stageHarness(root, "codex", source, "opus")).rejects.toThrow(
      "only to the Claude harness",
    );
  });

  test("refuses tracked Codex and shared skill configuration", async () => {
    for (const name of [".codex", ".agents"]) {
      const { root, source, worktrees } = await fixture();
      const worktree = worktrees[0]!;
      await mkdir(join(worktree, name), { recursive: true });
      await writeFile(join(worktree, name, "owned.txt"), "project-owned\n");
      await git(worktree, ["add", `${name}/owned.txt`]);
      await git(worktree, ["commit", "-m", "Project configuration"]);
      await stageHarness(root, "codex", source);
      await expect(syncHarness(root, "codex")).rejects.toThrow(
        "refusing to overwrite tracked harness paths",
      );
      expect(await readFile(join(worktree, name, "owned.txt"), "utf8")).toBe("project-owned\n");
    }
  });

  test("rejects incomplete runtime sources before creating a staged manifest", async () => {
    const { root, source } = await fixture();
    await rm(join(source, ".codex/config.toml"));
    await mkdir(join(source, ".codex/config.toml"));
    await expect(stageHarness(root, "codex", source)).rejects.toThrow(
      "missing a regular .codex/config.toml",
    );
    await expect(readFile(join(root, "harness/codex/manifest.json"))).rejects.toThrow();
  });

  test("pins linked-worktree hooks in each canonical checkout without replacing other configuration", async () => {
    const { root, source } = await fixture();
    const canonical = join(root, "repositories/api/.codex");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "config.toml"), "# canonical project configuration\n");
    await stageHarness(root, "codex", source);
    await syncHarness(root, "codex");
    expect(await readFile(join(canonical, "hooks.json"), "utf8")).toBe(
      await readFile(join(source, ".codex/hooks.json"), "utf8"),
    );
    expect(await readFile(join(canonical, "config.toml"), "utf8")).toBe(
      "# canonical project configuration\n",
    );
    await writeFile(join(canonical, "hooks.json"), "{}\n");
    expect((await verifyHarness(root, "codex")).errors.join("\n")).toContain(
      "canonical Codex hook manifest differs",
    );
    expect((await syncHarness(root, "codex")).changed).toBe(true);
    expect((await verifyHarness(root, "codex")).ok).toBe(true);
  });

  test("preserves tracked canonical hook manifests", async () => {
    const { root, source } = await fixture();
    const canonical = join(root, "repositories/api");
    await mkdir(join(canonical, ".codex"), { recursive: true });
    await writeFile(join(canonical, ".codex/hooks.json"), "project-owned\n");
    await git(canonical, ["add", ".codex/hooks.json"]);
    await git(canonical, ["commit", "-m", "Project hooks"]);
    await stageHarness(root, "codex", source);
    await expect(syncHarness(root, "codex")).rejects.toThrow("tracked canonical Codex hooks");
    expect(await readFile(join(canonical, ".codex/hooks.json"), "utf8")).toBe("project-owned\n");
  });

  test("keeps child state and shared memory when verifying or upgrading a runtime", async () => {
    const { root, source, worktrees } = await fixture();
    await mkdir(join(source, "aidlc/spaces/default/memory"), { recursive: true });
    await writeFile(join(source, "aidlc/active-space"), "default\n");
    await writeFile(join(source, "aidlc/spaces/default/memory/project.md"), "seed memory\n");
    await stageHarness(root, "codex", source);
    await syncHarness(root, "codex");
    const worktree = worktrees[0]!;
    const childState = "aidlc/spaces/default/intents/feature/aidlc-state.md";
    await mkdir(join(worktree, childState, ".."), { recursive: true });
    await writeFile(join(worktree, childState), "waiting for a human answer\n");
    await writeFile(
      join(worktree, "aidlc/spaces/default/memory/project.md"),
      "approved project memory\n",
    );
    await writeFile(join(worktree, "aidlc/active-space"), "feature-space\n");
    expect((await verifyHarness(root, "codex")).ok).toBe(true);
    expect((await syncHarness(root, "codex")).changed).toBe(false);

    await writeFile(join(source, "aidlc/version.txt"), "codex-v2\n");
    await stageHarness(root, "codex", source);
    await syncHarness(root, "codex");
    expect((await verifyHarness(root, "codex")).ok).toBe(true);
    expect(await readFile(join(worktree, childState), "utf8")).toBe("waiting for a human answer\n");
    expect(await readFile(join(worktree, "aidlc/spaces/default/memory/project.md"), "utf8")).toBe(
      "approved project memory\n",
    );
    expect(await readFile(join(worktree, "aidlc/active-space"), "utf8")).toBe("feature-space\n");
    expect(await readFile(join(worktree, "aidlc/version.txt"), "utf8")).toBe("codex-v2\n");
  });

  test("persists provider selection and defaults old portfolios to Claude", async () => {
    const root = await temporaryRoot();
    await initializeWorkspace(root, "legacy", "Legacy");
    const path = join(root, "portfolio/portfolio.yaml");
    await writeFile(path, (await readFile(path, "utf8")).replace("harnessProvider: claude\n", ""));
    expect(await portfolioHarnessProvider(root)).toBe("claude");
    expect((await initializeWorkspace(root, "legacy", "Legacy")).created).toBe(false);
    await expect(initializeWorkspace(root, "legacy", "Legacy", "codex")).rejects.toThrow(
      "already uses the claude harness",
    );

    const { root: codexRoot } = await fixture();
    expect(await portfolioHarnessProvider(codexRoot)).toBe("codex");
    expect(
      (await initializeWorkspace(codexRoot, "codex-demo", "Codex Demo", "codex")).created,
    ).toBe(false);
    await expect(initializeWorkspace(codexRoot, "codex-demo", "Codex Demo")).rejects.toThrow(
      "already uses the codex harness",
    );
  });

  test("dispatches two projects and retains independent human questions across CLI restarts", async () => {
    const { root, source } = await fixture();
    await cliCall("harness", "stage", "--root", root, "--source", source);
    await cliCall("harness", "sync", "--root", root);
    await cliCall("harness", "verify", "--root", root);
    await advanceLifecycle(root, "discover");
    await confirmDiscovery(
      root,
      await yaml(root, "discovery.yaml", {
        schemaVersion: 1,
        organization: { disposition: "unknown", value: "Unknown" },
        businessOutcomes: { disposition: "unknown", values: [] },
        businessCapabilities: { disposition: "unknown", values: [] },
        dependencies: { disposition: "unknown", ids: [] },
        acceptance: {
          acceptedBy: "Test Owner",
          acceptedAt: new Date().toISOString(),
          unknowns: ["organization", "businessOutcomes", "businessCapabilities", "dependencies"],
          deferrals: [],
        },
      }),
    );
    await advanceLifecycle(root, "confirm");
    await advanceLifecycle(root, "plan");
    await advanceLifecycle(root, "dispatch", "Test Owner");

    for (const project of ["api", "web"]) {
      expect((await checkDispatch(root, project, "feature")).harnessProvider).toBe("codex");
      await updateSession(root, "feature", project, "active", `codex-${project}`);
      const generated = join(root, `${project}-question.md`);
      await writeFile(generated, `# ${project} design\n\nChoose A or B.\n\n[Answer]:\n`);
      await submitQuestionPacket(
        root,
        `${project}-design`,
        project,
        "feature",
        "design",
        generated,
      );
    }
    const pending = await cliCall("question", "list", "--root", root, "--status", "pending");
    expect(pending).toContain("api-design");
    expect(pending).toContain("web-design");
    await expect(updateSession(root, "feature", "api", "active")).rejects.toThrow(
      "unanswered human questions",
    );
    await expect(updateSession(root, "feature", "api", "completed")).rejects.toThrow(
      "unanswered human questions",
    );

    const answer = join(root, "human-answer.md");
    await writeFile(
      answer,
      (await readFile(join(root, "portfolio/questions/api-design.md"), "utf8")).replace(
        "[Answer]:",
        "[Answer]: A, retain the existing API.",
      ),
    );
    await cliCall(
      "question",
      "answer",
      "--root",
      root,
      "--id",
      "api-design",
      "--file",
      answer,
      "--mode",
      "chat",
      "--answered-by",
      "Test Owner",
    );
    expect(await listQuestionPackets(root, "api", "feature", "pending")).toHaveLength(0);
    expect(await listQuestionPackets(root, "web", "feature", "pending")).toHaveLength(1);
    const state = JSON.parse(await readFile(join(root, "portfolio/state.json"), "utf8"));
    expect(state.sessions["feature:api"].status).toBe("active");
    expect(state.sessions["feature:web"].status).toBe("waiting");
    expect(state.sessions["feature:api"].terminalId).toBe("codex-api");
    await expect(
      answerQuestionPacket(root, "api-design", answer, "chat", "Test Owner"),
    ).rejects.toThrow("already answered");
  });
});

async function fixture() {
  const root = await temporaryRoot();
  await initializeWorkspace(root, "codex-demo", "Codex Demo", "codex");
  const source = join(root, "codex-distribution");
  await mkdir(join(source, ".codex"), { recursive: true });
  await mkdir(join(source, ".agents/skills/aidlc"), { recursive: true });
  await mkdir(join(source, "aidlc"), { recursive: true });
  await writeFile(
    join(source, ".codex/config.toml"),
    'developer_instructions = "AI-DLC onboarding"\n',
  );
  await writeFile(join(source, ".codex/hooks.json"), '{"hooks":{}}\n');
  await writeFile(join(source, ".agents/skills/aidlc/SKILL.md"), "# AI-DLC for Codex\n");
  await writeFile(join(source, "aidlc/version.txt"), "codex-v1\n");
  for (const id of ["api", "web"]) {
    const repository = join(root, "repositories", id);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.name", "Portfolio Test"]);
    await git(repository, ["config", "user.email", "portfolio@example.com"]);
    await writeFile(join(repository, "README.md"), `# ${id}\n`);
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    await registerDocument(
      root,
      "project",
      await yaml(root, `${id}.yaml`, {
        schemaVersion: 1,
        id,
        name: id,
        repository: `repositories/${id}`,
        description: `${id} project`,
        status: "proposed",
        businessCapabilities: [],
        owners: { team: "Unknown" },
        environments: [],
        components: [{ id: `${id}-service`, name: id, type: "service", criticality: "unknown" }],
        evidence: [],
        confidence: "low",
        lastVerified: "2026-10-23",
      }),
    );
  }
  await registerDocument(
    root,
    "intent",
    await yaml(root, "feature.yaml", {
      schemaVersion: 1,
      id: "feature",
      name: "Feature",
      objective: "Implement the feature",
      status: "proposed",
      businessOutcomes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projects: ["api", "web"].map((project) => ({
        project,
        aidlcIntent: `feature-${project}`,
        branch: "feat/feature",
        worktree: `worktrees/${project}/feature`,
        dependsOn: [],
      })),
    }),
  );
  const worktrees = [];
  for (const id of ["api", "web"]) {
    worktrees.push(await createWorktree(root, id, "feature", "feat/feature", "main"));
  }
  return { root, source, worktrees };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "codex portfolio "));
  roots.push(root);
  return root;
}

async function yaml(root: string, name: string, value: unknown) {
  const path = join(root, name);
  await writeFile(path, stringify(value));
  return path;
}

async function cliCall(...args: string[]) {
  return run([process.execPath, cli, ...args]);
}

async function git(directory: string, args: string[]) {
  return run(["git", "-C", directory, ...args]);
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr || stdout}`);
  return stdout;
}
