const sitesListEl = document.getElementById("sitesList");
const emptyStateEl = document.getElementById("emptyState");
const addSiteForm = document.getElementById("addSiteForm");
const domainInput = document.getElementById("domainInput");
const limitInput = document.getElementById("limitInput");
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

document.body.classList.add("dark-mode");

const MINUTES_PER_DAY = 24 * 60;

const PERIOD_LABEL = {
  daily: "day",
  weekly: "week"
};

let editingSiteId = null;
let cachedSites = [];

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

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.success) {
    throw new Error(response?.error ?? "Extension did not respond.");
  }
  return response.data;
}

async function refreshSites() {
  try {
    const data = await sendMessage({ type: "getSites" });
    cachedSites = Array.isArray(data?.sites) ? data.sites : [];
    renderSites(cachedSites);
  } catch (error) {
    showFormError(error.message);
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
      node.classList.toggle("blocked", site.remainingSeconds <= 0 && site.enabled);
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

function buildMetaText(site) {
  const usedMinutes = Math.round((site.usageSeconds ?? 0) / 60);
  const limitMinutes = site.limitMinutes;
  const periodLabel = PERIOD_LABEL[site.period] ?? site.period;
  const remaining = site.remainingSeconds ?? 0;
  const nextReset = site.nextReset ? formatRelativeTime(site.nextReset) : "soon";
  const windowRange = formatWindowRange(site.windowStartMinutes, site.windowEndMinutes);
  const windowPhrase = site.invertWindow ? `outside ${windowRange}` : `within ${windowRange}`;

  if (!site.enabled) {
    return `Disabled · active ${windowPhrase}`;
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

addSiteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideFormError();

  const prevLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = editingSiteId ? "Updating…" : "Saving…";

  try {
    const isEditing = Boolean(editingSiteId);
    const payload = {
      domain: domainInput.value,
      limitMinutes: Number(limitInput.value),
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
  } else {
    hideFormError();
  }
}

(async function bootstrap() {
  try {
    await refreshSites();
  } catch (error) {
    showFormError(error.message);
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
  limitInput.value = String(site.limitMinutes);
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
  periodSelect.value = preferredPeriod ?? "daily";
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
