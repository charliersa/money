# 組出 pwa/index.html：外殼 + 樣式 + 內嵌樣板
# 樣板直接從 FinanceApp.dc.html 的手機外框內容抽出，再套用幾處 PWA 專用調整。
import io, sys

src = io.open('FinanceApp.dc.html', encoding='utf-8').read()

FRAME_OPEN = 'width:390px;height:844px;'
FRAME_CLOSE = '</div><!-- /phone frame -->'
i = src.index(FRAME_OPEN)
i = src.index('>', i) + 1                     # 手機外框 div 的結尾
j = src.index(FRAME_CLOSE)
tpl = src[i:j].strip()

def fix(old, new, why):
    global tpl
    if old not in tpl:
        sys.exit('樣板中找不到：' + why)
    tpl = tpl.replace(old, new, 1)

# ── PWA 外殼需要的 class（讓 CSS 能處理安全區與滿版） ──────────
fix('<div style="height:44px;padding:14px 28px 0;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">',
    '<div class="status-bar" style="height:44px;padding:14px 28px 0;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">',
    '狀態列')
fix('<div style="flex:1;overflow-y:auto;overflow-x:hidden;">',
    '<div class="app-scroll" style="flex:1;overflow-y:auto;overflow-x:hidden;">',
    '捲動區')
fix('<div style="height:78px;background:var(--app-bg);border-top:1px solid var(--border-1);display:flex;align-items:center;flex-shrink:0;padding:0 4px 10px;">',
    '<div class="tab-bar" style="height:78px;background:var(--app-bg);border-top:1px solid var(--border-1);display:flex;align-items:center;flex-shrink:0;padding:0 4px 10px;">',
    '底部分頁列')
fix('<div style="position:absolute;bottom:90px;right:18px;z-index:20;">',
    '<div class="fab-wrap" style="position:absolute;bottom:90px;right:18px;z-index:20;">',
    'FAB')

# ── 內容修正 ────────────────────────────────────────────────
# 狀態列時間不再寫死 9:41
fix('letter-spacing:-0.3px;">9:41</span>', 'letter-spacing:-0.3px;">{{ clockText }}</span>', '狀態列時間')
# 保單到期日輸入框寫死 color-scheme:dark，淺色模式下日期選擇器會是黑底
if tpl.count('color-scheme:dark;') != 1:
    sys.exit('預期只有一處寫死的 color-scheme:dark，實際 %d 處' % tpl.count('color-scheme:dark;'))
tpl = tpl.replace('color-scheme:dark;', 'color-scheme:{{ colorScheme }};', 1)
# 語音辨識已改為真實實作，用字不要再宣稱是 AI
fix('AI 分析語音中…', '解析語音內容…', '語音分析文案')
fix('AI 解析結果', '語音解析結果', '語音結果文案')


# ── 插入雲端同步的介面（PWA 專屬，設計稿沒有） ─────────────────
SYNC_CARD = io.open('pwa/sync-ui.html', encoding='utf-8').read().strip()
SYNC_CONFLICT = io.open('pwa/sync-conflict.html', encoding='utf-8').read().strip()

NL = chr(10)
settings_anchor = ('            <div style="background:var(--card-bg);border-radius:20px;padding:18px;'
                   'border:1px solid var(--border-1);">' + NL +
                   '              <div style="font-size:14px;font-weight:700;color:var(--text-1);'
                   'margin-bottom:14px;">顯示與通知</div>')

indented = NL.join(('            ' + ln) if ln.strip() else ln for ln in SYNC_CARD.split(NL))
fix(settings_anchor, indented + NL + settings_anchor, '設定頁的雲端同步卡片')

fix('  <!-- ═══ ADD ASSET CATEGORY SHEET ═══ -->',
    SYNC_CONFLICT + NL + NL + '  <!-- ═══ ADD ASSET CATEGORY SHEET ═══ -->',
    '同步衝突面板')

