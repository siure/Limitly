const sitesListEl = document.getElementById("sitesList");
const emptyStateEl = document.getElementById("emptyState");
const addSiteForm = document.getElementById("addSiteForm");
const domainInput = document.getElementById("domainInput");
const limitInput = document.getElementById("limitInput");
const limitFieldsEl = document.getElementById("limitFields");
const unlimitedInput = document.getElementById("unlimitedInput");
const periodSelect = document.getElementById("periodSelect");
const formErrorEl = document.getElementById("formError");
const refreshButton = document.getElementById("refreshButton");
const siteTemplate = document.getElementById("siteItemTemplate");
const tabs = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));
const tabsContainer = document.querySelector(".tabs");
const windowStartInput = document.getElementById("windowStart");
const windowEndInput = document.getElementById("windowEnd");
const windowLabel = document.getElementById("windowLabel");
const sliderInputs = document.querySelector(".slider-inputs");
const windowInvertInput = document.getElementById("windowInvert");
const useCurrentButton = document.getElementById("useCurrentButton");
const submitButton = document.getElementById("submitButton");
const cancelEditButton = document.getElementById("cancelEditButton");
const statsTotalEl = document.getElementById("statsTotal");
const statsSessionCountEl = document.getElementById("statsSessionCount");
const statsAvgSessionEl = document.getElementById("statsAvgSession");
const statsTopListEl = document.getElementById("statsTopSites");
const statsTopEmptyEl = document.getElementById("statsTopEmpty");
const statsTrendSvg = document.getElementById("statsTrend");
const statsTrendEmptyEl = document.getElementById("statsTrendEmpty");
const openFullscreenButton = document.getElementById("openFullscreenButton");
const statsTopToggleButton = document.getElementById("statsTopToggle");
const statsRefreshButton = document.getElementById("statsRefreshButton");

document.body.classList.add("dark-mode");

const searchParams = new URLSearchParams(window.location.search);
const isFullPage = searchParams.get("view") === "full";
if (isFullPage) {
  document.body.classList.add("full-page");
}

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_TOP_SITES_LIMIT = 3;

const PERIOD_LABEL = {
  daily: "day",
  weekly: "week"
};

function filterTopSites(list) {
  return (Array.isArray(list) ? list : []).filter((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const seconds = Math.max(0, Number(item.seconds ?? 0));
    const sessionCount = Math.max(0, Number(item.sessionCount ?? 0));
    return seconds > 0 || sessionCount > 0;
  });
}

let editingSiteId = null;
let cachedSites = [];
let cachedStats = null;
let statsLoaded = false;
let statsLoading = false;
let topSitesExpanded = false;

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

if (windowStartInput && windowEndInput) {
  windowStartInput.addEventListener("input", handleWindowInput);
  windowEndInput.addEventListener("input", handleWindowInput);
}

if (windowInvertInput) {
  windowInvertInput.addEventListener("change", updateWindowLabel);
}

if (unlimitedInput) {
  unlimitedInput.addEventListener("change", () => {
    const isUnlimited = unlimitedInput.checked;
    if (limitFieldsEl) {
      limitFieldsEl.style.opacity = isUnlimited ? "0.5" : "1";
      limitFieldsEl.style.pointerEvents = isUnlimited ? "none" : "auto";
    }
    if (limitInput) {
      limitInput.required = !isUnlimited;
    }
  });
}

if (useCurrentButton) {
  useCurrentButton.addEventListener("click", fillDomainFromActiveTab);
}

if (cancelEditButton) {
  cancelEditButton.addEventListener("click", () => exitEditMode({ resetForm: true }));
}

if (tabsContainer) {
  tabsContainer.addEventListener("keydown", (event) => {
    const key = event.key;
    const enabledKeys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!enabledKeys.includes(key)) return;
    event.preventDefault();

    const currentIndex = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = tabs.length - 1;
    }

    const nextTab = tabs[nextIndex];
    if (nextTab) {
      nextTab.focus();
      activateTab(nextTab.dataset.tab);
    }
  });
}

if (openFullscreenButton) {
  if (isFullPage) {
    openFullscreenButton.hidden = true;
  } else {
    openFullscreenButton.addEventListener("click", handleOpenFullView);
  }
}

if (statsTopToggleButton) {
  statsTopToggleButton.addEventListener("click", () => {
    topSitesExpanded = !topSitesExpanded;
    if (cachedStats) {
      renderStats(cachedStats);
    }
  });
}

