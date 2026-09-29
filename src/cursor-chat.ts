import { realpathSync } from "fs";
import { dirname } from "path";
import { Agent, Cursor, CursorAgentError, type ToolName } from "@cursor/sdk";
import { App, FileSystemAdapter } from "obsidian";
import { clampParams, FALLBACK_MODELS, findModel, paramList, type CursorModel } from "./cursor-models";
import type { LMVoiceSettings } from "./settings";

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

let catalogCache: { at: number; models: CursorModel[] } | null = null;

export async function cursorCatalog(apiKey: string): Promise<CursorModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.models;
  try {
    const rows = await Cursor.models.list({ apiKey });
    const models: CursorModel[] = rows
      .filter((m) => m.id)
      .map((m) => ({
        id: m.id,
        displayName: m.displayName || m.id,
        aliases: m.aliases,
        parameters: m.parameters,
        variants: m.variants,
      }));
    if (models.length) {
      catalogCache = { at: Date.now(), models };
      return models;
    }
  } catch {
    /* account catalog unavailable */
  }
  return FALLBACK_MODELS;
}

export function cursorSelection(s: LMVoiceSettings, models: CursorModel[]): { id: string; params?: { id: string; value: string }[] } {
  const model = findModel(models, s.llmModel || "default") || models[0] || FALLBACK_MODELS[0];
  if (!model) return { id: "default" };
  const params = paramList(clampParams(model, s.cursorParams));
  return params.length ? { id: model.id, params } : { id: model.id };
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
    const fp = [s.llmModel, JSON.stringify(s.cursorParams || {}), s.editFiles, s.allowInternet, s.notesFolder].join("|");
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
      const key = await this.apiKey();
      const model = cursorSelection(s, await cursorCatalog(key));
      return await Agent.create({
        apiKey: key,
        model,
        local: { cwd: workspace(this.app, s.notesFolder) },
        ...toolOpts(s),
      });
    } finally {
      if (hint) process.argv[1] = prev ?? "";
    }
  }
}

void dirname;
