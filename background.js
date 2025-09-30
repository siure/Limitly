const PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};

const ALARM_NAME = "usageTick";
const DEFAULT_TICK_MINUTES = 0.25; // 15 seconds
const MINUTES_PER_DAY = 24 * 60;
const FULL_DAY_MINUTES = MINUTES_PER_DAY;

const READ_STATE_DEFAULTS = {
  sites: {},
  session: null,
  focus: null,
  metrics: null
};

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await initializeBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const now = Date.now();
  let siteToBlock = null;
  const { state } = await mutateState((state) => {
    accrueFocus(state, now, { finalize: false });
    const reached = accrueSession(state, now, { finalize: false });
    if (reached) {
      siteToBlock = reached;
    }
  });
  await refreshBadge(state);
  if (siteToBlock) {
    const site = state.sites?.[siteToBlock];
    if (site) {
      await enforceBlock(site);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await safeGetTab(tabId);
  if (!tab) {
    await finalizeActiveSession();
    return;
  }
  await setActiveContext(tabId, tab.url ?? "", windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab?.active) return;
  if (typeof changeInfo.status !== "string" && typeof changeInfo.url !== "string") return;
  const url = changeInfo.url ?? tab.url ?? "";
  await setActiveContext(tabId, url, tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await finalizeActiveSession();
    return;
  }
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (activeTab) {
    await setActiveContext(activeTab.id, activeTab.url ?? "", windowId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const now = Date.now();
  const { state } = await mutateState((state) => {
    if (state.focus?.tabId === tabId) {
      accrueFocus(state, now, { finalize: true });
    }
    if (state.session?.tabId === tabId) {
      accrueSession(state, now, { finalize: true });
    }
  });
  await refreshBadge(state);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "getSites": {
          const payload = await handleGetSites();
          sendResponse({ success: true, data: payload });
          break;
        }
        case "addSite": {
          const payload = message?.payload ?? {};
          const result = await handleAddSite(payload);
          sendResponse({ success: true, data: result });
          break;
        }
        case "removeSite": {
          const { siteId } = message?.payload ?? {};
          await handleRemoveSite(siteId);
          sendResponse({ success: true });
          break;
        }
        case "resetUsage": {
          const { siteId } = message?.payload ?? {};
          await handleResetUsage(siteId);
          sendResponse({ success: true });
          break;
        }
        case "setSiteEnabled": {
          const { siteId, enabled } = message?.payload ?? {};
          await handleSetSiteEnabled(siteId, enabled);
          sendResponse({ success: true });
          break;
        }
        case "updateSite": {
          const payload = message?.payload ?? {};
          const result = await handleUpdateSite(payload);
          sendResponse({ success: true, data: result });
          break;
        }
        case "getStats": {
          const payload = await handleGetStats();
          sendResponse({ success: true, data: payload });
          break;
        }
        default:
          sendResponse({ success: false, error: "Unknown message." });
      }
    } catch (error) {
      console.error("[TimeLimitExtension]", error);
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: DEFAULT_TICK_MINUTES,
      delayInMinutes: DEFAULT_TICK_MINUTES
    });
  }
}

async function initializeBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
  await chrome.action.setBadgeText({ text: "" });
}

async function finalizeActiveSession() {
  const now = Date.now();
  const { state } = await mutateState((state) => {
    accrueFocus(state, now, { finalize: true });
    const reached = accrueSession(state, now, { finalize: true });
    if (reached) {
      state.__blockedSiteId = reached;
    }
  });
  await refreshBadge(state);
  if (state.__blockedSiteId) {
    const site = state.sites?.[state.__blockedSiteId];
    if (site) {
      await enforceBlock(site);
    }
    delete state.__blockedSiteId;
  }
}

