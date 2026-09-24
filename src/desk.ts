// @ts-nocheck
import { ItemView, Notice, Setting, TFile, requestUrl, setIcon } from "obsidian";

const VIEW_TYPE = "desk-view";
const ISO = "YYYY-MM-DD";
const PX = 1.2;
const SNAP = 10;
const DEFAULTS = {
  name: "Jonas",
  startHour: 7,
  endHour: 22,
  reflectHour: 18,
  remindLead: 5,
  icsUrls: "",
  openOnStartup: true,
  banner: "Journal/banners/journal-day.png",
  template: "Templates/Journal.md",
  backlog: "Home.md",
};

/* ---------- time ---------- */

const M = () => window.moment();
const dailyPath = (d) => `Journal/${d.format("YYYY-MM")}/${d.format("DD-MM-YYYY")}.md`;
const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const fmt = (min) => {
  min = Math.max(0, Math.min(1439, Math.round(min)));
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
};
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60; };
const snap = (m) => Math.round(m / SNAP) * SNAP;
const dur = (m) => { m = Math.round(m); const h = Math.floor(m / 60); return h ? `${h}h${m % 60 ? " " + (m % 60) + "m" : ""}` : `${m}m`; };
const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

/* ---------- task text ---------- */

const DATE_EMOJI = /\s*(📅|⏳|🛫|✅|➕|❌)\s*\d{4}-\d{2}-\d{2}/gu;
const PRIO = /\s*(🔺|⏫|🔼|🔽|⏬)/gu;
const RECUR = /\s*🔁[^📅⏳🛫✅➕❌🔺⏫🔼🔽⏬#\n]*/gu;
const TAG = /(^|\s)#[\p{L}\p{N}_/-]+/gu;
const TIME_PREFIX = /^(\s*[-*+] \[.\]\s+)\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\s*/;

const pickDate = (t, e) => { const m = t.match(new RegExp(e + "\\s*(\\d{4}-\\d{2}-\\d{2})", "u")); return m ? m[1] : null; };
const tagsOf = (t) => (t.match(TAG) || []).map((s) => s.trim().slice(1).toLowerCase());
const stripMeta = (t) => t.replace(RECUR, "").replace(DATE_EMOJI, "").replace(PRIO, "").trim();
const clean = (t) => stripMeta(t)
  .replace(TAG, "$1")
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
  .replace(/\[\[([^\]]+)\]\]/g, (_, a) => a.split("/").pop())
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  .replace(/\*\*|__|~~|`/g, "")
  .replace(/\s+/g, " ").trim();
const norm = (t) => clean(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const prioOf = (t) => /🔺/u.test(t) ? 4 : /⏫/u.test(t) ? 3 : /🔼/u.test(t) ? 2 : /🔽|⏬/u.test(t) ? 0 : 1;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HUES = [[168, 42], [28, 72], [212, 55], [338, 52], [44, 70], [262, 42], [132, 36], [8, 60]];
const tagColor = (tag) => {
  if (!tag) return "var(--d-accent)";
  let h = 7;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [hu, s] = HUES[h % HUES.length];
  return `hsl(${hu} ${s}% 62%)`;
};

/* ---------- markdown sections ---------- */

function section(text, name) {
  const m = new RegExp("^# " + esc(name) + "[ \\t]*$", "m").exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nx = text.slice(start).search(/\n# /);
  return { head: m.index, start, end: nx === -1 ? text.length : start + nx };
}
const lineAt = (text, off) => text.slice(0, off).split("\n").length - 1;

function parseDaily(text) {
  const out = { goal: "", blocks: [], loose: [], moved: "", carries: "" };
  if (!text) return out;
  const lines = text.split("\n");
  const g = section(text, "Goal");
  if (g) {
    for (const raw of text.slice(g.start, g.end).split("\n")) {
      const s = raw.trim();
      if (s.startsWith("```")) break;
      if (!s) continue;
      const v = s.replace(/^[-*]\s+/, "").replace(/^[*_]+|[*_]+$/g, "").trim();
      if (v && v !== "One outcome for today.") out.goal = v;
      break;
    }
  }
  const p = section(text, "Day planner");
  if (p) {
    const last = lineAt(text, p.end);
    for (let i = lineAt(text, p.start) + 1; i <= last && i < lines.length; i++) {
      const ln = lines[i];
      const t = ln.match(/^- \[(.)\]\s+(.*)$/);
      if (!t) continue;
      const done = t[1] !== " " && t[1] !== "/";
      const tm = t[2].match(/^(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s+(.*)$/);
      if (tm) out.blocks.push({ line: i, raw: ln, start: toMin(tm[1]), end: tm[2] ? toMin(tm[2]) : null, text: tm[3], done });
      else if (t[2].trim()) out.loose.push({ line: i, raw: ln, text: t[2], done });
    }
    out.blocks.sort((a, b) => a.start - b.start);
    for (const b of out.blocks) if (b.end == null || b.end <= b.start) b.end = b.start + 30;
  }
  const mv = text.match(/^- Moved the goal:[ \t]*(.*)$/m);
  const cr = text.match(/^- Carries to tomorrow:[ \t]*(.*)$/m);
  out.moved = mv ? mv[1].trim() : "";
  out.carries = cr ? cr[1].trim() : "";
  return out;
}

