/* ──────────────────────────────────────────────────────────────
   boot.js — 掛載元件
   必須排在 app.js（定義 Component）與 sync.js（包裝 Component）之後，
   否則同步層來不及接上 renderVals / save。
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var tpl = document.getElementById('app-template');
  var host = document.getElementById('app-root');
  var Component = window.Component;
  if (!tpl || !host) { console.error('找不到 #app-template 或 #app-root'); return; }
  if (!Component) { console.error('app.js 尚未載入'); return; }

  if (window.SheetsSync) window.SheetsSync.attach(Component);

  var app = DCRuntime.mount(Component, tpl.textContent, host);
  window.__app = app;

  if (window.SheetsSync) window.SheetsSync.start(app);

  // manifest 的捷徑（?action=expense / ?action=income / ?action=scan）
  var action = new URLSearchParams(location.search).get('action');
  if (action === 'expense') {
    app.setState(function (p) {
      return Object.assign({ showTxSheet: true, txType: 'expense', txCategory: '餐飲',
                             txAmount: '', txNote: '' }, app.resetBank(p));
    });
  } else if (action === 'income') {
    app.setState(function (p) {
      return Object.assign({ showTxSheet: true, txType: 'income', txCategory: '薪資',
                             txAmount: '', txNote: '' }, app.resetBank(p));
    });
  } else if (action === 'scan') {
    app.scanRun = (app.scanRun || 0) + 1;
    app.setState(function (p) { return Object.assign({ showScanSheet: true }, app.resetScan(p)); });
  }
})();