async function setActiveContext(tabId, url, windowId) {
  if (!url || !isTrackableUrl(url)) {
    await finalizeActiveSession();
    return;
  }

  const host = extractHost(url);
  const now = Date.now();
  let siteToBlock = null;
  const { state } = await mutateState((state) => {
    accrueFocus(state, now, { finalize: true });

    const reached = accrueSession(state, now, { finalize: true });
    if (reached) {
      siteToBlock = reached;
    }

    if (!host) {
      state.focus = null;
      state.session = null;
      return;
    }

    startFocus(state, { tabId, windowId, url, host }, now);

    const site = findSiteForHost(state.sites, host);
    if (!site) {
      state.session = null;
      return;
    }

    if (!site.enabled) {
      state.session = null;
      return;
    }

    ensurePeriod(site, now);

    if (!isWithinActiveWindow(site, now)) {
      state.session = null;
      return;
    }

    const isUnlimited = !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0 || site.limitMinutes === 0;
    if (!isUnlimited && site.usageSeconds >= site.limitSeconds) {
      site.lastBlockedAt = now;
      siteToBlock = site.id;
      state.session = null;
      return;
    }

    state.session = {
      siteId: site.id,
      tabId,
      windowId,
      host,
      lastTick: now,
      startedAt: now,
      accumulatedSeconds: 0
    };
  });

  await refreshBadge(state);
  if (siteToBlock) {
    const site = state.sites?.[siteToBlock];
    if (site) {
      await enforceBlock(site);
    }
  }
}

async function handleGetSites() {
  const now = Date.now();
  const { state } = await mutateState((state) => {
    for (const site of Object.values(state.sites)) {
      ensurePeriod(site, now);
    }
  });
  await refreshBadge(state);
  return {
    session: state.session,
    sites: Object.values(state.sites).map((site) => formatSite(site))
  };
}

async function handleGetStats() {
  const now = Date.now();
  const { state } = await mutateState((state) => {
    ensureMetrics(state, now);
  });

  const metrics = state.metrics ?? sanitizeMetrics();
  const todaySeconds = Math.max(0, Math.round(metrics.totalSeconds ?? 0));
  const trackedSeconds = Math.max(0, Math.round(metrics.trackedSeconds ?? (metrics.totalSeconds ?? 0)));
  const sessionCount = Math.max(0, Math.round(metrics.sessionCount ?? 0));
  const totalSessionSeconds = Math.max(0, Math.round(metrics.totalSessionSeconds ?? 0));
  const avgSessionSeconds = sessionCount > 0 ? Math.round(totalSessionSeconds / sessionCount) : 0;

  const topSitesRaw = Object.values(metrics.siteTotals ?? {}).map((entry) => ({
    siteId: entry.siteId,
    domain: entry.domain,
    seconds: Math.max(0, Math.round(entry.seconds ?? 0)),
    sessionCount: Math.max(0, Math.round(entry.sessionCount ?? 0)),
    totalSessionSeconds: Math.max(0, Math.round(entry.totalSessionSeconds ?? 0))
  }));

  topSitesRaw.sort((a, b) => b.seconds - a.seconds);
  const topSites = topSitesRaw.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    avgSessionSeconds: entry.sessionCount > 0 ? Math.round(entry.totalSessionSeconds / entry.sessionCount) : 0,
    share: (trackedSeconds > 0 ? entry.seconds / trackedSeconds : (todaySeconds > 0 ? entry.seconds / todaySeconds : 0))
  }));

  const history = Array.isArray(metrics.history)
    ? metrics.history.filter((entry) => entry && typeof entry.dayKey === "string")
    : [];

  const combinedTrend = [...history, { dayKey: metrics.dayKey, totalSeconds: todaySeconds }];
  const trendMap = new Map();
  for (const entry of combinedTrend) {
    if (!entry || typeof entry !== "object") continue;
    const dayKey = typeof entry.dayKey === "string" ? entry.dayKey : null;
    if (!dayKey) continue;
    const totalSeconds = Math.max(0, Math.round(entry.totalSeconds ?? 0));
    trendMap.set(dayKey, { dayKey, totalSeconds });
  }

  const trend = Array.from(trendMap.values())
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
    .slice(-7);

  return {
    todaySeconds,
    trackedSeconds,
    sessionCount,
    avgSessionSeconds,
    topSites,
    trend
  };
}

