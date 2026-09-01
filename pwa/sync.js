/* ──────────────────────────────────────────────────────────────
   sync.js — Google 試算表同步
   設計原則：
     · localStorage 仍是主要儲存，離線照常記帳，同步是額外的一層
     · 每個使用者連的是「自己 Google 雲端硬碟裡的試算表」，沒有共用端點
     · 只要 drive.file 範圍（非敏感），App 只碰得到自己建立的那個檔案
     · access token 只放在記憶體，重新整理後靜默續期，不寫進 localStorage
   ────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var CFG = global.APP_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var META_KEY = 'financeapp_sync_v1';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var AUTO_DELAY = 8000;              // 改完資料後延遲上傳，避免每按一鍵就打一次 API

  /* ── 工作表結構 ─────────────────────────────────────────── */
  var TABS = {
    tx:     { title: '交易',     header: ['id', '日期', '類型', '類別', '金額', '帳戶', '備註'], cols: 'A:G' },
    budget: { title: '預算',     header: ['類別', '每月上限'], cols: 'A:B' },
    asset:  { title: '資產',     header: ['類別', '金額', '圖示', '自訂', '自訂ID'], cols: 'A:E' },
    hist:   { title: '資產異動', header: ['id', '類別', '原金額', '新金額', '日期', '時間'], cols: 'A:F' },
    policy: { title: '保單',     header: ['id', '名稱', '險種', '公司', '保費', '繳別', '到期日'], cols: 'A:G' },
    bank:   { title: '帳戶',     header: ['名稱'], cols: 'A:A' },
    meta:   { title: '設定',     header: ['項目', '值'], cols: 'A:B' },
  };
  var ORDER = ['tx', 'budget', 'asset', 'hist', 'policy', 'bank', 'meta'];

  /* ── 模組狀態 ───────────────────────────────────────────── */
  var app = null;
  var token = null;                   // { value, expiresAt }
  var tokenClient = null;
  var gisReady = null;
  var autoTimer = null;
  var busy = false;

  var S = {
    connected: false,
    spreadsheetId: '',
    lastSyncAt: 0,
    localChangedAt: 0,
    auto: true,
    status: '',
    statusKind: '',                   // '' | 'ok' | 'error' | 'busy'
    conflict: false,
    conflictText: '',
  };

  function loadMeta() {
    try {
      var raw = localStorage.getItem(META_KEY);
      if (!raw) return;
      var m = JSON.parse(raw);
      S.spreadsheetId = m.spreadsheetId || '';
      S.lastSyncAt = m.lastSyncAt || 0;
      S.localChangedAt = m.localChangedAt || 0;
      S.auto = m.auto !== false;
    } catch (e) {}
  }
  function saveMeta() {
    try {
      localStorage.setItem(META_KEY, JSON.stringify({
        spreadsheetId: S.spreadsheetId, lastSyncAt: S.lastSyncAt,
        localChangedAt: S.localChangedAt, auto: S.auto,
      }));
    } catch (e) {}
  }
  function notify() { if (app) app.setState({}); }
  function setStatus(text, kind) { S.status = text; S.statusKind = kind || ''; notify(); }

  /* ── OAuth（Google Identity Services，token 流程） ────────── */

  function loadGIS() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      if (global.google && global.google.accounts && global.google.accounts.oauth2) return resolve();
      var el = document.createElement('script');
      el.src = GIS_SRC;
      el.async = true;
      el.onload = function () {
        if (global.google && global.google.accounts && global.google.accounts.oauth2) resolve();
        else reject(new Error('Google 登入元件載入失敗'));
      };
      el.onerror = function () { reject(new Error('連不到 Google 登入服務')); };
      document.head.appendChild(el);
    });
    return gisReady;
  }

  // prompt='' 走靜默續期（使用者已授權過且仍登入 Google 時不會跳視窗）
  function requestToken(interactive) {
    return loadGIS().then(function () {
      return new Promise(function (resolve, reject) {
        if (!tokenClient) {
          tokenClient = global.google.accounts.oauth2.initTokenClient({
            client_id: CFG.googleClientId,
            scope: SCOPE,
            callback: function () {},          // 每次 request 前覆寫
          });
        }
        tokenClient.callback = function (resp) {
          if (resp && resp.access_token) {
            token = { value: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 - 60000 };
            resolve(token.value);
          } else {
            reject(new Error(describeAuthError(resp)));
          }
        };
        tokenClient.error_callback = function (err) { reject(new Error(describeAuthError(err))); };
        try {
          tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        } catch (e) { reject(e); }
      });
    });
  }

  function describeAuthError(resp) {
    var t = (resp && (resp.type || resp.error)) || '';
    if (t === 'popup_closed' || t === 'popup_failed_to_open') return '授權視窗被關閉或被瀏覽器擋下';
    if (t === 'access_denied') return '你拒絕了授權';
    if (t === 'user_logged_out' || t === 'interaction_required') return '需要重新登入 Google';
    return 'Google 授權失敗' + (t ? '（' + t + '）' : '');
  }

  function getToken(interactive) {
    if (token && token.expiresAt > Date.now()) return Promise.resolve(token.value);
    return requestToken(!!interactive);
  }

  /* ── REST 呼叫（401 自動換 token 重試一次） ───────────────── */

  function api(url, options, retried) {
    return getToken(false).then(function (tk) {
      var opts = options || {};
      var headers = Object.assign({ Authorization: 'Bearer ' + tk }, opts.headers || {});
      if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      return fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body });
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        token = null;
        return api(url, options, true);
      }
      if (!res.ok) {
        return res.text().then(function (body) {
          var msg = '';
          try { msg = JSON.parse(body).error.message; } catch (e) { msg = body.slice(0, 120); }
          throw new Error('Google API ' + res.status + '：' + msg);
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  /* ── 試算表：找到或建立 ─────────────────────────────────── */

  function findSpreadsheet() {
    var q = "name='" + String(CFG.spreadsheetName || '財務管家資料').replace(/'/g, "\\'") +
            "' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    var url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&q=' + encodeURIComponent(q);
    return api(url).then(function (d) {
      return d && d.files && d.files.length ? d.files[0].id : '';
    });
  }

  function createSpreadsheet() {
    var body = {
      properties: { title: CFG.spreadsheetName || '財務管家資料', locale: 'zh_TW' },
      sheets: ORDER.map(function (k) { return { properties: { title: TABS[k].title } }; }),
    };
    return api('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST', body: JSON.stringify(body),
    }).then(function (d) { return d.spreadsheetId; });
  }

  // 使用者可能在 Sheets 裡手動刪掉分頁，補回來以免寫入失敗
  function ensureTabs(id) {
    return api('https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=sheets.properties.title')
      .then(function (d) {
        var have = {};
        (d.sheets || []).forEach(function (s) { have[s.properties.title] = true; });
        var missing = ORDER.filter(function (k) { return !have[TABS[k].title]; });
        if (!missing.length) return;
        return api('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', {
          method: 'POST',
          body: JSON.stringify({
            requests: missing.map(function (k) {
              return { addSheet: { properties: { title: TABS[k].title } } };
            }),
          }),
        });
      });
  }

  function ensureSpreadsheet() {
    if (S.spreadsheetId) return ensureTabs(S.spreadsheetId).then(function () { return S.spreadsheetId; });
    return findSpreadsheet().then(function (id) {
      return id || createSpreadsheet();
    }).then(function (id) {
      S.spreadsheetId = id;
      saveMeta();
      return ensureTabs(id).then(function () { return id; });
    });
  }

  /* ── 狀態 ↔ 表格列 ──────────────────────────────────────── */

  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var str = function (v) { return v == null ? '' : String(v); };
  var amountCell = function (v) { return String(v).trim() === '' ? '' : num(v); };
  var amountBack = function (v) { return String(v).trim() === '' ? '' : String(num(v)); };

  function toRows(st) {
    var rows = {};
    rows.tx = (st.transactions || []).map(function (t) {
      return [t.id, str(t.date), t.type === 'income' ? '收入' : '支出',
              str(t.category), num(t.amount), str(t.bank), str(t.note)];
    });
    rows.budget = Object.keys(st.budgets || {}).map(function (k) {
      return [k, amountCell(st.budgets[k])];
    });
    var customById = {};
    (st.customAssetDefs || []).forEach(function (d) { customById[d.key] = d; });
    rows.asset = Object.keys(st.assets || {}).map(function (k) {
      var c = customById[k];
      return [k, amountCell(st.assets[k]), c ? c.emoji : '', c ? 'Y' : 'N', c ? c.id : ''];
    });
    rows.hist = (st.assetHistory || []).map(function (r) {
      return [r.id, str(r.assetType), num(r.oldAmount), num(r.newAmount), str(r.date), str(r.time)];
    });
    rows.policy = (st.policies || []).map(function (p) {
      return [p.id, str(p.name), str(p.type), str(p.company), amountCell(p.premium), str(p.freq), str(p.expiry)];
    });
    rows.bank = (st.banks || []).map(function (b) { return [b]; });
    var pr = st.profile || {};
    rows.meta = [
      ['更新時間', new Date().toISOString()],
      ['姓名', str(pr.name)],
      ['電子郵件', str(pr.email)],
      ['月收入', amountCell(pr.monthlyIncome)],
      ['深色模式', st.darkMode ? 'Y' : 'N'],
      ['預設帳戶', str(st.txBank)],
    ];
    return rows;
  }

  function fromRows(get) {
    var patch = {};
    var tx = get('tx');
    patch.transactions = tx.map(function (r) {
      return {
        id: num(r[0]) || Date.now() + Math.floor(Math.random() * 1000),
        date: str(r[1]),
        type: str(r[2]) === '收入' ? 'income' : 'expense',
        category: str(r[3]),
        amount: num(r[4]),
        bank: str(r[5]),
        note: str(r[6]),
      };
    }).filter(function (t) { return t.date && t.amount > 0; });

    var budgets = {};
    get('budget').forEach(function (r) { if (str(r[0])) budgets[str(r[0])] = amountBack(r[1]); });
    if (Object.keys(budgets).length) patch.budgets = budgets;

    var assets = {}, defs = [];
    get('asset').forEach(function (r) {
      var key = str(r[0]);
      if (!key) return;
      assets[key] = amountBack(r[1]);
      if (str(r[3]).toUpperCase() === 'Y') {
        defs.push({ id: num(r[4]) || Date.now() + defs.length, key: key, emoji: str(r[2]) || '💼' });
      }
    });
    if (Object.keys(assets).length) { patch.assets = assets; patch.customAssetDefs = defs; }

    patch.assetHistory = get('hist').map(function (r) {
      return { id: num(r[0]), assetType: str(r[1]), oldAmount: num(r[2]),
               newAmount: num(r[3]), date: str(r[4]), time: str(r[5]) };
    }).filter(function (r) { return r.assetType; });

    patch.policies = get('policy').map(function (r) {
      return { id: num(r[0]) || Date.now(), name: str(r[1]), type: str(r[2]), company: str(r[3]),
               premium: amountBack(r[4]), freq: str(r[5]) || '年繳', expiry: str(r[6]) || '—' };
    }).filter(function (p) { return p.name; });

    var banks = get('bank').map(function (r) { return str(r[0]); }).filter(Boolean);
    if (banks.length) patch.banks = banks;

    var meta = {};
    get('meta').forEach(function (r) { meta[str(r[0])] = r[1]; });
    patch.profile = { name: str(meta['姓名']), email: str(meta['電子郵件']),
                      monthlyIncome: amountBack(meta['月收入']) };
    if (meta['深色模式'] !== undefined) patch.darkMode = str(meta['深色模式']).toUpperCase() === 'Y';
    if (str(meta['預設帳戶'])) patch.txBank = str(meta['預設帳戶']);
    return { patch: patch, updatedAt: Date.parse(str(meta['更新時間'])) || 0 };
  }

  /* ── 讀 / 寫 ────────────────────────────────────────────── */

  function range(key, withHeader) {
    var t = TABS[key];
    var start = withHeader ? '1' : '2';
    return t.title + '!' + t.cols.split(':')[0] + start + ':' + t.cols.split(':')[1];
  }

  function pullRaw(id) {
    var qs = ORDER.map(function (k) { return 'ranges=' + encodeURIComponent(range(k, false)); }).join('&');
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id +
              '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + qs;
    return api(url).then(function (d) {
      var byIndex = d.valueRanges || [];
      return function (key) {
        var i = ORDER.indexOf(key);
        var vr = byIndex[i];
        return (vr && vr.values) || [];
      };
    });
  }

  function push(id, st) {
    var rows = toRows(st);
    // 先清空舊資料列，否則本機刪掉的東西會以殘留列的形式留在雲端
    var clear = { ranges: ORDER.map(function (k) { return range(k, false); }) };
    return api('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values:batchClear', {
      method: 'POST', body: JSON.stringify(clear),
    }).then(function () {
      var data = ORDER.map(function (k) {
        return { range: range(k, true), values: [TABS[k].header].concat(rows[k]) };
      });
      return api('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: data }),
      });
    });
  }

  /* ── 同步流程 ───────────────────────────────────────────── */

  function markSynced() {
    S.lastSyncAt = Date.now();
    S.localChangedAt = 0;
    saveMeta();
  }

  function doPush(id) {
    setStatus('上傳中…', 'busy');
    return push(id, app.state).then(function () {
      markSynced();
      setStatus('已同步', 'ok');
    });
  }

  function doPull(id) {
    setStatus('下載中…', 'busy');
    return pullRaw(id).then(function (get) {
      var r = fromRows(get);
      app.setState(r.patch);
      markSynced();
      setStatus('已同步', 'ok');
    });
  }

  function sync(opts) {
    opts = opts || {};
    if (busy) return Promise.resolve();
    if (!CFG.googleClientId) { setStatus('尚未設定 Client ID', 'error'); return Promise.resolve(); }
    busy = true;
    notify();
    return getToken(!!opts.interactive)
      .then(function () { S.connected = true; return ensureSpreadsheet(); })
      .then(function (id) {
        if (opts.force === 'push') return doPush(id);
        if (opts.force === 'pull') return doPull(id);
        return pullRaw(id).then(function (get) {
          var remote = fromRows(get);
          var hasRemote = remote.updatedAt > 0;
          var localDirty = S.localChangedAt > S.lastSyncAt;
          var remoteNewer = hasRemote && remote.updatedAt > S.lastSyncAt;

          if (!hasRemote) return doPush(id);
          if (localDirty && remoteNewer) {
            S.conflict = true;
            S.conflictText = '雲端在 ' + new Date(remote.updatedAt).toLocaleString('zh-TW') +
                             ' 有更新，本機也有尚未上傳的變更。要保留哪一份？';
            setStatus('有衝突待處理', 'error');
            return;
          }
          if (localDirty) return doPush(id);
          if (remoteNewer) {
            app.setState(remote.patch);
            markSynced();
            setStatus('已同步', 'ok');
            return;
          }
          markSynced();
          setStatus('已是最新', 'ok');
        });
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : '同步失敗', 'error');
        if (/授權|登入|access_denied/.test(String(err && err.message))) S.connected = false;
      })
      .then(function () { busy = false; notify(); });
  }

  function scheduleAuto() {
    if (!S.auto || !S.connected || !CFG.googleClientId) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { sync(); }, AUTO_DELAY);
  }

  /* ── 介面綁定 ───────────────────────────────────────────── */

  function fmtTime(ts) {
    if (!ts) return '尚未同步';
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return sameDay ? '今天 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function vals() {
    var configured = !!CFG.googleClientId;
    return {
      syncConfigured: configured,
      syncNotConfigured: !configured,
      syncConnected: configured && S.connected,
      syncDisconnected: configured && !S.connected,
      syncBusy: busy,
      syncStatusText: S.status || (S.connected ? '已連線' : '未連線'),
      syncStatusColor: S.statusKind === 'error' ? '#F87171'
                     : S.statusKind === 'ok' ? '#34D399'
                     : S.statusKind === 'busy' ? '#E9B44C' : 'var(--text-3)',
      syncLastText: '最後同步：' + fmtTime(S.lastSyncAt),
      syncSheetUrl: S.spreadsheetId ? 'https://docs.google.com/spreadsheets/d/' + S.spreadsheetId : '',
      hasSyncSheet: !!S.spreadsheetId,
      syncAuto: S.auto,
      syncAutoToggleBg: S.auto ? 'linear-gradient(135deg,#6C8EF5,#A78BFA)' : 'rgba(150,165,185,0.3)',
      syncAutoToggleDot: S.auto ? 'right:2px' : 'left:2px',
      showSyncConflict: S.conflict,
      syncConflictText: S.conflictText,

      connectSync: function () { sync({ interactive: true }); },
      syncNow: function () { sync(); },
      toggleSyncAuto: function () { S.auto = !S.auto; saveMeta(); notify(); },
      disconnectSync: function () {
        token = null;
        S.connected = false;
        S.status = '';
        S.statusKind = '';
        clearTimeout(autoTimer);
        notify();
      },
      resolveSyncLocal: function () {
        S.conflict = false;
        sync({ force: 'push' });
      },
      resolveSyncRemote: function () {
        S.conflict = false;
        sync({ force: 'pull' });
      },
      closeSyncConflict: function () { S.conflict = false; notify(); },
    };
  }

  /* ── 掛進元件 ───────────────────────────────────────────── */

  function attach(ComponentClass) {
    var origVals = ComponentClass.prototype.renderVals;
    ComponentClass.prototype.renderVals = function () {
      return Object.assign(origVals.call(this), vals());
    };

    var origSave = ComponentClass.prototype.save;
    ComponentClass.prototype.save = function (state) {
      origSave.call(this, state);
      S.localChangedAt = Date.now();          // 只有資料真的變動時才會走到這裡
      saveMeta();
      scheduleAuto();
    };
  }

  function start(instance) {
    app = instance;
    loadMeta();
    if (!CFG.googleClientId) return;
    // 之前連過就試著靜默取回 token；失敗就安靜地留在未連線狀態
    if (S.spreadsheetId || S.lastSyncAt) {
      getToken(false).then(function () {
        S.connected = true;
        notify();
        return sync();
      }).catch(function () { notify(); });
    }
    // 切到背景前把還沒送出的變更推上去
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && S.auto && S.connected &&
          S.localChangedAt > S.lastSyncAt) {
        clearTimeout(autoTimer);
        sync();
      }
    });
    global.addEventListener('online', function () {
      if (S.auto && S.connected && S.localChangedAt > S.lastSyncAt) sync();
    });
  }

  global.SheetsSync = { attach: attach, start: start, sync: sync };
})(window);
