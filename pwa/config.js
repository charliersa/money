/* ──────────────────────────────────────────────────────────────
   config.js — 部署設定
   Google 試算表同步需要一組 OAuth 用戶端 ID，填在下面。
   沒有填的話 App 照常運作，只是設定頁的「雲端同步」會顯示未設定。

   取得方式（Google Cloud Console，只需做一次）：
     1. 建立專案，啟用 Google Sheets API 與 Google Drive API
     2. OAuth 同意畫面：External，範圍只加
        https://www.googleapis.com/auth/drive.file
        （不要加 .../auth/spreadsheets，那是敏感範圍，要送審）
        建立後按「發布應用程式」
     3. 憑證 → OAuth 用戶端 ID → 網頁應用程式
        已授權的 JavaScript 來源：
          https://charliersa.github.io
          http://localhost:8765
        重新導向 URI 留空
   ────────────────────────────────────────────────────────────── */
window.APP_CONFIG = {
  googleClientId: '588226828631-3op4gj3ja8ttvb1nloh5l48r9lehsqfk.apps.googleusercontent.com',                 // 例：'1234567890-abc.apps.googleusercontent.com'
  spreadsheetName: '財務管家資料',      // 第一次連線時在使用者的雲端硬碟建立的檔名
};
