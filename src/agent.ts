import { App, normalizePath, requestUrl } from "obsidian";
import { chatHeaders, chatRoot, defaultChatModel, parseJson } from "./providers";
import type { LMVoiceSettings } from "./settings";

export type ChatMsg = { role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string };

type ToolCall = { id: string; function: { name: string; arguments: string } };

const CTX_PER_NOTE = 1200;
const CTX_TOTAL = 2400;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

const TOOL_LIST = tool("list_files", "List markdown files in a vault folder.", {
  folder: { type: "string", description: "Vault-relative folder. Empty = vault root or the allowed folder." },
}, []);
const TOOL_READ = tool("read_file", "Read a markdown note.", { path: { type: "string" } }, ["path"]);
const TOOL_CREATE = tool("create_file", "Create a new markdown note. Fails if it exists.", {
  path: { type: "string" },
  content: { type: "string" },
}, ["path", "content"]);
const TOOL_EDIT = tool("edit_file", "Replace the full contents of an existing markdown note.", {
  path: { type: "string" },
  content: { type: "string" },
}, ["path", "content"]);
const TOOL_PATCH = tool("patch_file", "Replace one exact substring in a markdown note.", {
  path: { type: "string" },
  old: { type: "string" },
  new: { type: "string" },
}, ["path", "old", "new"]);
const TOOL_DELETE = tool("delete_file", "Move a markdown note to the Obsidian trash.", {
  path: { type: "string" },
}, ["path"]);
const TOOL_FETCH = tool("fetch_url", "Fetch a public http(s) page and return plain text.", {
  url: { type: "string" },
}, ["url"]);

