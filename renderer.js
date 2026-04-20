// i18n structure moved to i18n.js and locales/

let globalSettings = { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [], savedProfileProxySourceBatchHistory: [], mode: 'single', enablePreProxy: false };
let currentEditId = null;
let confirmCallback = null;
let currentProxyGroup = 'manual';
let currentProxyManagerTab = 'chain';
let currentProxyLibraryTab = 'proxies';
let inputCallback = null;
let inputModalOptions = null;
let searchText = '';
let viewMode = localStorage.getItem('geekez_view') || 'list';
let sshHostKeyPromptReq = null;
const APP_REPO_URL = 'https://github.com/Frankieli123/GeekezBrowser';
const APP_API_DOCS_URL = `${APP_REPO_URL}/blob/main/docs/API.md`;
const profileDiagnosticsCache = new Map();
const profileProxyTestCache = new Map();
const savedProfileProxyTestCache = new Map();
const SAVED_PROXY_QUARANTINE_FAILURE_STREAK = 3;
const SAVED_PROFILE_PROXY_SOURCE_BATCH_HISTORY_LIMIT = 10;
const visibleProfileCardCache = new Map();
const selectedListProfileIds = new Set();
let profileDiagnosticsLoadToken = 0;
let profileProxyTestLoadToken = 0;
let savedProfileProxyTestLoadToken = 0;
let profileListLoadToken = 0;
let localApiBaseCache = '';
let visibleListProfileIds = [];
let savedProfileProxyUsageCounts = {};
let savedProfileProxyOriginalIds = new Set();
let savedProfileProxySourceOriginalIds = new Set();
const selectedSavedProfileProxyIds = new Set();
let savedProfileProxySourceBulkMaintenanceState = createSavedProfileProxySourceBulkMaintenanceState();
let savedProfileProxySourceOverviewActionState = createSavedProfileProxySourceOverviewActionState();
const profileExtensionStates = {
    add: { libraryPaths: [], selectedPaths: [], useGlobalExtensions: true },
    edit: { libraryPaths: [], selectedPaths: [], useGlobalExtensions: true }
};
const proxyTestStates = {
    add: { testedProxy: '', total: 0, inputSnapshot: '', result: null },
    edit: { testedProxy: '', total: 0, inputSnapshot: '', result: null }
};

function uiText(cn, en) {
    return curLang === 'cn' ? cn : en;
}

function normalizeRendererUiLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw === 'en' || raw === 'en-us' ? 'en' : 'cn';
}

async function syncAppLanguagePreference(nextLanguage = curLang) {
    const language = normalizeRendererUiLanguage(nextLanguage);
    curLang = language;
    window.curLang = language;
    localStorage.setItem('geekez_lang', language);
    if (!globalSettings || typeof globalSettings !== 'object') globalSettings = {};
    globalSettings.uiLanguage = language;
    try {
        await window.electronAPI.invoke('set-app-language', language);
    } catch (e) { }
    return language;
}

function normalizeDiagnosticStatus(value, fallback = 'info') {
    const current = String(value || '').trim().toLowerCase();
    return ['ok', 'warn', 'info'].includes(current) ? current : fallback;
}

function normalizeSavedProxyId(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxyTestResultEntry(result) {
    const current = result && typeof result === 'object' ? result : {};
    const checkedAt = Number(current.checkedAt);
    const latencyMs = Number(current.latencyMs);
    const lastSuccessAt = Number(current.lastSuccessAt);
    const lastFailureAt = Number(current.lastFailureAt);
    const failureStreak = Number(current.failureStreak);
    return {
        ...current,
        success: current.success === true,
        status: normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn'),
        checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : 0,
        latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : null,
        proxySnapshot: normalizeProxyTestInput(current.proxySnapshot || ''),
        savedProxyId: normalizeSavedProxyId(current.savedProxyId),
        lastSuccessAt: Number.isFinite(lastSuccessAt) && lastSuccessAt > 0 ? lastSuccessAt : 0,
        lastFailureAt: Number.isFinite(lastFailureAt) && lastFailureAt > 0 ? lastFailureAt : 0,
        failureStreak: Number.isFinite(failureStreak) && failureStreak > 0 ? Math.round(failureStreak) : 0,
    };
}

function mergeSavedProfileProxyTestHistory(result, previousResult = null) {
    const next = normalizeSavedProfileProxyTestResultEntry(result);
    const prev = normalizeSavedProfileProxyTestResultEntry(previousResult);
    if (next.status === 'ok') {
        next.lastSuccessAt = next.checkedAt || Date.now();
        next.lastFailureAt = prev.lastFailureAt || 0;
        next.failureStreak = 0;
        return next;
    }
    if (next.status === 'warn') {
        next.lastSuccessAt = prev.lastSuccessAt || 0;
        next.lastFailureAt = next.checkedAt || Date.now();
        next.failureStreak = (prev.status === 'warn' ? prev.failureStreak : 0) + 1;
        return next;
    }
    next.lastSuccessAt = prev.lastSuccessAt || 0;
    next.lastFailureAt = prev.lastFailureAt || 0;
    next.failureStreak = prev.failureStreak || 0;
    return next;
}

function setSavedProfileProxyTestCacheEntry(savedProxyId, result, { mergeHistory = true } = {}) {
    const id = normalizeSavedProxyId(savedProxyId);
    if (!id) return null;
    const next = mergeHistory
        ? mergeSavedProfileProxyTestHistory(result, savedProfileProxyTestCache.get(id))
        : normalizeSavedProfileProxyTestResultEntry(result);
    savedProfileProxyTestCache.set(id, next);
    return next;
}

function detectSavedProxyType(proxyStr) {
    const raw = String(proxyStr || '').trim();
    if (!raw) return 'DIRECT';
    const match = raw.match(/^([a-z0-9+.-]+):\/\//i);
    if (match && match[1]) return String(match[1]).toUpperCase();
    if (raw.includes(':') && !raw.includes('://')) return 'SOCKS';
    return 'UNKNOWN';
}

function getSavedProfileProxyLibrary(settings = globalSettings, { includeDisabled = true } = {}) {
    const list = Array.isArray(settings && settings.savedProfileProxies) ? settings.savedProfileProxies : [];
    return list
        .map((item) => ({
            id: normalizeSavedProxyId(item && item.id),
            name: String(item && item.name || '').trim(),
            proxyStr: String(item && item.proxyStr || '').trim(),
            tags: Array.isArray(item && item.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
            group: String(item && (item.group || item.groupName) || '').trim(),
            notes: String(item && (item.notes || item.remark) || '').trim(),
            sourceId: normalizeSavedProfileProxySourceId(item && item.sourceId),
            sourceName: String(item && (item.sourceName || item.sourceDisplayName) || '').trim(),
            sourceImportedAt: normalizeSavedProfileProxyImportedAt(item && item.sourceImportedAt),
            sourceStale: normalizeSavedProfileProxySourceStale(item && item.sourceStale),
            sourceMissingSince: normalizeSavedProfileProxyMissingSince(item && item.sourceMissingSince),
            profilesCount: Number(item && item.profilesCount || 0),
            enabled: item && item.enabled !== false,
        }))
        .filter((item) => item.id && item.proxyStr && (includeDisabled || item.enabled));
}

function getSavedProfileProxyDisplayName(proxy) {
    if (!proxy) return '';
    const base = String(proxy.name || proxy.id || '').trim();
    const group = String(proxy.group || '').trim();
    return group ? `${base} · ${group}` : base;
}

function findSavedProfileProxyById(settings, savedProxyId) {
    const targetId = normalizeSavedProxyId(savedProxyId);
    if (!targetId) return null;
    return getSavedProfileProxyLibrary(settings).find((item) => item.id === targetId) || null;
}

function getProfileResolvedProxyBinding(profile, settings = globalSettings) {
    const savedProxyId = normalizeSavedProxyId(profile && profile.savedProxyId);
    const manualProxyStr = String(profile && profile.proxyStr || '').trim();
    const savedProxy = findSavedProfileProxyById(settings, savedProxyId);
    if (savedProxy) {
        return {
            source: 'saved',
            savedProxyId: savedProxy.id,
            savedProxyName: savedProxy.name || savedProxy.id,
            savedProxyGroup: savedProxy.group || '',
            savedProxyTags: Array.isArray(savedProxy.tags) ? savedProxy.tags : [],
            proxyStr: savedProxy.proxyStr,
            manualProxyStr,
            bindingBroken: false,
        };
    }
    return {
        source: savedProxyId ? 'saved-missing' : 'manual',
        savedProxyId,
        savedProxyName: savedProxyId,
        savedProxyGroup: '',
        savedProxyTags: [],
        proxyStr: manualProxyStr,
        manualProxyStr,
        bindingBroken: !!savedProxyId,
    };
}

function getProfileEffectiveProxyInput(profile, settings = globalSettings) {
    return normalizeProxyTestInput(getProfileResolvedProxyBinding(profile, settings).proxyStr);
}

async function refreshSavedProfileProxyUsageCounts(profiles = null) {
    const list = Array.isArray(profiles) ? profiles : await window.electronAPI.getProfiles();
    const counts = {};
    for (const profile of Array.isArray(list) ? list : []) {
        const savedProxyId = normalizeSavedProxyId(profile && profile.savedProxyId);
        if (!savedProxyId) continue;
        counts[savedProxyId] = (counts[savedProxyId] || 0) + 1;
    }
    savedProfileProxyUsageCounts = counts;
    return counts;
}

function getSavedProfileProxyUsageCount(savedProxyId) {
    return Number(savedProfileProxyUsageCounts[normalizeSavedProxyId(savedProxyId)] || 0);
}

function normalizeSavedProfileProxySourceId(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxyImportedAt(value) {
    const current = Number(value);
    return Number.isFinite(current) && current > 0 ? Math.round(current) : 0;
}

function normalizeSavedProfileProxyMissingSince(value) {
    const current = Number(value);
    return Number.isFinite(current) && current > 0 ? Math.round(current) : 0;
}

function normalizeSavedProfileProxySourceStale(value) {
    return value === true;
}

function getSavedProfileProxySourceState(proxy) {
    const sourceId = normalizeSavedProfileProxySourceId(proxy && proxy.sourceId);
    const sourceImportedAt = normalizeSavedProfileProxyImportedAt(proxy && proxy.sourceImportedAt);
    const sourceMissingSince = normalizeSavedProfileProxyMissingSince(proxy && proxy.sourceMissingSince);
    const stale = normalizeSavedProfileProxySourceStale(proxy && proxy.sourceStale);
    const source = sourceId
        ? (Array.isArray(advancedPresetState && advancedPresetState.savedProfileProxySources)
            ? advancedPresetState.savedProfileProxySources.find((item) => normalizeSavedProfileProxySourceId(item && item.id) === sourceId)
            : null)
        : null;
    const fallbackName = String(proxy && (proxy.sourceName || proxy.sourceDisplayName) || '').trim();
    return {
        id: sourceId,
        name: String((source && source.name) || fallbackName || sourceId || '').trim(),
        importedAt: sourceImportedAt,
        missingSince: sourceMissingSince,
        stale,
        exists: !!source,
        status: !sourceId ? 'manual' : (!source ? 'source-missing' : (stale ? 'stale' : 'active')),
    };
}

function buildSavedProfileProxyStringMap(list) {
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
        const id = normalizeSavedProxyId(item && item.id);
        const proxyStr = String(item && item.proxyStr || '').trim();
        if (id && proxyStr) map.set(id, proxyStr);
    }
    return map;
}

async function syncSavedProxyFallbacksForProfiles(previousList, nextList) {
    const previousMap = buildSavedProfileProxyStringMap(previousList);
    const nextMap = buildSavedProfileProxyStringMap(nextList);
    const changedMap = new Map();
    for (const [id, proxyStr] of nextMap.entries()) {
        if (previousMap.has(id) && previousMap.get(id) !== proxyStr) {
            changedMap.set(id, proxyStr);
        }
    }
    if (changedMap.size === 0) return { updated: 0, failed: [] };

    const profiles = await window.electronAPI.getProfiles();
    let updated = 0;
    const failed = [];
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        const savedProxyId = normalizeSavedProxyId(profile && profile.savedProxyId);
        const nextProxyStr = changedMap.get(savedProxyId);
        if (!savedProxyId || !nextProxyStr) continue;
        if (String(profile && profile.proxyStr || '').trim() === nextProxyStr) continue;
        try {
            await window.electronAPI.updateProfile({ id: profile.id, proxyStr: nextProxyStr });
            profileProxyTestCache.delete(profile.id);
            updated++;
        } catch (e) {
            failed.push((profile && profile.name) || profile.id);
        }
    }
    return { updated, failed };
}

function getLatestExternalDiagnosticRun(diagnostics) {
    const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
    return recentRuns[0] || null;
}

function getSelfCheckDetail(summary) {
    const items = Array.isArray(summary && summary.items) ? summary.items : [];
    return items.find((item) => item && item.status === 'warn') || items[0] || null;
}

function formatDiagTime(value) {
    const current = Number(value);
    if (!Number.isFinite(current) || current <= 0) return uiText('未知时间', 'Unknown time');
    try {
        return new Date(current).toLocaleString();
    } catch (e) {
        return String(value);
    }
}

function formatRelativeDuration(value) {
    const current = Math.max(0, Number(value) || 0);
    if (current < 60 * 1000) return uiText('不到 1 分钟', '< 1 min');
    const totalMinutes = Math.round(current / (60 * 1000));
    if (totalMinutes < 60) return uiText(`${totalMinutes} 分钟`, `${totalMinutes} min`);
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    if (totalHours < 24) {
        return remainingMinutes > 0
            ? uiText(`${totalHours} 小时 ${remainingMinutes} 分钟`, `${totalHours}h ${remainingMinutes}m`)
            : uiText(`${totalHours} 小时`, `${totalHours}h`);
    }
    const totalDays = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return remainingHours > 0
        ? uiText(`${totalDays} 天 ${remainingHours} 小时`, `${totalDays}d ${remainingHours}h`)
        : uiText(`${totalDays} 天`, `${totalDays}d`);
}

function formatSignedCount(value) {
    const current = Number(value) || 0;
    if (current > 0) return `+${current}`;
    return String(current);
}

function createSavedProfileProxySourceBulkMaintenanceState(overrides = {}) {
    return {
        running: false,
        total: 0,
        currentIndex: 0,
        completed: 0,
        ok: 0,
        failed: 0,
        added: 0,
        quarantined: 0,
        recovered: 0,
        currentSourceId: '',
        currentSourceLabel: '',
        lastSummary: null,
        ...overrides,
    };
}

function createSavedProfileProxySourceOverviewActionState(overrides = {}) {
    return {
        running: false,
        action: '',
        current: 0,
        total: 0,
        label: '',
        ...overrides,
    };
}

function setSavedProfileProxySourceOverviewActionState(overrides = {}, options = {}) {
    savedProfileProxySourceOverviewActionState = createSavedProfileProxySourceOverviewActionState(overrides);
    if (options.render !== false) renderSavedProfileProxySourceEditors();
    return savedProfileProxySourceOverviewActionState;
}

function isSavedProfileProxySourceOperationsBusy() {
    return !!(
        (savedProfileProxySourceBulkMaintenanceState && savedProfileProxySourceBulkMaintenanceState.running)
        || (savedProfileProxySourceOverviewActionState && savedProfileProxySourceOverviewActionState.running)
    );
}

function normalizeSavedProfileProxySourceBatchAction(value) {
    const current = String(value || '').trim().toLowerCase();
    return [
        'attention-maintenance',
        'refresh-due',
        'quarantine-candidates',
        'recheck-quarantined',
    ].includes(current) ? current : 'attention-maintenance';
}

function normalizeSavedProfileProxySourceBatchHistoryEntry(entry) {
    const current = entry && typeof entry === 'object' ? entry : {};
    const toCount = (value) => {
        const currentValue = Number(value);
        return Number.isFinite(currentValue) && currentValue >= 0 ? Math.round(currentValue) : 0;
    };
    const finishedAt = Number(current.finishedAt);
    return {
        action: normalizeSavedProfileProxySourceBatchAction(current.action),
        finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? Math.round(finishedAt) : 0,
        total: toCount(current.total),
        ok: toCount(current.ok),
        failed: toCount(current.failed),
        added: toCount(current.added),
        quarantined: toCount(current.quarantined),
        recovered: toCount(current.recovered),
        dueCount: toCount(current.dueCount),
        overdueCount: toCount(current.overdueCount),
        errorCount: toCount(current.errorCount),
        candidateCount: toCount(current.candidateCount),
        sourceCount: toCount(current.sourceCount),
        affectedProfilesCount: toCount(current.affectedProfilesCount),
        sourceIds: (Array.isArray(current.sourceIds) ? current.sourceIds : [])
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 50),
    };
}

function normalizeSavedProfileProxySourceBatchHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceBatchHistoryEntry(item))
        .filter((item) => item.finishedAt > 0 && item.total > 0)
        .sort((a, b) => b.finishedAt - a.finishedAt)
        .slice(0, SAVED_PROFILE_PROXY_SOURCE_BATCH_HISTORY_LIMIT);
}

function getSavedProfileProxySourceBatchHistory(settings = globalSettings) {
    return normalizeSavedProfileProxySourceBatchHistory(settings && settings.savedProfileProxySourceBatchHistory);
}

function getLatestSavedProfileProxySourceBatchHistoryEntry(action = '') {
    const targetAction = normalizeSavedProfileProxySourceBatchAction(action);
    return getSavedProfileProxySourceBatchHistory().find((entry) => normalizeSavedProfileProxySourceBatchAction(entry && entry.action) === targetAction) || null;
}

function getSavedProfileProxySourceBatchHistoryActionLabel(entry) {
    const action = normalizeSavedProfileProxySourceBatchAction(entry && entry.action);
    if (action === 'refresh-due') return t('savedProxySourceBatchHistoryActionRefreshDue');
    if (action === 'quarantine-candidates') return t('savedProxySourceBatchHistoryActionQuarantineCandidates');
    if (action === 'recheck-quarantined') return t('savedProxySourceBatchHistoryActionRecheckQuarantined');
    return t('savedProxySourceBatchHistoryActionAttention');
}

function buildSavedProfileProxySourceBatchHistorySummaryText(entry) {
    const current = normalizeSavedProfileProxySourceBatchHistoryEntry(entry);
    const action = normalizeSavedProfileProxySourceBatchAction(current.action);
    if (action === 'refresh-due') {
        return uiText(
            `来源 ${current.total} 个 · 成功 ${current.ok} · 失败 ${current.failed} · 新增 ${current.added}`,
            `${current.total} sources · ${current.ok} ok · ${current.failed} failed · +${current.added} added`
        );
    }
    if (action === 'quarantine-candidates') {
        return uiText(
            `候选代理 ${current.total} 条 · 已隔离 ${current.quarantined} 条 · 来源 ${current.sourceCount} 个${current.affectedProfilesCount > 0 ? ` · 影响环境 ${current.affectedProfilesCount} 个` : ''}`,
            `${current.total} candidate proxies · ${current.quarantined} quarantined · ${current.sourceCount} sources${current.affectedProfilesCount > 0 ? ` · ${current.affectedProfilesCount} affected profiles` : ''}`
        );
    }
    if (action === 'recheck-quarantined') {
        return uiText(
            `隔离代理 ${current.total} 条 · 恢复 ${current.recovered} 条 · 检测异常 ${current.failed} 条 · 来源 ${current.sourceCount} 个`,
            `${current.total} quarantined proxies · ${current.recovered} recovered · ${current.failed} test failures · ${current.sourceCount} sources`
        );
    }
    return t('savedProxySourceBatchHistoryResultSummary')
        .replace('{ok}', String(current.ok))
        .replace('{failed}', String(current.failed))
        .replace('{added}', String(current.added))
        .replace('{quarantined}', String(current.quarantined))
        .replace('{recovered}', String(current.recovered));
}

function buildSavedProfileProxySourceBatchHistoryScopeText(entry) {
    const current = normalizeSavedProfileProxySourceBatchHistoryEntry(entry);
    const action = normalizeSavedProfileProxySourceBatchAction(current.action);
    if (action === 'refresh-due') {
        return uiText(
            `到期 ${current.dueCount} · 超时 ${current.overdueCount}`,
            `due ${current.dueCount} · overdue ${current.overdueCount}`
        );
    }
    if (action === 'quarantine-candidates') {
        return uiText(
            `候选项 ${current.candidateCount} · 来源 ${current.sourceCount}`,
            `candidates ${current.candidateCount} · sources ${current.sourceCount}`
        );
    }
    if (action === 'recheck-quarantined') {
        return uiText(
            `来源 ${current.sourceCount} · 成功 ${current.ok} · 失败 ${current.failed}`,
            `sources ${current.sourceCount} · ${current.ok} ok · ${current.failed} failed`
        );
    }
    return t('savedProxySourceRunAttentionMaintenanceScope')
        .replace('{count}', String(current.total))
        .replace('{due}', String(current.dueCount))
        .replace('{overdue}', String(current.overdueCount))
        .replace('{error}', String(current.errorCount))
        .replace('{candidate}', String(current.candidateCount));
}

function dedupeDiagnosticTexts(items, limit = 3) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        const value = String(item || '').replace(/\s+/g, ' ').trim();
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= limit) break;
    }
    return out;
}

function normalizeDiagnosticFactItems(items, limit = 4) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        const label = String(item && item.label || '').replace(/\s+/g, ' ').trim();
        const value = String(item && item.value || '').replace(/\s+/g, ' ').trim();
        const status = normalizeDiagnosticStatus(item && item.status, 'info');
        const key = `${label.toLowerCase()}::${value.toLowerCase()}`;
        if (!label || !value || seen.has(key)) continue;
        seen.add(key);
        out.push({ label, value, status });
        if (out.length >= limit) break;
    }
    return out;
}

function buildLatestRunFactsMarkup(result) {
    const facts = normalizeDiagnosticFactItems(result && result.facts, 4);
    if (facts.length === 0) return '';
    return `
        <div class="diag-fact-list">
            ${facts.map((item) => `
                <div class="diag-fact-chip" data-status="${escapeHtml(item.status)}">
                    <span class="diag-fact-label">${escapeHtml(item.label)}</span>
                    <span class="diag-fact-value">${escapeHtml(item.value)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function buildLatestRunArtifactMarkup(latestRun, options = {}) {
    const showDetails = options.showDetails !== false;
    const artifacts = latestRun && latestRun.result && latestRun.result.artifacts ? latestRun.result.artifacts : {};
    const available = Array.isArray(artifacts.available) ? artifacts.available : [];
    const buttons = [
        showDetails && artifacts.runId
            ? `<button type="button" class="diag-mini-btn" onclick="openDiagnosticDetails('${escapeHtml(latestRun && latestRun.profileId || '')}', '${escapeHtml(artifacts.runId)}')">${escapeHtml(uiText('详情', 'Details'))}</button>`
            : '',
        available.includes('screenshot') && artifacts.screenshotUrl
            ? `<button type="button" class="diag-mini-btn" data-url="${escapeHtml(artifacts.screenshotUrl)}" onclick="openDiagnosticArtifactFromButton(this)">Screenshot</button>`
            : '',
        available.includes('html') && artifacts.htmlUrl
            ? `<button type="button" class="diag-mini-btn" data-url="${escapeHtml(artifacts.htmlUrl)}" onclick="openDiagnosticArtifactFromButton(this)">HTML</button>`
            : '',
        available.includes('text') && artifacts.textUrl
            ? `<button type="button" class="diag-mini-btn" data-url="${escapeHtml(artifacts.textUrl)}" onclick="openDiagnosticArtifactFromButton(this)">Text</button>`
            : '',
        available.includes('json') && artifacts.jsonUrl
            ? `<button type="button" class="diag-mini-btn" data-url="${escapeHtml(artifacts.jsonUrl)}" onclick="openDiagnosticArtifactFromButton(this)">JSON</button>`
            : '',
    ].filter(Boolean);
    return buttons.length > 0 ? `<div class="diag-artifact-row">${buttons.join('')}</div>` : '';
}

function buildLatestRunComparisonMarkup(latestRun) {
    const comparison = latestRun && latestRun.comparison ? latestRun.comparison : null;
    if (!comparison || !comparison.summary) return '';
    return `
        <div class="diag-compare-box" data-changed="${comparison.changed ? 'true' : 'false'}">
            <div class="diag-compare-text">${escapeHtml(uiText('相比上次同站点检测：', 'Vs previous same preset: '))}${escapeHtml(comparison.summary)}</div>
            ${Array.isArray(comparison.changes) && comparison.changes.length > 0 ? `<div class="diag-compare-list">${comparison.changes.slice(0, 2).map((item) => `<span class="diag-compare-chip">${escapeHtml(item.label)}: ${escapeHtml(item.before || '∅')} → ${escapeHtml(item.after || '∅')}</span>`).join('')}</div>` : ''}
        </div>
    `;
}

function buildDiagnosticQuickPresetMarkup(profileId, diagnostics, loading) {
    if (loading) return '';
    const presets = (diagnostics && Array.isArray(diagnostics.presets) ? diagnostics.presets : [])
        .filter((item) => item && item.enabled !== false)
        .slice(0, 4);
    if (presets.length === 0) return '';
    const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
    const latestByPreset = new Map();
    for (const item of recentRuns) {
        const presetId = String(item && item.presetId || '').trim();
        if (!presetId || latestByPreset.has(presetId)) continue;
        latestByPreset.set(presetId, item);
    }
    return `
        <div class="diag-preset-section">
            <div class="diag-preset-title">${escapeHtml(uiText('快捷检测', 'Quick checks'))}</div>
            <div class="diag-preset-row">
                ${presets.map((preset) => {
                    const recent = latestByPreset.get(String(preset.id || '').trim());
                    const status = normalizeDiagnosticStatus(recent && recent.result && recent.result.status, 'info');
                    const isActive = recentRuns[0] && String(recentRuns[0].presetId || '').trim() === String(preset.id || '').trim();
                    return `<button type="button" class="diag-preset-btn" data-status="${escapeHtml(status)}" data-active="${isActive ? 'true' : 'false'}" onclick="runSingleProfileDiagnostic('${escapeHtml(profileId)}', '${escapeHtml(preset.id)}', this)">${escapeHtml(preset.name || preset.id || 'Preset')}</button>`;
                }).join('')}
            </div>
        </div>
    `;
}

function buildLatestRunDetailsMarkup(profileId, latestRun, loading) {
    if (loading) {
        return `<div class="diag-latest-empty">${escapeHtml(uiText('最近一次结果载入中...', 'Loading latest result...'))}</div>`;
    }
    if (!latestRun) {
        return `<div class="diag-latest-empty">${escapeHtml(uiText('暂无最近一次检测结果', 'No recent diagnostic result'))}</div>`;
    }
    const result = latestRun.result || {};
    const status = normalizeDiagnosticStatus(result.status, 'info');
    const title = result.headline || latestRun.name || latestRun.presetId || uiText('最近一次检测', 'Latest diagnostic');
    const notes = dedupeDiagnosticTexts([
        result.summary || '',
        ...(Array.isArray(result.signals) ? result.signals : []),
        result.finalUrl || latestRun.url || '',
    ], 4);
    return `
        <div class="diag-latest-box" data-status="${escapeHtml(status)}">
            <div class="diag-latest-head">
                <div class="diag-latest-title">${escapeHtml(title)}</div>
                <div class="diag-latest-time">${escapeHtml(formatDiagTime(latestRun.openedAt))}</div>
            </div>
            <div class="diag-latest-meta">${escapeHtml((latestRun.name || latestRun.presetId || '-') + ' · ' + status.toUpperCase())}</div>
            ${notes.length > 0 ? `<div class="diag-latest-text">${escapeHtml(notes[0])}</div>` : ''}
            ${buildLatestRunFactsMarkup(result)}
            ${buildLatestRunComparisonMarkup(latestRun)}
            ${notes.length > 1 ? `<div class="diag-signal-list">${notes.slice(1).map((item) => `<span class="diag-signal-chip">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
            ${buildLatestRunArtifactMarkup(latestRun)}
        </div>
    `;
}

function buildProfileDiagnosticsMarkup(profileId, diagnostics, options = {}) {
    const loading = !!options.loading;
    const error = String(options.error || '').trim();
    const selfCheck = diagnostics && diagnostics.selfCheckSummary ? diagnostics.selfCheckSummary : null;
    const selfStatus = normalizeDiagnosticStatus(selfCheck && selfCheck.status, error ? 'warn' : 'info');
    const selfDetail = getSelfCheckDetail(selfCheck);
    const latestRun = getLatestExternalDiagnosticRun(diagnostics);
    const externalStatus = normalizeDiagnosticStatus(latestRun && latestRun.result && latestRun.result.status, latestRun ? 'info' : 'info');
    const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
    const localText = error
        ? error
        : (selfStatus === 'warn'
            ? `${selfDetail && selfDetail.label ? selfDetail.label : uiText('自检', 'Self-check')}: ${selfDetail && selfDetail.message ? selfDetail.message : uiText('存在不一致', 'Mismatch found')}`
            : uiText('本地自检通过', 'Local self-check passed'));
    const externalText = latestRun
        ? `${latestRun.name || latestRun.presetId || uiText('外部检测', 'External')}: ${latestRun.result && (latestRun.result.headline || latestRun.result.summary) || uiText('已记录', 'Captured')}`
        : uiText('尚未运行外部检测', 'No external diagnostics yet');
    const countText = `${recentRuns.length} ${uiText('条记录', 'runs')}`;
    return `
        <div class="diag-status-row">
            <span class="diag-pill" data-status="${escapeHtml(selfStatus)}">${escapeHtml(uiText('本地', 'Local'))} ${escapeHtml(selfStatus.toUpperCase())}</span>
            <span class="diag-pill" data-status="${escapeHtml(externalStatus)}">${escapeHtml(uiText('外部', 'External'))} ${escapeHtml((latestRun ? externalStatus : 'info').toUpperCase())}</span>
            <span class="diag-count">${escapeHtml(countText)}</span>
        </div>
        <div class="diag-summary-text">${escapeHtml(loading ? uiText('正在刷新检测状态...', 'Refreshing diagnostics...') : `${localText} · ${externalText}`)}</div>
        ${buildDiagnosticQuickPresetMarkup(profileId, diagnostics, loading)}
        ${buildLatestRunDetailsMarkup(profileId, latestRun, loading)}
        <div class="diag-actions-row">
            <button type="button" class="diag-action" onclick="openProfileDashboard('${escapeHtml(profileId)}', this)">${escapeHtml(uiText('Dashboard', 'Dashboard'))}</button>
            <button type="button" class="diag-action" onclick="runAllProfileDiagnostics('${escapeHtml(profileId)}', this)">${escapeHtml(uiText('运行检测', 'Run all'))}</button>
            <button type="button" class="diag-action danger" onclick="clearProfileDiagnostics('${escapeHtml(profileId)}', this)">${escapeHtml(uiText('清空记录', 'Clear'))}</button>
        </div>
    `;
}

function renderProfileDiagnosticsCard(profileId, diagnostics, options = {}) {
    const el = document.getElementById(`profile-diagnostics-${profileId}`);
    if (!el) return;
    el.innerHTML = buildProfileDiagnosticsMarkup(profileId, diagnostics, options);
}

function getVisibleProfileCard(profileId) {
    return visibleProfileCardCache.get(String(profileId || '').trim()) || null;
}

function getProfileProxyListState(profile, result) {
    const current = result && typeof result === 'object' ? result : null;
    const binding = getProfileResolvedProxyBinding(profile, globalSettings);
    const currentProxy = normalizeProxyTestInput(binding.proxyStr);
    const proxySnapshot = normalizeProxyTestInput(current && current.proxySnapshot || '');
    const checkedAt = Number(current && current.checkedAt) || 0;
    const latencyMs = current && Number.isFinite(Number(current.latencyMs)) ? Number(current.latencyMs) : null;
    if (!currentProxy) {
        return { key: 'direct', checkedAt, latencyMs, current };
    }
    if (proxySnapshot && proxySnapshot !== currentProxy) {
        return { key: 'stale', checkedAt, latencyMs, current };
    }
    if (!current || (!checkedAt && !String(current.summary || current.error || '').trim())) {
        return { key: 'untested', checkedAt: 0, latencyMs: null, current };
    }
    return {
        key: normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn'),
        checkedAt,
        latencyMs,
        current
    };
}

function compareProfilesForList(a, b) {
    return String(a && a.name || '').localeCompare(String(b && b.name || ''), undefined, { sensitivity: 'base', numeric: true });
}

async function warmProfileProxyTestCache(profileIds) {
    const ids = Array.from(new Set((Array.isArray(profileIds) ? profileIds : []).map((item) => String(item || '').trim()).filter(Boolean)))
        .filter((id) => !profileProxyTestCache.has(id) || profileProxyTestCache.get(id) === null);
    if (ids.length === 0) return;
    await Promise.all(ids.map(async (profileId) => {
        try {
            const result = await window.electronAPI.invoke('get-profile-proxy-test', profileId);
            profileProxyTestCache.set(profileId, result && typeof result === 'object' ? result : null);
        } catch (e) {
            if (!profileProxyTestCache.has(profileId)) profileProxyTestCache.set(profileId, null);
        }
    }));
}

function getSelectedVisibleProfileIds() {
    return visibleListProfileIds.filter((id) => selectedListProfileIds.has(id));
}

function setProfileCardSelectedState(profileId, selected) {
    const id = String(profileId || '').trim();
    if (!id) return;
    const card = document.getElementById(`profile-card-${id}`);
    if (card) card.classList.toggle('selected-profile', !!selected);
    const checkbox = document.getElementById(`profile-select-${id}`);
    if (checkbox) checkbox.checked = !!selected;
}

function updateProfileSelectionBar() {
    const selectedCount = getSelectedVisibleProfileIds().length;
    const visibleCount = visibleListProfileIds.length;
    const batchBtn = document.getElementById('btnBatchProxyTest');
    const bindBtn = document.getElementById('btnBatchBindSavedProxy');
    if (batchBtn) batchBtn.disabled = selectedCount === 0;
    if (bindBtn) bindBtn.disabled = selectedCount === 0;

    const toggleBtn = document.getElementById('btnToggleSelection');
    const selectionIcon = document.getElementById('selectionIcon');
    if (toggleBtn) {
        const titleKey = visibleCount === 0
            ? 'toggleSelectionUnavailable'
            : (selectedCount > 0 ? 'clearSelectedProfiles' : 'selectVisibleProfiles');
        const state = visibleCount === 0
            ? 'disabled'
            : (selectedCount >= visibleCount ? 'all' : (selectedCount > 0 ? 'partial' : 'none'));
        const pressed = visibleCount === 0
            ? 'false'
            : (selectedCount >= visibleCount ? 'true' : (selectedCount > 0 ? 'mixed' : 'false'));
        toggleBtn.dataset.i18nTitle = titleKey;
        toggleBtn.dataset.state = state;
        toggleBtn.setAttribute('title', t(titleKey));
        toggleBtn.setAttribute('aria-label', t(titleKey));
        toggleBtn.setAttribute('aria-pressed', pressed);
    }
    if (selectionIcon) {
        if (visibleCount === 0 || selectedCount === 0) {
            selectionIcon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />';
        } else if (selectedCount >= visibleCount) {
            selectionIcon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="M7 12l3 3l7-7" />';
        } else {
            selectionIcon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="M7 12h10" />';
        }
    }
}

function toggleProfileCardSelection(profileId, checked) {
    const id = String(profileId || '').trim();
    if (!id) return;
    if (checked) selectedListProfileIds.add(id);
    else selectedListProfileIds.delete(id);
    setProfileCardSelectedState(id, checked);
    updateProfileSelectionBar();
}

function selectAllVisibleProfiles() {
    visibleListProfileIds.forEach((id) => {
        selectedListProfileIds.add(id);
        setProfileCardSelectedState(id, true);
    });
    updateProfileSelectionBar();
}

function clearVisibleProfileSelection() {
    selectedListProfileIds.clear();
    visibleListProfileIds.forEach((id) => {
        setProfileCardSelectedState(id, false);
    });
    updateProfileSelectionBar();
}

function toggleVisibleProfileSelection() {
    if (visibleListProfileIds.length === 0) return;
    if (getSelectedVisibleProfileIds().length > 0) clearVisibleProfileSelection();
    else selectAllVisibleProfiles();
}

function buildProfileProxyPrimarySummary(result) {
    const current = result && typeof result === 'object' ? result : {};
    const geo = [current.city, current.region, current.country].filter(Boolean).join(', ');
    return [current.ip, geo, current.latencyMs != null ? `${current.latencyMs} ms` : ''].filter(Boolean).join(' · ');
}

function buildProfileProxyStatusMarkup(profileId, result, options = {}) {
    const loading = !!options.loading;
    const error = String(options.error || '').trim();
    const profile = options.profile || getVisibleProfileCard(profileId) || {};
    const binding = getProfileResolvedProxyBinding(profile, globalSettings);
    const current = result && typeof result === 'object' ? result : null;
    const currentProxy = normalizeProxyTestInput(binding.proxyStr);
    const hasProxy = !!currentProxy;
    const proxySnapshot = normalizeProxyTestInput(current && current.proxySnapshot || '');
    const stale = hasProxy && proxySnapshot && proxySnapshot !== currentProxy;
    const checkedAt = formatProxyTestCheckedAt(current && current.checkedAt);
    const primarySummary = buildProfileProxyPrimarySummary(current);
    let status = 'info';
    let summary = '';
    let detail = '';
    let modeLabel = '';

    if (error) {
        status = 'warn';
        summary = error;
    } else if (loading && !current) {
        summary = uiText('正在载入代理状态...', 'Loading proxy status...');
    } else if (!hasProxy) {
        summary = primarySummary || t('proxyTestNoProxy');
        detail = uiText('当前环境未配置代理，将以直连方式运行。', 'No proxy configured. This profile runs direct.');
        modeLabel = formatProxyTestMode(current && current.mode ? current.mode : 'direct');
    } else if (stale) {
        summary = uiText('代理已变更，请重新测试。', 'Proxy changed after the last test. Retest recommended.');
        detail = current && current.summary ? current.summary : '';
        modeLabel = formatProxyTestMode(current && current.mode ? current.mode : 'info');
    } else if (!current || (!current.checkedAt && !String(current.summary || current.error || '').trim())) {
        summary = t('proxyTestIdle');
    } else {
        status = normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn');
        summary = primarySummary || current.summary || current.error || (current.success
            ? uiText('代理可用', 'Proxy reachable')
            : uiText('代理测试失败', 'Proxy test failed'));
        if (!current.success && current.error && current.error !== summary) {
            detail = current.error;
        } else if (current.summary && current.summary !== summary) {
            detail = current.summary;
        }
        if (current.mode && current.mode !== 'unknown') {
            modeLabel = formatProxyTestMode(current.mode);
        }
    }

    const chips = [
        binding.source === 'saved'
            ? `${uiText('已绑定', 'Saved')}: ${getSavedProfileProxyDisplayName({
                id: binding.savedProxyId,
                name: binding.savedProxyName,
                group: binding.savedProxyGroup,
            }) || binding.savedProxyId || '-'}`
            : (binding.bindingBroken ? uiText('已绑定: 已丢失', 'Saved: missing') : ''),
        checkedAt ? `${uiText('时间', 'Checked')}: ${checkedAt}` : '',
        current && current.timezone ? `${uiText('时区', 'Timezone')}: ${current.timezone}` : '',
        current && current.proxyType ? `${uiText('类型', 'Type')}: ${current.proxyType}` : '',
        current && (current.asn || current.org) ? [current.asn, current.org].filter(Boolean).join(' ') : '',
    ].filter(Boolean).slice(0, 3);
    const btnLabel = current && current.checkedAt ? uiText('重测', 'Retest') : t('proxyTestBtn');

    return `
        <div class="proxy-summary-head">
            <div class="diag-status-row">
                <span class="diag-pill" data-status="${escapeHtml(status)}">${escapeHtml(uiText('代理', 'Proxy'))} ${escapeHtml(status.toUpperCase())}</span>
                ${modeLabel ? `<span class="diag-count">${escapeHtml(modeLabel)}</span>` : ''}
            </div>
            <button type="button" class="diag-action" onclick="runProfileProxyTest('${escapeHtml(profileId)}', this)">${escapeHtml(btnLabel)}</button>
        </div>
        <div class="diag-summary-text">${escapeHtml(summary)}</div>
        ${detail ? `<div class="proxy-summary-meta">${escapeHtml(detail)}</div>` : ''}
        ${chips.length > 0 ? `<div class="diag-signal-list">${chips.map((item) => `<span class="diag-signal-chip">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    `;
}

function renderProfileProxyStatusCard(profileId, result, options = {}) {
    const el = document.getElementById(`profile-proxy-status-${profileId}`);
    if (!el) return;
    el.innerHTML = buildProfileProxyStatusMarkup(profileId, result, options);
}

function normalizeSavedProfileProxyEditorStatusFilter(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['all', 'enabled', 'disabled', 'used', 'unused', 'ok', 'warn', 'candidate', 'untested', 'stale', 'quarantined'].includes(current) ? current : 'all';
}

function normalizeSavedProfileProxyEditorSortMode(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['name-asc', 'group-asc', 'usage-desc', 'checked-desc', 'latency-asc', 'status-desc'].includes(current) ? current : 'name-asc';
}

function getSavedProfileProxyEditorGroupList() {
    const groups = [];
    for (const proxy of Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : []) {
        const current = String(proxy && proxy.group || '').trim();
        if (!current || groups.includes(current)) continue;
        groups.push(current);
    }
    return groups.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getSavedProfileProxyListState(proxy, result) {
    const current = result && typeof result === 'object' ? result : null;
    const currentProxy = normalizeProxyTestInput(proxy && proxy.proxyStr || '');
    const proxySnapshot = normalizeProxyTestInput(current && current.proxySnapshot || '');
    const checkedAt = Number(current && current.checkedAt) || 0;
    const latencyMs = current && Number.isFinite(Number(current.latencyMs)) ? Number(current.latencyMs) : null;
    const sourceState = getSavedProfileProxySourceState(proxy);
    if (sourceState.status === 'stale') {
        return { key: 'stale', checkedAt, latencyMs, current, sourceState };
    }
    if (currentProxy && proxySnapshot && proxySnapshot !== currentProxy) {
        return { key: 'stale', checkedAt, latencyMs, current, sourceState };
    }
    if (!current || (!checkedAt && !String(current.summary || current.error || '').trim())) {
        return { key: 'untested', checkedAt: 0, latencyMs: null, current, sourceState };
    }
    return {
        key: normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn'),
        checkedAt,
        latencyMs,
        current,
        sourceState,
    };
}

function getSavedProfileProxyHealthKey(proxy, result) {
    const state = getSavedProfileProxyListState(proxy, result);
    if (state.key === 'stale' || state.key === 'untested') return state.key;
    if (isSavedProfileProxyQuarantined(proxy, result)) return 'quarantined';
    if (isSavedProfileProxyQuarantineCandidate(proxy, result)) return 'candidate';
    return state.key;
}

function matchesSavedProfileProxyEditorFilters(proxy, result) {
    const filters = savedProfileProxyEditorFilters || {};
    const text = String(filters.search || '').trim().toLowerCase();
    if (text) {
        const haystack = [
            proxy && proxy.id,
            proxy && proxy.name,
            proxy && proxy.proxyStr,
            proxy && proxy.group,
            proxy && proxy.notes,
            proxy && proxy.changeIpUrl,
            proxy && proxy.sourceId,
            proxy && proxy.sourceName,
            ...(Array.isArray(proxy && proxy.tags) ? proxy.tags : []),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(text)) return false;
    }
    const group = String(filters.group || '').trim().toLowerCase();
    if (group && String(proxy && proxy.group || '').trim().toLowerCase() !== group) return false;

    const statusFilter = normalizeSavedProfileProxyEditorStatusFilter(filters.status);
    if (statusFilter === 'enabled') return proxy && proxy.enabled !== false;
    if (statusFilter === 'disabled') return proxy && proxy.enabled === false;
    if (statusFilter === 'used') return getSavedProfileProxyUsageCount(proxy && proxy.id) > 0;
    if (statusFilter === 'unused') return getSavedProfileProxyUsageCount(proxy && proxy.id) === 0;
    if (statusFilter === 'candidate' || statusFilter === 'quarantined') {
        return getSavedProfileProxyHealthKey(proxy, result) === statusFilter;
    }
    if (statusFilter !== 'all') return getSavedProfileProxyListState(proxy, result).key === statusFilter;
    return true;
}

function getSavedProfileProxyStatusRank(proxy, result) {
    const key = getSavedProfileProxyHealthKey(proxy, result);
    if (key === 'quarantined') return 6;
    if (key === 'candidate') return 5;
    if (key === 'warn') return 4;
    if (key === 'stale') return 3;
    if (key === 'untested') return 2;
    if (key === 'ok' || key === 'info') return 1;
    return 0;
}

function compareSavedProfileProxiesForEditor(a, b) {
    const mode = normalizeSavedProfileProxyEditorSortMode(savedProfileProxyEditorFilters && savedProfileProxyEditorFilters.sort);
    const stateA = getSavedProfileProxyListState(a, savedProfileProxyTestCache.get(normalizeSavedProxyId(a && a.id)));
    const stateB = getSavedProfileProxyListState(b, savedProfileProxyTestCache.get(normalizeSavedProxyId(b && b.id)));
    if (mode === 'group-asc') {
        const groupDiff = String(a && a.group || '').localeCompare(String(b && b.group || ''), undefined, { sensitivity: 'base' });
        if (groupDiff !== 0) return groupDiff;
    } else if (mode === 'usage-desc') {
        const usageDiff = getSavedProfileProxyUsageCount(b && b.id) - getSavedProfileProxyUsageCount(a && a.id);
        if (usageDiff !== 0) return usageDiff;
    } else if (mode === 'checked-desc') {
        const diff = (stateB.checkedAt || 0) - (stateA.checkedAt || 0);
        if (diff !== 0) return diff;
    } else if (mode === 'latency-asc') {
        const latencyA = stateA.latencyMs == null ? Number.POSITIVE_INFINITY : stateA.latencyMs;
        const latencyB = stateB.latencyMs == null ? Number.POSITIVE_INFINITY : stateB.latencyMs;
        if (latencyA !== latencyB) return latencyA - latencyB;
    } else if (mode === 'status-desc') {
        const rankDiff = getSavedProfileProxyStatusRank(b, savedProfileProxyTestCache.get(normalizeSavedProxyId(b && b.id)))
            - getSavedProfileProxyStatusRank(a, savedProfileProxyTestCache.get(normalizeSavedProxyId(a && a.id)));
        if (rankDiff !== 0) return rankDiff;
    }
    return String(a && a.name || a && a.id || '').localeCompare(String(b && b.name || b && b.id || ''), undefined, { sensitivity: 'base' });
}

function getSavedProfileProxySelectionDomToken(savedProxyId) {
    return encodeURIComponent(normalizeSavedProxyId(savedProxyId));
}

function getVisibleSavedProfileProxyEntries() {
    return [...(Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])]
        .filter((proxy) => matchesSavedProfileProxyEditorFilters(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))))
        .sort(compareSavedProfileProxiesForEditor);
}

function getVisibleStaleSavedProfileProxyEntries() {
    return getVisibleSavedProfileProxyEntries().filter((proxy) => {
        const proxyId = normalizeSavedProxyId(proxy && proxy.id);
        return getSavedProfileProxyListState(proxy, savedProfileProxyTestCache.get(proxyId)).key === 'stale';
    });
}

function hasSavedProfileProxyReachedQuarantineThreshold(proxy, result) {
    const current = result && typeof result === 'object' ? result : null;
    if (!proxy || !current) return false;
    const sourceState = getSavedProfileProxySourceState(proxy);
    if (sourceState.status === 'stale' || sourceState.status === 'source-missing') return false;
    const currentProxy = normalizeProxyTestInput(proxy && proxy.proxyStr || '');
    const proxySnapshot = normalizeProxyTestInput(current && current.proxySnapshot || '');
    if (!currentProxy || !Number(current.checkedAt)) return false;
    if (currentProxy && proxySnapshot && proxySnapshot !== currentProxy) return false;
    if (normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn') !== 'warn') return false;
    const failureStreak = Number(current.failureStreak || 0);
    if (failureStreak < SAVED_PROXY_QUARANTINE_FAILURE_STREAK) return false;
    const lastSuccessAt = Number(current.lastSuccessAt || 0);
    const lastFailureAt = Number(current.lastFailureAt || 0);
    return !(lastSuccessAt > 0 && lastFailureAt > 0 && lastFailureAt < lastSuccessAt);
}

function isSavedProfileProxyQuarantineCandidate(proxy, result) {
    return hasSavedProfileProxyReachedQuarantineThreshold(proxy, result) && proxy && proxy.enabled !== false;
}

function isSavedProfileProxyQuarantined(proxy, result) {
    return hasSavedProfileProxyReachedQuarantineThreshold(proxy, result) && proxy && proxy.enabled === false;
}

function getSavedProfileProxyEntriesForSource(sourceId, options = {}) {
    const targetSourceId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetSourceId) return [];
    const staleOnly = options.staleOnly === true;
    return (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
        .filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === targetSourceId)
        .filter((proxy) => {
            if (!staleOnly) return true;
            const proxyId = normalizeSavedProxyId(proxy && proxy.id);
            return getSavedProfileProxyListState(proxy, savedProfileProxyTestCache.get(proxyId)).key === 'stale';
        });
}

function getSavedProfileProxySourceHealthSummary(sourceId) {
    const summary = {
        total: 0,
        ok: 0,
        warn: 0,
        candidate: 0,
        untested: 0,
        stale: 0,
        quarantined: 0,
    };
    for (const proxy of getSavedProfileProxyEntriesForSource(sourceId)) {
        const proxyId = normalizeSavedProxyId(proxy && proxy.id);
        const result = savedProfileProxyTestCache.get(proxyId);
        const state = getSavedProfileProxyHealthKey(proxy, result);
        summary.total++;
        if (state === 'stale') {
            summary.stale++;
            continue;
        }
        if (state === 'untested') {
            summary.untested++;
            continue;
        }
        if (state === 'candidate') {
            summary.candidate++;
            continue;
        }
        if (state === 'quarantined') {
            summary.quarantined++;
            continue;
        }
        if (state === 'ok' || state === 'info') summary.ok++;
        else summary.warn++;
    }
    return summary;
}

function buildSavedProfileProxySourceHealthMarkup(sourceId) {
    const summary = getSavedProfileProxySourceHealthSummary(sourceId);
    if (summary.total === 0) {
        return `<div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceHealthEmpty'))}</div>`;
    }
    const chip = (label, value, color = 'var(--text-primary)') => `
        <span style="padding:4px 8px; border-radius:999px; border:1px solid var(--border); font-size:11px; color:${color};">
            ${escapeHtml(`${label}: ${value}`)}
        </span>
    `;
    return `
        <div style="display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
                ${chip(t('savedProxySourceHealthOk'), summary.ok, 'var(--success)')}
                ${chip(t('savedProxySourceHealthWarn'), summary.warn, summary.warn > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${chip(t('savedProxySourceHealthCandidate'), summary.candidate, summary.candidate > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${chip(t('savedProxySourceHealthQuarantined'), summary.quarantined, summary.quarantined > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${chip(t('savedProxySourceHealthUntested'), summary.untested)}
                ${chip(t('savedProxySourceHealthStale'), summary.stale, summary.stale > 0 ? 'var(--warning)' : 'var(--text-primary)')}
            </div>
            <div style="font-size:11px; opacity:0.72;">
                ${escapeHtml(t('savedProxySourceHealthThresholdHint').replace('{count}', String(SAVED_PROXY_QUARANTINE_FAILURE_STREAK)))}
            </div>
        </div>
    `;
}

function applySavedProfileProxySourceStalePolicyDraft(sourceId, policy) {
    const nextPolicy = normalizeSavedProfileProxySourceStalePolicy(policy);
    if (nextPolicy === 'mark') return { policyMode: nextPolicy, policyAffectedCount: 0 };
    let policyAffectedCount = 0;
    for (const proxy of getSavedProfileProxyEntriesForSource(sourceId, { staleOnly: true })) {
        if (nextPolicy === 'disable') {
            if (proxy.enabled !== false) {
                proxy.enabled = false;
                policyAffectedCount++;
            }
            continue;
        }
        proxy.sourceId = '';
        proxy.sourceName = '';
        proxy.sourceImportedAt = 0;
        proxy.sourceStale = false;
        proxy.sourceMissingSince = 0;
        policyAffectedCount++;
    }
    return { policyMode: nextPolicy, policyAffectedCount };
}

function pruneSelectedSavedProfileProxyIds() {
    const currentIds = new Set(
        (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
            .filter(Boolean)
    );
    Array.from(selectedSavedProfileProxyIds).forEach((id) => {
        if (!currentIds.has(id)) selectedSavedProfileProxyIds.delete(id);
    });
}

function getSelectedSavedProfileProxyEntries() {
    pruneSelectedSavedProfileProxyIds();
    return (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
        .filter((proxy) => selectedSavedProfileProxyIds.has(normalizeSavedProxyId(proxy && proxy.id)));
}

function setSavedProfileProxySelectedState(savedProxyId, selected) {
    const id = normalizeSavedProxyId(savedProxyId);
    if (!id) return;
    const domToken = getSavedProfileProxySelectionDomToken(id);
    const card = document.getElementById(`saved-proxy-card-${domToken}`);
    if (card) {
        card.style.borderColor = selected ? 'rgba(0, 224, 255, 0.55)' : 'var(--border)';
        card.style.boxShadow = selected ? '0 0 0 1px rgba(0, 224, 255, 0.14) inset' : 'none';
    }
    const checkbox = document.getElementById(`saved-proxy-select-${domToken}`);
    if (checkbox) checkbox.checked = !!selected;
}

function updateSavedProfileProxySelectionBar() {
    pruneSelectedSavedProfileProxyIds();
    const visibleIds = getVisibleSavedProfileProxyEntries()
        .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
        .filter(Boolean);
    const staleVisibleIds = getVisibleStaleSavedProfileProxyEntries()
        .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
        .filter(Boolean);
    const selectedCount = selectedSavedProfileProxyIds.size;
    const visibleSelectedCount = visibleIds.filter((id) => selectedSavedProfileProxyIds.has(id)).length;
    const staleVisibleSelectedCount = staleVisibleIds.filter((id) => selectedSavedProfileProxyIds.has(id)).length;
    const selectedEntries = getSelectedSavedProfileProxyEntries();
    const selectedWithSourceCount = selectedEntries.filter((proxy) => getSavedProfileProxySourceState(proxy).id).length;
    const summary = document.getElementById('savedProfileProxySelectionSummary');
    const toolbar = document.getElementById('savedProfileProxySelectionToolbar');
    if (summary) {
        summary.textContent = selectedCount > 0
            ? uiText(
                `已选 ${selectedCount} · 当前筛选命中 ${visibleSelectedCount}/${visibleIds.length}`,
                `${selectedCount} selected · ${visibleSelectedCount}/${visibleIds.length} visible`
            )
            : uiText(
                `未选择代理 · 当前筛选命中 ${visibleIds.length}`,
                `No proxy selected · ${visibleIds.length} visible`
            );
    }
    if (toolbar) toolbar.style.display = selectedCount > 0 ? 'flex' : 'none';
    const selectBtn = document.getElementById('btnSelectVisibleSavedProfileProxies');
    const selectStaleBtn = document.getElementById('btnSelectStaleSavedProfileProxies');
    const clearBtn = document.getElementById('btnClearSelectedSavedProfileProxies');
    const exportBtn = document.getElementById('btnExportSelectedSavedProfileProxies');
    const retestBtn = document.getElementById('btnRetestSelectedSavedProfileProxies');
    const rotateBtn = document.getElementById('btnRotateSelectedSavedProfileProxies');
    const deleteBtn = document.getElementById('btnDeleteSelectedSavedProfileProxies');
    const setGroupBtn = document.getElementById('btnBatchSetSavedProxyGroup');
    const enableBtn = document.getElementById('btnEnableSelectedSavedProfileProxies');
    const disableBtn = document.getElementById('btnDisableSelectedSavedProfileProxies');
    const disableVisibleStaleBtn = document.getElementById('btnDisableVisibleStaleSavedProfileProxies');
    const detachSourceBtn = document.getElementById('btnDetachSourceSelectedSavedProfileProxies');
    const setTagsBtn = document.getElementById('btnSetTagsSelectedSavedProfileProxies');
    const addTagsBtn = document.getElementById('btnAddTagsSelectedSavedProfileProxies');
    const removeTagsBtn = document.getElementById('btnRemoveTagsSelectedSavedProfileProxies');
    if (selectBtn) selectBtn.disabled = visibleIds.length === 0 || visibleSelectedCount === visibleIds.length;
    if (selectStaleBtn) selectStaleBtn.disabled = staleVisibleIds.length === 0 || staleVisibleSelectedCount === staleVisibleIds.length;
    if (clearBtn) clearBtn.disabled = selectedCount === 0;
    if (exportBtn) exportBtn.disabled = selectedCount === 0;
    if (retestBtn) retestBtn.disabled = selectedCount === 0;
    if (rotateBtn) rotateBtn.disabled = selectedCount === 0;
    if (deleteBtn) deleteBtn.disabled = selectedCount === 0;
    if (setGroupBtn) setGroupBtn.disabled = selectedCount === 0;
    if (enableBtn) enableBtn.disabled = selectedCount === 0;
    if (disableBtn) disableBtn.disabled = selectedCount === 0;
    if (disableVisibleStaleBtn) disableVisibleStaleBtn.disabled = staleVisibleIds.length === 0;
    if (detachSourceBtn) detachSourceBtn.disabled = selectedWithSourceCount === 0;
    if (setTagsBtn) setTagsBtn.disabled = selectedCount === 0;
    if (addTagsBtn) addTagsBtn.disabled = selectedCount === 0;
    if (removeTagsBtn) removeTagsBtn.disabled = selectedCount === 0;
}

function toggleSavedProfileProxySelection(savedProxyId, checked) {
    const id = normalizeSavedProxyId(savedProxyId);
    if (!id) return;
    if (checked) selectedSavedProfileProxyIds.add(id);
    else selectedSavedProfileProxyIds.delete(id);
    setSavedProfileProxySelectedState(id, checked);
    updateSavedProfileProxySelectionBar();
}

function selectAllVisibleSavedProfileProxies() {
    getVisibleSavedProfileProxyEntries().forEach((proxy) => {
        const id = normalizeSavedProxyId(proxy && proxy.id);
        if (!id) return;
        selectedSavedProfileProxyIds.add(id);
        setSavedProfileProxySelectedState(id, true);
    });
    updateSavedProfileProxySelectionBar();
}

function selectVisibleStaleSavedProfileProxies() {
    getVisibleStaleSavedProfileProxyEntries().forEach((proxy) => {
        const id = normalizeSavedProxyId(proxy && proxy.id);
        if (!id) return;
        selectedSavedProfileProxyIds.add(id);
        setSavedProfileProxySelectedState(id, true);
    });
    updateSavedProfileProxySelectionBar();
}

function selectSavedProfileProxiesForSource(sourceId, options = {}) {
    const staleOnly = options.staleOnly === true;
    const sourceEntries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly });
    if (sourceEntries.length === 0) {
        showAlert(staleOnly
            ? uiText('这个来源下没有失效代理。', 'No stale proxies are linked to this source.')
            : uiText('这个来源下还没有关联代理。', 'No proxies are linked to this source.'));
        return;
    }
    sourceEntries.forEach((proxy) => {
        const id = normalizeSavedProxyId(proxy && proxy.id);
        if (!id) return;
        selectedSavedProfileProxyIds.add(id);
        setSavedProfileProxySelectedState(id, true);
    });
    updateSavedProfileProxySelectionBar();
}

function clearSelectedSavedProfileProxies() {
    Array.from(selectedSavedProfileProxyIds).forEach((id) => setSavedProfileProxySelectedState(id, false));
    selectedSavedProfileProxyIds.clear();
    updateSavedProfileProxySelectionBar();
}

async function refreshSavedProfileProxyTestCache(savedProxyIds) {
    const ids = Array.from(new Set((Array.isArray(savedProxyIds) ? savedProxyIds : []).map((item) => normalizeSavedProxyId(item)).filter(Boolean)));
    if (ids.length === 0) return;
    const token = ++savedProfileProxyTestLoadToken;
    await Promise.all(ids.map(async (savedProxyId) => {
        try {
            const result = await window.electronAPI.invoke('get-saved-profile-proxy-test', savedProxyId);
            if (token !== savedProfileProxyTestLoadToken) return;
            savedProfileProxyTestCache.set(savedProxyId, result && typeof result === 'object'
                ? normalizeSavedProfileProxyTestResultEntry(result)
                : null);
        } catch (e) {
            if (token !== savedProfileProxyTestLoadToken) return;
            if (!savedProfileProxyTestCache.has(savedProxyId)) savedProfileProxyTestCache.set(savedProxyId, null);
        }
    }));
}

function buildSavedProfileProxyStatusMarkup(proxy, result, options = {}) {
    const current = result && typeof result === 'object' ? result : null;
    const loading = !!options.loading;
    const error = String(options.error || '').trim();
    const currentProxy = normalizeProxyTestInput(proxy && proxy.proxyStr || '');
    const proxySnapshot = normalizeProxyTestInput(current && current.proxySnapshot || '');
    const stale = currentProxy && proxySnapshot && proxySnapshot !== currentProxy;
    const sourceState = getSavedProfileProxySourceState(proxy);
    const sourceStale = sourceState.status === 'stale';
    const quarantineCandidate = isSavedProfileProxyQuarantineCandidate(proxy, current);
    const quarantined = isSavedProfileProxyQuarantined(proxy, current);
    const checkedAt = formatProxyTestCheckedAt(current && current.checkedAt);
    const primarySummary = buildProfileProxyPrimarySummary(current);
    let status = 'info';
    let summary = '';
    let detail = '';

    if (error) {
        status = 'warn';
        summary = error;
    } else if (loading) {
        summary = uiText('正在载入代理库状态...', 'Loading saved proxy status...');
    } else if (!currentProxy) {
        summary = t('proxyTestNoProxy');
        detail = uiText('当前保存代理为空，保存前请填写代理字符串。', 'This saved proxy is empty. Fill the proxy string before saving.');
    } else if (sourceStale) {
        status = 'warn';
        summary = uiText('来源同步后未在远程列表中找到该代理。', 'This proxy is no longer present in its remote source.');
        detail = sourceState.missingSince > 0
            ? uiText(`首次标记失效：${formatDiagTime(sourceState.missingSince)}`, `Marked stale at: ${formatDiagTime(sourceState.missingSince)}`)
            : '';
    } else if (stale) {
        status = 'warn';
        summary = uiText('代理库条目已变更，请重新测试。', 'Saved proxy changed after the last test. Retest recommended.');
        detail = current && current.summary ? current.summary : '';
    } else if (quarantineCandidate || quarantined) {
        status = 'warn';
        summary = quarantined
            ? t('savedProxyQuarantinedSummary')
            : t('savedProxyQuarantineSuggestedSummary');
        detail = quarantined
            ? uiText(
                `连续失败已达到 ${SAVED_PROXY_QUARANTINE_FAILURE_STREAK} 次阈值，该代理已进入 quarantine，可执行复检恢复。`,
                `Failure streak reached the ${SAVED_PROXY_QUARANTINE_FAILURE_STREAK}-check threshold. This proxy is quarantined; recheck it to recover.`
            )
            : uiText(
                `连续失败已达到 ${SAVED_PROXY_QUARANTINE_FAILURE_STREAK} 次阈值，建议重测或先隔离。`,
                `Failure streak reached the ${SAVED_PROXY_QUARANTINE_FAILURE_STREAK}-check threshold. Retest or quarantine this proxy.`
            );
    } else if (!current || (!current.checkedAt && !String(current.summary || current.error || '').trim())) {
        summary = t('proxyTestIdle');
    } else {
        status = normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn');
        summary = primarySummary || current.summary || current.error || (current.success
            ? uiText('代理可用', 'Proxy reachable')
            : uiText('代理测试失败', 'Proxy test failed'));
        if (!current.success && current.error && current.error !== summary) detail = current.error;
        else if (current.summary && current.summary !== summary) detail = current.summary;
    }

    const chips = [
        `${t('savedProxyUsageCount')}: ${getSavedProfileProxyUsageCount(proxy && proxy.id)} ${t('msgProfiles')}`,
        proxy && proxy.group ? `${t('savedProxyGroupLabel')}: ${proxy.group}` : '',
        sourceState.id ? `${uiText('来源', 'Source')}: ${sourceState.name || sourceState.id}` : '',
        sourceState.status === 'source-missing' ? uiText('来源配置已删除', 'Source config removed') : '',
        sourceState.status === 'stale' && sourceState.missingSince > 0
            ? `${uiText('失效于', 'Stale since')}: ${formatDiagTime(sourceState.missingSince)}`
            : '',
        checkedAt ? `${uiText('时间', 'Checked')}: ${checkedAt}` : '',
        current && current.latencyMs != null ? `${uiText('延迟', 'Latency')}: ${current.latencyMs} ms` : '',
        current && current.timezone ? `${uiText('时区', 'Timezone')}: ${current.timezone}` : '',
        current && current.org ? `ISP: ${current.org}` : '',
        current && current.country ? [current.city, current.region, current.country].filter(Boolean).join(', ') : '',
        quarantined ? `${t('savedProxyFilterStatusQuarantined')}: ${SAVED_PROXY_QUARANTINE_FAILURE_STREAK}+` : '',
        current && Number(current.failureStreak) > 0 ? `${uiText('失败次数', 'Failure streak')}: ${Number(current.failureStreak)}` : '',
        current && Number(current.lastSuccessAt) > 0 ? `${uiText('上次成功', 'Last success')}: ${formatProxyTestCheckedAt(current.lastSuccessAt)}` : '',
        current && Number(current.lastFailureAt) > 0 && normalizeDiagnosticStatus(current.status, current.success ? 'ok' : 'warn') !== 'ok'
            ? `${uiText('上次失败', 'Last failure')}: ${formatProxyTestCheckedAt(current.lastFailureAt)}`
            : '',
    ].filter(Boolean).slice(0, 8);
    const btnLabel = current && current.checkedAt ? uiText('重测', 'Retest') : t('proxyTestBtn');

    return `
        <div class="proxy-summary-head">
            <div class="diag-status-row">
                <span class="diag-pill" data-status="${escapeHtml(status)}">${escapeHtml(uiText('代理', 'Proxy'))} ${escapeHtml(status.toUpperCase())}</span>
                ${quarantined ? `<span class="diag-count">${escapeHtml(t('savedProxyFilterStatusQuarantined'))}</span>` : ''}
                ${proxy && proxy.enabled === false ? `<span class="diag-count">${escapeHtml(uiText('已禁用', 'Disabled'))}</span>` : ''}
            </div>
            <button type="button" class="diag-action" onclick="runSavedProfileProxyTest('${escapeHtml(normalizeSavedProxyId(proxy && proxy.id))}', this)">${escapeHtml(btnLabel)}</button>
        </div>
        <div class="diag-summary-text">${escapeHtml(summary)}</div>
        ${detail ? `<div class="proxy-summary-meta">${escapeHtml(detail)}</div>` : ''}
        ${chips.length > 0 ? `<div class="diag-signal-list">${chips.map((item) => `<span class="diag-signal-chip">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    `;
}

function syncSavedProfileProxyEditorControls() {
    const searchInput = document.getElementById('savedProfileProxySearch');
    const groupSelect = document.getElementById('savedProfileProxyFilterGroup');
    const statusSelect = document.getElementById('savedProfileProxyFilterStatus');
    const sortSelect = document.getElementById('savedProfileProxySortMode');
    const summary = document.getElementById('savedProfileProxyFilterSummary');
    if (searchInput) searchInput.value = savedProfileProxyEditorFilters.search || '';
    if (statusSelect) statusSelect.value = normalizeSavedProfileProxyEditorStatusFilter(savedProfileProxyEditorFilters.status);
    if (sortSelect) sortSelect.value = normalizeSavedProfileProxyEditorSortMode(savedProfileProxyEditorFilters.sort);
    if (groupSelect) {
        const currentValue = String(savedProfileProxyEditorFilters.group || '').trim();
        const groups = getSavedProfileProxyEditorGroupList();
        groupSelect.innerHTML = [`<option value="">${escapeHtml(t('noneOption'))}</option>`]
            .concat(groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`))
            .join('');
        if (currentValue && !groups.includes(currentValue)) savedProfileProxyEditorFilters.group = '';
        groupSelect.value = String(savedProfileProxyEditorFilters.group || '').trim();
    }
    if (summary) {
        const total = Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies.length : 0;
        const visible = getVisibleSavedProfileProxyEntries().length;
        summary.textContent = uiText(`显示 ${visible}/${total}`, `${visible}/${total} shown`);
    }
    updateSavedProfileProxySelectionBar();
}

async function refreshProfileProxyStatusCards(profileIds) {
    const ids = Array.from(new Set((Array.isArray(profileIds) ? profileIds : []).map((item) => String(item || '').trim()).filter(Boolean)));
    if (ids.length === 0) return;
    const token = ++profileProxyTestLoadToken;
    await Promise.all(ids.map(async (profileId) => {
        try {
            const result = await window.electronAPI.invoke('get-profile-proxy-test', profileId);
            if (token !== profileProxyTestLoadToken) return;
            profileProxyTestCache.set(profileId, result && typeof result === 'object' ? result : null);
            renderProfileProxyStatusCard(profileId, result);
        } catch (e) {
            if (token !== profileProxyTestLoadToken) return;
            renderProfileProxyStatusCard(profileId, profileProxyTestCache.get(profileId) || null, { error: e && e.message ? e.message : String(e) });
        }
    }));
}

async function refreshProfileDiagnosticsCards(profileIds) {
    const ids = Array.from(new Set((Array.isArray(profileIds) ? profileIds : []).map((item) => String(item || '').trim()).filter(Boolean)));
    if (ids.length === 0) return;
    const token = ++profileDiagnosticsLoadToken;
    await Promise.all(ids.map(async (profileId) => {
        try {
            const diagnostics = await window.electronAPI.invoke('get-profile-diagnostics', profileId);
            if (token !== profileDiagnosticsLoadToken) return;
            profileDiagnosticsCache.set(profileId, diagnostics);
            renderProfileDiagnosticsCard(profileId, diagnostics);
        } catch (e) {
            if (token !== profileDiagnosticsLoadToken) return;
            renderProfileDiagnosticsCard(profileId, null, { error: e && e.message ? e.message : String(e) });
        }
    }));
}

function setDiagActionBusy(btn, busy, busyLabel) {
    if (!btn) return () => { };
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;
    btn.disabled = !!busy;
    btn.textContent = busy ? busyLabel : original;
    return () => {
        btn.disabled = false;
        btn.textContent = original;
    };
}

async function getLocalApiBase() {
    if (localApiBaseCache) return localApiBaseCache;
    try {
        localApiBaseCache = await window.electronAPI.invoke('get-local-api-base');
    } catch (e) {
        localApiBaseCache = 'http://127.0.0.1:17555';
    }
    return localApiBaseCache;
}

async function postLocalApiJson(path, body = {}) {
    const base = await getLocalApiBase();
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!json || json.success !== true) {
        throw new Error((json && (json.error || json.msg)) || (`HTTP ${res.status}`));
    }
    return json.data;
}

async function openDiagnosticArtifactFromButton(btn) {
    const raw = btn && btn.dataset ? String(btn.dataset.url || '').trim() : '';
    if (!raw) return;
    try {
        const base = await getLocalApiBase();
        const target = /^https?:\/\//i.test(raw) ? raw : `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
        await window.electronAPI.invoke('open-url', target);
    } catch (e) {
        showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
    }
}

function getDiagnosticRunById(diagnostics, runId) {
    const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
    const target = String(runId || '').trim();
    if (!target) return null;
    return recentRuns.find((item) => String(item && item.result && item.result.artifacts && item.result.artifacts.runId || '').trim() === target) || null;
}

async function runProfileProxyTest(profileId, btn) {
    const id = String(profileId || '').trim();
    if (!id) return;
    const restore = setDiagActionBusy(btn, true, t('proxyTestTesting'));
    try {
        const result = await postLocalApiJson(`/profiles/${encodeURIComponent(id)}/proxy-test`);
        profileProxyTestCache.set(id, result && typeof result === 'object' ? result : null);
        renderProfileProxyStatusCard(id, result);
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        renderProfileProxyStatusCard(id, profileProxyTestCache.get(id) || null, { error: message });
        showAlert(`Error: ${message}`);
    } finally {
        restore();
    }
    await loadProfiles();
}

async function runSelectedProfileProxyTests(btn) {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(uiText('请先选择至少一个环境。', 'Select at least one profile first.'));
        return;
    }
    const restore = setDiagActionBusy(btn, true, `${t('proxyTestTesting')} 0/${ids.length}`);
    let ok = 0;
    let warn = 0;
    let info = 0;
    const failedNames = [];
    try {
        for (let index = 0; index < ids.length; index++) {
            const id = ids[index];
            if (btn) btn.textContent = `${t('proxyTestTesting')} ${index + 1}/${ids.length}`;
            const current = profileProxyTestCache.get(id) || null;
            renderProfileProxyStatusCard(id, {
                ...(current || {}),
                status: 'info',
                mode: 'testing',
                summary: t('proxyTestTesting'),
            }, { profile: getVisibleProfileCard(id) });
            try {
                const result = await postLocalApiJson(`/profiles/${encodeURIComponent(id)}/proxy-test`);
                profileProxyTestCache.set(id, result && typeof result === 'object' ? result : null);
                renderProfileProxyStatusCard(id, result);
                const status = normalizeDiagnosticStatus(result && result.status, result && result.success ? 'ok' : 'warn');
                if (status === 'ok') ok++;
                else if (status === 'warn') {
                    warn++;
                    failedNames.push((getVisibleProfileCard(id) && getVisibleProfileCard(id).name) || id);
                } else info++;
            } catch (e) {
                warn++;
                failedNames.push((getVisibleProfileCard(id) && getVisibleProfileCard(id).name) || id);
                renderProfileProxyStatusCard(id, current, { error: e && e.message ? e.message : String(e) });
            }
        }
    } finally {
        restore();
    }
    const failedText = failedNames.length > 0
        ? `${uiText('失败环境', 'Failed profiles')}: ${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? '...' : ''}`
        : '';
    showAlert([
        uiText(`代理测试完成：成功 ${ok}，告警 ${warn}，信息 ${info}`, `Proxy test finished: ${ok} ok, ${warn} warn, ${info} info`),
        failedText
    ].filter(Boolean).join('\n'));
    await loadProfiles();
}

function syncBatchSavedProxyBindInfo() {
    const select = document.getElementById('batchSavedProxyId');
    const info = document.getElementById('batchSavedProxyBindInfo');
    const summary = document.getElementById('batchSavedProxyBindSummary');
    const applyBtn = document.getElementById('batchSavedProxyBindApplyBtn');
    if (!select || !info || !summary) return;
    const selectedCount = getSelectedVisibleProfileIds().length;
    summary.textContent = `${selectedCount} ${t('msgProfiles')}`;
    const savedProxy = findSavedProfileProxyById(globalSettings, select.value);
    if (!savedProxy) {
        info.textContent = t('batchBindSavedProxyNoLibrary');
        if (applyBtn) applyBtn.disabled = true;
        return;
    }
    info.textContent = `${getSavedProfileProxyDisplayName(savedProxy) || savedProxy.id} · ${savedProxy.proxyStr || ''}`;
    if (applyBtn) applyBtn.disabled = selectedCount === 0;
}

function syncBatchReplaceSavedProxyInfo() {
    const fromSelect = document.getElementById('batchReplaceSavedProxyFromId');
    const toSelect = document.getElementById('batchReplaceSavedProxyToId');
    const info = document.getElementById('batchSavedProxyReplaceInfo');
    const summary = document.getElementById('batchSavedProxyReplaceSummary');
    const applyBtn = document.getElementById('batchSavedProxyReplaceApplyBtn');
    if (!fromSelect || !toSelect || !info || !summary) return;
    const selectedCount = getSelectedVisibleProfileIds().length;
    summary.textContent = `${selectedCount} ${t('msgProfiles')}`;
    const fromSavedProxy = findSavedProfileProxyById(globalSettings, fromSelect.value);
    const toSavedProxy = findSavedProfileProxyById(globalSettings, toSelect.value);
    if (!fromSavedProxy || !toSavedProxy) {
        info.textContent = t('batchBindSavedProxyNoLibrary');
        if (applyBtn) applyBtn.disabled = true;
        return;
    }
    info.textContent = `${getSavedProfileProxyDisplayName(fromSavedProxy) || fromSavedProxy.id} → ${getSavedProfileProxyDisplayName(toSavedProxy) || toSavedProxy.id}`;
    if (applyBtn) applyBtn.disabled = selectedCount === 0 || fromSavedProxy.id === toSavedProxy.id;
}

function getSavedProfileProxyTagList(settings = globalSettings) {
    const tags = [];
    for (const proxy of getSavedProfileProxyLibrary(settings, { includeDisabled: false })) {
        for (const tag of Array.isArray(proxy.tags) ? proxy.tags : []) {
            const current = String(tag || '').trim();
            if (!current || tags.includes(current)) continue;
            tags.push(current);
        }
    }
    return tags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getSavedProfileProxyGroupList(settings = globalSettings) {
    const groups = [];
    for (const proxy of getSavedProfileProxyLibrary(settings, { includeDisabled: false })) {
        const current = String(proxy.group || '').trim();
        if (!current || groups.includes(current)) continue;
        groups.push(current);
    }
    return groups.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function filterSavedProfileProxiesForBatch(settings = globalSettings, filters = {}) {
    const tag = String(filters.tag || '').trim().toLowerCase();
    const group = String(filters.group || '').trim().toLowerCase();
    return getSavedProfileProxyLibrary(settings, { includeDisabled: false }).filter((proxy) => {
        if (tag && !proxy.tags.some((item) => String(item || '').trim().toLowerCase() === tag)) return false;
        if (group && String(proxy.group || '').trim().toLowerCase() !== group) return false;
        return true;
    });
}

function syncBatchRandomSavedProxyInfo() {
    const tagInput = document.getElementById('batchRandomSavedProxyTag');
    const groupSelect = document.getElementById('batchRandomSavedProxyGroup');
    const info = document.getElementById('batchSavedProxyRandomInfo');
    const summary = document.getElementById('batchSavedProxyRandomSummary');
    const applyBtn = document.getElementById('batchSavedProxyRandomApplyBtn');
    const strategy = String(document.getElementById('batchRandomSavedProxyStrategy')?.value || 'random').trim();
    if (!info || !summary) return;
    const selectedCount = getSelectedVisibleProfileIds().length;
    summary.textContent = `${selectedCount} ${t('msgProfiles')}`;
    const tag = String(tagInput && tagInput.value || '').trim().toLowerCase();
    const group = String(groupSelect && groupSelect.value || '').trim().toLowerCase();
    const matched = filterSavedProfileProxiesForBatch(globalSettings, { tag, group });
    if (matched.length === 0) {
        info.textContent = t('batchBindSavedProxyNoLibrary');
        if (applyBtn) applyBtn.disabled = true;
        return;
    }
    info.textContent = uiText(
        `可用代理 ${matched.length} 个 · ${group ? `分组 ${group} · ` : ''}${strategy === 'least-used' ? '最少使用优先' : '随机打散'}`,
        `${matched.length} candidate proxies${group ? ` · group ${group}` : ''} · ${strategy === 'least-used' ? 'least-used' : 'random'}`
    );
    if (applyBtn) applyBtn.disabled = selectedCount === 0;
}

async function openBatchSavedProxyBindModal() {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    const proxies = getSavedProfileProxyLibrary(globalSettings, { includeDisabled: false });
    if (proxies.length === 0) {
        showAlert(t('batchBindSavedProxyNoLibrary'));
        return;
    }
    renderSavedProfileProxySelect('batchSavedProxyId', globalSettings, document.getElementById('batchSavedProxyId')?.value || proxies[0].id || '');
    syncBatchSavedProxyBindInfo();
    const modal = document.getElementById('batchSavedProxyBindModal');
    if (modal) modal.style.display = 'flex';
}

function closeBatchSavedProxyBindModal() {
    const modal = document.getElementById('batchSavedProxyBindModal');
    if (modal) modal.style.display = 'none';
}

async function openBatchRandomSavedProxyModal() {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    const proxies = getSavedProfileProxyLibrary(globalSettings, { includeDisabled: false });
    if (proxies.length === 0) {
        showAlert(t('batchBindSavedProxyNoLibrary'));
        return;
    }
    const tagInput = document.getElementById('batchRandomSavedProxyTag');
    if (tagInput) {
        const tags = getSavedProfileProxyTagList(globalSettings);
        tagInput.value = '';
        tagInput.setAttribute('list', 'savedProfileProxyTagSuggestions');
        let datalist = document.getElementById('savedProfileProxyTagSuggestions');
        if (!datalist) {
            datalist = document.createElement('datalist');
            datalist.id = 'savedProfileProxyTagSuggestions';
            document.body.appendChild(datalist);
        }
        datalist.innerHTML = tags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join('');
    }
    const groupSelect = document.getElementById('batchRandomSavedProxyGroup');
    if (groupSelect) {
        const groups = getSavedProfileProxyGroupList(globalSettings);
        groupSelect.innerHTML = [`<option value="">${escapeHtml(t('noneOption'))}</option>`]
            .concat(groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`))
            .join('');
        groupSelect.value = '';
    }
    const strategySelect = document.getElementById('batchRandomSavedProxyStrategy');
    if (strategySelect) strategySelect.value = 'random';
    syncBatchRandomSavedProxyInfo();
    const modal = document.getElementById('batchSavedProxyRandomModal');
    if (modal) modal.style.display = 'flex';
}

function closeBatchRandomSavedProxyModal() {
    const modal = document.getElementById('batchSavedProxyRandomModal');
    if (modal) modal.style.display = 'none';
}

async function openBatchReplaceSavedProxyModal() {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    const proxies = getSavedProfileProxyLibrary(globalSettings);
    if (proxies.length < 2) {
        showAlert(t('batchBindSavedProxyNoLibrary'));
        return;
    }
    const currentFrom = document.getElementById('batchReplaceSavedProxyFromId')?.value || proxies[0].id || '';
    const currentTo = document.getElementById('batchReplaceSavedProxyToId')?.value || proxies.find((item) => item.id !== currentFrom)?.id || proxies[0].id || '';
    renderSavedProfileProxySelect('batchReplaceSavedProxyFromId', globalSettings, currentFrom);
    renderSavedProfileProxySelect('batchReplaceSavedProxyToId', globalSettings, currentTo);
    syncBatchReplaceSavedProxyInfo();
    const modal = document.getElementById('batchSavedProxyReplaceModal');
    if (modal) modal.style.display = 'flex';
}

function closeBatchReplaceSavedProxyModal() {
    const modal = document.getElementById('batchSavedProxyReplaceModal');
    if (modal) modal.style.display = 'none';
}

async function applyBatchSavedProxyBinding(btn) {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    const select = document.getElementById('batchSavedProxyId');
    const savedProxy = findSavedProfileProxyById(globalSettings, select && select.value);
    if (!savedProxy) {
        showAlert(t('batchBindSavedProxyNoLibrary'));
        return;
    }
    const restore = setDiagActionBusy(btn, true, `${t('batchBindSavedProxyApplying')} 0/${ids.length}`);
    let result = null;
    try {
        result = await postLocalApiJson('/profiles/batch/saved-proxy-binding', {
            profileIds: ids,
            savedProxyId: savedProxy.id,
            syncFallbackProxyStr: true,
        });
    } finally {
        restore();
    }
    ids.forEach((id) => profileProxyTestCache.delete(id));
    closeBatchSavedProxyBindModal();
    await refreshSavedProfileProxyUsageCounts();
    if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
    showAlert([
        `${t('batchBindSavedProxySuccess')}: ${Number(result && result.updatedCount || 0)} ${t('msgProfiles')}`,
        result && Number(result.matchedCount || 0) !== Number(result.updatedCount || 0)
            ? uiText(`命中 ${result.matchedCount} 个环境`, `Matched ${result.matchedCount} profiles`)
            : ''
    ].filter(Boolean).join('\n'));
    await loadProfiles();
}

async function applyBatchReplaceSavedProxy(btn) {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const fromId = normalizeSavedProxyId(document.getElementById('batchReplaceSavedProxyFromId')?.value);
    const toId = normalizeSavedProxyId(document.getElementById('batchReplaceSavedProxyToId')?.value);
    if (!fromId) return showAlert(t('batchReplaceSavedProxySelectSource'));
    if (!toId) return showAlert(t('batchReplaceSavedProxySelectTarget'));
    if (fromId === toId) return showAlert(t('batchReplaceSavedProxySame'));

    const restore = setDiagActionBusy(btn, true, `${t('batchReplaceSavedProxyApplying')} 0/${ids.length}`);
    let result = null;
    try {
        result = await postLocalApiJson('/profiles/batch/saved-proxy-binding', {
            profileIds: ids,
            sourceSavedProxyId: fromId,
            savedProxyId: toId,
            syncFallbackProxyStr: true,
        });
    } finally {
        restore();
    }
    ids.forEach((id) => profileProxyTestCache.delete(id));
    closeBatchReplaceSavedProxyModal();
    await refreshSavedProfileProxyUsageCounts();
    if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
    showAlert([
        `${t('batchReplaceSavedProxySuccess')}: ${Number(result && result.updatedCount || 0)} ${t('msgProfiles')}`,
        result ? uiText(`命中 ${result.matchedCount} 个环境`, `Matched ${result.matchedCount} profiles`) : ''
    ].filter(Boolean).join('\n'));
    await loadProfiles();
}

async function applyBatchRandomSavedProxy(btn) {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const tag = String(document.getElementById('batchRandomSavedProxyTag')?.value || '').trim();
    const group = String(document.getElementById('batchRandomSavedProxyGroup')?.value || '').trim();
    const strategy = String(document.getElementById('batchRandomSavedProxyStrategy')?.value || 'random').trim();
    const restore = setDiagActionBusy(btn, true, `${t('batchRandomSavedProxyApplying')} 0/${ids.length}`);
    let result = null;
    try {
        result = await postLocalApiJson('/profiles/batch/random-saved-proxy-binding', {
            profileIds: ids,
            tag,
            group,
            strategy,
            syncFallbackProxyStr: true,
        });
    } finally {
        restore();
    }
    ids.forEach((id) => profileProxyTestCache.delete(id));
    closeBatchRandomSavedProxyModal();
    await refreshSavedProfileProxyUsageCounts();
    if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
    showAlert([
        `${t('batchRandomSavedProxySuccess')}: ${Number(result && result.updatedCount || 0)} ${t('msgProfiles')}`,
        result ? uiText(`候选代理 ${result.candidateCount} 个`, `${result.candidateCount} candidate proxies`) : '',
        result && result.tag ? uiText(`Tag: ${result.tag}`, `Tag: ${result.tag}`) : '',
        result && result.group ? uiText(`分组: ${result.group}`, `Group: ${result.group}`) : ''
    ].filter(Boolean).join('\n'));
    await loadProfiles();
}

async function clearBatchSavedProxyBinding(btn) {
    const ids = getSelectedVisibleProfileIds();
    if (ids.length === 0) {
        showAlert(t('batchBindSavedProxyNoSelection'));
        return;
    }
    const confirmed = await showConfirmAsync(
        uiText(
            `确认解除 ${ids.length} 个已选环境的代理库绑定吗？`,
            `Clear saved proxy binding for ${ids.length} selected profiles?`
        )
    );
    if (!confirmed) return;

    const restore = setDiagActionBusy(btn, true, `${uiText('解除中...', 'Clearing...')} 0/${ids.length}`);
    let result = null;
    try {
        result = await postLocalApiJson('/profiles/batch/saved-proxy-binding', {
            profileIds: ids,
            clear: true,
            syncFallbackProxyStr: true,
        });
    } finally {
        restore();
    }
    ids.forEach((id) => profileProxyTestCache.delete(id));
    await refreshSavedProfileProxyUsageCounts();
    if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
    showAlert([
        uiText(
            `已解除 ${Number(result && result.updatedCount || 0)} 个环境的代理库绑定`,
            `Cleared saved proxy binding for ${Number(result && result.updatedCount || 0)} profiles`
        ),
        result && Number(result.matchedCount || 0) !== Number(result.updatedCount || 0)
            ? uiText(`命中 ${result.matchedCount} 个环境`, `Matched ${result.matchedCount} profiles`)
            : ''
    ].filter(Boolean).join('\n'));
    await loadProfiles();
}

function closeDiagnosticDetailsModal() {
    const modal = document.getElementById('diagnosticDetailModal');
    if (modal) modal.style.display = 'none';
}

function buildDiagnosticDetailFacts(result) {
    const facts = normalizeDiagnosticFactItems(result && result.facts, 12);
    if (facts.length === 0) return `<div style="font-size:12px; color:var(--text-secondary);">${escapeHtml(uiText('暂无结构化字段', 'No structured facts'))}</div>`;
    return `
        <div style="display:flex; flex-direction:column; gap:8px;">
            ${facts.map((item) => `
                <div style="display:flex; justify-content:space-between; gap:12px; padding:8px 10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025);">
                    <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(item.label)}</strong>
                    <span style="font-size:12px; color:var(--text-secondary); text-align:right; word-break:break-word;">${escapeHtml(item.value)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function buildDiagnosticDetailComparison(comparison) {
    if (!comparison || !comparison.summary) return '';
    const changes = Array.isArray(comparison.changes) ? comparison.changes : [];
    return `
        <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="font-size:12px; color:var(--text-secondary);">${escapeHtml(comparison.summary)}</div>
            ${changes.length > 0 ? `<div style="display:flex; flex-direction:column; gap:8px;">${changes.map((item) => `
                <div style="padding:8px 10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025); font-size:12px; color:var(--text-secondary);">
                    <strong style="color:var(--text-primary);">${escapeHtml(item.label || '-')}</strong>
                    <div style="margin-top:4px;">${escapeHtml(item.before || '∅')} → ${escapeHtml(item.after || '∅')}</div>
                </div>
            `).join('')}</div>` : ''}
        </div>
    `;
}

function buildDiagnosticDetailArtifacts(latestRun) {
    const markup = buildLatestRunArtifactMarkup(latestRun, { showDetails: false });
    return markup || `<div style="font-size:12px; color:var(--text-secondary);">${escapeHtml(uiText('暂无归档文件', 'No archived artifacts'))}</div>`;
}

function openDiagnosticDetails(profileId, runId) {
    const diagnostics = profileDiagnosticsCache.get(String(profileId || '').trim());
    const latestRun = getDiagnosticRunById(diagnostics, runId);
    if (!latestRun) return showAlert(uiText('未找到该次检测详情', 'Diagnostic run not found'));

    const result = latestRun.result || {};
    const comparison = latestRun.comparison || null;
    const modal = document.getElementById('diagnosticDetailModal');
    const titleEl = document.getElementById('diagnosticDetailTitle');
    const contentEl = document.getElementById('diagnosticDetailContent');
    if (!modal || !titleEl || !contentEl) return;

    const notes = dedupeDiagnosticTexts([
        result.summary || '',
        ...(Array.isArray(result.signals) ? result.signals : []),
        result.finalUrl || latestRun.url || '',
    ], 12);
    const rawJson = JSON.stringify({
        presetId: latestRun.presetId,
        name: latestRun.name,
        openedAt: latestRun.openedAt,
        result,
        comparison,
    }, null, 2);

    titleEl.textContent = result.headline || latestRun.name || latestRun.presetId || uiText('检测详情', 'Diagnostic details');
    contentEl.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:16px;">
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                <div style="padding:10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025);">
                    <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(uiText('站点', 'Preset'))}</div>
                    <div style="margin-top:4px; font-size:13px; color:var(--text-primary);">${escapeHtml(latestRun.name || latestRun.presetId || '-')}</div>
                </div>
                <div style="padding:10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025);">
                    <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(uiText('状态', 'Status'))}</div>
                    <div style="margin-top:4px; font-size:13px; color:var(--text-primary);">${escapeHtml(String(result.status || 'info').toUpperCase())}</div>
                </div>
                <div style="padding:10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025);">
                    <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(uiText('打开时间', 'Opened at'))}</div>
                    <div style="margin-top:4px; font-size:13px; color:var(--text-primary);">${escapeHtml(formatDiagTime(latestRun.openedAt))}</div>
                </div>
                <div style="padding:10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025);">
                    <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(uiText('快照时间', 'Captured at'))}</div>
                    <div style="margin-top:4px; font-size:13px; color:var(--text-primary);">${escapeHtml(formatDiagTime(result.capturedAt))}</div>
                </div>
            </div>

            <div>
                <div style="font-size:12px; font-weight:bold; color:var(--text-primary); margin-bottom:8px;">${escapeHtml(uiText('摘要', 'Summary'))}</div>
                <div style="padding:10px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.025); font-size:12px; color:var(--text-secondary); line-height:1.6; white-space:pre-wrap; word-break:break-word;">${escapeHtml(notes.join('\n') || '-')}</div>
            </div>

            <div>
                <div style="font-size:12px; font-weight:bold; color:var(--text-primary); margin-bottom:8px;">${escapeHtml(uiText('结构化结果', 'Structured facts'))}</div>
                ${buildDiagnosticDetailFacts(result)}
            </div>

            ${comparison ? `
                <div>
                    <div style="font-size:12px; font-weight:bold; color:var(--text-primary); margin-bottom:8px;">${escapeHtml(uiText('与上次同站点对比', 'Comparison vs previous'))}</div>
                    ${buildDiagnosticDetailComparison(comparison)}
                </div>
            ` : ''}

            <div>
                <div style="font-size:12px; font-weight:bold; color:var(--text-primary); margin-bottom:8px;">${escapeHtml(uiText('归档快照', 'Archived artifacts'))}</div>
                ${buildDiagnosticDetailArtifacts(latestRun)}
            </div>

            <div>
                <div style="font-size:12px; font-weight:bold; color:var(--text-primary); margin-bottom:8px;">${escapeHtml(uiText('原始 JSON', 'Raw JSON'))}</div>
                <pre style="margin:0; max-height:260px; overflow:auto; padding:12px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(0,0,0,0.22); color:var(--text-secondary); font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word;">${escapeHtml(rawJson)}</pre>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

async function ensureProfileRunningForDiagnostics(id) {
    const runningIds = await window.electronAPI.getRunningIds();
    if (runningIds.includes(id)) return false;
    const watermarkStyle = localStorage.getItem('geekez_watermark_style') || 'enhanced';
    const msg = await window.electronAPI.launchProfile(id, watermarkStyle, curLang);
    if (msg && msg.includes(':')) showAlert(msg);
    return true;
}

async function openProfileDashboard(id, btn) {
    const done = setDiagActionBusy(btn, true, uiText('打开中...', 'Opening...'));
    try {
        await ensureProfileRunningForDiagnostics(id);
        await window.electronAPI.invoke('open-profile-dashboard', { profileId: id, appLang: curLang });
        await refreshProfileDiagnosticsCards([id]);
    } catch (e) {
        showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
    } finally {
        done();
    }
}

async function runAllProfileDiagnostics(id, btn) {
    const done = setDiagActionBusy(btn, true, uiText('检测中...', 'Running...'));
    try {
        await ensureProfileRunningForDiagnostics(id);
        const diagnostics = await window.electronAPI.invoke('run-profile-diagnostics-all', id);
        profileDiagnosticsCache.set(id, diagnostics);
        renderProfileDiagnosticsCard(id, diagnostics);
    } catch (e) {
        showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
    } finally {
        done();
    }
}

async function runSingleProfileDiagnostic(id, presetId, btn) {
    const done = setDiagActionBusy(btn, true, uiText('检测中...', 'Running...'));
    try {
        await ensureProfileRunningForDiagnostics(id);
        const diagnostics = await window.electronAPI.invoke('open-profile-diagnostic', { profileId: id, presetId });
        profileDiagnosticsCache.set(id, diagnostics);
        renderProfileDiagnosticsCard(id, diagnostics);
    } catch (e) {
        showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
    } finally {
        done();
    }
}

function clearProfileDiagnostics(id, btn) {
    showConfirm(uiText('清空该环境的检测历史和归档？', 'Clear diagnostics history and artifacts for this profile?'), async () => {
        const done = setDiagActionBusy(btn, true, uiText('清理中...', 'Clearing...'));
        try {
            const diagnostics = await window.electronAPI.invoke('clear-profile-diagnostics', id);
            profileDiagnosticsCache.set(id, diagnostics);
            renderProfileDiagnosticsCard(id, diagnostics);
        } catch (e) {
            showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
        } finally {
            done();
        }
    });
}

// Custom City Dropdown Initialization (Matches Timezone Logic)
function initCustomCityDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    if (!input || !dropdown) return;

    // Build cached list
    let allOptions = [];
    // 1. Add English "Auto" option
    allOptions.push({ name: "Auto (IP Based)", isAuto: true });
    // 2. Add cities
    if (window.CITY_DATA) {
        allOptions = allOptions.concat(window.CITY_DATA);
    }

    let selectedIndex = -1;

    function populateDropdown(filter = '') {
        const lowerFilter = filter.toLowerCase();
        // 如果是 "Auto" 则显示全部，否则按关键词过滤
        const shouldShowAll = filter === 'Auto (IP Based)' || filter === '';

        const filtered = (shouldShowAll ? allOptions : allOptions.filter(item =>
            item.name.toLowerCase().includes(lowerFilter)
        )).slice(0, 60);

        dropdown.innerHTML = filtered.map((item, index) =>
            `<div class="timezone-item" data-name="${item.name}" data-index="${index}">${item.name}</div>`
        ).join('');

        selectedIndex = -1;
    }

    function showDropdown() {
        populateDropdown(''); // Always show full list on click
        dropdown.classList.add('active');
    }

    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    function selectItem(name) {
        input.value = name;
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);

    // Prevent blur from closing immediately so click can register
    // Relaxed for click-outside logic instead

    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) dropdown.classList.add('active');
    });

    // Keyboard nav
    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].dataset.name);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    function updateSelection(items) {
        items.forEach((item, index) => item.classList.toggle('selected', index === selectedIndex));
        if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) selectItem(item.dataset.name);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}

// --- Language Dropdown Helpers ---
function getLanguageName(code) {
    if (!code || code === 'auto') return "Auto (System Default)";
    if (!window.LANGUAGE_DATA) return code;
    const entry = window.LANGUAGE_DATA.find(x => x.code === code);
    return entry ? entry.name : "Auto (System Default)";
}

function getLanguageCode(name) {
    if (!name || name === "Auto (System Default)") return 'auto';
    if (!window.LANGUAGE_DATA) return 'auto';
    const entry = window.LANGUAGE_DATA.find(x => x.name === name);
    return entry ? entry.code : 'auto';
}

function initCustomLanguageDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    // Use window.LANGUAGE_DATA from languages.js
    const allOptions = window.LANGUAGE_DATA || [];
    let selectedIndex = -1;

    function populateDropdown(filter = '') {
        const lowerFilter = filter.toLowerCase();
        const shouldShowAll = filter === '' || filter === 'Auto (System Default)';
        const filtered = (shouldShowAll ? allOptions : allOptions.filter(item =>
            item.name.toLowerCase().includes(lowerFilter)
        )).slice(0, 60);

        dropdown.innerHTML = filtered.map((item, index) =>
            `<div class="timezone-item" data-code="${item.code}" data-index="${index}">${item.name}</div>`
        ).join('');
        selectedIndex = -1;
    }

    function showDropdown() {
        populateDropdown('');
        dropdown.classList.add('active');
    }

    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    function selectItem(name) {
        input.value = name;
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) dropdown.classList.add('active');
    });

    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].innerText);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    function updateSelection(items) {
        items.forEach((item, index) => item.classList.toggle('selected', index === selectedIndex));
        if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) selectItem(item.innerText);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}


function decodeBase64Content(str) {
    try {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    } catch (e) { return atob(str); }
}

function getProxyRemark(link) {
    if (!link) return '';
    link = link.trim();
    try {
        if (link.startsWith('vmess://')) {
            const base64Str = link.replace('vmess://', '');
            const configStr = decodeBase64Content(base64Str);
            try { return JSON.parse(configStr).ps || ''; } catch (e) { return ''; }
        } else if (link.includes('#')) {
            return decodeURIComponent(link.split('#')[1]).trim();
        }
    } catch (e) { }
    return '';
}

function renderHelpContent() {
    const manualHTML = curLang === 'en' ?
        `<div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">1. Create Environment</h4><p style="font-size:14px;">Enter a profile name. Proxy is optional; if provided, the system auto-generates a unique fingerprint with randomized Hardware.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">2. Launch</h4><p style="font-size:14px;">Click Launch. A green badge indicates active status. Each environment is fully isolated.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">3. Pre-Proxy (Optional)</h4><p style="font-size:14px;">Chain proxy for IP hiding. Use TCP protocols for stability.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">4. Best Practices</h4><p style="font-size:14px;">• Use high-quality residential IPs<br>• Keep one account per environment<br>• Avoid frequent switching<br>• Simulate real user behavior</p></div>` :
        `<div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">1. 新建环境</h4><p style="font-size:14px;">填写环境名称，代理可选；如填写代理，系统会自动生成唯一指纹（硬件随机化）。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">2. 启动环境</h4><p style="font-size:14px;">点击启动，列表中显示绿色运行标签。每个环境完全隔离。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">3. 前置代理（可选）</h4><p style="font-size:14px;">用于隐藏本机IP或链路加速。建议使用TCP协议。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">4. 最佳实践</h4><p style="font-size:14px;">• 使用高质量住宅IP<br>• 一个账号固定一个环境<br>• 避免频繁切换<br>• 模拟真实用户行为</p></div>`;

    const aboutHTML = curLang === 'en' ?
        `<div style="text-align:center;margin-bottom:24px;padding:20px 0;">
            <div style="font-size:28px;font-weight:700;color:var(--text-primary);letter-spacing:1px;">Geek<span style="color:var(--accent);">EZ</span></div>
            <div style="font-size:12px;opacity:0.5;margin-top:4px;">v1.3.6 · Anti-detect Browser</div>
         </div>
         
         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, var(--accent), #7c3aed);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">CORE TECHNOLOGY</h4>
         </div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;">
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🧬 Real Chrome Kernel</div>
                <div style="font-size:11px;opacity:0.7;">Native Chrome + JS Injection</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🔐 Hardware Fingerprint</div>
                <div style="font-size:11px;opacity:0.7;">CPU/Memory Randomization</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🌍 60+ Languages</div>
                <div style="font-size:11px;opacity:0.7;">Timezone & Locale Spoofing</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">⚡ GPU Acceleration</div>
                <div style="font-size:11px;opacity:0.7;">Smooth UI Performance</div>
            </div>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #4CAF50, #2196F3);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">DETECTION STATUS</h4>
         </div>
         <div style="background:var(--input-bg);padding:14px;border-radius:8px;border:1px solid var(--border);margin-bottom:24px;">
            <div style="display:flex;flex-wrap:wrap;gap:16px;">
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> Runtime self-check</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> BrowserLeaks / Pixelscan / IPhey / Whoer presets</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> Locale / header / permission consistency</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> Diagnostic artifact archive</div>
            </div>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #FF9800, #F44336);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">PLATFORM COMPATIBILITY</h4>
         </div>
         <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;">
            <span style="background:linear-gradient(135deg, rgba(243,156,18,0.2), rgba(243,156,18,0.1));color:#f39c12;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Amazon</span>
            <span style="background:linear-gradient(135deg, rgba(39,174,96,0.2), rgba(39,174,96,0.1));color:#27ae60;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">TikTok</span>
            <span style="background:linear-gradient(135deg, rgba(41,128,185,0.2), rgba(41,128,185,0.1));color:#2980b9;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Facebook</span>
            <span style="background:linear-gradient(135deg, rgba(230,126,34,0.2), rgba(230,126,34,0.1));color:#e67e22;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Shopee</span>
            <span style="background:linear-gradient(135deg, rgba(191,0,0,0.2), rgba(191,0,0,0.1));color:#bf0000;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Rakuten</span>
            <span style="background:linear-gradient(135deg, rgba(241,196,15,0.2), rgba(241,196,15,0.1));color:#f1c40f;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Mercado</span>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #9C27B0, #E91E63);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">COMMUNITY</h4>
         </div>
         <div style="background:linear-gradient(135deg, var(--input-bg), var(--card-bg));padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center;">
            <div style="font-size:18px;margin-bottom:6px;">💬</div>
            <div style="font-size:12px;opacity:0.8;margin-bottom:8px;">Join our QQ Group for support</div>
            <a href="tencent://groupwpa/?subcmd=all&uin=1079216892" title="Click to join QQ Group" style="font-size:16px;font-weight:600;color:var(--accent);letter-spacing:1px;text-decoration:none;">Click to join: 1079216892</a>
         </div>` :
        `<div style="text-align:center;margin-bottom:24px;padding:20px 0;">
            <div style="font-size:28px;font-weight:700;color:var(--text-primary);letter-spacing:1px;">Geek<span style="color:var(--accent);">EZ</span></div>
            <div style="font-size:12px;opacity:0.5;margin-top:4px;">v1.3.6 · 指纹浏览器</div>
         </div>
         
         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, var(--accent), #7c3aed);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">核心技术</h4>
         </div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;">
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🧬 真实 Chrome 内核</div>
                <div style="font-size:11px;opacity:0.7;">原生内核 + JS 注入</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🔐 硬件指纹随机化</div>
                <div style="font-size:11px;opacity:0.7;">CPU/内存完全随机</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">🌍 60+ 语言适配</div>
                <div style="font-size:11px;opacity:0.7;">时区与语言完美伪装</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">⚡ GPU 硬件加速</div>
                <div style="font-size:11px;opacity:0.7;">流畅 UI 渲染体验</div>
            </div>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #4CAF50, #2196F3);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">检测状态</h4>
         </div>
         <div style="background:var(--input-bg);padding:14px;border-radius:8px;border:1px solid var(--border);margin-bottom:24px;">
            <div style="display:flex;flex-wrap:wrap;gap:16px;">
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> 运行时自检</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> 内置 BrowserLeaks / Pixelscan / IPhey / Whoer</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> Header / 语言 / 权限一致性检查</div>
                <div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> 检测快照归档</div>
            </div>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #FF9800, #F44336);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">平台适配</h4>
         </div>
         <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;">
            <span style="background:linear-gradient(135deg, rgba(243,156,18,0.2), rgba(243,156,18,0.1));color:#f39c12;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Amazon</span>
            <span style="background:linear-gradient(135deg, rgba(39,174,96,0.2), rgba(39,174,96,0.1));color:#27ae60;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">TikTok</span>
            <span style="background:linear-gradient(135deg, rgba(41,128,185,0.2), rgba(41,128,185,0.1));color:#2980b9;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">Facebook</span>
            <span style="background:linear-gradient(135deg, rgba(230,126,34,0.2), rgba(230,126,34,0.1));color:#e67e22;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">虾皮</span>
            <span style="background:linear-gradient(135deg, rgba(191,0,0,0.2), rgba(191,0,0,0.1));color:#bf0000;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">乐天</span>
            <span style="background:linear-gradient(135deg, rgba(241,196,15,0.2), rgba(241,196,15,0.1));color:#f1c40f;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">美客多</span>
         </div>

         <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg, #9C27B0, #E91E63);border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">交流社群</h4>
         </div>
         <div style="background:linear-gradient(135deg, var(--input-bg), var(--card-bg));padding:16px;border-radius:8px;border:1px solid var(--border);text-align:center;">
            <div style="font-size:18px;margin-bottom:6px;">💬</div>
            <div style="font-size:12px;opacity:0.8;margin-bottom:8px;">加入 QQ 群获取支持与交流</div>
            <a href="tencent://groupwpa/?subcmd=all&uin=1079216892" title="点击加入QQ群" style="font-size:16px;font-weight:600;color:var(--accent);letter-spacing:1px;text-decoration:none;">点击加入：1079216892</a>
         </div>`;

    const manualEl = document.getElementById('help-manual');
    const aboutEl = document.getElementById('help-about');
    if (manualEl) manualEl.innerHTML = manualHTML;
    if (aboutEl) aboutEl.innerHTML = aboutHTML;
}

function applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.innerText = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const text = t(el.getAttribute('data-i18n-title'));
        el.setAttribute('title', text);
        el.setAttribute('aria-label', text);
    });
    document.querySelectorAll('.running-badge').forEach(el => { el.innerText = t('runningStatus'); });
    const themeSel = document.getElementById('themeSelect');
    if (themeSel) { themeSel.options[0].text = t('themeGeek'); themeSel.options[1].text = t('themeLight'); themeSel.options[2].text = t('themeDark'); }
    if (
        (document.getElementById('settingsModal')?.style.display === 'flex' && switchSettingsTab._advancedLoaded)
        || document.getElementById('proxyModal')?.style.display === 'flex'
    ) {
        renderAdvancedPresetEditors();
    }
    window.electronAPI.getSettings().then((settings) => {
        renderHeaderPresetSelect('addHeaderPresetId', settings, document.getElementById('addHeaderPresetId')?.value || '');
        renderHeaderPresetSelect('editHeaderPresetId', settings, document.getElementById('editHeaderPresetId')?.value || '');
    }).catch(() => { });
    renderHelpContent();
    updateToolbar(); loadProfiles(); renderGroupTabs();
}

async function toggleLang() {
    await syncAppLanguagePreference(curLang === 'cn' ? 'en' : 'cn');
    applyLang();
}

function setTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('geekez_theme', themeName);
    const themeColors = {
        'geek': { bg: '#1e1e2d', symbol: '#ffffff' },
        'light': { bg: '#f0f2f5', symbol: '#000000' },
        'dark': { bg: '#121212', symbol: '#ffffff' }
    };
    const colors = themeColors[themeName] || themeColors['geek'];
    window.electronAPI.invoke('set-title-bar-color', colors);
}

// Show Alert (supports loading state)
function showAlert(msg, showBtn = true) {
    document.getElementById('alertMsg').innerText = msg;
    const btn = document.getElementById('alertBtn');
    if (btn) btn.style.display = showBtn ? 'block' : 'none';
    document.getElementById('alertModal').style.display = 'flex';
}
function showConfirm(msg, callback, options = {}) {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmMsg');
    const notesEl = document.getElementById('confirmNotes');
    const iconEl = document.getElementById('confirmIcon');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    msgEl.innerText = msg;

    if (iconEl) {
        iconEl.textContent = '⚠';
        iconEl.style.color = 'var(--danger)';
    }

    if (notesEl) {
        const notes = Array.isArray(options && options.notes) ? options.notes.map((item) => String(item || '').trim()).filter(Boolean) : [];
        notesEl.innerHTML = notes.length > 0 ? notes.map((item) => escapeHtml(item)).join('<br>') : '';
        notesEl.style.display = notes.length > 0 ? 'block' : 'none';
        notesEl.onclick = null;
    }

    if (noBtn) {
        noBtn.textContent = String(options && options.cancelText || 'Cancel');
        noBtn.onclick = () => closeConfirm(false);
    }
    if (yesBtn) {
        yesBtn.classList.toggle('danger', options && options.confirmDanger !== false);
        yesBtn.textContent = String(options && options.confirmText || 'Confirm');
        yesBtn.onclick = () => closeConfirm(true);
    }

    confirmCallback = callback;
    modal.style.display = 'flex';
}

function showConfirmAsync(msg, options = {}) {
    return new Promise((resolve) => {
        showConfirm(msg, () => resolve(true), options);
        const noBtn = document.getElementById('confirmNo');
        if (noBtn) noBtn.onclick = () => { closeConfirm(false); resolve(false); };
    });
}
function closeConfirm(result) {
    document.getElementById('confirmModal').style.display = 'none';
    if (result && confirmCallback) confirmCallback();
    confirmCallback = null;
}

function openSshHostKeyModal(data) {
    if (!data || !data.requestId) return;
    sshHostKeyPromptReq = data;

    const isCn = window.curLang === 'cn';
    const isUpdate = !!data.isUpdate;
    const host = data.host ? String(data.host) : '';
    const port = (data.port !== undefined && data.port !== null) ? String(data.port) : '';
    const fingerprint = data.fingerprint ? String(data.fingerprint) : '-';

    document.getElementById('sshHostKeyTitle').innerText = isUpdate
        ? (isCn ? 'SSH 主机指纹已变更' : 'SSH Host Key Changed')
        : (isCn ? 'SSH 主机指纹确认' : 'SSH Host Key Confirmation');

    document.getElementById('sshHostKeyMessage').innerText = isUpdate
        ? (isCn
            ? '检测到该服务器的 SSH Host Key 与本机缓存不一致。只有在你确认服务器确实更换过 Host Key 时才继续。'
            : 'The SSH host key does not match your cached key. Continue only if you trust this change.')
        : (isCn
            ? '首次连接该 SSH 服务器需要确认 Host Key（避免连接到伪造服务器）。请核对指纹后再继续。'
            : 'First-time connection requires confirming the host key. Verify the fingerprint before continuing.');

    document.getElementById('sshHostKeyHost').innerText = host || '-';
    document.getElementById('sshHostKeyPort').innerText = port || '-';
    document.getElementById('sshHostKeyFingerprint').innerText = fingerprint;

    const btnYes = document.getElementById('sshHostKeyBtnYes');
    const btnOnce = document.getElementById('sshHostKeyBtnOnce');
    const btnCancel = document.getElementById('sshHostKeyBtnCancel');
    const btnCopy = document.getElementById('sshHostKeyBtnCopy');

    if (btnYes) btnYes.innerText = isUpdate
        ? (isCn ? '更新缓存并继续 (y)' : 'Update & Continue (y)')
        : (isCn ? '信任并继续 (y)' : 'Trust & Continue (y)');
    if (btnOnce) btnOnce.innerText = isCn ? '仅本次继续 (n)' : 'Continue Once (n)';
    if (btnCancel) btnCancel.innerText = isCn ? '取消' : 'Cancel';
    if (btnCopy) btnCopy.innerText = isCn ? '复制指纹' : 'Copy Fingerprint';

    const rawWrap = document.getElementById('sshHostKeyRawWrap');
    const rawEl = document.getElementById('sshHostKeyRaw');
    const raw = data.raw ? String(data.raw).trim() : '';
    if (rawWrap && rawEl) {
        if (raw) {
            rawEl.textContent = raw;
            rawWrap.style.display = 'block';
        } else {
            rawEl.textContent = '';
            rawWrap.style.display = 'none';
        }
    }

    document.getElementById('sshHostKeyModal').style.display = 'flex';
}

async function closeSshHostKeyModal(choice) {
    const modal = document.getElementById('sshHostKeyModal');
    if (modal) modal.style.display = 'none';

    const req = sshHostKeyPromptReq;
    sshHostKeyPromptReq = null;
    if (!req || !req.requestId) return;

    const c = (choice === 'y' || choice === 'n') ? choice : 'cancel';
    try { await window.electronAPI.invoke('ssh-hostkey-prompt-result', { requestId: req.requestId, choice: c }); } catch (e) { }
}

async function copySshHostKeyFingerprint() {
    const el = document.getElementById('sshHostKeyFingerprint');
    const btn = document.getElementById('sshHostKeyBtnCopy');
    const text = el ? String(el.innerText || '').trim() : '';
    if (!text || text === '-') return;

    const isCn = window.curLang === 'cn';
    const original = btn ? btn.innerText : '';
    try {
        await navigator.clipboard.writeText(text);
        if (btn) {
            btn.innerText = isCn ? '已复制' : 'Copied';
            setTimeout(() => { if (btn) btn.innerText = original; }, 900);
        }
    } catch (e) {
        if (btn) {
            btn.innerText = isCn ? '复制失败' : 'Copy failed';
            setTimeout(() => { if (btn) btn.innerText = original; }, 1200);
        }
    }
}

function showInput(title, callback, options = {}) {
    const input = document.getElementById('inputModalValue');
    document.getElementById('inputModalTitle').innerText = title;
    input.value = String(options.value || '');
    input.placeholder = String(options.placeholder || '');
    input.rows = Number.isFinite(Number(options.rows)) && Number(options.rows) > 0 ? Number(options.rows) : 5;
    document.getElementById('inputModal').style.display = 'flex';
    input.focus();
    inputCallback = callback;
    inputModalOptions = options || {};
}
function closeInputModal() {
    const input = document.getElementById('inputModalValue');
    if (input) {
        input.placeholder = '';
        input.rows = 5;
    }
    document.getElementById('inputModal').style.display = 'none';
    inputCallback = null;
    inputModalOptions = null;
}
function submitInputModal() {
    const val = document.getElementById('inputModalValue').value.trim();
    if (inputCallback && (val || (inputModalOptions && inputModalOptions.allowEmpty === true))) inputCallback(val);
    closeInputModal();
}

async function init() {
    const savedTheme = localStorage.getItem('geekez_theme') || 'geek';
    setTheme(savedTheme);
    document.getElementById('themeSelect').value = savedTheme;
    setTimeout(() => { const s = document.getElementById('splash'); if (s) { s.style.opacity = '0'; setTimeout(() => s.remove(), 500); } }, 1500);

    globalSettings = await window.electronAPI.getSettings();
    if (!globalSettings.preProxies) globalSettings.preProxies = [];
    if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
    if (!globalSettings.savedProfileProxySources) globalSettings.savedProfileProxySources = [];
    if (!globalSettings.savedProfileProxies) globalSettings.savedProfileProxies = [];
    await syncAppLanguagePreference(curLang);
    bindAdvancedPresetEditorEvents();
    refreshProxyManagerAttentionBadgeState().catch(() => { });

    // Profile list event delegation
    const profileListEl = document.getElementById('profileList');
    if (profileListEl) {
        profileListEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                const action = btn.dataset.action;
                const id = btn.dataset.id;
                if (!id) return;
                switch (action) {
                    case 'launch': launch(id); break;
                    case 'edit': openEditModal(id); break;
                    case 'delete': remove(id); break;
                    case 'proxy-test': {
                        const dot = btn;
                        dot.classList.add('testing');
                        runProfileProxyTest(id).finally(() => { dot.classList.remove('testing'); });
                        break;
                    }
                }
                return;
            }
            if (getSelectedVisibleProfileIds().length === 0) return;
            const card = e.target.closest('.profile-item');
            if (!card || !profileListEl.contains(card)) return;
            if (e.target.closest('button, select, option, input, textarea, a, label')) return;
            const id = String(card.dataset.profileId || '').trim();
            if (!id) return;
            toggleProfileCardSelection(id, !selectedListProfileIds.has(id));
        });
        profileListEl.addEventListener('change', (e) => {
            const target = e.target;
            if (!target.dataset.action || !target.dataset.id) return;
            const action = target.dataset.action;
            const id = target.dataset.id;
            if (action === 'toggle-select') {
                toggleProfileCardSelection(id, target.checked);
            } else if (action === 'quick-preproxy') {
                quickUpdatePreProxy(id, target.value);
            }
        });
    }

    document.getElementById('enablePreProxy').checked = globalSettings.enablePreProxy || false;
    document.getElementById('enablePreProxy').addEventListener('change', updateToolbar);
    window.electronAPI.onProfileStatus(({ id, status }) => {
        const badge = document.getElementById(`status-${id}`);
        if (badge) status === 'running' ? badge.classList.add('active') : badge.classList.remove('active');
        refreshProfileDiagnosticsCards([id]).catch(() => { });
    });
    if (window.electronAPI.onSshHostKeyPrompt) {
        window.electronAPI.onSshHostKeyPrompt((data) => openSshHostKeyModal(data));
    }
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('sshHostKeyModal');
        if (!modal || modal.style.display !== 'flex') return;
        if (e.key === 'Escape') closeSshHostKeyModal('cancel');
        else if (e.key === 'Enter') closeSshHostKeyModal('y');
    });

    // API event listeners for remote refresh and launch
    window.electronAPI.onRefreshProfiles(() => {
        console.log('API triggered profile refresh');
        loadProfiles();
    });

    window.electronAPI.onApiLaunchProfile((id) => {
        console.log('API triggered launch for:', id);
        launch(id);
    });

    // 核心修复：版本号注入
    const info = await window.electronAPI.invoke('get-app-info');
    const verSpan = document.getElementById('app-version');
    if (verSpan) verSpan.innerText = `v${info.version}`;

    checkSubscriptionUpdates();
    applyLang();

    // Load timezones after DOM is ready - Custom Dropdown
    if (typeof window.TIMEZONES !== 'undefined' && Array.isArray(window.TIMEZONES)) {
        initCustomTimezoneDropdown('addTimezone', 'addTimezoneDropdown');
        initCustomTimezoneDropdown('editTimezone', 'editTimezoneDropdown');
    }
    const addProxyInput = document.getElementById('addProxy');
    const editProxyInput = document.getElementById('editProxy');
    if (addProxyInput) addProxyInput.addEventListener('input', () => {
        updateSavedProxyManualDraft('add');
        syncProxyTestResult('add');
    });
    if (editProxyInput) editProxyInput.addEventListener('input', () => {
        updateSavedProxyManualDraft('edit');
        syncProxyTestResult('edit');
    });

    // Check for updates silently on startup
    checkUpdatesSilent();
}


async function checkSubscriptionUpdates() {
    const now = Date.now();
    let updated = false;
    for (const sub of globalSettings.subscriptions) {
        if (!sub.interval || sub.interval == '0') continue;
        const intervalMs = parseInt(sub.interval) * 3600 * 1000;
        if (now - (sub.lastUpdated || 0) > intervalMs) {
            await updateSubscriptionNodes(sub);
            updated = true;
        }
    }
    if (updated) await window.electronAPI.saveSettings(globalSettings);
}

async function checkUpdates() {
    const btn = document.getElementById('btnUpdate');
    btn.style.transition = 'transform 1s';
    btn.style.transform = 'rotate(360deg)';

    // Show "Checking..." without button
    showAlert(t('checkingUpdate'), false);

    try {
        const appRes = await window.electronAPI.invoke('check-app-update');

        // Hide alert modal first to avoid conflict with showConfirm or to refresh state
        document.getElementById('alertModal').style.display = 'none';

        if (appRes.update) {
            // Found App Update -> Show Confirm with Skip option
            showUpdateConfirm(appRes.remote, appRes.url, appRes.notes);
            return;
        }

        const xrayRes = await window.electronAPI.invoke('check-xray-update');
        if (xrayRes.update) {
            showAlert(`${t('xrayUpdateFound')} (v${xrayRes.remote})`); // Shows OK button
            const success = await window.electronAPI.invoke('download-xray-update', xrayRes.downloadUrl);
            if (success) showAlert(t('updateDownloaded'));
            else showAlert(t('updateError'));
            return;
        }

        // No Update -> Show Alert with OK button
        showAlert(t('noUpdate'));

        // Clear badge if no update found after manual check
        btn.classList.remove('has-update');
    } catch (e) {
        showAlert(t('updateError') + " " + e.message);
    } finally {
        setTimeout(() => { btn.style.transform = 'none'; }, 1000);
    }
}

async function checkUpdatesSilent() {
    try {
        const appRes = await window.electronAPI.invoke('check-app-update');
        if (appRes.update) {
            // Check if this version was skipped
            const skippedVersion = localStorage.getItem('geekez_skipped_version');
            if (skippedVersion === appRes.remote) {
                console.log(`Version ${appRes.remote} was skipped, not showing update notification`);
                return;
            }

            const btn = document.getElementById('btnUpdate');
            if (btn) btn.classList.add('has-update');

            // Auto popup for App update with Skip option
            showUpdateConfirm(appRes.remote, appRes.url, appRes.notes);
            return;
        }
        const xrayRes = await window.electronAPI.invoke('check-xray-update');
        if (xrayRes.update) {
            const btn = document.getElementById('btnUpdate');
            if (btn) btn.classList.add('has-update');
        }
    } catch (e) {
        console.error('Silent update check failed:', e);
    }
}

// Simple markdown parser for release notes
function parseMarkdown(md) {
    if (!md) return '';
    return md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') // Escape HTML
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italic
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="#" data-open-url="$2" style="color:var(--accent);text-decoration:none;">$1</a>') // Links
        .replace(/^\s*-\s+(.*)$/gm, '<li>$1</li>') // List items
        .replace(/(<li>.*<\/li>)/s, '<ul style="padding-left: 20px; margin: 5px 0;">$1</ul>') // Wrap lists
        .replace(/\n\n/g, '<br><br>') // Paragraphs
        .replace(/\n/g, '<br>'); // Line breaks
}

// Show update confirm dialog with Skip option
function showUpdateConfirm(version, url, notes) {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmMsg');
    const notesEl = document.getElementById('confirmNotes');
    const iconEl = document.getElementById('confirmIcon');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    confirmCallback = null;
    msgEl.innerHTML = `${t('appUpdateFound')} (v${version})`;

    if (iconEl) {
        iconEl.textContent = '🚀';
        iconEl.style.color = 'var(--accent)';
    }

    if (notes && notesEl) {
        notesEl.innerHTML = parseMarkdown(notes);
        notesEl.style.display = 'block';
        notesEl.onclick = (ev) => {
            const a = ev && ev.target && ev.target.closest ? ev.target.closest('a[data-open-url]') : null;
            if (!a) return;
            ev.preventDefault();
            const targetUrl = a.getAttribute('data-open-url');
            if (targetUrl) window.electronAPI.invoke('open-url', targetUrl);
        };
    } else if (notesEl) {
        notesEl.innerHTML = '';
        notesEl.style.display = 'none';
        notesEl.onclick = null;
    }

    // Update button - go to download page
    yesBtn.textContent = t('goDownload') || '前往下载';
    yesBtn.classList.remove('danger');
    yesBtn.onclick = () => {
        closeConfirm(false);
        window.electronAPI.invoke('open-url', url);
    };

    // Skip button - save skipped version
    noBtn.textContent = t('skipVersion') || '跳过此版本';
    noBtn.onclick = () => {
        localStorage.setItem('geekez_skipped_version', version);
        closeConfirm(false);
        showAlert(t('versionSkipped') || `已跳过 v${version} 版本更新`);
    };

    modal.style.display = 'flex';
}

function openGithub() { window.electronAPI.invoke('open-url', APP_REPO_URL); }

function _debounce(fn, ms) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
}

const _debouncedLoadProfiles = _debounce(() => loadProfiles(), 200);

function filterProfiles(text) {
    searchText = text.toLowerCase();
    _debouncedLoadProfiles();
}

function toggleViewMode() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
    localStorage.setItem('geekez_view', viewMode);
    loadProfiles();
}

// 简单的颜色生成器
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + "00000".substring(0, 6 - c.length) + c;
}

async function loadProfiles() {
    const token = ++profileListLoadToken;
    try {
        const [profiles, settings, runningIdsArr] = await Promise.all([
            window.electronAPI.getProfiles(),
            window.electronAPI.getSettings(),
            window.electronAPI.getRunningIds()
        ]);
        const runningIds = new Set(runningIdsArr);
        if (token !== profileListLoadToken) return;
        globalSettings = settings || globalSettings;
        if (!globalSettings.preProxies) globalSettings.preProxies = [];
        if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
        if (!globalSettings.savedProfileProxySources) globalSettings.savedProfileProxySources = [];
        if (!globalSettings.savedProfileProxies) globalSettings.savedProfileProxies = [];
        if (token !== profileListLoadToken) return;
        const listEl = document.getElementById('profileList');
        visibleProfileCardCache.clear();

        if (viewMode === 'grid') {
            listEl.classList.add('grid-view');
            document.getElementById('viewIcon').innerHTML = '<path d="M3 10h18M3 14h18M3 18h18M3 6h18" stroke-width="2"/>';
        } else {
            listEl.classList.remove('grid-view');
            document.getElementById('viewIcon').innerHTML = '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>';
        }

        listEl.innerHTML = '';
        const filtered = profiles.filter(p => {
            const text = searchText;
            const proxyBinding = getProfileResolvedProxyBinding(p, globalSettings);
            const effectiveProxyText = String(proxyBinding.proxyStr || p.proxyStr || '').toLowerCase();
            const savedProxyText = [
                proxyBinding.savedProxyName,
                proxyBinding.savedProxyId,
                proxyBinding.savedProxyGroup,
                ...(Array.isArray(proxyBinding.savedProxyTags) ? proxyBinding.savedProxyTags : [])
            ].filter(Boolean).join(' ').toLowerCase();
            // 搜索逻辑增强：支持搜标签
            return p.name.toLowerCase().includes(text) ||
                effectiveProxyText.includes(text) ||
                savedProxyText.includes(text) ||
                (p.tags && p.tags.some(t => t.toLowerCase().includes(text)));
        });
        await warmProfileProxyTestCache(filtered.map((item) => item.id));
        if (token !== profileListLoadToken) return;
        const finalProfiles = filtered.sort(compareProfilesForList);
        visibleListProfileIds = finalProfiles.map((item) => item.id);
        for (const id of Array.from(selectedListProfileIds)) {
            if (!visibleListProfileIds.includes(id)) selectedListProfileIds.delete(id);
        }

        if (finalProfiles.length === 0) {
            const isSearch = searchText.length > 0;
            const msg = isSearch
                ? uiText('没有匹配搜索关键词的环境', 'No profiles match your search')
                : t('emptyStateMsg');
            listEl.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><div class="empty-state-text">${msg}</div></div>`;
            updateProfileSelectionBar();
            return;
        }

        const fragment = document.createDocumentFragment();
        finalProfiles.forEach(p => {
            visibleProfileCardCache.set(p.id, p);
            const fp = p.fingerprint || {};
            const screen = fp.screen || { width: 0, height: 0 };
            const override = p.preProxyOverride || 'default';
            const isRunning = runningIds.has(p.id);
            const proxyBinding = getProfileResolvedProxyBinding(p, globalSettings);

            // 渲染标签 HTML
            let tagsHtml = '';
            if (p.tags && p.tags.length > 0) {
                tagsHtml = p.tags.map(tag =>
                    `<span class="tag" style="background:${stringToColor(tag)}33; color:${stringToColor(tag)}; border:1px solid ${stringToColor(tag)}44;">${tag}</span>`
                ).join('');
            }

            const el = document.createElement('div');
            el.id = `profile-card-${p.id}`;
            el.className = 'profile-item no-drag';
            el.dataset.profileId = p.id;
            const cachedProxyTest = profileProxyTestCache.get(p.id);
            const proxyDotStatus = !cachedProxyTest ? 'untested' : (cachedProxyTest.success ? 'ok' : 'warn');
            const proxyDotTitle = !cachedProxyTest
                ? uiText('点击测试代理', 'Click to test proxy')
                : (cachedProxyTest.success
                    ? uiText('代理正常 · 点击重新测试', 'Proxy OK · Click to retest')
                    : uiText('代理异常 · 点击重新测试', 'Proxy failed · Click to retest'));
            el.innerHTML = `
                <div class="profile-info">
                    <div class="profile-title-row"><h4>${p.name}</h4><span id="status-${p.id}" class="running-badge ${isRunning ? 'active' : ''}">${t('runningStatus')}</span><span class="proxy-status-dot no-drag" data-action="proxy-test" data-id="${p.id}" data-status="${proxyDotStatus}" title="${proxyDotTitle}"></span></div>
                    <div class="profile-meta">
                        ${tagsHtml}
                        <span class="tag">${(proxyBinding.proxyStr || '').split('://')[0].toUpperCase() || 'N/A'}</span>
                        <span class="tag">${screen.width}x${screen.height}</span>
                        <span class="tag" style="border:1px solid var(--accent);">
                            <select class="quick-switch-select no-drag" data-action="quick-preproxy" data-id="${p.id}">
                                <option value="default" ${override === 'default' ? 'selected' : ''}>${t('qsDefault')}</option>
                                <option value="on" ${override === 'on' ? 'selected' : ''}>${t('qsOn')}</option>
                                <option value="off" ${override === 'off' ? 'selected' : ''}>${t('qsOff')}</option>
                            </select>
                        </span>
                    </div>
                </div>
                <div class="actions"><button data-action="launch" data-id="${p.id}" class="no-drag">${t('launch')}</button><button class="outline no-drag" data-action="edit" data-id="${p.id}">${t('edit')}</button><button class="danger no-drag" data-action="delete" data-id="${p.id}">${t('delete')}</button></div>
            `;
            fragment.appendChild(el);
        });
        listEl.appendChild(fragment);
        updateProfileSelectionBar();
        refreshProfileDiagnosticsCards(finalProfiles.slice(0, 15).map((item) => item.id)).then(() => {
            const remaining = finalProfiles.slice(15).map((item) => item.id);
            if (remaining.length > 0 && token === profileListLoadToken) {
                refreshProfileDiagnosticsCards(remaining).catch(() => { });
            }
        }).catch(() => { });
    } catch (e) {
        if (token !== profileListLoadToken) return;
        console.error(e);
    }
}


async function quickUpdatePreProxy(id, val) {
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === id);
    if (p) { p.preProxyOverride = val; await window.electronAPI.updateProfile(p); }
}

async function openAddModal() {
    document.getElementById('addName').value = '';
    document.getElementById('addProxy').value = '';
    document.getElementById('addTags').value = ''; // Clear tags
    document.getElementById('addStartupUrls').value = '';
    document.getElementById('addTimezone').value = 'Auto (No Change)';
    document.getElementById('addResW').value = '';
    document.getElementById('addResH').value = '';
    resetSavedProxyBindingDraft('add');
    clearProxyTestState('add');

    // Initialize location dropdown
    initCustomCityDropdown('addCity', 'addCityDropdown');
    document.getElementById('addCity').value = 'Auto (IP Based)';

    // Initialize language dropdown
    initCustomLanguageDropdown('addLanguage', 'addLanguageDropdown');
    document.getElementById('addLanguage').value = 'Auto (System Default)';

    renderProfileExtensionSelector('add', null, [], true);
    try {
        const settings = await window.electronAPI.getSettings();
        globalSettings = settings || globalSettings;
        renderHeaderPresetSelect('addHeaderPresetId', settings, '');
        renderSavedProfileProxySelect('addSavedProxyId', settings, '');
        renderProfileExtensionSelector('add', settings, [], true);
    } catch (e) { }
    document.getElementById('addGeoPermissionMode').value = 'auto';
    document.getElementById('addCameraPermissionMode').value = 'auto';
    document.getElementById('addMicrophonePermissionMode').value = 'auto';
    document.getElementById('addNotificationPermissionMode').value = 'auto';
    syncSavedProxyBindingInfo('add');

    document.getElementById('addModal').style.display = 'flex';
}
function closeAddModal() {
    document.getElementById('addModal').style.display = 'none';
    resetSavedProxyBindingDraft('add');
    clearProxyTestState('add');
}

function parseStartupUrlsInput(value) {
    return String(value || '')
        .split(/[\r\n]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeExtensionPathList(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of list) {
        const current = String(item || '').trim();
        if (!current || out.includes(current)) continue;
        out.push(current);
    }
    return out;
}

function getProfileExtensionContext(mode) {
    return mode === 'edit'
        ? { listId: 'editProfileExtensionList', toggleId: 'editUseGlobalExtensions' }
        : { listId: 'addProfileExtensionList', toggleId: 'addUseGlobalExtensions' };
}

function getProfileExtensionState(mode) {
    if (!profileExtensionStates[mode]) {
        profileExtensionStates[mode] = { libraryPaths: [], selectedPaths: [], useGlobalExtensions: true };
    }
    return profileExtensionStates[mode];
}

function collectCheckedExtensionPaths(listEl) {
    return normalizeExtensionPathList(Array.from(listEl.querySelectorAll('input[type="checkbox"][data-ext-path]:checked'))
        .map((input) => input.dataset.extPath || ''));
}

function drawProfileExtensionSelector(mode) {
    const { listId, toggleId } = getProfileExtensionContext(mode);
    const listEl = document.getElementById(listId);
    const toggleEl = document.getElementById(toggleId);
    if (!listEl || !toggleEl) return;
    const state = getProfileExtensionState(mode);

    const libraryPaths = normalizeExtensionPathList(state.libraryPaths);
    const selected = normalizeExtensionPathList(state.selectedPaths);
    const useGlobalExtensions = state.useGlobalExtensions !== false;
    const allPaths = normalizeExtensionPathList([...libraryPaths, ...selected]);
    const checkedPaths = useGlobalExtensions
        ? normalizeExtensionPathList([...libraryPaths, ...selected])
        : selected;
    toggleEl.checked = useGlobalExtensions;
    listEl.innerHTML = '';

    if (allPaths.length === 0) {
        listEl.innerHTML = `<div style="font-size:11px; opacity:0.55; padding:8px 10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('settingsExtNoExt'))}</div>`;
        return;
    }

    for (const extPath of allPaths) {
        const row = document.createElement('label');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.gap = '10px';
        row.style.padding = '8px 10px';
        row.style.border = '1px solid rgba(255,255,255,0.08)';
        row.style.borderRadius = '8px';
        row.style.background = 'rgba(255,255,255,0.025)';

        const left = document.createElement('div');
        left.style.minWidth = '0';
        left.style.flex = '1';
        left.style.overflow = 'hidden';

        const title = document.createElement('div');
        title.style.fontSize = '12px';
        title.style.fontWeight = '600';
        title.style.color = 'var(--text-primary)';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.style.whiteSpace = 'nowrap';
        title.textContent = extPath.split(/[\\/]/).pop() || extPath;
        title.title = extPath.split(/[\\/]/).pop() || extPath;

        const pathText = document.createElement('div');
        pathText.style.fontSize = '10px';
        pathText.style.opacity = '0.6';
        pathText.style.overflow = 'hidden';
        pathText.style.textOverflow = 'ellipsis';
        pathText.style.whiteSpace = 'nowrap';
        pathText.textContent = extPath;
        pathText.title = extPath;

        left.appendChild(title);
        left.appendChild(pathText);

        if (!libraryPaths.includes(extPath)) {
            const badge = document.createElement('div');
            badge.style.fontSize = '10px';
            badge.style.color = 'var(--warning, #ffb35c)';
            badge.style.marginTop = '4px';
            badge.textContent = t('profileExtensionSavedOnly');
            left.appendChild(badge);
        }

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checkedPaths.includes(extPath);
        checkbox.dataset.extPath = extPath;
        checkbox.style.flex = '0 0 auto';
        checkbox.disabled = useGlobalExtensions && libraryPaths.includes(extPath);
        checkbox.addEventListener('change', () => {
            const checked = collectCheckedExtensionPaths(listEl);
            if (state.useGlobalExtensions !== false) {
                const savedLibrarySelection = state.selectedPaths.filter(item => libraryPaths.includes(item));
                state.selectedPaths = normalizeExtensionPathList([
                    ...savedLibrarySelection,
                    ...checked.filter(item => !libraryPaths.includes(item))
                ]);
            } else {
                state.selectedPaths = checked;
            }
        });

        row.appendChild(left);
        row.appendChild(checkbox);
        listEl.appendChild(row);
    }
}

function renderProfileExtensionSelector(mode, settings, selectedPaths = [], useGlobalExtensions = true) {
    const { toggleId } = getProfileExtensionContext(mode);
    const toggleEl = document.getElementById(toggleId);
    const libraryPaths = normalizeExtensionPathList(settings && settings.userExtensions);
    const selected = normalizeExtensionPathList(selectedPaths);
    const state = getProfileExtensionState(mode);
    state.libraryPaths = libraryPaths;
    state.selectedPaths = selected.length > 0 ? selected : (useGlobalExtensions !== false ? libraryPaths : []);
    state.useGlobalExtensions = useGlobalExtensions !== false;
    if (toggleEl && !toggleEl.dataset.bound) {
        toggleEl.addEventListener('change', () => {
            state.useGlobalExtensions = toggleEl.checked;
            drawProfileExtensionSelector(mode);
        });
        toggleEl.dataset.bound = 'true';
    }
    drawProfileExtensionSelector(mode);
}

function collectSelectedProfileExtensions(mode) {
    const { listId, toggleId } = getProfileExtensionContext(mode);
    const listEl = document.getElementById(listId);
    const toggleEl = document.getElementById(toggleId);
    if (!listEl) return [];
    const checked = collectCheckedExtensionPaths(listEl);
    const libraryPaths = normalizeExtensionPathList(getProfileExtensionState(mode).libraryPaths);
    if (toggleEl && toggleEl.checked) {
        return checked.filter(item => !libraryPaths.includes(item));
    }
    return checked;
}

function getProxyTestContext(mode) {
    return mode === 'edit'
        ? { inputId: 'editProxy', resultId: 'editProxyTestResult' }
        : { inputId: 'addProxy', resultId: 'addProxyTestResult' };
}

function getProxyTestState(mode) {
    if (!proxyTestStates[mode]) proxyTestStates[mode] = { testedProxy: '', total: 0, inputSnapshot: '', result: null };
    return proxyTestStates[mode];
}

function clearProxyTestState(mode) {
    proxyTestStates[mode] = { testedProxy: '', total: 0, inputSnapshot: '', result: null };
    resetProxyTestResult(mode);
}

function resetProxyTestResult(mode) {
    const { resultId } = getProxyTestContext(mode);
    const el = document.getElementById(resultId);
    if (!el) return;
    el.style.display = 'none';
    el.dataset.status = '';
    el.innerHTML = '';
}

function getFirstProxyLine(value) {
    const lines = String(value || '')
        .split(/[\r\n]+/)
        .map(item => item.trim())
        .filter(Boolean);
    return { first: lines[0] || '', total: lines.length };
}

function normalizeProxyTestInput(value) {
    return String(value || '')
        .split(/[\r\n]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .join('\n');
}

function formatProxyTestMode(mode) {
    const current = String(mode || '').trim().toLowerCase();
    if (current === 'runtime') return uiText('运行中', 'Runtime');
    if (current === 'ephemeral') return uiText('独立测试', 'Ephemeral');
    if (current === 'direct') return uiText('直连', 'Direct');
    if (current === 'testing') return uiText('测试中', 'Testing');
    if (current === 'info') return uiText('提示', 'Info');
    return current || '-';
}

function formatProxyTestCheckedAt(value) {
    const current = Number(value);
    if (!Number.isFinite(current) || current <= 0) return '';
    try {
        return new Date(current).toLocaleString();
    } catch (e) {
        return String(value || '');
    }
}

function setProxyTestResult(mode, result, options = {}) {
    const { resultId } = getProxyTestContext(mode);
    const el = document.getElementById(resultId);
    if (!el) return;

    const current = result && typeof result === 'object' ? result : {};
    const status = String(current.status || '').trim().toLowerCase() || (current.success ? 'ok' : 'warn');
    const tone = status === 'ok'
        ? { border: 'rgba(61, 213, 152, 0.34)', bg: 'rgba(61, 213, 152, 0.08)', text: '#3dd598' }
        : (status === 'info'
            ? { border: 'rgba(255,255,255,0.14)', bg: 'rgba(255,255,255,0.03)', text: 'var(--text-secondary)' }
            : { border: 'rgba(255, 179, 92, 0.34)', bg: 'rgba(255, 179, 92, 0.08)', text: '#ffb35c' });

    const title = options.title || (current.success
        ? uiText('代理可用', 'Proxy reachable')
        : (current.direct ? t('proxyTestNoProxy') : uiText('代理测试失败', 'Proxy test failed')));
    const geo = [current.city, current.region, current.country].filter(Boolean).join(', ');
    const checkedAt = formatProxyTestCheckedAt(current.checkedAt);
    const rows = [
        current.summary ? [t('proxyTestSummaryLine'), current.summary] : null,
        current.ip ? ['IP', current.ip] : null,
        geo ? [uiText('地区', 'Geo'), geo] : null,
        current.timezone ? [uiText('时区', 'Timezone'), current.timezone] : null,
        current.latencyMs != null ? [uiText('延迟', 'Latency'), `${current.latencyMs} ms`] : null,
        current.proxyType ? [uiText('类型', 'Type'), current.proxyType] : null,
        checkedAt ? [uiText('时间', 'Checked'), checkedAt] : null,
        current.org || current.asn ? ['ASN', [current.asn, current.org].filter(Boolean).join(' ')] : null,
        options.showBatchHint ? [uiText('说明', 'Note'), t('proxyTestBatchHint')] : null,
        current.error && !current.success ? [uiText('错误', 'Error'), current.error] : null,
    ].filter(Boolean);

    el.dataset.status = status;
    el.style.display = 'block';
    el.style.borderColor = tone.border;
    el.style.background = tone.bg;
    el.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:${rows.length ? '8px' : '0'};">
            <strong style="color:${tone.text}; font-size:12px;">${escapeHtml(title)}</strong>
            <span style="font-size:11px; opacity:0.7;">${escapeHtml(formatProxyTestMode(current.mode))}</span>
        </div>
        ${rows.map(([label, value]) => `
            <div style="display:grid; grid-template-columns:72px minmax(0,1fr); gap:8px; margin-top:4px;">
                <span style="opacity:0.62;">${escapeHtml(label)}</span>
                <span style="word-break:break-word;">${escapeHtml(value)}</span>
            </div>
        `).join('')}
    `;
}

function syncProxyTestResult(mode) {
    const state = getProxyTestState(mode);
    const { inputId } = getProxyTestContext(mode);
    const input = document.getElementById(inputId);
    if (!input || !state.result) return resetProxyTestResult(mode);
    const { total } = getFirstProxyLine(input.value);
    const inputSnapshot = normalizeProxyTestInput(input.value);
    if (!inputSnapshot) return resetProxyTestResult(mode);
    if (inputSnapshot !== state.inputSnapshot) {
        return setProxyTestResult(mode, {
            success: false,
            status: 'info',
            mode: 'info',
            checkedAt: state.result && state.result.checkedAt,
            summary: uiText('代理内容已变更，请重新测试。', 'Proxy changed after the last test. Retest recommended.')
        }, {
            showBatchHint: total > 1,
            title: uiText('需重新测试', 'Retest required')
        });
    }
    setProxyTestResult(mode, state.result, { showBatchHint: total > 1 });
}

function buildProxySaveWarning(mode) {
    const { inputId } = getProxyTestContext(mode);
    const input = document.getElementById(inputId);
    if (!input) return '';
    const { total } = getFirstProxyLine(input.value);
    const inputSnapshot = normalizeProxyTestInput(input.value);
    if (!inputSnapshot) return '';
    const state = getProxyTestState(mode);
    let msg = '';
    if (!state.result || !state.inputSnapshot) {
        msg = uiText('当前代理尚未测试，仍要保存吗？', 'This proxy has not been tested yet. Save anyway?');
    } else if (inputSnapshot !== state.inputSnapshot) {
        msg = uiText('代理内容已变更，尚未重新测试，仍要保存吗？', 'The proxy changed after the last test. Save anyway?');
    } else if (!state.result.success) {
        msg = uiText('最近一次代理测试失败，仍要保存吗？', 'The last proxy test failed. Save anyway?');
    }
    if (mode === 'add' && total > 1) {
        const extra = uiText('注意：批量创建时仅测试第一行代理。', 'Note: batch create only tests the first proxy line.');
        msg = msg ? `${msg} ${extra}` : extra;
    }
    return msg;
}

async function confirmProxySaveIfNeeded(mode) {
    applySavedProxyFallbackToInput(mode);
    syncSavedProxyBindingInfo(mode);
    const warning = buildProxySaveWarning(mode);
    if (!warning) return true;
    return showConfirmAsync(warning);
}

async function runProxyConfigTest(mode) {
    applySavedProxyFallbackToInput(mode);
    syncSavedProxyBindingInfo(mode);
    const { inputId } = getProxyTestContext(mode);
    const input = document.getElementById(inputId);
    if (!input) return;
    const { first, total } = getFirstProxyLine(input.value);
    setProxyTestResult(mode, {
        success: false,
        status: 'info',
        mode: 'testing',
        summary: t('proxyTestTesting'),
    }, { showBatchHint: total > 1 });
    const result = await window.electronAPI.invoke('test-proxy-config', { proxyStr: first });
    const state = getProxyTestState(mode);
    state.testedProxy = first;
    state.total = total;
    state.inputSnapshot = normalizeProxyTestInput(input.value);
    state.result = result && typeof result === 'object' ? { ...result } : null;
    syncProxyTestResult(mode);
}

async function testAddProxyConfig() {
    return runProxyConfigTest('add');
}

async function testEditProxyConfig() {
    return runProxyConfigTest('edit');
}

async function hydrateEditProxyTestState(profileId, proxyValue) {
    const inputSnapshot = normalizeProxyTestInput(proxyValue);
    if (!profileId || !inputSnapshot) return;
    try {
        const result = await window.electronAPI.invoke('get-profile-proxy-test', profileId);
        if (!result || typeof result !== 'object') return;
        const savedSnapshot = normalizeProxyTestInput(result.proxySnapshot || '');
        if (!savedSnapshot || savedSnapshot !== inputSnapshot) return;
        const { first, total } = getFirstProxyLine(proxyValue);
        const state = getProxyTestState('edit');
        state.testedProxy = first;
        state.total = total;
        state.inputSnapshot = inputSnapshot;
        state.result = { ...result };
        syncProxyTestResult('edit');
    } catch (e) { }
}

async function saveNewProfile() {
    const nameBase = document.getElementById('addName').value.trim();
    const proxyBinding = applySavedProxyFallbackToInput('add');
    const savedProxyId = proxyBinding.savedProxyId || '';
    const proxyText = proxyBinding.proxyText || '';
    const tagsStr = document.getElementById('addTags').value;
    const startupUrls = parseStartupUrlsInput(document.getElementById('addStartupUrls').value);
    const headerPresetId = document.getElementById('addHeaderPresetId').value || '';
    const extensionPaths = collectSelectedProfileExtensions('add');
    const useGlobalExtensions = document.getElementById('addUseGlobalExtensions').checked;
    const geoPermissionMode = document.getElementById('addGeoPermissionMode').value || 'auto';
    const cameraPermissionMode = document.getElementById('addCameraPermissionMode').value || 'auto';
    const microphonePermissionMode = document.getElementById('addMicrophonePermissionMode').value || 'auto';
    const notificationPermissionMode = document.getElementById('addNotificationPermissionMode').value || 'auto';
    const timezoneInput = document.getElementById('addTimezone').value;
    // 将 "Auto (No Change)" 转换为 "Auto" 存储
    const timezone = timezoneInput === 'Auto (No Change)' ? 'Auto' : timezoneInput;

    // Get city/location value
    const cityInput = document.getElementById('addCity').value;
    let city = null;
    let geolocation = null;
    if (cityInput && cityInput !== 'Auto (IP Based)') {
        const cityData = window.CITY_DATA ? window.CITY_DATA.find(c => c.name === cityInput) : null;
        if (cityData) {
            city = cityData.name;
            geolocation = { latitude: cityData.lat, longitude: cityData.lng, accuracy: 100 };
        }
    }

    // Get language value
    const languageInput = document.getElementById('addLanguage').value;
    const language = getLanguageCode(languageInput);
    const resW = Number.parseInt(document.getElementById('addResW').value, 10);
    const resH = Number.parseInt(document.getElementById('addResH').value, 10);
    const screen = (Number.isFinite(resW) && resW > 0 && Number.isFinite(resH) && resH > 0)
        ? { width: resW, height: resH }
        : undefined;

    const tags = tagsStr.split(/[,，]/).map(s => s.trim()).filter(s => s);

    // 分割多行代理链接
    const proxyLines = proxyText.split('\n').map(l => l.trim()).filter(l => l);
    const createDirectProfile = proxyLines.length === 0;

    if (savedProxyId && proxyLines.length > 1) {
        return showAlert(t('savedProxyBatchNotSupported'));
    }
    if (createDirectProfile && !nameBase) {
        return showAlert(t('inputReq'));
    }
    if (!await confirmProxySaveIfNeeded('add')) return;

    // 批量创建环境
    let createdCount = 0;
    const profileInputs = createDirectProfile ? [''] : proxyLines;
    for (let i = 0; i < profileInputs.length; i++) {
        const proxyStr = profileInputs[i];
        let name;

        if (!nameBase) {
            // 无名称输入，使用代理备注
            name = getProxyRemark(proxyStr) || `Profile-${String(i + 1).padStart(2, '0')}`;
        } else if (profileInputs.length === 1) {
            // 单个代理，使用输入名称
            name = nameBase;
        } else {
            // 多个代理，添加序号
            name = `${nameBase}-${String(i + 1).padStart(2, '0')}`;
        }

        try {
            await window.electronAPI.saveProfile({ name, proxyStr, savedProxyId, tags, startupUrls, headerPresetId, extensionPaths, useGlobalExtensions, geoPermissionMode, cameraPermissionMode, microphonePermissionMode, notificationPermissionMode, timezone, city, geolocation, language, screen });
            createdCount++;
        } catch (e) {
            console.error(`Failed to create profile ${name}:`, e);
        }
    }

    await refreshSavedProfileProxyUsageCounts();
    if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
    closeAddModal();
    await loadProfiles();

    if (profileInputs.length > 1) {
        showAlert(`${t('msgBatchCreated') || '批量创建成功'}: ${createdCount} ${t('msgProfiles') || '个环境'}`);
    }
}

async function launch(id) {
    try {
        const watermarkStyle = localStorage.getItem('geekez_watermark_style') || 'enhanced';
        const msg = await window.electronAPI.launchProfile(id, watermarkStyle, curLang);
        if (msg && msg.includes(':')) showAlert(msg);
    } catch (e) { showAlert('Error: ' + e.message); }
}

function remove(id) {
    showConfirm(t('confirmDel'), async () => {
        await window.electronAPI.deleteProfile(id);
        await refreshSavedProfileProxyUsageCounts();
        if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
        await loadProfiles();
    });
}

function parseEditorSize(value, fallback) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getEditorWorkArea() {
    return {
        width: parseEditorSize(window.screen && window.screen.availWidth, 1366),
        height: parseEditorSize(window.screen && window.screen.availHeight, 768)
    };
}

function fitWindowSizeForEditor(size, workArea = getEditorWorkArea()) {
    const area = {
        width: parseEditorSize(workArea && workArea.width, 1366),
        height: parseEditorSize(workArea && workArea.height, 768)
    };
    const raw = {
        width: parseEditorSize(size && size.width, 1280),
        height: parseEditorSize(size && size.height, 720)
    };
    const marginX = area.width >= 1440 ? 80 : 48;
    const marginY = area.height >= 900 ? 96 : 64;

    let maxWidth = area.width - marginX;
    let maxHeight = area.height - marginY;
    if (maxWidth < 320) maxWidth = area.width;
    if (maxHeight < 240) maxHeight = area.height;

    return {
        width: Math.max(Math.min(raw.width, maxWidth), Math.min(320, maxWidth)),
        height: Math.max(Math.min(raw.height, maxHeight), Math.min(240, maxHeight))
    };
}

function sanitizeEditorWindowSize(size, fallback) {
    const base = fallback || { width: 1280, height: 720 };
    return {
        width: parseEditorSize(size && size.width, base.width),
        height: parseEditorSize(size && size.height, base.height)
    };
}

function isMirroredEditorWindow(fp) {
    if (!fp || !fp.screen || !fp.window) return true;
    const screenWidth = parseEditorSize(fp.screen.width, 1920);
    const screenHeight = parseEditorSize(fp.screen.height, 1080);
    const windowWidth = parseEditorSize(fp.window.width, screenWidth);
    const windowHeight = parseEditorSize(fp.window.height, screenHeight);
    return screenWidth === windowWidth && screenHeight === windowHeight;
}

function resolveEditWindowSize(fp) {
    if (fp && fp.window && !isMirroredEditorWindow(fp)) {
        return sanitizeEditorWindowSize(fp.window, { width: 1280, height: 720 });
    }
    return fitWindowSizeForEditor({ width: 1280, height: 720 });
}

function renderHeaderPresetSelect(selectId, settings, selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const presets = Array.isArray(settings && settings.headerPresets) ? settings.headerPresets : [];
    const options = [`<option value="">${escapeHtml(t('noneOption'))}</option>`].concat(
        presets.map(preset => `<option value="${preset.id}">${escapeHtml(preset.name)}${preset.enabled === false ? ` (${escapeHtml(t('disabledLabel'))})` : ''}</option>`)
    );
    select.innerHTML = options.join('');
    select.value = selectedId || '';
}

function renderSavedProfileProxySelect(selectId, settings, selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const proxies = getSavedProfileProxyLibrary(settings);
    const options = [`<option value="">${escapeHtml(t('proxySourceManual'))}</option>`].concat(
        proxies.map((proxy) => `<option value="${escapeHtml(proxy.id)}">${escapeHtml(getSavedProfileProxyDisplayName(proxy) || proxy.id)}${proxy.enabled === false ? ` (${escapeHtml(t('disabledLabel'))})` : ''}</option>`)
    );
    const normalizedSelectedId = normalizeSavedProxyId(selectedId);
    if (normalizedSelectedId && !proxies.some((proxy) => proxy.id === normalizedSelectedId)) {
        options.push(`<option value="${escapeHtml(normalizedSelectedId)}">${escapeHtml(`${normalizedSelectedId} (${t('savedProxyMissingOption')})`)}</option>`);
    }
    select.innerHTML = options.join('');
    select.value = normalizedSelectedId || '';
}

function getProxyBindingContext(mode) {
    return mode === 'edit'
        ? { selectId: 'editSavedProxyId', infoId: 'editSavedProxyInfo', inputId: 'editProxy' }
        : { selectId: 'addSavedProxyId', infoId: 'addSavedProxyInfo', inputId: 'addProxy' };
}

function resetSavedProxyBindingDraft(mode) {
    const { inputId } = getProxyBindingContext(mode);
    const input = document.getElementById(inputId);
    if (!input) return;
    delete input.dataset.manualProxyDraft;
    delete input.dataset.boundSavedProxyId;
    input.readOnly = false;
    input.style.opacity = '1';
}

function updateSavedProxyManualDraft(mode, settings = globalSettings) {
    const { selectId, inputId } = getProxyBindingContext(mode);
    const select = document.getElementById(selectId);
    const input = document.getElementById(inputId);
    if (!input) return;
    const selectedId = normalizeSavedProxyId(select && select.value);
    if (!selectedId || !findSavedProfileProxyById(settings, selectedId)) {
        input.dataset.manualProxyDraft = String(input.value || '');
    }
}

function applySavedProxyFallbackToInput(mode, settings = globalSettings, options = {}) {
    const { selectId, inputId } = getProxyBindingContext(mode);
    const select = document.getElementById(selectId);
    const input = document.getElementById(inputId);
    if (!select || !input) return { savedProxyId: '', savedProxy: null, proxyText: String(input && input.value || '').trim() };
    const selectedId = normalizeSavedProxyId(select.value);
    const savedProxy = findSavedProfileProxyById(settings, selectedId);
    const previousBoundId = normalizeSavedProxyId(input.dataset.boundSavedProxyId);
    const hadSavedBinding = !!previousBoundId || input.readOnly;
    if (savedProxy) {
        if (!input.readOnly) input.dataset.manualProxyDraft = String(input.value || '');
        if (options.force || !String(input.value || '').trim() || previousBoundId !== savedProxy.id || input.readOnly) {
            input.value = savedProxy.proxyStr || '';
        }
        input.dataset.boundSavedProxyId = savedProxy.id;
    } else if (hadSavedBinding && Object.prototype.hasOwnProperty.call(input.dataset, 'manualProxyDraft')) {
        input.value = String(input.dataset.manualProxyDraft || '');
        delete input.dataset.boundSavedProxyId;
    } else if (!selectedId) {
        delete input.dataset.boundSavedProxyId;
    }
    return {
        savedProxyId: selectedId,
        savedProxy,
        proxyText: String(input.value || '').trim(),
    };
}

function syncSavedProxyBindingInfo(mode, settings = globalSettings) {
    const { selectId, infoId, inputId } = getProxyBindingContext(mode);
    const select = document.getElementById(selectId);
    const info = document.getElementById(infoId);
    const input = document.getElementById(inputId);
    if (!select || !info || !input) return;
    const savedProxy = findSavedProfileProxyById(settings, select.value);
    if (!select.value) {
        input.readOnly = false;
        input.style.opacity = '1';
        input.dataset.manualProxyDraft = String(input.value || '');
        info.textContent = t('proxySourceManualHint');
        return;
    }
    if (!savedProxy) {
        input.readOnly = false;
        input.style.opacity = '1';
        input.dataset.manualProxyDraft = String(input.value || '');
        info.textContent = t('savedProxyMissingHint');
        return;
    }
    input.readOnly = true;
    input.style.opacity = '0.72';
    const hint = String(input.value || '').trim()
        ? t('savedProxyBoundHintWithFallback')
        : t('savedProxyBoundHint');
    info.textContent = `${getSavedProfileProxyDisplayName(savedProxy) || savedProxy.id} · ${hint}`;
}

function handleSavedProfileProxyChange(mode) {
    applySavedProxyFallbackToInput(mode, globalSettings, { force: true });
    syncSavedProxyBindingInfo(mode);
    syncProxyTestResult(mode);
}

const HEADER_RULE_RESOURCE_TYPES = [
    'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr',
    'fetch', 'prefetch', 'eventsource', 'websocket', 'manifest', 'signedexchange',
    'ping', 'cspviolationreport', 'preflight', 'other'
];
let advancedPresetState = { headerPresets: [], diagnosticPresets: [], savedProfileProxySources: [], savedProfileProxies: [] };
let advancedPresetEventsBound = false;
let savedProfileProxyEditorFilters = { search: '', group: '', status: 'all', sort: 'name-asc' };

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function splitPresetTextList(value) {
    return String(value || '')
        .split(/[\n,]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createEditorId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function slugifySavedProfileProxyEditorId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildUniqueSavedProfileProxyEditorId(baseId = 'saved-proxy') {
    const currentIds = new Set(
        (Array.isArray(advancedPresetState && advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
            .filter(Boolean)
    );
    const rawBase = slugifySavedProfileProxyEditorId(baseId) || 'saved-proxy';
    if (!currentIds.has(rawBase)) return rawBase;
    let index = 1;
    while (currentIds.has(`${rawBase}-${index}`)) index++;
    return `${rawBase}-${index}`;
}

function buildUniqueSavedProfileProxyEditorIdWithStart(baseId = 'saved-proxy', index = 0, startIndex = 1) {
    const currentIds = new Set(
        (Array.isArray(advancedPresetState && advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
            .filter(Boolean)
    );
    const rawBase = slugifySavedProfileProxyEditorId(baseId) || 'saved-proxy';
    let nextIndex = normalizeSavedProfileProxyImportStartIndex(startIndex) + Math.max(0, Number.parseInt(index, 10) || 0);
    let candidate = `${rawBase}-${nextIndex}`;
    while (currentIds.has(candidate)) {
        nextIndex++;
        candidate = `${rawBase}-${nextIndex}`;
    }
    return candidate;
}

function buildSavedProfileProxyImportIdBase(proxyStr, options = {}) {
    const prefixBase = slugifySavedProfileProxyEditorId(options && options.prefix);
    if (prefixBase) return prefixBase;
    const groupBase = slugifySavedProfileProxyEditorId(options && options.group);
    if (groupBase) return groupBase;
    const type = detectSavedProxyType(proxyStr);
    const typeBase = slugifySavedProfileProxyEditorId(type && type !== 'UNKNOWN' && type !== 'DIRECT'
        ? `${type.toLowerCase()}-proxy`
        : 'saved-proxy');
    return typeBase || 'saved-proxy';
}

function createHeaderRuleDraft() {
    return {
        id: createEditorId('rule'),
        enabled: true,
        match: { hosts: [], resourceTypes: [] },
        action: 'set',
        header: '',
        valueTemplate: ''
    };
}

function createHeaderPresetDraft() {
    return {
        id: createEditorId('preset'),
        name: t('newHeaderPresetName'),
        enabled: true,
        rules: [createHeaderRuleDraft()]
    };
}

function createDiagnosticPresetDraft() {
    return {
        id: createEditorId('diagnostic'),
        name: t('newDiagnosticPresetName'),
        url: 'https://',
        enabled: true
    };
}

function createSavedProfileProxyDraft() {
    return {
        id: createEditorId('saved-proxy'),
        name: t('newSavedProxyName'),
        proxyStr: '',
        tags: [],
        group: '',
        notes: '',
        changeIpUrl: '',
        sourceId: '',
        sourceName: '',
        sourceImportedAt: 0,
        sourceStale: false,
        sourceMissingSince: 0,
        enabled: true
    };
}

function createSavedProfileProxySourceDraft() {
    return {
        id: createEditorId('saved-proxy-source'),
        name: t('newSavedProxySourceName'),
        url: 'https://',
        format: 'auto',
        stalePolicy: 'disable',
        prefix: '',
        startIndex: 1,
        group: '',
        tags: [],
        enabled: true,
        autoCheck: false,
        scheduleEnabled: false,
        scheduleIntervalMinutes: 60,
        autoQuarantineOnRefresh: false,
        autoRecheckQuarantinedOnRefresh: false,
        lastImportedAt: 0,
        lastImportCount: 0,
        lastImportError: '',
        lastSyncStatus: 'ok',
        lastSyncAt: 0,
        lastSyncFormat: 'auto',
        lastSyncTotalLines: 0,
        lastSyncAddedCount: 0,
        lastSyncDuplicateCount: 0,
        lastSyncLinkedCount: 0,
        lastSyncStaleCount: 0,
        lastSyncReactivatedCount: 0,
        lastSyncInvalidCount: 0,
        lastSyncPolicyMode: 'disable',
        lastSyncPolicyAffectedCount: 0,
        lastSyncError: '',
        lastMaintenanceAt: 0,
        lastMaintenanceStatus: 'idle',
        lastMaintenanceTrigger: '',
        lastMaintenanceError: '',
        lastMaintenanceQuarantinedCount: 0,
        lastMaintenanceRecoveredCount: 0,
        syncHistory: [],
        maintenanceHistory: [],
    };
}

function normalizeSavedProfileProxySourceStalePolicy(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['mark', 'disable', 'detach'].includes(current) ? current : 'disable';
}

function normalizeSavedProfileProxySourceScheduleIntervalMinutes(value) {
    const current = Number(value);
    if (!Number.isFinite(current) || current <= 0) return 0;
    return Math.min(10080, Math.max(5, Math.round(current)));
}

function normalizeSavedProfileProxySourceMaintenanceStatus(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['idle', 'ok', 'error'].includes(current) ? current : 'idle';
}

function formatSavedProfileProxySourceMaintenanceTrigger(value) {
    const current = String(value || '').trim().toLowerCase();
    if (current === 'scheduler') return t('savedProxySourceMaintenanceTriggerScheduler');
    if (current === 'manual') return t('savedProxySourceMaintenanceTriggerManual');
    return t('savedProxySourceMaintenanceTriggerUnknown');
}

function normalizeSavedProfileProxySourceMaintenanceEntry(entry) {
    const current = entry && typeof entry === 'object' ? entry : {};
    const ranAt = Number(current.ranAt);
    const toCount = (value) => {
        const currentValue = Number(value);
        return Number.isFinite(currentValue) && currentValue >= 0 ? Math.round(currentValue) : 0;
    };
    return {
        ranAt: Number.isFinite(ranAt) && ranAt > 0 ? Math.round(ranAt) : 0,
        status: normalizeSavedProfileProxySourceMaintenanceStatus(current.status),
        trigger: String(current.trigger || '').trim().toLowerCase(),
        quarantinedCount: toCount(current.quarantinedCount),
        recoveredCount: toCount(current.recoveredCount),
        candidateCountAfter: toCount(current.candidateCountAfter),
        quarantinedCountAfter: toCount(current.quarantinedCountAfter),
        error: String(current.error || '').trim(),
    };
}

function normalizeSavedProfileProxySourceMaintenanceHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceMaintenanceEntry(item))
        .filter((item) => item.ranAt > 0)
        .sort((a, b) => b.ranAt - a.ranAt)
        .slice(0, 10);
}

function getSavedProfileProxySourceMaintenanceBaseTime(source) {
    return Math.max(
        Number(source && source.lastMaintenanceAt) || 0,
        Number(source && source.lastSyncAt) || 0,
        Number(source && source.lastImportedAt) || 0,
    );
}

function getSavedProfileProxySourceScheduleState(source) {
    const scheduleEnabled = source && source.scheduleEnabled === true;
    const intervalMinutes = normalizeSavedProfileProxySourceScheduleIntervalMinutes(source && source.scheduleIntervalMinutes) || 0;
    const displayIntervalMinutes = intervalMinutes || 60;
    const effectiveIntervalMinutes = scheduleEnabled ? displayIntervalMinutes : intervalMinutes;
    const baseTime = getSavedProfileProxySourceMaintenanceBaseTime(source);
    const nextDueAt = scheduleEnabled && effectiveIntervalMinutes > 0 && baseTime > 0
        ? baseTime + effectiveIntervalMinutes * 60 * 1000
        : 0;
    const isDueNow = scheduleEnabled && effectiveIntervalMinutes > 0 && baseTime <= 0;
    const delta = nextDueAt > 0 ? nextDueAt - Date.now() : 0;
    const isOverdue = scheduleEnabled && !isDueNow && nextDueAt > 0 && delta <= 0;
    return {
        scheduleEnabled,
        intervalMinutes,
        displayIntervalMinutes,
        effectiveIntervalMinutes,
        baseTime,
        nextDueAt,
        delta,
        isDueNow,
        isOverdue,
    };
}

function normalizeSavedProfileProxySourceHistoryEntry(entry) {
    const current = entry && typeof entry === 'object' ? entry : {};
    const syncedAt = Number(current.syncedAt);
    const toCount = (value) => {
        const currentValue = Number(value);
        return Number.isFinite(currentValue) && currentValue >= 0 ? Math.round(currentValue) : 0;
    };
    return {
        syncedAt: Number.isFinite(syncedAt) && syncedAt > 0 ? Math.round(syncedAt) : 0,
        status: String(current.status || '').trim().toLowerCase() === 'error' ? 'error' : 'ok',
        format: normalizeSavedProfileProxyImportFormat(current.format),
        totalLines: toCount(current.totalLines),
        addedCount: toCount(current.addedCount),
        duplicateCount: toCount(current.duplicateCount),
        linkedCount: toCount(current.linkedCount),
        staleCount: toCount(current.staleCount),
        reactivatedCount: toCount(current.reactivatedCount),
        invalidCount: toCount(current.invalidCount),
        policyMode: normalizeSavedProfileProxySourceStalePolicy(current.policyMode),
        policyAffectedCount: toCount(current.policyAffectedCount),
        error: String(current.error || '').trim(),
    };
}

function normalizeSavedProfileProxySourceHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceHistoryEntry(item))
        .filter((item) => item.syncedAt > 0)
        .sort((a, b) => b.syncedAt - a.syncedAt)
        .slice(0, 10);
}

function pushSavedProfileProxySourceHistoryEntryDraft(source, entry) {
    if (!source) return [];
    const normalized = normalizeSavedProfileProxySourceHistoryEntry(entry);
    source.lastSyncStatus = normalized.status;
    source.lastSyncAt = normalized.syncedAt;
    source.lastSyncFormat = normalized.format;
    source.lastSyncTotalLines = normalized.totalLines;
    source.lastSyncAddedCount = normalized.addedCount;
    source.lastSyncDuplicateCount = normalized.duplicateCount;
    source.lastSyncLinkedCount = normalized.linkedCount;
    source.lastSyncStaleCount = normalized.staleCount;
    source.lastSyncReactivatedCount = normalized.reactivatedCount;
    source.lastSyncInvalidCount = normalized.invalidCount;
    source.lastSyncPolicyMode = normalized.policyMode;
    source.lastSyncPolicyAffectedCount = normalized.policyAffectedCount;
    source.lastSyncError = normalized.error;
    source.syncHistory = normalizeSavedProfileProxySourceHistory([
        normalized,
        ...(Array.isArray(source.syncHistory) ? source.syncHistory : []),
    ]);
    return source.syncHistory;
}

function buildSavedProfileProxySourceLastSyncMarkup(source) {
    const lastSyncAt = Number(source && source.lastSyncAt) || 0;
    if (!lastSyncAt) {
        return `<div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceLastSyncEmpty'))}</div>`;
    }
    const lastSyncFormat = normalizeSavedProfileProxyImportFormat(source && source.lastSyncFormat);
    const lastSyncStatus = String(source && source.lastSyncStatus || '').trim().toLowerCase() === 'error' ? 'error' : 'ok';
    const lastSyncPolicyMode = normalizeSavedProfileProxySourceStalePolicy(source && source.lastSyncPolicyMode);
    const metric = (label, value, color = 'var(--text-primary)') => `
        <div style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.14);">
            <div style="font-size:11px; opacity:0.7; margin-bottom:4px;">${escapeHtml(label)}</div>
            <div style="font-size:12px; color:${color};">${escapeHtml(String(Math.max(0, Number(value) || 0)))}</div>
        </div>
    `;
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                <span><strong>${escapeHtml(t('savedProxySourceLastImportedLabel'))}:</strong> ${escapeHtml(formatDiagTime(lastSyncAt))}</span>
                <span><strong>${escapeHtml(t('savedProxySourceHistoryStatusLabel'))}:</strong> ${escapeHtml(lastSyncStatus === 'error' ? t('savedProxySourceHistoryStatusError') : t('savedProxySourceHistoryStatusOk'))}</span>
                <span><strong>${escapeHtml(t('savedProxySourceLastSyncFormatLabel'))}:</strong> ${escapeHtml(String(lastSyncFormat || 'auto').toUpperCase())}</span>
                <span><strong>${escapeHtml(t('savedProxySourceLastSyncTotalLinesLabel'))}:</strong> ${escapeHtml(String(Math.max(0, Number(source && source.lastSyncTotalLines) || 0)))}</span>
                <span><strong>${escapeHtml(t('savedProxySourceHistoryPolicyLabel'))}:</strong> ${escapeHtml(t(`savedProxySourcePolicy${lastSyncPolicyMode.charAt(0).toUpperCase()}${lastSyncPolicyMode.slice(1)}`))}</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px;">
                ${metric(t('savedProxySourceLastSyncAddedLabel'), source && source.lastSyncAddedCount)}
                ${metric(t('savedProxySourceLastSyncDuplicateLabel'), source && source.lastSyncDuplicateCount)}
                ${metric(t('savedProxySourceLastSyncLinkedLabel'), source && source.lastSyncLinkedCount)}
                ${metric(t('savedProxySourceLastSyncStaleLabel'), source && source.lastSyncStaleCount, Number(source && source.lastSyncStaleCount) > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceLastSyncReactivatedLabel'), source && source.lastSyncReactivatedCount)}
                ${metric(t('savedProxySourceLastSyncInvalidLabel'), source && source.lastSyncInvalidCount, Number(source && source.lastSyncInvalidCount) > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceHistoryPolicyAffectedLabel'), source && source.lastSyncPolicyAffectedCount, Number(source && source.lastSyncPolicyAffectedCount) > 0 ? 'var(--warning)' : 'var(--text-primary)')}
            </div>
            ${String(source && (source.lastSyncError || source.lastImportError) || '').trim()
                ? `<div style="font-size:12px; color:var(--warning); line-height:1.5;">${escapeHtml(String(source && (source.lastSyncError || source.lastImportError) || '').trim())}</div>`
                : ''}
        </div>
    `;
}

function buildSavedProfileProxySourceMaintenanceMarkup(source) {
    const lastMaintenanceAt = Number(source && source.lastMaintenanceAt) || 0;
    if (!lastMaintenanceAt) {
        return `<div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceMaintenanceEmpty'))}</div>`;
    }
    const status = normalizeSavedProfileProxySourceMaintenanceStatus(source && source.lastMaintenanceStatus);
    const trigger = formatSavedProfileProxySourceMaintenanceTrigger(source && source.lastMaintenanceTrigger);
    const quarantinedCount = Math.max(0, Number(source && source.lastMaintenanceQuarantinedCount) || 0);
    const recoveredCount = Math.max(0, Number(source && source.lastMaintenanceRecoveredCount) || 0);
    const error = String(source && source.lastMaintenanceError || '').trim();
    const statusLabel = status === 'error'
        ? t('savedProxySourceHistoryStatusError')
        : (status === 'ok' ? t('savedProxySourceHistoryStatusOk') : t('savedProxySourceMaintenanceStatusIdle'));
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                <span><strong>${escapeHtml(t('savedProxySourceMaintenanceLastRunLabel'))}:</strong> ${escapeHtml(formatDiagTime(lastMaintenanceAt))}</span>
                <span><strong>${escapeHtml(t('savedProxySourceHistoryStatusLabel'))}:</strong> ${escapeHtml(statusLabel)}</span>
                <span><strong>${escapeHtml(t('savedProxySourceMaintenanceTriggerLabel'))}:</strong> ${escapeHtml(trigger)}</span>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:11px; opacity:0.8;">
                <span>${escapeHtml(`${t('savedProxySourceMaintenanceQuarantinedLabel')}: ${quarantinedCount}`)}</span>
                <span>${escapeHtml(`${t('savedProxySourceMaintenanceRecoveredLabel')}: ${recoveredCount}`)}</span>
            </div>
            ${error ? `<div style="font-size:12px; color:var(--warning); line-height:1.5;">${escapeHtml(error)}</div>` : ''}
        </div>
    `;
}

function buildSavedProfileProxySourceScheduleSummaryMarkup(source) {
    const scheduleState = getSavedProfileProxySourceScheduleState(source);
    const scheduleEnabled = scheduleState.scheduleEnabled;
    const displayIntervalMinutes = scheduleState.displayIntervalMinutes;
    const nextDueAt = scheduleState.nextDueAt;
    const delta = scheduleState.delta;
    const isDueNow = scheduleState.isDueNow;
    const isOverdue = scheduleState.isOverdue;
    const tone = !scheduleEnabled
        ? 'var(--border)'
        : (isDueNow || isOverdue ? 'rgba(255,183,77,0.35)' : 'rgba(76,175,80,0.28)');
    const background = !scheduleEnabled
        ? 'rgba(0,0,0,0.12)'
        : (isDueNow || isOverdue ? 'rgba(255,183,77,0.08)' : 'rgba(76,175,80,0.08)');
    const stateLabel = scheduleEnabled
        ? t('savedProxySourceScheduleStateEnabled')
        : t('savedProxySourceScheduleStateDisabled');
    const nextDueLabel = !scheduleEnabled
        ? t('savedProxySourceScheduleStateDisabled')
        : (isDueNow
            ? t('savedProxySourceScheduleDueNow')
            : (nextDueAt > 0 ? formatDiagTime(nextDueAt) : t('savedProxySourceScheduleDueNow')));
    const timingLabel = !scheduleEnabled
        ? t('savedProxySourceScheduleDisabledHint')
        : (isDueNow
            ? t('savedProxySourceScheduleDueNow')
            : (isOverdue
                ? t('savedProxySourceScheduleOverdueBy').replace('{value}', formatRelativeDuration(Math.abs(delta)))
                : t('savedProxySourceScheduleDueIn').replace('{value}', formatRelativeDuration(delta))));
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid ${tone}; border-radius:8px; background:${background};">
            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                <span><strong>${escapeHtml(t('savedProxySourceHistoryStatusLabel'))}:</strong> ${escapeHtml(stateLabel)}</span>
                <span><strong>${escapeHtml(t('savedProxySourceScheduleIntervalLabel'))}:</strong> ${escapeHtml(t('savedProxySourceScheduleEveryValue').replace('{count}', String(displayIntervalMinutes)))}</span>
                <span><strong>${escapeHtml(t('savedProxySourceScheduleNextDueLabel'))}:</strong> ${escapeHtml(nextDueLabel)}</span>
            </div>
            <div style="font-size:11px; opacity:0.82; color:${scheduleEnabled && (isDueNow || isOverdue) ? 'var(--warning)' : 'var(--text-primary)'};">
                ${escapeHtml(timingLabel)}
            </div>
        </div>
    `;
}

function getSavedProfileProxySourceOperationsOverview(sources) {
    const summary = {
        total: 0,
        enabled: 0,
        scheduled: 0,
        dueNow: 0,
        overdue: 0,
        maintenanceErrors: 0,
        warn: 0,
        candidate: 0,
        quarantined: 0,
        attentionSources: 0,
    };
    for (const source of Array.isArray(sources) ? sources : []) {
        if (!source) continue;
        summary.total++;
        if (source.enabled !== false) summary.enabled++;
        const scheduleState = getSavedProfileProxySourceScheduleState(source);
        if (scheduleState.scheduleEnabled) summary.scheduled++;
        if (scheduleState.isDueNow) summary.dueNow++;
        if (scheduleState.isOverdue) summary.overdue++;
        if (normalizeSavedProfileProxySourceMaintenanceStatus(source.lastMaintenanceStatus) === 'error') {
            summary.maintenanceErrors++;
        }
        const health = getSavedProfileProxySourceHealthSummary(source.id);
        summary.warn += health.warn;
        summary.candidate += health.candidate;
        summary.quarantined += health.quarantined;
        if (
            scheduleState.isDueNow
            || scheduleState.isOverdue
            || normalizeSavedProfileProxySourceMaintenanceStatus(source.lastMaintenanceStatus) === 'error'
            || health.candidate > 0
        ) {
            summary.attentionSources++;
        }
    }
    return summary;
}

function getSavedProfileProxySourceAttentionEntries(sources) {
    const entries = [];
    for (const source of Array.isArray(sources) ? sources : []) {
        if (!source) continue;
        const sourceId = normalizeSavedProfileProxySourceId(source && source.id);
        const label = String(source && (source.name || source.id) || '').trim() || sourceId;
        const scheduleState = getSavedProfileProxySourceScheduleState(source);
        const health = sourceId ? getSavedProfileProxySourceHealthSummary(sourceId) : { candidate: 0 };
        const issues = [];
        const reasons = [];
        if (scheduleState.isDueNow) {
            issues.push(t('savedProxySourceAlertDueNow'));
            reasons.push('due-now');
        } else if (scheduleState.isOverdue) {
            issues.push(t('savedProxySourceAlertOverdue').replace('{value}', formatRelativeDuration(Math.abs(scheduleState.delta))));
            reasons.push('overdue');
        }
        if (normalizeSavedProfileProxySourceMaintenanceStatus(source.lastMaintenanceStatus) === 'error') {
            const reason = String(source.lastMaintenanceError || '').trim();
            issues.push(reason
                ? t('savedProxySourceAlertMaintenanceErrorWithReason').replace('{reason}', reason)
                : t('savedProxySourceAlertMaintenanceError'));
            reasons.push('error');
        }
        if (health.candidate > 0) {
            issues.push(t('savedProxySourceAlertCandidates').replace('{count}', String(health.candidate)));
            reasons.push('candidate');
        }
        if (issues.length === 0) continue;
        entries.push({
            id: sourceId,
            label,
            issues,
            reasons,
            candidateCount: Math.max(0, Number(health.candidate) || 0),
            persisted: !!sourceId && savedProfileProxySourceOriginalIds.has(sourceId),
        });
    }
    return entries;
}

function getSavedProfileProxySourceBulkMaintenanceTargets(sources) {
    return getSavedProfileProxySourceAttentionEntries(sources)
        .filter((entry) => entry.persisted)
        .map((entry) => ({
            id: entry.id,
            label: entry.label,
            reasons: Array.isArray(entry.reasons) ? entry.reasons.slice() : [],
        }));
}

function summarizeSavedProfileProxySourceBulkMaintenanceTargets(targets) {
    const summary = { due: 0, overdue: 0, error: 0, candidate: 0 };
    for (const target of Array.isArray(targets) ? targets : []) {
        const reasons = Array.isArray(target && target.reasons) ? target.reasons : [];
        if (reasons.includes('due-now')) summary.due++;
        if (reasons.includes('overdue')) summary.overdue++;
        if (reasons.includes('error')) summary.error++;
        if (reasons.includes('candidate')) summary.candidate++;
    }
    return summary;
}

function getSavedProfileProxySourceOverviewActionTargets(sources) {
    const dueSources = [];
    const candidateEntries = [];
    const quarantinedEntries = [];
    const candidateSourceIds = new Set();
    const quarantinedSourceIds = new Set();
    for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
        if (!source) continue;
        const sourceId = normalizeSavedProfileProxySourceId(source && source.id);
        const label = String(source && (source.name || source.id) || '').trim() || uiText(`来源 #${index + 1}`, `Source #${index + 1}`);
        const scheduleState = getSavedProfileProxySourceScheduleState(source);
        const sourceUrl = String(source && source.url || '').trim();
        if (source.enabled !== false && sourceUrl && (scheduleState.isDueNow || scheduleState.isOverdue)) {
            dueSources.push({
                index,
                id: sourceId,
                label,
                dueNow: scheduleState.isDueNow,
                overdue: scheduleState.isOverdue,
            });
        }
        if (!sourceId) continue;
        for (const proxy of getSavedProfileProxyEntriesForSource(sourceId)) {
            const proxyId = normalizeSavedProxyId(proxy && proxy.id);
            const result = savedProfileProxyTestCache.get(proxyId);
            if (isSavedProfileProxyQuarantineCandidate(proxy, result)) {
                candidateEntries.push(proxy);
                candidateSourceIds.add(sourceId);
                continue;
            }
            if (isSavedProfileProxyQuarantined(proxy, result)) {
                quarantinedEntries.push(proxy);
                quarantinedSourceIds.add(sourceId);
            }
        }
    }
    return {
        dueSources,
        candidateEntries,
        quarantinedEntries,
        candidateSourceCount: candidateSourceIds.size,
        quarantinedSourceCount: quarantinedSourceIds.size,
    };
}

function updateSavedProfileProxySourceAttentionBadges(sources) {
    const summary = getSavedProfileProxySourceOperationsOverview(sources);
    const count = Math.max(
        Number(summary.attentionSources || 0),
        Number(summary.overdue || 0),
        Number(summary.maintenanceErrors || 0)
    );
    const displayCount = count > 99 ? '99+' : String(count);
    const title = count > 0
        ? t('savedProxySourceAttentionBadgeTitle').replace('{count}', String(count))
        : '';
    [
        document.getElementById('proxyManagerBtn'),
        document.getElementById('proxyManagerLibraryTabBtn'),
    ].forEach((el) => {
        if (!el) return;
        el.setAttribute('title', title);
    });
    [
        document.getElementById('proxyManagerAlertBadge'),
        document.getElementById('proxyManagerLibraryTabAlertBadge'),
        document.getElementById('savedProxySourcesAlertBadge'),
    ].forEach((el) => {
        if (!el) return;
        el.textContent = displayCount;
        el.classList.toggle('active', count > 0);
        el.setAttribute('title', title);
    });
}

async function refreshProxyManagerAttentionBadgeState() {
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    advancedPresetState.savedProfileProxySources = cloneJson((settings && settings.savedProfileProxySources) || []);
    advancedPresetState.savedProfileProxies = cloneJson((settings && settings.savedProfileProxies) || []);
    await refreshSavedProfileProxyTestCache(advancedPresetState.savedProfileProxies.map((proxy) => proxy && proxy.id));
    updateSavedProfileProxySourceAttentionBadges(advancedPresetState.savedProfileProxySources);
}

function buildSavedProfileProxySourceOverviewMarkup(sources) {
    const summary = getSavedProfileProxySourceOperationsOverview(sources);
    const batchState = savedProfileProxySourceBulkMaintenanceState || createSavedProfileProxySourceBulkMaintenanceState();
    const overviewState = savedProfileProxySourceOverviewActionState || createSavedProfileProxySourceOverviewActionState();
    const latestBatchEntry = getLatestSavedProfileProxySourceBatchHistoryEntry('attention-maintenance');
    const targets = getSavedProfileProxySourceBulkMaintenanceTargets(sources);
    const targetSummary = summarizeSavedProfileProxySourceBulkMaintenanceTargets(targets);
    const overviewTargets = getSavedProfileProxySourceOverviewActionTargets(sources);
    const actionsBusy = batchState.running || overviewState.running;
    const actionLabel = batchState.running
        ? (
            Number(batchState.currentIndex) > 0 && Number(batchState.total) > 0
                ? t('savedProxySourceRunAttentionMaintenanceRunning')
                    .replace('{current}', String(Math.max(1, Number(batchState.currentIndex) || 1)))
                    .replace('{total}', String(Math.max(1, Number(batchState.total) || 1)))
                : uiText('总览维护执行中...', 'Overview maintenance running...')
        )
        : t('savedProxySourceRunAttentionMaintenanceBtn');
    const actionSummaryText = batchState.running
        ? [
            t('savedProxySourceRunAttentionMaintenanceCurrent')
                .replace('{source}', String(batchState.currentSourceLabel || batchState.currentSourceId || '-')),
            t('savedProxySourceRunAttentionMaintenanceScope')
                .replace('{count}', String(Math.max(0, Number(batchState.total) || 0)))
                .replace('{due}', String(targetSummary.due))
                .replace('{overdue}', String(targetSummary.overdue))
                .replace('{error}', String(targetSummary.error))
                .replace('{candidate}', String(targetSummary.candidate)),
        ].join(' · ')
        : (targets.length > 0
            ? t('savedProxySourceRunAttentionMaintenanceScope')
                .replace('{count}', String(targets.length))
                .replace('{due}', String(targetSummary.due))
                .replace('{overdue}', String(targetSummary.overdue))
                .replace('{error}', String(targetSummary.error))
                .replace('{candidate}', String(targetSummary.candidate))
            : t('savedProxySourceRunAttentionMaintenanceEmpty'));
    const refreshDueLabel = overviewState.running && overviewState.action === 'refresh-due'
        ? t('savedProxySourceOverviewRefreshDueRunning')
            .replace('{current}', String(Math.max(0, Number(overviewState.current) || 0)))
            .replace('{total}', String(Math.max(1, Number(overviewState.total) || 1)))
        : t('savedProxySourceOverviewRefreshDueBtn').replace('{count}', String(overviewTargets.dueSources.length));
    const quarantineCandidatesLabel = overviewState.running && overviewState.action === 'quarantine-candidates'
        ? t('savedProxySourceOverviewQuarantineCandidatesRunning')
            .replace('{current}', String(Math.max(0, Number(overviewState.current) || 0)))
            .replace('{total}', String(Math.max(1, Number(overviewState.total) || 1)))
        : t('savedProxySourceOverviewQuarantineCandidatesBtn').replace('{count}', String(overviewTargets.candidateEntries.length));
    const recheckQuarantinedLabel = overviewState.running && overviewState.action === 'recheck-quarantined'
        ? t('savedProxySourceOverviewRecheckQuarantinedRunning')
            .replace('{current}', String(Math.max(0, Number(overviewState.current) || 0)))
            .replace('{total}', String(Math.max(1, Number(overviewState.total) || 1)))
        : t('savedProxySourceOverviewRecheckQuarantinedBtn').replace('{count}', String(overviewTargets.quarantinedEntries.length));
    const lastSummaryMarkup = !batchState.running && latestBatchEntry
        ? `
            <div style="font-size:11px; opacity:0.72; line-height:1.6;">
                ${escapeHtml(
                    t('savedProxySourceRunAttentionMaintenanceLastBatch')
                        .replace('{count}', String(Math.max(0, Number(latestBatchEntry.total) || 0)))
                        .replace('{ok}', String(Math.max(0, Number(latestBatchEntry.ok) || 0)))
                        .replace('{failed}', String(Math.max(0, Number(latestBatchEntry.failed) || 0)))
                        .replace('{added}', String(Math.max(0, Number(latestBatchEntry.added) || 0)))
                        .replace('{quarantined}', String(Math.max(0, Number(latestBatchEntry.quarantined) || 0)))
                        .replace('{recovered}', String(Math.max(0, Number(latestBatchEntry.recovered) || 0)))
                )}
                ${Number(latestBatchEntry.finishedAt) > 0
                    ? ` · ${escapeHtml(formatDiagTime(latestBatchEntry.finishedAt))}`
                    : ''}
            </div>
        `
        : '';
    const metric = (label, value, color = 'var(--text-primary)') => `
        <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.14);">
            <div style="font-size:11px; opacity:0.7; margin-bottom:4px;">${escapeHtml(label)}</div>
            <div style="font-size:14px; font-weight:600; color:${color};">${escapeHtml(String(value))}</div>
        </div>
    `;
    const actionCard = (title, hint, buttonLabel, action, disabled) => `
        <div style="display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
            <div style="display:flex; flex-direction:column; gap:4px; min-height:48px;">
                <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(title)}</strong>
                <span style="font-size:11px; opacity:0.72; line-height:1.5;">${escapeHtml(hint)}</span>
            </div>
            <button type="button" class="outline" data-action="${escapeHtml(action)}" ${disabled ? 'disabled' : ''}>${escapeHtml(buttonLabel)}</button>
        </div>
    `;
    const overviewCurrentMarkup = overviewState.running
        ? `
            <div style="font-size:11px; opacity:0.82; line-height:1.6; color:var(--warning);">
                ${escapeHtml(t('savedProxySourceOverviewCurrentLabel').replace('{label}', String(overviewState.label || '-')))}
            </div>
        `
        : '';
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,0.02);">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxySourceOverviewTitle'))}</strong>
                <span style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceOverviewHint'))}</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px;">
                ${metric(t('savedProxySourceOverviewTotal'), summary.total)}
                ${metric(t('savedProxySourceOverviewEnabled'), summary.enabled, summary.enabled > 0 ? 'var(--success)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceOverviewScheduled'), summary.scheduled)}
                ${metric(t('savedProxySourceOverviewDueNow'), summary.dueNow, summary.dueNow > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceOverviewOverdue'), summary.overdue, summary.overdue > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceOverviewErrors'), summary.maintenanceErrors, summary.maintenanceErrors > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceOverviewCandidates'), summary.candidate, summary.candidate > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceOverviewQuarantined'), summary.quarantined, summary.quarantined > 0 ? 'var(--warning)' : 'var(--text-primary)')}
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(t('savedProxySourceRunAttentionMaintenanceBtn'))}</strong>
                        <span style="font-size:11px; opacity:0.72; line-height:1.5;">${escapeHtml(t('savedProxySourceRunAttentionMaintenanceHint'))}</span>
                    </div>
                    <button type="button" class="outline" data-action="run-attention-maintenance-saved-profile-proxy-sources" ${actionsBusy || targets.length === 0 ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button>
                </div>
                <div style="font-size:11px; opacity:0.82; line-height:1.6; color:${batchState.running ? 'var(--warning)' : 'var(--text-primary)'};">
                    ${escapeHtml(actionSummaryText)}
                </div>
                ${lastSummaryMarkup}
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12);">
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(uiText('总览快捷动作', 'Overview Quick Actions'))}</strong>
                    <span style="font-size:11px; opacity:0.72; line-height:1.5;">${escapeHtml(uiText('这些动作基于当前草稿执行；隔离/恢复后仍需点击保存。', 'These actions run on the current draft; quarantine/recovery changes still require Save.'))}</span>
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px;">
                    ${actionCard(
                        uiText('刷新到期来源', 'Refresh Due Sources'),
                        t('savedProxySourceOverviewRefreshDueHint').replace('{count}', String(overviewTargets.dueSources.length)),
                        refreshDueLabel,
                        'refresh-due-saved-profile-proxy-sources',
                        actionsBusy || overviewTargets.dueSources.length === 0
                    )}
                    ${actionCard(
                        uiText('隔离候选代理', 'Quarantine Candidates'),
                        t('savedProxySourceOverviewQuarantineCandidatesHint')
                            .replace('{count}', String(overviewTargets.candidateEntries.length))
                            .replace('{sources}', String(overviewTargets.candidateSourceCount)),
                        quarantineCandidatesLabel,
                        'quarantine-candidate-saved-profile-proxy-sources',
                        actionsBusy || overviewTargets.candidateEntries.length === 0
                    )}
                    ${actionCard(
                        uiText('复检隔离代理', 'Recheck Quarantined'),
                        t('savedProxySourceOverviewRecheckQuarantinedHint')
                            .replace('{count}', String(overviewTargets.quarantinedEntries.length))
                            .replace('{sources}', String(overviewTargets.quarantinedSourceCount)),
                        recheckQuarantinedLabel,
                        'recheck-quarantined-saved-profile-proxy-sources',
                        actionsBusy || overviewTargets.quarantinedEntries.length === 0
                    )}
                </div>
                ${overviewCurrentMarkup}
            </div>
        </div>
    `;
}

function buildSavedProfileProxySourceBatchHistoryMarkup() {
    const history = getSavedProfileProxySourceBatchHistory();
    if (history.length === 0) {
        return `
            <div style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,0.02);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                    <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxySourceBatchHistoryTitle'))}</strong>
                    <span style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceBatchHistoryHint'))}</span>
                </div>
                <div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceBatchHistoryEmpty'))}</div>
            </div>
        `;
    }
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,0.02);">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxySourceBatchHistoryTitle'))}</strong>
                <span style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceBatchHistoryHint'))}</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${history.slice(0, 5).map((entry) => {
                    const status = entry.failed > 0 ? 'warn' : 'ok';
                    const statusLabel = entry.failed > 0 ? 'WARN' : 'OK';
                    const actionLabel = getSavedProfileProxySourceBatchHistoryActionLabel(entry);
                    const sourcesLabel = entry.sourceIds.length > 0
                        ? `<div style="font-size:11px; opacity:0.72; line-height:1.6;">${escapeHtml(t('savedProxySourceBatchHistorySourcesLabel'))}: ${escapeHtml(`${entry.sourceIds.slice(0, 4).join(', ')}${entry.sourceIds.length > 4 ? '...' : ''}`)}</div>`
                        : '';
                    return `
                        <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12); display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                                <span style="font-size:12px; color:var(--text-primary);">${escapeHtml(formatDiagTime(entry.finishedAt))}</span>
                                <span class="diag-pill" data-status="${escapeHtml(status)}">${escapeHtml(`${actionLabel} · ${statusLabel}`)}</span>
                            </div>
                            <div style="font-size:12px; line-height:1.5; color:var(--text-primary); font-weight:600;">
                                ${escapeHtml(actionLabel)}
                            </div>
                            <div style="font-size:12px; line-height:1.6; color:var(--text-primary);">
                                ${escapeHtml(buildSavedProfileProxySourceBatchHistorySummaryText(entry))}
                            </div>
                            <div style="font-size:11px; opacity:0.78; line-height:1.6;">
                                ${escapeHtml(buildSavedProfileProxySourceBatchHistoryScopeText(entry))}
                            </div>
                            ${sourcesLabel}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function buildSavedProfileProxySourceAlertsMarkup(sources) {
    const alerts = getSavedProfileProxySourceAttentionEntries(sources);
    if (alerts.length === 0) {
        return `
            <div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">
                ${escapeHtml(t('savedProxySourceAlertsEmpty'))}
            </div>
        `;
    }
    return `
        <div style="display:flex; flex-direction:column; gap:8px;">
            ${alerts.slice(0, 8).map((entry) => `
                <div style="padding:10px; border:1px solid rgba(255,183,77,0.35); border-radius:8px; background:rgba(255,183,77,0.08); display:flex; flex-direction:column; gap:6px;">
                    <div style="font-size:12px; font-weight:600; color:var(--text-primary);">${escapeHtml(entry.label)}</div>
                    <div style="font-size:12px; line-height:1.6; color:var(--warning);">${escapeHtml(entry.issues.join(' · '))}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function getSavedProfileProxySourceRecentMaintenanceEntries(sources, limit = 20) {
    return (Array.isArray(sources) ? sources : [])
        .flatMap((source) => {
            const label = String(source && (source.name || source.id) || '').trim();
            const history = normalizeSavedProfileProxySourceMaintenanceHistory(source && source.maintenanceHistory);
            return history.map((entry, index) => {
                const previous = history[index + 1] || null;
                return {
                    ...entry,
                    sourceId: normalizeSavedProfileProxySourceId(source && source.id),
                    sourceLabel: label || String(source && source.id || '').trim(),
                    candidateDelta: previous ? entry.candidateCountAfter - previous.candidateCountAfter : 0,
                    quarantinedDelta: previous ? entry.quarantinedCountAfter - previous.quarantinedCountAfter : 0,
                    hasPreviousSnapshot: !!previous,
                };
            });
        })
        .filter((entry) => entry.ranAt > 0)
        .sort((a, b) => b.ranAt - a.ranAt)
        .slice(0, Math.max(1, Number(limit) || 20));
}

function getSavedProfileProxySourceMaintenanceTrendSummary(sources) {
    const entries = getSavedProfileProxySourceRecentMaintenanceEntries(sources, 20);
    const summary = {
        runs: entries.length,
        ok: 0,
        error: 0,
        quarantined: 0,
        recovered: 0,
        successRate: 0,
        latestCandidateAfter: 0,
        latestQuarantinedAfter: 0,
        candidateDelta: 0,
        quarantinedDelta: 0,
        comparableSnapshots: 0,
    };
    for (const entry of entries) {
        if (entry.status === 'error') summary.error++;
        else if (entry.status === 'ok') summary.ok++;
        summary.quarantined += Math.max(0, Number(entry.quarantinedCount) || 0);
        summary.recovered += Math.max(0, Number(entry.recoveredCount) || 0);
    }
    for (const source of Array.isArray(sources) ? sources : []) {
        const history = normalizeSavedProfileProxySourceMaintenanceHistory(source && source.maintenanceHistory);
        const latest = history[0] || null;
        const previous = history[1] || null;
        if (!latest) continue;
        summary.latestCandidateAfter += Math.max(0, Number(latest.candidateCountAfter) || 0);
        summary.latestQuarantinedAfter += Math.max(0, Number(latest.quarantinedCountAfter) || 0);
        if (!previous) continue;
        summary.candidateDelta += Math.max(0, Number(latest.candidateCountAfter) || 0) - Math.max(0, Number(previous.candidateCountAfter) || 0);
        summary.quarantinedDelta += Math.max(0, Number(latest.quarantinedCountAfter) || 0) - Math.max(0, Number(previous.quarantinedCountAfter) || 0);
        summary.comparableSnapshots++;
    }
    summary.successRate = summary.runs > 0 ? Math.round((summary.ok / summary.runs) * 100) : 0;
    return { entries, summary };
}

function buildSavedProfileProxySourceMaintenanceTrendMarkup(sources) {
    const { entries, summary } = getSavedProfileProxySourceMaintenanceTrendSummary(sources);
    if (entries.length === 0) {
        return `
            <div style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,0.02);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                    <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxySourceTrendTitle'))}</strong>
                    <span style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceTrendHint'))}</span>
                </div>
                <div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceTrendEmpty'))}</div>
            </div>
        `;
    }
    const metric = (label, value, color = 'var(--text-primary)') => `
        <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.14);">
            <div style="font-size:11px; opacity:0.7; margin-bottom:4px;">${escapeHtml(label)}</div>
            <div style="font-size:14px; font-weight:600; color:${color};">${escapeHtml(String(value))}</div>
        </div>
    `;
    return `
        <div style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,0.02);">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxySourceTrendTitle'))}</strong>
                <span style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceTrendHint'))}</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px;">
                ${metric(t('savedProxySourceTrendRuns'), summary.runs)}
                ${metric(t('savedProxySourceTrendOk'), summary.ok, summary.ok > 0 ? 'var(--success)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceTrendError'), summary.error, summary.error > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceTrendSuccessRate'), `${summary.successRate}%`, summary.successRate >= 80 ? 'var(--success)' : 'var(--warning)')}
                ${metric(t('savedProxySourceTrendQuarantined'), summary.quarantined, summary.quarantined > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceTrendRecovered'), summary.recovered, summary.recovered > 0 ? 'var(--success)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceTrendCandidateAfter'), summary.latestCandidateAfter, summary.latestCandidateAfter > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(t('savedProxySourceTrendQuarantinedAfter'), summary.latestQuarantinedAfter, summary.latestQuarantinedAfter > 0 ? 'var(--warning)' : 'var(--text-primary)')}
                ${metric(
                    t('savedProxySourceTrendCandidateDelta'),
                    summary.comparableSnapshots > 0 ? formatSignedCount(summary.candidateDelta) : '—',
                    summary.comparableSnapshots <= 0 ? 'var(--text-primary)' : (summary.candidateDelta <= 0 ? 'var(--success)' : 'var(--warning)')
                )}
                ${metric(
                    t('savedProxySourceTrendQuarantinedDelta'),
                    summary.comparableSnapshots > 0 ? formatSignedCount(summary.quarantinedDelta) : '—',
                    summary.comparableSnapshots <= 0 ? 'var(--text-primary)' : (summary.quarantinedDelta <= 0 ? 'var(--success)' : 'var(--warning)')
                )}
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:11px; opacity:0.72;">${escapeHtml(t('savedProxySourceTrendRecentEvents'))}</div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${entries.slice(0, 6).map((entry) => `
                        <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12); display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                                <span style="font-weight:600;">${escapeHtml(entry.sourceLabel || entry.sourceId || '-')}</span>
                                <span>${escapeHtml(formatDiagTime(entry.ranAt))}</span>
                                <span>${escapeHtml(entry.status === 'error' ? t('savedProxySourceHistoryStatusError') : t('savedProxySourceHistoryStatusOk'))}</span>
                                <span>${escapeHtml(formatSavedProfileProxySourceMaintenanceTrigger(entry.trigger))}</span>
                            </div>
                            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:11px; opacity:0.8;">
                                <span>${escapeHtml(`${t('savedProxySourceMaintenanceQuarantinedLabel')}: ${entry.quarantinedCount}`)}</span>
                                <span>${escapeHtml(`${t('savedProxySourceMaintenanceRecoveredLabel')}: ${entry.recoveredCount}`)}</span>
                                <span>${escapeHtml(`${t('savedProxySourceCandidateAfterLabel')}: ${entry.candidateCountAfter}`)}</span>
                                <span>${escapeHtml(`${t('savedProxySourceQuarantinedAfterLabel')}: ${entry.quarantinedCountAfter}`)}</span>
                                ${entry.hasPreviousSnapshot ? `<span>${escapeHtml(`${t('savedProxySourceTrendCandidateDelta')}: ${formatSignedCount(entry.candidateDelta)}`)}</span>` : ''}
                                ${entry.hasPreviousSnapshot ? `<span>${escapeHtml(`${t('savedProxySourceTrendQuarantinedDelta')}: ${formatSignedCount(entry.quarantinedDelta)}`)}</span>` : ''}
                            </div>
                            ${entry.error ? `<div style="font-size:12px; color:var(--warning); line-height:1.5;">${escapeHtml(entry.error)}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

function buildSavedProfileProxySourceMaintenanceHistoryMarkup(source) {
    const history = normalizeSavedProfileProxySourceMaintenanceHistory(source && source.maintenanceHistory);
    if (history.length === 0) {
        return `<div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceMaintenanceHistoryEmpty'))}</div>`;
    }
    return `
        <div style="display:flex; flex-direction:column; gap:8px;">
            ${history.map((entry) => {
                const statusKey = entry.status === 'error' ? 'savedProxySourceHistoryStatusError' : (entry.status === 'ok' ? 'savedProxySourceHistoryStatusOk' : 'savedProxySourceMaintenanceStatusIdle');
                return `
                    <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12); display:flex; flex-direction:column; gap:6px;">
                        <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                            <span>${escapeHtml(formatDiagTime(entry.ranAt))}</span>
                            <span>${escapeHtml(t(statusKey))}</span>
                            <span>${escapeHtml(formatSavedProfileProxySourceMaintenanceTrigger(entry.trigger))}</span>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:11px; opacity:0.8;">
                            <span>${escapeHtml(`${t('savedProxySourceMaintenanceQuarantinedLabel')}: ${entry.quarantinedCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceMaintenanceRecoveredLabel')}: ${entry.recoveredCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceCandidateAfterLabel')}: ${entry.candidateCountAfter}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceQuarantinedAfterLabel')}: ${entry.quarantinedCountAfter}`)}</span>
                        </div>
                        ${entry.error ? `<div style="font-size:12px; color:var(--warning); line-height:1.5;">${escapeHtml(entry.error)}</div>` : ''}
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function buildSavedProfileProxySourceHistoryMarkup(source) {
    const history = normalizeSavedProfileProxySourceHistory(source && source.syncHistory);
    if (history.length === 0) {
        return `<div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12px; opacity:0.72;">${escapeHtml(t('savedProxySourceHistoryEmpty'))}</div>`;
    }
    return `
        <div style="display:flex; flex-direction:column; gap:8px;">
            ${history.map((entry) => {
                const statusKey = entry.status === 'error' ? 'savedProxySourceHistoryStatusError' : 'savedProxySourceHistoryStatusOk';
                const policyKey = `savedProxySourcePolicy${entry.policyMode.charAt(0).toUpperCase()}${entry.policyMode.slice(1)}`;
                return `
                    <div style="padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,0.12); display:flex; flex-direction:column; gap:6px;">
                        <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-primary);">
                            <span>${escapeHtml(formatDiagTime(entry.syncedAt))}</span>
                            <span>${escapeHtml(t(statusKey))}</span>
                            <span>${escapeHtml(String(entry.format || 'auto').toUpperCase())}</span>
                            <span>${escapeHtml(t(policyKey))}</span>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:11px; opacity:0.8;">
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncTotalLinesLabel')}: ${entry.totalLines}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncAddedLabel')}: ${entry.addedCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncDuplicateLabel')}: ${entry.duplicateCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncLinkedLabel')}: ${entry.linkedCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncStaleLabel')}: ${entry.staleCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncReactivatedLabel')}: ${entry.reactivatedCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceLastSyncInvalidLabel')}: ${entry.invalidCount}`)}</span>
                            <span>${escapeHtml(`${t('savedProxySourceHistoryPolicyAffectedLabel')}: ${entry.policyAffectedCount}`)}</span>
                        </div>
                        ${entry.error ? `<div style="font-size:12px; color:var(--warning); line-height:1.5;">${escapeHtml(entry.error)}</div>` : ''}
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function normalizeSavedProfileProxyImportStartIndex(value) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildImportedSavedProxyName(proxyStr, index = 0) {
    const customPrefix = arguments.length > 2 ? String(arguments[2] || '').trim() : '';
    const startIndex = arguments.length > 3 ? normalizeSavedProfileProxyImportStartIndex(arguments[3]) : 1;
    const nextIndex = startIndex + Math.max(0, Number.parseInt(index, 10) || 0);
    if (customPrefix) return `${customPrefix} ${nextIndex}`;
    const type = detectSavedProxyType(proxyStr);
    return `${type} ${uiText('导入代理', 'Imported Proxy')} ${nextIndex}`;
}

function openSavedProfileProxyImport() {
    const modal = document.getElementById('savedProxyImportModal');
    const valueInput = document.getElementById('savedProxyImportValue');
    const prefixInput = document.getElementById('savedProxyImportPrefix');
    const startIndexInput = document.getElementById('savedProxyImportStartIndex');
    const formatInput = document.getElementById('savedProxyImportFormat');
    const groupInput = document.getElementById('savedProxyImportGroup');
    const tagsInput = document.getElementById('savedProxyImportTags');
    const remoteUrlInput = document.getElementById('savedProxyImportRemoteUrl');
    const autoCheckInput = document.getElementById('savedProxyImportAutoCheck');
    const fileInput = document.getElementById('savedProxyImportFile');
    const fileInfo = document.getElementById('savedProxyImportFileInfo');
    if (!modal || !valueInput) return;
    valueInput.value = '';
    if (prefixInput) prefixInput.value = '';
    if (startIndexInput) startIndexInput.value = '1';
    if (formatInput) formatInput.value = 'auto';
    if (groupInput) groupInput.value = '';
    if (tagsInput) tagsInput.value = '';
    if (remoteUrlInput) remoteUrlInput.value = '';
    if (autoCheckInput) autoCheckInput.checked = false;
    if (fileInput) fileInput.value = '';
    if (fileInfo) fileInfo.textContent = t('savedProxyImportFileHint');
    modal.style.display = 'flex';
    valueInput.focus();
}

function closeSavedProfileProxyImport() {
    const modal = document.getElementById('savedProxyImportModal');
    if (modal) modal.style.display = 'none';
}

async function submitSavedProfileProxyImport() {
    const valueInput = document.getElementById('savedProxyImportValue');
    if (!valueInput) return;
    const result = await importSavedProfileProxyLines({
        value: valueInput.value,
        prefix: document.getElementById('savedProxyImportPrefix')?.value || '',
        startIndex: document.getElementById('savedProxyImportStartIndex')?.value || '1',
        format: document.getElementById('savedProxyImportFormat')?.value || 'auto',
        group: document.getElementById('savedProxyImportGroup')?.value || '',
        tags: document.getElementById('savedProxyImportTags')?.value || '',
        autoCheck: document.getElementById('savedProxyImportAutoCheck')?.checked === true,
    });
    if (result && result.submitted) closeSavedProfileProxyImport();
}

function normalizeSavedProfileProxyImportLine(value) {
    return String(value || '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .trim();
}

function normalizeSavedProfileProxyImportFormat(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['auto', 'lines', 'csv', 'json'].includes(current) ? current : 'auto';
}

function parseSavedProfileProxyImportTags(value) {
    return String(value || '')
        .split(/[\n,，]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeSavedProfileProxyImportText(value) {
    return String(value || '').replace(/^\uFEFF/, '').trim();
}

function parseSavedProfileProxyDelimitedRow(line, delimiter = ',') {
    const cells = [];
    let current = '';
    let quoted = false;
    const text = String(line || '');
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            if (quoted && text[index + 1] === '"') {
                current += '"';
                index++;
            } else {
                quoted = !quoted;
            }
            continue;
        }
        if (char === delimiter && !quoted) {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    cells.push(current.trim());
    return cells.map((cell) => normalizeSavedProfileProxyImportLine(cell));
}

function normalizeSavedProfileProxyImportHeader(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function looksLikeSavedProfileProxyImportHeader(row) {
    const headers = (Array.isArray(row) ? row : []).map(normalizeSavedProfileProxyImportHeader).filter(Boolean);
    if (headers.length === 0) return false;
    const known = new Set(['proxy', 'proxystr', 'proxyurl', 'url', 'link', 'host', 'server', 'hostname', 'address', 'ip', 'port', 'user', 'username', 'login', 'password', 'pass', 'pwd', 'protocol', 'type', 'scheme']);
    return headers.some((header) => known.has(header));
}

function normalizeSavedProfileProxyImportProtocol(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['http', 'https', 'socks', 'socks4', 'socks5'].includes(current) ? current : '';
}

function formatSavedProfileProxyImportHost(value) {
    const host = String(value || '').trim();
    if (!host) return '';
    if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) return `[${host}]`;
    return host;
}

function buildSavedProfileProxyImportProxyString(fields = {}) {
    const host = formatSavedProfileProxyImportHost(fields.host || fields.server || fields.ip || fields.address || fields.hostname);
    const port = String(fields.port || '').trim();
    if (!host || !port) return '';
    const protocol = normalizeSavedProfileProxyImportProtocol(fields.protocol || fields.type || fields.scheme);
    const username = String(fields.username || fields.user || fields.login || '').trim();
    const password = String(fields.password || fields.pass || fields.pwd || '').trim();
    if (protocol) {
        const auth = username
            ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
            : '';
        return `${protocol}://${auth}${host}:${port}`;
    }
    if (username) return `${host}:${port}:${username}:${password}`;
    return `${host}:${port}`;
}

function extractSavedProfileProxyImportProxyString(record) {
    if (typeof record === 'string') return normalizeSavedProfileProxyImportLine(record);
    if (!record || typeof record !== 'object') return '';

    const directKeys = ['proxyStr', 'proxy', 'proxyUrl', 'url', 'link', 'value'];
    for (const key of directKeys) {
        const current = normalizeSavedProfileProxyImportLine(record[key]);
        if (current) return current;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(record)) {
        normalized[normalizeSavedProfileProxyImportHeader(key)] = value;
    }
    const normalizedDirect = normalizeSavedProfileProxyImportLine(
        normalized.proxystr || normalized.proxy || normalized.proxyurl || normalized.url || normalized.link || normalized.value
    );
    if (normalizedDirect) return normalizedDirect;
    return buildSavedProfileProxyImportProxyString({
        host: normalized.host || normalized.server || normalized.hostname || normalized.address || normalized.ip,
        port: normalized.port,
        username: normalized.username || normalized.user || normalized.login,
        password: normalized.password || normalized.pass || normalized.pwd,
        protocol: normalized.protocol || normalized.type || normalized.scheme,
    });
}

function collectSavedProfileProxyImportJsonRecords(value, bucket = []) {
    if (typeof value === 'string') {
        if (normalizeSavedProfileProxyImportLine(value)) bucket.push(value);
        return bucket;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectSavedProfileProxyImportJsonRecords(item, bucket));
        return bucket;
    }
    if (value && typeof value === 'object') {
        const direct = extractSavedProfileProxyImportProxyString(value);
        if (direct) {
            bucket.push(value);
            return bucket;
        }
        const nestedKeys = ['proxies', 'list', 'items', 'rows', 'data', 'result', 'results'];
        nestedKeys.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(value, key)) collectSavedProfileProxyImportJsonRecords(value[key], bucket);
        });
    }
    return bucket;
}

function detectSavedProfileProxyImportFormat(value, fileName = '', preferred = 'auto') {
    const format = normalizeSavedProfileProxyImportFormat(preferred);
    if (format !== 'auto') return format;
    const ext = String(fileName || '').trim().toLowerCase();
    if (ext.endsWith('.json')) return 'json';
    if (ext.endsWith('.csv') || ext.endsWith('.tsv')) return 'csv';
    if (ext.endsWith('.txt')) return 'lines';
    const text = normalizeSavedProfileProxyImportText(value);
    if (!text) return 'lines';
    if (text.startsWith('[') || text.startsWith('{')) return 'json';
    const firstLine = text.split(/\r?\n/).find((line) => String(line || '').trim());
    if (!firstLine) return 'lines';
    if (firstLine.includes('\t') || firstLine.includes(',')) {
        const delimiter = firstLine.includes('\t') ? '\t' : ',';
        const firstRow = parseSavedProfileProxyDelimitedRow(firstLine, delimiter);
        if (looksLikeSavedProfileProxyImportHeader(firstRow) || firstRow.length > 1) return 'csv';
    }
    return 'lines';
}

function parseSavedProfileProxyImportCsvRows(text) {
    const normalized = normalizeSavedProfileProxyImportText(text);
    if (!normalized) return [];
    const rows = normalized
        .split(/\r?\n/)
        .map((line) => String(line || '').trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
    if (rows.length === 0) return [];
    const delimiter = rows.some((line) => line.includes('\t')) ? '\t' : ',';
    const parsedRows = rows.map((line) => parseSavedProfileProxyDelimitedRow(line, delimiter));
    if (parsedRows.length === 0) return [];
    if (looksLikeSavedProfileProxyImportHeader(parsedRows[0])) {
        const headers = parsedRows[0].map(normalizeSavedProfileProxyImportHeader);
        return parsedRows.slice(1).map((row) => {
            const record = {};
            headers.forEach((header, index) => { record[header] = row[index] || ''; });
            return extractSavedProfileProxyImportProxyString(record);
        }).filter(Boolean);
    }
    return parsedRows.map((row) => {
        const values = row.map((item) => String(item || '').trim()).filter(Boolean);
        if (values.length === 0) return '';
        if (values.length === 1) return normalizeSavedProfileProxyImportLine(values[0]);
        if (normalizeSavedProfileProxyImportProtocol(values[0])) {
            return buildSavedProfileProxyImportProxyString({
                protocol: values[0],
                host: values[1],
                port: values[2],
                username: values[3],
                password: values[4],
            });
        }
        return buildSavedProfileProxyImportProxyString({
            host: values[0],
            port: values[1],
            username: values[2],
            password: values[3],
            protocol: values[4],
        });
    }).filter(Boolean);
}

function extractSavedProfileProxyImportLines(value, options = {}) {
    const text = normalizeSavedProfileProxyImportText(value);
    if (!text) return { format: 'lines', lines: [] };
    const format = detectSavedProfileProxyImportFormat(text, options.fileName, options.format);
    if (format === 'json') {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(uiText('JSON 格式无效', 'Invalid JSON import payload'));
        }
        const lines = collectSavedProfileProxyImportJsonRecords(parsed)
            .map((item) => extractSavedProfileProxyImportProxyString(item))
            .filter(Boolean);
        return { format, lines };
    }
    if (format === 'csv') {
        return { format, lines: parseSavedProfileProxyImportCsvRows(text) };
    }
    return {
        format: 'lines',
        lines: text
            .split(/[\r\n]+/)
            .map(normalizeSavedProfileProxyImportLine)
            .filter((item) => item && !item.startsWith('#') && !item.startsWith('//')),
    };
}

function isValidSavedProfileProxyImportLine(value) {
    const line = normalizeSavedProfileProxyImportLine(value);
    if (!line) return false;
    return detectSavedProxyType(line) !== 'UNKNOWN';
}

function triggerSavedProfileProxyImportFile() {
    document.getElementById('savedProxyImportFile')?.click();
}

async function handleSavedProfileProxyImportFile(input) {
    const file = input && input.files && input.files[0];
    const textarea = document.getElementById('savedProxyImportValue');
    const info = document.getElementById('savedProxyImportFileInfo');
    const formatInput = document.getElementById('savedProxyImportFormat');
    const format = formatInput?.value || 'auto';
    if (!file || !textarea) return;
    try {
        const text = await file.text();
        const parsed = extractSavedProfileProxyImportLines(text, { format, fileName: file.name });
        textarea.value = (parsed.lines || []).join('\n');
        if (formatInput) formatInput.value = 'lines';
        if (info) {
            info.textContent = uiText(
                `已载入 ${file.name} · ${String(parsed.format || '').toUpperCase()} · ${parsed.lines.length} 条`,
                `Loaded ${file.name} · ${String(parsed.format || '').toUpperCase()} · ${parsed.lines.length} rows`
            );
        }
        showAlert(uiText(
            `文件已载入：${file.name}\n识别格式：${String(parsed.format || '').toUpperCase()}\n提取代理：${parsed.lines.length} 条`,
            `File loaded: ${file.name}\nDetected format: ${String(parsed.format || '').toUpperCase()}\nExtracted proxies: ${parsed.lines.length}`
        ));
    } catch (e) {
        if (info) info.textContent = t('savedProxyImportFileHint');
        showAlert((e && e.message) ? e.message : String(e));
    } finally {
        if (input) input.value = '';
    }
}

async function fetchSavedProfileProxyImportRemotePayload(rawUrl, options = {}) {
    const input = String(rawUrl || '').trim();
    if (!input) throw new Error(uiText('请先输入远程地址。', 'Please enter a remote URL first.'));
    let target;
    try {
        target = new URL(input);
    } catch (e) {
        throw new Error(uiText('远程地址格式无效。', 'Invalid remote URL.'));
    }
    const content = await window.electronAPI.invoke('fetch-url', target.toString());
    let decoded = String(content || '');
    let parsed = null;
    try {
        parsed = extractSavedProfileProxyImportLines(decoded, {
            format: options.format,
            fileName: options.fileName || target.pathname || target.hostname,
        });
    } catch (primaryError) {
        try {
            if (!decoded.includes('://')) {
                decoded = decodeBase64Content(decoded);
                parsed = extractSavedProfileProxyImportLines(decoded, {
                    format: options.format,
                    fileName: options.fileName || target.pathname || target.hostname,
                });
            } else {
                throw primaryError;
            }
        } catch (fallbackError) {
            throw fallbackError || primaryError;
        }
    }
    return { target, decoded, parsed };
}

async function loadSavedProfileProxyImportRemote() {
    const urlInput = document.getElementById('savedProxyImportRemoteUrl');
    const textarea = document.getElementById('savedProxyImportValue');
    const info = document.getElementById('savedProxyImportFileInfo');
    const formatInput = document.getElementById('savedProxyImportFormat');
    const format = formatInput?.value || 'auto';
    if (!textarea) return;
    try {
        const remote = await fetchSavedProfileProxyImportRemotePayload(String(urlInput?.value || '').trim(), { format });
        const parsed = remote.parsed || { format: 'lines', lines: [] };
        textarea.value = (Array.isArray(parsed.lines) ? parsed.lines : []).join('\n');
        if (formatInput) formatInput.value = 'lines';
        if (info) {
            info.textContent = uiText(
                `已载入远程地址 · ${remote.target.host} · ${String(parsed?.format || '').toUpperCase()} · ${(parsed?.lines || []).length} 条`,
                `Loaded remote URL · ${remote.target.host} · ${String(parsed?.format || '').toUpperCase()} · ${(parsed?.lines || []).length} rows`
            );
        }
        showAlert(uiText(
            `远程地址已载入：${remote.target.toString()}\n识别格式：${String(parsed?.format || '').toUpperCase()}\n提取代理：${(parsed?.lines || []).length} 条`,
            `Remote URL loaded: ${remote.target.toString()}\nDetected format: ${String(parsed?.format || '').toUpperCase()}\nExtracted proxies: ${(parsed?.lines || []).length} rows`
        ));
    } catch (e) {
        if (info) info.textContent = t('savedProxyImportFileHint');
        showAlert((e && e.message) ? e.message : String(e));
    }
}

function syncSavedProfileProxySourceMembership(sourceId, activeProxyStrings, syncedAt) {
    const targetSourceId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetSourceId) return { staleCount: 0, reactivatedCount: 0 };
    const activeSet = activeProxyStrings instanceof Set
        ? activeProxyStrings
        : new Set((Array.isArray(activeProxyStrings) ? activeProxyStrings : []).map((item) => String(item || '').trim()).filter(Boolean));
    const missingSince = normalizeSavedProfileProxyMissingSince(syncedAt || Date.now());
    let staleCount = 0;
    let reactivatedCount = 0;
    for (const proxy of Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : []) {
        if (normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) !== targetSourceId) continue;
        const proxyStr = String(proxy && proxy.proxyStr || '').trim();
        if (proxyStr && activeSet.has(proxyStr)) {
            if (proxy.sourceStale === true || normalizeSavedProfileProxyMissingSince(proxy && proxy.sourceMissingSince) > 0) {
                reactivatedCount++;
            }
            proxy.sourceStale = false;
            proxy.sourceMissingSince = 0;
            continue;
        }
        if (proxy.sourceStale !== true) {
            staleCount++;
            proxy.sourceStale = true;
            proxy.sourceMissingSince = missingSince;
        } else if (!normalizeSavedProfileProxyMissingSince(proxy && proxy.sourceMissingSince)) {
            proxy.sourceMissingSince = missingSince;
        }
    }
    return { staleCount, reactivatedCount };
}

async function importSavedProfileProxyLines(payload) {
    const source = typeof payload === 'string' ? { value: payload } : (payload || {});
    const skipAlert = source.skipAlert === true;
    let parsed = null;
    try {
        parsed = extractSavedProfileProxyImportLines(source.value || '', {
            format: source.format,
            fileName: source.fileName,
        });
    } catch (e) {
        const message = (e && e.message) ? e.message : String(e);
        if (!skipAlert) showAlert(message);
        return { submitted: false, importedCount: 0, duplicateCount: 0, invalidCount: 0, messages: [message] };
    }
    const lines = Array.isArray(parsed && parsed.lines) ? parsed.lines : [];
    if (lines.length === 0) {
        const message = t('savedProxyImportEmpty');
        if (!skipAlert) showAlert(message);
        return { submitted: false, importedCount: 0, duplicateCount: 0, invalidCount: 0, messages: [message] };
    }
    const prefix = String(source.prefix || '').trim();
    const startIndex = normalizeSavedProfileProxyImportStartIndex(source.startIndex);
    const group = String(source.group || '').trim();
    const tags = parseSavedProfileProxyImportTags(source.tags);
    const autoCheck = source.autoCheck === true;
    const sourceId = normalizeSavedProfileProxySourceId(source.sourceId);
    const sourceName = String(source.sourceName || '').trim();
    const sourceImportedAt = normalizeSavedProfileProxyImportedAt(source.sourceImportedAt || Date.now());
    const existingProxyMap = new Map(
        (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .map((proxy) => [String(proxy && proxy.proxyStr || '').trim(), proxy])
            .filter(([proxyStr]) => !!proxyStr)
    );
    let importedCount = 0;
    let duplicateCount = 0;
    let linkedCount = 0;
    let invalidCount = 0;
    const invalidSamples = [];
    const importedIds = [];
    for (const line of lines) {
        if (!isValidSavedProfileProxyImportLine(line)) {
            invalidCount++;
            if (invalidSamples.length < 3) invalidSamples.push(line);
            continue;
        }
        const existingProxy = existingProxyMap.get(line);
        if (existingProxy) {
            duplicateCount++;
            if (sourceId) {
                const currentSourceId = normalizeSavedProfileProxySourceId(existingProxy && existingProxy.sourceId);
                if (!currentSourceId || currentSourceId === sourceId) {
                    existingProxy.sourceId = sourceId;
                    existingProxy.sourceName = sourceName || String(existingProxy.sourceName || '').trim();
                    existingProxy.sourceImportedAt = sourceImportedAt;
                    existingProxy.sourceStale = false;
                    existingProxy.sourceMissingSince = 0;
                    linkedCount++;
                }
            }
            continue;
        }
        const draft = createSavedProfileProxyDraft();
        draft.id = buildUniqueSavedProfileProxyEditorIdWithStart(
            buildSavedProfileProxyImportIdBase(line, { prefix, group }),
            importedCount,
            startIndex
        );
        draft.proxyStr = line;
        draft.name = buildImportedSavedProxyName(line, importedCount, prefix, startIndex);
        draft.group = group;
        draft.tags = [...tags];
        draft.sourceId = sourceId;
        draft.sourceName = sourceName;
        draft.sourceImportedAt = sourceImportedAt;
        draft.sourceStale = false;
        draft.sourceMissingSince = 0;
        advancedPresetState.savedProfileProxies.push(draft);
        existingProxyMap.set(line, draft);
        importedCount++;
        importedIds.push(draft.id);
    }
    let resetFilters = false;
    if (importedIds.length > 0) {
        const importedSet = new Set(importedIds);
        const visibleImported = advancedPresetState.savedProfileProxies.some((proxy) => {
            const proxyId = normalizeSavedProxyId(proxy && proxy.id);
            if (!importedSet.has(proxyId)) return false;
            return matchesSavedProfileProxyEditorFilters(proxy, savedProfileProxyTestCache.get(proxyId));
        });
        if (!visibleImported) {
            savedProfileProxyEditorFilters.search = '';
            savedProfileProxyEditorFilters.group = '';
            savedProfileProxyEditorFilters.status = 'all';
            resetFilters = true;
        }
    }
    renderSavedProfileProxyEditors();
    let autoCheckResult = null;
    if (autoCheck && importedIds.length > 0) {
        autoCheckResult = await runSavedProfileProxyTestsByIds(importedIds);
        renderSavedProfileProxyEditors();
    }
    const messages = [];
    if (importedCount > 0) {
        messages.push(uiText(`已导入 ${importedCount} 条代理`, `Imported ${importedCount} proxies`));
        messages.push(uiText('点击保存后才会持久化到代理库。', 'Click Save to persist the imported proxies.'));
    } else if (duplicateCount === 0 && invalidCount === 0) {
        messages.push(t('savedProxyImportNoNew'));
    }
    if (duplicateCount > 0) {
        messages.push(uiText(`跳过重复 ${duplicateCount} 条`, `Skipped ${duplicateCount} duplicates`));
    }
    if (linkedCount > 0) {
        messages.push(uiText(`已同步 ${linkedCount} 条已有代理的来源信息`, `Synced provenance for ${linkedCount} existing proxies`));
    }
    if (invalidCount > 0) {
        messages.push(uiText(`无效格式 ${invalidCount} 条`, `Invalid format ${invalidCount} lines`));
        if (invalidSamples.length > 0) {
            messages.push(`${uiText('示例', 'Examples')}: ${invalidSamples.join(' | ')}`);
        }
    }
    if (resetFilters) {
        messages.push(uiText('已自动清空筛选，方便查看刚导入的代理。', 'Filters were reset so the imported proxies stay visible.'));
    }
    if (autoCheckResult && autoCheckResult.total > 0) {
        messages.push(uiText(
            `已自动检测 ${autoCheckResult.total} 条代理，失败 ${autoCheckResult.failed} 条`,
            `Auto-checked ${autoCheckResult.total} proxies, ${autoCheckResult.failed} failed`
        ));
    }
    if (messages.length === 0) messages.push(t('savedProxyImportNoNew'));
    if (!skipAlert) showAlert(messages.join('\n'));
    return { submitted: true, importedCount, duplicateCount, linkedCount, invalidCount, autoCheckResult, importedIds, messages };
}

function setSavedProfileProxyEditorSearch(value) {
    savedProfileProxyEditorFilters.search = String(value || '').trim();
    renderSavedProfileProxyEditors();
}

function setSavedProfileProxyEditorGroupFilter(value) {
    savedProfileProxyEditorFilters.group = String(value || '').trim();
    renderSavedProfileProxyEditors();
}

function setSavedProfileProxyEditorStatusFilter(value) {
    savedProfileProxyEditorFilters.status = normalizeSavedProfileProxyEditorStatusFilter(value);
    renderSavedProfileProxyEditors();
}

function setSavedProfileProxyEditorSortMode(value) {
    savedProfileProxyEditorFilters.sort = normalizeSavedProfileProxyEditorSortMode(value);
    renderSavedProfileProxyEditors();
}

function getVisibleSavedProfileProxiesForExport() {
    return getVisibleSavedProfileProxyEntries();
}

async function exportSavedProfileProxyEntries(entries, btn, options = {}) {
    const selected = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (selected.length === 0) {
        showAlert(String(options.emptyMessage || uiText('当前没有可导出的代理。', 'No saved proxies are available to export.')));
        return;
    }
    const format = String(document.getElementById('savedProfileProxyExportFormat')?.value || 'txt').trim().toLowerCase() === 'json'
        ? 'json'
        : 'txt';
    const restore = setDiagActionBusy(btn, true, uiText('导出中...', 'Exporting...'));
    try {
        const result = await window.electronAPI.invoke('export-saved-profile-proxies', {
            format,
            scopeLabel: String(options.scopeLabel || 'visible').trim() || 'visible',
            savedProfileProxies: selected,
        });
        if (result && result.canceled) return;
        showAlert(uiText(
            `已导出 ${Number(result && result.count || 0)} 条${String(options.successLabel || '')}代理（${format.toUpperCase()}）`,
            `Exported ${Number(result && result.count || 0)} ${String(options.successLabel || '')}proxies (${format.toUpperCase()})`
        ));
    } catch (e) {
        showAlert(`${uiText('导出失败', 'Export failed')}: ${e && e.message ? e.message : String(e)}`);
    } finally {
        restore();
    }
}

async function exportVisibleSavedProfileProxies(btn) {
    return exportSavedProfileProxyEntries(getVisibleSavedProfileProxiesForExport(), btn, {
        scopeLabel: 'visible',
        emptyMessage: uiText('当前没有可导出的代理。', 'No saved proxies match the current filter.'),
    });
}

async function exportSelectedSavedProfileProxies(btn) {
    return exportSavedProfileProxyEntries(getSelectedSavedProfileProxyEntries(), btn, {
        scopeLabel: 'selected',
        successLabel: uiText('已选', 'selected '),
        emptyMessage: uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'),
    });
}

async function exportSavedProfileProxyEntriesForSource(sourceId, scope = 'all', btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const staleOnly = String(scope || '').trim().toLowerCase() === 'stale';
    const entries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly });
    return exportSavedProfileProxyEntries(entries, btn, {
        scopeLabel: `${normalizeSavedProfileProxySourceId(sourceId)}-${staleOnly ? 'stale' : 'all'}`,
        successLabel: uiText(`${String((source && source.name) || sourceId || '').trim()} ${staleOnly ? '失效' : '关联'} `, `${String((source && source.name) || sourceId || '').trim()} ${staleOnly ? 'stale ' : 'linked '}`),
        emptyMessage: staleOnly
            ? uiText('这个来源下没有可导出的失效代理。', 'No stale proxies are available to export for this source.')
            : uiText('这个来源下没有可导出的关联代理。', 'No linked proxies are available to export for this source.'),
    });
}

async function executeSavedProfileProxyChangeIp(proxy) {
    const rawUrl = String(proxy && proxy.changeIpUrl || '').trim();
    if (!rawUrl) throw new Error(uiText('未配置 Change IP URL', 'Missing Change IP URL'));
    let target;
    try {
        target = new URL(rawUrl);
    } catch (e) {
        throw new Error(uiText('Change IP URL 格式无效。', 'Invalid Change IP URL.'));
    }
    if (!/^https?:$/i.test(target.protocol)) {
        throw new Error(uiText('Change IP URL 仅支持 HTTP/HTTPS。', 'Change IP URL only supports HTTP/HTTPS.'));
    }
    const response = await window.electronAPI.invoke('fetch-url', target.toString());
    const preview = String(response || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return {
        target: target.toString(),
        preview,
    };
}

async function triggerSavedProfileProxyChangeIp(savedProxyId, btn) {
    const targetId = normalizeSavedProxyId(savedProxyId);
    if (!targetId) return;
    const proxy = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
        .find((item) => normalizeSavedProxyId(item && item.id) === targetId);
    const restore = setDiagActionBusy(btn, true, uiText('切换中...', 'Rotating...'));
    try {
        const result = await executeSavedProfileProxyChangeIp(proxy);
        const lines = [
            uiText('已发送 IP 切换请求。', 'IP rotation request sent.'),
            `${uiText('目标', 'Target')}: ${result.target}`,
        ];
        if (result.preview) lines.push(`${uiText('响应', 'Response')}: ${result.preview}`);
        lines.push(uiText('如需确认结果，请稍后重新检测该代理。', 'Retest this proxy after a short delay if needed.'));
        showAlert(lines.join('\n'));
    } catch (e) {
        showAlert(`${uiText('IP 切换请求失败', 'IP rotation request failed')}: ${e && e.message ? e.message : String(e)}`);
    } finally {
        restore();
    }
}

async function runSelectedSavedProfileProxyTests(btn) {
    return runSavedProfileProxyTestsForEntries(getSelectedSavedProfileProxyEntries(), btn, {
        scopeLabel: uiText('已选', 'selected'),
        emptyMessage: uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'),
    });
}

async function runSavedProfileProxyTestsForEntries(entries, btn, options = {}) {
    const selected = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const ids = selected.map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean);
    if (ids.length === 0) {
        showAlert(String(options.emptyMessage || uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.')));
        return { total: 0, failed: 0 };
    }
    const scopeLabel = String(options.scopeLabel || '').trim();
    const refreshSourceEditors = options.refreshSourceEditors === true;
    const restore = setDiagActionBusy(btn, true, `${uiText('重测中...', 'Retesting...')} 0/${ids.length}`);
    let result = null;
    try {
        result = await runSavedProfileProxyTestsByIds(ids, {
            onProgress: ({ index, total }) => {
                if (btn) btn.textContent = `${uiText('重测中...', 'Retesting...')} ${index}/${total}`;
            },
        });
    } finally {
        restore();
    }
    if (refreshSourceEditors) renderSavedProfileProxySourceEditors();
    showAlert(uiText(
        `已重测 ${Number(result && result.total || 0)} 条${scopeLabel || '已选'}代理，失败 ${Number(result && result.failed || 0)} 条`,
        `Retested ${Number(result && result.total || 0)} ${scopeLabel || 'selected'} proxies, ${Number(result && result.failed || 0)} failed`
    ));
    return result;
}

async function rotateSelectedSavedProfileProxies(btn) {
    const selected = getSelectedSavedProfileProxyEntries();
    if (selected.length === 0) {
        showAlert(uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'));
        return;
    }
    const restore = setDiagActionBusy(btn, true, `${uiText('切换中...', 'Rotating...')} 0/${selected.length}`);
    let rotated = 0;
    let skipped = 0;
    let failed = 0;
    const failedNames = [];
    try {
        for (let index = 0; index < selected.length; index++) {
            const proxy = selected[index];
            if (btn) btn.textContent = `${uiText('切换中...', 'Rotating...')} ${index + 1}/${selected.length}`;
            if (!String(proxy && proxy.changeIpUrl || '').trim()) {
                skipped++;
                continue;
            }
            try {
                await executeSavedProfileProxyChangeIp(proxy);
                rotated++;
            } catch (e) {
                failed++;
                failedNames.push(String(proxy && (proxy.name || proxy.id) || '').trim());
            }
        }
    } finally {
        restore();
    }
    const messages = [
        uiText(`已发送 ${rotated} 条代理的切换 IP 请求`, `Sent IP rotation requests for ${rotated} proxies`),
    ];
    if (skipped > 0) messages.push(uiText(`跳过 ${skipped} 条未配置 URL 的代理`, `Skipped ${skipped} proxies without change-IP URL`));
    if (failed > 0) {
        messages.push(uiText(`失败 ${failed} 条`, `${failed} failed`));
        if (failedNames.length > 0) messages.push(`${uiText('示例', 'Examples')}: ${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? '...' : ''}`);
    }
    messages.push(uiText('如需确认结果，请稍后重测这些代理。', 'Retest these proxies after a short delay if needed.'));
    showAlert(messages.join('\n'));
}

function batchSetGroupForSelectedSavedProxies() {
    const selected = getSelectedSavedProfileProxyEntries();
    if (selected.length === 0) {
        showAlert(uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'));
        return;
    }
    const groupSet = Array.from(new Set(selected.map((proxy) => String(proxy && proxy.group || '').trim()).filter(Boolean)));
    showInput(
        uiText('设置所选代理分组', 'Set Group For Selected Proxies'),
        (value) => {
            const nextGroup = String(value || '').trim();
            if (!nextGroup) return;
            selected.forEach((proxy) => { proxy.group = nextGroup; });
            renderSavedProfileProxyEditors();
            showAlert(uiText(
                `已更新 ${selected.length} 条代理的分组，点击保存后持久化。`,
                `Updated group for ${selected.length} proxies. Click Save to persist.`
            ));
        },
        {
            value: groupSet.length === 1 ? groupSet[0] : '',
            placeholder: uiText('例如：US / Warmup / Team A', 'e.g. US / Warmup / Team A'),
            rows: 1,
        }
    );
}

async function deleteSavedProfileProxyEntries(entries, btn, options = {}) {
    const selected = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (selected.length === 0) {
        showAlert(String(options.emptyMessage || uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.')));
        return;
    }
    const scopeLabel = String(options.scopeLabel || '').trim();
    const selectedIds = new Set(selected.map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean));
    const profiles = await window.electronAPI.getProfiles();
    const affectedProfiles = (Array.isArray(profiles) ? profiles : [])
        .filter((profile) => selectedIds.has(normalizeSavedProxyId(profile && profile.savedProxyId)));
    const confirmed = await showConfirmAsync(
        affectedProfiles.length > 0
            ? uiText(
                `这 ${selected.length} 条${scopeLabel || '已选'}代理当前影响 ${affectedProfiles.length} 个环境。删除后这些环境会退回各自保存的 fallback proxyStr，确认继续吗？`,
                `${selected.length} ${scopeLabel || 'selected'} proxies affect ${affectedProfiles.length} profiles. Deleting them will make those profiles fall back to their stored fallback proxyStr. Continue?`
            )
            : uiText(
                `确定删除这 ${selected.length} 条${scopeLabel || ''}代理吗？`,
                `Delete ${selected.length} ${scopeLabel || ''} proxies?`
            ),
        {
            notes: affectedProfiles.slice(0, 8).map((profile) => profile && profile.name || profile && profile.id || '').filter(Boolean),
            confirmText: uiText('删除', 'Delete'),
        }
    );
    if (!confirmed) return;
    const restore = setDiagActionBusy(btn, true, uiText('删除中...', 'Deleting...'));
    try {
        advancedPresetState.savedProfileProxies = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .filter((proxy) => !selectedIds.has(normalizeSavedProxyId(proxy && proxy.id)));
        selectedIds.forEach((id) => {
            selectedSavedProfileProxyIds.delete(id);
            savedProfileProxyTestCache.delete(id);
        });
        renderAdvancedPresetEditors();
        showAlert(uiText(
            `已从草稿代理库移除 ${selected.length} 条${scopeLabel || ''}代理，点击保存后持久化。`,
            `Removed ${selected.length} ${scopeLabel || ''} proxies from the draft library. Click Save to persist.`
        ));
        return { deleted: selected.length, affectedProfilesCount: affectedProfiles.length };
    } finally {
        restore();
    }
}

async function deleteSelectedSavedProfileProxies(btn) {
    return deleteSavedProfileProxyEntries(getSelectedSavedProfileProxyEntries(), btn, {
        scopeLabel: uiText('已选', 'selected'),
        emptyMessage: uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'),
    });
}

async function deleteStaleSavedProfileProxiesForSource(sourceId, btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const staleEntries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly: true });
    return deleteSavedProfileProxyEntries(staleEntries, btn, {
        scopeLabel: uiText(`${String((source && source.name) || sourceId || '').trim()} 失效`, `${String((source && source.name) || sourceId || '').trim()} stale`),
        emptyMessage: uiText('这个来源下没有可删除的失效代理。', 'No stale proxies are available to delete for this source.'),
    });
}

async function retestSavedProfileProxiesForSource(sourceId, btn, options = {}) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const staleOnly = options.staleOnly === true;
    const entries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly });
    return runSavedProfileProxyTestsForEntries(entries, btn, {
        scopeLabel: uiText(
            `${String((source && source.name) || sourceId || '').trim()} ${staleOnly ? '失效' : '关联'}`,
            `${String((source && source.name) || sourceId || '').trim()} ${staleOnly ? 'stale' : 'linked'}`
        ),
        emptyMessage: staleOnly
            ? t('savedProxySourceRetestStaleEmpty')
            : t('savedProxySourceRetestLinkedEmpty'),
        refreshSourceEditors: true,
    });
}

async function quarantineFailedSavedProfileProxiesForSource(sourceId, btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const candidates = getSavedProfileProxyEntriesForSource(sourceId)
        .filter((proxy) => isSavedProfileProxyQuarantineCandidate(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))))
        .filter((proxy) => proxy && proxy.enabled !== false);
    if (candidates.length === 0) {
        showAlert(t('savedProxySourceQuarantineEmpty'));
        return { updated: 0 };
    }
    const selectedIds = new Set(candidates.map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean));
    const profiles = await window.electronAPI.getProfiles();
    const affectedProfiles = (Array.isArray(profiles) ? profiles : [])
        .filter((profile) => selectedIds.has(normalizeSavedProxyId(profile && profile.savedProxyId)));
    const confirmed = await showConfirmAsync(
        affectedProfiles.length > 0
            ? uiText(
                `这 ${candidates.length} 条代理已达到 quarantine 阈值，将被禁用并从候选池中排除；当前影响 ${affectedProfiles.length} 个环境，确认继续吗？`,
                `${candidates.length} proxies reached the quarantine threshold and will be disabled. They currently affect ${affectedProfiles.length} profiles. Continue?`
            )
            : uiText(
                `将把这 ${candidates.length} 条连续失败达到阈值的代理置入 quarantine（禁用），确认继续吗？`,
                `Disable ${candidates.length} proxies that reached the quarantine threshold?`
            ),
        {
            notes: candidates.slice(0, 8).map((proxy) => String(proxy && (proxy.name || proxy.id) || '').trim()).filter(Boolean),
            confirmText: t('savedProxySourceQuarantineConfirm'),
        }
    );
    if (!confirmed) return { updated: 0, canceled: true };
    const restore = setDiagActionBusy(btn, true, t('savedProxySourceQuarantineApplying'));
    try {
        candidates.forEach((proxy) => { proxy.enabled = false; });
        renderAdvancedPresetEditors();
        showAlert(uiText(
            `已将 ${candidates.length} 条代理置入 quarantine，点击保存后持久化。`,
            `Placed ${candidates.length} proxies into quarantine. Click Save to persist.`
        ));
        return { updated: candidates.length, affectedProfilesCount: affectedProfiles.length };
    } finally {
        restore();
    }
}

async function recheckQuarantinedSavedProfileProxiesForSource(sourceId, btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const candidates = getSavedProfileProxyEntriesForSource(sourceId)
        .filter((proxy) => isSavedProfileProxyQuarantined(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))));
    if (candidates.length === 0) {
        showAlert(t('savedProxySourceRecheckQuarantinedEmpty'));
        return { total: 0, failed: 0, recoveredCount: 0 };
    }
    const result = await runSavedProfileProxyTestsForEntries(candidates, btn, {
        scopeLabel: uiText(
            `${String((source && source.name) || sourceId || '').trim()} 已隔离`,
            `${String((source && source.name) || sourceId || '').trim()} quarantined`
        ),
        emptyMessage: t('savedProxySourceRecheckQuarantinedEmpty'),
        refreshSourceEditors: false,
    });
    let recoveredCount = 0;
    for (const proxy of candidates) {
        const proxyId = normalizeSavedProxyId(proxy && proxy.id);
        const current = savedProfileProxyTestCache.get(proxyId);
        if (proxy && proxy.enabled === false && current && current.success === true) {
            proxy.enabled = true;
            recoveredCount++;
        }
    }
    renderAdvancedPresetEditors();
    if (recoveredCount > 0) {
        showAlert(uiText(
            `已恢复 ${recoveredCount} 条通过重测的隔离代理，点击保存后持久化。`,
            `Recovered ${recoveredCount} quarantined proxies after successful retest. Click Save to persist.`
        ));
    }
    return {
        total: Number(result && result.total || 0),
        failed: Number(result && result.failed || 0),
        recoveredCount,
    };
}

function areSavedProfileProxyDraftSectionsEqual(left, right) {
    return JSON.stringify(cloneJson(left || [])) === JSON.stringify(cloneJson(right || []));
}

function getSavedProfileProxyDraftDirtySections() {
    const dirty = [];
    if (!areSavedProfileProxyDraftSectionsEqual(
        advancedPresetState.savedProfileProxySources,
        globalSettings && globalSettings.savedProfileProxySources
    )) {
        dirty.push(t('savedProfileProxySourcesTitle'));
    }
    if (!areSavedProfileProxyDraftSectionsEqual(
        advancedPresetState.savedProfileProxies,
        globalSettings && globalSettings.savedProfileProxies
    )) {
        dirty.push(t('savedProfileProxiesTitle'));
    }
    return dirty;
}

async function reloadSavedProfileProxyEditorStateFromSettings() {
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    savedProfileProxySourceOriginalIds = new Set(
        ((settings && settings.savedProfileProxySources) || []).map((source) => normalizeSavedProfileProxySourceId(source && source.id)).filter(Boolean)
    );
    savedProfileProxyOriginalIds = new Set(
        ((settings && settings.savedProfileProxies) || []).map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean)
    );
    advancedPresetState.savedProfileProxySources = cloneJson((settings && settings.savedProfileProxySources) || []);
    advancedPresetState.savedProfileProxies = cloneJson((settings && settings.savedProfileProxies) || []);
    pruneSelectedSavedProfileProxyIds();
    await refreshSavedProfileProxyUsageCounts();
    await refreshSavedProfileProxyTestCache(advancedPresetState.savedProfileProxies.map((proxy) => proxy && proxy.id));
    renderAdvancedPresetEditors();
    renderSavedProfileProxySelect('addSavedProxyId', settings, document.getElementById('addSavedProxyId')?.value || '');
    renderSavedProfileProxySelect('editSavedProxyId', settings, document.getElementById('editSavedProxyId')?.value || '');
    renderSavedProfileProxySelect('batchSavedProxyId', settings, document.getElementById('batchSavedProxyId')?.value || '');
    renderSavedProfileProxySelect('batchReplaceSavedProxyFromId', settings, document.getElementById('batchReplaceSavedProxyFromId')?.value || '');
    renderSavedProfileProxySelect('batchReplaceSavedProxyToId', settings, document.getElementById('batchReplaceSavedProxyToId')?.value || '');
    syncSavedProxyBindingInfo('add', settings);
    syncSavedProxyBindingInfo('edit', settings);
    syncBatchSavedProxyBindInfo();
    syncBatchReplaceSavedProxyInfo();
    syncBatchRandomSavedProxyInfo();
    handleSavedProfileProxyChange('add');
    handleSavedProfileProxyChange('edit');
    return settings;
}

async function requestSavedProfileProxySourceMaintenance(sourceId) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw new Error(uiText('缺少来源 ID', 'Missing source id'));
    return postLocalApiJson(`/saved-profile-proxy-sources/${encodeURIComponent(targetId)}/actions/run-maintenance`, {});
}

async function requestSavedProfileProxySourceAttentionMaintenance() {
    return postLocalApiJson('/saved-profile-proxy-sources/actions/attention-maintenance', {});
}

function summarizeSavedProfileProxySourceMaintenanceResult(result) {
    const refreshResult = result && result.refreshResult ? result.refreshResult : {};
    const importResult = refreshResult && refreshResult.importResult ? refreshResult.importResult : {};
    return {
        addedCount: Math.max(0, Number(importResult.addedCount || importResult.importedCount) || 0),
        quarantinedCount: Math.max(0, Number(result && result.quarantineResult && result.quarantineResult.count) || 0),
        recoveredCount: Math.max(0, Number(result && result.recheckResult && result.recheckResult.recoveredCount) || 0),
    };
}

async function persistSavedProfileProxySourceBatchHistoryEntry(entry) {
    const settings = await window.electronAPI.getSettings();
    settings.savedProfileProxySourceBatchHistory = normalizeSavedProfileProxySourceBatchHistory([
        entry,
        ...((settings && settings.savedProfileProxySourceBatchHistory) || []),
    ]);
    await window.electronAPI.saveSettings(settings);
    globalSettings = settings || globalSettings;
    return settings.savedProfileProxySourceBatchHistory;
}

async function runSavedProfileProxySourceMaintenanceAction(sourceId, btn) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) return;
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === targetId);
    const sourceLabel = String((source && source.name) || targetId || '').trim() || targetId;
    const dirtySections = getSavedProfileProxyDraftDirtySections();
    if (dirtySections.length > 0) {
        const confirmed = await showConfirmAsync(
            uiText(
                `当前还有未保存草稿（${dirtySections.join(' / ')}）。立即维护会使用“已保存配置”，并在完成后回载来源区与代理库，未保存改动会丢失。是否继续？`,
                `There are unsaved drafts in ${dirtySections.join(' / ')}. Run Maintenance uses the saved config and reloads the source + proxy library after completion, so unsaved edits in those sections will be lost. Continue?`
            ),
            {
                notes: [
                    uiText('建议先保存来源区与代理库后再执行维护。', 'Save the source section and proxy library first if you want the latest draft to be used.'),
                ],
                confirmText: uiText('继续维护', 'Continue'),
                confirmDanger: false,
            }
        );
        if (!confirmed) return;
    }
    const restore = setDiagActionBusy(btn, true, t('savedProxySourceMaintenanceRunning'));
    try {
        const result = await requestSavedProfileProxySourceMaintenance(targetId);
        await reloadSavedProfileProxyEditorStateFromSettings();
        const { addedCount, quarantinedCount, recoveredCount } = summarizeSavedProfileProxySourceMaintenanceResult(result);
        showAlert([
            uiText(`已执行维护：${sourceLabel}`, `Maintenance completed: ${sourceLabel}`),
            uiText(`新增代理 ${addedCount} 条`, `Added ${addedCount} proxies`),
            uiText(`隔离 ${quarantinedCount} 条`, `Quarantined ${quarantinedCount}`),
            uiText(`恢复 ${recoveredCount} 条`, `Recovered ${recoveredCount}`),
            uiText('来源区与代理库已按已保存配置重新载入。', 'The source editor and proxy library were reloaded from saved settings.'),
        ].join('\n'));
    } catch (e) {
        showAlert(`${uiText('维护失败', 'Maintenance failed')}: ${e && e.message ? e.message : String(e)}`);
    } finally {
        restore();
    }
}

async function runSavedProfileProxySourceBulkMaintenanceAction() {
    if (savedProfileProxySourceBulkMaintenanceState && savedProfileProxySourceBulkMaintenanceState.running) return;
    const dirtySections = getSavedProfileProxyDraftDirtySections();
    if (dirtySections.length > 0) {
        const confirmed = await showConfirmAsync(
            uiText(
                `当前还有未保存草稿（${dirtySections.join(' / ')}）。总览一键维护会使用“已保存配置”，并在开始前回载来源区与代理库，未保存改动会丢失。是否继续？`,
                `There are unsaved drafts in ${dirtySections.join(' / ')}. Overview maintenance uses the saved config and reloads the source + proxy library before starting, so unsaved edits in those sections will be lost. Continue?`
            ),
            {
                notes: [
                    uiText('建议先保存来源区与代理库后再执行总览维护。', 'Save the source section and proxy library first if you want the latest draft to be used.'),
                ],
                confirmText: uiText('继续维护', 'Continue'),
                confirmDanger: false,
            }
        );
        if (!confirmed) return;
        try {
            await reloadSavedProfileProxyEditorStateFromSettings();
        } catch (e) {
            showAlert(`${uiText('总览维护失败', 'Overview maintenance failed')}: ${e && e.message ? e.message : String(e)}`);
            return;
        }
    }
    const sources = Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [];
    const targets = getSavedProfileProxySourceBulkMaintenanceTargets(sources);
    if (targets.length === 0) {
        showAlert(uiText('当前没有需要总览一键维护的来源。', 'No saved proxy source currently needs overview maintenance.'));
        return;
    }
    savedProfileProxySourceBulkMaintenanceState = createSavedProfileProxySourceBulkMaintenanceState({
        running: true,
        total: targets.length,
        currentIndex: 0,
        currentSourceLabel: uiText('正在通过本地 API 执行...', 'Running through local API...'),
    });
    renderSavedProfileProxySourceEditors();
    let result = null;
    try {
        result = await requestSavedProfileProxySourceAttentionMaintenance();
    } catch (e) {
        savedProfileProxySourceBulkMaintenanceState = createSavedProfileProxySourceBulkMaintenanceState();
        renderSavedProfileProxySourceEditors();
        showAlert(`${uiText('总览维护失败', 'Overview maintenance failed')}: ${e && e.message ? e.message : String(e)}`);
        return;
    }
    let reloadError = '';
    try {
        await reloadSavedProfileProxyEditorStateFromSettings();
    } catch (e) {
        reloadError = e && e.message ? e.message : String(e);
        renderAdvancedPresetEditors();
    }
    if (result && Array.isArray(result.history)) {
        globalSettings = {
            ...(globalSettings || {}),
            savedProfileProxySourceBatchHistory: normalizeSavedProfileProxySourceBatchHistory(result.history),
        };
    }
    const batchHistoryEntry = normalizeSavedProfileProxySourceBatchHistoryEntry(result && result.historyEntry ? result.historyEntry : {});
    const finalBatchHistoryEntry = batchHistoryEntry.finishedAt > 0
        ? batchHistoryEntry
        : getLatestSavedProfileProxySourceBatchHistoryEntry('attention-maintenance');
    savedProfileProxySourceBulkMaintenanceState = createSavedProfileProxySourceBulkMaintenanceState({
        lastSummary: finalBatchHistoryEntry && finalBatchHistoryEntry.finishedAt > 0 ? finalBatchHistoryEntry : null,
    });
    renderSavedProfileProxySourceEditors();
    const failedLabels = Array.isArray(result && result.failures)
        ? result.failures
            .map((item) => `${item && (item.label || item.sourceId) || '-'}: ${item && item.error ? item.error : '-'}`)
            .filter(Boolean)
        : [];
    const completedTotal = Math.max(0, Number(result && result.total || 0)) || targets.length;
    const lines = [
        uiText(`总览维护完成：共 ${completedTotal} 个来源`, `Overview maintenance completed: ${completedTotal} sources`),
        uiText(`成功 ${Math.max(0, Number(result && result.ok || 0))} 个`, `${Math.max(0, Number(result && result.ok || 0))} succeeded`),
        uiText(`失败 ${Math.max(0, Number(result && result.failed || 0))} 个`, `${Math.max(0, Number(result && result.failed || 0))} failed`),
        uiText(`新增代理 ${Math.max(0, Number(result && result.added || 0))} 条`, `Added ${Math.max(0, Number(result && result.added || 0))} proxies`),
        uiText(`隔离 ${Math.max(0, Number(result && result.quarantined || 0))} 条`, `Quarantined ${Math.max(0, Number(result && result.quarantined || 0))}`),
        uiText(`恢复 ${Math.max(0, Number(result && result.recovered || 0))} 条`, `Recovered ${Math.max(0, Number(result && result.recovered || 0))}`),
    ];
    if (failedLabels.length > 0) {
        lines.push(`${uiText('示例', 'Examples')}: ${failedLabels.slice(0, 3).join(' | ')}${failedLabels.length > 3 ? '...' : ''}`);
    }
    if (reloadError) {
        lines.push(`${uiText('回载失败', 'Reload failed')}: ${reloadError}`);
    } else {
        lines.push(uiText('来源区与代理库已按已保存配置重新载入。', 'The source editor and proxy library were reloaded from saved settings.'));
    }
    showAlert(lines.filter(Boolean).join('\n'));
}

async function setEnabledForSavedProfileProxyEntries(entries, nextEnabled, btn, options = {}) {
    const selected = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (selected.length === 0) {
        showAlert(uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'));
        return { updated: 0 };
    }
    const scopeLabel = String(options.scopeLabel || '').trim();
    if (nextEnabled !== true) {
        const selectedIds = new Set(selected.map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean));
        const profiles = await window.electronAPI.getProfiles();
        const affectedProfiles = (Array.isArray(profiles) ? profiles : [])
            .filter((profile) => selectedIds.has(normalizeSavedProxyId(profile && profile.savedProxyId)));
        if (affectedProfiles.length > 0) {
            const confirmed = await showConfirmAsync(
                uiText(
                    `这 ${selected.length} 条${scopeLabel || '已选'}代理当前影响 ${affectedProfiles.length} 个环境。禁用后不会立刻打断现有绑定，但会从随机分配和候选列表中排除，确认继续吗？`,
                    `${selected.length} ${scopeLabel || 'selected'} proxies affect ${affectedProfiles.length} profiles. Disabling them will not break existing bindings immediately, but they will be excluded from random assignment and candidate lists. Continue?`
                ),
                {
                    notes: affectedProfiles.slice(0, 8).map((profile) => profile && profile.name || profile && profile.id || '').filter(Boolean),
                    confirmText: uiText('禁用', 'Disable'),
                }
            );
            if (!confirmed) return { updated: 0, canceled: true };
        }
    }
    const restore = setDiagActionBusy(btn, true, nextEnabled ? uiText('启用中...', 'Enabling...') : uiText('禁用中...', 'Disabling...'));
    try {
        selected.forEach((proxy) => { proxy.enabled = nextEnabled === true; });
        renderSavedProfileProxyEditors();
        showAlert(uiText(
            `${nextEnabled ? '已启用' : '已禁用'} ${selected.length} 条${scopeLabel || ''}代理，点击保存后持久化。`,
            `${nextEnabled ? 'Enabled' : 'Disabled'} ${selected.length} ${scopeLabel || ''} proxies. Click Save to persist.`
        ));
        return { updated: selected.length };
    } finally {
        restore();
    }
}

async function setEnabledForSelectedSavedProfileProxies(nextEnabled, btn) {
    return setEnabledForSavedProfileProxyEntries(getSelectedSavedProfileProxyEntries(), nextEnabled, btn, {
        scopeLabel: uiText('已选', 'selected'),
    });
}

async function disableVisibleStaleSavedProfileProxies(btn) {
    const staleVisible = getVisibleStaleSavedProfileProxyEntries();
    if (staleVisible.length === 0) {
        showAlert(uiText('当前筛选结果里没有来源失效代理。', 'No stale proxies are visible in the current filter.'));
        return;
    }
    return setEnabledForSavedProfileProxyEntries(staleVisible, false, btn, {
        scopeLabel: uiText('当前失效', 'visible stale'),
    });
}

async function detachSourceForSelectedSavedProfileProxies(btn) {
    return detachSourceForSavedProfileProxyEntries(
        getSelectedSavedProfileProxyEntries().filter((proxy) => getSavedProfileProxySourceState(proxy).id),
        btn,
        { scopeLabel: uiText('已选', 'selected') }
    );
}

async function detachSourceForSavedProfileProxyEntries(entries, btn, options = {}) {
    const selected = Array.isArray(entries) ? entries.filter((proxy) => getSavedProfileProxySourceState(proxy).id) : [];
    if (selected.length === 0) {
        showAlert(uiText('没有可解除来源绑定的代理。', 'No proxies with source bindings are available to detach.'));
        return;
    }
    const scopeLabel = String(options.scopeLabel || '').trim();
    const confirmed = await showConfirmAsync(
        uiText(
            `这会把 ${selected.length} 条${scopeLabel || ''}代理从来源同步中解除，保留代理本身但转为手动条目。确认继续吗？`,
            `This will detach ${selected.length} ${scopeLabel || ''} proxies from source sync, keeping the proxies but turning them into manual entries. Continue?`
        ),
        {
            notes: selected.slice(0, 8).map((proxy) => String(proxy && (proxy.name || proxy.id) || '').trim()).filter(Boolean),
            confirmText: uiText('解除来源', 'Detach Source'),
        }
    );
    if (!confirmed) return;
    const restore = setDiagActionBusy(btn, true, uiText('处理中...', 'Applying...'));
    try {
        selected.forEach((proxy) => {
            proxy.sourceId = '';
            proxy.sourceName = '';
            proxy.sourceImportedAt = 0;
            proxy.sourceStale = false;
            proxy.sourceMissingSince = 0;
        });
        renderAdvancedPresetEditors();
        showAlert(uiText(
            `已解除 ${selected.length} 条${scopeLabel || ''}代理的来源绑定，点击保存后持久化。`,
            `Detached source bindings for ${selected.length} ${scopeLabel || ''} proxies. Click Save to persist.`
        ));
    } finally {
        restore();
    }
}

async function disableStaleSavedProfileProxiesForSource(sourceId, btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const staleEntries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly: true });
    if (staleEntries.length === 0) {
        showAlert(uiText('这个来源下没有可禁用的失效代理。', 'No stale proxies are available to disable for this source.'));
        return;
    }
    return setEnabledForSavedProfileProxyEntries(staleEntries, false, btn, {
        scopeLabel: uiText(`${String((source && source.name) || sourceId || '').trim()} 失效`, `${String((source && source.name) || sourceId || '').trim()} stale`),
    });
}

async function detachStaleSavedProfileProxiesForSource(sourceId, btn) {
    const source = (Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [])
        .find((item) => normalizeSavedProfileProxySourceId(item && item.id) === normalizeSavedProfileProxySourceId(sourceId));
    const staleEntries = getSavedProfileProxyEntriesForSource(sourceId, { staleOnly: true });
    if (staleEntries.length === 0) {
        showAlert(uiText('这个来源下没有可解除的失效代理。', 'No stale proxies are available to detach for this source.'));
        return;
    }
    return detachSourceForSavedProfileProxyEntries(staleEntries, btn, {
        scopeLabel: uiText(`${String((source && source.name) || sourceId || '').trim()} 失效`, `${String((source && source.name) || sourceId || '').trim()} stale`),
    });
}

function normalizeBatchSavedProxyTagInput(value) {
    return Array.from(new Set(parseSavedProfileProxyImportTags(value)));
}

function editTagsForSelectedSavedProfileProxies(mode = 'set') {
    const selected = getSelectedSavedProfileProxyEntries();
    if (selected.length === 0) {
        showAlert(uiText('请先选择至少一条代理。', 'Select at least one saved proxy first.'));
        return;
    }
    const normalizedMode = ['set', 'add', 'remove'].includes(String(mode || '').trim()) ? String(mode).trim() : 'set';
    const currentTags = Array.from(new Set(selected.flatMap((proxy) => Array.isArray(proxy && proxy.tags) ? proxy.tags : []).map((item) => String(item || '').trim()).filter(Boolean)));
    const titleMap = {
        set: uiText('设置所选代理标签', 'Set Tags For Selected Proxies'),
        add: uiText('为所选代理追加标签', 'Add Tags To Selected Proxies'),
        remove: uiText('移除所选代理标签', 'Remove Tags From Selected Proxies'),
    };
    showInput(
        titleMap[normalizedMode],
        (value) => {
            const tags = normalizeBatchSavedProxyTagInput(value);
            selected.forEach((proxy) => {
                const current = Array.isArray(proxy.tags) ? proxy.tags.map((item) => String(item || '').trim()).filter(Boolean) : [];
                if (normalizedMode === 'set') {
                    proxy.tags = [...tags];
                    return;
                }
                if (normalizedMode === 'add') {
                    proxy.tags = Array.from(new Set([...current, ...tags]));
                    return;
                }
                if (normalizedMode === 'remove') {
                    const removeSet = new Set(tags);
                    proxy.tags = current.filter((item) => !removeSet.has(item));
                }
            });
            renderSavedProfileProxyEditors();
            showAlert(uiText(
                `已更新 ${selected.length} 条代理的标签，点击保存后持久化。`,
                `Updated tags for ${selected.length} proxies. Click Save to persist.`
            ));
        },
        {
            value: normalizedMode === 'set' && currentTags.length <= 12 ? currentTags.join(', ') : '',
            placeholder: uiText('逗号或换行分隔，例如：us, warmup, residential', 'Comma or newline separated, e.g. us, warmup, residential'),
            rows: 3,
            allowEmpty: normalizedMode === 'set',
        }
    );
}

async function confirmSavedProfileProxyImpact(proxy, mode = 'delete') {
    const savedProxyId = normalizeSavedProxyId(proxy && proxy.id);
    if (!savedProxyId) return true;
    const profiles = await window.electronAPI.getProfiles();
    const affected = (Array.isArray(profiles) ? profiles : []).filter((profile) => normalizeSavedProxyId(profile && profile.savedProxyId) === savedProxyId);
    if (affected.length === 0) return true;
    const message = mode === 'disable'
        ? uiText(
            `这个代理库条目当前被 ${affected.length} 个环境绑定。禁用后不会立刻打断现有绑定，但会从随机分配和候选列表中排除，确认继续吗？`,
            `This saved proxy is bound to ${affected.length} profiles. Disabling it will not break existing bindings immediately, but it will be excluded from random assignment and candidate lists. Continue?`
        )
        : uiText(
            `这个代理库条目当前被 ${affected.length} 个环境绑定。删除后这些环境会退回各自保存的 fallback proxyStr，确认继续吗？`,
            `This saved proxy is bound to ${affected.length} profiles. Deleting it will make those profiles fall back to their stored fallback proxyStr. Continue?`
        );
    return showConfirmAsync(
        message,
        {
            notes: affected.slice(0, 8).map((profile) => profile && profile.name || profile && profile.id || '').filter(Boolean),
        }
    );
}

async function executeSavedProfileProxyTest(proxy) {
    const id = normalizeSavedProxyId(proxy && proxy.id);
    if (!id) throw new Error('Saved proxy not found');
    const currentProxy = String(proxy && proxy.proxyStr || '').trim();
    const libraryProxy = findSavedProfileProxyById(globalSettings, id);
    if (libraryProxy && String(libraryProxy.proxyStr || '').trim() === currentProxy) {
        return window.electronAPI.invoke('test-saved-profile-proxy', id);
    }
    return {
        ...((await window.electronAPI.invoke('test-proxy', currentProxy)) || {}),
        proxySource: 'saved-library-draft',
        savedProxyId: id,
        savedProxyName: proxy && (proxy.name || id),
        proxySnapshot: currentProxy,
    };
}

function buildSavedProfileProxyTestFailure(proxy, error) {
    return {
        success: false,
        status: 'warn',
        error: error && error.message ? error.message : String(error),
        checkedAt: Date.now(),
        savedProxyId: normalizeSavedProxyId(proxy && proxy.id),
        savedProxyName: proxy && (proxy.name || proxy.id),
        proxySnapshot: String(proxy && proxy.proxyStr || '').trim(),
        proxySource: 'saved-library-draft',
    };
}

async function runSavedProfileProxyTestsByIds(savedProxyIds, options = {}) {
    const ids = Array.from(new Set((Array.isArray(savedProxyIds) ? savedProxyIds : []).map((item) => normalizeSavedProxyId(item)).filter(Boolean)));
    let failed = 0;
    for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        const proxy = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
            .find((item) => normalizeSavedProxyId(item && item.id) === id);
        if (!proxy) continue;
        if (typeof options.onProgress === 'function') options.onProgress({ index: index + 1, total: ids.length, proxy });
        try {
            const result = await executeSavedProfileProxyTest(proxy);
            setSavedProfileProxyTestCacheEntry(id, result);
        } catch (e) {
            failed++;
            setSavedProfileProxyTestCacheEntry(id, buildSavedProfileProxyTestFailure(proxy, e));
        }
        renderSavedProfileProxyEditors();
    }
    return { total: ids.length, failed };
}

function shouldPersistSavedProfileProxyDraftResult(proxy, result) {
    const current = normalizeSavedProfileProxyTestResultEntry(result);
    if (!proxy || !current.checkedAt) return false;
    if (String(current.proxySource || '').trim() !== 'saved-library-draft') return false;
    if (normalizeSavedProxyId(proxy.id) !== normalizeSavedProxyId(current.savedProxyId)) return false;
    return normalizeProxyTestInput(proxy.proxyStr || '') === normalizeProxyTestInput(current.proxySnapshot || '');
}

async function persistSavedProfileProxyDraftTests(savedProfileProxies, latestSettings = globalSettings) {
    const list = Array.isArray(savedProfileProxies) ? savedProfileProxies : [];
    let persisted = 0;
    for (const proxy of list) {
        const id = normalizeSavedProxyId(proxy && proxy.id);
        const current = savedProfileProxyTestCache.get(id);
        if (!shouldPersistSavedProfileProxyDraftResult(proxy, current)) continue;
        try {
            const persistedResult = await window.electronAPI.invoke('persist-saved-profile-proxy-test', {
                savedProxyId: id,
                result: {
                    ...current,
                    savedProxyId: id,
                    savedProxyName: proxy.name || id,
                    proxySnapshot: String(proxy.proxyStr || '').trim(),
                    proxySource: 'saved-library',
                },
            });
            savedProfileProxyTestCache.set(id, persistedResult && typeof persistedResult === 'object'
                ? normalizeSavedProfileProxyTestResultEntry(persistedResult)
                : normalizeSavedProfileProxyTestResultEntry(current));
            persisted++;
        } catch (e) { }
    }
    globalSettings = latestSettings || globalSettings;
    return persisted;
}

async function runSavedProfileProxyTest(savedProxyId, btn) {
    const id = normalizeSavedProxyId(savedProxyId);
    if (!id) return;
    const proxy = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
        .find((item) => normalizeSavedProxyId(item && item.id) === id);
    if (!proxy) return;
    const restore = setDiagActionBusy(btn, true, t('proxyTestTesting'));
    try {
        const result = await executeSavedProfileProxyTest(proxy);
        setSavedProfileProxyTestCacheEntry(id, result);
        renderSavedProfileProxyEditors();
    } catch (e) {
        setSavedProfileProxyTestCacheEntry(id, buildSavedProfileProxyTestFailure(proxy, e));
        renderSavedProfileProxyEditors();
        showAlert(`Error: ${e && e.message ? e.message : String(e)}`);
    } finally {
        restore();
    }
}

async function runVisibleSavedProfileProxyTests(btn) {
    const visible = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
        .filter((proxy) => matchesSavedProfileProxyEditorFilters(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))));
    if (visible.length === 0) {
        showAlert(uiText('当前筛选结果里没有可检测的代理。', 'No saved proxies match the current filter.'));
        return;
    }
    const restore = setDiagActionBusy(btn, true, `${t('proxyTestTesting')} 0/${visible.length}`);
    try {
        await runSavedProfileProxyTestsByIds(visible.map((proxy) => proxy && proxy.id), {
            onProgress: ({ index, total }) => {
                if (btn) btn.textContent = `${t('proxyTestTesting')} ${index}/${total}`;
            },
        });
    } finally {
        restore();
    }
}

async function openEditModal(id) {
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    currentEditId = id;
    const fp = p.fingerprint || {};
    document.getElementById('editName').value = p.name;
    document.getElementById('editProxy').value = p.proxyStr;
    document.getElementById('editTags').value = (p.tags || []).join(', ');
    document.getElementById('editStartupUrls').value = Array.isArray(p.startupUrls) ? p.startupUrls.join('\n') : '';

    // 回填时区，将 "Auto" 转换为 "Auto (No Change)" 显示
    const savedTimezone = fp.timezone || 'Auto';
    const displayTimezone = savedTimezone === 'Auto' ? 'Auto (No Change)' : savedTimezone;
    document.getElementById('editTimezone').value = displayTimezone;

    initCustomCityDropdown('editCity', 'editCityDropdown');

    // Use stored value directly or Default English Auto
    const savedCity = fp.city || "Auto (IP Based)";
    document.getElementById('editCity').value = savedCity;

    const sel = document.getElementById('editPreProxyOverride');
    sel.options[0].text = t('optDefault'); sel.options[1].text = t('optOn'); sel.options[2].text = t('optOff');
    sel.value = p.preProxyOverride || 'default';
    document.getElementById('editResW').value = fp.screen?.width || 1920;
    document.getElementById('editResH').value = fp.screen?.height || 1080;
    const editWindow = resolveEditWindowSize(fp);
    document.getElementById('editWindowW').value = editWindow.width;
    document.getElementById('editWindowH').value = editWindow.height;

    // Init Language Dropdown
    initCustomLanguageDropdown('editLanguage', 'editLanguageDropdown');
    document.getElementById('editLanguage').value = getLanguageName(fp.language || 'auto');

    // Load debug port and show/hide based on global setting
    const settings = await window.electronAPI.getSettings();
    globalSettings = settings || globalSettings;
    renderHeaderPresetSelect('editHeaderPresetId', settings, p.headerPresetId || '');
    renderSavedProfileProxySelect('editSavedProxyId', settings, p.savedProxyId || '');
    renderProfileExtensionSelector('edit', settings, p.extensionPaths || [], p.useGlobalExtensions !== false);
    document.getElementById('editGeoPermissionMode').value = p.geoPermissionMode || 'auto';
    document.getElementById('editCameraPermissionMode').value = p.cameraPermissionMode || 'auto';
    document.getElementById('editMicrophonePermissionMode').value = p.microphonePermissionMode || 'auto';
    document.getElementById('editNotificationPermissionMode').value = p.notificationPermissionMode || 'auto';
    const debugPortSection = document.getElementById('debugPortSection');
    if (settings.enableRemoteDebugging) {
        debugPortSection.style.display = 'block';
        document.getElementById('editDebugPort').value = p.debugPort || '';
    } else {
        debugPortSection.style.display = 'none';
    }

    // Load fingerprint tab data
    loadFingerprintTab(fp);
    window._editFontsTemp = null; // Reset temp fonts
    
    // Initialize fingerprint button groups
    initFpButtonGroups();

    // Reset to basic tab
    setActiveEditTab('basic');
    // Load custom args and show/hide based on global setting
    const customArgsSection = document.getElementById('customArgsSection');
    if (settings.enableCustomArgs) {
        customArgsSection.style.display = 'block';
        document.getElementById('editCustomArgs').value = p.customArgs || '';
    } else {
        customArgsSection.style.display = 'none';
    }

    resetSavedProxyBindingDraft('edit');
    clearProxyTestState('edit');
    applySavedProxyFallbackToInput('edit', settings);
    syncSavedProxyBindingInfo('edit', settings);
    document.getElementById('editModal').style.display = 'flex';
    await hydrateEditProxyTestState(id, document.getElementById('editProxy').value);
}
function closeEditModal() { 
    document.getElementById('editModal').style.display = 'none'; 
    currentEditId = null;
    resetSavedProxyBindingDraft('edit');
    clearProxyTestState('edit');
    // Reset to basic tab (directly, without using event)
    setActiveEditTab('basic');
}

// Edit Modal Tab Switching
function setActiveEditTab(tabName) {
    const nextTab = ['basic', 'fingerprint', 'backup'].includes(tabName) ? tabName : 'basic';
    document.querySelectorAll('#editModal [data-edit-tab]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.editTab === nextTab);
    });

    document.querySelectorAll('#editModal .edit-tab-section').forEach((section) => {
        section.style.display = section.id === `edit-tab-${nextTab}` ? 'block' : 'none';
    });
}

function switchEditTab(tabName) {
    setActiveEditTab(tabName);
}

// Load fingerprint data into the fingerprint tab
function loadFingerprintTab(fp) {
    // User Agent
    document.getElementById('editUserAgent').value = fp.userAgent || '';
    
    // WebGL
    const webgl = fp.webgl || {};
    document.getElementById('editWebGLVendor').value = webgl.vendor || 'Google Inc.';
    document.getElementById('editWebGLRenderer').value = webgl.renderer || 'ANGLE (NVIDIA)';
    
    // Hardware
    document.getElementById('editHardwareConcurrency').value = fp.hardwareConcurrency || 8;
    document.getElementById('editDeviceMemory').value = fp.deviceMemory || 8;
    document.getElementById('editColorDepth').value = fp.colorDepth || 24;
    document.getElementById('editPixelRatio').value = fp.pixelRatio || 1;
    document.getElementById('editMaxTouchPoints').value = fp.maxTouchPoints !== undefined ? fp.maxTouchPoints : 0;
    document.getElementById('editDoNotTrack').value = fp.doNotTrack !== undefined ? String(fp.doNotTrack) : 'null';
    
    // Network
    const conn = fp.connection || {};
    document.getElementById('editConnectionType').value = conn.type || 'wifi';
    document.getElementById('editEffectiveType').value = conn.effectiveType || '4g';
    document.getElementById('editDownlink').value = conn.downlink || 10;
    document.getElementById('editRTT').value = conn.rtt || 50;
    
    // Fonts
    renderFontsPreview(fp.fonts || []);
    
    // Protection settings (button groups)
    loadProtectionSettings(fp);
}

// Render fonts preview as tags
function renderFontsPreview(fonts) {
    const container = document.getElementById('editFontsPreview');
    if (!container) return;
    container.innerHTML = fonts.map(font => 
        `<span class="fp-font-tag">${font}</span>`
    ).join('');
}

// Regenerate User Agent
async function regenerateUserAgent() {
    const newFp = await window.electronAPI.invoke('generate-fingerprint');
    if (newFp && newFp.userAgent) {
        document.getElementById('editUserAgent').value = newFp.userAgent;
        showAlert(t('fpRegenerated') || 'User Agent regenerated');
    }
}

// Regenerate WebGL
async function regenerateWebGL() {
    const newFp = await window.electronAPI.invoke('generate-fingerprint');
    if (newFp && newFp.webgl) {
        document.getElementById('editWebGLVendor').value = newFp.webgl.vendor;
        document.getElementById('editWebGLRenderer').value = newFp.webgl.renderer;
        showAlert(t('fpRegenerated') || 'WebGL regenerated');
    }
}

// Regenerate Hardware
async function regenerateHardware() {
    const newFp = await window.electronAPI.invoke('generate-fingerprint');
    if (newFp) {
        document.getElementById('editHardwareConcurrency').value = newFp.hardwareConcurrency;
        document.getElementById('editDeviceMemory').value = newFp.deviceMemory;
        showAlert(t('fpRegenerated') || 'Hardware regenerated');
    }
}

// Regenerate Fonts
async function regenerateFonts() {
    const newFp = await window.electronAPI.invoke('generate-fingerprint');
    if (newFp && newFp.fonts) {
        renderFontsPreview(newFp.fonts);
        // Store in a temp variable for saving
        window._editFontsTemp = newFp.fonts;
        showAlert(t('fpRegenerated') || 'Fonts regenerated');
    }
}

// Initialize fingerprint button groups
function initFpButtonGroups() {
    document.querySelectorAll('.fp-btn-group').forEach(group => {
        group.querySelectorAll('.fp-btn').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                // Remove active from siblings
                this.parentElement.querySelectorAll('.fp-btn').forEach(b => b.classList.remove('active'));
                // Add active to clicked
                this.classList.add('active');
            });
        });
    });
}

// Load protection settings into button groups
function loadProtectionSettings(fp) {
    const settings = fp.protection || {};
    
    const fields = ['canvasNoise', 'webglNoise', 'clientRects', 'audioNoise', 'speechVoices', 'mediaDevices', 'portScanProtection', 'webrtcMode'];
    const defaults = {
        canvasNoise: 'off',
        webglNoise: 'off',
        clientRects: 'off',
        audioNoise: 'off',
        speechVoices: 'off',
        mediaDevices: 'off',
        portScanProtection: 'off',
        webrtcMode: 'privacy',
    };
    
    fields.forEach(field => {
        const value = settings[field] !== undefined ? settings[field] : (defaults[field] || 'off');
        const btns = document.querySelectorAll(`.fp-btn[data-field="${field}"]`);
        btns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.value === value);
        });
    });
}

// Get protection settings from button groups
function getProtectionSettings() {
    const settings = {};
    const fields = ['canvasNoise', 'webglNoise', 'clientRects', 'audioNoise', 'speechVoices', 'mediaDevices', 'portScanProtection', 'webrtcMode'];
    
    fields.forEach(field => {
        const activeBtn = document.querySelector(`.fp-btn[data-field="${field}"].active`);
        if (activeBtn) {
            settings[field] = activeBtn.dataset.value;
        }
    });
    
    return settings;
}
async function saveEditProfile() {
    console.log('[saveEditProfile] Called, currentEditId:', currentEditId);
    if (!currentEditId) return;
    if (!await confirmProxySaveIfNeeded('edit')) return;
    const proxyBinding = applySavedProxyFallbackToInput('edit');
    const profiles = await window.electronAPI.getProfiles();
    let p = profiles.find(x => x.id === currentEditId);
    console.log('[saveEditProfile] Found profile:', p);
    if (p) {
        p.name = document.getElementById('editName').value;
        p.proxyStr = document.getElementById('editProxy').value;
        p.savedProxyId = proxyBinding.savedProxyId || '';
        const tagsStr = document.getElementById('editTags').value;
        p.tags = tagsStr.split(/[,，]/).map(s => s.trim()).filter(s => s);
        p.startupUrls = parseStartupUrlsInput(document.getElementById('editStartupUrls').value);
        p.headerPresetId = document.getElementById('editHeaderPresetId').value || '';
        p.extensionPaths = collectSelectedProfileExtensions('edit');
        p.useGlobalExtensions = document.getElementById('editUseGlobalExtensions').checked;
        p.geoPermissionMode = document.getElementById('editGeoPermissionMode').value || 'auto';
        p.cameraPermissionMode = document.getElementById('editCameraPermissionMode').value || 'auto';
        p.microphonePermissionMode = document.getElementById('editMicrophonePermissionMode').value || 'auto';
        p.notificationPermissionMode = document.getElementById('editNotificationPermissionMode').value || 'auto';
        p.preProxyOverride = document.getElementById('editPreProxyOverride').value;

        if (!p.fingerprint) p.fingerprint = {};
        const screenSize = {
            width: parseEditorSize(document.getElementById('editResW').value, 1920),
            height: parseEditorSize(document.getElementById('editResH').value, 1080)
        };
        const windowSize = {
            width: parseEditorSize(document.getElementById('editWindowW').value, screenSize.width),
            height: parseEditorSize(document.getElementById('editWindowH').value, screenSize.height)
        };
        p.fingerprint.screen = screenSize;
        p.fingerprint.window = sanitizeEditorWindowSize(windowSize, screenSize);
        const timezoneValue = document.getElementById('editTimezone').value;
        console.log('[saveEditProfile] Timezone value:', timezoneValue);
        p.fingerprint.timezone = timezoneValue === 'Auto (No Change)' ? 'Auto' : timezoneValue;
        console.log('[saveEditProfile] Converted timezone:', p.fingerprint.timezone);


        // Save City & Geolocation
        const cityInput = document.getElementById('editCity').value;
        if (cityInput && cityInput !== 'Auto (IP Based)') {
            const cityData = window.CITY_DATA ? window.CITY_DATA.find(c => c.name === cityInput) : null;
            if (cityData) {
                p.fingerprint.city = cityData.name;
                p.fingerprint.geolocation = { latitude: cityData.lat, longitude: cityData.lng, accuracy: 100 };
            }
        } else {
            // Auto mode: remove geolocation to let system/IP decide
            delete p.fingerprint.city;
            delete p.fingerprint.geolocation;
        }
        p.fingerprint.language = getLanguageCode(document.getElementById('editLanguage').value);

        // Save debug port if enabled
        const debugPortInput = document.getElementById('editDebugPort');
        if (debugPortInput.parentElement.style.display !== 'none') {
            const portValue = debugPortInput.value.trim();
            p.debugPort = portValue ? parseInt(portValue) : null;
        }

        // Save fingerprint tab data
        // User Agent
        const userAgentValue = document.getElementById('editUserAgent').value;
        if (userAgentValue) {
            p.fingerprint.userAgent = userAgentValue;
        }
        
        // WebGL
        p.fingerprint.webgl = {
            vendor: document.getElementById('editWebGLVendor').value,
            renderer: document.getElementById('editWebGLRenderer').value
        };
        
        // Hardware
        p.fingerprint.hardwareConcurrency = parseInt(document.getElementById('editHardwareConcurrency').value);
        p.fingerprint.deviceMemory = parseInt(document.getElementById('editDeviceMemory').value);
        p.fingerprint.colorDepth = parseInt(document.getElementById('editColorDepth').value);
        p.fingerprint.pixelRatio = parseFloat(document.getElementById('editPixelRatio').value);
        p.fingerprint.maxTouchPoints = parseInt(document.getElementById('editMaxTouchPoints').value);
        
        const dntValue = document.getElementById('editDoNotTrack').value;
        p.fingerprint.doNotTrack = dntValue === 'null' ? null : parseInt(dntValue);
        
        // Network
        p.fingerprint.connection = {
            type: document.getElementById('editConnectionType').value,
            effectiveType: document.getElementById('editEffectiveType').value,
            downlink: parseInt(document.getElementById('editDownlink').value),
            rtt: parseInt(document.getElementById('editRTT').value),
            saveData: false
        };
        
        // Fonts (use temp if regenerated, otherwise keep existing)
        if (window._editFontsTemp) {
            p.fingerprint.fonts = window._editFontsTemp;
        }
        
        // Protection settings (from button groups)
        p.fingerprint.protection = getProtectionSettings();
        // Save custom args if enabled
        const customArgsInput = document.getElementById('editCustomArgs');
        if (customArgsInput.parentElement.style.display !== 'none') {
            p.customArgs = customArgsInput.value.trim();
        }

        console.log('[saveEditProfile] Calling updateProfile...');
        await window.electronAPI.updateProfile(p);
        console.log('[saveEditProfile] Profile updated successfully');
        await refreshSavedProfileProxyUsageCounts();
        if (document.getElementById('settingsModal')?.style.display === 'flex') renderSavedProfileProxyEditors();
        closeEditModal(); loadProfiles();
    }
}

async function importProfileCookies() {
    if (!currentEditId) return;
    try {
        const result = await window.electronAPI.invoke('import-profile-cookies', { profileId: currentEditId });
        if (!result || result.canceled) return;
        showAlert(`${t('cookieImportSuccess')}: ${result.count}`);
    } catch (e) {
        showAlert(`${t('cookieImportFailed')}: ${e.message}`);
    }
}

async function exportProfileCookies(format) {
    if (!currentEditId) return;
    try {
        const result = await window.electronAPI.invoke('export-profile-cookies', { profileId: currentEditId, format });
        if (!result || result.canceled) return;
        showAlert(`${t('cookieExportSuccess')}: ${result.count}`);
    } catch (e) {
        showAlert(`${t('cookieExportFailed')}: ${e.message}`);
    }
}

function exportCurrentProfileFullBackup() {
    if (!currentEditId) return;
    const profileId = currentEditId;
    isImportMode = false;
    passwordCallback = async (password) => {
        const result = await window.electronAPI.invoke('export-full-backup', {
            profileIds: [profileId],
            password
        });
        if (result && result.success) {
            showAlert(t('fullBackupSuccess'));
            return;
        }
        if (result && !result.cancelled) {
            throw new Error(result.error || t('fullBackupFailed'));
        }
    };
    openPasswordModal(t('backupPasswordSetTitle'), true);
}

async function importProfileStorage() {
    if (!currentEditId) return;
    try {
        const result = await window.electronAPI.invoke('import-profile-storage', { profileId: currentEditId });
        if (!result || result.canceled) return;
        showAlert(`${t('storageImportSuccess')}: ${result.count}`);
    } catch (e) {
        showAlert(`${t('storageImportFailed')}: ${e.message}`);
    }
}

async function exportProfileStorage() {
    if (!currentEditId) return;
    try {
        const result = await window.electronAPI.invoke('export-profile-storage', { profileId: currentEditId });
        if (!result || result.canceled) return;
        showAlert(`${t('storageExportSuccess')}: ${result.count}`);
    } catch (e) {
        showAlert(`${t('storageExportFailed')}: ${e.message}`);
    }
}

function switchProxyManagerTab(tabName, tabButton) {
    currentProxyManagerTab = tabName === 'library' ? 'library' : 'chain';
    const buttons = [
        document.getElementById('proxyManagerChainTabBtn'),
        document.getElementById('proxyManagerLibraryTabBtn'),
    ].filter(Boolean);
    buttons.forEach((btn) => btn.classList.remove('active'));
    const activeBtn = tabButton || document.getElementById(
        currentProxyManagerTab === 'library' ? 'proxyManagerLibraryTabBtn' : 'proxyManagerChainTabBtn'
    );
    if (activeBtn) activeBtn.classList.add('active');

    const chainSection = document.getElementById('proxyManagerTab-chain');
    const librarySection = document.getElementById('proxyManagerTab-library');
    if (chainSection) chainSection.style.display = currentProxyManagerTab === 'chain' ? 'flex' : 'none';
    if (librarySection) librarySection.style.display = currentProxyManagerTab === 'library' ? 'block' : 'none';
    if (currentProxyManagerTab === 'library') switchProxyLibraryTab('proxies');
}

function switchProxyLibraryTab(tabName, tabButton) {
    currentProxyLibraryTab = tabName === 'sources' ? 'sources' : 'proxies';
    const buttons = [
        document.getElementById('proxyLibraryProxyListTabBtn'),
        document.getElementById('proxyLibrarySourceTabBtn'),
    ].filter(Boolean);
    buttons.forEach((btn) => btn.classList.remove('active'));
    const activeBtn = tabButton || document.getElementById(
        currentProxyLibraryTab === 'sources' ? 'proxyLibrarySourceTabBtn' : 'proxyLibraryProxyListTabBtn'
    );
    if (activeBtn) activeBtn.classList.add('active');

    const proxyListSection = document.getElementById('proxyLibrarySubTab-proxies');
    const sourceSection = document.getElementById('proxyLibrarySubTab-sources');
    if (proxyListSection) proxyListSection.style.display = currentProxyLibraryTab === 'proxies' ? 'block' : 'none';
    if (sourceSection) sourceSection.style.display = currentProxyLibraryTab === 'sources' ? 'block' : 'none';
}

async function openProxyManager() {
    const modal = document.getElementById('proxyModal');
    if (modal) modal.style.display = 'flex';
    switchProxyManagerTab('chain');
    switchProxyLibraryTab('proxies');
    try {
        const settings = await loadAdvancedPresetEditors();
        globalSettings = settings || globalSettings;
        if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
        renderGroupTabs();
        switchProxyManagerTab('chain');
    } catch (e) {
        console.error('Failed to open proxy manager:', e);
        try {
            const settings = await window.electronAPI.getSettings();
            globalSettings = settings || globalSettings;
            if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
            renderGroupTabs();
            switchProxyManagerTab('chain');
        } catch (inner) {
            console.error('Failed to recover proxy manager state:', inner);
        }
        if (typeof showAlert === 'function') {
            showAlert(`Proxy Manager: ${(e && e.message) ? e.message : String(e)}`);
        }
    }
}
function closeProxyManager() {
    document.getElementById('proxyModal').style.display = 'none';
    switchProxyManagerTab('chain');
    switchProxyLibraryTab('proxies');
}

function renderGroupTabs() {
    const container = document.getElementById('proxyGroupTabs');
    if (!container) return;
    container.innerHTML = '';
    const manualBtn = document.createElement('div');
    manualBtn.className = `tab-btn no-drag ${currentProxyGroup === 'manual' ? 'active' : ''}`;
    manualBtn.innerText = t('groupManual');
    manualBtn.onclick = () => switchProxyGroup('manual');
    container.appendChild(manualBtn);
    globalSettings.subscriptions.forEach(sub => {
        const btn = document.createElement('div');
        btn.className = `tab-btn no-drag ${currentProxyGroup === sub.id ? 'active' : ''}`;
        btn.innerText = sub.name || 'Sub';
        btn.onclick = () => switchProxyGroup(sub.id);
        container.appendChild(btn);
    });
    renderProxyNodes();
}

function switchProxyGroup(gid) { currentProxyGroup = gid; renderGroupTabs(); }

function renderProxyNodes() {
    const modeSel = document.getElementById('proxyMode');
    if (modeSel.options.length === 0) modeSel.innerHTML = `<option value="single">${t('modeSingle')}</option><option value="balance">${t('modeBalance')}</option><option value="failover">${t('modeFailover')}</option>`;
    modeSel.value = globalSettings.mode || 'single';
    document.getElementById('notifySwitch').checked = globalSettings.notify || false;

    const list = (globalSettings.preProxies || []).filter(p => {
        if (currentProxyGroup === 'manual') return !p.groupId || p.groupId === 'manual';
        return p.groupId === currentProxyGroup;
    });

    const listEl = document.getElementById('preProxyList');
    listEl.innerHTML = '';

    const groupName = currentProxyGroup === 'manual' ? t('groupManual') : (globalSettings.subscriptions.find(s => s.id === currentProxyGroup)?.name || 'Sub');
    document.getElementById('currentGroupTitle').innerText = `${groupName} (${list.length})`;

    const btnTest = document.querySelector('button[onclick="testCurrentGroup()"]');
    if (btnTest) btnTest.innerText = t('btnTestGroup');
    const btnNewSub = document.querySelector('button[onclick="openSubEditModal(true)"]');
    if (btnNewSub) btnNewSub.innerText = t('btnImportSub');
    const btnEditSub = document.getElementById('btnEditSub');
    if (btnEditSub) btnEditSub.innerText = t('btnEditSub');

    const isManual = currentProxyGroup === 'manual';
    document.getElementById('manualAddArea').style.display = isManual ? 'block' : 'none';
    document.getElementById('btnEditSub').style.display = isManual ? 'none' : 'inline-block';

    list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'proxy-row no-drag';
        const isSel = globalSettings.mode === 'single' && globalSettings.selectedId === p.id;
        if (isSel) div.style.background = "rgba(0,224,255,0.08)";

        const inputType = globalSettings.mode === 'single' ? 'radio' : 'checkbox';
        const checked = globalSettings.mode === 'single' ? isSel : (p.enable !== false);
        const onchange = globalSettings.mode === 'single' ? `selP('${p.id}')` : `togP('${p.id}')`;
        const inputHtml = `<input type="${inputType}" name="ps" ${checked ? 'checked' : ''} onchange="${onchange}" style="cursor:pointer; margin:0;" class="no-drag">`;

        let latHtml = '';
        if (p.latency !== undefined) {
            if (p.latency === -1 || p.latency === 9999) latHtml = `<span class="proxy-latency" style="border:1px solid #e74c3c; color:#e74c3c;">Fail</span>`;
            else {
                const color = p.latency < 500 ? '#27ae60' : (p.latency < 1000 ? '#f39c12' : '#e74c3c');
                latHtml = `<span class="proxy-latency" style="border:1px solid ${color}; color:${color};">${p.latency}ms</span>`;
            }
        } else {
            latHtml = `<span class="proxy-latency" style="border:1px solid var(--text-secondary); opacity:0.3;">-</span>`;
        }

        const proto = (p.url.split('://')[0] || 'UNK').toUpperCase();
        let displayRemark = p.remark;
        if (!displayRemark || displayRemark.trim() === '') displayRemark = 'Node';

        div.innerHTML = `
            <div class="proxy-left">${inputHtml}</div>
            <div class="proxy-mid">
                <div class="proxy-header"><span class="proxy-proto">${proto}</span><span class="proxy-remark" title="${displayRemark}">${displayRemark}</span>${latHtml}</div>
            </div>
            <div class="proxy-right">
                <button class="outline no-drag" onclick="testSingleProxy('${p.id}')">${t('btnTest')}</button>
                ${isManual ? `<button class="outline no-drag" onclick="editPreProxy('${p.id}')">${t('btnEdit')}</button>` : ''}
                <button class="danger no-drag" onclick="delP('${p.id}')">✕</button>
            </div>
        `;
        listEl.appendChild(div);
    });

    const btnDone = document.querySelector('#proxyModal button[data-i18n="done"]');
    if (btnDone) btnDone.innerText = t('done');
}

function resetProxyInput() {
    document.getElementById('editProxyId').value = '';
    document.getElementById('newProxyRemark').value = '';
    document.getElementById('newProxyUrl').value = '';
    const btn = document.getElementById('btnSaveProxy');
    btn.innerText = t('add'); btn.className = '';
}

function editPreProxy(id) {
    const p = globalSettings.preProxies.find(x => x.id === id);
    if (!p) return;
    document.getElementById('editProxyId').value = p.id;
    document.getElementById('newProxyRemark').value = p.remark;
    document.getElementById('newProxyUrl').value = p.url;
    const btn = document.getElementById('btnSaveProxy');
    btn.innerText = t('save'); btn.className = 'outline';
    document.getElementById('newProxyUrl').focus();
}

async function savePreProxy() {
    const id = document.getElementById('editProxyId').value;
    let remark = document.getElementById('newProxyRemark').value;
    const url = document.getElementById('newProxyUrl').value.trim();
    if (!url) return;
    if (!remark) remark = getProxyRemark(url) || 'Manual Node';
    if (!globalSettings.preProxies) globalSettings.preProxies = [];
    if (id) {
        const idx = globalSettings.preProxies.findIndex(x => x.id === id);
        if (idx > -1) { globalSettings.preProxies[idx].remark = remark; globalSettings.preProxies[idx].url = url; }
    } else {
        globalSettings.preProxies.push({ id: Date.now().toString(), remark, url, enable: true, groupId: 'manual' });
    }
    resetProxyInput(); renderProxyNodes(); await window.electronAPI.saveSettings(globalSettings);
}

// --- Subscription Management ---
function openSubEditModal(isNew) {
    const modal = document.getElementById('subEditModal');
    const headerTitle = modal.querySelector('.modal-header span'); if (headerTitle) headerTitle.innerText = t('subTitle');
    const labels = modal.querySelectorAll('label'); if (labels[0]) labels[0].innerText = t('subName'); if (labels[1]) labels[1].innerText = t('subUrl'); if (labels[2]) labels[2].innerText = t('subInterval');
    const options = document.getElementById('subInterval').options; options[0].text = t('optDisabled'); options[1].text = t('opt24h'); options[2].text = t('opt72h'); options[3].text = t('optCustom');
    const btnDel = document.getElementById('btnDelSub'); btnDel.innerText = t('btnDelSub'); btnDel.style.display = isNew ? 'none' : 'inline-block';
    const btnSave = modal.querySelector('button[onclick="saveSubscription()"]'); if (btnSave) btnSave.innerText = t('btnSaveUpdate');

    if (isNew) {
        document.getElementById('subId').value = '';
        document.getElementById('subName').value = '';
        document.getElementById('subUrl').value = '';
        document.getElementById('subInterval').value = '24';
        document.getElementById('subCustomInterval').style.display = 'none';
    }
    modal.style.display = 'flex';
    document.getElementById('subInterval').onchange = function () { document.getElementById('subCustomInterval').style.display = this.value === 'custom' ? 'block' : 'none'; }
}

function closeSubEditModal() { document.getElementById('subEditModal').style.display = 'none'; }

function editCurrentSubscription() {
    const sub = globalSettings.subscriptions.find(s => s.id === currentProxyGroup);
    if (!sub) return;
    openSubEditModal(false);
    document.getElementById('subId').value = sub.id;
    document.getElementById('subName').value = sub.name;
    document.getElementById('subUrl').value = sub.url;
    const sel = document.getElementById('subInterval');
    const cust = document.getElementById('subCustomInterval');
    if (['0', '24', '72'].includes(sub.interval)) { sel.value = sub.interval; cust.style.display = 'none'; }
    else { sel.value = 'custom'; cust.style.display = 'block'; cust.value = sub.interval; }
}

async function saveSubscription() {
    const id = document.getElementById('subId').value;
    const name = document.getElementById('subName').value || 'Subscription';
    const url = document.getElementById('subUrl').value.trim();
    let interval = document.getElementById('subInterval').value;
    if (interval === 'custom') interval = document.getElementById('subCustomInterval').value;
    if (!url) return;

    let sub;
    if (id) {
        sub = globalSettings.subscriptions.find(s => s.id === id);
        if (sub) { sub.name = name; sub.url = url; sub.interval = interval; }
    } else {
        function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
        sub = { id: `sub-${Date.now()}`, name, url, interval, lastUpdated: 0 };
        globalSettings.subscriptions.push(sub);
    }
    closeSubEditModal();
    await updateSubscriptionNodes(sub);
    currentProxyGroup = sub.id;
    renderGroupTabs();
    await window.electronAPI.saveSettings(globalSettings);
}

async function deleteSubscription() {
    const id = document.getElementById('subId').value;
    if (!id) return;
    showConfirm(t('confirmDelSub'), async () => {
        globalSettings.subscriptions = globalSettings.subscriptions.filter(s => s.id !== id);
        globalSettings.preProxies = globalSettings.preProxies.filter(p => p.groupId !== id);
        currentProxyGroup = 'manual';
        closeSubEditModal(); renderGroupTabs(); await window.electronAPI.saveSettings(globalSettings);
    });
}

async function updateSubscriptionNodes(sub) {
    try {
        const content = await window.electronAPI.invoke('fetch-url', sub.url);
        let decoded = content;
        try { if (!content.includes('://')) decoded = decodeBase64Content(content); } catch (e) { }
        const lines = decoded.split(/[\r\n]+/);
        globalSettings.preProxies = globalSettings.preProxies.filter(p => p.groupId !== sub.id);
        let count = 0;
        lines.forEach(line => {
            line = line.trim();
            if (line && line.includes('://')) {
                const remark = getProxyRemark(line) || `Node ${count + 1}`;
                function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
                globalSettings.preProxies.push({ id: uuidv4(), remark, url: line, enable: true, groupId: sub.id });
                count++;
            }
        });
        sub.lastUpdated = Date.now();
        showAlert(`${t('msgSubUpdated')} ${sub.name} (${count} ${t('msgNodes')})`);
    } catch (e) {
        showAlert(`${t('msgUpdateFailed')} ${e.message}`);
    }
}

async function testSingleProxy(id) {
    const p = globalSettings.preProxies.find(x => x.id === id);
    if (!p) return;
    const btn = Array.from(document.querySelectorAll('#preProxyList button.outline')).find(el => el.onclick.toString().includes(id));
    if (btn) btn.innerText = "...";
    try {
        const res = await window.electronAPI.invoke('test-proxy-latency', p.url);
        p.latency = res.success ? res.latency : -1;
        renderProxyNodes();
    } catch (e) { console.error(e); }
}

async function testCurrentGroup() {
    const list = (globalSettings.preProxies || []).filter(p => {
        if (currentProxyGroup === 'manual') return !p.groupId || p.groupId === 'manual';
        return p.groupId === currentProxyGroup;
    });
    if (list.length === 0) return;

    // 先将所有测试按钮设置为加载状态
    list.forEach(p => {
        const btn = Array.from(document.querySelectorAll('#preProxyList button.outline')).find(el => el.onclick && el.onclick.toString().includes(p.id));
        if (btn) btn.innerText = "...";
    });

    const promises = list.map(async (p) => {
        const res = await window.electronAPI.invoke('test-proxy-latency', p.url);
        p.latency = res.success ? res.latency : -1;
        return p;
    });
    await Promise.all(promises);
    if (globalSettings.mode === 'single') {
        let best = null, min = 99999;
        list.forEach(p => { if (p.latency > 0 && p.latency < min) { min = p.latency; best = p; } });
        if (best) {
            globalSettings.selectedId = best.id;
            if (document.getElementById('notifySwitch').checked) new Notification('GeekEZ', { body: `Auto-Switched: ${best.remark}` });
        }
    }
    renderProxyNodes();
}

function delP(id) { globalSettings.preProxies = globalSettings.preProxies.filter(p => p.id !== id); renderProxyNodes(); }
function selP(id) { globalSettings.selectedId = id; renderProxyNodes(); }
function togP(id) { const p = globalSettings.preProxies.find(x => x.id === id); if (p) p.enable = !p.enable; }

async function saveProxySettings() {
    globalSettings.mode = document.getElementById('proxyMode').value;
    globalSettings.notify = document.getElementById('notifySwitch').checked;
    await window.electronAPI.saveSettings(globalSettings);
    closeProxyManager(); updateToolbar();
}

function updateToolbar() {
    const enable = document.getElementById('enablePreProxy').checked;
    globalSettings.enablePreProxy = enable;
    window.electronAPI.saveSettings(globalSettings);
    const d = document.getElementById('currentProxyDisplay');
    if (!enable) { d.innerText = "OFF"; d.style.color = "var(--text-secondary)"; d.style.border = "1px solid var(--border)"; return; }
    d.style.color = "var(--accent)"; d.style.border = "1px solid var(--accent)";
    let count = 0;
    if (globalSettings.mode === 'single') count = globalSettings.selectedId ? 1 : 0;
    else count = (globalSettings.preProxies || []).filter(p => p.enable !== false).length;
    let modeText = "";
    if (globalSettings.mode === 'single') modeText = t('modeSingle');
    else if (globalSettings.mode === 'balance') modeText = t('modeBalance');
    else modeText = t('modeFailover');
    d.innerText = `${modeText} [${count}]`;
}

// Export Logic (重构版)
let exportType = '';
let selectedProfileIds = [];
let passwordCallback = null;
let isImportMode = false;

function openExportModal() { document.getElementById('exportModal').style.display = 'flex'; }
function closeExportModal() { document.getElementById('exportModal').style.display = 'none'; }

async function openExportSelectModal(type) {
    exportType = type;
    closeExportModal();

    // 如果是仅导出代理，不需要选择环境
    if (type === 'proxies') {
        try {
            const result = await window.electronAPI.invoke('export-selected-data', { type: 'proxies', profileIds: [] });
            if (result.success) showAlert(t('msgExportSuccess'));
            else if (!result.cancelled) showAlert(result.error || t('msgNoData'));
        } catch (e) { showAlert("Export Failed: " + e.message); }
        return;
    }

    // 获取环境列表
    const profiles = await window.electronAPI.invoke('get-export-profiles');

    if (profiles.length === 0) {
        showAlert(t('expNoProfiles'));
        return;
    }

    // 渲染选择器
    renderExportProfileList(profiles);

    // 默认全选
    selectedProfileIds = profiles.map(p => p.id);
    document.getElementById('exportSelectAll').checked = true;
    updateExportSelectedCount(profiles.length);

    // 更新标题（使用 i18n）
    const titleSpan = document.querySelector('#exportSelectTitle span[data-i18n]');
    const iconSpan = document.querySelector('#exportSelectTitle span:first-child');
    if (type === 'full-backup') {
        if (titleSpan) titleSpan.innerText = t('expSelectTitleFull');
        if (iconSpan) iconSpan.innerText = '🔐';
    } else {
        if (titleSpan) titleSpan.innerText = t('expSelectTitle');
        if (iconSpan) iconSpan.innerText = '📦';
    }

    document.getElementById('exportSelectModal').style.display = 'flex';
}

function closeExportSelectModal() {
    document.getElementById('exportSelectModal').style.display = 'none';
    selectedProfileIds = [];
}

function renderExportProfileList(profiles) {
    const container = document.getElementById('exportProfileList');
    if (!profiles || profiles.length === 0) {
        container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--text-secondary);">
            <div style="font-size: 24px; margin-bottom: 8px;">📭</div>
            <div>${t('expNoProfiles')}</div>
        </div>`;
        return;
    }

    let html = '';
    for (const p of profiles) {
        const tagsHtml = (p.tags || []).map(tag =>
            `<span style="font-size: 9px; padding: 2px 6px; background: ${stringToColor(tag)}22; color: ${stringToColor(tag)}; border-radius: 4px; margin-left: 6px; font-weight: 500;">${tag}</span>`
        ).join('');

        html += `<label style="display: flex; align-items: center; padding: 10px 12px; margin: 4px 0; background: rgba(255,255,255,0.03); border: 1px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;" 
            onmouseover="this.style.background='rgba(0,255,255,0.05)'; this.style.borderColor='var(--accent)';" 
            onmouseout="this.style.background='rgba(255,255,255,0.03)'; this.style.borderColor='transparent';">
            <input type="checkbox" id="export-${p.id}" checked 
                onchange="handleExportCheckboxChange('${p.id}', this.checked)"
                style="width: 18px; height: 18px; margin-right: 12px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name || t('expNoProfiles')}</div>
            </div>
            <div style="display: flex; align-items: center; flex-shrink: 0;">${tagsHtml}</div>
        </label>`;
    }
    container.innerHTML = html;
}

// 处理单个 checkbox 变化
function handleExportCheckboxChange(id, checked) {
    if (checked) {
        if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
    } else {
        selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
    }

    // 更新全选状态
    const allCheckboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    document.getElementById('exportSelectAll').checked = allChecked;

    updateExportSelectedCount(allCheckboxes.length);
}

function toggleExportProfile(id) {
    const checkbox = document.getElementById(`export-${id}`);
    checkbox.checked = !checkbox.checked;

    if (checkbox.checked) {
        if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
    } else {
        selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
    }

    // 更新全选状态
    const allCheckboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    document.getElementById('exportSelectAll').checked = allChecked;

    updateExportSelectedCount(allCheckboxes.length);
}

function toggleExportSelectAll() {
    const selectAll = document.getElementById('exportSelectAll').checked;
    const checkboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');

    checkboxes.forEach(cb => {
        cb.checked = selectAll;
        const id = cb.id.replace('export-', '');
        if (selectAll) {
            if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
        }
    });

    if (!selectAll) selectedProfileIds = [];

    updateExportSelectedCount(checkboxes.length);
}

function updateExportSelectedCount(total) {
    document.getElementById('exportSelectedCount').innerText = `${selectedProfileIds.length}/${total}`;
}

async function confirmExport() {
    if (selectedProfileIds.length === 0) {
        showAlert('请至少选择一个环境');
        return;
    }

    // 保存选中的 ID（因为 closeExportSelectModal 会清空）
    const idsToExport = [...selectedProfileIds];
    const typeToExport = exportType;

    closeExportSelectModal();
    if (typeToExport === 'full-backup') {
        isImportMode = false;
        passwordCallback = async (password) => {
            const result = await window.electronAPI.invoke('export-full-backup', {
                profileIds: idsToExport,
                password
            });
            if (result && result.success) {
                showAlert(t('fullBackupSuccess'));
                return;
            }
            if (result && !result.cancelled) {
                throw new Error(result.error || t('fullBackupFailed'));
            }
        };
        openPasswordModal(t('backupPasswordSetTitle'), true);
    } else {
        // 直接导出
        try {
            const result = await window.electronAPI.invoke('export-selected-data', {
                type: typeToExport,
                profileIds: idsToExport
            });
            if (result.success) {
                showAlert(`导出成功！共 ${result.count} 个环境`);
            } else if (!result.cancelled) {
                showAlert(result.error || t('msgNoData'));
            }
        } catch (e) {
            showAlert("Export Failed: " + e.message);
        }
    }
}

// 密码模态框
function openPasswordModal(title, showConfirm) {
    document.getElementById('passwordModalTitle').innerText = title;
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupPasswordConfirm').value = '';

    // 导入时不需要确认密码
    const confirmLabel = document.getElementById('confirmPasswordLabel');
    const confirmInput = document.getElementById('backupPasswordConfirm');
    if (showConfirm) {
        confirmLabel.style.display = 'block';
        confirmInput.style.display = 'block';
    } else {
        confirmLabel.style.display = 'none';
        confirmInput.style.display = 'none';
    }

    document.getElementById('passwordModal').style.display = 'flex';
    document.getElementById('backupPassword').focus();
}

function closePasswordModal() {
    document.getElementById('passwordModal').style.display = 'none';
    passwordCallback = null;
}

async function submitPassword() {
    const password = document.getElementById('backupPassword').value;
    const confirmPassword = document.getElementById('backupPasswordConfirm').value;
    const importMode = isImportMode;
    const callback = passwordCallback;

    if (!password) {
        showAlert('请输入密码');
        return;
    }

    if (!importMode && password !== confirmPassword) {
        showAlert('两次输入的密码不一致');
        return;
    }

    if (password.length < 4) {
        showAlert('密码长度至少 4 位');
        return;
    }

    closePasswordModal();
    isImportMode = false;

    if (callback) {
        try {
            await callback(password);
        } catch (e) {
            showAlert((e && e.message) ? e.message : String(e));
        }
        return;
    }

    if (importMode) {
        // 导入完整备份
        try {
            const result = await window.electronAPI.invoke('import-full-backup', { password });
            if (result.success) {
                showAlert(`导入成功！共 ${result.count} 个环境`);
                loadProfiles();
                globalSettings = await window.electronAPI.getSettings();
                renderGroupTabs();
                updateToolbar();
            } else if (!result.cancelled) {
                showAlert(result.error || '导入失败');
            }
        } catch (e) {
            showAlert("Import Failed: " + e.message);
        }
    } else {
        // 导出完整备份
        try {
            const result = await window.electronAPI.invoke('export-full-backup', {
                profileIds: selectedProfileIds,
                password
            });
            if (result.success) {
                showAlert(`完整备份成功！共 ${result.count} 个环境`);
            } else if (!result.cancelled) {
                showAlert(result.error || '备份失败');
            }
        } catch (e) {
            showAlert("Backup Failed: " + e.message);
        }
    }
}

// Import Logic
async function importData() {
    try {
        const result = await window.electronAPI.invoke('import-data');
        if (result) {
            globalSettings = await window.electronAPI.getSettings();
            if (!globalSettings.preProxies) globalSettings.preProxies = [];
            if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
            loadProfiles(); renderGroupTabs(); updateToolbar();
            showAlert(t('msgImportSuccess'));
        }
    } catch (e) { showAlert("Import Failed: " + e.message); }
}

// 导入完整备份（.geekez 文件）
async function importFullBackup() {
    isImportMode = true;
    openPasswordModal('输入备份密码', false);
}

// Import Menu Toggle
function toggleImportMenu() {
    const menu = document.getElementById('importMenu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function closeImportMenu() {
    document.getElementById('importMenu').style.display = 'none';
}

// 点击其他地方关闭菜单
document.addEventListener('click', (e) => {
    const menu = document.getElementById('importMenu');
    const btn = document.getElementById('importBtn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.style.display = 'none';
    }
});

function openImportSub() { showInput(t('importSubTitle'), importSubscription); }
async function importSubscription(url) {
    if (!url) return;
    try {
        const content = await window.electronAPI.invoke('fetch-url', url);
        if (!content) return showAlert(t('subErr'));
        let decoded = content;
        try { if (!content.includes('://')) decoded = decodeBase64Content(content); } catch (e) { }
        const lines = decoded.split(/[\r\n]+/);
        let count = 0;
        if (!globalSettings.preProxies) globalSettings.preProxies = [];
        const groupId = `group-${Date.now()}`;
        const groupName = `Sub ${new Date().toLocaleTimeString()}`;
        lines.forEach(line => {
            line = line.trim();
            if (line && line.includes('://')) {
                const remark = getProxyRemark(line) || `Node ${count + 1}`;
                function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
                globalSettings.preProxies.push({
                    id: uuidv4(), remark, url: line, enable: true, groupId, groupName
                });
                count++;
            }
        });
        renderProxyNodes(); await window.electronAPI.saveSettings(globalSettings);
        showAlert(`${t('msgImported')} ${count} ${t('msgNodes')}`);
    } catch (e) { showAlert(t('subErr') + " " + e); }
}

function switchHelpTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const idx = tabName === 'manual' ? 0 : 1;
    const tabs = document.querySelectorAll('#helpModal .tab-btn');
    if (tabs[idx]) tabs[idx].classList.add('active');
    document.querySelectorAll('.help-section').forEach(el => el.classList.remove('active'));
    document.getElementById(`help-${tabName}`).classList.add('active');
}
// ============================================================================
// Settings Modal Functions
// ============================================================================
function renderResourceTypeOptions(selectedValues) {
    const selected = Array.isArray(selectedValues) ? selectedValues : [];
    return HEADER_RULE_RESOURCE_TYPES.map((item) => {
        const isSelected = selected.includes(item);
        return `<option value="${item}" ${isSelected ? 'selected' : ''}>${item}</option>`;
    }).join('');
}

function renderHeaderPresetRules(preset, presetIndex) {
    const rules = Array.isArray(preset && preset.rules) ? preset.rules : [];
    if (rules.length === 0) {
        return `<div style="font-size:12px; opacity:0.65; padding:8px 0;">${escapeHtml(t('noHeaderRules'))}</div>`;
    }
    return rules.map((rule, ruleIndex) => `
        <div style="border:1px dashed var(--border); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:10px;">
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; align-items:end;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleIdLabel'))}</span>
                    <input type="text" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="id" value="${escapeHtml(rule.id || '')}" spellcheck="false">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleActionLabel'))}</span>
                    <select data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="action">
                        <option value="set" ${rule.action === 'set' ? 'selected' : ''}>set</option>
                        <option value="remove" ${rule.action === 'remove' ? 'selected' : ''}>remove</option>
                    </select>
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleHeaderLabel'))}</span>
                    <input type="text" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="header" value="${escapeHtml(rule.header || '')}" spellcheck="false" placeholder="Accept-Language">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleValueTemplateLabel'))}</span>
                    <input type="text" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="valueTemplate" value="${escapeHtml(rule.valueTemplate || '')}" spellcheck="false" placeholder="{{resolvedAcceptLanguage}}">
                </label>
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                    <input type="checkbox" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="enabled" ${rule.enabled !== false ? 'checked' : ''}>
                    <span>${escapeHtml(t('presetEnabledLabel'))}</span>
                </label>
                <div style="display:flex; justify-content:flex-end;">
                    <button type="button" class="danger outline" data-action="delete-header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}">${escapeHtml(t('deleteRule'))}</button>
                </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleHostsLabel'))}</span>
                    <textarea rows="2" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="hosts" spellcheck="false" placeholder="example.com&#10;*.example.com">${escapeHtml((rule.match && rule.match.hosts || []).join('\n'))}</textarea>
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('ruleResourceTypesLabel'))}</span>
                    <select multiple size="6" data-entity="header-rule" data-preset-index="${presetIndex}" data-rule-index="${ruleIndex}" data-field="resourceTypes">
                        ${renderResourceTypeOptions(rule.match && rule.match.resourceTypes)}
                    </select>
                </label>
            </div>
        </div>
    `).join('');
}

function renderHeaderPresetEditors() {
    const wrap = document.getElementById('headerPresetEditorList');
    if (!wrap) return;
    const presets = Array.isArray(advancedPresetState.headerPresets) ? advancedPresetState.headerPresets : [];
    if (presets.length === 0) {
        wrap.innerHTML = `<div style="font-size:12px; opacity:0.65; padding:10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('noHeaderPresets'))}</div>`;
        return;
    }
    wrap.innerHTML = presets.map((preset, presetIndex) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:12px; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; gap:12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <strong style="color:var(--text-primary);">${escapeHtml(t('headerPresetCardTitle'))} #${presetIndex + 1}</strong>
                <button type="button" class="danger outline" data-action="delete-header-preset" data-preset-index="${presetIndex}">${escapeHtml(t('deletePreset'))}</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetIdLabel'))}</span>
                    <input type="text" data-entity="header-preset" data-preset-index="${presetIndex}" data-field="id" value="${escapeHtml(preset.id || '')}" spellcheck="false">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetNameLabel'))}</span>
                    <input type="text" data-entity="header-preset" data-preset-index="${presetIndex}" data-field="name" value="${escapeHtml(preset.name || '')}" spellcheck="false">
                </label>
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                    <input type="checkbox" data-entity="header-preset" data-preset-index="${presetIndex}" data-field="enabled" ${preset.enabled !== false ? 'checked' : ''}>
                    <span>${escapeHtml(t('presetEnabledLabel'))}</span>
                </label>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(t('headerRulesTitle'))}</strong>
                <button type="button" class="outline" data-action="add-header-rule" data-preset-index="${presetIndex}">${escapeHtml(t('addRule'))}</button>
            </div>
            ${renderHeaderPresetRules(preset, presetIndex)}
        </div>
    `).join('');
}

function renderDiagnosticPresetEditors() {
    const wrap = document.getElementById('diagnosticPresetEditorList');
    if (!wrap) return;
    const presets = Array.isArray(advancedPresetState.diagnosticPresets) ? advancedPresetState.diagnosticPresets : [];
    if (presets.length === 0) {
        wrap.innerHTML = `<div style="font-size:12px; opacity:0.65; padding:10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('noDiagnosticPresets'))}</div>`;
        return;
    }
    wrap.innerHTML = presets.map((preset, presetIndex) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:12px; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; gap:12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <strong style="color:var(--text-primary);">${escapeHtml(t('diagnosticPresetCardTitle'))} #${presetIndex + 1}</strong>
                <button type="button" class="danger outline" data-action="delete-diagnostic-preset" data-preset-index="${presetIndex}">${escapeHtml(t('deletePreset'))}</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetIdLabel'))}</span>
                    <input type="text" data-entity="diagnostic-preset" data-preset-index="${presetIndex}" data-field="id" value="${escapeHtml(preset.id || '')}" spellcheck="false">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetNameLabel'))}</span>
                    <input type="text" data-entity="diagnostic-preset" data-preset-index="${presetIndex}" data-field="name" value="${escapeHtml(preset.name || '')}" spellcheck="false">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('diagnosticUrlLabel'))}</span>
                    <input type="text" data-entity="diagnostic-preset" data-preset-index="${presetIndex}" data-field="url" value="${escapeHtml(preset.url || '')}" spellcheck="false" placeholder="https://">
                </label>
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                    <input type="checkbox" data-entity="diagnostic-preset" data-preset-index="${presetIndex}" data-field="enabled" ${preset.enabled !== false ? 'checked' : ''}>
                    <span>${escapeHtml(t('presetEnabledLabel'))}</span>
                </label>
            </div>
        </div>
    `).join('');
}

function renderSavedProfileProxySourceEditors() {
    const wrap = document.getElementById('savedProfileProxySourceEditorList');
    if (!wrap) return;
    const sources = Array.isArray(advancedPresetState.savedProfileProxySources) ? advancedPresetState.savedProfileProxySources : [];
    const proxies = Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [];
    const sourceOpsBusy = isSavedProfileProxySourceOperationsBusy();
    updateSavedProfileProxySourceAttentionBadges(sources);
    if (sources.length === 0) {
        wrap.innerHTML = `<div style="font-size:12px; opacity:0.65; padding:10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('noSavedProfileProxySources'))}</div>`;
        return;
    }
    const overviewMarkup = buildSavedProfileProxySourceOverviewMarkup(sources);
    const batchHistoryMarkup = buildSavedProfileProxySourceBatchHistoryMarkup();
    const trendMarkup = buildSavedProfileProxySourceMaintenanceTrendMarkup(sources);
    const alertsMarkup = buildSavedProfileProxySourceAlertsMarkup(sources);
    const cardsMarkup = sources.map((source, sourceIndex) => {
        const sourceId = normalizeSavedProfileProxySourceId(source && source.id);
        const isLockedSourceId = savedProfileProxySourceOriginalIds.has(sourceId);
        const isPersistedSource = !!sourceId && savedProfileProxySourceOriginalIds.has(sourceId);
        const lastImportedAt = Number(source && source.lastImportedAt) || 0;
        const lastImportCount = Number(source && source.lastImportCount) || 0;
        const lastImportError = String(source && source.lastImportError || '').trim();
        const format = normalizeSavedProfileProxyImportFormat(source && source.format);
        const stalePolicy = normalizeSavedProfileProxySourceStalePolicy(source && source.stalePolicy);
        const scheduleEnabled = source && source.scheduleEnabled === true;
        const scheduleIntervalMinutes = normalizeSavedProfileProxySourceScheduleIntervalMinutes(source && source.scheduleIntervalMinutes);
        const scheduleSummaryMarkup = buildSavedProfileProxySourceScheduleSummaryMarkup({
            ...(source || {}),
            scheduleEnabled,
            scheduleIntervalMinutes,
        });
        const lastSyncMarkup = buildSavedProfileProxySourceLastSyncMarkup(source);
        const maintenanceMarkup = buildSavedProfileProxySourceMaintenanceMarkup(source);
        const maintenanceHistoryMarkup = buildSavedProfileProxySourceMaintenanceHistoryMarkup(source);
        const historyMarkup = buildSavedProfileProxySourceHistoryMarkup(source);
        const linkedProxyCount = proxies.filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === sourceId).length;
        const staleLinkedCount = proxies.filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === sourceId && normalizeSavedProfileProxySourceStale(proxy && proxy.sourceStale)).length;
        const quarantinedCount = getSavedProfileProxyEntriesForSource(sourceId)
            .filter((proxy) => isSavedProfileProxyQuarantined(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))))
            .length;
        const quarantineCandidateCount = getSavedProfileProxyEntriesForSource(sourceId)
            .filter((proxy) => proxy && proxy.enabled !== false)
            .filter((proxy) => isSavedProfileProxyQuarantineCandidate(proxy, savedProfileProxyTestCache.get(normalizeSavedProxyId(proxy && proxy.id))))
            .length;
        return `
        <div style="border:1px solid var(--border); border-radius:10px; padding:12px; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; gap:12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0;">
                    <strong style="color:var(--text-primary); min-width:0; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(source.name || source.id || `${t('savedProxySourceCardTitle')} #${sourceIndex + 1}`)}">${escapeHtml(source.name || source.id || `${t('savedProxySourceCardTitle')} #${sourceIndex + 1}`)}</strong>
                    ${isLockedSourceId ? `<span style="font-size:11px; opacity:0.72; padding:2px 8px; border-radius:999px; border:1px solid var(--border);">${escapeHtml(t('savedProxyIdLocked'))}</span>` : ''}
                    <span style="font-size:11px; opacity:0.72; padding:2px 8px; border-radius:999px; border:1px solid var(--border); color:${source.enabled !== false ? 'var(--success)' : 'var(--text-secondary)'};">${escapeHtml(source.enabled !== false ? t('savedProxySourceScheduleStateEnabled') : t('savedProxySourceScheduleStateDisabled'))}</span>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button type="button" class="outline" data-action="refresh-saved-profile-proxy-source" data-source-index="${sourceIndex}" ${sourceOpsBusy ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceRefreshBtn'))}</button>
                </div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
                <span style="padding:6px 10px; border-radius:999px; border:1px solid var(--border); font-size:11px; color:var(--text-primary); background:rgba(255,255,255,0.03);">
                    ${escapeHtml(`${t('savedProxySourceLastImportedLabel')}: ${lastImportedAt > 0 ? formatDiagTime(lastImportedAt) : t('savedProxySourceNeverImported')}`)}
                </span>
                <span style="padding:6px 10px; border-radius:999px; border:1px solid var(--border); font-size:11px; color:var(--text-primary); background:rgba(255,255,255,0.03);">
                    ${escapeHtml(`${t('savedProxySourceLastImportCountLabel')}: ${lastImportCount}`)}
                </span>
                <span style="padding:6px 10px; border-radius:999px; border:1px solid var(--border); font-size:11px; color:var(--text-primary); background:rgba(255,255,255,0.03);">
                    ${escapeHtml(`${t('savedProxySourceLinkedCountLabel')}: ${linkedProxyCount}`)}
                </span>
                <span style="padding:6px 10px; border-radius:999px; border:1px solid ${staleLinkedCount > 0 ? 'rgba(255,183,77,0.35)' : 'var(--border)'}; font-size:11px; color:${staleLinkedCount > 0 ? 'var(--warning)' : 'var(--text-primary)'}; background:rgba(255,255,255,0.03);">
                    ${escapeHtml(`${t('savedProxySourceStaleLabel')}: ${staleLinkedCount}`)}
                </span>
            </div>
            <details style="border:1px solid var(--border); border-radius:8px; padding:10px; background:rgba(255,255,255,0.02);">
                <summary style="cursor:pointer; font-size:12px; color:var(--text-primary); user-select:none;">${escapeHtml(t('sourceConfigPanelTitle'))}</summary>
                <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('presetIdLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="id" value="${escapeHtml(source.id || '')}" spellcheck="false" ${isLockedSourceId ? 'readonly' : ''} style="${isLockedSourceId ? 'opacity:0.72;' : ''}">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('presetNameLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="name" value="${escapeHtml(source.name || '')}" spellcheck="false">
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                            <input type="checkbox" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="enabled" ${source.enabled !== false ? 'checked' : ''}>
                            <span>${escapeHtml(t('presetEnabledLabel'))}</span>
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                            <input type="checkbox" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="autoCheck" ${source.autoCheck === true ? 'checked' : ''}>
                            <span>${escapeHtml(t('savedProxyImportAutoCheckLabel'))}</span>
                        </label>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85; grid-column:1 / -1;">
                            <span>${escapeHtml(t('savedProxyImportRemoteUrlLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="url" value="${escapeHtml(source.url || '')}" spellcheck="false" placeholder="https://example.com/proxies.txt">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxyImportFormatLabel'))}</span>
                            <select data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="format">
                                <option value="auto" ${format === 'auto' ? 'selected' : ''}>${escapeHtml(t('savedProxyImportFormatAuto'))}</option>
                                <option value="lines" ${format === 'lines' ? 'selected' : ''}>${escapeHtml(t('savedProxyImportFormatLines'))}</option>
                                <option value="csv" ${format === 'csv' ? 'selected' : ''}>${escapeHtml(t('savedProxyImportFormatCsv'))}</option>
                                <option value="json" ${format === 'json' ? 'selected' : ''}>${escapeHtml(t('savedProxyImportFormatJson'))}</option>
                            </select>
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxySourceStalePolicyLabel'))}</span>
                            <select data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="stalePolicy">
                                <option value="mark" ${stalePolicy === 'mark' ? 'selected' : ''}>${escapeHtml(t('savedProxySourcePolicyMark'))}</option>
                                <option value="disable" ${stalePolicy === 'disable' ? 'selected' : ''}>${escapeHtml(t('savedProxySourcePolicyDisable'))}</option>
                                <option value="detach" ${stalePolicy === 'detach' ? 'selected' : ''}>${escapeHtml(t('savedProxySourcePolicyDetach'))}</option>
                            </select>
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxyImportPrefixLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="prefix" value="${escapeHtml(source.prefix || '')}" spellcheck="false" placeholder="Warmup US">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxyImportStartIndexLabel'))}</span>
                            <input type="number" min="1" step="1" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="startIndex" value="${escapeHtml(normalizeSavedProfileProxyImportStartIndex(source.startIndex))}">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxyImportGroupLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="group" value="${escapeHtml(source.group || '')}" spellcheck="false" placeholder="US / Team A">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85; grid-column:1 / -1;">
                            <span>${escapeHtml(t('savedProxyImportTagsLabel'))}</span>
                            <input type="text" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="tags" value="${escapeHtml(Array.isArray(source.tags) ? source.tags.join(', ') : '')}" spellcheck="false" placeholder="us, warmup, residential">
                        </label>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                            <input type="checkbox" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="scheduleEnabled" ${scheduleEnabled ? 'checked' : ''}>
                            <span>${escapeHtml(t('savedProxySourceScheduleEnabledLabel'))}</span>
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                            <span>${escapeHtml(t('savedProxySourceScheduleIntervalLabel'))}</span>
                            <input type="number" min="5" max="10080" step="1" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="scheduleIntervalMinutes" value="${escapeHtml(String(scheduleIntervalMinutes || 60))}">
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                            <input type="checkbox" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="autoQuarantineOnRefresh" ${source && source.autoQuarantineOnRefresh === true ? 'checked' : ''}>
                            <span>${escapeHtml(t('savedProxySourceAutoQuarantineLabel'))}</span>
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                            <input type="checkbox" data-entity="saved-profile-proxy-source" data-source-index="${sourceIndex}" data-field="autoRecheckQuarantinedOnRefresh" ${source && source.autoRecheckQuarantinedOnRefresh === true ? 'checked' : ''}>
                            <span>${escapeHtml(t('savedProxySourceAutoRecheckLabel'))}</span>
                        </label>
                    </div>
                    <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceScheduleHint'))}</div>
                    ${scheduleSummaryMarkup}
                </div>
            </details>
            <details style="border:1px solid var(--border); border-radius:8px; padding:10px; background:rgba(255,255,255,0.02);">
                <summary style="cursor:pointer; font-size:12px; color:var(--text-primary); user-select:none;">${escapeHtml(t('moreActionsBtn'))}</summary>
                <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">
                    <button type="button" class="danger outline" data-action="delete-saved-profile-proxy-source" data-source-index="${sourceIndex}" ${sourceOpsBusy ? 'disabled' : ''}>${escapeHtml(t('deletePreset'))}</button>
                    <button type="button" class="outline" data-action="run-maintenance-saved-profile-proxy-source" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || !isPersistedSource ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceRunMaintenanceBtn'))}</button>
                    <button type="button" class="outline" data-action="retest-saved-profile-proxy-source-linked" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || linkedProxyCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceRetestLinkedBtn'))}</button>
                    <button type="button" class="outline" data-action="retest-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceRetestStaleBtn'))}</button>
                    <button type="button" class="outline" data-action="quarantine-saved-profile-proxy-source-failed" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || quarantineCandidateCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceQuarantineFailedBtn'))}</button>
                    <button type="button" class="outline" data-action="recheck-saved-profile-proxy-source-quarantined" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || quarantinedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceRecheckQuarantinedBtn'))}</button>
                    <button type="button" class="outline" data-action="select-saved-profile-proxy-source-linked" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || linkedProxyCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceSelectLinkedBtn'))}</button>
                    <button type="button" class="outline" data-action="select-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceSelectStaleBtn'))}</button>
                    <button type="button" class="outline" data-action="export-saved-profile-proxy-source-linked" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || linkedProxyCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceExportLinkedBtn'))}</button>
                    <button type="button" class="outline" data-action="export-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceExportStaleBtn'))}</button>
                    <button type="button" class="outline" data-action="disable-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceDisableStaleBtn'))}</button>
                    <button type="button" class="outline" data-action="detach-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceDetachStaleBtn'))}</button>
                    <button type="button" class="danger outline" data-action="delete-saved-profile-proxy-source-stale" data-source-id="${escapeHtml(source.id || '')}" ${sourceOpsBusy || staleLinkedCount === 0 ? 'disabled' : ''}>${escapeHtml(t('savedProxySourceDeleteStaleBtn'))}</button>
                </div>
            </details>
            <details style="border:1px solid var(--border); border-radius:8px; padding:10px; background:rgba(255,255,255,0.02);">
                <summary style="cursor:pointer; font-size:12px; color:var(--text-primary); user-select:none;">
                    ${escapeHtml(t('sourceStatusDiagTitle'))}
                </summary>
                <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceHealthTitle'))}</div>
                        ${buildSavedProfileProxySourceHealthMarkup(sourceId)}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceLastSyncTitle'))}</div>
                        ${lastSyncMarkup}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceMaintenanceTitle'))}</div>
                        ${maintenanceMarkup}
                    </div>
                </div>
            </details>
            <details style="border:1px solid var(--border); border-radius:8px; padding:10px; background:rgba(255,255,255,0.02);">
                <summary style="cursor:pointer; font-size:12px; color:var(--text-primary); user-select:none;">
                    ${escapeHtml(t('sourceHistoryPanelTitle'))}
                </summary>
                <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceMaintenanceHistoryTitle'))}</div>
                        ${maintenanceHistoryMarkup}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceHistoryTitle'))}</div>
                        ${historyMarkup}
                    </div>
                </div>
            </details>
            ${lastImportError ? `<div style="padding:10px; border:1px solid rgba(255,183,77,0.35); border-radius:8px; background:rgba(255,183,77,0.08); color:var(--warning); font-size:12px; line-height:1.5;"><strong>${escapeHtml(t('savedProxySourceLastImportErrorLabel'))}:</strong> ${escapeHtml(lastImportError)}</div>` : ''}
        </div>
    `;
    }).join('');
    wrap.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px;">
            ${overviewMarkup}
            <details style="border:1px solid var(--border); border-radius:8px; padding:10px; background:rgba(255,255,255,0.02);">
                <summary style="cursor:pointer; font-size:12px; color:var(--text-primary); user-select:none;">${escapeHtml(t('sourceInsightsTitle'))}</summary>
                <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                    ${batchHistoryMarkup}
                    ${trendMarkup}
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="font-size:11px; opacity:0.7;">${escapeHtml(t('savedProxySourceAlertsTitle'))}</div>
                        ${alertsMarkup}
                    </div>
                </div>
            </details>
            ${cardsMarkup}
        </div>
    `;
}

function renderSavedProfileProxyEditors() {
    const wrap = document.getElementById('savedProfileProxyEditorList');
    if (!wrap) return;
    const proxies = Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [];
    pruneSelectedSavedProfileProxyIds();
    syncSavedProfileProxyEditorControls();
    if (proxies.length === 0) {
        wrap.innerHTML = `<div style="font-size:12px; opacity:0.65; padding:10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('noSavedProfileProxies'))}</div>`;
        return;
    }
    const filtered = getVisibleSavedProfileProxyEntries();
    if (filtered.length === 0) {
        wrap.innerHTML = `<div style="font-size:12px; opacity:0.65; padding:10px; border:1px dashed var(--border); border-radius:8px;">${escapeHtml(t('noSavedProfileProxyMatches'))}</div>`;
        return;
    }
    wrap.innerHTML = filtered.map((proxy) => {
        const proxyIndex = proxies.indexOf(proxy);
        const proxyId = normalizeSavedProxyId(proxy && proxy.id);
        const domToken = getSavedProfileProxySelectionDomToken(proxyId);
        const isLockedId = savedProfileProxyOriginalIds.has(proxyId);
        const testResult = savedProfileProxyTestCache.get(proxyId) || null;
        const isSelected = selectedSavedProfileProxyIds.has(proxyId);
        const sourceState = getSavedProfileProxySourceState(proxy);
        const sourceSummary = sourceState.id
            ? [
                sourceState.name || sourceState.id,
                sourceState.exists ? '' : t('savedProxySourceStatusRemoved'),
                sourceState.stale && sourceState.missingSince > 0 ? `${t('savedProxySourceStatusStaleSince')}: ${formatDiagTime(sourceState.missingSince)}` : '',
                sourceState.importedAt > 0 ? `${t('savedProxySourceStatusImportedAt')}: ${formatDiagTime(sourceState.importedAt)}` : '',
            ].filter(Boolean).join(' · ')
            : '';
        return `
        <div id="saved-proxy-card-${domToken}" style="border:1px solid ${isSelected ? 'rgba(0, 224, 255, 0.55)' : 'var(--border)'}; border-radius:10px; padding:12px; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; gap:12px; ${isSelected ? 'box-shadow:0 0 0 1px rgba(0, 224, 255, 0.14) inset;' : ''}">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <label style="display:flex; align-items:center; gap:6px; font-size:11px; opacity:0.9;">
                        <input id="saved-proxy-select-${domToken}" type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleSavedProfileProxySelection('${escapeHtml(proxyId)}', this.checked)">
                        <span>${escapeHtml(t('selectProfileLabel'))}</span>
                    </label>
                    <strong style="color:var(--text-primary);">${escapeHtml(t('savedProxyCardTitle'))} #${proxyIndex + 1}</strong>
                    <span style="font-size:11px; opacity:0.72; padding:2px 8px; border-radius:999px; border:1px solid var(--border);">
                        ${escapeHtml(`${t('savedProxyUsageCount')}: ${getSavedProfileProxyUsageCount(proxy.id)} ${t('msgProfiles')}`)}
                    </span>
                    ${isLockedId ? `<span style="font-size:11px; opacity:0.72; padding:2px 8px; border-radius:999px; border:1px solid var(--border);">${escapeHtml(t('savedProxyIdLocked'))}</span>` : ''}
                </div>
                <button type="button" class="danger outline" data-action="delete-saved-profile-proxy" data-proxy-index="${proxyIndex}">${escapeHtml(t('deletePreset'))}</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetIdLabel'))}</span>
                    <input type="text" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="id" value="${escapeHtml(proxy.id || '')}" spellcheck="false" ${isLockedId ? 'readonly' : ''} style="${isLockedId ? 'opacity:0.72;' : ''}">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('presetNameLabel'))}</span>
                    <input type="text" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="name" value="${escapeHtml(proxy.name || '')}" spellcheck="false">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('tagsLabel'))}</span>
                    <input type="text" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="tags" value="${escapeHtml(Array.isArray(proxy.tags) ? proxy.tags.join(', ') : '')}" spellcheck="false" placeholder="us, tiktok, warmup">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('savedProxyGroupLabel'))}</span>
                    <input type="text" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="group" value="${escapeHtml(proxy.group || '')}" spellcheck="false" placeholder="US / Warmup / Team A">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                    <span>${escapeHtml(t('savedProxyChangeIpUrlLabel'))}</span>
                    <div style="display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px;">
                        <input type="text" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="changeIpUrl" value="${escapeHtml(proxy.changeIpUrl || '')}" spellcheck="false" placeholder="https://provider.example.com/change-ip">
                        <button type="button" class="outline" data-action="rotate-saved-profile-proxy" data-proxy-index="${proxyIndex}" ${proxy.changeIpUrl ? '' : 'disabled'}>${escapeHtml(t('savedProxyRotateIpBtn'))}</button>
                    </div>
                </label>
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding-top:22px;">
                    <input type="checkbox" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="enabled" ${proxy.enabled !== false ? 'checked' : ''}>
                    <span>${escapeHtml(t('presetEnabledLabel'))}</span>
                </label>
            </div>
            <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                <span>${escapeHtml(t('savedProxyStringLabel'))}</span>
                <textarea rows="3" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="proxyStr" spellcheck="false" placeholder="socks5://user:pass@host:port">${escapeHtml(proxy.proxyStr || '')}</textarea>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px; font-size:11px; opacity:0.85;">
                <span>${escapeHtml(t('savedProxyNotesLabel'))}</span>
                <textarea rows="2" data-entity="saved-profile-proxy" data-proxy-index="${proxyIndex}" data-field="notes" spellcheck="false" placeholder="provider, owner, expiry, remarks...">${escapeHtml(proxy.notes || '')}</textarea>
            </label>
            ${sourceSummary ? `
            <div style="padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:11px; opacity:0.82;">
                <div style="margin-bottom:4px;">${escapeHtml(t('savedProxySourceProvenanceLabel'))}</div>
                <div style="color:var(--text-primary);">${escapeHtml(sourceSummary)}</div>
            </div>` : ''}
            <div>${buildSavedProfileProxyStatusMarkup(proxy, testResult)}</div>
        </div>
    `;
    }).join('');
}

function renderAdvancedPresetEditors() {
    renderHeaderPresetEditors();
    renderDiagnosticPresetEditors();
    renderSavedProfileProxySourceEditors();
    renderSavedProfileProxyEditors();
}

function bindAdvancedPresetEditorEvents() {
    if (advancedPresetEventsBound) return;
    advancedPresetEventsBound = true;

    const headerWrap = document.getElementById('headerPresetEditorList');
    const diagnosticWrap = document.getElementById('diagnosticPresetEditorList');
    const savedProxySourceWrap = document.getElementById('savedProfileProxySourceEditorList');
    const savedProxyWrap = document.getElementById('savedProfileProxyEditorList');
    const onFieldChange = async (target) => {
        if (!target || !target.dataset) return;
        const entity = target.dataset.entity;
        const presetIndex = Number(target.dataset.presetIndex);

        if (entity === 'header-preset') {
            if (!Number.isInteger(presetIndex) || presetIndex < 0) return;
            const preset = advancedPresetState.headerPresets[presetIndex];
            if (!preset) return;
            preset[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
            return;
        }

        if (entity === 'header-rule') {
            if (!Number.isInteger(presetIndex) || presetIndex < 0) return;
            const preset = advancedPresetState.headerPresets[presetIndex];
            const ruleIndex = Number(target.dataset.ruleIndex);
            const rule = preset && Array.isArray(preset.rules) ? preset.rules[ruleIndex] : null;
            if (!rule) return;
            const field = target.dataset.field;
            if (field === 'enabled') rule.enabled = target.checked;
            else if (field === 'hosts') {
                rule.match = rule.match || {};
                rule.match.hosts = splitPresetTextList(target.value);
            } else if (field === 'resourceTypes') {
                rule.match = rule.match || {};
                rule.match.resourceTypes = Array.from(target.selectedOptions || []).map(option => option.value);
            } else {
                rule[field] = target.value;
            }
            return;
        }

        if (entity === 'diagnostic-preset') {
            if (!Number.isInteger(presetIndex) || presetIndex < 0) return;
            const preset = advancedPresetState.diagnosticPresets[presetIndex];
            if (!preset) return;
            preset[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
            return;
        }

        if (entity === 'saved-profile-proxy-source') {
            const sourceIndex = Number(target.dataset.sourceIndex);
            if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return;
            const source = advancedPresetState.savedProfileProxySources[sourceIndex];
            if (!source) return;
            const previousId = normalizeSavedProfileProxySourceId(source && source.id);
            const isLockedSourceId = previousId && savedProfileProxySourceOriginalIds.has(previousId);
            if (target.dataset.field === 'tags') {
                source.tags = String(target.value || '')
                    .split(/[\n,，]+/)
                    .map((item) => item.trim())
                    .filter(Boolean);
            } else if (['enabled', 'autoCheck', 'scheduleEnabled', 'autoQuarantineOnRefresh', 'autoRecheckQuarantinedOnRefresh'].includes(target.dataset.field)) {
                source[target.dataset.field] = target.checked;
            } else if (target.dataset.field === 'stalePolicy') {
                source.stalePolicy = normalizeSavedProfileProxySourceStalePolicy(target.value);
            } else if (target.dataset.field === 'scheduleIntervalMinutes') {
                source.scheduleIntervalMinutes = normalizeSavedProfileProxySourceScheduleIntervalMinutes(target.value) || 60;
                target.value = String(source.scheduleIntervalMinutes);
            } else {
                if (target.dataset.field === 'id' && isLockedSourceId) {
                    source.id = previousId;
                    target.value = previousId;
                    return;
                }
                source[target.dataset.field] = target.value;
                if (target.dataset.field === 'id') {
                    const nextId = normalizeSavedProfileProxySourceId(source && source.id);
                    if (previousId && nextId && previousId !== nextId) {
                        (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : []).forEach((proxy) => {
                            if (normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) !== previousId) return;
                            proxy.sourceId = nextId;
                        });
                    }
                }
            }
            return;
        }

        if (entity === 'saved-profile-proxy') {
            const proxyIndex = Number(target.dataset.proxyIndex);
            if (!Number.isInteger(proxyIndex) || proxyIndex < 0) return;
            const proxy = advancedPresetState.savedProfileProxies[proxyIndex];
            if (!proxy) return;
            const previousId = normalizeSavedProxyId(proxy && proxy.id);
            if (target.dataset.field === 'tags') {
                proxy.tags = String(target.value || '')
                    .split(/[\n,，]+/)
                    .map((item) => item.trim())
                    .filter(Boolean);
            } else if (target.dataset.field === 'enabled') {
                if (!target.checked) {
                    const confirmed = await confirmSavedProfileProxyImpact(proxy, 'disable');
                    if (!confirmed) {
                        target.checked = true;
                        proxy.enabled = true;
                        return;
                    }
                }
                proxy.enabled = target.checked;
                renderSavedProfileProxyEditors();
            } else {
                proxy[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
                if (target.dataset.field === 'id') {
                    const nextId = normalizeSavedProxyId(proxy && proxy.id);
                    if (previousId && previousId !== nextId && selectedSavedProfileProxyIds.has(previousId)) {
                        selectedSavedProfileProxyIds.delete(previousId);
                        if (nextId) selectedSavedProfileProxyIds.add(nextId);
                    }
                }
                if (target.dataset.field === 'changeIpUrl') {
                    const rotateBtn = savedProxyWrap && savedProxyWrap.querySelector(
                        `[data-action="rotate-saved-profile-proxy"][data-proxy-index="${proxyIndex}"]`
                    );
                    if (rotateBtn) rotateBtn.disabled = !String(proxy.changeIpUrl || '').trim();
                }
                updateSavedProfileProxySelectionBar();
            }
        }
    };

    [headerWrap, diagnosticWrap, savedProxySourceWrap, savedProxyWrap].forEach((wrap) => {
        if (!wrap) return;
        wrap.addEventListener('input', (e) => {
            if (e.target && e.target.type === 'checkbox') return;
            void onFieldChange(e.target);
        });
        wrap.addEventListener('change', (e) => { void onFieldChange(e.target); });
        wrap.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const presetIndex = Number(btn.dataset.presetIndex);
            const ruleIndex = Number(btn.dataset.ruleIndex);
            const proxyIndex = Number(btn.dataset.proxyIndex);
            const sourceId = normalizeSavedProfileProxySourceId(btn.dataset.sourceId);
            if (btn.dataset.action === 'delete-header-preset' && Number.isInteger(presetIndex) && presetIndex >= 0) {
                advancedPresetState.headerPresets.splice(presetIndex, 1);
                renderAdvancedPresetEditors();
            } else if (btn.dataset.action === 'add-header-rule' && Number.isInteger(presetIndex) && presetIndex >= 0) {
                const preset = advancedPresetState.headerPresets[presetIndex];
                if (!preset.rules) preset.rules = [];
                preset.rules.push(createHeaderRuleDraft());
                renderAdvancedPresetEditors();
            } else if (btn.dataset.action === 'delete-header-rule' && Number.isInteger(presetIndex) && presetIndex >= 0 && Number.isInteger(ruleIndex) && ruleIndex >= 0) {
                const preset = advancedPresetState.headerPresets[presetIndex];
                if (preset && Array.isArray(preset.rules)) preset.rules.splice(ruleIndex, 1);
                renderAdvancedPresetEditors();
            } else if (btn.dataset.action === 'delete-diagnostic-preset' && Number.isInteger(presetIndex) && presetIndex >= 0) {
                advancedPresetState.diagnosticPresets.splice(presetIndex, 1);
                renderAdvancedPresetEditors();
            } else if (btn.dataset.action === 'refresh-due-saved-profile-proxy-sources') {
                await refreshDueSavedProfileProxySources();
            } else if (btn.dataset.action === 'quarantine-candidate-saved-profile-proxy-sources') {
                await quarantineCandidateSavedProfileProxiesAcrossSources();
            } else if (btn.dataset.action === 'recheck-quarantined-saved-profile-proxy-sources') {
                await recheckQuarantinedSavedProfileProxiesAcrossSources();
            } else if (btn.dataset.action === 'run-attention-maintenance-saved-profile-proxy-sources') {
                await runSavedProfileProxySourceBulkMaintenanceAction();
            } else if (btn.dataset.action === 'refresh-saved-profile-proxy-source') {
                const sourceIndex = Number(btn.dataset.sourceIndex);
                if (Number.isInteger(sourceIndex) && sourceIndex >= 0) await refreshSavedProfileProxySourceByIndex(sourceIndex, btn);
            } else if (btn.dataset.action === 'delete-saved-profile-proxy-source') {
                const sourceIndex = Number(btn.dataset.sourceIndex);
                if (Number.isInteger(sourceIndex) && sourceIndex >= 0) {
                    const source = advancedPresetState.savedProfileProxySources[sourceIndex];
                    const linkedCount = (Array.isArray(advancedPresetState.savedProfileProxies) ? advancedPresetState.savedProfileProxies : [])
                        .filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === normalizeSavedProfileProxySourceId(source && source.id))
                        .length;
                    if (linkedCount > 0) {
                        const confirmed = window.confirm(uiText(
                            `该来源下仍有关联代理 ${linkedCount} 条。删除来源后不会删除代理，但来源状态会变为“已删除”。是否继续？`,
                            `${linkedCount} proxies are still linked to this source. Deleting the source will keep the proxies, but mark the source as removed. Continue?`
                        ));
                        if (!confirmed) return;
                    }
                    advancedPresetState.savedProfileProxySources.splice(sourceIndex, 1);
                    renderAdvancedPresetEditors();
                }
            } else if (btn.dataset.action === 'select-saved-profile-proxy-source-linked' && sourceId) {
                selectSavedProfileProxiesForSource(sourceId, { staleOnly: false });
            } else if (btn.dataset.action === 'select-saved-profile-proxy-source-stale' && sourceId) {
                selectSavedProfileProxiesForSource(sourceId, { staleOnly: true });
            } else if (btn.dataset.action === 'run-maintenance-saved-profile-proxy-source' && sourceId) {
                await runSavedProfileProxySourceMaintenanceAction(sourceId, btn);
            } else if (btn.dataset.action === 'retest-saved-profile-proxy-source-linked' && sourceId) {
                await retestSavedProfileProxiesForSource(sourceId, btn, { staleOnly: false });
            } else if (btn.dataset.action === 'retest-saved-profile-proxy-source-stale' && sourceId) {
                await retestSavedProfileProxiesForSource(sourceId, btn, { staleOnly: true });
            } else if (btn.dataset.action === 'quarantine-saved-profile-proxy-source-failed' && sourceId) {
                await quarantineFailedSavedProfileProxiesForSource(sourceId, btn);
            } else if (btn.dataset.action === 'recheck-saved-profile-proxy-source-quarantined' && sourceId) {
                await recheckQuarantinedSavedProfileProxiesForSource(sourceId, btn);
            } else if (btn.dataset.action === 'export-saved-profile-proxy-source-linked' && sourceId) {
                await exportSavedProfileProxyEntriesForSource(sourceId, 'all', btn);
            } else if (btn.dataset.action === 'export-saved-profile-proxy-source-stale' && sourceId) {
                await exportSavedProfileProxyEntriesForSource(sourceId, 'stale', btn);
            } else if (btn.dataset.action === 'disable-saved-profile-proxy-source-stale' && sourceId) {
                await disableStaleSavedProfileProxiesForSource(sourceId, btn);
            } else if (btn.dataset.action === 'detach-saved-profile-proxy-source-stale' && sourceId) {
                await detachStaleSavedProfileProxiesForSource(sourceId, btn);
            } else if (btn.dataset.action === 'delete-saved-profile-proxy-source-stale' && sourceId) {
                await deleteStaleSavedProfileProxiesForSource(sourceId, btn);
            } else if (btn.dataset.action === 'delete-saved-profile-proxy' && Number.isInteger(proxyIndex) && proxyIndex >= 0) {
                const proxy = advancedPresetState.savedProfileProxies[proxyIndex];
                const confirmed = await confirmSavedProfileProxyImpact(proxy, 'delete');
                if (!confirmed) return;
                advancedPresetState.savedProfileProxies.splice(proxyIndex, 1);
                savedProfileProxyTestCache.delete(normalizeSavedProxyId(proxy && proxy.id));
                renderAdvancedPresetEditors();
            } else if (btn.dataset.action === 'rotate-saved-profile-proxy' && Number.isInteger(proxyIndex) && proxyIndex >= 0) {
                const proxy = advancedPresetState.savedProfileProxies[proxyIndex];
                await triggerSavedProfileProxyChangeIp(proxy && proxy.id, btn);
            }
        });
    });
}

async function loadAdvancedPresetEditors() {
    const settings = await window.electronAPI.getSettings();
    await refreshSavedProfileProxyUsageCounts();
    globalSettings = settings || globalSettings;
    savedProfileProxySourceOriginalIds = new Set(
        ((settings && settings.savedProfileProxySources) || []).map((source) => normalizeSavedProfileProxySourceId(source && source.id)).filter(Boolean)
    );
    savedProfileProxyOriginalIds = new Set(
        ((settings && settings.savedProfileProxies) || []).map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean)
    );
    advancedPresetState = {
        headerPresets: cloneJson((settings && settings.headerPresets) || []),
        diagnosticPresets: cloneJson((settings && settings.diagnosticPresets) || []),
        savedProfileProxySources: cloneJson((settings && settings.savedProfileProxySources) || []),
        savedProfileProxies: cloneJson((settings && settings.savedProfileProxies) || [])
    };
    pruneSelectedSavedProfileProxyIds();
    await refreshSavedProfileProxyTestCache(advancedPresetState.savedProfileProxies.map((proxy) => proxy && proxy.id));
    renderAdvancedPresetEditors();
    return settings;
}

async function saveAdvancedPresetEditor(field, successKey) {
    try {
        const settings = await window.electronAPI.getSettings();
        const previousSavedProfileProxies = field === 'savedProfileProxies'
            ? cloneJson((settings && settings.savedProfileProxies) || [])
            : [];
        const pendingSavedProfileProxies = field === 'savedProfileProxies'
            ? cloneJson(advancedPresetState.savedProfileProxies || [])
            : [];
        let persistedDraftTests = 0;
        settings[field] = cloneJson(advancedPresetState[field] || []);
        await window.electronAPI.saveSettings(settings);
        const latest = await window.electronAPI.getSettings();
        const fallbackSyncResult = field === 'savedProfileProxies'
            ? await syncSavedProxyFallbacksForProfiles(previousSavedProfileProxies, (latest && latest.savedProfileProxies) || [])
            : { updated: 0, failed: [] };
        await refreshSavedProfileProxyUsageCounts();
        advancedPresetState[field] = cloneJson((latest && latest[field]) || []);
        globalSettings = latest || globalSettings;
        if (field === 'savedProfileProxySources') {
            savedProfileProxySourceOriginalIds = new Set(
                ((latest && latest.savedProfileProxySources) || []).map((source) => normalizeSavedProfileProxySourceId(source && source.id)).filter(Boolean)
            );
        }
        if (field === 'savedProfileProxies') {
            savedProfileProxyOriginalIds = new Set(
                ((latest && latest.savedProfileProxies) || []).map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean)
            );
            const removedIds = previousSavedProfileProxies
                .map((proxy) => normalizeSavedProxyId(proxy && proxy.id))
                .filter(Boolean)
                .filter((id) => !advancedPresetState.savedProfileProxies.some((proxy) => normalizeSavedProxyId(proxy && proxy.id) === id));
            await Promise.all(removedIds.map(async (id) => {
                savedProfileProxyTestCache.delete(id);
                try {
                    await window.electronAPI.invoke('delete-saved-profile-proxy-test', id);
                } catch (e) { }
            }));
            persistedDraftTests = await persistSavedProfileProxyDraftTests(
                pendingSavedProfileProxies.filter((proxy) => ((latest && latest.savedProfileProxies) || [])
                    .some((item) => normalizeSavedProxyId(item && item.id) === normalizeSavedProxyId(proxy && proxy.id)
                        && normalizeProxyTestInput(item && item.proxyStr || '') === normalizeProxyTestInput(proxy && proxy.proxyStr || ''))),
                latest
            );
            await refreshSavedProfileProxyTestCache(advancedPresetState.savedProfileProxies.map((proxy) => proxy && proxy.id));
            if (persistedDraftTests > 0) {
                savedProfileProxyTestCache.forEach((result, id) => {
                    savedProfileProxyTestCache.set(id, normalizeSavedProfileProxyTestResultEntry(result));
                });
            }
            pruneSelectedSavedProfileProxyIds();
        }
        renderAdvancedPresetEditors();
        renderHeaderPresetSelect('addHeaderPresetId', latest, document.getElementById('addHeaderPresetId')?.value || '');
        renderHeaderPresetSelect('editHeaderPresetId', latest, document.getElementById('editHeaderPresetId')?.value || '');
        renderSavedProfileProxySelect('addSavedProxyId', latest, document.getElementById('addSavedProxyId')?.value || '');
        renderSavedProfileProxySelect('editSavedProxyId', latest, document.getElementById('editSavedProxyId')?.value || '');
        renderSavedProfileProxySelect('batchSavedProxyId', latest, document.getElementById('batchSavedProxyId')?.value || '');
        renderSavedProfileProxySelect('batchReplaceSavedProxyFromId', latest, document.getElementById('batchReplaceSavedProxyFromId')?.value || '');
        renderSavedProfileProxySelect('batchReplaceSavedProxyToId', latest, document.getElementById('batchReplaceSavedProxyToId')?.value || '');
        syncSavedProxyBindingInfo('add', latest);
        syncSavedProxyBindingInfo('edit', latest);
        syncBatchSavedProxyBindInfo();
        syncBatchReplaceSavedProxyInfo();
        syncBatchRandomSavedProxyInfo();
        if (field === 'savedProfileProxies') {
            handleSavedProfileProxyChange('add');
            handleSavedProfileProxyChange('edit');
            await loadProfiles();
        }
        const messages = [t(successKey)];
        if (field === 'savedProfileProxies' && fallbackSyncResult.updated > 0) {
            messages.push(uiText(
                `已同步 ${fallbackSyncResult.updated} 个环境的 fallback 代理文本`,
                `Synced fallback proxy text for ${fallbackSyncResult.updated} profiles`
            ));
        }
        if (field === 'savedProfileProxies' && fallbackSyncResult.failed.length > 0) {
            messages.push(`${uiText('同步失败', 'Sync failed')}: ${fallbackSyncResult.failed.slice(0, 3).join(', ')}${fallbackSyncResult.failed.length > 3 ? '...' : ''}`);
        }
        if (field === 'savedProfileProxies' && persistedDraftTests > 0) {
            messages.push(uiText(
                `已保留 ${persistedDraftTests} 条草稿代理检测结果`,
                `Preserved ${persistedDraftTests} draft proxy test results`
            ));
        }
        showAlert(messages.filter(Boolean).join('\n'));
    } catch (e) {
        showAlert((e && e.message) ? e.message : String(e));
    }
}

function saveHeaderPresetsEditor() {
    return saveAdvancedPresetEditor('headerPresets', 'headerPresetsSaved');
}

function saveDiagnosticPresetsEditor() {
    return saveAdvancedPresetEditor('diagnosticPresets', 'diagnosticPresetsSaved');
}

function saveSavedProfileProxySourcesEditor() {
    return saveAdvancedPresetEditor('savedProfileProxySources', 'savedProfileProxySourcesSaved');
}

function saveSavedProfileProxiesEditor() {
    return saveAdvancedPresetEditor('savedProfileProxies', 'savedProfileProxiesSaved');
}

async function resetHeaderPresetsEditor() {
    const settings = await window.electronAPI.getSettings();
    advancedPresetState.headerPresets = cloneJson((settings && settings.headerPresets) || []);
    renderAdvancedPresetEditors();
}

async function resetDiagnosticPresetsEditor() {
    const settings = await window.electronAPI.getSettings();
    advancedPresetState.diagnosticPresets = cloneJson((settings && settings.diagnosticPresets) || []);
    renderAdvancedPresetEditors();
}

async function resetSavedProfileProxySourcesEditor() {
    const settings = await window.electronAPI.getSettings();
    savedProfileProxySourceOriginalIds = new Set(
        ((settings && settings.savedProfileProxySources) || []).map((source) => normalizeSavedProfileProxySourceId(source && source.id)).filter(Boolean)
    );
    advancedPresetState.savedProfileProxySources = cloneJson((settings && settings.savedProfileProxySources) || []);
    renderAdvancedPresetEditors();
}

async function resetSavedProfileProxiesEditor() {
    const settings = await window.electronAPI.getSettings();
    savedProfileProxyOriginalIds = new Set(
        ((settings && settings.savedProfileProxies) || []).map((proxy) => normalizeSavedProxyId(proxy && proxy.id)).filter(Boolean)
    );
    advancedPresetState.savedProfileProxies = cloneJson((settings && settings.savedProfileProxies) || []);
    pruneSelectedSavedProfileProxyIds();
    await refreshSavedProfileProxyTestCache(advancedPresetState.savedProfileProxies.map((proxy) => proxy && proxy.id));
    renderAdvancedPresetEditors();
}

function addHeaderPreset() {
    advancedPresetState.headerPresets.push(createHeaderPresetDraft());
    renderAdvancedPresetEditors();
}

function addDiagnosticPreset() {
    advancedPresetState.diagnosticPresets.push(createDiagnosticPresetDraft());
    renderAdvancedPresetEditors();
}

function addSavedProfileProxySource() {
    advancedPresetState.savedProfileProxySources.push(createSavedProfileProxySourceDraft());
    renderAdvancedPresetEditors();
}

function addSavedProfileProxy() {
    advancedPresetState.savedProfileProxies.push(createSavedProfileProxyDraft());
    renderAdvancedPresetEditors();
}

function openSettings() {
    document.getElementById('settingsModal').style.display = 'flex';
    loadUserExtensions();
    loadWatermarkStyle();
    loadRemoteDebuggingSetting();
    loadLaunchSettings();
    loadBackgroundMode();
    loadCustomArgsSetting();
    loadApiServerSetting();
    loadDataPathSetting();
}
function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
    switchSettingsTab._advancedLoaded = false;
    // Reset to default tab so next open doesn't show stale advanced content
    switchSettingsTab('extensions');
}

// Watermark Style Functions
function loadWatermarkStyle() {
    const style = localStorage.getItem('geekez_watermark_style') || 'enhanced';
    const radios = document.getElementsByName('watermarkStyle');
    radios.forEach(radio => {
        if (radio.value === style) {
            radio.checked = true;
            radio.parentElement.style.borderColor = 'var(--accent)';
        } else {
            radio.parentElement.style.borderColor = 'var(--border)';
        }
    });
}

function saveWatermarkStyle(style) {
    localStorage.setItem('geekez_watermark_style', style);
    const radios = document.getElementsByName('watermarkStyle');
    radios.forEach(radio => {
        if (radio.checked) {
            radio.parentElement.style.borderColor = 'var(--accent)';
        } else {
            radio.parentElement.style.borderColor = 'var(--border)';
        }
    });
    showAlert('水印样式已保存，重启环境后生效');
}

// --- 自定义数据目录 ---
async function loadDataPathSetting() {
    try {
        const info = await window.electronAPI.invoke('get-data-path-info');
        document.getElementById('currentDataPath').textContent = info.currentPath;
        document.getElementById('resetDataPathBtn').style.display = info.isCustom ? 'inline-block' : 'none';
    } catch (e) {
        console.error('Failed to load data path:', e);
    }
}

async function selectDataDirectory() {
    const newPath = await window.electronAPI.invoke('select-data-directory');
    if (!newPath) return;

    // 确认迁移
    const migrate = confirm(t('dataPathConfirmMigrate') || '是否将现有数据迁移到新目录？\n\n选择"确定"迁移数据\n选择"取消"仅更改路径（不迁移）');

    showAlert(t('dataPathMigrating') || '正在迁移数据，请稍候...');

    const result = await window.electronAPI.invoke('set-data-directory', { newPath, migrate });

    if (result.success) {
        document.getElementById('currentDataPath').textContent = newPath;
        document.getElementById('resetDataPathBtn').style.display = 'inline-block';
        document.getElementById('dataPathWarning').style.display = 'block';
        showAlert(t('dataPathSuccess') || '数据目录已更改，请重启应用');
    } else {
        showAlert((t('dataPathError') || '更改失败: ') + result.error);
    }
}

async function resetDataDirectory() {
    if (!confirm(t('dataPathConfirmReset') || '确定要恢复默认数据目录吗？\n\n注意：这不会迁移数据，您需要手动处理自定义目录中的数据。')) {
        return;
    }

    const result = await window.electronAPI.invoke('reset-data-directory');

    if (result.success) {
        const info = await window.electronAPI.invoke('get-data-path-info');
        document.getElementById('currentDataPath').textContent = info.defaultPath;
        document.getElementById('resetDataPathBtn').style.display = 'none';
        document.getElementById('dataPathWarning').style.display = 'block';
        showAlert(t('dataPathResetSuccess') || '已恢复默认目录，请重启应用');
    } else {
        showAlert((t('dataPathError') || '操作失败: ') + result.error);
    }
}

async function saveRemoteDebuggingSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableRemoteDebugging = enabled;
    await window.electronAPI.saveSettings(settings);
    showAlert(enabled ? '远程调试已启用，编辑环境时可设置端口' : '远程调试已禁用');
}

// Unified toggle handler for developer features
function handleDevToggle(checkbox) {
    const toggleSwitch = checkbox.closest('.toggle-switch');
    const track = toggleSwitch?.querySelector('.toggle-track');
    const knob = toggleSwitch?.querySelector('.toggle-knob');

    // Animate toggle - update track color and knob position
    if (track) {
        track.style.background = checkbox.checked ? 'var(--accent)' : 'var(--border)';
    }
    if (knob) {
        knob.style.left = checkbox.checked ? '22px' : '2px';
    }

    // Call appropriate save function based on checkbox id
    if (checkbox.id === 'enableRemoteDebugging') {
        saveRemoteDebuggingSetting(checkbox.checked);
    } else if (checkbox.id === 'enableCustomArgs') {
        saveCustomArgsSetting(checkbox.checked);
    } else if (checkbox.id === 'enableApiServer') {
        saveApiServerSetting(checkbox.checked);
    }
}

// Update toggle visual state (for loading saved state)
function updateToggleVisual(checkbox) {
    const toggleSwitch = checkbox.closest('.toggle-switch');
    const track = toggleSwitch?.querySelector('.toggle-track');
    const knob = toggleSwitch?.querySelector('.toggle-knob');

    if (track) {
        track.style.background = checkbox.checked ? 'var(--accent)' : 'var(--border)';
    }
    if (knob) {
        knob.style.left = checkbox.checked ? '22px' : '2px';
    }
}

async function loadRemoteDebuggingSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableRemoteDebugging');
    if (checkbox) {
        checkbox.checked = settings.enableRemoteDebugging || false;
        updateToggleVisual(checkbox);
    }
}

async function loadLaunchSettings() {
    const settings = await window.electronAPI.getSettings();
    const dashCb = document.getElementById('dashboardOnLaunch');
    const quietCb = document.getElementById('apiQuietLaunch');
    if (dashCb) dashCb.checked = settings.dashboardOnLaunch === true;
    if (quietCb) quietCb.checked = settings.apiQuietLaunch === true;
}

async function saveLaunchSettings() {
    const settings = await window.electronAPI.getSettings();
    const dashCb = document.getElementById('dashboardOnLaunch');
    const quietCb = document.getElementById('apiQuietLaunch');
    settings.dashboardOnLaunch = !!(dashCb && dashCb.checked);
    settings.apiQuietLaunch = !!(quietCb && quietCb.checked);
    await window.electronAPI.saveSettings(settings);
}

async function loadBackgroundMode() {
    const settings = await window.electronAPI.getSettings();
    const mode = settings.backgroundMode === 'keep-active' ? 'keep-active' : 'chromium';
    const radios = document.getElementsByName('backgroundMode');
    radios.forEach(radio => {
        const active = radio.value === mode;
        radio.checked = active;
        radio.parentElement.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    });
}

async function saveBackgroundMode(mode) {
    const settings = await window.electronAPI.getSettings();
    settings.backgroundMode = mode === 'chromium' ? 'chromium' : 'keep-active';
    await window.electronAPI.saveSettings(settings);
    const radios = document.getElementsByName('backgroundMode');
    radios.forEach(radio => {
        radio.parentElement.style.borderColor = radio.checked ? 'var(--accent)' : 'var(--border)';
    });
    showAlert(settings.backgroundMode === 'chromium'
        ? (t('backgroundModeSavedChromium') || '已切换为 Chromium 默认后台模式，重启环境后生效')
        : (t('backgroundModeSavedKeepActive') || '已切换为保持后台活跃模式，重启环境后生效'));
}
// Custom Args Settings
async function saveCustomArgsSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableCustomArgs = enabled;
    await window.electronAPI.saveSettings(settings);
    showAlert(enabled ? t('customArgsEnabled') || '自定义启动参数已启用' : t('customArgsDisabled') || '自定义启动参数已禁用');
}

async function loadCustomArgsSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableCustomArgs');
    if (checkbox) {
        checkbox.checked = settings.enableCustomArgs || false;
        updateToggleVisual(checkbox);
    }
}

// API Server Settings
async function saveApiServerSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableApiServer = enabled;
    await window.electronAPI.saveSettings(settings);

    // Show/hide port section
    document.getElementById('apiPortSection').style.display = enabled ? 'block' : 'none';

    if (enabled) {
        // Start API server
        const port = settings.apiPort || 12138;
        const result = await window.electronAPI.invoke('start-api-server', { port });
        if (result.success) {
            document.getElementById('apiStatus').style.display = 'inline-block';
            showAlert(`${t('apiStarted') || 'API 服务已启动'}: http://localhost:${port}`);
        } else {
            showAlert((t('apiError') || 'API 启动失败: ') + result.error);
        }
    } else {
        // Stop API server
        await window.electronAPI.invoke('stop-api-server');
        document.getElementById('apiStatus').style.display = 'none';
        showAlert(t('apiStopped') || 'API 服务已停止');
    }
}

async function saveApiPort() {
    const port = parseInt(document.getElementById('apiPortInput').value) || 12138;
    if (port < 1024 || port > 65535) {
        showAlert(t('apiPortInvalid') || '端口号必须在 1024-65535 之间');
        return;
    }

    const settings = await window.electronAPI.getSettings();
    settings.apiPort = port;
    await window.electronAPI.saveSettings(settings);
    document.getElementById('apiPortDisplay').textContent = port;

    // Restart API server if enabled
    if (settings.enableApiServer) {
        await window.electronAPI.invoke('stop-api-server');
        const result = await window.electronAPI.invoke('start-api-server', { port });
        if (result.success) {
            showAlert(`${t('apiRestarted') || 'API 服务已重启'}: http://localhost:${port}`);
        }
    } else {
        showAlert(t('apiPortSaved') || 'API 端口已保存');
    }
}

async function loadApiServerSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableApiServer');
    const portInput = document.getElementById('apiPortInput');
    const portDisplay = document.getElementById('apiPortDisplay');
    const portSection = document.getElementById('apiPortSection');
    const apiStatus = document.getElementById('apiStatus');

    if (checkbox) {
        checkbox.checked = settings.enableApiServer || false;
        updateToggleVisual(checkbox);
    }
    if (portInput) {
        portInput.value = settings.apiPort || 12138;
    }
    if (portDisplay) {
        portDisplay.textContent = settings.apiPort || 12138;
    }
    if (portSection) {
        portSection.style.display = settings.enableApiServer ? 'block' : 'none';
    }

    // Check if API is running
    try {
        const status = await window.electronAPI.invoke('get-api-status');
        if (apiStatus) {
            apiStatus.style.display = status.running ? 'inline-block' : 'none';
        }
    } catch (e) { }
}

function openApiDocs() {
    window.electronAPI.invoke('open-url', APP_API_DOCS_URL);
}

function switchSettingsTab(tabName, tabButton) {
    // Update tab buttons
    document.querySelectorAll('#settingsModal .tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeTabButton = tabButton || document.querySelector(`#settingsModal .tab-btn[onclick*="${tabName}"]`);
    if (activeTabButton) activeTabButton.classList.add('active');

    // Update tab content
    document.querySelectorAll('.settings-section').forEach(section => {
        section.style.display = 'none';
    });
    document.getElementById('settings-' + tabName).style.display = 'block';

    // Lazy-load advanced preset editors on first switch
    if (tabName === 'advanced' && !switchSettingsTab._advancedLoaded) {
        switchSettingsTab._advancedLoaded = true;
        loadAdvancedPresetEditors();
    }
}
// ============================================================================
// Extension Management Functions
// ============================================================================
async function selectExtensionFolder() {
    const path = await window.electronAPI.invoke('select-extension-folder');
    if (path) {
        await window.electronAPI.invoke('add-user-extension', path);
        await loadUserExtensions();
        showAlert(t('settingsExtAdded'));
    }
}
async function loadUserExtensions() {
    const exts = await window.electronAPI.invoke('get-user-extensions');
    const list = document.getElementById('userExtensionList');
    if (!list) return;

    if (exts.length === 0) {
        list.innerHTML = `<div style="opacity:0.5; text-align:center; padding:20px;">${t('settingsExtNoExt')}</div>`;
        return;
    }

    list.innerHTML = exts.map(ext => {
        const name = ext.split(/[\\/]/).pop();
        return `
            <div class="ext-item">
                <div>
                    <div style="font-weight:bold;">${name}</div>
                    <div style="font-size:11px; opacity:0.6;">${ext}</div>
                </div>
                <button class="danger outline" onclick="removeUserExtension('${ext.replace(/\\/g, '\\\\')}')" style="padding:4px 12px; font-size:11px;">${t('settingsExtRemove')}</button>
            </div>
        `;
    }).join('');
}
async function removeUserExtension(path) {
    await window.electronAPI.invoke('remove-user-extension', path);
    await loadUserExtensions();
    showAlert(t('settingsExtRemoved'));
}
function openHelp() { switchHelpTab('manual'); document.getElementById('helpModal').style.display = 'flex'; } // flex
function closeHelp() { document.getElementById('helpModal').style.display = 'none'; }


// Custom timezone dropdown initialization
function initCustomTimezoneDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    if (!input || !dropdown || !window.TIMEZONES) return;

    let selectedIndex = -1;

    // Populate dropdown with all timezones
    function populateDropdown(filter = '') {
        const filtered = window.TIMEZONES.filter(tz =>
            tz.toLowerCase().includes(filter.toLowerCase())
        ).slice(0, 60);

        dropdown.innerHTML = filtered.map((tz, index) =>
            `<div class="timezone-item" data-value="${tz}" data-index="${index}">${tz}</div>`
        ).join('');

        selectedIndex = -1;
    }



    // Hide dropdown
    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    // Select item
    function selectItem(value) {
        input.value = value;
        hideDropdown();
    }

    // Input focus - show dropdown (Show ALL options, ignore current value filter)
    input.addEventListener('focus', () => {
        populateDropdown('');
        dropdown.classList.add('active');
    });

    // Input typing - filter
    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) {
            dropdown.classList.add('active');
        }
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item:not(.hidden)');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].dataset.value);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    // Update selection highlight
    function updateSelection(items) {
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === selectedIndex);
        });
        if (items[selectedIndex]) {
            items[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    // Click on item
    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) {
            selectItem(item.dataset.value);
        }
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}
init();
