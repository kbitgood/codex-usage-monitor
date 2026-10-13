const refreshMilliseconds = 2_000;
const creditsRefreshMilliseconds = 60_000;
const creditPriceUsd = 0.056;
const baseWidgetWidth = 340;
const fullWidgetHeight = 336;
const compactWidgetHeight = 266;
const creditsSectionHeight = 112;
let creditsVisible = false;
let baseWidgetHeight = fullWidgetHeight - creditsSectionHeight;
let compactLayout = false;
let creditsTimer;
let creditsRequestVersion = 0;

function scaleWidget() {
  const scale = Math.min(
    window.innerWidth / baseWidgetWidth,
    window.innerHeight / baseWidgetHeight,
  );
  document.documentElement.style.setProperty("--widget-scale", String(scale));
}

window.addEventListener("resize", scaleWidget);
scaleWidget();

document.querySelector("#close").addEventListener("click", () => {
  window.codexMonitor.hide();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.codexMonitor.hide();
});

window.codexMonitor.onRefresh(() => {
  void refresh();
  void refreshCredits();
});

const autoResetToggle = document.querySelector("#auto-reset-toggle");
let automaticallyUseResets = false;

function showAutomaticallyUseResets(enabled) {
  automaticallyUseResets = enabled;
  autoResetToggle.checked = enabled;
}

autoResetToggle.addEventListener("change", async () => {
  autoResetToggle.disabled = true;
  try {
    showAutomaticallyUseResets(await window.codexMonitor.setAutomaticallyUseResets(autoResetToggle.checked));
  } catch {
    autoResetToggle.checked = automaticallyUseResets;
  } finally {
    autoResetToggle.disabled = false;
  }
});

window.codexMonitor.onAutomaticallyUseResetsChanged(showAutomaticallyUseResets);
window.codexMonitor.automaticallyUseResets().then(enabled => {
  showAutomaticallyUseResets(enabled);
  autoResetToggle.disabled = false;
});

async function refresh() {
  try {
    const snapshot = await window.codexMonitor.latest();
    if (!snapshot) throw new Error("No Codex usage found yet");
    document.body.classList.remove("error");
    renderWindow("primary", snapshot.rateLimits.primary);
    renderWindow("secondary", snapshot.rateLimits.secondary);
    document.querySelector("#banked-resets-count").textContent =
      snapshot.rateLimits.bankedResets ?? "--";
    const windowCount = [
      snapshot.rateLimits.primary,
      snapshot.rateLimits.secondary,
    ].filter(Boolean).length;
    setCompactLayout(windowCount === 1);
  } catch (error) {
    document.body.classList.add("error");
  }
}

function setCompactLayout(compact) {
  if (compactLayout === compact) return;
  compactLayout = compact;
  document.body.classList.toggle("compact", compact);
  window.codexMonitor.setCompact(compact);
  updateWidgetHeight();
}

function updateWidgetHeight() {
  baseWidgetHeight = (compactLayout ? compactWidgetHeight : fullWidgetHeight)
    - (creditsVisible ? 0 : creditsSectionHeight);
  requestAnimationFrame(scaleWidget);
}

function renderWindow(name, limit) {
  const element = document.querySelector(`[data-window="${name}"]`);
  element.hidden = !limit;
  if (!limit) return;
  const usedPercent = Math.max(0, Math.min(100, limit.used_percent));
  const remainingPercent = 100 - usedPercent;
  const color = remainingPercent <= 10
    ? "var(--red)"
    : remainingPercent <= 30
      ? "var(--amber)"
      : "var(--blue)";
  const reset = new Date(limit.resets_at * 1_000);
  const remaining = Math.max(0, reset.getTime() - Date.now());

  element.querySelector(".percent").textContent = `${formatPercent(remainingPercent)}%`;
  element.querySelector(".percent").style.color = color;
  element.querySelector(".fill").style.width = `${remainingPercent}%`;
  element.querySelector(".fill").style.background = color;
  element.querySelector("time").textContent = `${formatDuration(remaining)} · ${formatReset(reset)}`;
  element.querySelector("time").dateTime = reset.toISOString();
}

