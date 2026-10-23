import { cp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestionPacket } from "../skills/aidlc-portfolio/scripts/lib.ts";
import { trustCodexStartup } from "../skills/aidlc-portfolio/scripts/codex.ts";

export async function answer(root: string, id: string, decision: string) {
  const file = join(root, `${id}-answer.md`);
  await writeFile(file, (await readFile(join(root, "portfolio/questions", `${id}.md`), "utf8")).replace(/^\[Answer\]:.*$/m, `[Answer]: ${decision}`));
  return answerQuestionPacket(root, id, file, "chat", "Synthetic test operator");
}

export async function approveStartup(root: string, project: string) {
  const cli = fileURLToPath(new URL("../skills/aidlc-portfolio/scripts/portfolio.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "codex", "review", "--root", root, "--project", project, "--intent", "feature"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  const review = JSON.parse(text);
  await answer(root, review.id, "approve");
  await trustCodexStartup(root, review.id, "supervisor-test");
  return review;
}

export async function installFakeCodex(root: string) {
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CAO_HOME_DIR: process.env.CAO_HOME_DIR };
  const bin = join(root, "bin");
  const home = join(root, "codex-home");
  const cao = join(root, "cao-home");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  await cp(fileURLToPath(new URL("../skills/aidlc-portfolio", import.meta.url)), join(cao, "skills/aidlc-portfolio"), { recursive: true });
  await cp(fileURLToPath(new URL("../codex/aidlc_portfolio_worker.config.toml", import.meta.url)), join(home, "aidlc_portfolio_worker.config.toml"));
  await writeFile(join(home, "config.toml"), '# preserved comment\nmodel = "configured-model"\n[projects."/unrelated"]\ntrust_level = "untrusted"\n');
  await writeFile(join(bin, "codex"), `#!${process.execPath}\n` + await readFile(new URL("./fake-codex.ts.txt", import.meta.url), "utf8"));
  await chmod(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.CODEX_HOME = home;
  process.env.CAO_HOME_DIR = cao;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}
