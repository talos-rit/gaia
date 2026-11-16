// Gaia client: HTMX does the fragments; this file only handles live streams (jobs, logs),
// the modal, and a couple of UX niceties. No build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- drawer ------------------------------------------------------------------------------
const drawer = () => $("#drawer");

// Activity stays collapsed while commands run (it's half the screen): progress shows in the
// collapsed bar (current job + step, thin moving line, a badge next to "Activity").
// A failure leaves a red badge until Activity is opened.
const running = new Set();
let unseenFailure = false;
function setActivity(state, text) {
  const s = $("#activity-status");
  if (s) {
    s.className = state;
    s.textContent = text;
  }
  drawer().classList.toggle("busy", running.size > 0);
  const b = $("#activity-badge");
  if (!b) return;
  if (running.size) {
    b.className = "running";
    b.textContent = running.size > 1 ? `◌ ${running.size}` : "◌";
  } else if (unseenFailure && !drawer().classList.contains("open")) {
    b.className = "failed";
    b.textContent = "✗";
  } else b.textContent = "";
}
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const jobTitle = (jobEl) => $("summary b", jobEl)?.textContent ?? "job";

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-toggle-drawer]")) {
    drawer().classList.toggle("open");
    if (drawer().classList.contains("open")) unseenFailure = false;
    setActivity($("#activity-status")?.className ?? "muted", $("#activity-status")?.textContent ?? "");
  }
  if (e.target.closest("[data-close-modal]")) closeModal();
  // Close dropdown menus when clicking elsewhere or after choosing an item.
  for (const d of $$("details.menu[open]")) {
    if (!d.contains(e.target) || e.target.closest(".menu-item")) d.open = false;
  }
});

// ---- settings forms (src/ui/settingsForm.tsx) ---------------------------------------------
// [data-fill] buttons put values into the form: a detected USB device's "Use as …", and a changed
// field's reset button (gaia.config.yaml's value; Save then writes it like any other edit).
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-fill]");
  const form = btn?.closest("form");
  if (!form) return;
  for (const [name, value] of Object.entries(JSON.parse(btn.dataset.fill))) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = !!value;
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (btn.hasAttribute("data-reset")) {
    const row = btn.closest(".setting");
    row?.classList.remove("changed");
    $(".changed-mark", row)?.remove();
    btn.remove();
  }
});

// Unsaved edits: closing the modal (Cancel, ×, Esc), or leaving it for another form or the
// Sources panel, asks first. A form that came back with errors counts as edited (data-dirty).
const snapshot = (form) => JSON.stringify([...new FormData(form)].filter(([k]) => k !== "applyUsb"));
const settingsForm = () => $("#modal[open] form.settings-form");
function isDirty() {
  const form = settingsForm();
  return !!form && (form.dataset.dirty === "1" || snapshot(form) !== form.dataset.initial);
}
const askDiscard = () =>
  isDirty() ? askConfirm({ message: "Your changes haven't been saved.", action: "Discard changes", tone: "danger" }) : Promise.resolve(true);
function closeModal() {
  askDiscard().then((yes) => yes && $("#modal").close());
}
$("#modal")?.addEventListener("cancel", (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  closeModal();
});

// Source › Change: close the settings and open that component's Change form in the Sources panel.
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-open-source]");
  if (!btn) return;
  askDiscard().then((yes) => {
    if (!yes) return;
    $("#modal").close();
    const menu = $(`.src[data-source="${btn.dataset.openSource}"] details.menu`);
    if (!menu) return;
    // Not smooth: the menu measures where it has room as it opens, so it has to be in place first.
    menu.scrollIntoView({ block: "center" });
    menu.open = true;
    $("input:checked, input", menu)?.focus({ preventScroll: true });
  });
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-copy]");
  const src = btn && $(btn.dataset.copy);
  if (!src) return;
  navigator.clipboard.writeText(src.textContent).then(() => {
    const label = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!label) return;
    label.textContent = "Copied";
    setTimeout(() => (label.textContent = "Copy"), 1500);
  });
});

// Section list (Gaia settings): jump to a section, and mark the one being read.
document.addEventListener("click", (e) => {
  const link = e.target.closest?.("[data-nav]");
  if (!link) return;
  e.preventDefault();
  const body = $(".settings-body", link.closest("form"));
  const section = $(`#${link.dataset.nav}`, body);
  // +1: past the section's top border, so the line above the heading doesn't sit against the edge.
  if (section) body.scrollTo({ top: section.offsetTop - body.offsetTop + 1 });
});
document.addEventListener(
  "scroll",
  (e) => {
    const body = e.target;
    if (!(body instanceof HTMLElement) || !body.classList.contains("settings-body")) return;
    const links = $$("[data-nav]", body.closest("form"));
    if (!links.length) return;
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    let current = links[0];
    for (const l of links) {
      const s = $(`#${l.dataset.nav}`, body);
      if (s && s.offsetTop - body.offsetTop - body.scrollTop <= 48) current = l;
    }
    if (atEnd) current = links[links.length - 1];
    for (const l of links) l.toggleAttribute("aria-current", l === current);
  },
  true,
);