if (statsRefreshButton) {
  statsRefreshButton.addEventListener("click", handleStatsRefreshClick);
}

async function sendMessage(message, { retries = 1 } = {}) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.success) {
      const error = response?.error ?? "Extension did not respond.";
      if (error.includes("Unknown message") && message?.type) {
        throw new Error(`${error} (type: ${message.type}). Did you reload the extension after recent code changes? Visit chrome://extensions and click reload.`);
      }
      throw new Error(error);
    }
    return response.data;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const transient = /Could not establish connection|Receiving end does not exist|The message port closed/i.test(messageText);
    if (retries > 0 && transient) {
      await delay(150);
      return sendMessage(message, { retries: retries - 1 });
    }
    throw error;
  }
}

async function refreshSites() {
  try {
    const data = await sendMessage({ type: "getSites" });
    cachedSites = Array.isArray(data?.sites) ? data.sites : [];
    renderSites(cachedSites);
    if (statsLoaded) {
      await refreshStats({ force: true });
    }
  } catch (error) {
    showFormError(error.message);
  }
}

async function refreshStats({ force = false } = {}) {
  if (!statsTotalEl) {
    console.warn("Stats elements not found in DOM");
    return;
  }
  if (statsLoading) {
    console.log("Stats already loading, skipping");
    return;
  }
  if (!force && statsLoaded && cachedStats) {
    renderStats(cachedStats);
    return;
  }
  statsLoading = true;
  try {
    const data = await sendMessage({ type: "getStats" });
    if (!data || typeof data !== "object") {
      throw new Error("Invalid stats response format");
    }
    cachedStats = data;
    statsLoaded = true;
    renderStats(cachedStats);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Failed to load stats:", error);
    
    if (errorMsg.includes("Unknown message")) {
      alert("⚠️ EXTENSION NOT RELOADED ⚠️\n\nThe Stats feature requires reloading the extension:\n\n1. Open chrome://extensions\n2. Find 'Limitly'\n3. Click the ↻ RELOAD button\n4. Close and reopen this popup\n\nThe 'getStats' handler exists in your code but Chrome is still running the old version.");
    }
    
    statsLoaded = false;
    cachedStats = null;
    renderStats(null);
  } finally {
    statsLoading = false;
  }
}

async function handleStatsRefreshClick() {
  if (!statsRefreshButton) return;
  statsRefreshButton.disabled = true;
  try {
    await refreshStats({ force: true });
  } finally {
    statsRefreshButton.disabled = false;
  }
}

function renderSites(sites) {
  sitesListEl.innerHTML = "";

  if (!sites.length) {
    emptyStateEl.hidden = false;
    return;
  }

  emptyStateEl.hidden = true;

  const fragment = document.createDocumentFragment();
  sites
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .forEach((site) => {
      const node = siteTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.siteId = site.id;
      const isUnlimited = !Number.isFinite(site.remainingSeconds);
      node.classList.toggle("blocked", !isUnlimited && site.remainingSeconds <= 0 && site.enabled);
      node.classList.toggle("disabled", !site.enabled);

      const domainEl = node.querySelector(".site-domain");
      const metaEl = node.querySelector(".site-meta");
      const toggleInput = node.querySelector(".js-enabled");
      domainEl.textContent = site.domain;
      domainEl.title = site.domain;
      metaEl.textContent = buildMetaText(site);
      if (toggleInput) {
        toggleInput.checked = !!site.enabled;
        toggleInput.setAttribute("aria-label", site.enabled ? `Disable ${site.domain}` : `Enable ${site.domain}`);
        toggleInput.title = site.enabled ? "Disable tracking" : "Enable tracking";
      }

      fragment.appendChild(node);
    });

  sitesListEl.appendChild(fragment);

  if (editingSiteId && !sites.some((site) => site.id === editingSiteId)) {
    exitEditMode({ resetForm: true });
  }
}