HEAD = '''<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<title>財務管家</title>
<meta name="description" content="記帳、預算、資產、保險與財務分析，資料全部留在你的裝置上。">
<meta name="theme-color" content="#F0F5FE">
<meta name="color-scheme" content="light dark">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="./icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="財務管家">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── 設計稿原有的動畫與變數（原封不動） ───────────────────── */
@keyframes slideUp { from { transform: translateY(18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes toastIn { from { transform: translateY(-16px) translateX(-50%); opacity:0; } to { transform: translateY(0) translateX(-50%); opacity:1; } }
@keyframes scanLine { 0%,100%{top:8%} 50%{top:80%} }
@keyframes waveA { 0%,100%{height:6px} 50%{height:30px} }
@keyframes waveB { 0%,100%{height:10px} 50%{height:46px} }
@keyframes waveC { 0%,100%{height:5px} 50%{height:38px} }
@keyframes spin { to{transform:rotate(360deg)} }

:root {
  --outer-bg:#E4ECF8; --app-bg:#F0F5FE; --card-bg:#FFFFFF; --card-bg2:#EAF0FD;
  --text-1:#0D1B2E; --text-2:#1D3154; --text-3b:#3A5278; --text-3:#526898;
  --text-4:#7090B0; --text-5:#96B0CC; --text-6:#B0C4DC;
  --border-1:rgba(70,100,160,0.07); --input-bg:rgba(70,100,160,0.04);
  --border-2:rgba(70,100,160,0.10); --border-3:rgba(70,100,160,0.07);
  --border-4:rgba(70,100,160,0.10);
}

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--outer-bg);
  font-family: 'Plus Jakarta Sans', 'Noto Sans TC', system-ui, -apple-system, 'Segoe UI', sans-serif;
  overscroll-behavior: none;                 /* 關掉整頁下拉刷新，行為才像原生 App */
  -webkit-font-smoothing: antialiased;
}
::-webkit-scrollbar { display: none; }
#analysis-pills { scrollbar-width: thin; scrollbar-color: rgba(108,142,245,0.35) transparent; }
#analysis-pills::-webkit-scrollbar { display: block !important; height: 4px; }
#analysis-pills::-webkit-scrollbar-thumb { background: rgba(108,142,245,0.35); border-radius: 2px; }
#analysis-pills::-webkit-scrollbar-track { background: transparent; }
a { color: inherit; text-decoration: none; }
input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }
input[type=number] { -moz-appearance: textfield; }
input::placeholder { color: var(--text-6); }
input:focus { border-color: rgba(108,142,245,0.4) !important; }
select option { background: var(--card-bg); color: var(--text-1); }

/* ── PWA 外殼：桌機保留手機外框，手機／獨立視窗滿版 ───────── */
.app-shell {
  min-height: 100vh; min-height: 100dvh;
  display: flex; align-items: center; justify-content: center;
  padding: 20px 0;
  background:
    radial-gradient(ellipse 70% 50% at 20% 15%, rgba(108,142,245,0.13) 0%, transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 85%, rgba(167,139,250,0.09) 0%, transparent 55%),
    var(--outer-bg);
}
.app-frame {
  width: 390px; height: 844px; max-height: calc(100dvh - 40px);
  background: var(--app-bg);
  border-radius: 44px; overflow: hidden; position: relative;
  display: flex; flex-direction: column;
  box-shadow: 0 0 0 1px rgba(108,142,245,0.18), 0 32px 80px rgba(13,27,46,0.28);
}
.app-scroll { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }

@media (max-width: 480px), (display-mode: standalone), (display-mode: fullscreen) {
  .app-shell { padding: 0; background: var(--app-bg); align-items: stretch; }
  .app-frame {
    width: 100%; height: 100dvh; max-height: none;
    border-radius: 0; box-shadow: none;
  }
  /* 假的 9:41 狀態列在真機上是多餘的，收成安全區墊片 */
  .status-bar { height: env(safe-area-inset-top, 0px) !important; padding: 0 !important; }
  .status-bar > * { display: none !important; }
  .tab-bar { height: auto !important; min-height: 78px;
             padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)) !important; }
  .fab-wrap { bottom: calc(90px + env(safe-area-inset-bottom, 0px)) !important; }
}

/* ── 加入主畫面提示 ──────────────────────────────────────── */
#install-bar {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  z-index: 200; display: none; align-items: center; gap: 10px;
  background: var(--card-bg); color: var(--text-1);
  border: 1px solid rgba(108,142,245,0.25); border-radius: 18px;
  padding: 10px 12px 10px 16px; font-size: 13px; font-weight: 600;
  box-shadow: 0 10px 30px rgba(13,27,46,0.25); white-space: nowrap;
}
#install-bar button {
  font: inherit; font-weight: 700; cursor: pointer; border: none;
  border-radius: 12px; padding: 8px 14px; color: #fff;
  background: linear-gradient(135deg,#6C8EF5,#A78BFA);
}
#install-bar .dismiss { background: var(--border-1); color: var(--text-3); }
</style>
</head>
<body>

<div class="app-shell">
  <div class="app-frame" id="app-root"></div>
</div>

<div id="install-bar" role="dialog" aria-label="安裝應用程式">
  <span>把「財務管家」加入主畫面？</span>
  <button type="button" id="install-yes">安裝</button>
  <button type="button" class="dismiss" id="install-no">稍後</button>
</div>

<script type="text/x-template" id="app-template">
'''

TAIL = '''</script>

<script src="./vendor/chart.umd.min.js"></script>
<script src="./config.js"></script>
<script src="./runtime.js"></script>
<script src="./app.js"></script>
<script src="./sync.js"></script>
<script src="./boot.js"></script>
<script>
/* ── Service Worker：離線可用 ─────────────────────────────── */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service Worker 註冊失敗：', err);
    });
  });
}

/* ── 加入主畫面 ───────────────────────────────────────────── */
(function () {
  var bar = document.getElementById('install-bar');
  var deferred = null;
  var HIDDEN = 'financeapp_install_dismissed';

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    try { if (localStorage.getItem(HIDDEN)) return; } catch (err) {}
    bar.style.display = 'flex';
  });
  document.getElementById('install-yes').addEventListener('click', function () {
    bar.style.display = 'none';
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.finally(function () { deferred = null; });
  });
  document.getElementById('install-no').addEventListener('click', function () {
    bar.style.display = 'none';
    try { localStorage.setItem(HIDDEN, '1'); } catch (err) {}
  });
  window.addEventListener('appinstalled', function () { bar.style.display = 'none'; });
})();
</script>
</body>
</html>
'''

if '</script' in tpl:
    sys.exit('樣板內含 </script，不能直接內嵌')

io.open('pwa/index.html', 'w', encoding='utf-8', newline='\n').write(HEAD + tpl + TAIL)
print('pwa/index.html 產生完成')
