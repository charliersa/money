# 財務管家 Finance Manager

記帳、預算、資產、保險與財務分析的可安裝網頁 App（PWA）。資料只存在使用者自己的裝置上。

**線上版：** https://charliersa.github.io/money/

## 內容

| 路徑 | 說明 |
| --- | --- |
| `pwa/` | 正式的 PWA，部署到 GitHub Pages 的就是這個目錄。詳見 [`pwa/README.md`](pwa/README.md) |
| `SYNC.md` | Google 試算表同步的設定步驟、同步流程與疑難排解 |
| `FinanceApp.dc.html` | 原始設計稿（Claude Design canvas），`pwa/` 的樣板與邏輯由此產生 |
| `support.js` | 設計稿用的 dc-runtime，PWA 版本不需要 |

## 功能

- 記帳：收支、類別、帳戶／銀行、月份切換
- 預算：各類別上限與進度
- 分析：月度趨勢、支出分類、資產配置、現金流量、保費比例（Chart.js）
- 資產：分類管理、自訂類別、異動紀錄，並與帳簿連動（見下）
- 保險：保單管理、保障缺口分析
- 發票掃描：電子發票 QR Code（本機解析）＋ 收據 OCR（Tesseract.js）
- 語音記帳：Web Speech API（zh-TW）＋ 中文數字解析
- 深色模式、離線可用、可加入主畫面
- 雲端同步：資料存到使用者自己 Google 雲端硬碟裡的試算表（設定見 [`SYNC.md`](SYNC.md)）

### 帳簿 ↔ 資產彙整的連動

每個資產類別可以指定它涵蓋哪些帳戶（在「我的 → 資產彙整 → 編輯」裡勾選）。
預設是「現金 & 存款」涵蓋現金與所有銀行帳戶，`信用卡` 則不連動。

- 在帳簿記一筆帳，對應資產類別的金額就跟著加減，記帳表單上會先提示會動到哪一類。
- 資產類別存的是**基準金額**（最後一次手動校正輸入的數字）；畫面上顯示的是
  基準金額 ＋ 校正之後記在連動帳戶上的收支。因為是推算而不是直接改數字，
  **刪掉一筆帳，資產金額會自己還原**。
- 一個帳戶只能屬於一個資產類別，避免同一筆帳被算兩次。
- 反向不會產生交易：手動校正資產金額只會寫進「異動紀錄」，
  不會變成收入／支出去汙染月結與預算統計。
- 首頁「淨值」＝ 總資產 ＋ 尚未連動帳戶（例如信用卡）的現金流，不重複計算。

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