function parseTimeline(text) {
  const sec = section(text, "Timeline");
  if (!sec) return [];
  const out = [];
  for (const ch of text.slice(sec.start, sec.end).split(/\n(?=## )/)) {
    const head = ch.match(/^##\s+(\d{4}-\d{2}-\d{2}|open)\s+·\s+(now|done|later)\s+[—–-]\s+(.+)$/m);
    if (!head) continue;
    const lane = (name) => {
      const m = ch.match(new RegExp("### " + name + "\\n+([\\s\\S]*?)(?=\\n### |\\n## |$)"));
      return m ? m[1].replace(/\n+/g, " ").trim() : "";
    };
    const doneWhen = (ch.match(/\*\*Done when\*\*\s*[—–-]\s*(.+)/) || [])[1] || "";
    out.push({
      date: head[1],
      status: head[2],
      title: head[3].trim(),
      doneWhen: doneWhen.trim(),
      cloud: lane("Cloud"),
      agent: lane("Agent"),
      you: lane("You"),
      closes: /closes the project/i.test(ch),
    });
  }
  return out;
}

/* ---------- iCal ---------- */

const unIcs = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
function icsDate(v) {
  const m = v && v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00", z] = m;
  const s = `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
  return z ? window.moment.utc(s).local() : window.moment(s);
}
function parseICS(src) {
  const evs = [];
  let cur = null;
  for (const l of src.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (l === "BEGIN:VEVENT") { cur = { ex: [] }; continue; }
    if (l === "END:VEVENT") { if (cur && cur.start) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(":");
    if (i < 0) continue;
    const [name, ...ps] = l.slice(0, i).split(";");
    const params = Object.fromEntries(ps.map((p) => p.split("=")));
    const val = l.slice(i + 1);
    if (name === "SUMMARY") cur.title = unIcs(val);
    else if (name === "LOCATION") cur.location = unIcs(val);
    else if (name === "UID") cur.uid = val;
    else if (name === "STATUS") cur.status = val;
    else if (name === "DTSTART") { cur.start = icsDate(val); cur.allDay = params.VALUE === "DATE" || /^\d{8}$/.test(val); }
    else if (name === "DTEND") cur.end = icsDate(val);
    else if (name === "DURATION") cur.duration = val;
    else if (name === "RRULE") cur.rrule = Object.fromEntries(val.split(";").map((kv) => kv.split("=")));
    else if (name === "EXDATE") for (const v of val.split(",")) cur.ex.push(icsDate(v));
    else if (name === "RECURRENCE-ID") cur.recur = icsDate(val);
  }
  return evs;
}
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function durMin(ev) {
  if (ev.end) return Math.max(15, ev.end.diff(ev.start, "minutes"));
  const m = ev.duration && ev.duration.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (m) return (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return ev.allDay ? 1440 : 60;
}
function occurs(ev, day) {
  const s = ev.start.clone().startOf("day");
  const d = day.clone().startOf("day");
  if (d.isBefore(s)) return false;
  const r = ev.rrule;
  if (!r) {
    if (ev.allDay) { const e = ev.end ? ev.end.clone().startOf("day") : s.clone().add(1, "day"); return d.isBefore(e) || d.isSame(s); }
    return d.isSame(s);
  }
  if (r.UNTIL) { const u = icsDate(r.UNTIL); if (u && d.isAfter(u.clone().endOf("day"))) return false; }
  if (ev.ex.some((x) => x && x.isSame(d, "day"))) return false;
  const iv = +(r.INTERVAL || 1);
  const days = d.diff(s, "days");
  const byday = r.BYDAY ? r.BYDAY.split(",") : null;
  let ok = false, idx = 0;
  if (r.FREQ === "DAILY") { ok = days % iv === 0; idx = days / iv; }
  else if (r.FREQ === "WEEKLY") {
    const weeks = d.clone().startOf("isoWeek").diff(s.clone().startOf("isoWeek"), "weeks");
    const wds = byday ? byday.map((x) => WD[x.slice(-2)]) : [s.day()];
    ok = weeks % iv === 0 && wds.includes(d.day());
    idx = Math.floor(weeks / iv) * wds.length;
  } else if (r.FREQ === "MONTHLY") {
    const months = (d.year() - s.year()) * 12 + d.month() - s.month();
    if (months % iv !== 0) return false;
    if (byday) {
      ok = byday.some((x) => {
        const n = parseInt(x, 10), wd = WD[x.slice(-2)];
        if (d.day() !== wd) return false;
        if (!n) return true;
        const nth = Math.ceil(d.date() / 7);
        const fromEnd = Math.ceil((d.daysInMonth() - d.date() + 1) / 7);
        return n > 0 ? nth === n : fromEnd === -n;
      });
    } else ok = d.date() === (r.BYMONTHDAY ? +r.BYMONTHDAY : s.date());
    idx = months / iv;
  } else if (r.FREQ === "YEARLY") { ok = d.month() === s.month() && d.date() === s.date(); idx = d.year() - s.year(); }
  if (ok && r.COUNT && idx >= +r.COUNT) ok = false;
  return ok;
}
function eventsOn(evs, day) {
  const key = day.format(ISO);
  const moved = new Set(evs.filter((e) => e.recur).map((e) => `${e.uid}|${e.recur.format(ISO)}`));
  const out = [];
  for (const ev of evs) {
    if (ev.status === "CANCELLED") continue;
    if (ev.rrule && moved.has(`${ev.uid}|${key}`)) continue;
    if (!occurs(ev, day)) continue;
    const start = ev.allDay ? 0 : ev.start.hours() * 60 + ev.start.minutes();
    out.push({ kind: "event", title: ev.title || "Busy", location: ev.location || "", allDay: !!ev.allDay, start, end: Math.min(1440, start + durMin(ev)), done: false });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- DOM helpers ---------- */

function btn(parent, icon, label, onClick, cls = "") {
  const b = parent.createEl("button", { cls: "desk-btn " + cls, attr: { "aria-label": label, type: "button" } });
  if (icon) setIcon(b.createSpan("desk-ico"), icon);
  if (label && !cls.includes("is-icon")) b.createSpan({ text: label });
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}
function autogrow(ta) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
}
function lanes(items) {
  const sorted = items.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  let group = [], end = -1;
  const flush = () => {
    const cols = [];
    for (const it of group) {
      let c = cols.findIndex((e) => e <= it.start);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = it.end;
      it._col = c;
    }
    for (const it of group) it._cols = cols.length;
    group = [];
  };
  for (const it of sorted) {
    if (group.length && it.start >= end) { flush(); end = -1; }
    group.push(it);
    end = Math.max(end, it.end);
  }
  if (group.length) flush();
  return sorted;
}
function relDay(iso, today) {
  const d = window.moment(iso, ISO), t = window.moment(today, ISO);
  const n = d.diff(t, "days");
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 0) return `${-n}d late`;
  if (n < 7) return d.format("ddd");
  return d.format("D MMM");
}

/* ================================================================ */

class DeskView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.data = null;
    this.expanded = new Set(["overdue", "today"]);
    this.scrolled = false;
    this.target = "today";
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Desk"; }
  getIcon() { return "sunrise"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("desk");
    const scroll = root.createDiv("desk-scroll");
    this.page = scroll.createDiv("desk-page");
    this.heroEl = this.page.createDiv("desk-hero");
    this.goalEl = this.page.createDiv("desk-goal");
    const grid = this.page.createDiv("desk-grid");
    this.dayEl = grid.createDiv("desk-card desk-day");
    this.tasksEl = grid.createDiv("desk-card desk-tasks");
    this.projectsEl = grid.createDiv("desk-card desk-projects");
    this.registerDomEvent(document, "pointerdown", (e) => { if (this.pop && !this.pop.contains(e.target)) this.closePop(); });
    this.registerDomEvent(document, "keydown", (e) => { if (e.key === "Escape") this.closePop(); });
    this.registerInterval(window.setInterval(() => this.tick(), 30000));
    await this.refresh();
  }

  async onClose() {
    this.closePop();
  }

  async refresh() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      this.data = await this.plugin.collect();
      this.render();
    } catch (e) {
      console.error("desk", e);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(); }
    }
  }

  render() {
    const d = this.data;
    const evening = new Date().getHours() >= this.plugin.settings.reflectHour;
    this.page.toggleClass("is-evening", evening);
    this.page.toggleClass("is-unplanned", !d.daily.goal && !d.daily.blocks.length);
    this.renderHero();
    this.renderGoal();
    this.renderDay();
    this.renderTasks();
    this.renderProjects();
  }

  tick() {
    if (!this.data) return;
    if (M().format(ISO) !== this.data.today) { this.scrolled = false; this.refresh(); return; }
    this.renderNow();
    this.placeNowLine();
  }

  /* ---------- hero ---------- */

  renderHero() {
    const d = this.data, el = this.heroEl;
    el.empty();
    const url = this.plugin.resource(this.plugin.settings.banner);
    if (url) el.style.setProperty("--desk-banner", `url("${url}")`);
    const text = el.createDiv("desk-hero-text");
    text.createDiv({ cls: "desk-eyebrow", text: d.day.format("dddd · D MMMM YYYY") });
    text.createDiv({ cls: "desk-greet", text: `${greeting()}, ${this.plugin.settings.name}.` });
    if (d.weekGoal) text.createDiv({ cls: "desk-week", text: d.weekGoal });
    const strip = text.createDiv("desk-strip");
    const mon = d.day.clone().startOf("isoWeek");
    for (let i = 0; i < 7; i++) {
      const day = mon.clone().add(i, "day");
      const key = day.format(ISO);
      const cell = strip.createDiv({ cls: "desk-strip-day" });
      if (key === d.today) cell.addClass("is-today");
      else if (key < d.today) cell.addClass("is-past");
      if (this.app.vault.getAbstractFileByPath(dailyPath(day))) cell.addClass("has-note");
      cell.createSpan({ cls: "desk-strip-wd", text: day.format("dd").slice(0, 2) });
      cell.createSpan({ cls: "desk-strip-n", text: day.format("D") });
      cell.addEventListener("click", () => this.plugin.openDaily(day));
    }
    this.nowEl = el.createDiv("desk-now");
    this.renderNow();
  }

  items() {
    const d = this.data;
    return [...d.daily.blocks.map((b) => ({ ...b, kind: "block" })), ...d.events.filter((e) => !e.allDay)];
  }

  renderNow() {
    const el = this.nowEl;
    if (!el) return;
    el.empty();
    const n = nowMin();
    const live = this.items().filter((x) => !x.done);
    const cur = live.filter((x) => x.start <= n && n < x.end).sort((a, b) => (a.kind === "block" ? -1 : 1))[0];
    const next = live.filter((x) => x.start > n).sort((a, b) => a.start - b.start)[0];
    const head = el.createDiv("desk-now-head");
    if (cur) {
      head.createSpan({ cls: "desk-pulse" });
      head.createSpan({ text: "Now" });
      head.createSpan({ cls: "desk-now-when", text: `${Math.ceil(cur.end - n)} min left` });
      el.createDiv({ cls: "desk-now-title", text: clean(cur.text || cur.title) });
      const bar = el.createDiv("desk-bar");
      bar.createDiv({ cls: "desk-bar-fill" }).style.width = `${Math.min(100, ((n - cur.start) / (cur.end - cur.start)) * 100)}%`;
      const row = el.createDiv("desk-now-acts");
      if (cur.kind === "block") {
        btn(row, "check", "Done", () => this.plugin.toggleBlock(cur));
        btn(row, "plus", "15 min", () => this.plugin.retime(cur, cur.start, cur.end + 15));
      }
      if (next) row.createSpan({ cls: "desk-now-next", text: `then ${fmt(next.start)} ${clean(next.text || next.title)}` });
    } else if (next) {
      const inMin = Math.round(next.start - n);
      head.createSpan({ text: "Next" });
      head.createSpan({ cls: "desk-now-when", text: inMin < 60 ? `in ${inMin} min` : `at ${fmt(next.start)}` });
      el.createDiv({ cls: "desk-now-title", text: clean(next.text || next.title) });
      el.createDiv({ cls: "desk-now-sub", text: `${fmt(next.start)} – ${fmt(next.end)} · free until then` });
    } else {
      const any = this.data.daily.blocks.length;
      head.createSpan({ text: any ? "Clear" : "Open day" });
      el.createDiv({ cls: "desk-now-title", text: any ? "Nothing left on the plan." : "No plan yet." });
    }
  }

  /* ---------- goal + AI ---------- */

  renderGoal() {
    const el = this.goalEl;
    if (el.contains(document.activeElement)) return;
    el.empty();
    el.createDiv({ cls: "desk-label", text: "Today's goal" });
    const ta = el.createEl("textarea", { cls: "desk-goal-input", attr: { rows: 1, placeholder: "What would make today a win?", spellcheck: "false" } });
    ta.value = this.data.daily.goal;
    autogrow(ta);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
    ta.addEventListener("blur", () => { const v = ta.value.replace(/\s+/g, " ").trim(); if (v !== this.data.daily.goal) this.plugin.setGoal(v); });
  }

  /* ---------- timeline ---------- */

  renderDay() {
    const d = this.data, el = this.dayEl, s = this.plugin.settings;
    const prev = el.querySelector(".desk-tl");
    const keep = prev ? prev.scrollTop : null;
    el.empty();
    const blocks = d.daily.blocks;
    const planned = blocks.reduce((a, b) => a + b.end - b.start, 0);
    const head = el.createDiv("desk-card-head");
    head.createDiv({ cls: "desk-card-title", text: "Day" });
    head.createDiv({ cls: "desk-card-meta", text: `${blocks.length} blocks · ${dur(planned)} planned${d.events.length ? ` · ${d.events.length} events` : ""}` });
    btn(head, "plus", "Add block", (e) => this.composer(this.plugin.freeSlot(60), e.currentTarget), "is-icon");

    const allDay = d.events.filter((e) => e.allDay);
    if (allDay.length) {
      const row = el.createDiv("desk-allday");
      for (const e of allDay) row.createSpan({ cls: "desk-pill is-event", text: e.title });
    }
    if (!s.icsUrls.trim() && !blocks.length) el.createDiv({ cls: "desk-hint", text: "Tip: add your calendar's secret iCal link in Desk settings to see meetings here." });

    const tl = el.createDiv("desk-tl");
    this.base = s.startHour * 60;
    const span = (s.endHour - s.startHour) * 60;
    const inner = tl.createDiv("desk-tl-inner");
    inner.style.height = `${span * PX + 16}px`;
    for (let h = s.startHour; h <= s.endHour; h++) {
      const y = (h * 60 - this.base) * PX;
      const row = inner.createDiv("desk-hour");
      row.style.top = `${y}px`;
      row.createSpan({ cls: "desk-hour-label", text: `${String(h).padStart(2, "0")}:00` });
      if (h < s.endHour) inner.createDiv("desk-half").style.top = `${y + 30 * PX}px`;
    }
    const lane = inner.createDiv("desk-lane");
    this.lane = lane;
    const yToMin = (clientY) => snap((clientY - lane.getBoundingClientRect().top) / PX + this.base);
    lane.addEventListener("click", (e) => { if (e.target === lane) this.composer(yToMin(e.clientY), null, e.clientX, e.clientY); });
    lane.addEventListener("dragover", (e) => { e.preventDefault(); lane.addClass("is-drop"); this.ghost(yToMin(e.clientY)); });
    lane.addEventListener("dragleave", (e) => { if (e.target === lane) { lane.removeClass("is-drop"); this.ghost(null); } });
    lane.addEventListener("drop", (e) => {
      e.preventDefault();
      lane.removeClass("is-drop");
      this.ghost(null);
      const t = this.dragTask;
      this.dragTask = null;
      if (t) this.plugin.scheduleTask(t, yToMin(e.clientY), 60);
    });

    const n = nowMin();
    for (const it of lanes(this.items())) {
      if (it.end <= this.base || it.start >= this.base + span) continue;
      const tag = it.kind === "block" ? tagsOf(it.text)[0] : null;
      const b = lane.createDiv({ cls: `desk-blk is-${it.kind}` });
      if (it.done) b.addClass("is-done");
      if (!it.done && it.start <= n && n < it.end) b.addClass("is-live");
      if (/^🔔/u.test(it.text || "")) b.addClass("is-reminder");
      b.style.setProperty("--c", it.kind === "event" ? "var(--d-event)" : tagColor(tag));
      b.style.top = `${(Math.max(it.start, this.base) - this.base) * PX}px`;
      const h = (it.end - Math.max(it.start, this.base)) * PX - 3;
      b.style.height = `${Math.max(20, h)}px`;
      b.style.left = `calc(${(it._col / it._cols) * 100}% + 2px)`;
      b.style.width = `calc(${100 / it._cols}% - 4px)`;
      if (h < 34) b.addClass("is-short");
      if (it.kind === "block") {
        const chk = b.createEl("button", { cls: "desk-blk-check", attr: { "aria-label": "Done", type: "button" } });
        setIcon(chk, it.done ? "check-circle-2" : "circle");
        chk.addEventListener("click", (e) => { e.stopPropagation(); this.plugin.toggleBlock(it); });
      }
      const body = b.createDiv("desk-blk-body");
      body.createDiv({ cls: "desk-blk-title", text: clean(it.text || it.title) });
      const time = body.createDiv({ cls: "desk-blk-time", text: `${fmt(it.start)} – ${fmt(it.end)}${tag ? `  ·  #${tag}` : ""}${it.location ? `  ·  ${it.location}` : ""}` });
      if (it.kind === "block") {
        b.createDiv("desk-blk-grip");
        this.dragBlock(b, it, time);
      } else b.addEventListener("click", (e) => { e.stopPropagation(); this.eventPop(it, b); });
    }
    this.nowLine = inner.createDiv("desk-nowline");
    this.nowLine.createSpan({ cls: "desk-nowline-t" });
    this.placeNowLine();
    requestAnimationFrame(() => {
      if (keep != null && this.scrolled) tl.scrollTop = keep;
      else { tl.scrollTop = Math.max(0, (nowMin() - this.base - 90) * PX); this.scrolled = true; }
    });
  }

  placeNowLine() {
    if (!this.nowLine) return;
    const s = this.plugin.settings, n = nowMin();
    const inside = n >= s.startHour * 60 && n <= s.endHour * 60;
    this.nowLine.toggle(inside);
    this.nowLine.style.top = `${(n - this.base) * PX}px`;
    this.nowLine.firstChild.setText(fmt(n));
  }

  ghost(min) {
    this.lane?.querySelector(".desk-ghost")?.remove();
    if (min == null) return;
    const g = this.lane.createDiv("desk-ghost");
    g.style.top = `${(min - this.base) * PX}px`;
    g.style.height = `${60 * PX - 3}px`;
    g.setText(`${fmt(min)} – ${fmt(min + 60)}`);
  }

  dragBlock(b, it, timeEl) {
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".desk-blk-check")) return;
      const resize = !!e.target.closest(".desk-blk-grip");
      const y0 = e.clientY, len = it.end - it.start;
      let moved = false, ns = it.start, ne = it.end;
      b.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dy = ev.clientY - y0;
        if (!moved && Math.abs(dy) < 5) return;
        moved = true;
        b.addClass("is-drag");
        if (resize) {
          ne = Math.max(it.start + SNAP, snap(it.end + dy / PX));
          b.style.height = `${(ne - it.start) * PX - 3}px`;
        } else {
          ns = snap(it.start + dy / PX);
          ne = ns + len;
          b.style.top = `${(ns - this.base) * PX}px`;
        }
        timeEl.setText(`${fmt(ns)} – ${fmt(ne)}`);
      };
      const up = () => {
        b.removeEventListener("pointermove", move);
        b.removeEventListener("pointerup", up);
        b.removeEventListener("pointercancel", up);
        if (!moved) { this.blockPop(it, b); return; }
        this.plugin.retime(it, ns, ne);
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
    });
  }

  /* ---------- popovers ---------- */

  closePop() { this.pop?.remove(); this.pop = null; }

  openPop(anchor, x, y) {
    this.closePop();
    const pop = this.contentEl.createDiv("desk-pop");
    this.pop = pop;
    requestAnimationFrame(() => {
      const box = this.contentEl.getBoundingClientRect();
      const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
      const w = pop.offsetWidth, h = pop.offsetHeight;
      let left = r.right + 10 - box.left;
      if (left + w > box.width - 12) left = Math.max(12, r.left - w - 10 - box.left);
      let top = Math.min(r.top - box.top, box.height - h - 12);
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(12, top)}px`;
      pop.addClass("is-in");
    });
    return pop;
  }

  composer(start, anchor, x, y) {
    const pop = this.openPop(anchor || (x == null ? this.lane : null), x, y);
    let len = 60;
    const title = pop.createDiv("desk-pop-title");
    const upd = () => title.setText(`${fmt(start)} – ${fmt(start + len)}`);
    upd();
    const input = pop.createEl("input", { cls: "desk-input", attr: { placeholder: "What will you do?", type: "text" } });
    const lens = pop.createDiv("desk-seg");
    for (const m of [15, 30, 45, 60, 90, 120]) {
      const b = lens.createEl("button", { text: dur(m), attr: { type: "button" } });
      if (m === len) b.addClass("is-on");
      b.addEventListener("click", () => { len = m; lens.querySelectorAll("button").forEach((x) => x.removeClass("is-on")); b.addClass("is-on"); upd(); input.focus(); });
    }
    const add = async (text) => {
      if (!text.trim()) return;
      this.closePop();
      await this.plugin.addBlock(start, start + len, text.trim());
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(input.value); });
    const sug = this.data.tasks.overdue.concat(this.data.tasks.today, this.data.tasks.upcoming).slice(0, 6);
    if (sug.length) {
      pop.createDiv({ cls: "desk-label", text: "From your tasks" });
      const list = pop.createDiv("desk-sug");
      for (const t of sug) {
        const row = list.createDiv({ cls: "desk-sug-row" });
        row.style.setProperty("--c", tagColor(t.tags[0]));
        row.createSpan({ cls: "desk-dot" });
        row.createSpan({ text: t.desc });
        row.addEventListener("click", () => { this.closePop(); this.plugin.scheduleTask(t, start, len); });
      }
    }
    const foot = pop.createDiv("desk-pop-foot");
    btn(foot, "bell", "Reminder", () => { this.closePop(); this.plugin.addBlock(start, start + 15, "🔔 " + (input.value.trim() || "Reminder")); });
    btn(foot, "plus", "Add", () => add(input.value), "is-solid");
    setTimeout(() => input.focus(), 30);
  }

  blockPop(it, anchor) {
    const pop = this.openPop(anchor);
    const input = pop.createEl("input", { cls: "desk-input is-title", attr: { type: "text" } });
    input.value = stripMeta(it.text);
    const commit = () => { const v = input.value.trim(); if (v && v !== stripMeta(it.text)) this.plugin.renameBlock(it, v); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); this.closePop(); } });
    input.addEventListener("blur", commit);
    pop.createDiv({ cls: "desk-pop-sub", text: `${fmt(it.start)} – ${fmt(it.end)} · ${dur(it.end - it.start)}` });
    const shift = pop.createDiv("desk-seg");
    const mv = (a, b) => { this.closePop(); this.plugin.retime(it, it.start + a, it.end + b); };
    for (const [label, a, b] of [["−15", -15, -15], ["+15", 15, 15], ["+1h", 60, 60], ["longer", 0, 15], ["shorter", 0, -15]]) {
      const x = shift.createEl("button", { text: label, attr: { type: "button" } });
      x.addEventListener("click", () => (b - a === -15 && it.end - it.start <= 15 ? null : mv(a, b)));
    }
    const foot = pop.createDiv("desk-pop-foot");
    btn(foot, "trash-2", "Delete", () => { this.closePop(); this.plugin.deleteBlock(it); }, "is-ghost");
    btn(foot, it.done ? "rotate-ccw" : "check", it.done ? "Reopen" : "Done", () => { this.closePop(); this.plugin.toggleBlock(it); }, "is-solid");
  }

  eventPop(ev, anchor) {
    const pop = this.openPop(anchor);
    pop.createDiv({ cls: "desk-pop-title", text: ev.title });
    pop.createDiv({ cls: "desk-pop-sub", text: `${fmt(ev.start)} – ${fmt(ev.end)}${ev.location ? " · " + ev.location : ""}` });
  }

  /* ---------- tasks ---------- */

  renderTasks() {
    const el = this.tasksEl, T = this.data.tasks;
    const refocus = el.querySelector(".desk-add input") === document.activeElement;
    el.empty();
    const head = el.createDiv("desk-card-head");
    head.createDiv({ cls: "desk-card-title", text: "Tasks" });
    head.createDiv({ cls: "desk-card-meta", text: `${T.overdue.length + T.today.length} for today · ${this.data.doneToday} done` });
    this.renderDuties();

    const add = el.createDiv("desk-add");
    const input = add.createEl("input", { cls: "desk-input", attr: { type: "text", placeholder: "Add task · 14:30 call Anna · remind 16:00 stretch · #docas" } });
    const seg = add.createDiv("desk-seg is-small");
    for (const [k, label] of [["today", "Today"], ["later", "Later"]]) {
      const b = seg.createEl("button", { text: label, attr: { type: "button" } });
      if (this.target === k) b.addClass("is-on");
      b.addEventListener("click", () => { this.target = k; seg.querySelectorAll("button").forEach((x) => x.removeClass("is-on")); b.addClass("is-on"); input.focus(); });
    }
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      const v = input.value;
      input.value = "";
      await this.plugin.quickAdd(v, this.target);
    });
    if (refocus) input.focus();

    const groups = [
      ["overdue", "Overdue", T.overdue],
      ["today", "Today", T.today],
      ["upcoming", "Next 7 days", T.upcoming],
      ["later", "Someday", T.later],
    ];
    let any = false;
    for (const [key, label, list] of groups) {
      if (!list.length) continue;
      any = true;
      const g = el.createDiv({ cls: `desk-group is-${key}` });
      const gh = g.createDiv("desk-group-head");
      const isOpen = this.expanded.has(key);
      setIcon(gh.createSpan("desk-caret"), isOpen ? "chevron-down" : "chevron-right");
      gh.createSpan({ text: label });
      gh.createSpan({ cls: "desk-count", text: String(list.length) });
      gh.addEventListener("click", () => { isOpen ? this.expanded.delete(key) : this.expanded.add(key); this.renderTasks(); });
      if (!isOpen) continue;
      for (const t of list) this.taskRow(g, t, key);
    }
    if (!any) el.createDiv({ cls: "desk-empty", text: "Nothing due. Add a task or plan a block." });
  }

  renderDuties() {
    const d = this.data;
    const stale = d.projects.filter((p) => !p.updatedThisWeek).sort((a, b) => (a.lastLog || "").localeCompare(b.lastLog || ""));
    if (!stale.length) return;
    const box = this.tasksEl.createDiv("desk-duties");
    box.createDiv({ cls: "desk-label", text: "This week · project update" });
    for (const p of stale) {
      const row = box.createDiv("desk-duty");
      row.style.setProperty("--c", tagColor(p.slug));
      const body = row.createDiv("desk-duty-body");
      body.createDiv({ cls: "desk-duty-title", text: p.title });
      body.createDiv({ cls: "desk-duty-sub", text: p.lastLog ? `Last update ${p.lastLog}` : "No update yet" });
      btn(row, "arrow-up-right", "Open", () => this.plugin.openProject(p.file), "is-soft");
      row.addEventListener("click", () => this.plugin.openProject(p.file));
    }
  }

  taskRow(parent, t, key) {
    const today = this.data.today;
    const row = parent.createDiv({ cls: "desk-task" });
    if (t.prio >= 3) row.addClass("is-hi");
    row.style.setProperty("--c", tagColor(t.tags[0]));
    row.draggable = true;
    row.addEventListener("dragstart", (e) => { this.dragTask = t; e.dataTransfer.setData("text/plain", t.desc); e.dataTransfer.effectAllowed = "copy"; row.addClass("is-dragging"); });
    row.addEventListener("dragend", () => { row.removeClass("is-dragging"); this.ghost(null); });
    const chk = row.createEl("button", { cls: "desk-check", attr: { "aria-label": "Complete", type: "button" } });
    chk.addEventListener("click", async (e) => {
      e.stopPropagation();
      row.addClass("is-checking");
      await sleep(260);
      await this.plugin.toggleTask(t);
    });
    const body = row.createDiv("desk-task-body");
    body.createDiv({ cls: "desk-task-text", text: t.desc });
    const meta = body.createDiv("desk-task-meta");
    for (const tag of t.tags.slice(0, 2)) meta.createSpan({ cls: "desk-tag", text: "#" + tag }).style.setProperty("--c", tagColor(tag));
    if (t.due) meta.createSpan({ cls: "desk-due" + (t.due < today ? " is-late" : ""), text: "due " + relDay(t.due, today) });
    else if (key === "overdue" && (t.scheduled || t.implied)) meta.createSpan({ cls: "desk-due is-late", text: "from " + relDay(t.scheduled || t.implied, today).replace(" late", " ago") });
    if (!t.isToday) meta.createSpan({ cls: "desk-src", text: t.file.basename });
    const acts = row.createDiv("desk-task-acts");
    btn(acts, "calendar-plus", "Schedule next free hour", () => this.plugin.scheduleTask(t, this.plugin.freeSlot(60), 60), "is-icon");
    btn(acts, "arrow-up-right", "Open", () => this.plugin.openAt(t.file, t.line), "is-icon");
  }

  /* ---------- projects ---------- */

  renderProjects() {
    const el = this.projectsEl, P = this.data.projects;
    el.empty();
    const head = el.createDiv("desk-card-head");
    head.createDiv({ cls: "desk-card-title", text: "Projects" });
    head.createDiv({ cls: "desk-card-meta", text: `${P.length} active` });
    const list = el.createDiv("desk-proj-list");
    for (const p of P) {
      const card = list.createDiv("desk-proj");
      card.style.setProperty("--c", tagColor(p.slug));
      const thumb = card.createDiv("desk-proj-thumb");
      if (p.banner) thumb.style.backgroundImage = `url("${p.banner}")`;
      const body = card.createDiv("desk-proj-body");
      const top = body.createDiv("desk-proj-top");
      top.createSpan({ cls: "desk-proj-name", text: p.title });
      if (p.stageDate) top.createSpan({ cls: "desk-pill" + (p.daysLeft != null && p.daysLeft < 21 ? " is-warn" : ""), text: p.stageDate });
      else if (p.daysLeft != null) top.createSpan({ cls: "desk-pill" + (p.daysLeft < 21 ? " is-warn" : ""), text: p.daysLeft >= 0 ? `${p.daysLeft}d left` : "past due" });
      if (p.open) top.createSpan({ cls: "desk-pill", text: `${p.open} open` });
      if (p.now) body.createDiv({ cls: "desk-proj-now", text: p.now });
      if (p.you) body.createDiv({ cls: "desk-proj-you", text: "You — " + p.you });
      if (p.total) {
        const bar = body.createDiv("desk-bar is-thin");
        bar.createDiv("desk-bar-fill").style.width = `${(p.done / p.total) * 100}%`;
      }
      const acts = card.createDiv("desk-proj-acts");
      btn(acts, "play", "Focus 45m", () => this.plugin.focusProject(p), "is-icon");
      btn(acts, "arrow-up-right", "Open", () => this.plugin.openProject(p.file), "is-icon");
      card.addEventListener("click", () => this.plugin.openProject(p.file));
    }
  }

  }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================ */

