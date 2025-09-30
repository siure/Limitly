const domainEl = document.getElementById("blockedDomain");
const messageEl = document.getElementById("blockedMessage");
const settingsBtn = document.getElementById("openSettings");
const newTabBtn = document.getElementById("newTab");

const params = new URLSearchParams(window.location.search);
const siteId = params.get("siteId");

(async function init() {
  try {
    const site = await fetchSite(siteId);
    if (!site) {
      renderMissingState();
      return;
    }
    renderSite(site);
  } catch (error) {
    console.error("Failed to load site", error);
    renderMissingState();
  }
})();

settingsBtn.addEventListener("click", () => {
  const url = chrome.runtime.getURL("popup.html");
  chrome.tabs.create({ url });
});

newTabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://newtab/" });
});

async function fetchSite(targetId) {
  if (!targetId) return null;
  const response = await chrome.runtime.sendMessage({ type: "getSites" });
  if (!response?.success) {
    throw new Error(response?.error ?? "No response");
  }
  const data = response.data;
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  return sites.find((site) => site.id === targetId) ?? null;
}

function renderSite(site) {
  domainEl.textContent = site.domain ?? "that site";
  const limitMinutes = site.limitMinutes;
  const periodWord = site.period === "weekly" ? "week" : "day";
  const nextResetText = site.nextReset ? formatRelativeTime(site.nextReset) : "soon";
  const usedText = formatDuration(site.usageSeconds ?? 0);
  const limitText = formatDuration(site.limitSeconds ?? site.limitMinutes * 60);

  messageEl.textContent = `You've used ${usedText} of ${limitText} allowed for this ${periodWord}. Come back ${nextResetText}.`;
}

function renderMissingState() {
  domainEl.textContent = "This website";
  messageEl.textContent = "We couldn't find its settings, but the block will lift automatically on the next reset.";
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = Math.max(0, timestamp - now);
  if (diff < 60_000) {
    return "in about a minute";
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    if (remMinutes === 0) return `in ${hours} hr`;
    return `in ${hours} hr ${remMinutes} min`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (remHours === 0) {
    return `in ${days} day${days > 1 ? "s" : ""}`;
  }
  return `in ${days} day${days > 1 ? "s" : ""} ${remHours} hr`;
}

function formatDuration(secondsInput) {
  const totalSeconds = Math.max(0, Math.round(Number(secondsInput) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${remMinutes} min`;
}