async function handleAddSite(payload) {
  const now = Date.now();
  const {
    domain,
    limitMinutes,
    limitSeconds,
    period,
    windowStartMinutes,
    windowEndMinutes,
    invertWindow
  } = normalizeAddPayload(payload);
  let siteData = null;
  const { state } = await mutateState((state) => {
    const existing = Object.values(state.sites).find((site) => site.domain === domain);
    if (existing) {
      throw new Error("Domain already configured.");
    }

    const id = crypto.randomUUID();
    const periodStart = getPeriodStart(period, now);

    const site = {
      id,
      domain,
      period,
      limitMinutes,
      limitSeconds,
      enabled: true,
      windowStartMinutes,
    windowEndMinutes,
    invertWindow,
      usageSeconds: 0,
      periodStart,
      createdAt: now,
      lastUpdated: now,
      lastBlockedAt: null
    };

    state.sites[id] = site;
    siteData = formatSite(site);
  });
  await refreshBadge(state);
  return siteData;
}

async function handleUpdateSite(payload) {
  const { siteId } = payload ?? {};
  if (!siteId) {
    throw new Error("Missing site identifier.");
  }

  const now = Date.now();
  const {
    domain,
    limitMinutes,
    limitSeconds,
    period,
    windowStartMinutes,
    windowEndMinutes,
    invertWindow
  } = normalizeAddPayload(payload);

  let updatedSite = null;
  const { state } = await mutateState((state) => {
    const site = state.sites[siteId];
    if (!site) {
      throw new Error("Site not found.");
    }

    const conflicting = Object.values(state.sites).find(
      (candidate) => candidate.id !== siteId && candidate.domain === domain
    );
    if (conflicting) {
      throw new Error("Another site already uses that domain.");
    }

    site.domain = domain;
    site.limitMinutes = limitMinutes;
    site.limitSeconds = limitSeconds;
    site.period = period;
    site.windowStartMinutes = windowStartMinutes;
    site.windowEndMinutes = windowEndMinutes;
    site.invertWindow = invertWindow;
    ensurePeriod(site, now);
    site.lastUpdated = now;

    if (state.session?.siteId === siteId) {
      accrueSession(state, now, { finalize: true });
      state.session = null;
    }

    const isUnlimited = !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0 || site.limitMinutes === 0;
    if (!isUnlimited && site.usageSeconds >= site.limitSeconds) {
      site.lastBlockedAt = now;
    }

    const metrics = ensureMetrics(state, now);
    if (metrics.siteTotals?.[siteId]) {
      metrics.siteTotals[siteId].domain = domain;
    }

    updatedSite = formatSite(site);
  });

  await refreshBadge(state);
  return updatedSite;
}

async function handleRemoveSite(siteId) {
  if (!siteId) {
    throw new Error("Missing site identifier.");
  }
  const { state } = await mutateState((state) => {
    if (!state.sites[siteId]) {
      throw new Error("Site not found.");
    }
    if (state.session?.siteId === siteId) {
      accrueSession(state, Date.now(), { finalize: true });
      state.session = null;
    }
    delete state.sites[siteId];
  });
  await refreshBadge(state);
}

async function handleResetUsage(siteId) {
  if (!siteId) {
    throw new Error("Missing site identifier.");
  }
  const now = Date.now();
  const { state } = await mutateState((state) => {
    const site = state.sites[siteId];
    if (!site) {
      throw new Error("Site not found.");
    }
    site.usageSeconds = 0;
    site.periodStart = getPeriodStart(site.period, now);
    site.lastUpdated = now;
    site.lastBlockedAt = null;
    if (state.session?.siteId === siteId) {
      state.session.lastTick = now;
    }
  });
  await refreshBadge(state);
}

async function handleSetSiteEnabled(siteId, enabled) {
  if (!siteId) {
    throw new Error("Missing site identifier.");
  }
  const now = Date.now();
  const { state } = await mutateState((state) => {
    const site = state.sites[siteId];
    if (!site) {
      throw new Error("Site not found.");
    }
    site.enabled = Boolean(enabled);
    site.lastUpdated = now;
    if (!site.enabled && state.session?.siteId === siteId) {
      accrueSession(state, now, { finalize: true });
      state.session = null;
    }
  });
  await refreshBadge(state);
}

