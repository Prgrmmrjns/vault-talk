import { App, FileSystemAdapter, FileView, MarkdownView, TFile, normalizePath, requestUrl } from "obsidian";
import { CursorVaultChat } from "./cursor-chat";
import { ANTHROPIC_API, GEMINI_API, chatRoot, defaultChatModel, parseJson } from "./providers";
import { txt } from "./txt";
import type { LMVoiceSettings } from "./settings";

export type ChatMsg = { role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string };

export type AgentKeys = {
  cursor: () => Promise<string>;
  openai: () => Promise<string>;
  google: () => Promise<string>;
  mistral: () => Promise<string>;
  anthropic: () => Promise<string>;
};

type ToolCall = { id: string; function: { name: string; arguments: string } };

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
const TOOL_OPEN = tool(
  "open_file",
  "Open a note in Obsidian. Call this once — do not glob, grep, shell, or read first. Path may be a vault path, filename, [[wikilink]], or 'today' / 'journal' for the daily journal.",
  { path: { type: "string", description: "Vault path, filename, [[wikilink]], or today/journal." } },
  ["path"]
);
const TOOL_READ = tool(
  "read_file",
  "Read a markdown note. Not for cursor or open tabs — those are already in the prompt. Path may be a vault path, filename, today/journal, or Jarvis.md for memory.",
  { path: { type: "string", description: "Vault path, filename, today/journal, or Jarvis.md." } },
  ["path"]
);
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
const TOOL_FETCH = tool("fetch_url", "Fetch a public http(s) page and return plain text.", {
  url: { type: "string" },
}, ["url"]);

const FALLBACK_PROMPT = `You are Jarvis in Obsidian. One short spoken sentence. No vault paths, no .md names. Say “today’s journal”, the note title, or the PDF title.

Call tools silently. If you need several, call the next before speaking. Never announce that you will look or edit. After the work, speak once.

Open files, PDFs, and the writing cursor are already in the prompt. Do not read_file to find them.

today / journal → path today. For the plan, read_file today. Markdown only for edits. Never delete.

When they teach you how to behave, add a short bullet under # Memory in Jarvis.md (patch_file). Keep Memory short. Never delete the instructions above it.

# Memory
`;

export class VaultAgent {
  private cursor: CursorVaultChat | null = null;
  private lastMd: MarkdownView | null = null;
  private lastFile: TFile | null = null;

  constructor(
    private app: App,
    private settings: () => LMVoiceSettings,
    private keys: AgentKeys
  ) {}

  resetCursor() {
    this.cursor?.reset();
    this.cursor = null;
  }

  private canWrite(): boolean {
    return this.settings().editFiles;
  }

  async systemText(): Promise<string> {
    this.rememberFocus();
    const live = this.liveLine();
    const raw = ((await this.loadPersonality()) || FALLBACK_PROMPT)
      .replaceAll("{{date}}", localDay())
      .replaceAll("{{file}}", this.noteLabel(this.writingFile()?.path || "") || "(none)")
      .replaceAll("{{journal}}", this.noteLabel(this.dailyJournal()?.path || "") || "(none)")
      .replaceAll("{{tabs}}", this.openLabels() || "(none)")
      .replaceAll("{{pdfs}}", this.openPdfs().map((p) => this.noteLabel(p)).join(", ") || "(none)")
      .replaceAll("{{cursor}}", this.cursorLine());
    return `${raw.trim()}\n\n${live}`.slice(0, 4500);
  }

  rememberFocus() {
    const leaf = this.app.workspace.activeLeaf;
    const view = leaf?.view;
    if (!view) return;
    const kind = view.getViewType();
    if (kind.startsWith("vault-talk")) return;
    if (view instanceof MarkdownView && view.file) {
      this.lastMd = view;
      this.lastFile = view.file;
      return;
    }
    if (view instanceof FileView && view.file) this.lastFile = view.file;
  }