function renderStats(data) {
  if (!statsTotalEl) return;
  try {
    const todaySeconds = Math.max(0, Math.round(Number(data?.todaySeconds ?? 0)));
    const trackedSeconds = Math.max(0, Math.round(Number(data?.trackedSeconds ?? data?.todaySeconds ?? 0)));
    const sessionCount = Math.max(0, Math.round(Number(data?.sessionCount ?? 0)));
    const avgSessionSeconds = Math.max(0, Math.round(Number(data?.avgSessionSeconds ?? 0)));

    statsTotalEl.textContent = formatDuration(todaySeconds, { fallback: "0m" });
    if (statsSessionCountEl) {
      statsSessionCountEl.textContent = String(sessionCount);
    }
    if (statsAvgSessionEl) {
      statsAvgSessionEl.textContent = avgSessionSeconds > 0 ? formatDuration(avgSessionSeconds, { includeSeconds: avgSessionSeconds < 60 }) : "0m";
    }

  const topSites = filterTopSites(data?.topSites);
  updateTopSitesToggle(topSites);
  renderTopSites(topSites, trackedSeconds);

    const trend = Array.isArray(data?.trend) ? data.trend : [];
    renderSparkline(trend);
  } catch (error) {
    console.error("Failed to render stats", data, error);
  }
}

function renderTopSites(list, trackedSeconds) {
  if (!statsTopListEl || !statsTopEmptyEl) return;
  statsTopListEl.innerHTML = "";

  const sites = Array.isArray(list) ? list : [];

  if (!sites.length) {
    statsTopEmptyEl.hidden = false;
    statsTopListEl.hidden = true;
    if (statsTopToggleButton) {
      statsTopToggleButton.hidden = true;
    }
    return;
  }

  statsTopEmptyEl.hidden = true;
  statsTopListEl.hidden = false;
  const items = topSitesExpanded ? sites : sites.slice(0, DEFAULT_TOP_SITES_LIMIT);
  const maxSeconds = Math.max(...items.map((item) => Math.max(0, item.seconds ?? 0)), 1);

  items.forEach((item) => {
    const seconds = Math.max(0, Math.round(item.seconds ?? 0));
    const shareRatio = typeof item.share === "number" ? item.share : (trackedSeconds > 0 ? seconds / trackedSeconds : 0);
    const share = Math.min(100, Math.max(0, Math.round(shareRatio * 100)));
    const percent = Math.max(6, Math.round((seconds / maxSeconds) * 100));

    const li = document.createElement("li");
    li.className = "stats-top-item";

    const row = document.createElement("div");
    row.className = "stats-top-row";

    const domain = document.createElement("span");
    domain.className = "stats-top-domain";
    domain.textContent = item.domain ?? "Site";

    const meta = document.createElement("span");
    meta.className = "stats-top-meta";
    const formattedDuration = formatDuration(seconds, { fallback: "0m" });
    const parts = [formattedDuration];
    if (share > 0) {
      parts.push(`${share}%`);
    }
    meta.textContent = parts.join(" · ");

    row.appendChild(domain);
    row.appendChild(meta);

    const bar = document.createElement("div");
    bar.className = "stats-top-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, percent)}%`;
    bar.appendChild(fill);

    li.appendChild(row);
    const sessionCount = Math.max(0, Math.round(item.sessionCount ?? 0));
    const avgSessionSeconds = Math.max(0, Math.round(item.avgSessionSeconds ?? 0));
    if (sessionCount > 0) {
      const submeta = document.createElement("div");
      submeta.className = "stats-top-submeta";
      const sessionLabel = sessionCount === 1 ? "session" : "sessions";
      const avgText = avgSessionSeconds > 0
        ? formatDuration(avgSessionSeconds, { includeSeconds: avgSessionSeconds < 60 })
        : "0m";
      submeta.textContent = `${sessionCount} ${sessionLabel} · avg ${avgText}`;
      li.appendChild(submeta);
    }
    li.appendChild(bar);
    statsTopListEl.appendChild(li);
  });
}

function updateTopSitesToggle(list) {
  if (!statsTopToggleButton) return;
  const sites = Array.isArray(list) ? list : [];
  if (!sites.length) {
    topSitesExpanded = false;
    statsTopToggleButton.hidden = true;
    statsTopToggleButton.textContent = "Show more";
    statsTopToggleButton.setAttribute("aria-expanded", "false");
    statsTopToggleButton.title = "Show more top sites";
    return;
  }
  const hasMore = sites.length > DEFAULT_TOP_SITES_LIMIT;
  if (!hasMore) {
    topSitesExpanded = false;
  }
  statsTopToggleButton.hidden = !hasMore;
  statsTopToggleButton.textContent = topSitesExpanded ? "Show less" : "Show more";
  statsTopToggleButton.setAttribute("aria-expanded", topSitesExpanded ? "true" : "false");
  statsTopToggleButton.title = topSitesExpanded ? "Collapse top sites" : "Show more top sites";
}