async function enforceBlock(site) {
  if (!site) return;
  if (!site.enabled) return;
  if (!isWithinActiveWindow(site)) return;
  const patterns = createUrlPatterns(site.domain);
  const blockUrl = chrome.runtime.getURL(`blocked.html?siteId=${encodeURIComponent(site.id)}`);
  const tabs = await chrome.tabs.query({ url: patterns });
  await Promise.all(
    tabs.map((tab) => chrome.tabs.update(tab.id, { url: blockUrl }))
  );
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  await chrome.action.setBadgeText({ text: "STOP" });
}

function startFocus(state, context, now) {
  if (!state) return;
  const tabId = Number(context?.tabId);
  if (!Number.isFinite(tabId)) {
    state.focus = null;
    return;
  }
  const windowId = Number.isFinite(Number(context?.windowId)) ? Number(context.windowId) : chrome.windows.WINDOW_ID_CURRENT;
  state.focus = {
    tabId,
    windowId,
    url: typeof context?.url === "string" ? context.url : "",
    host: typeof context?.host === "string" ? context.host : "",
    lastTick: now,
    startedAt: now,
    accumulatedSeconds: 0
  };
}

function accrueFocus(state, now, { finalize = false } = {}) {
  const focus = state?.focus;
  if (!focus) return;

  const lastTick = Number.isFinite(Number(focus.lastTick)) ? Number(focus.lastTick) : now;
  let deltaMs = now - lastTick;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    deltaMs = 0;
  }

  const deltaSeconds = Math.floor(deltaMs / 1000);
  if (deltaSeconds > 0) {
    focus.accumulatedSeconds = Math.max(0, (Number(focus.accumulatedSeconds) || 0) + deltaSeconds);
    recordFocus(state, deltaSeconds, now);
  }

  focus.lastTick = now;

  if (finalize) {
    state.focus = null;
  }
}

function accrueSession(state, now, { finalize = false } = {}) {
  const session = state.session;
  if (!session) return null;
  const site = state.sites?.[session.siteId];
  if (!site) {
    state.session = null;
    return null;
  }

  ensurePeriod(site, now);

  session.accumulatedSeconds = Math.max(0, Number(session.accumulatedSeconds) || 0);

  if (!site.enabled || !isWithinActiveWindow(site, now)) {
    if (finalize && session.accumulatedSeconds > 0) {
      recordSession(state, session, now);
    }
    state.session = null;
    return null;
  }

  const lastTick = session.lastTick ?? now;
  let deltaMs = now - lastTick;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    deltaMs = 0;
  }

  const deltaSeconds = Math.floor(deltaMs / 1000);
  if (deltaSeconds > 0) {
    site.usageSeconds = Math.max(0, (site.usageSeconds ?? 0) + deltaSeconds);
    site.lastUpdated = now;
    session.accumulatedSeconds += deltaSeconds;
    recordUsage(state, site, deltaSeconds, now);
  }

  session.lastTick = now;

  const isUnlimited = !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0 || site.limitMinutes === 0;
  const reachedLimit = !isUnlimited && site.usageSeconds >= site.limitSeconds;
  if (reachedLimit) {
    site.lastBlockedAt = now;
  }

  if (finalize || reachedLimit) {
    if (session.accumulatedSeconds > 0) {
      recordSession(state, session, now);
    }
    state.session = null;
  }

  return reachedLimit ? site.id : null;
}

