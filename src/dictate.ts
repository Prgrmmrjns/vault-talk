import { MarkdownView, Notice, type Editor, type EditorPosition } from "obsidian";
import type LMVoicePlugin from "./main";
import { VoiceIO } from "./audio";
import { hotkeyLabel } from "./settings";

export type DictateState = "off" | "on" | "active";
export type DictateEvt = "state" | "text";

export class EditorDictate {
  private voice: VoiceIO;
  private busy = false;
  private view: MarkdownView | null = null;
  private from: EditorPosition | null = null;
  private written = 0;
  private pad = "";
  private fns = new Set<(e: DictateEvt) => void>();
  loudIndex = 0;
  private errShown = false;
  state: DictateState = "off";
  text = "";
  levels = new Float32Array(40);

  constructor(private plugin: LMVoicePlugin) {
    this.voice = new VoiceIO(
      () => plugin.settings,
      () => plugin.xaiKey(),
      () => plugin.mistralKey(),
      () => plugin.openaiKey(),
      () => plugin.googleKey()
    );
  }

  get listening() {
    return this.state !== "off";
  }

  onChange(fn: (e: DictateEvt) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  remember(view: MarkdownView) {
    if (this.state === "off" || !this.written) this.view = view;
  }

  cancel() {
    this.unplace();
    this.voice.cancelListen();
  }

  toggle() {
    if (this.state !== "off") {
      this.voice.stopListen();
      return;
    }
    if (this.busy) return;
    void this.start();
  }

  private async start() {
    const open = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (open?.file) this.view = open;
    this.busy = true;
    this.text = "";
    this.from = null;
    this.written = 0;
    this.pad = "";
    this.loudIndex = 0;
    this.levels.fill(0);
    this.errShown = false;
    this.setState("on");
    this.watchPlace();
    const keys = hotkeyLabel(this.plugin.settings.noteHotkey);
    new Notice(keys ? `Dictation on · click in the note · ${keys} or Esc stops` : "Dictation on · click in the note · Esc stops");
    void this.voice
      .listenLive({
        onText: (full) => {
          this.text = full;
          this.paintEditor();
          this.emit("text");
        },
        onLevel: (level) => this.pushLevel(level),
        onVad: (speaking) => {
          if (this.state === "off") return;
          this.setState(speaking ? "active" : "on");
        },
        onError: (msg) => {
          if (this.errShown) return;
          if (/API key|401|403|could not reach|STT /.test(msg)) {
            this.errShown = true;
            new Notice(msg);
          }
        },
      })
      .then((raw) => {
        const text = raw.trim();
        if (text && text !== this.text) {
          this.text = text;
          this.paintEditor();
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Cancelled") {
          this.revertEditor();
          return;
        }
        if (msg.includes("Empty")) return;
        new Notice(msg);
      })
      .finally(() => {
        this.unplace();
        this.busy = false;
        this.from = null;
        this.written = 0;
        this.setState("off");
        this.emit("text");
      });
  }

  private placeOff: (() => void) | null = null;

  private watchPlace() {
    this.unplace();
    const aim = () => {
      if (this.written) return;
      const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) return;
      this.view = view;
      this.from = null;
    };
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.(".cm-editor, .markdown-source-view, .markdown-preview-view")) return;
      window.setTimeout(aim, 0);
    };
    document.addEventListener("mousedown", click, true);
    const ref = this.plugin.app.workspace.on("active-leaf-change", aim);
    this.placeOff = () => {
      document.removeEventListener("mousedown", click, true);
      this.plugin.app.workspace.offref(ref);
      this.placeOff = null;
    };
  }

  private unplace() {
    this.placeOff?.();
  }

  private noteView(): MarkdownView | null {
    const cur = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (cur) return cur;
    if (this.view && this.view.file) return this.view;
    const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i];
      if (leaf?.view instanceof MarkdownView) return leaf.view;
    }
    return null;
  }

  private editor(): Editor | null {
    const view = this.view;
    if (!view) return this.noteView()?.editor ?? null;
    const cur = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (cur && cur.file?.path === view.file?.path) return cur.editor;
    return view.editor;
  }

  private paintEditor() {
    if (!this.view?.file) this.view = this.noteView();
    const ed = this.editor();
    if (!ed || !this.text) return;
    if (!this.view?.file) {
      if (!this.errShown) {
        this.errShown = true;
        new Notice("Click in the open note.");
      }
      return;
    }
    if (!this.from) {
      const pos = ed.getCursor();
      const before = pos.ch > 0 ? ed.getLine(pos.line).slice(pos.ch - 1, pos.ch) : "";
      this.pad = before && !/\s/.test(before) ? " " : "";
      this.from = { line: pos.line, ch: pos.ch };
      this.written = 0;
    }
    const next = this.pad + this.text;
    const start = ed.posToOffset(this.from);
    const oldTo = ed.offsetToPos(start + this.written);
    ed.replaceRange(next, this.from, oldTo);
    this.written = next.length;
    ed.setCursor(ed.offsetToPos(start + this.written));
  }

  private revertEditor() {
    const ed = this.editor();
    if (!ed || !this.from || !this.written) return;
    const start = ed.posToOffset(this.from);
    const oldTo = ed.offsetToPos(start + this.written);
    ed.replaceRange("", this.from, oldTo);
    this.written = 0;
    this.text = "";
  }

  private pushLevel(level: number) {
    this.loudIndex = (this.loudIndex + 1) % this.levels.length;
    this.levels[this.loudIndex] = level;
  }

  private setState(state: DictateState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state");
  }

  private emit(e: DictateEvt) {
    for (const fn of this.fns) fn(e);
  }
}
