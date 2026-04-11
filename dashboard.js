const profileId = window.__PROFILE_ID__ || '';
const apiBase = location.origin;
const $ = (id) => document.getElementById(id);

let totpTimer = null;
let currentSecret = null;
let currentProfile = null;
let currentRuntime = null;
let currentDiagnostics = null;
let currentLiveSelfCheck = null;
let currentProxyTest = null;

const dashboardTranslations = {
  cn: {
    'page.title': 'GeekEZ 仪表盘',
    'brand.runtimeConsole': 'GeekEZ 运行时控制台',
    'page.dashboard': '仪表盘',
    'meta.profile': '环境',
    'meta.api': 'API',
    'meta.ip': 'IP',
    'meta.lastUpdated': '最近刷新',
    'common.copy': '复制',
    'common.ssh': 'SSH',
    'common.none': '未提供',
    'common.expected': '期望',
    'common.actual': '实际',
    'common.ruleUnit': '条规则',
    'common.secondsShort': '秒',
    'button.refreshAll': '刷新全部',
    'button.refreshIp': '刷新 IP',
    'button.refreshNetinfo': '刷新网络信息',
    'button.testProxy': '测试代理',
    'button.restartSsh': '重连 SSH',
    'button.restartProfile': '重启实例',
    'button.copyWs': '复制 WS',
    'button.copy': '复制',
    'button.copyIp': '复制 IP',
    'button.copyProxy': '复制代理',
    'button.copyProfileId': '复制环境ID',
    'button.runAll': '运行全部',
    'button.clearHistory': '清空记录',
    'button.close': '关闭',
    'button.rerun': '重跑',
    'button.applyPixelscanCompat': '应用兼容预设',
    'link.open2faShow': '打开 2fa.show',
    'button.busy.refreshing': '刷新中...',
    'button.busy.testing': '测试中...',
    'button.busy.running': '运行中...',
    'button.busy.clearing': '清空中...',
    'button.busy.reconnecting': '重连中...',
    'button.busy.applying': '应用中...',
    'button.busy.restarting': '重启中...',
    'hero.proxyExit': '代理出口',
    'hero.proxy': '代理',
    'hero.instanceStatus': '实例状态',
    'hero.proxyType': '代理类型',
    'hero.sshStatus': 'SSH 状态',
    'hero.sshUnused': '当前未使用 SSH 代理',
    'hero.profileId': '环境ID',
    'card.geoAsn': '地理 / ASN',
    'card.netinfo': '网络信息',
    'card.connectivity': '连接能力',
    'card.runtimeDebug': '运行 / 调试',
    'card.profileMetadata': '环境元数据',
    'card.profileInfo': '环境信息',
    'card.accountTools': '账号工具',
    'card.account2fa': '账号 / 2FA',
    'card.unifiedVerdict': '统一判定',
    'card.unifiedVerdictCn': '统一判定',
    'card.selfCheck': '自检',
    'card.diagnosticWorkbench': '检测工作台',
    'card.detectionPresets': '检测预设',
    'card.thirdPartySites': '第三方检测站',
    'card.recentRuns': '最近记录',
    'card.recentRunsCn': '最近检测记录',
    'card.advancedDiagnostics': '高级诊断',
    'card.rawInfo': '原始信息',
    'card.diagnosticDetails': '检测详情',
    'field.name': '名称',
    'field.source': '来源',
    'field.runtime': '运行时',
    'field.launch': '启动',
    'field.location': '位置',
    'field.language': '语言',
    'field.geolocation': '地理位置',
    'field.timezone': '时区',
    'field.asnOrg': 'ASN / 组织',
    'field.coordinates': '坐标',
    'field.postal': '邮编',
    'field.proxyTest': '代理测试',
    'field.testLatency': '测试延迟',
    'field.lastTest': '最近测试',
    'field.resolvedTimezone': '解析时区',
    'field.resolvedLanguage': '解析语言',
    'field.resolvedGeo': '解析地理位置',
    'field.wsEndpoint': 'WS 端点',
    'field.httpEndpoint': 'HTTP 端点',
    'field.debugPort': '调试端口',
    'field.localPort': '本地端口',
    'field.sshLocalPort': 'SSH 本地端口',
    'field.geoPermission': '地理位置权限',
    'field.cameraPermission': '摄像头权限',
    'field.microphonePermission': '麦克风权限',
    'field.notificationPermission': '通知权限',
    'field.headerPreset': '请求头预设',
    'field.calibration': '自动校准',
    'field.createdAt': '创建时间',
    'field.remark': '备注',
    'field.preProxyOverride': '前置代理覆盖',
    'field.tags': '标签',
    'field.email': '邮箱',
    'field.auxEmail': '辅助邮箱',
    'field.otpCode': '动态码',
    'field.remaining': '剩余',
    'field.local': '本地',
    'field.external': '外部',
    'field.agreement': '一致性',
    'field.headerRules': '请求头规则',
    'field.clientHints': '客户端提示',
    'field.fonts': '字体',
    'field.mediaDevices': '媒体设备',
    'field.graphicsFingerprint': '图形指纹',
    'field.requestUserAgent': '请求 User-Agent',
    'field.navigatorUserAgent': '浏览器 UA (navigator.userAgent)',
    'field.navigatorPlatform': '平台 (navigator.platform)',
    'field.navigatorLanguage': '语言 (navigator.language)',
    'field.navigatorLanguages': '语言列表 (navigator.languages)',
    'field.intlTimezone': '时区 (Intl.timeZone)',
    'field.permissionGeoQuery': '地理位置权限 (permissions.query(geolocation))',
    'field.permissionCameraQuery': '摄像头权限 (permissions.query(camera))',
    'field.permissionMicrophoneQuery': '麦克风权限 (permissions.query(microphone))',
    'field.permissionNotificationsQuery': '通知权限 (permissions.query(notifications))',
    'field.notificationPermissionApi': '通知权限 (Notification.permission)',
    'field.requestUserAgentHeader': '请求 UA (Request User-Agent)',
    'field.acceptLanguageHeader': '语言请求头 (Accept-Language)',
    'field.userAgentData': 'UA Client Hints (navigator.userAgentData)',
    'field.userAgentDataHighEntropy': '高熵 UA 提示 (userAgentData.getHighEntropyValues)',
    'field.userAgentDataPlatform': 'UA 平台 (userAgentData.platform)',
    'field.userAgentDataMobile': 'UA 移动标记 (userAgentData.mobile)',
    'field.userAgentDataBrands': 'UA 品牌列表 (userAgentData.brands)',
    'field.userAgentDataFullVersion': 'UA 完整版本 (userAgentData.uaFullVersion)',
    'field.userAgentDataArchitecture': 'UA 架构 (userAgentData.architecture)',
    'field.userAgentDataBitness': 'UA 位数 (userAgentData.bitness)',
    'field.userAgentDataPlatformVersion': 'UA 平台版本 (userAgentData.platformVersion)',
    'field.userAgentDataWow64': 'UA Wow64 (userAgentData.wow64)',
    'field.secChUaHeader': '客户端提示 UA (Sec-CH-UA)',
    'field.secChUaMobileHeader': '客户端提示移动标记 (Sec-CH-UA-Mobile)',
    'field.secChUaPlatformHeader': '客户端提示平台 (Sec-CH-UA-Platform)',
    'field.secChUaFullVersionListHeader': '客户端提示完整版本列表 (Sec-CH-UA-Full-Version-List)',
    'field.secChUaArchHeader': '客户端提示架构 (Sec-CH-UA-Arch)',
    'field.secChUaBitnessHeader': '客户端提示位数 (Sec-CH-UA-Bitness)',
    'field.secChUaPlatformVersionHeader': '客户端提示平台版本 (Sec-CH-UA-Platform-Version)',
    'field.secChUaWow64Header': '客户端提示 Wow64 (Sec-CH-UA-Wow64)',
    'field.navigatorGeolocation': '地理位置 API (navigator.geolocation)',
    'field.mediaDevicesEnumerate': '媒体设备枚举 (mediaDevices.enumerateDevices)',
    'field.documentFontsCheck': '字体检测 (document.fonts.check)',
    'field.navigatorGpu': '图形适配器 (navigator.gpu)',
    'field.browserSelfCheck': '浏览器自检',
    'section.latestExternalRun': '最近一次外部检测',
    'section.siteStatuses': '站点状态',
    'section.keyWarnings': '关键告警',
    'section.headerPreview': '请求头预览',
    'section.permissionSnapshot': '权限快照',
    'section.acceptChProbe': 'Accept-CH 探针',
    'section.webgpuSnapshot': 'WebGPU 快照',
    'section.fontsSnapshot': '字体快照',
    'section.mediaDevicesSnapshot': '媒体设备快照',
    'section.latestByPreset': '各预设最新结果',
    'section.fingerprintConfig': '指纹配置',
    'section.browserInfo': '浏览器信息',
    'section.summary': '摘要',
    'section.structuredFacts': '结构化字段',
    'section.comparison': '对比',
    'section.artifacts': '归档',
    'section.rawJson': '原始 JSON',
    'section.pixelscanFix': 'Pixelscan 修复建议',
    'status.ok': '正常',
    'status.warn': '告警',
    'status.info': '信息',
    'status.running': '运行中',
    'status.stopped': '未运行',
    'status.connected': '已连接',
    'status.disconnected': '已断开',
    'status.reconnecting': '重连中',
    'status.notEnabled': '未启用',
    'status.na': 'N/A',
    'status.direct': '直连',
    'status.failed': '失败',
    'status.okRuntime': '正常 · 运行中',
    'status.okStandalone': '正常 · 独立测试',
    'status.untested': '未测试',
    'status.error': '错误',
    'agreement.match': '一致',
    'agreement.mismatch': '不一致',
    'agreement.local': '仅本地',
    'agreement.pending': '待补充',
    'agreement.partial': '部分一致',
    'permission.granted': '已允许',
    'permission.prompt': '询问',
    'permission.denied': '已拒绝',
    'permission.unsupported': '不支持',
    'permission.unknown': '未知',
    'permission.error': '错误',
    'source.runtime': '运行时',
    'source.browser': '浏览器',
    'source.external': '外部',
    'empty.structuredFacts': '暂无结构化字段',
    'empty.comparison': '暂无对比结果',
    'empty.selectRun': '请选择一条最近检测记录查看详情',
    'empty.summary': '暂无摘要',
    'empty.selfCheck': '暂无自检结果',
    'empty.latestRun': '暂无外部检测结果',
    'empty.siteStatuses': '暂无站点状态',
    'empty.keyWarnings': '暂无关键告警',
    'empty.presets': '暂无预设',
    'empty.latestByPreset': '每个检测站最新结果会显示在这里',
    'empty.recentRuns': '还没有打开过检测预设',
    'empty.noPresetFacts': '暂无预设信息',
    'modal.diagnosticDetailTitle': '检测详情',
    'modal.detailSite': '站点',
    'modal.detailStatus': '状态',
    'modal.detailOpenedAt': '打开时间',
    'modal.detailCapturedAt': '采集时间',
    'artifact.details': '详情',
    'artifact.screenshot': '截图',
    'artifact.html': 'HTML',
    'artifact.text': '文本',
    'artifact.json': 'JSON',
    'message.detailNotFound': '未找到该次检测详情',
    'message.detailRenderFailed': '详情渲染失败',
    'message.detailRenderFailedWithReason': '详情渲染失败：{{reason}}',
    'message.sourceValue': '来源: {{value}}',
    'message.notBound': '未绑定',
    'message.notSet': '未设置',
    'message.available': '可用',
    'message.unsupported': '不支持',
    'message.probeUnavailable': '探针不可用',
    'message.highEntropyCaptured': '已捕获高熵请求提示头',
    'message.highEntropyMissing': '缺少高熵请求提示头',
    'message.noConfiguredFontSample': '未配置字体样本',
    'message.noConfiguredFonts': '未配置字体',
    'message.fontsApiUnavailable': '字体 API 不可用',
    'message.mediaDevicesUnavailable': '媒体设备 API 不可用',
    'message.webgpuUnavailable': 'WebGPU 不可用',
    'message.adapterAcquired': '已获取适配器',
    'message.adapterNull': 'requestAdapter 返回空值',
    'message.missingUserAgentMetadata': '缺少 userAgentMetadata',
    'message.defaultSyntheticDeviceSet': '使用默认合成设备集',
    'message.noExplicitGraphicsFingerprint': '未显式配置图形指纹',
    'message.missingCoordinates': '缺少坐标',
    'message.coordinatesStillExposed': '坐标仍然暴露',
    'message.coordinatesWithheld': '坐标已隐藏',
    'message.browserSelfCheckWarnings': '浏览器自检报告了告警。',
    'message.browserSelfCheckMismatch': '浏览器自检发现不一致。',
    'message.externalRiskSignal': '外部检测报告了风险信号。',
    'message.configuredCount': '{{count}} 项已配置',
    'message.customDevicesCount': '{{count}} 个自定义设备',
    'message.rulesCountSuffix': '{{count}} 条规则',
    'message.sampleCount': '样本={{count}}',
    'message.availableCount': '可用={{count}}',
    'message.featureCount': '特性={{count}}',
    'message.noRecentExternalRuns': '暂无最近外部检测',
    'message.allLocalChecksPassed': '本地检查全部通过',
    'message.notRun': '未运行',
    'message.waitMoreExternal': '等待更多外部验证',
    'message.localAvailableNoExternal': '本地自检可用，但还没有足够的外部检测结果。',
    'message.localAndExternalRisk': '本地与外部检测都出现风险信号',
    'message.localWarnExternalRiskSummary': '本地告警 {{localCount}} 项；外部风险 {{externalCount}} 项。',
    'message.localSelfCheckAbnormal': '本地自检出现异常',
    'message.externalRiskHeadline': '外部检测站报告了风险信号',
    'message.localExternalAligned': '本地自检与外部检测基本一致',
    'message.localOkExternalCount': '本地通过；外部通过 {{okCount}} 项{{techSuffix}}。',
    'message.localOkOnly': '本地自检通过',
    'message.localOkExternalPartial': '本地自检通过，外部检测部分失败',
    'message.notRunExternalYet': '尚未运行外部检测站，或外部结果仍为中性信息。',
    'message.technicalFailuresSuffix': '，另有 {{count}} 项技术失败',
    'message.externalTechnicalIssue': '外部 · 技术问题',
    'message.localPrefix': '本地',
    'message.externalPrefix': '外部',
    'message.vsPrevious': '对比上次：{{summary}}',
    'message.geolocationUnavailable': '地理位置 API 不可用',
    'message.timeout': '超时',
    'message.geolocationError': '地理位置错误',
    'message.profileParamMissing': '缺少 profile 参数（例如 /dashboard?profile=<id>）',
    'message.profileNotRunning': '环境未运行',
    'message.profileNotFound': '环境不存在',
    'message.clearDiagnosticsConfirm': '清空当前环境的检测历史和归档快照？',
    'message.sshDisconnectedRecover': 'SSH 隧道已断开，可点击“重连 SSH”恢复。',
    'message.sshReconnecting': 'SSH 正在重连，恢复后会自动刷新运行态。',
    'message.sshNotProxy': '当前代理不是 SSH',
    'message.sshTunnelHealthy': 'SSH 隧道正常',
    'message.sshForwardPort': '本地动态转发端口 {{port}}',
    'message.sshReconnectingHint': '正在重新建立 SSH 动态转发',
    'message.sshStoppedHint': 'SSH 隧道已断开，可手动重连',
    'message.restartProfileConfirm': '即将重启当前环境，所有页面会被关闭。继续？',
    'message.restartProfileScheduled': '已调度重启（页面即将关闭）。如需继续查看，请重开仪表盘。',
    'message.errorSelfCheck': '浏览器自检',
    'message.openedAt': '打开于 {{time}}',
    'message.pixelscanCompatConfirm': '将为当前环境应用 Pixelscan 兼容预设：关闭画布/音频/WebGL 噪声、ClientRects、SpeechVoices。需要重启环境后才会生效。继续？',
    'message.pixelscanCompatApplied': '已应用 Pixelscan 兼容预设（需要重启环境后生效）。',
    'message.pixelscanMaskingHint': 'Pixelscan 检测到“伪装痕迹”。通常由画布/音频/WebGL 噪声与布局噪声等保护项导致。可先应用兼容预设验证告警是否消失，再按需要逐项开启。',
    'message.pixelscanWarnHint': 'Pixelscan 报告指纹不一致。建议先应用兼容预设验证是否由保护项导致，再逐项恢复以找到触发源。',
  },
  en: {
    'page.title': 'GeekEZ Dashboard',
    'brand.runtimeConsole': 'GeekEZ Runtime Console',
    'page.dashboard': 'Dashboard',
    'meta.profile': 'Profile',
    'meta.api': 'API',
    'meta.ip': 'IP',
    'meta.lastUpdated': 'Last updated',
    'common.copy': 'Copy',
    'common.ssh': 'SSH',
    'common.none': 'none',
    'common.expected': 'expected',
    'common.actual': 'actual',
    'common.ruleUnit': 'rules',
    'common.secondsShort': 's',
    'button.refreshAll': 'Refresh All',
    'button.refreshIp': 'Refresh IP',
    'button.refreshNetinfo': 'Refresh Netinfo',
    'button.testProxy': 'Test Proxy',
    'button.restartSsh': 'Reconnect SSH',
    'button.restartProfile': 'Restart Profile',
    'button.copyWs': 'Copy WS',
    'button.copy': 'Copy',
    'button.copyIp': 'Copy IP',
    'button.copyProxy': 'Copy Proxy',
    'button.copyProfileId': 'Copy ProfileID',
    'button.runAll': 'Run All',
    'button.clearHistory': 'Clear History',
    'button.close': 'Close',
    'button.rerun': 'Rerun',
    'button.applyPixelscanCompat': 'Apply Compat Preset',
    'link.open2faShow': 'Open 2fa.show',
    'button.busy.refreshing': 'Refreshing...',
    'button.busy.testing': 'Testing...',
    'button.busy.running': 'Running...',
    'button.busy.clearing': 'Clearing...',
    'button.busy.reconnecting': 'Reconnecting...',
    'button.busy.applying': 'Applying...',
    'button.busy.restarting': 'Restarting...',
    'hero.proxyExit': 'Proxy Exit',
    'hero.proxy': 'Proxy',
    'hero.instanceStatus': 'Instance Status',
    'hero.proxyType': 'Proxy Type',
    'hero.sshStatus': 'SSH Status',
    'hero.sshUnused': 'SSH proxy is not in use',
    'hero.profileId': 'ProfileID',
    'card.geoAsn': 'Geo / ASN',
    'card.netinfo': 'Network Info',
    'card.connectivity': 'Connectivity',
    'card.runtimeDebug': 'Runtime / Debug',
    'card.profileMetadata': 'Profile Metadata',
    'card.profileInfo': 'Profile Info',
    'card.accountTools': 'Account Tools',
    'card.account2fa': 'Account / 2FA',
    'card.unifiedVerdict': 'Unified Verdict',
    'card.unifiedVerdictCn': 'Unified Verdict',
    'card.selfCheck': 'Self-check',
    'card.diagnosticWorkbench': 'Diagnostic Workbench',
    'card.detectionPresets': 'Detection Presets',
    'card.thirdPartySites': 'Third-party Detection Sites',
    'card.recentRuns': 'Recent Runs',
    'card.recentRunsCn': 'Recent Runs',
    'card.advancedDiagnostics': 'Advanced Diagnostics',
    'card.rawInfo': 'Raw Info',
    'card.diagnosticDetails': 'Diagnostic Details',
    'field.name': 'Name',
    'field.source': 'Source',
    'field.runtime': 'Runtime',
    'field.launch': 'Launch',
    'field.location': 'Location',
    'field.language': 'Language',
    'field.geolocation': 'Geolocation',
    'field.timezone': 'Timezone',
    'field.asnOrg': 'ASN / Org',
    'field.coordinates': 'Coordinates',
    'field.postal': 'Postal',
    'field.proxyTest': 'Proxy Test',
    'field.testLatency': 'Latency',
    'field.lastTest': 'Last Test',
    'field.resolvedTimezone': 'Resolved TZ',
    'field.resolvedLanguage': 'Resolved Lang',
    'field.resolvedGeo': 'Resolved Geo',
    'field.wsEndpoint': 'WS Endpoint',
    'field.httpEndpoint': 'HTTP Endpoint',
    'field.debugPort': 'Debug Port',
    'field.localPort': 'Local Port',
    'field.sshLocalPort': 'SSH Local Port',
    'field.geoPermission': 'Geo Permission',
    'field.cameraPermission': 'Camera Permission',
    'field.microphonePermission': 'Microphone Permission',
    'field.notificationPermission': 'Notification Permission',
    'field.headerPreset': 'Header Preset',
    'field.calibration': 'Calibration',
    'field.createdAt': 'Created At',
    'field.remark': 'Remark',
    'field.preProxyOverride': 'Pre-proxy Override',
    'field.tags': 'Tags',
    'field.email': 'Email',
    'field.auxEmail': 'Aux Email',
    'field.otpCode': 'OTP',
    'field.remaining': 'Remaining',
    'field.local': 'Local',
    'field.external': 'External',
    'field.agreement': 'Agreement',
    'field.headerRules': 'Header Rules',
    'field.clientHints': 'Client Hints',
    'field.fonts': 'Fonts',
    'field.mediaDevices': 'Media Devices',
    'field.graphicsFingerprint': 'Graphics Fingerprint',
    'field.requestUserAgent': 'Request User-Agent',
    'field.navigatorUserAgent': 'Browser UA (navigator.userAgent)',
    'field.navigatorPlatform': 'Platform (navigator.platform)',
    'field.navigatorLanguage': 'Language (navigator.language)',
    'field.navigatorLanguages': 'Languages (navigator.languages)',
    'field.intlTimezone': 'Timezone (Intl.timeZone)',
    'field.permissionGeoQuery': 'Geolocation Permission (permissions.query(geolocation))',
    'field.permissionCameraQuery': 'Camera Permission (permissions.query(camera))',
    'field.permissionMicrophoneQuery': 'Microphone Permission (permissions.query(microphone))',
    'field.permissionNotificationsQuery': 'Notification Permission (permissions.query(notifications))',
    'field.notificationPermissionApi': 'Notification Permission (Notification.permission)',
    'field.requestUserAgentHeader': 'Request UA (Request User-Agent)',
    'field.acceptLanguageHeader': 'Language Header (Accept-Language)',
    'field.userAgentData': 'UA Client Hints (navigator.userAgentData)',
    'field.userAgentDataHighEntropy': 'High-entropy UA Hints (userAgentData.getHighEntropyValues)',
    'field.userAgentDataPlatform': 'UA Platform (userAgentData.platform)',
    'field.userAgentDataMobile': 'UA Mobile Flag (userAgentData.mobile)',
    'field.userAgentDataBrands': 'UA Brand List (userAgentData.brands)',
    'field.userAgentDataFullVersion': 'UA Full Version (userAgentData.uaFullVersion)',
    'field.userAgentDataArchitecture': 'UA Architecture (userAgentData.architecture)',
    'field.userAgentDataBitness': 'UA Bitness (userAgentData.bitness)',
    'field.userAgentDataPlatformVersion': 'UA Platform Version (userAgentData.platformVersion)',
    'field.userAgentDataWow64': 'UA Wow64 (userAgentData.wow64)',
    'field.secChUaHeader': 'Client Hint UA (Sec-CH-UA)',
    'field.secChUaMobileHeader': 'Client Hint Mobile Flag (Sec-CH-UA-Mobile)',
    'field.secChUaPlatformHeader': 'Client Hint Platform (Sec-CH-UA-Platform)',
    'field.secChUaFullVersionListHeader': 'Client Hint Full Version List (Sec-CH-UA-Full-Version-List)',
    'field.secChUaArchHeader': 'Client Hint Architecture (Sec-CH-UA-Arch)',
    'field.secChUaBitnessHeader': 'Client Hint Bitness (Sec-CH-UA-Bitness)',
    'field.secChUaPlatformVersionHeader': 'Client Hint Platform Version (Sec-CH-UA-Platform-Version)',
    'field.secChUaWow64Header': 'Client Hint Wow64 (Sec-CH-UA-Wow64)',
    'field.navigatorGeolocation': 'Geolocation API (navigator.geolocation)',
    'field.mediaDevicesEnumerate': 'Media Device Enumeration (mediaDevices.enumerateDevices)',
    'field.documentFontsCheck': 'Font Probe (document.fonts.check)',
    'field.navigatorGpu': 'Graphics Adapter (navigator.gpu)',
    'field.browserSelfCheck': 'Browser Self-check',
    'section.latestExternalRun': 'Latest External Run',
    'section.siteStatuses': 'Site Statuses',
    'section.keyWarnings': 'Key Warnings',
    'section.headerPreview': 'Header Preview',
    'section.permissionSnapshot': 'Permission Snapshot',
    'section.acceptChProbe': 'Accept-CH Probe',
    'section.webgpuSnapshot': 'WebGPU Snapshot',
    'section.fontsSnapshot': 'Fonts Snapshot',
    'section.mediaDevicesSnapshot': 'MediaDevices Snapshot',
    'section.latestByPreset': 'Latest by Preset',
    'section.fingerprintConfig': 'Fingerprint Config',
    'section.browserInfo': 'Browser Info',
    'section.summary': 'Summary',
    'section.structuredFacts': 'Structured Facts',
    'section.comparison': 'Comparison',
    'section.artifacts': 'Artifacts',
    'section.rawJson': 'Raw JSON',
    'section.pixelscanFix': 'Pixelscan Fix',
    'status.ok': 'OK',
    'status.warn': 'WARN',
    'status.info': 'INFO',
    'status.running': 'RUNNING',
    'status.stopped': 'STOPPED',
    'status.connected': 'CONNECTED',
    'status.disconnected': 'DISCONNECTED',
    'status.reconnecting': 'RECONNECTING',
    'status.notEnabled': 'DISABLED',
    'status.na': 'N/A',
    'status.direct': 'Direct',
    'status.failed': 'Failed',
    'status.okRuntime': 'OK · Runtime',
    'status.okStandalone': 'OK · Standalone',
    'status.untested': 'Not tested',
    'status.error': 'ERROR',
    'agreement.match': 'MATCH',
    'agreement.mismatch': 'MISMATCH',
    'agreement.local': 'LOCAL',
    'agreement.pending': 'PENDING',
    'agreement.partial': 'PARTIAL',
    'permission.granted': 'granted',
    'permission.prompt': 'prompt',
    'permission.denied': 'denied',
    'permission.unsupported': 'unsupported',
    'permission.unknown': 'unknown',
    'permission.error': 'error',
    'source.runtime': 'runtime',
    'source.browser': 'browser',
    'source.external': 'external',
    'empty.structuredFacts': 'No structured facts yet',
    'empty.comparison': 'No comparison available',
    'empty.selectRun': 'Select a recent run to inspect details',
    'empty.summary': 'No summary available',
    'empty.selfCheck': 'No self-check results yet',
    'empty.latestRun': 'No external run available',
    'empty.siteStatuses': 'No site statuses yet',
    'empty.keyWarnings': 'No key warnings',
    'empty.presets': 'No presets available',
    'empty.latestByPreset': 'Latest results for each preset will appear here',
    'empty.recentRuns': 'No diagnostic presets have been opened yet',
    'empty.noPresetFacts': 'No preset info available',
    'modal.diagnosticDetailTitle': 'Diagnostic Details',
    'modal.detailSite': 'Site',
    'modal.detailStatus': 'Status',
    'modal.detailOpenedAt': 'Opened At',
    'modal.detailCapturedAt': 'Captured At',
    'artifact.details': 'Details',
    'artifact.screenshot': 'Screenshot',
    'artifact.html': 'HTML',
    'artifact.text': 'Text',
    'artifact.json': 'JSON',
    'message.detailNotFound': 'Run details were not found',
    'message.detailRenderFailed': 'Failed to render details',
    'message.detailRenderFailedWithReason': 'Failed to render details: {{reason}}',
    'message.sourceValue': 'Source: {{value}}',
    'message.notBound': 'not bound',
    'message.notSet': 'not set',
    'message.available': 'available',
    'message.unsupported': 'unsupported',
    'message.probeUnavailable': 'probe unavailable',
    'message.highEntropyCaptured': 'high-entropy request hints captured',
    'message.highEntropyMissing': 'high-entropy request hints missing',
    'message.noConfiguredFontSample': 'no configured font sample',
    'message.noConfiguredFonts': 'no configured fonts',
    'message.fontsApiUnavailable': 'fonts API unavailable',
    'message.mediaDevicesUnavailable': 'media devices API unavailable',
    'message.webgpuUnavailable': 'navigator.gpu unavailable',
    'message.adapterAcquired': 'adapter acquired',
    'message.adapterNull': 'requestAdapter returned null',
    'message.missingUserAgentMetadata': 'missing userAgentMetadata',
    'message.defaultSyntheticDeviceSet': 'default synthetic device set',
    'message.noExplicitGraphicsFingerprint': 'no explicit graphics fingerprint',
    'message.missingCoordinates': 'missing coordinates',
    'message.coordinatesStillExposed': 'coordinates still exposed',
    'message.coordinatesWithheld': 'coordinates withheld',
    'message.browserSelfCheckWarnings': 'Browser self-check reported warnings.',
    'message.browserSelfCheckMismatch': 'Browser self-check reported a mismatch.',
    'message.externalRiskSignal': 'External diagnostics reported a risk signal.',
    'message.configuredCount': '{{count}} configured',
    'message.customDevicesCount': '{{count}} custom devices',
    'message.rulesCountSuffix': '{{count}} rules',
    'message.sampleCount': 'sample={{count}}',
    'message.availableCount': 'available={{count}}',
    'message.featureCount': 'features={{count}}',
    'message.noRecentExternalRuns': 'no recent external runs',
    'message.allLocalChecksPassed': 'all local checks passed',
    'message.notRun': 'not run',
    'message.waitMoreExternal': 'Waiting for more external evidence',
    'message.localAvailableNoExternal': 'Local self-check is available, but there are not enough external diagnostic results yet.',
    'message.localAndExternalRisk': 'Local and external diagnostics both report risk signals',
    'message.localWarnExternalRiskSummary': 'Local warnings: {{localCount}}; external risks: {{externalCount}}.',
    'message.localSelfCheckAbnormal': 'Local self-check reported anomalies',
    'message.externalRiskHeadline': 'External diagnostic sites reported risk signals',
    'message.localExternalAligned': 'Local and external diagnostics broadly align',
    'message.localOkExternalCount': 'Local checks passed; external OK runs: {{okCount}}{{techSuffix}}.',
    'message.localOkOnly': 'Local self-check passed',
    'message.localOkExternalPartial': 'Local self-check passed, but some external runs failed technically',
    'message.notRunExternalYet': 'External diagnostic sites have not been run yet, or results are still neutral.',
    'message.technicalFailuresSuffix': ', plus {{count}} technical failures',
    'message.externalTechnicalIssue': 'External · Technical issue',
    'message.localPrefix': 'Local',
    'message.externalPrefix': 'External',
    'message.vsPrevious': 'vs previous: {{summary}}',
    'message.geolocationUnavailable': 'geolocation unavailable',
    'message.timeout': 'timeout',
    'message.geolocationError': 'geolocation error',
    'message.profileParamMissing': 'Missing profile parameter (for example /dashboard?profile=<id>)',
    'message.profileNotRunning': 'Profile not running',
    'message.profileNotFound': 'Profile not found',
    'message.clearDiagnosticsConfirm': 'Clear diagnostic history and archived artifacts for this environment?',
    'message.sshDisconnectedRecover': 'SSH tunnel is disconnected. Click “Reconnect SSH” to recover.',
    'message.sshReconnecting': 'SSH is reconnecting. Runtime state will refresh automatically after recovery.',
    'message.sshNotProxy': 'Current proxy is not SSH',
    'message.sshTunnelHealthy': 'SSH tunnel is healthy',
    'message.sshForwardPort': 'Local dynamic forwarding port {{port}}',
    'message.sshReconnectingHint': 'Re-establishing SSH dynamic forwarding',
    'message.sshStoppedHint': 'SSH tunnel is disconnected. Manual reconnect is available',
    'message.restartProfileConfirm': 'Restart this profile now? All pages will be closed.',
    'message.restartProfileScheduled': 'Profile restart scheduled (this page will close soon). Re-open the dashboard after restart.',
    'message.errorSelfCheck': 'Browser self-check',
    'message.openedAt': 'Opened at {{time}}',
    'message.pixelscanCompatConfirm': 'Apply Pixelscan compatibility preset for this profile: disable canvas/audio/WebGL noise, ClientRects, SpeechVoices. A profile restart is required to take effect. Continue?',
    'message.pixelscanCompatApplied': 'Pixelscan compatibility preset applied (restart required).',
    'message.pixelscanMaskingHint': 'Pixelscan reports “masking detected”. This is commonly triggered by canvas/audio/WebGL noise and layout noise. Apply the compat preset to validate, then re-enable items one-by-one if needed.',
    'message.pixelscanWarnHint': 'Pixelscan reports an inconsistent fingerprint. Apply the compat preset to validate whether protections trigger it, then restore items gradually to isolate the cause.',
  }
};

