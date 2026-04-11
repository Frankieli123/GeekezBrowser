const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn, spawnSync, exec } = require('child_process');
const getPort = require('get-port');
const puppeteer = require('puppeteer'); // 使用原生 puppeteer，不带 extra
const { v4: uuidv4 } = require('uuid');
const yaml = require('js-yaml');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const https = require('https');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const logger = require('./logger');

const shouldDisableHardwareAcceleration =
    process.env.GEEKEZ_DISABLE_HW_ACCEL === '1' ||
    process.argv.includes('--disable-hardware-acceleration') ||
    process.argv.includes('--disable-gpu');

const shouldDisableSandbox =
    process.env.GEEKEZ_DISABLE_SANDBOX === '1' ||
    process.argv.includes('--no-sandbox');

if (shouldDisableSandbox) {
    app.commandLine.appendSwitch('no-sandbox');
}

if (shouldDisableHardwareAcceleration) {
    app.commandLine.appendSwitch('disable-gpu');
    app.disableHardwareAcceleration();
}

const { generateXrayConfig } = require('./utils');
const { generateFingerprint, getInjectScript } = require('./fingerprint');

const isRootLinux = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
if (isRootLinux) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

const isDev = !app.isPackaged;
const RESOURCES_BIN = isDev ? path.join(__dirname, 'resources', 'bin') : path.join(process.resourcesPath, 'bin');
// Use platform+arch specific directory for xray binary
const PLATFORM_ARCH = `${process.platform}-${process.arch}`; // e.g., darwin-arm64, darwin-x64, win32-x64
const BIN_DIR = path.join(RESOURCES_BIN, PLATFORM_ARCH);
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'xray.exe' : 'xray');
// Fallback to old location for backward compatibility
const BIN_DIR_LEGACY = RESOURCES_BIN;
const BIN_PATH_LEGACY = path.join(BIN_DIR_LEGACY, process.platform === 'win32' ? 'xray.exe' : 'xray');

// 自定义数据目录支持
const APP_CONFIG_FILE = path.join(app.getPath('userData'), 'app-config.json');
const DEFAULT_DATA_PATH = path.join(app.getPath('userData'), 'BrowserProfiles');

// 读取自定义数据目录
function getCustomDataPath() {
    try {
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = fs.readJsonSync(APP_CONFIG_FILE);
            if (config.customDataPath && fs.existsSync(config.customDataPath)) {
                return config.customDataPath;
            }
        }
    } catch (e) {
        console.error('Failed to read custom data path:', e);
    }
    return DEFAULT_DATA_PATH;
}

const DATA_PATH = getCustomDataPath();
const TRASH_PATH = path.join(app.getPath('userData'), '_Trash_Bin');
const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');
const DASHBOARD_TEMPLATE_FILE = path.join(__dirname, 'dashboard-template.html');
const DASHBOARD_CSS_FILE = path.join(__dirname, 'dashboard.css');
const DASHBOARD_JS_FILE = path.join(__dirname, 'dashboard.js');

fs.ensureDirSync(DATA_PATH);
fs.ensureDirSync(TRASH_PATH);

let activeProcesses = {};
let localApiServer = null;
const trustedSshHosts = new Set();
const sshHostKeyPromptWaiters = new Map();
let sshHostKeyPromptSeq = 0;

const LOCAL_API_HOST = '127.0.0.1';
const LOCAL_API_PORT = Number.parseInt(process.env.GEEKEZ_API_PORT || '17555', 10) || 17555;
const ACCEPT_CH_PROBE_HEADERS = [
    'Sec-CH-UA-Full-Version-List',
    'Sec-CH-UA-Arch',
    'Sec-CH-UA-Bitness',
    'Sec-CH-UA-Platform-Version',
    'Sec-CH-UA-Model',
    'Sec-CH-UA-Wow64',
];
let apiServer = null;
let apiServerRunning = false;
let mainWindow = null; // Global reference for API-to-UI communication
let savedProfileProxySourceMaintenanceTimer = null;
let savedProfileProxySourceMaintenanceTickRunning = false;
const savedProfileProxySourceMaintenanceLocks = new Set();
let savedProfileProxySourceOverviewActionLock = false;
const DEFAULT_FINGERPRINT_SCREEN = { width: 1920, height: 1080 };
const DEFAULT_BROWSER_WINDOW = { width: 1280, height: 720 };
const APP_REPO_URL = 'https://github.com/Frankieli123/GeekezBrowser';
const APP_RELEASES_API_URL = 'https://api.github.com/repos/Frankieli123/GeekezBrowser/releases/latest';
const APP_RELEASES_URL = `${APP_REPO_URL}/releases`;

// API Security
const ALLOWED_ORIGINS = ['http://localhost:17555', 'http://127.0.0.1:17555'];

function getOrCreateApiToken() {
    const settings = fs.existsSync(SETTINGS_FILE) ? fs.readJsonSync(SETTINGS_FILE) : {};
    if (!settings.apiToken) {
        settings.apiToken = crypto.randomBytes(32).toString('hex');
        fs.writeJsonSync(SETTINGS_FILE, settings);
    }
    return settings.apiToken;
}

const API_TOKEN = getOrCreateApiToken();

// ============================================================================
// REST API Server
// ============================================================================
function createApiServer(port) {
    const server = http.createServer(async (req, res) => {
        // CORS headers - restricted
        const origin = req.headers.origin;
        if (ALLOWED_ORIGINS.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // Token validation for write operations
        const token = req.headers['x-api-token'];
        if (req.method !== 'GET' && token !== API_TOKEN) {
            res.writeHead(403);
            res.end(JSON.stringify({ success: false, error: 'Invalid API token' }));
            return;
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        // Parse body for POST/PUT with size limit
        let body = '';
        const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
        if (method === 'POST' || method === 'PUT') {
            body = await new Promise((resolve, reject) => {
                let data = '';
                req.on('data', chunk => {
                    data += chunk;
                    if (data.length > MAX_BODY_SIZE) {
                        req.destroy();
                        reject(new Error('Request body too large'));
                    }
                });
                req.on('end', () => resolve(data));
                req.on('error', reject);
            }).catch(err => {
                res.writeHead(413);
                res.end(JSON.stringify({ success: false, error: err.message }));
                return null;
            });
            if (body === null) return;
        }

        try {
            const result = await handleApiRequest(method, pathname, body, url.searchParams);
            res.writeHead(result.status || 200);
            res.end(JSON.stringify(result.data || result));
        } catch (err) {
            logger.error('API Error', { method, pathname, error: err.message, stack: err.stack });
            const status = err.status || (err.message.includes('JSON') ? 400 : 500);
            res.writeHead(status);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    return server;
}

async function handleApiRequest(method, pathname, body, params) {
    let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = await readSettingsAsync();

    // Helper: Find profile by ID or Name
    const findProfile = (idOrName) => {
        return profiles.find(p => p.id === idOrName || p.name === idOrName);
    };

    // Helper: Generate unique name
    const generateUniqueName = (baseName) => {
        if (!profiles.find(p => p.name === baseName)) return baseName;
        let suffix = 2;
        while (profiles.find(p => p.name === `${baseName}-${String(suffix).padStart(2, '0')}`)) {
            suffix++;
        }
        return `${baseName}-${String(suffix).padStart(2, '0')}`;
    };

    // GET /api/status
    if (method === 'GET' && pathname === '/api/status') {
        return { success: true, running: Object.keys(activeProcesses), count: Object.keys(activeProcesses).length };
    }

    if (pathname === '/api/saved-profile-proxies') {
        if (method === 'GET') {
            return {
                success: true,
                savedProfileProxies: attachSavedProfileProxyUsage(settings.savedProfileProxies || [], profiles, settings.savedProfileProxySources || []),
            };
        }
        if (method === 'POST') {
            const data = JSON.parse(body || '{}');
            const result = await createSavedProfileProxyEntry(data);
            return { success: true, savedProfileProxy: result.item, savedProfileProxies: result.list };
        }
        if (method === 'PUT') {
            const data = JSON.parse(body || '{}');
            try {
                const result = await replaceSavedProfileProxiesCollection(
                    Array.isArray(data.savedProfileProxies) ? data.savedProfileProxies : data.proxies,
                    settings
                );
                return {
                    success: true,
                    savedProfileProxies: result.list,
                };
            } catch (e) {
                throw createHttpError(400, e && e.message ? e.message : String(e));
            }
        }
        return { status: 405, data: { success: false, error: 'Method Not Allowed' } };
    }

    const legacySavedProxyTestMatch = pathname.match(/^\/api\/saved-profile-proxies\/([^/]+)\/proxy-test$/);
    if (legacySavedProxyTestMatch) {
        const savedProxyId = decodeURIComponent(legacySavedProxyTestMatch[1]);
        if (method === 'GET') {
            return {
                success: true,
                savedProxyTest: (await readSavedProfileProxyTestResult(savedProxyId)) || normalizeProxyTestResult({
                    success: false,
                    status: 'info',
                    mode: 'unknown',
                    error: 'Not tested yet',
                    summary: 'Not tested yet',
                })
            };
        }
        if (method === 'POST') {
            const result = await testSavedProfileProxyInternal(savedProxyId);
            return { success: true, savedProxyTest: result };
        }
        return { status: 405, data: { success: false, error: 'Method Not Allowed' } };
    }

    const legacySavedProxyMatch = pathname.match(/^\/api\/saved-profile-proxies\/([^/]+)$/);
    if (legacySavedProxyMatch) {
        const savedProxyId = decodeURIComponent(legacySavedProxyMatch[1]);
        if (method === 'GET') {
            const item = attachSavedProfileProxyUsage(settings.savedProfileProxies || [], profiles, settings.savedProfileProxySources || [])
                .find(proxy => proxy.id === normalizeSavedProfileProxyId(savedProxyId)) || null;
            if (!item) return { status: 404, data: { success: false, error: 'Saved proxy not found' } };
            return { success: true, savedProfileProxy: item };
        }
        if (method === 'PATCH') {
            const data = JSON.parse(body || '{}');
            const result = await patchSavedProfileProxyEntry(savedProxyId, data);
            return { success: true, savedProfileProxy: result.item, savedProfileProxies: result.list };
        }
        if (method === 'DELETE') {
            const result = await deleteSavedProfileProxyEntry(savedProxyId);
            return {
                success: true,
                deletedSavedProxyId: result.deletedId,
                affectedProfilesCount: result.affectedProfilesCount,
                savedProfileProxies: result.list,
            };
        }
        return { status: 405, data: { success: false, error: 'Method Not Allowed' } };
    }

    if (method === 'POST' && pathname === '/api/profiles/batch/saved-proxy-binding') {
        const data = JSON.parse(body || '{}');
        const result = await batchUpdateSavedProfileProxyBindings(data);
        return { success: true, data: result };
    }

    if (method === 'POST' && pathname === '/api/profiles/batch/random-saved-proxy-binding') {
        const data = JSON.parse(body || '{}');
        const result = await batchAssignRandomSavedProfileProxyBindings(data);
        return { success: true, data: result };
    }

    // GET /api/profiles
    if (method === 'GET' && pathname === '/api/profiles') {
        return { success: true, profiles: profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags, running: !!activeProcesses[p.id] })) };
    }

    // GET /api/profiles/:idOrName
    const profileMatch = pathname.match(/^\/api\/profiles\/([^\/]+)$/);
    if (method === 'GET' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        return { success: true, profile: { ...profile, running: !!activeProcesses[profile.id] } };
    }

    // POST /api/profiles - Create with unique name
    if (method === 'POST' && pathname === '/api/profiles') {
        const data = JSON.parse(body);
        const id = uuidv4();
        const fingerprint = normalizeFingerprintForStorage(
            data.fingerprint || createManagedFingerprint({}),
            { fitMissingWindowToWorkArea: true }
        );
        if (typeof data.timezone === 'string' && data.timezone.trim()) fingerprint.timezone = data.timezone.trim();
        else if (!fingerprint.timezone) fingerprint.timezone = AUTO_TIMEZONE;
        if (data.city) fingerprint.city = data.city;
        if (data.geolocation) fingerprint.geolocation = data.geolocation;
        if (typeof data.language === 'string' && data.language.trim()) fingerprint.language = data.language.trim();
        else if (!fingerprint.language) fingerprint.language = AUTO_LANGUAGE;
        const baseName = data.name || `Profile-${Date.now()}`;
        const uniqueName = generateUniqueName(baseName);
        const newProfile = {
            id,
            name: uniqueName,
            proxyStr: data.proxyStr || '',
            savedProxyId: normalizeSavedProfileProxyId(data.savedProxyId),
            tags: data.tags || [],
            remark: data.remark || '',
            startupUrls: normalizeStartupUrls(data.startupUrls),
            fingerprint,
            headerPresetId: normalizeHeaderPresetId(data.headerPresetId),
            extensionPaths: normalizeProfileExtensionPaths(data.extensionPaths),
            useGlobalExtensions: normalizeUseGlobalExtensions(data.useGlobalExtensions, true),
            ...normalizeProfilePermissionModes(data),
            preProxyOverride: data.preProxyOverride || 'default',
            debugPort: data.debugPort || undefined,
            createdAt: Date.now()
        };
        profiles.push(newProfile);
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, profile: newProfile };
    }

    // PUT /api/profiles/:idOrName - Edit
    if (method === 'PUT' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const idx = profiles.findIndex(p => p.id === profile.id);
        const data = JSON.parse(body);
        // If name changed, ensure uniqueness
        if (data.name && data.name !== profile.name) {
            data.name = generateUniqueName(data.name);
        }
        const fingerprintPatch = {};
        if (typeof data.timezone === 'string' && data.timezone.trim()) fingerprintPatch.timezone = data.timezone.trim();
        if (typeof data.language === 'string' && data.language.trim()) fingerprintPatch.language = data.language.trim();
        if (Object.prototype.hasOwnProperty.call(data, 'city')) fingerprintPatch.city = data.city;
        if (Object.prototype.hasOwnProperty.call(data, 'geolocation')) fingerprintPatch.geolocation = data.geolocation;
        if (Object.prototype.hasOwnProperty.call(data, 'fingerprint')) {
            data.fingerprint = mergeFingerprint(profile.fingerprint, deepMergeObjects(fingerprintPatch, data.fingerprint), { fitMissingWindowToWorkArea: true });
        } else if (Object.keys(fingerprintPatch).length > 0) {
            data.fingerprint = mergeFingerprint(profile.fingerprint, fingerprintPatch, { fitMissingWindowToWorkArea: true });
        }
        if (Object.prototype.hasOwnProperty.call(data, 'startupUrls')) {
            data.startupUrls = normalizeStartupUrls(data.startupUrls);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'headerPresetId')) {
            data.headerPresetId = normalizeHeaderPresetId(data.headerPresetId);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'savedProxyId')) {
            data.savedProxyId = normalizeSavedProfileProxyId(data.savedProxyId);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'extensionPaths')) {
            data.extensionPaths = normalizeProfileExtensionPaths(data.extensionPaths);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'useGlobalExtensions')) {
            data.useGlobalExtensions = normalizeUseGlobalExtensions(data.useGlobalExtensions, true);
        }
        applyNormalizedProfilePermissionModes(data, data);
        applyNormalizedProfileSavedProxyConfig(data, data);
        profiles[idx] = { ...profiles[idx], ...data };
        await fs.writeJson(PROFILES_FILE, profiles);
        return { success: true, profile: profiles[idx] };
    }

    // DELETE /api/profiles/:idOrName
    if (method === 'DELETE' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        profiles = profiles.filter(p => p.id !== profile.id);
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, message: 'Profile deleted' };
    }

    // GET /api/open/:idOrName - Launch profile
    const openMatch = pathname.match(/^\/api\/open\/([^\/]+)$/);
    if (method === 'GET' && openMatch) {
        const profile = findProfile(decodeURIComponent(openMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        if (activeProcesses[profile.id]) return { success: true, message: 'Already running', profileId: profile.id };
        // Trigger launch via IPC to main window
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('api-launch-profile', profile.id);
        }
        return { success: true, message: 'Launch requested', profileId: profile.id, name: profile.name };
    }

    // POST /api/profiles/:idOrName/stop - Stop profile
    const stopMatch = pathname.match(/^\/api\/profiles\/([^\/]+)\/stop$/);
    if (method === 'POST' && stopMatch) {
        const profile = findProfile(decodeURIComponent(stopMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const proc = activeProcesses[profile.id];
        if (!proc) return { status: 404, data: { success: false, error: 'Profile not running' } };
        await closeProfileInternal(profile.id, mainWindow && mainWindow.webContents ? mainWindow.webContents : null);
        return { success: true, message: 'Profile stopped' };
    }

    // GET /api/export/all?password=xxx - Export full backup
    if (method === 'GET' && pathname === '/api/export/all') {
        const password = params.get('password');
        if (!password) return { status: 400, data: { success: false, error: 'Password required. Use ?password=yourpassword' } };
        ensureProfilesStopped(profiles.map(p => p.id), profiles, '完整备份');
        const bundle = await buildFullBackupBundle(profiles, settings);
        try {
            const zipBuffer = await fs.readFile(bundle.zipPath);
            const encrypted = encryptData(zipBuffer, password);
            return {
                success: true,
                data: encrypted.toString('base64'),
                filename: `GeekEZ_FullBackup_${Date.now()}.geekez`,
                profileCount: profiles.length
            };
        } finally {
            try { await fs.remove(bundle.tempRoot); } catch (e) { }
        }
    }

    // GET /api/export/fingerprint - Export YAML fingerprints
    if (method === 'GET' && pathname === '/api/export/fingerprint') {
        const exportData = profiles.map(p => ({
            id: p.id,
            name: p.name,
            proxyStr: p.proxyStr,
            tags: p.tags,
            fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint
        }));
        const yamlStr = yaml.dump(exportData, { lineWidth: -1, noRefs: true });
        return {
            success: true,
            data: yamlStr,
            filename: `GeekEZ_Profiles_${Date.now()}.yaml`,
            profileCount: profiles.length
        };
    }

    // POST /api/import - Import backup (YAML or encrypted)
    if (method === 'POST' && pathname === '/api/import') {
        try {
            const data = JSON.parse(body);
            const content = data.content;
            const password = data.password;

            if (!content) return { status: 400, data: { success: false, error: 'Content required' } };

            // Try YAML first
            try {
                const yamlData = yaml.load(content);
                if (Array.isArray(yamlData)) {
                    let imported = 0;
                    for (const item of yamlData) {
                        const name = generateUniqueName(item.name || `Imported-${Date.now()}`);
                        const newProfile = {
                            id: uuidv4(),
                            name,
                            proxyStr: item.proxyStr || '',
                            tags: item.tags || [],
                            fingerprint: normalizeFingerprintForStorage(
                                item.fingerprint || createManagedFingerprint({}),
                                { fitMissingWindowToWorkArea: true }
                            ),
                            createdAt: Date.now()
                        };
                        profiles.push(newProfile);
                        imported++;
                    }
                    await fs.writeJson(PROFILES_FILE, profiles);
                    notifyUIRefresh(); // Notify UI to refresh
                    return { success: true, message: `Imported ${imported} profiles from YAML`, count: imported };
                }
            } catch (yamlErr) { }

            // Try encrypted backup
            if (!password) return { status: 400, data: { success: false, error: 'Password required for encrypted backup' } };

            try {
                const encrypted = Buffer.from(content, 'base64');
                const zipBuffer = decryptData(encrypted, password);
                const bundle = await loadFullBackupBundle(zipBuffer);
                try {
                    const idMap = new Map();
                    const remappedProfiles = bundle.metadata.profiles.map(profile => {
                        const nextId = uuidv4();
                        idMap.set(profile.id, nextId);
                        return { ...profile, id: nextId, name: generateUniqueName(profile.name || `Imported-${Date.now()}`) };
                    });
                    await remapPayloadProfileIds(bundle.payloadRoot, idMap);
                    const remappedMetadata = {
                        ...bundle.metadata,
                        profiles: remappedProfiles,
                        cookies: remapImportedCookies(bundle.metadata.cookies || {}, idMap),
                    };
                    const imported = await applyImportedBundle(bundle.payloadRoot, remappedMetadata);
                    notifyUIRefresh();
                    return { success: true, message: `Imported ${imported} profiles from backup`, count: imported };
                } finally {
                    try { await fs.remove(bundle.stageRoot); } catch (e) { }
                }
            } catch (decryptErr) {
                const msg = decryptErr && decryptErr.message ? decryptErr.message : String(decryptErr);
                const friendly = (msg.includes('Unsupported state') || msg.includes('bad decrypt'))
                    ? 'Invalid password or corrupted backup'
                    : msg;
                return { status: 400, data: { success: false, error: friendly } };
            }
        } catch (err) {
            return { status: 400, data: { success: false, error: err.message } };
        }
    }

    return { status: 404, data: { success: false, error: 'Endpoint not found' } };
}

// API Server IPC handlers
ipcMain.handle('start-api-server', async (e, { port }) => {
    if (apiServerRunning) {
        return { success: false, error: 'API server already running' };
    }
    try {
        apiServer = createApiServer(port);
        await new Promise((resolve, reject) => {
            apiServer.listen(port, '127.0.0.1', () => resolve());
            apiServer.on('error', reject);
        });
        apiServerRunning = true;
        console.log(`🔌 API Server started on http://localhost:${port}`);
        console.log(`🔑 API Token: ${API_TOKEN}`);
        return { success: true, port, token: API_TOKEN };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('stop-api-server', async () => {
    if (!apiServer) return { success: true };
    return new Promise(resolve => {
        apiServer.close(() => {
            apiServer = null;
            apiServerRunning = false;
            console.log('🔌 API Server stopped');
            resolve({ success: true });
        });
    });
});

ipcMain.handle('get-api-status', () => {
    return { running: apiServerRunning };
});

ipcMain.handle('get-api-token', () => {
    return { success: true, token: API_TOKEN };
});

ipcMain.handle('regenerate-api-token', () => {
    const settings = fs.existsSync(SETTINGS_FILE) ? fs.readJsonSync(SETTINGS_FILE) : {};
    const newToken = crypto.randomBytes(32).toString('hex');
    settings.apiToken = newToken;
    fs.writeJsonSync(SETTINGS_FILE, settings);
    return { success: true, token: newToken };
});


function forceKill(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        try {
            if (process.platform === 'win32') exec(`taskkill /pid ${pid} /T /F`, () => resolve());
            else { process.kill(pid, 'SIGKILL'); resolve(); }
        } catch (e) { resolve(); }
    });
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function ensureExecutable(filePath) {
    const target = String(filePath || '').trim();
    if (!target || process.platform === 'win32' || !fs.existsSync(target)) return target;
    try {
        if ((fs.statSync(target).mode & 0o111) === 0) fs.chmodSync(target, 0o755);
    } catch (e) { }
    return target;
}

function getAvailableXrayBinaryPath() {
    if (fs.existsSync(BIN_PATH)) return ensureExecutable(BIN_PATH);
    if (fs.existsSync(BIN_PATH_LEGACY)) return ensureExecutable(BIN_PATH_LEGACY);
    return '';
}

async function waitForTcpPort(host, port, timeoutMs = 6000, shouldAbort = null) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { if (typeof shouldAbort === 'function' && shouldAbort()) return false; } catch (e) { }
        const ok = await new Promise((resolve) => {
            const sock = net.connect({ host, port }, () => { try { sock.destroy(); } catch (e) { } resolve(true); });
            sock.on('error', () => resolve(false));
        });
        if (ok) return true;
        await _sleep(200);
    }
    return false;
}

async function waitForTcpPortClosed(host, port, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const open = await new Promise((resolve) => {
            const sock = net.connect({ host, port }, () => { try { sock.destroy(); } catch (e) { } resolve(true); });
            sock.on('error', () => resolve(false));
        });
        if (!open) return true;
        await _sleep(120);
    }
    return false;
}

function detectProxyType(proxyStr) {
    const raw = String(proxyStr || '').trim();
    if (!raw) return 'DIRECT';
    const m = raw.match(/^([a-z0-9+.-]+):\/\//i);
    if (m && m[1]) return String(m[1]).toUpperCase();
    if (raw.includes(':') && !raw.includes('://')) return 'SOCKS';
    return 'UNKNOWN';
}

const AUTO_TIMEZONE = 'Auto';
const AUTO_LANGUAGE = 'auto';
const PERMISSION_MODE_AUTO = 'auto';
const GEO_PERMISSION_AUTO = PERMISSION_MODE_AUTO;
const PERMISSION_MODE_STATES = new Set([PERMISSION_MODE_AUTO, 'granted', 'prompt', 'denied']);
const GEO_PERMISSION_STATES = PERMISSION_MODE_STATES;
const PERMISSION_PROFILE_FIELDS = {
    geolocation: 'geoPermissionMode',
    camera: 'cameraPermissionMode',
    microphone: 'microphonePermissionMode',
    notifications: 'notificationPermissionMode',
};
const SUPPORTED_PERMISSION_KEYS = Object.keys(PERMISSION_PROFILE_FIELDS);
const FORBIDDEN_HEADER_RULE_NAMES = new Set(['host', 'content-length', 'connection']);
const ALLOWED_HEADER_RULE_ACTIONS = new Set(['set', 'remove']);
const ALLOWED_HEADER_RULE_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket', 'manifest', 'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'other']);
// Fingerprint protection defaults:
// Prefer stability & fewer detectable JS hooks by default; users can opt in per profile.
const DEFAULT_FINGERPRINT_PROTECTION = Object.freeze({
    canvasNoise: 'off',
    webglNoise: 'off',
    clientRects: 'off',
    audioNoise: 'off',
    speechVoices: 'off',
    mediaDevices: 'off',
    portScanProtection: 'off',
    webrtcMode: 'privacy',
});
const FINGERPRINT_PROTECTION_TOGGLES = Object.freeze([
    'canvasNoise',
    'webglNoise',
    'clientRects',
    'audioNoise',
    'speechVoices',
    'mediaDevices',
    'portScanProtection',
]);
const FINGERPRINT_WEBRTC_MODES = new Set(['real', 'privacy', 'disabled']);
const DEFAULT_HEADER_PRESETS = [
    {
        id: 'builtin-locale-consistency',
        name: 'Locale Consistency',
        enabled: true,
        rules: [
            {
                id: 'builtin-locale-accept-language',
                enabled: true,
                match: { hosts: [], resourceTypes: [] },
                action: 'set',
                header: 'Accept-Language',
                valueTemplate: '{{resolvedAcceptLanguage}}',
            }
        ]
    },
    {
        id: 'builtin-minimal-clean-headers',
        name: 'Minimal Clean Headers',
        enabled: true,
        rules: [
            { id: 'builtin-clean-xff', enabled: true, match: { hosts: [], resourceTypes: [] }, action: 'remove', header: 'X-Forwarded-For', valueTemplate: '' },
            { id: 'builtin-clean-forwarded', enabled: true, match: { hosts: [], resourceTypes: [] }, action: 'remove', header: 'Forwarded', valueTemplate: '' },
            { id: 'builtin-clean-via', enabled: true, match: { hosts: [], resourceTypes: [] }, action: 'remove', header: 'Via', valueTemplate: '' },
            { id: 'builtin-clean-cf', enabled: true, match: { hosts: [], resourceTypes: [] }, action: 'remove', header: 'CF-Connecting-IP', valueTemplate: '' },
            { id: 'builtin-clean-true-client-ip', enabled: true, match: { hosts: [], resourceTypes: [] }, action: 'remove', header: 'True-Client-IP', valueTemplate: '' },
        ]
    }
];
const DEFAULT_DIAGNOSTIC_PRESETS = [
    { id: 'builtin-browserleaks', name: 'BrowserLeaks', url: 'https://browserleaks.com/javascript', enabled: true },
    { id: 'builtin-pixelscan', name: 'Pixelscan', url: 'https://pixelscan.net/', enabled: true },
    { id: 'builtin-iphey', name: 'IPhey', url: 'https://iphey.com/', enabled: true },
    { id: 'builtin-whoer', name: 'Whoer', url: 'https://whoer.net/', enabled: true },
];
const SAVED_PROFILE_PROXY_QUARANTINE_FAILURE_STREAK = 3;
const DEFAULT_APP_SETTINGS = {
    preProxies: [],
    subscriptions: [],
    savedProfileProxies: [],
    savedProfileProxySources: [],
    uiLanguage: 'cn',
    mode: 'single',
    enablePreProxy: false,
    notify: false,
    userExtensions: [],
    enableRemoteDebugging: false,
    dashboardOnLaunch: false,
    apiQuietLaunch: false,
    backgroundMode: 'chromium',
    enableCustomArgs: false,
    enableApiServer: false,
    apiPort: 12138,
    headerPresets: DEFAULT_HEADER_PRESETS,
    diagnosticPresets: DEFAULT_DIAGNOSTIC_PRESETS,
    savedProfileProxySourceBatchHistory: [],
};
const GEEKEZ_PAGE_RUNTIME_PATCH = Symbol('geekezPageRuntimePatch');
const GEEKEZ_PAGE_RUNTIME_PATCH_HANDLER = Symbol('geekezPageRuntimePatchHandler');
const GEEKEZ_BROWSER_RUNTIME_LISTENER = Symbol('geekezBrowserRuntimeListener');
const GEEKEZ_BROWSER_HEADER_RULES_LISTENER = Symbol('geekezBrowserHeaderRulesListener');
const GEEKEZ_BROWSER_HEADER_RULES_DESTROY_LISTENER = Symbol('geekezBrowserHeaderRulesDestroyListener');
const GEEKEZ_TARGET_HEADER_RULES_SESSION = Symbol('geekezTargetHeaderRulesSession');
let currentUiLanguage = DEFAULT_APP_SETTINGS.uiLanguage;

function normalizeProtectionToggle(value, fallback = 'off') {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'on' || v === 'off') return v;
    return fallback;
}

function normalizeWebrtcMode(value, fallback = DEFAULT_FINGERPRINT_PROTECTION.webrtcMode) {
    const v = String(value || '').trim().toLowerCase();
    return FINGERPRINT_WEBRTC_MODES.has(v) ? v : fallback;
}

function ensureFingerprintProtectionDefaults(fingerprint) {
    if (!isPlainObject(fingerprint)) return false;
    const current = isPlainObject(fingerprint.protection) ? fingerprint.protection : {};
    const next = { ...current };
    let changed = !isPlainObject(fingerprint.protection);

    for (const key of FINGERPRINT_PROTECTION_TOGGLES) {
        const fallback = DEFAULT_FINGERPRINT_PROTECTION[key] || 'off';
        const normalized = Object.prototype.hasOwnProperty.call(current, key)
            ? normalizeProtectionToggle(current[key], fallback)
            : fallback;
        if (next[key] !== normalized) { next[key] = normalized; changed = true; }
    }

    const currentWebrtc = Object.prototype.hasOwnProperty.call(current, 'webrtcMode') ? current.webrtcMode : undefined;
    const normalizedWebrtc = normalizeWebrtcMode(currentWebrtc, DEFAULT_FINGERPRINT_PROTECTION.webrtcMode);
    if (next.webrtcMode !== normalizedWebrtc) { next.webrtcMode = normalizedWebrtc; changed = true; }

    if (changed) fingerprint.protection = next;
    return changed;
}

function buildCorruptedJsonBackupPath(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${filePath}.corrupt-${stamp}.bak`;
}

function extractLeadingJsonValueSlice(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const first = text[0];
    if (first !== '[' && first !== '{') return '';
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }
            if (char === '\\') {
                escaping = true;
                continue;
            }
            if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') {
            depth--;
            if (depth === 0) return text.slice(0, index + 1);
        }
    }
    return '';
}

async function backupCorruptedJsonFile(filePath, raw) {
    try {
        const backupPath = buildCorruptedJsonBackupPath(filePath);
        await fs.writeFile(backupPath, String(raw || ''), 'utf8');
        return backupPath;
    } catch (e) {
        console.error(`Failed to backup corrupted JSON file ${filePath}:`, e);
        return '';
    }
}

async function readRecoverableJsonFile(filePath, fallbackValue, options = {}) {
    const normalize = typeof options.normalize === 'function' ? options.normalize : (value) => value;
    const label = String(options.label || path.basename(filePath)).trim() || path.basename(filePath);
    const fallback = () => normalize(typeof fallbackValue === 'function' ? fallbackValue() : cloneJsonCompatible(fallbackValue));
    if (!fs.existsSync(filePath)) return fallback();

    let raw = '';
    try {
        raw = await fs.readFile(filePath, 'utf8');
        return normalize(JSON.parse(raw));
    } catch (error) {
        const extracted = extractLeadingJsonValueSlice(raw);
        if (extracted) {
            try {
                const recovered = normalize(JSON.parse(extracted));
                const backupPath = await backupCorruptedJsonFile(filePath, raw);
                await fs.writeJson(filePath, recovered, { spaces: 2 });
                console.warn(`[GeekEZ Recovery] Repaired ${label}${backupPath ? ` (backup: ${backupPath})` : ''}`);
                return recovered;
            } catch (repairError) {
                console.error(`[GeekEZ Recovery] Failed to repair ${label}:`, repairError);
            }
        }
        const backupPath = await backupCorruptedJsonFile(filePath, raw);
        const nextFallback = fallback();
        await fs.writeJson(filePath, nextFallback, { spaces: 2 });
        console.error(`[GeekEZ Recovery] Reset invalid ${label}${backupPath ? ` (backup: ${backupPath})` : ''}:`, error);
        return nextFallback;
    }
}

function cloneJsonCompatible(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeStringArray(value, { lower = false } = {}) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of list) {
        const text = String(item || '').trim();
        if (!text) continue;
        const normalized = lower ? text.toLowerCase() : text;
        if (!out.includes(normalized)) out.push(normalized);
    }
    return out;
}

function normalizeProfileExtensionPaths(value) {
    return normalizeStringArray(value);
}

function normalizeUseGlobalExtensions(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeSavedProfileProxyId(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxyTags(value) {
    if (Array.isArray(value)) return normalizeStringArray(value);
    if (typeof value === 'string') return normalizeStringArray(String(value).split(/[\n,，]+/));
    return [];
}

function normalizeSavedProfileProxyGroup(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxyNotes(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxyChangeIpUrl(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxySourceId(value) {
    return String(value || '').trim();
}

function normalizeSavedProfileProxySourceFormat(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['auto', 'lines', 'csv', 'json'].includes(current) ? current : 'auto';
}

const SAVED_PROFILE_PROXY_SOURCE_STALE_POLICIES = new Set(['mark', 'disable', 'detach']);
const SAVED_PROFILE_PROXY_SOURCE_HISTORY_LIMIT = 10;
const SAVED_PROFILE_PROXY_SOURCE_MAINTENANCE_HISTORY_LIMIT = 10;
const SAVED_PROFILE_PROXY_SOURCE_BATCH_HISTORY_LIMIT = 10;
const SAVED_PROFILE_PROXY_SOURCE_SCHEDULE_MINUTES_MIN = 5;
const SAVED_PROFILE_PROXY_SOURCE_SCHEDULE_MINUTES_MAX = 10080;
const SAVED_PROFILE_PROXY_SOURCE_SCHEDULER_POLL_MS = 60 * 1000;

function normalizeSavedProfileProxySourceStalePolicy(value) {
    const current = String(value || '').trim().toLowerCase();
    return SAVED_PROFILE_PROXY_SOURCE_STALE_POLICIES.has(current) ? current : 'disable';
}

function normalizeSavedProfileProxySourceScheduleIntervalMinutes(value) {
    const current = Number(value);
    if (!Number.isFinite(current) || current <= 0) return 0;
    const rounded = Math.round(current);
    return Math.min(
        SAVED_PROFILE_PROXY_SOURCE_SCHEDULE_MINUTES_MAX,
        Math.max(SAVED_PROFILE_PROXY_SOURCE_SCHEDULE_MINUTES_MIN, rounded)
    );
}

function normalizeSavedProfileProxySourceMaintenanceStatus(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['idle', 'ok', 'error'].includes(current) ? current : 'idle';
}

function normalizeSavedProfileProxySourceMaintenanceTrigger(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['manual', 'scheduler'].includes(current) ? current : '';
}

function normalizeSavedProfileProxySourceMaintenanceEntry(entry) {
    const current = isPlainObject(entry) ? entry : {};
    const ranAt = Number(current.ranAt);
    const quarantinedCount = Number(current.quarantinedCount);
    const recoveredCount = Number(current.recoveredCount);
    const candidateCountAfter = Number(current.candidateCountAfter);
    const quarantinedCountAfter = Number(current.quarantinedCountAfter);
    return {
        ranAt: Number.isFinite(ranAt) && ranAt > 0 ? Math.round(ranAt) : 0,
        status: normalizeSavedProfileProxySourceMaintenanceStatus(current.status),
        trigger: normalizeSavedProfileProxySourceMaintenanceTrigger(current.trigger),
        quarantinedCount: Number.isFinite(quarantinedCount) && quarantinedCount >= 0 ? Math.round(quarantinedCount) : 0,
        recoveredCount: Number.isFinite(recoveredCount) && recoveredCount >= 0 ? Math.round(recoveredCount) : 0,
        candidateCountAfter: Number.isFinite(candidateCountAfter) && candidateCountAfter >= 0 ? Math.round(candidateCountAfter) : 0,
        quarantinedCountAfter: Number.isFinite(quarantinedCountAfter) && quarantinedCountAfter >= 0 ? Math.round(quarantinedCountAfter) : 0,
        error: String(current.error || '').trim(),
    };
}

function normalizeSavedProfileProxySourceMaintenanceHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceMaintenanceEntry(item))
        .filter((item) => item.ranAt > 0)
        .sort((a, b) => b.ranAt - a.ranAt)
        .slice(0, SAVED_PROFILE_PROXY_SOURCE_MAINTENANCE_HISTORY_LIMIT);
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
    const current = isPlainObject(entry) ? entry : {};
    const finishedAt = Number(current.finishedAt);
    const total = Number(current.total);
    const ok = Number(current.ok);
    const failed = Number(current.failed);
    const added = Number(current.added);
    const quarantined = Number(current.quarantined);
    const recovered = Number(current.recovered);
    const dueCount = Number(current.dueCount);
    const overdueCount = Number(current.overdueCount);
    const errorCount = Number(current.errorCount);
    const candidateCount = Number(current.candidateCount);
    const sourceCount = Number(current.sourceCount);
    const affectedProfilesCount = Number(current.affectedProfilesCount);
    return {
        action: normalizeSavedProfileProxySourceBatchAction(current.action),
        finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? Math.round(finishedAt) : 0,
        total: Number.isFinite(total) && total >= 0 ? Math.round(total) : 0,
        ok: Number.isFinite(ok) && ok >= 0 ? Math.round(ok) : 0,
        failed: Number.isFinite(failed) && failed >= 0 ? Math.round(failed) : 0,
        added: Number.isFinite(added) && added >= 0 ? Math.round(added) : 0,
        quarantined: Number.isFinite(quarantined) && quarantined >= 0 ? Math.round(quarantined) : 0,
        recovered: Number.isFinite(recovered) && recovered >= 0 ? Math.round(recovered) : 0,
        dueCount: Number.isFinite(dueCount) && dueCount >= 0 ? Math.round(dueCount) : 0,
        overdueCount: Number.isFinite(overdueCount) && overdueCount >= 0 ? Math.round(overdueCount) : 0,
        errorCount: Number.isFinite(errorCount) && errorCount >= 0 ? Math.round(errorCount) : 0,
        candidateCount: Number.isFinite(candidateCount) && candidateCount >= 0 ? Math.round(candidateCount) : 0,
        sourceCount: Number.isFinite(sourceCount) && sourceCount >= 0 ? Math.round(sourceCount) : 0,
        affectedProfilesCount: Number.isFinite(affectedProfilesCount) && affectedProfilesCount >= 0 ? Math.round(affectedProfilesCount) : 0,
        sourceIds: normalizeStringArray(current.sourceIds).slice(0, 50),
    };
}

function normalizeSavedProfileProxySourceBatchHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceBatchHistoryEntry(item))
        .filter((item) => item.finishedAt > 0 && item.total > 0)
        .sort((a, b) => b.finishedAt - a.finishedAt)
        .slice(0, SAVED_PROFILE_PROXY_SOURCE_BATCH_HISTORY_LIMIT);
}

async function appendSavedProfileProxySourceBatchHistoryEntry(entry, settings = null) {
    const currentSettings = settings || await readSettingsAsync();
    const nextSettings = {
        ...currentSettings,
        savedProfileProxySourceBatchHistory: normalizeSavedProfileProxySourceBatchHistory([
            entry,
            ...((currentSettings && currentSettings.savedProfileProxySourceBatchHistory) || []),
        ]),
    };
    const saved = await writeSettingsWithSavedProfileProxyLifecycle(nextSettings, currentSettings);
    return saved.settings.savedProfileProxySourceBatchHistory || [];
}

function normalizeSavedProfileProxySourceSyncStatus(value) {
    return String(value || '').trim().toLowerCase() === 'error' ? 'error' : 'ok';
}

function normalizeSavedProfileProxySourceHistoryEntry(entry) {
    const current = isPlainObject(entry) ? entry : {};
    const syncedAt = Number(current.syncedAt);
    const totalLines = Number(current.totalLines);
    const addedCount = Number(current.addedCount);
    const duplicateCount = Number(current.duplicateCount);
    const linkedCount = Number(current.linkedCount);
    const staleCount = Number(current.staleCount);
    const reactivatedCount = Number(current.reactivatedCount);
    const invalidCount = Number(current.invalidCount);
    const policyAffectedCount = Number(current.policyAffectedCount);
    return {
        syncedAt: Number.isFinite(syncedAt) && syncedAt > 0 ? Math.round(syncedAt) : 0,
        status: normalizeSavedProfileProxySourceSyncStatus(current.status),
        format: normalizeSavedProfileProxySourceFormat(current.format),
        totalLines: Number.isFinite(totalLines) && totalLines >= 0 ? Math.round(totalLines) : 0,
        addedCount: Number.isFinite(addedCount) && addedCount >= 0 ? Math.round(addedCount) : 0,
        duplicateCount: Number.isFinite(duplicateCount) && duplicateCount >= 0 ? Math.round(duplicateCount) : 0,
        linkedCount: Number.isFinite(linkedCount) && linkedCount >= 0 ? Math.round(linkedCount) : 0,
        staleCount: Number.isFinite(staleCount) && staleCount >= 0 ? Math.round(staleCount) : 0,
        reactivatedCount: Number.isFinite(reactivatedCount) && reactivatedCount >= 0 ? Math.round(reactivatedCount) : 0,
        invalidCount: Number.isFinite(invalidCount) && invalidCount >= 0 ? Math.round(invalidCount) : 0,
        policyMode: normalizeSavedProfileProxySourceStalePolicy(current.policyMode),
        policyAffectedCount: Number.isFinite(policyAffectedCount) && policyAffectedCount >= 0 ? Math.round(policyAffectedCount) : 0,
        error: String(current.error || '').trim(),
    };
}

function normalizeSavedProfileProxySourceHistory(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => normalizeSavedProfileProxySourceHistoryEntry(item))
        .filter((item) => item.syncedAt > 0)
        .sort((a, b) => b.syncedAt - a.syncedAt)
        .slice(0, SAVED_PROFILE_PROXY_SOURCE_HISTORY_LIMIT);
}

function applySavedProfileProxySourceSyncSummary(target, entry) {
    const normalized = normalizeSavedProfileProxySourceHistoryEntry(entry);
    if (!target) return normalized;
    target.lastSyncAt = normalized.syncedAt;
    target.lastSyncStatus = normalized.status;
    target.lastSyncFormat = normalized.format;
    target.lastSyncTotalLines = normalized.totalLines;
    target.lastSyncAddedCount = normalized.addedCount;
    target.lastSyncDuplicateCount = normalized.duplicateCount;
    target.lastSyncLinkedCount = normalized.linkedCount;
    target.lastSyncStaleCount = normalized.staleCount;
    target.lastSyncReactivatedCount = normalized.reactivatedCount;
    target.lastSyncInvalidCount = normalized.invalidCount;
    target.lastSyncPolicyMode = normalized.policyMode;
    target.lastSyncPolicyAffectedCount = normalized.policyAffectedCount;
    target.lastSyncError = normalized.error;
    return normalized;
}

function pushSavedProfileProxySourceHistoryEntry(target, entry) {
    if (!target) return [];
    const normalized = applySavedProfileProxySourceSyncSummary(target, entry);
    const history = normalizeSavedProfileProxySourceHistory([
        normalized,
        ...(Array.isArray(target.syncHistory) ? target.syncHistory : []),
    ]);
    target.syncHistory = history;
    return history;
}

function applySavedProfileProxySourceMaintenanceSummary(target, entry) {
    const normalized = normalizeSavedProfileProxySourceMaintenanceEntry(entry);
    if (!target) return normalized;
    target.lastMaintenanceAt = normalized.ranAt;
    target.lastMaintenanceStatus = normalized.status;
    target.lastMaintenanceTrigger = normalized.trigger;
    target.lastMaintenanceError = normalized.error;
    target.lastMaintenanceQuarantinedCount = normalized.quarantinedCount;
    target.lastMaintenanceRecoveredCount = normalized.recoveredCount;
    return normalized;
}

function pushSavedProfileProxySourceMaintenanceEntry(target, entry) {
    if (!target) return [];
    const normalized = applySavedProfileProxySourceMaintenanceSummary(target, entry);
    const history = normalizeSavedProfileProxySourceMaintenanceHistory([
        normalized,
        ...(Array.isArray(target.maintenanceHistory) ? target.maintenanceHistory : []),
    ]);
    target.maintenanceHistory = history;
    return history;
}

function normalizeSavedProfileProxySource(item, index = 0) {
    const source = isPlainObject(item) ? item : {};
    const fallbackId = `saved-proxy-source-${index + 1}`;
    const fallbackName = `Saved Proxy Source ${index + 1}`;
    const lastImportedAt = Number(source.lastImportedAt);
    const lastImportCount = Number(source.lastImportCount);
    const lastSyncAt = Number(
        Object.prototype.hasOwnProperty.call(source, 'lastSyncAt')
            ? source.lastSyncAt
            : lastImportedAt
    );
    const lastSyncTotalLines = Number(source.lastSyncTotalLines);
    const lastSyncAddedCount = Number(
        Object.prototype.hasOwnProperty.call(source, 'lastSyncAddedCount')
            ? source.lastSyncAddedCount
            : lastImportCount
    );
    const lastSyncDuplicateCount = Number(source.lastSyncDuplicateCount);
    const lastSyncLinkedCount = Number(source.lastSyncLinkedCount);
    const lastSyncStaleCount = Number(source.lastSyncStaleCount);
    const lastSyncReactivatedCount = Number(source.lastSyncReactivatedCount);
    const lastSyncInvalidCount = Number(source.lastSyncInvalidCount);
    const lastSyncPolicyAffectedCount = Number(source.lastSyncPolicyAffectedCount);
    const lastMaintenanceAt = Number(source.lastMaintenanceAt);
    const lastMaintenanceQuarantinedCount = Number(source.lastMaintenanceQuarantinedCount);
    const lastMaintenanceRecoveredCount = Number(source.lastMaintenanceRecoveredCount);
    const syncHistory = normalizeSavedProfileProxySourceHistory(source.syncHistory);
    const maintenanceHistory = normalizeSavedProfileProxySourceMaintenanceHistory(source.maintenanceHistory);
    return {
        id: normalizeSavedProfileProxySourceId(source.id || fallbackId) || fallbackId,
        name: String(source.name || fallbackName).trim() || fallbackName,
        url: isValidHttpUrl(source.url) ? String(source.url).trim() : '',
        enabled: normalizeBoolean(source.enabled, true),
        format: normalizeSavedProfileProxySourceFormat(source.format),
        stalePolicy: normalizeSavedProfileProxySourceStalePolicy(source.stalePolicy),
        prefix: String(source.prefix || '').trim(),
        startIndex: parsePositiveInt(source.startIndex, 1),
        group: normalizeSavedProfileProxyGroup(
            Object.prototype.hasOwnProperty.call(source, 'group')
                ? source.group
                : source.groupName
        ),
        tags: normalizeSavedProfileProxyTags(source.tags),
        autoCheck: normalizeBoolean(source.autoCheck, false),
        scheduleEnabled: normalizeBoolean(source.scheduleEnabled, false),
        scheduleIntervalMinutes: normalizeSavedProfileProxySourceScheduleIntervalMinutes(source.scheduleIntervalMinutes),
        autoQuarantineOnRefresh: normalizeBoolean(source.autoQuarantineOnRefresh, false),
        autoRecheckQuarantinedOnRefresh: normalizeBoolean(source.autoRecheckQuarantinedOnRefresh, false),
        lastImportedAt: Number.isFinite(lastImportedAt) && lastImportedAt > 0 ? Math.round(lastImportedAt) : 0,
        lastImportCount: Number.isFinite(lastImportCount) && lastImportCount >= 0 ? Math.round(lastImportCount) : 0,
        lastImportError: String(source.lastImportError || '').trim(),
        lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? Math.round(lastSyncAt) : 0,
        lastSyncStatus: normalizeSavedProfileProxySourceSyncStatus(source.lastSyncStatus),
        lastSyncFormat: normalizeSavedProfileProxySourceFormat(source.lastSyncFormat || source.format),
        lastSyncTotalLines: Number.isFinite(lastSyncTotalLines) && lastSyncTotalLines >= 0 ? Math.round(lastSyncTotalLines) : 0,
        lastSyncAddedCount: Number.isFinite(lastSyncAddedCount) && lastSyncAddedCount >= 0 ? Math.round(lastSyncAddedCount) : 0,
        lastSyncDuplicateCount: Number.isFinite(lastSyncDuplicateCount) && lastSyncDuplicateCount >= 0 ? Math.round(lastSyncDuplicateCount) : 0,
        lastSyncLinkedCount: Number.isFinite(lastSyncLinkedCount) && lastSyncLinkedCount >= 0 ? Math.round(lastSyncLinkedCount) : 0,
        lastSyncStaleCount: Number.isFinite(lastSyncStaleCount) && lastSyncStaleCount >= 0 ? Math.round(lastSyncStaleCount) : 0,
        lastSyncReactivatedCount: Number.isFinite(lastSyncReactivatedCount) && lastSyncReactivatedCount >= 0 ? Math.round(lastSyncReactivatedCount) : 0,
        lastSyncInvalidCount: Number.isFinite(lastSyncInvalidCount) && lastSyncInvalidCount >= 0 ? Math.round(lastSyncInvalidCount) : 0,
        lastSyncPolicyMode: normalizeSavedProfileProxySourceStalePolicy(source.lastSyncPolicyMode || source.stalePolicy),
        lastSyncPolicyAffectedCount: Number.isFinite(lastSyncPolicyAffectedCount) && lastSyncPolicyAffectedCount >= 0 ? Math.round(lastSyncPolicyAffectedCount) : 0,
        lastSyncError: String(source.lastSyncError || '').trim(),
        lastMaintenanceAt: Number.isFinite(lastMaintenanceAt) && lastMaintenanceAt > 0 ? Math.round(lastMaintenanceAt) : 0,
        lastMaintenanceStatus: normalizeSavedProfileProxySourceMaintenanceStatus(source.lastMaintenanceStatus),
        lastMaintenanceTrigger: normalizeSavedProfileProxySourceMaintenanceTrigger(source.lastMaintenanceTrigger),
        lastMaintenanceError: String(source.lastMaintenanceError || '').trim(),
        lastMaintenanceQuarantinedCount: Number.isFinite(lastMaintenanceQuarantinedCount) && lastMaintenanceQuarantinedCount >= 0 ? Math.round(lastMaintenanceQuarantinedCount) : 0,
        lastMaintenanceRecoveredCount: Number.isFinite(lastMaintenanceRecoveredCount) && lastMaintenanceRecoveredCount >= 0 ? Math.round(lastMaintenanceRecoveredCount) : 0,
        syncHistory,
        maintenanceHistory,
    };
}

function createHttpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function buildSavedProfileProxyDefaultName(proxyStr, index = 0) {
    const type = detectProxyType(proxyStr);
    const suffix = index + 1;
    return type ? `${type.toUpperCase()} Proxy ${suffix}` : `Saved Proxy ${suffix}`;
}

function normalizeSavedProfileProxy(item, index = 0) {
    const source = isPlainObject(item) ? item : {};
    const proxyStr = String(source.proxyStr || source.url || '').trim();
    const fallbackName = buildSavedProfileProxyDefaultName(proxyStr, index);
    const id = normalizeSavedProfileProxyId(source.id || `saved-proxy-${index + 1}`) || `saved-proxy-${index + 1}`;
    const group = normalizeSavedProfileProxyGroup(
        Object.prototype.hasOwnProperty.call(source, 'group')
            ? source.group
            : source.groupName
    );
    const notes = normalizeSavedProfileProxyNotes(
        Object.prototype.hasOwnProperty.call(source, 'notes')
            ? source.notes
            : source.remark
    );
    const changeIpUrl = normalizeSavedProfileProxyChangeIpUrl(
        Object.prototype.hasOwnProperty.call(source, 'changeIpUrl')
            ? source.changeIpUrl
            : (source.ipChangeUrl || source.rotateUrl || source.changeIpLink || source.changeIpApi || '')
    );
    const sourceId = normalizeSavedProfileProxySourceId(
        Object.prototype.hasOwnProperty.call(source, 'sourceId')
            ? source.sourceId
            : (source.savedProxySourceId || (isPlainObject(source.source) ? source.source.id : ''))
    );
    const sourceName = String(
        Object.prototype.hasOwnProperty.call(source, 'sourceName')
            ? source.sourceName
            : (source.savedProxySourceName || (isPlainObject(source.source) ? source.source.name : ''))
    ).trim();
    const sourceImportedAtRaw = Number(
        Object.prototype.hasOwnProperty.call(source, 'sourceImportedAt')
            ? source.sourceImportedAt
            : source.savedProxySourceImportedAt
    );
    const sourceMissingSinceRaw = Number(
        Object.prototype.hasOwnProperty.call(source, 'sourceMissingSince')
            ? source.sourceMissingSince
            : source.savedProxySourceMissingSince
    );
    return {
        id,
        name: String(source.name || fallbackName).trim() || fallbackName,
        proxyStr,
        tags: normalizeSavedProfileProxyTags(source.tags),
        group,
        notes,
        changeIpUrl,
        sourceId,
        sourceName,
        sourceImportedAt: Number.isFinite(sourceImportedAtRaw) && sourceImportedAtRaw > 0 ? Math.round(sourceImportedAtRaw) : 0,
        sourceStale: normalizeBoolean(source.sourceStale, false),
        sourceMissingSince: Number.isFinite(sourceMissingSinceRaw) && sourceMissingSinceRaw > 0 ? Math.round(sourceMissingSinceRaw) : 0,
        enabled: normalizeBoolean(source.enabled, true),
    };
}

function applyNormalizedProfileExtensionConfig(target, source) {
    if (!target || !source) return target;
    if (Object.prototype.hasOwnProperty.call(source, 'extensionPaths')) {
        target.extensionPaths = normalizeProfileExtensionPaths(source.extensionPaths);
    } else if (!Array.isArray(target.extensionPaths)) {
        target.extensionPaths = [];
    }
    if (Object.prototype.hasOwnProperty.call(source, 'useGlobalExtensions')) {
        target.useGlobalExtensions = normalizeUseGlobalExtensions(source.useGlobalExtensions, true);
    } else if (typeof target.useGlobalExtensions !== 'boolean') {
        target.useGlobalExtensions = true;
    }
    return target;
}

function resolveLaunchExtensionPaths(profile, settings) {
    const globalExtensions = normalizeStringArray(settings && settings.userExtensions);
    const profileExtensions = normalizeProfileExtensionPaths(profile && profile.extensionPaths);
    const useGlobalExtensions = normalizeUseGlobalExtensions(profile && profile.useGlobalExtensions, true);
    const merged = [];
    for (const extPath of [...(useGlobalExtensions ? globalExtensions : []), ...profileExtensions]) {
        if (!extPath || merged.includes(extPath)) continue;
        if (!fs.existsSync(extPath)) continue;
        merged.push(extPath);
    }
    return merged;
}

function normalizeHeaderName(value) {
    return String(value || '').trim();
}

function normalizeHeaderRuleMatch(match) {
    const source = isPlainObject(match) ? match : {};
    return {
        hosts: normalizeStringArray(source.hosts, { lower: true }),
        resourceTypes: normalizeStringArray(source.resourceTypes, { lower: true })
            .filter(item => ALLOWED_HEADER_RULE_RESOURCE_TYPES.has(item)),
    };
}

function normalizeHeaderRule(rule, index = 0) {
    const source = isPlainObject(rule) ? rule : {};
    const action = String(source.action || 'set').trim().toLowerCase();
    return {
        id: String(source.id || `rule-${index + 1}`).trim() || `rule-${index + 1}`,
        enabled: normalizeBoolean(source.enabled, true),
        match: normalizeHeaderRuleMatch(source.match),
        action: ALLOWED_HEADER_RULE_ACTIONS.has(action) ? action : 'set',
        header: normalizeHeaderName(source.header || ''),
        valueTemplate: String(source.valueTemplate || ''),
    };
}

function normalizeHeaderPreset(preset, index = 0) {
    const source = isPlainObject(preset) ? preset : {};
    return {
        id: String(source.id || `preset-${index + 1}`).trim() || `preset-${index + 1}`,
        name: String(source.name || `Preset ${index + 1}`).trim() || `Preset ${index + 1}`,
        enabled: normalizeBoolean(source.enabled, true),
        rules: (Array.isArray(source.rules) ? source.rules : []).map((rule, ruleIndex) => normalizeHeaderRule(rule, ruleIndex)),
    };
}

function normalizeDiagnosticPreset(preset, index = 0) {
    const source = isPlainObject(preset) ? preset : {};
    return {
        id: String(source.id || `diagnostic-${index + 1}`).trim() || `diagnostic-${index + 1}`,
        name: String(source.name || `Diagnostic ${index + 1}`).trim() || `Diagnostic ${index + 1}`,
        url: isValidHttpUrl(source.url) ? String(source.url).trim() : '',
        enabled: normalizeBoolean(source.enabled, true),
    };
}

function mergePresetLists(defaults, current, normalizer) {
    const normalizedDefaults = (Array.isArray(defaults) ? defaults : []).map((item, index) => normalizer(cloneJsonCompatible(item), index));
    const currentList = (Array.isArray(current) ? current : []).map((item, index) => normalizer(item, index));
    const byId = new Map(currentList.map(item => [item.id, item]));
    const result = normalizedDefaults.map(item => byId.has(item.id) ? normalizer(byId.get(item.id)) : item);
    const defaultIds = new Set(normalizedDefaults.map(item => item.id));
    for (const item of currentList) {
        if (!defaultIds.has(item.id)) result.push(item);
    }
    return result;
}

function normalizeUiLanguage(value, fallback = DEFAULT_APP_SETTINGS.uiLanguage) {
    const raw = String(value || fallback || 'cn').trim().toLowerCase();
    return raw === 'en' || raw === 'en-us' ? 'en' : 'cn';
}

function normalizeOptionalUiLanguage(value) {
    const raw = String(value || '').trim();
    return raw ? normalizeUiLanguage(raw, DEFAULT_APP_SETTINGS.uiLanguage) : '';
}

function normalizeSettings(settings) {
    const source = isPlainObject(settings) ? settings : {};
    return {
        ...DEFAULT_APP_SETTINGS,
        ...source,
        preProxies: Array.isArray(source.preProxies) ? source.preProxies : [],
        subscriptions: Array.isArray(source.subscriptions) ? source.subscriptions : [],
        savedProfileProxies: (Array.isArray(source.savedProfileProxies) ? source.savedProfileProxies : [])
            .map((item, index) => normalizeSavedProfileProxy(item, index))
            .filter(item => !!item.proxyStr),
        savedProfileProxySources: (Array.isArray(source.savedProfileProxySources) ? source.savedProfileProxySources : [])
            .map((item, index) => normalizeSavedProfileProxySource(item, index))
            .filter(item => !!item.url),
        userExtensions: normalizeStringArray(source.userExtensions),
        uiLanguage: normalizeUiLanguage(source.uiLanguage, DEFAULT_APP_SETTINGS.uiLanguage),
        enablePreProxy: normalizeBoolean(source.enablePreProxy, DEFAULT_APP_SETTINGS.enablePreProxy),
        notify: normalizeBoolean(source.notify, DEFAULT_APP_SETTINGS.notify),
        enableRemoteDebugging: normalizeBoolean(source.enableRemoteDebugging, DEFAULT_APP_SETTINGS.enableRemoteDebugging),
        dashboardOnLaunch: normalizeBoolean(source.dashboardOnLaunch, DEFAULT_APP_SETTINGS.dashboardOnLaunch),
        apiQuietLaunch: normalizeBoolean(source.apiQuietLaunch, DEFAULT_APP_SETTINGS.apiQuietLaunch),
        enableCustomArgs: normalizeBoolean(source.enableCustomArgs, DEFAULT_APP_SETTINGS.enableCustomArgs),
        enableApiServer: normalizeBoolean(source.enableApiServer, DEFAULT_APP_SETTINGS.enableApiServer),
        backgroundMode: String(source.backgroundMode || DEFAULT_APP_SETTINGS.backgroundMode).trim() === 'keep-active' ? 'keep-active' : 'chromium',
        apiPort: parsePositiveInt(source.apiPort, DEFAULT_APP_SETTINGS.apiPort),
        headerPresets: mergePresetLists(DEFAULT_HEADER_PRESETS, source.headerPresets, normalizeHeaderPreset),
        diagnosticPresets: mergePresetLists(DEFAULT_DIAGNOSTIC_PRESETS, source.diagnosticPresets, normalizeDiagnosticPreset)
            .filter(item => !!item.url),
        savedProfileProxySourceBatchHistory: normalizeSavedProfileProxySourceBatchHistory(source.savedProfileProxySourceBatchHistory),
    };
}

async function persistUiLanguagePreference(language) {
    const nextLanguage = normalizeUiLanguage(language, currentUiLanguage);
    currentUiLanguage = nextLanguage;
    const settings = await readSettingsAsync();
    if (normalizeUiLanguage(settings && settings.uiLanguage, nextLanguage) === nextLanguage) return nextLanguage;
    const nextSettings = normalizeSettings({ ...settings, uiLanguage: nextLanguage });
    await fs.writeJson(SETTINGS_FILE, nextSettings);
    currentUiLanguage = nextLanguage;
    return nextLanguage;
}

async function readSettingsAsync() {
    const settings = await readRecoverableJsonFile(SETTINGS_FILE, {}, {
        label: 'settings.json',
        normalize: (value) => normalizeSettings(value),
    });
    currentUiLanguage = normalizeUiLanguage(settings && settings.uiLanguage, currentUiLanguage);
    return settings;
}

async function readProfilesAsync() {
    return readRecoverableJsonFile(PROFILES_FILE, [], {
        label: 'profiles.json',
        normalize: (value) => Array.isArray(value) ? value : [],
    });
}

async function ensureAppDataFilesHealthy() {
    await readProfilesAsync();
    await readSettingsAsync();
}

function isForbiddenHeaderRuleName(header) {
    return FORBIDDEN_HEADER_RULE_NAMES.has(String(header || '').trim().toLowerCase());
}

function validateHeaderPresetsOrThrow(headerPresets) {
    const presets = (Array.isArray(headerPresets) ? headerPresets : []).map((item, index) => normalizeHeaderPreset(item, index));
    for (const preset of presets) {
        for (const rule of preset.rules) {
            if (!rule.header) throw new Error(`Header preset "${preset.name}" contains a rule with empty header`);
            if (!ALLOWED_HEADER_RULE_ACTIONS.has(rule.action)) throw new Error(`Header preset "${preset.name}" contains invalid action "${rule.action}"`);
            if (isForbiddenHeaderRuleName(rule.header)) throw new Error(`Header "${rule.header}" is not allowed in Header Rules`);
        }
    }
}

function validateDiagnosticPresetsOrThrow(diagnosticPresets) {
    const presets = (Array.isArray(diagnosticPresets) ? diagnosticPresets : []).map((item, index) => normalizeDiagnosticPreset(item, index));
    for (const preset of presets) {
        if (!preset.url) throw new Error(`Diagnostic preset "${preset.name}" has invalid URL`);
    }
}

function validateSavedProfileProxiesOrThrow(savedProfileProxies) {
    const proxies = (Array.isArray(savedProfileProxies) ? savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    const ids = new Set();
    for (const proxy of proxies) {
        if (!proxy.proxyStr) throw new Error(`Saved proxy "${proxy.name || proxy.id}" has empty proxy string`);
        if (ids.has(proxy.id)) throw new Error(`Duplicate saved proxy id "${proxy.id}"`);
        ids.add(proxy.id);
    }
}

function validateSavedProfileProxySourcesOrThrow(savedProfileProxySources) {
    const sources = (Array.isArray(savedProfileProxySources) ? savedProfileProxySources : []).map((item, index) => normalizeSavedProfileProxySource(item, index));
    const ids = new Set();
    for (const source of sources) {
        if (!source.url) throw new Error(`Saved proxy source "${source.name || source.id}" has invalid URL`);
        if (ids.has(source.id)) throw new Error(`Duplicate saved proxy source id "${source.id}"`);
        ids.add(source.id);
    }
}

function resolvePermissionMode(value) {
    const mode = String(value || PERMISSION_MODE_AUTO).trim().toLowerCase();
    return PERMISSION_MODE_STATES.has(mode) ? mode : PERMISSION_MODE_AUTO;
}

function resolveGeoPermissionMode(value) {
    return resolvePermissionMode(value);
}

function normalizeProfilePermissionModes(source) {
    const current = source || {};
    return {
        geoPermissionMode: resolvePermissionMode(current.geoPermissionMode),
        cameraPermissionMode: resolvePermissionMode(current.cameraPermissionMode),
        microphonePermissionMode: resolvePermissionMode(current.microphonePermissionMode),
        notificationPermissionMode: resolvePermissionMode(current.notificationPermissionMode),
    };
}

function applyNormalizedProfilePermissionModes(target, source) {
    if (!target || !source) return target;
    for (const field of Object.values(PERMISSION_PROFILE_FIELDS)) {
        if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = resolvePermissionMode(source[field]);
    }
    return target;
}

function applyNormalizedProfileSavedProxyConfig(target, source) {
    if (!target) return target;
    if (source && Object.prototype.hasOwnProperty.call(source, 'savedProxyId')) {
        target.savedProxyId = normalizeSavedProfileProxyId(source.savedProxyId);
    } else if (typeof target.savedProxyId !== 'string') {
        target.savedProxyId = '';
    }
    return target;
}

function findSavedProfileProxyById(settings, savedProxyId) {
    const targetId = normalizeSavedProfileProxyId(savedProxyId);
    if (!targetId) return null;
    const list = Array.isArray(settings && settings.savedProfileProxies) ? settings.savedProfileProxies : [];
    return list.find(item => normalizeSavedProfileProxyId(item && item.id) === targetId) || null;
}

function resolveProfileProxyBinding(profile, settings, proc = null) {
    if (proc && proc.proxyBinding) return proc.proxyBinding;
    const savedProxyId = normalizeSavedProfileProxyId(profile && profile.savedProxyId);
    const manualProxyStr = String(profile && profile.proxyStr || '').trim();
    const savedProxy = findSavedProfileProxyById(settings, savedProxyId);
    if (savedProxy && savedProxy.proxyStr) {
        return {
            source: 'saved',
            proxyStr: String(savedProxy.proxyStr || '').trim(),
            savedProxyId: savedProxy.id,
            savedProxyName: savedProxy.name || savedProxy.id,
            bindingBroken: false,
            fallbackProxyStr: manualProxyStr,
        };
    }
    return {
        source: savedProxyId ? 'saved-missing' : 'manual',
        proxyStr: manualProxyStr,
        savedProxyId,
        savedProxyName: savedProxyId,
        bindingBroken: !!savedProxyId,
        fallbackProxyStr: manualProxyStr,
    };
}

function buildSavedProfileProxyUsageMap(profiles) {
    const counts = {};
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        const savedProxyId = normalizeSavedProfileProxyId(profile && profile.savedProxyId);
        if (!savedProxyId) continue;
        counts[savedProxyId] = (counts[savedProxyId] || 0) + 1;
    }
    return counts;
}

function buildSavedProfileProxySourceMap(savedProfileProxySources) {
    const map = new Map();
    for (const source of Array.isArray(savedProfileProxySources) ? savedProfileProxySources : []) {
        const normalized = normalizeSavedProfileProxySource(source);
        if (normalized.id) map.set(normalized.id, normalized);
    }
    return map;
}

function attachSavedProfileProxyUsage(savedProfileProxies, profiles, savedProfileProxySources = []) {
    const counts = buildSavedProfileProxyUsageMap(profiles);
    const sourceMap = buildSavedProfileProxySourceMap(savedProfileProxySources);
    return (Array.isArray(savedProfileProxies) ? savedProfileProxies : []).map((proxy, index) => {
        const normalized = normalizeSavedProfileProxy(proxy, index);
        const liveSource = normalized.sourceId ? sourceMap.get(normalized.sourceId) || null : null;
        const sourceStatus = !normalized.sourceId
            ? 'manual'
            : (!liveSource ? 'source-missing' : (normalized.sourceStale ? 'stale' : 'active'));
        return {
            ...normalized,
            profilesCount: Number(counts[normalized.id] || 0),
            sourceExists: !!liveSource,
            sourceDisplayName: String(
                (liveSource && liveSource.name)
                || normalized.sourceName
                || normalized.sourceId
                || ''
            ).trim(),
            sourceStatus,
        };
    });
}

async function listSavedProfileProxiesWithUsage() {
    const settings = await readSettingsAsync();
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return attachSavedProfileProxyUsage(settings.savedProfileProxies || [], profiles, settings.savedProfileProxySources || []);
}

function attachSavedProfileProxySourceUsage(savedProfileProxySources, savedProfileProxies, profiles = []) {
    const proxyUsage = buildSavedProfileProxyUsageMap(profiles);
    const proxies = (Array.isArray(savedProfileProxies) ? savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    return (Array.isArray(savedProfileProxySources) ? savedProfileProxySources : []).map((source, index) => {
        const normalized = normalizeSavedProfileProxySource(source, index);
        const linked = proxies.filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === normalized.id);
        return {
            ...normalized,
            linkedProxyCount: linked.length,
            staleLinkedCount: linked.filter((proxy) => proxy && proxy.sourceStale === true).length,
            linkedProfilesCount: linked.reduce((sum, proxy) => sum + Number(proxyUsage[normalizeSavedProfileProxyId(proxy && proxy.id)] || 0), 0),
        };
    });
}

function hasSavedProfileProxyReachedQuarantineThreshold(proxy, result) {
    const current = isPlainObject(result) ? result : null;
    const proxyStr = String(proxy && proxy.proxyStr || '').trim();
    const proxySnapshot = String(current && current.proxySnapshot || '').trim();
    if (!proxy || !current) return false;
    if (proxy && proxy.sourceStale === true) return false;
    if (proxyStr && proxySnapshot && proxySnapshot !== proxyStr) return false;
    if (!current || (!Number(current.checkedAt) && !String(current.summary || current.error || '').trim())) return false;
    const status = ['ok', 'warn', 'info'].includes(String(current.status || '').trim().toLowerCase())
        ? String(current.status).trim().toLowerCase()
        : (current.success === true ? 'ok' : 'warn');
    if (status === 'warn') {
        const failureStreak = Number(current.failureStreak || 0);
        const lastSuccessAt = Number(current.lastSuccessAt || 0);
        const lastFailureAt = Number(current.lastFailureAt || 0);
        return failureStreak >= SAVED_PROFILE_PROXY_QUARANTINE_FAILURE_STREAK
            && !(lastSuccessAt > 0 && lastFailureAt > 0 && lastFailureAt < lastSuccessAt);
    }
    return false;
}

function isSavedProfileProxyQuarantined(proxy, result) {
    return proxy && proxy.enabled === false && hasSavedProfileProxyReachedQuarantineThreshold(proxy, result);
}

function isSavedProfileProxyQuarantineCandidate(proxy, result) {
    return proxy && proxy.enabled !== false && hasSavedProfileProxyReachedQuarantineThreshold(proxy, result);
}

function getSavedProfileProxyHealthBucket(proxy, result) {
    const current = isPlainObject(result) ? result : null;
    const proxyStr = String(proxy && proxy.proxyStr || '').trim();
    const proxySnapshot = String(current && current.proxySnapshot || '').trim();
    if (proxy && proxy.sourceStale === true) return 'stale';
    if (proxyStr && proxySnapshot && proxySnapshot !== proxyStr) return 'stale';
    if (!current || (!Number(current.checkedAt) && !String(current.summary || current.error || '').trim())) return 'untested';
    if (isSavedProfileProxyQuarantineCandidate(proxy, result)) return 'candidate';
    if (isSavedProfileProxyQuarantined(proxy, result)) return 'quarantined';
    const status = ['ok', 'warn', 'info'].includes(String(current.status || '').trim().toLowerCase())
        ? String(current.status).trim().toLowerCase()
        : (current.success === true ? 'ok' : 'warn');
    return (status === 'ok' || status === 'info') ? 'ok' : 'warn';
}

async function attachSavedProfileProxySourceUsageWithHealth(savedProfileProxySources, savedProfileProxies, profiles = []) {
    const base = attachSavedProfileProxySourceUsage(savedProfileProxySources, savedProfileProxies, profiles);
    const proxies = (Array.isArray(savedProfileProxies) ? savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    const testEntries = await Promise.all(
        proxies.map(async (proxy) => [normalizeSavedProfileProxyId(proxy && proxy.id), await readSavedProfileProxyTestResult(proxy && proxy.id)])
    );
    const testMap = new Map(testEntries.filter(([id]) => !!id));
    return base.map((source) => {
        const linked = proxies.filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === normalizeSavedProfileProxySourceId(source && source.id));
        const health = {
            healthOkCount: 0,
            healthWarnCount: 0,
            healthCandidateCount: 0,
            healthUntestedCount: 0,
            healthStaleCount: 0,
            healthQuarantinedCount: 0,
        };
        for (const proxy of linked) {
            const bucket = getSavedProfileProxyHealthBucket(proxy, testMap.get(normalizeSavedProfileProxyId(proxy && proxy.id)));
            if (bucket === 'ok') health.healthOkCount++;
            else if (bucket === 'warn') health.healthWarnCount++;
            else if (bucket === 'candidate') health.healthCandidateCount++;
            else if (bucket === 'stale') health.healthStaleCount++;
            else if (bucket === 'quarantined') health.healthQuarantinedCount++;
            else health.healthUntestedCount++;
        }
        return {
            ...source,
            ...health,
        };
    });
}

async function listSavedProfileProxySourcesWithUsage() {
    const settings = await readSettingsAsync();
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return attachSavedProfileProxySourceUsageWithHealth(settings.savedProfileProxySources || [], settings.savedProfileProxies || [], profiles);
}

function buildSavedProfileProxyStringMap(savedProfileProxies) {
    const map = new Map();
    for (const proxy of Array.isArray(savedProfileProxies) ? savedProfileProxies : []) {
        const normalized = normalizeSavedProfileProxy(proxy);
        if (!normalized.id || !normalized.proxyStr) continue;
        map.set(normalized.id, normalized.proxyStr);
    }
    return map;
}

function findSavedProfileProxyIndexById(savedProfileProxies, savedProxyId) {
    const targetId = normalizeSavedProfileProxyId(savedProxyId);
    if (!targetId) return -1;
    const list = Array.isArray(savedProfileProxies) ? savedProfileProxies : [];
    return list.findIndex(proxy => normalizeSavedProfileProxyId(proxy && proxy.id) === targetId);
}

function findSavedProfileProxySourceIndexById(savedProfileProxySources, sourceId) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) return -1;
    const list = Array.isArray(savedProfileProxySources) ? savedProfileProxySources : [];
    return list.findIndex((source) => normalizeSavedProfileProxySourceId(source && source.id) === targetId);
}

function buildUniqueSavedProfileProxySourceId(savedProfileProxySources, baseId = 'saved-proxy-source') {
    const currentIds = new Set(
        (Array.isArray(savedProfileProxySources) ? savedProfileProxySources : [])
            .map((source) => normalizeSavedProfileProxySourceId(source && source.id))
            .filter(Boolean)
    );
    const rawBase = normalizeSavedProfileProxySourceId(baseId) || 'saved-proxy-source';
    if (!currentIds.has(rawBase)) return rawBase;
    let index = 1;
    while (currentIds.has(`${rawBase}-${index}`)) index++;
    return `${rawBase}-${index}`;
}

function filterSavedProfileProxyCandidates(savedProfileProxies, filters = {}) {
    const tag = String(filters.tag || '').trim().toLowerCase();
    const group = normalizeSavedProfileProxyGroup(filters.group).toLowerCase();
    return (Array.isArray(savedProfileProxies) ? savedProfileProxies : [])
        .map((proxy, index) => normalizeSavedProfileProxy(proxy, index))
        .filter((proxy) => proxy.enabled !== false && proxy.proxyStr)
        .filter((proxy) => !tag || proxy.tags.some((item) => String(item || '').trim().toLowerCase() === tag))
        .filter((proxy) => !group || String(proxy.group || '').trim().toLowerCase() === group);
}

function buildUniqueSavedProfileProxyId(savedProfileProxies, baseId = 'saved-proxy') {
    const currentIds = new Set(
        (Array.isArray(savedProfileProxies) ? savedProfileProxies : [])
            .map((item, index) => normalizeSavedProfileProxy(item, index).id)
            .filter(Boolean)
    );
    const rawBase = normalizeSavedProfileProxyId(baseId) || 'saved-proxy';
    if (!currentIds.has(rawBase)) return rawBase;
    let index = 1;
    while (currentIds.has(`${rawBase}-${index}`)) index++;
    return `${rawBase}-${index}`;
}

function collectRemovedSavedProfileProxyIds(previousSavedProfileProxies, nextSavedProfileProxies) {
    const nextIds = new Set(
        (Array.isArray(nextSavedProfileProxies) ? nextSavedProfileProxies : [])
            .map((item, index) => normalizeSavedProfileProxy(item, index).id)
            .filter(Boolean)
    );
    return (Array.isArray(previousSavedProfileProxies) ? previousSavedProfileProxies : [])
        .map((item, index) => normalizeSavedProfileProxy(item, index).id)
        .filter(Boolean)
        .filter((id) => !nextIds.has(id));
}

function assertSavedProfileProxyCollectionIdIntegrity(previousSavedProfileProxies, nextSavedProfileProxies) {
    const previous = (Array.isArray(previousSavedProfileProxies) ? previousSavedProfileProxies : [])
        .map((item, index) => normalizeSavedProfileProxy(item, index));
    const next = (Array.isArray(nextSavedProfileProxies) ? nextSavedProfileProxies : [])
        .map((item, index) => normalizeSavedProfileProxy(item, index));
    if (previous.length === 0 || next.length === 0) return;
    const nextIds = new Set(next.map((item) => item.id).filter(Boolean));
    const conflicts = [];
    for (const prev of previous) {
        if (!prev.id || !prev.proxyStr || nextIds.has(prev.id)) continue;
        const renamed = next.find((item) => item.id !== prev.id && item.proxyStr === prev.proxyStr);
        if (renamed) conflicts.push(`${prev.id} -> ${renamed.id}`);
    }
    if (conflicts.length > 0) {
        throw createHttpError(400, `Changing saved proxy id via collection replace is not supported: ${conflicts.slice(0, 3).join(', ')}`);
    }
}

async function writeSettingsWithSavedProfileProxyLifecycle(nextSettingsInput, currentSettings = null) {
    const previousSettings = currentSettings || await readSettingsAsync();
    const previousSavedProfileProxies = Array.isArray(previousSettings.savedProfileProxies) ? previousSettings.savedProfileProxies : [];
    const nextSettings = normalizeSettings(nextSettingsInput || previousSettings);
    validateHeaderPresetsOrThrow(nextSettings && nextSettings.headerPresets);
    validateDiagnosticPresetsOrThrow(nextSettings && nextSettings.diagnosticPresets);
    validateSavedProfileProxiesOrThrow(nextSettings && nextSettings.savedProfileProxies);
    validateSavedProfileProxySourcesOrThrow(nextSettings && nextSettings.savedProfileProxySources);
    assertSavedProfileProxyCollectionIdIntegrity(previousSavedProfileProxies, nextSettings.savedProfileProxies || []);
    await fs.writeJson(SETTINGS_FILE, nextSettings);
    currentUiLanguage = normalizeUiLanguage(nextSettings && nextSettings.uiLanguage, currentUiLanguage);
    notifyUIRefresh();
    await syncSavedProfileProxyFallbacks(previousSavedProfileProxies, nextSettings.savedProfileProxies || []);
    const removedSavedProxyIds = collectRemovedSavedProfileProxyIds(previousSavedProfileProxies, nextSettings.savedProfileProxies || []);
    if (removedSavedProxyIds.length > 0) {
        await Promise.all(removedSavedProxyIds.map((savedProxyId) => deleteSavedProfileProxyTestResult(savedProxyId)));
    }
    return {
        settings: nextSettings,
        removedSavedProxyIds,
    };
}

async function syncSavedProfileProxyFallbacks(previousSavedProfileProxies, nextSavedProfileProxies) {
    const previousMap = buildSavedProfileProxyStringMap(previousSavedProfileProxies);
    const nextMap = buildSavedProfileProxyStringMap(nextSavedProfileProxies);
    const changedIds = [];
    for (const [id, proxyStr] of nextMap.entries()) {
        if (previousMap.has(id) && previousMap.get(id) !== proxyStr) changedIds.push(id);
    }
    if (changedIds.length === 0) return { updatedCount: 0 };

    const changedIdSet = new Set(changedIds);
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    let updatedCount = 0;
    for (const profile of profiles) {
        const savedProxyId = normalizeSavedProfileProxyId(profile && profile.savedProxyId);
        if (!changedIdSet.has(savedProxyId)) continue;
        const nextProxyStr = String(nextMap.get(savedProxyId) || '').trim();
        if (!nextProxyStr || String(profile && profile.proxyStr || '').trim() === nextProxyStr) continue;
        profile.proxyStr = nextProxyStr;
        updatedCount++;
    }
    if (updatedCount > 0) {
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh();
    }
    return { updatedCount };
}

async function replaceSavedProfileProxiesCollection(nextSavedProfileProxies, settings = null) {
    const currentSettings = settings || await readSettingsAsync();
    try {
        const saved = await writeSettingsWithSavedProfileProxyLifecycle({
            ...currentSettings,
            savedProfileProxies: nextSavedProfileProxies,
        }, currentSettings);
        const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        return {
            settings: saved.settings,
            list: attachSavedProfileProxyUsage(saved.settings.savedProfileProxies || [], profiles, saved.settings.savedProfileProxySources || []),
        };
    } catch (e) {
        throw createHttpError(400, e && e.message ? e.message : String(e));
    }
}

async function createSavedProfileProxyEntry(payload = {}) {
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : [];
    const normalizedPayload = {
        ...payload,
        id: normalizeSavedProfileProxyId(payload.id) || buildUniqueSavedProfileProxyId(currentList, 'saved-proxy'),
    };
    const nextList = [...currentList, normalizeSavedProfileProxy(normalizedPayload, currentList.length)];
    const saved = await replaceSavedProfileProxiesCollection(nextList, settings);
    const item = saved.list.find(proxy => proxy.id === normalizeSavedProfileProxyId(normalizedPayload.id)) || saved.list[saved.list.length - 1] || null;
    return {
        item,
        list: saved.list,
    };
}

async function patchSavedProfileProxyEntry(savedProxyId, payload = {}) {
    const targetId = normalizeSavedProfileProxyId(savedProxyId);
    if (!targetId) throw createHttpError(400, 'savedProxyId is required');
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : [];
    const index = findSavedProfileProxyIndexById(currentList, targetId);
    if (index < 0) throw createHttpError(404, `Saved proxy "${targetId}" not found`);
    if (Object.prototype.hasOwnProperty.call(payload, 'id')) {
        const requestedId = normalizeSavedProfileProxyId(payload.id);
        if (requestedId && requestedId !== targetId) {
            throw createHttpError(400, 'Changing saved proxy id via PATCH is not supported');
        }
    }
    const rawCurrent = currentList[index];
    const nextList = [...currentList];
    nextList[index] = normalizeSavedProfileProxy({ ...rawCurrent, ...payload, id: targetId }, index);
    const saved = await replaceSavedProfileProxiesCollection(nextList, settings);
    return {
        item: saved.list.find(proxy => proxy.id === targetId) || null,
        list: saved.list,
    };
}

async function deleteSavedProfileProxyEntry(savedProxyId) {
    const targetId = normalizeSavedProfileProxyId(savedProxyId);
    if (!targetId) throw createHttpError(400, 'savedProxyId is required');
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : [];
    const index = findSavedProfileProxyIndexById(currentList, targetId);
    if (index < 0) throw createHttpError(404, `Saved proxy "${targetId}" not found`);
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const deleted = normalizeSavedProfileProxy(currentList[index], index);
    const affectedProfilesCount = Number(buildSavedProfileProxyUsageMap(profiles)[targetId] || 0);
    const nextList = currentList.filter((_, currentIndex) => currentIndex !== index);
    const saved = await replaceSavedProfileProxiesCollection(nextList, settings);
    await deleteSavedProfileProxyTestResult(targetId);
    return {
        deleted,
        deletedId: targetId,
        affectedProfilesCount,
        list: saved.list,
    };
}

function slugifySavedProfileProxyIdBase(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildUniqueSavedProfileProxyIdWithStart(savedProfileProxies, baseId = 'saved-proxy', index = 0, startIndex = 1) {
    const currentIds = new Set(
        (Array.isArray(savedProfileProxies) ? savedProfileProxies : [])
            .map((proxy) => normalizeSavedProfileProxyId(proxy && proxy.id))
            .filter(Boolean)
    );
    const rawBase = slugifySavedProfileProxyIdBase(baseId) || 'saved-proxy';
    let nextIndex = Math.max(1, parsePositiveInt(startIndex, 1)) + Math.max(0, Number.parseInt(index, 10) || 0);
    let candidate = `${rawBase}-${nextIndex}`;
    while (currentIds.has(candidate)) {
        nextIndex++;
        candidate = `${rawBase}-${nextIndex}`;
    }
    return candidate;
}

function buildSavedProfileProxyImportIdBase(proxyStr, options = {}) {
    const prefixBase = slugifySavedProfileProxyIdBase(options && options.prefix);
    if (prefixBase) return prefixBase;
    const groupBase = slugifySavedProfileProxyIdBase(options && options.group);
    if (groupBase) return groupBase;
    const type = detectProxyType(proxyStr);
    const typeBase = slugifySavedProfileProxyIdBase(type && type !== 'UNKNOWN' && type !== 'DIRECT'
        ? `${type.toLowerCase()}-proxy`
        : 'saved-proxy');
    return typeBase || 'saved-proxy';
}

function buildImportedSavedProfileProxyName(proxyStr, index = 0, prefix = '', startIndex = 1) {
    const customPrefix = String(prefix || '').trim();
    const nextIndex = Math.max(1, parsePositiveInt(startIndex, 1)) + Math.max(0, Number.parseInt(index, 10) || 0);
    if (customPrefix) return `${customPrefix} ${nextIndex}`;
    const type = detectProxyType(proxyStr);
    return `${type} Imported Proxy ${nextIndex}`;
}

function normalizeSavedProfileProxyImportLine(value) {
    return String(value || '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .trim();
}

function decodeBase64ContentNode(str) {
    const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
}

function normalizeSavedProfileProxyImportFormat(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['auto', 'lines', 'csv', 'json'].includes(current) ? current : 'auto';
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
            throw createHttpError(400, 'Invalid JSON import payload');
        }
        const lines = collectSavedProfileProxyImportJsonRecords(parsed)
            .map((item) => extractSavedProfileProxyImportProxyString(item))
            .filter(Boolean);
        return { format, lines };
    }
    if (format === 'csv') return { format, lines: parseSavedProfileProxyImportCsvRows(text) };
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
    return !!line && detectProxyType(line) !== 'UNKNOWN';
}

async function fetchSavedProfileProxyImportRemotePayloadInternal(rawUrl, options = {}) {
    const input = String(rawUrl || '').trim();
    if (!input) throw createHttpError(400, 'Please enter a remote URL first');
    let target;
    try {
        target = new URL(input);
    } catch (e) {
        throw createHttpError(400, 'Invalid remote URL');
    }
    const response = await fetch(target.toString());
    if (!response.ok) throw createHttpError(response.status || 502, `HTTP ${response.status}`);
    let decoded = await response.text();
    let parsed;
    try {
        parsed = extractSavedProfileProxyImportLines(decoded, {
            format: options.format,
            fileName: options.fileName || target.pathname || target.hostname,
        });
    } catch (primaryError) {
        try {
            if (!decoded.includes('://')) {
                decoded = decodeBase64ContentNode(decoded);
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

function getSavedProfileProxyEntriesForSource(savedProfileProxies, sourceId, options = {}) {
    const targetSourceId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetSourceId) return [];
    const staleOnly = options.staleOnly === true;
    return (Array.isArray(savedProfileProxies) ? savedProfileProxies : [])
        .filter((proxy) => normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) === targetSourceId)
        .filter((proxy) => !staleOnly || proxy && proxy.sourceStale === true);
}

function syncSavedProfileProxySourceMembershipForList(savedProfileProxies, sourceId, activeProxyStrings, syncedAt) {
    const targetSourceId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetSourceId) return { staleCount: 0, reactivatedCount: 0 };
    const activeSet = activeProxyStrings instanceof Set
        ? activeProxyStrings
        : new Set((Array.isArray(activeProxyStrings) ? activeProxyStrings : []).map((item) => String(item || '').trim()).filter(Boolean));
    const missingSince = Number.isFinite(Number(syncedAt)) && Number(syncedAt) > 0 ? Math.round(Number(syncedAt)) : Date.now();
    let staleCount = 0;
    let reactivatedCount = 0;
    for (const proxy of Array.isArray(savedProfileProxies) ? savedProfileProxies : []) {
        if (normalizeSavedProfileProxySourceId(proxy && proxy.sourceId) !== targetSourceId) continue;
        const proxyStr = String(proxy && proxy.proxyStr || '').trim();
        if (proxyStr && activeSet.has(proxyStr)) {
            if (proxy.sourceStale === true || Number(proxy.sourceMissingSince || 0) > 0) reactivatedCount++;
            proxy.sourceStale = false;
            proxy.sourceMissingSince = 0;
            continue;
        }
        if (proxy.sourceStale !== true) {
            staleCount++;
            proxy.sourceStale = true;
            proxy.sourceMissingSince = missingSince;
        } else if (!(Number(proxy.sourceMissingSince || 0) > 0)) {
            proxy.sourceMissingSince = missingSince;
        }
    }
    return { staleCount, reactivatedCount };
}

function applySavedProfileProxySourceStalePolicyToList(savedProfileProxies, sourceId, policy) {
    const nextPolicy = normalizeSavedProfileProxySourceStalePolicy(policy);
    if (nextPolicy === 'mark') return { policyMode: nextPolicy, policyAffectedCount: 0 };
    let policyAffectedCount = 0;
    for (const proxy of getSavedProfileProxyEntriesForSource(savedProfileProxies, sourceId, { staleOnly: true })) {
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

function importSavedProfileProxyLinesIntoList(savedProfileProxies, payload = {}) {
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const prefix = String(payload.prefix || '').trim();
    const startIndex = parsePositiveInt(payload.startIndex, 1);
    const group = normalizeSavedProfileProxyGroup(payload.group);
    const tags = normalizeSavedProfileProxyTags(payload.tags);
    const sourceId = normalizeSavedProfileProxySourceId(payload.sourceId);
    const sourceName = String(payload.sourceName || '').trim();
    const sourceImportedAt = Number.isFinite(Number(payload.sourceImportedAt)) && Number(payload.sourceImportedAt) > 0
        ? Math.round(Number(payload.sourceImportedAt))
        : Date.now();
    const existingProxyMap = new Map(
        (Array.isArray(savedProfileProxies) ? savedProfileProxies : [])
            .map((proxy) => [String(proxy && proxy.proxyStr || '').trim(), proxy])
            .filter(([proxyStr]) => !!proxyStr)
    );
    let importedCount = 0;
    let duplicateCount = 0;
    let linkedCount = 0;
    let invalidCount = 0;
    const importedIds = [];
    for (const line of lines) {
        if (!isValidSavedProfileProxyImportLine(line)) {
            invalidCount++;
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
        const nextId = buildUniqueSavedProfileProxyIdWithStart(
            savedProfileProxies,
            buildSavedProfileProxyImportIdBase(line, { prefix, group }),
            importedCount,
            startIndex
        );
        const nextProxy = normalizeSavedProfileProxy({
            id: nextId,
            name: buildImportedSavedProfileProxyName(line, importedCount, prefix, startIndex),
            proxyStr: line,
            group,
            tags,
            sourceId,
            sourceName,
            sourceImportedAt,
            sourceStale: false,
            sourceMissingSince: 0,
            enabled: true,
        }, savedProfileProxies.length);
        savedProfileProxies.push(nextProxy);
        existingProxyMap.set(line, nextProxy);
        importedCount++;
        importedIds.push(nextProxy.id);
    }
    return { importedCount, duplicateCount, linkedCount, invalidCount, importedIds };
}

async function runSavedProfileProxyAutoChecks(savedProxyIds) {
    const ids = Array.from(new Set((Array.isArray(savedProxyIds) ? savedProxyIds : []).map((item) => normalizeSavedProfileProxyId(item)).filter(Boolean)));
    if (ids.length === 0) return { total: 0, failed: 0 };
    let failed = 0;
    await Promise.all(ids.map(async (savedProxyId) => {
        try {
            const result = await testSavedProfileProxyInternal(savedProxyId);
            if (!result || result.success !== true) failed++;
        } catch (e) {
            failed++;
        }
    }));
    return { total: ids.length, failed };
}

async function replaceSavedProfileProxySourceState(nextState = {}, settings = null) {
    const currentSettings = settings || await readSettingsAsync();
    try {
        const saved = await writeSettingsWithSavedProfileProxyLifecycle({
            ...currentSettings,
            savedProfileProxySources: Object.prototype.hasOwnProperty.call(nextState, 'savedProfileProxySources')
                ? nextState.savedProfileProxySources
                : currentSettings.savedProfileProxySources,
            savedProfileProxies: Object.prototype.hasOwnProperty.call(nextState, 'savedProfileProxies')
                ? nextState.savedProfileProxies
                : currentSettings.savedProfileProxies,
        }, currentSettings);
        const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        return {
            settings: saved.settings,
            sources: await attachSavedProfileProxySourceUsageWithHealth(saved.settings.savedProfileProxySources || [], saved.settings.savedProfileProxies || [], profiles),
            proxies: attachSavedProfileProxyUsage(saved.settings.savedProfileProxies || [], profiles, saved.settings.savedProfileProxySources || []),
        };
    } catch (e) {
        throw createHttpError(400, e && e.message ? e.message : String(e));
    }
}

async function patchSavedProfileProxySourceRuntimeState(sourceId, patch = {}, settings = null) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const currentSettings = settings || await readSettingsAsync();
    const currentList = Array.isArray(currentSettings.savedProfileProxySources) ? currentSettings.savedProfileProxySources : [];
    const index = findSavedProfileProxySourceIndexById(currentList, targetId);
    if (index < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const nextList = currentList.map((item, currentIndex) => currentIndex === index
        ? normalizeSavedProfileProxySource({ ...item, ...patch, id: targetId }, currentIndex)
        : normalizeSavedProfileProxySource(item, currentIndex));
    const saved = await replaceSavedProfileProxySourceState({ savedProfileProxySources: nextList }, currentSettings);
    return {
        item: (saved.sources || []).find((source) => source.id === targetId) || null,
        list: saved.sources || [],
        settings: saved.settings,
    };
}

async function createSavedProfileProxySourceEntry(payload = {}) {
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const normalizedPayload = {
        ...payload,
        id: normalizeSavedProfileProxySourceId(payload.id) || buildUniqueSavedProfileProxySourceId(currentList, 'saved-proxy-source'),
    };
    const nextList = [...currentList, normalizeSavedProfileProxySource(normalizedPayload, currentList.length)];
    const saved = await replaceSavedProfileProxySourceState({ savedProfileProxySources: nextList }, settings);
    const item = saved.sources.find((source) => source.id === normalizeSavedProfileProxySourceId(normalizedPayload.id)) || saved.sources[saved.sources.length - 1] || null;
    return { item, list: saved.sources };
}

async function patchSavedProfileProxySourceEntry(sourceId, payload = {}) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const index = findSavedProfileProxySourceIndexById(currentList, targetId);
    if (index < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    if (Object.prototype.hasOwnProperty.call(payload, 'id')) {
        const requestedId = normalizeSavedProfileProxySourceId(payload.id);
        if (requestedId && requestedId !== targetId) throw createHttpError(400, 'Changing saved proxy source id via PATCH is not supported');
    }
    const nextList = [...currentList];
    nextList[index] = normalizeSavedProfileProxySource({ ...nextList[index], ...payload, id: targetId }, index);
    const saved = await replaceSavedProfileProxySourceState({ savedProfileProxySources: nextList }, settings);
    return {
        item: saved.sources.find((source) => source.id === targetId) || null,
        list: saved.sources,
    };
}

async function deleteSavedProfileProxySourceEntry(sourceId) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const settings = await readSettingsAsync();
    const currentList = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const index = findSavedProfileProxySourceIndexById(currentList, targetId);
    if (index < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const deleted = normalizeSavedProfileProxySource(currentList[index], index);
    const linkedProxyCount = getSavedProfileProxyEntriesForSource(settings.savedProfileProxies || [], targetId).length;
    const nextList = currentList.filter((_, currentIndex) => currentIndex !== index);
    const saved = await replaceSavedProfileProxySourceState({ savedProfileProxySources: nextList }, settings);
    return {
        deleted,
        deletedId: targetId,
        linkedProxyCount,
        list: saved.sources,
    };
}

async function refreshSavedProfileProxySourceEntry(sourceId) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const settings = await readSettingsAsync();
    const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const sourceIndex = findSavedProfileProxySourceIndexById(currentSources, targetId);
    if (sourceIndex < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const nextSources = currentSources.map((item, index) => normalizeSavedProfileProxySource(item, index));
    const nextSource = nextSources[sourceIndex];
    const nextProxies = (Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    const syncAt = Date.now();
    try {
        const remote = await fetchSavedProfileProxyImportRemotePayloadInternal(String(nextSource.url || '').trim(), {
            format: normalizeSavedProfileProxyImportFormat(nextSource.format),
        });
        const parsed = remote.parsed || { format: 'lines', lines: [] };
        const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
        const normalizedLines = lines.map((item) => String(item || '').trim()).filter(Boolean);
        let importResult = { importedCount: 0, duplicateCount: 0, linkedCount: 0, invalidCount: 0, importedIds: [] };
        let sourceSyncResult = { staleCount: 0, reactivatedCount: 0 };
        if (lines.length > 0) {
            importResult = importSavedProfileProxyLinesIntoList(nextProxies, {
                lines,
                prefix: String(nextSource.prefix || nextSource.name || '').trim(),
                startIndex: nextSource.startIndex,
                group: String(nextSource.group || '').trim(),
                tags: nextSource.tags,
                sourceId: nextSource.id,
                sourceName: nextSource.name,
                sourceImportedAt: syncAt,
            });
            nextSource.lastImportedAt = syncAt;
            sourceSyncResult = syncSavedProfileProxySourceMembershipForList(nextProxies, nextSource.id, normalizedLines, syncAt);
        } else {
            nextSource.lastImportedAt = syncAt;
            sourceSyncResult = syncSavedProfileProxySourceMembershipForList(nextProxies, nextSource.id, [], syncAt);
        }
        const policyResult = applySavedProfileProxySourceStalePolicyToList(nextProxies, nextSource.id, nextSource.stalePolicy);
        nextSource.lastImportCount = Number(importResult.importedCount || 0);
        nextSource.lastImportError = '';
        pushSavedProfileProxySourceHistoryEntry(nextSource, {
            syncedAt: syncAt,
            status: 'ok',
            format: parsed && parsed.format,
            totalLines: lines.length,
            addedCount: importResult.importedCount || 0,
            duplicateCount: importResult.duplicateCount || 0,
            linkedCount: importResult.linkedCount || 0,
            staleCount: sourceSyncResult.staleCount || 0,
            reactivatedCount: sourceSyncResult.reactivatedCount || 0,
            invalidCount: importResult.invalidCount || 0,
            policyMode: policyResult.policyMode,
            policyAffectedCount: policyResult.policyAffectedCount,
            error: '',
        });
        const saved = await replaceSavedProfileProxySourceState({
            savedProfileProxySources: nextSources,
            savedProfileProxies: nextProxies,
        }, settings);
        const autoCheckResult = nextSource.autoCheck === true && importResult.importedIds.length > 0
            ? await runSavedProfileProxyAutoChecks(importResult.importedIds)
            : { total: 0, failed: 0 };
        return {
            source: saved.sources.find((item) => item.id === targetId) || null,
            importResult,
            sourceSyncResult,
            policyResult,
            autoCheckResult,
            remote: {
                url: remote.target.toString(),
                host: remote.target.host,
                format: parsed && parsed.format ? String(parsed.format) : 'lines',
                totalLines: lines.length,
            },
        };
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        nextSource.lastImportCount = 0;
        nextSource.lastImportError = message;
        pushSavedProfileProxySourceHistoryEntry(nextSource, {
            syncedAt: syncAt,
            status: 'error',
            format: nextSource.format,
            totalLines: 0,
            addedCount: 0,
            duplicateCount: 0,
            linkedCount: 0,
            staleCount: 0,
            reactivatedCount: 0,
            invalidCount: 0,
            policyMode: nextSource.stalePolicy,
            policyAffectedCount: 0,
            error: message,
        });
        await replaceSavedProfileProxySourceState({
            savedProfileProxySources: nextSources,
            savedProfileProxies: nextProxies,
        }, settings);
        throw createHttpError(e && e.status ? e.status : 502, message);
    }
}

function assertSavedProfileProxySourceRouteMutationUnlocked(sourceId) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (savedProfileProxySourceOverviewActionLock) {
        throw createHttpError(409, 'Saved proxy source overview action is already running');
    }
    if (targetId && savedProfileProxySourceMaintenanceLocks.has(targetId)) {
        throw createHttpError(409, `Saved proxy source "${targetId}" maintenance is already running`);
    }
}

async function exportSavedProfileProxySourceContent(sourceId, options = {}) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const scope = String(options.scope || 'all').trim().toLowerCase() === 'stale' ? 'stale' : 'all';
    const format = String(options.format || 'json').trim().toLowerCase() === 'txt' ? 'txt' : 'json';
    const settings = await readSettingsAsync();
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const source = attachSavedProfileProxySourceUsage(settings.savedProfileProxySources || [], settings.savedProfileProxies || [], profiles)
        .find((item) => item.id === targetId) || null;
    if (!source) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const selected = getSavedProfileProxyEntriesForSource(
        (Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index)),
        targetId,
        { staleOnly: scope === 'stale' }
    );
    if (selected.length === 0) throw createHttpError(400, scope === 'stale' ? 'No stale proxies found for this source' : 'No linked proxies found for this source');
    const proxyList = attachSavedProfileProxyUsage(selected, profiles, settings.savedProfileProxySources || []);
    if (format === 'txt') {
        return {
            format,
            scope,
            count: proxyList.length,
            source,
            content: proxyList.map((proxy) => String(proxy.proxyStr || '').trim()).filter(Boolean).join('\n'),
        };
    }
    return {
        format,
        scope,
        count: proxyList.length,
        content: {
            source,
            scope,
            count: proxyList.length,
            proxies: proxyList,
        }
    };
}

async function mutateSavedProfileProxySourceStaleEntries(sourceId, action = 'disable') {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const normalizedAction = ['disable', 'detach', 'delete'].includes(String(action || '').trim()) ? String(action).trim() : 'disable';
    const settings = await readSettingsAsync();
    const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const sourceIndex = findSavedProfileProxySourceIndexById(currentSources, targetId);
    if (sourceIndex < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const nextSources = currentSources.map((item, index) => normalizeSavedProfileProxySource(item, index));
    const nextSource = nextSources[sourceIndex];
    const nextProxies = (Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    const staleEntries = getSavedProfileProxyEntriesForSource(nextProxies, targetId, { staleOnly: true });
    if (staleEntries.length === 0) throw createHttpError(400, 'No stale proxies found for this source');
    const staleIds = new Set(staleEntries.map((proxy) => normalizeSavedProfileProxyId(proxy && proxy.id)).filter(Boolean));
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const affectedProfilesCount = (Array.isArray(profiles) ? profiles : [])
        .filter((profile) => staleIds.has(normalizeSavedProfileProxyId(profile && profile.savedProxyId)))
        .length;
    let updatedCount = 0;
    if (normalizedAction === 'disable') {
        for (const proxy of staleEntries) {
            if (proxy.enabled !== false) {
                proxy.enabled = false;
                updatedCount++;
            }
        }
    } else if (normalizedAction === 'detach') {
        for (const proxy of staleEntries) {
            proxy.sourceId = '';
            proxy.sourceName = '';
            proxy.sourceImportedAt = 0;
            proxy.sourceStale = false;
            proxy.sourceMissingSince = 0;
            updatedCount++;
        }
    } else {
        updatedCount = staleEntries.length;
    }
    const saved = await replaceSavedProfileProxySourceState({
        savedProfileProxySources: nextSources,
        savedProfileProxies: normalizedAction === 'delete'
            ? nextProxies.filter((proxy) => !staleIds.has(normalizeSavedProfileProxyId(proxy && proxy.id)))
            : nextProxies,
    }, settings);
    return {
        action: normalizedAction,
        source: saved.sources.find((item) => item.id === targetId) || null,
        count: updatedCount,
        affectedProfilesCount,
    };
}

async function buildSavedProfileProxyTestMap(savedProfileProxies) {
    const entries = await Promise.all(
        (Array.isArray(savedProfileProxies) ? savedProfileProxies : []).map(async (proxy) => {
            const id = normalizeSavedProfileProxyId(proxy && proxy.id);
            return [id, id ? await readSavedProfileProxyTestResult(id) : null];
        })
    );
    return new Map(entries.filter(([id]) => !!id));
}

async function retestSavedProfileProxyEntriesForSource(entries, { reenableRecovered = false } = {}) {
    const selected = Array.isArray(entries) ? entries.filter(Boolean) : [];
    let total = 0;
    let failed = 0;
    let recoveredCount = 0;
    const results = [];
    for (const proxy of selected) {
        const savedProxyId = normalizeSavedProfileProxyId(proxy && proxy.id);
        if (!savedProxyId) continue;
        total++;
        try {
            const result = await testSavedProfileProxyInternal(savedProxyId);
            const current = isPlainObject(result) ? result : {};
            if (!result || result.success !== true) {
                failed++;
            } else if (reenableRecovered && proxy.enabled === false) {
                proxy.enabled = true;
                recoveredCount++;
            }
            results.push({
                savedProxyId,
                savedProxyName: String(proxy && (proxy.name || proxy.id) || '').trim(),
                success: current.success === true,
                status: current.status ? current.status : 'warn',
                checkedAt: Number(current.checkedAt) || 0,
                latencyMs: Number.isFinite(Number(current.latencyMs)) ? Number(current.latencyMs) : null,
                summary: String(current.summary || '').trim(),
                error: String(current.error || '').trim(),
                failureStreak: Number(current.failureStreak || 0),
                candidate: isSavedProfileProxyQuarantineCandidate(proxy, current),
                quarantined: isSavedProfileProxyQuarantined(proxy, current),
            });
        } catch (e) {
            failed++;
            results.push({
                savedProxyId,
                savedProxyName: String(proxy && (proxy.name || proxy.id) || '').trim(),
                success: false,
                status: 'warn',
                checkedAt: 0,
                latencyMs: null,
                summary: '',
                failureStreak: 0,
                candidate: false,
                quarantined: false,
                error: e && e.message ? e.message : String(e),
            });
        }
    }
    return { total, failed, recoveredCount, results };
}

async function runSavedProfileProxySourceHealthAction(sourceId, action = 'retest-linked') {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const normalizedAction = String(action || '').trim().toLowerCase();
    const supported = new Set(['retest-linked', 'retest-stale', 'quarantine-failed', 'recheck-quarantined']);
    if (!supported.has(normalizedAction)) throw createHttpError(400, 'Unsupported source health action');

    const settings = await readSettingsAsync();
    const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
    const sourceIndex = findSavedProfileProxySourceIndexById(currentSources, targetId);
    if (sourceIndex < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
    const nextSources = currentSources.map((item, index) => normalizeSavedProfileProxySource(item, index));
    const nextProxies = (Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
    const linkedEntries = getSavedProfileProxyEntriesForSource(nextProxies, targetId);
    const testMap = await buildSavedProfileProxyTestMap(linkedEntries);
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];

    if (normalizedAction === 'retest-linked') {
        if (linkedEntries.length === 0) throw createHttpError(400, 'No linked proxies found for this source');
        const result = await retestSavedProfileProxyEntriesForSource(linkedEntries);
        const source = (await listSavedProfileProxySourcesWithUsage()).find((item) => item.id === targetId) || null;
        return { action: normalizedAction, source, ...result };
    }

    if (normalizedAction === 'retest-stale') {
        const staleEntries = linkedEntries.filter((proxy) => proxy && proxy.sourceStale === true);
        if (staleEntries.length === 0) throw createHttpError(400, 'No stale proxies found for this source');
        const result = await retestSavedProfileProxyEntriesForSource(staleEntries);
        const source = (await listSavedProfileProxySourcesWithUsage()).find((item) => item.id === targetId) || null;
        return { action: normalizedAction, source, ...result };
    }

    if (normalizedAction === 'quarantine-failed') {
        const candidates = linkedEntries.filter((proxy) => isSavedProfileProxyQuarantineCandidate(proxy, testMap.get(normalizeSavedProfileProxyId(proxy && proxy.id))));
        if (candidates.length === 0) throw createHttpError(400, 'No linked proxies reached the quarantine threshold for this source');
        const candidateIds = new Set(candidates.map((proxy) => normalizeSavedProfileProxyId(proxy && proxy.id)).filter(Boolean));
        const affectedProfilesCount = (Array.isArray(profiles) ? profiles : [])
            .filter((profile) => candidateIds.has(normalizeSavedProfileProxyId(profile && profile.savedProxyId)))
            .length;
        let count = 0;
        for (const proxy of candidates) {
            if (proxy.enabled !== false) {
                proxy.enabled = false;
                count++;
            }
        }
        const saved = await replaceSavedProfileProxySourceState({
            savedProfileProxySources: nextSources,
            savedProfileProxies: nextProxies,
        }, settings);
        return {
            action: normalizedAction,
            source: saved.sources.find((item) => item.id === targetId) || null,
            count,
            affectedProfilesCount,
        };
    }

    const quarantinedEntries = linkedEntries.filter((proxy) => isSavedProfileProxyQuarantined(proxy, testMap.get(normalizeSavedProfileProxyId(proxy && proxy.id))));
    if (quarantinedEntries.length === 0) throw createHttpError(400, 'No quarantined proxies found for this source');
    const result = await retestSavedProfileProxyEntriesForSource(quarantinedEntries, { reenableRecovered: true });
    const saved = result.recoveredCount > 0
        ? await replaceSavedProfileProxySourceState({
            savedProfileProxySources: nextSources,
            savedProfileProxies: nextProxies,
        }, settings)
        : { sources: await listSavedProfileProxySourcesWithUsage() };
    return {
        action: normalizedAction,
        source: (saved.sources || []).find((item) => item.id === targetId) || null,
        ...result,
    };
}

async function runSavedProfileProxySourcesOverviewAction(action = 'refresh-due') {
    const normalizedAction = normalizeSavedProfileProxySourceBatchAction(action);
    if (normalizedAction === 'attention-maintenance') {
        throw createHttpError(400, 'Unsupported overview action');
    }
    if (savedProfileProxySourceOverviewActionLock) {
        throw createHttpError(409, 'Saved proxy source overview action is already running');
    }
    if (savedProfileProxySourceMaintenanceLocks.size > 0) {
        throw createHttpError(409, 'A saved proxy source maintenance task is already running');
    }

    savedProfileProxySourceOverviewActionLock = true;
    try {
        if (normalizedAction === 'refresh-due') {
            const settings = await readSettingsAsync();
            const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
            const dueSources = currentSources
                .map((item, index) => normalizeSavedProfileProxySource(item, index))
                .filter((source) => source && source.enabled !== false && String(source.url || '').trim())
                .map((source) => ({ source, scheduleState: getSavedProfileProxySourceScheduleState(source) }))
                .filter(({ scheduleState }) => scheduleState.isDueNow || scheduleState.isOverdue);
            if (dueSources.length === 0) throw createHttpError(400, 'No due or overdue saved proxy sources with URL found');

            let ok = 0;
            let failed = 0;
            let added = 0;
            let duplicateCount = 0;
            let linkedCount = 0;
            let staleCount = 0;
            let reactivatedCount = 0;
            let invalidCount = 0;
            let policyAffectedCount = 0;
            const failures = [];
            for (const target of dueSources) {
                try {
                    const result = await refreshSavedProfileProxySourceEntry(target.source.id);
                    const importResult = result && result.importResult ? result.importResult : {};
                    const sourceSyncResult = result && result.sourceSyncResult ? result.sourceSyncResult : {};
                    const policyResult = result && result.policyResult ? result.policyResult : {};
                    ok++;
                    added += Number(importResult.importedCount || 0);
                    duplicateCount += Number(importResult.duplicateCount || 0);
                    linkedCount += Number(importResult.linkedCount || 0);
                    staleCount += Number(sourceSyncResult.staleCount || 0);
                    reactivatedCount += Number(sourceSyncResult.reactivatedCount || 0);
                    invalidCount += Number(importResult.invalidCount || 0);
                    policyAffectedCount += Number(policyResult.policyAffectedCount || 0);
                } catch (e) {
                    failed++;
                    failures.push({
                        sourceId: target.source.id,
                        error: e && e.message ? e.message : String(e),
                    });
                }
            }
            const historyEntry = normalizeSavedProfileProxySourceBatchHistoryEntry({
                action: normalizedAction,
                finishedAt: Date.now(),
                total: dueSources.length,
                ok,
                failed,
                added,
                dueCount: dueSources.filter((item) => item.scheduleState && item.scheduleState.isDueNow).length,
                overdueCount: dueSources.filter((item) => item.scheduleState && item.scheduleState.isOverdue).length,
                sourceCount: dueSources.length,
                sourceIds: dueSources.map((item) => item.source.id),
            });
            const history = await appendSavedProfileProxySourceBatchHistoryEntry(historyEntry);
            return {
                action: normalizedAction,
                total: dueSources.length,
                ok,
                failed,
                added,
                duplicateCount,
                linkedCount,
                staleCount,
                reactivatedCount,
                invalidCount,
                policyAffectedCount,
                sourceIds: dueSources.map((item) => item.source.id),
                sourceCount: dueSources.length,
                failures,
                historyEntry,
                history,
                list: await listSavedProfileProxySourcesWithUsage(),
            };
        }

        const settings = await readSettingsAsync();
        const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
        const nextSources = currentSources.map((item, index) => normalizeSavedProfileProxySource(item, index));
        const nextProxies = (Array.isArray(settings.savedProfileProxies) ? settings.savedProfileProxies : []).map((item, index) => normalizeSavedProfileProxy(item, index));
        const testMap = await buildSavedProfileProxyTestMap(nextProxies);
        const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];

        if (normalizedAction === 'quarantine-candidates') {
            const candidates = [];
            const sourceIds = new Set();
            for (const source of nextSources) {
                const targetId = normalizeSavedProfileProxySourceId(source && source.id);
                if (!targetId) continue;
                for (const proxy of getSavedProfileProxyEntriesForSource(nextProxies, targetId)) {
                    if (!isSavedProfileProxyQuarantineCandidate(proxy, testMap.get(normalizeSavedProfileProxyId(proxy && proxy.id)))) continue;
                    candidates.push(proxy);
                    sourceIds.add(targetId);
                }
            }
            if (candidates.length === 0) throw createHttpError(400, 'No candidate proxies reached the quarantine threshold');
            const selectedIds = new Set(candidates.map((proxy) => normalizeSavedProfileProxyId(proxy && proxy.id)).filter(Boolean));
            const affectedProfilesCount = (Array.isArray(profiles) ? profiles : [])
                .filter((profile) => selectedIds.has(normalizeSavedProfileProxyId(profile && profile.savedProxyId)))
                .length;
            let count = 0;
            for (const proxy of candidates) {
                if (proxy && proxy.enabled !== false) {
                    proxy.enabled = false;
                    count++;
                }
            }
            const saved = await replaceSavedProfileProxySourceState({
                savedProfileProxySources: nextSources,
                savedProfileProxies: nextProxies,
            }, settings);
            const historyEntry = normalizeSavedProfileProxySourceBatchHistoryEntry({
                action: normalizedAction,
                finishedAt: Date.now(),
                total: candidates.length,
                ok: count,
                failed: 0,
                quarantined: count,
                candidateCount: candidates.length,
                sourceCount: sourceIds.size,
                affectedProfilesCount,
                sourceIds: [...sourceIds],
            });
            const history = await appendSavedProfileProxySourceBatchHistoryEntry(historyEntry, saved.settings);
            return {
                action: normalizedAction,
                count,
                total: candidates.length,
                ok: count,
                failed: 0,
                quarantined: count,
                candidateCount: candidates.length,
                sourceCount: sourceIds.size,
                affectedProfilesCount,
                sourceIds: [...sourceIds],
                historyEntry,
                history,
                list: saved.sources || [],
            };
        }

        const quarantinedEntries = [];
        const sourceIds = new Set();
        for (const source of nextSources) {
            const targetId = normalizeSavedProfileProxySourceId(source && source.id);
            if (!targetId) continue;
            for (const proxy of getSavedProfileProxyEntriesForSource(nextProxies, targetId)) {
                if (!isSavedProfileProxyQuarantined(proxy, testMap.get(normalizeSavedProfileProxyId(proxy && proxy.id)))) continue;
                quarantinedEntries.push(proxy);
                sourceIds.add(targetId);
            }
        }
        if (quarantinedEntries.length === 0) throw createHttpError(400, 'No quarantined proxies found across saved proxy sources');
        const result = await retestSavedProfileProxyEntriesForSource(quarantinedEntries, { reenableRecovered: true });
        const saved = result.recoveredCount > 0
            ? await replaceSavedProfileProxySourceState({
                savedProfileProxySources: nextSources,
                savedProfileProxies: nextProxies,
            }, settings)
            : { settings: await readSettingsAsync(), sources: await listSavedProfileProxySourcesWithUsage() };
        const historyEntry = normalizeSavedProfileProxySourceBatchHistoryEntry({
            action: normalizedAction,
            finishedAt: Date.now(),
            total: Number(result.total || quarantinedEntries.length || 0),
            ok: Math.max(0, Number(result.total || quarantinedEntries.length || 0) - Number(result.failed || 0)),
            failed: Number(result.failed || 0),
            recovered: Number(result.recoveredCount || 0),
            sourceCount: sourceIds.size,
            sourceIds: [...sourceIds],
        });
        const history = await appendSavedProfileProxySourceBatchHistoryEntry(historyEntry, saved.settings);
        return {
            action: normalizedAction,
            ...result,
            sourceCount: sourceIds.size,
            sourceIds: [...sourceIds],
            historyEntry,
            history,
            list: saved.sources || [],
        };
    } finally {
        savedProfileProxySourceOverviewActionLock = false;
    }
}

function getSavedProfileProxySourceAttentionTargets(sources, now = Date.now()) {
    const targets = [];
    for (const source of Array.isArray(sources) ? sources : []) {
        const targetId = normalizeSavedProfileProxySourceId(source && source.id);
        if (!targetId) continue;
        const scheduleState = getSavedProfileProxySourceScheduleState(source, now);
        const reasons = [];
        if (scheduleState.isDueNow) reasons.push('due-now');
        else if (scheduleState.isOverdue) reasons.push('overdue');
        if (normalizeSavedProfileProxySourceMaintenanceStatus(source && source.lastMaintenanceStatus) === 'error') reasons.push('error');
        if (Number(source && source.healthCandidateCount || 0) > 0) reasons.push('candidate');
        if (reasons.length === 0) continue;
        targets.push({
            id: targetId,
            label: String(source && (source.name || source.id) || '').trim() || targetId,
            reasons,
        });
    }
    return targets;
}

function summarizeSavedProfileProxySourceAttentionTargets(targets) {
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

async function runSavedProfileProxySourcesAttentionMaintenance() {
    if (savedProfileProxySourceOverviewActionLock) {
        throw createHttpError(409, 'Saved proxy source overview action is already running');
    }
    if (savedProfileProxySourceMaintenanceLocks.size > 0) {
        throw createHttpError(409, 'A saved proxy source maintenance task is already running');
    }

    savedProfileProxySourceOverviewActionLock = true;
    try {
        const sources = await listSavedProfileProxySourcesWithUsage();
        const targets = getSavedProfileProxySourceAttentionTargets(sources);
        if (targets.length === 0) {
            throw createHttpError(400, 'No saved proxy source currently needs overview maintenance');
        }
        const targetSummary = summarizeSavedProfileProxySourceAttentionTargets(targets);
        let ok = 0;
        let failed = 0;
        let added = 0;
        let quarantined = 0;
        let recovered = 0;
        const failures = [];
        for (const target of targets) {
            try {
                const result = await runSavedProfileProxySourceMaintenance(target.id, { trigger: 'manual' });
                const refreshResult = result && result.refreshResult && result.refreshResult.importResult ? result.refreshResult.importResult : {};
                ok++;
                added += Number(refreshResult.addedCount || refreshResult.importedCount || 0);
                quarantined += Number(result && result.quarantineResult && result.quarantineResult.count || 0);
                recovered += Number(result && result.recheckResult && result.recheckResult.recoveredCount || 0);
            } catch (e) {
                failed++;
                failures.push({
                    sourceId: target.id,
                    label: target.label,
                    error: e && e.message ? e.message : String(e),
                });
            }
        }
        const historyEntry = normalizeSavedProfileProxySourceBatchHistoryEntry({
            action: 'attention-maintenance',
            finishedAt: Date.now(),
            total: targets.length,
            ok,
            failed,
            added,
            quarantined,
            recovered,
            dueCount: targetSummary.due,
            overdueCount: targetSummary.overdue,
            errorCount: targetSummary.error,
            candidateCount: targetSummary.candidate,
            sourceCount: targets.length,
            sourceIds: targets.map((item) => item.id),
        });
        const history = await appendSavedProfileProxySourceBatchHistoryEntry(historyEntry);
        return {
            action: 'attention-maintenance',
            total: targets.length,
            ok,
            failed,
            added,
            quarantined,
            recovered,
            dueCount: targetSummary.due,
            overdueCount: targetSummary.overdue,
            errorCount: targetSummary.error,
            candidateCount: targetSummary.candidate,
            sourceCount: targets.length,
            sourceIds: targets.map((item) => item.id),
            failures,
            historyEntry,
            history,
            list: await listSavedProfileProxySourcesWithUsage(),
        };
    } finally {
        savedProfileProxySourceOverviewActionLock = false;
    }
}

function getSavedProfileProxySourceMaintenanceBaseTime(source) {
    return Math.max(
        Number(source && source.lastMaintenanceAt) || 0,
        Number(source && source.lastSyncAt) || 0,
        Number(source && source.lastImportedAt) || 0,
    );
}

function getSavedProfileProxySourceScheduleState(source, now = Date.now()) {
    const normalized = normalizeSavedProfileProxySource(source);
    const intervalMinutes = normalizeSavedProfileProxySourceScheduleIntervalMinutes(normalized.scheduleIntervalMinutes) || 0;
    const baseTime = getSavedProfileProxySourceMaintenanceBaseTime(normalized);
    const nextDueAt = normalized.scheduleEnabled === true && intervalMinutes > 0 && baseTime > 0
        ? baseTime + intervalMinutes * 60 * 1000
        : 0;
    const isDueNow = normalized.scheduleEnabled === true && intervalMinutes > 0 && baseTime <= 0;
    const delta = nextDueAt > 0 ? nextDueAt - now : 0;
    const isOverdue = normalized.scheduleEnabled === true && !isDueNow && nextDueAt > 0 && delta <= 0;
    return {
        scheduleEnabled: normalized.scheduleEnabled === true,
        intervalMinutes,
        baseTime,
        nextDueAt,
        delta,
        isDueNow,
        isOverdue,
    };
}

function isSavedProfileProxySourceMaintenanceDue(source, now = Date.now()) {
    const normalized = normalizeSavedProfileProxySource(source);
    if (!normalized.id || normalized.enabled === false) return false;
    const scheduleState = getSavedProfileProxySourceScheduleState(normalized, now);
    return scheduleState.isDueNow || scheduleState.isOverdue;
}

async function runSavedProfileProxySourceMaintenance(sourceId, options = {}) {
    const targetId = normalizeSavedProfileProxySourceId(sourceId);
    if (!targetId) throw createHttpError(400, 'sourceId is required');
    const trigger = normalizeSavedProfileProxySourceMaintenanceTrigger(options.trigger) || 'manual';
    const skipIfBusy = options.skipIfBusy === true;
    if (savedProfileProxySourceMaintenanceLocks.has(targetId)) {
        if (skipIfBusy) {
            return {
                action: 'run-maintenance',
                skipped: true,
                busy: true,
                trigger,
                source: (await listSavedProfileProxySourcesWithUsage()).find((item) => item.id === targetId) || null,
            };
        }
        throw createHttpError(409, `Saved proxy source "${targetId}" maintenance is already running`);
    }

    savedProfileProxySourceMaintenanceLocks.add(targetId);
    try {
        const settings = await readSettingsAsync();
        const currentSources = Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [];
        const sourceIndex = findSavedProfileProxySourceIndexById(currentSources, targetId);
        if (sourceIndex < 0) throw createHttpError(404, `Saved proxy source "${targetId}" not found`);
        const source = normalizeSavedProfileProxySource(currentSources[sourceIndex], sourceIndex);
        const refreshResult = await refreshSavedProfileProxySourceEntry(targetId);

        let quarantineResult = {
            action: 'quarantine-failed',
            skipped: source.autoQuarantineOnRefresh !== true,
            count: 0,
            affectedProfilesCount: 0,
        };
        if (source.autoQuarantineOnRefresh === true) {
            try {
                quarantineResult = await runSavedProfileProxySourceHealthAction(targetId, 'quarantine-failed');
            } catch (e) {
                if (!(e && e.status === 400)) throw e;
                quarantineResult = {
                    action: 'quarantine-failed',
                    skipped: true,
                    count: 0,
                    affectedProfilesCount: 0,
                    reason: e && e.message ? e.message : String(e),
                };
            }
        }

        let recheckResult = {
            action: 'recheck-quarantined',
            skipped: source.autoRecheckQuarantinedOnRefresh !== true,
            total: 0,
            failed: 0,
            recoveredCount: 0,
            results: [],
        };
        if (source.autoRecheckQuarantinedOnRefresh === true) {
            try {
                recheckResult = await runSavedProfileProxySourceHealthAction(targetId, 'recheck-quarantined');
            } catch (e) {
                if (!(e && e.status === 400)) throw e;
                recheckResult = {
                    action: 'recheck-quarantined',
                    skipped: true,
                    total: 0,
                    failed: 0,
                    recoveredCount: 0,
                    results: [],
                    reason: e && e.message ? e.message : String(e),
                };
            }
        }

        const latestSourceUsage = (await listSavedProfileProxySourcesWithUsage()).find((item) => item.id === targetId) || null;
        const maintenanceEntry = normalizeSavedProfileProxySourceMaintenanceEntry({
            ranAt: Date.now(),
            status: 'ok',
            trigger,
            error: '',
            quarantinedCount: Number(quarantineResult.count || 0),
            recoveredCount: Number(recheckResult.recoveredCount || 0),
            candidateCountAfter: Number(latestSourceUsage && latestSourceUsage.healthCandidateCount || 0),
            quarantinedCountAfter: Number(latestSourceUsage && latestSourceUsage.healthQuarantinedCount || 0),
        });
        const latestSettings = await readSettingsAsync();
        const latestSources = Array.isArray(latestSettings.savedProfileProxySources) ? latestSettings.savedProfileProxySources : [];
        const latestSourceIndex = findSavedProfileProxySourceIndexById(latestSources, targetId);
        const latestSource = latestSourceIndex >= 0
            ? normalizeSavedProfileProxySource(latestSources[latestSourceIndex], latestSourceIndex)
            : normalizeSavedProfileProxySource({ id: targetId });
        const maintenanceHistory = pushSavedProfileProxySourceMaintenanceEntry(latestSource, maintenanceEntry);
        const finalized = await patchSavedProfileProxySourceRuntimeState(targetId, {
            lastMaintenanceAt: latestSource.lastMaintenanceAt,
            lastMaintenanceStatus: latestSource.lastMaintenanceStatus,
            lastMaintenanceTrigger: latestSource.lastMaintenanceTrigger,
            lastMaintenanceError: latestSource.lastMaintenanceError,
            lastMaintenanceQuarantinedCount: latestSource.lastMaintenanceQuarantinedCount,
            lastMaintenanceRecoveredCount: latestSource.lastMaintenanceRecoveredCount,
            maintenanceHistory,
        }, latestSettings);
        return {
            action: 'run-maintenance',
            trigger,
            source: finalized.item,
            refreshResult,
            quarantineResult,
            recheckResult,
        };
    } catch (e) {
        try {
            const latestSourceUsage = (await listSavedProfileProxySourcesWithUsage()).find((item) => item.id === targetId) || null;
            const maintenanceEntry = normalizeSavedProfileProxySourceMaintenanceEntry({
                ranAt: Date.now(),
                status: 'error',
                trigger,
                error: e && e.message ? e.message : String(e),
                quarantinedCount: 0,
                recoveredCount: 0,
                candidateCountAfter: Number(latestSourceUsage && latestSourceUsage.healthCandidateCount || 0),
                quarantinedCountAfter: Number(latestSourceUsage && latestSourceUsage.healthQuarantinedCount || 0),
            });
            const latestSettings = await readSettingsAsync();
            const latestSources = Array.isArray(latestSettings.savedProfileProxySources) ? latestSettings.savedProfileProxySources : [];
            const latestSourceIndex = findSavedProfileProxySourceIndexById(latestSources, targetId);
            const latestSource = latestSourceIndex >= 0
                ? normalizeSavedProfileProxySource(latestSources[latestSourceIndex], latestSourceIndex)
                : normalizeSavedProfileProxySource({ id: targetId });
            const maintenanceHistory = pushSavedProfileProxySourceMaintenanceEntry(latestSource, maintenanceEntry);
            await patchSavedProfileProxySourceRuntimeState(targetId, {
                lastMaintenanceAt: latestSource.lastMaintenanceAt,
                lastMaintenanceStatus: latestSource.lastMaintenanceStatus,
                lastMaintenanceTrigger: latestSource.lastMaintenanceTrigger,
                lastMaintenanceError: latestSource.lastMaintenanceError,
                lastMaintenanceQuarantinedCount: latestSource.lastMaintenanceQuarantinedCount,
                lastMaintenanceRecoveredCount: latestSource.lastMaintenanceRecoveredCount,
                maintenanceHistory,
            }, latestSettings);
        } catch (inner) { }
        throw e;
    } finally {
        savedProfileProxySourceMaintenanceLocks.delete(targetId);
    }
}

async function runSavedProfileProxySourceMaintenanceSchedulerTick() {
    if (savedProfileProxySourceMaintenanceTickRunning) return;
    savedProfileProxySourceMaintenanceTickRunning = true;
    try {
        const settings = await readSettingsAsync();
        const sources = (Array.isArray(settings.savedProfileProxySources) ? settings.savedProfileProxySources : [])
            .map((item, index) => normalizeSavedProfileProxySource(item, index))
            .filter((source) => isSavedProfileProxySourceMaintenanceDue(source));
        for (const source of sources) {
            try {
                await runSavedProfileProxySourceMaintenance(source.id, { trigger: 'scheduler', skipIfBusy: true });
            } catch (e) {
                console.error(`[Saved Proxy Source Scheduler] ${source.id}: ${e && e.message ? e.message : String(e)}`);
            }
        }
    } catch (e) {
        console.error('[Saved Proxy Source Scheduler] tick failed:', e && e.message ? e.message : String(e));
    } finally {
        savedProfileProxySourceMaintenanceTickRunning = false;
    }
}

function startSavedProfileProxySourceMaintenanceScheduler() {
    if (savedProfileProxySourceMaintenanceTimer) clearInterval(savedProfileProxySourceMaintenanceTimer);
    savedProfileProxySourceMaintenanceTimer = setInterval(() => {
        void runSavedProfileProxySourceMaintenanceSchedulerTick();
    }, SAVED_PROFILE_PROXY_SOURCE_SCHEDULER_POLL_MS);
    void runSavedProfileProxySourceMaintenanceSchedulerTick();
}

function normalizeRequestedProfileIds(profileIds) {
    const out = [];
    for (const item of Array.isArray(profileIds) ? profileIds : []) {
        const id = String(item || '').trim();
        if (!id || out.includes(id)) continue;
        out.push(id);
    }
    return out;
}

async function batchUpdateSavedProfileProxyBindings(options = {}) {
    const profileIds = normalizeRequestedProfileIds(options.profileIds);
    if (profileIds.length === 0) throw createHttpError(400, 'profileIds is required');

    const clear = !!options.clear;
    const syncFallbackProxyStr = options.syncFallbackProxyStr !== false;
    const sourceSavedProxyId = normalizeSavedProfileProxyId(options.sourceSavedProxyId);
    const targetSavedProxyId = normalizeSavedProfileProxyId(options.savedProxyId);
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = await readSettingsAsync();
    const targetSavedProxy = clear ? null : findSavedProfileProxyById(settings, targetSavedProxyId);

    if (!clear && !targetSavedProxyId) throw createHttpError(400, 'savedProxyId is required');
    if (!clear && !targetSavedProxy) throw createHttpError(404, `Saved proxy "${targetSavedProxyId}" not found`);

    const targetSet = new Set(profileIds);
    let matchedCount = 0;
    let updatedCount = 0;
    const updatedProfileIds = [];

    for (const profile of profiles) {
        const profileId = String(profile && profile.id || '').trim();
        if (!targetSet.has(profileId)) continue;
        const currentSavedProxyId = normalizeSavedProfileProxyId(profile && profile.savedProxyId);
        if (sourceSavedProxyId && currentSavedProxyId !== sourceSavedProxyId) continue;

        matchedCount++;
        if (clear) {
            if (!currentSavedProxyId) continue;
            const resolvedBinding = resolveProfileProxyBinding(profile, settings, null);
            profile.savedProxyId = '';
            if (syncFallbackProxyStr) {
                profile.proxyStr = String(resolvedBinding && resolvedBinding.proxyStr || profile.proxyStr || '').trim();
            }
            updatedCount++;
            updatedProfileIds.push(profileId);
            continue;
        }

        const nextProxyStr = String(targetSavedProxy && targetSavedProxy.proxyStr || '').trim();
        const currentProxyStr = String(profile && profile.proxyStr || '').trim();
        if (currentSavedProxyId === targetSavedProxy.id && (!syncFallbackProxyStr || currentProxyStr === nextProxyStr)) {
            continue;
        }
        profile.savedProxyId = targetSavedProxy.id;
        if (syncFallbackProxyStr) profile.proxyStr = nextProxyStr;
        updatedCount++;
        updatedProfileIds.push(profileId);
    }

    if (updatedCount > 0) {
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh();
    }

    return {
        profileIds,
        matchedCount,
        updatedCount,
        updatedProfileIds,
        sourceSavedProxyId,
        savedProxyId: clear ? '' : targetSavedProxy.id,
        savedProxyName: clear ? '' : (targetSavedProxy.name || targetSavedProxy.id),
        cleared: clear,
        syncFallbackProxyStr,
    };
}

async function batchAssignRandomSavedProfileProxyBindings(options = {}) {
    const profileIds = normalizeRequestedProfileIds(options.profileIds);
    if (profileIds.length === 0) throw createHttpError(400, 'profileIds is required');

    const strategy = String(options.strategy || 'random').trim().toLowerCase() === 'least-used'
        ? 'least-used'
        : 'random';
    const tag = String(options.tag || '').trim().toLowerCase();
    const group = normalizeSavedProfileProxyGroup(options.group).toLowerCase();
    const syncFallbackProxyStr = options.syncFallbackProxyStr !== false;
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = await readSettingsAsync();
    const usage = buildSavedProfileProxyUsageMap(profiles);
    const candidates = filterSavedProfileProxyCandidates(settings.savedProfileProxies || [], { tag, group });

    if (candidates.length === 0) {
        const filterText = [tag ? `tag "${tag}"` : '', group ? `group "${group}"` : ''].filter(Boolean).join(' + ');
        throw createHttpError(404, filterText ? `No saved proxies found for ${filterText}` : 'No saved proxies available');
    }

    const targetSet = new Set(profileIds);
    const selectedProfiles = profiles.filter((profile) => targetSet.has(String(profile && profile.id || '').trim()));
    const pool = [...candidates];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const assigned = [];
    let updatedCount = 0;
    for (let index = 0; index < selectedProfiles.length; index++) {
        const profile = selectedProfiles[index];
        let selectedProxy = null;
        if (strategy === 'least-used') {
            selectedProxy = [...pool].sort((a, b) => {
                const usageDiff = Number(usage[a.id] || 0) - Number(usage[b.id] || 0);
                if (usageDiff !== 0) return usageDiff;
                return String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: 'base' });
            })[0] || null;
        } else {
            selectedProxy = pool[index % pool.length] || null;
        }
        if (!selectedProxy) continue;

        const nextProxyStr = String(selectedProxy.proxyStr || '').trim();
        const currentSavedProxyId = normalizeSavedProfileProxyId(profile && profile.savedProxyId);
        const currentProxyStr = String(profile && profile.proxyStr || '').trim();
        if (currentSavedProxyId === selectedProxy.id && (!syncFallbackProxyStr || currentProxyStr === nextProxyStr)) {
            assigned.push({ profileId: profile.id, savedProxyId: selectedProxy.id, savedProxyName: selectedProxy.name || selectedProxy.id });
            continue;
        }

        profile.savedProxyId = selectedProxy.id;
        if (syncFallbackProxyStr) profile.proxyStr = nextProxyStr;
        usage[selectedProxy.id] = Number(usage[selectedProxy.id] || 0) + 1;
        updatedCount++;
        assigned.push({ profileId: profile.id, savedProxyId: selectedProxy.id, savedProxyName: selectedProxy.name || selectedProxy.id });
    }

    if (updatedCount > 0) {
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh();
    }

    return {
        profileIds,
        candidateCount: pool.length,
        updatedCount,
        strategy,
        tag,
        group,
        assigned,
        syncFallbackProxyStr,
    };
}

function getProfilePermissionMode(profile, permissionKey) {
    const field = PERMISSION_PROFILE_FIELDS[permissionKey];
    return resolvePermissionMode(field ? (profile && profile[field]) : undefined);
}

function resolvePermissionState(permissionKey, profile, runtimeContext) {
    const mode = getProfilePermissionMode(profile, permissionKey);
    if (mode !== PERMISSION_MODE_AUTO) return mode;
    if (permissionKey === 'geolocation') return runtimeContext && runtimeContext.geolocation ? 'granted' : 'prompt';
    return 'prompt';
}

function resolveGeoPermissionState(profile, runtimeContext) {
    return resolvePermissionState('geolocation', profile, runtimeContext);
}

function resolveRuntimePermissionStates(profile, runtimeContext) {
    const states = {
        geolocation: resolvePermissionState('geolocation', profile, runtimeContext),
        camera: resolvePermissionState('camera', profile, runtimeContext),
        microphone: resolvePermissionState('microphone', profile, runtimeContext),
        notifications: resolvePermissionState('notifications', profile, runtimeContext),
    };
    if (runtimeContext) {
        runtimeContext.permissionStates = states;
        runtimeContext.geoPermissionState = states.geolocation;
        runtimeContext.cameraPermissionState = states.camera;
        runtimeContext.microphonePermissionState = states.microphone;
        runtimeContext.notificationPermissionState = states.notifications;
    }
    return states;
}

function resolveHeaderPresets(settings) {
    const normalized = normalizeSettings(settings);
    return Array.isArray(normalized.headerPresets) ? normalized.headerPresets : [];
}

function resolveDiagnosticPresets(settings) {
    const normalized = normalizeSettings(settings);
    return Array.isArray(normalized.diagnosticPresets) ? normalized.diagnosticPresets : [];
}

function findHeaderPresetById(settings, presetId) {
    const id = String(presetId || '').trim();
    if (!id) return null;
    return resolveHeaderPresets(settings).find(item => item.id === id) || null;
}

function buildHeaderTemplateVariables(runtimeContext, launchFingerprint) {
    return {
        resolvedLanguage: String(runtimeContext && runtimeContext.language || '').trim(),
        resolvedAcceptLanguage: String(runtimeContext && runtimeContext.acceptLanguage || '').trim(),
        resolvedTimezone: String(runtimeContext && runtimeContext.timezone || '').trim(),
        countryCode: String(runtimeContext && runtimeContext.countryCode || '').trim(),
        userAgent: String(launchFingerprint && launchFingerprint.userAgent || '').trim(),
        platform: String(launchFingerprint && launchFingerprint.platform || '').trim(),
    };
}

function renderHeaderValueTemplate(template, variables) {
    const source = String(template || '');
    const vars = isPlainObject(variables) ? variables : {};
    return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(vars[key] || ''));
}

function hostMatchesPattern(hostname, pattern) {
    const host = String(hostname || '').trim().toLowerCase();
    const rule = String(pattern || '').trim().toLowerCase();
    if (!host || !rule) return false;
    if (rule.startsWith('*.')) {
        const suffix = rule.slice(1);
        return host.endsWith(suffix);
    }
    return host === rule;
}

function headerRuleMatchesRequest(rule, request) {
    const current = normalizeHeaderRule(rule);
    const url = String(request && request.url || '').trim();
    const resourceType = String(request && request.resourceType || '').trim().toLowerCase();
    const match = current.match || { hosts: [], resourceTypes: [] };
    if (match.resourceTypes.length > 0 && !match.resourceTypes.includes(resourceType)) return false;
    if (match.hosts.length === 0) return true;
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return match.hosts.some(pattern => hostMatchesPattern(hostname, pattern));
    } catch (e) {
        return false;
    }
}

function applyHeaderPresetToHeaders(headers, preset, request, variables) {
    const currentHeaders = isPlainObject(headers) ? { ...headers } : {};
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    if (!normalizedPreset || normalizedPreset.enabled === false) return currentHeaders;
    for (const rule of normalizedPreset.rules) {
        if (!rule.enabled || !rule.header || !headerRuleMatchesRequest(rule, request)) continue;
        const headerName = rule.header;
        const headerNameLower = headerName.toLowerCase();
        for (const existingKey of Object.keys(currentHeaders)) {
            if (String(existingKey || '').trim().toLowerCase() === headerNameLower) delete currentHeaders[existingKey];
        }
        if (rule.action === 'set') currentHeaders[headerName] = renderHeaderValueTemplate(rule.valueTemplate, variables);
    }
    return currentHeaders;
}

function hasEnabledHeaderRules(preset) {
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    return !!(normalizedPreset && normalizedPreset.enabled !== false && normalizedPreset.rules.some(rule => rule.enabled !== false && rule.header));
}

function presetControlsHeader(preset, headerName) {
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    const targetName = String(headerName || '').trim().toLowerCase();
    if (!normalizedPreset || !targetName) return false;
    return normalizedPreset.rules.some((rule) => rule.enabled !== false && String(rule.header || '').trim().toLowerCase() === targetName);
}

function presetGloballySetsHeader(preset, headerName) {
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    const targetName = String(headerName || '').trim().toLowerCase();
    if (!normalizedPreset || !targetName) return false;
    return normalizedPreset.rules.some((rule) => {
        if (!rule || rule.enabled === false) return false;
        if (String(rule.action || '').trim().toLowerCase() !== 'set') return false;
        if (String(rule.header || '').trim().toLowerCase() !== targetName) return false;
        const match = isPlainObject(rule.match) ? rule.match : { hosts: [], resourceTypes: [] };
        const hosts = Array.isArray(match.hosts) ? match.hosts : [];
        const resourceTypes = Array.isArray(match.resourceTypes) ? match.resourceTypes : [];
        return hosts.length === 0 && resourceTypes.length === 0;
    });
}

function normalizeHeadersForComparison(headers) {
    const source = isPlainObject(headers) ? headers : {};
    return Object.keys(source)
        .map((key) => [String(key || '').trim().toLowerCase(), String(source[key] == null ? '' : source[key]).trim()])
        .filter(([key]) => !!key)
        .sort((a, b) => a[0].localeCompare(b[0]));
}

function areHeaderSetsEquivalent(left, right) {
    const a = normalizeHeadersForComparison(left);
    const b = normalizeHeadersForComparison(right);
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index][0] !== b[index][0] || a[index][1] !== b[index][1]) return false;
    }
    return true;
}

function serializeHeadersForFetchContinuation(headers) {
    const source = isPlainObject(headers) ? headers : {};
    return Object.keys(source)
        .map((name) => {
            const key = String(name || '').trim();
            if (!key) return null;
            return { name: key, value: String(source[name] == null ? '' : source[name]) };
        })
        .filter(Boolean);
}

function getFetchResourceType(resourceType) {
    const current = String(resourceType || '').trim().toLowerCase();
    const mapping = {
        document: 'Document',
        stylesheet: 'Stylesheet',
        image: 'Image',
        media: 'Media',
        font: 'Font',
        script: 'Script',
        texttrack: 'TextTrack',
        xhr: 'XHR',
        fetch: 'Fetch',
        prefetch: 'Prefetch',
        eventsource: 'EventSource',
        websocket: 'WebSocket',
        manifest: 'Manifest',
        signedexchange: 'SignedExchange',
        ping: 'Ping',
        cspviolationreport: 'CSPViolationReport',
        preflight: 'Preflight',
        other: 'Other',
    };
    return mapping[current] || '';
}

function buildFetchPatternsForHeaderPreset(preset) {
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    if (!normalizedPreset || normalizedPreset.enabled === false) return [];
    const rules = normalizedPreset.rules.filter(rule => rule.enabled !== false && rule.header);
    if (rules.length === 0) return [];
    if (rules.some(rule => !rule.match || !Array.isArray(rule.match.resourceTypes) || rule.match.resourceTypes.length === 0)) {
        return [{ urlPattern: '*', requestStage: 'Request' }];
    }
    const types = Array.from(new Set(rules.flatMap(rule => rule.match.resourceTypes || []).map(getFetchResourceType).filter(Boolean)));
    return types.length > 0
        ? types.map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Request' }))
        : [{ urlPattern: '*', requestStage: 'Request' }];
}

function shouldAttachHeaderRulesToTarget(target) {
    if (!target || typeof target.type !== 'function') return false;
    return new Set(['page', 'service_worker', 'shared_worker', 'worker']).has(String(target.type() || '').trim().toLowerCase());
}

async function detachHeaderRulesFromTarget(target) {
    const state = target && target[GEEKEZ_TARGET_HEADER_RULES_SESSION];
    if (!state) return;
    delete target[GEEKEZ_TARGET_HEADER_RULES_SESSION];
    const client = state.client;
    const onRequestPaused = state.onRequestPaused;
    try {
        if (client && typeof client.off === 'function' && onRequestPaused) client.off('Fetch.requestPaused', onRequestPaused);
    } catch (e) { }
    try {
        if (client) await client.send('Fetch.disable');
    } catch (e) { }
    try {
        if (client && typeof client.detach === 'function') await client.detach();
    } catch (e) { }
}

async function attachHeaderRulesToTarget(target, runtimeContext, launchFingerprint, headerPreset) {
    if (!shouldAttachHeaderRulesToTarget(target) || target[GEEKEZ_TARGET_HEADER_RULES_SESSION]) return;
    const normalizedPreset = headerPreset ? normalizeHeaderPreset(headerPreset) : null;
    if (!hasEnabledHeaderRules(normalizedPreset)) return;
    const templateVariables = buildHeaderTemplateVariables(runtimeContext, launchFingerprint);
    const patterns = buildFetchPatternsForHeaderPreset(normalizedPreset);
    try {
        const client = await target.createCDPSession();
        const onRequestPaused = async (event) => {
            const request = isPlainObject(event && event.request) ? event.request : {};
            const originalHeaders = isPlainObject(request.headers) ? request.headers : {};
            const nextHeaders = applyHeaderPresetToHeaders(
                originalHeaders,
                normalizedPreset,
                {
                    url: String(request.url || '').trim(),
                    resourceType: String(event && event.resourceType || '').trim().toLowerCase(),
                },
                templateVariables
            );
            try {
                if (areHeaderSetsEquivalent(originalHeaders, nextHeaders)) {
                    await client.send('Fetch.continueRequest', { requestId: event.requestId });
                } else {
                    await client.send('Fetch.continueRequest', {
                        requestId: event.requestId,
                        headers: serializeHeadersForFetchContinuation(nextHeaders),
                    });
                }
            } catch (e) {
                try {
                    await client.send('Fetch.continueRequest', { requestId: event.requestId });
                } catch (inner) { }
            }
        };
        await client.send('Fetch.enable', patterns.length > 0 ? { patterns } : {}).catch(async () => {
            await client.send('Fetch.enable').catch(() => { });
        });
        client.on('Fetch.requestPaused', onRequestPaused);
        target[GEEKEZ_TARGET_HEADER_RULES_SESSION] = { client, onRequestPaused };
    } catch (e) { }
}

async function attachHeaderRulesToBrowser(browser, runtimeContext, launchFingerprint, headerPreset) {
    if (!browser || !hasEnabledHeaderRules(headerPreset)) return;

    const attachToTarget = async (target) => {
        try {
            await attachHeaderRulesToTarget(target, runtimeContext, launchFingerprint, headerPreset);
        } catch (e) { }
    };

    try {
        const targets = typeof browser.targets === 'function' ? browser.targets() : [];
        await Promise.all((Array.isArray(targets) ? targets : []).map(attachToTarget));
    } catch (e) { }

    if (!browser[GEEKEZ_BROWSER_HEADER_RULES_LISTENER]) {
        browser[GEEKEZ_BROWSER_HEADER_RULES_LISTENER] = async (target) => {
            await attachToTarget(target);
        };
        try { browser.on('targetcreated', browser[GEEKEZ_BROWSER_HEADER_RULES_LISTENER]); } catch (e) { }
    }
    if (!browser[GEEKEZ_BROWSER_HEADER_RULES_DESTROY_LISTENER]) {
        browser[GEEKEZ_BROWSER_HEADER_RULES_DESTROY_LISTENER] = async (target) => {
            await detachHeaderRulesFromTarget(target);
        };
        try { browser.on('targetdestroyed', browser[GEEKEZ_BROWSER_HEADER_RULES_DESTROY_LISTENER]); } catch (e) { }
    }
}

function buildHeaderPreview(preset, variables) {
    const normalizedPreset = preset ? normalizeHeaderPreset(preset) : null;
    if (!normalizedPreset) return { presetId: '', name: '', enabled: false, rules: [] };
    return {
        presetId: normalizedPreset.id,
        name: normalizedPreset.name,
        enabled: normalizedPreset.enabled !== false,
        rules: normalizedPreset.rules.map(rule => ({
            id: rule.id,
            enabled: rule.enabled,
            action: rule.action,
            header: rule.header,
            value: rule.action === 'set' ? renderHeaderValueTemplate(rule.valueTemplate, variables) : '',
            match: rule.match,
        })),
    };
}

function buildObservedBrowserHeaders(headers) {
    const current = headers || {};
    return {
        acceptLanguage: String(current['accept-language'] || '').trim(),
        userAgent: String(current['user-agent'] || '').trim(),
        secChUa: String(current['sec-ch-ua'] || '').trim(),
        secChUaMobile: String(current['sec-ch-ua-mobile'] || '').trim(),
        secChUaPlatform: String(current['sec-ch-ua-platform'] || '').trim(),
        secChUaFullVersionList: String(current['sec-ch-ua-full-version-list'] || '').trim(),
        secChUaArch: String(current['sec-ch-ua-arch'] || '').trim(),
        secChUaBitness: String(current['sec-ch-ua-bitness'] || '').trim(),
        secChUaPlatformVersion: String(current['sec-ch-ua-platform-version'] || '').trim(),
        secChUaModel: String(current['sec-ch-ua-model'] || '').trim(),
        secChUaWow64: String(current['sec-ch-ua-wow64'] || '').trim(),
    };
}

function applyAcceptChProbeHeaders(res) {
    const value = ACCEPT_CH_PROBE_HEADERS.join(', ');
    res.setHeader('Accept-CH', value);
    res.setHeader('Vary', ['Accept-CH', ...ACCEPT_CH_PROBE_HEADERS].join(', '));
    res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function getProfileDiagnosticsFile(profileId) {
    return path.join(DATA_PATH, profileId, 'diagnostics.json');
}

function getProfileProxyTestFile(profileId) {
    return path.join(DATA_PATH, profileId, 'proxy-test.json');
}

function getSavedProfileProxyTestFile(savedProxyId) {
    return path.join(DATA_PATH, '_saved_proxy_tests', `${encodeURIComponent(String(savedProxyId || '').trim())}.json`);
}

function normalizeProxyTestResult(result) {
    const current = isPlainObject(result) ? result : {};
    const checkedAt = Number(current.checkedAt);
    const latencyMs = Number(current.latencyMs);
    const lastSuccessAt = Number(current.lastSuccessAt);
    const lastFailureAt = Number(current.lastFailureAt);
    const failureStreak = Number(current.failureStreak);
    return {
        success: current.success === true,
        status: ['ok', 'warn', 'info'].includes(String(current.status || '').trim().toLowerCase())
            ? String(current.status).trim().toLowerCase()
            : (current.success === true ? 'ok' : 'warn'),
        mode: String(current.mode || '').trim() || 'ephemeral',
        direct: current.direct === true,
        running: current.running === true,
        proxyType: String(current.proxyType || '').trim(),
        checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : 0,
        latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : null,
        checkedUrl: String(current.checkedUrl || '').trim(),
        statusCode: Number.isFinite(Number(current.statusCode)) ? Number(current.statusCode) : null,
        ip: String(current.ip || '').trim(),
        country: String(current.country || '').trim(),
        region: String(current.region || '').trim(),
        city: String(current.city || '').trim(),
        timezone: String(current.timezone || '').trim(),
        postal: String(current.postal || '').trim(),
        org: String(current.org || '').trim(),
        asn: String(current.asn || '').trim(),
        source: String(current.source || '').trim(),
        proxySource: String(current.proxySource || '').trim(),
        savedProxyId: normalizeSavedProfileProxyId(current.savedProxyId),
        savedProxyName: String(current.savedProxyName || '').trim(),
        proxyBindingBroken: current.proxyBindingBroken === true,
        proxySnapshot: String(current.proxySnapshot || '').trim(),
        lastSuccessAt: Number.isFinite(lastSuccessAt) && lastSuccessAt > 0 ? lastSuccessAt : 0,
        lastFailureAt: Number.isFinite(lastFailureAt) && lastFailureAt > 0 ? lastFailureAt : 0,
        failureStreak: Number.isFinite(failureStreak) && failureStreak > 0 ? Math.round(failureStreak) : 0,
        summary: String(current.summary || '').trim(),
        error: String(current.error || '').trim(),
    };
}

function mergeProxyTestHistory(result, previousResult = null) {
    const next = normalizeProxyTestResult(result);
    const prev = normalizeProxyTestResult(previousResult);
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

async function readProfileProxyTestResult(profileId) {
    const file = getProfileProxyTestFile(profileId);
    try {
        if (!fs.existsSync(file)) return null;
        return normalizeProxyTestResult(await fs.readJson(file));
    } catch (e) {
        return null;
    }
}

async function writeProfileProxyTestResult(profileId, result) {
    const file = getProfileProxyTestFile(profileId);
    const normalized = normalizeProxyTestResult(result);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, normalized);
    return normalized;
}

async function readSavedProfileProxyTestResult(savedProxyId) {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) return null;
    const file = getSavedProfileProxyTestFile(id);
    try {
        if (!fs.existsSync(file)) return null;
        return normalizeProxyTestResult(await fs.readJson(file));
    } catch (e) {
        return null;
    }
}

async function writeSavedProfileProxyTestResult(savedProxyId, result) {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) throw new Error('savedProxyId is required');
    const file = getSavedProfileProxyTestFile(id);
    const normalized = normalizeProxyTestResult(result);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, normalized);
    return normalized;
}

async function deleteSavedProfileProxyTestResult(savedProxyId) {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) return;
    const file = getSavedProfileProxyTestFile(id);
    try {
        if (fs.existsSync(file)) await fs.remove(file);
    } catch (e) { }
}

async function persistSavedProfileProxyTestResult(savedProxyId, result, options = {}) {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) throw new Error('savedProxyId is required');
    const current = normalizeProxyTestResult({
        ...(isPlainObject(result) ? result : {}),
        savedProxyId: id,
        proxySource: 'saved-library',
    });
    const previous = options && options.mergeHistory === false ? null : await readSavedProfileProxyTestResult(id);
    const output = previous
        ? mergeProxyTestHistory(current, previous)
        : current;
    await writeSavedProfileProxyTestResult(id, output);
    return output;
}

function sanitizeDiagnosticArtifactSegment(value) {
    const cleaned = String(value || '').trim().replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || 'artifact';
}

function buildDiagnosticRunId(openedAt, presetId) {
    return `${Number(openedAt) || Date.now()}-${sanitizeDiagnosticArtifactSegment(presetId)}`;
}

function getProfileDiagnosticArtifactsRoot(profileId) {
    return path.join(DATA_PATH, profileId, 'diagnostic-artifacts');
}

function getProfileDiagnosticArtifactDir(profileId, runId) {
    return path.join(getProfileDiagnosticArtifactsRoot(profileId), sanitizeDiagnosticArtifactSegment(runId));
}

function getDiagnosticArtifactFilePath(profileId, runId, kind) {
    const fileMap = {
        screenshot: 'page.png',
        html: 'page.html.txt',
        text: 'page.txt',
        json: 'page.json',
    };
    const name = fileMap[kind];
    if (!name) return '';
    return path.join(getProfileDiagnosticArtifactDir(profileId, runId), name);
}

function buildDiagnosticArtifactUrl(profileId, runId, kind) {
    return `/profiles/${encodeURIComponent(profileId)}/diagnostics/artifacts/${encodeURIComponent(runId)}/${kind}`;
}

function normalizeDiagnosticArtifacts(profileId, artifacts) {
    const current = isPlainObject(artifacts) ? artifacts : {};
    const runId = sanitizeDiagnosticArtifactSegment(current.runId || '');
    const available = [];
    const output = runId ? { runId } : {};
    for (const kind of ['screenshot', 'html', 'text', 'json']) {
        const urlKey = `${kind}Url`;
        const value = String(current[urlKey] || '').trim();
        if (value) {
            output[urlKey] = value;
            available.push(kind);
        } else if (runId && Array.isArray(current.available) && current.available.includes(kind)) {
            output[urlKey] = buildDiagnosticArtifactUrl(profileId, runId, kind);
            available.push(kind);
        }
    }
    if (available.length > 0) output.available = available;
    return output;
}

function normalizeDiagnosticFacts(facts, limit = 10) {
    const out = [];
    const seen = new Set();
    const maxItems = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 10;
    for (const item of Array.isArray(facts) ? facts : []) {
        const label = normalizeDiagnosticText(item && item.label, 42);
        const value = normalizeDiagnosticText(item && item.value, 180);
        const status = normalizeDiagnosticResultStatus(item && item.status);
        const key = `${label.toLowerCase()}::${value.toLowerCase()}`;
        if (!label || !value || seen.has(key)) continue;
        seen.add(key);
        out.push({ label, value, status });
        if (out.length >= maxItems) break;
    }
    return out;
}

async function readDiagnosticHistory(profileId) {
    const file = getProfileDiagnosticsFile(profileId);
    try {
        if (!fs.existsSync(file)) return [];
        const parsed = await fs.readJson(file);
        return Array.isArray(parsed && parsed.recentRuns) ? parsed.recentRuns.map(normalizeDiagnosticHistoryEntry) : [];
    } catch (e) {
        return [];
    }
}

async function writeDiagnosticHistory(profileId, recentRuns) {
    const file = getProfileDiagnosticsFile(profileId);
    const normalized = (Array.isArray(recentRuns) ? recentRuns : []).map(normalizeDiagnosticHistoryEntry).slice(0, 20);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, {
        recentRuns: normalized
    });
    await pruneDiagnosticArtifacts(profileId, normalized);
}

async function appendDiagnosticHistory(profileId, entry) {
    const current = await readDiagnosticHistory(profileId);
    current.unshift(entry);
    await writeDiagnosticHistory(profileId, current);
    return current.slice(0, 20);
}

async function pruneDiagnosticArtifacts(profileId, recentRuns) {
    const root = getProfileDiagnosticArtifactsRoot(profileId);
    if (!profileId || !fs.existsSync(root)) return;
    const keep = new Set(
        (Array.isArray(recentRuns) ? recentRuns : [])
            .map((item) => sanitizeDiagnosticArtifactSegment(item && item.result && item.result.artifacts && item.result.artifacts.runId))
            .filter(Boolean)
    );
    const entries = await fs.readdir(root).catch(() => []);
    await Promise.all(entries.map(async (name) => {
        const runId = sanitizeDiagnosticArtifactSegment(name);
        if (!runId || keep.has(runId)) return;
        await fs.remove(path.join(root, name)).catch(() => { });
    }));
    const leftovers = await fs.readdir(root).catch(() => []);
    if (leftovers.length === 0) await fs.remove(root).catch(() => { });
}

async function clearDiagnosticHistory(profileId) {
    await writeDiagnosticHistory(profileId, []);
    await fs.remove(getProfileDiagnosticArtifactsRoot(profileId)).catch(() => { });
}

function normalizeDiagnosticResultStatus(value) {
    const current = String(value || '').trim().toLowerCase();
    return ['ok', 'warn', 'info'].includes(current) ? current : 'info';
}

function normalizeDiagnosticText(text, maxLength = 220) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…` : value;
}

function dedupeDiagnosticLines(lines, limit = 6) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(lines) ? lines : []) {
        const value = normalizeDiagnosticText(item);
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= limit) break;
    }
    return out;
}

function pickDiagnosticSignalLines(lines, patterns, limit = 3) {
    const rules = Array.isArray(patterns) ? patterns : [];
    if (rules.length === 0) return [];
    return dedupeDiagnosticLines((Array.isArray(lines) ? lines : []).filter((line) => {
        const text = String(line || '');
        return rules.some((pattern) => pattern.test(text));
    }), limit);
}

function normalizeDiagnosticHistoryEntry(entry) {
    const current = isPlainObject(entry) ? entry : {};
    const result = isPlainObject(current.result) ? current.result : {};
    const profileId = String(current.profileId || '').trim();
    return {
        presetId: String(current.presetId || '').trim(),
        name: String(current.name || '').trim(),
        url: String(current.url || '').trim(),
        openedAt: Number(current.openedAt) || 0,
        profileId,
        result: {
            status: normalizeDiagnosticResultStatus(result.status),
            headline: normalizeDiagnosticText(result.headline, 120),
            summary: normalizeDiagnosticText(result.summary, 240),
            title: normalizeDiagnosticText(result.title, 180),
            finalUrl: normalizeDiagnosticText(result.finalUrl, 280),
            capturedAt: Number(result.capturedAt) || 0,
            signals: dedupeDiagnosticLines(result.signals, 4),
            facts: normalizeDiagnosticFacts(result.facts),
            artifacts: normalizeDiagnosticArtifacts(profileId, result.artifacts),
        }
    };
}

function buildDiagnosticFactMap(facts) {
    const map = new Map();
    for (const item of Array.isArray(facts) ? facts : []) {
        const label = normalizeDiagnosticText(item && item.label, 42);
        const value = normalizeDiagnosticText(item && item.value, 180);
        const status = normalizeDiagnosticResultStatus(item && item.status);
        if (!label || !value) continue;
        map.set(label.toLowerCase(), { label, value, status });
    }
    return map;
}

function buildDiagnosticRunComparison(currentEntry, previousEntry) {
    if (!currentEntry || !previousEntry) return null;
    const currentResult = isPlainObject(currentEntry.result) ? currentEntry.result : {};
    const previousResult = isPlainObject(previousEntry.result) ? previousEntry.result : {};
    const currentFacts = buildDiagnosticFactMap(currentResult.facts);
    const previousFacts = buildDiagnosticFactMap(previousResult.facts);
    const changeKeys = new Set([...currentFacts.keys(), ...previousFacts.keys()]);
    const changes = [];

    if (normalizeDiagnosticResultStatus(currentResult.status) !== normalizeDiagnosticResultStatus(previousResult.status)) {
        changes.push({
            label: 'Status',
            before: normalizeDiagnosticResultStatus(previousResult.status).toUpperCase(),
            after: normalizeDiagnosticResultStatus(currentResult.status).toUpperCase(),
            type: 'status',
        });
    }

    for (const key of changeKeys) {
        if (changes.length >= 4) break;
        const before = previousFacts.get(key);
        const after = currentFacts.get(key);
        if (!before && after) {
            changes.push({ label: after.label, before: '', after: after.value, type: 'added' });
            continue;
        }
        if (before && !after) {
            changes.push({ label: before.label, before: before.value, after: '', type: 'removed' });
            continue;
        }
        if (!before || !after) continue;
        if (before.value !== after.value || before.status !== after.status) {
            changes.push({ label: after.label, before: before.value, after: after.value, type: 'changed' });
        }
    }

    const summary = changes.length === 0
        ? 'No visible change vs previous run'
        : changes.length === 1
            ? `${changes[0].label}: ${changes[0].before || '∅'} → ${changes[0].after || '∅'}`
            : `${changes[0].label}: ${changes[0].before || '∅'} → ${changes[0].after || '∅'} · ${changes[1].label}: ${changes[1].before || '∅'} → ${changes[1].after || '∅'}`;

    return {
        previousOpenedAt: Number(previousEntry.openedAt) || 0,
        changed: changes.length > 0,
        changeCount: changes.length,
        summary: normalizeDiagnosticText(summary, 240),
        changes: changes.map((item) => ({
            label: normalizeDiagnosticText(item.label, 42),
            before: normalizeDiagnosticText(item.before, 180),
            after: normalizeDiagnosticText(item.after, 180),
            type: String(item.type || 'changed').trim() || 'changed',
        })),
    };
}

function pushDiagnosticFact(facts, label, value, status = 'info') {
    if (!Array.isArray(facts)) return;
    const normalizedLabel = normalizeDiagnosticText(label, 42);
    const normalizedValue = normalizeDiagnosticText(value, 180);
    if (!normalizedLabel || !normalizedValue) return;
    facts.push({
        label: normalizedLabel,
        value: normalizedValue,
        status: normalizeDiagnosticResultStatus(status),
    });
}

function findDiagnosticLine(lines, patterns) {
    const source = Array.isArray(lines) ? lines : [];
    const rules = Array.isArray(patterns) ? patterns : [];
    if (rules.length === 0) return '';
    for (const line of source) {
        const text = String(line || '');
        if (!text) continue;
        if (rules.some((pattern) => pattern.test(text))) return normalizeDiagnosticText(text, 180);
    }
    return '';
}

function findDiagnosticValueAfterLine(lines, patterns, maxOffset = 3) {
    const source = Array.isArray(lines) ? lines : [];
    const rules = Array.isArray(patterns) ? patterns : [];
    if (rules.length === 0) return '';
    for (let index = 0; index < source.length; index += 1) {
        const current = String(source[index] || '');
        if (!current || !rules.some((pattern) => pattern.test(current))) continue;
        for (let offset = 1; offset <= maxOffset && index + offset < source.length; offset += 1) {
            const candidate = normalizeDiagnosticText(source[index + offset], 180);
            if (!candidate) continue;
            if (rules.some((pattern) => pattern.test(candidate))) continue;
            return candidate;
        }
    }
    return '';
}

function findDiagnosticValueInline(lines, patterns) {
    const source = Array.isArray(lines) ? lines : [];
    const rules = Array.isArray(patterns) ? patterns : [];
    if (rules.length === 0) return '';
    for (const line of source) {
        const text = String(line || '').trim();
        if (!text || !rules.some((pattern) => pattern.test(text))) continue;
        const parts = text.split(/\s*[:：]\s*/);
        if (parts.length >= 2) {
            const value = normalizeDiagnosticText(parts.slice(1).join(': '), 180);
            if (value) return value;
        }
    }
    return '';
}

function findDiagnosticValue(lines, patterns, maxOffset = 3) {
    const source = Array.isArray(lines) ? lines : [];
    const rules = Array.isArray(patterns) ? patterns : [];
    if (rules.length === 0) return '';
    for (let index = 0; index < source.length; index += 1) {
        const current = normalizeDiagnosticText(source[index], 180);
        if (!current) continue;
        for (const pattern of rules) {
            const match = current.match(pattern);
            if (!match) continue;
            const remainder = normalizeDiagnosticText(current.slice(match[0].length).replace(/^[:：\s-]+/, ''), 180);
            if (remainder) return remainder;
            for (let offset = 1; offset <= maxOffset && index + offset < source.length; offset += 1) {
                const candidate = normalizeDiagnosticText(source[index + offset], 180);
                if (!candidate) continue;
                if (rules.some((rule) => rule.test(candidate))) continue;
                return candidate;
            }
        }
    }
    return '';
}

function isDiagnosticPlaceholderValue(text) {
    const value = normalizeDiagnosticText(text, 180).toLowerCase();
    return !value || value === 'n/a' || value === 'na' || value === '-' || value === '()';
}

function findDiagnosticValueSmart(lines, patterns, { maxOffset = 4, skipPatterns = [], reject = null } = {}) {
    const source = Array.isArray(lines) ? lines : [];
    const rules = Array.isArray(patterns) ? patterns : [];
    const skips = Array.isArray(skipPatterns) ? skipPatterns : [];
    if (rules.length === 0) return '';

    const acceptCandidate = (candidate, index) => {
        const normalized = normalizeDiagnosticText(candidate, 180);
        if (!normalized) return '';
        if (rules.some((rule) => rule.test(normalized))) return '';
        if (skips.some((rule) => rule.test(normalized))) return '';
        if (typeof reject === 'function' && reject(normalized, index, source)) return '';
        return normalized;
    };

    for (let index = 0; index < source.length; index += 1) {
        const current = normalizeDiagnosticText(source[index], 180);
        if (!current) continue;
        for (const pattern of rules) {
            const match = current.match(pattern);
            if (!match) continue;
            const remainder = acceptCandidate(current.slice(match[0].length).replace(/^[:：\s-]+/, ''), index);
            if (remainder) return remainder;
            for (let offset = 1; offset <= maxOffset && index + offset < source.length; offset += 1) {
                const candidate = acceptCandidate(source[index + offset], index + offset);
                if (candidate) return candidate;
            }
        }
    }
    return '';
}

function findDiagnosticSectionValue(lines, sectionPatterns, valuePatterns, { searchWindow = 36, ...options } = {}) {
    const source = Array.isArray(lines) ? lines : [];
    const sections = Array.isArray(sectionPatterns) ? sectionPatterns : [];
    const values = Array.isArray(valuePatterns) ? valuePatterns : [];
    if (sections.length === 0 || values.length === 0) return '';
    const size = Number.isFinite(Number(searchWindow)) ? Math.max(4, Number(searchWindow)) : 36;
    for (let index = 0; index < source.length; index += 1) {
        const current = normalizeDiagnosticText(source[index], 180);
        if (!current || !sections.some((pattern) => pattern.test(current))) continue;
        const scoped = source.slice(index, Math.min(source.length, index + size));
        const value = findDiagnosticValueSmart(scoped, values, options);
        if (value) return value;
    }
    return '';
}

function looksLikePixelscanBrowserMatrix(text) {
    const value = normalizeDiagnosticText(text, 180);
    if (!value) return false;
    const matches = value.match(/\b(?:chrome|opera|edge|safari|firefox|yandex|facebook|miui)\b/ig) || [];
    return matches.length >= 3 && value.includes(',');
}

function extractPrimaryLocaleCandidate(text) {
    const value = normalizeDiagnosticText(text, 180);
    if (!value) return '';
    const commonNoiseTokens = new Set(['to', 'go', 'no', 'my', 'ip', 'time', 'want']);
    const allowShortLocales = new Set(['en', 'zh', 'ru', 'fr', 'de', 'es', 'pt', 'ja', 'ko', 'it', 'nl', 'pl', 'tr', 'ar', 'hi', 'vi', 'th', 'id']);
    const tupleMatch = value.match(/\|\s*([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\)?$/i);
    if (tupleMatch && tupleMatch[1]) {
        const token = normalizeLocaleToken(tupleMatch[1]);
        if (!token) return '';
        if (!token.includes('-') && !allowShortLocales.has(token.toLowerCase())) return '';
        if (commonNoiseTokens.has(token.toLowerCase())) return '';
        return token;
    }
    const tokenMatch = value.match(/\b([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\b/i);
    if (!tokenMatch || !tokenMatch[1]) return '';
    const token = normalizeLocaleToken(tokenMatch[1]);
    if (!token) return '';
    if (commonNoiseTokens.has(token.toLowerCase())) return '';
    if (!token.includes('-') && !allowShortLocales.has(token.toLowerCase())) return '';
    return token;
}

function sanitizeDiagnosticPresetFactValue(presetId, label, value) {
    const normalizedLabel = normalizeDiagnosticText(label, 42).toLowerCase();
    const normalizedValue = normalizeDiagnosticText(value, 180);
    if (!normalizedValue) return '';

    if (presetId === 'builtin-pixelscan') {
        if (/how to fix it/i.test(normalizedValue) && /your browser fingerprint is inconsistent/i.test(normalizedValue)) {
            return 'Your Browser Fingerprint is inconsistent';
        }
        if ((normalizedLabel === 'overall' || normalizedLabel === 'fingerprint') && /your browser fingerprint is inconsistent/i.test(normalizedValue)) {
            return 'Your Browser Fingerprint is inconsistent';
        }
        if ((normalizedLabel === 'overall' || normalizedLabel === 'fingerprint') && /no obvious fingerprint inconsistencies/i.test(normalizedValue)) {
            return 'No obvious fingerprint inconsistencies';
        }
        return normalizedValue;
    }

    if (presetId === 'builtin-iphey') {
        if (normalizedLabel === 'browser' && (/^(?:\d+\s*)?browser$/i.test(normalizedValue) || /browser fingerprint(?:ing)?/i.test(normalizedValue))) return '';
        if (normalizedLabel === 'ip' && /^(?:ip(?: address)?|browser fingerprint(?:ing)?)$/i.test(normalizedValue)) return '';
        if (['location', 'hardware', 'software'].includes(normalizedLabel) && /^(?:location|hardware|software|temporary value)$/i.test(normalizedValue)) return '';
        if (normalizedLabel === 'webrtc' && /^(?:webrtc:?|audiocontext:?|temporary value)$/i.test(normalizedValue)) return '';
        if (normalizedLabel === 'security' && /^review needed$/i.test(normalizedValue)) return '';
        return normalizedValue;
    }

    if (presetId === 'builtin-whoer') {
        if (normalizedLabel === 'language') {
            const locale = extractPrimaryLocaleCandidate(normalizedValue);
            if (locale) return locale;
            if (/^(?:want|headers|javascript|social networks|my ip:?|ip(?:-|\s)?address)$/i.test(normalizedValue)) return '';
            if (/social networks/i.test(normalizedValue)) return '';
            return '';
        }
        if (normalizedLabel === 'accept-language') {
            const locale = extractPrimaryLocaleCandidate(normalizedValue);
            if (locale) return buildAcceptLanguage(locale, [locale]);
            const locales = String(normalizedValue)
                .split(',')
                .map((item) => normalizeLocaleToken(item))
                .filter(Boolean);
            return locales.length > 0 ? buildAcceptLanguage(locales[0], locales) : '';
        }
        if (normalizedLabel === 'system time' && /social networks/i.test(normalizedValue)) return '';
        if (normalizedLabel === 'system time' && /^(?:time|n\/a|na)$/i.test(normalizedValue)) return '';
        if ((normalizedLabel === 'provider' || normalizedLabel === 'as organization') && /^(?:time|social networks|n\/a|na)$/i.test(normalizedValue)) return '';
        if (normalizedLabel === 'ip' && /^(?:my ip:?|ip(?:-|\s)?address)$/i.test(normalizedValue)) return '';
        if (normalizedLabel === 'webrtc' && /^(?:my ip:?|ip(?:-|\s)?address|language|headers|javascript)$/i.test(normalizedValue)) return '';
        if (/social networks/i.test(normalizedValue)) return '';
        return normalizedValue;
    }

    return normalizedValue;
}

function sanitizeDiagnosticPresetSignal(presetId, value) {
    const normalizedValue = normalizeDiagnosticText(value, 240);
    if (!normalizedValue) return '';
    if (presetId === 'builtin-pixelscan' && /how to fix it/i.test(normalizedValue) && /your browser fingerprint is inconsistent/i.test(normalizedValue)) {
        return 'Your Browser Fingerprint is inconsistent';
    }
    if (presetId === 'builtin-whoer' && (/^language\s+want$/i.test(normalizedValue) || /social networks/i.test(normalizedValue) || /^my ip:?\s*$/i.test(normalizedValue))) {
        return '';
    }
    if (presetId === 'builtin-iphey' && (/^browser fingerprint(?:ing)?$/i.test(normalizedValue) || /^ip(?: address)?$/i.test(normalizedValue))) {
        return '';
    }
    if (presetId === 'builtin-iphey' && /^canvas fingerprinting:?$/i.test(normalizedValue)) {
        return '';
    }
    return normalizedValue;
}

function buildPresetDiagnosticSummary(presetId, facts, fallbackSummary) {
    const normalizedFacts = normalizeDiagnosticFacts(facts, 10);
    const byLabel = new Map(normalizedFacts.map((item) => [String(item.label || '').trim().toLowerCase(), item]));
    const pick = (labels) => labels.map((label) => byLabel.get(label)).find(Boolean) || null;
    const summarize = (labels, limit = 3) => labels
        .map((label) => byLabel.get(label))
        .filter(Boolean)
        .slice(0, limit)
        .map((item) => `${item.label} ${item.value}`)
        .join(' · ');

    if (presetId === 'builtin-whoer') {
        return summarize(['issue', 'proxy', 'blacklist', 'ip type', 'fraud', 'accept-language', 'language', 'webrtc', 'timezone', 'ip'], 3)
            || normalizeDiagnosticText(fallbackSummary, 240);
    }
    if (presetId === 'builtin-iphey') {
        return summarize(['reputation', 'blacklist', 'browser', 'ip', 'location', 'webrtc'], 3)
            || normalizeDiagnosticText(fallbackSummary, 240);
    }
    if (presetId === 'builtin-pixelscan') {
        const fingerprint = pick(['fingerprint']);
        const proxy = pick(['proxy']);
        const bot = pick(['bot']);
        return [fingerprint, proxy, bot]
            .filter(Boolean)
            .slice(0, 3)
            .map((item) => item.value)
            .join(' · ') || normalizeDiagnosticText(fallbackSummary, 240);
    }
    return normalizeDiagnosticText(fallbackSummary, 240);
}

function sanitizeDiagnosticResultForPreset(presetId, result) {
    const current = isPlainObject(result) ? result : {};
    const facts = normalizeDiagnosticFacts((Array.isArray(current.facts) ? current.facts : []).map((item) => {
        const label = normalizeDiagnosticText(item && item.label, 42);
        const value = sanitizeDiagnosticPresetFactValue(presetId, label, item && item.value);
        if (!label || !value) return null;
        return { label, value, status: normalizeDiagnosticResultStatus(item && item.status) };
    }).filter(Boolean), 10);
    const signals = dedupeDiagnosticLines((Array.isArray(current.signals) ? current.signals : [])
        .map((item) => sanitizeDiagnosticPresetSignal(presetId, item))
        .filter(Boolean), 4);
    const warnFacts = facts.filter((item) => normalizeDiagnosticResultStatus(item && item.status) === 'warn');

    let status = normalizeDiagnosticResultStatus(current.status);
    let summary = normalizeDiagnosticText(current.summary, 240);
    if (presetId === 'builtin-pixelscan' && /how to fix it/i.test(summary) && /your browser fingerprint is inconsistent/i.test(summary)) {
        summary = 'Your Browser Fingerprint is inconsistent';
    }
    if (presetId === 'builtin-whoer' && (/language\s+want/i.test(summary) || /social networks/i.test(summary) || /^my ip:?\s*$/i.test(summary))) {
        summary = '';
    }
    if (presetId === 'builtin-iphey' && (/browser fingerprint(?:ing)?/i.test(summary) || /^ip(?: address)?$/i.test(summary))) {
        summary = '';
    }
    if (presetId === 'builtin-pixelscan' && /collecting data|scan still collecting/i.test(summary)) {
        status = 'info';
    }
    if (presetId === 'builtin-whoer' && status === 'warn' && warnFacts.length === 0) {
        status = 'info';
    }
    if (presetId === 'builtin-iphey' && status === 'warn' && warnFacts.length === 0) {
        status = 'info';
    }
    summary = buildPresetDiagnosticSummary(presetId, facts, summary);

    return {
        ...current,
        status,
        summary,
        signals,
        facts,
    };
}

function buildDiagnosticResultFromSnapshot(preset, snapshot) {
    const rawHeadings = (Array.isArray(snapshot && snapshot.headings) ? snapshot.headings : []).map((item) => normalizeDiagnosticText(item, 220)).filter(Boolean).slice(0, 16);
    const rawCandidates = (Array.isArray(snapshot && snapshot.candidates) ? snapshot.candidates : []).map((item) => normalizeDiagnosticText(item, 220)).filter(Boolean).slice(0, 48);
    const rawBodyLines = (Array.isArray(snapshot && snapshot.bodyLines) ? snapshot.bodyLines : []).map((item) => normalizeDiagnosticText(item, 220)).filter(Boolean).slice(0, 320);
    const exactLines = [normalizeDiagnosticText(snapshot && snapshot.title, 180), ...rawHeadings, ...rawCandidates, ...rawBodyLines].filter(Boolean).slice(0, 420);
    const headings = dedupeDiagnosticLines(rawHeadings, 12);
    const candidates = dedupeDiagnosticLines(rawCandidates, 24);
    const bodyLines = dedupeDiagnosticLines(rawBodyLines, 280);
    const allLines = dedupeDiagnosticLines(exactLines, 160);
    const allText = allLines.join('\n');
    const lower = allText.toLowerCase();
    let status = 'info';
    let headline = headings[0] || normalizeDiagnosticText(snapshot && snapshot.title, 120) || String(preset && preset.name || '').trim() || 'Diagnostic';
    let summary = '';
    let signals = [];
    const facts = [];

    switch (String(preset && preset.id || '').trim()) {
        case 'builtin-pixelscan': {
            signals = pickDiagnosticSignalLines(allLines, [
                /your browser fingerprint is inconsistent/i,
                /no obvious fingerprint inconsistencies/i,
                /masking detected/i,
                /no proxy detected/i,
                /no automated behavior detected/i,
                /proxy detected/i,
                /bot detected/i,
            ], 4);
            const pixelscanPending = /collecting data|fingerprint is scanning|scan in progress|check geo api/i.test(lower);
            const pixelscanFingerprint = findDiagnosticLine(allLines, [
                /your browser fingerprint is inconsistent/i,
                /no obvious fingerprint inconsistencies/i,
                /masking detected/i,
            ]) || findDiagnosticLine(allLines, [/fingerprint scan/i, /your browser fingerprint is scanning/i]);
            const pixelscanProxy = findDiagnosticLine(allLines, [/no proxy detected/i, /proxy detected/i, /vpn detected/i]) || findDiagnosticValue(exactLines, [/^proxy(?:\s*[:：])?/i], 2);
            const pixelscanBot = findDiagnosticLine(allLines, [/no automated behavior detected/i, /automated behavior detected/i, /bot detected/i]) || findDiagnosticValue(exactLines, [/^bot(?:\s*check|\s*verification)?(?:\s*[:：])?/i], 2);
            const pixelscanBrowser = findDiagnosticLine(allLines, [/\b(?:chrome|chromium|firefox|safari|edge|opera)\s+\d[\w.]*\s+on\s+[a-z][a-z0-9 ._-]+/i])
                || findDiagnosticValueSmart(exactLines, [/^browser(?:\s*[:：])?/i], {
                    maxOffset: 3,
                    reject: (candidate) => looksLikePixelscanBrowserMatrix(candidate),
                });
            const pixelscanCountry = findDiagnosticValue(exactLines, [/^country(?:\s*[:：])?/i], 2);
            const pixelscanCity = findDiagnosticValue(exactLines, [/^city(?:\s*[:：])?/i], 2);
            const pixelscanLocation = [pixelscanCountry, pixelscanCity].filter(Boolean).join(' / ') || findDiagnosticValue(exactLines, [/^location(?:\s*[:：])?/i], 2);
            const pixelscanTimezone = findDiagnosticValue(exactLines, [/^timezone from js(?:\s*[:：])?/i, /^timezone(?:\s*[:：])?/i], 2);
            const fingerprintWarn = /your browser fingerprint is inconsistent|masking detected/i.test(pixelscanFingerprint);
            const proxyWarn = /proxy detected|vpn detected/i.test(pixelscanProxy) && !/no proxy detected/i.test(pixelscanProxy);
            const botWarn = /automated behavior detected|bot detected/i.test(pixelscanBot) && !/no automated behavior detected/i.test(pixelscanBot);
            if (fingerprintWarn || proxyWarn || botWarn) status = 'warn';
            else if (/no obvious fingerprint inconsistencies/i.test(pixelscanFingerprint) || /no proxy detected/i.test(pixelscanProxy) || /no automated behavior detected/i.test(pixelscanBot)) status = 'ok';
            else if (pixelscanPending) status = 'info';
            summary = pixelscanPending && !pixelscanFingerprint && !pixelscanProxy && !pixelscanBot
                ? 'Pixelscan scan still collecting data'
                : (pixelscanFingerprint || pixelscanProxy || pixelscanBot || candidates[0] || bodyLines[0] || 'Scan page opened');
            pushDiagnosticFact(facts, 'Overall', pixelscanFingerprint || (status === 'ok' ? 'No obvious inconsistencies' : (status === 'warn' ? 'Risk signals found' : 'Needs manual review')), status);
            if (pixelscanPending) pushDiagnosticFact(facts, 'Progress', 'Scan still collecting data', 'info');
            pushDiagnosticFact(facts, 'Fingerprint', pixelscanFingerprint || findDiagnosticLine(allLines, [/fingerprint check/i, /verify your browser fingerprint/i, /fingerprint/i]) || summary, fingerprintWarn ? 'warn' : (/no obvious fingerprint inconsistencies/i.test(pixelscanFingerprint) ? 'ok' : 'info'));
            pushDiagnosticFact(facts, 'Bot', pixelscanBot || findDiagnosticLine(allLines, [/bot verification/i, /\bbot\b/i]), botWarn ? 'warn' : (/no automated behavior detected/i.test(pixelscanBot) ? 'ok' : 'info'));
            pushDiagnosticFact(facts, 'Proxy', pixelscanProxy || findDiagnosticLine(allLines, [/proxy/i, /vpn/i]), proxyWarn ? 'warn' : (/no proxy detected/i.test(pixelscanProxy) ? 'ok' : 'info'));
            if (!pixelscanPending && pixelscanBrowser) pushDiagnosticFact(facts, 'Browser', pixelscanBrowser, 'info');
            pushDiagnosticFact(facts, 'Location', pixelscanLocation || findDiagnosticLine(allLines, [/^country$/i, /^city$/i, /^location$/i]), 'info');
            pushDiagnosticFact(facts, 'Timezone', pixelscanTimezone || findDiagnosticLine(allLines, [/timezone from js/i, /timezone/i]), 'info');
            break;
        }
        case 'builtin-iphey': {
            signals = pickDiagnosticSignalLines(allLines, [
                /trustworthy/i,
                /displayed as real/i,
                /ordinary user'?s location/i,
                /not blacklisted/i,
                /suspicious|unreliable|untrustworthy/i,
                /blacklisted/i,
            ], 3);
            const ipheyReputation = findDiagnosticLine(allLines, [/^trustworthy$/i, /^suspicious$/i, /^unreliable$/i]);
            const ipheyBrowser = findDiagnosticLine(allLines, [/your browser displayed as real/i, /browser displayed as real/i]);
            const ipheyLocation = findDiagnosticLine(allLines, [/your location looks like an ordinary user'?s location/i, /ordinary user'?s location/i]);
            const ipheyIp = findDiagnosticLine(allLines, [/your ip-address is unique and is not blacklisted/i, /ip-address is unique/i, /ip address is unique/i]);
            const ipheyHardware = findDiagnosticLine(allLines, [/hardware parameters match each other/i, /hardware .*match each other/i]);
            const ipheySoftware = findDiagnosticLine(allLines, [/software settings don'?t look suspicious/i, /software .*look suspicious/i]);
            const ipheyBlacklist = findDiagnosticLine(allLines, [/not blacklisted/i, /blacklisted/i]);
            const ipheySecurity = findDiagnosticValue(exactLines, [/^security(?:\s*[:：])?/i], 2) || findDiagnosticLine(allLines, [/all clear/i]);
            const ipheyWebrtc = findDiagnosticValue(exactLines, [/^webrtc(?:\s*[:：])?/i], 2);
            const ipheyStatusText = [ipheyReputation, ipheyBlacklist, ipheySecurity, ipheyBrowser, ipheyLocation, ipheyIp].filter(Boolean).join(' | ');
            if (/suspicious|unreliable|untrustworthy|blacklisted|fake/i.test(ipheyStatusText) && !/not blacklisted/i.test(ipheyStatusText)) status = 'warn';
            else if (/trustworthy|displayed as real|not blacklisted|ordinary user'?s location|all clear/i.test(ipheyStatusText)) status = 'ok';
            summary = ipheyReputation || ipheyBrowser || ipheyIp || signals[0] || candidates[0] || bodyLines[0] || 'Identity page opened';
            pushDiagnosticFact(
                facts,
                'Reputation',
                ipheyReputation || (/trustworthy/i.test(ipheyStatusText) ? 'Trustworthy' : (/suspicious|unreliable|untrustworthy|fake/i.test(ipheyStatusText) ? 'Suspicious' : 'Review needed')),
                /trustworthy/i.test(String(ipheyReputation || ipheyStatusText)) ? 'ok' : (/suspicious|unreliable|untrustworthy|fake/i.test(String(ipheyReputation || ipheyStatusText)) ? 'warn' : status)
            );
            if (ipheyBrowser) pushDiagnosticFact(facts, 'Browser', ipheyBrowser, /displayed as real/i.test(ipheyBrowser) ? 'ok' : 'info');
            if (ipheyIp) pushDiagnosticFact(facts, 'IP', ipheyIp, /not blacklisted/i.test(ipheyIp) ? 'ok' : 'info');
            if (ipheyBlacklist) pushDiagnosticFact(facts, 'Blacklist', ipheyBlacklist, /blacklisted/i.test(ipheyBlacklist) && !/not blacklisted/i.test(ipheyBlacklist) ? 'warn' : 'ok');
            if (ipheySecurity) pushDiagnosticFact(facts, 'Security', ipheySecurity, /all clear/i.test(ipheySecurity) ? 'ok' : 'info');
            if (ipheyWebrtc) pushDiagnosticFact(facts, 'WebRTC', ipheyWebrtc, /disabled|protected/i.test(ipheyWebrtc) ? 'ok' : 'info');
            if (ipheyLocation) pushDiagnosticFact(facts, 'Location', ipheyLocation, 'info');
            if (ipheyHardware) pushDiagnosticFact(facts, 'Hardware', ipheyHardware, 'info');
            if (ipheySoftware) pushDiagnosticFact(facts, 'Software', ipheySoftware, 'info');
            break;
        }
        case 'builtin-whoer': {
            const sectionLines = rawBodyLines;
            const whoerHttpHeadersSectionPatterns = [/^(?:http headers|http 请求头|http头|http标题)$/i, /^####\s*(?:http headers|http 请求头|http头|http标题)$/i];
            const whoerNavigatorSectionPatterns = [/^(?:navigator|导航器|导航)$/i, /^####\s*(?:navigator|导航器|导航)$/i];
            const whoerInteractiveSectionPatterns = [/^(?:interactive detection|互动检查|互动检测|交互式检测)$/i, /^####\s*(?:interactive detection|互动检查|互动检测|交互式检测)$/i];
            const disguiseMatch = allText.match(/(?:your disguise|disguise|伪装|匿名(?:度|性)|隐身(?:度|性)|隐匿(?:度|性))[^0-9]{0,24}(\d{1,3})%/i)
                || allText.match(/(\d{1,3})%\s*(?:minor remarks|anonymity|security|匿名|安全|伪装)/i);
            const dnsValue = findDiagnosticValueSmart(exactLines, [/^dns(?:\s*[:：])?$/i], {
                maxOffset: 3,
                skipPatterns: [/^dns泄漏测试$/i, /^dns leak test$/i, /^dns$/i],
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const ipTypeValue = findDiagnosticValueSmart(exactLines, [/^ip type(?:\s*[:：])?/i], {
                maxOffset: 3,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const languageValue = findDiagnosticValueSmart(exactLines, [/^language(?:\s*[:：])?/i, /^语言(?:\s*[:：])?/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate) || /^[A-Z]{2}$/i.test(candidate) || /(?:语言不同|languages?\s+different|不相符|如何更正|how to fix)/i.test(candidate),
            });
            const webRtcValue = findDiagnosticValueSmart(exactLines, [/^webrtc(?:\s*[:：])?$/i], {
                maxOffset: 4,
                skipPatterns: [/^javascript$/i, /^(?:flash|activex|java|cookies)$/i, /^java\s*\((?:tcp|udp|system)\)$/i, /^(?:dns|browser|os|headers|ports|language)$/i],
                reject: (candidate) => !normalizeDiagnosticText(candidate, 180) || /[:：]$/.test(candidate) || /^(?:java|dns|browser|headers|os|ports|language)(?:\b|[:：])/i.test(candidate),
            });
            const fraudScoreMatch = allText.match(/fraud score:\s*(-?\d{1,3})/i);
            const providerValue = findDiagnosticValueSmart(exactLines, [/^provider(?:\s*[:：])?/i, /^提供商(?:\s*[:：])?/i], {
                maxOffset: 4,
                skipPatterns: [/^dns$/i, /^(?:国家|省份|城市|邮编|主机|公司|as organization|as number)(?:\s*[:：])?$/i],
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const locationAsOrganizationValue = findDiagnosticSectionValue(sectionLines, [/^(?:location|所在位置)$/i, /^####\s*(?:location|所在位置)$/i], [/^as organization(?:\s*[:：])?$/i, /^organization(?:\s*[:：])?$/i, /^公司(?:\s*[:：])?$/i], {
                searchWindow: 28,
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const timezoneValue = findDiagnosticValueSmart(exactLines, [/^timezone(?:\s*[:：])?/i, /^时区(?:\s*[:：])?/i], {
                maxOffset: 4,
                skipPatterns: [/^(?:当地时间|local time|系统时间|system time)(?:\s*[:：])?$/i],
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate) || /\b(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(candidate) || /gmt[+-]\d{4}/i.test(candidate),
            });
            const localTimeValue = findDiagnosticValueSmart(exactLines, [/^(?:当地时间|local time)(?:\s*[:：])?/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const systemTimeValue = findDiagnosticSectionValue(sectionLines, [/^(?:time|时间)$/i, /^####\s*(?:time|时间)$/i], [/^(?:system time|system|系统时间|系统)(?:\s*[:：])?$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const sectionLanguageHeadersValue = findDiagnosticSectionValue(sectionLines, [/^(?:language|语言)$/i, /^####\s*(?:language|语言)$/i], [/^(?:headers|标题)(?:\s*[:：])?$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const sectionLanguageJsValue = findDiagnosticSectionValue(sectionLines, [/^(?:language|语言)$/i, /^####\s*(?:language|语言)$/i], [/^javascript(?:\s*[:：])?$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const httpAcceptLanguageValue = findDiagnosticSectionValue(sectionLines, whoerHttpHeadersSectionPatterns, [/^http_accept_language$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const httpUserAgentValue = findDiagnosticSectionValue(sectionLines, whoerHttpHeadersSectionPatterns, [/^http_user_agent$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const navigatorPlatformValue = findDiagnosticSectionValue(sectionLines, whoerNavigatorSectionPatterns, [/^platform(?:\s*[:：])?$/i], {
                searchWindow: 96,
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const navigatorLanguageValue = findDiagnosticSectionValue(sectionLines, whoerNavigatorSectionPatterns, [/^language(?:\s*[:：])?$/i], {
                searchWindow: 96,
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const navigatorWebdriverValue = findDiagnosticSectionValue(sectionLines, whoerNavigatorSectionPatterns, [/^webdriver(?:\s*[:：])?$/i], {
                searchWindow: 96,
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const interactiveIpValue = findDiagnosticSectionValue(sectionLines, whoerInteractiveSectionPatterns, [/^(?:ip address|ip-地址)(?:\s*[:：])?$/i], {
                maxOffset: 2,
                reject: (candidate) => isDiagnosticPlaceholderValue(candidate) || /[:：]$/.test(candidate),
            });
            const fingerprintWebRtcValue = findDiagnosticSectionValue(sectionLines, [/^browser fingerprint$/i, /^浏览器指纹$/i], [/^webrtc(?:\s*[:：])?$/i], {
                searchWindow: 40,
                maxOffset: 2,
                reject: (candidate) => {
                    const normalized = normalizeDiagnosticText(candidate, 180);
                    return !normalized
                        || /[:：]$/.test(normalized)
                        || /^(?:javascript|flash|activex|java|cookies|location|time|language|dns leak test|port scanner|evercookie test|java \(tcp\)|java \(udp\)|java \(system\)|headers|browser|os)$/i.test(normalized);
                },
            });
            const interactiveWebRtcValue = findDiagnosticSectionValue(sectionLines, whoerInteractiveSectionPatterns, [/^webrtc(?:\s*[:：])?$/i], {
                maxOffset: 2,
                reject: (candidate) => {
                    const normalized = normalizeDiagnosticText(candidate, 180);
                    return !normalized
                        || /[:：]$/.test(normalized)
                        || /^(?:java \(tcp\)|java \(udp\)|java \(system\)|dns|browser|os|ports|language|headers|javascript)$/i.test(normalized);
                },
            });
            const interactiveLanguageHeadersValue = findDiagnosticSectionValue(sectionLines, whoerInteractiveSectionPatterns, [/^headers(?:\s*[:：])?$/i], {
                searchWindow: 28,
                maxOffset: 2,
                reject: (candidate, index, scoped) => {
                    const normalized = normalizeDiagnosticText(candidate, 180);
                    if (isDiagnosticPlaceholderValue(normalized) || /[:：]$/.test(normalized)) return true;
                    const previous = normalizeDiagnosticText(scoped && scoped[index - 1], 80).toLowerCase();
                    const twoBack = normalizeDiagnosticText(scoped && scoped[index - 2], 80).toLowerCase();
                    return !/^(language|语言)$/.test(previous) && !/^(language|语言)$/.test(twoBack);
                },
            });
            const interactiveLanguageJsValue = findDiagnosticSectionValue(sectionLines, whoerInteractiveSectionPatterns, [/^javascript(?:\s*[:：])?$/i], {
                searchWindow: 28,
                maxOffset: 2,
                reject: (candidate, index, scoped) => {
                    const normalized = normalizeDiagnosticText(candidate, 180);
                    if (isDiagnosticPlaceholderValue(normalized) || /[:：]$/.test(normalized)) return true;
                    const previous = normalizeDiagnosticText(scoped && scoped[index - 1], 80).toLowerCase();
                    const twoBack = normalizeDiagnosticText(scoped && scoped[index - 2], 80).toLowerCase();
                    return !/^(language|语言)$/.test(previous) && !/^(language|语言)$/.test(twoBack);
                },
            });
            const blacklistMatch = allText.match(/(?:blacklist|黑色名单)\s*[:：]?\s*(yes|no|是|不)/i);
            const proxyMatch = allText.match(/(?:proxy server|代理服务器)\s*[:：]?\s*(yes|no|是|不)/i);
            const ipMatch = allText.match(/(?:my ip|your ip|我的ip)\s*[:：]?\s*(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f:]{6,})/i);
            const blacklistValue = blacklistMatch && blacklistMatch[1] ? blacklistMatch[1] : findDiagnosticValue(exactLines, [/^blacklist(?:\s*[:：])?/i, /^黑色名单(?:\s*[:：])?/i], 2);
            const proxyValue = proxyMatch && proxyMatch[1] ? proxyMatch[1] : findDiagnosticValue(exactLines, [/^proxy server(?:\s*[:：])?/i, /^代理服务器(?:\s*[:：])?/i], 2);
            const ipValue = ipMatch && ipMatch[1] ? ipMatch[1] : (interactiveIpValue || findDiagnosticValue(exactLines, [/^(?:my ip|your ip|我的ip)(?:\s*[:：])?/i], 2));
            const systemTimeWarning = findDiagnosticLine(allLines, [/system time different/i]);
            const ipTypeWarning = findDiagnosticLine(allLines, [/ip type danger/i]);
            const fingerprintExposureWarning = findDiagnosticLine(allLines, [/your fingerprint is exposed/i, /fingerprint is exposed/i]);
            const browserHeadersWarning = findDiagnosticLine(allLines, [/browser headers different/i]);
            const languageMismatchWarning = findDiagnosticLine(allLines, [/languages different/i]);
            const dnsDifferentWarning = findDiagnosticLine(allLines, [/dns different/i]);
            const proxyDetectedWarning = findDiagnosticLine(allLines, [/proxy detected/i, /webproxy detected/i, /open proxy ports/i]);
            const ipDifferentWarning = findDiagnosticLine(allLines, [/ip addresses different/i]);
            const whoerPrimarySignal = findDiagnosticLine(headings, [/^browser fingerprint$/i, /^what is my ip/i])
                || findDiagnosticLine(candidates, [/^browser fingerprint$/i, /^what is my ip/i]);
            const primaryLocaleValue = extractPrimaryLocaleCandidate(
                sectionLanguageJsValue
                || interactiveLanguageJsValue
                || navigatorLanguageValue
                || httpAcceptLanguageValue
                || interactiveLanguageHeadersValue
                || sectionLanguageHeadersValue
                || languageValue
            );
            const languageDisplayValue = navigatorLanguageValue || sectionLanguageJsValue || interactiveLanguageJsValue || primaryLocaleValue || languageValue || interactiveLanguageHeadersValue || sectionLanguageHeadersValue || httpAcceptLanguageValue;
            const acceptLanguageDisplayValue = sectionLanguageHeadersValue || interactiveLanguageHeadersValue || httpAcceptLanguageValue;
            const providerDisplayValue = [locationAsOrganizationValue, providerValue].filter(Boolean).sort((a, b) => String(b).length - String(a).length)[0] || '';
            let webRtcDisplayValue = fingerprintWebRtcValue || webRtcValue || interactiveWebRtcValue;
            if (/^java\s*\((?:tcp|udp|system)\)$/i.test(String(webRtcDisplayValue || '').trim())) webRtcDisplayValue = 'N/A';
            const riskSignals = dedupeDiagnosticLines([
                fingerprintExposureWarning,
                browserHeadersWarning,
                languageMismatchWarning,
                dnsDifferentWarning,
                proxyDetectedWarning,
                ipDifferentWarning,
                systemTimeWarning,
                ipTypeWarning,
            ], 4);
            const primaryRiskSignal = riskSignals[0] || '';
            if (disguiseMatch && disguiseMatch[1]) {
                const score = Number.parseInt(disguiseMatch[1], 10);
                if (Number.isFinite(score)) {
                    signals = dedupeDiagnosticLines([`Disguise ${score}%`, ...riskSignals, ...pickDiagnosticSignalLines(allLines, [/leak/i, /fingerprint/i, /insecurity/i, /exposed/i, /system time different/i, /ip type danger/i], 2)], 4);
                    summary = primaryRiskSignal
                        ? `Disguise ${score}% · ${primaryRiskSignal}`
                        : `Disguise ${score}%`;
                    status = score >= 80 ? 'ok' : 'warn';
                }
            }
            if (!summary) {
                signals = dedupeDiagnosticLines([
                    primaryRiskSignal,
                    whoerPrimarySignal,
                    systemTimeWarning,
                    ipTypeWarning,
                    /yes|true|是/i.test(proxyValue) ? `Proxy ${proxyValue}` : '',
                    /yes|true|是/i.test(blacklistValue) ? `Blacklist ${blacklistValue}` : '',
                ], 4);
                if (signals.length === 0) {
                    signals = pickDiagnosticSignalLines(allLines, [/leak/i, /fingerprint/i, /insecurity/i, /exposed/i, /\d{1,3}%/i, /system time different/i, /ip type danger/i], 3);
                }
                if (/fingerprint is exposed|system time different|browser headers different|languages different|dns different|proxy detected|ip addresses different|ip type danger/i.test(lower) || riskSignals.length > 0) status = 'warn';
                summary = dedupeDiagnosticLines([
                    primaryRiskSignal,
                    systemTimeWarning,
                    ipTypeWarning,
                    proxyValue ? `Proxy ${proxyValue}` : '',
                    blacklistValue ? `Blacklist ${blacklistValue}` : '',
                    timezoneValue ? `Timezone ${timezoneValue}` : '',
                    languageDisplayValue ? `Language ${languageDisplayValue}` : '',
                    webRtcDisplayValue ? `WebRTC ${webRtcDisplayValue}` : '',
                    signals[0],
                    candidates[0],
                    bodyLines[0],
                ], 3).join(' · ') || 'Whoer page opened';
            }
            if (riskSignals.length > 0 || /yes|true|是/i.test(proxyValue) || /yes|true|是/i.test(blacklistValue)) status = 'warn';
            if (disguiseMatch && disguiseMatch[1]) {
                const score = Number.parseInt(disguiseMatch[1], 10);
                pushDiagnosticFact(facts, 'Disguise', `${score}%`, Number.isFinite(score) && score >= 80 ? 'ok' : 'warn');
            }
            if (primaryRiskSignal) pushDiagnosticFact(facts, 'Issue', primaryRiskSignal, 'warn');
            pushDiagnosticFact(facts, 'Proxy', proxyValue || findDiagnosticLine(allLines, [/proxy server/i, /代理服务器/i]), /yes|true|是/i.test(proxyValue) ? 'warn' : (proxyValue ? 'ok' : 'info'));
            pushDiagnosticFact(facts, 'Blacklist', blacklistValue || findDiagnosticLine(allLines, [/blacklist/i, /黑色名单/i]), /yes|true|是/i.test(blacklistValue) ? 'warn' : (blacklistValue ? 'ok' : 'info'));
            if (ipTypeValue || ipTypeWarning) pushDiagnosticFact(facts, 'IP Type', ipTypeValue || ipTypeWarning, /danger|hosting/i.test(String(ipTypeValue || ipTypeWarning || '')) ? 'warn' : 'info');
            if (fraudScoreMatch && fraudScoreMatch[1]) pushDiagnosticFact(facts, 'Fraud', fraudScoreMatch[1], /^-?\d+$/.test(fraudScoreMatch[1]) && Number.parseInt(fraudScoreMatch[1], 10) > 40 ? 'warn' : 'info');
            if (timezoneValue) pushDiagnosticFact(facts, 'Timezone', timezoneValue, 'info');
            else if (localTimeValue) pushDiagnosticFact(facts, 'Local Time', localTimeValue, 'info');
            if (languageDisplayValue) pushDiagnosticFact(facts, 'Language', languageDisplayValue, languageMismatchWarning ? 'warn' : 'info');
            if (webRtcDisplayValue) pushDiagnosticFact(facts, 'WebRTC', webRtcDisplayValue, /disabled|closed|已关闭/i.test(webRtcDisplayValue) ? 'ok' : 'info');
            if (acceptLanguageDisplayValue) pushDiagnosticFact(facts, 'Accept-Language', acceptLanguageDisplayValue, 'info');
            if (navigatorPlatformValue) pushDiagnosticFact(facts, 'Navigator Platform', navigatorPlatformValue, 'info');
            if (navigatorLanguageValue) pushDiagnosticFact(facts, 'Navigator Language', navigatorLanguageValue, 'info');
            if (dnsValue && (dnsDifferentWarning || /yes|true|是/i.test(proxyValue))) pushDiagnosticFact(facts, 'DNS', dnsValue, dnsDifferentWarning ? 'warn' : 'info');
            if (systemTimeValue) pushDiagnosticFact(facts, 'System Time', systemTimeValue, 'info');
            if (providerDisplayValue) pushDiagnosticFact(facts, 'Provider', providerDisplayValue, 'info');
            if (locationAsOrganizationValue) pushDiagnosticFact(facts, 'AS Organization', locationAsOrganizationValue, 'info');
            if (navigatorWebdriverValue) pushDiagnosticFact(facts, 'webdriver', navigatorWebdriverValue, /true|present|detected/i.test(navigatorWebdriverValue) ? 'warn' : 'ok');
            if (httpUserAgentValue) pushDiagnosticFact(facts, 'HTTP UA', httpUserAgentValue, 'info');
            pushDiagnosticFact(facts, 'IP', ipValue || findDiagnosticLine(allLines, [/my ip/i, /your ip/i, /我的ip/i, /\bip\b/i]), 'info');
            break;
        }
        case 'builtin-browserleaks': {
            signals = pickDiagnosticSignalLines(allLines, [
                /webdriver/i,
                /headless/i,
                /language/i,
                /timezone/i,
                /platform/i,
                /webgl/i,
                /navigator/i,
                /document/i,
            ], 4);
            const webdriverValue = findDiagnosticValue(exactLines, [/^webdriver(?:\s*[:：])?/i], 2);
            const timezoneValue = findDiagnosticValue(exactLines, [/^timezone(?:\s*[:：])?/i, /^timeZone(?:\s*[:：])?/i], 2);
            const languageValue = findDiagnosticValue(exactLines, [/^language(?:\s*[:：])?/i, /^accept-language(?:\s*[:：])?/i], 2);
            const platformValue = findDiagnosticValue(exactLines, [/^platform(?:\s*[:：])?/i], 2);
            const userAgentValue = findDiagnosticValue(exactLines, [/^userAgent(?:\s*[:：])?/i], 2);
            const webdriverDetected = /^(true|present|detected)$/i.test(webdriverValue) || /webdriver[^a-z0-9]{0,12}(true|present|detected)/i.test(lower);
            const headlessDetected = /headlesschrome/i.test(userAgentValue) || /headless|automation/i.test(lower);
            if (webdriverDetected || headlessDetected) status = 'warn';
            summary = signals[0] || candidates[0] || bodyLines[0] || 'JavaScript data table captured';
            pushDiagnosticFact(facts, 'webdriver', webdriverValue || findDiagnosticLine(allLines, [/webdriver/i]), webdriverDetected ? 'warn' : (webdriverValue ? 'ok' : 'info'));
            pushDiagnosticFact(facts, 'Headless', headlessDetected ? 'Detected' : 'Not detected', headlessDetected ? 'warn' : 'ok');
            pushDiagnosticFact(facts, 'Language', languageValue || findDiagnosticLine(allLines, [/language/i, /accept-language/i]), 'info');
            pushDiagnosticFact(facts, 'Timezone', timezoneValue || findDiagnosticLine(allLines, [/timezone/i, /time zone/i]), 'info');
            pushDiagnosticFact(facts, 'Platform', platformValue || findDiagnosticLine(allLines, [/platform/i, /navigator\.platform/i]), 'info');
            pushDiagnosticFact(facts, 'WebGL', findDiagnosticLine(allLines, [/webgl/i, /renderer/i, /vendor/i]), 'info');
            break;
        }
        default:
            signals = pickDiagnosticSignalLines(allLines, [/detected/i, /clean/i, /trustworthy/i, /leak/i, /exposed/i, /score/i], 3);
            if (/clean|trustworthy|protected|not detected|consistent/i.test(lower)) status = 'ok';
            else if (/detected|leak|exposed|insecurity|blacklisted/i.test(lower)) status = 'warn';
            summary = signals[0] || candidates[0] || bodyLines[0] || 'Diagnostic page opened';
            pushDiagnosticFact(facts, 'Overall', summary, status);
            break;
    }

    return sanitizeDiagnosticResultForPreset(String(preset && preset.id || '').trim(), {
        status: normalizeDiagnosticResultStatus(status),
        headline: normalizeDiagnosticText(headline, 120),
        summary: normalizeDiagnosticText(summary, 240),
        title: normalizeDiagnosticText(snapshot && snapshot.title, 180),
        finalUrl: normalizeDiagnosticText(snapshot && snapshot.finalUrl, 280),
        capturedAt: Date.now(),
        signals: dedupeDiagnosticLines(signals, 4),
        facts: normalizeDiagnosticFacts(facts),
    });
}

function buildDiagnosticStructuredSnapshot(preset, snapshot, result, navigationError) {
    const output = {
        presetId: String(preset && preset.id || '').trim(),
        presetName: String(preset && preset.name || '').trim(),
        capturedAt: Number(result && result.capturedAt) || Date.now(),
        title: normalizeDiagnosticText(snapshot && snapshot.title, 180),
        finalUrl: normalizeDiagnosticText(snapshot && snapshot.finalUrl, 280),
        parsedResult: {
            status: normalizeDiagnosticResultStatus(result && result.status),
            headline: normalizeDiagnosticText(result && result.headline, 120),
            summary: normalizeDiagnosticText(result && result.summary, 240),
            signals: dedupeDiagnosticLines(result && result.signals, 8),
            facts: normalizeDiagnosticFacts(result && result.facts),
        },
        snapshot: {
            headings: dedupeDiagnosticLines(snapshot && snapshot.headings, 24),
            candidates: dedupeDiagnosticLines(snapshot && snapshot.candidates, 48),
            bodyLines: dedupeDiagnosticLines(snapshot && snapshot.bodyLines, 220),
        },
    };
    const errorMessage = normalizeDiagnosticText(navigationError && navigationError.message, 180);
    if (errorMessage) output.navigationError = errorMessage;
    return output;
}

function hasUsableDiagnosticSnapshot(snapshot, result) {
    const title = normalizeDiagnosticText(snapshot && snapshot.title, 180);
    const headings = dedupeDiagnosticLines(snapshot && snapshot.headings, 24);
    const candidates = dedupeDiagnosticLines(snapshot && snapshot.candidates, 48);
    const bodyLines = dedupeDiagnosticLines(snapshot && snapshot.bodyLines, 220);
    const signals = dedupeDiagnosticLines(result && result.signals, 8);
    const facts = normalizeDiagnosticFacts(result && result.facts);
    if (facts.length > 0 || signals.length > 0) return true;
    if (headings.length >= 2 || candidates.length >= 2) return true;
    if (bodyLines.length >= 8) return true;
    return !!title && bodyLines.length > 0;
}

function hasWhoerDetailMarkers(snapshot, result = null) {
    const lines = dedupeDiagnosticLines([
        normalizeDiagnosticText(snapshot && snapshot.title, 180),
        ...(snapshot && Array.isArray(snapshot.headings) ? snapshot.headings : []),
        ...(snapshot && Array.isArray(snapshot.candidates) ? snapshot.candidates : []),
        ...(snapshot && Array.isArray(snapshot.bodyLines) ? snapshot.bodyLines : []),
        ...(result && Array.isArray(result.signals) ? result.signals : []),
        ...(result && Array.isArray(result.facts) ? result.facts.map((item) => `${item && item.label || ''}: ${item && item.value || ''}`) : []),
    ], 220).join('\n');
    return /(browser fingerprint|webrtc|language|http headers|navigator|interactive detection|ip address details|proxy server|blacklist|social networks|local time|timezone|当地时间|时区|黑色名单|代理服务器|社交网络|扩展版本|浏览器指纹)/i.test(lines);
}

function isSparseWhoerDiagnosticSnapshot(snapshot, result) {
    const headings = dedupeDiagnosticLines(snapshot && snapshot.headings, 24);
    const candidates = dedupeDiagnosticLines(snapshot && snapshot.candidates, 48);
    const bodyLines = dedupeDiagnosticLines(snapshot && snapshot.bodyLines, 220);
    const facts = normalizeDiagnosticFacts(result && result.facts);
    if (facts.length >= 4) return false;
    if (bodyLines.length >= 40 && hasWhoerDetailMarkers(snapshot, result)) return false;
    if (!hasWhoerDetailMarkers(snapshot, result)) return true;
    return bodyLines.length < 28 || (headings.length + candidates.length < 6 && facts.length < 3);
}

async function collectDiagnosticPageSnapshot(page) {
    if (!page) return { title: '', headings: [], candidates: [], bodyLines: [] };
    return page.evaluate(() => {
        const clean = (value, maxLength = 220) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text) return '';
            return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…` : text;
        };
        const collect = (selectors, limit = 12) => {
            const out = [];
            const seen = new Set();
            for (const node of Array.from(document.querySelectorAll(selectors))) {
                if (out.length >= limit) break;
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                if (rect && rect.width <= 0 && rect.height <= 0) continue;
                const value = clean(node.innerText || node.textContent || '');
                const key = value.toLowerCase();
                if (!value || seen.has(key)) continue;
                seen.add(key);
                out.push(value);
            }
            return out;
        };
        const bodyLines = [];
        for (const line of String(document.body && document.body.innerText || '').split(/\n+/)) {
            const value = clean(line);
            if (!value) continue;
            bodyLines.push(value);
            if (bodyLines.length >= 260) break;
        }
        return {
            title: clean(document.title || '', 180),
            headings: collect('h1,h2,h3,[role="heading"]', 10),
            candidates: collect([
                '.status-indicator',
                '.browser-status',
                '.ip-status',
                '.ip-info',
                '#my-ip',
                '#insecurity-level',
                '[class*="score"]',
                '[class*="status"]',
                '[class*="result"]',
                '[class*="summary"]',
                '[class*="risk"]',
                '[class*="leak"]',
                '[class*="fingerprint"]',
                '[id*="score"]',
                '[id*="status"]',
                '[id*="result"]',
                'strong',
                'table tr',
                'table th',
                'table td'
            ].join(','), 32),
            bodyLines,
        };
    });
}

async function waitForWhoerDiagnosticDetails(page, previousTextLength = 0, timeout = 12000) {
    if (!page || typeof page.waitForFunction !== 'function') return;
    await page.waitForFunction((beforeLength) => {
        const text = String(document.body && document.body.innerText || '');
        if (!text) return false;
        const hasMarkers = /(browser fingerprint|webrtc|language|http headers|navigator|interactive detection|ip address details|proxy server|blacklist|social networks|local time|timezone|当地时间|时区|黑色名单|代理服务器|社交网络|扩展版本|浏览器指纹)/i.test(text);
        const bodyLines = text.split(/\n+/).map((line) => String(line || '').trim()).filter(Boolean);
        if (hasMarkers && bodyLines.length >= 18) return true;
        if (Number.isFinite(beforeLength) && beforeLength > 0 && text.length >= Math.max(beforeLength + 500, Math.floor(beforeLength * 1.35))) {
            return hasMarkers || bodyLines.length >= 30;
        }
        return false;
    }, { timeout }, previousTextLength).catch(() => { });
}

async function captureDiagnosticPresetArtifacts(page, profileId, runId, structuredSnapshot = null) {
    const artifacts = {
        runId,
        available: [],
    };
    if (!page || !profileId || !runId) return artifacts;
    const dir = getProfileDiagnosticArtifactDir(profileId, runId);
    await fs.ensureDir(dir);

    try {
        const html = await page.content();
        await fs.writeFile(getDiagnosticArtifactFilePath(profileId, runId, 'html'), String(html || ''), 'utf8');
        artifacts.htmlUrl = buildDiagnosticArtifactUrl(profileId, runId, 'html');
        artifacts.available.push('html');
    } catch (e) { }

    try {
        const text = await page.evaluate(() => String(document.documentElement && document.documentElement.innerText || '').trim());
        await fs.writeFile(getDiagnosticArtifactFilePath(profileId, runId, 'text'), String(text || ''), 'utf8');
        artifacts.textUrl = buildDiagnosticArtifactUrl(profileId, runId, 'text');
        artifacts.available.push('text');
    } catch (e) { }

    try {
        if (structuredSnapshot) {
            await fs.writeFile(getDiagnosticArtifactFilePath(profileId, runId, 'json'), JSON.stringify(structuredSnapshot, null, 2), 'utf8');
            artifacts.jsonUrl = buildDiagnosticArtifactUrl(profileId, runId, 'json');
            artifacts.available.push('json');
        }
    } catch (e) { }

    try {
        await page.screenshot({ path: getDiagnosticArtifactFilePath(profileId, runId, 'screenshot'), type: 'png', fullPage: true });
        artifacts.screenshotUrl = buildDiagnosticArtifactUrl(profileId, runId, 'screenshot');
        artifacts.available.push('screenshot');
    } catch (e) {
        try {
            await page.screenshot({ path: getDiagnosticArtifactFilePath(profileId, runId, 'screenshot'), type: 'png', fullPage: false });
            artifacts.screenshotUrl = buildDiagnosticArtifactUrl(profileId, runId, 'screenshot');
            artifacts.available.push('screenshot');
        } catch (inner) { }
    }

    artifacts.available = Array.from(new Set(artifacts.available));
    return artifacts;
}

async function captureDiagnosticPresetResult(page, preset, profileId, openedAt, navigationError) {
    if (!page) return { status: 'info', headline: String(preset && preset.name || '').trim() || 'Diagnostic', summary: 'Page opened', title: '', finalUrl: '', capturedAt: Date.now(), signals: [], facts: [], artifacts: {} };
    try {
        const presetId = String(preset && preset.id || '').trim();
        if (typeof page.waitForNetworkIdle === 'function') {
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => { });
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        let snapshot = await collectDiagnosticPageSnapshot(page);
        let result = buildDiagnosticResultFromSnapshot(preset, {
            ...snapshot,
            finalUrl: page.url(),
        });
        if (presetId === 'builtin-whoer' && isSparseWhoerDiagnosticSnapshot(snapshot, result)) {
            const previousTextLength = dedupeDiagnosticLines(snapshot && snapshot.bodyLines, 220).join('\n').length;
            await waitForWhoerDiagnosticDetails(page, previousTextLength, 7000);
            if (typeof page.waitForNetworkIdle === 'function') {
                await page.waitForNetworkIdle({ idleTime: 700, timeout: 4000 }).catch(() => { });
            }
            await new Promise(resolve => setTimeout(resolve, 1200));
            snapshot = await collectDiagnosticPageSnapshot(page);
            result = buildDiagnosticResultFromSnapshot(preset, {
                ...snapshot,
                finalUrl: page.url(),
            });
            if (isSparseWhoerDiagnosticSnapshot(snapshot, result)) {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
                await prepareDiagnosticPresetPage(page, preset).catch(() => { });
                if (typeof page.waitForNetworkIdle === 'function') {
                    await page.waitForNetworkIdle({ idleTime: 700, timeout: 4000 }).catch(() => { });
                }
                await new Promise(resolve => setTimeout(resolve, 1500));
                snapshot = await collectDiagnosticPageSnapshot(page);
                result = buildDiagnosticResultFromSnapshot(preset, {
                    ...snapshot,
                    finalUrl: page.url(),
                });
            }
        }
        const runId = buildDiagnosticRunId(openedAt, preset && preset.id);
        const effectiveNavigationError = navigationError && !hasUsableDiagnosticSnapshot(snapshot, result)
            ? navigationError
            : null;
        if (effectiveNavigationError) {
            result.status = normalizeDiagnosticResultStatus(result.status === 'ok' ? 'info' : 'warn');
            const message = normalizeDiagnosticText(effectiveNavigationError && effectiveNavigationError.message ? effectiveNavigationError.message : 'Navigation failed', 180);
            if (message && !String(result.summary || '').toLowerCase().includes(message.toLowerCase())) {
                result.summary = normalizeDiagnosticText(result.summary ? `${result.summary} | ${message}` : message, 240);
            }
        }
        result.artifacts = normalizeDiagnosticArtifacts(profileId, await captureDiagnosticPresetArtifacts(
            page,
            profileId,
            runId,
            buildDiagnosticStructuredSnapshot(preset, { ...snapshot, finalUrl: page.url() }, result, effectiveNavigationError)
        ));
        return result;
    } catch (e) {
        const runId = buildDiagnosticRunId(openedAt, preset && preset.id);
        const fallbackResult = {
            status: 'warn',
            headline: String(preset && preset.name || '').trim() || 'Diagnostic',
            summary: normalizeDiagnosticText(e && e.message ? e.message : 'Capture failed', 240),
            title: '',
            finalUrl: normalizeDiagnosticText(page && typeof page.url === 'function' ? page.url() : '', 280),
            capturedAt: Date.now(),
            signals: [],
            facts: [],
        };
        return {
            ...fallbackResult,
            artifacts: normalizeDiagnosticArtifacts(profileId, await captureDiagnosticPresetArtifacts(
                page,
                profileId,
                runId,
                buildDiagnosticStructuredSnapshot(preset, { title: '', headings: [], candidates: [], bodyLines: [], finalUrl: fallbackResult.finalUrl }, fallbackResult, e)
            ).catch(() => ({ runId }))),
        };
    }
}

async function prepareDiagnosticPresetPage(page, preset) {
    const presetId = String(preset && preset.id || '').trim();
    if (!page || !presetId) return;
    if (presetId === 'builtin-pixelscan') {
        const before = await page.evaluate(() => String(document.body && document.body.innerText || '').slice(0, 4000));
        const clicked = await page.evaluate(() => {
            const patterns = [/scan my browser/i, /run.*scan/i, /start.*scan/i, /scan now/i];
            const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
            const target = nodes.find((node) => {
                const text = String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                return text && (!rect || rect.width > 0 || rect.height > 0) && patterns.some((pattern) => pattern.test(text));
            });
            if (!target) return false;
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
            try { target.click(); return true; } catch (e) { return false; }
        }).catch(() => false);
        if (clicked) {
            await page.waitForFunction(() => /\/fingerprint-check(?:$|[/?#])/i.test(String(location.pathname || '')), { timeout: 12000 }).catch(() => { });
            await page.waitForNetworkIdle({ idleTime: 900, timeout: 15000 }).catch(() => { });
            await page.waitForFunction((previousText) => {
                const text = String(document.body && document.body.innerText || '');
                const lower = text.toLowerCase();
                if (!text) return false;
                if (/no obvious fingerprint inconsistencies|masking detected|proxy detected|bot detected|webrtc leak|fingerprint inconsistencies|no automated behavior detected|automated behavior detected/i.test(lower)) return true;
                if (text !== previousText && /what websites see about you|fingerprint scan/i.test(lower) && !/collecting data|scanning/i.test(lower)) return true;
                return text !== previousText && /what websites see about you|fingerprint scan/i.test(lower);
            }, { timeout: 15000 }, before).catch(() => { });
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return;
    }
    if (presetId === 'builtin-iphey') {
        const clicked = await page.evaluate(() => {
            const patterns = [/extended check/i];
            const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
            const target = nodes.find((node) => {
                const text = String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                return text && (!rect || rect.width > 0 || rect.height > 0) && patterns.some((pattern) => pattern.test(text));
            });
            if (!target) return false;
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
            try { target.click(); return true; } catch (e) { return false; }
        }).catch(() => false);
        if (clicked) {
            await page.waitForFunction(() => /\/leaks(?:$|[/?#])/i.test(String(location.pathname || '')) || /security|webrtc|fonts list/i.test(String(document.body && document.body.innerText || '').toLowerCase()), { timeout: 10000 }).catch(() => { });
            await page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }).catch(() => { });
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
        return;
    }
    if (presetId === 'builtin-whoer') {
        const beforeLength = await page.evaluate(() => String(document.body && document.body.innerText || '').length).catch(() => 0);
        await page.evaluate(() => {
            const patterns = [/^accept$/i, /^接受$/i, /^同意$/i];
            const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
            const target = nodes.find((node) => {
                const text = String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                return text && (!rect || rect.width > 0 || rect.height > 0) && patterns.some((pattern) => pattern.test(text));
            });
            if (!target) return false;
            try { target.click(); return true; } catch (e) { return false; }
        }).catch(() => false);
        await waitForWhoerDiagnosticDetails(page, beforeLength, 9000);
        const fingerprintTabClicked = await page.evaluate(() => {
            const patterns = [/check fingerprint/i, /检查浏览器指纹/i, /^browser fingerprint$/i, /^浏览器指纹$/i];
            const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
            const target = nodes.find((node) => {
                const text = String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                const href = String((typeof node.getAttribute === 'function' && node.getAttribute('href')) || node.href || '').trim();
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                return (!rect || rect.width > 0 || rect.height > 0)
                    && ((text && patterns.some((pattern) => pattern.test(text))) || /#tab-fingerprint$/i.test(href));
            });
            if (!target) return false;
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
            try { target.click(); return true; } catch (e) { return false; }
        }).catch(() => false);
        const afterFingerprintBaseline = await page.evaluate(() => String(document.body && document.body.innerText || '').length).catch(() => beforeLength);
        await waitForWhoerDiagnosticDetails(page, afterFingerprintBaseline, fingerprintTabClicked ? 9000 : 4000);
        const clicked = await page.evaluate(() => {
            const patterns = [/want to know more\?\s*use extended version/i, /use extended version/i, /使用扩展版本/i, /^more$/i, /^更详细$/i, /^扩展版$/i];
            const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
            const target = nodes.find((node) => {
                const text = String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                return text && (!rect || rect.width > 0 || rect.height > 0) && patterns.some((pattern) => pattern.test(text));
            });
            if (!target) return false;
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
            try { target.click(); return true; } catch (e) { return false; }
        }).catch(() => false);
        const afterClickBaseline = await page.evaluate(() => String(document.body && document.body.innerText || '').length).catch(() => afterFingerprintBaseline);
        await waitForWhoerDiagnosticDetails(page, afterClickBaseline, clicked ? 10000 : 7000);
        if (typeof page.waitForNetworkIdle === 'function') {
            await page.waitForNetworkIdle({ idleTime: 700, timeout: 5000 }).catch(() => { });
        }
        await new Promise(resolve => setTimeout(resolve, clicked ? 1500 : 900));
    }
}

function normalizeHeaderPresetId(value) {
    return String(value || '').trim();
}

function getRuntimeLikeContext(profile, proc) {
    if (proc && proc.runtimeContext) return proc.runtimeContext;
    const fingerprint = isPlainObject(profile && profile.fingerprint) ? profile.fingerprint : {};
    const language = String(fingerprint.language || '').trim();
    const fallbackLanguages = sanitizeResolvedLanguages('', Array.isArray(fingerprint.languages) ? fingerprint.languages : []);
    const effectiveLanguage = language && language !== AUTO_LANGUAGE
        ? (normalizeLocaleToken(language) || language)
        : (fallbackLanguages[0] || 'en-US');
    const languages = sanitizeResolvedLanguages(effectiveLanguage, fallbackLanguages);
    const timezone = String(fingerprint.timezone || '').trim();
    const geolocation = normalizeResolvedGeolocation(fingerprint.geolocation);
    return {
        language: effectiveLanguage,
        languages,
        acceptLanguage: buildAcceptLanguage(effectiveLanguage, languages),
        timezone: timezone && timezone !== AUTO_TIMEZONE ? timezone : '',
        geolocation,
        country: '',
        countryCode: '',
        city: String(fingerprint.city || '').trim(),
    };
}

function getLaunchLikeFingerprint(profile, proc) {
    if (proc && proc.launchFingerprint) return proc.launchFingerprint;
    return normalizeFingerprintForStorage(profile && profile.fingerprint, { fitMissingWindowToWorkArea: true });
}

function resolveActiveHeaderPreset(profile, proc, settings) {
    if (proc && proc.activeHeaderPreset) return normalizeHeaderPreset(proc.activeHeaderPreset);
    const presetId = normalizeHeaderPresetId(profile && profile.headerPresetId);
    if (!presetId) return null;
    const preset = findHeaderPresetById(settings, presetId);
    return preset ? normalizeHeaderPreset(preset) : null;
}

function buildSelfCheckSummary(profile, proc, settings) {
    const running = !!(proc && proc.browser && proc.browser.isConnected && proc.browser.isConnected());
    const runtimeContext = getRuntimeLikeContext(profile, proc);
    const launchFingerprint = getLaunchLikeFingerprint(profile, proc);
    const activeHeaderPreset = resolveActiveHeaderPreset(profile, proc, settings);
    const permissionStates = resolveRuntimePermissionStates(profile, runtimeContext);
    const items = [];
    const push = (key, label, status, message) => items.push({ key, label, status, message });

    if (!running) {
        push('runtime', 'Runtime', 'warn', 'Profile not running');
        return { status: 'warn', items };
    }

    const timezone = String(runtimeContext.timezone || '').trim();
    const timezoneOk = !timezone || timezone === String(launchFingerprint.timezone || '').trim();
    push(
        'timezone',
        'Timezone',
        timezoneOk ? 'ok' : 'warn',
        timezoneOk ? (timezone || 'not set') : `launch=${launchFingerprint.timezone || '-'} runtime=${timezone || '-'}`
    );

    const resolvedLanguage = String(runtimeContext.language || '').trim();
    const resolvedLanguages = Array.isArray(runtimeContext.languages)
        ? runtimeContext.languages.map(item => String(item || '').trim()).filter(Boolean)
        : [];
    const acceptLanguage = String(runtimeContext.acceptLanguage || '').trim();
    const languageOk = resolvedLanguage
        && resolvedLanguage === String(launchFingerprint.language || '').trim()
        && resolvedLanguages.length > 0
        && acceptLanguage.toLowerCase().includes(resolvedLanguage.split('-')[0].toLowerCase());
    push(
        'language',
        'Language',
        languageOk ? 'ok' : 'warn',
        languageOk ? `${resolvedLanguage} / ${acceptLanguage || '-'}` : `launch=${launchFingerprint.language || '-'} runtime=${resolvedLanguage || '-'}`
    );

    const geoPermissionState = String(permissionStates.geolocation || 'prompt').trim() || 'prompt';
    const runtimeGeolocation = normalizeResolvedGeolocation(runtimeContext.geolocation);
    const exposedGeolocation = normalizeResolvedGeolocation(launchFingerprint.geolocation);
    const geolocationOk = geoPermissionState === 'granted'
        ? !!runtimeGeolocation && !!exposedGeolocation
        : !exposedGeolocation;
    push(
        'geolocation',
        'Geolocation',
        geolocationOk ? 'ok' : 'warn',
        geoPermissionState === 'granted'
            ? (runtimeGeolocation ? `${runtimeGeolocation.latitude}, ${runtimeGeolocation.longitude}` : 'missing coordinates')
            : `${geoPermissionState} (${exposedGeolocation ? 'coordinates still exposed' : 'coordinates withheld'})`
    );
    push('cameraPermission', 'Camera Permission', 'ok', permissionStates.camera);
    push('microphonePermission', 'Microphone Permission', 'ok', permissionStates.microphone);
    push('notificationPermission', 'Notification Permission', 'ok', permissionStates.notifications);

    const headerRulesCount = activeHeaderPreset && activeHeaderPreset.enabled !== false
        ? activeHeaderPreset.rules.filter(rule => rule.enabled !== false).length
        : 0;
    push(
        'headers',
        'Header Rules',
        'ok',
        headerRulesCount > 0 ? `${activeHeaderPreset.name} (${headerRulesCount} rules)` : 'not bound'
    );

    const clientHints = buildExpectedClientHints(launchFingerprint);
    const clientHintsOk = !!(clientHints.platform && clientHints.chromeVersion);
    push(
        'clientHints',
        'Client Hints',
        clientHintsOk ? 'ok' : 'warn',
        clientHintsOk
            ? `${clientHints.platform} / ${clientHints.architecture}${clientHints.bitness ? ` ${clientHints.bitness}` : ''} / Chrome ${clientHints.chromeVersion}`
            : 'missing userAgentMetadata'
    );

    const configuredFonts = Array.isArray(launchFingerprint.fonts)
        ? launchFingerprint.fonts.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    push(
        'fonts',
        'Fonts',
        configuredFonts.length > 0 ? 'ok' : 'info',
        configuredFonts.length > 0 ? `${configuredFonts.length} configured` : 'no configured fonts'
    );

    const configuredMediaDevices = Array.isArray(launchFingerprint.mediaDevices)
        ? launchFingerprint.mediaDevices.filter((item) => isPlainObject(item))
        : [];
    push(
        'mediaDevices',
        'Media Devices',
        'ok',
        configuredMediaDevices.length > 0 ? `${configuredMediaDevices.length} custom devices` : 'default synthetic device set'
    );

    const webgl = isPlainObject(launchFingerprint.webgl) ? launchFingerprint.webgl : null;
    push(
        'graphics',
        'Graphics Fingerprint',
        webgl && (webgl.vendor || webgl.renderer) ? 'ok' : 'info',
        webgl && (webgl.vendor || webgl.renderer)
            ? `${String(webgl.vendor || '').trim() || '-'} / ${String(webgl.renderer || '').trim() || '-'}`
            : 'no explicit graphics fingerprint'
    );

    return {
        status: items.some(item => item.status === 'warn') ? 'warn' : 'ok',
        items,
    };
}

async function buildDiagnosticsPayload(profile, proc, settings) {
    const runtimeContext = getRuntimeLikeContext(profile, proc);
    const launchFingerprint = getLaunchLikeFingerprint(profile, proc);
    const activeHeaderPreset = resolveActiveHeaderPreset(profile, proc, settings);
    const permissionStates = resolveRuntimePermissionStates(profile, runtimeContext);
    const geoPermissionState = String(permissionStates.geolocation || 'prompt').trim() || 'prompt';
    const history = await readDiagnosticHistory(profile.id);
    const recentRuns = history.map((entry, index) => {
        const previousSamePreset = history.slice(index + 1).find((item) => String(item && item.presetId || '').trim() === String(entry && entry.presetId || '').trim());
        return previousSamePreset
            ? { ...entry, comparison: buildDiagnosticRunComparison(entry, previousSamePreset) }
            : entry;
    });

    const clientHints = buildExpectedClientHints(launchFingerprint);

    return {
        presets: resolveDiagnosticPresets(settings).filter(item => item.enabled !== false),
        recentRuns,
        activeHeaderPresetId: activeHeaderPreset ? activeHeaderPreset.id : '',
        geoPermissionState,
        permissionStates,
        headerPreview: buildHeaderPreview(activeHeaderPreset, buildHeaderTemplateVariables(runtimeContext, launchFingerprint)),
        expectedBrowser: {
            userAgent: String(launchFingerprint.userAgent || '').trim(),
            platform: String(launchFingerprint.platform || '').trim(),
            language: String(runtimeContext.language || '').trim(),
            languages: Array.isArray(runtimeContext.languages) ? runtimeContext.languages : [],
            acceptLanguage: String(runtimeContext.acceptLanguage || '').trim(),
            timezone: String(runtimeContext.timezone || '').trim(),
            geolocation: geoPermissionState === 'granted' ? normalizeResolvedGeolocation(launchFingerprint.geolocation) : null,
            geoPermissionState,
            permissionStates,
            clientHints,
            fonts: Array.isArray(launchFingerprint.fonts)
                ? launchFingerprint.fonts.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 32)
                : [],
            mediaDevices: Array.isArray(launchFingerprint.mediaDevices)
                ? launchFingerprint.mediaDevices
                    .filter((item) => isPlainObject(item))
                    .map((item) => ({
                        kind: String(item.kind || '').trim(),
                        label: String(item.label || '').trim(),
                        deviceId: String(item.deviceId || '').trim(),
                        groupId: String(item.groupId || '').trim(),
                    }))
                    .slice(0, 16)
                : [],
            webgl: isPlainObject(launchFingerprint.webgl)
                ? {
                    vendor: String(launchFingerprint.webgl.vendor || '').trim(),
                    renderer: String(launchFingerprint.webgl.renderer || '').trim(),
                }
                : null,
        },
        selfCheckSummary: buildSelfCheckSummary(profile, proc, settings),
    };
}

function isBrowserProcessRunning(proc) {
    return !!(proc && proc.browser && proc.browser.isConnected && proc.browser.isConnected());
}

function buildProfileDashboardUrl(profileId, appLang = '') {
    const params = new URLSearchParams({ profile: String(profileId || '').trim() });
    const normalizedAppLang = normalizeOptionalUiLanguage(appLang);
    if (normalizedAppLang) params.set('appLang', normalizedAppLang);
    return `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}/dashboard?${params.toString()}`;
}

async function openProfileDashboardInternal(profileId, proc = activeProcesses[profileId], appLang = '') {
    if (!isBrowserProcessRunning(proc)) throw new Error('Profile not running');
    const dashboardBaseUrl = buildProfileDashboardUrl(profileId);
    const dashboardUrl = buildProfileDashboardUrl(profileId, appLang || currentUiLanguage);
    const pages = await proc.browser.pages().catch(() => []);
    const page = pages.find((item) => {
        try {
            return String(item.url() || '').startsWith(dashboardBaseUrl);
        } catch (e) {
            return false;
        }
    }) || pages.find((item) => {
        try {
            return isBlankOrNewTabUrl(item.url());
        } catch (e) {
            return false;
        }
    }) || await proc.browser.newPage();
    await applyRuntimeContextToPage(page, proc.runtimeContext, proc.launchFingerprint, proc.activeHeaderPreset).catch(() => { });
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.bringToFront().catch(() => { });
    return dashboardUrl;
}

async function runDiagnosticPresetForProfile(profile, proc, preset) {
    const profileId = String(profile && profile.id || '').trim();
    if (!profileId) throw new Error('Profile not found');
    if (!preset) throw new Error('Diagnostic preset not found');
    if (!isBrowserProcessRunning(proc)) throw new Error('Profile not running');

    let historyEntry = null;
    try {
        const page = await proc.browser.newPage();
        const openedAt = Date.now();
        let navigationError = null;
        try {
            await applyRuntimeContextToPage(page, proc.runtimeContext, proc.launchFingerprint, proc.activeHeaderPreset).catch(() => { });
            await page.goto(preset.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await prepareDiagnosticPresetPage(page, preset).catch(() => { });
        } catch (e) {
            navigationError = e;
        }
        await page.bringToFront().catch(() => { });
        historyEntry = {
            presetId: preset.id,
            name: preset.name,
            url: preset.url,
            openedAt,
            profileId,
            result: await captureDiagnosticPresetResult(page, preset, profileId, openedAt, navigationError),
        };
        await appendDiagnosticHistory(profileId, historyEntry);
    } catch (e) {
        historyEntry = {
            presetId: preset.id,
            name: preset.name,
            url: preset.url,
            openedAt: Date.now(),
            profileId,
            result: {
                status: 'warn',
                headline: preset.name,
                summary: normalizeDiagnosticText(e && e.message ? e.message : 'Failed to open diagnostic preset', 240),
                title: '',
                finalUrl: preset.url,
                capturedAt: Date.now(),
                signals: [],
                facts: [],
            }
        };
        await appendDiagnosticHistory(profileId, historyEntry).catch(() => { });
    }
    return historyEntry;
}

async function runAllDiagnosticPresetsForProfile(profile, proc, settings) {
    const presets = resolveDiagnosticPresets(settings).filter((item) => item.enabled !== false);
    for (const preset of presets) {
        await runDiagnosticPresetForProfile(profile, proc, preset);
    }
    return presets.length;
}

const COUNTRY_NAME_TO_CODE = {
    'united states': 'US',
    'united kingdom': 'GB',
    'great britain': 'GB',
    'canada': 'CA',
    'mexico': 'MX',
    'argentina': 'AR',
    'chile': 'CL',
    'colombia': 'CO',
    'brazil': 'BR',
    'portugal': 'PT',
    'spain': 'ES',
    'france': 'FR',
    'germany': 'DE',
    'italy': 'IT',
    'netherlands': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'austria': 'AT',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'poland': 'PL',
    'czech republic': 'CZ',
    'czechia': 'CZ',
    'hungary': 'HU',
    'romania': 'RO',
    'greece': 'GR',
    'turkey': 'TR',
    'russia': 'RU',
    'ukraine': 'UA',
    'china': 'CN',
    'taiwan': 'TW',
    'hong kong': 'HK',
    'japan': 'JP',
    'south korea': 'KR',
    'korea, republic of': 'KR',
    'thailand': 'TH',
    'vietnam': 'VN',
    'indonesia': 'ID',
    'malaysia': 'MY',
    'philippines': 'PH',
    'india': 'IN',
    'australia': 'AU',
    'new zealand': 'NZ',
    'saudi arabia': 'SA',
    'united arab emirates': 'AE',
    'israel': 'IL',
    'south africa': 'ZA',
    'ireland': 'IE',
};

const COUNTRY_TO_LOCALE = {
    US: 'en-US',
    GB: 'en-GB',
    CA: 'en-CA',
    MX: 'es-MX',
    AR: 'es-AR',
    CL: 'es-CL',
    CO: 'es-CO',
    BR: 'pt-BR',
    PT: 'pt-PT',
    ES: 'es-ES',
    FR: 'fr-FR',
    DE: 'de-DE',
    IT: 'it-IT',
    NL: 'nl-NL',
    BE: 'nl-BE',
    CH: 'de-CH',
    AT: 'de-AT',
    SE: 'sv-SE',
    NO: 'no-NO',
    DK: 'da-DK',
    FI: 'fi-FI',
    PL: 'pl-PL',
    CZ: 'cs-CZ',
    HU: 'hu-HU',
    RO: 'ro-RO',
    GR: 'el-GR',
    TR: 'tr-TR',
    RU: 'ru-RU',
    UA: 'uk-UA',
    CN: 'zh-CN',
    TW: 'zh-TW',
    HK: 'zh-HK',
    JP: 'ja-JP',
    KR: 'ko-KR',
    TH: 'th-TH',
    VN: 'vi-VN',
    ID: 'id-ID',
    MY: 'ms-MY',
    PH: 'fil-PH',
    IN: 'en-IN',
    AU: 'en-AU',
    NZ: 'en-NZ',
    SA: 'ar-SA',
    AE: 'ar-AE',
    IL: 'he-IL',
    ZA: 'en-ZA',
    IE: 'en-IE',
};

function isValidHttpUrl(raw) {
    try {
        const value = String(raw || '').trim();
        if (!value) return false;
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function normalizeStartupUrls(value) {
    const list = Array.isArray(value)
        ? value
        : String(value || '').split(/[\r\n]+/);
    return Array.from(new Set(
        list
            .map(item => String(item || '').trim())
            .filter(isValidHttpUrl)
    ));
}

function getProfileStartupUrls(profile) {
    return normalizeStartupUrls(profile && profile.startupUrls);
}

function getCookieTargetUrl(profile, override) {
    if (isValidHttpUrl(override)) return String(override).trim();
    const startupUrls = getProfileStartupUrls(profile);
    return startupUrls[0] || '';
}

function resolveCountryCode(country, countryCode) {
    const explicit = String(countryCode || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(explicit)) return explicit;
    const raw = String(country || '').trim();
    if (/^[A-Z]{2}$/.test(raw)) return raw.toUpperCase();
    const mapped = COUNTRY_NAME_TO_CODE[raw.toLowerCase()];
    return mapped || '';
}

function resolveLanguageByCountry(country, countryCode) {
    const code = resolveCountryCode(country, countryCode);
    return COUNTRY_TO_LOCALE[code] || 'en-US';
}

function normalizeLocaleToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const firstToken = raw.split(',')[0].trim().replace(/;q=\d(?:\.\d+)?$/i, '').trim().replace(/_/g, '-');
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(firstToken)) return '';
    const parts = firstToken.split('-').filter(Boolean);
    if (parts.length === 0) return '';
    return parts.map((part, index) => {
        if (index === 0) return part.toLowerCase();
        if (/^\d+$/.test(part)) return part;
        return part.length <= 2 ? part.toUpperCase() : (part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }).join('-');
}

function sanitizeResolvedLanguages(locale, languages) {
    const primary = normalizeLocaleToken(locale);
    const ordered = [];
    const seen = new Set();
    const push = (value) => {
        const token = normalizeLocaleToken(value);
        const key = token.toLowerCase();
        if (!token || seen.has(key)) return;
        seen.add(key);
        ordered.push(token);
    };

    if (primary) push(primary);
    for (const item of Array.isArray(languages) ? languages : []) push(item);
    if (ordered.length === 0) {
        const fallback = primary || 'en-US';
        const base = fallback.split('-')[0];
        return base && base !== fallback ? [fallback, base] : [fallback];
    }
    const base = ordered[0].split('-')[0];
    if (base && !seen.has(base.toLowerCase())) ordered.push(base);
    return ordered;
}

function buildResolvedLanguages(locale) {
    return sanitizeResolvedLanguages(locale || 'en-US', []);
}

function buildAcceptLanguage(locale, languages) {
    const ordered = sanitizeResolvedLanguages(locale, languages);
    if (!ordered.some(item => /^en(?:-|$)/i.test(item))) {
        for (const item of ['en-US', 'en']) {
            if (!ordered.some(existing => existing.toLowerCase() === item.toLowerCase())) ordered.push(item);
        }
    }
    return ordered
        .map((item, index) => {
            if (index === 0) return item;
            const q = Math.max(0.1, 1 - (index * 0.1));
            return `${item};q=${q.toFixed(1)}`;
        })
        .join(',');
}

function buildCdpAcceptLanguage(locale, languages, acceptLanguage = '') {
    const ordered = [];
    const seen = new Set();
    const push = (value) => {
        const token = normalizeLocaleToken(value);
        const key = token.toLowerCase();
        if (!token || seen.has(key)) return;
        seen.add(key);
        ordered.push(token);
    };

    const headerValue = String(acceptLanguage || '').trim();
    if (headerValue) {
        for (const item of headerValue.split(',')) push(item);
    }
    for (const item of sanitizeResolvedLanguages(locale, languages)) push(item);
    if (!ordered.some(item => /^en(?:-|$)/i.test(item))) {
        push('en-US');
        push('en');
    }
    return ordered.join(',');
}

function normalizeResolvedGeolocation(source, fallbackAccuracy = 100) {
    if (!isPlainObject(source)) return null;
    const latitude = Number(source.latitude);
    const longitude = Number(source.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const accuracy = Number.isFinite(Number(source.accuracy)) ? Math.max(1, Number(source.accuracy)) : fallbackAccuracy;
    return { latitude, longitude, accuracy };
}

function requestViaAgent(url, agent, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https:') ? https : http;
        const req = mod.get(url, {
            agent,
            timeout: timeoutMs,
            headers: { 'User-Agent': 'GeekEZ-Browser' }
        }, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => buf += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: buf }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function createLocalSocksAgent(localPort) {
    if (!Number.isFinite(Number(localPort)) || Number(localPort) <= 0) throw new Error('Invalid local proxy port');
    return new SocksProxyAgent(`socks5h://127.0.0.1:${Number(localPort)}`);
}

async function fetchIpViaAgent(agent) {
    const urls = [
        'https://api.ipify.org?format=text',
        'https://ifconfig.me/ip',
        'https://ipinfo.io/ip',
    ];
    for (const url of urls) {
        try {
            const { body } = await requestViaAgent(url, agent);
            const ip = String(body || '').trim();
            if (ip && ip.length <= 64) return { ip, source: url };
        } catch (e) { }
    }
    throw new Error('IP fetch failed');
}

async function fetchProxyIpViaLocalPort(localPort) {
    return fetchIpViaAgent(createLocalSocksAgent(localPort));
}

function normalizeNetinfoPayload(url, obj) {
    const data = obj && typeof obj === 'object' ? obj : {};
    const ip = String(data.ip || data.ip_address || '').trim();
    if (!ip) return null;

    const country = String(data.country_name || data.country || '').trim();
    const countryCode = resolveCountryCode(country, data.country_code || data.countryCode || data.country_code_iso || '');
    const region = String(data.region || data.region_name || '').trim();
    const city = String(data.city || '').trim();
    let timezone = '';
    if (data.timezone && typeof data.timezone === 'object') timezone = String(data.timezone.id || data.timezone.name || '').trim();
    else timezone = String(data.timezone || '').trim();

    let latitude = data.latitude ?? data.lat;
    let longitude = data.longitude ?? data.lon;
    if ((latitude === undefined || longitude === undefined) && typeof data.loc === 'string' && data.loc.includes(',')) {
        const [latRaw, lonRaw] = data.loc.split(',');
        const parsedLat = Number.parseFloat(latRaw);
        const parsedLon = Number.parseFloat(lonRaw);
        if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
            latitude = parsedLat;
            longitude = parsedLon;
        }
    }

    const postal = String(data.postal || data.zip || '').trim();
    const org = String(data.org || (data.connection && data.connection.isp) || '').trim();
    const asnValue = data.asn;
    const asn = String((asnValue && typeof asnValue === 'object' ? (asnValue.asn || asnValue.number || '') : asnValue) || (data.connection && data.connection.asn) || '').trim();

    return {
        ip,
        country,
        countryCode,
        region,
        city,
        timezone,
        latitude: (latitude === undefined || latitude === null || latitude === '') ? null : Number(latitude),
        longitude: (longitude === undefined || longitude === null || longitude === '') ? null : Number(longitude),
        postal,
        org,
        asn,
        source: url,
    };
}

async function fetchProxyNetinfoViaLocalPort(localPort) {
    return fetchNetinfoViaAgent(createLocalSocksAgent(localPort));
}

async function fetchNetinfoViaAgent(agent) {
    const urls = [
        'https://ipwho.is/',
        'https://ipapi.co/json/',
        'https://ipinfo.io/json',
    ];
    for (const url of urls) {
        try {
            const { body } = await requestViaAgent(url, agent);
            const parsed = JSON.parse(String(body || '').trim() || '{}');
            const normalized = normalizeNetinfoPayload(url, parsed);
            if (normalized && normalized.ip) return normalized;
        } catch (e) { }
    }
    throw new Error('Netinfo fetch failed');
}

async function probeProxyConnectivityViaAgent(agent, timeoutMs = 5000) {
    const urls = [
        'http://cp.cloudflare.com/generate_204',
        'https://www.google.com/generate_204',
        'https://archive.org/',
        'https://www.wikipedia.org/',
    ];
    let lastError = 'Connection test failed';
    let lastUrl = '';
    for (const url of urls) {
        lastUrl = url;
        const startedAt = Date.now();
        try {
            const { statusCode } = await requestViaAgent(url, agent, timeoutMs);
            const latencyMs = Date.now() - startedAt;
            if (statusCode === 204 || (statusCode >= 200 && statusCode < 400)) {
                return { success: true, checkedUrl: url, statusCode, latencyMs };
            }
            lastError = `HTTP ${statusCode}`;
        } catch (e) {
            lastError = e && e.message ? e.message : String(e);
        }
    }
    return { success: false, checkedUrl: lastUrl, error: lastError };
}

async function probeProxyConnectivityViaLocalPort(localPort, timeoutMs = 5000) {
    return probeProxyConnectivityViaAgent(createLocalSocksAgent(localPort), timeoutMs);
}

async function startTemporaryLocalProxyForProxy(proxyStr, label = 'proxy-test') {
    const proxyValue = String(proxyStr || '').trim();
    if (!proxyValue) throw new Error('Proxy not configured');

    const tempRoot = await fs.mkdtemp(path.join(app.getPath('temp'), `geekez-${sanitizeDiagnosticArtifactSegment(label)}-`));
    const tempPort = await getPort();
    const tempConfigPath = path.join(tempRoot, `xray-${tempPort}.json`);
    const sshDir = path.join(tempRoot, 'ssh');
    let sshInfo = null;
    let xrayPid = null;
    let logFd;

    try {
        let effectiveProxy = proxyValue;
        if (effectiveProxy.startsWith('ssh://')) {
            fs.ensureDirSync(sshDir);
            sshInfo = await startSshDynamicProxy(effectiveProxy, sshDir);
            effectiveProxy = `socks5://127.0.0.1:${sshInfo.localPort}`;
        }

        let outbound;
        try {
            const { parseProxyLink } = require('./utils');
            outbound = parseProxyLink(effectiveProxy, 'proxy_test');
        } catch (e) {
            throw new Error('Format Err');
        }

        const xrayBinPath = getAvailableXrayBinaryPath();
        if (!xrayBinPath) throw new Error('Xray binary not found.');

        const config = {
            log: { loglevel: 'none' },
            inbounds: [{ port: tempPort, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } }],
            outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }],
            routing: { rules: [{ type: 'field', outboundTag: 'proxy_test', port: '0-65535' }] }
        };

        await fs.writeJson(tempConfigPath, config);
        const xrayLogPath = path.join(tempRoot, 'xray.log');
        logFd = fs.openSync(xrayLogPath, 'a');
        let spawnError = '';
        const xrayProcess = spawn(xrayBinPath, ['run', '-c', tempConfigPath], {
            cwd: path.dirname(xrayBinPath),
            env: { ...process.env, XRAY_LOCATION_ASSET: RESOURCES_BIN },
            stdio: ['ignore', logFd, logFd],
            windowsHide: true
        });
        xrayPid = xrayProcess.pid;
        xrayProcess.once('error', (err) => {
            spawnError = err && err.message ? err.message : String(err);
        });

        const ready = await waitForTcpPort('127.0.0.1', tempPort, 4000, () => !!spawnError || xrayProcess.exitCode !== null);
        if (!ready) throw new Error(spawnError || 'Local proxy failed to start.');

        return {
            localPort: tempPort,
            cleanup: async () => {
                if (xrayPid) await forceKill(xrayPid);
                if (sshInfo && sshInfo.pid) await forceKill(sshInfo.pid);
                if (logFd !== undefined) {
                    try { fs.closeSync(logFd); } catch (e) { }
                    logFd = undefined;
                }
                if (sshInfo && sshInfo.logFd !== undefined) {
                    try { fs.closeSync(sshInfo.logFd); } catch (e) { }
                    sshInfo.logFd = undefined;
                }
                try { await fs.remove(tempRoot); } catch (e) { }
            }
        };
    } catch (err) {
        if (xrayPid) await forceKill(xrayPid);
        if (sshInfo && sshInfo.pid) await forceKill(sshInfo.pid);
        if (logFd !== undefined) { try { fs.closeSync(logFd); } catch (e) { } }
        if (sshInfo && sshInfo.logFd !== undefined) { try { fs.closeSync(sshInfo.logFd); } catch (e) { } }
        try { await fs.remove(tempRoot); } catch (e) { }
        throw err;
    }
}

function buildProxyTestResultSummary(result) {
    const current = normalizeProxyTestResult(result);
    if (current.success) {
        return [
            current.ip || '',
            [current.city, current.region, current.country].filter(Boolean).join(', '),
            current.latencyMs != null ? `${current.latencyMs} ms` : '',
        ].filter(Boolean).join(' · ') || 'Proxy reachable';
    }
    if (current.direct) return 'No proxy configured';
    return current.error || 'Proxy check failed';
}

function buildProxyTestResult(result, defaults = {}) {
    const output = normalizeProxyTestResult({ ...defaults, ...result });
    output.summary = buildProxyTestResultSummary(output);
    return output;
}

async function testLocalProxyPortInternal(localPort, defaults = {}) {
    const connectivity = await probeProxyConnectivityViaLocalPort(localPort);
    if (!connectivity.success) {
        return buildProxyTestResult({
            success: false,
            status: 'warn',
            checkedUrl: connectivity.checkedUrl,
            statusCode: connectivity.statusCode,
            error: connectivity.error || 'Connection test failed',
        }, defaults);
    }
    let netinfo = null;
    let ipInfo = null;
    try {
        netinfo = await fetchProxyNetinfoViaLocalPort(localPort);
    } catch (e) {
        try { ipInfo = await fetchProxyIpViaLocalPort(localPort); } catch (inner) { }
    }
    return buildProxyTestResult({
        success: true,
        status: 'ok',
        latencyMs: connectivity.latencyMs,
        checkedUrl: connectivity.checkedUrl,
        statusCode: connectivity.statusCode,
        ip: String((netinfo && netinfo.ip) || (ipInfo && ipInfo.ip) || '').trim(),
        country: String((netinfo && netinfo.country) || '').trim(),
        region: String((netinfo && netinfo.region) || '').trim(),
        city: String((netinfo && netinfo.city) || '').trim(),
        timezone: String((netinfo && netinfo.timezone) || '').trim(),
        postal: String((netinfo && netinfo.postal) || '').trim(),
        org: String((netinfo && netinfo.org) || '').trim(),
        asn: String((netinfo && netinfo.asn) || '').trim(),
        source: String((netinfo && netinfo.source) || (ipInfo && ipInfo.source) || '').trim(),
    }, defaults);
}

async function testProxyConfigInternal(proxyStr) {
    const rawProxy = String(proxyStr || '').trim();
    const defaults = {
        checkedAt: Date.now(),
        proxyType: detectProxyType(rawProxy),
        proxySnapshot: rawProxy,
        running: false,
        mode: 'ephemeral',
    };
    if (!rawProxy) {
        return buildProxyTestResult({
            success: false,
            status: 'info',
            direct: true,
            mode: 'direct',
            error: 'No proxy configured',
        }, defaults);
    }
    try {
        const tempProxy = await startTemporaryLocalProxyForProxy(rawProxy, 'proxy-config-test');
        try {
            return await testLocalProxyPortInternal(tempProxy.localPort, defaults);
        } finally {
            await tempProxy.cleanup();
        }
    } catch (e) {
        return buildProxyTestResult({
            success: false,
            status: 'warn',
            error: e && e.message ? e.message : String(e),
        }, defaults);
    }
}

async function resolveLaunchPreProxySelection(settings) {
    const active = Array.isArray(settings && settings.preProxies)
        ? settings.preProxies.filter((item) => item && item.enable !== false)
        : [];
    if (active.length === 0) {
        throw new Error('Pre-proxy is enabled but no active pre-proxy is available.');
    }

    const mode = String(settings && settings.mode || 'single').trim();
    const buildMessage = (prefix, target) => {
        const label = String(target && (target.remark || target.id || target.url) || 'node').trim() || 'node';
        return `${prefix}: [${label}]`;
    };

    if (mode === 'single') {
        const target = active.find((item) => item.id === settings.selectedId) || active[0];
        return { preProxyConfig: { preProxies: [target] }, switchMsg: null };
    }

    if (mode === 'balance') {
        const target = active[Math.floor(Math.random() * active.length)];
        return {
            preProxyConfig: { preProxies: [target] },
            switchMsg: settings && settings.notify ? buildMessage('Balance', target) : null,
        };
    }

    const failures = [];
    for (const target of active) {
        const result = await testProxyConfigInternal(String(target && target.url || '').trim());
        if (result && result.success) {
            return {
                preProxyConfig: { preProxies: [target] },
                switchMsg: settings && settings.notify ? buildMessage('Failover', target) : null,
            };
        }
        const label = String(target && (target.remark || target.id || target.url) || 'node').trim() || 'node';
        const reason = String((result && (result.error || result.summary)) || 'Probe failed').trim();
        failures.push(`${label}: ${reason}`);
    }

    throw new Error(`Failover: no active pre-proxy passed connectivity check. ${failures.slice(0, 3).join(' | ')}`);
}

async function testProfileProxyInternal(profile, proc = activeProcesses[String(profile && profile.id || '').trim()]) {
    const profileId = String(profile && profile.id || '').trim();
    if (!profileId) throw new Error('Profile not found');

    const checkedAt = Date.now();
    const settings = await readSettingsAsync();
    const proxyBinding = resolveProfileProxyBinding(profile, settings, proc);
    const proxyStr = String(proxyBinding && proxyBinding.proxyStr || '').trim();
    const proxyType = detectProxyType(proxyStr);
    const running = isBrowserProcessRunning(proc);

    const finalizeResult = async (result) => {
        const previous = await readProfileProxyTestResult(profileId);
        const output = mergeProxyTestHistory(buildProxyTestResult(result, {
            running,
            proxyType,
            proxySnapshot: proxyStr,
            checkedAt,
            proxySource: proxyBinding.source,
            savedProxyId: proxyBinding.savedProxyId,
            savedProxyName: proxyBinding.savedProxyName,
            proxyBindingBroken: proxyBinding.bindingBroken,
        }), previous);
        await writeProfileProxyTestResult(profileId, output);
        return output;
    };

    if (running && proc && proc.localPort) return finalizeResult(await testLocalProxyPortInternal(proc.localPort, { mode: 'runtime' }));
    if (!proxyStr) {
        return finalizeResult({
            success: false,
            status: 'info',
            direct: true,
            mode: 'direct',
            error: 'No proxy configured',
        });
    }

    try {
        const tempProxy = await startTemporaryLocalProxyForProxy(proxyStr, `proxy-test-${profileId}`);
        try {
            return finalizeResult(await testLocalProxyPortInternal(tempProxy.localPort, { mode: 'ephemeral' }));
        } finally {
            await tempProxy.cleanup();
        }
    } catch (e) {
        return finalizeResult({
            success: false,
            status: 'warn',
            mode: 'ephemeral',
            error: e && e.message ? e.message : String(e),
        });
    }
}

async function testSavedProfileProxyInternal(savedProxyId) {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) throw new Error('Saved proxy not found');
    const settings = await readSettingsAsync();
    const savedProxy = findSavedProfileProxyById(settings, id);
    if (!savedProxy) throw new Error('Saved proxy not found');

    const proxyStr = String(savedProxy.proxyStr || '').trim();
    const defaults = {
        checkedAt: Date.now(),
        running: false,
        mode: proxyStr ? 'ephemeral' : 'direct',
        direct: !proxyStr,
        proxyType: detectProxyType(proxyStr),
        proxySnapshot: proxyStr,
        proxySource: 'saved-library',
        savedProxyId: savedProxy.id,
        savedProxyName: savedProxy.name || savedProxy.id,
        proxyBindingBroken: false,
    };
    const previous = await readSavedProfileProxyTestResult(savedProxy.id);
    const output = mergeProxyTestHistory(buildProxyTestResult(await testProxyConfigInternal(proxyStr), defaults), previous);
    await writeSavedProfileProxyTestResult(savedProxy.id, output);
    return output;
}

async function resolveRuntimeContext(profile, localPort) {
    const fingerprint = isPlainObject(profile && profile.fingerprint) ? profile.fingerprint : {};
    const manualTimezone = String(fingerprint.timezone || '').trim();
    const manualLanguage = String(fingerprint.language || '').trim();
    const manualGeolocation = normalizeResolvedGeolocation(fingerprint.geolocation);
    const manualCity = String(fingerprint.city || '').trim();

    let netinfo = null;
    let error = '';
    try {
        netinfo = await fetchProxyNetinfoViaLocalPort(localPort);
    } catch (e) {
        error = e && e.message ? e.message : String(e);
    }

    const resolvedTimezone = (manualTimezone && manualTimezone !== AUTO_TIMEZONE)
        ? manualTimezone
        : String((netinfo && netinfo.timezone) || '').trim();
    const resolvedLanguage = (manualLanguage && manualLanguage !== AUTO_LANGUAGE)
        ? manualLanguage
        : resolveLanguageByCountry(netinfo && netinfo.country, netinfo && netinfo.countryCode);
    const resolvedLanguages = buildResolvedLanguages(resolvedLanguage);
    const resolvedGeolocation = manualGeolocation
        || normalizeResolvedGeolocation(netinfo ? {
            latitude: netinfo.latitude,
            longitude: netinfo.longitude,
            accuracy: 100
        } : null);

    return {
        ip: String((netinfo && netinfo.ip) || '').trim(),
        country: String((netinfo && netinfo.country) || '').trim(),
        countryCode: resolveCountryCode(netinfo && netinfo.country, netinfo && netinfo.countryCode),
        region: String((netinfo && netinfo.region) || '').trim(),
        city: manualCity || String((netinfo && netinfo.city) || '').trim(),
        timezone: resolvedTimezone,
        geolocation: resolvedGeolocation,
        language: resolvedLanguage || 'en-US',
        languages: resolvedLanguages,
        acceptLanguage: buildAcceptLanguage(resolvedLanguage || 'en-US', resolvedLanguages),
        netinfo,
        autoCalibration: {
            error,
            source: netinfo ? String(netinfo.source || '') : '',
        },
    };
}

function parsePositiveInt(value, fallback) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeObjects(base, patch) {
    const source = isPlainObject(base) ? base : {};
    const delta = isPlainObject(patch) ? patch : {};
    const out = { ...source };

    for (const [key, value] of Object.entries(delta)) {
        if (isPlainObject(value) && isPlainObject(source[key])) out[key] = deepMergeObjects(source[key], value);
        else out[key] = value;
    }

    return out;
}

function sanitizeSize(size, fallback) {
    const base = fallback || DEFAULT_BROWSER_WINDOW;
    return {
        width: parsePositiveInt(size && size.width, base.width),
        height: parsePositiveInt(size && size.height, base.height),
    };
}

function getPreferredWorkAreaBounds() {
    const fallback = { x: 0, y: 0, width: DEFAULT_FINGERPRINT_SCREEN.width, height: DEFAULT_FINGERPRINT_SCREEN.height };
    try {
        if (!app || typeof app.isReady !== 'function' || !app.isReady()) return fallback;

        let display = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            display = screen.getDisplayMatching(mainWindow.getBounds());
        }

        if (!display && BrowserWindow.getFocusedWindow) {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused && !focused.isDestroyed()) {
                display = screen.getDisplayMatching(focused.getBounds());
            }
        }

        if (!display && screen.getCursorScreenPoint && screen.getDisplayNearestPoint) {
            display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        }

        if (!display && screen.getPrimaryDisplay) display = screen.getPrimaryDisplay();
        const workArea = (display && display.workArea) || fallback;
        return {
            x: Number.isFinite(workArea.x) ? workArea.x : 0,
            y: Number.isFinite(workArea.y) ? workArea.y : 0,
            width: parsePositiveInt(workArea.width, fallback.width),
            height: parsePositiveInt(workArea.height, fallback.height),
        };
    } catch (e) {
        return fallback;
    }
}

function fitWindowSizeToWorkArea(size, workArea = getPreferredWorkAreaBounds()) {
    const area = {
        x: Number.isFinite(workArea && workArea.x) ? workArea.x : 0,
        y: Number.isFinite(workArea && workArea.y) ? workArea.y : 0,
        width: parsePositiveInt(workArea && workArea.width, DEFAULT_FINGERPRINT_SCREEN.width),
        height: parsePositiveInt(workArea && workArea.height, DEFAULT_FINGERPRINT_SCREEN.height),
    };
    const raw = sanitizeSize(size, DEFAULT_BROWSER_WINDOW);
    const marginX = area.width >= 1440 ? 80 : 48;
    const marginY = area.height >= 900 ? 96 : 64;

    let maxWidth = area.width - marginX;
    let maxHeight = area.height - marginY;
    if (maxWidth < 320) maxWidth = area.width;
    if (maxHeight < 240) maxHeight = area.height;

    maxWidth = Math.max(320, Math.min(maxWidth, area.width));
    maxHeight = Math.max(240, Math.min(maxHeight, area.height));

    return {
        width: Math.max(Math.min(raw.width, maxWidth), Math.min(320, maxWidth)),
        height: Math.max(Math.min(raw.height, maxHeight), Math.min(240, maxHeight)),
    };
}

function normalizeFingerprintForStorage(fingerprint, options = {}) {
    const next = isPlainObject(fingerprint) ? deepMergeObjects({}, fingerprint) : {};
    const screenSize = sanitizeSize(next.screen, DEFAULT_FINGERPRINT_SCREEN);
    const shouldFitWindow = !!options.fitWindowToWorkArea;
    const shouldFitMissingWindow = !!options.fitMissingWindowToWorkArea;
    const workArea = (shouldFitWindow || shouldFitMissingWindow) ? (options.workArea || getPreferredWorkAreaBounds()) : null;
    const fallbackWindow = sanitizeSize(options.defaultWindow, DEFAULT_BROWSER_WINDOW);
    const defaultWindow = shouldFitMissingWindow ? fitWindowSizeToWorkArea(fallbackWindow, workArea) : fallbackWindow;
    const windowSize = next.window ? sanitizeSize(next.window, defaultWindow) : defaultWindow;
    const normalizedLanguage = String(next.language || '').trim() === AUTO_LANGUAGE
        ? AUTO_LANGUAGE
        : normalizeLocaleToken(next.language || '');

    next.screen = screenSize;
    next.window = shouldFitWindow ? fitWindowSizeToWorkArea(windowSize, workArea) : windowSize;
    if (normalizedLanguage) next.language = normalizedLanguage;
    else if (String(next.language || '').trim() && String(next.language || '').trim() !== AUTO_LANGUAGE) delete next.language;
    if (Array.isArray(next.languages) || normalizedLanguage) {
        const primaryLanguage = normalizedLanguage && normalizedLanguage !== AUTO_LANGUAGE ? normalizedLanguage : '';
        next.languages = sanitizeResolvedLanguages(primaryLanguage, next.languages);
    }
    return next;
}

function mergeFingerprint(baseFingerprint, patchFingerprint, options = {}) {
    const merged = deepMergeObjects(
        isPlainObject(baseFingerprint) ? baseFingerprint : {},
        isPlainObject(patchFingerprint) ? patchFingerprint : {}
    );
    return normalizeFingerprintForStorage(merged, options);
}

function createManagedFingerprint(options = {}) {
    const base = generateFingerprint(options);
    ensureFingerprintProtectionDefaults(base);
    delete base.window;
    return normalizeFingerprintForStorage(base, {
        ...options,
        defaultWindow: DEFAULT_BROWSER_WINDOW,
        fitMissingWindowToWorkArea: true,
        fitWindowToWorkArea: true
    });
}

function isLegacyMirroredWindow(fingerprint) {
    if (!isPlainObject(fingerprint)) return true;
    const screenSize = sanitizeSize(fingerprint.screen, DEFAULT_FINGERPRINT_SCREEN);
    if (!isPlainObject(fingerprint.window)) return true;
    const windowSize = sanitizeSize(fingerprint.window, screenSize);
    return windowSize.width === screenSize.width && windowSize.height === screenSize.height;
}

async function applyBrowserWindowBounds(browser, workArea, windowSize, options = {}) {
    if (!browser) return null;
    const area = workArea || getPreferredWorkAreaBounds();
    const size = fitWindowSizeToWorkArea(windowSize, area);
    const left = area.x + Math.max(0, Math.floor((area.width - size.width) / 2));
    const top = area.y + Math.max(0, Math.floor((area.height - size.height) / 2));

    try {
        const pageTarget = await browser.waitForTarget(t => t.type() === 'page', { timeout: 5000 }).catch(() => null);
        if (!pageTarget) return size;

        const session = await pageTarget.createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal', left, top, width: size.width, height: size.height }
        });

        if (options.minimize) {
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        }
    } catch (e) { }

    return size;
}

function isBlankOrNewTabUrl(url) {
    const value = String(url || '');
    return value === 'about:blank' || value === 'chrome://newtab/' || value.startsWith('chrome://newtab');
}

function isLikelyStartupExtensionUrl(url) {
    const value = String(url || '').toLowerCase();
    if (!value) return false;
    if (value.includes('onboarding.') || value.includes('extension-welcome')) return true;
    if (!value.startsWith('chrome-extension://')) return false;
    return (
        value.includes('/welcome')
        || value.includes('/onboarding')
        || value.includes('/install')
        || value.includes('/getting-started')
        || value.includes('/getstarted')
        || value.includes('/first-run')
        || value.includes('/firstrun')
    );
}

function isPreservedUrl(url, preservedPrefixes = []) {
    const value = String(url || '');
    return preservedPrefixes.some(prefix => prefix && (value === prefix || value.startsWith(prefix)));
}

async function applyTimezoneOverrideToBrowser(browser, timezone) {
    if (!browser || process.platform !== 'win32' || !timezone || timezone === 'Auto') return;

    const applyToPage = async (page) => {
        if (!page) return;
        try { await page.emulateTimezone(timezone); } catch (e) { }
    };

    try {
        const pages = await browser.pages();
        await Promise.all(pages.map(applyToPage));
    } catch (e) { }

    const onTargetCreated = async (target) => {
        if (!target || target.type() !== 'page') return;
        try {
            const page = await target.page();
            await applyToPage(page);
        } catch (e) { }
    };

    try { browser.on('targetcreated', onTargetCreated); } catch (e) { }
}

function buildRuntimeConsistencyPatch(runtimeContext) {
    const payload = JSON.stringify({
        language: String(runtimeContext && runtimeContext.language || '').trim(),
        languages: Array.isArray(runtimeContext && runtimeContext.languages)
            ? runtimeContext.languages.map(item => String(item || '').trim()).filter(Boolean)
            : [],
        permissionStates: isPlainObject(runtimeContext && runtimeContext.permissionStates)
            ? runtimeContext.permissionStates
            : {
                geolocation: String(runtimeContext && runtimeContext.geoPermissionState || '').trim().toLowerCase(),
                camera: String(runtimeContext && runtimeContext.cameraPermissionState || '').trim().toLowerCase(),
                microphone: String(runtimeContext && runtimeContext.microphonePermissionState || '').trim().toLowerCase(),
                notifications: String(runtimeContext && runtimeContext.notificationPermissionState || '').trim().toLowerCase(),
            },
    });
    return `
    (function() {
        try {
            const payload = ${payload};
            const languageValue = payload.language || '';
            const languageList = Array.isArray(payload.languages) ? payload.languages.slice() : [];
            const normalizePermissionState = (value, fallback) => {
                const current = String(value || '').trim().toLowerCase();
                return ['granted', 'prompt', 'denied'].includes(current) ? current : fallback;
            };
            const permissionStates = {
                geolocation: normalizePermissionState(payload.permissionStates && payload.permissionStates.geolocation, 'prompt'),
                camera: normalizePermissionState(payload.permissionStates && payload.permissionStates.camera, 'prompt'),
                microphone: normalizePermissionState(payload.permissionStates && payload.permissionStates.microphone, 'prompt'),
                notifications: normalizePermissionState(payload.permissionStates && payload.permissionStates.notifications, 'prompt'),
            };
            const notificationPermission = permissionStates.notifications === 'prompt' ? 'default' : permissionStates.notifications;
            const getPermissionState = (name) => {
                const key = String(name || '').trim().toLowerCase();
                return Object.prototype.hasOwnProperty.call(permissionStates, key) ? permissionStates[key] : '';
            };
            const makeNative = (func, name) => {
                const nativeStr = 'function ' + name + '() { [native code] }';
                try {
                    Object.defineProperty(func, 'toString', {
                        value: function() { return nativeStr; },
                        configurable: true,
                        writable: true
                    });
                } catch (e) { }
                return func;
            };
            if (languageValue) {
                const languageGetter = makeNative(function language() { return languageValue; }, 'language');
                const languagesGetter = makeNative(function languages() { return languageList.slice(); }, 'languages');
                try {
                    Object.defineProperty(Navigator.prototype, 'language', { get: languageGetter, configurable: true });
                    Object.defineProperty(Navigator.prototype, 'languages', { get: languagesGetter, configurable: true });
                } catch (e) { }
                try {
                    Object.defineProperty(navigator, 'language', { get: languageGetter, configurable: true });
                    Object.defineProperty(navigator, 'languages', { get: languagesGetter, configurable: true });
                } catch (e) { }
            }
            const buildPermissionStatus = (state) => ({
                state: state || 'prompt',
                onchange: null,
                addEventListener: function() {},
                removeEventListener: function() {},
                dispatchEvent: function() { return false; }
            });
            try {
                if (typeof Permissions !== 'undefined' && Permissions.prototype && typeof Permissions.prototype.query === 'function') {
                    const originalQuery = Permissions.prototype.query;
                    Permissions.prototype.query = makeNative(function query(permissionDesc) {
                        const name = permissionDesc && permissionDesc.name ? String(permissionDesc.name).toLowerCase() : '';
                        const state = getPermissionState(name);
                        if (state) return Promise.resolve(buildPermissionStatus(state));
                        return originalQuery.call(this, permissionDesc);
                    }, 'query');
                }
            } catch (e) { }
            try {
                if (navigator.permissions && typeof navigator.permissions.query === 'function') {
                    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
                    navigator.permissions.query = makeNative(function query(permissionDesc) {
                        const name = permissionDesc && permissionDesc.name ? String(permissionDesc.name).toLowerCase() : '';
                        const state = getPermissionState(name);
                        if (state) return Promise.resolve(buildPermissionStatus(state));
                        return originalQuery(permissionDesc);
                    }, 'query');
                }
            } catch (e) { }
            try {
                if (typeof Notification !== 'undefined') {
                    Object.defineProperty(Notification, 'permission', {
                        get: makeNative(function permission() { return notificationPermission; }, 'get permission'),
                        configurable: true
                    });
                    Notification.requestPermission = makeNative(function requestPermission(callback) {
                        if (typeof callback === 'function') {
                            try { callback(notificationPermission); } catch (e) { }
                        }
                        return Promise.resolve(notificationPermission);
                    }, 'requestPermission');
                }
            } catch (e) { }
            try {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                    navigator.mediaDevices.getUserMedia = makeNative(function getUserMedia(constraints) {
                        const wantsAudio = !!(constraints && constraints.audio);
                        const wantsVideo = !!(constraints && constraints.video);
                        if ((wantsAudio && permissionStates.microphone === 'denied') || (wantsVideo && permissionStates.camera === 'denied')) {
                            return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
                        }
                        return originalGetUserMedia(constraints);
                    }, 'getUserMedia');
                }
            } catch (e) { }
        } catch (e) { }
    })();
    `;
}

async function applyRuntimeContextToPage(page, runtimeContext, launchFingerprint, headerPreset = null) {
    if (!page) return;
    const acceptLanguage = String(runtimeContext && runtimeContext.acceptLanguage || '').trim();
    const language = String(runtimeContext && runtimeContext.language || '').trim();
    const resolvedLanguages = Array.isArray(runtimeContext && runtimeContext.languages)
        ? runtimeContext.languages.map(item => String(item || '').trim()).filter(Boolean)
        : buildResolvedLanguages(language || 'en-US');
    const cdpAcceptLanguage = buildCdpAcceptLanguage(language || 'en-US', resolvedLanguages, acceptLanguage);
    const headerPresetOverridesAcceptLanguage = presetGloballySetsHeader(headerPreset, 'accept-language');
    const userAgent = String(launchFingerprint && launchFingerprint.userAgent || '').trim();
    const platform = String(launchFingerprint && launchFingerprint.platform || '').trim();
    const userAgentMetadata = buildUserAgentMetadata(launchFingerprint);
    const consistencyPatchScript = buildRuntimeConsistencyPatch(runtimeContext);
    try {
        const client = await page.target().createCDPSession();
        await client.send('Network.enable').catch(() => { });
        if (!page[GEEKEZ_PAGE_RUNTIME_PATCH]) {
            await client.send('Page.addScriptToEvaluateOnNewDocument', { source: consistencyPatchScript }).catch(() => { });
            page[GEEKEZ_PAGE_RUNTIME_PATCH] = consistencyPatchScript;
            page.once('close', () => { delete page[GEEKEZ_PAGE_RUNTIME_PATCH]; });
        }
        if (userAgent || acceptLanguage || platform) {
            await client.send('Network.setUserAgentOverride', {
                userAgent: userAgent || buildDefaultUserAgent(getBundledChromeVersion()),
                acceptLanguage: headerPresetOverridesAcceptLanguage ? undefined : (cdpAcceptLanguage || language || 'en-US'),
                platform: platform || undefined,
                userAgentMetadata,
            }).catch(() => { });
        }
        if (language) {
            await client.send('Emulation.setLocaleOverride', { locale: language }).catch(() => { });
        }
    } catch (e) { }
    const runConsistencyPatch = async () => {
        try {
            await page.evaluate((script) => { try { (0, eval)(script); } catch (e) { } }, consistencyPatchScript);
        } catch (e) { }
    };
    if (!page[GEEKEZ_PAGE_RUNTIME_PATCH_HANDLER]) {
        page[GEEKEZ_PAGE_RUNTIME_PATCH_HANDLER] = runConsistencyPatch;
        try { page.on('domcontentloaded', runConsistencyPatch); } catch (e) { }
        page.once('close', () => { delete page[GEEKEZ_PAGE_RUNTIME_PATCH_HANDLER]; });
    }
    try {
        await runConsistencyPatch();
    } catch (e) { }
    try {
        if (runtimeContext && runtimeContext.timezone) await page.emulateTimezone(runtimeContext.timezone);
    } catch (e) { }
}

async function applyRuntimeContextToBrowser(browser, runtimeContext, launchFingerprint, headerPreset) {
    if (!browser || !runtimeContext) return;

    await attachHeaderRulesToBrowser(browser, runtimeContext, launchFingerprint, headerPreset);

    const applyToPage = async (page) => {
        try {
            await applyRuntimeContextToPage(page, runtimeContext, launchFingerprint, headerPreset);
        } catch (e) { }
    };

    try {
        const pages = await browser.pages();
        await Promise.all(pages.map(applyToPage));
    } catch (e) { }

    if (!browser[GEEKEZ_BROWSER_RUNTIME_LISTENER]) {
        browser[GEEKEZ_BROWSER_RUNTIME_LISTENER] = async (target) => {
            if (!target || target.type() !== 'page') return;
            try {
                const page = await target.page();
                await applyToPage(page);
            } catch (e) { }
        };
        try { browser.on('targetcreated', browser[GEEKEZ_BROWSER_RUNTIME_LISTENER]); } catch (e) { }
    }
}

async function openStartupUrls(browser, urls, runtimeContext = null, launchFingerprint = null, headerPreset = null) {
    const list = normalizeStartupUrls(urls);
    if (!browser || list.length === 0) return false;

    const pages = await browser.pages().catch(() => []);
    const blankStartupPage = pages.find(page => {
        try { return isBlankOrNewTabUrl(page.url()); } catch (e) { return false; }
    }) || null;
    let firstPage = blankStartupPage ? await browser.newPage() : (pages[0] || null);
    if (!firstPage) firstPage = await browser.newPage();

    for (let i = 0; i < list.length; i++) {
        const page = i === 0 ? firstPage : await browser.newPage();
        try {
            await applyRuntimeContextToPage(page, runtimeContext, launchFingerprint, headerPreset).catch(() => { });
            await page.goto(list[i], { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
            try { await page.goto(list[i], { waitUntil: 'load', timeout: 15000 }); } catch (e2) { }
        }
    }

    if (blankStartupPage && blankStartupPage !== firstPage) {
        try { await blankStartupPage.close({ runBeforeUnload: false }); } catch (e) { }
    }
    try { await firstPage.bringToFront(); } catch (e) { }
    return true;
}

async function cleanupStartupPages(browser, options = {}) {
    if (!browser) return;

    const preservedPrefixes = (options.preservedPrefixes || []).filter(Boolean);
    const startupWindowMs = parsePositiveInt(options.startupWindowMs, 3000);
    const startTime = Date.now();

    const sweep = async () => {
        const pages = await browser.pages().catch(() => []);
        const items = [];

        for (const page of pages) {
            let url = '';
            try { url = page.url(); } catch (e) { }
            items.push({ page, url: String(url || '') });
        }

        const realPages = items.filter(({ url }) => (
            url
            && !isBlankOrNewTabUrl(url)
            && !isLikelyStartupExtensionUrl(url)
            && !isPreservedUrl(url, preservedPrefixes)
        ));

        for (const { page, url } of items) {
            if (!page || isPreservedUrl(url, preservedPrefixes)) continue;
            if (isLikelyStartupExtensionUrl(url) || (isBlankOrNewTabUrl(url) && realPages.length > 0)) {
                try { await page.close({ runBeforeUnload: false }); } catch (e) { }
            }
        }
    };

    const onTargetCreated = async (target) => {
        if (Date.now() - startTime > startupWindowMs) {
            try { browser.off('targetcreated', onTargetCreated); } catch (e) { }
            return;
        }
        if (!target || target.type() !== 'page') return;
        await _sleep(350);
        await sweep();
    };

    try { browser.on('targetcreated', onTargetCreated); } catch (e) { }
    await sweep().catch(() => { });
    setTimeout(() => {
        try { browser.off('targetcreated', onTargetCreated); } catch (e) { }
    }, startupWindowMs + 500);
}

async function promptSshHostKeyDecision({ host, port, fingerprint, isUpdate, raw } = {}) {
    const safeHost = host ? String(host) : '';
    const safePort = (port !== undefined && port !== null) ? String(port) : '';
    const safeFp = fingerprint ? String(fingerprint) : '';
    const safeRaw = raw ? String(raw) : '';

    const allWins = (BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : []) || [];
    const win = (BrowserWindow.getFocusedWindow ? BrowserWindow.getFocusedWindow() : null) || allWins[0] || null;
    const hasUi = win && win.webContents && !win.webContents.isDestroyed();

    if (hasUi) {
        const requestId = `ssh_hostkey_${Date.now()}_${++sshHostKeyPromptSeq}`;
        try { if (win.isMinimized && win.isMinimized()) win.restore(); } catch (e) { }
        try { win.show(); } catch (e) { }
        try { win.focus(); } catch (e) { }
        try { if (win.moveTop) win.moveTop(); } catch (e) { }
        try { win.flashFrame(true); } catch (e) { }
        try { app.focus({ steal: true }); } catch (e) { try { app.focus(); } catch (e2) { } }
        try { shell.beep(); } catch (e) { }

        const payload = { requestId, host: safeHost, port: safePort, fingerprint: safeFp, isUpdate: !!isUpdate, raw: safeRaw };
        try { win.webContents.send('ssh-hostkey-prompt', payload); } catch (e) { }

        const choice = await new Promise((resolve) => {
            const timer = setTimeout(() => { sshHostKeyPromptWaiters.delete(requestId); resolve('cancel'); }, 5 * 60 * 1000);
            sshHostKeyPromptWaiters.set(requestId, {
                resolve: (c) => { clearTimeout(timer); resolve(c || 'cancel'); }
            });
        });

        try { win.flashFrame(false); } catch (e) { }
        return choice;
    }

    try {
        const title = isUpdate ? 'SSH Host Key Changed' : 'SSH Host Key';
        const message = isUpdate
            ? 'The SSH host key does not match your cached key. Continue only if you trust this change.'
            : 'First-time connection requires confirming the host key. Verify the fingerprint before continuing.';
        const detail = `Host: ${safeHost}\nPort: ${safePort}${safeFp ? `\nFingerprint: ${safeFp}` : ''}${safeRaw ? `\n\n${safeRaw}` : ''}`;
        const { response } = await dialog.showMessageBox(win || null, {
            type: 'warning',
            buttons: [isUpdate ? 'Update & Continue (y)' : 'Trust & Continue (y)', 'Continue Once (n)', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            title,
            message,
            detail,
            noLink: true,
        });
        return response === 0 ? 'y' : (response === 1 ? 'n' : 'cancel');
    } catch (e) {
        return 'cancel';
    }
}

function parseSshProxy(proxyStr) {
    const u = new URL(String(proxyStr || '').trim());
    if (u.protocol !== 'ssh:') throw new Error('Invalid ssh proxy');

    const host = u.hostname || '';
    const port = u.port ? Number.parseInt(u.port, 10) : 22;
    if (!host) throw new Error('SSH host missing');
    if (!Number.isFinite(port) || port <= 0) throw new Error('SSH port invalid');

    const keepAliveRaw = u.searchParams.get('keepalive') || u.searchParams.get('ServerAliveInterval') || '';
    const keepAlive = Number.parseInt(keepAliveRaw, 10);
    const hostKeyPolicyRaw = String(
        u.searchParams.get('hostkeyPolicy')
        || u.searchParams.get('hostKeyPolicy')
        || u.searchParams.get('hostkey_policy')
        || u.searchParams.get('autoHostKey')
        || u.searchParams.get('auto_hostkey')
        || ''
    ).trim().toLowerCase();
    // Default: accept-new (auto-accept first connection, prompt on key change)
    // NOTE: accept-all is unsafe (will auto accept even on key mismatch).
    let hostKeyPolicy = 'accept-new'; // ask | accept-new | accept-all
    if (hostKeyPolicyRaw) {
        if (['accept-all', 'accept_all', 'all', 'unsafe', 'trust-all', 'trust_all'].includes(hostKeyPolicyRaw)) hostKeyPolicy = 'accept-all';
        else if (['accept-new', 'accept_new', 'new', 'auto', '1', 'true', 'yes', 'y'].includes(hostKeyPolicyRaw)) hostKeyPolicy = 'accept-new';
        else if (['ask', 'prompt', '0', 'false', 'no', 'n'].includes(hostKeyPolicyRaw)) hostKeyPolicy = 'ask';
    }

    return {
        host,
        port,
        username: u.username || '',
        password: u.password || '',
        keyPath: u.searchParams.get('key') || u.searchParams.get('identity') || '',
        hostKey: u.searchParams.get('hostkey') || u.searchParams.get('hostKey') || '',
        hostKeyPolicy,
        verbose: (u.searchParams.get('verbose') === '1' || u.searchParams.get('v') === '1'),
        strictHostKeyChecking: u.searchParams.get('strict') || u.searchParams.get('StrictHostKeyChecking') || 'accept-new',
        keepAliveInterval: (Number.isFinite(keepAlive) && keepAlive > 0) ? keepAlive : 30,
    };
}

function findPlinkPath() {
    const override = String(process.env.GEEKEZ_PLINK_PATH || '').trim();
    if (override && fs.existsSync(override)) return override;

    if (process.platform !== 'win32') return null;

    const bundledCandidates = [
        path.join(BIN_DIR, 'plink.exe'),
        path.join(BIN_DIR_LEGACY, 'plink.exe'),
    ];
    for (const p of bundledCandidates) {
        try { if (fs.existsSync(p)) return p; } catch (e) { }
    }

    const envPath = String(process.env.PATH || '');
    const parts = envPath.split(';').map(s => s.trim()).filter(Boolean);
    for (const dir of parts) {
        try {
            const full = path.join(dir, 'plink.exe');
            if (fs.existsSync(full)) return full;
        } catch (e) { }
    }

    const candidates = [
        'C:\\Program Files\\PuTTY\\plink.exe',
        'C:\\Program Files (x86)\\PuTTY\\plink.exe',
        'D:\\Program Files\\PuTTY\\plink.exe',
        'D:\\Program Files (x86)\\PuTTY\\plink.exe',
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (e) { }
    }
    return null;
}

const plinkLegacyPromptsCache = new Map();
function plinkSupportsLegacyStdioPrompts(plinkPath) {
    const key = String(plinkPath || '').trim();
    if (!key) return false;
    if (plinkLegacyPromptsCache.has(key)) return plinkLegacyPromptsCache.get(key);

    let supported = false;
    try {
        const r = spawnSync(key, ['-V'], { windowsHide: true, encoding: 'utf8' });
        const out = `${r.stdout || ''}\n${r.stderr || ''}`;
        const m = out.match(/Release\s+(\d+)\.(\d+)/i);
        if (m) {
            const major = Number.parseInt(m[1], 10);
            const minor = Number.parseInt(m[2], 10);
            supported = (Number.isFinite(major) && Number.isFinite(minor) && (major > 0 || minor >= 82));
        }
    } catch (e) { }
    plinkLegacyPromptsCache.set(key, supported);
    return supported;
}

async function startSshDynamicProxy(proxyStr, profileDir, options = {}) {
    const cfg = parseSshProxy(proxyStr);
    const preferredLocalPort = Number.parseInt(options.preferredLocalPort, 10);
    const localPort = (Number.isFinite(preferredLocalPort) && preferredLocalPort > 0) ? preferredLocalPort : await getPort();
    const knownHosts = path.join(profileDir, 'known_hosts');
    const logPath = path.join(profileDir, 'ssh_run.log');
    const logFd = fs.openSync(logPath, 'a');

    const dest = cfg.username ? `${cfg.username}@${cfg.host}` : cfg.host;

    const writeLogLine = (line) => {
        try { fs.writeSync(logFd, Buffer.from(`${line}\n`, 'utf8')); } catch (e) { }
    };

    // Best-effort cleanup: leftover password files (avoid leaving secrets on disk)
    try {
        for (const name of fs.readdirSync(profileDir)) {
            if (!name.startsWith('ssh_pw_') || !name.endsWith('.txt')) continue;
            const full = path.join(profileDir, name);
            try { fs.unlinkSync(full); } catch (e) { }
        }
    } catch (e) { }

    writeLogLine(`[${new Date().toISOString()}] SSH dynamic proxy start: host=${cfg.host} port=${cfg.port} user=${cfg.username ? '***' : ''} localPort=${localPort} auth=${cfg.password ? 'password' : (cfg.keyPath ? 'key' : 'agent')}`);

    const tryUnlink = (p) => { try { fs.unlinkSync(p); return true; } catch (e) { return false; } };

    if (cfg.password) {
        if (process.platform !== 'win32') {
            try { fs.closeSync(logFd); } catch (e) { }
            throw new Error('SSH password auth is only supported on Windows with plink.exe; use ssh key/agent instead.');
        }
        const plinkPath = findPlinkPath();
        if (!plinkPath) {
            try { fs.closeSync(logFd); } catch (e) { }
            throw new Error('plink.exe not found; install PuTTY, use a build with bundled plink, or set GEEKEZ_PLINK_PATH');
        }

        const pwFile = path.join(profileDir, `ssh_pw_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
        try {
            fs.writeFileSync(pwFile, cfg.password, { encoding: 'utf8', mode: 0o600 });
        } catch (e) {
            try { fs.closeSync(logFd); } catch (e2) { }
            throw new Error(`Failed to write SSH password file: ${e.message}`);
        }

        const args = [
            '-ssh',
            '-no-antispoof',
            '-N',
            '-D', `127.0.0.1:${localPort}`,
            '-P', String(cfg.port),
            '-pwfile', pwFile,
        ];
        // PuTTY/plink 0.82+ writes interactive security prompts to the Windows console (WriteConsole),
        // which becomes invisible/non-capturable in GUI apps. Force legacy stdio prompts so we can
        // surface a visible confirmation dialog and answer via stdin.
        if (!cfg.hostKey && plinkSupportsLegacyStdioPrompts(plinkPath)) {
            args.unshift('-legacy-stdio-prompts');
        }
        if (cfg.verbose || String(process.env.GEEKEZ_SSH_VERBOSE || '') === '1') args.push('-v');
        if (cfg.hostKey) {
            args.push('-hostkey', cfg.hostKey, '-batch');
        }
        if (cfg.username) args.push('-l', cfg.username);
        args.push(cfg.host);

        const proc = spawn(plinkPath, args, { cwd: profileDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let spawnErr = null;
        proc.once('error', (e) => { spawnErr = e; });

        let cancelled = false;
        const hostPortKey = `${cfg.host}:${cfg.port}`;
        let hostKeyFingerprint = '';
        let promptTask = null;
        let textBuf = '';

        const writeLog = (buf) => { try { fs.writeSync(logFd, buf); } catch (e) { } };

        const maybeHandlePrompt = async () => {
            if (promptTask || cfg.hostKey) return;
            const isUpdate = textBuf.includes('Update cached key?');
            if (!textBuf.includes('Store key in cache?') && !isUpdate) return;
            promptTask = (async () => {
                if (!isUpdate && trustedSshHosts.has(hostPortKey)) {
                    try { proc.stdin.write('y\n'); } catch (e) { }
                    return;
                }

                // Optional auto policy to avoid any prompt (similar to many commercial tools).
                // accept-new: auto trust only when key is missing (Store key...).
                // accept-all: auto trust even when cached key mismatch (Update cached key...) (unsafe).
                if (cfg.hostKeyPolicy === 'accept-all' || (!isUpdate && cfg.hostKeyPolicy === 'accept-new')) {
                    if (!isUpdate) trustedSshHosts.add(hostPortKey);
                    try { proc.stdin.write('y\n'); } catch (e) { }
                    return;
                }

                const choice = await promptSshHostKeyDecision({
                    host: cfg.host,
                    port: cfg.port,
                    fingerprint: hostKeyFingerprint,
                    isUpdate,
                    raw: textBuf.slice(-2000),
                });
                if (choice === 'y' || choice === 'n') {
                    if (!isUpdate && choice === 'y') trustedSshHosts.add(hostPortKey);
                    try { proc.stdin.write(`${choice}\n`); } catch (e) { }
                    return;
                }

                cancelled = true;
                await forceKill(proc.pid);
            })();
        };

        const onText = (t) => {
            textBuf += t;
            const m = textBuf.match(/(?:The server's|The new)\s+[^\r\n]+ key fingerprint is:\s*\r?\n\s*([^\r\n]+)\r?\n/i);
            if (m && m[1]) hostKeyFingerprint = String(m[1]).trim();
            void maybeHandlePrompt();
        };

        if (proc.stdout) proc.stdout.on('data', (d) => { writeLog(d); onText(String(d)); });
        if (proc.stderr) proc.stderr.on('data', (d) => { writeLog(d); onText(String(d)); });

        const ready = await waitForTcpPort('127.0.0.1', localPort, 60000, () => cancelled || proc.exitCode !== null);
        if (promptTask) await promptTask.catch(() => { });
        if (spawnErr) {
            tryUnlink(pwFile);
            try { fs.closeSync(logFd); } catch (e) { }
            throw new Error(`SSH spawn failed: ${spawnErr.message || String(spawnErr)}`);
        }
        if (cancelled) {
            tryUnlink(pwFile);
            try { fs.closeSync(logFd); } catch (e) { }
            throw new Error('SSH host key not trusted');
        }
        if (!ready || proc.exitCode !== null) {
            await forceKill(proc.pid);
            // plink may keep the pwfile handle open until exit; retry deletion briefly after kill
            for (let i = 0; i < 20; i++) {
                if (tryUnlink(pwFile)) break;
                await _sleep(100);
            }
            try { fs.closeSync(logFd); } catch (e) { }
            throw new Error(`SSH tunnel not ready (check ${logPath})`);
        }
        tryUnlink(pwFile);
        return { pid: proc.pid, localPort, logFd, child: proc, logPath };
    }

    const cmd = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
    const strictHostKeyChecking = (cfg.hostKeyPolicy === 'accept-all') ? 'no' : String(cfg.strictHostKeyChecking || 'accept-new');
    const args = [
        '-N',
        '-D', `127.0.0.1:${localPort}`,
        '-p', String(cfg.port),
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        '-o', `StrictHostKeyChecking=${strictHostKeyChecking}`,
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', `ServerAliveInterval=${cfg.keepAliveInterval}`,
        '-o', 'ServerAliveCountMax=3',
    ];
    if (cfg.verbose || String(process.env.GEEKEZ_SSH_VERBOSE || '') === '1') args.push('-v');
    if (cfg.keyPath) {
        args.push('-i', cfg.keyPath, '-o', 'IdentitiesOnly=yes');
    }
    args.push(dest);

    const proc = spawn(cmd, args, { cwd: profileDir, stdio: ['ignore', logFd, logFd], windowsHide: true });
    let spawnErr = null;
    proc.once('error', (e) => { spawnErr = e; });

    const ready = await waitForTcpPort('127.0.0.1', localPort, 6000, () => proc.exitCode !== null);
    if (spawnErr) {
        try { fs.closeSync(logFd); } catch (e) { }
        throw new Error(`SSH spawn failed: ${spawnErr.message || String(spawnErr)}`);
    }
    if (!ready || proc.exitCode !== null) {
        await forceKill(proc.pid);
        try { fs.closeSync(logFd); } catch (e) { }
        throw new Error(`SSH tunnel not ready (check ${logPath})`);
    }
    return { pid: proc.pid, localPort, logFd, child: proc, logPath };
}

function buildRuntimeSnapshot(profile, proc, settings = null) {
    const running = !!(proc && proc.browser && proc.browser.isConnected && proc.browser.isConnected());
    const proxyBinding = resolveProfileProxyBinding(profile, settings, proc);
    const effectiveProxyStr = String((proxyBinding && proxyBinding.proxyStr) || '').trim();
    const isSsh = effectiveProxyStr.startsWith('ssh://');
    const proxyType = detectProxyType(effectiveProxyStr);
    const ws = running && proc && proc.browser && proc.browser.wsEndpoint ? proc.browser.wsEndpoint() : null;
    const httpEndpoint = running && proc && proc.remoteDebuggingEnabled && profile && profile.debugPort
        ? `http://${LOCAL_API_HOST}:${profile.debugPort}`
        : null;
    const runtimeContext = getRuntimeLikeContext(profile, proc);
    const permissionStates = resolveRuntimePermissionStates(profile, runtimeContext);
    const geoPermissionState = String(permissionStates.geolocation || 'prompt').trim() || 'prompt';

    return {
        running,
        ws,
        http: httpEndpoint,
        debugPort: running && proc && proc.remoteDebuggingEnabled ? ((profile && profile.debugPort) || undefined) : undefined,
        localPort: running && proc ? (proc.localPort || undefined) : undefined,
        sshLocalPort: running && proc ? (proc.sshLocalPort || undefined) : undefined,
        proxyType,
        canRestartSsh: !!(proc && isSsh),
        sshState: isSsh ? String((proc && proc.sshState) || (proc && proc.sshPid ? 'running' : 'stopped')) : null,
        sshLastError: isSsh ? String((proc && proc.sshLastError) || '') : '',
        proxySource: proxyBinding.source,
        activeSavedProxyId: proxyBinding.savedProxyId || '',
        activeSavedProxyName: proxyBinding.savedProxyName || '',
        proxyBindingBroken: !!proxyBinding.bindingBroken,
        resolvedTimezone: runtimeContext.timezone || '',
        resolvedLanguage: runtimeContext.language || '',
        resolvedLanguages: runtimeContext.languages || [],
        resolvedAcceptLanguage: runtimeContext.acceptLanguage || '',
        resolvedGeolocation: runtimeContext.geolocation || null,
        resolvedCity: runtimeContext.city || '',
        resolvedCountry: runtimeContext.country || '',
        autoCalibrationError: runtimeContext.autoCalibration ? String(runtimeContext.autoCalibration.error || '') : '',
        activeHeaderPresetId: normalizeHeaderPresetId((proc && proc.activeHeaderPreset && proc.activeHeaderPreset.id) || (profile && profile.headerPresetId) || ''),
        geoPermissionState,
        cameraPermissionState: permissionStates.camera,
        microphonePermissionState: permissionStates.microphone,
        notificationPermissionState: permissionStates.notifications,
        permissionStates,
        selfCheckSummary: buildSelfCheckSummary(profile, proc, null),
    };
}

function bindSshLifecycle(profileId, child) {
    if (!child || !child.pid) return;

    child.once('exit', (code, signal) => {
        const proc = activeProcesses[profileId];
        if (!proc || proc.manualClosing || proc.sshRestarting) return;
        if (proc.sshPid !== child.pid) return;

        proc.sshPid = undefined;
        proc.sshProc = null;
        proc.sshState = 'stopped';
        proc.sshLastError = `SSH exited (${code !== null ? `code ${code}` : (signal || 'unknown')})`;

        if (proc.sshLogFd !== undefined) {
            try { fs.closeSync(proc.sshLogFd); } catch (e) { }
            proc.sshLogFd = undefined;
        }
    });

    child.once('error', (err) => {
        const proc = activeProcesses[profileId];
        if (!proc || proc.manualClosing) return;
        if (proc.sshPid !== child.pid) return;
        proc.sshState = 'stopped';
        proc.sshLastError = err && err.message ? err.message : String(err);
    });
}

async function restartSshInternal(profileId) {
    const proc = activeProcesses[profileId];
    if (!proc) throw new Error('Profile not running');
    if (!proc.browser || !proc.browser.isConnected || !proc.browser.isConnected()) throw new Error('Browser session is not connected');

    const proxyStr = String(proc.originalProxyStr || '').trim();
    if (!proxyStr.startsWith('ssh://')) throw new Error('Current profile is not using SSH proxy');

    const profileDir = proc.profileDir || path.join(DATA_PATH, profileId);
    const oldPid = proc.sshPid;
    const oldLogFd = proc.sshLogFd;
    const preferredLocalPort = proc.sshLocalPort;

    proc.sshRestarting = true;
    proc.sshState = 'reconnecting';
    proc.sshLastError = '';
    proc.sshPid = undefined;
    proc.sshProc = null;
    proc.sshLogFd = undefined;

    await forceKill(oldPid);
    if (oldLogFd !== undefined) {
        try { fs.closeSync(oldLogFd); } catch (e) { }
    }
    if (preferredLocalPort) {
        await waitForTcpPortClosed('127.0.0.1', preferredLocalPort, 4000).catch(() => false);
    }

    try {
        const sshInfo = await startSshDynamicProxy(proxyStr, profileDir, { preferredLocalPort });
        proc.sshPid = sshInfo.pid;
        proc.sshProc = sshInfo.child || null;
        proc.sshLogFd = sshInfo.logFd;
        proc.sshLocalPort = sshInfo.localPort;
        proc.sshState = 'running';
        proc.sshLastError = '';
        proc.sshRestarting = false;
        bindSshLifecycle(profileId, sshInfo.child);
        return sshInfo;
    } catch (err) {
        proc.sshRestarting = false;
        proc.sshState = 'stopped';
        proc.sshLastError = err && err.message ? err.message : String(err);
        throw err;
    }
}

function getChromiumPath() {
    const basePath = isDev ? path.join(__dirname, 'resources', 'puppeteer') : path.join(process.resourcesPath, 'puppeteer');
    function collectFiles(dir, filename, matches = []) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) collectFiles(fullPath, filename, matches);
                else if (file === filename) matches.push(fullPath);
            }
        } catch (e) { }
        return matches;
    }

    if (fs.existsSync(basePath)) {
        if (process.platform === 'darwin') {
            const matches = collectFiles(basePath, 'Google Chrome for Testing');
            if (matches.length > 0) return ensureExecutable(matches[0]);
        } else if (process.platform === 'win32') {
            const matches = collectFiles(basePath, 'chrome.exe');
            if (matches.length > 0) return matches[0];
        } else if (process.platform === 'linux') {
            const matches = collectFiles(basePath, 'chrome')
                .filter(p => /chrome-linux/i.test(p))
                .sort((a, b) => a.length - b.length);
            if (matches.length > 0) return ensureExecutable(matches[0]);
        }
    }

    const fallbackPaths = process.platform === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
        : [];
    const fallback = fallbackPaths.find(p => fs.existsSync(p));
    return fallback ? ensureExecutable(fallback) : null;
}

let _cachedBundledChromeVersion; // undefined = not resolved yet
const _CHROME_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

function _compareChromeVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10));
    const pb = String(b).split('.').map(n => parseInt(n, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function _parseChromeVersionFromPath(chromePath) {
    if (!chromePath) return null;
    const normalized = String(chromePath).replace(/\\/g, '/');
    const m = normalized.match(/\/(?:win64|win32|mac-arm64|mac-x64|linux64)-(\d+\.\d+\.\d+\.\d+)\//);
    return m ? m[1] : null;
}

function _readChromeVersionFromBinary(chromePath) {
    if (!chromePath) return null;
    try {
        const result = spawnSync(chromePath, ['--version'], { encoding: 'utf8' });
        const text = `${result.stdout || ''}\n${result.stderr || ''}`;
        const match = text.match(/(\d+\.\d+\.\d+\.\d+)/);
        return match && _CHROME_VERSION_RE.test(match[1]) ? match[1] : null;
    } catch (e) {
        return null;
    }
}

function getBundledChromeVersion() {
    if (_cachedBundledChromeVersion !== undefined) return _cachedBundledChromeVersion;
    _cachedBundledChromeVersion = null;

    const basePath = isDev ? path.join(__dirname, 'resources', 'puppeteer') : path.join(process.resourcesPath, 'puppeteer');
    const chromeRoot = path.join(basePath, 'chrome');
    if (fs.existsSync(chromeRoot)) {
        try {
            const versions = fs.readdirSync(chromeRoot, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name.match(/-(\d+\.\d+\.\d+\.\d+)$/))
                .map(m => (m ? m[1] : null))
                .filter(v => v && _CHROME_VERSION_RE.test(v));
            if (versions.length > 0) {
                versions.sort(_compareChromeVersions);
                _cachedBundledChromeVersion = versions[versions.length - 1];
                return _cachedBundledChromeVersion;
            }
        } catch (e) { }
    }

    const chromePath = getChromiumPath();
    _cachedBundledChromeVersion = _parseChromeVersionFromPath(chromePath) || _readChromeVersionFromBinary(chromePath);
    return _cachedBundledChromeVersion;
}

function buildDefaultUserAgent(chromeVersion) {
    const ver = (_CHROME_VERSION_RE.test(String(chromeVersion || '').trim()))
        ? String(chromeVersion).trim()
        : '120.0.0.0';
    if (process.platform === 'win32') {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
    }
    if (process.platform === 'darwin') {
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
    }
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

function extractChromeVersionFromUserAgent(userAgent) {
    const match = String(userAgent || '').match(/(?:Chrome|HeadlessChrome)\/(\d+\.\d+\.\d+\.\d+)/i);
    return match && _CHROME_VERSION_RE.test(match[1]) ? match[1] : '';
}

function padVersionSegments(version, size = 3) {
    const parts = String(version || '').trim().split(/[._-]+/).filter(Boolean);
    while (parts.length < size) parts.push('0');
    return parts.slice(0, size).join('.');
}

function resolveClientHintsPlatform(navigatorPlatform, userAgent) {
    const platform = String(navigatorPlatform || '').trim().toLowerCase();
    const ua = String(userAgent || '').trim().toLowerCase();
    if (platform.includes('win') || ua.includes('windows nt')) return 'Windows';
    if (platform.includes('mac') || ua.includes('mac os x')) return 'macOS';
    if (platform.includes('linux') || ua.includes('linux')) return 'Linux';
    return process.platform === 'win32' ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux');
}

function resolveClientHintsPlatformVersion(platform, userAgent) {
    const ua = String(userAgent || '').trim();
    if (platform === 'Windows') {
        const match = ua.match(/Windows NT ([0-9.]+)/i);
        return padVersionSegments(match ? match[1] : '10.0', 3);
    }
    if (platform === 'macOS') {
        const match = ua.match(/Mac OS X ([0-9_]+)/i);
        return padVersionSegments(match ? match[1].replace(/_/g, '.') : '10.15.7', 3);
    }
    return '';
}

function resolveClientHintsArchitecture(navigatorPlatform, userAgent) {
    const raw = `${navigatorPlatform || ''} ${userAgent || ''}`.toLowerCase();
    if (/(arm|aarch64)/i.test(raw)) return 'arm';
    return 'x86';
}

function resolveClientHintsBitness(navigatorPlatform, userAgent) {
    const raw = `${navigatorPlatform || ''} ${userAgent || ''}`.toLowerCase();
    return /(?:x86_64|x64|win64|amd64|arm64|aarch64|64)/i.test(raw) ? '64' : '32';
}

function buildUserAgentMetadata(launchFingerprint) {
    const userAgent = String(launchFingerprint && launchFingerprint.userAgent || '').trim();
    const navigatorPlatform = String(launchFingerprint && launchFingerprint.platform || '').trim();
    const platform = resolveClientHintsPlatform(navigatorPlatform, userAgent);
    const chromeVersion = String(
        launchFingerprint && launchFingerprint.chromeVersion
        || extractChromeVersionFromUserAgent(userAgent)
        || ''
    ).trim();
    const chromeMajor = chromeVersion ? chromeVersion.split('.')[0] : '';
    const brands = chromeMajor ? [
        { brand: 'Chromium', version: chromeMajor },
        { brand: 'Google Chrome', version: chromeMajor },
    ] : undefined;
    const fullVersionList = chromeVersion ? [
        { brand: 'Chromium', version: chromeVersion },
        { brand: 'Google Chrome', version: chromeVersion },
    ] : undefined;
    return {
        brands,
        platform,
        platformVersion: resolveClientHintsPlatformVersion(platform, userAgent),
        architecture: resolveClientHintsArchitecture(navigatorPlatform, userAgent),
        model: '',
        mobile: false,
        bitness: resolveClientHintsBitness(navigatorPlatform, userAgent),
        wow64: false,
        fullVersion: chromeVersion || undefined,
        fullVersionList,
    };
}

function buildExpectedClientHints(launchFingerprint) {
    const metadata = buildUserAgentMetadata(launchFingerprint);
    const chromeVersion = String(
        launchFingerprint && launchFingerprint.chromeVersion
        || extractChromeVersionFromUserAgent(launchFingerprint && launchFingerprint.userAgent)
        || getBundledChromeVersion()
        || ''
    ).trim();
    const majorVersion = chromeVersion ? String(chromeVersion).split('.')[0] : '';
    return {
        ...metadata,
        chromeVersion,
        majorVersion,
        browserBrands: ['Chromium', 'Google Chrome'],
    };
}

function ensureFingerprintChromeVersion(fp, chromeVersion) {
    if (!fp || !_CHROME_VERSION_RE.test(String(chromeVersion || '').trim())) return false;
    const ver = String(chromeVersion).trim();
    const nextUA = (typeof fp.userAgent === 'string' && fp.userAgent.length > 0 && /Chrome\/[\d.]+/.test(fp.userAgent))
        ? fp.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${ver}`)
        : buildDefaultUserAgent(ver);
    const changed = fp.chromeVersion !== ver || fp.userAgent !== nextUA;
    fp.chromeVersion = ver;
    fp.userAgent = nextUA;
    return changed;
}

// Settings management
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return normalizeSettings({});
}

function saveSettings(settings) {
    try {
        validateHeaderPresetsOrThrow(settings && settings.headerPresets);
        validateDiagnosticPresetsOrThrow(settings && settings.diagnosticPresets);
        validateSavedProfileProxiesOrThrow(settings && settings.savedProfileProxies);
        validateSavedProfileProxySourcesOrThrow(settings && settings.savedProfileProxySources);
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalizeSettings(settings), null, 2));
        return true;
    } catch (e) {
        console.error('Failed to save settings:', e);
        return false;
    }
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
        width: Math.round(width * 0.5), height: Math.round(height * 0.601), minWidth: 900, minHeight: 600,
        title: "GeekEZ Browser", backgroundColor: '#1e1e2d',
        icon: path.join(__dirname, 'icon.png'),
        titleBarOverlay: { color: '#1e1e2d', symbolColor: '#ffffff', height: 35 },
        titleBarStyle: 'hidden',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    win.setMenuBarVisibility(false);
    win.loadFile('index.html');
    mainWindow = win; // Store global reference for API
    return win;
}

// Helper to notify UI to refresh profiles
function notifyUIRefresh() {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('refresh-profiles');
    }
}

async function generateExtension(profilePath, fingerprint, profileName, watermarkStyle) {
    const extDir = path.join(profilePath, 'extension');
    await fs.ensureDir(extDir);
    const manifest = {
        manifest_version: 3,
        name: "GeekEZ Guard",
        version: "1.0.0",
        description: "Privacy Protection",
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, world: "MAIN" }]
    };
    const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
    const scriptContent = getInjectScript(fingerprint, profileName, style);
    await fs.writeJson(path.join(extDir, 'manifest.json'), manifest);
    await fs.writeFile(path.join(extDir, 'content.js'), scriptContent);
    return extDir;
}

function _sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function _sendHtml(res, statusCode, html) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
}

function _sendBuffer(res, statusCode, body, contentType, extraHeaders = {}) {
    res.statusCode = statusCode;
    if (contentType) res.setHeader('Content-Type', contentType);
    for (const [key, value] of Object.entries(extraHeaders || {})) {
        if (value !== undefined && value !== null && value !== '') res.setHeader(key, value);
    }
    res.end(body);
}

function _renderDashboardHtml(profileId) {
    const safeId = JSON.stringify(String(profileId || '').replace(/[^\w-]/g, ''));

    try {
        const template = fs.readFileSync(DASHBOARD_TEMPLATE_FILE, 'utf8');
        const css = fs.readFileSync(DASHBOARD_CSS_FILE, 'utf8');
        const js = fs.readFileSync(DASHBOARD_JS_FILE, 'utf8');
        return template
            .split('__GEEKEZ_PROFILE_ID_JSON__').join(safeId)
            .split('__DASHBOARD_CSS__').join(css)
            .split('__DASHBOARD_JS__').join(js);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>GeekEZ Dashboard</title></head><body style="font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#10151f;color:#fff;padding:24px;"><h1 style="margin:0 0 12px;">GeekEZ Dashboard / 仪表盘加载失败</h1><pre style="white-space:pre-wrap;background:#182233;border-radius:12px;padding:14px;border:1px solid rgba(255,255,255,.12);">${msg}</pre></body></html>`;
    }
}

function _readJsonBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > maxBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function startLocalApiServer() {
    if (localApiServer) return;

    localApiServer = http.createServer(async (req, res) => {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host || LOCAL_API_HOST}`);
            const path = urlObj.pathname;

            if (req.method === 'GET' && path === '/health') {
                return _sendJson(res, 200, { success: true, data: { name: app.getName(), version: app.getVersion() } });
            }

            if (req.method === 'GET' && path === '/dashboard') {
                const profileId = urlObj.searchParams.get('profile') || '';
                applyAcceptChProbeHeaders(res);
                return _sendHtml(res, 200, _renderDashboardHtml(profileId));
            }

            if (path === '/diagnostics/accept-ch/bootstrap') {
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                applyAcceptChProbeHeaders(res);
                res.statusCode = 204;
                return res.end();
            }

            if (path === '/diagnostics/accept-ch/collect') {
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                applyAcceptChProbeHeaders(res);
                return _sendJson(res, 200, { success: true, data: buildObservedBrowserHeaders(req.headers) });
            }

            if (path === '/profiles') {
                if (req.method === 'GET') {
                    const list = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    return _sendJson(res, 200, { success: true, data: { list } });
                }

                if (req.method === 'POST') {
                    const data = await _readJsonBody(req);

                    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    const fingerprint = normalizeFingerprintForStorage(
                        data.fingerprint || createManagedFingerprint({ chromeVersion: getBundledChromeVersion() }),
                        { fitMissingWindowToWorkArea: true }
                    );
                    if (typeof data.timezone === 'string' && data.timezone.trim()) fingerprint.timezone = data.timezone.trim();
                    else if (!fingerprint.timezone) fingerprint.timezone = AUTO_TIMEZONE;
                    if (data.city) fingerprint.city = data.city;
                    if (data.geolocation) fingerprint.geolocation = data.geolocation;
                    if (typeof data.language === 'string' && data.language.trim()) fingerprint.language = data.language.trim();
                    else if (!fingerprint.language) fingerprint.language = AUTO_LANGUAGE;

                    const newProfile = {
                        id: uuidv4(),
                        name: data.name || 'Profile',
                        proxyStr: data.proxyStr || '',
                        savedProxyId: normalizeSavedProfileProxyId(data.savedProxyId),
                        remark: data.remark || '',
                        tags: data.tags || [],
                        startupUrls: normalizeStartupUrls(data.startupUrls),
                        fingerprint: fingerprint,
                        headerPresetId: normalizeHeaderPresetId(data.headerPresetId),
                        extensionPaths: normalizeProfileExtensionPaths(data.extensionPaths),
                        useGlobalExtensions: normalizeUseGlobalExtensions(data.useGlobalExtensions, true),
                        ...normalizeProfilePermissionModes(data),
                        preProxyOverride: data.preProxyOverride || 'default',
                        debugPort: data.debugPort || undefined,
                        isSetup: false,
                        createdAt: Date.now()
                    };

                    profiles.push(newProfile);
                    await fs.writeJson(PROFILES_FILE, profiles);
                    return _sendJson(res, 201, { success: true, data: newProfile });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            if (path === '/saved-profile-proxies') {
                if (req.method === 'GET') {
                    return _sendJson(res, 200, { success: true, data: { list: await listSavedProfileProxiesWithUsage() } });
                }

                if (req.method === 'POST') {
                    const payload = await _readJsonBody(req);
                    const result = await createSavedProfileProxyEntry(payload);
                    return _sendJson(res, 201, { success: true, data: result.item });
                }

                if (req.method === 'PUT') {
                    const payload = await _readJsonBody(req);
                    try {
                        const result = await replaceSavedProfileProxiesCollection(
                            Array.isArray(payload.savedProfileProxies) ? payload.savedProfileProxies : payload.proxies
                        );
                        return _sendJson(res, 200, {
                            success: true,
                            data: { list: result.list }
                        });
                    } catch (e) {
                        throw createHttpError(400, e && e.message ? e.message : String(e));
                    }
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            if (path === '/saved-profile-proxy-sources') {
                if (req.method === 'GET') {
                    return _sendJson(res, 200, { success: true, data: { list: await listSavedProfileProxySourcesWithUsage() } });
                }

                if (req.method === 'POST') {
                    const payload = await _readJsonBody(req);
                    const result = await createSavedProfileProxySourceEntry(payload);
                    return _sendJson(res, 201, { success: true, data: result.item });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            if (path === '/saved-profile-proxy-sources/actions/history') {
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const settings = await readSettingsAsync();
                return _sendJson(res, 200, {
                    success: true,
                    data: { list: normalizeSavedProfileProxySourceBatchHistory(settings.savedProfileProxySourceBatchHistory) }
                });
            }

            const savedProxySourceOverviewActionMatch = path.match(/^\/saved-profile-proxy-sources\/actions\/(attention-maintenance|refresh-due|quarantine-candidates|recheck-quarantined)$/);
            if (savedProxySourceOverviewActionMatch) {
                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const action = savedProxySourceOverviewActionMatch[1];
                const result = action === 'attention-maintenance'
                    ? await runSavedProfileProxySourcesAttentionMaintenance()
                    : await runSavedProfileProxySourcesOverviewAction(action);
                return _sendJson(res, 200, { success: true, data: result });
            }

            const savedProxySourceExportMatch = path.match(/^\/saved-profile-proxy-sources\/([^/]+)\/export$/);
            if (savedProxySourceExportMatch) {
                const sourceId = decodeURIComponent(savedProxySourceExportMatch[1]);
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const scope = String(urlObj.searchParams.get('scope') || 'all').trim().toLowerCase();
                const format = String(urlObj.searchParams.get('format') || 'json').trim().toLowerCase();
                const result = await exportSavedProfileProxySourceContent(sourceId, { scope, format });
                if (result.format === 'txt') {
                    return _sendBuffer(
                        res,
                        200,
                        Buffer.from(String(result.content || ''), 'utf8'),
                        'text/plain; charset=utf-8',
                        {
                            'Cache-Control': 'no-store, max-age=0',
                            'Content-Disposition': `inline; filename="${sanitizeDiagnosticArtifactSegment(sourceId)}-${result.scope}.txt"`,
                        }
                    );
                }
                return _sendJson(res, 200, { success: true, data: result.content });
            }

            const savedProxySourceActionMatch = path.match(/^\/saved-profile-proxy-sources\/([^/]+)\/actions\/(disable-stale|detach-stale|delete-stale|retest-linked|retest-stale|quarantine-failed|recheck-quarantined|run-maintenance)$/);
            if (savedProxySourceActionMatch) {
                const sourceId = decodeURIComponent(savedProxySourceActionMatch[1]);
                const action = savedProxySourceActionMatch[2];
                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                assertSavedProfileProxySourceRouteMutationUnlocked(sourceId);
                const result = ['disable-stale', 'detach-stale', 'delete-stale'].includes(action)
                    ? await mutateSavedProfileProxySourceStaleEntries(
                        sourceId,
                        action === 'detach-stale' ? 'detach' : (action === 'delete-stale' ? 'delete' : 'disable')
                    )
                    : action === 'run-maintenance'
                        ? await runSavedProfileProxySourceMaintenance(sourceId, { trigger: 'manual' })
                    : await runSavedProfileProxySourceHealthAction(sourceId, action);
                return _sendJson(res, 200, { success: true, data: result });
            }

            const savedProxySourceRefreshMatch = path.match(/^\/saved-profile-proxy-sources\/([^/]+)\/refresh$/);
            if (savedProxySourceRefreshMatch) {
                const sourceId = decodeURIComponent(savedProxySourceRefreshMatch[1]);
                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                assertSavedProfileProxySourceRouteMutationUnlocked(sourceId);
                const result = await refreshSavedProfileProxySourceEntry(sourceId);
                return _sendJson(res, 200, { success: true, data: result });
            }

            const savedProxySourceMatch = path.match(/^\/saved-profile-proxy-sources\/([^/]+)$/);
            if (savedProxySourceMatch) {
                const sourceId = decodeURIComponent(savedProxySourceMatch[1]);
                if (req.method === 'GET') {
                    const item = (await listSavedProfileProxySourcesWithUsage()).find((source) => source.id === normalizeSavedProfileProxySourceId(sourceId)) || null;
                    if (!item) return _sendJson(res, 404, { success: false, error: 'Saved proxy source not found' });
                    return _sendJson(res, 200, { success: true, data: item });
                }

                if (req.method === 'PATCH') {
                    const payload = await _readJsonBody(req);
                    const result = await patchSavedProfileProxySourceEntry(sourceId, payload);
                    return _sendJson(res, 200, { success: true, data: result.item });
                }

                if (req.method === 'DELETE') {
                    const result = await deleteSavedProfileProxySourceEntry(sourceId);
                    return _sendJson(res, 200, {
                        success: true,
                        data: {
                            id: result.deletedId,
                            linkedProxyCount: result.linkedProxyCount,
                        }
                    });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            const savedProxyTestMatch = path.match(/^\/saved-profile-proxies\/([^/]+)\/proxy-test$/);
            if (savedProxyTestMatch) {
                const savedProxyId = decodeURIComponent(savedProxyTestMatch[1]);
                if (req.method === 'GET') {
                    return _sendJson(res, 200, {
                        success: true,
                        data: (await readSavedProfileProxyTestResult(savedProxyId)) || normalizeProxyTestResult({
                            success: false,
                            status: 'info',
                            mode: 'unknown',
                            error: 'Not tested yet',
                            summary: 'Not tested yet',
                        })
                    });
                }

                if (req.method === 'POST') {
                    return _sendJson(res, 200, {
                        success: true,
                        data: await testSavedProfileProxyInternal(savedProxyId)
                    });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            const savedProxyMatch = path.match(/^\/saved-profile-proxies\/([^/]+)$/);
            if (savedProxyMatch) {
                const savedProxyId = decodeURIComponent(savedProxyMatch[1]);
                if (req.method === 'GET') {
                    const list = await listSavedProfileProxiesWithUsage();
                    const item = list.find(proxy => proxy.id === normalizeSavedProfileProxyId(savedProxyId)) || null;
                    if (!item) return _sendJson(res, 404, { success: false, error: 'Saved proxy not found' });
                    return _sendJson(res, 200, { success: true, data: item });
                }

                if (req.method === 'PATCH') {
                    const payload = await _readJsonBody(req);
                    const result = await patchSavedProfileProxyEntry(savedProxyId, payload);
                    return _sendJson(res, 200, { success: true, data: result.item });
                }

                if (req.method === 'DELETE') {
                    const result = await deleteSavedProfileProxyEntry(savedProxyId);
                    return _sendJson(res, 200, {
                        success: true,
                        data: {
                            id: result.deletedId,
                            affectedProfilesCount: result.affectedProfilesCount,
                        }
                    });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            if (path === '/profiles/batch/saved-proxy-binding') {
                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const payload = await _readJsonBody(req);
                const result = await batchUpdateSavedProfileProxyBindings(payload);
                return _sendJson(res, 200, { success: true, data: result });
            }

            if (path === '/profiles/batch/random-saved-proxy-binding') {
                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const payload = await _readJsonBody(req);
                const result = await batchAssignRandomSavedProfileProxyBindings(payload);
                return _sendJson(res, 200, { success: true, data: result });
            }

            const cookieMatch = path.match(/^\/profiles\/([^/]+)\/cookies\/(import|export)$/);
            if (cookieMatch) {
                const profileId = cookieMatch[1];
                const action = cookieMatch[2];
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);
                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });

                if (action === 'export') {
                    if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                    ensureProfilesStopped([profileId], profiles, 'Cookies 导出');
                    const format = String(urlObj.searchParams.get('format') || 'json').trim().toLowerCase();
                    const cookies = await exportCookiesFromUserDataDir(getProfileUserDataDir(profileId));
                    const content = format === 'netscape'
                        ? serializeCookiesToNetscape(cookies)
                        : JSON.stringify(cookies, null, 2);
                    return _sendJson(res, 200, { success: true, data: { format: format === 'netscape' ? 'netscape' : 'json', count: cookies.length, content } });
                }

                if (action === 'import') {
                    if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                    ensureProfilesStopped([profileId], profiles, 'Cookies 导入');
                    const payload = await _readJsonBody(req);
                    const cookies = parseCookiesForImport(payload && (payload.content || payload.cookies), {
                        targetUrl: getCookieTargetUrl(profile, payload && payload.targetUrl),
                    });
                    await importCookiesToUserDataDir(getProfileUserDataDir(profileId), cookies);
                    return _sendJson(res, 200, { success: true, data: { count: cookies.length } });
                }
            }

            const proxyTestMatch = path.match(/^\/profiles\/([^/]+)\/proxy-test$/);
            if (proxyTestMatch) {
                const profileId = decodeURIComponent(proxyTestMatch[1]);
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);
                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });

                if (req.method === 'GET') {
                    const cached = await readProfileProxyTestResult(profileId);
                    return _sendJson(res, 200, {
                        success: true,
                        data: cached || normalizeProxyTestResult({
                            success: false,
                            status: 'info',
                            mode: 'unknown',
                            error: 'Not tested yet',
                            summary: 'Not tested yet',
                        })
                    });
                }

                if (req.method === 'POST') {
                    const result = await testProfileProxyInternal(profile, activeProcesses[profileId]);
                    return _sendJson(res, 200, { success: true, data: result });
                }

                return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
            }

            const diagnosticsArtifactMatch = path.match(/^\/profiles\/([^/]+)\/diagnostics\/artifacts\/([^/]+)\/(screenshot|html|text|json)$/);
            if (diagnosticsArtifactMatch) {
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                const profileId = decodeURIComponent(diagnosticsArtifactMatch[1]);
                const runId = decodeURIComponent(diagnosticsArtifactMatch[2]);
                const kind = diagnosticsArtifactMatch[3];
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);
                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });
                const filePath = getDiagnosticArtifactFilePath(profileId, runId, kind);
                if (!filePath || !fs.existsSync(filePath)) return _sendJson(res, 404, { success: false, error: 'Artifact not found' });
                const body = await fs.readFile(filePath);
                const contentType = kind === 'screenshot'
                    ? 'image/png'
                    : (kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
                return _sendBuffer(res, 200, body, contentType, {
                    'Cache-Control': 'no-store, max-age=0',
                    'Content-Disposition': kind === 'screenshot'
                        ? `inline; filename="${sanitizeDiagnosticArtifactSegment(runId)}.png"`
                        : `inline; filename="${sanitizeDiagnosticArtifactSegment(runId)}.${kind === 'html' ? 'html.txt' : (kind === 'json' ? 'json' : 'txt')}"`,
                });
            }

            const diagnosticsMatch = path.match(/^\/profiles\/([^/]+)\/diagnostics(?:\/(open|run-all|clear))?$/);
            if (diagnosticsMatch) {
                const profileId = diagnosticsMatch[1];
                const action = diagnosticsMatch[2] || '';
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);
                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });

                const settings = await readSettingsAsync();
                const proc = activeProcesses[profileId];

                if (!action) {
                    if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                    const diagnostics = await buildDiagnosticsPayload(profile, proc, settings);
                    diagnostics.observedHeaders = buildObservedBrowserHeaders(req.headers);
                    return _sendJson(res, 200, { success: true, data: diagnostics });
                }

                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                if (action === 'clear') {
                    await clearDiagnosticHistory(profileId);
                    return _sendJson(res, 200, { success: true, data: await buildDiagnosticsPayload(profile, proc, settings) });
                }

                if (!isBrowserProcessRunning(proc)) {
                    return _sendJson(res, 400, { success: false, error: 'Profile not running' });
                }

                if (action === 'run-all') {
                    await runAllDiagnosticPresetsForProfile(profile, proc, settings);
                    return _sendJson(res, 200, { success: true, data: await buildDiagnosticsPayload(profile, proc, settings) });
                }

                const payload = await _readJsonBody(req).catch(() => ({}));
                const presetId = String(payload.presetId || '').trim();
                const preset = resolveDiagnosticPresets(settings).find(item => item.id === presetId && item.enabled !== false);
                if (!preset) return _sendJson(res, 404, { success: false, error: 'Diagnostic preset not found' });
                await runDiagnosticPresetForProfile(profile, proc, preset);
                return _sendJson(res, 200, { success: true, data: await buildDiagnosticsPayload(profile, proc, settings) });
            }

            const subMatch = path.match(/^\/profiles\/([^/]+)\/(runtime|ip|netinfo)$/);
            if (subMatch) {
                const profileId = subMatch[1];
                const kind = subMatch[2];
                if (req.method !== 'GET') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);
                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });

                const proc = activeProcesses[profileId];
                const running = !!(proc && proc.browser && proc.browser.isConnected && proc.browser.isConnected());

                if (kind === 'runtime') {
                    return _sendJson(res, 200, { success: true, data: buildRuntimeSnapshot(profile, proc, await readSettingsAsync()) });
                }

                if (!running || !proc || !proc.localPort) return _sendJson(res, 400, { success: false, error: 'Profile not running' });

                if (kind === 'ip') {
                    try {
                        const data = await fetchProxyIpViaLocalPort(proc.localPort);
                        return _sendJson(res, 200, { success: true, data });
                    } catch (e) {
                        return _sendJson(res, 502, { success: false, error: 'IP fetch failed' });
                    }
                }

                if (kind === 'netinfo') {
                    try {
                        const data = await fetchProxyNetinfoViaLocalPort(proc.localPort);
                        return _sendJson(res, 200, { success: true, data });
                    } catch (e) {
                        return _sendJson(res, 502, { success: false, error: 'Netinfo fetch failed' });
                    }
                }

                return _sendJson(res, 404, { success: false, error: 'Not Found' });
            }

            const match = path.match(/^\/profiles\/([^/]+)(?:\/(open|close|restart|restart-ssh))?$/);
            if (match) {
                const profileId = match[1];
                const action = match[2];
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const profile = profiles.find(p => p.id === profileId);

                if (!profile) return _sendJson(res, 404, { success: false, error: 'Profile not found' });

                if (!action) {
                    if (req.method === 'GET') {
                        return _sendJson(res, 200, { success: true, data: profile });
                    }

                    if (req.method === 'PATCH') {
                        const patch = await _readJsonBody(req);
                        const allowed = ['name', 'proxyStr', 'remark', 'tags', 'debugPort', 'preProxyOverride'];
                        for (const k of allowed) {
                            if (Object.prototype.hasOwnProperty.call(patch, k)) profile[k] = patch[k];
                        }
                        if (Object.prototype.hasOwnProperty.call(patch, 'startupUrls')) {
                            profile.startupUrls = normalizeStartupUrls(patch.startupUrls);
                        }
                        if (Object.prototype.hasOwnProperty.call(patch, 'headerPresetId')) {
                            profile.headerPresetId = normalizeHeaderPresetId(patch.headerPresetId);
                        }
                        if (Object.prototype.hasOwnProperty.call(patch, 'savedProxyId')) {
                            profile.savedProxyId = normalizeSavedProfileProxyId(patch.savedProxyId);
                        }
                        applyNormalizedProfileExtensionConfig(profile, patch);
                        applyNormalizedProfilePermissionModes(profile, patch);
                        applyNormalizedProfileSavedProxyConfig(profile, patch);
                        const fingerprintPatch = {};
                        if (typeof patch.timezone === 'string' && patch.timezone.trim()) fingerprintPatch.timezone = patch.timezone.trim();
                        if (typeof patch.language === 'string' && patch.language.trim()) fingerprintPatch.language = patch.language.trim();
                        if (Object.prototype.hasOwnProperty.call(patch, 'city')) fingerprintPatch.city = patch.city;
                        if (Object.prototype.hasOwnProperty.call(patch, 'geolocation')) fingerprintPatch.geolocation = patch.geolocation;
                        if (Object.prototype.hasOwnProperty.call(patch, 'fingerprint')) {
                            profile.fingerprint = mergeFingerprint(profile.fingerprint, deepMergeObjects(fingerprintPatch, patch.fingerprint), { fitMissingWindowToWorkArea: true });
                        } else if (Object.keys(fingerprintPatch).length > 0) {
                            profile.fingerprint = mergeFingerprint(profile.fingerprint, fingerprintPatch, { fitMissingWindowToWorkArea: true });
                        } else if (profile.fingerprint) {
                            profile.fingerprint = normalizeFingerprintForStorage(profile.fingerprint, { fitMissingWindowToWorkArea: true });
                        }
                        await fs.writeJson(PROFILES_FILE, profiles);
                        return _sendJson(res, 200, { success: true, data: profile });
                    }

                    if (req.method === 'DELETE') {
                        await deleteProfileInternal(profileId);
                        return _sendJson(res, 200, { success: true });
                    }

                    return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
                }

                if (req.method !== 'POST') return _sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

                if (action === 'open') {
                    const body = await _readJsonBody(req).catch(() => ({}));
                    const style = body.watermarkStyle || 'enhanced';
                    const result = await launchProfileInternal(profileId, style, null, { forceRemoteDebugging: true });
                    return _sendJson(res, 200, { success: true, data: result });
                }

                if (action === 'restart') {
                    const body = await _readJsonBody(req).catch(() => ({}));
                    const style = body.watermarkStyle || 'enhanced';
                    _sendJson(res, 202, { success: true, data: { scheduled: true } });
                    setTimeout(() => {
                        (async () => {
                            try { await closeProfileInternal(profileId, null); } catch (e) { }
                            try { await launchProfileInternal(profileId, style, null, { forceRemoteDebugging: true }); } catch (e) {
                                console.error('Profile restart failed:', e);
                            }
                        })();
                    }, 200);
                    return;
                }

                if (action === 'close') {
                    await closeProfileInternal(profileId, null);
                    return _sendJson(res, 200, { success: true });
                }

                if (action === 'restart-ssh') {
                    await restartSshInternal(profileId);
                    return _sendJson(res, 200, { success: true, data: buildRuntimeSnapshot(profile, activeProcesses[profileId], await readSettingsAsync()) });
                }
            }

            return _sendJson(res, 404, { success: false, error: 'Not Found' });
        } catch (e) {
            return _sendJson(res, e && e.status ? e.status : 500, { success: false, error: e.message || String(e) });
        }
    });

    localApiServer.on('error', (err) => {
        console.error(`[GeekEZ Local API] Error: ${err && err.message ? err.message : String(err)}`);
    });

    localApiServer.listen(LOCAL_API_PORT, LOCAL_API_HOST, () => {
        console.log(`[GeekEZ Local API] Listening on http://${LOCAL_API_HOST}:${LOCAL_API_PORT}`);
    });
}

app.whenReady().then(async () => {
    await ensureAppDataFilesHealthy();
    createWindow();

    // Auto-start API server if enabled
    try {
        const settings = await readSettingsAsync();
        if (settings.enableApiServer && !apiServerRunning) {
            const port = settings.apiPort || 12138;
            apiServer = createApiServer(port);
            apiServer.on('error', (err) => {
                apiServer = null;
                apiServerRunning = false;
                console.error('API Server failed to auto-start:', err);
            });
            apiServer.listen(port, '127.0.0.1', () => {
                apiServerRunning = true;
                console.log(`🔌 API Server auto-started on http://localhost:${port}`);
            });
        }
    } catch (e) {
        console.error('Failed to auto-start API server:', e);
    }

    startLocalApiServer();
    startSavedProfileProxySourceMaintenanceScheduler();
    setTimeout(() => { fs.emptyDir(TRASH_PATH).catch(() => { }); }, 10000);
});

// IPC Handles
ipcMain.handle('get-app-info', () => { return { name: app.getName(), version: app.getVersion() }; });
ipcMain.handle('get-local-api-base', () => `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}`);
ipcMain.handle('ssh-hostkey-prompt-result', (e, payload) => {
    const requestId = payload && payload.requestId ? String(payload.requestId) : '';
    const choice = payload && payload.choice ? String(payload.choice) : 'cancel';
    const waiter = requestId ? sshHostKeyPromptWaiters.get(requestId) : null;
    if (!waiter) return false;
    sshHostKeyPromptWaiters.delete(requestId);
    try { waiter.resolve(choice); } catch (e2) { }
    return true;
});
ipcMain.handle('fetch-url', async (e, url) => { try { const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.text(); } catch (e) { throw e.message; } });
ipcMain.handle('test-proxy-config', async (e, payload) => {
    const proxyStr = typeof payload === 'string'
        ? payload
        : (payload && Object.prototype.hasOwnProperty.call(payload, 'proxyStr') ? payload.proxyStr : '');
    return testProxyConfigInternal(proxyStr);
});
ipcMain.handle('get-profile-proxy-test', async (e, profileId) => {
    const id = String(profileId || '').trim();
    if (!id) return null;
    return readProfileProxyTestResult(id);
});
ipcMain.handle('get-saved-profile-proxy-test', async (e, savedProxyId) => {
    const id = normalizeSavedProfileProxyId(savedProxyId);
    if (!id) return null;
    return readSavedProfileProxyTestResult(id);
});
ipcMain.handle('test-saved-profile-proxy', async (e, savedProxyId) => {
    return testSavedProfileProxyInternal(savedProxyId);
});
ipcMain.handle('delete-saved-profile-proxy-test', async (e, savedProxyId) => {
    await deleteSavedProfileProxyTestResult(savedProxyId);
    return true;
});
ipcMain.handle('persist-saved-profile-proxy-test', async (e, payload) => {
    const source = isPlainObject(payload) ? payload : {};
    const savedProxyId = normalizeSavedProfileProxyId(source.savedProxyId || source.id);
    if (!savedProxyId) throw new Error('savedProxyId is required');
    return persistSavedProfileProxyTestResult(savedProxyId, source.result || source, {
        mergeHistory: source.mergeHistory !== false,
    });
});
ipcMain.handle('test-proxy-latency', async (e, proxyStr) => {
    try {
        const tempProxy = await startTemporaryLocalProxyForProxy(proxyStr, 'latency-test');
        try {
            const result = await probeProxyConnectivityViaLocalPort(tempProxy.localPort);
            return result.success
                ? { success: true, latency: result.latencyMs }
                : { success: false, msg: result.error || 'Err' };
        } finally {
            await tempProxy.cleanup();
        }
    } catch (err) {
        return { success: false, msg: err.message };
    }
});
ipcMain.handle('set-title-bar-color', (e, colors) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) { if (process.platform === 'win32') try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol }); } catch (e) { } win.setBackgroundColor(colors.bg); } });
ipcMain.handle('check-app-update', async () => { try { const data = await fetchJson(APP_RELEASES_API_URL); if (!data || !data.tag_name) return { update: false }; const remote = data.tag_name.replace('v', ''); if (compareVersions(remote, app.getVersion()) > 0) { return { update: true, remote, url: data.html_url || APP_RELEASES_URL, notes: data.body }; } return { update: false }; } catch (e) { return { update: false, error: e.message }; } });
ipcMain.handle('check-xray-update', async () => { try { const data = await fetchJson('https://api.github.com/repos/XTLS/Xray-core/releases/latest'); if (!data || !data.tag_name) return { update: false }; const remoteVer = data.tag_name; const currentVer = await getLocalXrayVersion(); if (remoteVer !== currentVer) { let assetName = ''; const arch = os.arch(); const platform = os.platform(); if (platform === 'win32') assetName = `Xray-windows-${arch === 'x64' ? '64' : '32'}.zip`; else if (platform === 'darwin') assetName = `Xray-macos-${arch === 'arm64' ? 'arm64-v8a' : '64'}.zip`; else assetName = `Xray-linux-${arch === 'x64' ? '64' : '32'}.zip`; const downloadUrl = `https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/download/${remoteVer}/${assetName}`; return { update: true, remote: remoteVer.replace(/^v/, ''), downloadUrl }; } return { update: false }; } catch (e) { return { update: false }; } });
ipcMain.handle('download-xray-update', async (e, url) => {
    const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray';
    const tempBase = os.tmpdir();
    const updateId = `xray_update_${Date.now()}`;
    const tempDir = path.join(tempBase, updateId);
    const zipPath = path.join(tempDir, 'xray.zip');
    try {
        fs.mkdirSync(tempDir, { recursive: true });
        await downloadFile(url, zipPath);
        if (process.platform === 'win32') await new Promise((resolve) => exec('taskkill /F /IM xray.exe', () => resolve()));
        activeProcesses = {};
        await new Promise(r => setTimeout(r, 3000));
        const extractDir = path.join(tempDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZip(zipPath, extractDir);
        function findXrayBinary(dir) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const found = findXrayBinary(fullPath);
                    if (found) return found;
                } else if (file === exeName) {
                    return fullPath;
                }
            }
            return null;
        }
        const xrayBinary = findXrayBinary(extractDir);
        console.log('[Update Debug] Searched in:', extractDir);
        console.log('[Update Debug] Found binary:', xrayBinary);
        if (!xrayBinary) {
            // 列出所有文件帮助调试
            const allFiles = [];
            function listAllFiles(dir, prefix = '') {
                const files = fs.readdirSync(dir);
                files.forEach(file => {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        allFiles.push(prefix + file + '/');
                        listAllFiles(fullPath, prefix + file + '/');
                    } else {
                        allFiles.push(prefix + file);
                    }
                });
            }
            listAllFiles(extractDir);
            console.log('[Update Debug] All extracted files:', allFiles);
            throw new Error('Xray binary not found in package');
        }

        // Windows文件锁规避：先重命名旧文件，再复制新文件
        const oldPath = BIN_PATH + '.old';
        if (fs.existsSync(BIN_PATH)) {
            try {
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (e) { }
            fs.renameSync(BIN_PATH, oldPath);
        }
        fs.copyFileSync(xrayBinary, BIN_PATH);
        // 删除旧文件
        try {
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch (e) { }
        if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, '755');
        // 清理临时目录（即使失败也不影响更新）
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('[Cleanup Warning] Failed to remove temp dir:', cleanupErr.message);
        }
        return true;
    } catch (e) {
        console.error('Xray update failed:', e);
        try {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) { }
        return false;
    }
});
ipcMain.handle('get-running-ids', () => Object.keys(activeProcesses));
ipcMain.handle('generate-fingerprint', () => createManagedFingerprint({ chromeVersion: getBundledChromeVersion() }));
ipcMain.handle('get-profiles', async () => readProfilesAsync());
ipcMain.handle('get-profile-runtime', async (event, profileId) => {
    const profiles = await readProfilesAsync();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    return buildRuntimeSnapshot(profile, activeProcesses[profileId], await readSettingsAsync());
});
ipcMain.handle('get-profile-diagnostics', async (event, profileId) => {
    const profiles = await readProfilesAsync();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    const settings = await readSettingsAsync();
    return buildDiagnosticsPayload(profile, activeProcesses[profileId], settings);
});
ipcMain.handle('open-profile-dashboard', async (event, payload) => {
    const profileId = typeof payload === 'string'
        ? String(payload || '').trim()
        : String(payload && payload.profileId || '').trim();
    const appLang = typeof payload === 'string' ? '' : String(payload && payload.appLang || '').trim();
    const profiles = await readProfilesAsync();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    const url = await openProfileDashboardInternal(profileId, activeProcesses[profileId], appLang);
    return { url };
});
ipcMain.handle('set-app-language', async (event, language) => persistUiLanguagePreference(language));
ipcMain.handle('open-profile-diagnostic', async (event, payload) => {
    const profileId = String(payload && payload.profileId || '').trim();
    const presetId = String(payload && payload.presetId || '').trim();
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    const settings = await readSettingsAsync();
    const preset = resolveDiagnosticPresets(settings).find((item) => item.id === presetId && item.enabled !== false);
    if (!preset) throw new Error('Diagnostic preset not found');
    await runDiagnosticPresetForProfile(profile, activeProcesses[profileId], preset);
    return buildDiagnosticsPayload(profile, activeProcesses[profileId], settings);
});
ipcMain.handle('run-profile-diagnostics-all', async (event, profileId) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    const settings = await readSettingsAsync();
    await runAllDiagnosticPresetsForProfile(profile, activeProcesses[profileId], settings);
    return buildDiagnosticsPayload(profile, activeProcesses[profileId], settings);
});
ipcMain.handle('clear-profile-diagnostics', async (event, profileId) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    const settings = await readSettingsAsync();
    await clearDiagnosticHistory(profileId);
    return buildDiagnosticsPayload(profile, activeProcesses[profileId], settings);
});
ipcMain.handle('update-profile', async (event, updatedProfile) => {
    let profiles = await fs.readJson(PROFILES_FILE);
    const index = profiles.findIndex(p => p.id === updatedProfile.id);
    if (index > -1) {
        const currentProfile = profiles[index];
        const nextProfile = { ...currentProfile, ...updatedProfile };
        if (updatedProfile && Object.prototype.hasOwnProperty.call(updatedProfile, 'fingerprint')) {
            nextProfile.fingerprint = mergeFingerprint(currentProfile.fingerprint, updatedProfile.fingerprint, { fitMissingWindowToWorkArea: true });
        } else if (nextProfile.fingerprint) {
            nextProfile.fingerprint = normalizeFingerprintForStorage(nextProfile.fingerprint, { fitMissingWindowToWorkArea: true });
        }
        if (nextProfile.fingerprint) ensureFingerprintProtectionDefaults(nextProfile.fingerprint);
        if (updatedProfile && Object.prototype.hasOwnProperty.call(updatedProfile, 'startupUrls')) {
            nextProfile.startupUrls = normalizeStartupUrls(updatedProfile.startupUrls);
        }
        if (updatedProfile && Object.prototype.hasOwnProperty.call(updatedProfile, 'headerPresetId')) {
            nextProfile.headerPresetId = normalizeHeaderPresetId(updatedProfile.headerPresetId);
        }
        applyNormalizedProfileExtensionConfig(nextProfile, updatedProfile);
        applyNormalizedProfilePermissionModes(nextProfile, updatedProfile);
        applyNormalizedProfileSavedProxyConfig(nextProfile, updatedProfile);
        profiles[index] = nextProfile;
        await fs.writeJson(PROFILES_FILE, profiles);
        return true;
    }
    return false;
});
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprintSource = isPlainObject(data.fingerprint)
        ? deepMergeObjects({}, data.fingerprint)
        : createManagedFingerprint({ chromeVersion: getBundledChromeVersion() });
    if (data.screen) {
        fingerprintSource.screen = sanitizeSize(data.screen, DEFAULT_FINGERPRINT_SCREEN);
        if (!(isPlainObject(data.fingerprint) && isPlainObject(data.fingerprint.window))) delete fingerprintSource.window;
    }
    const fingerprint = normalizeFingerprintForStorage(fingerprintSource, { fitMissingWindowToWorkArea: true });

    if (typeof data.timezone === 'string' && data.timezone.trim()) fingerprint.timezone = data.timezone.trim();
    else if (!fingerprint.timezone) fingerprint.timezone = AUTO_TIMEZONE;
    if (data.city) fingerprint.city = data.city;
    if (data.geolocation) fingerprint.geolocation = data.geolocation;
    if (typeof data.language === 'string' && data.language.trim()) fingerprint.language = data.language.trim();
    else if (!fingerprint.language) fingerprint.language = AUTO_LANGUAGE;

    ensureFingerprintProtectionDefaults(fingerprint);

    const newProfile = {
        id: uuidv4(),
        name: data.name,
        proxyStr: data.proxyStr,
        savedProxyId: normalizeSavedProfileProxyId(data.savedProxyId),
        remark: data.remark || '',
        tags: data.tags || [],
        startupUrls: normalizeStartupUrls(data.startupUrls),
        fingerprint: fingerprint,
        headerPresetId: normalizeHeaderPresetId(data.headerPresetId),
        extensionPaths: normalizeProfileExtensionPaths(data.extensionPaths),
        useGlobalExtensions: normalizeUseGlobalExtensions(data.useGlobalExtensions, true),
        ...normalizeProfilePermissionModes(data),
        preProxyOverride: data.preProxyOverride || 'default',
        debugPort: data.debugPort || undefined,
        isSetup: false,
        createdAt: Date.now()
    };
    profiles.push(newProfile);
    await fs.writeJson(PROFILES_FILE, profiles);
    return newProfile;
});
ipcMain.handle('import-profile-cookies', async (event, payload = {}) => {
    const profileId = String(payload.profileId || '').trim();
    if (!profileId) throw new Error('Profile ID required');
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    ensureProfilesStopped([profileId], profiles, 'Cookies 导入');

    let content = payload.content;
    if (!content) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Import Cookies',
            properties: ['openFile'],
            filters: [
                { name: 'Cookie Files', extensions: ['json', 'txt', 'cookies'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
        content = await fs.readFile(filePaths[0], 'utf8');
    }

    const cookies = parseCookiesForImport(content, {
        targetUrl: getCookieTargetUrl(profile, payload.targetUrl),
    });
    await importCookiesToUserDataDir(getProfileUserDataDir(profileId), cookies);
    return { canceled: false, count: cookies.length };
});
ipcMain.handle('export-profile-cookies', async (event, payload = {}) => {
    const profileId = String(payload.profileId || '').trim();
    if (!profileId) throw new Error('Profile ID required');
    const format = String(payload.format || 'json').trim().toLowerCase() === 'netscape' ? 'netscape' : 'json';
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    ensureProfilesStopped([profileId], profiles, 'Cookies 导出');

    const cookies = await exportCookiesFromUserDataDir(getProfileUserDataDir(profileId));
    const content = format === 'netscape'
        ? serializeCookiesToNetscape(cookies)
        : JSON.stringify(cookies, null, 2);

    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export Cookies',
        defaultPath: `${profile.name || 'profile'}-cookies.${format === 'netscape' ? 'txt' : 'json'}`,
        filters: format === 'netscape'
            ? [{ name: 'Netscape Cookies', extensions: ['txt', 'cookies'] }]
            : [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { canceled: true, count: cookies.length };
    await fs.writeFile(filePath, content, 'utf8');
    return { canceled: false, count: cookies.length, format };
});
ipcMain.handle('import-profile-storage', async (event, payload = {}) => {
    const profileId = String(payload.profileId || '').trim();
    if (!profileId) throw new Error('Profile ID required');
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    ensureProfilesStopped([profileId], profiles, 'Storage 导入');

    let filePath = String(payload.filePath || '').trim();
    if (!filePath) {
        const dialogResult = await dialog.showOpenDialog({
            title: 'Import Storage Snapshot',
            properties: ['openFile'],
            filters: [
                { name: 'GeekEZ Storage', extensions: ['geekezstorage', 'zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (dialogResult.canceled || !dialogResult.filePaths || !dialogResult.filePaths[0]) return { canceled: true };
        filePath = dialogResult.filePaths[0];
    }

    const buffer = await fs.readFile(filePath);
    const bundle = await loadProfileStorageBundle(buffer);
    try {
        await importProfileStorageBundleToUserDataDir(getProfileUserDataDir(profileId), bundle);
        return { canceled: false, count: bundle.metadata.items.length, items: bundle.metadata.items.map(item => item.key) };
    } finally {
        try { await fs.remove(bundle.tempRoot); } catch (e) { }
    }
});
ipcMain.handle('export-profile-storage', async (event, payload = {}) => {
    const profileId = String(payload.profileId || '').trim();
    if (!profileId) throw new Error('Profile ID required');
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    ensureProfilesStopped([profileId], profiles, 'Storage 导出');

    const bundle = await buildProfileStorageBundle(profileId);
    try {
        let filePath = String(payload.filePath || '').trim();
        if (!filePath) {
            const dialogResult = await dialog.showSaveDialog({
                title: 'Export Storage Snapshot',
                defaultPath: `${profile.name || 'profile'}-storage.geekezstorage`,
                filters: [{ name: 'GeekEZ Storage', extensions: ['geekezstorage'] }]
            });
            if (dialogResult.canceled || !dialogResult.filePath) return { canceled: true, count: bundle.metadata.items.length };
            filePath = dialogResult.filePath;
        }
        await fs.copy(bundle.zipPath, filePath, { overwrite: true });
        return { canceled: false, count: bundle.metadata.items.length, items: bundle.metadata.items.map(item => item.key) };
    } finally {
        try { await fs.remove(bundle.tempRoot); } catch (e) { }
    }
});
ipcMain.handle('export-saved-profile-proxies', async (event, payload = {}) => {
    const format = String(payload.format || '').trim().toLowerCase() === 'json' ? 'json' : 'txt';
    const sourceList = Array.isArray(payload.savedProfileProxies)
        ? payload.savedProfileProxies
        : (Array.isArray(payload.proxies) ? payload.proxies : []);
    const proxies = sourceList
        .map((item, index) => normalizeSavedProfileProxy(item, index))
        .filter((proxy) => String(proxy.proxyStr || '').trim());
    if (proxies.length === 0) return { canceled: true, count: 0, format };

    const content = format === 'json'
        ? JSON.stringify(proxies, null, 2)
        : proxies.map((proxy) => String(proxy.proxyStr || '').trim()).filter(Boolean).join('\n');
    const scopeLabel = String(payload.scopeLabel || 'visible').trim() || 'visible';
    const defaultPath = `GeekEZ_SavedProxies_${scopeLabel}_${Date.now()}.${format === 'json' ? 'json' : 'txt'}`;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export Saved Proxies',
        defaultPath,
        filters: format === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Text', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true, count: proxies.length, format };
    await fs.writeFile(filePath, content, 'utf8');
    return { canceled: false, count: proxies.length, format };
});
async function closeProfileInternal(id, sender) {
    const proc = activeProcesses[id];
    if (!proc) return false;
    proc.manualClosing = true;
    proc.sshRestarting = false;
    delete activeProcesses[id];

    await forceKill(proc.xrayPid);
    await forceKill(proc.sshPid);
    try {
        await proc.browser.close();
    } catch (e) { }

    // 关闭日志文件描述符（Windows 必须）
    if (proc.logFd !== undefined) {
        try {
            fs.closeSync(proc.logFd);
            console.log('Closed log file descriptor');
        } catch (e) {
            console.error('Failed to close log fd:', e.message);
        }
    }
    if (proc.sshLogFd !== undefined) {
        try {
            fs.closeSync(proc.sshLogFd);
        } catch (e) { }
    }
    // Windows 需要更长的等待时间让文件释放
    await new Promise(r => setTimeout(r, 1000));

    if (sender && !sender.isDestroyed()) sender.send('profile-status', { id, status: 'stopped' });
    return true;
}
ipcMain.handle('close-profile', async (event, id) => {
    await closeProfileInternal(id, event.sender);
    return true;
});

async function deleteProfileInternal(id) {
    // 关闭正在运行的进程
    await closeProfileInternal(id, null);

    // 从 profiles.json 中删除
    let profiles = await fs.readJson(PROFILES_FILE);
    profiles = profiles.filter(p => p.id !== id);
    await fs.writeJson(PROFILES_FILE, profiles);

    // 永久删除 profile 文件夹（带重试机制）
    const profileDir = path.join(DATA_PATH, id);
    let deleted = false;

    // 尝试删除 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (fs.existsSync(profileDir)) {
                // 使用 fs-extra 的 remove，它会递归删除
                await fs.remove(profileDir);
                console.log(`Deleted profile folder: ${profileDir}`);
                deleted = true;
                break;
            } else {
                deleted = true;
                break;
            }
        } catch (err) {
            console.error(`Delete attempt ${attempt} failed:`, err.message);
            if (attempt < 3) {
                // 等待后重试
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
    }

    // 如果删除失败，移到回收站作为后备方案
    if (!deleted && fs.existsSync(profileDir)) {
        console.warn(`Failed to delete, moving to trash: ${profileDir}`);
        const trashDest = path.join(TRASH_PATH, `${id}_${Date.now()}`);
        try {
            await fs.move(profileDir, trashDest);
            console.log(`Moved to trash: ${trashDest}`);
        } catch (err) {
            console.error(`Failed to move to trash:`, err);
        }
    }

    return true;
}
ipcMain.handle('delete-profile', async (event, id) => deleteProfileInternal(id));
ipcMain.handle('get-settings', async () => readSettingsAsync());
ipcMain.handle('save-settings', async (e, settings) => {
    await writeSettingsWithSavedProfileProxyLifecycle(settings);
    return true;
});
ipcMain.handle('select-extension-folder', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Extension Folder'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});
ipcMain.handle('add-user-extension', async (e, extPath) => {
    const settings = await readSettingsAsync();
    if (!settings.userExtensions) settings.userExtensions = [];
    if (!settings.userExtensions.includes(extPath)) {
        settings.userExtensions.push(extPath);
        await fs.writeJson(SETTINGS_FILE, normalizeSettings(settings));
    }
    return true;
});
ipcMain.handle('remove-user-extension', async (e, extPath) => {
    const settings = await readSettingsAsync();
    if (settings.userExtensions) {
        settings.userExtensions = settings.userExtensions.filter(p => p !== extPath);
        await fs.writeJson(SETTINGS_FILE, normalizeSettings(settings));
    }
    return true;
});
ipcMain.handle('get-user-extensions', async () => {
    const settings = await readSettingsAsync();
    return settings.userExtensions || [];
});
ipcMain.handle('open-url', async (e, url) => { await shell.openExternal(url); });

// --- 自定义数据目录 ---
ipcMain.handle('get-data-path-info', async () => {
    return {
        currentPath: DATA_PATH,
        defaultPath: DEFAULT_DATA_PATH,
        isCustom: DATA_PATH !== DEFAULT_DATA_PATH
    };
});

ipcMain.handle('select-data-directory', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Data Directory'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});

ipcMain.handle('set-data-directory', async (e, { newPath, migrate }) => {
    try {
        // 验证路径
        if (!newPath) {
            return { success: false, error: 'Invalid path' };
        }

        // 确保目录存在
        await fs.ensureDir(newPath);

        // 检查是否有写入权限
        const testFile = path.join(newPath, '.geekez-test');
        try {
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
        } catch (e) {
            return { success: false, error: 'No write permission to selected directory' };
        }

        // 如果需要迁移数据
        if (migrate && DATA_PATH !== newPath) {
            const oldProfiles = path.join(DATA_PATH, 'profiles.json');
            const oldSettings = path.join(DATA_PATH, 'settings.json');

            // 迁移 profiles.json
            if (fs.existsSync(oldProfiles)) {
                await fs.copy(oldProfiles, path.join(newPath, 'profiles.json'));
            }
            // 迁移 settings.json
            if (fs.existsSync(oldSettings)) {
                await fs.copy(oldSettings, path.join(newPath, 'settings.json'));
            }

            // 迁移所有环境数据目录
            const profiles = fs.existsSync(oldProfiles) ? await fs.readJson(oldProfiles) : [];
            for (const profile of profiles) {
                const oldDir = path.join(DATA_PATH, profile.id);
                const newDir = path.join(newPath, profile.id);
                if (fs.existsSync(oldDir)) {
                    console.log(`Migrating profile ${profile.id}...`);
                    await fs.copy(oldDir, newDir);
                }
            }
        }

        // 保存新路径到配置
        await fs.writeJson(APP_CONFIG_FILE, { customDataPath: newPath });

        return { success: true, requiresRestart: true };
    } catch (err) {
        console.error('Failed to set data directory:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('reset-data-directory', async () => {
    try {
        // 删除自定义配置
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = await fs.readJson(APP_CONFIG_FILE);
            delete config.customDataPath;
            await fs.writeJson(APP_CONFIG_FILE, config);
        }
        return { success: true, requiresRestart: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// --- 导出/导入功能 (重构版) ---

// 辅助函数：清理 fingerprint 中的无用字段
function cleanFingerprint(fp) {
    if (!fp) return fp;
    const cleaned = { ...fp };
    delete cleaned.userAgent;
    delete cleaned.userAgentMetadata;
    delete cleaned.webgl;
    return cleaned;
}

// 加密辅助函数
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC_HEADER = Buffer.from('GKEZ'); // GeekEZ magic bytes

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function encryptData(data, password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 格式: MAGIC(4) + VERSION(4) + SALT(16) + IV(12) + AUTH_TAG(16) + ENCRYPTED_DATA
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1, 0); // Version 1

    return Buffer.concat([MAGIC_HEADER, version, salt, iv, authTag, encrypted]);
}

function decryptData(encryptedBuffer, password) {
    // 验证 magic header
    const magic = encryptedBuffer.slice(0, 4);
    if (!magic.equals(MAGIC_HEADER)) {
        throw new Error('Invalid backup file format');
    }

    let offset = 4;
    const version = encryptedBuffer.readUInt32LE(offset);
    offset += 4;

    if (version !== 1) {
        throw new Error(`Unsupported backup version: ${version}`);
    }

    const salt = encryptedBuffer.slice(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;

    const iv = encryptedBuffer.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    const authTag = encryptedBuffer.slice(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;

    const encrypted = encryptedBuffer.slice(offset);

    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

const FULL_BACKUP_DATA_VERSION = 2;
const FULL_BACKUP_METADATA_FILE = 'metadata.json';
const PROFILE_STORAGE_BUNDLE_VERSION = 1;
const PROFILE_STORAGE_METADATA_FILE = 'storage-metadata.json';
const PROFILE_STORAGE_DIRS = [
    { key: 'localStorage', relativePath: path.join('Default', 'Local Storage') },
    { key: 'sessionStorage', relativePath: path.join('Default', 'Session Storage') },
    { key: 'indexedDB', relativePath: path.join('Default', 'IndexedDB') },
];
const FULL_BACKUP_SKIP_DIRS = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'GrShaderCache',
    'ShaderCache',
    'Crashpad',
]);
const FULL_BACKUP_SKIP_FILES = new Set([
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'LOCK',
]);

function isSupportedFullBackupVersion(version) {
    return version === FULL_BACKUP_DATA_VERSION;
}

function getRunningProfileNames(profileIds, profiles) {
    const idSet = new Set(Array.isArray(profileIds) ? profileIds : []);
    return (Array.isArray(profiles) ? profiles : [])
        .filter(p => idSet.has(p.id) && activeProcesses[p.id])
        .map(p => String(p.name || p.id || '').trim() || p.id);
}

function ensureProfilesStopped(profileIds, profiles, actionText) {
    const runningNames = getRunningProfileNames(profileIds, profiles);
    if (runningNames.length > 0) {
        throw new Error(`${actionText}前请先关闭环境：${runningNames.join(', ')}`);
    }
}

function normalizeBackupRelativePath(relativePath) {
    const normalized = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/')).replace(/^\/+/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw new Error(`Invalid backup path: ${relativePath}`);
    }
    return normalized;
}

function getProfileUserDataDir(profileId) {
    return path.join(DATA_PATH, profileId, 'browser_data');
}

function getBackupTempRoot(prefix) {
    return fs.mkdtemp(path.join(app.getPath('temp'), prefix));
}

function getImportStageRoot(prefix) {
    fs.ensureDirSync(DATA_PATH);
    return fs.mkdtemp(path.join(DATA_PATH, prefix));
}

function shouldSkipBackupCopyPath(rootDir, srcPath) {
    const relativePath = path.relative(rootDir, srcPath);
    if (!relativePath || relativePath === '') return false;
    const normalized = normalizeBackupRelativePath(relativePath);
    const parts = normalized.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || '';
    if (!name) return false;
    if (FULL_BACKUP_SKIP_DIRS.has(name) || FULL_BACKUP_SKIP_FILES.has(name)) return true;
    const lower = name.toLowerCase();
    return lower.endsWith('.tmp') || lower.endsWith('.temp');
}

async function copyUserDataDirForBackup(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return false;
    await fs.copy(srcDir, destDir, {
        dereference: false,
        preserveTimestamps: false,
        filter: (srcPath) => !shouldSkipBackupCopyPath(srcDir, srcPath),
    });
    return true;
}

async function withCookieBrowser(userDataDir, handler) {
    const chromePath = getChromiumPath();
    if (!chromePath) throw new Error('Chrome binary not found.');
    await fs.ensureDir(userDataDir);
    const args = [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
    ];

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        userDataDir,
        defaultViewport: null,
        pipe: false,
        dumpio: false,
        args,
    });

    try {
        return await handler(browser);
    } finally {
        try { await browser.close(); } catch (e) { }
    }
}

function parseCookieExpires(value) {
    if (value === undefined || value === null || value === '' || value === 'session') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed / 1000);
}

function normalizeCookieSameSite(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'strict') return 'Strict';
    if (raw === 'lax') return 'Lax';
    if (raw === 'none' || raw === 'no_restriction') return 'None';
    return '';
}

function normalizeCookieDomain(value) {
    return String(value || '').trim().replace(/^#HttpOnly_/i, '');
}

function buildCookieUrl(cookie, targetUrl) {
    if (isValidHttpUrl(cookie && cookie.url)) return String(cookie.url).trim();
    const domain = normalizeCookieDomain(cookie && cookie.domain);
    const pathName = String(cookie && cookie.path || '/').trim() || '/';
    if (domain) {
        const host = domain.replace(/^\./, '');
        if (!host) return '';
        return `${cookie && cookie.secure ? 'https' : 'http'}://${host}${pathName.startsWith('/') ? pathName : '/'}`;
    }
    if (!isValidHttpUrl(targetUrl)) return '';
    try {
        const u = new URL(String(targetUrl).trim());
        u.pathname = pathName.startsWith('/') ? pathName : '/';
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch (e) {
        return '';
    }
}

function normalizeCookieForImport(cookie, options = {}) {
    if (!cookie || !cookie.name) return null;
    const name = String(cookie.name || '').trim();
    if (!name) return null;
    const secure = !!cookie.secure;
    const httpOnly = !!cookie.httpOnly;
    const domain = normalizeCookieDomain(cookie.domain);
    const pathName = String(cookie.path || '/').trim() || '/';
    const out = {
        name,
        value: String(cookie.value || ''),
        path: pathName.startsWith('/') ? pathName : '/',
        secure,
        httpOnly,
    };
    const url = buildCookieUrl(cookie, options.targetUrl);
    if (url) out.url = url;
    if (domain) out.domain = domain;
    const sameSite = normalizeCookieSameSite(cookie.sameSite);
    if (sameSite) out.sameSite = sameSite;
    const expires = parseCookieExpires(cookie.expires);
    if (expires && expires > 0) out.expires = expires;
    if (cookie.priority) out.priority = cookie.priority;
    if (typeof cookie.sameParty === 'boolean') out.sameParty = cookie.sameParty;
    if (cookie.sourceScheme) out.sourceScheme = cookie.sourceScheme;
    if (Number.isInteger(cookie.sourcePort)) out.sourcePort = cookie.sourcePort;
    if (cookie.partitionKey !== undefined) out.partitionKey = cookie.partitionKey;
    if (!out.url && !out.domain) return null;
    return out;
}

function parseJsonCookies(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed;
    if (isPlainObject(parsed) && Array.isArray(parsed.cookies)) return parsed.cookies;
    if (isPlainObject(parsed) && parsed.name) return [parsed];
    throw new Error('Invalid JSON cookie format');
}

function parseNetscapeCookies(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const cookies = [];
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        const httpOnly = line.startsWith('#HttpOnly_');
        if (line.startsWith('#') && !httpOnly) continue;
        const normalizedLine = httpOnly ? line.replace(/^#HttpOnly_/, '') : line;
        const cols = normalizedLine.split('\t');
        if (cols.length < 7) continue;
        const domain = cols[0];
        const includeSubdomains = String(cols[1] || '').trim().toUpperCase() === 'TRUE';
        const pathName = cols[2] || '/';
        const secure = String(cols[3] || '').trim().toUpperCase() === 'TRUE';
        const expires = parseCookieExpires(cols[4]);
        const name = String(cols[5] || '').trim();
        const value = cols.slice(6).join('\t');
        if (!name) continue;
        cookies.push({
            name,
            value,
            domain: includeSubdomains && domain && !String(domain).startsWith('.') ? `.${domain}` : domain,
            path: pathName || '/',
            secure,
            httpOnly,
            expires,
        });
    }
    if (cookies.length === 0) throw new Error('Invalid Netscape cookie format');
    return cookies;
}

function parsePlainTextCookieLine(line) {
    const parts = String(line || '').split(';').map(item => item.trim()).filter(Boolean);
    if (parts.length === 0 || !parts[0].includes('=')) return null;
    const [name, ...valueParts] = parts[0].split('=');
    const cookie = {
        name: String(name || '').trim(),
        value: valueParts.join('=').trim(),
    };
    for (let i = 1; i < parts.length; i++) {
        const token = parts[i];
        const [attrName, ...attrValueParts] = token.split('=');
        const key = String(attrName || '').trim().toLowerCase();
        const attrValue = attrValueParts.join('=').trim();
        if (key === 'domain') cookie.domain = attrValue;
        else if (key === 'path') cookie.path = attrValue || '/';
        else if (key === 'expires' || key === 'expiry' || key === 'max-age') cookie.expires = parseCookieExpires(attrValue);
        else if (key === 'samesite') cookie.sameSite = attrValue;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'httponly' || key === 'http-only') cookie.httpOnly = true;
        else if (!attrValueParts.length && key === 'secure') cookie.secure = true;
        else if (!attrValueParts.length && (key === 'httponly' || key === 'http-only')) cookie.httpOnly = true;
    }
    return cookie.name ? cookie : null;
}

function parsePlainTextCookies(raw) {
    const cookies = String(raw || '')
        .split(/\r?\n/)
        .map(line => String(line || '').trim())
        .filter(Boolean)
        .map((line) => {
            const normalized = line.replace(/^cookie:\s*/i, '');
            return parsePlainTextCookieLine(normalized);
        })
        .filter(Boolean);
    if (cookies.length === 0) throw new Error('Invalid plain cookie format');
    return cookies;
}

function parseCookiesForImport(raw, options = {}) {
    if (Array.isArray(raw) || isPlainObject(raw)) {
        const cookies = parseJsonCookies(raw)
            .map(cookie => normalizeCookieForImport(cookie, options))
            .filter(Boolean);
        if (cookies.length === 0) throw new Error('No valid cookies found');
        return cookies;
    }

    const text = String(raw || '').trim();
    if (!text) throw new Error('Cookie content is empty');

    let parsedCookies;
    if (text.startsWith('[') || text.startsWith('{')) {
        parsedCookies = parseJsonCookies(text);
    } else if (/\t(?:TRUE|FALSE)\t/i.test(text)) {
        parsedCookies = parseNetscapeCookies(text);
    } else {
        parsedCookies = parsePlainTextCookies(text);
    }

    const cookies = parsedCookies
        .map(cookie => normalizeCookieForImport(cookie, options))
        .filter(Boolean);
    if (cookies.length === 0) throw new Error('No valid cookies found');
    return cookies;
}

function serializeCookiesToNetscape(cookies) {
    const lines = [
        '# Netscape HTTP Cookie File',
        '# This file was generated by GeekEZ Browser',
        '',
    ];
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
        const domain = normalizeCookieDomain(cookie && cookie.domain) || (() => {
            try {
                return cookie && cookie.url ? new URL(cookie.url).hostname : '';
            } catch (e) {
                return '';
            }
        })();
        if (!domain) continue;
        const includeSubdomains = String(cookie && cookie.domain || '').startsWith('.') ? 'TRUE' : 'FALSE';
        const secure = cookie && cookie.secure ? 'TRUE' : 'FALSE';
        const expires = parseCookieExpires(cookie && cookie.expires) || 0;
        const pathName = String(cookie && cookie.path || '/').trim() || '/';
        const name = String(cookie && cookie.name || '').trim();
        if (!name) continue;
        const value = String(cookie && cookie.value || '');
        const domainField = cookie && cookie.httpOnly ? `#HttpOnly_${domain}` : domain;
        lines.push([domainField, includeSubdomains, pathName, secure, expires, name, value].join('\t'));
    }
    return lines.join('\n');
}

async function exportCookiesFromUserDataDir(userDataDir) {
    return withCookieBrowser(userDataDir, async (browser) => browser.cookies());
}

async function clearCookieStoresInUserDataDir(userDataDir) {
    const cookiePaths = [
        path.join(userDataDir, 'Default', 'Cookies'),
        path.join(userDataDir, 'Default', 'Cookies-journal'),
        path.join(userDataDir, 'Default', 'Network', 'Cookies'),
        path.join(userDataDir, 'Default', 'Network', 'Cookies-journal'),
    ];
    for (const p of cookiePaths) {
        try { await fs.remove(p); } catch (e) { }
    }
}

async function importCookiesToUserDataDir(userDataDir, cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) throw new Error('No valid cookies to import');
    await clearCookieStoresInUserDataDir(userDataDir);
    await withCookieBrowser(userDataDir, async (browser) => {
        const normalized = cookies
            .map(cookie => normalizeCookieForImport(cookie))
            .filter(Boolean);
        if (normalized.length === 0) throw new Error('No valid cookies to import');
        await browser.setCookie(...normalized);
    });
}

function normalizeProfileStorageBundleItems(items) {
    const allowed = new Map(PROFILE_STORAGE_DIRS.map((item) => [normalizeBackupRelativePath(item.relativePath), item.key]));
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
        const relativePath = normalizeBackupRelativePath(item && item.path ? item.path : item && item.relativePath);
        if (!allowed.has(relativePath)) throw new Error(`Unsupported storage path: ${relativePath}`);
        if (out.some((current) => current.path === relativePath)) continue;
        out.push({ key: allowed.get(relativePath), path: relativePath });
    }
    return out;
}

function createProfileStorageBundleMetadata(items) {
    return {
        version: PROFILE_STORAGE_BUNDLE_VERSION,
        exportedAt: Date.now(),
        items: normalizeProfileStorageBundleItems(items),
    };
}

async function buildProfileStorageBundle(profileId) {
    const tempRoot = await getBackupTempRoot('geekez-storage-');
    const payloadRoot = path.join(tempRoot, 'payload');
    const storageRoot = path.join(payloadRoot, 'storage');
    await fs.ensureDir(storageRoot);

    const userDataDir = getProfileUserDataDir(profileId);
    const items = [];
    for (const def of PROFILE_STORAGE_DIRS) {
        const relativePath = normalizeBackupRelativePath(def.relativePath);
        const srcPath = path.join(userDataDir, relativePath);
        if (!fs.existsSync(srcPath)) continue;
        const destPath = path.join(storageRoot, relativePath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(srcPath, destPath, { dereference: false, preserveTimestamps: false });
        items.push({ key: def.key, path: relativePath });
    }

    const metadata = createProfileStorageBundleMetadata(items);
    await fs.writeJson(path.join(payloadRoot, PROFILE_STORAGE_METADATA_FILE), metadata);
    const zipPath = path.join(tempRoot, 'storage.geekezstorage');
    const zip = new AdmZip();
    zip.addLocalFolder(payloadRoot, '');
    zip.writeZip(zipPath);
    return { tempRoot, zipPath, metadata };
}

async function loadProfileStorageBundle(buffer) {
    const tempRoot = await getBackupTempRoot('geekez-storage-load-');
    const payloadRoot = path.join(tempRoot, 'payload');
    await fs.ensureDir(payloadRoot);
    try {
        const zip = new AdmZip(buffer);
        zip.extractAllTo(payloadRoot, true);
        const metadataPath = path.join(payloadRoot, PROFILE_STORAGE_METADATA_FILE);
        if (!fs.existsSync(metadataPath)) throw new Error('Invalid storage bundle: metadata missing');
        const metadata = await fs.readJson(metadataPath);
        if (Number(metadata && metadata.version) !== PROFILE_STORAGE_BUNDLE_VERSION) {
            throw new Error(`Unsupported storage bundle version: ${metadata && metadata.version}`);
        }
        return {
            tempRoot,
            payloadRoot,
            metadata: {
                ...metadata,
                items: normalizeProfileStorageBundleItems(metadata && metadata.items),
            },
        };
    } catch (e) {
        try { await fs.remove(tempRoot); } catch (inner) { }
        throw e;
    }
}

async function importProfileStorageBundleToUserDataDir(userDataDir, bundle) {
    const rollbackRoot = await getBackupTempRoot('geekez-storage-rollback-');
    const relativePaths = PROFILE_STORAGE_DIRS.map((item) => normalizeBackupRelativePath(item.relativePath));
    const incoming = new Map((bundle && bundle.metadata && Array.isArray(bundle.metadata.items) ? bundle.metadata.items : [])
        .map((item) => [normalizeBackupRelativePath(item.path), item]));
    const backups = [];

    try {
        await fs.ensureDir(userDataDir);

        for (const relativePath of relativePaths) {
            const destPath = path.join(userDataDir, relativePath);
            const backupPath = path.join(rollbackRoot, relativePath);
            const hadExisting = fs.existsSync(destPath);
            if (hadExisting) {
                await fs.ensureDir(path.dirname(backupPath));
                await fs.move(destPath, backupPath, { overwrite: true });
            }
            backups.push({ relativePath, destPath, backupPath, hadExisting });
        }

        for (const relativePath of relativePaths) {
            if (!incoming.has(relativePath)) continue;
            const srcPath = path.join(bundle.payloadRoot, 'storage', relativePath);
            if (!fs.existsSync(srcPath)) throw new Error(`Storage bundle item missing: ${relativePath}`);
            const destPath = path.join(userDataDir, relativePath);
            await fs.ensureDir(path.dirname(destPath));
            await fs.copy(srcPath, destPath, { dereference: false, preserveTimestamps: false, overwrite: true });
        }
    } catch (e) {
        for (const backup of backups.reverse()) {
            try { await fs.remove(backup.destPath); } catch (inner) { }
            if (!backup.hadExisting || !fs.existsSync(backup.backupPath)) continue;
            try {
                await fs.ensureDir(path.dirname(backup.destPath));
                await fs.move(backup.backupPath, backup.destPath, { overwrite: true });
            } catch (inner) { }
        }
        throw e;
    } finally {
        try { await fs.remove(rollbackRoot); } catch (e) { }
    }
}

function createFullBackupMetadata(selectedProfiles, settings) {
    return {
        version: FULL_BACKUP_DATA_VERSION,
        createdAt: Date.now(),
        profiles: selectedProfiles.map(p => ({
            ...p,
            fingerprint: cleanFingerprint(p.fingerprint)
        })),
        preProxies: settings.preProxies || [],
        subscriptions: settings.subscriptions || [],
        savedProfileProxies: settings.savedProfileProxies || [],
        savedProfileProxySources: settings.savedProfileProxySources || [],
        savedProfileProxySourceBatchHistory: settings.savedProfileProxySourceBatchHistory || [],
        cookies: {}
    };
}

async function buildFullBackupBundle(selectedProfiles, settings) {
    const tempRoot = await getBackupTempRoot('geekez-backup-');
    const payloadRoot = path.join(tempRoot, 'payload');
    const browserDataRoot = path.join(payloadRoot, 'browser_data');
    const metadata = createFullBackupMetadata(selectedProfiles, settings);

    try {
        await fs.ensureDir(browserDataRoot);
        for (const profile of selectedProfiles) {
            const srcUserDataDir = getProfileUserDataDir(profile.id);
            const snapshotUserDataDir = path.join(browserDataRoot, profile.id);
            const copied = await copyUserDataDirForBackup(srcUserDataDir, snapshotUserDataDir);
            if (!copied) continue;
            const cookies = await exportCookiesFromUserDataDir(snapshotUserDataDir);
            if (Array.isArray(cookies) && cookies.length > 0) metadata.cookies[profile.id] = cookies;
            await clearCookieStoresInUserDataDir(snapshotUserDataDir);
        }

        await fs.writeJson(path.join(payloadRoot, FULL_BACKUP_METADATA_FILE), metadata);
        const zipPath = path.join(tempRoot, 'backup.zip');
        const zip = new AdmZip();
        zip.addLocalFolder(payloadRoot, '');
        zip.writeZip(zipPath);
        return { tempRoot, zipPath, metadata };
    } catch (err) {
        logger.error('Full backup creation failed', { error: err.message, stack: err.stack });
        try { await fs.remove(tempRoot); } catch (e) { }
        throw err;
    }
}

async function loadFullBackupBundle(buffer, options = {}) {
    const stageRoot = options.stageRoot || await getImportStageRoot('.geekez-import-');
    const payloadRoot = path.join(stageRoot, 'payload');
    try {
        await fs.ensureDir(payloadRoot);
        const zip = new AdmZip(buffer);
        zip.extractAllTo(payloadRoot, true);
        const metadataPath = path.join(payloadRoot, FULL_BACKUP_METADATA_FILE);
        if (!fs.existsSync(metadataPath)) throw new Error('Invalid backup: metadata missing');
        const metadata = await fs.readJson(metadataPath);
        const version = Number.parseInt(metadata && metadata.version, 10);
        if (!isSupportedFullBackupVersion(version)) throw new Error(`Unsupported backup version: ${version}`);
        if (!Array.isArray(metadata.profiles)) throw new Error('Invalid backup: profiles missing');
        return { stageRoot, payloadRoot, metadata };
    } catch (err) {
        try { await fs.remove(stageRoot); } catch (e) { }
        throw err;
    }
}

async function replaceProfileUserDataDirs(payloadRoot, profiles) {
    const operations = [];
    const browserDataRoot = path.join(payloadRoot, 'browser_data');
    const rollbackRoot = path.join(payloadRoot, '_rollback');

    for (const profile of profiles) {
        const incomingDir = path.join(browserDataRoot, profile.id);
        const destProfileDir = path.join(DATA_PATH, profile.id);
        const destUserDataDir = getProfileUserDataDir(profile.id);
        const backupDir = path.join(rollbackRoot, profile.id, 'browser_data');
        const hasIncoming = fs.existsSync(incomingDir);
        const hadExisting = fs.existsSync(destUserDataDir);
        if (!hasIncoming && !hadExisting) continue;
        await fs.ensureDir(destProfileDir);
        const op = { profileId: profile.id, destUserDataDir, backupDir, hadExisting, hasIncoming };
        operations.push(op);
        if (hadExisting) {
            await fs.ensureDir(path.dirname(backupDir));
            await fs.move(destUserDataDir, backupDir, { overwrite: true });
        }
        if (hasIncoming) {
            await fs.move(incomingDir, destUserDataDir, { overwrite: true });
        }
    }

    return operations;
}

async function rollbackUserDataReplacements(operations) {
    for (const op of [...operations].reverse()) {
        try {
            if (fs.existsSync(op.destUserDataDir)) await fs.remove(op.destUserDataDir);
        } catch (e) { }
        if (op.hadExisting) {
            try {
                if (fs.existsSync(op.backupDir)) {
                    await fs.ensureDir(path.dirname(op.destUserDataDir));
                    await fs.move(op.backupDir, op.destUserDataDir, { overwrite: true });
                }
            } catch (e) { }
        }
    }
}

async function finalizeUserDataReplacements(operations) {
    for (const op of operations) {
        try {
            const rollbackProfileDir = path.dirname(op.backupDir);
            if (fs.existsSync(rollbackProfileDir)) await fs.remove(rollbackProfileDir);
        } catch (e) { }
    }
}

async function importCookiesForProfiles(profiles, cookiesMap) {
    for (const profile of profiles) {
        const cookies = cookiesMap && cookiesMap[profile.id];
        if (!Array.isArray(cookies) || cookies.length === 0) continue;
        await importCookiesToUserDataDir(getProfileUserDataDir(profile.id), cookies);
    }
}

function buildImportedProfiles(currentProfiles, importedProfiles) {
    const nextProfiles = Array.isArray(currentProfiles) ? [...currentProfiles] : [];
    for (const profile of importedProfiles) {
        const idx = nextProfiles.findIndex(cp => cp.id === profile.id);
        const normalizedProfile = {
            ...profile,
            savedProxyId: normalizeSavedProfileProxyId(profile && profile.savedProxyId),
            fingerprint: normalizeFingerprintForStorage(
                profile.fingerprint || createManagedFingerprint({}),
                { fitMissingWindowToWorkArea: true }
            )
        };
        if (idx > -1) nextProfiles[idx] = normalizedProfile;
        else nextProfiles.push(normalizedProfile);
    }
    return nextProfiles;
}

function buildImportedSettings(currentSettings, metadata) {
    const nextSettings = isPlainObject(currentSettings) ? { ...currentSettings } : {};
    if (!Array.isArray(nextSettings.preProxies)) nextSettings.preProxies = [];
    if (!Array.isArray(nextSettings.subscriptions)) nextSettings.subscriptions = [];
    if (!Array.isArray(nextSettings.savedProfileProxies)) nextSettings.savedProfileProxies = [];
    if (!Array.isArray(nextSettings.savedProfileProxySources)) nextSettings.savedProfileProxySources = [];
    if (!Array.isArray(nextSettings.savedProfileProxySourceBatchHistory)) nextSettings.savedProfileProxySourceBatchHistory = [];
    for (const p of metadata.preProxies || []) {
        if (!nextSettings.preProxies.find(cp => cp.id === p.id)) nextSettings.preProxies.push(p);
    }
    for (const s of metadata.subscriptions || []) {
        if (!nextSettings.subscriptions.find(cs => cs.id === s.id)) nextSettings.subscriptions.push(s);
    }
    for (const proxy of metadata.savedProfileProxies || []) {
        const normalizedProxy = normalizeSavedProfileProxy(proxy, nextSettings.savedProfileProxies.length);
        if (!normalizedProxy.proxyStr) continue;
        if (!nextSettings.savedProfileProxies.find(item => item.id === normalizedProxy.id)) nextSettings.savedProfileProxies.push(normalizedProxy);
    }
    for (const source of metadata.savedProfileProxySources || []) {
        const normalizedSource = normalizeSavedProfileProxySource(source, nextSettings.savedProfileProxySources.length);
        if (!normalizedSource.url) continue;
        if (!nextSettings.savedProfileProxySources.find(item => item.id === normalizedSource.id)) nextSettings.savedProfileProxySources.push(normalizedSource);
    }
    nextSettings.savedProfileProxySourceBatchHistory = normalizeSavedProfileProxySourceBatchHistory([
        ...(metadata.savedProfileProxySourceBatchHistory || []),
        ...(nextSettings.savedProfileProxySourceBatchHistory || []),
    ]);
    return nextSettings;
}

function remapImportedCookies(cookiesMap, idMap) {
    const out = {};
    for (const [oldId, cookies] of Object.entries(cookiesMap || {})) {
        const newId = idMap.get(oldId);
        if (!newId) continue;
        out[newId] = cookies;
    }
    return out;
}

async function remapPayloadProfileIds(payloadRoot, idMap) {
    const browserDataRoot = path.join(payloadRoot, 'browser_data');
    if (!fs.existsSync(browserDataRoot)) return;
    for (const [oldId, newId] of idMap.entries()) {
        if (!oldId || !newId || oldId === newId) continue;
        const oldDir = path.join(browserDataRoot, oldId);
        const newDir = path.join(browserDataRoot, newId);
        if (!fs.existsSync(oldDir)) continue;
        await fs.ensureDir(path.dirname(newDir));
        await fs.move(oldDir, newDir, { overwrite: true });
    }
}

async function restoreFileContents(targetPath, previousContent) {
    if (previousContent === null) {
        await fs.remove(targetPath);
        return;
    }
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, previousContent);
}

async function applyImportedBundle(payloadRoot, metadata) {
    const currentProfilesRaw = fs.existsSync(PROFILES_FILE) ? await fs.readFile(PROFILES_FILE) : null;
    const currentSettingsRaw = fs.existsSync(SETTINGS_FILE) ? await fs.readFile(SETTINGS_FILE) : null;
    const currentProfiles = currentProfilesRaw ? JSON.parse(currentProfilesRaw.toString('utf8')) : [];
    const currentSettings = currentSettingsRaw ? JSON.parse(currentSettingsRaw.toString('utf8')) : { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [] };
    const nextProfiles = buildImportedProfiles(currentProfiles, metadata.profiles);
    const nextSettings = buildImportedSettings(currentSettings, metadata);
    const operations = [];

    try {
        operations.push(...await replaceProfileUserDataDirs(payloadRoot, metadata.profiles));
        await importCookiesForProfiles(metadata.profiles, metadata.cookies || {});
        await fs.writeJson(PROFILES_FILE, nextProfiles);
        await fs.writeJson(SETTINGS_FILE, nextSettings);
        await finalizeUserDataReplacements(operations);
        return metadata.profiles.length;
    } catch (err) {
        await rollbackUserDataReplacements(operations);
        try { await restoreFileContents(PROFILES_FILE, currentProfilesRaw); } catch (e) { }
        try { await restoreFileContents(SETTINGS_FILE, currentSettingsRaw); } catch (e) { }
        throw err;
    }
}

// 获取用于选择器的环境列表
ipcMain.handle('get-export-profiles', async () => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags || [] }));
});

// 导出选定环境 (精简版，不含浏览器数据)
ipcMain.handle('export-selected-data', async (e, { type, profileIds }) => {
    const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [] };

    // 过滤选中的环境
    const selectedProfiles = allProfiles
        .filter(p => profileIds.includes(p.id))
        .map(p => ({
            ...p,
            fingerprint: cleanFingerprint(p.fingerprint)
        }));

    let exportObj = {};

    if (type === 'all' || type === 'profiles') {
        exportObj.profiles = selectedProfiles;
    }
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
        exportObj.savedProfileProxies = settings.savedProfileProxies || [];
        exportObj.savedProfileProxySources = settings.savedProfileProxySources || [];
        exportObj.savedProfileProxySourceBatchHistory = settings.savedProfileProxySourceBatchHistory || [];
    }

    if (Object.keys(exportObj).length === 0) return { success: false, error: 'No data to export' };

    const typeNames = { all: 'profiles', profiles: 'profiles', proxies: 'proxies' };
    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `GeekEZ_Backup_${typeNames[type] || type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return { success: true, count: selectedProfiles.length };
    }
    return { success: false, cancelled: true };
});

// 完整备份 (含浏览器数据，加密)
ipcMain.handle('export-full-backup', async (e, { profileIds, password }) => {
    try {
        const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [] };
        const selectedProfiles = allProfiles.filter(p => profileIds.includes(p.id));
        ensureProfilesStopped(selectedProfiles.map(p => p.id), allProfiles, '完整备份');
        const bundle = await buildFullBackupBundle(selectedProfiles, settings);
        try {
            const zipBuffer = await fs.readFile(bundle.zipPath);
            const encrypted = encryptData(zipBuffer, password);

            const { filePath } = await dialog.showSaveDialog({
                title: 'Export Full Backup',
                defaultPath: `GeekEZ_FullBackup_${Date.now()}.geekez`,
                filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
            });

            if (filePath) {
                await fs.writeFile(filePath, encrypted);
                return { success: true, count: selectedProfiles.length };
            }
            return { success: false, cancelled: true };
        } finally {
            try { await fs.remove(bundle.tempRoot); } catch (e) { }
        }
    } catch (err) {
        console.error('Full backup failed:', err);
        return { success: false, error: err.message };
    }
});

// 导入完整备份
ipcMain.handle('import-full-backup', async (e, { password }) => {
    try {
        const { filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
        });

        if (!filePaths || filePaths.length === 0) {
            return { success: false, cancelled: true };
        }

        const encrypted = await fs.readFile(filePaths[0]);
        const zipBuffer = decryptData(encrypted, password);
        const bundle = await loadFullBackupBundle(zipBuffer);
        try {
            ensureProfilesStopped(bundle.metadata.profiles.map(p => p.id), bundle.metadata.profiles, '导入完整备份');
            const importedCount = await applyImportedBundle(bundle.payloadRoot, bundle.metadata);
            return { success: true, count: importedCount };
        } finally {
            try { await fs.remove(bundle.stageRoot); } catch (e) { }
        }
    } catch (err) {
        console.error('Import full backup failed:', err);
        if (err.message.includes('Unsupported state') || err.message.includes('bad decrypt')) {
            return { success: false, error: '密码错误或文件已损坏' };
        }
        return { success: false, error: err.message };
    }
});

// 导入普通备份 (YAML)
ipcMain.handle('import-data', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePaths && filePaths.length > 0) {
        try {
            const content = await fs.readFile(filePaths[0], 'utf8');
            const data = yaml.load(content);
            let updated = false;

            if (data.profiles || data.preProxies || data.subscriptions || data.savedProfileProxies || data.savedProfileProxySources || data.savedProfileProxySourceBatchHistory) {
                if (Array.isArray(data.profiles)) {
                    const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    data.profiles.forEach(p => {
                        const idx = currentProfiles.findIndex(cp => cp.id === p.id);
                            p.fingerprint = normalizeFingerprintForStorage(
                                p.fingerprint || createManagedFingerprint({}),
                                { fitMissingWindowToWorkArea: true }
                            );
                        if (idx > -1) currentProfiles[idx] = p;
                        else {
                            if (!p.id) p.id = uuidv4();
                            currentProfiles.push(p);
                        }
                    });
                    await fs.writeJson(PROFILES_FILE, currentProfiles);
                    updated = true;
                }
                if (Array.isArray(data.preProxies) || Array.isArray(data.subscriptions) || Array.isArray(data.savedProfileProxies) || Array.isArray(data.savedProfileProxySources) || Array.isArray(data.savedProfileProxySourceBatchHistory)) {
                    const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [] };
                    if (data.preProxies) {
                        if (!currentSettings.preProxies) currentSettings.preProxies = [];
                        data.preProxies.forEach(p => {
                            if (!currentSettings.preProxies.find(cp => cp.id === p.id)) currentSettings.preProxies.push(p);
                        });
                    }
                    if (data.subscriptions) {
                        if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
                        data.subscriptions.forEach(s => {
                            if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) currentSettings.subscriptions.push(s);
                        });
                    }
                    if (data.savedProfileProxies) {
                        if (!currentSettings.savedProfileProxies) currentSettings.savedProfileProxies = [];
                        data.savedProfileProxies.forEach((proxy, index) => {
                            const normalizedProxy = normalizeSavedProfileProxy(proxy, index);
                            if (!normalizedProxy.proxyStr) return;
                            if (!currentSettings.savedProfileProxies.find(item => item.id === normalizedProxy.id)) currentSettings.savedProfileProxies.push(normalizedProxy);
                        });
                    }
                    if (data.savedProfileProxySources) {
                        if (!currentSettings.savedProfileProxySources) currentSettings.savedProfileProxySources = [];
                        data.savedProfileProxySources.forEach((source, index) => {
                            const normalizedSource = normalizeSavedProfileProxySource(source, index);
                            if (!normalizedSource.url) return;
                            if (!currentSettings.savedProfileProxySources.find(item => item.id === normalizedSource.id)) currentSettings.savedProfileProxySources.push(normalizedSource);
                        });
                    }
                    if (data.savedProfileProxySourceBatchHistory) {
                        currentSettings.savedProfileProxySourceBatchHistory = normalizeSavedProfileProxySourceBatchHistory([
                            ...(data.savedProfileProxySourceBatchHistory || []),
                            ...((currentSettings && currentSettings.savedProfileProxySourceBatchHistory) || []),
                        ]);
                    }
                    await fs.writeJson(SETTINGS_FILE, currentSettings);
                    updated = true;
                }
            } else if (data.name && data.proxyStr && data.fingerprint) {
                // 单个环境导入
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const newProfile = { ...data, id: uuidv4(), isSetup: false, createdAt: Date.now() };
                newProfile.savedProxyId = normalizeSavedProfileProxyId(newProfile.savedProxyId);
                newProfile.fingerprint = normalizeFingerprintForStorage(
                    newProfile.fingerprint || createManagedFingerprint({}),
                    { fitMissingWindowToWorkArea: true }
                );
                profiles.push(newProfile);
                await fs.writeJson(PROFILES_FILE, profiles);
                updated = true;
            }
            return updated;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }
    return false;
});

// 保留旧的 export-data 用于向后兼容 (deprecated)
ipcMain.handle('export-data', async (e, type) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [], savedProfileProxies: [], savedProfileProxySources: [] };

    // 清理 fingerprint
    const cleanedProfiles = profiles.map(p => ({
        ...p,
        fingerprint: cleanFingerprint(p.fingerprint)
    }));

    let exportObj = {};
    if (type === 'all' || type === 'profiles') exportObj.profiles = cleanedProfiles;
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
        exportObj.savedProfileProxies = settings.savedProfileProxies || [];
        exportObj.savedProfileProxySources = settings.savedProfileProxySources || [];
        exportObj.savedProfileProxySourceBatchHistory = settings.savedProfileProxySourceBatchHistory || [];
    }
    if (Object.keys(exportObj).length === 0) return false;

    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `GeekEZ_Backup_${type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });
    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return true;
    }
    return false;
});

// --- 核心启动逻辑 ---
async function launchProfileInternal(profileId, watermarkStyle, sender, options = {}) {
    const forceRemoteDebugging = !!options.forceRemoteDebugging;
    const isApiLaunch = !sender;
    const settings = await readSettingsAsync();
    const requestedUiLanguage = normalizeOptionalUiLanguage(options.appLang) || settings.uiLanguage || currentUiLanguage;
    const isQuietLaunch = isApiLaunch && settings.apiQuietLaunch;

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        if (proc.browser && proc.browser.isConnected()) {
            try {
                const targets = await proc.browser.targets();
                const pageTarget = targets.find(t => t.type() === 'page');
                if (pageTarget) {
                    const page = await pageTarget.page();
                    if (page) {
                        if (!isQuietLaunch) {
                            const session = await pageTarget.createCDPSession();
                            const { windowId } = await session.send('Browser.getWindowForTarget');
                            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
                            setTimeout(async () => {
                                try { await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch (e) { }
                            }, 100);
                            await page.bringToFront();
                        }
                    }
                }
                const ws = proc.browser && proc.browser.wsEndpoint ? proc.browser.wsEndpoint() : null;
                let name = '';
                let remark = '';
                let debugPort = null;
                try {
                    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    const p = profiles.find(pp => pp.id === profileId);
                    if (p) { name = p.name || ''; remark = p.remark || ''; debugPort = p.debugPort || null; }
                } catch (e) { }
                const httpEndpoint = debugPort ? `http://${LOCAL_API_HOST}:${debugPort}` : null;
                return { id: profileId, name, remark, ws, http: httpEndpoint, debugPort: debugPort || undefined, message: "环境已唤醒" };
            } catch (e) {
                proc.manualClosing = true;
                await forceKill(proc.xrayPid);
                await forceKill(proc.sshPid);
                if (proc.logFd !== undefined) { try { fs.closeSync(proc.logFd); } catch (e2) { } }
                if (proc.sshLogFd !== undefined) { try { fs.closeSync(proc.sshLogFd); } catch (e2) { } }
                delete activeProcesses[profileId];
            }
        } else {
            proc.manualClosing = true;
            await forceKill(proc.xrayPid);
            await forceKill(proc.sshPid);
            if (proc.logFd !== undefined) { try { fs.closeSync(proc.logFd); } catch (e) { } }
            if (proc.sshLogFd !== undefined) { try { fs.closeSync(proc.sshLogFd); } catch (e) { } }
            delete activeProcesses[profileId];
        }
        if (activeProcesses[profileId]) {
            const proc = activeProcesses[profileId];
            const ws = proc.browser && proc.browser.wsEndpoint ? proc.browser.wsEndpoint() : null;
            let name = '';
            let remark = '';
            let debugPort = null;
            try {
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const p = profiles.find(pp => pp.id === profileId);
                if (p) { name = p.name || ''; remark = p.remark || ''; debugPort = p.debugPort || null; }
            } catch (e) { }
            const httpEndpoint = debugPort ? `http://${LOCAL_API_HOST}:${debugPort}` : null;
            return { id: profileId, name, remark, ws, http: httpEndpoint, debugPort: debugPort || undefined, message: "环境已唤醒" };
        }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // settings already loaded above

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    const bundledChromeVersion = getBundledChromeVersion();
    let fingerprintChanged = false;
    if (!profile.fingerprint) {
        profile.fingerprint = createManagedFingerprint({ chromeVersion: bundledChromeVersion });
        fingerprintChanged = true;
    } else {
        const normalizedFingerprint = normalizeFingerprintForStorage(profile.fingerprint, { fitMissingWindowToWorkArea: true });
        if (JSON.stringify(normalizedFingerprint.screen) !== JSON.stringify(profile.fingerprint.screen)
            || JSON.stringify(normalizedFingerprint.window) !== JSON.stringify(profile.fingerprint.window)) {
            profile.fingerprint = { ...profile.fingerprint, screen: normalizedFingerprint.screen, window: normalizedFingerprint.window };
            fingerprintChanged = true;
        }
    }
    if (!profile.fingerprint.languages) profile.fingerprint.languages = ['en-US', 'en'];
    if (ensureFingerprintProtectionDefaults(profile.fingerprint)) fingerprintChanged = true;
    if (bundledChromeVersion && ensureFingerprintChromeVersion(profile.fingerprint, bundledChromeVersion)) {
        fingerprintChanged = true;
    }
    if (fingerprintChanged) {
        try { await fs.writeJson(PROFILES_FILE, profiles); } catch (e) { }
    }

    // Pre-proxy settings (settings already loaded above)
    const override = profile.preProxyOverride || 'default';
    const shouldUsePreProxy = override === 'on' || (override === 'default' && settings.enablePreProxy);
    let finalPreProxyConfig = null;
    let switchMsg = null;
	    if (shouldUsePreProxy) {
	        const selection = await resolveLaunchPreProxySelection(settings);
	        finalPreProxyConfig = selection.preProxyConfig;
	        switchMsg = selection.switchMsg;
	    }

	    let sshInfo = null;
	    let xrayProcess = null;
	    let logFd = undefined;

	    try {
	        const localPort = await getPort();
	        const profileDir = path.join(DATA_PATH, profileId);
	        const userDataDir = path.join(profileDir, 'browser_data');
        const xrayConfigPath = path.join(profileDir, 'config.json');
        const xrayLogPath = path.join(profileDir, 'xray_run.log');
        fs.ensureDirSync(userDataDir);

        try {
            const defaultProfileDir = path.join(userDataDir, 'Default');
            fs.ensureDirSync(defaultProfileDir);
            const preferencesPath = path.join(defaultProfileDir, 'Preferences');
            let preferences = {};
            if (fs.existsSync(preferencesPath)) preferences = await fs.readJson(preferencesPath);
            if (!preferences.bookmark_bar) preferences.bookmark_bar = {};
            preferences.bookmark_bar.show_on_all_tabs = true;
            if (preferences.protection) delete preferences.protection;
            if (!preferences.profile) preferences.profile = {};
            preferences.profile.name = profile.name;
            if (!preferences.webrtc) preferences.webrtc = {};
            preferences.webrtc.ip_handling_policy = 'disable_non_proxied_udp';
            await fs.writeJson(preferencesPath, preferences);
        } catch (e) { }

        const proxyBinding = resolveProfileProxyBinding(profile, settings, null);
        let mainProxyStr = String(proxyBinding && proxyBinding.proxyStr || '').trim();
        if (proxyBinding && proxyBinding.bindingBroken && !mainProxyStr) {
            throw new Error(`Saved proxy binding is broken: ${proxyBinding.savedProxyId || 'unknown saved proxy'}`);
        }
        if (mainProxyStr.startsWith('ssh://')) {
            sshInfo = await startSshDynamicProxy(mainProxyStr, profileDir);
            mainProxyStr = `socks5://127.0.0.1:${sshInfo.localPort}`;
        }

        const config = generateXrayConfig(mainProxyStr, localPort, finalPreProxyConfig);
        fs.writeJsonSync(xrayConfigPath, config);
        logFd = fs.openSync(xrayLogPath, 'a');
        const xrayBinPath = fs.existsSync(BIN_PATH) ? ensureExecutable(BIN_PATH) : (fs.existsSync(BIN_PATH_LEGACY) ? ensureExecutable(BIN_PATH_LEGACY) : '');
        if (!xrayBinPath) throw new Error('Xray binary not found.');
        let xraySpawnError = '';
        xrayProcess = spawn(xrayBinPath, ['run', '-c', xrayConfigPath], { cwd: path.dirname(xrayBinPath), env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: ['ignore', logFd, logFd], windowsHide: true });
        xrayProcess.once('error', (err) => {
            xraySpawnError = err && err.message ? err.message : String(err);
        });
        const xrayReady = await waitForTcpPort('127.0.0.1', localPort, 4000, () => !!xraySpawnError || xrayProcess.exitCode !== null);
        if (!xrayReady) throw new Error(xraySpawnError || 'Local proxy failed to start.');

        const workArea = getPreferredWorkAreaBounds();
        const runtimeContext = await resolveRuntimeContext(profile, localPort);
        const activeHeaderPreset = resolveActiveHeaderPreset(profile, null, settings);
        const permissionStates = resolveRuntimePermissionStates(profile, runtimeContext);
        const geoPermissionState = permissionStates.geolocation;
        runtimeContext.activeHeaderPresetId = activeHeaderPreset ? activeHeaderPreset.id : '';
        const launchFingerprint = normalizeFingerprintForStorage(profile.fingerprint, {
            workArea,
            defaultWindow: DEFAULT_BROWSER_WINDOW,
            fitMissingWindowToWorkArea: true,
            fitWindowToWorkArea: true
        });
        const launchWindow = isLegacyMirroredWindow(profile.fingerprint)
            ? fitWindowSizeToWorkArea(DEFAULT_BROWSER_WINDOW, workArea)
            : (launchFingerprint.window || fitWindowSizeToWorkArea(DEFAULT_BROWSER_WINDOW, workArea));
        const targetLang = String(runtimeContext.language || launchFingerprint.language || 'en-US').trim() || 'en-US';
        const targetLanguages = Array.isArray(runtimeContext.languages) && runtimeContext.languages.length > 0
            ? runtimeContext.languages
            : buildResolvedLanguages(targetLang);
        const targetAcceptLanguage = String(runtimeContext.acceptLanguage || buildAcceptLanguage(targetLang, targetLanguages)).trim();
        const targetTimezone = String(runtimeContext.timezone || '').trim();
        const targetGeolocation = geoPermissionState === 'granted'
            ? (runtimeContext.geolocation || normalizeResolvedGeolocation(launchFingerprint.geolocation))
            : null;
        const targetCity = String(runtimeContext.city || launchFingerprint.city || '').trim();

        launchFingerprint.timezone = targetTimezone || '';
        launchFingerprint.language = targetLang;
        launchFingerprint.languages = targetLanguages;
        launchFingerprint.acceptLanguage = targetAcceptLanguage;
        launchFingerprint.geoPermissionState = geoPermissionState;
        launchFingerprint.cameraPermissionState = permissionStates.camera;
        launchFingerprint.microphonePermissionState = permissionStates.microphone;
        launchFingerprint.notificationPermissionState = permissionStates.notifications;
        if (targetGeolocation) launchFingerprint.geolocation = targetGeolocation;
        else delete launchFingerprint.geolocation;
        if (targetCity) launchFingerprint.city = targetCity;

        // 1. 生成 GeekEZ Guard 扩展（使用传递的水印样式）
        const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
        const extPath = await generateExtension(profileDir, launchFingerprint, profile.name, style);

        // 2. 获取用户自定义扩展
        const userExts = resolveLaunchExtensionPaths(profile, settings);

        // 3. 合并所有扩展路径
        let extPaths = extPath; // GeekEZ Guard
        if (userExts.length > 0) {
            extPaths += ',' + userExts.join(',');
        }

        // 4. 构建启动参数（性能优化）
        // P1: 使用指纹中的 User-Agent
        const userAgent = launchFingerprint?.userAgent
            || (bundledChromeVersion ? buildDefaultUserAgent(bundledChromeVersion) : null)
            || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        const launchArgs = [
	            `--proxy-server=socks5://127.0.0.1:${localPort}`,
	            '--proxy-bypass-list=127.0.0.1;localhost;[::1]',
	            '--disable-quic',
	            `--user-data-dir=${userDataDir}`,
	            `--window-size=${launchWindow.width},${launchWindow.height}`,
            '--restore-last-session',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process,ExtensionsMenuAccessControl',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            `--lang=${targetLang}`,
            `--user-agent=${userAgent}`,  // P1: 自定义 User-Agent
            `--disable-extensions-except=${extPaths}`,
            `--load-extension=${extPaths}`,
            // 性能优化参数
            '--no-first-run',                    // 跳过首次运行向导
            '--no-default-browser-check',        // 跳过默认浏览器检查
            '--disable-session-crashed-bubble',  // 隐藏恢复会话提示
            '--disable-dev-shm-usage',           // 减少共享内存使用
            '--disk-cache-size=52428800',        // 限制磁盘缓存为 50MB
            '--media-cache-size=52428800'        // 限制媒体缓存为 50MB
        ];
        const backgroundMode = String(settings.backgroundMode || 'chromium').trim();
        if (backgroundMode === 'keep-active') {
            launchArgs.push(
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            );
        }
        if (isQuietLaunch && process.platform === 'win32') launchArgs.push('--start-minimized');

        // 5. Remote Debugging Port (if enabled)
        const remoteDebuggingEnabled = forceRemoteDebugging || settings.enableRemoteDebugging;
        if (remoteDebuggingEnabled) {
            if (!profile.debugPort) {
                profile.debugPort = await getPort();
                if (profile.debugPort === localPort) profile.debugPort = await getPort();
                try { await fs.writeJson(PROFILES_FILE, profiles); } catch (e) { }
            }
            launchArgs.push(`--remote-debugging-port=${profile.debugPort}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('⚠️  REMOTE DEBUGGING ENABLED');
            console.log(`📡 Port: ${profile.debugPort}`);
            console.log(`🔗 Connect: chrome://inspect or ws://localhost:${profile.debugPort}`);
            console.log('⚠️  WARNING: May increase automation detection risk!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // 6. Custom Launch Arguments (if enabled)
        if (settings.enableCustomArgs && profile.customArgs) {
            const customArgsList = profile.customArgs
                .split(/[\n\s]+/)
                .map(arg => arg.trim())
                .filter(arg => arg && arg.startsWith('--'));

            if (customArgsList.length > 0) {
                launchArgs.push(...customArgsList);
                console.log('⚡ Custom Args:', customArgsList.join(' '));
            }
        }

        // 5. 启动浏览器
        const chromePath = getChromiumPath();
        if (!chromePath) {
            await forceKill(xrayProcess.pid);
            throw new Error("Chrome binary not found.");
        }

        // 时区设置
        const env = { ...process.env };
        if (targetTimezone) {
            env.TZ = launchFingerprint.timezone;
        }

        const browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            userDataDir: userDataDir,
            args: launchArgs,
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
            pipe: false,
            dumpio: false,
            env: env  // 注入环境变量
        });

        await applyTimezoneOverrideToBrowser(browser, launchFingerprint.timezone);
        await applyBrowserWindowBounds(browser, workArea, launchWindow, { minimize: isQuietLaunch });
        await applyRuntimeContextToBrowser(browser, runtimeContext, launchFingerprint, activeHeaderPreset);

        activeProcesses[profileId] = {
            xrayPid: xrayProcess.pid,
            sshPid: sshInfo ? sshInfo.pid : undefined,
            sshProc: sshInfo ? (sshInfo.child || null) : null,
            browser,
            logFd: logFd,  // 存储日志文件描述符，用于后续关闭
            sshLogFd: sshInfo ? sshInfo.logFd : undefined,
            localPort,
            sshLocalPort: sshInfo ? sshInfo.localPort : undefined,
            remoteDebuggingEnabled,
            originalProxyStr: String(proxyBinding && proxyBinding.proxyStr || '').trim(),
            proxyBinding,
            profileDir,
            sshState: sshInfo ? 'running' : null,
            sshLastError: '',
            manualClosing: false,
            sshRestarting: false,
            runtimeContext,
            launchFingerprint,
            activeHeaderPreset,
        };
        if (sshInfo && sshInfo.child) bindSshLifecycle(profileId, sshInfo.child);
        if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'running' });

        const localApiPrefix = `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}/`;
        await cleanupStartupPages(browser, { preservedPrefixes: [localApiPrefix] });
        const startupUrls = getProfileStartupUrls(profile);
        const openedStartupUrls = await openStartupUrls(browser, startupUrls, runtimeContext, launchFingerprint, activeHeaderPreset);

        let dashboardUrl = '';
        if (!openedStartupUrls && settings.dashboardOnLaunch === true && !isQuietLaunch) {
            try {
                dashboardUrl = buildProfileDashboardUrl(profileId, requestedUiLanguage);
                const pages = await browser.pages();
                const page = pages.find(p => isBlankOrNewTabUrl(p.url())) || await browser.newPage();
                await applyRuntimeContextToPage(page, runtimeContext, launchFingerprint, activeHeaderPreset).catch(() => { });
                await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
                await page.bringToFront();
            } catch (e) { }
        }

        // CDP Geolocation Removed in favor of Stealth JS Hook
        // 由于 CDP 本身会被检测，我们移除所有 Emulation.Overrides
        // 地理位置将由 fingerprint.js 中的 Stealth Hook 接管

        browser.on('disconnected', async () => {
            if (activeProcesses[profileId]) {
                const proc = activeProcesses[profileId];
                const pid = proc.xrayPid;
                const sshPid = proc.sshPid;
                const logFd = proc.logFd;
                const sshLogFd = proc.sshLogFd;
                proc.manualClosing = true;

                // 关闭日志文件描述符
                if (logFd !== undefined) {
                    try {
                        fs.closeSync(logFd);
                    } catch (e) { }
                }
                if (sshLogFd !== undefined) {
                    try {
                        fs.closeSync(sshLogFd);
                    } catch (e) { }
                }

                delete activeProcesses[profileId];
                await forceKill(pid);
                await forceKill(sshPid);

                // 性能优化：清理缓存文件，节省磁盘空间
                try {
                    const cacheDir = path.join(userDataDir, 'Default', 'Cache');
                    const codeCacheDir = path.join(userDataDir, 'Default', 'Code Cache');
                    if (fs.existsSync(cacheDir)) await fs.emptyDir(cacheDir);
                    if (fs.existsSync(codeCacheDir)) await fs.emptyDir(codeCacheDir);
                } catch (e) {
                    // 忽略清理错误
                }

                if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'stopped' });
            }
        });

        const ws = browser && browser.wsEndpoint ? browser.wsEndpoint() : null;
        const httpEndpoint = remoteDebuggingEnabled && profile.debugPort ? `http://${LOCAL_API_HOST}:${profile.debugPort}` : null;
        return {
            id: profileId,
            name: profile.name || '',
            remark: profile.remark || '',
            ws,
            http: httpEndpoint,
            debugPort: remoteDebuggingEnabled ? (profile.debugPort || undefined) : undefined,
            message: switchMsg
        };
	    } catch (err) {
	        if (!activeProcesses[profileId]) {
	            if (xrayProcess && xrayProcess.pid) await forceKill(xrayProcess.pid);
	            if (sshInfo && sshInfo.pid) await forceKill(sshInfo.pid);
	            if (logFd !== undefined) { try { fs.closeSync(logFd); } catch (e) { } }
	            if (sshInfo && sshInfo.logFd !== undefined) { try { fs.closeSync(sshInfo.logFd); } catch (e) { } }
	        }
	        console.error(err);
	        throw err;
	    }
}

ipcMain.handle('launch-profile', async (event, profileId, watermarkStyle, appLang) => {
    const result = await launchProfileInternal(profileId, watermarkStyle, event.sender, { forceRemoteDebugging: false, appLang });
    return result.message;
});

app.on('window-all-closed', () => {
    Object.values(activeProcesses).forEach(p => { forceKill(p.xrayPid); forceKill(p.sshPid); });
    if (process.platform !== 'darwin') app.quit();
});
// Helpers (Same)
function fetchJson(url) { return new Promise((resolve, reject) => { const req = https.get(url, { headers: { 'User-Agent': 'GeekEZ-Browser' } }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }); req.on('error', reject); }); }
function getLocalXrayVersion() { return new Promise((resolve) => { if (!fs.existsSync(BIN_PATH)) return resolve('v0.0.0'); try { const proc = spawn(BIN_PATH, ['version']); let output = ''; proc.stdout.on('data', d => output += d.toString()); proc.on('close', () => { const match = output.match(/Xray\s+v?(\d+\.\d+\.\d+)/i); resolve(match ? (match[1].startsWith('v') ? match[1] : 'v' + match[1]) : 'v0.0.0'); }); proc.on('error', () => resolve('v0.0.0')); } catch (e) { resolve('v0.0.0'); } }); }
function compareVersions(v1, v2) { const p1 = v1.split('.').map(Number); const p2 = v2.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((p1[i] || 0) > (p2[i] || 0)) return 1; if ((p1[i] || 0) < (p2[i] || 0)) return -1; } return 0; }
function downloadFile(url, dest) { return new Promise((resolve, reject) => { const file = fs.createWriteStream(dest); https.get(url, (response) => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { downloadFile(response.headers.location, dest).then(resolve).catch(reject); return; } response.pipe(file); file.on('finish', () => file.close(resolve)); }).on('error', (err) => { fs.unlink(dest, () => { }); reject(err); }); }); }
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
            // Windows: 使用 adm-zip（可靠）
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(destDir, true);
                console.log('[Extract Success] Extracted to:', destDir);
                resolve();
            } catch (err) {
                console.error('[Extract Error]', err);
                reject(err);
            }
        } else {
            // macOS/Linux: 使用原生 unzip 命令
            exec(`unzip -o "${zipPath}" -d "${destDir}"`, (err, stdout, stderr) => {
                if (err) {
                    console.error('[Extract Error]', err);
                    console.error('[Extract stderr]', stderr);
                    reject(err);
                } else {
                    console.log('[Extract Success]', stdout);
                    resolve();
                }
            });
        }
    });
}