window.codexMonitor.onCreditsChanged(snapshot => {
  creditsRequestVersion += 1;
  applyCreditSnapshot(snapshot);
});

function applyCreditSnapshot(snapshot) {
  if (snapshot.status === "ready") renderCredits(snapshot);
  else setCreditsVisible(false);
  scheduleCreditsRefresh(creditsRefreshMilliseconds);
}

async function refreshCredits() {
  const version = ++creditsRequestVersion;
  try {
    const snapshot = await window.codexMonitor.latestCredits();
    if (version !== creditsRequestVersion) return;
    applyCreditSnapshot(snapshot);
  } catch {
    if (version !== creditsRequestVersion) return;
    setCreditsVisible(false);
    scheduleCreditsRefresh(creditsRefreshMilliseconds);
  }
}

function scheduleCreditsRefresh(delay) {
  clearTimeout(creditsTimer);
  creditsTimer = setTimeout(refreshCredits, delay);
}

function renderCredits(snapshot) {
  const chart = document.querySelector("#credit-chart");
  const recent = recentCreditDays(snapshot.days);
  const maximum = Math.max(1, ...recent.map((day) => day.credits));
  const today = recent.at(-1);
  const todaySummary = `${formatCreditAmount(today.credits)} cr · ${formatUsd(today.credits * creditPriceUsd)}`;
  chart.onpointerleave = () => setCreditSummary(todaySummary);

  chart.replaceChildren(...recent.map((day, index) => {
    const column = document.createElement("div");
    column.className = `credit-column${index === recent.length - 1 ? " today" : ""}`;
    const credits = formatCreditAmount(day.credits);
    const estimatedPrice = formatUsd(day.credits * creditPriceUsd);
    const hoverSummary = `${credits} cr · ${estimatedPrice}`;
    column.title = `${day.date}: ${credits} credits, ${estimatedPrice} estimated${day.partial ? " so far" : ""}`;
    column.setAttribute("aria-label", column.title);
    column.tabIndex = 0;
    column.addEventListener("pointerenter", () => setCreditSummary(hoverSummary));
    column.addEventListener("focus", () => setCreditSummary(hoverSummary));
    column.addEventListener("blur", () => setCreditSummary(todaySummary));

    const shell = document.createElement("div");
    shell.className = "credit-bar-shell";
    const bar = document.createElement("span");
    bar.className = "credit-bar";
    const height = day.credits === 0 ? 2 : Math.max(4, (day.credits / maximum) * 48);
    bar.style.height = `${height}px`;
    shell.append(bar);

    const label = document.createElement("span");
    label.className = "credit-day";
    label.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "narrow",
      timeZone: "UTC",
    }).format(new Date(`${day.date}T12:00:00Z`));
    column.append(shell, label);
    return column;
  }));

  setCreditSummary(todaySummary);
  setCreditsVisible(true);
}

function setCreditSummary(value) {
  document.querySelector("#credits-today").textContent = value;
}

function recentCreditDays(days) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const today = new Date();
  const results = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - offset,
    )).toISOString().slice(0, 10);
    results.push(byDate.get(date) ?? { date, credits: 0, partial: offset === 0 });
  }
  return results;
}

function setCreditsVisible(visible) {
  creditsVisible = visible;
  document.querySelector(".credits").hidden = !visible;
  document.body.classList.toggle("no-credits", !visible);
  if (!visible) {
    document.querySelector("#credit-chart").replaceChildren();
    document.querySelector("#credits-today").textContent = "";
  }
  updateWidgetHeight();
}

function formatCreditAmount(value) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsd(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value) {
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatReset(date) {
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

refresh();
setInterval(refresh, refreshMilliseconds);
refreshCredits();