// Cmd/Ctrl+Enter saves.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
  const form = e.target.closest?.("form.settings-form");
  if (form) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Pi settings: changing a USB field ticks "Re-apply USB rules after saving".
document.addEventListener("input", (e) => {
  const t = e.target;
  if (!t.name?.startsWith("usb.")) return;
  const apply = t.form?.elements.namedItem("applyUsb");
  if (apply) apply.checked = true;
});

// Pi settings (adding): the ID follows the name ("Bingo 2" → bingo-2) until you edit it yourself.
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.matches?.("[data-slug-target]")) t.dataset.edited = t.value ? "1" : "";
  if (!t.matches?.("[data-slug-source]")) return;
  const id = $("[data-slug-target]", t.form);
  if (id && !id.dataset.edited) id.value = slug(t.value);
});

// A form inside a dropdown (Commander's branch switch) starts a job: close the dropdown.
document.addEventListener("submit", (e) => e.target.closest?.("details.menu")?.removeAttribute("open"));

// Open a dropdown upward if there isn't room below it (above the Activity drawer), and cap its
// height to the visible space so nothing ends up hidden behind the drawer or the header.
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("menu") || !d.open) return;
    const list = $(".menu-list", d);
    if (!list) return;
    d.classList.remove("up");
    list.style.maxHeight = list.style.overflowY = list.style.translate = "";
    const s = d.getBoundingClientRect();
    const floor = Math.min(window.innerHeight, drawer()?.getBoundingClientRect().top ?? window.innerHeight) - 8;
    const ceiling = ($("header.top")?.getBoundingClientRect().bottom ?? 0) + 8;
    const below = floor - s.bottom - 4, above = s.top - ceiling - 4;
    const need = list.scrollHeight;
    if (need > below && above > below) d.classList.add("up");
    const room = d.classList.contains("up") ? above : below;
    if (need > room) Object.assign(list.style, { maxHeight: `${Math.max(room, 120)}px`, overflowY: "auto" });
    // Keep it on screen horizontally too (a right-aligned menu near the left edge runs off it).
    const r = list.getBoundingClientRect();
    const dx = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
    if (dx) list.style.translate = `${dx}px 0`;
  },
  true,
);

// Keep command previews (.peek) on screen: shift them left when they'd run past the right edge
// (or right past the left edge), and flip them above the button when they'd go under the
// Activity drawer. Measured on hover, since the right fix depends on where the button is.
document.addEventListener("mouseover", (e) => {
  const act = e.target.closest?.(".act");
  const peek = act && $(":scope > .peek", act);
  if (!peek || act.contains(e.relatedTarget)) return;
  peek.style.translate = "";
  requestAnimationFrame(() => {
    const r = peek.getBoundingClientRect();
    if (!r.width) return;
    const margin = 8;
    const dx = r.right > innerWidth - margin ? innerWidth - margin - r.right : r.left < margin ? margin - r.left : 0;
    const floor = Math.min(innerHeight, drawer()?.getBoundingClientRect().top ?? innerHeight) - margin;
    let dy = 0;
    if (r.bottom > floor) {
      const a = act.getBoundingClientRect();
      // Below the button: flip above it if that fits better. Beside a menu item: slide up.
      dy = r.top >= a.bottom - 1 && a.top - r.height - 6 > margin ? -(r.height + a.height + 12) : floor - r.bottom;
    }
    if (dx || dy) peek.style.translate = `${dx}px ${dy}px`;
  });
});

// ---- jobs --------------------------------------------------------------------------------
const STATUS_ICON = { pending: "○", running: "◌", ok: "✓", failed: "✗", skipped: "–", warn: "!" };

function stepEl(jobEl, index) {
  const list = $(".steps", jobEl);
  let li = $(`li[data-i="${index}"]`, list);
  if (!li) {
    li = document.createElement("li");
    li.dataset.i = index;
    li.innerHTML = `<div class="step-head"><span class="st"></span> <span class="label"></span><span class="step-note"></span></div><pre class="cmd"></pre><pre class="out"></pre>`;
    list.appendChild(li);
  }
  return li;
}

