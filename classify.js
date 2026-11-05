/* 台灣家庭單據分類。點選分類後顯示 help。自己加的分類由設定頁寫入。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JHClassify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ITEMS = [
    { name: "稅單", help: "房屋稅、地價稅、汽機車牌照稅、綜合所得稅、土地增值稅。" },
    { name: "水電瓦斯與通訊", help: "台電電費、自來水水費、瓦斯費、市話、手機門號、寬頻、第四台。" },
    { name: "金融帳單", help: "信用卡帳單、銀行對帳單、房貸、車貸、信貸繳款。" },
    { name: "保險", help: "壽險、醫療險、車險、住宅火險、強制險。" },
    { name: "住家固定費用", help: "房租、管理費、停車費、大樓清潔費。" },
    { name: "發票", help: "統一發票、電子發票、收銀機發票。超市、餐飲、購物多半是這一張。" },
    { name: "收據", help: "診所與醫院、藥局、學費才藝、捐款，以及沒開發票的一般收據。" },
    { name: "其他", help: "罰單、戶政規費、保證金、一時歸不進去的單子。" }
  ];
  let custom = [];

  function clip(s, max) {
    const text = String(s || "").trim();
    return Array.from(text).slice(0, max).join("");
  }

  function isBuiltin(name) {
    return ITEMS.some(function (item) { return item.name === name; });
  }

  function setCustom(list) {
    const seen = {};
    custom = [];
    (list || []).forEach(function (item) {
      const name = clip(item && item.name, 12);
      const help = clip(item && item.help, 80);
      if (!name || isBuiltin(name) || seen[name]) return;
      seen[name] = true;
      custom.push({ name: name, help: help });
    });
    return custom.map(function (item) { return { name: item.name, help: item.help }; });
  }

  function names() {
    return ITEMS.map(function (item) { return item.name; }).concat(custom.map(function (item) { return item.name; }));
  }

  function helpOf(name) {
    const all = ITEMS.concat(custom);
    for (let i = 0; i < all.length; i++) {
      if (all[i].name === name) return all[i].help;
    }
    return "";
  }

  return {
    CATEGORIES: ITEMS.map(function (item) { return item.name; }),
    builtins: function () { return ITEMS.map(function (item) { return { name: item.name, help: item.help }; }); },
    custom: function () { return custom.map(function (item) { return { name: item.name, help: item.help }; }); },
    names: names,
    helpOf: helpOf,
    isBuiltin: isBuiltin,
    setCustom: setCustom
  };
});
