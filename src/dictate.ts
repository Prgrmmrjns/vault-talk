import { Editor, MarkdownView, Notice } from "obsidian";
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, ViewUpdate, type DecorationSet } from "@codemirror/view";
import { VoiceIO } from "./audio";
import type LMVoicePlugin from "./main";

type Target = {
  filePath: string;
  start: number;
  end: number;
  title: string;
  cursor: { line: number; ch: number };
  onHeading: boolean;
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const NAV = /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;
const tick = StateEffect.define<null>();

let paint = (_view: EditorView): DecorationSet => Decoration.none;

function sectionAt(getLine: (i: number) => string, last: number, line: number) {
  let start = 0;
  let level = 0;
  let title = "";
  for (let i = line; i >= 0; i--) {
    const m = getLine(i).match(HEADING);
    if (m?.[1]) {
      start = i;
      level = m[1].length;
      title = (m[2] || "").trim();
      break;
    }
  }
  let end = last;
  for (let i = start + 1; i <= last; i++) {
    const m = getLine(i).match(HEADING);
    if (m?.[1] && m[1].length <= (level || 6)) {
      end = i - 1;
      break;
    }
  }
  return { start, end, title };
}

function marks(view: EditorView, start: number, end: number): DecorationSet {
  const deco = [];
  const a = Math.max(1, start + 1);
  const last = Math.min(view.state.doc.lines, end + 1);
  for (let n = a; n <= last; n++) {
    const line = view.state.doc.line(n);
    deco.push(Decoration.line({ class: n === a ? "vt-dictate-sec vt-dictate-head" : "vt-dictate-sec" }).range(line.from));
  }
  return Decoration.set(deco);
}

const dictationExt = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = paint(view);
    }
    update(u: ViewUpdate) {
      this.decorations = paint(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

function cmOf(editor: Editor): EditorView | null {
  return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

function isFnKey(e: KeyboardEvent) {
  if (e.repeat) return false;
  const k = e.key;
  const c = e.code;
  return k === "Fn" || k === "Globe" || c === "Fn" || c === "FnLeft" || c === "FnRight" || c === "Lang1";
}

export class Dictation {
  private voice: VoiceIO;
  private listening = false;
  private hold: { start: number; end: number } | null = null;
  private status: HTMLElement;
  private lastFn = 0;

  constructor(private plugin: LMVoicePlugin) {
    this.voice = new VoiceIO(() => plugin.settings, () => plugin.mistralKey());
    this.status = plugin.addStatusBarItem();
    this.status.addClass("vt-dictate-status");
    this.status.hide();
  }

  private deco(view: EditorView): DecorationSet {
    if (!this.plugin.settings.dictation) return Decoration.none;
    if (this.hold) return marks(view, this.hold.start, this.hold.end);
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    const last = view.state.doc.lines - 1;
    const { start, end } = sectionAt((i) => view.state.doc.line(i + 1).text, last, line);
    return marks(view, start, end);
  }

  onload() {
    paint = (view) => this.deco(view);
    this.plugin.registerEditorExtension(dictationExt);
    this.plugin.addCommand({
      id: "dictate",
      name: "Dictate into note",
      checkCallback: (checking) => {
        if (!this.plugin.settings.dictation) return false;
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.editor) return false;
        if (!checking) void this.toggle();
        return true;
      },
    });
    this.plugin.registerDomEvent(document, "keydown", (e) => this.onKey(e), { capture: true });
    this.plugin.registerDomEvent(document, "keyup", (e) => this.onKey(e), { capture: true });
    this.plugin.registerDomEvent(document, "keyup", (e) => {
      if (this.plugin.settings.dictation && NAV.test(e.key)) this.refresh();
    });
    this.plugin.registerDomEvent(document, "click", () => {
      if (this.plugin.settings.dictation) window.setTimeout(() => this.refresh(), 0);
    });
    this.plugin.registerDomEvent(this.status, "click", () => void this.toggle());
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.plugin.register(() => {
      paint = () => Decoration.none;
    });
    this.sync();
  }

  sync() {
    document.body.toggleClass("vt-dictate-on", this.plugin.settings.dictation);
    if (!this.plugin.settings.dictation) {
      if (this.listening) this.stopOnly();
      this.status.hide();
    }
    this.refresh();
  }

  private refresh() {
    const editor = this.view()?.editor;
    if (editor) cmOf(editor)?.dispatch({ effects: tick.of(null) });
    this.refreshStatus();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.plugin.settings.dictation || !isFnKey(e)) return;
    const now = Date.now();
    if (now - this.lastFn < 400) return;
    this.lastFn = now;
    e.preventDefault();
    e.stopPropagation();
    void this.toggle();
  }

  private view(): MarkdownView | null {
    const v = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return v?.editor ? v : null;
  }

  private targetFrom(editor: Editor, view: MarkdownView): Target | null {
    const file = view.file;
    if (!file) return null;
    const cursor = editor.getCursor();
    const { start, end, title } = sectionAt((i) => editor.getLine(i), editor.lastLine(), cursor.line);
    return {
      filePath: file.path,
      start,
      end,
      title: title || file.basename,
      cursor,
      onHeading: !!editor.getLine(start).match(HEADING) && cursor.line === start,
    };
  }

  private refreshStatus() {
    if (!this.plugin.settings.dictation) {
      this.status.hide();
      return;
    }
    this.status.show();
    if (this.listening) {
      this.status.setText("Listening…");
      return;
    }
    const view = this.view();
    if (!view) {
      this.status.setText("Dictate");
      return;
    }
    const t = this.targetFrom(view.editor, view);
    this.status.setText(`Dictate · ${t?.title || view.file?.basename || "note"}`);
  }

  async toggle() {
    if (this.listening) {
      this.voice.stopListen();
      return;
    }
    const view = this.view();
    if (!view) {
      new Notice("Open a markdown note in edit view.");
      return;
    }
    const target = this.targetFrom(view.editor, view);
    if (!target) {
      new Notice("Open a markdown note in edit view.");
      return;
    }
    this.listening = true;
    this.hold = { start: target.start, end: target.end };
    document.body.addClass("vt-dictate-listen");
    this.refresh();
    try {
      const text = await this.voice.listenTurn();
      if (!text.trim()) return;
      this.insert(target, text.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Empty transcript") new Notice(msg);
    } finally {
      this.listening = false;
      this.hold = null;
      document.body.removeClass("vt-dictate-listen");
      this.refresh();
    }
  }

  private stopOnly() {
    this.listening = false;
    this.hold = null;
    this.voice.stopListen();
    document.body.removeClass("vt-dictate-listen");
  }

  private insert(t: Target, text: string) {
    const view = this.view();
    if (!view || view.file?.path !== t.filePath) {
      new Notice("Note changed — dictation dropped.");
      return;
    }
    const editor = view.editor;
    if (!t.onHeading && editor.somethingSelected()) {
      editor.replaceSelection(text);
      return;
    }
    if (!t.onHeading) {
      const line = editor.getLine(t.cursor.line);
      const pad = t.cursor.ch > 0 && !/\s$/.test(line.slice(0, t.cursor.ch)) ? " " : "";
      editor.replaceRange(pad + text, t.cursor);
      return;
    }
    let line = t.end;
    while (line > t.start && !editor.getLine(line).trim()) line--;
    const cur = editor.getLine(line);
    const prefix = line === t.start || cur.trim() ? "\n\n" : "\n";
    editor.replaceRange(prefix + text, { line, ch: cur.length });
  }
}