function renderSparkline(trend) {
  if (!statsTrendSvg || !statsTrendEmptyEl) return;
  statsTrendSvg.innerHTML = "";

  if (!trend.length) {
    statsTrendEmptyEl.hidden = false;
    statsTrendSvg.hidden = true;
    statsTrendSvg.setAttribute("aria-hidden", "true");
    return;
  }

  statsTrendEmptyEl.hidden = true;
  statsTrendSvg.hidden = false;
  statsTrendSvg.setAttribute("aria-hidden", "false");

  const ordered = [...trend].sort((a, b) => String(a.dayKey).localeCompare(String(b.dayKey)));

  const width = 140;
  const height = 48;
  const topPadding = 6;
  const bottomPadding = 6;
  const chartHeight = height - topPadding - bottomPadding;

  const values = ordered.map((item) => Math.max(0, Math.round(item.totalSeconds ?? 0)));
  const maxValue = Math.max(...values, 1);

  const step = ordered.length > 1 ? width / (ordered.length - 1) : 0;
  const points = ordered.map((item, index) => {
    const x = ordered.length > 1 ? index * step : width / 2;
    const ratio = (Math.max(0, Math.round(item.totalSeconds ?? 0)) / maxValue) || 0;
    const y = topPadding + (chartHeight - chartHeight * ratio);
    return { x, y };
  });

  let coords = points;
  if (points.length === 1) {
    const single = points[0];
    coords = [
      { x: 0, y: single.y },
      { x: width, y: single.y }
    ];
  }

  const ns = "http://www.w3.org/2000/svg";

  const areaPath = document.createElementNS(ns, "path");
  let d = `M ${coords[0].x} ${height - bottomPadding}`;
  coords.forEach((point) => {
    d += ` L ${point.x} ${point.y}`;
  });
  d += ` L ${coords[coords.length - 1].x} ${height - bottomPadding} Z`;
  areaPath.setAttribute("d", d);
  areaPath.setAttribute("fill", "rgba(230, 77, 0, 0.18)");
  areaPath.setAttribute("stroke", "none");

  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("points", coords.map((point) => `${point.x},${point.y}`).join(" "));

  statsTrendSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  statsTrendSvg.setAttribute("preserveAspectRatio", "none");
  statsTrendSvg.setAttribute(
    "aria-label",
    `Daily usage from ${ordered[0].dayKey} to ${ordered[ordered.length - 1].dayKey}`
  );

  statsTrendSvg.appendChild(areaPath);
  statsTrendSvg.appendChild(line);
}

function buildMetaText(site) {
  const usedMinutes = Math.round((site.usageSeconds ?? 0) / 60);
  const limitMinutes = site.limitMinutes;
  const periodLabel = PERIOD_LABEL[site.period] ?? site.period;
  const remaining = site.remainingSeconds ?? 0;
  const nextReset = site.nextReset ? formatRelativeTime(site.nextReset) : "soon";
  const windowRange = formatWindowRange(site.windowStartMinutes, site.windowEndMinutes);
  const windowPhrase = site.invertWindow ? `outside ${windowRange}` : `within ${windowRange}`;
  const isUnlimited = limitMinutes === 0 || !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0;

  if (!site.enabled) {
    return isUnlimited
      ? `Disabled (stats only) · active ${windowPhrase}`
      : `Disabled · active ${windowPhrase}`;
  }

  if (isUnlimited) {
    return `Stats only (${periodLabel}) · ${usedMinutes} min used · active ${windowPhrase} · resets ${nextReset}`;
  }

  if (remaining <= 0) {
    return `Blocked (${periodLabel}) · active ${windowPhrase} · resets ${nextReset}`;
  }

  return `${usedMinutes}/${limitMinutes} min (${periodLabel}) · active ${windowPhrase} · resets ${nextReset}`;
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diffMs = Math.max(0, timestamp - now);
  const totalMinutes = Math.max(1, Math.round(diffMs / 60000));

  if (totalMinutes < 60) {
    return `in ${totalMinutes}m`;
  }

  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) {
    const remMinutes = totalMinutes % 60;
    if (remMinutes === 0 || totalHours >= 12) {
      return `in ${totalHours}h`;
    }
    return `in ${totalHours}h ${remMinutes}m`;
  }

  const totalDays = Math.round(totalMinutes / (60 * 24));
  return `in ${totalDays}d`;
}