export class Desk {
  constructor(plugin) { this.plugin = plugin; }
  get app() { return this.plugin.app; }

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, this.plugin.deskData || {});
    this.plugin.deskData = this.settings;
    this.fired = new Set();
    this.firedDay = "";
    this.plugin.registerView(VIEW_TYPE, (leaf) => new DeskView(leaf, this));
    this.plugin.addRibbonIcon("sunrise", "Open desk", () => this.openDesk());
    this.plugin.addCommand({ id: "open-desk", name: "Open desk", callback: () => this.openDesk() });

    const bump = () => { window.clearTimeout(this.t); this.t = window.setTimeout(() => this.views().forEach((v) => v.refresh()), 500); };
    this.plugin.registerEvent(this.app.metadataCache.on("changed", bump));
    this.plugin.registerEvent(this.app.vault.on("delete", bump));
    this.plugin.registerEvent(this.app.vault.on("rename", bump));
    this.plugin.registerInterval(window.setInterval(() => this.remind(), 20000));

    this.app.workspace.onLayoutReady(async () => {
      await this.openDesk(true);
      this.remind();
    });
  }

  views() { return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v) => v instanceof DeskView); }
  jarvis() { return this.plugin; }
  renderSettings(el) { renderDeskSettings(el, this); }
  async saveSettings() {
    this.plugin.deskData = this.settings;
    await this.plugin.saveSettings();
    this.evCache = null;
    this.views().forEach((v) => v.refresh());
  }

  resource(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? this.app.vault.getResourcePath(f) : null;
  }

  async openDesk(startup = false) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = startup ? ws.getLeaf(false) : ws.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (startup) for (const l of ws.getLeavesOfType("markdown")) if (l.getRoot() === ws.rootSplit) l.detach();
    ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
  }

  async openProject(file) {
    const text = await this.app.vault.cachedRead(file);
    const lines = text.split("\n");
    let line = lines.findIndex((l) => /^## .+ · now —/.test(l));
    if (line < 0) line = lines.findIndex((l) => l.trim() === "# Timeline");
    await this.openAt(file, Math.max(0, line));
  }

  async openAt(file, line) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { eState: { line } });
  }

  async openDaily(day) {
    const f = await this.ensureDaily(day);
    await this.openAt(f, 0);
  }

  /* ---------- files ---------- */

  async ensureDaily(day = M()) {
    const path = dailyPath(day);
    const got = this.app.vault.getAbstractFileByPath(path);
    if (got instanceof TFile) return got;
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    const tpl = this.app.vault.getAbstractFileByPath(this.settings.template);
    let body = tpl instanceof TFile ? await this.app.vault.read(tpl) : "# Goal\n\n# Day planner\n\n- [ ]\n\n# Reflection\n\n- Moved the goal:\n- Carries to tomorrow:\n";
    body = body.replace(/\{\{date(?::([^}]+))?\}\}/g, (_, f) => day.format(f || ISO));
    return await this.app.vault.create(path, body);
  }

  async edit(file, fn) {
    try { await this.app.vault.process(file, fn); }
    catch (e) { new Notice(e.message || String(e)); }
  }

  lineIndex(lines, i, raw) {
    if (lines[i] === raw) return i;
    const j = lines.indexOf(raw);
    if (j < 0) throw new Error("That line changed — refreshed.");
    return j;
  }

  async setGoal(goal) {
    const f = await this.ensureDaily();
    await this.edit(f, (text) => {
      const g = section(text, "Goal");
      if (!g) return text.replace(/^(---\n[\s\S]*?\n---\n)?/, (fm) => `${fm}\n# Goal\n\n${goal}\n\n`);
      const body = text.slice(g.start, g.end);
      const fence = body.search(/^```/m);
      const tail = fence >= 0 ? body.slice(fence).replace(/\s*$/, "") + "\n\n" : "";
      return text.slice(0, g.start) + `\n\n${goal ? goal + "\n\n" : ""}${tail}` + text.slice(g.end).replace(/^\n+/, "");
    });
  }

  async logProject(p, text) {
    const today = M().format(ISO);
    const line = `* **Update**: ${text}`;
    const head = `## ${today}`;
    await this.edit(p.file, (src) => {
      const log = section(src, "Log");
      if (!log) return src.replace(/\s*$/, `\n\n# Log\n\n${head}\n${line}\n`);
      const body = src.slice(log.start, log.end);
      const at = body.indexOf(head);
      if (at >= 0) {
        const insertAt = log.start + at + head.length;
        return src.slice(0, insertAt) + `\n${line}` + src.slice(insertAt);
      }
      const rest = src.slice(log.start).replace(/^\n+/, "\n");
      return src.slice(0, log.start) + `\n\n${head}\n${line}\n` + rest;
    });
  }

  async setReflection(key, value) {
    const f = await this.ensureDaily();
    const label = key === "moved" ? "Moved the goal:" : "Carries to tomorrow:";
    await this.edit(f, (text) => {
      const re = new RegExp(`^- ${esc(label)}.*$`, "m");
      const line = `- ${label}${value ? " " + value : ""}`;
      if (re.test(text)) return text.replace(re, line);
      const r = section(text, "Reflection");
      if (r) return text.slice(0, r.end).replace(/\s*$/, "\n") + line + "\n" + text.slice(r.end);
      return text.replace(/\s*$/, "\n\n# Reflection\n\n") + line + "\n";
    });
  }

  async addBlock(start, end, text) {
    const f = await this.ensureDaily();
    const line = `- [ ] ${fmt(start)} - ${fmt(end)} ${text}`;
    await this.edit(f, (src) => this.insertPlanner(src, line, start));
    this.nudge();
  }

  insertPlanner(src, line, start) {
    let p = section(src, "Day planner");
    if (!p) {
      const r = section(src, "Reflection");
      const at = r ? r.head : src.length;
      src = src.slice(0, at).replace(/\s*$/, "\n\n") + "# Day planner\n\n" + (r ? "\n" + src.slice(at) : "");
      p = section(src, "Day planner");
    }
    const lines = src.split("\n");
    const first = lineAt(src, p.start) + 1;
    const last = Math.min(lineAt(src, p.end), lines.length - 1);
    let at = -1, lastItem = first - 1;
    for (let i = first; i <= last; i++) {
      const ln = lines[i];
      if (/^- \[ \]\s*$/.test(ln) && start == null) { lines[i] = line; return lines.join("\n"); }
      if (ln.trim()) lastItem = i;
      const m = ln.match(/^- \[.\]\s+(\d{1,2}:\d{2})/);
      if (start != null && m && toMin(m[1]) > start && at < 0) at = i;
    }
    if (at < 0) at = lastItem + 1;
    if (at === first) {
      if ((lines[first] ?? "").trim() === "" && first < lines.length) at = first + 1;
      else lines.splice(at++, 0, "");
    }
    lines.splice(at, 0, line);
    return lines.join("\n");
  }

  async retime(b, start, end) {
    start = Math.max(0, start);
    end = Math.min(1439, Math.max(start + 5, end));
    const f = await this.ensureDaily();
    await this.edit(f, (src) => {
      const lines = src.split("\n");
      const i = this.lineIndex(lines, b.line, b.raw);
      lines[i] = lines[i].replace(TIME_PREFIX, `$1${fmt(start)} - ${fmt(end)} `);
      return lines.join("\n");
    });
  }

  async renameBlock(b, text) {
    const f = await this.ensureDaily();
    await this.edit(f, (src) => {
      const lines = src.split("\n");
      const i = this.lineIndex(lines, b.line, b.raw);
      const dates = (b.text.match(DATE_EMOJI) || []).join("");
      lines[i] = `- [${b.done ? "x" : " "}] ${fmt(b.start)} - ${fmt(b.end)} ${text}${dates}`;
      return lines.join("\n");
    });
  }

  async deleteBlock(b) {
    const f = await this.ensureDaily();
    await this.edit(f, (src) => {
      const lines = src.split("\n");
      lines.splice(this.lineIndex(lines, b.line, b.raw), 1);
      return lines.join("\n");
    });
  }

  async toggleLine(file, line, raw) {
    const today = M().format(ISO);
    const api = this.app.plugins.plugins["obsidian-tasks-plugin"]?.apiV1;
    await this.edit(file, (src) => {
      const lines = src.split("\n");
      const i = this.lineIndex(lines, line, raw);
      let next = null;
      try { next = api?.executeToggleTaskDoneCommand?.(lines[i], file.path) || null; } catch (_) { next = null; }
      if (!next) {
        next = /\[[xX]\]/.test(lines[i])
          ? lines[i].replace(/\[[xX]\]/, "[ ]").replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, "")
          : lines[i].replace(/\[( |\/)\]/, "[x]") + ` ✅ ${today}`;
      }
      lines.splice(i, 1, ...next.split("\n"));
      return lines.join("\n");
    });
  }

  async toggleTask(t) { await this.toggleLine(t.file, t.line, t.raw); }

  async toggleBlock(b) {
    const f = await this.ensureDaily();
    await this.toggleLine(f, b.line, b.raw);
    if (b.done) return;
    const key = norm(b.text);
    const twin = (this.latest?.allOpen || []).find((t) => !t.isToday && norm(t.body) === key);
    if (twin) await this.toggleTask(twin);
    new Notice(`✓ ${clean(b.text)}`);
  }

  async scheduleTask(t, start, len) {
    await this.addBlock(start, start + len, stripMeta(t.body));
  }

  async focusProject(p) {
    const start = Math.ceil(nowMin() / 5) * 5;
    await this.addBlock(start, start + 45, `${p.now ? p.now.replace(/\s*[—–-]\s*$/, "") : p.title} #${p.slug}`);
  }

  async quickAdd(raw, target) {
    let s = raw.trim();
    const rem = s.match(/^remind(?:\s+me)?(?:\s+at)?\s+(\d{1,2}:\d{2})\s+(?:to\s+)?(.+)$/i);
    if (rem) { const a = toMin(rem[1]); return this.addBlock(a, a + 15, "🔔 " + rem[2]); }
    const tm = s.match(/^(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s+(.+)$/);
    if (tm) { const a = toMin(tm[1]); return this.addBlock(a, tm[2] ? toMin(tm[2]) : a + 30, tm[3]); }
    let date = null;
    if (/\btomorrow\b/i.test(s)) { date = M().add(1, "day").format(ISO); s = s.replace(/\s*\btomorrow\b/i, "").trim(); }
    if (date || target === "later") {
      const f = this.app.vault.getAbstractFileByPath(this.settings.backlog);
      const line = `- [ ] ${s}${date ? ` ⏳ ${date}` : ""}`;
      if (f instanceof TFile) await this.edit(f, (src) => src.replace(/\s*$/, "\n") + line + "\n");
      else await this.app.vault.create(this.settings.backlog, line + "\n");
      new Notice(date ? "Added for tomorrow" : "Added to backlog");
      return;
    }
    const f = await this.ensureDaily();
    await this.edit(f, (src) => this.insertPlanner(src, `- [ ] ${s}`, null));
  }

  freeSlot(len) {
    const s = this.settings;
    const busy = [...(this.latest?.daily.blocks || []), ...(this.latest?.events || []).filter((e) => !e.allDay)]
      .map((x) => [x.start, x.end]).sort((a, b) => a[0] - b[0]);
    let t = Math.max(s.startHour * 60, Math.ceil(nowMin() / SNAP) * SNAP);
    for (const [a, b] of busy) {
      if (b <= t) continue;
      if (a - t >= len) break;
      t = Math.max(t, Math.ceil(b / SNAP) * SNAP);
    }
    return Math.min(t, s.endHour * 60 - len);
  }

  nudge() {
    this.latestAt = 0;
  }

  async ensureReflection(file, today, scan) {
    const named = (s) => clean(s).toLowerCase() === "reflection";
    if (scan.open.some((t) => named(t.body)) || scan.doneList.some((s) => s.toLowerCase() === "reflection")) return false;
    const line = `- [ ] Reflection 🔁 every day 📅 ${today}`;
    await this.edit(file, (text) => {
      if (/^- \[[ xX]\] Reflection\b/m.test(text)) return text;
      const r = section(text, "Reflection");
      if (r) return text.slice(0, r.end).replace(/\s*$/, "\n") + line + "\n" + text.slice(r.end);
      return text.replace(/\s*$/, `\n\n# Reflection\n\n${line}\n`);
    });
    return true;
  }

  /* ---------- data ---------- */

  async collect() {
    const day = M();
    const today = day.format(ISO);
    const file = await this.ensureDaily(day);
    let scan = await this.scanTasks(today, file.path);
    if (!(await this.ensureReflection(file, today, scan))) {
      /* already on the list */
    } else {
      scan = await this.scanTasks(today, file.path);
    }
    const daily = parseDaily(await this.app.vault.cachedRead(file));
    const events = await this.loadEvents(day);
    const planned = new Set(daily.blocks.map((b) => norm(b.text)));
    const cutoff = day.clone().subtract(3, "days").format(ISO);
    const week = day.clone().add(7, "days").format(ISO);
    const tasks = { overdue: [], today: [], upcoming: [], later: [] };
    for (const t of scan.open) {
      if (t.isToday && TIME_PREFIX.test(t.raw)) continue;
      if (planned.has(norm(t.body))) continue;
      const sched = t.scheduled || t.implied;
      if ((t.due && t.due < today) || (t.scheduled && t.scheduled < today) || (!t.scheduled && t.implied && t.implied < today && t.implied >= cutoff)) tasks.overdue.push(t);
      else if (t.due === today || sched === today || (t.start && t.start <= today && !t.due)) tasks.today.push(t);
      else if (t.due && t.due <= week) tasks.upcoming.push(t);
      else if (!t.due && !sched && t.indent === 0) tasks.later.push(t);
    }
    const byUrg = (a, b) => b.prio - a.prio || (a.due || "9").localeCompare(b.due || "9");
    Object.values(tasks).forEach((l) => l.sort(byUrg));
    tasks.later = tasks.later.slice(0, 30);
    const y = parseDaily(await this.readIf(dailyPath(day.clone().subtract(1, "day"))));
    const data = {
      day, today, file, daily, events, tasks,
      allOpen: scan.open,
      doneToday: scan.doneToday,
      doneList: scan.doneList,
      projects: await this.projects(scan.open, today),
      weekGoal: await this.weekGoal(day),
      yesterdayCarries: y.carries,
    };
    this.latest = data;
    this.latestAt = Date.now();
    return data;
  }

  async readIf(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? await this.app.vault.cachedRead(f) : "";
  }

  async weekGoal(day) {
    const end = day.clone().endOf("isoWeek");
    const path = `Journal/${end.format("YYYY-MM")}/${end.format(ISO)} Wochenjournal W${String(day.isoWeek()).padStart(2, "0")}.md`;
    return parseDaily(await this.readIf(path)).goal;
  }

  async scanTasks(today, todayPath) {
    const open = [], doneList = [];
    let doneToday = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith("Templates/") || f.path.startsWith("Wiki/Sources/")) continue;
      const items = this.app.metadataCache.getFileCache(f)?.listItems?.filter((li) => li.task !== undefined);
      if (!items?.length) continue;
      const lines = (await this.app.vault.cachedRead(f)).split("\n");
      const im = f.path.match(/^Journal\/\d{4}-\d{2}\/(\d{2})-(\d{2})-(\d{4})\.md$/);
      const implied = im ? `${im[3]}-${im[2]}-${im[1]}` : null;
      for (const li of items) {
        const ln = lines[li.position.start.line];
        const m = ln && ln.match(/^(\s*)(?:>\s*)?[-*+] \[(.)\] (.*)$/);
        if (!m) continue;
        const body = m[3];
        if (m[2] === "x" || m[2] === "X") {
          if (body.includes("✅ " + today)) { doneToday++; doneList.push(clean(body)); }
          continue;
        }
        if (m[2] !== " " && m[2] !== "/") continue;
        const desc = clean(body.replace(/^\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\s*/, ""));
        if (!desc) continue;
        open.push({
          file: f, line: li.position.start.line, raw: ln, body, desc,
          tags: tagsOf(body), due: pickDate(body, "📅"), scheduled: pickDate(body, "⏳"), start: pickDate(body, "🛫"),
          implied, prio: prioOf(body), indent: m[1].length, isToday: f.path === todayPath,
        });
      }
    }
    return { open, doneToday, doneList };
  }

  async projects(open, today) {
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!/^Projects\/[^/]+\.md$/.test(f.path)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      if (fm.status === "done" || fm.status === "archived") continue;
      const text = await this.app.vault.cachedRead(f);
      const stages = parseTimeline(text);
      const path = section(text, "Path");
      let now = "", you = "", stageDate = "", done = 0, total = 0;
      if (stages.length) {
        total = stages.length;
        done = stages.filter((s) => s.status === "done").length;
        const cur = stages.find((s) => s.status === "now") || stages.find((s) => s.status === "later");
        if (cur) {
          now = cur.title;
          you = cur.you;
          stageDate = cur.date !== "open" ? cur.date : "";
        }
      } else if (path) {
        for (const ln of text.slice(path.start, path.end).split("\n")) {
          const m = ln.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/);
          if (!m || /^\s{2,}/.test(ln)) continue;
          total++;
          if (/^~~.*~~/.test(m[1].trim()) || /^\[x\]/i.test(m[1])) { done++; continue; }
          if (!now || /\*\*Now\*\*/.test(m[1])) now = clean(m[1].replace(/\*\*Now\*\*\s*[—–-]?\s*/, ""));
        }
      }
      const slug = f.basename.toLowerCase().replace(/\s+/g, "-");
      const slugs = new Set([slug, slug.replace(/-/g, ""), ...[].concat(fm.aliases || []).map((a) => String(a).toLowerCase().replace(/\s+/g, "-"))]);
      const bm = String(fm.banner || "").match(/\[\[([^\]|]+)/);
      const bf = bm ? this.app.metadataCache.getFirstLinkpathDest(bm[1], f.path) : null;
      const due = stageDate || (fm.mode === "deadline" ? String(fm.end || "") : "");
      const dueM = due ? window.moment(due, ISO, true) : null;
      const days = dueM && dueM.isValid() ? dueM.diff(window.moment(today, ISO), "days") : null;
      const log = section(text, "Log");
      let lastLog = "";
      if (log) {
        for (const m of text.slice(log.start, log.end).matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)) {
          if (m[1] > lastLog) lastLog = m[1];
        }
      }
      const weekStart = window.moment(today, ISO).startOf("isoWeek").format(ISO);
      out.push({
        file: f, slug, title: fm.title || f.basename, now: now.replace(/[.:]\s*$/, ""), you, stageDate, done, total,
        daysLeft: days, banner: bf ? this.app.vault.getResourcePath(bf) : null,
        open: open.filter((t) => t.tags.some((x) => slugs.has(x))).length,
        lastLog, updatedThisWeek: !!lastLog && lastLog >= weekStart,
      });
    }
    return out.sort((a, b) => (a.daysLeft ?? 1e4) - (b.daysLeft ?? 1e4) || b.open - a.open);
  }

  async loadEvents(day) {
    const urls = this.settings.icsUrls.split(/\s+/).filter(Boolean);
    if (!urls.length) return [];
    const key = day.format(ISO);
    if (this.evCache && this.evCache.key === key && Date.now() - this.evCache.at < 15 * 60e3) return this.evCache.events;
    const events = [];
    for (const url of urls) {
      try {
        const res = await requestUrl({ url: url.replace(/^webcal:/, "https:") });
        events.push(...eventsOn(parseICS(res.text), day));
      } catch (e) {
        console.warn("desk: calendar", e);
      }
    }
    events.sort((a, b) => a.start - b.start);
    this.evCache = { key, at: Date.now(), events };
    return events;
  }

  /* ---------- reminders ---------- */

  async remind() {
    const day = M().format(ISO);
    if (this.firedDay !== day) { this.fired = new Set(); this.firedDay = day; }
    if (!this.latest || this.latest.today !== day || Date.now() - (this.latestAt || 0) > 5 * 60e3) {
      try { await this.collect(); } catch (_) { return; }
    }
    const d = this.latest, n = nowMin(), lead = this.settings.remindLead;
    const items = [...d.daily.blocks, ...d.events.filter((e) => !e.allDay)].filter((x) => !x.done);
    for (const it of items) {
      const title = clean(it.text || it.title);
      const key = `${it.start}|${title}`;
      if (lead > 0 && n >= it.start - lead && n < it.start && !this.fired.has(key + ":lead")) {
        this.fired.add(key + ":lead");
        this.notify(`In ${Math.max(1, Math.round(it.start - n))} min`, `${fmt(it.start)} ${title}`);
      }
      if (n >= it.start && n < it.start + 2 && !this.fired.has(key + ":start")) {
        this.fired.add(key + ":start");
        this.notify(/^🔔/u.test(it.text || "") ? "Reminder" : "Now", title);
      }
    }
    const h = new Date().getHours();
    if (h >= this.settings.reflectHour && !d.daily.moved && !this.fired.has("reflect")) {
      this.fired.add("reflect");
      this.notify("Time to reflect", "Two lines: what moved, what carries.");
    }
    if (h >= 8 && h < 11 && !d.daily.goal && !d.daily.blocks.length && !this.fired.has("plan")) {
      this.fired.add("plan");
      this.notify("Plan your day", "Set one goal and a few blocks.");
    }
  }

  notify(title, body) {
    const n = new Notice(`${title} — ${body}`, 12000);
    n.noticeEl?.addEventListener("click", () => this.openDesk());
    try {
      if (!window.Notification) return;
      if (Notification.permission === "granted") new Notification(title, { body });
      else if (Notification.permission === "default") Notification.requestPermission();
    } catch (_) { /* no system notifications */ }
  }

  /* ---------- Jarvis ---------- */

  async context() {
    const d = this.latest && this.latest.today === M().format(ISO) ? this.latest : await this.collect();
    const n = nowMin(), s = this.settings;
    const busy = [...d.daily.blocks, ...d.events.filter((e) => !e.allDay)].sort((a, b) => a.start - b.start);
    const free = [];
    let t = Math.max(s.startHour * 60, Math.ceil(n / 5) * 5);
    for (const x of busy) { if (x.start - t >= 20) free.push(`${fmt(t)}–${fmt(x.start)}`); t = Math.max(t, x.end); }
    if (s.endHour * 60 - t >= 20) free.push(`${fmt(t)}–${fmt(s.endHour * 60)}`);
    const task = (x) => `- ${x.desc}${x.tags.length ? " #" + x.tags.join(" #") : ""}${x.due ? " (due " + x.due + ")" : ""} [${x.file.path}:${x.line + 1}]`;
    return [
      `[Desk context — ${d.day.format("dddd YYYY-MM-DD")}, now ${fmt(n)}]`,
      `Today's journal: ${d.file.path}`,
      d.weekGoal ? `Week goal: ${d.weekGoal}` : "",
      `Goal: ${d.daily.goal || "(empty)"}`,
      `Calendar: ${d.events.map((e) => (e.allDay ? "all-day " : `${fmt(e.start)}–${fmt(e.end)} `) + e.title).join("; ") || "(none)"}`,
      `Planner: ${d.daily.blocks.map((b) => `[${b.done ? "x" : " "}] ${fmt(b.start)}–${fmt(b.end)} ${clean(b.text)}`).join("; ") || "(empty)"}`,
      `Free windows: ${free.join(", ") || "(none)"}`,
      `Overdue:\n${d.tasks.overdue.slice(0, 12).map(task).join("\n") || "(none)"}`,
      `Due/scheduled today:\n${d.tasks.today.slice(0, 15).map(task).join("\n") || "(none)"}`,
      `Next 7 days:\n${d.tasks.upcoming.slice(0, 8).map(task).join("\n") || "(none)"}`,
      `Projects:\n${d.projects.map((p) => `- ${p.title}${p.stageDate ? ` by ${p.stageDate}` : ""}${p.now ? " — " + p.now : ""}${p.you ? ". You: " + p.you : ""} #${p.slug} [${p.file.path}]`).join("\n")}`,
      `Done today: ${d.doneList.join("; ") || "(nothing yet)"}`,
      d.yesterdayCarries ? `Yesterday carried: ${d.yesterdayCarries}` : "",
    ].filter(Boolean).join("\n");
  }

  async ask(display, instruction) {
    const vt = this.jarvis();
    if (!vt?.askJarvis) { new Notice("Enable Vault Talk to use Jarvis."); return; }
    await this.openDesk();
    const ctx = await this.context();
    await vt.askJarvis(display, `${ctx}\n\n${instruction}`);
  }

  aiPlan() {
    const path = dailyPath(M());
    return this.ask("Plan my day", `Plan my day. Edit ${path}: if # Goal is empty, write one concrete goal line there. Under # Day planner keep every existing line and add 3–6 timed blocks as "- [ ] HH:mm - HH:mm task #tag", only inside the free windows, around calendar events, with a short break roughly every 2 hours. Prefer overdue and due-today tasks and the project Now steps closest to their deadline; copy task text verbatim when scheduling an existing task. Then tell me the plan in two short sentences.`);
  }
  aiReplan() {
    const path = dailyPath(M());
    return this.ask("Replan the rest of my day", `Replan the rest of today from now. In ${path} under # Day planner: leave done and past blocks alone; move or drop open future blocks so they fit the free windows realistically, and add at most two new blocks if there is room. Keep the "- [ ] HH:mm - HH:mm text" format. Then say what changed in one sentence.`);
  }
  aiNext() {
    return this.ask("What now?", "What should I do right now? Answer in one or two sentences, concrete, based on the time, the plan, the goal and deadlines. Do not edit files.");
  }
  aiReflect() {
    const path = dailyPath(M());
    return this.ask("Draft my reflection", `Draft my reflection. In ${path} under # Reflection, fill "- Moved the goal:" and "- Carries to tomorrow:" with one short honest line each, based on the goal vs the done blocks and tasks. Keep anything I already wrote there. Then read it back to me in one sentence and ask one question to sharpen tomorrow.`);
  }
  aiFocus(what) {
    return this.ask(`Coach me: ${what}`, `I'm starting now on: ${what}. Give me the single most useful first step for the next 45 minutes in one or two sentences. Do not edit files.`);
  }
  aiBreakdown(t) {
    return this.ask(`Break down: ${t.desc}`, `Break this task into 2–4 concrete subtasks: "${t.desc}" in ${t.file.path} at line ${t.line + 1}. Add them as indented "    - [ ]" lines directly under that line, keep the original line unchanged, keep any #tags. Then list them back in one sentence.`);
  }
}

