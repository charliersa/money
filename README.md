# 財務管家 Finance Manager

記帳、預算、資產、保險與財務分析的可安裝網頁 App（PWA）。資料只存在使用者自己的裝置上。

**線上版：** https://charliersa.github.io/money/

## 內容

| 路徑 | 說明 |
| --- | --- |
| `pwa/` | 正式的 PWA，部署到 GitHub Pages 的就是這個目錄。詳見 [`pwa/README.md`](pwa/README.md) |
| `FinanceApp.dc.html` | 原始設計稿（Claude Design canvas），`pwa/` 的樣板與邏輯由此產生 |
| `support.js` | 設計稿用的 dc-runtime，PWA 版本不需要 |

## 功能

- 記帳：收支、類別、帳戶／銀行、月份切換
- 預算：各類別上限與進度
- 分析：月度趨勢、支出分類、資產配置、現金流量、保費比例（Chart.js）
- 資產：分類管理、自訂類別、異動紀錄
- 保險：保單管理、保障缺口分析
- 發票掃描：電子發票 QR Code（本機解析）＋ 收據 OCR（Tesseract.js）
- 語音記帳：Web Speech API（zh-TW）＋ 中文數字解析
- 深色模式、離線可用、可加入主畫面

## 開發

```bash
cd pwa
python -m http.server 8765   # http://localhost:8765
```

必須用 `http://localhost` 或 HTTPS 開啟，`file://` 下 Service Worker 與麥克風都不會運作。

改完 `FinanceApp.dc.html` 後重新產生：

```bash
python pwa/build_app_js.py
python pwa/build_index.py
```

## 部署

推上 `main` 後由 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
自動把 `pwa/` 發佈到 GitHub Pages。