function normalizeAddPayload(payload) {
  const rawDomain = String(payload?.domain ?? payload?.url ?? "").trim();
  if (!rawDomain) {
    throw new Error("Enter a website domain.");
  }

  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new Error("Unable to parse that website. Try something like example.com");
  }

  const period = payload?.period === "weekly" ? "weekly" : "daily";

  const limitInput = Number(payload?.limitMinutes ?? payload?.limit ?? 0);
  const isUnlimited = limitInput === 0;
  
  if (!isUnlimited && (!Number.isFinite(limitInput) || limitInput <= 0)) {
    throw new Error("Time limit must be a positive number of minutes or 0 for unlimited tracking.");
  }

  const windowStartRaw = payload?.windowStart ?? payload?.windowStartMinutes ?? 0;
  const windowEndRaw = payload?.windowEnd ?? payload?.windowEndMinutes ?? FULL_DAY_MINUTES;
  const windowBounds = normalizeWindowBounds(windowStartRaw, windowEndRaw);
  const limitMinutes = isUnlimited ? 0 : Math.max(1, limitInput);
  const limitSeconds = isUnlimited ? Infinity : Math.max(60, Math.round(limitMinutes * 60));
  const invertWindow = Boolean(payload?.invertWindow);

  return {
    domain,
    limitMinutes,
    limitSeconds,
    period,
    windowStartMinutes: windowBounds.start,
    windowEndMinutes: windowBounds.end,
    invertWindow
  };
}

function formatSite(site) {
  const normalized = applySiteDefaults({ ...site });
  const limitSeconds = normalized.limitSeconds;
  const usageSeconds = normalized.usageSeconds ?? 0;
  const isUnlimited = !Number.isFinite(limitSeconds) || limitSeconds === 0 || normalized.limitMinutes === 0;
  const remainingSeconds = isUnlimited ? Infinity : Math.max(0, limitSeconds - usageSeconds);
  return {
    id: normalized.id,
    domain: normalized.domain,
    period: normalized.period,
    limitMinutes: normalized.limitMinutes,
    limitSeconds: isUnlimited ? Infinity : limitSeconds,
    usageSeconds,
    remainingSeconds,
    periodStart: normalized.periodStart,
    nextReset: computeNextReset(normalized),
    enabled: normalized.enabled,
    windowStartMinutes: normalized.windowStartMinutes,
    windowEndMinutes: normalized.windowEndMinutes,
    invertWindow: normalized.invertWindow,
    createdAt: normalized.createdAt,
    lastUpdated: normalized.lastUpdated ?? null,
    lastBlockedAt: normalized.lastBlockedAt ?? null
  };
}

async function refreshBadge(stateOverride) {
  const state = stateOverride ?? await readState();
  const session = state.session;
  if (!session) {
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const site = state.sites?.[session.siteId];
  if (!site) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  if (!site.enabled || !isWithinActiveWindow(site)) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const isUnlimited = !Number.isFinite(site.limitSeconds) || site.limitSeconds === 0 || site.limitMinutes === 0;
  if (isUnlimited) {
    await chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
    await chrome.action.setBadgeText({ text: "∞" });
    return;
  }

  const remainingSeconds = Math.max(0, site.limitSeconds - site.usageSeconds);
  if (remainingSeconds <= 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "STOP" });
    return;
  }

  const minutes = Math.ceil(remainingSeconds / 60);
  const text = minutes > 99 ? "99+" : String(minutes);
  await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
  await chrome.action.setBadgeText({ text });
}

function ensurePeriod(site, now = Date.now()) {
  if (!site) return;
  const periodStart = getPeriodStart(site.period, now);
  const duration = PERIOD_MS[site.period] ?? PERIOD_MS.daily;
  if (!Number.isFinite(site.periodStart)) {
    site.periodStart = periodStart;
    site.usageSeconds = 0;
    return;
  }

  if (now - site.periodStart >= duration || site.periodStart < periodStart) {
    site.periodStart = periodStart;
    site.usageSeconds = 0;
    site.lastBlockedAt = null;
  }
}

function computeNextReset(site) {
  const duration = PERIOD_MS[site.period] ?? PERIOD_MS.daily;
  return (site.periodStart ?? getPeriodStart(site.period)) + duration;
}

