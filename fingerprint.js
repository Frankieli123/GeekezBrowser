const os = require('os');

const RESOLUTIONS = [{ w: 1920, h: 1080 }, { w: 2560, h: 1440 }, { w: 1366, h: 768 }, { w: 1536, h: 864 }, { w: 1440, h: 900 }];

// P0: WebGL 渲染器预设列表（按平台分类）
const WEBGL_CONFIGS = {
    win32: [
        { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
    ],
    darwin: [
        { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' },
        { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
        { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)' }
    ],
    linux: [
        { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1080/PCIe/SSE2, OpenGL 4.6.0)' },
        { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620, OpenGL 4.6)' }
    ]
};

// P0: 常见字体列表（用于字体指纹伪装，按平台分类）
const FONT_CONFIGS = {
    win32: [
        'Arial', 'Arial Black', 'Arial Narrow', 'Book Antiqua', 'Bookman Old Style',
        'Calibri', 'Cambria', 'Cambria Math', 'Century', 'Century Gothic',
        'Comic Sans MS', 'Consolas', 'Courier', 'Courier New', 'Georgia',
        'Impact', 'Lucida Console', 'Lucida Sans Unicode',
        'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Tahoma',
        'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Wingdings'
    ],
    darwin: [
        'American Typewriter', 'Arial', 'Arial Black', 'Arial Narrow', 'Avenir',
        'Courier', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue',
        'Menlo', 'Monaco', 'Optima', 'Palatino', 'Times', 'Times New Roman',
        'Trebuchet MS', 'Verdana'
    ],
    linux: [
        'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif',
        'Liberation Sans', 'Liberation Sans Narrow', 'Liberation Mono', 'Liberation Serif',
        'Noto Sans', 'Noto Sans Mono', 'Noto Serif',
        'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono',
        'Cantarell', 'Arial', 'Courier New', 'Times New Roman'
    ]
};

const DEFAULT_CHROME_VERSIONS = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
const CHROME_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

function resolveChromeVersion(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!CHROME_VERSION_RE.test(v)) return null;
    return v;
}

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateFingerprint(options = {}) {
    // 1. 强制匹配宿主机系统和架构
    const platform = os.platform();
    const arch = os.arch(); // 'arm64' for Apple Silicon, 'x64' for Intel

    let osData = {};

    if (platform === 'win32') {
        osData = { platform: 'Win32' };
    } else if (platform === 'darwin') {
        // Apple Silicon (M1/M2/M3/M4) vs Intel Mac
        // Note: Chrome on ARM Mac still reports 'MacIntel' for compatibility
        // but we need to not fake other signals that would reveal ARM
        osData = { platform: 'MacIntel', isArm: arch === 'arm64' };
    } else {
        osData = { platform: 'Linux x86_64' };
    }

    const res = getRandom(RESOLUTIONS);
    const languages = ['en-US', 'en'];

    const canvasNoise = {
        r: Math.floor(Math.random() * 10) - 5,
        g: Math.floor(Math.random() * 10) - 5,
        b: Math.floor(Math.random() * 10) - 5,
        a: Math.floor(Math.random() * 10) - 5
    };

    // P0: 根据平台选择 WebGL 配置
    const webglConfigs = WEBGL_CONFIGS[platform] || WEBGL_CONFIGS.win32;
    const webgl = getRandom(webglConfigs);

    // P0: 随机选择字体子集（模拟不同系统安装的字体）
    const fontCount = 15 + Math.floor(Math.random() * 10); // 15-24 个字体
    const fontPool = FONT_CONFIGS[platform] || FONT_CONFIGS.win32;
    const shuffledFonts = [...fontPool].sort(() => Math.random() - 0.5);
    const fonts = shuffledFonts.slice(0, Math.min(fontCount, shuffledFonts.length));

    // P1: 生成 User-Agent（根据平台匹配）
    const forcedChromeVersion = resolveChromeVersion(options.chromeVersion) || resolveChromeVersion(process.env.GEEKEZ_CHROME_VERSION);
    const chromeVersion = forcedChromeVersion || getRandom(DEFAULT_CHROME_VERSIONS);
    let userAgent;
    if (platform === 'win32') {
        userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    } else if (platform === 'darwin') {
        userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    } else {
        userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    }

    return {
        platform: osData.platform,
        screen: { width: res.w, height: res.h },
        window: { width: res.w, height: res.h },
        language: 'auto',
        languages: languages,
        hardwareConcurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
        deviceMemory: [2, 4, 8][Math.floor(Math.random() * 3)],
        canvasNoise: canvasNoise,
        audioNoise: Math.random() * 0.000001,
        noiseSeed: Math.floor(Math.random() * 9999999),
        timezone: 'Auto',
        // P0: WebGL 渲染器信息
        webgl: webgl,
        // P0: 字体列表
        fonts: fonts,
        // P1: User-Agent 和 Chrome 版本
        userAgent: userAgent,
        chromeVersion: chromeVersion
    };
}

// 水印样式常量
const WATERMARK_STYLES = {
    banner: 'position: fixed; top: 12px; right: 12px; max-width: min(320px, calc(100vw - 24px)); background: linear-gradient(135deg, rgba(37, 99, 235, 0.92), rgba(79, 70, 229, 0.9)); color: #fff; padding: 8px 36px 8px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; z-index: 2147483647; box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18); display: flex; align-items: center; gap: 8px; font-family: "Segoe UI", monospace; border: 1px solid rgba(255,255,255,0.18); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; backdrop-filter: blur(10px);',
    floating: 'position: fixed; bottom: 16px; right: 16px; background: rgba(15, 23, 42, 0.85); color: rgba(255, 255, 255, 0.9); padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 500; z-index: 2147483647; pointer-events: none; font-family: "Segoe UI", monospace; backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1);'
};

// 注入脚本：包含复杂的时区伪装逻辑
function getInjectScript(fp, profileName, watermarkStyle) {
    const fpJson = JSON.stringify(fp);
    const safeProfileName = (profileName || 'Profile')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    const style = watermarkStyle || 'enhanced';
    return `
    (function() {
        try {
            const __geekezLocalPage = (() => {
                try {
                    const href = String(location && location.href || '');
                    const isLocal = /^(https?:\\/\\/)?(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?(\\/|$)/i.test(href);
                    const isDashboard = /^(https?:\\/\\/)?(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?\\/dashboard(?:[/?#]|$)/i.test(href);
                    return isLocal && !isDashboard;
                } catch (e) {
                    return false;
                }
            })();
            if (__geekezLocalPage) return;

            const fp = ${fpJson};
            const targetTimezone = fp.timezone || "";
            const targetLang = fp.language && fp.language !== 'auto' ? String(fp.language) : '';
            const targetLanguages = Array.isArray(fp.languages) && fp.languages.length
                ? fp.languages.filter(Boolean).map(item => String(item))
                : (targetLang ? [targetLang, targetLang.split('-')[0]].filter((item, index, arr) => item && arr.indexOf(item) === index) : []);
            const normalizePermissionState = (value, fallback) => {
                const current = String(value || '').trim().toLowerCase();
                return ['granted', 'prompt', 'denied'].includes(current) ? current : fallback;
            };
            const permissionStates = {
                geolocation: normalizePermissionState(fp.geoPermissionState, fp.geolocation ? 'granted' : 'prompt'),
                camera: normalizePermissionState(fp.cameraPermissionState, 'prompt'),
                microphone: normalizePermissionState(fp.microphonePermissionState, 'prompt'),
                notifications: normalizePermissionState(fp.notificationPermissionState, 'prompt')
            };
            const geoPermissionState = permissionStates.geolocation;
            const notificationPermission = permissionStates.notifications === 'prompt' ? 'default' : permissionStates.notifications;
            const isTopFrame = (() => {
                try {
                    return window.top === window;
                } catch (e) {
                    return false;
                }
            })();

            // Protection settings (default all enabled)
            const prot = fp.protection || {};
            const isEnabled = (key) => prot[key] !== 'off';

            // --- Global Helper: makeNative ---
            // Makes hooked functions appear as native code to avoid detection
            const makeNative = (func, name) => {
                const nativeStr = 'function ' + name + '() { [native code] }';
                Object.defineProperty(func, 'toString', {
                    value: function() { return nativeStr; },
                    configurable: true,
                    writable: true
                });
                Object.defineProperty(func.toString, 'toString', {
                    value: function() { return 'function toString() { [native code] }'; },
                    configurable: true,
                    writable: true
                });
                if (func.prototype) {
                    Object.defineProperty(func.prototype.constructor, 'toString', {
                        value: function() { return nativeStr; },
                        configurable: true,
                        writable: true
                    });
                }
                return func;
            };

            const createSeededRandom = (seed) => {
                let value = Math.abs(Number(seed) || 1) % 2147483647;
                if (value <= 0) value += 2147483646;
                return () => {
                    value = value * 16807 % 2147483647;
                    return (value - 1) / 2147483646;
                };
            };
            const seededRandom = createSeededRandom(fp.noiseSeed || 1);

            // --- 0. Windows Timezone Fallback ---
            // CDP timezone override is the primary path.
            // Keep a JS-level fallback on Windows so restored startup pages do not
            // observe host timezone before the main process finishes applying CDP.
            const isWindows = navigator.platform && navigator.platform.toLowerCase().includes('win');
            if (isWindows && fp.timezone && fp.timezone !== 'Auto') {
                const tzMakeNative = (func, name) => {
                    const nativeStr = 'function ' + name + '() { [native code] }';
                    func.toString = function() { return nativeStr; };
                    func.toString.toString = function() { return 'function toString() { [native code] }'; };
                    return func;
                };

                const getTimezoneOffsetForZone = (tz) => {
                    try {
                        const now = new Date();
                        const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
                        const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
                        return Math.round((utcDate - tzDate) / 60000);
                    } catch (e) {
                        return new Date().getTimezoneOffset();
                    }
                };

                const targetOffset = getTimezoneOffsetForZone(targetTimezone);

                const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
                Date.prototype.getTimezoneOffset = tzMakeNative(function getTimezoneOffset() {
                    return targetOffset;
                }, 'getTimezoneOffset');

                const OrigDTFProto = Intl.DateTimeFormat.prototype;
                const origResolvedOptions = OrigDTFProto.resolvedOptions;
                OrigDTFProto.resolvedOptions = tzMakeNative(function resolvedOptions() {
                    const result = origResolvedOptions.call(this);
                    result.timeZone = targetTimezone;
                    return result;
                }, 'resolvedOptions');

                ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((methodName) => {
                    const origMethod = Date.prototype[methodName];
                    Date.prototype[methodName] = tzMakeNative(function(...args) {
                        if (args.length === 0) {
                            return origMethod.call(this, undefined, { timeZone: targetTimezone });
                        }
                        if (args.length === 1) {
                            return origMethod.call(this, args[0], { timeZone: targetTimezone });
                        }
                        const opts = args[1] || {};
                        if (!opts.timeZone) opts.timeZone = targetTimezone;
                        return origMethod.call(this, args[0], opts);
                    }, methodName);
                });

                const OrigDateTimeFormat = Intl.DateTimeFormat;
                Intl.DateTimeFormat = function(locales, options) {
                    const opts = options ? { ...options } : {};
                    if (!opts.timeZone) opts.timeZone = targetTimezone;
                    return new OrigDateTimeFormat(locales, opts);
                };
                Intl.DateTimeFormat.prototype = OrigDateTimeFormat.prototype;
                Intl.DateTimeFormat.supportedLocalesOf = OrigDateTimeFormat.supportedLocalesOf.bind(OrigDateTimeFormat);
                tzMakeNative(Intl.DateTimeFormat, 'DateTimeFormat');
            }

            // --- 1. 移除 WebDriver 及 Puppeteer 特征 ---
            if (navigator.webdriver) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            }
            // 移除 cdc_ 变量 (Puppeteer 特征)
            const cdcRegex = /cdc_[a-zA-Z0-9]+/;
            for (const key in window) {
                if (cdcRegex.test(key)) {
                    delete window[key];
                }
            }
            // 防御性移除常见自动化变量
            ['$cdc_asdjflasutopfhvcZLmcfl_', '$chrome_asyncScriptInfo', 'callPhantom', 'webdriver'].forEach(k => {
                 if (window[k]) delete window[k];
            });
            // Only stub window.chrome when missing; overwriting an existing object is detectable.
            try {
                if (!window.chrome) {
                    Object.defineProperty(window, 'chrome', {
                        writable: true,
                        enumerable: true,
                        configurable: false,
                        value: { app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }, runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } } }
                    });
                }
            } catch (e) { }

            // --- 1.5 Screen Resolution Hook ---
            // Override screen properties to match fingerprint values
            if (fp.screen && fp.screen.width && fp.screen.height) {
                const screenWidth = fp.screen.width;
                const screenHeight = fp.screen.height;
                const windowWidth = fp.window && fp.window.width ? fp.window.width : screenWidth;
                const windowHeight = fp.window && fp.window.height ? fp.window.height : screenHeight;
                
                Object.defineProperty(screen, 'width', {
                    get: makeNative(function width() { return screenWidth; }, 'width'),
                    configurable: true
                });
                Object.defineProperty(screen, 'height', {
                    get: makeNative(function height() { return screenHeight; }, 'height'),
                    configurable: true
                });
                Object.defineProperty(screen, 'availWidth', {
                    get: makeNative(function availWidth() { return screenWidth; }, 'availWidth'),
                    configurable: true
                });
                Object.defineProperty(screen, 'availHeight', {
                    get: makeNative(function availHeight() { return screenHeight - 40; }, 'availHeight'),
                    configurable: true
                });
                // Also override window.outerWidth/outerHeight for consistency
                Object.defineProperty(window, 'outerWidth', {
                    get: makeNative(function outerWidth() { return windowWidth; }, 'outerWidth'),
                    configurable: true
                });
                Object.defineProperty(window, 'outerHeight', {
                    get: makeNative(function outerHeight() { return windowHeight; }, 'outerHeight'),
                    configurable: true
                });
            }

            // --- 1.6 Stealthy Hardware Fingerprint Hook (CPU Cores & Memory) ---
            // Override navigator.hardwareConcurrency and navigator.deviceMemory on Navigator.prototype
            // Using the same stealth pattern as timezone hooks to avoid Pixelscan detection
            if (fp.hardwareConcurrency) {
                const targetCores = fp.hardwareConcurrency;
                // Create a getter that returns our value
                const coresGetter = function() { return targetCores; };
                // Apply makeNative to hide the hook
                Object.defineProperty(coresGetter, 'toString', {
                    value: function() { return 'function get hardwareConcurrency() { [native code] }'; },
                    configurable: true, writable: true
                });
                Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
                    get: coresGetter,
                    configurable: true
                });
            }
            
            if (fp.deviceMemory) {
                const targetMemory = fp.deviceMemory;
                const memoryGetter = function() { return targetMemory; };
                Object.defineProperty(memoryGetter, 'toString', {
                    value: function() { return 'function get deviceMemory() { [native code] }'; },
                    configurable: true, writable: true
                });
                Object.defineProperty(Navigator.prototype, 'deviceMemory', {
                    get: memoryGetter,
                    configurable: true
                });
            }

            // --- 2. Stealth Geolocation Hook (Native Mock Pattern) ---
            // 避免使用 Proxy (会被 Pixelscan 识别为 Masking detected)
            // 直接修改 Geolocation.prototype 并确保存根函数通过 native code 检查
            if (typeof Geolocation !== 'undefined' && Geolocation.prototype) {
                const targetGeolocation = fp.geolocation || null;
                const latitude = targetGeolocation ? Number(targetGeolocation.latitude) : NaN;
                const longitude = targetGeolocation ? Number(targetGeolocation.longitude) : NaN;
                const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude);
                const latOffset = hasCoords ? (seededRandom() - 0.5) * 0.0025 : 0;
                const lonOffset = hasCoords ? (seededRandom() - 0.5) * 0.0025 : 0;
                const accuracy = Math.max(25, Number(targetGeolocation && targetGeolocation.accuracy) || 100);
                const geoError = { code: 1, message: geoPermissionState === 'denied' ? 'User denied Geolocation' : 'Geolocation unavailable' };

                const fakeGetCurrentPosition = function getCurrentPosition(success, error, options) {
                    if (geoPermissionState !== 'granted' || !hasCoords) {
                        if (typeof error === 'function') setTimeout(() => error(geoError), 10);
                        return;
                    }
                    const position = {
                        coords: {
                            latitude: latitude + latOffset,
                            longitude: longitude + lonOffset,
                            accuracy: accuracy,
                            altitude: null,
                            altitudeAccuracy: null,
                            heading: null,
                            speed: null
                        },
                        timestamp: Date.now()
                    };
                    // 异步回调
                    setTimeout(() => success(position), 10);
                };

                const fakeWatchPosition = function watchPosition(success, error, options) {
                    if (geoPermissionState !== 'granted' || !hasCoords) {
                        if (typeof error === 'function') setTimeout(() => error(geoError), 10);
                        return 0;
                    }
                    fakeGetCurrentPosition(success, error, options);
                    return Math.floor(Math.random() * 10000) + 1;
                };

                // 应用 Native Mock
                Object.defineProperty(Geolocation.prototype, 'getCurrentPosition', {
                    value: makeNative(fakeGetCurrentPosition, 'getCurrentPosition'),
                    configurable: true,
                    writable: true
                });

                Object.defineProperty(Geolocation.prototype, 'watchPosition', {
                    value: makeNative(fakeWatchPosition, 'watchPosition'),
                    configurable: true,
                    writable: true
                });
            }

            const getPermissionState = (name) => {
                const key = String(name || '').trim().toLowerCase();
                return Object.prototype.hasOwnProperty.call(permissionStates, key) ? permissionStates[key] : '';
            };
            const buildPermissionStatus = (state) => ({
                state: state || 'prompt',
                onchange: null,
                addEventListener: function() {},
                removeEventListener: function() {},
                dispatchEvent: function() { return false; }
            });
            try {
                const permissionsProto = typeof Permissions !== 'undefined' && Permissions.prototype
                    && typeof Permissions.prototype.query === 'function'
                    ? Permissions.prototype
                    : null;
                if (permissionsProto) {
                    const originalPermissionsQuery = permissionsProto.query;
                    permissionsProto.query = makeNative(function query(permissionDesc) {
                        const name = permissionDesc && permissionDesc.name ? String(permissionDesc.name).toLowerCase() : '';
                        const state = getPermissionState(name);
                        if (state) return Promise.resolve(buildPermissionStatus(state));
                        return originalPermissionsQuery.call(this, permissionDesc);
                    }, 'query');
                }
                if (navigator.permissions && typeof navigator.permissions.query === 'function') {
                    const originalPermissionsQuery = navigator.permissions.query.bind(navigator.permissions);
                    navigator.permissions.query = makeNative(function query(permissionDesc) {
                        const name = permissionDesc && permissionDesc.name ? String(permissionDesc.name).toLowerCase() : '';
                        const state = getPermissionState(name);
                        if (state) return Promise.resolve(buildPermissionStatus(state));
                        return originalPermissionsQuery(permissionDesc);
                    }, 'query');
                }
            } catch (e) { }
            try {
                if (typeof Notification !== 'undefined') {
                    Object.defineProperty(Notification, 'permission', {
                        get: makeNative(function permission() { return notificationPermission; }, 'permission'),
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

            // --- 2. Locale / Language Consistency Hook ---
            if (targetLang) {
                const languageGetter = makeNative(function language() { return targetLang; }, 'language');
                const languagesGetter = makeNative(function languages() { return targetLanguages.slice(); }, 'languages');
                try {
                    Object.defineProperty(Navigator.prototype, 'language', {
                        get: languageGetter,
                        configurable: true
                    });
                    Object.defineProperty(Navigator.prototype, 'languages', {
                        get: languagesGetter,
                        configurable: true
                    });
                } catch (e) { }
                try {
                    Object.defineProperty(navigator, 'language', {
                        get: languageGetter,
                        configurable: true
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get: languagesGetter,
                        configurable: true
                    });
                } catch (e) { }

                // Save originals
                const OrigDTF = Intl.DateTimeFormat;
                const OrigNF = Intl.NumberFormat;
                const OrigColl = Intl.Collator;
                const OrigPluralRules = Intl.PluralRules;
                
                // Minimal hook - only inject default locale when not specified
                const hookedDTF = function DateTimeFormat(locales, options) {
                    return new OrigDTF(locales || targetLang, options);
                };
                hookedDTF.prototype = OrigDTF.prototype;
                hookedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);
                Intl.DateTimeFormat = makeNative(hookedDTF, 'DateTimeFormat');
                
                const hookedNF = function NumberFormat(locales, options) {
                    return new OrigNF(locales || targetLang, options);
                };
                hookedNF.prototype = OrigNF.prototype;
                hookedNF.supportedLocalesOf = OrigNF.supportedLocalesOf.bind(OrigNF);
                Intl.NumberFormat = makeNative(hookedNF, 'NumberFormat');
                
                const hookedColl = function Collator(locales, options) {
                    return new OrigColl(locales || targetLang, options);
                };
                hookedColl.prototype = OrigColl.prototype;
                hookedColl.supportedLocalesOf = OrigColl.supportedLocalesOf.bind(OrigColl);
                Intl.Collator = makeNative(hookedColl, 'Collator');

                if (OrigPluralRules) {
                    const hookedPluralRules = function PluralRules(locales, options) {
                        return new OrigPluralRules(locales || targetLang, options);
                    };
                    hookedPluralRules.prototype = OrigPluralRules.prototype;
                    hookedPluralRules.supportedLocalesOf = OrigPluralRules.supportedLocalesOf.bind(OrigPluralRules);
                    Intl.PluralRules = makeNative(hookedPluralRules, 'PluralRules');
                }

                try {
                    const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
                    Intl.DateTimeFormat.prototype.resolvedOptions = makeNative(function resolvedOptions() {
                        const result = origResolvedOptions.call(this);
                        result.locale = targetLang;
                        if (targetTimezone) result.timeZone = targetTimezone;
                        return result;
                    }, 'resolvedOptions');
                } catch (e) { }
            }

            // --- P1: User-Agent 一致性 Hook ---
            // 确保 navigator.userAgent 等属性与启动参数一致
            try {
                if (fp.userAgent) {
                    const targetUA = fp.userAgent;
                    Object.defineProperty(Navigator.prototype, 'userAgent', {
                        get: makeNative(function userAgent() { return targetUA; }, 'userAgent'),
                        configurable: true
                    });
                    Object.defineProperty(Navigator.prototype, 'appVersion', {
                        get: makeNative(function appVersion() { return targetUA.replace('Mozilla/', ''); }, 'appVersion'),
                        configurable: true
                    });
                    if (fp.platform) {
                        Object.defineProperty(Navigator.prototype, 'platform', {
                            get: makeNative(function platform() { return fp.platform; }, 'platform'),
                            configurable: true
                        });
                    }
                }
            } catch (e) { }

            // --- P0: 字体指纹伪装 ---
            // Hook document.fonts.check() 和 Canvas 字体测量
            try {
                if (fp.fonts && Array.isArray(fp.fonts) && fp.fonts.length > 0) {
                    const allowedFonts = fp.fonts.map(f => String(f).toLowerCase());
                    const genericFonts = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'];
                    const probeFonts = [
                        'arial', 'arial black', 'arial narrow', 'calibri', 'cambria', 'cambria math',
                        'consolas', 'courier', 'courier new', 'georgia', 'helvetica', 'helvetica neue',
                        'impact', 'lucida console', 'lucida sans unicode', 'microsoft sans serif',
                        'palatino linotype', 'segoe ui', 'tahoma', 'times', 'times new roman',
                        'trebuchet ms', 'verdana', 'menlo', 'monaco',
                        'dejavu sans', 'dejavu sans mono', 'dejavu serif',
                        'liberation sans', 'liberation mono', 'liberation serif',
                        'ubuntu', 'ubuntu mono', 'cantarell', 'noto sans', 'noto sans mono', 'noto serif'
                    ];

                    if (document.fonts && typeof document.fonts.check === 'function') {
                        const origFontsCheck = document.fonts.check.bind(document.fonts);
                        const hookedFontsCheck = function check(font, text) {
                            try {
                                const fontStr = String(font || '');
                                const fontMatch = fontStr.match(/['""]?([^'""]+)['""]?\\s*$/);
                                if (fontMatch) {
                                    const fontName = fontMatch[1].toLowerCase().trim();
                                    if (!genericFonts.includes(fontName)) {
                                        if (!allowedFonts.includes(fontName) && probeFonts.includes(fontName)) return false;
                                    }
                                }
                            } catch (e) { }
                            return origFontsCheck(font, text);
                        };
                        document.fonts.check = makeNative(hookedFontsCheck, 'check');
                    }
                }
            } catch (e) { }

            // --- P3: 细节指纹伪装 ---
            // 色深
            try {
                if (Number.isFinite(fp.colorDepth)) {
                    const cd = fp.colorDepth;
                    Object.defineProperty(screen, 'colorDepth', {
                        get: makeNative(function colorDepth() { return cd; }, 'colorDepth'),
                        configurable: true
                    });
                    Object.defineProperty(screen, 'pixelDepth', {
                        get: makeNative(function pixelDepth() { return cd; }, 'pixelDepth'),
                        configurable: true
                    });
                }
            } catch (e) { }

            try {
                if (Number.isFinite(fp.pixelRatio)) {
                    const pr = fp.pixelRatio;
                    Object.defineProperty(window, 'devicePixelRatio', {
                        get: makeNative(function devicePixelRatio() { return pr; }, 'devicePixelRatio'),
                        configurable: true
                    });
                }
            } catch (e) { }

            try {
                if (fp.doNotTrack !== undefined && fp.doNotTrack !== null) {
                    const dnt = String(fp.doNotTrack);
                    Object.defineProperty(Navigator.prototype, 'doNotTrack', {
                        get: makeNative(function doNotTrack() { return dnt; }, 'doNotTrack'),
                        configurable: true
                    });
                }
            } catch (e) { }

            try {
                if (fp.maxTouchPoints !== undefined && fp.maxTouchPoints !== null) {
                    const mtp = Number(fp.maxTouchPoints) || 0;
                    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
                        get: makeNative(function maxTouchPoints() { return mtp; }, 'maxTouchPoints'),
                        configurable: true
                    });
                    if (mtp === 0 && ('ontouchstart' in window)) {
                        try { delete window.ontouchstart; } catch (e) { }
                    }
                }
            } catch (e) { }

            try {
                if (fp.battery !== undefined && fp.battery !== null && navigator.getBattery) {
                    const cfg = (fp.battery && typeof fp.battery === 'object') ? fp.battery : {};
                    const fakeBattery = {
                        charging: cfg.charging !== undefined ? !!cfg.charging : true,
                        chargingTime: Number.isFinite(cfg.chargingTime) ? cfg.chargingTime : 0,
                        dischargingTime: Number.isFinite(cfg.dischargingTime) ? cfg.dischargingTime : Infinity,
                        level: Number.isFinite(cfg.level) ? Math.max(0, Math.min(1, cfg.level)) : 1,
                        onchargingchange: null,
                        onchargingtimechange: null,
                        ondischargingtimechange: null,
                        onlevelchange: null,
                        addEventListener: function() {},
                        removeEventListener: function() {}
                    };
                    Object.defineProperty(Navigator.prototype, 'getBattery', {
                        value: makeNative(function getBattery() { return Promise.resolve(fakeBattery); }, 'getBattery'),
                        configurable: true,
                        writable: true
                    });
                }
            } catch (e) { }

            try {
                if (fp.connection && navigator.connection) {
                    const cfg = fp.connection && typeof fp.connection === 'object' ? fp.connection : {};
                    const fakeConnection = {
                        effectiveType: cfg.effectiveType || '4g',
                        downlink: Number.isFinite(cfg.downlink) ? cfg.downlink : 10,
                        rtt: Number.isFinite(cfg.rtt) ? cfg.rtt : 50,
                        saveData: !!cfg.saveData,
                        type: cfg.type || 'wifi',
                        addEventListener: function() {},
                        removeEventListener: function() {}
                    };
                    Object.defineProperty(Navigator.prototype, 'connection', {
                        get: makeNative(function connection() { return fakeConnection; }, 'connection'),
                        configurable: true
                    });
                }
            } catch (e) { }

            // --- 3. Canvas Noise ---
            if (isEnabled('canvasNoise')) {
                const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
                const hookedGetImageData = function getImageData(x, y, w, h) {
                    const imageData = originalGetImageData.apply(this, arguments);
                    if (fp.noiseSeed) {
                        for (let i = 0; i < imageData.data.length; i += 4) {
                            if ((i + fp.noiseSeed) % 53 === 0) {
                                const noise = fp.canvasNoise ? (fp.canvasNoise.a || 0) : 0;
                                imageData.data[i+3] = Math.max(0, Math.min(255, imageData.data[i+3] + noise));
                            }
                        }
                    }
                    return imageData;
                };
                CanvasRenderingContext2D.prototype.getImageData = makeNative(hookedGetImageData, 'getImageData');
            }

            // --- 4. Audio Noise ---
            if (isEnabled('audioNoise')) {
                const originalGetChannelData = AudioBuffer.prototype.getChannelData;
                const hookedGetChannelData = function getChannelData(channel) {
                    const results = originalGetChannelData.apply(this, arguments);
                    const noise = fp.audioNoise || 0.0000001;
                    for (let i = 0; i < 100 && i < results.length; i++) {
                        results[i] = results[i] + noise;
                    }
                    return results;
                };
                AudioBuffer.prototype.getChannelData = makeNative(hookedGetChannelData, 'getChannelData');
            }

            // --- 5. WebRTC Protection ---
            const webrtcMode = prot.webrtcMode || 'privacy';
            if (webrtcMode !== 'real') {
                const originalPC = window.RTCPeerConnection;
                if (webrtcMode === 'disabled') {
                    // Completely disable WebRTC
                    window.RTCPeerConnection = undefined;
                    window.webkitRTCPeerConnection = undefined;
                } else {
                    // Privacy mode: force relay
                    const hookedPC = function RTCPeerConnection(config) {
                        if(!config) config = {};
                        config.iceTransportPolicy = 'relay'; 
                        return new originalPC(config);
                    };
                    hookedPC.prototype = originalPC.prototype;
                    window.RTCPeerConnection = makeNative(hookedPC, 'RTCPeerConnection');
                }
            }

            // --- 6. ClientRects 伪装 (Phase 5) ---
            if (isEnabled('clientRects')) {
                try {
                    // Stable & sub-pixel noise (avoid UI jitter on real sites).
                    // NOTE: Do NOT scale linearly with fp.noiseSeed (can be millions).
                    const seed = (fp.noiseSeed || 1) >>> 0;
                    const rectNoiseScale = 0.00002;
                    const rectNoise = (shift) => ((((seed >>> shift) & 0xff) / 255) - 0.5) * rectNoiseScale;
                    const nx = rectNoise(0);
                    const ny = rectNoise(8);
                    const nw = rectNoise(16);
                    const nh = rectNoise(24);

                    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
                    Element.prototype.getBoundingClientRect = makeNative(function getBoundingClientRect() {
                        const rect = origGetBoundingClientRect.call(this);
                        return new DOMRect(
                            rect.x + nx,
                            rect.y + ny,
                            rect.width ? (rect.width + nw) : rect.width,
                            rect.height ? (rect.height + nh) : rect.height
                        );
                    }, 'getBoundingClientRect');

                    const origGetClientRects = Element.prototype.getClientRects;
                    Element.prototype.getClientRects = makeNative(function getClientRects() {
                        const rects = origGetClientRects.call(this);
                        const DOMRectListProxy = {
                            length: rects.length,
                            item: function(i) { return this[i]; },
                            [Symbol.iterator]: function*() {
                                for (let i = 0; i < this.length; i++) yield this[i];
                            }
                        };
                        for (let i = 0; i < rects.length; i++) {
                            const r = rects[i];
                            DOMRectListProxy[i] = new DOMRect(
                                r.x + nx,
                                r.y + ny,
                                r.width ? (r.width + nw) : r.width,
                                r.height ? (r.height + nh) : r.height
                            );
                        }
                        return DOMRectListProxy;
                    }, 'getClientRects');
                } catch (e) { }
            }

            // --- 7. WebGL 图像噪声 (Phase 5) ---
            if (isEnabled('webglNoise')) {
                try {
                    const origReadPixels = WebGLRenderingContext.prototype.readPixels;
                    WebGLRenderingContext.prototype.readPixels = makeNative(function readPixels(...args) {
                        origReadPixels.apply(this, args);
                        const pixels = args[6];
                        if (pixels && fp.noiseSeed) {
                            for (let i = 0; i < Math.min(pixels.length, 1000); i += 4) {
                                if ((i + fp.noiseSeed) % 47 === 0) {
                                    pixels[i] = Math.max(0, Math.min(255, pixels[i] + ((fp.canvasNoise && fp.canvasNoise.r) || 1)));
                                }
                            }
                        }
                    }, 'readPixels');

                    if (typeof WebGL2RenderingContext !== 'undefined') {
                        const origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
                        WebGL2RenderingContext.prototype.readPixels = makeNative(function readPixels(...args) {
                            origReadPixels2.apply(this, args);
                            const pixels = args[6];
                            if (pixels && fp.noiseSeed) {
                                for (let i = 0; i < Math.min(pixels.length, 1000); i += 4) {
                                    if ((i + fp.noiseSeed) % 47 === 0) {
                                        pixels[i] = Math.max(0, Math.min(255, pixels[i] + ((fp.canvasNoise && fp.canvasNoise.r) || 1)));
                                    }
                                }
                            }
                        }, 'readPixels');
                    }
                } catch (e) { }
            }

            // --- 8. Speech Voices 伪装 (Phase 5) ---
            if (isEnabled('speechVoices')) {
                try {
                    if (window.speechSynthesis) {
                        const fakeVoices = [
                            { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true, default: true, voiceURI: 'Microsoft David - English (United States)' },
                            { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true, default: false, voiceURI: 'Microsoft Zira - English (United States)' },
                            { name: 'Google US English', lang: 'en-US', localService: false, default: false, voiceURI: 'Google US English' }
                        ];
                        
                        speechSynthesis.getVoices = makeNative(function getVoices() {
                            return fakeVoices;
                        }, 'getVoices');
                    }
                } catch (e) { }
            }

            // --- 9. 端口扫描保护 (Phase 5) ---
            if (isEnabled('portScanProtection')) {
                try {
                    const isLocalhost = (url) => {
                        if (!url) return false;
                        const urlStr = typeof url === 'string' ? url : (url.url || url.href || '');
                        return /^(https?:\\/\\/)?(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:\\d+)?/i.test(urlStr);
                    };

                    // 仅阻止“非本地页面”对 localhost 的探测，避免影响本地 dashboard/API 正常工作
                    const isLocalPage = isLocalhost((location && location.origin) ? location.origin : '');

                    // 保护 fetch
                    const origFetch = window.fetch;
                    window.fetch = makeNative(function fetch(url, ...args) {
                        if (!isLocalPage && isLocalhost(url)) {
                            return Promise.reject(new TypeError('Failed to fetch'));
                        }
                        return origFetch.apply(this, [url, ...args]);
                    }, 'fetch');

                    // 保护 WebSocket
                    const OrigWebSocket = window.WebSocket;
                    window.WebSocket = function WebSocket(url, ...args) {
                        if (!isLocalPage && isLocalhost(url)) {
                            throw new DOMException('WebSocket connection failed', 'SecurityError');
                        }
                        return new OrigWebSocket(url, ...args);
                    };
                    window.WebSocket.prototype = OrigWebSocket.prototype;
                    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
                    window.WebSocket.OPEN = OrigWebSocket.OPEN;
                    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
                    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
                    makeNative(window.WebSocket, 'WebSocket');

                    // 保护 XMLHttpRequest
                    const origXHROpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = makeNative(function open(method, url, ...args) {
                        if (!isLocalPage && isLocalhost(url)) {
                            throw new DOMException('Network request failed', 'NetworkError');
                        }
                        return origXHROpen.apply(this, [method, url, ...args]);
                    }, 'open');
                } catch (e) { }
            }

            // --- 10. Media Devices 伪装 ---
            if (isEnabled('mediaDevices')) {
                try {
                    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                        const seededHex = (seed, len) => {
                            let x = (seed >>> 0) || 1;
                            let out = '';
                            for (let i = 0; i < len; i++) {
                                x = (x * 1664525 + 1013904223) >>> 0;
                                out += (x & 0x0f).toString(16);
                            }
                            return out;
                        };

                        const seed = Number.isFinite(fp.noiseSeed) ? fp.noiseSeed : 1;
                        const mkId = (n) => seededHex(seed + n, 64);
                        const mkGroup = (n) => seededHex(seed + n, 32);

                        const shouldRevealLabels = () => permissionStates.microphone === 'granted' || permissionStates.camera === 'granted';

                        const defaultDevices = [
                            { deviceId: 'default', kind: 'audioinput', label: 'Default - Microphone', groupId: 'default' },
                            { deviceId: mkId(1), kind: 'audioinput', label: 'Default - Microphone', groupId: mkGroup(1) },
                            { deviceId: 'default', kind: 'audiooutput', label: 'Default - Speakers', groupId: 'default' },
                            { deviceId: mkId(2), kind: 'audiooutput', label: 'Default - Speakers', groupId: mkGroup(1) },
                            { deviceId: mkId(3), kind: 'videoinput', label: 'Integrated Webcam', groupId: mkGroup(2) }
                        ];

                        const devices = (Array.isArray(fp.mediaDevices) && fp.mediaDevices.length > 0) ? fp.mediaDevices : defaultDevices;
                        const normalized = devices.map((d, index) => ({
                            deviceId: String(d && d.deviceId !== undefined ? d.deviceId : mkId(10 + index)),
                            kind: String(d && d.kind !== undefined ? d.kind : ''),
                            label: String(d && d.label !== undefined ? d.label : ''),
                            groupId: String(d && d.groupId !== undefined ? d.groupId : mkGroup(10 + index)),
                        }));

                        navigator.mediaDevices.enumerateDevices = makeNative(async function enumerateDevices() {
                            const expose = shouldRevealLabels();
                            return normalized.map((d) => {
                                const item = {
                                    deviceId: d.deviceId,
                                    kind: d.kind,
                                    label: expose ? d.label : '',
                                    groupId: d.groupId,
                                };
                                item.toJSON = function() { return { deviceId: item.deviceId, kind: item.kind, label: item.label, groupId: item.groupId }; };
                                return item;
                            });
                        }, 'enumerateDevices');
                    }
                } catch (e) { }
            }

            // --- 11. 浮动水印（显示环境名称）---
            // 根据用户设置选择水印样式
            const watermarkStyle = '${style}';
            
            function createWatermark() {
                try {
                    if (!isTopFrame) return;
                    // 检查是否已存在水印（避免重复创建）
                    if (document.getElementById('geekez-watermark')) return;
                    
                    // 确保 body 存在
                    if (!document.body) {
                        setTimeout(createWatermark, 50);
                        return;
                    }
                    
                    if (watermarkStyle === 'banner') {
                        const banner = document.createElement('div');
                        banner.id = 'geekez-watermark';
                        banner.style.cssText = ${JSON.stringify(WATERMARK_STYLES.banner)};
                        
                        const icon = document.createElement('span');
                        icon.textContent = '🔹';
                        icon.style.cssText = 'font-size: 13px; flex: 0 0 auto;';
                        
                        const text = document.createElement('span');
                        text.textContent = '环境：${safeProfileName}';
                        text.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                        
                        const closeBtn = document.createElement('button');
                        closeBtn.textContent = '×';
                        closeBtn.style.cssText = 'position: absolute; top: 50%; right: 8px; transform: translateY(-50%); background: rgba(255,255,255,0.16); border: none; color: white; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; font-size: 14px; line-height: 1; transition: background 0.2s; font-family: monospace;';
                        closeBtn.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.3)'; };
                        closeBtn.onmouseout = function() { this.style.background = 'rgba(255,255,255,0.2)'; };
                        closeBtn.onclick = function() { banner.style.display = 'none'; };
                        
                        banner.appendChild(icon);
                        banner.appendChild(text);
                        banner.appendChild(closeBtn);
                        document.body.appendChild(banner);
                        
                    } else {
                        const watermark = document.createElement('div');
                        watermark.id = 'geekez-watermark';
                        watermark.style.cssText = 'position: fixed; right: 16px; bottom: 16px; max-width: min(340px, calc(100vw - 24px)); min-height: 42px; padding: 10px 14px 10px 12px; border-radius: 14px; background: linear-gradient(135deg, rgba(15, 23, 42, 0.82), rgba(30, 41, 59, 0.74)); backdrop-filter: blur(12px); color: #e5eefc; font-size: 13px; font-weight: 600; z-index: 2147483647; box-shadow: 0 14px 30px rgba(15, 23, 42, 0.22); display: flex; align-items: center; gap: 10px; font-family: "Segoe UI", monospace; border: 1px solid rgba(148, 163, 184, 0.22); pointer-events: none; user-select: none;';
                        
                        const icon = document.createElement('span');
                        icon.textContent = '●';
                        icon.style.cssText = 'font-size: 12px; color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.55); flex: 0 0 auto;';
                        
                        const textWrap = document.createElement('div');
                        textWrap.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0;';

                        const label = document.createElement('span');
                        label.textContent = 'GeekEZ Profile';
                        label.style.cssText = 'font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(191, 219, 254, 0.82);';

                        const text = document.createElement('span');
                        text.textContent = '${safeProfileName}';
                        text.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

                        watermark.appendChild(icon);
                        textWrap.appendChild(label);
                        textWrap.appendChild(text);
                        watermark.appendChild(textWrap);
                        document.body.appendChild(watermark);
                    }
                    
                } catch(e) { /* 静默失败，不影响页面 */ }
            }
            
            // 立即尝试创建（针对已加载的页面）
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', createWatermark);
            } else {
                createWatermark();
            }

        } catch(e) { console.error("FP Error", e); }
    })();
    `;
}

module.exports = { generateFingerprint, getInjectScript };
