# 從 FinanceApp.dc.html 抽出元件邏輯 → pwa/app.js
# 只做幾處明確的修改：真實時鐘、真實語音辨識、theme-color 同步、啟動程式碼。
import io, re, sys

src = io.open('FinanceApp.dc.html', encoding='utf-8').read()
start = src.index('<script type="text/x-dc" data-dc-script>')
start = src.index('\n', start) + 1
end = src.index('</script>', start)
logic = src[start:end].rstrip() + '\n'

applied = []
def sub(old, new, why):
    global logic
    if old not in logic:
        sys.exit('找不到要替換的片段：' + why)
    logic = logic.replace(old, new, 1)
    applied.append(why)

# ── 1. 狀態：加入時鐘文字 ────────────────────────────────────
sub("    darkMode: false,\n",
    "    darkMode: false,\n"
    "    // 首次繪製就要有時間，否則狀態列會空一個影格\n"
    "    clockText: ((d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`)(new Date()),\n",
    'state.clockText')

# ── 2. applyTheme 同步 theme-color 與 color-scheme ──────────
sub("    Object.entries(theme).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));\n  }",
    "    Object.entries(theme).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));\n"
    "    // PWA：狀態列顏色與原生表單控制項配色要跟著主題走\n"
    "    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';\n"
    "    const meta = document.querySelector('meta[name=\"theme-color\"]');\n"
    "    if (meta) meta.setAttribute('content', dark ? '#080C18' : '#F0F5FE');\n"
    "  }",
    'applyTheme → theme-color')

# ── 3. 啟動時鐘 ────────────────────────────────────────────
sub("    this.applyTheme(dark);\n    this.prevState = this.state;",
    "    this.applyTheme(dark);\n    this.startClock();\n    this.prevState = this.state;",
    'componentDidMount → startClock')

sub("  componentWillUnmount() {\n    this.aiRun++;",
    "  // 頂端狀態列顯示真實時間（原設計稿寫死 9:41）\n"
    "  startClock() {\n"
    "    const tick = () => {\n"
    "      const d = new Date();\n"
    "      const txt = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;\n"
    "      if (txt !== this.state.clockText) this.setState({ clockText: txt });\n"
    "    };\n"
    "    clearInterval(this.timers.clock);\n"
    "    tick();\n"
    "    this.timers.clock = setInterval(tick, 15000);\n"
    "  }\n\n"
    "  componentWillUnmount() {\n    this.stopRecognition();\n    this.aiRun++;",
    'startClock 方法 + unmount 停止辨識')

# ── 4. 語音記帳：以 Web Speech API 取代假資料 ────────────────
voice_start = logic.index('  startVoice() {')
voice_end = logic.index('  showToast(msg) {')
new_voice = r'''  // ═══ 語音記帳（Web Speech API） ═══
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

'''
logic = logic[:voice_start] + new_voice + logic[voice_end:]
applied.append('startVoice/stopVoice/confirmVoice → Web Speech API')

# ── 5. 開關語音面板時要停掉辨識 ──────────────────────────────
sub("openVoiceSheet: () => { clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice);",
    "openVoiceSheet: () => { this.stopRecognition(); clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice);",
    'openVoiceSheet 停止辨識')
sub("closeVoiceSheet: () => { clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice);",
    "closeVoiceSheet: () => { this.stopRecognition(); clearInterval(this.timers.voiceTick); clearTimeout(this.timers.voice);",
    'closeVoiceSheet 停止辨識')

# ── 6. renderVals 補上 clockText ────────────────────────────
sub("    return {\n      tab, isHome:",
    "    return {\n      clockText: s.clockText,\n      tab, isHome:",
    'renderVals.clockText')

header = '''/* ──────────────────────────────────────────────────────────────
   app.js — 財務管家 PWA 的應用邏輯
   由 build_app_js.py 從 FinanceApp.dc.html 產生（勿直接手改，改來源檔後重跑）。
   與設計稿版本的差異：
     · 頂端狀態列顯示真實時間，不再寫死 9:41
     · 語音記帳改用 Web Speech API，不再產生模擬資料
     · 切換深色模式時同步更新 <meta name="theme-color">
   掛載程式在 boot.js，不在這裡。
   ────────────────────────────────────────────────────────────── */
'''

# 掛載程式改放 pwa/boot.js：sync.js 必須先包裝 Component 才能掛載。
# 明確掛到 window，不倚賴 class 宣告在腳本之間的全域繫結行為。
boot = '\n\nwindow.Component = Component;\n'


io.open('pwa/app.js', 'w', encoding='utf-8', newline='\n').write(header + logic + boot)
print('已套用：')
for a in applied:
    print('  ·', a)
print('pwa/app.js 產生完成')
