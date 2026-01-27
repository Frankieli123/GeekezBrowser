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
        languages: languages,
        hardwareConcurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
        deviceMemory: [2, 4, 8][Math.floor(Math.random() * 3)],
        canvasNoise: canvasNoise,
        audioNoise: Math.random() * 0.000001,
        noiseSeed: Math.floor(Math.random() * 9999999),
        timezone: "America/Los_Angeles", // 默认值
        // P0: WebGL 渲染器信息
        webgl: webgl,
        // P0: 字体列表
        fonts: fonts,
        // P1: User-Agent 和 Chrome 版本
        userAgent: userAgent,
        chromeVersion: chromeVersion
    };
}

// 注入脚本：包含复杂的时区伪装逻辑
function getInjectScript(fp, profileName, watermarkStyle) {
    const fpJson = JSON.stringify(fp);
    const safeProfileName = (profileName || 'Profile').replace(/[<>"'&]/g, ''); // 防止 XSS
    const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
    return `
    (function() {
        try {
            const fp = ${fpJson};
            const targetTimezone = fp.timezone || "America/Los_Angeles";
            
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

            // --- 0. Stealth Timezone Hook (Windows Only) ---
            // On Windows, TZ env var doesn't work, so we use JS hooks
            // On macOS/Linux, TZ env var works natively, no JS hook needed (avoids detection)
            const isWindows = navigator.platform && navigator.platform.toLowerCase().includes('win');
            if (isWindows && fp.timezone && fp.timezone !== 'Auto') {
                // Helper to make functions appear native
                const tzMakeNative = (func, name) => {
                    const nativeStr = 'function ' + name + '() { [native code] }';
                    func.toString = function() { return nativeStr; };
                    func.toString.toString = function() { return 'function toString() { [native code] }'; };
                    return func;
                };

                // Calculate timezone offset from timezone name
                // This creates a date in the target timezone and compares to UTC
                const getTimezoneOffsetForZone = (tz) => {
                    try {
                        const now = new Date();
                        const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
                        const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
                        return Math.round((utcDate - tzDate) / 60000);
                    } catch (e) {
                        return new Date().getTimezoneOffset(); // Fallback to system
                    }
                };

                const targetOffset = getTimezoneOffsetForZone(targetTimezone);

                // Hook 1: Date.prototype.getTimezoneOffset
                const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
                Date.prototype.getTimezoneOffset = tzMakeNative(function getTimezoneOffset() {
                    return targetOffset;
                }, 'getTimezoneOffset');

                // Hook 2: Intl.DateTimeFormat.prototype.resolvedOptions
                const OrigDTFProto = Intl.DateTimeFormat.prototype;
                const origResolvedOptions = OrigDTFProto.resolvedOptions;
                OrigDTFProto.resolvedOptions = tzMakeNative(function resolvedOptions() {
                    const result = origResolvedOptions.call(this);
                    result.timeZone = targetTimezone;
                    return result;
                }, 'resolvedOptions');

                // Hook 3: Date.prototype.toLocaleString family (with timeZone support)
                const dateMethodsToHook = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'];
                dateMethodsToHook.forEach(methodName => {
                    const origMethod = Date.prototype[methodName];
                    Date.prototype[methodName] = tzMakeNative(function(...args) {
                        // If options provided without timeZone, inject target timeZone
                        if (args.length === 0) {
                            return origMethod.call(this, undefined, { timeZone: targetTimezone });
                        } else if (args.length === 1) {
                            return origMethod.call(this, args[0], { timeZone: targetTimezone });
                        } else {
                            const opts = args[1] || {};
                            if (!opts.timeZone) {
                                opts.timeZone = targetTimezone;
                            }
                            return origMethod.call(this, args[0], opts);
                        }
                    }, methodName);
                });

                // Hook 4: new Intl.DateTimeFormat() constructor - inject default timeZone
                const OrigDateTimeFormat = Intl.DateTimeFormat;
                Intl.DateTimeFormat = function(locales, options) {
                    const opts = options ? { ...options } : {};
                    if (!opts.timeZone) {
                        opts.timeZone = targetTimezone;
                    }
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
            Object.defineProperty(window, 'chrome', {
                writable: true,
                enumerable: true,
                configurable: false,
                value: { app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }, runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } } }
            });

            // --- 1.5 Screen Resolution Hook ---
            // Override screen properties to match fingerprint values
            if (fp.screen && fp.screen.width && fp.screen.height) {
                const screenWidth = fp.screen.width;
                const screenHeight = fp.screen.height;
                
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
                    get: makeNative(function outerWidth() { return screenWidth; }, 'outerWidth'),
                    configurable: true
                });
                Object.defineProperty(window, 'outerHeight', {
                    get: makeNative(function outerHeight() { return screenHeight; }, 'outerHeight'),
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
            if (fp.geolocation) {
                const { latitude, longitude } = fp.geolocation;
                // 精度提升到 500m - 1500m
                const accuracy = 500 + Math.floor(Math.random() * 1000);

                const makeNative = (func, name) => {
                    Object.defineProperty(func, 'toString', {
                        value: function() { return "function " + name + "() { [native code] }"; },
                        configurable: true,
                        writable: true
                    });
                    // 隐藏 toString 自身的 toString
                    Object.defineProperty(func.toString, 'toString', {
                        value: function() { return "function toString() { [native code] }"; },
                        configurable: true,
                        writable: true
                    });
                    return func;
                };

                // 保存原始引用 (虽然我们不打算用它，但为了保险)
                const originalGetCurrentPosition = Geolocation.prototype.getCurrentPosition;

                // 创建伪造函数
                const fakeGetCurrentPosition = function getCurrentPosition(success, error, options) {
                    const position = {
                        coords: {
                            latitude: latitude + (Math.random() - 0.5) * 0.005,
                            longitude: longitude + (Math.random() - 0.5) * 0.005,
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

            // --- 2. Intl API Language Override (Minimal Hook) ---
            // Only hook Intl API to match --lang parameter, don't touch navigator
            if (fp.language && fp.language !== 'auto') {
                const targetLang = fp.language;
                
                // Save originals
                const OrigDTF = Intl.DateTimeFormat;
                const OrigNF = Intl.NumberFormat;
                const OrigColl = Intl.Collator;
                
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

            // --- P0: WebGL 渲染器伪装 ---
            // Hook WebGLRenderingContext.getParameter 返回伪造的 GPU 信息
            try {
                if (fp.webgl && fp.webgl.vendor && fp.webgl.renderer) {
                    const webglVendor = fp.webgl.vendor;
                    const webglRenderer = fp.webgl.renderer;

                    if (typeof WebGLRenderingContext !== 'undefined'
                        && WebGLRenderingContext.prototype
                        && typeof WebGLRenderingContext.prototype.getParameter === 'function') {
                        const origGetParameter = WebGLRenderingContext.prototype.getParameter;
                        const hookedGetParameter = function getParameter(param) {
                            if (param === 37445) return webglVendor;
                            if (param === 37446) return webglRenderer;
                            return origGetParameter.call(this, param);
                        };
                        WebGLRenderingContext.prototype.getParameter = makeNative(hookedGetParameter, 'getParameter');
                    }

                    if (typeof WebGL2RenderingContext !== 'undefined'
                        && WebGL2RenderingContext.prototype
                        && typeof WebGL2RenderingContext.prototype.getParameter === 'function') {
                        const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
                        const hookedGetParameter2 = function getParameter(param) {
                            if (param === 37445) return webglVendor;
                            if (param === 37446) return webglRenderer;
                            return origGetParameter2.call(this, param);
                        };
                        WebGL2RenderingContext.prototype.getParameter = makeNative(hookedGetParameter2, 'getParameter');
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

                    if (typeof CanvasRenderingContext2D !== 'undefined'
                        && CanvasRenderingContext2D.prototype
                        && typeof CanvasRenderingContext2D.prototype.measureText === 'function') {
                        const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
                        const hookedMeasureText = function measureText(text) {
                            const result = origMeasureText.call(this, text);
                            try {
                                const noise = ((fp.noiseSeed || 0) % 100) / 10000;
                                const originalWidth = result.width;
                                Object.defineProperty(result, 'width', {
                                    get: function() { return originalWidth + noise; },
                                    configurable: true
                                });
                            } catch (e) { }
                            return result;
                        };
                        CanvasRenderingContext2D.prototype.measureText = makeNative(hookedMeasureText, 'measureText');
                    }
                }
            } catch (e) { }

            // --- P2: 插件列表伪装 ---
            // Hook navigator.plugins 返回预设的 Chrome 插件
            try {
                (function() {
                    const basePlugins = Array.isArray(fp.plugins) && fp.plugins.length > 0 ? fp.plugins : [
                        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
                        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
                        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 }
                    ];

                    const fakePlugins = basePlugins.map((p) => {
                        const name = (p && p.name) ? String(p.name) : '';
                        const filename = (p && p.filename) ? String(p.filename) : '';
                        const description = (p && p.description) ? String(p.description) : '';
                        const length = (p && Number.isFinite(p.length)) ? p.length : 1;
                        const plugin = { name, filename, description, length };
                        try { Object.defineProperty(plugin, Symbol.toStringTag, { value: 'Plugin', configurable: true }); } catch (e) { }
                        plugin[0] = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' };
                        if (length > 1) plugin[1] = { type: 'application/x-nacl', suffixes: '', description: 'Native Client' };
                        return plugin;
                    });

                    const fakePluginArray = {
                        item: function(i) { return fakePlugins[i] || null; },
                        namedItem: function(name) { return fakePlugins.find(p => p.name === name) || null; },
                        refresh: function() {}
                    };
                    try {
                        Object.defineProperty(fakePluginArray, Symbol.toStringTag, { value: 'PluginArray', configurable: true });
                        fakePluginArray[Symbol.iterator] = function* () { yield* fakePlugins; };
                    } catch (e) { }
                    fakePlugins.forEach((p, i) => { fakePluginArray[i] = p; });
                    try { Object.defineProperty(fakePluginArray, 'length', { value: fakePlugins.length, configurable: true }); } catch (e) { fakePluginArray.length = fakePlugins.length; }

                    try {
                        Object.defineProperty(Navigator.prototype, 'plugins', {
                            get: makeNative(function plugins() { return fakePluginArray; }, 'plugins'),
                            configurable: true
                        });
                    } catch (e) { }
                })();
            } catch (e) { }

            // --- P2: 媒体设备伪装 ---
            // Hook navigator.mediaDevices.enumerateDevices 返回虚拟设备
            try {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
                    const seededHex = (seed, len) => {
                        let x = (seed >>> 0) || 1;
                        let out = '';
                        for (let i = 0; i < len; i++) {
                            x = (x * 1664525 + 1013904223) >>> 0;
                            out += (x & 0x0f).toString(16);
                        }
                        return out;
                    };

                    const seed = Number.isFinite(fp.noiseSeed) ? fp.noiseSeed : Math.floor(Math.random() * 0x7fffffff);
                    const mkId = (n) => seededHex(seed + n, 64);
                    const mkGroup = (n) => seededHex(seed + n, 32);

                    const defaultDevices = [
                        { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' },
                        { deviceId: mkId(1), kind: 'audioinput', label: '', groupId: mkGroup(1) },
                        { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' },
                        { deviceId: mkId(2), kind: 'audiooutput', label: '', groupId: mkGroup(1) },
                        { deviceId: mkId(3), kind: 'videoinput', label: '', groupId: mkGroup(2) }
                    ];

                    const devices = (Array.isArray(fp.mediaDevices) && fp.mediaDevices.length > 0) ? fp.mediaDevices : defaultDevices;

                    const hookedEnumerateDevices = async function enumerateDevices() {
                        return devices.map(d => ({
                            deviceId: String(d.deviceId || ''),
                            kind: String(d.kind || ''),
                            label: String(d.label || ''),
                            groupId: String(d.groupId || ''),
                            toJSON: function() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; }
                        }));
                    };
                    navigator.mediaDevices.enumerateDevices = makeNative(hookedEnumerateDevices, 'enumerateDevices');
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
                    const rectsNoise = () => (Math.random() - 0.5) * 0.00001 * (fp.noiseSeed || 1);
                    
                    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
                    Element.prototype.getBoundingClientRect = makeNative(function getBoundingClientRect() {
                        const rect = origGetBoundingClientRect.call(this);
                        return new DOMRect(
                            rect.x + rectsNoise(),
                            rect.y + rectsNoise(),
                            rect.width + rectsNoise(),
                            rect.height + rectsNoise()
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
                                r.x + rectsNoise(), r.y + rectsNoise(),
                                r.width + rectsNoise(), r.height + rectsNoise()
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

                    // 保护 fetch
                    const origFetch = window.fetch;
                    window.fetch = makeNative(function fetch(url, ...args) {
                        if (isLocalhost(url)) {
                            return Promise.reject(new TypeError('Failed to fetch'));
                        }
                        return origFetch.apply(this, [url, ...args]);
                    }, 'fetch');

                    // 保护 WebSocket
                    const OrigWebSocket = window.WebSocket;
                    window.WebSocket = function WebSocket(url, ...args) {
                        if (isLocalhost(url)) {
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
                        if (isLocalhost(url)) {
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
                        const fakeDevices = [
                            { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' },
                            { deviceId: crypto.randomUUID ? crypto.randomUUID() : 'audio-' + fp.noiseSeed, kind: 'audioinput', label: 'Default - Microphone', groupId: 'audio1' },
                            { deviceId: crypto.randomUUID ? crypto.randomUUID() : 'audioout-' + fp.noiseSeed, kind: 'audiooutput', label: 'Default - Speakers', groupId: 'audio1' },
                            { deviceId: crypto.randomUUID ? crypto.randomUUID() : 'video-' + fp.noiseSeed, kind: 'videoinput', label: 'Integrated Webcam', groupId: 'video1' }
                        ];
                        
                        navigator.mediaDevices.enumerateDevices = makeNative(async function enumerateDevices() {
                            return fakeDevices.map(d => ({
                                deviceId: d.deviceId,
                                kind: d.kind,
                                label: d.label,
                                groupId: d.groupId,
                                toJSON: () => d
                            }));
                        }, 'enumerateDevices');
                    }
                } catch (e) { }
            }

            // --- 11. 浮动水印（显示环境名称）---
            // 根据用户设置选择水印样式
            const watermarkStyle = '${style}';
            
            function createWatermark() {
                try {
                    // 检查是否已存在水印（避免重复创建）
                    if (document.getElementById('geekez-watermark')) return;
                    
                    // 确保 body 存在
                    if (!document.body) {
                        setTimeout(createWatermark, 50);
                        return;
                    }
                    
                    if (watermarkStyle === 'banner') {
                        // 方案1: 顶部横幅
                        const banner = document.createElement('div');
                        banner.id = 'geekez-watermark';
                        banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: linear-gradient(135deg, rgba(102, 126, 234, 0.5), rgba(118, 75, 162, 0.5)); backdrop-filter: blur(10px); color: white; padding: 5px 20px; text-align: center; font-size: 12px; font-weight: 500; z-index: 2147483647; box-shadow: 0 2px 10px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: center; gap: 8px; font-family: monospace;';
                        
                        const icon = document.createElement('span');
                        icon.textContent = '🔹';
                        icon.style.cssText = 'font-size: 14px;';
                        
                        const text = document.createElement('span');
                        text.textContent = '环境：${safeProfileName}';
                        
                        const closeBtn = document.createElement('button');
                        closeBtn.textContent = '×';
                        closeBtn.style.cssText = 'position: absolute; right: 10px; background: rgba(255,255,255,0.2); border: none; color: white; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; transition: background 0.2s; font-family: monospace;';
                        closeBtn.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.3)'; };
                        closeBtn.onmouseout = function() { this.style.background = 'rgba(255,255,255,0.2)'; };
                        closeBtn.onclick = function() { banner.style.display = 'none'; };
                        
                        banner.appendChild(icon);
                        banner.appendChild(text);
                        banner.appendChild(closeBtn);
                        document.body.appendChild(banner);
                        
                    } else {
                        // 方案5: 增强水印 (默认)
                        const watermark = document.createElement('div');
                        watermark.id = 'geekez-watermark';
                        watermark.style.cssText = 'position: fixed; bottom: 16px; right: 16px; background: linear-gradient(135deg, rgba(102, 126, 234, 0.5), rgba(118, 75, 162, 0.5)); backdrop-filter: blur(10px); color: white; padding: 10px 16px; border-radius: 8px; font-size: 15px; font-weight: 600; z-index: 2147483647; pointer-events: none; user-select: none; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); display: flex; align-items: center; gap: 8px; font-family: monospace; animation: geekez-pulse 2s ease-in-out infinite;';
                        
                        const icon = document.createElement('span');
                        icon.textContent = '🎯';
                        icon.style.cssText = 'font-size: 18px; animation: geekez-rotate 3s linear infinite;';
                        
                        const text = document.createElement('span');
                        text.textContent = '${safeProfileName}';
                        
                        watermark.appendChild(icon);
                        watermark.appendChild(text);
                        document.body.appendChild(watermark);
                        
                        // 添加动画样式
                        if (!document.getElementById('geekez-watermark-styles')) {
                            const style = document.createElement('style');
                            style.id = 'geekez-watermark-styles';
                            style.textContent = '@keyframes geekez-pulse { 0%, 100% { box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); } 50% { box-shadow: 0 4px 25px rgba(102, 126, 234, 0.6); } } @keyframes geekez-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
                            document.head.appendChild(style);
                        }
                        
                        // 自适应颜色函数（保留之前的功能）
                        function updateWatermarkColor() {
                            try {
                                const rect = watermark.getBoundingClientRect();
                                const x = rect.left + rect.width / 2;
                                const y = rect.top + rect.height / 2;
                                
                                watermark.style.display = 'none';
                                const elementBelow = document.elementFromPoint(x, y) || document.body;
                                watermark.style.display = '';
                                
                                const bgColor = window.getComputedStyle(elementBelow).backgroundColor;
                                const rgb = bgColor.match(/\\d+/g);
                                
                                if (rgb && rgb.length >= 3) {
                                    const r = parseInt(rgb[0]);
                                    const g = parseInt(rgb[1]);
                                    const b = parseInt(rgb[2]);
                                    const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
                                    
                                    // 保持渐变背景，统一使用50%透明度
                                    watermark.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3)';
                                }
                            } catch(e) { /* 忽略错误 */ }
                        }
                        
                        setTimeout(updateWatermarkColor, 100);
                        
                        let colorUpdateTimer;
                        function scheduleColorUpdate() {
                            clearTimeout(colorUpdateTimer);
                            colorUpdateTimer = setTimeout(updateWatermarkColor, 200);
                        }
                        
                        window.addEventListener('scroll', scheduleColorUpdate, { passive: true });
                        window.addEventListener('resize', scheduleColorUpdate, { passive: true });
                        
                        const observer = new MutationObserver(scheduleColorUpdate);
                        observer.observe(document.body, { 
                            attributes: true, 
                            attributeFilter: ['style', 'class'],
                            subtree: true 
                        });
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