function getPeriodStart(period, timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return Date.now();
  }
  date.setMilliseconds(0);
  date.setSeconds(0);
  date.setMinutes(0);
  date.setHours(0);

  if (period === "weekly") {
    const day = date.getDay(); // 0 (Sun) - 6 (Sat)
    const diffToMonday = (day + 6) % 7; // Monday => 0
    date.setDate(date.getDate() - diffToMonday);
  }

  return date.getTime();
}

function findSiteForHost(sites, host) {
  return Object.values(sites || {}).find((site) => hostMatches(site.domain, host)) ?? null;
}

function hostMatches(domain, host) {
  if (!domain || !host) return false;
  if (host === domain) return true;
  return host.endsWith(`.${domain}`);
}

function normalizeDomain(input) {
  let candidate = String(input).trim();
  if (!candidate) return null;

  if (!candidate.includes("://")) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!/^https?$/.test(url.protocol.replace(":", ""))) {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    return hostname.replace(/^www\./, "");
  } catch (_error) {
    return null;
  }
}

function isTrackableUrl(url) {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function extractHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch (_error) {
    return null;
  }
}

function createUrlPatterns(domain) {
  const clean = domain.replace(/^\*+\.?/, "");
  const basePatterns = new Set([
    `https://${clean}/*`,
    `http://${clean}/*`,
    `https://*.${clean}/*`,
    `http://*.${clean}/*`
  ]);
  return Array.from(basePatterns);
}

function readState() {
  return chrome.storage.local.get(READ_STATE_DEFAULTS).then((data) => ({
    sites: sanitizeSites(data.sites ?? {}),
    session: sanitizeSession(data.session ?? null),
    focus: sanitizeFocus(data.focus ?? null),
    metrics: sanitizeMetrics(data.metrics)
  }));
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_error) {
    return null;
  }
}

async function mutateState(mutator) {
  const data = await chrome.storage.local.get(READ_STATE_DEFAULTS);
  const state = {
    sites: sanitizeSites(data.sites ?? {}),
    session: sanitizeSession(data.session ?? null),
    focus: sanitizeFocus(data.focus ?? null),
    metrics: sanitizeMetrics(data.metrics)
  };
  const result = await mutator(state);
  state.sites = sanitizeSites(state.sites ?? {});
  state.metrics = sanitizeMetrics(state.metrics);
  state.session = sanitizeSession(state.session);
  state.focus = sanitizeFocus(state.focus);
  if (state.session && !state.sites[state.session.siteId]) {
    state.session = null;
  }
  await chrome.storage.local.set({
    sites: state.sites,
    session: state.session ?? null,
    focus: state.focus ?? null,
    metrics: state.metrics
  });
  return { state, result };
}

function sanitizeSites(record) {
  const result = {};
  for (const [id, raw] of Object.entries(record || {})) {
    if (!raw || typeof raw !== "object") continue;
    result[id] = applySiteDefaults({ ...raw });
  }
  return result;
}

function sanitizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  if (!session.siteId) {
    return null;
  }
  const sanitized = { ...session };
  const fallback = Date.now();
  sanitized.lastTick = Number.isFinite(Number(sanitized.lastTick)) ? Number(sanitized.lastTick) : fallback;
  sanitized.startedAt = Number.isFinite(Number(sanitized.startedAt)) ? Number(sanitized.startedAt) : sanitized.lastTick;
  sanitized.accumulatedSeconds = Math.max(0, Number(sanitized.accumulatedSeconds) || 0);
  return sanitized;
}

function sanitizeFocus(focus) {
  if (!focus || typeof focus !== "object") {
    return null;
  }
  const tabId = Number(focus.tabId);
  if (!Number.isFinite(tabId)) {
    return null;
  }
  const sanitized = { ...focus };
  const fallback = Date.now();
  sanitized.tabId = tabId;
  sanitized.windowId = Number.isFinite(Number(sanitized.windowId)) ? Number(sanitized.windowId) : chrome.windows.WINDOW_ID_CURRENT;
  sanitized.url = typeof sanitized.url === "string" ? sanitized.url : "";
  sanitized.host = typeof sanitized.host === "string" ? sanitized.host : "";
  sanitized.lastTick = Number.isFinite(Number(sanitized.lastTick)) ? Number(sanitized.lastTick) : fallback;
  sanitized.startedAt = Number.isFinite(Number(sanitized.startedAt)) ? Number(sanitized.startedAt) : sanitized.lastTick;
  sanitized.accumulatedSeconds = Math.max(0, Number(sanitized.accumulatedSeconds) || 0);
  if (!isTrackableUrl(sanitized.url)) {
    return null;
  }
  return sanitized;
}

