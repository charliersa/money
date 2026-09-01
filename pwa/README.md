# 財務管家 PWA

`FinanceApp.dc.html`（Claude Design 設計稿）的可安裝網頁版。移除了 React 與 `support.js`
的相依，改用自帶的極簡樣板引擎，因此**不需要打包工具、不需要 node_modules，把整個
`pwa/` 資料夾丟上任何靜態主機就能跑**。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 應用外殼 + 樣式 + 內嵌樣板（產生檔） |
| `runtime.js` | 極簡樣板引擎：`{{ }}`、`sc-if`、`sc-for`、事件綁定、DOM diff |
| `app.js` | 應用邏輯：記帳、預算、資產、保單、發票掃描、語音、AI 建議（產生檔） |
| `sw.js` | Service Worker，離線快取 |
| `manifest.webmanifest` | PWA 資訊、圖示、捷徑 |
| `icons/` | 192 / 512 / maskable 圖示 |
| `vendor/chart.umd.min.js` | Chart.js 4.4.0（本地放置，離線也能畫圖） |
| `build_app_js.py` `build_index.py` `gen_icons.cjs` | 產生上述產生檔的腳本 |

## 本機執行

```bash
cd pwa
python -m http.server 8765
# 開 http://localhost:8765
```

必須透過 `http://localhost` 或 HTTPS 開啟，不能用 `file://`：
Service Worker、麥克風、`beforeinstallprompt` 都需要安全來源（secure context）。

## 部署

上傳 `pwa/` 全部內容到任一靜態主機（GitHub Pages / Netlify / Vercel / Cloudflare Pages
/ 自家 Nginx）即可，沒有建置步驟。唯一要求是 **HTTPS**。

放在子路徑（例如 `https://example.com/money/`）也可以，所有路徑都是相對的。

改版後記得把 `sw.js` 裡的 `VERSION` 加一，使用者才會拿到新版而不是舊快取。

## 安裝到手機 / 桌面

- **Android Chrome**：開啟網址 → 底部會跳出「加入主畫面」提示，或用選單「安裝應用程式」。
- **iOS Safari**：分享 → 加入主畫面。（iOS 不支援 `beforeinstallprompt`，所以不會有自動提示。）
- **桌面 Chrome / Edge**：網址列右側的安裝圖示。

## 重新產生

樣板與邏輯的真正來源是上層的 `FinanceApp.dc.html`。改完設計稿後：

```bash
python pwa/build_app_js.py    # → pwa/app.js
python pwa/build_index.py     # → pwa/index.html
node   pwa/gen_icons.cjs      # → pwa/icons/*.png（圖示沒改就不用跑）
```

兩支腳本都會在找不到預期片段時直接報錯中止，設計稿大改時不會靜靜產出壞掉的檔案。

## 與設計稿版本的差異

| 項目 | 設計稿 | PWA |
| --- | --- | --- |
| 執行環境 | React + `support.js`（dc-runtime） | 自帶 `runtime.js`，無外部框架 |
| 下拉選單 | `<sc-for>` 被 HTML 解析器吃掉，只剩一個 `{{ bk.label }}` 選項 | 正常展開所有選項 |
| 頂端時間 | 寫死 `9:41` | 真實時間；裝成 App 後改為瀏海安全區 |
| 語音記帳 | 隨機回傳四筆**模擬**交易 | Web Speech API（zh-TW）+ 中文數字解析；聽不到就明說，不會寫入虛構金額 |
| 版面 | 固定 390×844 | 桌機保留手機外框，手機／獨立視窗滿版並處理安全區 |
| 離線 | 需要 CDN | Service Worker 快取，安裝後可離線使用 |
| 到期日欄位 | `color-scheme:dark` 寫死 | 跟隨深色／淺色模式 |

## 已知限制

- **資料只存在瀏覽器的 localStorage**，沒有雲端同步。清除瀏覽資料、換裝置、
  或 iOS 長期未開啟 PWA 觸發的儲存清理，都會讓資料消失。建議之後補上匯出／匯入 JSON。
- **語音辨識**只有 Chrome / Edge（含 Android）支援，iOS Safari 不支援
  `SpeechRecognition`，該功能會顯示提示而非運作。辨識由瀏覽器送往其服務商處理。
- **發票 OCR** 第一次使用會下載約 6 MB 的語言模型（jsDelivr CDN），需要網路；
  電子發票 QR Code 則是純本機解析，離線可用。
- 「AI 智慧分析」是本機的規則式建議，不是真的呼叫語言模型；
  「每月預算提醒」「保費到期通知」兩個開關目前只是靜態畫面。
