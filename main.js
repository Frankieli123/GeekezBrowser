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
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);


// Hardware acceleration enabled for better UI performance
// Only disable if GPU compatibility issues occur

const { generateXrayConfig } = require('./utils');
const { generateFingerprint, getInjectScript } = require('./fingerprint');

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
let apiServer = null;
let apiServerRunning = false;
let mainWindow = null; // Global reference for API-to-UI communication
const DEFAULT_FINGERPRINT_SCREEN = { width: 1920, height: 1080 };
const DEFAULT_BROWSER_WINDOW = { width: 1280, height: 800 };
const APP_REPO_URL = 'https://github.com/Frankieli123/GeekezBrowser';
const APP_RELEASES_API_URL = 'https://api.github.com/repos/Frankieli123/GeekezBrowser/releases/latest';
const APP_RELEASES_URL = `${APP_REPO_URL}/releases`;

// ============================================================================
// REST API Server
// ============================================================================
function createApiServer(port) {
    const server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        // Parse body for POST/PUT
        let body = '';
        if (method === 'POST' || method === 'PUT') {
            body = await new Promise(resolve => {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => resolve(data));
            });
        }

        try {
            const result = await handleApiRequest(method, pathname, body, url.searchParams);
            res.writeHead(result.status || 200);
            res.end(JSON.stringify(result.data || result));
        } catch (err) {
            console.error('API Error:', err);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    return server;
}

async function handleApiRequest(method, pathname, body, params) {
    let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};

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
        const baseName = data.name || `Profile-${Date.now()}`;
        const uniqueName = generateUniqueName(baseName);
        const newProfile = {
            id,
            name: uniqueName,
            proxyStr: data.proxyStr || '',
            tags: data.tags || [],
            fingerprint,
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
        if (Object.prototype.hasOwnProperty.call(data, 'fingerprint')) {
            data.fingerprint = mergeFingerprint(profile.fingerprint, data.fingerprint, { fitMissingWindowToWorkArea: true });
        }
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

        // Build backup data
        const backupData = {
            version: 1,
            createdAt: Date.now(),
            profiles: profiles.map(p => ({ ...p, fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint })),
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // Collect browser data
        for (const profile of profiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            if (fs.existsSync(profileDataDir)) {
                const defaultDir = path.join(profileDataDir, 'Default');
                if (fs.existsSync(defaultDir)) {
                    const browserFiles = {};
                    const filesToBackup = ['Bookmarks', 'Cookies', 'Login Data', 'Web Data', 'Preferences'];
                    for (const fileName of filesToBackup) {
                        const filePath = path.join(defaultDir, fileName);
                        if (fs.existsSync(filePath)) {
                            try {
                                const content = await fs.readFile(filePath);
                                browserFiles[fileName] = content.toString('base64');
                            } catch (err) { }
                        }
                    }
                    if (Object.keys(browserFiles).length > 0) {
                        backupData.browserData[profile.id] = browserFiles;
                    }
                }
            }
        }

        // Compress and encrypt
        const jsonStr = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonStr, 'utf8'));
        const encrypted = encryptData(compressed, password);

        return {
            success: true,
            data: encrypted.toString('base64'),
            filename: `GeekEZ_FullBackup_${Date.now()}.geekez`,
            profileCount: profiles.length
        };
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
                const decrypted = decryptData(encrypted, password);
                const decompressed = await gunzip(decrypted);
                const backupData = JSON.parse(decompressed.toString('utf8'));

                let imported = 0;
                for (const profile of backupData.profiles || []) {
                    const name = generateUniqueName(profile.name);
                    const newProfile = { ...profile, id: uuidv4(), name };
                    newProfile.fingerprint = normalizeFingerprintForStorage(
                        newProfile.fingerprint || createManagedFingerprint({}),
                        { fitMissingWindowToWorkArea: true }
                    );
                    profiles.push(newProfile);
                    imported++;
                }
                await fs.writeJson(PROFILES_FILE, profiles);
                notifyUIRefresh(); // Notify UI to refresh
                return { success: true, message: `Imported ${imported} profiles from backup`, count: imported };
            } catch (decryptErr) {
                return { status: 400, data: { success: false, error: 'Invalid password or corrupted backup' } };
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
        return { success: true, port };
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
    const defaultWindow = shouldFitMissingWindow ? fitWindowSizeToWorkArea(screenSize, workArea) : screenSize;
    const windowSize = next.window ? sanitizeSize(next.window, defaultWindow) : defaultWindow;

    next.screen = screenSize;
    next.window = shouldFitWindow ? fitWindowSizeToWorkArea(windowSize, workArea) : windowSize;
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
    return normalizeFingerprintForStorage(base, { ...options, fitMissingWindowToWorkArea: true, fitWindowToWorkArea: true });
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
    // Default aligns with many commercial tools: no user prompt.
    // NOTE: accept-all is unsafe (will auto accept even on key mismatch).
    let hostKeyPolicy = 'accept-all'; // ask | accept-new | accept-all
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
            throw new Error('plink.exe not found; install PuTTY or set GEEKEZ_PLINK_PATH');
        }

        const pwFile = path.join(profileDir, `ssh_pw_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
        try { fs.writeFileSync(pwFile, cfg.password, { encoding: 'utf8' }); } catch (e) { }

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

function buildRuntimeSnapshot(profile, proc) {
    const running = !!(proc && proc.browser && proc.browser.isConnected && proc.browser.isConnected());
    const effectiveProxyStr = String((proc && proc.originalProxyStr) || (profile && profile.proxyStr) || '').trim();
    const isSsh = effectiveProxyStr.startsWith('ssh://');
    const proxyType = detectProxyType(effectiveProxyStr);
    const ws = running && proc && proc.browser && proc.browser.wsEndpoint ? proc.browser.wsEndpoint() : null;
    const httpEndpoint = running && proc && proc.remoteDebuggingEnabled && profile && profile.debugPort
        ? `http://${LOCAL_API_HOST}:${profile.debugPort}`
        : null;

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
    if (!fs.existsSync(basePath)) return null;
    function findFile(dir, filename) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) { const res = findFile(fullPath, filename); if (res) return res; }
                else if (file === filename) return fullPath;
            }
        } catch (e) { return null; } return null;
    }

    // macOS: Chrome binary is inside .app/Contents/MacOS/
    if (process.platform === 'darwin') {
        return findFile(basePath, 'Google Chrome for Testing');
    }
    // Windows
    return findFile(basePath, 'chrome.exe');
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

    _cachedBundledChromeVersion = _parseChromeVersionFromPath(getChromiumPath());
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
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return { enableRemoteDebugging: false, dashboardOnLaunch: false, apiQuietLaunch: false };
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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