function attachJob(jobEl) {
  if (jobEl.dataset.attached || jobEl.dataset.status !== "running") return;
  jobEl.dataset.attached = "1";
  $(".steps", jobEl).innerHTML = "";
  running.add(jobEl.dataset.job);
  setActivity("running", `◌ ${jobTitle(jobEl)}…`);
  const es = new EventSource(`/jobs/${jobEl.dataset.job}/events`);
  es.addEventListener("step", (ev) => {
    const d = JSON.parse(ev.data);
    const li = stepEl(jobEl, d.index);
    li.className = d.status;
    const st = $(".st", li);
    st.className = `st ${d.status}`;
    st.textContent = STATUS_ICON[d.status] ?? "";
    if (d.label) $(".label", li).textContent = d.label;
    $(".step-note", li).textContent = d.status === "skipped" ? "skipped" : "";
    if (d.status === "running") setActivity("running", `◌ ${jobTitle(jobEl)} · ${$(".label", li).textContent}`);
    if (d.status === "failed") jobEl.dataset.failedStep = $(".label", li).textContent;
    if (d.display) $(".cmd", li).textContent = `$ ${d.display}`;
    if (d.status === "running") li.scrollIntoView({ block: "nearest" });
  });
  es.addEventListener("line", (ev) => {
    const d = JSON.parse(ev.data);
    const out = $(".out", stepEl(jobEl, d.index));
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    const span = document.createElement("span");
    span.className = d.stream;
    span.textContent = d.text + "\n";
    out.appendChild(span);
    if (atBottom) out.scrollTop = out.scrollHeight;
  });
  es.addEventListener("done", (ev) => {
    const { status } = JSON.parse(ev.data);
    jobEl.dataset.status = status;
    jobEl.className = `job ${status}`;
    const chip = $(".chip-status", jobEl);
    chip.className = `chip-status ${status}`;
    chip.textContent = status;
    const dur = $(".dur", jobEl);
    if (dur) dur.textContent = ` · took ${fmtDuration(Date.now() - Number(jobEl.dataset.started))}`;
    es.close();
    running.delete(jobEl.dataset.job);
    if (status === "failed") unseenFailure = true;
    const t = jobTitle(jobEl);
    setActivity(status, status === "failed" ? `✗ ${t} failed${jobEl.dataset.failedStep ? `: ${jobEl.dataset.failedStep}` : ""} (click for output)` : `${STATUS_ICON[status] ?? ""} ${t} ${status === "ok" ? "done" : status}`);
  });
  es.onerror = () => {
    if (jobEl.dataset.status !== "running") es.close();
  };
}

// ---- logs --------------------------------------------------------------------------------
let logSource = null;
const MAX_LOG_LINES = 5000;

