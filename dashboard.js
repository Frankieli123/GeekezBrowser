const profileId = window.__PROFILE_ID__ || '';
const apiBase = location.origin;
const $ = (id) => document.getElementById(id);

let totpTimer = null;
let currentSecret = null;
let currentProfile = null;
let currentRuntime = null;

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
  err.textContent = String(message);
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
    return new Date(value).toLocaleString();
  } catch (e) {
    return String(ms);
  }
}

function fmtClock(date = new Date()) {
  try {
    return date.toLocaleTimeString([], { hour12: false });
  } catch (e) {
    return String(date);
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
  setText('runText', running ? '运行中' : '未运行');
}

function renderSshState(runtime) {
  const card = $('sshStateCard');
  const btn = $('btnRestartSsh');
  const canRestart = !!(runtime && runtime.canRestartSsh);
  if (btn) btn.hidden = !canRestart;
  if (card) card.hidden = false;

  if (!canRestart) {
    setText('sshState', '未启用');
    setText('sshStateMini', 'N/A');
    setText('sshHint', '当前代理不是 SSH');
    if (card) card.dataset.state = 'idle';
    return;
  }

  const state = String(runtime.sshState || '').trim().toLowerCase();
  if (state === 'running') {
    setText('sshState', '已连接');
    setText('sshStateMini', '已连接');
    setText('sshHint', runtime.sshLocalPort ? `本地动态转发端口 ${runtime.sshLocalPort}` : 'SSH 隧道正常');
    if (card) card.dataset.state = 'running';
  } else if (state === 'reconnecting') {
    setText('sshState', '重连中');
    setText('sshStateMini', '重连中');
    setText('sshHint', '正在重新建立 SSH 动态转发');
    if (card) card.dataset.state = 'warn';
  } else {
    setText('sshState', '已断开');
    setText('sshStateMini', '已断开');
    setText('sshHint', runtime.sshLastError || 'SSH 隧道已断开，可手动重连');
    if (card) card.dataset.state = 'error';
  }
}

function syncRestartButton(runtime) {
  const btn = $('btnRestartSsh');
  if (!btn) return;
  if (!runtime || !runtime.canRestartSsh) {
    btn.hidden = true;
    btn.disabled = false;
    btn.textContent = '重连 SSH';
    return;
  }
  btn.hidden = false;
  if (runtime.sshState === 'reconnecting') {
    btn.disabled = true;
    btn.textContent = '重连中...';
  } else {
    btn.disabled = false;
    btn.textContent = '重连 SSH';
  }
}

function maybeShowSshWarning(runtime) {
  if (runtime && runtime.canRestartSsh && runtime.sshState === 'stopped') {
    setErr(runtime.sshLastError || 'SSH 隧道已断开，可点击“重连 SSH”恢复。', 'warn');
  } else if (runtime && runtime.sshState === 'reconnecting') {
    setErr('SSH 正在重连，恢复后会自动刷新运行态。', 'info');
  } else {
    setErr('');
  }
}

async function refreshProfile() {
  const profile = await getJson('/profiles/' + encodeURIComponent(profileId));
  currentProfile = profile;
  setText('pid', profileId || '(none)');
  setText('profileInline', profileId || '(none)');
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
  setRunning(!!runtime.running);
  setText('proxyType', formatProxyType(runtime.proxyType));
  setText('ws', runtime.ws || '-');
  setText('http', runtime.http || '-');
  setText('debugPort', runtime.debugPort || '-');
  setText('localPort', runtime.localPort || '-');
  setText('sshLocalPort', runtime.sshLocalPort || '-');
  renderSshState(runtime);
  syncRestartButton(runtime);
  maybeShowSshWarning(runtime);

  $('btnCopyWs').onclick = async () => { if (runtime.ws) await copyText(runtime.ws); };
  $('copyWs').onclick = async () => { if (runtime.ws) await copyText(runtime.ws); };
  $('copyHttp').onclick = async () => { if (runtime.http) await copyText(runtime.http); };
  return runtime;
}

async function refreshIp() {
  setText('ip', '...');
  setText('ipMeta', '来源: ...');
  $('btnCopyIp').onclick = null;
  try {
    const ip = await getJson('/profiles/' + encodeURIComponent(profileId) + '/ip');
    setText('ip', ip.ip || '-');
    setText('ipMeta', '来源: ' + (ip.source || '-'));
    $('btnCopyIp').onclick = async () => copyText(ip.ip || '');
    return ip;
  } catch (e) {
    setText('ip', '-');
    setText('ipMeta', '来源: -');
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

async function refreshAll() {
  setErr('');
  if (!profileId) {
    setErr('缺少 profile 参数（例如 /dashboard?profile=<id>）');
    return;
  }
  setBusy('btnAll', true, '刷新中...');
  renderBrowserInfo();
  try {
    await Promise.all([refreshProfile(), refreshRuntime()]);
    await Promise.all([refreshIp(), refreshNetinfo()]);
    markUpdated();
  } finally {
    setBusy('btnAll', false, '刷新全部');
    syncRestartButton(currentRuntime);
  }
}

async function restartSsh() {
  if (!currentRuntime || !currentRuntime.canRestartSsh) return;
  setBusy('btnRestartSsh', true, '重连中...');
  setErr('');
  try {
    const runtime = await postJson('/profiles/' + encodeURIComponent(profileId) + '/restart-ssh');
    currentRuntime = runtime;
    renderSshState(runtime);
    await Promise.all([refreshRuntime(), refreshIp(), refreshNetinfo()]);
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

$('btnAll').onclick = () => refreshAll().catch(e => setErr(e && e.message ? e.message : String(e)));
$('btnIp').onclick = async () => {
  setBusy('btnIp', true, '刷新中...');
  try {
    await refreshIp();
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnIp', false, '刷新 IP');
  }
};

$('btnNet').onclick = async () => {
  setBusy('btnNet', true, '刷新中...');
  try {
    await refreshNetinfo();
    markUpdated();
  } catch (e) {
    setErr(e && e.message ? e.message : String(e));
  } finally {
    setBusy('btnNet', false, '刷新网络信息');
  }
};

$('btnRestartSsh').onclick = () => restartSsh().catch(e => setErr(e && e.message ? e.message : String(e)));

renderBrowserInfo();
refreshAll().catch(e => setErr(e && e.message ? e.message : String(e)));