function resolveDashboardLang() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const queryLang = String(params.get('appLang') || '').trim().toLowerCase();
    if (queryLang === 'cn' || queryLang === 'zh' || queryLang === 'zh-cn') return 'cn';
    if (queryLang === 'en' || queryLang === 'en-us') return 'en';
  } catch (e) { }
  try {
    const stored = String(localStorage.getItem('geekez_lang') || '').trim().toLowerCase();
    if (stored === 'cn' || stored === 'zh' || stored === 'zh-cn') return 'cn';
    if (stored === 'en' || stored === 'en-us') return 'en';
  } catch (e) { }
  return String(navigator.language || '').trim().toLowerCase().startsWith('zh') ? 'cn' : 'en';
}

const dashboardLang = resolveDashboardLang();
const dashboardLocale = dashboardLang === 'cn' ? 'zh-CN' : 'en-US';

function fillTemplate(text, vars = {}) {
  return String(text == null ? '' : text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function dt(key, vars) {
  const current = dashboardTranslations[dashboardLang] || dashboardTranslations.cn;
  const fallback = dashboardTranslations.en[key] || dashboardTranslations.cn[key] || key;
  return fillTemplate(current[key] || fallback, vars);
}

function applyDashboardI18n(root = document) {
  document.documentElement.lang = dashboardLang === 'cn' ? 'zh-CN' : 'en';
  document.title = dt('page.title');
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    el.textContent = dt(key);
  });
}

