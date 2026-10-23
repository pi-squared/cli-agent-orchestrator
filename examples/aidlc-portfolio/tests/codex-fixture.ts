import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { initializeWorkspace, registerDocument, createWorktree } from "../skills/aidlc-portfolio/scripts/lib.ts";

export async function createCodexFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex portfolio "));
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

export async function yaml(root: string, name: string, value: unknown) {
  const path = join(root, name);
  await writeFile(path, stringify(value));
  return path;
}

export async function git(directory: string, args: string[]) {
  return run(["git", "-C", directory, ...args]);
}

export async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr || stdout}`);
  return stdout;
}