export function compactNote(src: string, max: number): string {
  let t = src.replace(/^---[\s\S]*?---\s*/, "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/\[\[[^\]|#/]+[|#]([^\]]+)\]\]/g, "$1");
  t = t.replace(/\[\[([^\]|#]+)\]\]/g, "$1");
  t = t.replace(/^#+\s+/gm, "");
  t = t.replace(/^[>|*+-]+\s?/gm, "");
  t = t.replace(/[`*_~]/g, "");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/[ \t]+/g, " ");
  return t.replace(/\s+\n/g, "\n").trim().slice(0, max);
}

export class VaultAgent {
  constructor(
    private app: App,
    private settings: () => LMVoiceSettings,
    private key: () => Promise<string>
  ) {}

  private canWrite(): boolean {
    const s = this.settings();
    return s.allowTools && !s.readOnly;
  }

  async systemText(): Promise<string> {
    const s = this.settings();
    const file = this.app.workspace.getActiveFile()?.path || "(none)";
    const d = new Date().toISOString().slice(0, 10);
    const caps: string[] = [];
    if (!s.allowTools) caps.push("no tools (talk only)");
    else {
      if (s.allowList) caps.push("list");
      if (s.allowRead) caps.push("read");
      if (this.canWrite() && s.allowCreate) caps.push("create");
      if (this.canWrite() && s.allowEdit) caps.push("edit");
      if (this.canWrite() && s.allowDelete) caps.push("delete (trash)");
      if (s.allowInternet) caps.push("fetch http(s)");
    }
    if (s.readOnly) caps.push("read-only");
    if (s.activeFileOnly) caps.push("active file only");
    const scope = s.notesFolder ? `Only inside folder: ${normalizePath(s.notesFolder)}.` : "Whole vault.";
    const extra = `\nYou may ${caps.join(", ") || "not change files"}. ${scope}`;
    const persona = await this.loadPersonality();
    const ctx = await this.loadContextNotes();
    return s.systemPrompt.replaceAll("{{date}}", d).replaceAll("{{file}}", file) + extra + persona + ctx;
  }

  private async loadPersonality(): Promise<string> {
    const raw = (this.settings().personalityFile || "Personality.md").trim();
    if (!raw) return "";
    const path = normalizePath(raw.replace(/^\[\[|\]\]$/g, ""));
    const file =
      this.app.vault.getFileByPath(path.endsWith(".md") ? path : `${path}.md`) || this.app.vault.getFileByPath(path);
    if (!file) return "";
    const body = (await this.app.vault.read(file)).replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 2000);
    return body ? `\n\nPersonality:\n${body}` : "";
  }

  private async loadContextNotes(): Promise<string> {
    const raw = this.settings().contextNotes || "";
    const paths = raw
      .split(/[\n,]/)
      .map((p) => normalizePath(p.trim().replace(/^\[\[|\]\]$/g, "")))
      .filter(Boolean)
      .slice(0, 6);
    if (!paths.length) return "";
    const chunks: string[] = [];
    let used = 0;
    for (const path of paths) {
      const file = this.app.vault.getFileByPath(path.endsWith(".md") ? path : `${path}.md`) || this.app.vault.getFileByPath(path);
      if (!file) continue;
      const room = Math.min(CTX_PER_NOTE, CTX_TOTAL - used);
      if (room < 80) break;
      const compact = compactNote(await this.app.vault.read(file), room);
      if (!compact) continue;
      chunks.push(`\n[${file.path}]\n${compact}`);
      used += compact.length;
    }
    return chunks.length ? `\n\nContext notes (compact):${chunks.join("\n")}` : "";
  }

  private tools() {
    const s = this.settings();
    if (!s.allowTools) return [];
    const out = [];
    if (s.allowList && !s.activeFileOnly) out.push(TOOL_LIST);
    if (s.allowRead) out.push(TOOL_READ);
    if (this.canWrite() && s.allowCreate && !s.activeFileOnly) out.push(TOOL_CREATE);
    if (this.canWrite() && s.allowEdit) out.push(TOOL_EDIT, TOOL_PATCH);
    if (this.canWrite() && s.allowDelete && !s.activeFileOnly) out.push(TOOL_DELETE);
    if (s.allowInternet) out.push(TOOL_FETCH);
    return out;
  }

  async run(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    const s = this.settings();
    const model = s.llmModel || defaultChatModel(s.chatProvider);
    if (!model) throw new Error("Pick a chat model in settings.");
    const key = s.chatProvider === "mistral" ? await this.key() : "";
    const headers = chatHeaders(s, key);
    const messages: Record<string, unknown>[] = [{ role: "system", content: await this.systemText() }, ...history];
    const tools = this.tools();
    let spoken = "";
    for (let hop = 0; hop < 8; hop++) {
      const body: Record<string, unknown> = {
        model,
        temperature: 0.3,
        messages,
      };
      if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      const res = await requestUrl({
        url: `${chatRoot(s)}/chat/completions`,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        throw: false,
      });
      if (res.status >= 300) throw new Error(`LLM ${res.status}: ${(res.text || "").slice(0, 200)}`);
      const json = parseJson(res);
      const msg = llmMessage(json);
      const calls = msg?.tool_calls || [];
      if (!calls.length) {
        spoken = messageText(msg?.content) || spoken;
        break;
      }
      messages.push({
        role: "assistant",
        content: messageText(msg?.content),
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      });
      for (const call of calls) {
        const result = await this.exec(call, onTool);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return spoken.trim();
  }

  private async exec(call: ToolCall, onTool: (name: string, detail: string) => void): Promise<string> {
    const args = parseToolArgs(call.function.arguments);
    if (args == null) return `Bad arguments: ${call.function.arguments}`;
    try {
      const out = await this.dispatch(call.function.name, args);
      onTool(call.function.name, out.slice(0, 160));
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onTool(call.function.name, msg);
      return `Error: ${msg}`;
    }
  }

  private allowedFolder(): string {
    const f = this.settings().notesFolder.trim();
    return f ? normalizePath(f) : "";
  }

  private inScope(path: string): boolean {
    const s = this.settings();
    if (s.activeFileOnly) {
      const cur = this.app.workspace.getActiveFile()?.path;
      return !!cur && path === cur;
    }
    const folder = this.allowedFolder();
    if (!folder) return true;
    return path === folder || path.startsWith(folder + "/");
  }

  private safeMd(path: string): string {
    const p = normalizePath(path || "");
    if (!p || p.split("/").includes("..")) throw new Error(`Blocked path: ${path}`);
    if (!p.toLowerCase().endsWith(".md")) throw new Error("Markdown only (.md)");
    if (!this.inScope(p)) throw new Error(`Outside allowed scope: ${p}`);
    return p;
  }

  private async ensureParent(path: string) {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!this.app.vault.getFolderByPath(acc)) await this.app.vault.createFolder(acc);
    }
  }

  private async afterWrite(path: string) {
    if (!this.settings().openAfterWrite) return;
    await this.app.workspace.openLinkText(path, "", false);
  }

  private htmlText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  }

  private async dispatch(name: string, args: Record<string, string>): Promise<string> {
    const s = this.settings();
    if (!s.allowTools) throw new Error("Tool calls are disabled");
    if (name === "fetch_url") {
      if (!s.allowInternet) throw new Error("Internet is disabled");
      const url = (args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs");
      const res = await requestUrl({ url, throw: false });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const raw = res.text || "";
      const text = raw.includes("<") ? this.htmlText(raw) : raw.slice(0, 4000);
      return text || "(empty)";
    }
    if (name === "list_files") {
      if (!s.allowList) throw new Error("Listing notes is disabled");
      if (s.activeFileOnly) {
        const cur = this.app.workspace.getActiveFile()?.path;
        return cur || "(no active file)";
      }
      const folder = normalizePath(args.folder || this.allowedFolder() || "");
      if (folder.split("/").includes("..")) throw new Error("Blocked path");
      const cap = this.allowedFolder();
      if (folder && cap && folder !== cap && !folder.startsWith(cap + "/")) {
        throw new Error(`Outside allowed folder: ${folder}`);
      }
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => this.inScope(f.path))
        .filter((f) => (folder ? f.path === folder || f.path.startsWith(folder + "/") : true))
        .slice(0, 80)
        .map((f) => f.path);
      return files.join("\n") || "(empty)";
    }
    const path = this.safeMd(args.path || "");
    if (name === "read_file") {
      if (!s.allowRead) throw new Error("Reading notes is disabled");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      return (await this.app.vault.read(file)).slice(0, 12000);
    }
    if (name === "create_file") {
      if (!this.canWrite() || !s.allowCreate) throw new Error("Creating notes is disabled");
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`Exists: ${path}`);
      await this.ensureParent(path);
      await this.app.vault.create(path, args.content || "");
      await this.afterWrite(path);
      return `Created ${path}`;
    }
    if (name === "edit_file") {
      if (!this.canWrite() || !s.allowEdit) throw new Error("Editing notes is disabled");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      await this.app.vault.process(file, () => args.content || "");
      await this.afterWrite(path);
      return `Wrote ${path}`;
    }
    if (name === "patch_file") {
      if (!this.canWrite() || !s.allowEdit) throw new Error("Editing notes is disabled");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      const old = args.old || "";
      await this.app.vault.process(file, (text) => {
        if (!old || !text.includes(old)) throw new Error("old text not found");
        return text.replace(old, args.new || "");
      });
      await this.afterWrite(path);
      return `Patched ${path}`;
    }
    if (name === "delete_file") {
      if (!this.canWrite() || !s.allowDelete) throw new Error("Deleting notes is disabled");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      await this.app.fileManager.trashFile(file);
      return `Trashed ${path}`;
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}

function isToolCall(v: unknown): v is ToolCall {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const fn = o.function;
  if (typeof o.id !== "string" || !fn || typeof fn !== "object") return false;
  const f = fn as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.arguments === "string";
}

function llmMessage(json: Record<string, unknown>): { content?: unknown; tool_calls?: ToolCall[] } | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (!first || typeof first !== "object" || !("message" in first)) return undefined;
  const { message } = first;
  if (!message || typeof message !== "object") return undefined;
  const rec = message as { content?: unknown; tool_calls?: unknown };
  const tool_calls = Array.isArray(rec.tool_calls) ? rec.tool_calls.filter(isToolCall) : [];
  return { content: rec.content, tool_calls };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text || "");
      return "";
    })
    .join("");
}

function parseToolArgs(raw: string): Record<string, string> | null {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
      else if (val != null) out[k] = String(val);
    }
    return out;
  } catch {
    return null;
  }
}