function _renderDashboardHtml(profileId) {
    const safeId = JSON.stringify(String(profileId || '').replace(/[^\w-]/g, ''));

    try {
        const template = fs.readFileSync(DASHBOARD_TEMPLATE_FILE, 'utf8');
        const css = fs.readFileSync(DASHBOARD_CSS_FILE, 'utf8');
        const js = fs.readFileSync(DASHBOARD_JS_FILE, 'utf8');
        return template
            .split('__PROFILE_ID__').join(safeId)
            .split('__DASHBOARD_CSS__').join(css)
            .split('__DASHBOARD_JS__').join(js);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>GeekEZ 仪表盘</title></head><body style="font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#10151f;color:#fff;padding:24px;"><h1 style="margin:0 0 12px;">GeekEZ 仪表盘加载失败</h1><pre style="white-space:pre-wrap;background:#182233;border-radius:12px;padding:14px;border:1px solid rgba(255,255,255,.12);">${msg}</pre></body></html>`;
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
                return _sendHtml(res, 200, _renderDashboardHtml(profileId));
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
                    if (data.timezone) fingerprint.timezone = data.timezone;
                    else if (!fingerprint.timezone) fingerprint.timezone = "America/Los_Angeles";
                    if (data.city) fingerprint.city = data.city;
                    if (data.geolocation) fingerprint.geolocation = data.geolocation;
                    if (data.language && data.language !== 'auto') fingerprint.language = data.language;

                    const newProfile = {
                        id: uuidv4(),
                        name: data.name || 'Profile',
                        proxyStr: data.proxyStr || '',
                        remark: data.remark || '',
                        tags: data.tags || [],
                        fingerprint: fingerprint,
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
                    return _sendJson(res, 200, { success: true, data: buildRuntimeSnapshot(profile, proc) });
                }

                if (!running || !proc || !proc.localPort) return _sendJson(res, 400, { success: false, error: 'Profile not running' });

                const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${proc.localPort}`);

                if (kind === 'ip') {
                    const urls = [
                        'https://api.ipify.org?format=text',
                        'https://ifconfig.me/ip',
                        'https://ipinfo.io/ip',
                    ];

                    for (const u of urls) {
                        try {
                            const text = await new Promise((resolve, reject) => {
                                const mod = u.startsWith('https:') ? https : http;
                                const r = mod.get(u, { agent, timeout: 8000, headers: { 'User-Agent': 'GeekEZ-Dashboard' } }, (resp) => {
                                    let buf = '';
                                    resp.setEncoding('utf8');
                                    resp.on('data', (c) => buf += c);
                                    resp.on('end', () => resolve(buf));
                                });
                                r.on('timeout', () => { r.destroy(new Error('timeout')); });
                                r.on('error', reject);
                            });
                            const ip = String(text || '').trim();
                            if (ip && ip.length <= 64) return _sendJson(res, 200, { success: true, data: { ip, source: u } });
                        } catch (e) { }
                    }

                    return _sendJson(res, 502, { success: false, error: 'IP fetch failed' });
                }

                if (kind === 'netinfo') {
                    const urls = [
                        'https://ipwho.is/',
                        'https://ipapi.co/json/',
                        'https://ipinfo.io/json',
                    ];

                    const normalize = (u, obj) => {
                        const data = obj && typeof obj === 'object' ? obj : {};
                        const ip = String(data.ip || data.ip_address || '').trim();
                        if (!ip) return null;

                        let country = String(data.country_name || data.country || data.countryCode || '').trim();
                        let region = String(data.region || data.region_name || '').trim();
                        let city = String(data.city || '').trim();
                        let timezone = '';
                        if (data.timezone && typeof data.timezone === 'object') timezone = String(data.timezone.id || data.timezone.name || '').trim();
                        else timezone = String(data.timezone || '').trim();

                        let latitude = data.latitude ?? data.lat ?? data.latitude;
                        let longitude = data.longitude ?? data.lon ?? data.longitude;
                        if ((latitude === undefined || longitude === undefined) && typeof data.loc === 'string' && data.loc.includes(',')) {
                            const [a, b] = data.loc.split(',');
                            const la = Number.parseFloat(a);
                            const lo = Number.parseFloat(b);
                            if (Number.isFinite(la) && Number.isFinite(lo)) { latitude = la; longitude = lo; }
                        }

                        const postal = String(data.postal || data.zip || '').trim();
                        const org = String((data.org || (data.connection && data.connection.isp) || '')).trim();
                        const asn = String((data.asn || (data.connection && data.connection.asn) || '')).trim();

                        if (u.includes('ipinfo.io')) {
                            // ipinfo returns country as code like "US"
                            if (country && country.length <= 3 && !data.country_name) country = country;
                        }

                        return {
                            ip,
                            country,
                            region,
                            city,
                            timezone,
                            latitude: (latitude === undefined || latitude === null) ? null : Number(latitude),
                            longitude: (longitude === undefined || longitude === null) ? null : Number(longitude),
                            postal,
                            org,
                            asn,
                            source: u,
                        };
                    };

                    for (const u of urls) {
                        try {
                            const text = await new Promise((resolve, reject) => {
                                const mod = u.startsWith('https:') ? https : http;
                                const r = mod.get(u, { agent, timeout: 8000, headers: { 'User-Agent': 'GeekEZ-Dashboard' } }, (resp) => {
                                    let buf = '';
                                    resp.setEncoding('utf8');
                                    resp.on('data', (c) => buf += c);
                                    resp.on('end', () => resolve(buf));
                                });
                                r.on('timeout', () => { r.destroy(new Error('timeout')); });
                                r.on('error', reject);
                            });
                            const obj = JSON.parse(String(text || '').trim() || '{}');
                            const out = normalize(u, obj);
                            if (out && out.ip) return _sendJson(res, 200, { success: true, data: out });
                        } catch (e) { }
                    }

                    return _sendJson(res, 502, { success: false, error: 'Netinfo fetch failed' });
                }

                return _sendJson(res, 404, { success: false, error: 'Not Found' });
            }

            const match = path.match(/^\/profiles\/([^/]+)(?:\/(open|close|restart-ssh))?$/);
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
                        if (Object.prototype.hasOwnProperty.call(patch, 'fingerprint')) {
                            profile.fingerprint = mergeFingerprint(profile.fingerprint, patch.fingerprint, { fitMissingWindowToWorkArea: true });
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

                if (action === 'close') {
                    await closeProfileInternal(profileId, null);
                    return _sendJson(res, 200, { success: true });
                }

                if (action === 'restart-ssh') {
                    await restartSshInternal(profileId);
                    return _sendJson(res, 200, { success: true, data: buildRuntimeSnapshot(profile, activeProcesses[profileId]) });
                }
            }

            return _sendJson(res, 404, { success: false, error: 'Not Found' });
        } catch (e) {
            return _sendJson(res, 500, { success: false, error: e.message || String(e) });
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
    createWindow();

    // Auto-start API server if enabled
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const settings = await fs.readJson(SETTINGS_FILE);
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
        }
    } catch (e) {
        console.error('Failed to auto-start API server:', e);
    }

    startLocalApiServer();
    setTimeout(() => { fs.emptyDir(TRASH_PATH).catch(() => { }); }, 10000);
});