  private liveLine(): string {
    const writing = this.noteLabel(this.writingFile()?.path || "") || "(none)";
    const focus = this.noteLabel(this.lastFile?.path || this.writingFile()?.path || "") || "(none)";
    const pdfs = this.openPdfs().map((p) => this.noteLabel(p)).join(", ") || "(none)";
    const tabs = this.openLabels() || "(none)";
    return `Today: ${localDay()}. Focused: ${focus}. Writing: ${writing}. Cursor: ${this.cursorLine()}. PDFs: ${pdfs}. Open: ${tabs}. Journal: ${this.noteLabel(this.dailyJournal()?.path || "") || "(none)"}.`;
  }

  private writingFile(): TFile | null {
    if (this.lastMd?.file) return this.lastMd.file;
    return this.activeMarkdown();
  }

  private writingView(): MarkdownView | null {
    if (this.lastMd?.file) return this.lastMd;
    const cur = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (cur?.file) return cur;
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (let i = leaves.length - 1; i >= 0; i--) {
      const view = leaves[i]?.view;
      if (view instanceof MarkdownView && view.file) return view;
    }
    return null;
  }

  private cursorLine(): string {
    const view = this.writingView();
    if (!view?.file) return "(none)";
    const ed = view.editor;
    if (!ed || view.getMode?.() === "preview") return `${this.noteLabel(view.file.path)}, reading`;
    const pos = ed.getCursor();
    const lineNo = pos.line + 1;
    let heading = "";
    for (let i = pos.line; i >= 0; i--) {
      const m = ed.getLine(i).match(/^(#{1,6})\s+(.+)/);
      if (m?.[2]) {
        heading = m[2].trim();
        break;
      }
    }
    const snippet = ed.getLine(pos.line).trim().slice(0, 80);
    const bits = [`line ${lineNo}`];
    if (heading) bits.push(`heading ${heading}`);
    if (snippet) bits.push(`“${snippet}”`);
    return bits.join(", ");
  }

  private openFiles(): TFile[] {
    const out: TFile[] = [];
    const seen = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view.getViewType().startsWith("vault-talk")) return;
      if (!(view instanceof FileView) || !view.file) return;
      if (seen.has(view.file.path)) return;
      seen.add(view.file.path);
      out.push(view.file);
    });
    return out.slice(0, 12);
  }

  private openPdfs(): string[] {
    return this.openFiles()
      .filter((f) => f.extension.toLowerCase() === "pdf")
      .map((f) => f.path);
  }

  private openLabels(): string {
    return this.openFiles()
      .map((f) => this.noteLabel(f.path))
      .join(", ");
  }

  activeMarkdown(): TFile | null {
    const cur = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (cur?.file) return cur.file;
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (let i = leaves.length - 1; i >= 0; i--) {
      const view = leaves[i]?.view;
      if (view instanceof MarkdownView && view.file) return view.file;
    }
    return null;
  }

  openMarkdown(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      if (seen.has(view.file.path)) continue;
      seen.add(view.file.path);
      out.push(view.file.path);
    }
    return out.slice(0, 8);
  }

  private personalityFile(): TFile | null {
    const raw = (this.settings().personalityFile || "Jarvis.md").trim();
    if (!raw) return null;
    const path = normalizePath(raw.replace(/^\[\[|\]\]$/g, ""));
    return this.app.vault.getFileByPath(path.endsWith(".md") ? path : `${path}.md`) || this.app.vault.getFileByPath(path);
  }

  private async loadPersonality(): Promise<string> {
    const file = this.personalityFile();
    if (!file) return "";
    return (await this.app.vault.read(file)).replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 3500);
  }

  private tools() {
    const s = this.settings();
    const out = [TOOL_OPEN, TOOL_READ, TOOL_LIST];
    if (s.editFiles) out.push(TOOL_CREATE, TOOL_EDIT, TOOL_PATCH);
    if (s.allowInternet) out.push(TOOL_FETCH);
    return out;
  }

  grokTools() {
    return this.tools().map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  async callTool(name: string, rawArgs: string, onTool: (name: string, detail: string) => void): Promise<string> {
    return this.exec({ id: "grok", function: { name, arguments: rawArgs } }, onTool);
  }

  async run(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    const s = this.settings();
    const last = [...history].reverse().find((m) => m.role === "user");
    const target = last ? openTarget(last.content) : null;
    if (target) {
      try {
        const out = await this.openNote(target);
        onTool("open_file", out);
        return out;
      } catch {
        /* let the model find it */
      }
    }
    if (s.chatProvider === "cursor") return this.runCursor(history, onTool);
    if (s.chatProvider === "anthropic") return this.runAnthropic(history, onTool);
    if (s.chatProvider === "google") return this.runGemini(history, onTool);
    this.resetCursor();
    return this.runOpenAI(history, onTool);
  }

  private async runOpenAI(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    const s = this.settings();
    const model = s.llmModel || defaultChatModel(s.chatProvider);
    if (!model) throw new Error("Pick a chat model in settings.");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (s.chatProvider === "openai") headers.Authorization = "Bearer " + (await this.keys.openai());
    if (s.chatProvider === "mistral") headers.Authorization = "Bearer " + (await this.keys.mistral());
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

  private async runAnthropic(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    const s = this.settings();
    const model = s.llmModel || defaultChatModel("anthropic");
    const key = await this.keys.anthropic();
    const tools = this.tools().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    const messages: Record<string, unknown>[] = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    let spoken = "";
    for (let hop = 0; hop < 8; hop++) {
      const res = await requestUrl({
        url: `${ANTHROPIC_API}/messages`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0.3,
          system: await this.systemText(),
          messages,
          tools: tools.length ? tools : undefined,
        }),
        throw: false,
      });
      if (res.status >= 300) throw new Error(`LLM ${res.status}: ${(res.text || "").slice(0, 200)}`);
      const json = parseJson(res);
      const content = Array.isArray(json.content) ? json.content : [];
      const uses: { id: string; name: string; input: unknown }[] = [];
      let text = "";
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (p.type === "text") text += p.text || "";
        if (p.type === "tool_use") uses.push({ id: String(p.id || ""), name: String(p.name || ""), input: p.input });
      }
      if (!uses.length) {
        spoken = text || spoken;
        break;
      }
      messages.push({ role: "assistant", content });
      const results: Record<string, unknown>[] = [];
      for (const u of uses) {
        const result = await this.exec(
          { id: u.id, function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } },
          onTool
        );
        results.push({ type: "tool_result", tool_use_id: u.id, content: result });
      }
      messages.push({ role: "user", content: results });
    }
    return spoken.trim();
  }

  private async runGemini(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    const s = this.settings();
    const model = s.llmModel || defaultChatModel("google");
    const key = await this.keys.google();
    const decls = this.grokTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const contents: Record<string, unknown>[] = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    let spoken = "";
    for (let hop = 0; hop < 8; hop++) {
      const res = await requestUrl({
        url: `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: await this.systemText() }] },
          contents,
          generationConfig: { temperature: 0.3 },
          tools: decls.length ? [{ functionDeclarations: decls }] : undefined,
        }),
        throw: false,
      });
      if (res.status >= 300) throw new Error(`LLM ${res.status}: ${(res.text || "").slice(0, 200)}`);
      const json = parseJson(res);
      const cands = json.candidates;
      const first: unknown = Array.isArray(cands) ? cands[0] : null;
      const parts: Record<string, unknown>[] = [];
      if (first && typeof first === "object" && "content" in first) {
        const content = (first as { content?: { parts?: unknown } }).content;
        if (Array.isArray(content?.parts)) {
          for (const part of content.parts) {
            if (part && typeof part === "object") parts.push(part as Record<string, unknown>);
          }
        }
      }
      const calls: { name: string; args: unknown }[] = [];
      let text = "";
      for (const p of parts) {
        if (typeof p.text === "string") text += p.text;
        const fc = p.functionCall as { name?: string; args?: unknown } | undefined;
        if (fc?.name) calls.push({ name: fc.name, args: fc.args });
      }
      contents.push({ role: "model", parts });
      if (!calls.length) {
        spoken = text || spoken;
        break;
      }
      const responses: Record<string, unknown>[] = [];
      for (const c of calls) {
        const result = await this.exec(
          { id: c.name, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } },
          onTool
        );
        responses.push({ functionResponse: { name: c.name, response: { result } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return spoken.trim();
  }

  private async runCursor(history: ChatMsg[], onTool: (name: string, detail: string) => void): Promise<string> {
    if (!this.cursor) {
      this.cursor = new CursorVaultChat(this.app, this.keys.cursor, this.settings);
    }
    const last = [...history].reverse().find((m) => m.role === "user");
    if (!last) return "";
    return this.cursor.send(last.content, await this.systemText(), onTool);
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

  private dailyJournal(): TFile | null {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const iso = `${yyyy}-${mm}-${dd}`;
    const dayFile = `${dd}-${mm}-${yyyy}.md`;
    const month = d.toLocaleString("en-US", { month: "long" });
    const paths = [
      `Journal/${yyyy}/${month}/${dayFile}`,
      `Journal/${yyyy}/${yyyy}-${mm}/${dayFile}`,
      `Journal/${yyyy}/${dayFile}`,
      `Journal/${iso}.md`,
      `Journal/${dayFile}`,
    ];
    for (const p of paths) {
      const f = this.app.vault.getFileByPath(p);
      if (f && this.inScope(f.path)) return f;
    }
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.inScope(f.path)) continue;
      if (f.name === dayFile && f.path.startsWith("Journal/")) return f;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      const type = String(fm.type || "").toLowerCase();
      const date = String(fm.date || "").slice(0, 10);
      if (date === iso && (type === "daily" || type === "journal")) return f;
    }
    return null;
  }

  private resolveOpen(raw: string): TFile {
    const cleaned = (raw || "").replace(/^\[\[|\]\]$/g, "").trim().replace(/\\/g, "/");
    if (!cleaned || cleaned.split("/").includes("..")) throw new Error(`Blocked path: ${raw}`);
    if (journalAlias(cleaned)) {
      const j = this.dailyJournal();
      if (j) return j;
      throw new Error("Today's journal is missing");
    }
    if (memoryAlias(cleaned)) {
      const mem = this.personalityFile();
      if (mem) return mem;
      throw new Error("Jarvis.md is missing");
    }
    let p = cleaned;
    const ad = this.app.vault.adapter;
    if (ad instanceof FileSystemAdapter) {
      const root = ad.getBasePath().replace(/\\/g, "/");
      const full = p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p;
      if (full === root || full.startsWith(root + "/")) p = full.slice(root.length).replace(/^\/+/, "");
    }
    p = normalizePath(p);
    const folder = this.allowedFolder();
    const active = this.app.workspace.getActiveFile()?.path || "";
    const linkName = p.replace(/\.md$/i, "");
    const link =
      this.app.metadataCache.getFirstLinkpathDest(linkName, active) ||
      this.app.metadataCache.getFirstLinkpathDest(cleaned, active);
    const tries = [p];
    if (!/\.[a-z0-9]+$/i.test(p)) tries.push(`${p}.md`, `${p}.pdf`);
    if (folder) {
      tries.push(normalizePath(`${folder}/${p}`));
      if (!p.toLowerCase().endsWith(".md")) tries.push(normalizePath(`${folder}/${p}.md`));
    }
    const file =
      (link && this.inScope(link.path) ? link : null) ||
      tries.map((t) => this.app.vault.getFileByPath(t)).find((f): f is TFile => !!f) ||
      null;
    if (!file) throw new Error(`Missing: ${p}`);
    if (!this.inScope(file.path)) throw new Error(`Outside allowed scope: ${file.path}`);
    return file;
  }

  private async openNote(raw: string): Promise<string> {
    const file = this.resolveOpen(raw);
    const { workspace } = this.app;
    let found: ReturnType<typeof workspace.getLeaf> | null = null;
    workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === file.path) found = leaf;
    });
    if (found) {
      void workspace.revealLeaf(found);
      const label = this.noteLabel(file.path);
      if (file.extension === "md" && this.dailyJournal()?.path === file.path) {
        const body = (await this.app.vault.read(file)).replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 4000);
        return `Opened ${label}\n${body}`;
      }
      return `Opened ${label}`;
    }
    const recent = workspace.getMostRecentLeaf();
    const leaf =
      recent && recent.view.getViewType() !== "vault-talk-view" && recent.view.getViewType() !== "vault-talk-dictate"
        ? recent
        : workspace.getLeaf("tab");
    await leaf.openFile(file);
    void workspace.revealLeaf(leaf);
    const label = this.noteLabel(file.path);
    if (this.dailyJournal()?.path === file.path) {
      const body = (await this.app.vault.read(file)).replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 4000);
      return `Opened ${label}\n${body}`;
    }
    return `Opened ${label}`;
  }

  private noteLabel(path: string): string {
    const journal = this.dailyJournal()?.path;
    if (journal && path === journal) return "today's journal";
    const base = path.split("/").pop() || path;
    return base.replace(/\.(md|pdf)$/i, "");
  }

  private async afterWrite(path: string) {
    if (!this.settings().openAfterWrite) return;
    await this.openNote(path);
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
    if (name === "open_file") return this.openNote(args.path || "");
    if (name === "read_file" || name === "edit_file" || name === "patch_file") {
      const file = this.resolveOpen(args.path || "");
      args = { ...args, path: file.path };
    }
    if (name === "list_files") {
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
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      return (await this.app.vault.read(file)).slice(0, 12000);
    }
    if (name === "create_file") {
      if (!this.canWrite()) throw new Error("Editing files is off");
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`Exists: ${path}`);
      await this.ensureParent(path);
      await this.app.vault.create(path, args.content || "");
      await this.afterWrite(path);
      return `Created ${this.noteLabel(path)}`;
    }
    if (name === "edit_file") {
      if (!this.canWrite()) throw new Error("Editing files is off");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      await this.app.vault.process(file, () => args.content || "");
      await this.afterWrite(path);
      return `Wrote ${this.noteLabel(path)}`;
    }
    if (name === "patch_file") {
      if (!this.canWrite()) throw new Error("Editing files is off");
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing: ${path}`);
      const old = args.old || "";
      await this.app.vault.process(file, (text) => {
        if (!old || !text.includes(old)) throw new Error("old text not found");
        return text.replace(old, args.new || "");
      });
      await this.afterWrite(path);
      return `Patched ${this.noteLabel(path)}`;
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function memoryAlias(raw: string): boolean {
  const t = raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return t === "memory" || t === "jarvis" || t === "jarvis md" || t === "personality";
}

function journalAlias(raw: string): boolean {
  const t = raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\b(the|my|our|a|an|note|file|page|entry)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    t === "today" ||
    t === "journal" ||
    t === "daily" ||
    t === "daily journal" ||
    t === "today journal" ||
    t === "todays journal" ||
    t === "today daily" ||
    t === "today daily journal" ||
    t === "todays daily journal" ||
    t.endsWith("daily journal")
  );
}

function openTarget(text: string): string | null {
  const t = text.trim().replace(/[?!.,]+$/g, "");
  const m = t.match(/^(please\s+)?(open|show(?:\s+me)?|go\s+to|look\s+at)\s+(.+)$/i);
  if (!m) return null;
  const rest = (m[3] || "").replace(/^(the|my|our)\s+/i, "").trim();
  if (!rest) return null;
  if (/\b(and|then)\b/i.test(rest)) return null;
  if (/\b(add|write|edit|append|update|fill|create|delete|patch)\b/i.test(rest)) return null;
  return rest;
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
      if (part && typeof part === "object" && "text" in part) return txt((part as { text?: unknown }).text);
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
      else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
    }
    return out;
  } catch {
    return null;
  }
}