function sanitizeMetrics(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const legacyTotal = Number(source.totalSeconds);
  const focusSeconds = Number(source.focusSeconds);
  const trackedSeconds = Number(source.trackedSeconds);
  const metrics = {
    dayKey: typeof source.dayKey === "string" ? source.dayKey : null,
    totalSeconds: Math.max(0, Number.isFinite(focusSeconds) ? focusSeconds : (Number.isFinite(legacyTotal) ? legacyTotal : 0)),
    trackedSeconds: Math.max(0, Number.isFinite(trackedSeconds) ? trackedSeconds : (Number.isFinite(legacyTotal) ? legacyTotal : 0)),
    sessionCount: Math.max(0, Number(source.sessionCount) || 0),
    totalSessionSeconds: Math.max(0, Number(source.totalSessionSeconds) || 0),
    siteTotals: {},
    history: []
  };

  if (source.siteTotals && typeof source.siteTotals === "object") {
    for (const [siteId, value] of Object.entries(source.siteTotals)) {
      if (!value || typeof value !== "object") continue;
      const seconds = Math.max(0, Number(value.seconds) || 0);
      const domain = typeof value.domain === "string" ? value.domain : String(value.domain ?? siteId);
      const sessionCount = Math.max(0, Number(value.sessionCount) || 0);
      const totalSessionSeconds = Math.max(0, Number(value.totalSessionSeconds) || 0);
      metrics.siteTotals[siteId] = {
        siteId,
        domain,
        seconds,
        sessionCount,
        totalSessionSeconds
      };
    }
  }

  if (Array.isArray(source.history)) {
    const byDay = new Map();
    for (const entry of source.history) {
      if (!entry || typeof entry !== "object") continue;
      const dayKey = typeof entry.dayKey === "string" ? entry.dayKey : null;
      if (!dayKey) continue;
      const totalSeconds = Math.max(0, Number(entry.totalSeconds) || 0);
      byDay.set(dayKey, { dayKey, totalSeconds });
    }
    metrics.history = Array.from(byDay.values()).sort((a, b) => a.dayKey.localeCompare(b.dayKey)).slice(-7);
  }

  if (!metrics.dayKey) {
    metrics.dayKey = getDayKey();
  }

  return metrics;
}

function ensureMetrics(state, now = Date.now()) {
  state.metrics = sanitizeMetrics(state.metrics);
  const metrics = state.metrics;
  const dayKey = getDayKey(now);
  if (metrics.dayKey !== dayKey) {
    archiveMetrics(metrics, dayKey);
  }
  return metrics;
}

function archiveMetrics(metrics, newDayKey) {
  if (!metrics) return;
  const history = Array.isArray(metrics.history) ? [...metrics.history] : [];
  if (metrics.dayKey) {
    const entry = {
      dayKey: metrics.dayKey,
      totalSeconds: Math.max(0, Math.round(metrics.totalSeconds ?? 0))
    };
    const byDay = new Map(history.map((item) => [item.dayKey, item]));
    byDay.set(entry.dayKey, entry);
    metrics.history = Array.from(byDay.values()).sort((a, b) => a.dayKey.localeCompare(b.dayKey)).slice(-7);
  } else {
    metrics.history = history.slice(-7);
  }
  metrics.dayKey = newDayKey;
  metrics.totalSeconds = 0;
  metrics.trackedSeconds = 0;
  metrics.sessionCount = 0;
  metrics.totalSessionSeconds = 0;
  metrics.siteTotals = {};
}

