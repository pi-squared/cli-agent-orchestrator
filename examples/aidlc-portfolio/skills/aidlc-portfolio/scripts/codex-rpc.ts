/** Uses the installed Codex's hashes and TOML editor instead of duplicating them. */
export class StdioRpc {
  private process: Bun.Subprocess<"pipe", "pipe", "ignore">;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(command: string[], cwd: string) {
    this.process = Bun.spawn(command, { cwd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void this.read();
  }

  private async read() {
    try {
      const reader = this.process.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          const request = this.pending.get(response.id);
          if (!request) continue;
          this.pending.delete(response.id);
          if (response.error) request.reject(new Error(`Codex ${response.error.message}`));
          else request.resolve(response.result);
        }
      }
    } catch { /* Exit and transport errors reject all pending calls below. */ }
    finally {
      for (const request of this.pending.values()) request.reject(new Error("Codex app-server exited"));
      this.pending.clear();
    }
  }

  notify(method: string, params?: unknown): void {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
    this.process.stdin.flush();
  }

  async call(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          this.process.stdin.flush();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Codex ${method} timed out`)), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
      this.pending.delete(id);
    }
  }

  close(): void {
    // app-server can defer SIGTERM during shutdown; this helper owns no threads.
    this.process.kill("SIGKILL");
  }
}

export class CodexRpc extends StdioRpc {
  constructor(cwd: string, trustForInspection: string[] = []) {
    // app-server rejects --profile in 0.164. The worker profile contains policy
    // settings only; all hooks live in inspected project layers.
    const args = ["codex"];
    if (trustForInspection.length) {
      // Discovery only: no thread or hook runs under these temporary overrides.
      args.push("-c", `projects={${trustForInspection.map((path) => `${JSON.stringify(path)}={trust_level="trusted"}`).join(",")}}`);
    }
    super([...args, "app-server"], cwd);
  }

  async initialize(): Promise<{ codexHome: string; userAgent: string }> {
    const result = await this.call("initialize", {
      clientInfo: { name: "cao-portfolio", version: "1" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return result;
  }
}