// Operator (erv) stamps lines with a UTC time of day and no date, e.g. "[T00:30:12:345Z]"
// (its milliseconds follow a colon). Show it in this browser's local time. Today's date is
// assumed, which only matters for the UTC offset on the day the clocks change.
const ERV_UTC_STAMP = /^\[T(\d\d):(\d\d):(\d\d)[.:](\d{3})Z\]/;
// Terminal colour codes (erv colours its level names); a <pre> would show them as "[0;34m".
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
function localizeLogLine(line) {
  return line.replace(ANSI_SGR, "").replace(ERV_UTC_STAMP, (_, h, m, s, ms) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), +h, +m, +s, +ms));
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}]`;
  });
}

function attachLogs(pre) {
  logSource?.close();
  const root = pre.closest(".modal-content");
  const state = $("[data-logstate]", root);
  const follow = $("[data-follow]", root);
  const filter = $("[data-filter]", root);
  $("[data-wrap]", root).addEventListener("change", (e) => pre.classList.toggle("wrap", e.target.checked));
  const matches = (t) => !filter.value || t.toLowerCase().includes(filter.value.toLowerCase());
  filter.addEventListener("input", () => {
    for (const s of pre.children) s.hidden = !matches(s.textContent);
  });
  const es = new EventSource(pre.dataset.logsrc);
  logSource = es;
  es.addEventListener("open", () => (state.textContent = "streaming"));
  es.addEventListener("line", (ev) => {
    const s = document.createElement("span");
    s.textContent = localizeLogLine(ev.data) + "\n";
    if (/error|fail|fault|traceback|exception/i.test(ev.data)) s.className = "err";
    else if (/warn/i.test(ev.data)) s.className = "warn";
    s.hidden = !matches(ev.data);
    pre.appendChild(s);
    while (pre.childElementCount > MAX_LOG_LINES) pre.firstElementChild.remove();
    if (follow.checked) pre.scrollTop = pre.scrollHeight;
  });
  es.addEventListener("end", (ev) => {
    state.textContent = ev.data;
    es.close();
  });
  es.onerror = () => {
    state.textContent = "disconnected";
    es.close();
  };
}

$("#modal")?.addEventListener("close", () => {
  logSource?.close();
  logSource = null;
});

// ---- htmx hooks --------------------------------------------------------------------------
document.addEventListener("htmx:afterSwap", (e) => {
  const t = e.detail.target;
  if (t.id === "jobs") {
    const note = $(".job.note", t);
    if (note && t.firstElementChild === note) {
      unseenFailure = true;
      setActivity("failed", `✗ ${note.textContent.trim()}`);
    }
    for (const j of $$(".job[data-status=running]", t)) attachJob(j);
  }
  if (t.id === "modal-body") {
    const m = $("#modal");
    if (!m.open) m.showModal();
    const pre = $("pre[data-logsrc]", t);
    if (pre) attachLogs(pre);
    const form = $("form.settings-form", t);
    if (form) {
      form.dataset.initial = snapshot(form);
      // Came back with errors: show the first field that needs fixing.
      const bad = $(".setting.invalid", form);
      if (bad) {
        bad.closest("details")?.setAttribute("open", "");
        bad.scrollIntoView({ block: "center" });
        $("input, textarea, select", bad)?.focus({ preventScroll: true });
      } else ($("[autofocus]", form) ?? $(".settings-body", form))?.focus();
    }
  }
});

// ---- confirm dialog ----------------------------------------------------------------------
// Replaces the browser's confirm() for every hx-confirm. The element can add
// data-confirm-subject (big text: which Pi), data-confirm-action (the button's label) and
// data-confirm-tone ("home": the arm moves; "danger": disruptive), which colours the dialog.

function askConfirm({ message, subject, action, tone }) {
  const dlg = $("#confirm");
  dlg.className = tone ?? "";
  const subj = $("[data-subject]", dlg);
  subj.textContent = subject ?? "";
  subj.hidden = !subject;
  $("[data-message]", dlg).replaceChildren(
    ...message.split(/\n\s*\n/).map((para) => {
      const p = document.createElement("p");
      p.textContent = para.trim();
      return p;
    }),
  );
  const ok = $("[data-ok]", dlg);
  ok.textContent = action ?? "OK";
  ok.className = `btn ${tone === "danger" ? "danger-fill" : tone === "home" ? "warn-fill" : "primary"}`;
  dlg.returnValue = "";
  dlg.showModal();
  // Risky actions default to Cancel, so a stray Enter never homes an arm or powers a Pi off.
  (tone ? $("[data-cancel]", dlg) : ok).focus();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

document.addEventListener("htmx:confirm", (e) => {
  const elt = e.detail.elt;
  // Leaving a settings form for another one (Gaia settings › a Pi): ask about unsaved edits.
  if (elt.closest?.("#modal") && elt.hasAttribute?.("hx-get") && e.detail.target?.id === "modal-body" && isDirty()) {
    e.preventDefault();
    askDiscard().then((yes) => yes && e.detail.issueRequest(true));
    return;
  }
  let message = e.detail.question;
  let data = (elt.closest?.("[data-confirm-action]") ?? elt).dataset ?? {};
  // Deploy form: only ask about homing when "start after deploy" is on and a homing arm is targeted.
  const form = elt.closest?.("form.deploy-form");
  if (form && elt === form) {
    if (e.detail.triggeringEvent?.submitter?.name === "buildOnly") return;
    const fd = new FormData(form);
    const homing = (form.dataset.homing || "").split(",").filter(Boolean);
    const hits = fd.getAll("targets").filter((t) => homing.includes(t));
    if (!fd.get("start") || !hits.length) return;
    const names = hits.map((id) => $(`#pi-${id} h2`)?.textContent ?? id).join(", ");
    message = `Deploy will start the stack on ${names}.\n\nIf Operator's image changed, the arm HOMEs. Is the workspace clear?`;
    data = { confirmSubject: names, confirmAction: "Build & deploy", confirmTone: "home" };
  }
  if (!message) return;
  e.preventDefault();
  askConfirm({ message, subject: data.confirmSubject, action: data.confirmAction, tone: data.confirmTone }).then((yes) => yes && e.detail.issueRequest(true));
});

// ---- tab title ---------------------------------------------------------------------------
// "Gaia · 1 problem (Bluey)" while a Pi needs attention, so a background tab still says so.
let titleQueued = false;
function updateTitle() {
  if (titleQueued) return;
  titleQueued = true;
  requestAnimationFrame(() => {
    titleQueued = false;
    const names = $$(".fleet .chip")
      .filter((c) => $(".dot.bad, .dot.warn", c))
      .map((c) => c.dataset.name);
    document.title = names.length ? `Gaia · ${names.length} problem${names.length > 1 ? "s" : ""} (${names.join(", ")})` : "Gaia";
  });
}
document.addEventListener("htmx:oobAfterSwap", updateTitle);
document.addEventListener("htmx:afterSettle", updateTitle);

document.addEventListener("DOMContentLoaded", () => {
  for (const j of $$(".job[data-status=running]")) attachJob(j);
});
