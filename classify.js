/* 先看短關鍵字再分類：發票、信用卡、稅、銀行、收據。純函式，可在瀏覽器與 Node 測試。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JHClassify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CATEGORIES = ["帳單", "稅單", "發票", "收據", "其他"];
  const RULES = [
    ["稅單", 6, /房屋稅|地價稅|牌照稅|使用牌照|所得稅|綜所稅|土地增值稅|國稅局|地方稅|燃料稅|稅額通知|核定稅額/],
    ["稅單", 3, /稅單|繳款書|營業稅|貨物稅/],
    ["帳單", 6, /電費|水費|瓦斯費|瓦斯費通知|台灣電力|台電|自來水|中華電信|台灣大哥大|遠傳電信|信用卡帳單|健保費|國民年金/],
    ["帳單", 3, /帳單|繳費通知|繳費單|管理費|停車費|保險費|保費|電信費|學雜費/],
    ["發票", 6, /統一發票|電子發票|發票證明聯|收銀機統一發票/],
    ["發票", 2, /發票號碼|應稅|銷售額|隨機碼/],
    ["收據", 5, /收據|收訖|領據/],
    ["收據", 3, /診所|醫院|藥局|診療|掛號費|捐款|學費收據/]
  ];
  const ORDER = ["稅單", "帳單", "發票", "收據"];
  const SKIP_LINE = /證明聯|統一發票|電子發票|收執聯|收銀機|銷售額|隨機碼|統一編號|買受人|賣方|地址|電話|日期|總計|合計|金額|應稅|免稅|條碼/;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function toIso(y, m, d) {
    let year = Number(y);
    const month = Number(m);
    const day = Number(d || 1);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "";
    if (year < 1911) year += 1911;
    if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
    return year + "-" + pad(month) + "-" + pad(day);
  }

  function extractDate(text) {
    const src = String(text || "");
    const patterns = [
      /(\d{4})\s*[.\/-年]\s*(\d{1,2})\s*[.\/-月]\s*(\d{1,2})/,
      /(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
      /(\d{2,3})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})/,
      /(\d{2,3})\s*年\s*(\d{1,2})\s*月/
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = patterns[i].exec(src);
      if (!m) continue;
      const iso = toIso(m[1], m[2], m[3] || 1);
      if (iso) return iso;
    }
    return "";
  }

  function numberOf(raw) {
    const n = Number(String(raw || "").replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
    return Math.round(n * 100) / 100;
  }

  function extractAmount(text) {
    const src = String(text || "");
    const labeled = /(?:應繳總金額|應繳金額|總計|合計|總額|實付|實收|金額)\s*[:：]?\s*(?:NT\$|＄|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.\d{1,2})?/g;
    let match;
    let best = null;
    let bestRank = -1;
    while ((match = labeled.exec(src))) {
      const n = numberOf(match[1]);
      if (n == null) continue;
      const label = match[0];
      const rank = /總計|合計|總額|應繳/.test(label) ? 2 : 1;
      if (rank > bestRank) {
        bestRank = rank;
        best = n;
      }
    }
    if (best != null) return best;
    const money = /(?:NT\$|＄|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.\d{1,2})?/;
    const m = money.exec(src);
    return m ? numberOf(m[1]) : null;
  }

  function extractInvoiceNo(text) {
    const m = String(text || "").toUpperCase().match(/[A-Z]{2}\s*-?\s*(\d{8})/);
    if (!m) return "";
    const head = String(text || "").toUpperCase().match(/[A-Z]{2}(?=\s*-?\s*\d{8})/);
    return (head ? head[0] : "") + m[1];
  }

  function extractTaxId(text) {
    const m = String(text || "").match(/統一編號\s*[:：]?\s*(\d{8})/);
    return m ? m[1] : "";
  }

  function extractVendor(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(function (line) { return line.replace(/\s+/g, "").trim(); })
      .filter(Boolean);
    const org = /公司|商店|商行|藥局|診所|醫院|餐廳|電力|自來水|電信|瓦斯|保險|銀行|超商|百貨|市場|診所/;
    let fallback = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length < 2 || line.length > 30) continue;
      if (!/[\u4e00-\u9fff]/.test(line)) continue;
      if (SKIP_LINE.test(line)) continue;
      if (org.test(line)) return line;
      if (!fallback && line.length <= 14) fallback = line;
    }
    return fallback;
  }

  // 越上面越優先。稅單常印「代收銀行」，所以「稅」要排在「銀行」前面；發票上的營業稅則以「發票」為準。
  const KEYWORDS = [
    ["發票", "發票"],
    ["信用卡", "帳單"],
    ["稅", "稅單"],
    ["銀行", "帳單"],
    ["收據", "收據"]
  ];

  function matchKeyword(text) {
    const src = String(text || "");
    for (let i = 0; i < KEYWORDS.length; i++) {
      if (src.indexOf(KEYWORDS[i][0]) !== -1) {
        return { keyword: KEYWORDS[i][0], category: KEYWORDS[i][1], score: 6 };
      }
    }
    return null;
  }

  function classifyText(text) {
    const hit = matchKeyword(text);
    if (hit) return { category: hit.category, score: hit.score, keyword: hit.keyword };
    const src = String(text || "");
    const scores = { "稅單": 0, "帳單": 0, "發票": 0, "收據": 0 };
    RULES.forEach(function (rule) {
      if (rule[2].test(src)) scores[rule[0]] += rule[1];
    });
    let best = "";
    let bestScore = 0;
    ORDER.forEach(function (cat) {
      if (scores[cat] > bestScore) {
        bestScore = scores[cat];
        best = cat;
      }
    });
    if (bestScore < 3) return { category: "", score: bestScore, keyword: "" };
    return { category: best, score: bestScore, keyword: "" };
  }

  function extractFields(text) {
    const found = classifyText(text);
    return {
      category: found.category,
      score: found.score,
      keyword: found.keyword || "",
      amount: extractAmount(text),
      date: extractDate(text),
      vendor: extractVendor(text),
      invoiceNo: extractInvoiceNo(text),
      taxId: extractTaxId(text)
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    classifyText: classifyText,
    extractFields: extractFields
  };
});
