import { realpathSync } from "fs";
import { dirname } from "path";
import { Agent, Cursor, CursorAgentError, type ToolName } from "@cursor/sdk";
import { App, FileSystemAdapter } from "obsidian";
import type { LMVoiceSettings } from "./settings";
import { CURSOR_MODELS } from "./voices";

export function vaultPath(app: App): string {
  const ad = app.vault.adapter;
  if (ad instanceof FileSystemAdapter) return ad.getBasePath();
  throw new Error("Cursor chat needs a local desktop vault.");
}

function workspace(app: App, folder: string): string {
  const root = vaultPath(app);
  const f = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return f ? `${root}/${f}` : root;
}

export async function listCursorModels(apiKey: string): Promise<string[]> {
  try {
    const rows = await Cursor.models.list({ apiKey });
    const ids = rows.map((m) => m.id).filter(Boolean);
    return ids.length ? ids : CURSOR_MODELS.map((m) => m.id);
  } catch {
    return CURSOR_MODELS.map((m) => m.id);
  }
}

function toolOpts(s: LMVoiceSettings): { tools?: ToolName[]; disallowedTools?: ToolName[] } {
  const deny: ToolName[] = ["delete"];
  if (!s.allowInternet) deny.push("webFetch", "webSearch");
  if (!s.editFiles) {
    const tools: ToolName[] = ["read", "grep", "glob", "ls", "semSearch"];
    if (s.allowInternet) tools.push("webFetch", "webSearch");
    return { tools, disallowedTools: ["delete"] };
  }
  return { disallowedTools: deny };
}

function hintArgv(): string | undefined {
  try {
    return typeof __filename === "string" ? realpathSync(__filename) : undefined;
  } catch {
    return undefined;
  }
}

type ToolFn = (name: string, detail: string) => void;

export class CursorVaultChat {
  private agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  private primed = false;
  private fp = "";

  constructor(
    private app: App,
    private apiKey: () => Promise<string>,
    private settings: () => LMVoiceSettings
  ) {}

  reset() {
    const a = this.agent;
    this.agent = null;
    this.primed = false;
    this.fp = "";
    try {
      a?.close();
    } catch {
      /* already closed */
    }
  }

  async send(user: string, system: string, onTool: ToolFn): Promise<string> {
    const s = this.settings();
    const fp = [s.llmModel, s.editFiles, s.allowInternet, s.notesFolder].join("|");
    if (this.fp && this.fp !== fp) this.reset();
    if (!this.agent) {
      this.agent = await this.create(s);
      this.fp = fp;
    }
    const text = this.primed ? user : `${system}\n\n${user}`;
    this.primed = true;
    try {
      const run = await this.agent.send(text);
      try {
        for await (const event of run.stream()) {
          if (event.type === "tool_call") onTool(event.name, event.status);
        }
      } catch {
        /* wait() still settles the run */
      }
      const result = await run.wait();
      if (result.status === "error") {
        throw new Error(result.error?.message || "Cursor run failed.");
      }
      return (result.result || "").trim();
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(err.message || "Cursor could not start.");
      }
      throw err;
    }
  }

  private async create(s: LMVoiceSettings) {
    const hint = hintArgv();
    const prev = process.argv[1];
    if (hint) process.argv[1] = hint;
    try {
      return await Agent.create({
        apiKey: await this.apiKey(),
        model: { id: s.llmModel || "composer-2.5" },
        local: { cwd: workspace(this.app, s.notesFolder) },
        ...toolOpts(s),
      });
    } finally {
      if (hint) process.argv[1] = prev ?? "";
    }
  }
}

void dirname;
