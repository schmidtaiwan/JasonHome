(function () {
  const CAT = window.JHClassify.CATEGORIES;
  const FILTERS = ["全部", "待確認"].concat(CAT);
  const $ = function (id) { return document.getElementById(id); };
  // 版次顯示：版次{流水號} (日期)。每次改網頁把 PAGE_BUILD +1，並把 index.html 的 ?v= 改成同一個數字。
  const PAGE_BUILD = 7;
  const PAGE_DATE = "2026-11-05";

  const state = {
    items: [],
    filter: "全部",
    q: "",
    thumbs: new Map(),
    queue: [],
    index: 0,
    ocrGen: 0,
    detailId: "",
    fullUrl: "",
    fileUrl: "",
    busy: false
  };

  let toastTimer = 0;

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 3200);
  }

  function todayIso() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function formatMoney(n) {
    if (n == null || n === "" || !Number.isFinite(Number(n))) return "";
    return "NT$ " + Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
  }

  function parseAmount(s) {
    if (s == null || String(s).trim() === "") return null;
    const m = String(s).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1048576) return Math.round(v / 1024) + " KB";
    return (v / 1048576).toFixed(1) + " MB";
  }

  function shortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "未填日期";
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y === new Date().getFullYear()) return mo + "月" + d + "日";
    return y + "/" + mo + "/" + d;
  }

  function monthKey(item) {
    const s = item.date || String(item.createdAt || "").slice(0, 10);
    return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : "未標月份";
  }

  function monthLabel(key) {
    if (key === "未標月份") return key;
    const parts = key.split("-");
    return parts[0] + "年" + Number(parts[1]) + "月";
  }

  function stamp(item) {
    return item.date || String(item.createdAt || "").slice(0, 10) || "";
  }

  function hay(item) {
    return [
      item.category, item.vendor, item.note, item.invoiceNo, item.taxId,
      item.name, item.date, item.text, item.amount
    ].join(" ").toLowerCase().replace(/,/g, "");
  }

  function matchQuery(item) {
    const q = state.q.toLowerCase().replace(/,/g, "").trim();
    if (!q) return true;
    return hay(item).includes(q);
  }

  function inFilter(item, cat) {
    if (!matchQuery(item) && cat !== "全部" && cat !== "待確認" && item.category !== cat) {
      /* 搜尋與分類一起生效；計數也用同一套 */
    }
    if (!matchQuery(item)) return false;
    if (cat === "全部") return true;
    if (cat === "待確認") return !!item.needsReview;
    return item.category === cat;
  }

  function visibleItems() {
    return state.items
      .filter(function (item) { return inFilter(item, state.filter); })
      .sort(function (a, b) {
        return stamp(b).localeCompare(stamp(a)) || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      });
  }

  function setOverlay(on) {
    document.body.classList.toggle("overlay", on);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const old = document.querySelector('script[src="' + src + '"]');
      if (old) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("載入元件失敗")); };
      document.head.appendChild(s);
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", quality);
    });
  }

  function drawFit(source, maxEdge) {
    const sw = source.width || source.videoWidth;
    const sh = source.height || source.videoHeight;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function placeholderThumb(label) {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 640;
    const g = canvas.getContext("2d");
    g.fillStyle = "#f4efe4";
    g.fillRect(0, 0, 480, 640);
    g.fillStyle = "#c2410c";
    g.fillRect(0, 0, 480, 18);
    g.fillStyle = "#221b14";
    g.font = "700 48px sans-serif";
    g.fillText(label || "單據", 36, 140);
    g.fillStyle = "#4e463c";
    g.font = "400 28px sans-serif";
    g.fillText("開啟原檔可看完整內容", 36, 200);
    return canvasBlob(canvas, 0.8);
  }

  async function prepareImage(file) {
    const bmp = await createImageBitmap(file);
    try {
      const storeCanvas = drawFit(bmp, 2400);
      const thumbCanvas = drawFit(bmp, 720);
      const store = await canvasBlob(storeCanvas, 0.86);
      const thumb = await canvasBlob(thumbCanvas, 0.72);
      if (!store || !thumb) throw new Error("無法處理照片");
      return {
        store: store,
        storeMime: "image/jpeg",
        ext: ".jpg",
        thumb: thumb,
        isPdf: false
      };
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  async function preparePdf(file) {
    await loadScript("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js");
    if (!window.pdfjsLib) throw new Error("無法讀取 PDF");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data: data }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1400 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
    const snap = await canvasBlob(canvas, 0.82);
    const thumbCanvas = drawFit(canvas, 720);
    const thumb = await canvasBlob(thumbCanvas, 0.72);
    return {
      store: file,
      storeMime: "application/pdf",
      ext: ".pdf",
      thumb: thumb,
      isPdf: true
    };
  }

  async function prepare(file) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (isPdf) {
      try { return await preparePdf(file); }
      catch (e) {
        return {
          store: file,
          storeMime: "application/pdf",
          ext: ".pdf",
          thumb: await placeholderThumb("PDF"),
          isPdf: true
        };
      }
    }
    try { return await prepareImage(file); }
    catch (e) {
      return {
        store: file,
        storeMime: file.type || "image/jpeg",
        ext: (/\.[a-z0-9]+$/i.exec(file.name || "") || [".jpg"])[0].toLowerCase(),
        thumb: await placeholderThumb("照片"),
        isPdf: false
      };
    }
  }

  function newId() {
    return "jh_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function blankDraft(prepared) {
    return {
      localId: newId(),
      id: newId(),
      name: "單據" + prepared.ext,
      mime: prepared.storeMime,
      category: "",
      catTouched: false,
      date: todayIso(),
      dateTouched: false,
      vendor: "",
      vendorTouched: false,
      amount: null,
      amountTouched: false,
      note: "",
      noteTouched: false,
      invoiceNo: "",
      taxId: "",
      text: "",
      needsReview: false,
      bytes: prepared.store.size || 0,
      createdAt: new Date().toISOString(),
      store: prepared.store,
      thumb: prepared.thumb,
      isPdf: prepared.isPdf,
      previewUrl: URL.createObjectURL(prepared.isPdf ? prepared.thumb : prepared.store),
      status: "請點一個分類"
    };
  }

  function currentDraft() {
    return state.queue[state.index] || null;
  }

  function readFormInto(draft) {
    if (!draft) return;
    draft.date = $("f-date").value || "";
    draft.vendor = $("f-vendor").value.trim();
    draft.amount = parseAmount($("f-amount").value);
    draft.note = $("f-note").value.trim();
  }

  function fillForm(draft) {
    $("preview").src = draft.previewUrl;
    $("preview-badge").hidden = !draft.isPdf;
    $("sheet-status").textContent = draft.status || "";
    $("f-date").value = draft.date || "";
    $("f-vendor").value = draft.vendor || "";
    $("f-amount").value = draft.amount == null ? "" : String(draft.amount);
    $("f-note").value = draft.note || "";
    $("sheet-title").textContent = state.queue.length > 1
      ? ("第 " + (state.index + 1) + " / " + state.queue.length + " 張")
      : "上傳";
    $("sheet-next").hidden = state.queue.length < 2;
    $("save-all").hidden = state.queue.length < 2;
    document.querySelectorAll("#pick-cat button").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.cat === draft.category ? "true" : "false");
    });
    showHelp($("pick-help"), draft.category);
  }

  async function openQueue(fileList) {
    const files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    closeSheet(true);
    toast(files.length > 1 ? "正在準備 " + files.length + " 個檔案…" : "正在準備照片…");
    const queue = [];
    for (let i = 0; i < files.length; i++) {
      const prepared = await prepare(files[i]);
      const draft = blankDraft(prepared);
      draft.name = "單據" + prepared.ext;
      queue.push(draft);
    }
    state.queue = queue;
    state.index = 0;
    $("sheet").hidden = false;
    setOverlay(true);
    fillForm(queue[0]);
  }

  function closeSheet(force) {
    if (!force && state.queue.length && !confirm("這次選的檔案還沒存進雲端，要放棄嗎？")) return;
    state.queue.forEach(function (draft) {
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    });
    state.queue = [];
    state.index = 0;
    $("sheet").hidden = true;
    if ($("detail").hidden) setOverlay(false);
  }

  function showDraft(step) {
    const draft = currentDraft();
    if (draft) readFormInto(draft);
    const next = state.index + step;
    if (next < 0 || next >= state.queue.length) return;
    state.index = next;
    fillForm(currentDraft());
  }

  function draftToItem(draft) {
    readFormInto(draft);
    if (!draft.category) throw new Error("請先點一個分類");
    if (!draft.date) draft.date = todayIso();
    const snippet = String(draft.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      id: draft.id,
      name: "單據" + (draft.isPdf ? ".pdf" : ".jpg"),
      mime: draft.mime,
      category: draft.category,
      date: draft.date,
      vendor: draft.vendor,
      amount: draft.amount,
      note: draft.note,
      invoiceNo: draft.invoiceNo,
      taxId: draft.taxId,
      text: snippet,
      needsReview: !!draft.needsReview,
      bytes: draft.store.size || draft.bytes || 0,
      createdAt: draft.createdAt
    };
  }

  async function saveDraft(draft) {
    const item = draftToItem(draft);
    const result = await window.JHDrive.uploadNew(item, draft.store, draft.thumb);
    state.items = result.items;
    draft.saved = true;
    return result.item;
  }

  async function onSaveOne() {
    const draft = currentDraft();
    if (!draft || state.busy) return;
    readFormInto(draft);
    if (!draft.category) {
      toast("請先點一個分類");
      return;
    }
    state.busy = true;
    $("save-one").textContent = "上傳中…";
    try {
      const item = await saveDraft(draft);
      toast("已存到雲端：" + item.category + (item.vendor ? " · " + item.vendor : ""));
      if (navigator.vibrate) navigator.vibrate(12);
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      state.queue.splice(state.index, 1);
      if (!state.queue.length) {
        closeSheet(true);
      } else {
        if (state.index >= state.queue.length) state.index = state.queue.length - 1;
        fillForm(currentDraft());
      }
      render();
    } catch (err) {
      console.error(err);
      toast(err.message || "上傳失敗");
    } finally {
      state.busy = false;
      $("save-one").textContent = "存入雲端";
    }
  }

  async function onSaveAll() {
    if (state.busy || state.queue.length < 2) return;
    const shown = currentDraft();
    if (shown) readFormInto(shown);
    if (state.queue.some(function (d) { return !d.category; })) {
      toast("每一張都要先點分類");
      return;
    }
    state.busy = true;
    try {
      const pending = state.queue.slice();
      for (let i = 0; i < pending.length; i++) {
        $("save-all").textContent = "上傳 " + (i + 1) + "/" + pending.length + "…";
        await saveDraft(pending[i]);
        if (pending[i].previewUrl) URL.revokeObjectURL(pending[i].previewUrl);
      }
      toast("已存入 " + pending.length + " 張");
      closeSheet(true);
      render();
    } catch (err) {
      console.error(err);
      toast(err.message || "上傳失敗");
      state.queue = state.queue.filter(function (d) { return !d.saved; });
      state.index = 0;
      if (state.queue.length) fillForm(currentDraft());
      render();
    } finally {
      state.busy = false;
      $("save-all").textContent = "全部存入";
    }
  }

  function renderFilters() {
    const host = $("filters");
    if (!host.childElementCount) {
      FILTERS.forEach(function (cat) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.dataset.cat = cat;
        host.appendChild(btn);
      });
      host.addEventListener("click", function (ev) {
        const btn = ev.target.closest("button");
        if (!btn) return;
        state.filter = btn.dataset.cat;
        render();
      });
    }
    host.querySelectorAll(".chip").forEach(function (btn) {
      const cat = btn.dataset.cat;
      const n = state.items.filter(function (item) { return inFilter(item, cat); }).length;
      btn.textContent = cat + " " + n;
      btn.setAttribute("aria-pressed", state.filter === cat ? "true" : "false");
    });
  }

  function renderList() {
    const host = $("list");
    const items = visibleItems();
    host.replaceChildren();
    $("empty").hidden = state.items.length !== 0;
    if (!items.length) {
      if (state.items.length) {
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "沒有符合的單據。換個關鍵字，或切回「全部」。";
        host.appendChild(p);
      }
      return;
    }
    let lastMonth = "";
    items.forEach(function (item) {
      const key = monthKey(item);
      if (key !== lastMonth) {
        lastMonth = key;
        const group = items.filter(function (x) { return monthKey(x) === key; });
        const sum = group.reduce(function (acc, x) {
          return x.amount == null ? acc : acc + Number(x.amount);
        }, 0);
        const head = document.createElement("div");
        head.className = "month";
        const label = document.createElement("span");
        label.textContent = monthLabel(key) + " · " + group.length + " 筆";
        const total = document.createElement("b");
        total.textContent = sum ? formatMoney(sum) : "";
        head.append(label, total);
        host.appendChild(head);
      }
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.dataset.id = item.id;
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = "";
      img.dataset.thumb = item.thumbId || "";
      img.src = state.thumbs.get(item.thumbId) || "";
      if (!img.src) {
        img.removeAttribute("src");
        img.classList.add("thumb-fallback");
      }
      const body = document.createElement("span");
      const top = document.createElement("span");
      top.className = "card-top";
      const date = document.createElement("span");
      date.textContent = shortDate(item.date || String(item.createdAt || "").slice(0, 10));
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.dataset.cat = item.category || "其他";
      pill.textContent = item.category || "其他";
      top.append(date, pill);
      const vendor = document.createElement("span");
      vendor.className = "vendor";
      vendor.textContent = item.vendor || "未填店家";
      const amt = document.createElement("span");
      amt.className = "amt" + (item.amount == null ? " missing" : "");
      amt.textContent = item.amount == null ? "未填金額" : formatMoney(item.amount);
      body.append(top, vendor, amt);
      const sub = document.createElement("span");
      sub.className = "card-sub";
      const bits = [];
      if (item.invoiceNo) bits.push(item.invoiceNo);
      if (item.note) bits.push(item.note);
      if (bits.length) {
        sub.textContent = bits.join(" · ");
        body.appendChild(sub);
      }
      if (item.needsReview) {
        const review = document.createElement("span");
        review.className = "review";
        review.textContent = "待確認";
        body.appendChild(review);
      }
      card.append(img, body);
      host.appendChild(card);
    });
    observeThumbs();
  }

  function render() {
    renderFilters();
    renderList();
  }

  let thumbObserver = null;
  function observeThumbs() {
    if (!thumbObserver && "IntersectionObserver" in window) {
      thumbObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) loadThumb(entry.target);
        });
      }, { rootMargin: "200px" });
    }
    document.querySelectorAll(".thumb[data-thumb]").forEach(function (img) {
      if (!img.dataset.thumb) return;
      if (state.thumbs.has(img.dataset.thumb)) {
        img.src = state.thumbs.get(img.dataset.thumb);
        return;
      }
      if (thumbObserver) thumbObserver.observe(img);
      else loadThumb(img);
    });
  }

  async function loadThumb(img) {
    const id = img.dataset.thumb;
    if (!id || state.thumbs.has(id)) return;
    state.thumbs.set(id, "");
    try {
      const blob = await window.JHDrive.download(id);
      const url = URL.createObjectURL(blob);
      if (state.thumbs.size > 48) {
        const first = state.thumbs.keys().next().value;
        const old = state.thumbs.get(first);
        if (old) URL.revokeObjectURL(old);
        state.thumbs.delete(first);
      }
      state.thumbs.set(id, url);
      img.src = url;
    } catch (e) {
      state.thumbs.delete(id);
    }
  }

  function showHelp(el, name) {
    if (!el) return;
    const text = window.JHClassify.helpOf(name);
    el.hidden = !text;
    el.textContent = text;
  }

  function paintCats(host, selected, onPick) {
    host.replaceChildren();
    CAT.forEach(function (cat) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.cat = cat;
      btn.textContent = cat;
      btn.setAttribute("aria-pressed", cat === selected ? "true" : "false");
      btn.addEventListener("click", function () { onPick(cat); });
      host.appendChild(btn);
    });
  }

  function bindPickCats() {
    paintCats($("pick-cat"), "", function (cat) {
      const draft = currentDraft();
      if (!draft) return;
      draft.catTouched = true;
      draft.category = cat;
      draft.needsReview = false;
      draft.status = "";
      fillForm(draft);
    });
  }

  async function openDetail(id) {
    const item = state.items.find(function (x) { return x.id === id; });
    if (!item) return;
    state.detailId = id;
    if (state.fullUrl) URL.revokeObjectURL(state.fullUrl);
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fullUrl = "";
    state.fileUrl = "";
    $("shot").src = state.thumbs.get(item.thumbId) || "";
    $("shot").alt = item.vendor || item.category || "單據";
    $("d-date").value = item.date || "";
    $("d-vendor").value = item.vendor || "";
    $("d-amount").value = item.amount == null ? "" : String(item.amount);
    $("d-note").value = item.note || "";
    $("detail-meta").textContent = [item.mime === "application/pdf" ? "PDF" : "照片", formatBytes(item.bytes), item.invoiceNo, item.taxId ? "統編 " + item.taxId : ""]
      .filter(Boolean).join(" · ");
    $("open-drive").href = "https://drive.google.com/file/d/" + item.fileId + "/view";
    $("open-file").href = $("open-drive").href;
    $("detail").dataset.cat = item.category || "其他";
    paintCats($("detail-cat"), item.category, function () {});
    showHelp($("detail-help"), item.category);
    $("detail-cat").querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.cat === item.category ? "true" : "false");
    });
    $("detail").hidden = false;
    setOverlay(true);
    $("detail").scrollTop = 0;
    if (item.thumbId && !state.thumbs.get(item.thumbId)) {
      try {
        const blob = await window.JHDrive.download(item.thumbId);
        const url = URL.createObjectURL(blob);
        state.thumbs.set(item.thumbId, url);
        if (state.detailId === id) $("shot").src = url;
      } catch (e) { /* 下面再試原檔 */ }
    } else if (state.thumbs.get(item.thumbId)) {
      $("shot").src = state.thumbs.get(item.thumbId);
    }
    if ((item.mime || "").indexOf("image/") === 0) {
      try {
        const blob = await window.JHDrive.download(item.fileId);
        const url = URL.createObjectURL(blob);
        state.fullUrl = url;
        if (state.detailId === id) $("shot").src = url;
      } catch (e) {
        toast("原圖暫時打不開，先顯示快照");
      }
    }
  }

  function closeDetail() {
    $("detail").hidden = true;
    state.detailId = "";
    if ($("sheet").hidden) setOverlay(false);
    if (state.fullUrl) URL.revokeObjectURL(state.fullUrl);
    state.fullUrl = "";
  }

  async function onDetailSave() {
    const item = state.items.find(function (x) { return x.id === state.detailId; });
    if (!item || state.busy) return;
    const next = Object.assign({}, item, {
      category: $("detail").dataset.cat || item.category,
      date: $("d-date").value || "",
      vendor: $("d-vendor").value.trim(),
      amount: parseAmount($("d-amount").value),
      note: $("d-note").value.trim(),
      needsReview: false
    });
    state.busy = true;
    $("detail-save").textContent = "儲存中…";
    try {
      const result = await window.JHDrive.updateMeta(next);
      state.items = result.items;
      toast("已更新");
      render();
      closeDetail();
    } catch (err) {
      console.error(err);
      toast(err.message || "更新失敗");
    } finally {
      state.busy = false;
      $("detail-save").textContent = "儲存修改";
    }
  }

  async function onDetailDelete() {
    const item = state.items.find(function (x) { return x.id === state.detailId; });
    if (!item) return;
    if (!confirm("從雲端硬碟刪除這張單據？檔案會進垃圾桶。")) return;
    state.busy = true;
    try {
      state.items = await window.JHDrive.removeItem(item);
      toast("已刪除");
      closeDetail();
      render();
    } catch (err) {
      console.error(err);
      toast(err.message || "刪除失敗");
    } finally {
      state.busy = false;
    }
  }

  function showMismatch(email) {
    const want = window.JHDrive.preferredEmail();
    $("mismatch-text").textContent = "現在登入的是 " + email + "。請改用 " + window.JHDrive.allowedEmails().join(" 或 ") + "。檔案只放在 " + want + " 的雲端硬碟。";
    $("mismatch").hidden = false;
    $("main").hidden = true;
    $("filters").hidden = true;
    document.querySelector(".dock").hidden = true;
    $("who").textContent = email;
  }

  function showMain(email) {
    $("mismatch").hidden = true;
    $("main").hidden = false;
    $("filters").hidden = false;
    document.querySelector(".dock").hidden = false;
    $("who").textContent = email + " · " + window.JHDrive.preferredEmail() + " 的雲端硬碟 / " + window.JHDrive.folderName();
  }

  async function enterApp(acc) {
    const email = String(acc.email || "").toLowerCase();
    try { localStorage.setItem("jh_email", email); } catch (e) { /* 忽略 */ }
    $("gate").hidden = true;
    $("app").hidden = false;
    if (!window.JHDrive.isAllowed(email)) {
      showMismatch(acc.email);
      return;
    }
    showMain(acc.email);
    $("empty").textContent = "正在讀取雲端清單…";
    $("empty").hidden = false;
    try {
      const cat = await window.JHDrive.readCatalog();
      state.items = cat.items || [];
      $("empty").textContent = "還沒有單據。用下方「拍照」或「相簿」，點分類後就存進雲端硬碟。";
      render();
    } catch (err) {
      console.error(err);
      toast(err.message || "讀取雲端失敗");
      $("empty").textContent = "讀取清單失敗。請按右上角「更新」，或從雲端重建。";
      $("empty").hidden = false;
    }
  }

  async function onLogin(opts) {
    $("login").disabled = true;
    $("gate-msg").textContent = "正在開啟 Google 登入…";
    try {
      const acc = await window.JHDrive.login(opts || { prompt: "select_account" });
      $("gate-msg").textContent = "";
      await enterApp(acc);
    } catch (err) {
      console.error(err);
      $("gate-msg").textContent = window.JHDrive.explainAuthError(err);
    } finally {
      $("login").disabled = false;
    }
  }

  function onLogout() {
    window.JHDrive.logout();
    try { localStorage.removeItem("jh_email"); } catch (e) { /* 忽略 */ }
    state.items = [];
    closeDetail();
    closeSheet(true);
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gate-msg").textContent = "";
  }

  async function reload() {
    if ($("mismatch").hidden === false) return;
    try {
      const cat = await window.JHDrive.readCatalog();
      state.items = cat.items || [];
      render();
      toast("已更新");
    } catch (err) {
      toast(err.message || "更新失敗");
    }
  }

  async function onRebuild() {
    if (!confirm("用雲端硬碟裡的檔案重做清單。較長的備註可能只留前段，照片不會刪除。")) return;
    toast("正在重建…");
    try {
      state.items = await window.JHDrive.rebuild();
      render();
      toast("清單已重建，共 " + state.items.length + " 筆");
    } catch (err) {
      console.error(err);
      toast(err.message || "重建失敗");
    }
  }

  function showVersion() {
    const text = "版次 " + PAGE_BUILD + " (" + PAGE_DATE + ")";
    $("pageVer").textContent = text;
    $("gate-ver").textContent = text;
  }

  function bind() {
    showVersion();
    $("prefer").textContent = window.JHDrive.allowedEmails().join(" 或 ");
    $("login").addEventListener("click", function () { onLogin({ prompt: "select_account" }); });
    $("logout").addEventListener("click", onLogout);
    $("switch").addEventListener("click", function () { onLogin({ prompt: "select_account" }); });
    $("reload").addEventListener("click", reload);
    $("rebuild").addEventListener("click", onRebuild);
    $("shoot").addEventListener("click", function () { $("cam").click(); });
    $("album-btn").addEventListener("click", function () { $("album").click(); });
    $("pdf-btn").addEventListener("click", function () { $("pdf").click(); });
    $("cam").addEventListener("change", function () {
      openQueue($("cam").files);
      $("cam").value = "";
    });
    $("album").addEventListener("change", function () {
      openQueue($("album").files);
      $("album").value = "";
    });
    $("pdf").addEventListener("change", function () {
      openQueue($("pdf").files);
      $("pdf").value = "";
    });
    $("q").addEventListener("input", function () {
      state.q = $("q").value || "";
      render();
    });
    $("list").addEventListener("click", function (ev) {
      const card = ev.target.closest(".card");
      if (!card) return;
      openDetail(card.dataset.id);
    });
    $("sheet-close").addEventListener("click", function () { closeSheet(false); });
    $("sheet-next").addEventListener("click", function () {
      if (state.index >= state.queue.length - 1) showDraft(-state.index);
      else showDraft(1);
    });
    $("save-one").addEventListener("click", onSaveOne);
    $("save-all").addEventListener("click", onSaveAll);
    $("f-today").addEventListener("click", function () {
      const draft = currentDraft();
      if (!draft) return;
      draft.dateTouched = true;
      draft.date = todayIso();
      $("f-date").value = draft.date;
    });
    ["f-date", "f-vendor", "f-amount", "f-note"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        const draft = currentDraft();
        if (!draft) return;
        if (id === "f-date") draft.dateTouched = true;
        if (id === "f-vendor") draft.vendorTouched = true;
        if (id === "f-amount") draft.amountTouched = true;
        if (id === "f-note") draft.noteTouched = true;
        readFormInto(draft);
      });
    });
    $("detail-cat").addEventListener("click", function (ev) {
      const btn = ev.target.closest("button");
      if (!btn || !$("detail-cat").contains(btn)) return;
      $("detail").dataset.cat = btn.dataset.cat;
      showHelp($("detail-help"), btn.dataset.cat);
      $("detail-cat").querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.cat === btn.dataset.cat ? "true" : "false");
      });
    });
    $("detail-close").addEventListener("click", closeDetail);
    $("detail-save").addEventListener("click", onDetailSave);
    $("detail-del").addEventListener("click", onDetailDelete);
    $("d-today").addEventListener("click", function () { $("d-date").value = todayIso(); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!$("detail").hidden) closeDetail();
      else if (!$("sheet").hidden) closeSheet(false);
    });
    bindPickCats();
  }

  async function boot() {
    bind();
    try { await window.JHDrive.init(); }
    catch (err) {
      $("gate-msg").textContent = err.message || "Google 登入還沒準備好";
    }
    let hint = "";
    try { hint = localStorage.getItem("jh_email") || ""; } catch (e) { hint = ""; }
    if (hint && window.JHDrive.isAllowed(hint)) {
      $("gate-msg").textContent = "正在連上上次的 Google 帳號…";
      try {
        const acc = await window.JHDrive.login({ prompt: "", hint: hint });
        $("gate-msg").textContent = "";
        await enterApp(acc);
      } catch (e) {
        $("gate-msg").textContent = "";
      }
    }
  }

  async function openSample() {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 1100;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 800, 1100);
    g.fillStyle = "#221b14";
    g.font = "700 42px sans-serif";
    g.fillText("台灣電力公司", 60, 140);
    g.font = "400 32px sans-serif";
    g.fillText("電費帳單", 60, 220);
    g.fillText("115年10月5日", 60, 300);
    g.fillText("應繳總金額 1,280", 60, 380);
    const blob = await canvasBlob(canvas, 0.9);
    const file = new File([blob], "sample.jpg", { type: "image/jpeg" });
    await openQueue([file]);
  }

  document.addEventListener("DOMContentLoaded", boot);

  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    window.JHDebug = { openSample: openSample, state: state };
  }
})();
