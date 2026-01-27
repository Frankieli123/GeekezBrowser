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
const DATA_PATH = path.join(app.getPath('userData'), 'BrowserProfiles');
const TRASH_PATH = path.join(app.getPath('userData'), '_Trash_Bin');
const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');

fs.ensureDirSync(DATA_PATH);
fs.ensureDirSync(TRASH_PATH);

let activeProcesses = {};
let localApiServer = null;
const trustedSshHosts = new Set();
const sshHostKeyPromptWaiters = new Map();
let sshHostKeyPromptSeq = 0;

const LOCAL_API_HOST = '127.0.0.1';
const LOCAL_API_PORT = Number.parseInt(process.env.GEEKEZ_API_PORT || '17555', 10) || 17555;

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

async function startSshDynamicProxy(proxyStr, profileDir) {
    const cfg = parseSshProxy(proxyStr);

    const localPort = await getPort();
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
        return { pid: proc.pid, localPort, logFd };
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
    return { pid: proc.pid, localPort, logFd };
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
    return { enableRemoteDebugging: false };
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
    return win;
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
    const safeId = String(profileId || '').replace(/[^\w-]/g, '');
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GeekEZ 仪表盘</title>
  <style>
    :root{
      --bg:#1e1e2d;
      --card:#2b2b40;
      --text:#ffffff;
      --muted:#a0a0ba;
      --accent:#00e0ff;
      --danger:#f64e60;
      --ok:#27ae60;
      --border:#3f4254;
      --line:rgba(255,255,255,.08);
      --shadow:rgba(0,0,0,.35);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      color:var(--text);
      font-family:'Segoe UI',system-ui,-apple-system,Roboto,'Microsoft YaHei',sans-serif;
      background:
        radial-gradient(1200px 700px at 15% 10%, rgba(0,224,255,.12), transparent 55%),
        radial-gradient(900px 600px at 85% 0%, rgba(124,58,237,.18), transparent 55%),
        var(--bg);
    }
    .wrap{max-width:1180px;margin:18px auto;padding:0 16px 28px}
    .header{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin-top:8px}
    .brand{display:flex;flex-direction:column;gap:4px}
    .title{font-size:18px;font-weight:700;letter-spacing:.2px}
    .meta{font-size:12px;color:var(--muted)}
    .meta code{color:var(--text);background:rgba(0,0,0,.25);border:1px solid var(--line);padding:2px 6px;border-radius:6px}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .btn{cursor:pointer;border:1px solid var(--border);background:rgba(0,0,0,.18);color:var(--text);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1}
    .btn:hover{border-color:rgba(0,224,255,.6);box-shadow:0 0 0 2px rgba(0,224,255,.12) inset}
    .btn.primary{background:rgba(0,224,255,.14);border-color:rgba(0,224,255,.45)}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;margin-top:12px}
    .card{grid-column:span 12;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 10px 30px var(--shadow)}
    .hero{display:flex;gap:12px;justify-content:space-between;align-items:stretch;flex-wrap:wrap}
    .heroLeft{min-width:260px;flex:1}
    .heroLabel{font-size:12px;color:var(--muted)}
    .heroIpRow{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:6px}
    .heroIp{font-size:34px;font-weight:800;letter-spacing:.5px;text-shadow:0 0 18px rgba(0,224,255,.16)}
    .pill{display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);font-size:12px}
    .dot{width:8px;height:8px;border-radius:50%}
    .dot.ok{background:var(--ok)}
    .dot.bad{background:var(--danger)}
    .heroSub{margin-top:6px;font-size:12px;color:var(--muted)}
    .heroRight{display:flex;gap:8px;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap}
    .kv{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
    .item{grid-column:span 12}
    @media (min-width:920px){
      .span6{grid-column:span 6}
      .span12{grid-column:span 12}
      .item.half{grid-column:span 6}
      .item.third{grid-column:span 4}
    }
    .k{color:var(--muted);font-size:12px}
    .v{font-size:13px;word-break:break-word}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .link{color:#a6c8ff;text-decoration:none}
    .link:hover{text-decoration:underline}
    .copy{cursor:pointer;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);color:var(--text);border-radius:8px;padding:5px 8px;font-size:12px}
    .copy:hover{border-color:rgba(0,224,255,.6)}
    pre{margin:10px 0 0;padding:12px;border-radius:12px;overflow:auto;background:rgba(0,0,0,.22);border:1px solid var(--line);font-size:12px;line-height:1.35}
    details{margin-top:10px}
    summary{cursor:pointer;color:var(--text);font-weight:600}
    .err{margin-top:12px;color:var(--danger);white-space:pre-wrap}
    .otpBox{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .otpCode{font-size:24px;font-weight:800;letter-spacing:2px}
    .bar{position:relative;height:8px;flex:1;min-width:120px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid rgba(255,255,255,.10)}
    .bar>div{height:100%;background:rgba(0,224,255,.55);width:0%}
  </style>
  <script>window.__PROFILE_ID__=${JSON.stringify(safeId)};</script>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="brand">
        <div class="title">GeekEZ 仪表盘</div>
        <div class="meta">Profile: <code id="pid"></code> · API: <span id="api"></span></div>
      </div>
      <div class="actions">
        <button class="btn primary" id="btnAll">刷新全部</button>
        <button class="btn" id="btnIp">刷新 IP</button>
        <button class="btn" id="btnNet">刷新网络信息</button>
        <button class="btn" id="btnCopyWs">复制 WS</button>
      </div>
    </div>

    <div class="grid">
      <div class="card hero">
        <div class="heroLeft">
          <div class="heroLabel">代理出口 IP</div>
          <div class="heroIpRow">
            <div class="heroIp" id="ip">-</div>
            <span class="pill"><span class="dot" id="dotRun"></span><span id="runText">-</span></span>
          </div>
          <div class="heroSub" id="ipMeta">来源: -</div>
          <div class="heroSub">名称: <span id="name">-</span></div>
          <div class="heroSub">代理: <span class="mono" id="proxyMasked">-</span></div>
        </div>
        <div class="heroRight">
          <button class="btn" id="btnCopyIp">复制 IP</button>
          <button class="btn" id="btnCopyProxy">复制代理</button>
          <button class="btn" id="btnCopyProfile">复制 ProfileID</button>
        </div>
      </div>

      <div class="card span6">
        <div class="row" style="justify-content:space-between">
          <div class="k">网络信息</div>
          <span class="pill">IP: <span id="netIp">-</span></span>
        </div>
        <div class="kv" style="margin-top:10px">
          <div class="item half"><div class="k">位置</div><div class="v" id="loc">-</div></div>
          <div class="item half"><div class="k">时区</div><div class="v" id="tz">-</div></div>
          <div class="item half"><div class="k">ASN / 组织</div><div class="v" id="org">-</div></div>
          <div class="item half"><div class="k">坐标</div><div class="v" id="geo">-</div></div>
          <div class="item half"><div class="k">邮编</div><div class="v" id="postal">-</div></div>
          <div class="item half"><div class="k">来源</div><div class="v" id="netSource">-</div></div>
        </div>
      </div>

      <div class="card span6">
        <div class="k">运行 / 调试</div>
        <div class="kv" style="margin-top:10px">
          <div class="item"><div class="k">WS</div><div class="row"><div class="v mono" id="ws">-</div><button class="copy" id="copyWs">复制</button></div></div>
          <div class="item"><div class="k">HTTP</div><div class="row"><div class="v mono" id="http">-</div><button class="copy" id="copyHttp">复制</button></div></div>
          <div class="item third"><div class="k">debugPort</div><div class="v mono" id="debugPort">-</div></div>
          <div class="item third"><div class="k">localPort</div><div class="v mono" id="localPort">-</div></div>
          <div class="item third"><div class="k">sshLocalPort</div><div class="v mono" id="sshLocalPort">-</div></div>
        </div>
      </div>

      <div class="card span6">
        <div class="k">Profile 信息</div>
        <div class="kv" style="margin-top:10px">
          <div class="item half"><div class="k">名称</div><div class="v" id="pName">-</div></div>
          <div class="item half"><div class="k">创建时间</div><div class="v" id="createdAt">-</div></div>
          <div class="item"><div class="k">备注</div><div class="row"><div class="v" id="remark">-</div><button class="copy" id="copyRemark">复制</button></div></div>
          <div class="item half"><div class="k">preProxyOverride</div><div class="v mono" id="preProxyOverride">-</div></div>
          <div class="item half"><div class="k">标签</div><div class="v" id="tags">-</div></div>
        </div>
      </div>

      <div class="card span6" id="acctCard" style="display:none">
        <div class="k">账号 / 2FA</div>
        <div class="kv" style="margin-top:10px">
          <div class="item half"><div class="k">邮箱</div><div class="v mono" id="acctEmail">-</div></div>
          <div class="item half"><div class="k">辅助邮箱</div><div class="v mono" id="acctAux">-</div></div>
          <div class="item">
            <div class="k">动态码</div>
            <div class="otpBox">
              <div class="otpCode mono" id="otpCode">------</div>
              <div class="pill">剩余 <span id="otpRemain">-</span>s</div>
              <button class="copy" id="copyOtp">复制</button>
              <a class="link" id="otpFallback" href="#" target="_blank" rel="noreferrer" style="display:none">2fa.show</a>
              <div class="bar" title="倒计时"><div id="otpBar"></div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card span12">
        <details>
          <summary>指纹配置</summary>
          <pre id="fingerprint">-</pre>
        </details>
        <details>
          <summary>浏览器信息</summary>
          <pre id="browserInfo">-</pre>
        </details>
        <div class="err" id="err"></div>
      </div>
    </div>
  </div>

  <script>
    const profileId = window.__PROFILE_ID__ || '';
    const apiBase = location.origin;
    const $ = (id) => document.getElementById(id);

    function pretty(o) { return JSON.stringify(o, null, 2); }
    function setErr(msg) { $('err').textContent = msg || ''; }

    function setText(id, text) {
      const el = $(id);
      if (!el) return;
      el.textContent = (text === undefined || text === null || text === '') ? '-' : String(text);
    }

    function fmtTime(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return '-';
      try { return new Date(n).toLocaleString(); } catch (e) { return String(ms); }
    }

    function maskProxy(proxyStr) {
      const raw = String(proxyStr || '').trim();
      if (!raw) return '';
      try {
        const u = new URL(raw);
        const auth = u.username ? (decodeURIComponent(u.username) + (u.password ? ':***' : '') + '@') : '';
        const host = u.hostname + (u.port ? ':' + u.port : '');
        const q = u.search || '';
        return u.protocol + '//' + auth + host + q;
      } catch (e) {
        return raw;
      }
    }

    async function copyText(text) {
      const s = String(text || '');
      if (!s) return;
      try {
        await navigator.clipboard.writeText(s);
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = s;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch (e2) {
          prompt('复制：', s);
        }
      }
    }

    async function getJson(path) {
      const res = await fetch(apiBase + path, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!json || json.success !== true) throw new Error((json && (json.error || json.msg)) || 'API error');
      return json.data;
    }

    let totpTimer = null;
    let currentSecret = null;

    function stopTotp() {
      if (totpTimer) clearInterval(totpTimer);
      totpTimer = null;
      currentSecret = null;
      $('acctCard').style.display = 'none';
    }

    function base32ToBytes(input) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
      let bits = 0;
      let value = 0;
      const out = [];
      for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        while (bits >= 8) {
          out.push((value >>> (bits - 8)) & 0xff);
          bits -= 8;
        }
      }
      return new Uint8Array(out);
    }

    async function computeTotp(secret) {
      if (!secret) return null;
      if (!window.crypto || !crypto.subtle) return null;
      try {
        const keyBytes = base32ToBytes(secret);
        if (!keyBytes || !keyBytes.length) return null;

        const counter = Math.floor(Date.now() / 30000);
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint32(0, 0, false);
        dv.setUint32(4, counter, false);

        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
        const off = sig[sig.length - 1] & 0x0f;
        const bin = ((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff);
        return String(bin % 1000000).padStart(6, '0');
      } catch (e) {
        return null;
      }
    }

    function startTotp(email, aux, secret) {
      $('acctCard').style.display = '';
      setText('acctEmail', email);
      setText('acctAux', aux);

      currentSecret = secret;

      const fallback = $('otpFallback');
      fallback.style.display = 'none';
      fallback.href = '#';

      $('copyOtp').onclick = async () => {
        const code = $('otpCode').textContent;
        if (code && code !== '------' && code !== 'ERR') await copyText(code);
      };

      const tick = async () => {
        const remain = 30 - (Math.floor(Date.now() / 1000) % 30);
        setText('otpRemain', remain);
        $('otpBar').style.width = (remain / 30 * 100).toFixed(0) + '%';

        const code = await computeTotp(currentSecret);
        if (code) {
          setText('otpCode', code);
        } else {
          setText('otpCode', 'ERR');
          fallback.style.display = '';
          fallback.href = 'https://2fa.show/2fa/' + encodeURIComponent(currentSecret);
        }
      };

      tick();
      if (totpTimer) clearInterval(totpTimer);
      totpTimer = setInterval(tick, 1000);
    }

    function setRunning(running) {
      const dot = $('dotRun');
      const txt = $('runText');
      if (running) {
        dot.className = 'dot ok';
        txt.textContent = '运行中';
      } else {
        dot.className = 'dot bad';
        txt.textContent = '未运行';
      }
    }

    async function refreshProfile() {
      const p = await getJson('/profiles/' + encodeURIComponent(profileId));
      setText('pid', profileId || '(none)');
      setText('api', apiBase);

      setText('name', p.name || '-');
      setText('pName', p.name || '-');
      setText('createdAt', fmtTime(p.createdAt));
      setText('remark', p.remark || '-');
      setText('preProxyOverride', p.preProxyOverride || '-');
      setText('tags', Array.isArray(p.tags) && p.tags.length ? p.tags.join(', ') : '-');

      setText('proxyMasked', maskProxy(p.proxyStr || '') || '-');

      $('btnCopyProxy').onclick = async () => { await copyText(p.proxyStr || ''); };
      $('btnCopyProfile').onclick = async () => { await copyText(profileId); };
      $('copyRemark').onclick = async () => { await copyText(p.remark || ''); };

      setText('fingerprint', pretty(p.fingerprint || {}));

      const remark = String(p.remark || '');
      const parts = remark.split('----').map(s => String(s || '').trim());
      if (parts.length >= 3) {
        const email = parts[0] || '';
        const secret = parts[parts.length - 1] || '';
        const aux = (parts.length >= 4) ? (parts[2] || '') : '';
        if (email && secret) startTotp(email, aux, secret);
        else stopTotp();
      } else {
        stopTotp();
      }

      return p;
    }

    async function refreshRuntime() {
      const r = await getJson('/profiles/' + encodeURIComponent(profileId) + '/runtime').catch(() => ({ running: false }));
      setRunning(!!r.running);

      const ws = r.ws || '';
      const http = r.http || '';
      setText('ws', ws || '-');
      setText('http', http || '-');
      setText('debugPort', r.debugPort || '-');
      setText('localPort', r.localPort || '-');
      setText('sshLocalPort', r.sshLocalPort || '-');

      $('btnCopyWs').onclick = async () => { if (ws) await copyText(ws); };
      $('copyWs').onclick = async () => { if (ws) await copyText(ws); };
      $('copyHttp').onclick = async () => { if (http) await copyText(http); };

      return r;
    }

    async function refreshIp() {
      setText('ip', '...');
      setText('ipMeta', '来源: ...');
      $('btnCopyIp').onclick = null;

      try {
        const ip = await getJson('/profiles/' + encodeURIComponent(profileId) + '/ip');
        setText('ip', ip.ip || '-');
        setText('ipMeta', '来源: ' + (ip.source || '-'));
        $('btnCopyIp').onclick = async () => { await copyText(ip.ip || ''); };
      } catch (e) {
        setText('ip', '-');
        setText('ipMeta', '来源: -');
      }
    }

    async function refreshNetinfo() {
      setText('loc', '...');
      setText('tz', '...');
      setText('org', '...');
      setText('geo', '...');
      setText('postal', '...');
      setText('netIp', '...');
      setText('netSource', '...');

      try {
        const n = await getJson('/profiles/' + encodeURIComponent(profileId) + '/netinfo');
        setText('netIp', n.ip || '-');
        setText('loc', [n.city, n.region, n.country].filter(Boolean).join(', ') || '-');
        setText('tz', n.timezone || '-');
        setText('org', [n.asn, n.org].filter(Boolean).join(' ') || '-');
        const lat = (n.latitude !== undefined && n.latitude !== null) ? String(n.latitude) : '';
        const lon = (n.longitude !== undefined && n.longitude !== null) ? String(n.longitude) : '';
        setText('geo', (lat && lon) ? (lat + ', ' + lon) : '-');
        setText('postal', n.postal || '-');
        setText('netSource', n.source || '-');
      } catch (e) {
        setText('netIp', '-');
        setText('loc', '-');
        setText('tz', '-');
        setText('org', '-');
        setText('geo', '-');
        setText('postal', '-');
        setText('netSource', '-');
      }
    }

    async function refreshAll() {
      setErr('');
      if (!profileId) {
        setErr('缺少 profile 参数（例如 /dashboard?profile=<id>）');
        return;
      }

      setText('browserInfo', pretty({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        webdriver: navigator.webdriver,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
      }));

      await Promise.all([refreshProfile(), refreshRuntime()]);
      await Promise.all([refreshIp(), refreshNetinfo()]);
    }

    $('btnAll').onclick = () => refreshAll().catch(e => setErr(String(e && e.stack ? e.stack : e)));
    $('btnIp').onclick = () => refreshIp().catch(e => setErr(String(e && e.stack ? e.stack : e)));
    $('btnNet').onclick = () => refreshNetinfo().catch(e => setErr(String(e && e.stack ? e.stack : e)));

    refreshAll().catch(e => setErr(String(e && e.stack ? e.stack : e)));
  </script>
</body>
</html>`;
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
                    const fingerprint = data.fingerprint || generateFingerprint({ chromeVersion: getBundledChromeVersion() });
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
                    const ws = running && proc && proc.browser && proc.browser.wsEndpoint ? proc.browser.wsEndpoint() : null;
                    const httpEndpoint = running && proc && proc.remoteDebuggingEnabled && profile.debugPort ? `http://${LOCAL_API_HOST}:${profile.debugPort}` : null;
                    return _sendJson(res, 200, {
                        success: true,
                        data: {
                            running,
	                            ws,
	                            http: httpEndpoint,
	                            debugPort: running && proc && proc.remoteDebuggingEnabled ? (profile.debugPort || undefined) : undefined,
	                            localPort: running && proc ? (proc.localPort || undefined) : undefined,
	                            sshLocalPort: running && proc ? (proc.sshLocalPort || undefined) : undefined,
	                        }
	                    });
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

            const match = path.match(/^\/profiles\/([^/]+)(?:\/(open|close))?$/);
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
                        const allowed = ['name', 'proxyStr', 'remark', 'tags', 'fingerprint', 'debugPort', 'preProxyOverride'];
                        for (const k of allowed) {
                            if (Object.prototype.hasOwnProperty.call(patch, k)) profile[k] = patch[k];
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
ipcMain.handle('check-app-update', async () => { try { const data = await fetchJson('https://api.github.com/repos/EchoHS/GeekezBrowser/releases/latest'); if (!data || !data.tag_name) return { update: false }; const remote = data.tag_name.replace('v', ''); if (compareVersions(remote, app.getVersion()) > 0) { return { update: true, remote, url: data.html_url }; } return { update: false }; } catch (e) { return { update: false, error: e.message }; } });
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
ipcMain.handle('generate-fingerprint', () => generateFingerprint({ chromeVersion: getBundledChromeVersion() }));
ipcMain.handle('get-profiles', async () => { if (!fs.existsSync(PROFILES_FILE)) return []; return fs.readJson(PROFILES_FILE); });
ipcMain.handle('update-profile', async (event, updatedProfile) => { let profiles = await fs.readJson(PROFILES_FILE); const index = profiles.findIndex(p => p.id === updatedProfile.id); if (index > -1) { profiles[index] = updatedProfile; await fs.writeJson(PROFILES_FILE, profiles); return true; } return false; });
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprint = data.fingerprint || generateFingerprint({ chromeVersion: getBundledChromeVersion() });

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
ipcMain.handle('get-settings', async () => { if (fs.existsSync(SETTINGS_FILE)) return fs.readJson(SETTINGS_FILE); return { preProxies: [], mode: 'single', enablePreProxy: false, enableRemoteDebugging: false }; });
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
ipcMain.handle('export-data', async (e, type) => { const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : []; const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] }; let exportObj = {}; if (type === 'all' || type === 'profiles') exportObj.profiles = profiles; if (type === 'all' || type === 'proxies') { exportObj.preProxies = settings.preProxies || []; exportObj.subscriptions = settings.subscriptions || []; } if (Object.keys(exportObj).length === 0) return false; const { filePath } = await dialog.showSaveDialog({ title: 'Export Data', defaultPath: `GeekEZ_Backup_${type}_${Date.now()}.yaml`, filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }] }); if (filePath) { await fs.writeFile(filePath, yaml.dump(exportObj)); return true; } return false; });
ipcMain.handle('import-data', async () => { const { filePaths } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }] }); if (filePaths && filePaths.length > 0) { try { const content = await fs.readFile(filePaths[0], 'utf8'); const data = yaml.load(content); let updated = false; if (data.profiles || data.preProxies || data.subscriptions) { if (Array.isArray(data.profiles)) { const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : []; data.profiles.forEach(p => { const idx = currentProfiles.findIndex(cp => cp.id === p.id); if (idx > -1) currentProfiles[idx] = p; else { if (!p.id) p.id = uuidv4(); currentProfiles.push(p); } }); await fs.writeJson(PROFILES_FILE, currentProfiles); updated = true; } if (Array.isArray(data.preProxies) || Array.isArray(data.subscriptions)) { const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] }; if (data.preProxies) { if (!currentSettings.preProxies) currentSettings.preProxies = []; data.preProxies.forEach(p => { if (!currentSettings.preProxies.find(cp => cp.id === p.id)) currentSettings.preProxies.push(p); }); } if (data.subscriptions) { if (!currentSettings.subscriptions) currentSettings.subscriptions = []; data.subscriptions.forEach(s => { if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) currentSettings.subscriptions.push(s); }); } await fs.writeJson(SETTINGS_FILE, currentSettings); updated = true; } } else if (data.name && data.proxyStr && data.fingerprint) { const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : []; const newProfile = { ...data, id: uuidv4(), isSetup: false, createdAt: Date.now() }; profiles.push(newProfile); await fs.writeJson(PROFILES_FILE, profiles); updated = true; } return updated; } catch (e) { console.error(e); throw e; } } return false; });

