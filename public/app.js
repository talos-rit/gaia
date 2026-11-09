// Gaia client: HTMX does the fragments; this file only handles live streams (jobs, logs),
// the modal, and a couple of UX niceties. No build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- drawer ------------------------------------------------------------------------------
const drawer = () => $("#drawer");
function openDrawer() {
  drawer().classList.add("open");
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-toggle-drawer]")) drawer().classList.toggle("open");
  if (e.target.closest("[data-close-modal]")) $("#modal").close();
  // Close dropdown menus when clicking elsewhere or after choosing an item.
  for (const d of $$("details.menu[open]")) {
    if (!d.contains(e.target) || e.target.closest(".menu-item")) d.open = false;
  }
});

// ---- jobs --------------------------------------------------------------------------------
const STATUS_ICON = { pending: "○", running: "◌", ok: "✓", failed: "✗", skipped: "–", warn: "!" };

function stepEl(jobEl, index) {
  const list = $(".steps", jobEl);
  let li = $(`li[data-i="${index}"]`, list);
  if (!li) {
    li = document.createElement("li");
    li.dataset.i = index;
    li.innerHTML = `<div class="step-head"><span class="st"></span> <span class="label"></span></div><pre class="cmd"></pre><pre class="out"></pre>`;
    list.appendChild(li);
  }
  return li;
}

function attachJob(jobEl) {
  if (jobEl.dataset.attached || jobEl.dataset.status !== "running") return;
  jobEl.dataset.attached = "1";
  $(".steps", jobEl).innerHTML = "";
  const es = new EventSource(`/jobs/${jobEl.dataset.job}/events`);
  es.addEventListener("step", (ev) => {
    const d = JSON.parse(ev.data);
    const li = stepEl(jobEl, d.index);
    li.className = d.status;
    const st = $(".st", li);
    st.className = `st ${d.status}`;
    st.textContent = STATUS_ICON[d.status] ?? "";
    if (d.label) $(".label", li).textContent = d.label;
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
    es.close();
  });
  es.onerror = () => {
    if (jobEl.dataset.status !== "running") es.close();
  };
}

// ---- logs --------------------------------------------------------------------------------
let logSource = null;
const MAX_LOG_LINES = 5000;

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
    s.textContent = ev.data + "\n";
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
    openDrawer();
    for (const j of $$(".job[data-status=running]", t)) attachJob(j);
  }
  if (t.id === "modal-body") {
    const m = $("#modal");
    if (!m.open) m.showModal();
    const pre = $("pre[data-logsrc]", t);
    if (pre) attachLogs(pre);
  }
});

// Deploy form: only ask about homing when "start after deploy" is on and a homing arm is targeted.
document.addEventListener("htmx:confirm", (e) => {
  const form = e.target.closest?.("form.deploy-form");
  if (!form || e.target !== form) return;
  if (e.detail.triggeringEvent?.submitter?.name === "buildOnly") return;
  const fd = new FormData(form);
  const homing = (form.dataset.homing || "").split(",").filter(Boolean);
  const hits = fd.getAll("targets").filter((t) => homing.includes(t));
  if (!fd.get("start") || !hits.length) return;
  e.preventDefault();
  if (confirm(`Deploy will start the stack on ${hits.join(", ")}.\n\nIf Operator's image changed, the arm HOMEs. Is the workspace clear?`)) e.detail.issueRequest(true);
});

document.addEventListener("DOMContentLoaded", () => {
  for (const j of $$(".job[data-status=running]")) attachJob(j);
});