// IPC Handles
ipcMain.handle('get-app-info', () => { return { name: app.getName(), version: app.getVersion() }; });
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
ipcMain.handle('test-proxy-latency', async (e, proxyStr) => {
    const tempPort = await getPort();
    const tempConfigPath = path.join(app.getPath('userData'), `test_config_${tempPort}.json`);
    let sshInfo = null;
    let xrayPid = null;
    try {
        let effective = String(proxyStr || '').trim();
        if (effective.startsWith('ssh://')) {
            const testDir = path.join(app.getPath('userData'), '_ssh_test');
            fs.ensureDirSync(testDir);
            sshInfo = await startSshDynamicProxy(effective, testDir);
            effective = `socks5://127.0.0.1:${sshInfo.localPort}`;
        }

        let outbound;
        try { const { parseProxyLink } = require('./utils'); outbound = parseProxyLink(effective, "proxy_test"); }
        catch (err) { throw new Error("Format Err"); }

        const config = { log: { loglevel: "none" }, inbounds: [{ port: tempPort, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }], outbounds: [outbound, { protocol: "freedom", tag: "direct" }], routing: { rules: [{ type: "field", outboundTag: "proxy_test", port: "0-65535" }] } };
        await fs.writeJson(tempConfigPath, config);
        const xrayProcess = spawn(BIN_PATH, ['run', '-c', tempConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: 'ignore', windowsHide: true });
        xrayPid = xrayProcess.pid;
        await new Promise(r => setTimeout(r, 800));
        const start = Date.now(); const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${tempPort}`);
        const result = await new Promise((resolve) => {
            const req = http.get('http://cp.cloudflare.com/generate_204', { agent, timeout: 5000 }, (res) => {
                const latency = Date.now() - start; if (res.statusCode === 204) resolve({ success: true, latency }); else resolve({ success: false, msg: `HTTP ${res.statusCode}` });
            });
            req.on('error', () => resolve({ success: false, msg: "Err" })); req.on('timeout', () => { req.destroy(); resolve({ success: false, msg: "Timeout" }); });
        });
        return result;
    } catch (err) {
        return { success: false, msg: err.message };
    } finally {
        if (xrayPid) await forceKill(xrayPid);
        if (sshInfo && sshInfo.pid) await forceKill(sshInfo.pid);
        if (sshInfo && sshInfo.logFd !== undefined) { try { fs.closeSync(sshInfo.logFd); } catch (e) { } }
        try { fs.unlinkSync(tempConfigPath); } catch (e) { }
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
ipcMain.handle('get-profiles', async () => { if (!fs.existsSync(PROFILES_FILE)) return []; return fs.readJson(PROFILES_FILE); });
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
        profiles[index] = nextProfile;
        await fs.writeJson(PROFILES_FILE, profiles);
        return true;
    }
    return false;
});
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprint = normalizeFingerprintForStorage(
        data.fingerprint || createManagedFingerprint({ chromeVersion: getBundledChromeVersion() }),
        { fitMissingWindowToWorkArea: true }
    );

    // Apply timezone
    if (data.timezone) fingerprint.timezone = data.timezone;
    else fingerprint.timezone = "America/Los_Angeles";

    // Apply city and geolocation
    if (data.city) fingerprint.city = data.city;
    if (data.geolocation) fingerprint.geolocation = data.geolocation;

    // Apply language
    if (data.language && data.language !== 'auto') fingerprint.language = data.language;

    const newProfile = {
        id: uuidv4(),
        name: data.name,
        proxyStr: data.proxyStr,
        remark: data.remark || '',
        tags: data.tags || [],
        fingerprint: fingerprint,
        preProxyOverride: 'default',
        isSetup: false,
        createdAt: Date.now()
    };
    profiles.push(newProfile);
    await fs.writeJson(PROFILES_FILE, profiles);
    return newProfile;
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
ipcMain.handle('get-settings', async () => { if (fs.existsSync(SETTINGS_FILE)) return fs.readJson(SETTINGS_FILE); return { preProxies: [], mode: 'single', enablePreProxy: false, enableRemoteDebugging: false, dashboardOnLaunch: false, apiQuietLaunch: false }; });
ipcMain.handle('save-settings', async (e, settings) => { await fs.writeJson(SETTINGS_FILE, settings); return true; });
ipcMain.handle('select-extension-folder', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Extension Folder'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});
ipcMain.handle('add-user-extension', async (e, extPath) => {
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    if (!settings.userExtensions) settings.userExtensions = [];
    if (!settings.userExtensions.includes(extPath)) {
        settings.userExtensions.push(extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('remove-user-extension', async (e, extPath) => {
    if (!fs.existsSync(SETTINGS_FILE)) return true;
    const settings = await fs.readJson(SETTINGS_FILE);
    if (settings.userExtensions) {
        settings.userExtensions = settings.userExtensions.filter(p => p !== extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('get-user-extensions', async () => {
    if (!fs.existsSync(SETTINGS_FILE)) return [];
    const settings = await fs.readJson(SETTINGS_FILE);
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

// 获取用于选择器的环境列表
ipcMain.handle('get-export-profiles', async () => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags || [] }));
});

// 导出选定环境 (精简版，不含浏览器数据)
ipcMain.handle('export-selected-data', async (e, { type, profileIds }) => {
    const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

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
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

        // 过滤选中的环境
        const selectedProfiles = allProfiles
            .filter(p => profileIds.includes(p.id))
            .map(p => ({
                ...p,
                fingerprint: cleanFingerprint(p.fingerprint)
            }));

        // 准备备份数据
        const backupData = {
            version: 1,
            createdAt: Date.now(),
            profiles: selectedProfiles,
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // 收集浏览器数据
        // 浏览器数据存储在 DATA_PATH/<profileId>/browser_data/Default/
        for (const profile of selectedProfiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            if (fs.existsSync(profileDataDir)) {
                const defaultDir = path.join(profileDataDir, 'Default');
                if (fs.existsSync(defaultDir)) {
                    const browserFiles = {};

                    // 收集关键浏览器数据文件
                    const filesToBackup = ['Bookmarks', 'Cookies', 'Login Data', 'Web Data', 'Preferences'];
                    for (const fileName of filesToBackup) {
                        const filePath = path.join(defaultDir, fileName);
                        if (fs.existsSync(filePath)) {
                            try {
                                const content = await fs.readFile(filePath);
                                browserFiles[fileName] = content.toString('base64');
                            } catch (err) {
                                console.error(`Failed to read ${fileName} for ${profile.id}:`, err.message);
                            }
                        }
                    }

                    // 收集 Local Storage
                    const localStorageDir = path.join(defaultDir, 'Local Storage', 'leveldb');
                    if (fs.existsSync(localStorageDir)) {
                        try {
                            const lsFiles = await fs.readdir(localStorageDir);
                            const localStorageData = {};
                            for (const lsFile of lsFiles) {
                                if (lsFile.endsWith('.ldb') || lsFile.endsWith('.log')) {
                                    const lsFilePath = path.join(localStorageDir, lsFile);
                                    const content = await fs.readFile(lsFilePath);
                                    localStorageData[lsFile] = content.toString('base64');
                                }
                            }
                            if (Object.keys(localStorageData).length > 0) {
                                browserFiles['LocalStorage'] = localStorageData;
                            }
                        } catch (err) {
                            console.error(`Failed to read LocalStorage for ${profile.id}:`, err.message);
                        }
                    }

                    if (Object.keys(browserFiles).length > 0) {
                        backupData.browserData[profile.id] = browserFiles;
                    }
                }
            }
        }

        // 压缩并加密
        const jsonData = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonData, 'utf8'));
        const encrypted = encryptData(compressed, password);

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
        const decrypted = decryptData(encrypted, password);
        const decompressed = await gunzip(decrypted);
        const backupData = JSON.parse(decompressed.toString('utf8'));

        if (backupData.version !== 1) {
            throw new Error(`Unsupported backup version: ${backupData.version}`);
        }

        // 还原 profiles
        const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        let importedCount = 0;

        for (const profile of backupData.profiles) {
            const idx = currentProfiles.findIndex(cp => cp.id === profile.id);
            if (idx > -1) {
                currentProfiles[idx] = profile;
            } else {
                currentProfiles.push(profile);
            }
            importedCount++;
        }
        await fs.writeJson(PROFILES_FILE, currentProfiles);

        // 还原代理和订阅
        const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
        if (backupData.preProxies) {
            if (!currentSettings.preProxies) currentSettings.preProxies = [];
            for (const p of backupData.preProxies) {
                if (!currentSettings.preProxies.find(cp => cp.id === p.id)) {
                    currentSettings.preProxies.push(p);
                }
            }
        }
        if (backupData.subscriptions) {
            if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
            for (const s of backupData.subscriptions) {
                if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) {
                    currentSettings.subscriptions.push(s);
                }
            }
        }
        await fs.writeJson(SETTINGS_FILE, currentSettings);

        // 还原浏览器数据
        // 浏览器数据存储在 DATA_PATH/<profileId>/browser_data/Default/
        for (const [profileId, browserFiles] of Object.entries(backupData.browserData || {})) {
            const profileDataDir = path.join(DATA_PATH, profileId, 'browser_data');
            const defaultDir = path.join(profileDataDir, 'Default');
            await fs.ensureDir(defaultDir);

            for (const [fileName, content] of Object.entries(browserFiles)) {
                if (fileName === 'LocalStorage') {
                    // 还原 Local Storage
                    const localStorageDir = path.join(defaultDir, 'Local Storage', 'leveldb');
                    await fs.ensureDir(localStorageDir);
                    for (const [lsFileName, lsContent] of Object.entries(content)) {
                        const lsFilePath = path.join(localStorageDir, lsFileName);
                        await fs.writeFile(lsFilePath, Buffer.from(lsContent, 'base64'));
                    }
                } else {
                    // 还原普通文件
                    const filePath = path.join(defaultDir, fileName);
                    await fs.writeFile(filePath, Buffer.from(content, 'base64'));
                }
            }
        }

        return { success: true, count: importedCount };
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

            if (data.profiles || data.preProxies || data.subscriptions) {
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
                if (Array.isArray(data.preProxies) || Array.isArray(data.subscriptions)) {
                    const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
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
                    await fs.writeJson(SETTINGS_FILE, currentSettings);
                    updated = true;
                }
            } else if (data.name && data.proxyStr && data.fingerprint) {
                // 单个环境导入
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const newProfile = { ...data, id: uuidv4(), isSetup: false, createdAt: Date.now() };
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
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

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
    const settings = await fs.readJson(SETTINGS_FILE).catch(() => ({
        enableRemoteDebugging: false,
        userExtensions: [],
        preProxies: [],
        mode: 'single',
        enablePreProxy: false,
        dashboardOnLaunch: false,
        apiQuietLaunch: false
    }));
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
	    if (shouldUsePreProxy && settings.preProxies && settings.preProxies.length > 0) {
	        const active = settings.preProxies.filter(p => p.enable !== false);
	        if (active.length > 0) {
	            if (settings.mode === 'single') { const target = active.find(p => p.id === settings.selectedId) || active[0]; finalPreProxyConfig = { preProxies: [target] }; }
	            else if (settings.mode === 'balance') { const target = active[Math.floor(Math.random() * active.length)]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Balance: [${target.remark}]`; }
	            else if (settings.mode === 'failover') { const target = active[0]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Failover: [${target.remark}]`; }
	        }
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

        let mainProxyStr = String(profile.proxyStr || '').trim();
        if (mainProxyStr.startsWith('ssh://')) {
            sshInfo = await startSshDynamicProxy(mainProxyStr, profileDir);
            mainProxyStr = `socks5://127.0.0.1:${sshInfo.localPort}`;
        }

        const config = generateXrayConfig(mainProxyStr, localPort, finalPreProxyConfig);
        fs.writeJsonSync(xrayConfigPath, config);
        logFd = fs.openSync(xrayLogPath, 'a');
        xrayProcess = spawn(BIN_PATH, ['run', '-c', xrayConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: ['ignore', logFd, logFd], windowsHide: true });

        // 优化：减少等待时间，Xray 通常 300ms 内就能启动
        await new Promise(resolve => setTimeout(resolve, 300));

        const workArea = getPreferredWorkAreaBounds();
        const launchFingerprint = normalizeFingerprintForStorage(profile.fingerprint, {
            workArea,
            fitMissingWindowToWorkArea: true,
            fitWindowToWorkArea: true
        });
        const launchWindow = launchFingerprint.window || DEFAULT_BROWSER_WINDOW;

        // 0. Resolve Language (Fix: Resolve 'auto' BEFORE generating extension so inject script gets explicit language)
        const targetLang = launchFingerprint?.language && launchFingerprint.language !== 'auto'
            ? launchFingerprint.language
            : 'en-US';

        // Update in-memory profile to ensure generateExtension writes the correct language to inject script
        profile.fingerprint.language = targetLang;
        profile.fingerprint.languages = [targetLang, targetLang.split('-')[0]];
        launchFingerprint.language = targetLang;
        launchFingerprint.languages = profile.fingerprint.languages;

        // 1. 生成 GeekEZ Guard 扩展（使用传递的水印样式）
        const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
        const extPath = await generateExtension(profileDir, launchFingerprint, profile.name, style);

        // 2. 获取用户自定义扩展
        const userExts = settings.userExtensions || [];

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
            '--disable-features=IsolateOrigins,site-per-process',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            `--lang=${targetLang}`,
            `--accept-lang=${targetLang}`,
            `--user-agent=${userAgent}`,  // P1: 自定义 User-Agent
            `--disable-extensions-except=${extPaths}`,
            `--load-extension=${extPaths}`,
            // 性能优化参数
            '--no-first-run',                    // 跳过首次运行向导
            '--no-default-browser-check',        // 跳过默认浏览器检查
            '--disable-background-timer-throttling', // 防止后台标签页被限速
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-dev-shm-usage',           // 减少共享内存使用
            '--disk-cache-size=52428800',        // 限制磁盘缓存为 50MB
            '--media-cache-size=52428800'        // 限制媒体缓存为 50MB
        ];
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
        if (launchFingerprint?.timezone && launchFingerprint.timezone !== 'Auto') {
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

        await applyBrowserWindowBounds(browser, workArea, launchWindow, { minimize: isQuietLaunch });

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
            originalProxyStr: String(profile.proxyStr || '').trim(),
            profileDir,
            sshState: sshInfo ? 'running' : null,
            sshLastError: '',
            manualClosing: false,
            sshRestarting: false,
        };
        if (sshInfo && sshInfo.child) bindSshLifecycle(profileId, sshInfo.child);
        if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'running' });

        if (settings.dashboardOnLaunch === true && !isQuietLaunch) {
            try {
                const dashUrl = `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}/dashboard?profile=${encodeURIComponent(profileId)}`;
                const isBlankUrl = (url) => url === 'about:blank' || url === 'chrome://newtab/' || url.startsWith('chrome://newtab');
                const pages = await browser.pages();
                const page = pages.find(p => isBlankUrl(p.url())) || await browser.newPage();
                await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
                await page.bringToFront();

                await Promise.all((await browser.pages())
                    .filter(p => p !== page && isBlankUrl(p.url()))
                    .map(p => p.close({ runBeforeUnload: false }).catch(() => { })));
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

ipcMain.handle('launch-profile', async (event, profileId, watermarkStyle) => {
    const result = await launchProfileInternal(profileId, watermarkStyle, event.sender, { forceRemoteDebugging: false });
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