// --- 核心启动逻辑 ---
async function launchProfileInternal(profileId, watermarkStyle, sender, options = {}) {
    const forceRemoteDebugging = !!options.forceRemoteDebugging;

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        if (proc.browser && proc.browser.isConnected()) {
            try {
                const targets = await proc.browser.targets();
                const pageTarget = targets.find(t => t.type() === 'page');
                if (pageTarget) {
                    const page = await pageTarget.page();
                    if (page) {
                        const session = await pageTarget.createCDPSession();
                        const { windowId } = await session.send('Browser.getWindowForTarget');
                        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
                        setTimeout(async () => {
                            try { await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch (e) { }
                        }, 100);
                        await page.bringToFront();
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
                await forceKill(proc.xrayPid);
                delete activeProcesses[profileId];
            }
        } else {
            await forceKill(proc.xrayPid);
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

    // Load settings early for userExtensions and remote debugging
    const settings = await fs.readJson(SETTINGS_FILE).catch(() => ({
        enableRemoteDebugging: false,
        userExtensions: [],
        preProxies: [],
        mode: 'single',
        enablePreProxy: false,
        dashboardOnLaunch: true
    }));

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    const bundledChromeVersion = getBundledChromeVersion();
    if (!profile.fingerprint) profile.fingerprint = generateFingerprint({ chromeVersion: bundledChromeVersion });
    if (!profile.fingerprint.languages) profile.fingerprint.languages = ['en-US', 'en'];
    if (bundledChromeVersion && ensureFingerprintChromeVersion(profile.fingerprint, bundledChromeVersion)) {
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

        // 0. Resolve Language (Fix: Resolve 'auto' BEFORE generating extension so inject script gets explicit language)
        const targetLang = profile.fingerprint?.language && profile.fingerprint.language !== 'auto'
            ? profile.fingerprint.language
            : 'en-US';

        // Update in-memory profile to ensure generateExtension writes the correct language to inject script
        profile.fingerprint.language = targetLang;
        profile.fingerprint.languages = [targetLang, targetLang.split('-')[0]];

        // 1. 生成 GeekEZ Guard 扩展（使用传递的水印样式）
        const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
        const extPath = await generateExtension(profileDir, profile.fingerprint, profile.name, style);

        // 2. 获取用户自定义扩展
        const userExts = settings.userExtensions || [];

        // 3. 合并所有扩展路径
        let extPaths = extPath; // GeekEZ Guard
        if (userExts.length > 0) {
            extPaths += ',' + userExts.join(',');
        }

        // 4. 构建启动参数（性能优化）
        // P1: 使用指纹中的 User-Agent
        const userAgent = profile.fingerprint?.userAgent
            || (bundledChromeVersion ? buildDefaultUserAgent(bundledChromeVersion) : null)
            || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

	        const launchArgs = [
	            `--proxy-server=socks5://127.0.0.1:${localPort}`,
	            '--proxy-bypass-list=127.0.0.1;localhost;[::1]',
	            '--disable-quic',
	            `--user-data-dir=${userDataDir}`,
	            `--window-size=${profile.fingerprint?.window?.width || 1280},${profile.fingerprint?.window?.height || 800}`,
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


        // 5. 启动浏览器
        const chromePath = getChromiumPath();
        if (!chromePath) {
            await forceKill(xrayProcess.pid);
            throw new Error("Chrome binary not found.");
        }

        // 时区设置
        const env = { ...process.env };
        if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
            env.TZ = profile.fingerprint.timezone;
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

        activeProcesses[profileId] = {
            xrayPid: xrayProcess.pid,
            sshPid: sshInfo ? sshInfo.pid : undefined,
            browser,
            logFd: logFd,  // 存储日志文件描述符，用于后续关闭
            sshLogFd: sshInfo ? sshInfo.logFd : undefined,
            localPort,
            sshLocalPort: sshInfo ? sshInfo.localPort : undefined,
            remoteDebuggingEnabled
        };
        if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'running' });

        if (settings.dashboardOnLaunch !== false) {
            try {
                const dashUrl = `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}/dashboard?profile=${encodeURIComponent(profileId)}`;
                const page = await browser.newPage();
                await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
                await page.bringToFront();
            } catch (e) { }
        }

        // CDP Geolocation Removed in favor of Stealth JS Hook
        // 由于 CDP 本身会被检测，我们移除所有 Emulation.Overrides
        // 地理位置将由 fingerprint.js 中的 Stealth Hook 接管

        browser.on('disconnected', async () => {
            if (activeProcesses[profileId]) {
                const pid = activeProcesses[profileId].xrayPid;
                const sshPid = activeProcesses[profileId].sshPid;
                const logFd = activeProcesses[profileId].logFd;
                const sshLogFd = activeProcesses[profileId].sshLogFd;

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
