/* 台灣家庭單據分類。點選分類後顯示 help。 */
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

  function helpOf(name) {
    for (let i = 0; i < ITEMS.length; i++) {
      if (ITEMS[i].name === name) return ITEMS[i].help;
    }
    return "";
  }

  return {
    CATEGORIES: ITEMS.map(function (item) { return item.name; }),
    helpOf: helpOf
  };
});