function formatStatusText(status) {
  const current = String(status || '').trim().toLowerCase();
  if (current === 'ok') return dt('status.ok');
  if (current === 'warn') return dt('status.warn');
  if (current === 'info') return dt('status.info');
  if (current === 'error') return dt('status.error');
  return String(status || '-');
}

function formatAgreementText(status) {
  const current = String(status || '').trim().toLowerCase();
  if (current === 'match') return dt('agreement.match');
  if (current === 'mismatch') return dt('agreement.mismatch');
  if (current === 'local') return dt('agreement.local');
  if (current === 'pending') return dt('agreement.pending');
  if (current === 'partial') return dt('agreement.partial');
  return String(status || '-');
}

function formatPermissionStateText(value) {
  const current = String(value || '').trim().toLowerCase();
  if (current === 'granted') return dt('permission.granted');
  if (current === 'prompt' || current === 'default') return dt('permission.prompt');
  if (current === 'denied') return dt('permission.denied');
  if (current === 'unsupported') return dt('permission.unsupported');
  if (current === 'unknown') return dt('permission.unknown');
  if (current === 'error') return dt('permission.error');
  return String(value || '-');
}

function formatCheckSource(source) {
  const current = String(source || '').trim().toLowerCase();
  if (current === 'runtime') return dt('source.runtime');
  if (current === 'browser') return dt('source.browser');
  if (current === 'external') return dt('source.external');
  return String(source || '-');
}

function formatExpectedActual(expected, actual) {
  return `${dt('common.expected')}=${expected}\n${dt('common.actual')}=${actual}`;
}

function normalizeLoopbackHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return host;
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return host;
}