function formatWindowRange(startMinutes = 0, endMinutes = MINUTES_PER_DAY) {
  const start = clampMinutes(startMinutes);
  const end = clampMinutes(endMinutes);
  if (start === 0 && (end === MINUTES_PER_DAY || end === 0)) {
    return "All day";
  }

  if (start === end) {
    return "All day";
  }

  return `${formatMinutesToTime(start)}–${formatMinutesToTime(end)}`;
}

function clampMinutes(value) {
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(Number(value) || 0)));
}

function formatMinutesToTime(mins) {
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}`;
}

function formatDuration(secondsInput, { fallback = "0s", includeSeconds = false } = {}) {
  const totalSeconds = Math.max(0, Math.round(Number(secondsInput) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  if (minutes > 0) {
    if (includeSeconds && seconds > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${minutes}m`;
  }

  if (seconds > 0) {
    return `${seconds}s`;
  }

  return fallback;
}

function handleOpenFullView() {
  const url = chrome.runtime.getURL("src/popup/popup.html?view=full");
  chrome.tabs.create({ url });
  if (!isFullPage && typeof window.close === "function") {
    window.close();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

addSiteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideFormError();

  const prevLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = editingSiteId ? "Updating…" : "Saving…";

  try {
    const isEditing = Boolean(editingSiteId);
    const isUnlimited = Boolean(unlimitedInput?.checked);
    const payload = {
      domain: domainInput.value,
      limitMinutes: isUnlimited ? 0 : Number(limitInput.value),
      period: periodSelect.value,
      windowStart: clampMinutes(windowStartInput?.value ?? 0),
      windowEnd: clampMinutes(windowEndInput?.value ?? MINUTES_PER_DAY),
      invertWindow: Boolean(windowInvertInput?.checked)
    };
    if (isEditing) {
      await sendMessage({ type: "updateSite", payload: { ...payload, siteId: editingSiteId } });
      exitEditMode({ resetForm: true });
    } else {
      await sendMessage({ type: "addSite", payload });
      resetFormAfterSubmit(payload.period);
    }
    await refreshSites();
  } catch (error) {
    showFormError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = prevLabel;
  }
});

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  await refreshSites();
  refreshButton.disabled = false;
});

sitesListEl.addEventListener("click", async (event) => {
  const actionBtn = event.target.closest("button");
  if (!actionBtn) return;
  const li = actionBtn.closest(".site-item");
  if (!li) return;
  const siteId = li.dataset.siteId;
  if (!siteId) return;

  if (actionBtn.classList.contains("js-remove")) {
    if (!confirm("Remove this site?")) {
      return;
    }
    actionBtn.disabled = true;
    try {
      await sendMessage({ type: "removeSite", payload: { siteId } });
      await refreshSites();
    } catch (error) {
      alert(error.message);
    }
    actionBtn.disabled = false;
  } else if (actionBtn.classList.contains("js-reset")) {
    actionBtn.disabled = true;
    try {
      await sendMessage({ type: "resetUsage", payload: { siteId } });
      await refreshSites();
    } catch (error) {
      alert(error.message);
    }
    actionBtn.disabled = false;
  } else if (actionBtn.classList.contains("js-edit")) {
    const site = cachedSites.find((item) => item.id === siteId);
    if (site) {
      enterEditMode(site);
    }
  }
});

sitesListEl.addEventListener("change", async (event) => {
  const checkbox = event.target.closest(".js-enabled");
  if (!checkbox) return;
  const li = checkbox.closest(".site-item");
  if (!li) return;
  const siteId = li.dataset.siteId;
  if (!siteId) return;

  const enabled = checkbox.checked;
  checkbox.disabled = true;
  try {
    await sendMessage({ type: "setSiteEnabled", payload: { siteId, enabled } });
    await refreshSites();
  } catch (error) {
    alert(error.message);
    checkbox.checked = !enabled;
  }
  checkbox.disabled = false;
});

function showFormError(message) {
  formErrorEl.textContent = message;
  formErrorEl.hidden = false;
}

function hideFormError() {
  formErrorEl.hidden = true;
  formErrorEl.textContent = "";
}

(function initializeTabs() {
  tabs.forEach((tab) => {
    const isActive = tab.classList.contains("active");
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tabPanel === "add";
    panel.hidden = !isActive;
  });
  updateWindowLabel();
})();

function activateTab(tabName) {
  if (!tabName) return;
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });

  if (tabName === "tracked") {
    refreshSites();
  } else if (tabName === "stats") {
    refreshStats({ force: true });
  } else {
    hideFormError();
  }
}