function recordFocus(state, deltaSeconds, now = Date.now()) {
  if (!deltaSeconds || deltaSeconds <= 0) return;
  const metrics = ensureMetrics(state, now);
  metrics.totalSeconds = Math.max(0, (metrics.totalSeconds ?? 0) + deltaSeconds);
}

function recordUsage(state, site, deltaSeconds, now = Date.now()) {
  if (!deltaSeconds || deltaSeconds <= 0) return;
  const metrics = ensureMetrics(state, now);
  metrics.trackedSeconds = Math.max(0, (metrics.trackedSeconds ?? 0) + deltaSeconds);
  if (!site?.id) return;
  const current = metrics.siteTotals[site.id] ?? {
    siteId: site.id,
    domain: site.domain,
    seconds: 0,
    sessionCount: 0,
    totalSessionSeconds: 0
  };
  current.seconds = Math.max(0, (current.seconds ?? 0) + deltaSeconds);
  current.domain = site.domain ?? current.domain;
  metrics.siteTotals[site.id] = current;
}

function recordSession(state, session, now = Date.now()) {
  if (!session || typeof session !== "object") return;
  const sessionSeconds = Math.max(0, Number(session.accumulatedSeconds) || 0);
  if (!sessionSeconds) return;
  const metrics = ensureMetrics(state, now);
  metrics.sessionCount = Math.max(0, (metrics.sessionCount ?? 0) + 1);
  metrics.totalSessionSeconds = Math.max(0, (metrics.totalSessionSeconds ?? 0) + sessionSeconds);
  const siteId = session.siteId;
  if (!siteId) return;
  const site = state.sites?.[siteId];
  const current = metrics.siteTotals[siteId] ?? {
    siteId,
    domain: site?.domain ?? String(siteId),
    seconds: 0,
    sessionCount: 0,
    totalSessionSeconds: 0
  };
  current.sessionCount = Math.max(0, (current.sessionCount ?? 0) + 1);
  current.totalSessionSeconds = Math.max(0, (current.totalSessionSeconds ?? 0) + sessionSeconds);
  current.domain = site?.domain ?? current.domain;
  metrics.siteTotals[siteId] = current;
}

function applySiteDefaults(site) {
  if (!site || typeof site !== "object") {
    return {
      enabled: true,
      windowStartMinutes: 0,
      windowEndMinutes: FULL_DAY_MINUTES,
      invertWindow: false
    };
  }
  if (typeof site.enabled !== "boolean") {
    site.enabled = true;
  }
  if (typeof site.invertWindow !== "boolean") {
    site.invertWindow = false;
  }
  const windowBounds = normalizeWindowBounds(site.windowStartMinutes, site.windowEndMinutes);
  site.windowStartMinutes = windowBounds.start;
  site.windowEndMinutes = windowBounds.end;
  return site;
}

function getDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeWindowBounds(start, end) {
  let normalizedStart = clampWindowValue(start);
  let normalizedEnd = clampWindowValue(end);
  if (normalizedStart === normalizedEnd) {
    return { start: 0, end: FULL_DAY_MINUTES };
  }
  if (normalizedStart > normalizedEnd) {
    [normalizedStart, normalizedEnd] = [normalizedEnd, normalizedStart];
  }
  return { start: normalizedStart, end: normalizedEnd };
}

function clampWindowValue(value) {
  const numeric = Math.round(Number(value) || 0);
  return Math.min(FULL_DAY_MINUTES, Math.max(0, numeric));
}

function isWithinActiveWindow(site, timestamp = Date.now()) {
  if (!site) return false;
  const { start, end } = normalizeWindowBounds(site.windowStartMinutes, site.windowEndMinutes);
  const minutes = minutesSinceMidnight(timestamp);

  let active;
  if (start === 0 && end === FULL_DAY_MINUTES) {
    active = true;
  } else if (start <= end) {
    active = minutes >= start && minutes < end;
  } else {
    active = minutes >= start || minutes < end;
  }

  return site.invertWindow ? !active : active;
}

function minutesSinceMidnight(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }
  return (date.getHours() * 60) + date.getMinutes();
}