function normalizeEndpointForDisplay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const normalizedHost = normalizeLoopbackHostname(parsed.hostname);
    if (normalizedHost === parsed.hostname) return raw;
    parsed.hostname = normalizedHost;
    let next = parsed.toString();
    if (!/[/?#]/.test(raw.slice(raw.indexOf('://') + 3))) next = next.replace(/\/$/, '');
    return next;
  } catch (e) {
    return raw
      .replace(/:\/\/\[::1\](?=[:/?#]|$)/gi, '://127.0.0.1')
      .replace(/:\/\/::1(?=[:/?#]|$)/gi, '://127.0.0.1')
      .replace(/:\/\/localhost(?=[:/?#]|$)/gi, '://127.0.0.1');
  }
}

function buildRuntimeEndpointDisplay(runtime) {
  const ws = normalizeEndpointForDisplay(runtime && runtime.ws);
  const http = normalizeEndpointForDisplay(runtime && runtime.http);
  return {
    wsDisplay: ws || '-',
    httpDisplay: http || '-',
    wsCopy: ws,
    httpCopy: http,
  };
}

function localizeKnownLabel(text, key = '') {
  const label = String(text || '').trim();
  const map = {
    'Runtime': 'field.runtime',
    'Timezone': 'field.timezone',
    'Language': 'field.language',
    'Geolocation': 'field.geolocation',
    'navigator.userAgent': 'field.navigatorUserAgent',
    'navigator.platform': 'field.navigatorPlatform',
    'navigator.language': 'field.navigatorLanguage',
    'navigator.languages': 'field.navigatorLanguages',
    'Intl.timeZone': 'field.intlTimezone',
    'permissions.query(geolocation)': 'field.permissionGeoQuery',
    'permissions.query(camera)': 'field.permissionCameraQuery',
    'permissions.query(microphone)': 'field.permissionMicrophoneQuery',
    'permissions.query(notifications)': 'field.permissionNotificationsQuery',
    'Notification.permission': 'field.notificationPermissionApi',
    'Geo Permission': 'field.geoPermission',
    'Camera Permission': 'field.cameraPermission',
    'Microphone Permission': 'field.microphonePermission',
    'Notification Permission': 'field.notificationPermission',
    'Header Rules': 'field.headerRules',
    'Client Hints': 'field.clientHints',
    'Fonts': 'field.fonts',
    'Media Devices': 'field.mediaDevices',
    'Graphics Fingerprint': 'field.graphicsFingerprint',
    'Request User-Agent': 'field.requestUserAgentHeader',
    'Accept-Language': 'field.acceptLanguageHeader',
    'navigator.userAgentData': 'field.userAgentData',
    'userAgentData.getHighEntropyValues': 'field.userAgentDataHighEntropy',
    'userAgentData.platform': 'field.userAgentDataPlatform',
    'userAgentData.mobile': 'field.userAgentDataMobile',
    'userAgentData.brands': 'field.userAgentDataBrands',
    'userAgentData.uaFullVersion': 'field.userAgentDataFullVersion',
    'userAgentData.architecture': 'field.userAgentDataArchitecture',
    'userAgentData.bitness': 'field.userAgentDataBitness',
    'userAgentData.platformVersion': 'field.userAgentDataPlatformVersion',
    'userAgentData.wow64': 'field.userAgentDataWow64',
    'Sec-CH-UA': 'field.secChUaHeader',
    'Sec-CH-UA-Mobile': 'field.secChUaMobileHeader',
    'Sec-CH-UA-Platform': 'field.secChUaPlatformHeader',
    'Sec-CH-UA-Full-Version-List': 'field.secChUaFullVersionListHeader',
    'Sec-CH-UA-Arch': 'field.secChUaArchHeader',
    'Sec-CH-UA-Bitness': 'field.secChUaBitnessHeader',
    'Sec-CH-UA-Platform-Version': 'field.secChUaPlatformVersionHeader',
    'Sec-CH-UA-Wow64': 'field.secChUaWow64Header',
    'navigator.geolocation': 'field.navigatorGeolocation',
    'mediaDevices.enumerateDevices': 'field.mediaDevicesEnumerate',
    'document.fonts.check': 'field.documentFontsCheck',
    'navigator.gpu': 'field.navigatorGpu',
    'Header Preview': 'section.headerPreview',
    'Accept-CH probe': 'section.acceptChProbe',
    'Browser self-check': 'field.browserSelfCheck',
    'Local self-check': 'field.local',
    'External diagnostics': 'field.external',
    'External': 'field.external',
  };
  const directKey = map[label];
  if (directKey) return dt(directKey);
  if (key === 'headers') return dt('field.headerRules');
  if (key === 'clientHints') return dt('field.clientHints');
  if (key === 'fonts') return dt('field.fonts');
  if (key === 'mediaDevices') return dt('field.mediaDevices');
  if (key === 'graphics') return dt('field.graphicsFingerprint');
  if (key === 'requestUserAgent') return dt('field.requestUserAgentHeader');
  if (key === 'acceptLanguage') return dt('field.acceptLanguageHeader');
  if (key === 'headerPreset') return dt('section.headerPreview');
  if (key === 'acceptChProbe') return dt('section.acceptChProbe');
  if (key === 'selfCheck') return dt('field.browserSelfCheck');
  return label || '-';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localizeCnTechnicalPhrases(text) {
  if (dashboardLang !== 'cn') return text;
  let out = String(text || '');
  const replacements = [
    ['Your Browser Fingerprint is inconsistent', '浏览器指纹不一致'],
    ['No proxy detected', '未检测到代理'],
    ['No automated behavior detected', '未检测到自动化行为'],
    ['Masking detected', '检测到伪装痕迹'],
    ['Fingerprint Scan', '指纹扫描'],
    ['JavaScript Browser Information', 'JavaScript 浏览器信息'],
    ['Your Digital Identity Looks', '数字身份评估'],
    ['Reputation Review needed', '信誉评估：需要复查'],
    ['Review needed', '需要复查'],
    ['Blacklist No', '黑名单：否'],
    ['WebRTC Disabled', 'WebRTC 已禁用'],
    ['Browser fingerprinting', '浏览器指纹识别'],
    ['Browser fingerprint', '浏览器指纹'],
    ['Document Object', '文档对象'],
    ['Navigator Object', '导航器对象'],
    ['System Time', '系统时间'],
    ['SOCIAL NETWORKS', '社交网络'],
    ['IP ADDRESS', 'IP 地址'],
    ['My IP:', '我的 IP：'],
    ['How to Fix it?', '如何修复？'],
    ['Not detected', '未检测到'],
    ['It is almost impossible to completely hide a fingerprint, as empty parameter values themselves look suspicious to security systems. The best strategy is camouflage.', '完全隐藏指纹几乎不可能；更可行的是让参数分布看起来更自然。'],
    ['Using anti-detect browsers or specialized extensions a…', '建议通过反检测浏览器或专业扩展做伪装。'],
    ['Using anti-detect browsers or specialized extensions', '建议通过反检测浏览器或专业扩展做伪装'],
    ['Language Want', '语言（站点期望）'],
    ['Language to', '语言（疑似异常值）'],
    ['SSH exited (code', 'SSH 已退出 (code'],
    ['Your Browser Fingerprint is scanning…', '浏览器指纹扫描中…'],
    ['Your Browser Fingerprint is scanning...', '浏览器指纹扫描中...'],
    ['Fingerprint is scanning…', '指纹扫描中…'],
    ['Fingerprint is scanning...', '指纹扫描中...'],
    ['scanning…', '扫描中…'],
    ['scanning...', '扫描中...'],
  ];
  for (const [from, to] of replacements) {
    out = out.replace(new RegExp(escapeRegExp(from), 'gi'), to);
  }
  return out;
}

function localizeKnownMessage(text) {
  const value = String(text || '').trim();
  if (!value) return value;
  const exact = {
    'not bound': 'message.notBound',
    'not set': 'message.notSet',
    'available': 'message.available',
    'unsupported': 'message.unsupported',
    'probe unavailable': 'message.probeUnavailable',
    'high-entropy request hints captured': 'message.highEntropyCaptured',
    'high-entropy request hints missing': 'message.highEntropyMissing',
    'no configured font sample': 'message.noConfiguredFontSample',
    'no configured fonts': 'message.noConfiguredFonts',
    'fonts api unavailable': 'message.fontsApiUnavailable',
    'enumerateDevices unavailable': 'message.mediaDevicesUnavailable',
    'navigator.gpu unavailable': 'message.webgpuUnavailable',
    'adapter acquired': 'message.adapterAcquired',
    'requestAdapter returned null': 'message.adapterNull',
    'missing userAgentMetadata': 'message.missingUserAgentMetadata',
    'default synthetic device set': 'message.defaultSyntheticDeviceSet',
    'no explicit graphics fingerprint': 'message.noExplicitGraphicsFingerprint',
    'missing coordinates': 'message.missingCoordinates',
    'coordinates still exposed': 'message.coordinatesStillExposed',
    'coordinates withheld': 'message.coordinatesWithheld',
    'Browser self-check reported warnings.': 'message.browserSelfCheckWarnings',
    'Browser self-check reported a mismatch.': 'message.browserSelfCheckMismatch',
    'Local self-check reported a mismatch.': 'message.browserSelfCheckMismatch',
    'External diagnostics reported a risk signal.': 'message.externalRiskSignal',
    'External diagnostic reported a risk signal.': 'message.externalRiskSignal',
    'all local checks passed': 'message.allLocalChecksPassed',
    'no recent external runs': 'message.noRecentExternalRuns',
    'not run': 'message.notRun',
    'timeout': 'message.timeout',
    'geolocation unavailable': 'message.geolocationUnavailable',
    'geolocation error': 'message.geolocationError',
    'Profile not running': 'message.profileNotRunning',
    'Profile not found': 'message.profileNotFound',
  };
  if (exact[value]) return dt(exact[value]);
  const launchRuntimeMatch = value.match(/^launch=(.+)\s+runtime=(.+)$/i);
  if (launchRuntimeMatch) return `${dt('field.launch')}=${launchRuntimeMatch[1]}\n${dt('field.runtime')}=${launchRuntimeMatch[2]}`;
  const expectedActualInline = value.match(/^expected=([^\n]+?)\s+actual=([^\n]+)$/i);
  if (expectedActualInline) return formatExpectedActual(expectedActualInline[1], expectedActualInline[2]);
  const expectedActualMultiline = value.match(/^expected=([^\n]+)\nactual=([^\n]+)$/i);
  if (expectedActualMultiline) return formatExpectedActual(expectedActualMultiline[1], expectedActualMultiline[2]);
  const permissionHintMatch = value.match(/^(granted|prompt|denied|unsupported|unknown|error)\s+\((.+)\)$/i);
  if (permissionHintMatch) return `${formatPermissionStateText(permissionHintMatch[1])} (${localizeKnownMessage(permissionHintMatch[2])})`;
  const rulesMatch = value.match(/^(.*)\((\d+)\s+rules\)$/i);
  if (rulesMatch) return `${rulesMatch[1].trim()} (${dt('message.rulesCountSuffix', { count: rulesMatch[2] })})`;
  const configuredMatch = value.match(/^(\d+)\s+configured$/i);
  if (configuredMatch) return dt('message.configuredCount', { count: configuredMatch[1] });
  const devicesMatch = value.match(/^(\d+)\s+custom devices$/i);
  if (devicesMatch) return dt('message.customDevicesCount', { count: devicesMatch[1] });
  if (['granted', 'prompt', 'denied', 'unsupported', 'unknown', 'error', 'default'].includes(value.toLowerCase())) {
    return formatPermissionStateText(value);
  }
  return localizeCnTechnicalPhrases(value);
}

function localizeKnownSummaryLines(items, limit = Infinity) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = localizeKnownMessage(item);
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function setErr(message, kind = 'error') {
  const alertBar = $('alertBar');
  const err = $('err');
  if (!alertBar || !err) return;
  if (!message) {
    alertBar.hidden = true;
    alertBar.dataset.kind = '';
    err.textContent = '';
    return;
  }
  alertBar.hidden = false;
  alertBar.dataset.kind = kind;
  err.textContent = localizeKnownMessage(String(message));
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = (text === undefined || text === null || text === '') ? '-' : String(text);
}

function fmtTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '-';
  try {
    return new Date(value).toLocaleString(dashboardLocale);
  } catch (e) {
    return String(ms);
  }
}

function fmtClock(date = new Date()) {
  try {
    return date.toLocaleTimeString(dashboardLocale, { hour12: false });
  } catch (e) {
    return String(date);
  }
}

function normalizeStatus(value, fallback = 'info') {
  const current = String(value || '').trim().toLowerCase();
  return ['ok', 'warn', 'info'].includes(current) ? current : fallback;
}

function normalizeDiagnosticFacts(items, limit = 4) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const label = String(item && item.label || '').replace(/\s+/g, ' ').trim();
    const value = String(item && item.value || '').replace(/\s+/g, ' ').trim();
    const status = normalizeStatus(item && item.status, 'info');
    const key = `${label.toLowerCase()}::${value.toLowerCase()}`;
    if (!label || !value || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, status });
    if (out.length >= limit) break;
  }
  return out;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDiagnosticRunById(diagnostics, runId) {
  const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
  const target = String(runId || '').trim();
  if (!target) return null;
  return recentRuns.find((item) => String(item && item.result && item.result.artifacts && item.result.artifacts.runId || '').trim() === target) || null;
}

function buildDiagnosticArtifactLinksMarkup(artifacts, { detailRunId = '' } = {}) {
  const source = artifacts && typeof artifacts === 'object' ? artifacts : {};
  const available = Array.isArray(source.available) ? source.available : [];
  const links = [
    detailRunId
      ? `<button type="button" class="artifact-link artifact-button" data-run-id="${escapeHtml(detailRunId)}">${escapeHtml(dt('artifact.details'))}</button>`
      : '',
    available.includes('screenshot') && source.screenshotUrl
      ? `<a class="artifact-link" href="${escapeHtml(source.screenshotUrl)}" target="_blank" rel="noreferrer">${escapeHtml(dt('artifact.screenshot'))}</a>`
      : '',
    available.includes('html') && source.htmlUrl
      ? `<a class="artifact-link" href="${escapeHtml(source.htmlUrl)}" target="_blank" rel="noreferrer">${escapeHtml(dt('artifact.html'))}</a>`
      : '',
    available.includes('text') && source.textUrl
      ? `<a class="artifact-link" href="${escapeHtml(source.textUrl)}" target="_blank" rel="noreferrer">${escapeHtml(dt('artifact.text'))}</a>`
      : '',
    available.includes('json') && source.jsonUrl
      ? `<a class="artifact-link" href="${escapeHtml(source.jsonUrl)}" target="_blank" rel="noreferrer">${escapeHtml(dt('artifact.json'))}</a>`
      : '',
  ];
  return links.filter(Boolean).join('');
}

function buildDiagnosticFactsMarkup(items, limit = 12) {
  const facts = normalizeDiagnosticFacts(items, limit);
  if (facts.length === 0) return `<div class="empty-state">${escapeHtml(dt('empty.structuredFacts'))}</div>`;
  return `<div class="diag-detail-stack">${facts.map((fact) => `
    <div class="diag-detail-fact" data-status="${escapeHtml(fact.status)}">
      <strong>${escapeHtml(localizeKnownLabel(fact.label))}</strong>
      <span>${escapeHtml(localizeKnownMessage(fact.value))}</span>
    </div>
  `).join('')}</div>`;
}

function buildDiagnosticComparisonMarkup(comparison) {
  if (!comparison || !comparison.summary) return `<div class="empty-state">${escapeHtml(dt('empty.comparison'))}</div>`;
  const changes = Array.isArray(comparison.changes) ? comparison.changes : [];
  return `
    <div class="diag-detail-stack">
      <div class="diag-detail-note">${escapeHtml(localizeKnownMessage(comparison.summary))}</div>
      ${changes.length > 0 ? changes.map((item) => `
        <div class="diag-detail-change">
          <strong>${escapeHtml(localizeKnownLabel(item.label || '-'))}</strong>
          <span>${escapeHtml(localizeKnownMessage(item.before || '∅'))} → ${escapeHtml(localizeKnownMessage(item.after || '∅'))}</span>
        </div>
      `).join('') : ''}
    </div>
  `;
}

function closeDiagnosticDetails() {
  const modal = $('diagnosticDetailModal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function renderDiagnosticDetailEmptyState(message = dt('empty.selectRun')) {
  const contentEl = $('diagnosticDetailContent');
  if (!contentEl) return;
  contentEl.innerHTML = `<div class="empty-state">${escapeHtml(message || dt('empty.selectRun'))}</div>`;
}

function openDiagnosticRunDetails(runId) {
  const latestRun = getDiagnosticRunById(currentDiagnostics, runId);
  if (!latestRun) {
    setErr(dt('message.detailNotFound'), 'warn');
    return;
  }
  const modal = $('diagnosticDetailModal');
  const titleEl = $('diagnosticDetailTitle');
  const contentEl = $('diagnosticDetailContent');
  if (!modal || !titleEl || !contentEl) return;

  try {
    const result = latestRun.result || {};
    const comparison = latestRun.comparison || null;
    const artifacts = result.artifacts || {};
    const notes = localizeKnownSummaryLines([
      result.summary || '',
      ...(Array.isArray(result.signals) ? result.signals : []),
      result.finalUrl || latestRun.url || '',
    ]);
    const rawJson = JSON.stringify({
      presetId: latestRun.presetId,
      name: latestRun.name,
      openedAt: latestRun.openedAt,
      result,
      comparison,
    }, null, 2);

    titleEl.textContent = result.headline || latestRun.name || latestRun.presetId || dt('modal.diagnosticDetailTitle');
    contentEl.innerHTML = `
      <div class="diag-detail-grid">
        <div class="diag-detail-card">
          <div class="diag-detail-k">${escapeHtml(dt('modal.detailSite'))}</div>
          <div class="diag-detail-v">${escapeHtml(latestRun.name || latestRun.presetId || '-')}</div>
        </div>
        <div class="diag-detail-card">
          <div class="diag-detail-k">${escapeHtml(dt('modal.detailStatus'))}</div>
          <div class="diag-detail-v">${escapeHtml(formatStatusText(normalizeStatus(result.status, 'info')))}</div>
        </div>
        <div class="diag-detail-card">
          <div class="diag-detail-k">${escapeHtml(dt('modal.detailOpenedAt'))}</div>
          <div class="diag-detail-v">${escapeHtml(fmtTime(latestRun.openedAt))}</div>
        </div>
        <div class="diag-detail-card">
          <div class="diag-detail-k">${escapeHtml(dt('modal.detailCapturedAt'))}</div>
          <div class="diag-detail-v">${escapeHtml(fmtTime(result.capturedAt))}</div>
        </div>
      </div>
      <section class="diag-detail-section">
        <h3>${escapeHtml(dt('section.summary'))}</h3>
        <div class="diag-detail-stack">
          ${notes.length > 0 ? notes.map((item) => `<div class="diag-detail-note">${escapeHtml(item)}</div>`).join('') : `<div class="empty-state">${escapeHtml(dt('empty.summary'))}</div>`}
        </div>
      </section>
      <section class="diag-detail-section">
        <h3>${escapeHtml(dt('section.structuredFacts'))}</h3>
        ${buildDiagnosticFactsMarkup(result.facts, 12)}
      </section>
      <section class="diag-detail-section">
        <h3>${escapeHtml(dt('section.comparison'))}</h3>
        ${buildDiagnosticComparisonMarkup(comparison)}
      </section>
      <section class="diag-detail-section">
        <h3>${escapeHtml(dt('section.artifacts'))}</h3>
        <div class="artifact-links">${buildDiagnosticArtifactLinksMarkup(artifacts)}</div>
      </section>
      <section class="diag-detail-section">
        <h3>${escapeHtml(dt('section.rawJson'))}</h3>
        <pre class="diag-detail-pre">${escapeHtml(rawJson)}</pre>
      </section>
    `;
  } catch (e) {
    titleEl.textContent = dt('modal.diagnosticDetailTitle');
    renderDiagnosticDetailEmptyState(e && e.message ? dt('message.detailRenderFailedWithReason', { reason: e.message }) : dt('message.detailRenderFailed'));
    setErr(e && e.message ? e.message : String(e), 'warn');
  }

  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function fmtGeoValue(geo) {
  if (!geo || geo.latitude === undefined || geo.longitude === undefined) return '-';
  return `${geo.latitude}, ${geo.longitude}`;
}

function isCloseGeo(a, b, tolerance = 0.2) {
  if (!a || !b) return false;
  return Math.abs(Number(a.latitude) - Number(b.latitude)) <= tolerance
    && Math.abs(Number(a.longitude) - Number(b.longitude)) <= tolerance;
}

function normalizeHeaderValue(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function normalizeQuotedHeaderValue(text) {
  return String(text || '').trim().replace(/^"+|"+$/g, '');
}

function normalizePermissionState(text, fallback = 'prompt') {
  const value = String(text || '').trim().toLowerCase();
  return ['granted', 'prompt', 'denied'].includes(value) ? value : fallback;
}

function countMediaDevicesByKind(devices) {
  const counts = { audioinput: 0, audiooutput: 0, videoinput: 0 };
  for (const item of Array.isArray(devices) ? devices : []) {
    const kind = String(item && item.kind || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += 1;
  }
  return counts;
}

function buildExpectedMediaDeviceTemplate(expectedDevices) {
  const current = Array.isArray(expectedDevices) ? expectedDevices.filter(Boolean) : [];
  if (current.length > 0) return current;
  return [
    { kind: 'audioinput', label: '' },
    { kind: 'audioinput', label: '' },
    { kind: 'audiooutput', label: '' },
    { kind: 'videoinput', label: '' },
  ];
}

async function readWebGpuSnapshot() {
  if (!navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function') {
    return { supported: false, error: dt('message.webgpuUnavailable') };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: true, adapterAvailable: false, error: dt('message.adapterNull') };
    }
    let info = {};
    try {
      if (adapter.info && typeof adapter.info === 'object') {
        info = {
          vendor: String(adapter.info.vendor || '').trim(),
          architecture: String(adapter.info.architecture || '').trim(),
          device: String(adapter.info.device || '').trim(),
          description: String(adapter.info.description || '').trim(),
        };
      } else if (typeof adapter.requestAdapterInfo === 'function') {
        const rawInfo = await adapter.requestAdapterInfo().catch(() => null);
        if (rawInfo) {
          info = {
            vendor: String(rawInfo.vendor || '').trim(),
            architecture: String(rawInfo.architecture || '').trim(),
            device: String(rawInfo.device || '').trim(),
            description: String(rawInfo.description || '').trim(),
          };
        }
      }
    } catch (e) { }
    const features = Array.from(adapter.features || []).map((item) => String(item || '').trim()).filter(Boolean);
    const limits = adapter.limits ? {
      maxTextureDimension2D: Number(adapter.limits.maxTextureDimension2D || 0) || 0,
      maxBufferSize: Number(adapter.limits.maxBufferSize || 0) || 0,
      maxComputeInvocationsPerWorkgroup: Number(adapter.limits.maxComputeInvocationsPerWorkgroup || 0) || 0,
    } : {};
    return {
      supported: true,
      adapterAvailable: true,
      info,
      featureCount: features.length,
      features: features.slice(0, 24),
      limits,
    };
  } catch (e) {
    return { supported: true, adapterAvailable: false, error: e && e.message ? e.message : String(e) };
  }
}

function buildFontProbeList(expectedFonts, limit = 6) {
  return Array.from(new Set((Array.isArray(expectedFonts) ? expectedFonts : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)))
    .slice(0, limit);
}

async function readFontsSnapshot(expectedFonts) {
  const probes = buildFontProbeList(expectedFonts);
  if (!document.fonts || typeof document.fonts.check !== 'function') {
    return { supported: false, error: dt('message.fontsApiUnavailable'), probes: probes.map((font) => ({ font, available: false })) };
  }
  const results = probes.map((font) => {
    let available = false;
    try {
      available = !!document.fonts.check(`16px "${font}"`);
    } catch (e) { }
    return { font, available };
  });
  return {
    supported: true,
    total: results.length,
    availableCount: results.filter((item) => item.available).length,
    probes: results,
  };
}

async function readMediaDevicesSnapshot() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return { supported: false, error: dt('message.mediaDevicesUnavailable'), devices: [], counts: {} };
  }
  try {
    const raw = await navigator.mediaDevices.enumerateDevices();
    const devices = (Array.isArray(raw) ? raw : []).map((item) => ({
      kind: String(item && item.kind || '').trim(),
      label: String(item && item.label || '').trim(),
      deviceId: String(item && item.deviceId || '').trim(),
      groupId: String(item && item.groupId || '').trim(),
    }));
    return {
      supported: true,
      total: devices.length,
      counts: countMediaDevicesByKind(devices),
      devices: devices.slice(0, 12),
    };
  } catch (e) {
    return { supported: true, error: e && e.message ? e.message : String(e), devices: [], counts: {} };
  }
}

function notificationPermissionValueToState(text) {
  const value = String(text || '').trim().toLowerCase();
  if (value === 'default') return 'prompt';
  return normalizePermissionState(value, 'unsupported');
}

function stateToNotificationPermissionValue(state) {
  const normalized = normalizePermissionState(state, 'prompt');
  return normalized === 'prompt' ? 'default' : normalized;
}

function extractChromeVersion(text) {
  const match = String(text || '').match(/(?:Chrome|HeadlessChrome)\/(\d+\.\d+\.\d+\.\d+)/i);
  return match ? match[1] : '';
}

function extractChromeMajor(text) {
  const full = extractChromeVersion(text);
  return full ? full.split('.')[0] : '';
}

function normalizeBrandList(brands) {
  return Array.isArray(brands)
    ? brands.map((item) => ({
      brand: String(item && item.brand || '').trim(),
      version: String(item && item.version || '').trim(),
    })).filter((item) => item.brand)
    : [];
}

function hasExpectedChromeBrands(brands, expectedMajor, expectedBrandNames) {
  const list = normalizeBrandList(brands);
  const brandNames = Array.isArray(expectedBrandNames) && expectedBrandNames.length
    ? expectedBrandNames.map((item) => String(item || '').trim()).filter(Boolean)
    : ['Chromium', 'Google Chrome'];
  return brandNames.every((brandName) => list.some((item) => item.brand === brandName && (!expectedMajor || item.version === expectedMajor)));
}

function secChUaLooksConsistent(headerValue, expectedMajor, expectedBrandNames) {
  const raw = String(headerValue || '').trim();
  if (!raw) return false;
  const brandNames = Array.isArray(expectedBrandNames) && expectedBrandNames.length
    ? expectedBrandNames
    : ['Chromium', 'Google Chrome'];
  return brandNames.every((brandName) => raw.includes(`"${brandName}"`) && (!expectedMajor || raw.includes(`"${brandName}";v="${expectedMajor}"`)));
}

function secChUaFullVersionListLooksConsistent(headerValue, expectedVersion, expectedBrandNames) {
  const raw = String(headerValue || '').trim();
  if (!raw) return !expectedVersion;
  const brandNames = Array.isArray(expectedBrandNames) && expectedBrandNames.length
    ? expectedBrandNames
    : ['Chromium', 'Google Chrome'];
  return brandNames.every((brandName) => raw.includes(`"${brandName}"`) && (!expectedVersion || raw.includes(`"${brandName}";v="${expectedVersion}"`)));
}

function hasHighEntropyClientHints(headers) {
  if (!headers) return false;
  return [
    headers.secChUaFullVersionList,
    headers.secChUaArch,
    headers.secChUaBitness,
    headers.secChUaPlatformVersion,
    headers.secChUaModel,
    headers.secChUaWow64,
  ].some((value) => String(value || '').trim());
}

async function readUserAgentDataSnapshot() {
  if (!navigator.userAgentData) return { supported: false, low: null, high: null };
  try {
    const low = typeof navigator.userAgentData.toJSON === 'function'
      ? navigator.userAgentData.toJSON()
      : {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
      };
    const high = typeof navigator.userAgentData.getHighEntropyValues === 'function'
      ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64'])
      : null;
    return { supported: true, low: low || null, high: high || null };
  } catch (e) {
    return { supported: true, low: null, high: null, error: e && e.message ? e.message : String(e) };
  }
}

function readNotificationPermissionValue() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    return String(Notification.permission || 'default').trim().toLowerCase() || 'default';
  } catch (e) {
    return 'error';
  }
}

function isTechnicalDiagnosticWarning(run) {
  const status = normalizeStatus(run && run.result && run.result.status, 'info');
  if (status !== 'warn') return false;
  const text = `${run && run.result && run.result.summary || ''}\n${run && run.result && run.result.headline || ''}`.toLowerCase();
  return /timeout|failed to open|capture failed|network|dns|net::|navigation timeout|http \d{3}|blocked|temporarily unavailable/.test(text);
}

function getUnifiedExternalRuns(diagnostics, limit = 4) {
  const source = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const key = String(item && (item.presetId || item.name || item.url) || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function getDiagnosticRunLabel(run) {
  return String(run && (run.name || run.presetId) || '').trim() || dt('field.external');
}

function getDiagnosticRunSummary(run) {
  const result = run && run.result ? run.result : {};
  return localizeKnownSummaryLines([
    result.summary || '',
    ...(Array.isArray(result.signals) ? result.signals.slice(0, 2) : []),
  ], 3).join(' / ');
}

function buildUnifiedVerdict(diagnostics, liveCheck) {
  const runtimeItems = currentRuntime && currentRuntime.selfCheckSummary && Array.isArray(currentRuntime.selfCheckSummary.items)
    ? currentRuntime.selfCheckSummary.items
    : [];
  const browserItems = liveCheck && Array.isArray(liveCheck.items) ? liveCheck.items : [];
  const localItems = [...runtimeItems, ...browserItems];
  const localWarns = localItems.filter(item => normalizeStatus(item && item.status, 'ok') === 'warn');
  const localStatus = localItems.length === 0 ? 'info' : (localWarns.length > 0 ? 'warn' : 'ok');

  const externalRuns = getUnifiedExternalRuns(diagnostics);
  const externalWarns = externalRuns.filter(item => normalizeStatus(item && item.result && item.result.status, 'info') === 'warn');
  const technicalWarns = externalWarns.filter(isTechnicalDiagnosticWarning);
  const externalRiskWarns = externalWarns.filter(item => !isTechnicalDiagnosticWarning(item));
  const externalOk = externalRuns.filter(item => normalizeStatus(item && item.result && item.result.status, 'info') === 'ok');
  const externalStatus = externalRuns.length === 0
    ? 'info'
    : (externalRiskWarns.length > 0 ? 'warn' : (externalOk.length > 0 ? 'ok' : 'info'));

  let overallStatus = 'info';
  let agreement = 'PENDING';
  let headline = dt('message.waitMoreExternal');
  let summary = dt('message.localAvailableNoExternal');

  if (localStatus === 'warn' && externalRiskWarns.length > 0) {
    overallStatus = 'warn';
    agreement = 'MATCH';
    headline = dt('message.localAndExternalRisk');
    summary = dt('message.localWarnExternalRiskSummary', { localCount: localWarns.length, externalCount: externalRiskWarns.length });
  } else if (localStatus === 'warn') {
    overallStatus = 'warn';
    agreement = externalOk.length > 0 ? 'MISMATCH' : 'LOCAL';
    headline = dt('message.localSelfCheckAbnormal');
    summary = localWarns.slice(0, 3).map(item => localizeKnownLabel(item.label || item.key || '-', item.key)).join(' / ') || dt('message.browserSelfCheckWarnings');
  } else if (externalRiskWarns.length > 0) {
    overallStatus = 'warn';
    agreement = 'MISMATCH';
    headline = dt('message.externalRiskHeadline');
    summary = externalRiskWarns.slice(0, 2).map(item => getDiagnosticRunSummary(item) || item && item.result && localizeKnownMessage(item.result.headline || '') || item.name || item.presetId || '-').join(' / ');
  } else if (localStatus === 'ok' && externalOk.length > 0) {
    overallStatus = 'ok';
    agreement = 'MATCH';
    headline = dt('message.localExternalAligned');
    summary = dt('message.localOkExternalCount', {
      okCount: externalOk.length,
      techSuffix: technicalWarns.length > 0 ? dt('message.technicalFailuresSuffix', { count: technicalWarns.length }) : '',
    });
  } else if (localStatus === 'ok') {
    overallStatus = 'info';
    agreement = technicalWarns.length > 0 ? 'PARTIAL' : 'LOCAL';
    headline = technicalWarns.length > 0 ? dt('message.localOkExternalPartial') : dt('message.localOkOnly');
    summary = technicalWarns.length > 0
      ? technicalWarns.slice(0, 2).map(item => getDiagnosticRunSummary(item) || item.name || '-').join(' / ')
      : dt('message.notRunExternalYet');
  }

  const items = [
    {
      label: dt('field.local'),
      status: localStatus,
      message: localStatus === 'warn'
        ? `${localWarns.length} ${dt('status.warn')}`
        : (localItems.length > 0 ? dt('message.allLocalChecksPassed') : dt('message.notRun')),
    },
    {
      label: dt('field.external'),
      status: externalStatus,
      message: externalRuns.length > 0
        ? externalRuns.map(item => `${item.name || item.presetId || '-'} ${formatStatusText(normalizeStatus(item && item.result && item.result.status, 'info'))}`).join(' / ')
        : dt('message.noRecentExternalRuns'),
    },
  ];

  externalRuns.slice(0, 3).forEach((item) => {
    const status = normalizeStatus(item && item.result && item.result.status, 'info');
    const detail = [
      item && item.result && item.result.summary || '',
      ...(Array.isArray(item && item.result && item.result.signals) ? item.result.signals.slice(0, 2) : []),
    ].filter(Boolean);
    items.push({
      label: item && item.name || item && item.presetId || dt('field.external'),
      status: isTechnicalDiagnosticWarning(item) ? 'info' : status,
      message: detail.join(' / ') || (item && item.url) || '-',
    });
  });

  const latestExternalRun = externalRuns[0] || null;
  const siteStatuses = externalRuns.map((item) => ({
    label: getDiagnosticRunLabel(item),
    status: isTechnicalDiagnosticWarning(item) ? 'info' : normalizeStatus(item && item.result && item.result.status, 'info'),
    summary: getDiagnosticRunSummary(item) || (item && item.url) || '-',
    openedAt: item && item.openedAt ? fmtTime(item.openedAt) : '-',
  }));

  const keyWarnings = [];
  localWarns.slice(0, 3).forEach((item) => {
    keyWarnings.push({
      label: `${dt('message.localPrefix')} · ${localizeKnownLabel(item && (item.label || item.key || 'check'), item && item.key)}`,
      message: item && item.message ? localizeKnownMessage(item.message) : dt('message.browserSelfCheckMismatch'),
      status: 'warn',
    });
  });
  externalRiskWarns.slice(0, 3).forEach((item) => {
    keyWarnings.push({
      label: `${dt('message.externalPrefix')} · ${getDiagnosticRunLabel(item)}`,
      message: getDiagnosticRunSummary(item) || (item && item.url) || dt('message.externalRiskSignal'),
      status: 'warn',
    });
  });
  if (keyWarnings.length === 0 && technicalWarns.length > 0) {
    keyWarnings.push({
      label: dt('message.externalTechnicalIssue'),
      message: technicalWarns.slice(0, 2).map((item) => getDiagnosticRunSummary(item) || getDiagnosticRunLabel(item)).join(' / '),
      status: 'info',
    });
  }

  return {
    overallStatus,
    localStatus,
    externalStatus,
    agreement,
    headline,
    summary,
    items,
    latestExternalRun: latestExternalRun ? {
      label: getDiagnosticRunLabel(latestExternalRun),
      status: isTechnicalDiagnosticWarning(latestExternalRun) ? 'info' : normalizeStatus(latestExternalRun && latestExternalRun.result && latestExternalRun.result.status, 'info'),
      summary: getDiagnosticRunSummary(latestExternalRun) || (latestExternalRun && latestExternalRun.url) || '-',
      openedAt: latestExternalRun && latestExternalRun.openedAt ? fmtTime(latestExternalRun.openedAt) : '-',
    } : null,
    siteStatuses,
    keyWarnings,
  };
}

async function queryPermissionState(name) {
  try {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return name === 'notifications' ? notificationPermissionValueToState(readNotificationPermissionValue()) : 'unsupported';
    }
    const result = await navigator.permissions.query({ name });
    return result && result.state ? String(result.state) : 'unknown';
  } catch (e) {
    return name === 'notifications' ? notificationPermissionValueToState(readNotificationPermissionValue()) : 'error';
  }
}

async function queryPermissionSnapshot() {
  const [geolocation, camera, microphone, notifications] = await Promise.all([
    queryPermissionState('geolocation'),
    queryPermissionState('camera'),
    queryPermissionState('microphone'),
    queryPermissionState('notifications'),
  ]);
  return {
    geolocation,
    camera,
    microphone,
    notifications,
    notificationPermission: readNotificationPermissionValue(),
  };
}

async function runAcceptChProbe() {
  const collect = async () => {
    const res = await fetch(`${apiBase}/diagnostics/accept-ch/collect?ts=${Date.now()}-${Math.random().toString(36).slice(2)}`, { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json || json.success !== true) {
      throw new Error((json && (json.error || json.msg)) || (`HTTP ${res.status}`));
    }
    return json.data || {};
  };

  try {
    await fetch(`${apiBase}/diagnostics/accept-ch/bootstrap?ts=${Date.now()}`, { cache: 'no-store' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    let headers = await collect();
    if (!hasHighEntropyClientHints(headers)) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      headers = await collect();
    }
    return { ok: true, headers };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), headers: null };
  }
}

function markUpdated() {
  setText('lastUpdated', fmtClock());
}

function maskProxy(proxyStr) {
  const raw = String(proxyStr || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const auth = u.username ? (decodeURIComponent(u.username) + (u.password ? ':***' : '') + '@') : '';
    const host = u.hostname + (u.port ? ':' + u.port : '');
    return u.protocol + '//' + auth + host + (u.search || '');
  } catch (e) {
    return raw;
  }
}

function formatProxyType(proxyType) {
  const text = String(proxyType || '').trim();
  if (!text) return '-';
  return text.toUpperCase();
}

function formatProxyTestStatus(result) {
  const current = result && typeof result === 'object' ? result : {};
  const status = String(current.status || '').trim().toLowerCase();
  if (status === 'ok' && current.success === true) {
    return current.mode === 'runtime' ? dt('status.okRuntime') : dt('status.okStandalone');
  }
  if (status === 'info' && current.direct) return dt('status.direct');
  if (status === 'info') return localizeKnownMessage(current.summary || current.error || dt('status.untested'));
  return localizeKnownMessage(current.error || current.summary || dt('status.failed'));
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

async function getJson(path) {
  const res = await fetch(apiBase + path, { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!json || json.success !== true) {
    throw new Error((json && (json.error || json.msg)) || ('HTTP ' + res.status));
  }
  return json.data;
}

async function postJson(path, body = {}) {
  const res = await fetch(apiBase + path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json || json.success !== true) {
    throw new Error((json && (json.error || json.msg)) || ('HTTP ' + res.status));
  }
  return json.data;
}

async function patchJson(path, body = {}) {
  const res = await fetch(apiBase + path, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json || json.success !== true) {
    throw new Error((json && (json.error || json.msg)) || ('HTTP ' + res.status));
  }
  return json.data;
}

function setBusy(id, busy, busyLabel) {
  const btn = $(id);
  if (!btn) return;
  if (!btn.dataset.defaultLabel) btn.dataset.defaultLabel = btn.textContent;
  btn.disabled = !!busy;
  btn.textContent = busy ? busyLabel : btn.dataset.defaultLabel;
}

function renderTags(tags) {
  const el = $('tags');
  if (!el) return;
  if (!Array.isArray(tags) || tags.length === 0) {
    el.textContent = '-';
    return;
  }
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  tags.forEach((tag) => {
    const span = document.createElement('span');
    span.className = 'tag-pill';
    span.textContent = String(tag);
    frag.appendChild(span);
  });
  el.appendChild(frag);
}

function stopTotp() {
  if (totpTimer) clearInterval(totpTimer);
  totpTimer = null;
  currentSecret = null;
  $('acctCard').hidden = true;
  $('otpFallback').hidden = true;
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
  if (!secret || !window.crypto || !crypto.subtle) return null;
  try {
    const keyBytes = base32ToBytes(secret);
    if (!keyBytes.length) return null;
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
  $('acctCard').hidden = false;
  setText('acctEmail', email);
  setText('acctAux', aux);
  currentSecret = secret;
  $('otpFallback').hidden = true;
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
      $('otpFallback').hidden = true;
    } else {
      setText('otpCode', 'ERR');
      $('otpFallback').hidden = false;
      $('otpFallback').href = 'https://2fa.show/2fa/' + encodeURIComponent(currentSecret);
    }
  };

  tick();
  if (totpTimer) clearInterval(totpTimer);
  totpTimer = setInterval(tick, 1000);
}

function setRunning(running) {
  const dot = $('dotRun');
  if (!dot) return;
  dot.className = running ? 'dot ok' : 'dot bad';
  setText('runText', running ? dt('status.running') : dt('status.stopped'));
}

function renderSshState(runtime) {
  const card = $('sshStateCard');
  const btn = $('btnRestartSsh');
  const canRestart = !!(runtime && runtime.canRestartSsh);
  if (btn) btn.hidden = !canRestart;
  if (card) card.hidden = false;

  if (!canRestart) {
    setText('sshState', dt('status.notEnabled'));
    setText('sshStateMini', dt('status.na'));
    setText('sshHint', dt('message.sshNotProxy'));
    if (card) card.dataset.state = 'idle';
    return;
  }

  const state = String(runtime.sshState || '').trim().toLowerCase();
  if (state === 'running') {
    setText('sshState', dt('status.connected'));
    setText('sshStateMini', dt('status.connected'));
    setText('sshHint', runtime.sshLocalPort ? dt('message.sshForwardPort', { port: runtime.sshLocalPort }) : dt('message.sshTunnelHealthy'));
    if (card) card.dataset.state = 'running';
  } else if (state === 'reconnecting') {
    setText('sshState', dt('status.reconnecting'));
    setText('sshStateMini', dt('status.reconnecting'));
    setText('sshHint', dt('message.sshReconnectingHint'));
    if (card) card.dataset.state = 'warn';
  } else {
    setText('sshState', dt('status.disconnected'));
    setText('sshStateMini', dt('status.disconnected'));
    setText('sshHint', runtime.sshLastError ? localizeKnownMessage(runtime.sshLastError) : dt('message.sshStoppedHint'));
    if (card) card.dataset.state = 'error';
  }
}

function syncRestartButton(runtime) {
  const btn = $('btnRestartSsh');
  if (!btn) return;
  if (!runtime || !runtime.canRestartSsh) {
    btn.hidden = true;
    btn.disabled = false;
    btn.textContent = dt('button.restartSsh');
    return;
  }
  btn.hidden = false;
  if (runtime.sshState === 'reconnecting') {
    btn.disabled = true;
    btn.textContent = dt('button.busy.reconnecting');
  } else {
    btn.disabled = false;
    btn.textContent = dt('button.restartSsh');
  }
}

function maybeShowSshWarning(runtime) {
  if (runtime && runtime.canRestartSsh && runtime.sshState === 'stopped') {
    setErr(runtime.sshLastError || dt('message.sshDisconnectedRecover'), 'warn');
  } else if (runtime && runtime.sshState === 'reconnecting') {
    setErr(dt('message.sshReconnecting'), 'info');
  } else {
    setErr('');
  }
}

async function refreshProfile() {
  const profile = await getJson('/profiles/' + encodeURIComponent(profileId));
  currentProfile = profile;
  setText('pid', profileId || `(${dt('common.none')})`);
  setText('profileInline', profileId || `(${dt('common.none')})`);
  setText('api', apiBase);
  setText('name', profile.name || '-');
  setText('pName', profile.name || '-');
  setText('createdAt', fmtTime(profile.createdAt));
  setText('remark', profile.remark || '-');
  setText('preProxyOverride', profile.preProxyOverride || '-');
  renderTags(profile.tags || []);
  setText('proxyMasked', maskProxy(profile.proxyStr || '') || '-');
  $('btnCopyProxy').onclick = async () => copyText(profile.proxyStr || '');
  $('btnCopyProfile').onclick = async () => copyText(profileId);
  $('copyRemark').onclick = async () => copyText(profile.remark || '');
  setText('fingerprint', pretty(profile.fingerprint || {}));

  const remark = String(profile.remark || '');
  const parts = remark.split('----').map(s => String(s || '').trim());
  if (parts.length >= 3) {
    const email = parts[0] || '';
    const secret = parts[parts.length - 1] || '';
    const aux = parts.length >= 4 ? (parts[2] || '') : '';
    if (email && secret) startTotp(email, aux, secret);
    else stopTotp();
  } else {
    stopTotp();
  }

  return profile;
}

async function refreshRuntime() {
  const runtime = await getJson('/profiles/' + encodeURIComponent(profileId) + '/runtime').catch(() => ({
    running: false,
    proxyType: currentProfile ? formatProxyType((currentProfile.proxyStr || '').split('://')[0]) : '-',
    canRestartSsh: false,
    sshState: null,
    sshLastError: '',
  }));
  currentRuntime = runtime;
  const endpointDisplay = buildRuntimeEndpointDisplay(runtime);
  setRunning(!!runtime.running);
  setText('proxyType', formatProxyType(runtime.proxyType));
  setText('ws', endpointDisplay.wsDisplay);
  setText('http', endpointDisplay.httpDisplay);
  setText('debugPort', runtime.running ? (runtime.debugPort || dt('status.notEnabled')) : '-');
  setText('localPort', runtime.running ? (runtime.localPort || '-') : '-');
  setText('sshLocalPort', runtime.running ? (runtime.canRestartSsh ? (runtime.sshLocalPort || dt('status.notEnabled')) : dt('status.na')) : '-');
  setText('resolvedTimezone', runtime.resolvedTimezone || '-');
  setText('resolvedLanguage', runtime.resolvedLanguage || '-');
  setText('resolvedAcceptLanguage', runtime.resolvedAcceptLanguage || '-');
  const geo = runtime.resolvedGeolocation && runtime.resolvedGeolocation.latitude !== undefined && runtime.resolvedGeolocation.longitude !== undefined
    ? `${runtime.resolvedGeolocation.latitude}, ${runtime.resolvedGeolocation.longitude}`
    : '-';
  setText('resolvedGeolocation', geo);
  setText('geoPermissionState', formatPermissionStateText(runtime.geoPermissionState || '-'));
  setText('cameraPermissionState', formatPermissionStateText(runtime.cameraPermissionState || '-'));
  setText('microphonePermissionState', formatPermissionStateText(runtime.microphonePermissionState || '-'));
  setText('notificationPermissionState', formatPermissionStateText(runtime.notificationPermissionState || '-'));
  setText('activeHeaderPreset', runtime.activeHeaderPresetId || '-');
  setText('autoCalibrationError', localizeKnownMessage(runtime.autoCalibrationError || dt('status.ok')));
  renderSshState(runtime);
  syncRestartButton(runtime);
  maybeShowSshWarning(runtime);

  $('btnCopyWs').onclick = async () => { if (endpointDisplay.wsCopy) await copyText(endpointDisplay.wsCopy); };
  $('copyWs').onclick = async () => { if (endpointDisplay.wsCopy) await copyText(endpointDisplay.wsCopy); };
  $('copyHttp').onclick = async () => { if (endpointDisplay.httpCopy) await copyText(endpointDisplay.httpCopy); };
  return runtime;
}

async function refreshIp() {
  setText('ip', '...');
  setText('ipMeta', '...');
  $('btnCopyIp').onclick = null;
  try {
    const ip = await getJson('/profiles/' + encodeURIComponent(profileId) + '/ip');
    setText('ip', ip.ip || '-');
    setText('ipMeta', ip.source || '-');
    $('btnCopyIp').onclick = async () => copyText(ip.ip || '');
    return ip;
  } catch (e) {
    setText('ip', '-');
    setText('ipMeta', '-');
    return null;
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
    const net = await getJson('/profiles/' + encodeURIComponent(profileId) + '/netinfo');
    setText('netIp', net.ip || '-');
    setText('loc', [net.city, net.region, net.country].filter(Boolean).join(', ') || '-');
    setText('tz', net.timezone || '-');
    setText('org', [net.asn, net.org].filter(Boolean).join(' ') || '-');
    const lat = (net.latitude !== undefined && net.latitude !== null) ? String(net.latitude) : '';
    const lon = (net.longitude !== undefined && net.longitude !== null) ? String(net.longitude) : '';
    setText('geo', lat && lon ? (lat + ', ' + lon) : '-');
    setText('postal', net.postal || '-');
    setText('netSource', net.source || '-');
    return net;
  } catch (e) {
    setText('netIp', '-');
    setText('loc', '-');
    setText('tz', '-');
    setText('org', '-');
    setText('geo', '-');
    setText('postal', '-');
    setText('netSource', '-');
    return null;
  }
}

async function refreshProxyTest(run = false) {
  setText('proxyTestStatus', run ? dt('button.busy.testing') : '...');
  setText('proxyTestLatency', '...');
  setText('proxyTestCheckedAt', '...');
  try {
    const data = run
      ? await postJson('/profiles/' + encodeURIComponent(profileId) + '/proxy-test')
      : await getJson('/profiles/' + encodeURIComponent(profileId) + '/proxy-test');
    currentProxyTest = data;
    setText('proxyTestStatus', formatProxyTestStatus(data));
    setText('proxyTestLatency', data && data.latencyMs != null ? `${data.latencyMs} ms` : '-');
    setText('proxyTestCheckedAt', fmtTime(data && data.checkedAt));
    return data;
  } catch (e) {
    currentProxyTest = null;
    setText('proxyTestStatus', dt('status.failed'));
    setText('proxyTestLatency', '-');
    setText('proxyTestCheckedAt', '-');
    if (run) setErr(e && e.message ? e.message : String(e));
    return null;
  }
}

function renderBrowserInfo() {
  setText('browserInfo', pretty({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
  }));
}

async function queryGeoPermissionState() {
  return queryPermissionState('geolocation');
}

async function probeGeolocation(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
      resolve({ ok: false, error: dt('message.geolocationUnavailable') });
      return;
    }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: dt('message.timeout') }), timeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => finish({ ok: true, coords: position.coords }),
        (error) => finish({ ok: false, error: error && error.message ? error.message : dt('message.geolocationError') }),
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 0 }
      );
    } catch (e) {
      finish({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

function renderSelfCheck(diagnostics, liveCheck) {
  const serverSummary = currentRuntime && currentRuntime.selfCheckSummary && Array.isArray(currentRuntime.selfCheckSummary.items)
    ? currentRuntime.selfCheckSummary.items.map(item => ({ ...item, source: 'runtime' }))
    : [];
  const liveItems = liveCheck && Array.isArray(liveCheck.items)
    ? liveCheck.items.map(item => ({ ...item, source: 'browser' }))
    : [];
  const items = [...serverSummary, ...liveItems];
  const status = items.some(item => item.status === 'warn') ? 'warn' : 'ok';
  setText('selfCheckStatus', formatStatusText(status));
  setText('diagGeoPermission', formatPermissionStateText((diagnostics && diagnostics.geoPermissionState) || (currentRuntime && currentRuntime.geoPermissionState) || '-'));
  setText('diagHeaderPreset', (diagnostics && diagnostics.activeHeaderPresetId) || (currentRuntime && currentRuntime.activeHeaderPresetId) || '-');

  const list = $('selfCheckList');
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(dt('empty.selfCheck'))}</div>`;
  } else {
    list.innerHTML = items.map(item => `
      <div class="check-item" data-status="${escapeHtml(item.status || 'ok')}">
        <div class="check-main">
          <div class="check-label">${escapeHtml(localizeKnownLabel(item.label || item.key || '-', item.key))} <span class="preset-source">${escapeHtml(formatCheckSource(item.source || 'runtime'))}</span></div>
          <div class="check-msg">${escapeHtml(localizeKnownMessage(item.message || '-'))}</div>
        </div>
        <div class="check-badge" data-status="${escapeHtml(item.status || 'ok')}">${escapeHtml(formatStatusText(item.status || 'ok'))}</div>
      </div>
    `).join('');
  }

  const headerPreview = diagnostics && diagnostics.headerPreview;
  const headerPreviewEl = $('headerPreview');
  if (headerPreviewEl) headerPreviewEl.textContent = pretty(headerPreview || {});
  const permissionSnapshotEl = $('permissionSnapshot');
  if (permissionSnapshotEl) permissionSnapshotEl.textContent = pretty(liveCheck && liveCheck.permissionSnapshot ? liveCheck.permissionSnapshot : {});
  const acceptChProbeEl = $('acceptChProbe');
  if (acceptChProbeEl) acceptChProbeEl.textContent = pretty(liveCheck && liveCheck.acceptChProbe ? liveCheck.acceptChProbe : {});
  const webgpuSnapshotEl = $('webgpuSnapshot');
  if (webgpuSnapshotEl) webgpuSnapshotEl.textContent = pretty(liveCheck && liveCheck.webgpuSnapshot ? liveCheck.webgpuSnapshot : {});
  const fontsSnapshotEl = $('fontsSnapshot');
  if (fontsSnapshotEl) fontsSnapshotEl.textContent = pretty(liveCheck && liveCheck.fontsSnapshot ? liveCheck.fontsSnapshot : {});
  const mediaDevicesSnapshotEl = $('mediaDevicesSnapshot');
  if (mediaDevicesSnapshotEl) mediaDevicesSnapshotEl.textContent = pretty(liveCheck && liveCheck.mediaDevicesSnapshot ? liveCheck.mediaDevicesSnapshot : {});
}

function renderUnifiedVerdict(diagnostics, liveCheck) {
  const verdict = buildUnifiedVerdict(diagnostics, liveCheck);
  setText('verdictStatus', formatStatusText(verdict.overallStatus));
  setText('verdictLocalStatus', formatStatusText(verdict.localStatus));
  setText('verdictExternalStatus', formatStatusText(verdict.externalStatus));
  setText('verdictAgreement', formatAgreementText(verdict.agreement));
  setText('verdictHeadline', verdict.headline);
  setText('verdictSummary', verdict.summary);
  const latestWrap = $('verdictLatestRun');
  if (latestWrap) {
    const latest = verdict.latestExternalRun;
    latestWrap.innerHTML = latest ? `
      <div class="verdict-latest">
        <div class="verdict-latest-top">
          <div>
            <div class="verdict-latest-name">${escapeHtml(localizeKnownLabel(latest.label || '-'))}</div>
            <div class="verdict-latest-meta">${escapeHtml(latest.openedAt || '-')}</div>
          </div>
          <div class="verdict-inline-badge" data-status="${escapeHtml(normalizeStatus(latest.status, 'info'))}">${escapeHtml(formatStatusText(normalizeStatus(latest.status, 'info')))}</div>
        </div>
        <div class="verdict-latest-text">${escapeHtml(localizeKnownMessage(latest.summary || '-'))}</div>
      </div>
    ` : `<div class="empty-state">${escapeHtml(dt('empty.latestRun'))}</div>`;
  }
  const siteWrap = $('verdictSiteStatuses');
  if (siteWrap) {
    const siteStatuses = Array.isArray(verdict.siteStatuses) ? verdict.siteStatuses : [];
    siteWrap.innerHTML = siteStatuses.length > 0 ? `
      <div class="verdict-site-grid">${siteStatuses.map((item) => `
        <div class="verdict-site-item" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">
          <div>
            <div class="verdict-site-name">${escapeHtml(localizeKnownLabel(item.label || '-'))}</div>
            <div class="verdict-site-text">${escapeHtml(localizeKnownMessage(item.summary || '-'))}</div>
          </div>
          <div class="verdict-inline-badge" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">${escapeHtml(formatStatusText(normalizeStatus(item.status, 'info')))}</div>
        </div>
      `).join('')}</div>
    ` : `<div class="empty-state">${escapeHtml(dt('empty.siteStatuses'))}</div>`;
  }
  const warningWrap = $('verdictWarnings');
  if (warningWrap) {
    const warnings = Array.isArray(verdict.keyWarnings) ? verdict.keyWarnings : [];
    warningWrap.innerHTML = warnings.length > 0 ? `
      <div class="verdict-warning-list">${warnings.map((item) => `
        <div class="verdict-warning-item" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">
          <div>
            <div class="verdict-warning-label">${escapeHtml(localizeKnownLabel(item.label || '-'))}</div>
            <div class="verdict-warning-text">${escapeHtml(localizeKnownMessage(item.message || '-'))}</div>
          </div>
          <div class="verdict-inline-badge" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">${escapeHtml(formatStatusText(normalizeStatus(item.status, 'info')))}</div>
        </div>
      `).join('')}</div>
    ` : `<div class="empty-state">${escapeHtml(dt('empty.keyWarnings'))}</div>`;
  }
  const wrap = $('verdictList');
  if (!wrap) return;
  wrap.innerHTML = (Array.isArray(verdict.items) ? verdict.items : []).map(item => `
    <div class="check-item" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">
      <div class="check-main">
        <div class="check-label">${escapeHtml(localizeKnownLabel(item.label || '-'))}</div>
        <div class="check-msg">${escapeHtml(localizeKnownMessage(item.message || '-'))}</div>
      </div>
      <div class="check-badge" data-status="${escapeHtml(normalizeStatus(item.status, 'info'))}">${escapeHtml(formatStatusText(normalizeStatus(item.status, 'info')))}</div>
    </div>
  `).join('');

  renderPixelscanFixBar(diagnostics);
}

function getLatestPixelscanRun(diagnostics) {
  const runs = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
  const pixelscanRuns = runs.filter((run) => String(run && run.presetId || '').trim() === 'builtin-pixelscan');
  pixelscanRuns.sort((a, b) => Number(b && b.openedAt || 0) - Number(a && a.openedAt || 0));
  return pixelscanRuns[0] || null;
}

function extractPixelscanSignalsText(run) {
  const result = run && run.result ? run.result : {};
  const lines = [];
  if (result.summary) lines.push(String(result.summary));
  if (Array.isArray(result.signals)) lines.push(...result.signals.map(s => String(s || '')).filter(Boolean));
  return lines.join('\n');
}

async function applyPixelscanCompatPreset() {
  if (!profileId) return;
  if (!window.confirm(dt('message.pixelscanCompatConfirm'))) return;
  setBusy('btnPixelscanCompat', true, dt('button.busy.applying'));
  setErr('');
  try {
    await patchJson('/profiles/' + encodeURIComponent(profileId), {
      fingerprint: {
        protection: {
          canvasNoise: 'off',
          audioNoise: 'off',
          webglNoise: 'off',
          clientRects: 'off',
          speechVoices: 'off',
          mediaDevices: 'off',
          portScanProtection: 'off',
        }
      }
    });
    await refreshProfile();
    setErr(dt('message.pixelscanCompatApplied'), 'info');
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnPixelscanCompat', false, dt('button.applyPixelscanCompat'));
  }
}

function renderPixelscanFixBar(diagnostics) {
  const bar = $('pixelscanFixBar');
  const textEl = $('pixelscanFixText');
  const btn = $('btnPixelscanCompat');
  if (!bar || !textEl || !btn) return;

  const run = getLatestPixelscanRun(diagnostics);
  const status = normalizeStatus(run && run.result && run.result.status, 'info');
  if (status !== 'warn') {
    bar.hidden = true;
    btn.onclick = null;
    return;
  }

  const signals = extractPixelscanSignalsText(run).toLowerCase();
  bar.hidden = false;
  textEl.textContent = /masking detected/i.test(signals) ? dt('message.pixelscanMaskingHint') : dt('message.pixelscanWarnHint');
  btn.onclick = () => applyPixelscanCompatPreset().catch(e => setErr(e && e.message ? e.message : String(e)));
}

function renderDiagnosticPresets(diagnostics) {
  const wrap = $('diagnosticPresetList');
  if (!wrap) return;
  const presets = diagnostics && Array.isArray(diagnostics.presets) ? diagnostics.presets : [];
  if (presets.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${escapeHtml(dt('empty.presets'))}</div>`;
    return;
  }
  wrap.innerHTML = presets.map(preset => `
    <button class="btn preset-btn" data-preset-id="${escapeHtml(preset.id)}">
      <strong>${escapeHtml(preset.name || preset.id)}</strong>
      <span>${escapeHtml(preset.url || '')}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('[data-preset-id]').forEach((btn) => {
    btn.onclick = () => openDiagnosticPreset(btn.dataset.presetId).catch(e => setErr(e && e.message ? e.message : String(e)));
  });
}

function renderLatestPresetRuns(diagnostics) {
  const wrap = $('diagnosticPresetLatest');
  if (!wrap) return;
  const runs = getUnifiedExternalRuns(diagnostics, 8);
  if (runs.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${escapeHtml(dt('empty.latestByPreset'))}</div>`;
    return;
  }
  wrap.innerHTML = runs.map((item) => {
    const result = item && item.result ? item.result : {};
    const status = normalizeStatus(result.status, 'info');
    const artifacts = result.artifacts || {};
    const comparison = item && item.comparison ? item.comparison : null;
    const summary = localizeKnownSummaryLines([
      result.summary || '',
      ...(Array.isArray(result.signals) ? result.signals.slice(0, 3) : []),
    ], 4).join('\n');
    return `
      <div class="diag-mini-card" data-status="${escapeHtml(status)}">
        <div class="diag-mini-top">
          <div>
            <div class="diag-mini-name">${escapeHtml(localizeKnownMessage(result.headline || item.name || item.presetId || '-'))}</div>
            <div class="diag-mini-meta">${escapeHtml(fmtTime(item.openedAt))}</div>
          </div>
          <div class="check-badge" data-status="${escapeHtml(status)}">${escapeHtml(formatStatusText(status))}</div>
        </div>
        <div class="diag-mini-summary">${escapeHtml(summary || result.finalUrl || item.url || '-')}</div>
        ${comparison && comparison.summary ? `<div class="recent-compare" data-changed="${comparison.changed ? 'true' : 'false'}">${escapeHtml(dt('message.vsPrevious', { summary: localizeKnownMessage(comparison.summary) }))}</div>` : ''}
        <div class="diag-mini-actions">
          ${artifacts.runId ? `<button class="diag-mini-action" type="button" data-run-id="${escapeHtml(artifacts.runId)}">${escapeHtml(dt('artifact.details'))}</button>` : ''}
          <button class="diag-mini-action" type="button" data-rerun-preset-id="${escapeHtml(item.presetId || '')}">${escapeHtml(dt('button.rerun'))}</button>
        </div>
        ${buildDiagnosticArtifactLinksMarkup(artifacts) ? `<div class="artifact-links">${buildDiagnosticArtifactLinksMarkup(artifacts)}</div>` : ''}
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('[data-run-id]').forEach((btn) => {
    btn.onclick = () => openDiagnosticRunDetails(btn.dataset.runId);
  });
  wrap.querySelectorAll('[data-rerun-preset-id]').forEach((btn) => {
    btn.onclick = () => openDiagnosticPreset(btn.dataset.rerunPresetId).catch(e => setErr(e && e.message ? e.message : String(e)));
  });
}

function renderRecentRuns(diagnostics) {
  const wrap = $('diagnosticRecentRuns');
  if (!wrap) return;
  const recentRuns = diagnostics && Array.isArray(diagnostics.recentRuns) ? diagnostics.recentRuns : [];
  if (recentRuns.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${escapeHtml(dt('empty.recentRuns'))}</div>`;
    return;
  }
  wrap.innerHTML = recentRuns.map(item => {
    const result = item && item.result ? item.result : {};
    const status = ['ok', 'warn', 'info'].includes(String(result.status || '').toLowerCase()) ? String(result.status).toLowerCase() : 'info';
    const artifacts = result && result.artifacts ? result.artifacts : {};
    const facts = normalizeDiagnosticFacts(result.facts, 4);
    const comparison = item && item.comparison ? item.comparison : null;
    const artifactLinks = buildDiagnosticArtifactLinksMarkup(artifacts, { detailRunId: artifacts.runId || '' });
    const summaryLines = localizeKnownSummaryLines([
      result.summary || '',
      ...(Array.isArray(result.signals) ? result.signals.slice(0, 3) : []),
      result.finalUrl || item.url || '',
    ], 4);
    return `
    <div class="recent-item" data-status="${escapeHtml(status)}">
      <div class="check-main">
        <div class="check-label">${escapeHtml(localizeKnownMessage(result.headline || item.name || item.presetId || '-'))}</div>
        <div class="recent-sub">${escapeHtml(summaryLines.join('\n') || '-')}</div>
        ${comparison && comparison.summary ? `<div class="recent-compare" data-changed="${comparison.changed ? 'true' : 'false'}">${escapeHtml(dt('message.vsPrevious', { summary: localizeKnownMessage(comparison.summary) }))}</div>` : ''}
        ${facts.length > 0 ? `<div class="recent-facts">${facts.map((fact) => `
          <div class="recent-fact" data-status="${escapeHtml(fact.status)}">
            <span class="recent-fact-label">${escapeHtml(localizeKnownLabel(fact.label))}</span>
            <span class="recent-fact-value">${escapeHtml(localizeKnownMessage(fact.value))}</span>
          </div>
        `).join('')}</div>` : ''}
        ${artifactLinks ? `<div class="artifact-links">${artifactLinks}</div>` : ''}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
        <div class="check-badge" data-status="${escapeHtml(status)}">${escapeHtml(formatStatusText(status))}</div>
        <div class="recent-time">${escapeHtml(fmtTime(item.openedAt))}</div>
      </div>
    </div>
  `;
  }).join('');
  wrap.querySelectorAll('[data-run-id]').forEach((btn) => {
    btn.onclick = () => openDiagnosticRunDetails(btn.dataset.runId);
  });
}

function applyDiagnosticsData(diagnostics, { mark = false } = {}) {
  currentDiagnostics = diagnostics;
  renderDiagnosticPresets(diagnostics);
  renderLatestPresetRuns(diagnostics);
  renderRecentRuns(diagnostics);
  if (mark) markUpdated();
}

async function runLocalSelfCheck(runtime, diagnostics) {
  const expected = diagnostics && diagnostics.expectedBrowser ? diagnostics.expectedBrowser : {};
  const observedHeaders = diagnostics && diagnostics.observedHeaders ? diagnostics.observedHeaders : {};
  const expectedTimezone = expected.timezone || (runtime && runtime.resolvedTimezone) || '';
  const expectedLanguage = expected.language || (runtime && runtime.resolvedLanguage) || '';
  const expectedLanguages = Array.isArray(expected.languages) && expected.languages.length ? expected.languages : ((runtime && runtime.resolvedLanguages) || []);
  const expectedAcceptLanguage = expected.acceptLanguage || (runtime && runtime.resolvedAcceptLanguage) || '';
  const expectedPermissionStates = {
    geolocation: normalizePermissionState(expected.geoPermissionState || (expected.permissionStates && expected.permissionStates.geolocation) || (runtime && runtime.geoPermissionState) || 'prompt'),
    camera: normalizePermissionState(expected.permissionStates && expected.permissionStates.camera || (runtime && runtime.cameraPermissionState) || 'prompt'),
    microphone: normalizePermissionState(expected.permissionStates && expected.permissionStates.microphone || (runtime && runtime.microphonePermissionState) || 'prompt'),
    notifications: normalizePermissionState(expected.permissionStates && expected.permissionStates.notifications || (runtime && runtime.notificationPermissionState) || 'prompt'),
  };
  const expectedGeoPermission = expectedPermissionStates.geolocation;
  const expectedGeo = expected.geolocation || (expectedGeoPermission === 'granted' ? (runtime && runtime.resolvedGeolocation) : null);
  const expectedClientHints = expected.clientHints || {};
  const expectedChromeVersion = String(expectedClientHints.chromeVersion || expected.userAgent && extractChromeVersion(expected.userAgent) || '').trim();
  const expectedChromeMajor = String(expectedClientHints.majorVersion || (expectedChromeVersion ? expectedChromeVersion.split('.')[0] : '')).trim();
  const expectedFonts = Array.isArray(expected.fonts) ? expected.fonts : [];
  const expectedMediaDevices = buildExpectedMediaDeviceTemplate(expected.mediaDevices);

  const intlInfo = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions();
    } catch (e) {
      return {};
    }
  })();
  const permissionSnapshot = await queryPermissionSnapshot();
  const userAgentData = await readUserAgentDataSnapshot();
  const acceptChProbe = Object.keys(expectedClientHints).length > 0 ? await runAcceptChProbe() : null;
  const acceptChHeaders = acceptChProbe && acceptChProbe.headers ? acceptChProbe.headers : {};
  const webgpuSnapshot = await readWebGpuSnapshot();
  const fontsSnapshot = await readFontsSnapshot(expectedFonts);
  const mediaDevicesSnapshot = await readMediaDevicesSnapshot();
  const items = [];
  const push = (key, label, status, message) => items.push({ key, label, status, message });

  push('userAgent', 'navigator.userAgent', expected.userAgent && navigator.userAgent !== expected.userAgent ? 'warn' : 'ok',
    expected.userAgent ? formatExpectedActual(expected.userAgent, navigator.userAgent) : navigator.userAgent);
  push('platform', 'navigator.platform', expected.platform && navigator.platform !== expected.platform ? 'warn' : 'ok',
    expected.platform ? formatExpectedActual(expected.platform, navigator.platform) : navigator.platform);
  push('language', 'navigator.language', expectedLanguage && navigator.language !== expectedLanguage ? 'warn' : 'ok',
    formatExpectedActual(expectedLanguage || '-', navigator.language || '-'));
  push('languages', 'navigator.languages', JSON.stringify(navigator.languages || []) !== JSON.stringify(expectedLanguages || []) ? 'warn' : 'ok',
    formatExpectedActual(JSON.stringify(expectedLanguages || []), JSON.stringify(navigator.languages || [])));
  push('timezone', 'Intl.timeZone', expectedTimezone && intlInfo.timeZone !== expectedTimezone ? 'warn' : 'ok',
    formatExpectedActual(expectedTimezone || '-', intlInfo.timeZone || '-'));
  push('geoPermission', 'permissions.query(geolocation)', permissionSnapshot.geolocation !== expectedPermissionStates.geolocation ? 'warn' : 'ok',
    formatExpectedActual(formatPermissionStateText(expectedPermissionStates.geolocation), formatPermissionStateText(permissionSnapshot.geolocation)));
  push('cameraPermission', 'permissions.query(camera)', permissionSnapshot.camera !== expectedPermissionStates.camera ? 'warn' : 'ok',
    formatExpectedActual(formatPermissionStateText(expectedPermissionStates.camera), formatPermissionStateText(permissionSnapshot.camera)));
  push('microphonePermission', 'permissions.query(microphone)', permissionSnapshot.microphone !== expectedPermissionStates.microphone ? 'warn' : 'ok',
    formatExpectedActual(formatPermissionStateText(expectedPermissionStates.microphone), formatPermissionStateText(permissionSnapshot.microphone)));
  push('notificationsPermission', 'permissions.query(notifications)', permissionSnapshot.notifications !== expectedPermissionStates.notifications ? 'warn' : 'ok',
    formatExpectedActual(formatPermissionStateText(expectedPermissionStates.notifications), formatPermissionStateText(permissionSnapshot.notifications)));
  push('notificationPermission', 'Notification.permission',
    notificationPermissionValueToState(permissionSnapshot.notificationPermission) !== expectedPermissionStates.notifications ? 'warn' : 'ok',
    formatExpectedActual(formatPermissionStateText(stateToNotificationPermissionValue(expectedPermissionStates.notifications)), formatPermissionStateText(permissionSnapshot.notificationPermission)));
  push('requestUserAgent', 'Request User-Agent', expected.userAgent && observedHeaders.userAgent !== expected.userAgent ? 'warn' : 'ok',
    formatExpectedActual(expected.userAgent || '-', observedHeaders.userAgent || '-'));
  push('acceptLanguage', 'Accept-Language', expectedAcceptLanguage && normalizeHeaderValue(observedHeaders.acceptLanguage) !== normalizeHeaderValue(expectedAcceptLanguage) ? 'warn' : 'ok',
    formatExpectedActual(expectedAcceptLanguage || '-', observedHeaders.acceptLanguage || '-'));
  push('headerPreset', 'Header Preview', diagnostics && diagnostics.headerPreview && diagnostics.headerPreview.enabled && diagnostics.headerPreview.rules && diagnostics.headerPreview.rules.length
    ? 'ok'
    : 'ok',
    diagnostics && diagnostics.headerPreview && diagnostics.headerPreview.rules && diagnostics.headerPreview.rules.length
      ? `${diagnostics.headerPreview.name || diagnostics.headerPreview.presetId} (${diagnostics.headerPreview.rules.length} rules)`
      : dt('message.notBound'));

  if (Object.keys(expectedClientHints).length > 0) {
    push(
      'userAgentDataSupport',
      'navigator.userAgentData',
      userAgentData.supported ? 'ok' : 'warn',
      userAgentData.supported ? dt('message.available') : dt('message.unsupported')
    );
    if (userAgentData.error) {
      push('userAgentDataError', 'userAgentData.getHighEntropyValues', 'warn', userAgentData.error);
    } else if (userAgentData.supported) {
      const low = userAgentData.low || {};
      const high = userAgentData.high || {};
      push(
        'userAgentDataPlatform',
        'userAgentData.platform',
        expectedClientHints.platform && String(low.platform || '') !== String(expectedClientHints.platform || '') ? 'warn' : 'ok',
        formatExpectedActual(expectedClientHints.platform || '-', low.platform || '-')
      );
      push(
        'userAgentDataMobile',
        'userAgentData.mobile',
        typeof expectedClientHints.mobile === 'boolean' && !!low.mobile !== !!expectedClientHints.mobile ? 'warn' : 'ok',
        formatExpectedActual(!!expectedClientHints.mobile, !!low.mobile)
      );
      push(
        'userAgentDataBrands',
        'userAgentData.brands',
        hasExpectedChromeBrands(low.brands, expectedChromeMajor, expectedClientHints.browserBrands) ? 'ok' : 'warn',
        JSON.stringify(normalizeBrandList(low.brands))
      );
      push(
        'userAgentDataFullVersion',
        'userAgentData.uaFullVersion',
        expectedChromeVersion && String(high.uaFullVersion || '') !== expectedChromeVersion ? 'warn' : 'ok',
        formatExpectedActual(expectedChromeVersion || '-', high.uaFullVersion || '-')
      );
      push(
        'userAgentDataArchitecture',
        'userAgentData.architecture',
        expectedClientHints.architecture && String(high.architecture || '') !== String(expectedClientHints.architecture || '') ? 'warn' : 'ok',
        formatExpectedActual(expectedClientHints.architecture || '-', high.architecture || '-')
      );
      push(
        'userAgentDataBitness',
        'userAgentData.bitness',
        expectedClientHints.bitness && String(high.bitness || '') !== String(expectedClientHints.bitness || '') ? 'warn' : 'ok',
        formatExpectedActual(expectedClientHints.bitness || '-', high.bitness || '-')
      );
      push(
        'userAgentDataPlatformVersion',
        'userAgentData.platformVersion',
        String(high.platformVersion || '') !== String(expectedClientHints.platformVersion || '') ? 'warn' : 'ok',
        formatExpectedActual(expectedClientHints.platformVersion || '-', high.platformVersion || '-')
      );
      push(
        'userAgentDataWow64',
        'userAgentData.wow64',
        typeof expectedClientHints.wow64 === 'boolean' && !!high.wow64 !== !!expectedClientHints.wow64 ? 'warn' : 'ok',
        formatExpectedActual(!!expectedClientHints.wow64, !!high.wow64)
      );
      push(
        'secChUa',
        'Sec-CH-UA',
        secChUaLooksConsistent(observedHeaders.secChUa, expectedChromeMajor, expectedClientHints.browserBrands) ? 'ok' : 'warn',
        observedHeaders.secChUa || '-'
      );
      push(
        'secChUaMobile',
        'Sec-CH-UA-Mobile',
        String(observedHeaders.secChUaMobile || '') !== (expectedClientHints.mobile ? '?1' : '?0') ? 'warn' : 'ok',
        `expected=${expectedClientHints.mobile ? '?1' : '?0'}\nactual=${observedHeaders.secChUaMobile || '-'}`
      );
      push(
        'secChUaPlatform',
        'Sec-CH-UA-Platform',
        normalizeQuotedHeaderValue(observedHeaders.secChUaPlatform) !== String(expectedClientHints.platform || '') ? 'warn' : 'ok',
        `expected=${expectedClientHints.platform || '-'}\nactual=${normalizeQuotedHeaderValue(observedHeaders.secChUaPlatform) || '-'}`
      );
      if (!acceptChProbe || !acceptChProbe.ok) {
        push(
          'acceptChProbe',
          'Accept-CH probe',
          'warn',
          acceptChProbe && acceptChProbe.error ? acceptChProbe.error : dt('message.probeUnavailable')
        );
      } else {
        const hasHints = hasHighEntropyClientHints(acceptChHeaders);
        push(
          'acceptChProbe',
          'Accept-CH probe',
          hasHints ? 'ok' : 'warn',
          hasHints ? dt('message.highEntropyCaptured') : dt('message.highEntropyMissing')
        );
        push(
          'secChUaFullVersionList',
          'Sec-CH-UA-Full-Version-List',
          secChUaFullVersionListLooksConsistent(acceptChHeaders.secChUaFullVersionList, expectedChromeVersion, expectedClientHints.browserBrands) ? 'ok' : 'warn',
          formatExpectedActual(expectedChromeVersion || '-', acceptChHeaders.secChUaFullVersionList || '-')
        );
        push(
          'secChUaArch',
          'Sec-CH-UA-Arch',
          normalizeQuotedHeaderValue(acceptChHeaders.secChUaArch) !== String(expectedClientHints.architecture || '') ? 'warn' : 'ok',
          formatExpectedActual(expectedClientHints.architecture || '-', normalizeQuotedHeaderValue(acceptChHeaders.secChUaArch) || '-')
        );
        push(
          'secChUaBitness',
          'Sec-CH-UA-Bitness',
          normalizeQuotedHeaderValue(acceptChHeaders.secChUaBitness) !== String(expectedClientHints.bitness || '') ? 'warn' : 'ok',
          formatExpectedActual(expectedClientHints.bitness || '-', normalizeQuotedHeaderValue(acceptChHeaders.secChUaBitness) || '-')
        );
        push(
          'secChUaPlatformVersion',
          'Sec-CH-UA-Platform-Version',
          normalizeQuotedHeaderValue(acceptChHeaders.secChUaPlatformVersion) !== String(expectedClientHints.platformVersion || '') ? 'warn' : 'ok',
          formatExpectedActual(expectedClientHints.platformVersion || '-', normalizeQuotedHeaderValue(acceptChHeaders.secChUaPlatformVersion) || '-')
        );
        if (typeof expectedClientHints.wow64 === 'boolean') {
          push(
            'secChUaWow64',
            'Sec-CH-UA-Wow64',
            String(acceptChHeaders.secChUaWow64 || '') !== (expectedClientHints.wow64 ? '?1' : '?0') ? 'warn' : 'ok',
            formatExpectedActual(expectedClientHints.wow64 ? '?1' : '?0', acceptChHeaders.secChUaWow64 || '-')
          );
        }
      }
    }
  }

  if (expectedGeoPermission === 'granted') {
    const geoProbe = await probeGeolocation();
    const geoStatus = geoProbe.ok && isCloseGeo(geoProbe.coords, expectedGeo) ? 'ok' : 'warn';
    const actualGeo = geoProbe.ok ? { latitude: geoProbe.coords.latitude, longitude: geoProbe.coords.longitude } : null;
    push('geolocationProbe', 'navigator.geolocation', geoStatus,
      geoProbe.ok
        ? formatExpectedActual(fmtGeoValue(expectedGeo), fmtGeoValue(actualGeo))
        : formatExpectedActual(fmtGeoValue(expectedGeo), geoProbe.error || dt('status.error')));
  }

  const expectedMediaDeviceCounts = countMediaDevicesByKind(expectedMediaDevices);
  const actualMediaDeviceCounts = countMediaDevicesByKind(mediaDevicesSnapshot.devices);
  const usesDefaultMediaDeviceTemplate = !(Array.isArray(expected.mediaDevices) && expected.mediaDevices.length > 0);
  const mediaDevicesKindsOk = mediaDevicesSnapshot.supported
    && !mediaDevicesSnapshot.error
    && actualMediaDeviceCounts.audioinput >= (usesDefaultMediaDeviceTemplate ? 1 : Math.max(0, expectedMediaDeviceCounts.audioinput || 0))
    && actualMediaDeviceCounts.audiooutput >= (usesDefaultMediaDeviceTemplate ? 1 : Math.max(0, expectedMediaDeviceCounts.audiooutput || 0))
    && actualMediaDeviceCounts.videoinput >= (usesDefaultMediaDeviceTemplate ? 1 : Math.max(0, expectedMediaDeviceCounts.videoinput || 0));
  push(
    'mediaDevicesProbe',
    'mediaDevices.enumerateDevices',
    mediaDevicesSnapshot.supported ? (mediaDevicesKindsOk ? 'ok' : 'warn') : 'warn',
    mediaDevicesSnapshot.supported
      ? (mediaDevicesSnapshot.error
        ? mediaDevicesSnapshot.error
        : formatExpectedActual(JSON.stringify(expectedMediaDeviceCounts), JSON.stringify(actualMediaDeviceCounts)))
      : (mediaDevicesSnapshot.error || dt('message.mediaDevicesUnavailable'))
  );

  const fontProbeTotal = Number(fontsSnapshot.total || 0);
  const fontsOk = fontsSnapshot.supported && (!fontProbeTotal || Number(fontsSnapshot.availableCount || 0) >= 1);
  push(
    'fontsProbe',
    'document.fonts.check',
    fontProbeTotal > 0 ? (fontsOk ? 'ok' : 'warn') : (fontsSnapshot.supported ? 'info' : 'warn'),
    fontProbeTotal > 0
      ? formatExpectedActual(dt('message.sampleCount', { count: fontProbeTotal }), dt('message.availableCount', { count: Number(fontsSnapshot.availableCount || 0) }))
      : (fontsSnapshot.supported ? dt('message.noConfiguredFontSample') : (fontsSnapshot.error || dt('message.fontsApiUnavailable')))
  );

  const webgpuStatus = !webgpuSnapshot.supported
    ? 'info'
    : (webgpuSnapshot.adapterAvailable ? 'ok' : 'warn');
  const webgpuInfo = webgpuSnapshot && webgpuSnapshot.info ? webgpuSnapshot.info : {};
  push(
    'webgpuProbe',
    'navigator.gpu',
    webgpuStatus,
    !webgpuSnapshot.supported
      ? (webgpuSnapshot.error || dt('message.webgpuUnavailable'))
      : (webgpuSnapshot.adapterAvailable
        ? [
          webgpuInfo.vendor || webgpuInfo.architecture || webgpuInfo.device || webgpuInfo.description
            ? `${webgpuInfo.vendor || '-'} / ${webgpuInfo.architecture || '-'} / ${webgpuInfo.device || webgpuInfo.description || '-'}`
            : dt('message.adapterAcquired'),
          dt('message.featureCount', { count: Number(webgpuSnapshot.featureCount || 0) })
        ].join('\n')
        : (webgpuSnapshot.error || dt('message.adapterNull')))
  );

  return {
    status: items.some(item => item.status === 'warn') ? 'warn' : 'ok',
    items,
    permissionSnapshot,
    acceptChProbe: acceptChProbe && acceptChProbe.ok
      ? acceptChHeaders
      : (acceptChProbe && acceptChProbe.error ? { error: acceptChProbe.error } : {}),
    webgpuSnapshot,
    fontsSnapshot,
    mediaDevicesSnapshot,
  };
}

async function refreshDiagnostics() {
  const diagnostics = await getJson('/profiles/' + encodeURIComponent(profileId) + '/diagnostics');
  applyDiagnosticsData(diagnostics);
  try {
    currentLiveSelfCheck = await runLocalSelfCheck(currentRuntime, diagnostics);
  } catch (e) {
    currentLiveSelfCheck = { status: 'warn', items: [{ key: 'selfCheck', label: dt('field.browserSelfCheck'), status: 'warn', message: e && e.message ? e.message : String(e) }] };
  }
  renderUnifiedVerdict(diagnostics, currentLiveSelfCheck);
  renderSelfCheck(diagnostics, currentLiveSelfCheck);
  return diagnostics;
}

async function openDiagnosticPreset(presetId) {
  if (!presetId) return;
  const data = await postJson('/profiles/' + encodeURIComponent(profileId) + '/diagnostics/open', { presetId });
  applyDiagnosticsData(data);
  try {
    currentLiveSelfCheck = await runLocalSelfCheck(currentRuntime, data);
  } catch (e) {
    currentLiveSelfCheck = { status: 'warn', items: [{ key: 'selfCheck', label: dt('field.browserSelfCheck'), status: 'warn', message: e && e.message ? e.message : String(e) }] };
  }
  renderUnifiedVerdict(data, currentLiveSelfCheck);
  renderSelfCheck(data, currentLiveSelfCheck);
  markUpdated();
}

async function runAllDiagnostics() {
  if (!profileId) return;
  setBusy('btnDiagRunAll', true, dt('button.busy.running'));
  setErr('');
  try {
    const data = await postJson('/profiles/' + encodeURIComponent(profileId) + '/diagnostics/run-all', {});
    applyDiagnosticsData(data);
    try {
      currentLiveSelfCheck = await runLocalSelfCheck(currentRuntime, data);
    } catch (e) {
      currentLiveSelfCheck = { status: 'warn', items: [{ key: 'selfCheck', label: dt('field.browserSelfCheck'), status: 'warn', message: e && e.message ? e.message : String(e) }] };
    }
    renderUnifiedVerdict(data, currentLiveSelfCheck);
    renderSelfCheck(data, currentLiveSelfCheck);
    markUpdated();
  } finally {
    setBusy('btnDiagRunAll', false, dt('button.runAll'));
  }
}

async function clearDiagnosticsHistory() {
  if (!profileId) return;
  if (!window.confirm(dt('message.clearDiagnosticsConfirm'))) return;
  setBusy('btnDiagClear', true, dt('button.busy.clearing'));
  setErr('');
  try {
    const data = await postJson('/profiles/' + encodeURIComponent(profileId) + '/diagnostics/clear', {});
    applyDiagnosticsData(data);
    closeDiagnosticDetails();
    renderDiagnosticDetailEmptyState(dt('empty.selectRun'));
    try {
      currentLiveSelfCheck = await runLocalSelfCheck(currentRuntime, data);
    } catch (e) {
      currentLiveSelfCheck = { status: 'warn', items: [{ key: 'selfCheck', label: dt('field.browserSelfCheck'), status: 'warn', message: e && e.message ? e.message : String(e) }] };
    }
    renderUnifiedVerdict(data, currentLiveSelfCheck);
    renderSelfCheck(data, currentLiveSelfCheck);
    markUpdated();
  } finally {
    setBusy('btnDiagClear', false, dt('button.clearHistory'));
  }
}

async function refreshAll() {
  setErr('');
  if (!profileId) {
    setErr(dt('message.profileParamMissing'));
    return;
  }
  setBusy('btnAll', true, dt('button.busy.refreshing'));
  renderBrowserInfo();
  try {
    await Promise.all([refreshProfile(), refreshRuntime()]);
    await Promise.all([refreshIp(), refreshNetinfo(), refreshProxyTest(), refreshDiagnostics()]);
    markUpdated();
  } finally {
    setBusy('btnAll', false, dt('button.refreshAll'));
    syncRestartButton(currentRuntime);
  }
}

async function restartSsh() {
  if (!currentRuntime || !currentRuntime.canRestartSsh) return;
  setBusy('btnRestartSsh', true, dt('button.busy.reconnecting'));
  setErr('');
  try {
    const runtime = await postJson('/profiles/' + encodeURIComponent(profileId) + '/restart-ssh');
    currentRuntime = runtime;
    renderSshState(runtime);
    await Promise.all([refreshRuntime(), refreshIp(), refreshNetinfo(), refreshProxyTest(), refreshDiagnostics()]);
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
    if (currentRuntime) {
      currentRuntime.sshState = 'stopped';
      currentRuntime.sshLastError = e && e.message ? e.message : String(e);
      renderSshState(currentRuntime);
    }
  } finally {
    syncRestartButton(currentRuntime);
  }
}

async function restartProfile() {
  if (!profileId) return;
  if (!window.confirm(dt('message.restartProfileConfirm'))) return;
  setBusy('btnRestartProfile', true, dt('button.busy.restarting'));
  setErr('');
  try {
    await postJson('/profiles/' + encodeURIComponent(profileId) + '/restart', {});
    setErr(dt('message.restartProfileScheduled'), 'info');
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnRestartProfile', false, dt('button.restartProfile'));
  }
}

applyDashboardI18n();

$('btnAll').onclick = () => refreshAll().catch(e => setErr(e && e.message ? e.message : String(e)));
$('btnIp').onclick = async () => {
  setBusy('btnIp', true, dt('button.busy.refreshing'));
  try {
    await refreshIp();
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnIp', false, dt('button.refreshIp'));
  }
};

$('btnNet').onclick = async () => {
  setBusy('btnNet', true, dt('button.busy.refreshing'));
  try {
    await refreshNetinfo();
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnNet', false, dt('button.refreshNetinfo'));
  }
};

$('btnProxyTest').onclick = async () => {
  setBusy('btnProxyTest', true, dt('button.busy.testing'));
  try {
    await refreshProxyTest(true);
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnProxyTest', false, dt('button.testProxy'));
  }
};

$('btnRestartSsh').onclick = () => restartSsh().catch(e => setErr(e && e.message ? e.message : String(e)));
if ($('btnRestartProfile')) $('btnRestartProfile').onclick = () => restartProfile().catch(e => setErr(e && e.message ? e.message : String(e)));
if ($('btnDiagRunAll')) $('btnDiagRunAll').onclick = () => runAllDiagnostics().catch(e => setErr(e && e.message ? e.message : String(e)));
if ($('btnDiagClear')) $('btnDiagClear').onclick = () => clearDiagnosticsHistory().catch(e => setErr(e && e.message ? e.message : String(e)));

if ($('diagnosticDetailClose')) $('diagnosticDetailClose').onclick = () => closeDiagnosticDetails();
if ($('diagnosticDetailModal')) {
  renderDiagnosticDetailEmptyState();
  $('diagnosticDetailModal').onclick = (event) => {
    if (event.target === $('diagnosticDetailModal')) closeDiagnosticDetails();
  };
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDiagnosticDetails();
});

renderBrowserInfo();
refreshAll().catch(e => setErr(e && e.message ? e.message : String(e)));