function renderDeskSettings(el, plugin) {
    const s = plugin.settings;
    el.createEl("h3", { text: "Desk" });
    const text = (name, desc, key, parse = (v) => v) => new Setting(el).setName(name).setDesc(desc).addText((t) => t.setValue(String(s[key])).onChange(async (v) => { s[key] = parse(v); await plugin.saveSettings(); }));
    const num = (v) => Math.max(0, Math.min(23, parseInt(v, 10) || 0));
    text("Name", "Used in the greeting.", "name");
    new Setting(el).setName("Calendars (iCal)").setDesc("Secret iCal / webcal addresses, one per line. Google Calendar → Settings → your calendar → Secret address in iCal format.")
      .addTextArea((t) => { t.setValue(s.icsUrls).onChange(async (v) => { s.icsUrls = v; await plugin.saveSettings(); }); t.inputEl.rows = 3; t.inputEl.style.width = "100%"; });
    text("Day starts", "Hour (0–23).", "startHour", num);
    text("Day ends", "Hour (0–23).", "endHour", num);
    text("Reflection hour", "From this hour the desk switches to evening mode.", "reflectHour", num);
    text("Reminder lead", "Minutes before a block to notify (0 = only at start).", "remindLead", (v) => Math.max(0, parseInt(v, 10) || 0));
    text("Banner", "Vault path of the hero image.", "banner");
    text("Backlog note", "Where 'Later' tasks go.", "backlog");
    new Setting(el).setName("Open on startup").addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await plugin.saveSettings(); }));
}