function isTabActive(tabName) {
  const activeTab = tabs.find((tab) => tab.classList.contains("active"));
  return activeTab?.dataset.tab === tabName;
}

(async function bootstrap() {
  try {
    await refreshSites();
  } catch (error) {
    showFormError(error.message);
  }
  try {
    await refreshStats();
  } catch (error) {
    console.warn("Stats bootstrap failed", error);
  }
})();

function handleWindowInput(event) {
  const start = clampMinutes(windowStartInput.value);
  let end = clampMinutes(windowEndInput.value);

  if (event.target === windowStartInput && start > end) {
    end = start;
    windowEndInput.value = String(end);
  }

  if (event.target === windowEndInput && end < start) {
    windowStartInput.value = String(end);
  }

  updateWindowLabel();
}

function updateWindowLabel() {
  if (!windowLabel) return;
  const start = clampMinutes(windowStartInput?.value ?? 0);
  const end = clampMinutes(windowEndInput?.value ?? MINUTES_PER_DAY);
  const rangeLabel = formatWindowRange(start, end);
  const invert = Boolean(windowInvertInput?.checked);
  windowLabel.textContent = invert ? `Outside ${rangeLabel}` : `Within ${rangeLabel}`;
  if (sliderInputs) {
    const startPct = Math.round((start / MINUTES_PER_DAY) * 100);
    const endPct = Math.round((end / MINUTES_PER_DAY) * 100);
    sliderInputs.style.setProperty("--window-start", `${startPct}%`);
    sliderInputs.style.setProperty("--window-end", `${endPct}%`);
    sliderInputs.dataset.invert = String(invert);
  }
}

async function fillDomainFromActiveTab() {
  hideFormError();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      throw new Error("No active tab URL available.");
    }
    const domain = normalizeDomain(tab.url);
    if (!domain) {
      throw new Error("Active tab is not an http(s) page.");
    }
    domainInput.value = domain;
  } catch (error) {
    showFormError(error.message);
  }
}

function enterEditMode(site) {
  editingSiteId = site.id;
  addSiteForm.dataset.mode = "edit";
  submitButton.textContent = "Update";
  cancelEditButton.hidden = false;
  domainInput.value = site.domain;
  const isUnlimited = site.limitMinutes === 0 || !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0;
  if (unlimitedInput) {
    unlimitedInput.checked = isUnlimited;
    if (limitFieldsEl) {
      limitFieldsEl.style.opacity = isUnlimited ? "0.5" : "1";
      limitFieldsEl.style.pointerEvents = isUnlimited ? "none" : "auto";
    }
  }
  limitInput.value = isUnlimited ? "30" : String(site.limitMinutes);
  limitInput.required = !isUnlimited;
  periodSelect.value = site.period;
  if (windowStartInput && windowEndInput) {
    windowStartInput.value = String(site.windowStartMinutes ?? 0);
    windowEndInput.value = String(site.windowEndMinutes ?? MINUTES_PER_DAY);
  }
  if (windowInvertInput) {
    windowInvertInput.checked = Boolean(site.invertWindow);
  }
  updateWindowLabel();
  activateTab("add");
  domainInput.focus();
}

function exitEditMode({ resetForm = false } = {}) {
  editingSiteId = null;
  delete addSiteForm.dataset.mode;
  submitButton.textContent = "Save";
  cancelEditButton.hidden = true;
  if (resetForm) {
    addSiteForm.reset();
    resetFormAfterSubmit();
  }
}

function resetFormAfterSubmit(preferredPeriod) {
  hideFormError();
  limitInput.value = "30";
  limitInput.required = true;
  periodSelect.value = preferredPeriod ?? "daily";
  if (unlimitedInput) {
    unlimitedInput.checked = false;
  }
  if (limitFieldsEl) {
    limitFieldsEl.style.opacity = "1";
    limitFieldsEl.style.pointerEvents = "auto";
  }
  if (windowStartInput && windowEndInput) {
    windowStartInput.value = String(0);
    windowEndInput.value = String(MINUTES_PER_DAY);
  }
  if (windowInvertInput) {
    windowInvertInput.checked = false;
  }
  updateWindowLabel();
  domainInput.value = "";
}

function normalizeDomain(input) {
  let candidate = String(input || "").trim();
  if (!candidate) return null;

  if (!candidate.includes("://")) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!/^https?$/.test(url.protocol.replace(":", ""))) {
      return null;
    }
    return url.hostname.replace(/^www\./i, "");
  } catch (_error) {
    return null;
  }
}
