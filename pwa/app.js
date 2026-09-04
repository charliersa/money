/* ──────────────────────────────────────────────────────────────
   app.js — 財務管家 PWA 的應用邏輯
   由 build_app_js.py 從 FinanceApp.dc.html 產生（勿直接手改，改來源檔後重跑）。
   與設計稿版本的差異：
     · 頂端狀態列顯示真實時間，不再寫死 9:41
     · 語音記帳改用 Web Speech API，不再產生模擬資料
     · 切換深色模式時同步更新 <meta name="theme-color">
   掛載程式在 boot.js，不在這裡。
   ────────────────────────────────────────────────────────────── */
const CUSTOM_BANK = '__custom__';

class Component extends DCLogic {
  state = {
    tab: 'home',
    recordsTab: 'transactions',
    analysisTab: 'trend',
    insuranceTab: 'policies',
    profileTab: 'main',
    currentMonth: { year: 2026, month: 7 },
    transactions: [],
    budgets: { '餐飲': '', '交通': '', '娛樂': '', '購物': '', '醫療保健': '' },
    assets: { '現金 & 存款': '', '股票 & ETF': '', '基金 & 債券': '', '不動產': '' },
    assetHistory: [],
    policies: [],
    profile: { name: '', email: '', monthlyIncome: '' },
    showAIPanel: false, aiMessages: [], aiTyping: false, fabOpen: false,
    showTxSheet: false, txType: 'expense', txAmount: '', txCategory: '餐飲', txNote: '', txDate: '2026-07-08',
    banks: ['現金', '台灣銀行', '中國信託', '國泰世華', '玉山銀行', '台新銀行', '富邦銀行', '第一銀行', '郵局', '信用卡'],
    txBank: '現金', txBankCustom: '',
    showBudgetSheet: false, budgetCategory: '餐飲', budgetAmount: '',
    showPolicySheet: false, policyName: '', policyType: '壽險', policyCompany: '', policyPremium: '', policyFreq: '年繳', policyExpiry: '',
    showAssetSheet: false, editAssetType: '現金 & 存款', editAssetAmount: '', editAssetBanks: [],
    // 帳簿 ↔ 資產彙整的連動：帳戶 → 資產類別（'' 代表不連動），
    // 以及每個資產類別最後一次手動校正的時間戳。
    bankAsset: {}, assetBaseAt: {},
    customAssetDefs: [],
    showAddAssetCat: false, newAssetName: '', newAssetEmoji: '💼', newAssetAmount: '',
    toast: '',
    darkMode: false,
    // 首次繪製就要有時間，否則狀態列會空一個影格
    clockText: ((d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`)(new Date()),
    showScanSheet: false, scanStep: 'ready', scanImage: '', scanText: '', showScanText: false,
    scanAmount: '', scanShop: '', scanCategory: '餐飲', scanDate: '', scanBank: '現金',
    scanInvNo: '', scanItems: [], scanSource: '', scanProgress: 0, scanStatus: '', scanError: '',
    showVoiceSheet: false, voiceStep: 'ready', voiceData: null, voiceSeconds: 0,
  };
  charts = {};
  STORAGE_KEY = 'financeapp_v1';
  timers = {};
  aiRun = 0;

  // 重開記帳表單時沿用上次選的帳戶；若上次停在「自訂」就退回第一個帳戶，
  // 否則一打開就看到空的自訂輸入框。
  defaultBank(prev) {
    const list = Array.isArray(prev.banks) && prev.banks.length ? prev.banks : ['現金'];
    return prev.txBank === CUSTOM_BANK || !prev.txBank ? list[0] : prev.txBank;
  }

  resetBank(prev) {
    return { txBank: this.defaultBank(prev), txBankCustom: '' };
  }

  // ═══ 帳簿 ↔ 資產彙整的連動 ═══
  // assets[類別] 存的是「基準金額」：使用者最後一次手動校正輸入的數字。
  // 顯示金額 = 基準金額 + 校正之後、記在連動帳戶上的所有收支。
  // 用推算而不是直接改數字，刪掉一筆帳資產就會自己還原，不必反向補記。
  CASH_ASSET = '現金 & 存款';

  // 沒設定過的帳戶預設連到「現金 & 存款」；信用卡是負債性質，預設不連動。
  bankAssetOf(state, bank) {
    if (!bank) return '';
    const map = state.bankAsset || {};
    if (map[bank] !== undefined) return map[bank];
    return bank === '信用卡' ? '' : this.CASH_ASSET;
  }

  // 某個資產類別自基準時間以來的帳簿淨額
  assetFlow(state, key) {
    const since = (state.assetBaseAt || {})[key] || 0;
    return (state.transactions || []).reduce((sum, t) => {
      if (!(t.id > since)) return sum;
      if (this.bankAssetOf(state, t.bank) !== key) return sum;
      const amt = parseFloat(t.amount) || 0;
      return sum + (t.type === 'income' ? amt : -amt);
    }, 0);
  }

  assetAmount(state, key) {
    return (parseFloat((state.assets || {})[key]) || 0) + this.assetFlow(state, key);
  }

  // 沒連到任何資產類別的帳（例如信用卡）：這些錢還沒反映在總資產裡
  unlinkedFlow(state) {
    return (state.transactions || []).reduce((sum, t) => {
      if (this.bankAssetOf(state, t.bank)) return sum;
      const amt = parseFloat(t.amount) || 0;
      return sum + (t.type === 'income' ? amt : -amt);
    }, 0);
  }

  bankList(state) {
    return Array.isArray(state.banks) && state.banks.length ? state.banks : ['現金'];
  }

  banksLinkedTo(state, key) {
    return this.bankList(state).filter(b => this.bankAssetOf(state, b) === key);
  }

  // 以「本地時區」解析 YYYY-MM-DD。new Date('2026-08-01') 會被當成 UTC 午夜，
  // 在 UTC 負時區會退回前一天，導致交易被算進錯誤的月份。
  parseDate(str) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(NaN);
  }
  todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  monthOf(dateStr) {
    const d = this.parseDate(dateStr);
    return isNaN(d.getTime()) ? null : { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  inMonth(dateStr, year, month) {
    const d = this.parseDate(dateStr);
    return !isNaN(d.getTime()) && d.getFullYear() === year && d.getMonth() + 1 === month;
  }

  applyTheme(dark) {
    const d = { '--outer-bg':'#03050D','--app-bg':'#080C18','--card-bg':'#0D1526','--card-bg2':'#111E3A','--text-1':'#E8EDF8','--text-2':'#C8D4F0','--text-3b':'#8899BB','--text-3':'#526080','--text-4':'#7B90BB','--text-5':'#344060','--text-6':'#3A4E72','--border-1':'rgba(255,255,255,0.05)','--input-bg':'rgba(255,255,255,0.04)','--border-2':'rgba(255,255,255,0.08)','--border-3':'rgba(255,255,255,0.06)','--border-4':'rgba(255,255,255,0.12)' };
    const l = { '--outer-bg':'#E4ECF8','--app-bg':'#F0F5FE','--card-bg':'#FFFFFF','--card-bg2':'#EAF0FD','--text-1':'#0D1B2E','--text-2':'#1D3154','--text-3b':'#3A5278','--text-3':'#526898','--text-4':'#7090B0','--text-5':'#96B0CC','--text-6':'#B0C4DC','--border-1':'rgba(70,100,160,0.07)','--input-bg':'rgba(70,100,160,0.04)','--border-2':'rgba(70,100,160,0.10)','--border-3':'rgba(70,100,160,0.07)','--border-4':'rgba(70,100,160,0.10)' };
    const theme = dark ? d : l;
    Object.entries(theme).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
    // PWA：狀態列顏色與原生表單控制項配色要跟著主題走
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#080C18' : '#F0F5FE');
  }

  componentDidMount() {
    const now = new Date();
    // 預設月份／日期要跟著今天走，不能寫死
    const patch = {
      currentMonth: { year: now.getFullYear(), month: now.getMonth() + 1 },
      txDate: this.todayStr(),
    };
    let dark = this.state.darkMode;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const keys = ['transactions','budgets','assets','assetHistory','policies','profile','customAssetDefs','banks','txBank','bankAsset','assetBaseAt','darkMode'];
        keys.forEach(k => { if (saved[k] !== undefined) patch[k] = saved[k]; });
        // 連動功能之前存的檔沒有基準時間。缺的一律補上「現在」，舊帳就不會
        // 回頭改動已經對過的資產金額，只有之後新記的帳才開始連動。
        const stamp = Date.now();
        patch.assetBaseAt = { ...(patch.assetBaseAt || {}) };
        Object.keys(patch.assets || this.state.assets).forEach(k => {
          if (!patch.assetBaseAt[k]) patch.assetBaseAt[k] = stamp;
        });
        if (typeof saved.darkMode === 'boolean') dark = saved.darkMode;
      }
    } catch(e) {}
    this.setState(patch);
    // 只套一次主題：先前寫成「先套 saved 再套 this.state」，第二次會用尚未更新的
    // 舊 state 把剛套好的深色主題蓋回淺色。
    this.applyTheme(dark);
    this.startClock();
    this.prevState = this.state;
  }

  // 頂端狀態列顯示真實時間（原設計稿寫死 9:41）
  startClock() {
    const tick = () => {
      const d = new Date();
      const txt = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (txt !== this.state.clockText) this.setState({ clockText: txt });
    };
    clearInterval(this.timers.clock);
    tick();
    this.timers.clock = setInterval(tick, 15000);
  }

  componentWillUnmount() {
    this.stopRecognition();
    this.aiRun++;
    this.destroyCharts();
    Object.keys(this.timers).forEach(k => { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); });
    this.timers = {};
  }

  save(state) {
    try {
      const { transactions, budgets, assets, assetHistory, policies, profile, customAssetDefs, banks, txBank, bankAsset, assetBaseAt, darkMode } = state;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({ transactions, budgets, assets, assetHistory, policies, profile, customAssetDefs, banks, txBank, bankAsset, assetBaseAt, darkMode }));
    } catch(e) {}
  }

  // ═══ 發票掃描 ═══
  // 拍照 → 先找電子發票 QR Code（金額、日期、發票號碼都是明碼，最準確），
  // 找不到才退回 OCR 文字辨識。兩個函式庫都等到真的要用時才下載。
  QR_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  OCR_LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // 第一次 OCR 會下載語言模型（chi_tra 約 2.4MB、eng 約 4MB，之後瀏覽器會快取）。
  // 只記中文發票的話可以把 'eng' 拿掉，下載量大約少一半。
  OCR_LANGS = ['chi_tra', 'eng'];

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const found = document.querySelector('script[data-lib="' + src + '"]');
      if (found) {
        if (found.dataset.ready === '1') return resolve();
        found.addEventListener('load', () => resolve());
        found.addEventListener('error', () => reject(new Error('函式庫載入失敗')));
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      el.dataset.lib = src;
      el.onload = () => { el.dataset.ready = '1'; resolve(); };
      el.onerror = () => reject(new Error('函式庫載入失敗，請確認網路連線'));
      document.head.appendChild(el);
    });
  }

  onScanFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 清掉才能重選同一張照片
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => this.scanFailed('讀不到這個檔案，請換一張照片');
    reader.onload = () => this.processReceipt(String(reader.result));
    reader.readAsDataURL(file);
  }

  // 手機照片動輒 4000px 寬，先縮到長邊 1600px：QR 與 OCR 都夠用又快很多
  loadCanvas(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('影像解碼失敗'));
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv);
      };
      img.src = dataUrl;
    });
  }

  async processReceipt(dataUrl) {
    // 連續選兩張照片時，舊的辨識結果不能蓋掉新的
    this.scanRun = (this.scanRun || 0) + 1;
    const run = this.scanRun;
    const alive = () => run === this.scanRun && this.state.showScanSheet;
    this.setState({ scanStep: 'scanning', scanImage: dataUrl, scanProgress: 8, scanStatus: '讀取影像…', scanError: '', scanText: '', scanItems: [], scanInvNo: '' });

    let canvas;
    try {
      canvas = await this.loadCanvas(dataUrl);
    } catch (err) {
      if (alive()) this.scanFailed('照片無法解碼，請改用 JPG / PNG 照片');
      return;
    }
    if (!alive()) return;

    // 1) 電子發票 QR Code
    this.setState({ scanProgress: 22, scanStatus: '尋找發票 QR Code…' });
    try {
      const invoice = await this.readInvoiceQR(canvas);
      if (!alive()) return;
      if (invoice) { this.scanDone(invoice, 'qr'); return; }
    } catch (err) { /* 沒有 QR 或函式庫載不到，往下走 OCR */ }
    if (!alive()) return;

    // 2) OCR 文字辨識
    this.setState({ scanProgress: 35, scanStatus: '下載辨識模型…' });
    try {
      const text = await this.readReceiptText(canvas, (pct, label) => {
        if (alive()) this.setState({ scanProgress: 35 + Math.round(pct * 60), scanStatus: label });
      });
      if (!alive()) return;
      this.scanDone({ ...this.parseReceiptText(text), text }, 'ocr');
    } catch (err) {
      if (alive()) this.scanFailed('自動辨識失敗（' + ((err && err.message) || '未知錯誤') + '），請手動輸入金額');
    }
  }

  async readInvoiceQR(canvas) {
    await this.loadScript(this.QR_LIB);
    if (!window.jsQR) return null;
    const ctx = canvas.getContext('2d');
    // 整張找一次，再單獨掃下半部——發票 QR 幾乎都印在下方，放大比例後比較好認
    const regions = [
      [0, 0, canvas.width, canvas.height],
      [0, Math.round(canvas.height * 0.4), canvas.width, canvas.height - Math.round(canvas.height * 0.4)],
    ];
    for (const [x, y, w, h] of regions) {
      if (w < 40 || h < 40) continue;
      const img = ctx.getImageData(x, y, w, h);
      const code = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
      const invoice = code && this.parseInvoiceQR(code.data);
      if (invoice) return invoice;
    }
    return null;
  }

  // 台灣電子發票左側 QR 的前 77 碼是固定格式：
  // 發票號碼10 + 開立日期(民國)7 + 隨機碼4 + 銷售額8(16進位) + 總計額8(16進位)
  //   + 買方統編8 + 賣方統編8 + 加密驗證24
  parseInvoiceQR(raw) {
    const s = String(raw || '').trim();
    if (s.length < 37 || !/^[A-Z]{2}\d{8}/.test(s)) return null; // 右側 QR 以 ** 開頭，會被擋掉
    const total = parseInt(s.slice(29, 37), 16);
    if (!isFinite(total) || total <= 0) return null;
    const m = /^(\d{3})(\d{2})(\d{2})$/.exec(s.slice(10, 17));
    const items = this.parseInvoiceItems(s);
    return {
      amount: total,
      date: m ? this.safeDate(+m[1] + 1911, +m[2], +m[3]) : '',
      invNo: s.slice(0, 10),
      items,
      shop: '',
      // 左側 QR 只有賣方統編沒有店名，改用品名猜類別
      category: this.guessCategory(items.map(i => i.text).join(' ')),
      text: s,
    };
  }

  // 77 碼之後以「:」分隔：自定資料、本 QR 品目筆數、發票總筆數、中文編碼參數(1=Base64)、
  // 之後每三欄一組品名/數量/單價
  parseInvoiceItems(s) {
    const rest = s.slice(77);
    const parts = (rest.startsWith(':') ? rest.slice(1) : rest).split(':');
    if (parts.length < 7) return [];
    const isBase64 = parts[3] === '1';
    const rows = parts.slice(4);
    const items = [];
    for (let i = 0; i + 2 < rows.length && items.length < 12; i += 3) {
      let name = rows[i];
      if (isBase64) {
        try {
          const bin = atob(name);
          name = new TextDecoder('utf-8').decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
        } catch (e) { continue; } // Big5 或壞掉的編碼就跳過，不要塞亂碼進畫面
      }
      const price = parseFloat(rows[i + 2]);
      if (!name) continue;
      items.push({ text: isFinite(price) ? `${name} × ${rows[i + 1]}　$${Math.round(price)}` : name });
    }
    return items;
  }

  async readReceiptText(canvas, onProgress) {
    await this.loadScript(this.OCR_LIB);
    if (!window.Tesseract) throw new Error('OCR 函式庫載入失敗');
    let worker = null;
    const job = (async () => {
      worker = await window.Tesseract.createWorker(this.OCR_LANGS, 1, {
        // 用 tessdata_fast：標準版中文模型超過 20MB，手機上光是下載就要等很久。
        // 放在 jsdelivr 上（跟 OCR 函式庫同一個 CDN），比預設的來源穩定。
        langPath: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0',
        gzip: false,
        logger: m => {
          const pct = m.progress || 0;
          if (m.status === 'recognizing text') onProgress(pct, `文字辨識中… ${Math.round(pct * 100)}%`);
          else if (String(m.status || '').includes('traineddata')) onProgress(0, '下載辨識模型…');
          else if (m.status) onProgress(0, '啟動辨識引擎…');
        },
      });
      const { data } = await worker.recognize(canvas);
      return (data && data.text) || '';
    })();

    // 下載模型或辨識卡住時要有出口，不能讓使用者對著進度條乾等
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('辨識時間過長')), 180000); });
    try {
      return await Promise.race([job, guard]);
    } finally {
      clearTimeout(timer);
      // 逾時後工作仍在背景跑，等它自己結束再收掉 worker（順便吃掉未處理的 rejection）
      job.then(() => worker && worker.terminate(), () => worker && worker.terminate());
    }
  }

  // 從 OCR 文字裡挑金額：先看「總計／應收／TOTAL」那幾行，再退而求其次找最大的合理數字
  parseReceiptText(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const numbersIn = line => (line.match(/\d[\d,]*(?:\.\d{1,2})?/g) || [])
      .map(n => parseFloat(n.replace(/,/g, '')))
      .filter(n => isFinite(n) && n > 0 && n < 1000000);
    const pick = re => {
      let best = 0;
      for (const line of lines) {
        if (!re.test(line)) continue;
        const nums = numbersIn(line);
        if (nums.length) best = Math.max(best, nums[nums.length - 1]);
      }
      return best;
    };
    let amount = pick(/(總計|總金額|合計|應收|實收|應付|TOTAL|AMOUNT)/i)
      || pick(/(小計|金額|現金|CASH|SUBTOTAL)/i);
    if (!amount) {
      // 保底：取最大的數字，但要先排掉日期、時間、統編、電話那幾行，否則年份會被當成金額
      const meta = /(\d{4}[-\/.年]\d{1,2}[-\/.月]|\d{1,2}:\d{2}|統一編號|統編|發票|號碼|電話|TEL|NO\.|INVOICE|DATE|TIME)/i;
      const all = lines.filter(l => !meta.test(l)).reduce((acc, l) => acc.concat(numbersIn(l)), []);
      if (all.length) amount = Math.max.apply(null, all);
    }

    let date = '';
    const ad = /(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/.exec(text);
    if (ad) date = this.safeDate(+ad[1], +ad[2], +ad[3]);
    if (!date) {
      const roc = /(\d{3})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/.exec(text);
      if (roc) date = this.safeDate(+roc[1] + 1911, +roc[2], +roc[3]);
    }

    // 商家：抬頭幾行裡第一行不像欄位標題的文字
    const noise = /(發票|統一編號|統編|收銀|日期|時間|電話|地址|號碼|明細|隨機碼|TEL|NO\.|INVOICE|DATE)/i;
    const shop = lines.slice(0, 6).find(l => l.length >= 2 && l.length <= 20 && !noise.test(l) && /[\u4e00-\u9fffA-Za-z]/.test(l)) || '';

    return { amount: Math.round(amount) || 0, date, shop, items: [], category: this.guessCategory(shop + ' ' + text) };
  }

  safeDate(y, m, d) {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  guessCategory(text) {
    const t = String(text || '');
    const rules = [
      ['餐飲', /(餐|食|飲|咖啡|茶|麵|飯|便當|小吃|早餐|烘焙|麥當勞|starbucks|coffee|burger|pizza)/i],
      ['交通', /(加油|中油|台塑|油站|捷運|台鐵|高鐵|停車|計程車|客運|悠遊卡|一卡通|uber)/i],
      ['醫療保健', /(藥|診所|醫院|健保|藥妝|clinic|pharmacy)/i],
      ['娛樂', /(電影|影城|KTV|遊戲|書店|唱片|樂園|netflix|spotify)/i],
      ['購物', /(超商|超市|全家|全聯|統一超商|萊爾富|家樂福|大潤發|百貨|購物|商店|市場|mart|store|shop|7-ELEVEN)/i],
    ];
    for (const [cat, re] of rules) if (re.test(t)) return cat;
    return '其他';
  }

  scanDone(data, source) {
    this.setState(s => ({
      scanStep: 'result', scanSource: source, scanProgress: 100, scanStatus: '',
      scanAmount: data.amount ? String(data.amount) : '',
      scanShop: data.shop || '',
      scanCategory: data.category || this.guessCategory(data.shop || ''),
      scanDate: data.date || this.todayStr(),
      scanInvNo: data.invNo || '',
      scanItems: data.items || [],
      scanText: data.text || '',
      scanBank: this.defaultBank(s),
      scanError: data.amount ? '' : '沒有讀到金額，請自行輸入',
    }));
  }

  scanFailed(msg) {
    this.setState(s => ({
      scanStep: 'result', scanSource: 'manual', scanProgress: 0, scanStatus: '',
      scanAmount: '', scanShop: '', scanCategory: '餐飲', scanDate: this.todayStr(),
      scanInvNo: '', scanItems: [], scanText: '', scanError: msg, scanBank: this.defaultBank(s),
    }));
  }

  resetScan(prev) {
    return {
      scanStep: 'ready', scanImage: '', scanText: '', showScanText: false, scanAmount: '',
      scanShop: '', scanCategory: '餐飲', scanDate: '', scanInvNo: '', scanItems: [],
      scanSource: '', scanProgress: 0, scanStatus: '', scanError: '', scanBank: this.defaultBank(prev),
    };
  }

  // 加入一筆交易，並把目前檢視的月份跳到該筆交易所屬月份，
  // 否則記完帳卻因為月份不同而在清單上看不到。
  addTx(tx, extraPatch) {
    const cm = this.monthOf(tx.date);
    this.setState(s => Object.assign({
      transactions: [...s.transactions, tx],
      currentMonth: cm || s.currentMonth,
    }, extraPatch));
  }

  confirmScan() {
    const { scanAmount, scanCategory, scanShop, scanDate, scanBank, scanInvNo } = this.state;
    const amount = parseFloat(scanAmount);
    if (!isFinite(amount) || amount <= 0) { this.showToast('⚠️ 請確認金額後再記錄'); return; }
    const note = [String(scanShop).trim(), scanInvNo ? `發票 ${scanInvNo}` : ''].filter(Boolean).join(' · ');
    const date = this.monthOf(scanDate) ? scanDate : this.todayStr();
    const tx = { id: Date.now(), type: 'expense', amount, category: scanCategory, note, date, bank: scanBank };
    this.scanRun = (this.scanRun || 0) + 1;
    this.addTx(tx, Object.assign({ showScanSheet: false, txBank: scanBank }, this.resetScan(this.state)));
    this.showToast('✓ 發票已記錄');
  }

  // ═══ 語音記帳（Web Speech API） ═══
  // 原設計稿在這裡回傳四筆寫死的假交易；正式版改用瀏覽器的語音辨識，
  // 辨識不到就明講，絕不把虛構的金額寫進使用者的帳本。
  CN_DIGITS = { '零':0,'〇':0,'一':1,'壹':1,'二':2,'貳':2,'兩':2,'两':2,'三':3,'參':3,'叁':3,'四':4,'肆':4,'五':5,'伍':5,'六':6,'陸':6,'七':7,'柒':7,'八':8,'捌':8,'九':9,'玖':9 };
  CN_UNITS  = { '十':10,'拾':10,'百':100,'佰':100,'千':1000,'仟':1000 };
  CN_BIG    = { '萬':10000,'万':10000,'億':100000000,'亿':100000000 };

  speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  startVoice() {
    const SR = this.speechCtor();
    if (!SR) { this.showToast('⚠️ 此瀏覽器不支援語音辨識，請改用 Chrome / Edge'); return; }
    if (!window.isSecureContext) { this.showToast('⚠️ 語音辨識需要 HTTPS 或 localhost'); return; }

    this.stopRecognition();
    clearInterval(this.timers.voiceTick);

    let rec;
    try { rec = new SR(); } catch (e) { this.showToast('⚠️ 無法啟動語音辨識'); return; }
    rec.lang = 'zh-TW';
    rec.continuous = true;        // 由使用者按「停止錄音」決定何時結束
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    this.rec = rec;
    this.recText = '';
    this.recError = '';

    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) this.recText += e.results[i][0].transcript;
      }
    };
    rec.onerror = e => {
      const msg = {
        'not-allowed': '麥克風權限被拒絕，請在瀏覽器設定中允許',
        'service-not-allowed': '麥克風權限被拒絕',
        'no-speech': '沒有聽到聲音，請再試一次',
        'audio-capture': '找不到麥克風',
        'network': '語音辨識服務連線失敗',
      }[e.error];
      this.recError = msg || ('語音辨識失敗（' + e.error + '）');
    };
    rec.onend = () => {
      clearInterval(this.timers.voiceTick);
      this.rec = null;
      if (this.state.showVoiceSheet) this.finishVoice();
    };

    try { rec.start(); }
    catch (e) { this.rec = null; this.showToast('⚠️ 無法啟動語音辨識'); return; }

    this.setState({ voiceStep: 'recording', voiceSeconds: 0, voiceData: null });
    this.timers.voiceTick = setInterval(() => this.setState(s => ({ voiceSeconds: s.voiceSeconds + 1 })), 1000);
  }

  stopVoice() {
    clearInterval(this.timers.voiceTick);
    this.setState({ voiceStep: 'analyzing' });
    this.stopRecognition();       // 觸發 onend → finishVoice
  }

  stopRecognition() {
    if (!this.rec) return;
    const rec = this.rec;
    this.rec = null;
    try { rec.onend = null; rec.onresult = null; rec.onerror = null; rec.stop(); } catch (e) {}
  }

  finishVoice() {
    const text = String(this.recText || '').trim();
    if (!text) {
      const err = this.recError;
      this.recError = '';
      this.setState({ voiceStep: 'ready', voiceSeconds: 0 });
      this.showToast('⚠️ ' + (err || '沒有聽到內容，請再說一次'));
      return;
    }
    const data = this.parseSpeech(text);
    if (!data.amount) {
      this.setState({ voiceStep: 'ready', voiceSeconds: 0 });
      this.showToast('⚠️ 沒聽出金額，例如「午餐花了 85 元」');
      return;
    }
    this.setState({ voiceStep: 'result', voiceData: data });
  }

  // 中文數字 → 阿拉伯數字（「八十五」→ 85、「一千二百」→ 1200）
  cnToNumber(str) {
    let total = 0, section = 0, num = 0, seen = false;
    for (const ch of String(str)) {
      if (this.CN_DIGITS[ch] !== undefined) { num = this.CN_DIGITS[ch]; seen = true; }
      else if (this.CN_UNITS[ch] !== undefined) { section += (num || 1) * this.CN_UNITS[ch]; num = 0; seen = true; }
      else if (this.CN_BIG[ch] !== undefined) { total += ((section + num) || 1) * this.CN_BIG[ch]; section = 0; num = 0; seen = true; }
      else return null;
    }
    if (!seen) return null;
    const v = total + section + num;
    return isFinite(v) && v > 0 ? v : null;
  }

  extractAmount(text) {
    const t = String(text).replace(/,/g, '');
    // 1) 「85 元」這種帶單位的阿拉伯數字最可信
    let m = /(\d+(?:\.\d+)?)\s*(?:元|塊|块|圓|円)/.exec(t);
    if (m) return { amount: parseFloat(m[1]), raw: m[0] };
    // 2) 中文數字，同樣優先看有沒有接單位
    const re = /[零〇一壹二貳兩两三參叁四肆五伍六陸七柒八捌九玖十拾百佰千仟萬万億亿]+/g;
    let best = null, hit;
    while ((hit = re.exec(t))) {
      const v = this.cnToNumber(hit[0]);
      if (v == null) continue;
      const withUnit = /^[元塊块圓円]/.test(t.slice(hit.index + hit[0].length));
      if (withUnit) return { amount: v, raw: hit[0] };
      if (!best || v > best.amount) best = { amount: v, raw: hit[0] };
    }
    // 3) 都沒有單位就取最大的阿拉伯數字
    const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(n => parseFloat(n)).filter(n => isFinite(n) && n > 0);
    if (nums.length) {
      const max = Math.max.apply(null, nums);
      if (!best || max >= best.amount) return { amount: max, raw: String(max) };
    }
    return best;
  }

  parseSpeech(text) {
    const t = String(text).trim();
    const hit = this.extractAmount(t);
    const amount = hit ? Math.round(hit.amount) : 0;
    const isIncome = /(薪水|薪資|收入|獎金|入帳|進帳|領到|賺了|紅利|退稅|股利|配息)/.test(t);
    const category = isIncome
      ? (/薪/.test(t) ? '薪資'
        : /獎金|紅利/.test(t) ? '獎金'
        : /租/.test(t) ? '租金收入'
        : /投資|股票|股利|配息/.test(t) ? '投資收益' : '其他收入')
      : this.guessCategory(t);
    let note = t;
    if (hit) note = note.replace(hit.raw, ' ');
    note = note
      .replace(/(花費|花了|付了|共計|總共|一共|大概|差不多|支出|收入|元|塊|块|圓|円|新台幣|台幣|NT\$?)/g, ' ')
      .replace(/(今天|今日|昨天|昨日|前天|剛剛|剛才|早上|中午|下午|晚上)/g, ' ')
      .replace(/[，,。．.、！!？?~～\s]+/g, ' ')
      .trim();
    if (note.length > 20) note = note.slice(0, 20);
    return { text: t, amount, category, note: note || category, type: isIncome ? 'income' : 'expense' };
  }

  confirmVoice() {
    const { voiceData } = this.state;
    if (!voiceData || !voiceData.amount) return;
    const tx = {
      id: Date.now(), type: voiceData.type || 'expense', amount: voiceData.amount,
      category: voiceData.category, note: voiceData.note, date: this.todayStr(),
      bank: this.defaultBank(this.state),
    };
    this.addTx(tx, { showVoiceSheet: false, voiceStep: 'ready', voiceData: null, voiceSeconds: 0 });
    this.showToast(tx.type === 'income' ? '✓ 語音記錄收入完成' : '✓ 語音記帳完成');
  }

  showToast(msg) {
    this.setState({ toast: msg });
    clearTimeout(this.timers.toast);
    this.timers.toast = setTimeout(() => this.setState({ toast: '' }), 2200);
  }

  submitAddAssetCat() {
    const { newAssetName, newAssetEmoji, newAssetAmount, assets, customAssetDefs } = this.state;
    const key = newAssetName.trim();
    if (!key) { this.showToast('⚠️ 請輸入類別名稱'); return; }
    if (assets[key] !== undefined) { this.showToast('⚠️ 已有相同名稱的資產類別'); return; }
    const amt = newAssetAmount === '' ? '' : parseFloat(newAssetAmount);
    if (amt !== '' && (!isFinite(amt) || amt < 0)) { this.showToast('⚠️ 請輸入有效金額'); return; }
    const newDef = { id: Date.now(), key, emoji: newAssetEmoji || '💼' };
    this.setState(prev => ({
      customAssetDefs: [...prev.customAssetDefs, newDef],
      assets: { ...prev.assets, [key]: amt === '' ? '' : String(amt) },
      assetBaseAt: { ...(prev.assetBaseAt || {}), [key]: Date.now() },
      showAddAssetCat: false, newAssetName: '', newAssetEmoji: '💼', newAssetAmount: '',
    }));
    this.showToast(`✓ 已新增「${key}」類別`);
  }

  // dc-runtime 呼叫的是 componentDidUpdate(prevProps)——只有一個參數。
  // 原本簽章寫成 (prev, prevState) 並在第一行就讀 prevState.darkMode，
  // 每次更新都會丟 TypeError 並被 runtime 的 try/catch 吞掉，
  // 導致自動存檔、圖表初始化、深色模式套用三件事全部沒有執行。
  // 這裡改成自己保存上一輪的 state 快照。
  componentDidUpdate() {
    const prevState = this.prevState || {};
    const s = this.state;
    this.prevState = s;

    if (prevState.darkMode !== s.darkMode) this.applyTheme(s.darkMode);

    // Auto-save when data changes
    if (prevState.transactions !== s.transactions || prevState.budgets !== s.budgets ||
        prevState.assets !== s.assets || prevState.assetHistory !== s.assetHistory ||
        prevState.policies !== s.policies || prevState.profile !== s.profile ||
        prevState.customAssetDefs !== s.customAssetDefs || prevState.banks !== s.banks ||
        prevState.txBank !== s.txBank || prevState.bankAsset !== s.bankAsset ||
        prevState.assetBaseAt !== s.assetBaseAt || prevState.darkMode !== s.darkMode) {
      this.save(s);
    }

    // Charts
    if (s.tab === 'analysis') {
      const changed = prevState.tab !== 'analysis' || prevState.analysisTab !== s.analysisTab
        || prevState.transactions !== s.transactions || prevState.assets !== s.assets
        || prevState.bankAsset !== s.bankAsset || prevState.assetBaseAt !== s.assetBaseAt
        || prevState.policies !== s.policies || prevState.currentMonth !== s.currentMonth
        || prevState.darkMode !== s.darkMode;
      if (changed) this.initChart();
    } else if (prevState.tab === 'analysis') {
      this.destroyCharts();
    }
  }

  destroyCharts() {
    clearTimeout(this.timers.chart);
    this.timers.chart = null;
    Object.values(this.charts).forEach(c => { try { c.destroy(); } catch (e) {} });
    this.charts = {};
  }

  initChart() {
    this.destroyCharts();
    const { analysisTab, currentMonth, transactions, assets, policies } = this.state;
    const colors = ['#6C8EF5', '#34D399', '#E9B44C', '#F87171', '#A78BFA'];
    // 圖表文字／格線顏色要跟著主題走，原本寫死深色值在淺色模式下幾乎看不見
    const dark = this.state.darkMode;
    const legendColor = dark ? '#7B90BB' : '#526898';
    const tickColor = dark ? '#526080' : '#7090B0';
    const gridColor = dark ? 'rgba(255,255,255,0.05)' : 'rgba(70,100,160,0.12)';
    const baseOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: legendColor, font: { family: 'Plus Jakarta Sans', size: 11 }, boxWidth: 10, padding: 12 } } }
    };
    const scaleOpts = {
      x: { ticks: { color: tickColor, font: { family: 'Plus Jakarta Sans', size: 10 } }, grid: { color: gridColor }, border: { color: gridColor } },
      y: { ticks: { color: tickColor, font: { family: 'Plus Jakarta Sans', size: 10 } }, grid: { color: gridColor }, border: { color: gridColor } }
    };
    // Last 6 months
    const months6 = [];
    for (let i = 5; i >= 0; i--) {
      let m = currentMonth.month - i, y = currentMonth.year;
      while (m <= 0) { m += 12; y -= 1; }
      const inc = transactions.filter(t => t.type === 'income' && this.inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
      const exp = transactions.filter(t => t.type === 'expense' && this.inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
      months6.push({ label: `${m}月`, inc, exp });
    }
    // 延遲建立圖表是為了等 canvas 進 DOM，但延遲期間可能又切了分頁：
    // 沒有 guard 的話兩個 timeout 會對同一個 canvas 建兩次圖，
    // Chart.js 會丟 "Canvas is already in use"。
    this.timers.chart = setTimeout(() => {
      this.timers.chart = null;
      if (typeof Chart === 'undefined') return;
      if (this.state.tab !== 'analysis' || this.state.analysisTab !== analysisTab) return;
      if (analysisTab === 'trend') {
        const el = document.getElementById('chart-trend'); if (!el) return;
        this.charts.trend = new Chart(el, { type: 'line', data: { labels: months6.map(m => m.label), datasets: [
          { label: '收入', data: months6.map(m => m.inc), borderColor: '#34D399', backgroundColor: 'rgba(52,211,153,0.08)', tension: 0.4, fill: true, pointBackgroundColor: '#34D399', pointRadius: 4 },
          { label: '支出', data: months6.map(m => m.exp), borderColor: '#F87171', backgroundColor: 'rgba(248,113,113,0.08)', tension: 0.4, fill: true, pointBackgroundColor: '#F87171', pointRadius: 4 }
        ] }, options: { ...baseOpts, scales: scaleOpts } });
      } else if (analysisTab === 'category') {
        const el = document.getElementById('chart-category'); if (!el) return;
        const cats = ['餐飲','交通','娛樂','購物','醫療保健','其他'];
        const cm = currentMonth;
        const data = cats.map(cat => transactions.filter(t => t.type === 'expense' && t.category === cat && this.inMonth(t.date, cm.year, cm.month)).reduce((s,t)=>s+t.amount,0));
        const total = data.reduce((s,v)=>s+v,0);
        this.charts.category = new Chart(el, { type: 'doughnut', data: { labels: cats, datasets: [{ data: total > 0 ? data : [1,1,1,1,1,1], backgroundColor: colors.concat('#5BA4F5'), borderWidth: 0, hoverOffset: 6 }] }, options: { ...baseOpts, cutout: '62%' } });
      } else if (analysisTab === 'assets') {
        const el = document.getElementById('chart-assets'); if (!el) return;
        const keys = ['現金 & 存款','股票 & ETF','基金 & 債券','不動產'];
        const data = keys.map(k => this.assetAmount(this.state, k));
        const total = data.reduce((s,v)=>s+v,0);
        this.charts.assets = new Chart(el, { type: 'doughnut', data: { labels: keys, datasets: [{ data: total > 0 ? data : [1,1,1,1], backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] }, options: { ...baseOpts, cutout: '62%' } });
      } else if (analysisTab === 'cashflow') {
        const el = document.getElementById('chart-cashflow'); if (!el) return;
        this.charts.cashflow = new Chart(el, { type: 'bar', data: { labels: months6.map(m => m.label), datasets: [
          { label: '流入', data: months6.map(m => m.inc), backgroundColor: 'rgba(52,211,153,0.65)', borderRadius: 5 },
          { label: '流出', data: months6.map(m => m.exp), backgroundColor: 'rgba(248,113,113,0.65)', borderRadius: 5 }
        ] }, options: { ...baseOpts, scales: scaleOpts } });
      } else if (analysisTab === 'premium') {
        const el = document.getElementById('chart-premium'); if (!el) return;
        const types = ['壽險','醫療險','意外險','重大傷病險','其他'];
        const data = types.map(t => policies.filter(p=>p.type===t).reduce((s,p)=>{ const pr=parseFloat(p.premium)||0; return s+(p.freq==='月繳'?pr*12:p.freq==='半年繳'?pr*2:pr); },0));
        const total = data.reduce((s,v)=>s+v,0);
        this.charts.premium = new Chart(el, { type: 'doughnut', data: { labels: types, datasets: [{ data: total > 0 ? data : [1,1,1,1,1], backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] }, options: { ...baseOpts, cutout: '62%' } });
      }
    }, 220);
  }

  triggerAI() {
    const { transactions, policies, profile } = this.state;
    const allInc = transactions.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
    const allExp = transactions.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
    const monthlyInc = parseFloat(profile.monthlyIncome) || 0;
    const msgs = [
      { isSys: true, isAI: false, text: '正在分析您的財務狀況…' },
    ];
    if (transactions.length === 0 && policies.length === 0) {
      msgs.push({ isSys: false, isAI: true, text: '📊 目前尚無財務記錄。建議先：\n\n① 記錄收入來源（薪資、投資收益等）\n② 建立預算分類控制支出\n③ 整理現有保單確保基本保障' });
    } else {
      const savings = allInc - allExp;
      // 沒有收入卻有支出時，原本算出 0% 會被歸類成「儲蓄率偏低」，實際上是入不敷出
      const savingRate = allInc > 0 ? Math.round((savings / allInc) * 100) : (allExp > 0 ? -100 : 0);
      const rateText = allInc > 0 ? `${savingRate}%` : '—（尚無收入記錄）';
      msgs.push({ isSys: false, isAI: true, text: `📊 財務摘要：累計收入 NT$${Math.round(allInc).toLocaleString()}，支出 NT$${Math.round(allExp).toLocaleString()}，儲蓄率 ${rateText}。` });
      if (savingRate >= 20) {
        msgs.push({ isSys: false, isAI: true, text: '✅ 您的儲蓄率表現良好！建議將閒置資金投入指數型 ETF，長期複利增值。' });
      } else if (savingRate >= 0) {
        msgs.push({ isSys: false, isAI: true, text: '⚠️ 儲蓄率偏低，建議設定各類別預算目標，從減少娛樂和餐飲支出開始改善。' });
      } else {
        msgs.push({ isSys: false, isAI: true, text: '🚨 目前支出超過收入，建議立即審視非必要支出，優先建立 3-6 個月緊急備用金。' });
      }
      if (policies.length === 0) {
        msgs.push({ isSys: false, isAI: true, text: '🛡️ 尚未建立任何保障！建議優先投保定期壽險（保額建議年薪 10 倍）和醫療實支實付險。' });
      } else if (monthlyInc > 0) {
        const annualPrem = policies.reduce((s,p)=>{ const pr=parseFloat(p.premium)||0; return s+(p.freq==='月繳'?pr*12:p.freq==='半年繳'?pr*2:pr); },0);
        const premRatio = Math.round((annualPrem / (monthlyInc * 12)) * 100);
        msgs.push({ isSys: false, isAI: true, text: `🛡️ 您有 ${policies.length} 張保單，年繳保費占年收入 ${premRatio}%。${premRatio > 15 ? '建議檢視是否有重複保障，適度精簡。' : '保費配置合理，持續維護保障完整性。'}` });
      }
    }
    // 每次分析給一個流水號：關掉面板或重新分析時舊的序列會自動停止，
    // 否則關閉後殘留的 setTimeout 會把舊訊息塞進下一次的對話。
    const run = ++this.aiRun;
    clearTimeout(this.timers.ai);
    this.setState({ showAIPanel: true, aiTyping: true, aiMessages: [] });
    let i = 0;
    const show = () => {
      if (run !== this.aiRun) return;
      if (i < msgs.length) {
        const msg = msgs[i++];
        this.setState(s => ({ aiMessages: [...s.aiMessages, msg] }));
        this.timers.ai = setTimeout(show, i === 1 ? 900 : 1600);
      } else {
        this.setState({ aiTyping: false });
      }
    };
    this.timers.ai = setTimeout(show, 400);
  }

  submitTx() {
    const { txType, txAmount, txCategory, txNote, txDate, txBank, txBankCustom, banks } = this.state;
    const amount = parseFloat(txAmount);
    // 原本靜默 return，使用者按了沒反應也不知道為什麼
    if (!isFinite(amount) || amount <= 0) { this.showToast('⚠️ 請輸入大於 0 的金額'); return; }
    // 選了「自訂」卻沒填名稱的話，這筆帳會沒有歸屬帳戶，先擋下來
    const isCustomBank = txBank === CUSTOM_BANK;
    const bank = isCustomBank ? String(txBankCustom).trim() : txBank;
    if (isCustomBank && !bank) { this.showToast('⚠️ 請輸入銀行 / 帳戶名稱'); return; }
    const date = this.monthOf(txDate) ? txDate : this.todayStr();
    const tx = { id: Date.now(), type: txType, amount, category: txCategory, note: txNote.trim(), date, bank };
    // 新的自訂帳戶存進清單，下次可直接從下拉選單挑
    const nextBanks = banks.includes(bank) ? banks : [...banks, bank];
    this.addTx(tx, { showTxSheet: false, txAmount: '', txNote: '', fabOpen: false, banks: nextBanks, txBank: bank, txBankCustom: '' });
    this.showToast(tx.type === 'income' ? '✓ 收入已記錄' : '✓ 支出已記錄');
  }

  submitBudget() {
    const { budgetCategory, budgetAmount } = this.state;
    const amt = String(budgetAmount).trim() === '' ? '' : parseFloat(budgetAmount);
    if (amt !== '' && (!isFinite(amt) || amt < 0)) { this.showToast('⚠️ 請輸入有效的預算金額'); return; }
    const value = amt === '' ? '' : String(amt);
    this.setState(s => ({ budgets: { ...s.budgets, [budgetCategory]: value }, showBudgetSheet: false, budgetAmount: '' }));
    this.showToast(value === '' ? `✓ 已清除${budgetCategory}預算` : `✓ ${budgetCategory}預算已儲存`);
  }

  submitPolicy() {
    const { policyName, policyType, policyCompany, policyPremium, policyFreq, policyExpiry } = this.state;
    if (!policyName.trim()) { this.showToast('⚠️ 請輸入保單名稱'); return; }
    const prem = String(policyPremium).trim() === '' ? '' : parseFloat(policyPremium);
    if (prem !== '' && (!isFinite(prem) || prem < 0)) { this.showToast('⚠️ 請輸入有效的保費'); return; }
    const pol = { id: Date.now(), name: policyName.trim(), type: policyType, company: policyCompany.trim(), premium: prem === '' ? '' : String(prem), freq: policyFreq, expiry: policyExpiry || '—' };
    this.setState(s => ({ policies: [...s.policies, pol], showPolicySheet: false, policyName: '', policyCompany: '', policyPremium: '', policyExpiry: '' }));
    this.showToast('✓ 保單已新增');
  }

  submitAsset() {
    const { editAssetType, editAssetAmount, editAssetBanks } = this.state;
    const raw = String(editAssetAmount).trim();
    const newAmount = raw === '' ? 0 : parseFloat(raw);
    if (!isFinite(newAmount) || newAmount < 0) { this.showToast('⚠️ 請輸入有效金額'); return; }
    const picked = Array.isArray(editAssetBanks) ? editAssetBanks : [];
    const now = new Date();
    const dateStr = this.todayStr();
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    this.setState(s => {
      // 舊金額要用「連動後」的數字，異動紀錄才對得上畫面上原本顯示的值
      const oldAmount = this.assetAmount(s, editAssetType);
      // 一個帳戶只能屬於一個資產類別，否則同一筆帳會被算兩次
      const nextMap = { ...(s.bankAsset || {}) };
      this.bankList(s).forEach(b => {
        if (picked.includes(b)) nextMap[b] = editAssetType;
        else if (this.bankAssetOf(s, b) === editAssetType) nextMap[b] = '';
      });
      // 這次輸入的金額成為新基準；時間戳之後記的帳才開始往上加減
      const stamp = Date.now();
      const rec = { id: stamp, assetType: editAssetType, oldAmount, newAmount, date: dateStr, time: timeStr, manual: true };
      return {
        assets: { ...s.assets, [editAssetType]: raw === '' ? '' : String(newAmount) },
        bankAsset: nextMap,
        assetBaseAt: { ...(s.assetBaseAt || {}), [editAssetType]: stamp },
        assetHistory: [rec, ...s.assetHistory].slice(0, 50),
        showAssetSheet: false, editAssetAmount: '', editAssetBanks: [],
      };
    });
    this.showToast(picked.length ? `✓ 已儲存，並與 ${picked.length} 個帳戶連動` : '✓ 資產已儲存');
  }

  renderVals() {
    const s = this.state;
    const { tab, recordsTab, analysisTab, insuranceTab, profileTab, currentMonth,
      transactions, budgets, assets, policies, profile,
      txType, txAmount, txCategory, txNote, txDate, txBank, txBankCustom, banks,
      showTxSheet, showBudgetSheet, showPolicySheet, showAssetSheet,
      budgetCategory, budgetAmount, policyName, policyType, policyCompany,
      policyPremium, policyFreq, policyExpiry, editAssetType, editAssetAmount,
      showAIPanel, aiMessages, aiTyping, fabOpen } = s;

    const fmt = n => Math.round(n).toLocaleString('zh-TW');
    const ac = '#6C8EF5', mc = '#526080';
    const tc = t => tab === t ? ac : mc;
    const seg = (val, cur) => ({ bg: val === cur ? 'rgba(108,142,245,0.14)' : 'transparent', color: val === cur ? '#6C8EF5' : '#526080' });
    const pill = (val, cur) => ({ bg: val === cur ? 'rgba(108,142,245,0.12)' : 'transparent', color: val === cur ? '#6C8EF5' : '#526080', border: val === cur ? '1px solid rgba(108,142,245,0.22)' : '1px solid transparent' });

    const catEmoji = { '餐飲':'🍜','交通':'🚗','娛樂':'🎮','購物':'🛍️','醫療保健':'💊','其他':'📦','薪資':'💼','投資收益':'📈','獎金':'🎁','租金收入':'🏠','其他收入':'💰' };
    const expCats = ['餐飲','交通','娛樂','購物','醫療保健','其他'];
    const bankIcon = b => b === '現金' ? '💵' : b === '信用卡' ? '💳' : b === '郵局' ? '📮' : '🏦';
    const bankList = Array.isArray(banks) && banks.length ? banks : ['現金'];
    const incCats = ['薪資','投資收益','獎金','租金收入','其他收入'];

    // Month transactions
    const monthTxs = transactions.filter(tx => this.inMonth(tx.date, currentMonth.year, currentMonth.month));
    const monthIncome = monthTxs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const monthExpense = monthTxs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const monthBalance = monthIncome - monthExpense;
    const allIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const allExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

    // Assets
    const assetDefs = [
      { key: '現金 & 存款', emoji: '💰', color: '#6C8EF5', bg: 'rgba(108,142,245,0.06)', borderColor: 'rgba(108,142,245,0.12)' },
      { key: '股票 & ETF', emoji: '📈', color: '#34D399', bg: 'rgba(52,211,153,0.06)', borderColor: 'rgba(52,211,153,0.12)' },
      { key: '基金 & 債券', emoji: '🏦', color: '#E9B44C', bg: 'rgba(233,180,76,0.06)', borderColor: 'rgba(233,180,76,0.12)' },
      { key: '不動產', emoji: '🏠', color: '#F87171', bg: 'rgba(248,113,113,0.06)', borderColor: 'rgba(248,113,113,0.12)' },
    ];
    const customPalette = [
      { color:'#A78BFA', bg:'rgba(167,139,250,0.06)', borderColor:'rgba(167,139,250,0.12)' },
      { color:'#34D399', bg:'rgba(52,211,153,0.06)', borderColor:'rgba(52,211,153,0.12)' },
      { color:'#E9B44C', bg:'rgba(233,180,76,0.06)', borderColor:'rgba(233,180,76,0.12)' },
      { color:'#F87171', bg:'rgba(248,113,113,0.06)', borderColor:'rgba(248,113,113,0.12)' },
      { color:'#6C8EF5', bg:'rgba(108,142,245,0.06)', borderColor:'rgba(108,142,245,0.12)' },
    ];
    const customDefs = (s.customAssetDefs || []).map((d, i) => ({
      key: d.key, emoji: d.emoji, isCustom: true,
      ...customPalette[i % customPalette.length],
      onDelete: () => this.setState(prev => {
        const newDefs = prev.customAssetDefs.filter(cd => cd.id !== d.id);
        const newAssets = { ...prev.assets };
        delete newAssets[d.key];
        const newBase = { ...(prev.assetBaseAt || {}) };
        delete newBase[d.key];
        // 連到這個類別的帳戶要放掉，否則它們的帳會憑空消失在總資產裡
        const newMap = { ...(prev.bankAsset || {}) };
        Object.keys(newMap).forEach(b => { if (newMap[b] === d.key) newMap[b] = ''; });
        return { customAssetDefs: newDefs, assets: newAssets, assetBaseAt: newBase, bankAsset: newMap };
      })
    }));
    const allAssetDefs = [...assetDefs.map(d => ({ ...d, isCustom: false })), ...customDefs];
    const assetItems = allAssetDefs.map(def => {
      const amount = this.assetAmount(s, def.key);
      const flow = this.assetFlow(s, def.key);
      const linked = this.banksLinkedTo(s, def.key);
      return {
        ...def,
        amount,
        amountText: `NT$${fmt(amount)}`,
        linkText: linked.length ? `🔗 ${linked.join('・')}` : '未連動帳戶',
        linkColor: linked.length ? def.color : 'var(--text-5)',
        hasFlow: flow !== 0,
        flowText: flow === 0 ? '' : `帳簿 ${flow > 0 ? '+' : '−'}NT$${fmt(Math.abs(flow))}`,
        flowColor: flow > 0 ? '#34D399' : '#F87171',
        // 編輯時帶入目前顯示的金額（含連動），存檔後它就是新的基準
        onEdit: () => this.setState(prev => ({
          showAssetSheet: true, editAssetType: def.key,
          editAssetAmount: String(this.assetAmount(prev, def.key) || ''),
          editAssetBanks: this.banksLinkedTo(prev, def.key),
        })),
      };
    });
    const totalAssets = assetItems.reduce((s, a) => s + a.amount, 0);

    // Asset history
    const assetEmojiMap = { '現金 & 存款':'💰', '股票 & ETF':'📈', '基金 & 債券':'🏦', '不動產':'🏠' };
    const assetColorMap = { '現金 & 存款':'rgba(108,142,245,0.12)', '股票 & ETF':'rgba(52,211,153,0.12)', '基金 & 債券':'rgba(233,180,76,0.12)', '不動產':'rgba(248,113,113,0.12)' };
    // 自訂類別的異動紀錄原本一律顯示 💼，改成沿用建立時挑的圖示與配色
    customDefs.forEach(d => { assetEmojiMap[d.key] = d.emoji; assetColorMap[d.key] = d.borderColor; });
    const assetHistory = s.assetHistory || [];
    const assetHistoryDisplay = assetHistory.map(rec => {
      const diff = rec.newAmount - rec.oldAmount;
      return {
        ...rec,
        emoji: assetEmojiMap[rec.assetType] || '💼',
        dotBg: assetColorMap[rec.assetType] || 'rgba(255,255,255,0.06)',
        dateDisplay: `${rec.date} ${rec.time}`,
        newAmountText: `NT$${fmt(rec.newAmount)}`,
        changeText: diff === 0 ? '無變動' : (diff > 0 ? `▲ NT$${fmt(diff)}` : `▼ NT$${fmt(Math.abs(diff))}`),
        changeColor: diff > 0 ? '#34D399' : diff < 0 ? '#F87171' : '#526080',
      };
    });
    const lastUpdate = assetHistory[0];
    const assetLastUpdated = lastUpdate ? `最後更新：${lastUpdate.date} ${lastUpdate.time}` : '尚未記錄';
    // 已連動的收支早就算進 totalAssets 了，這裡只補上還沒連動的帳戶（例如信用卡）
    const unlinkedFlow = this.unlinkedFlow(s);
    const netWorth = totalAssets + unlinkedFlow;

    // Budget
    const budgetCatDefs = [
      { name:'餐飲', emoji:'🍜', barColor:'#6C8EF5' }, { name:'交通', emoji:'🚗', barColor:'#34D399' },
      { name:'娛樂', emoji:'🎮', barColor:'#E9B44C' }, { name:'購物', emoji:'🛍️', barColor:'#F87171' }, { name:'醫療保健', emoji:'💊', barColor:'#A78BFA' }
    ];
    const budgetItems = budgetCatDefs.map(def => {
      const spent = monthTxs.filter(t => t.type === 'expense' && t.category === def.name).reduce((s, t) => s + t.amount, 0);
      const limit = parseFloat(budgets[def.name]) || 0;
      const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
      return { ...def, spent, limit, spentText: `NT$${fmt(spent)}`, limitText: limit > 0 ? `NT$${fmt(limit)}` : '未設定', pctWidth: `${pct}%`, onSetBudget: () => this.setState({ showBudgetSheet: true, budgetCategory: def.name, budgetAmount: String(budgets[def.name] || '') }) };
    });
    const budgetTotal = budgetCatDefs.reduce((s, d) => s + (parseFloat(budgets[d.name]) || 0), 0);
    const budgetSpent = budgetCatDefs.reduce((s, d) => s + monthTxs.filter(t => t.type === 'expense' && t.category === d.name).reduce((ss, t) => ss + t.amount, 0), 0);
    const budgetPct = budgetTotal > 0 ? Math.min(100, (budgetSpent / budgetTotal) * 100) : 0;

    // Transactions list
    // 舊資料（或掃描／語音記帳）沒有 bank 欄位，清單就不顯示帳戶標籤
    const currentMonthTxItems = [...monthTxs].sort((a, b) => (this.parseDate(b.date) - this.parseDate(a.date)) || (b.id - a.id)).map(tx => ({ ...tx, emoji: catEmoji[tx.category] || '📦', hasBank: !!tx.bank, bankLabel: tx.bank ? `${bankIcon(tx.bank)} ${tx.bank}` : '', amountColor: tx.type === 'income' ? '#34D399' : '#F87171', amountText: (tx.type === 'income' ? '+' : '−') + 'NT$' + fmt(tx.amount), dateDisplay: tx.note ? `${tx.date} · ${tx.note}` : tx.date, onDelete: () => this.setState(prev => ({ transactions: prev.transactions.filter(t => t.id !== tx.id) })) }));
    const recentTxs = currentMonthTxItems.slice(0, 4);

    // 記帳表單：這筆會動到哪個資產類別
    const txBankName = txBank === CUSTOM_BANK ? String(txBankCustom).trim() : txBank;
    const txLinkedAsset = txBankName ? this.bankAssetOf(s, txBankName) : '';
    const txBankAssetHint = txLinkedAsset
      ? `✓ 這筆會同步更新資產彙整的「${txLinkedAsset}」`
      : '此帳戶未連動資產，只會記在帳簿';

    // 資產面板：可勾選要連動的帳戶
    const editBanks = Array.isArray(s.editAssetBanks) ? s.editAssetBanks : [];
    const editAssetBankChips = bankList.map(b => {
      const on = editBanks.includes(b);
      const owner = this.bankAssetOf(s, b);
      const takenBy = !on && owner && owner !== editAssetType ? owner : '';
      return {
        name: b,
        label: `${bankIcon(b)} ${b}${takenBy ? `（現屬 ${takenBy}）` : ''}`,
        bg: on ? 'rgba(52,211,153,0.14)' : 'var(--input-bg)',
        border: on ? '1px solid rgba(52,211,153,0.4)' : '1px solid var(--border-2)',
        color: on ? '#34D399' : 'var(--text-3)',
        onToggle: () => this.setState(prev => {
          const cur = Array.isArray(prev.editAssetBanks) ? prev.editAssetBanks : [];
          return { editAssetBanks: cur.includes(b) ? cur.filter(x => x !== b) : [...cur, b] };
        }),
      };
    });

    // Policies
    const policyTypeEmoji = { '壽險':'❤️','醫療險':'🏥','意外險':'⚡','重大傷病險':'🧬','其他':'📋' };
    const policyItems = policies.map(p => ({ ...p, typeEmoji: policyTypeEmoji[p.type] || '📋', premiumText: `NT$${fmt(parseFloat(p.premium) || 0)}`, onDelete: () => this.setState(prev => ({ policies: prev.policies.filter(pol => pol.id !== p.id) })) }));
    const annualPremium = policies.reduce((s, p) => { const pr = parseFloat(p.premium) || 0; return s + (p.freq === '月繳' ? pr * 12 : p.freq === '半年繳' ? pr * 2 : pr); }, 0);
    const covTypes = ['壽險','醫療險','意外險','重大傷病險'];
    const gapCount = covTypes.filter(t => !policies.some(p => p.type === t)).length;

    // Coverage analysis
    const targets = { '壽險': '保額建議年薪 10 倍', '醫療險': '建議實支實付型', '意外險': '保額建議 200 萬以上', '重大傷病險': '建議 100 萬以上' };
    const coverageItems = covTypes.map(type => {
      const hasCov = policies.some(p => p.type === type);
      return { label: `${policyTypeEmoji[type]} ${type}`, statusText: hasCov ? '✅ 已覆蓋' : '❌ 未覆蓋', statusColor: hasCov ? '#34D399' : '#F87171', pctWidth: hasCov ? '100%' : '0%', barColor: hasCov ? '#34D399' : '#F87171', target: targets[type] };
    });

    // Category items for form
    const currentCatList = txType === 'expense' ? expCats : incCats;
    const categoryItems = currentCatList.map(cat => ({ name: cat, emoji: catEmoji[cat], bg: txCategory === cat ? 'rgba(108,142,245,0.15)' : 'rgba(255,255,255,0.04)', border: txCategory === cat ? '1px solid rgba(108,142,245,0.3)' : '1px solid rgba(255,255,255,0.06)', color: txCategory === cat ? '#6C8EF5' : '#8899BB', onSelect: () => this.setState({ txCategory: cat }) }));

    const bankOptions = [...bankList.map(b => ({ value: b, label: `${bankIcon(b)} ${b}` })), { value: CUSTOM_BANK, label: '＋ 自訂銀行 / 帳戶' }];

    const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const ap = t => pill(t, analysisTab);
    const sp = t => seg(t, recordsTab);
    const ip = t => seg(t, insuranceTab);
    const profileTitle = { main:'我的', assets:'資產彙整', ai:'AI 智慧分析', settings:'帳戶設定' }[profileTab] || '我的';

    return {
      clockText: s.clockText,
      tab, isHome: tab==='home', isRecords: tab==='records', isAnalysis: tab==='analysis', isInsurance: tab==='insurance', isProfile: tab==='profile',
      isTransactions: recordsTab==='transactions', isBudgetPage: recordsTab==='budget',
      isTrend: analysisTab==='trend', isCategory: analysisTab==='category', isAssets: analysisTab==='assets', isCashflow: analysisTab==='cashflow', isPremium: analysisTab==='premium',
      isPolicies: insuranceTab==='policies', isCoverage: insuranceTab==='coverage', isClaims: insuranceTab==='claims',
      isProfileMain: profileTab==='main', isProfileAssets: profileTab==='assets', isProfileAI: profileTab==='ai', isProfileSettings: profileTab==='settings',
      isProfileSub: profileTab !== 'main', profileTitle,
      // Computed display
      netWorthText: `NT$ ${fmt(netWorth)}`,
      netWorthSub: transactions.length === 0 ? `尚無記錄 · 開始記帳以追蹤資產`
        : unlinkedFlow !== 0 ? `資產 + 未連動帳戶現金流` : `資產彙整已與帳簿連動`,
      allIncomeText: `NT$${fmt(allIncome)}`, allExpenseText: `NT$${fmt(allExpense)}`,
      monthIncomeText: `NT$${fmt(monthIncome)}`, monthExpenseText: `NT$${fmt(monthExpense)}`,
      monthBalanceText: `NT$${fmt(Math.abs(monthBalance))}`,
      balanceColor: monthBalance >= 0 ? '#34D399' : '#F87171',
      totalAssetsText: `NT$ ${fmt(totalAssets)}`,
      assetLastUpdated, assetHistoryDisplay,
      hasAssetHistory: assetHistoryDisplay.length > 0,
      noAssetHistory: assetHistoryDisplay.length === 0,
      clearAssetHistory: () => this.setState({ assetHistory: [] }),
      hasBudget: budgetTotal > 0, noBudget: budgetTotal === 0,
      budgetSpentText: `NT$${fmt(budgetSpent)}`, budgetTotalText: budgetTotal > 0 ? `NT$${fmt(budgetTotal)}` : '未設定',
      budgetPctText: `${Math.round(budgetPct)}%`, budgetPctWidth: `${budgetPct}%`,
      budgetRemainText: budgetTotal > 0 ? `NT$${fmt(Math.max(0, budgetTotal - budgetSpent))}` : '—',
      currentMonthLabel: `${currentMonth.year}年 ${monthNames[currentMonth.month - 1]}`,
      hasTxs: currentMonthTxItems.length > 0, noTxs: currentMonthTxItems.length === 0,
      hasRecentTxs: recentTxs.length > 0, noRecentTxs: recentTxs.length === 0,
      currentMonthTxItems, recentTxs, budgetItems, assetItems, policyItems, coverageItems,
      hasPolicies: policyItems.length > 0, noPolicies: policyItems.length === 0,
      policyCount: policies.length, gapCount, annualPremiumText: `NT$${fmt(annualPremium)}`,
      // Tab colors
      homeTabColor: tc('home'), recordsTabColor: tc('records'), analysisTabColor: tc('analysis'), insuranceTabColor: tc('insurance'), profileTabColor: tc('profile'),
      // Sub-tabs
      recTransBg: sp('transactions').bg, recTransColor: sp('transactions').color, recBudgetBg: sp('budget').bg, recBudgetColor: sp('budget').color,
      trendBg: ap('trend').bg, trendColor: ap('trend').color, trendBorder: ap('trend').border,
      catBg: ap('category').bg, catColor: ap('category').color, catBorder: ap('category').border,
      assetsBg: ap('assets').bg, assetsColor: ap('assets').color, assetsBorder: ap('assets').border,
      cashBg: ap('cashflow').bg, cashColor: ap('cashflow').color, cashBorder: ap('cashflow').border,
      premBg: ap('premium').bg, premColor: ap('premium').color, premBorder: ap('premium').border,
      polBg: ip('policies').bg, polColor: ip('policies').color, covBg: ip('coverage').bg, covColor: ip('coverage').color, claimsBg: ip('claims').bg, claimsColor: ip('claims').color,
      // Profile
      profileAvatar: profile.name ? profile.name.charAt(0) : '👤',
      profileGreeting: profile.name ? `你好，${profile.name}！` : '您好！',
      profileName: profile.name, profileEmail: profile.email, profileMonthlyIncome: profile.monthlyIncome,
      // TX form
      showTxSheet, txAmount, txNote, txDate, txType, categoryItems,
      txBank, txBankCustom, bankOptions, isCustomBank: txBank === CUSTOM_BANK,
      txBankAssetHint, editAssetBankChips,
      txExpenseBg: txType === 'expense' ? '#F87171' : 'transparent',
      txExpenseColor: txType === 'expense' ? '#fff' : '#526080',
      txIncomeBg: txType === 'income' ? '#34D399' : 'transparent',
      txIncomeColor: txType === 'income' ? '#fff' : '#526080',
      txSubmitLabel: txType === 'expense' ? '記錄支出' : '記錄收入',
      txSubmitBg: txType === 'expense' ? '#F87171' : '#34D399',
      // Budget form
      showBudgetSheet, budgetCategory, budgetAmount,
      // Policy form
      showPolicySheet, policyName, policyType, policyCompany, policyPremium, policyFreq, policyExpiry,
      // Asset form
      showAssetSheet, editAssetType, editAssetAmount,
      // AI
      showAIPanel, aiMessages, aiTyping,
      showToast: !!s.toast, toastMsg: s.toast,
      darkMode: s.darkMode, colorScheme: s.darkMode ? 'dark' : 'light',
      darkToggleBg: s.darkMode ? 'linear-gradient(135deg,#6C8EF5,#A78BFA)' : 'rgba(150,165,185,0.3)',
      darkToggleDot: s.darkMode ? 'right:2px' : 'left:2px',
      toggleDarkMode: () => this.setState(prev => ({ darkMode: !prev.darkMode })),
      showScanSheet: s.showScanSheet, scanStep: s.scanStep,
      isScanReady: s.scanStep === 'ready', isScanScanning: s.scanStep === 'scanning', isScanResult: s.scanStep === 'result',
      scanImage: s.scanImage, scanAmount: s.scanAmount, scanShop: s.scanShop, scanDate: s.scanDate,
      scanCategory: s.scanCategory, scanBank: s.scanBank, scanInvNo: s.scanInvNo, hasScanInvNo: !!s.scanInvNo,
      scanItems: s.scanItems, hasScanItems: s.scanItems.length > 0,
      scanText: s.scanText, hasScanText: !!String(s.scanText).trim(), showScanText: s.showScanText,
      scanTextToggleLabel: s.showScanText ? '收合辨識文字 ▲' : '查看辨識到的文字 ▼',
      hasScanError: !!s.scanError, scanError: s.scanError,
      scanStatusText: s.scanStatus || '辨識中…', scanProgressWidth: `${s.scanProgress}%`,
      scanSourceLabel: s.scanSource === 'qr' ? '📇 已讀取電子發票 QR Code' : s.scanSource === 'ocr' ? '🔍 文字辨識結果，請核對' : '✍️ 手動輸入',
      scanHeadline: parseFloat(s.scanAmount) > 0 ? `NT$ ${fmt(parseFloat(s.scanAmount))}` : '未讀到金額',
      scanCatOptions: expCats.map(c => ({ value: c, label: `${catEmoji[c]} ${c}` })),
      scanBankOptions: bankList.map(b => ({ value: b, label: `${bankIcon(b)} ${b}` })),
      showVoiceSheet: s.showVoiceSheet, voiceStep: s.voiceStep, voiceData: s.voiceData,
      isVoiceReady: s.voiceStep === 'ready', isVoiceRecording: s.voiceStep === 'recording',
      isVoiceAnalyzing: s.voiceStep === 'analyzing', isVoiceResult: s.voiceStep === 'result',
      voiceTimer: `${Math.floor(s.voiceSeconds/60)}:${String(s.voiceSeconds%60).padStart(2,'0')}`,
      voiceText: s.voiceData ? s.voiceData.text : '',
      voiceAmount: s.voiceData ? `NT$ ${s.voiceData.amount.toLocaleString()}` : '',
      voiceCategory: s.voiceData ? s.voiceData.category : '',
      voiceNote: s.voiceData ? s.voiceData.note : '',
      fabOpen, showFab: tab === 'home' || tab === 'records',
      fabRotate: fabOpen ? 'rotate(45deg)' : 'rotate(0deg)',
      // Handlers
      goHome: () => this.setState({ tab:'home', fabOpen:false }),
      goRecords: () => this.setState({ tab:'records', fabOpen:false }),
      goAnalysis: () => this.setState({ tab:'analysis', analysisTab:'trend', fabOpen:false }),
      goInsurance: () => this.setState({ tab:'insurance', insuranceTab:'policies', fabOpen:false }),
      goProfile: () => this.setState({ tab:'profile', profileTab:'main', fabOpen:false }),
      goBudget: () => this.setState({ tab:'records', recordsTab:'budget', fabOpen:false }),
      prevMonth: () => this.setState(prev => { let m=prev.currentMonth.month-1, y=prev.currentMonth.year; if(m<1){m=12;y--;} return {currentMonth:{year:y,month:m}}; }),
      nextMonth: () => this.setState(prev => { let m=prev.currentMonth.month+1, y=prev.currentMonth.year; if(m>12){m=1;y++;} return {currentMonth:{year:y,month:m}}; }),
      setRecordsTab_transactions: () => this.setState({ recordsTab:'transactions' }),
      setRecordsTab_budget: () => this.setState({ recordsTab:'budget' }),
      setAnalysisTab_trend: () => this.setState({ analysisTab:'trend' }),
      setAnalysisTab_category: () => this.setState({ analysisTab:'category' }),
      setAnalysisTab_assets: () => this.setState({ analysisTab:'assets' }),
      setAnalysisTab_cashflow: () => this.setState({ analysisTab:'cashflow' }),
      setAnalysisTab_premium: () => this.setState({ analysisTab:'premium' }),
      setInsuranceTab_policies: () => this.setState({ insuranceTab:'policies' }),
      setInsuranceTab_coverage: () => this.setState({ insuranceTab:'coverage' }),
      setInsuranceTab_claims: () => this.setState({ insuranceTab:'claims' }),
      backToProfile: () => this.setState({ profileTab:'main' }),
      goAssets: () => this.setState({ profileTab:'assets' }),
      goAI: () => this.setState({ profileTab:'ai' }),
      goSettings: () => this.setState({ profileTab:'settings' }),
      toggleFab: () => this.setState(prev => ({ fabOpen: !prev.fabOpen })),
      openScanSheet: () => { this.scanRun = (this.scanRun || 0) + 1; this.setState(p => Object.assign({ showScanSheet:true, fabOpen:false }, this.resetScan(p))); },
      closeScanSheet: () => { this.scanRun = (this.scanRun || 0) + 1; this.setState(p => Object.assign({ showScanSheet:false }, this.resetScan(p))); },
      rescanReceipt: () => { this.scanRun = (this.scanRun || 0) + 1; this.setState(p => this.resetScan(p)); },
      onScanFile: e => this.onScanFile(e),
      onScanAmount: e => this.setState({ scanAmount: e.target.value }),
      onScanShop: e => this.setState({ scanShop: e.target.value }),
      onScanCategory: e => this.setState({ scanCategory: e.target.value }),
      onScanDate: e => this.setState({ scanDate: e.target.value }),
      onScanBank: e => this.setState({ scanBank: e.target.value }),
      toggleScanText: () => this.setState(p => ({ showScanText: !p.showScanText })),
      confirmScan: () => this.confirmScan(),
      openVoiceSheet: () => { this.stopRecognition(); clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice); this.setState({ showVoiceSheet:true, voiceStep:'ready', voiceData:null, voiceSeconds:0, fabOpen:false }); },
      closeVoiceSheet: () => { this.stopRecognition(); clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice); this.setState({ showVoiceSheet:false, voiceStep:'ready', voiceData:null, voiceSeconds:0 }); },
      startVoice: () => this.startVoice(),
      stopVoice: () => this.stopVoice(),
      confirmVoice: () => this.confirmVoice(),
      openExpenseTx: () => this.setState(p => ({ showTxSheet:true, txType:'expense', txCategory:'餐飲', txAmount:'', txNote:'', fabOpen:false, ...this.resetBank(p) })),
      openIncomeTx: () => this.setState(p => ({ showTxSheet:true, txType:'income', txCategory:'薪資', txAmount:'', txNote:'', fabOpen:false, ...this.resetBank(p) })),
      setTxExpense: () => this.setState({ txType:'expense', txCategory:'餐飲' }),
      setTxIncome: () => this.setState({ txType:'income', txCategory:'薪資' }),
      onTxAmount: e => this.setState({ txAmount: e.target.value }),
      onTxNote: e => this.setState({ txNote: e.target.value }),
      onTxDate: e => this.setState({ txDate: e.target.value }),
      onTxBank: e => this.setState({ txBank: e.target.value, txBankCustom: '' }),
      onTxBankCustom: e => this.setState({ txBankCustom: e.target.value }),
      closeTxSheet: () => this.setState({ showTxSheet:false }),
      submitTx: () => this.submitTx(),
      onBudgetAmount: e => this.setState({ budgetAmount: e.target.value }),
      closeBudgetSheet: () => this.setState({ showBudgetSheet:false }),
      submitBudget: () => this.submitBudget(),
      openPolicySheet: () => this.setState({ showPolicySheet:true }),
      onPolicyName: e => this.setState({ policyName: e.target.value }),
      onPolicyType: e => this.setState({ policyType: e.target.value }),
      onPolicyCompany: e => this.setState({ policyCompany: e.target.value }),
      onPolicyPremium: e => this.setState({ policyPremium: e.target.value }),
      onPolicyFreq: e => this.setState({ policyFreq: e.target.value }),
      onPolicyExpiry: e => this.setState({ policyExpiry: e.target.value }),
      closePolicySheet: () => this.setState({ showPolicySheet:false }),
      submitPolicy: () => this.submitPolicy(),
      closeAssetSheet: () => this.setState({ showAssetSheet:false, editAssetBanks: [] }),
      onAssetAmount: e => this.setState({ editAssetAmount: e.target.value }),
      submitAsset: () => this.submitAsset(),
      showAddAssetCat: s.showAddAssetCat,
      newAssetName: s.newAssetName, newAssetEmoji: s.newAssetEmoji, newAssetAmount: s.newAssetAmount,
      openAddAssetCat: () => this.setState({ showAddAssetCat: true, newAssetName: '', newAssetEmoji: '💼', newAssetAmount: '' }),
      closeAddAssetCat: () => this.setState({ showAddAssetCat: false }),
      onNewAssetName: e => this.setState({ newAssetName: e.target.value }),
      onNewAssetEmoji: e => this.setState({ newAssetEmoji: e.target.value }),
      onNewAssetAmount: e => this.setState({ newAssetAmount: e.target.value }),
      submitAddAssetCat: () => this.submitAddAssetCat(),
      emojiOptions: ['💵','🪙','📊','💎','🚗','🏗️','🌾','✈️','📱','🖥️','🎯','🚀'].map(em => ({ emoji: em, bg: s.newAssetEmoji === em ? 'rgba(108,142,245,0.18)' : 'rgba(255,255,255,0.04)', border: s.newAssetEmoji === em ? '1px solid rgba(108,142,245,0.35)' : '1px solid rgba(255,255,255,0.06)', onPick: () => this.setState({ newAssetEmoji: em }) })),
      onProfileName: e => this.setState(prev => ({ profile: { ...prev.profile, name: e.target.value } })),
      onProfileEmail: e => this.setState(prev => ({ profile: { ...prev.profile, email: e.target.value } })),
      onProfileIncome: e => this.setState(prev => ({ profile: { ...prev.profile, monthlyIncome: e.target.value } })),
      triggerAI: () => this.triggerAI(),
      closeAI: () => { this.aiRun++; clearTimeout(this.timers.ai); this.setState({ showAIPanel:false, aiMessages:[], aiTyping:false }); },
    };
  }
}


window.Component = Component;
