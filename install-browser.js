const { install } = require('@puppeteer/browsers');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 1. 配置
// 这里的 Build ID 对应 Chrome 129 稳定版，与 puppeteer-core v23/24 兼容性较好
const BUILD_ID = '129.0.6668.58'; 
const DOWNLOAD_ROOT = path.join(__dirname, 'resources', 'puppeteer');

// 镜像源地址
const MIRROR_URL = 'https://npmmirror.com/mirrors/chrome-for-testing';

// 2. 网络检测函数
function checkNetwork() {
    return new Promise((resolve) => {
        console.log('🌐 Detecting network environment...');
        // 尝试连接 Google，超时设置为 3秒
        const req = https.get('https://www.google.com', { timeout: 3000 }, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve(false); // 能连上 -> Global
            } else {
                resolve(true); // 连不上 -> China
            }
        });

        req.on('error', () => resolve(true)); // 报错 -> China
        req.on('timeout', () => {
            req.destroy();
            resolve(true); // 超时 -> China
        });
    });
}

// 3. 主逻辑
(async () => {
    // 清理旧目录
    if (fs.existsSync(DOWNLOAD_ROOT)) {
        console.log(`🧹 Cleaning existing directory: ${DOWNLOAD_ROOT}`);
        fs.rmSync(DOWNLOAD_ROOT, { recursive: true, force: true });
    }

    // 检测网络
    const isChina = await checkNetwork();
    
    // 设置下载源
    // 如果是中国，使用 npmmirror；否则传 undefined (使用默认 Google 源)
    const baseUrl = isChina ? MIRROR_URL : undefined;

    if (isChina) {
        console.log('🇨🇳 China network detected. Using npmmirror for acceleration.');
    } else {
        console.log('🌍 Global network detected. Using default Google source.');
    }

    console.log(`⬇️  Downloading Chrome (Build: ${BUILD_ID})...`);

    try {
        const result = await install({
            cacheDir: DOWNLOAD_ROOT,
            browser: 'chrome',
            buildId: BUILD_ID,
            unpack: true,
            baseUrl: baseUrl // 关键参数
        });

        console.log('------------------------------------------------');
        console.log('✅ Chrome downloaded successfully!');
        console.log(`📂 Install Path: ${result.path}`);
        console.log('🚀 Ready to build. Run "npm run build:win" now.');
        console.log('------------------------------------------------');

    } catch (error) {
        console.error('❌ Download failed:', error.message);
        console.error('   Please check your network connection.');
        process.exit(1);
    }
})();