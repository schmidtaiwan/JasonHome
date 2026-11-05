/* Google 登入與雲端硬碟。網頁只拿短期 token，單據本體不進 Git。
 * 範圍用 drive.file：這個網頁只能看到自己建立的檔案，讀不到整顆硬碟。
 */
(function (global) {
  const cfg = global.GOOGLE_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
  const enc = new TextEncoder();

  let tokenClient = null;
  let token = "";
  let exp = 0;
  let inflight = null;
  let account = null;
  let catalogId = "";
  let folderLock = Promise.resolve();
  let catalogLock = Promise.resolve();
  const folderCache = new Map();

  function preferredEmail() {
    return String(cfg.preferredEmail || "").trim().toLowerCase();
  }

  function folderName() {
    return String(cfg.folderName || "JasonHome").trim() || "JasonHome";
  }

  function catalogName() {
    return String(cfg.catalogName || "catalog.json").trim() || "catalog.json";
  }

  function waitForGis() {
    const start = Date.now();
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (global.google && google.accounts && google.accounts.oauth2) {
          resolve();
          return;
        }
        if (Date.now() - start > 15000) {
          reject(new Error("Google 登入元件載入逾時，請用手機瀏覽器重新整理"));
          return;
        }
        setTimeout(tick, 80);
      })();
    });
  }

  function init() {
    const id = String(cfg.clientId || "").trim();
    if (!id) return Promise.reject(new Error("尚未設定 Google 用戶端 ID"));
    if (tokenClient) return Promise.resolve();
    return waitForGis().then(function () {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: SCOPES,
        callback: function () {}
      });
    });
  }

  function requestToken(prompt, hint) {
    return init().then(function () {
      return new Promise(function (resolve, reject) {
        tokenClient.callback = function (resp) {
          if (!resp || resp.error) {
            reject(new Error((resp && (resp.error_description || resp.error)) || "登入未完成"));
            return;
          }
          token = resp.access_token;
          const sec = Number(resp.expires_in) || 3600;
          exp = Date.now() + Math.max(60, sec - 120) * 1000;
          resolve(token);
        };
        const req = {};
        if (prompt) req.prompt = prompt;
        if (hint) req.hint = hint;
        tokenClient.requestAccessToken(req);
      });
    });
  }

  function getToken(force) {
    if (!force && token && Date.now() < exp) return Promise.resolve(token);
    if (!force && inflight) return inflight;
    const hint = account && account.email ? account.email : "";
    const run = requestToken("", hint).catch(function () {
      return requestToken("select_account", "");
    });
    inflight = run.finally(function () {
      if (inflight === run) inflight = null;
    });
    return inflight;
  }

  function driveFetch(url, options, retried) {
    options = options || {};
    return getToken(!!retried).then(function (tok) {
      const headers = new Headers(options.headers || {});
      headers.set("Authorization", "Bearer " + tok);
      return fetch(url, {
        method: options.method || "GET",
        headers: headers,
        body: options.body
      });
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        token = "";
        exp = 0;
        return driveFetch(url, options, true);
      }
      return res;
    });
  }

  async function readErr(res, label) {
    let text = "";
    try { text = await res.text(); } catch (e) { text = ""; }
    let detail = text.slice(0, 180);
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error.status)) || detail;
    } catch (e) { /* 保留原文 */ }
    throw new Error(label + "（" + res.status + "）" + (detail ? " " + detail : ""));
  }

  function qEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function utf8clip(s, max) {
    const text = String(s || "");
    let out = "";
    let n = 0;
    for (const ch of text) {
      const b = enc.encode(ch).length;
      if (n + b > max) break;
      out += ch;
      n += b;
    }
    return out;
  }

  function prop(s, max) {
    return utf8clip(s, max) || "-";
  }

  function cleanProp(s) {
    const v = String(s || "");
    return !v || v === "-" ? "" : v;
  }

  async function listAll(q, fields) {
    const out = [];
    let page = "";
    do {
      let url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
        "&fields=" + encodeURIComponent("nextPageToken,files(" + fields + ")") +
        "&pageSize=100&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true";
      if (page) url += "&pageToken=" + encodeURIComponent(page);
      const res = await driveFetch(url);
      if (!res.ok) await readErr(res, "讀取雲端清單失敗");
      const data = await res.json();
      (data.files || []).forEach(function (f) { out.push(f); });
      page = data.nextPageToken || "";
    } while (page);
    return out;
  }

  async function ensureFolderNow(parts) {
    let parent = "root";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const key = parent + "/" + name;
      if (folderCache.has(key)) {
        parent = folderCache.get(key);
        continue;
      }
      const q = "mimeType='application/vnd.google-apps.folder' and name='" + qEscape(name) +
        "' and '" + parent + "' in parents and trashed=false";
      const found = await listAll(q, "id,name,createdTime");
      let id = found[0] && found[0].id;
      if (!id) {
        const res = await driveFetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parent]
          })
        });
        if (!res.ok) await readErr(res, "建立資料夾失敗");
        const created = await res.json();
        id = created.id;
      }
      folderCache.set(key, id);
      parent = id;
    }
    return parent;
  }

  function ensureFolder(parts) {
    const run = folderLock.then(function () { return ensureFolderNow(parts); });
    folderLock = run.then(function () {}, function () {});
    return run;
  }

  function withCatalog(fn) {
    const run = catalogLock.then(fn, fn);
    catalogLock = run.then(function () {}, function () {});
    return run;
  }

  async function fetchAccount() {
    let email = "";
    let name = "";
    const info = await driveFetch("https://www.googleapis.com/oauth2/v2/userinfo");
    if (info.ok) {
      const u = await info.json();
      email = u.email || "";
      name = u.name || "";
    }
    if (!email) {
      const about = await driveFetch("https://www.googleapis.com/drive/v3/about?fields=user");
      if (!about.ok) await readErr(about, "無法讀取 Google 帳號");
      const data = await about.json();
      email = (data.user && data.user.emailAddress) || "";
      name = name || (data.user && data.user.displayName) || "";
    }
    if (!email) throw new Error("無法讀取 Google 帳號信箱");
    account = { email: email, name: name };
    return account;
  }

  async function login(opts) {
    opts = opts || {};
    token = "";
    exp = 0;
    account = null;
    catalogId = "";
    folderCache.clear();
    const prompt = opts.prompt != null ? opts.prompt : "select_account";
    await requestToken(prompt, opts.hint || "");
    return fetchAccount();
  }

  function logout() {
    const old = token;
    token = "";
    exp = 0;
    account = null;
    catalogId = "";
    folderCache.clear();
    if (old && global.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(old, function () {}); } catch (e) { /* 忽略 */ }
    }
  }

  function yearOf(item) {
    const src = String((item && (item.date || item.createdAt)) || "");
    const y = src.slice(0, 4);
    return /^\d{4}$/.test(y) ? y : String(new Date().getFullYear());
  }

  function extOf(item) {
    const name = String((item && item.name) || "");
    const m = name.match(/(\.[a-z0-9]{1,8})$/i);
    if (m) return m[1].toLowerCase();
    if (item && item.mime === "application/pdf") return ".pdf";
    return ".jpg";
  }

  function safeBit(s) {
    return String(s || "")
      .replace(/[\\/:*?"<>|\r\n#]/g, "_")
      .replace(/\s+/g, "")
      .slice(0, 24);
  }

  function buildName(item) {
    const vendor = safeBit(item.vendor || item.note || "單據") || "單據";
    const date = item.date || "未標日期";
    const tail = String(item.id || "file").slice(-6);
    return date + "_" + (item.category || "其他") + "_" + vendor + "_" + tail + extOf(item);
  }

  function propsOf(item, role) {
    return {
      jhRole: role,
      jhId: prop(item.id, 60),
      jhCat: prop(item.category, 20),
      jhDate: prop(item.date, 20),
      jhVendor: prop(item.vendor, 72),
      jhAmount: item.amount == null || item.amount === "" ? "-" : prop(String(item.amount), 24),
      jhNote: prop(item.note, 80),
      jhInv: prop(item.invoiceNo, 20),
      jhTax: prop(item.taxId, 16),
      jhReview: item.needsReview ? "1" : "0",
      jhThumb: prop(item.thumbId, 80)
    };
  }

  async function uploadMultipart(meta, blob, mime) {
    const boundary = "jh" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const body = new Blob([
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
      JSON.stringify(meta),
      "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n",
      blob,
      "\r\n--" + boundary + "--"
    ]);
    const res = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,parents",
      {
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body: body
      }
    );
    if (!res.ok) await readErr(res, "上傳失敗");
    return res.json();
  }

  async function readCatalog() {
    const root = await ensureFolder([folderName()]);
    if (!catalogId) {
      const q = "name='" + qEscape(catalogName()) + "' and '" + root + "' in parents and trashed=false";
      const files = await listAll(q, "id,name,modifiedTime");
      files.sort(function (a, b) {
        return String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
      });
      catalogId = files[0] ? files[0].id : "";
    }
    if (!catalogId) return { fileId: "", items: [] };
    const blob = await download(catalogId);
    let data;
    try {
      data = JSON.parse(await blob.text());
    } catch (e) {
      throw new Error("雲端清單壞掉了，請按「從雲端重建」");
    }
    return { fileId: catalogId, items: Array.isArray(data.items) ? data.items : [] };
  }

  async function writeCatalog(fileId, items) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: items
    };
    const body = JSON.stringify(payload, null, 2);
    if (!fileId) {
      const root = await ensureFolder([folderName()]);
      const created = await uploadMultipart({
        name: catalogName(),
        mimeType: "application/json",
        parents: [root]
      }, new Blob([body], { type: "application/json" }), "application/json");
      catalogId = created.id;
      return catalogId;
    }
    const res = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(fileId) + "?uploadType=media&supportsAllDrives=true",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: body
      }
    );
    if (!res.ok) await readErr(res, "儲存清單失敗");
    catalogId = fileId;
    return fileId;
  }

  function publicItem(item, file, thumb) {
    const next = Object.assign({}, item);
    next.fileId = file.id;
    next.thumbId = thumb.id;
    next.folderId = (file.parents && file.parents[0]) || item.folderId || "";
    next.name = file.name || next.name;
    next.mime = file.mimeType || next.mime;
    next.bytes = Number(file.size || next.bytes || 0);
    delete next.storeBlob;
    delete next.thumbBlob;
    delete next.ocrBlob;
    delete next.previewUrl;
    return next;
  }

  async function uploadNew(item, storeBlob, thumbBlob) {
    if (!storeBlob) throw new Error("沒有可上傳的檔案");
    const draft = Object.assign({}, item);
    draft.name = buildName(draft);
    const year = yearOf(draft);
    const folderId = await ensureFolder([folderName(), draft.category || "其他", year]);
    const thumbFolder = await ensureFolder([folderName(), "thumbs"]);
    const file = await uploadMultipart({
      name: draft.name,
      mimeType: draft.mime || storeBlob.type || "application/octet-stream",
      parents: [folderId],
      appProperties: propsOf(draft, "file")
    }, storeBlob, draft.mime || storeBlob.type || "application/octet-stream");
    let thumb = { id: "" };
    if (thumbBlob) {
      const thumbMeta = propsOf(draft, "thumb");
      thumb = await uploadMultipart({
        name: draft.id + ".jpg",
        mimeType: "image/jpeg",
        parents: [thumbFolder],
        appProperties: thumbMeta
      }, thumbBlob, "image/jpeg");
      draft.thumbId = thumb.id;
      await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.id) + "?supportsAllDrives=true", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties: propsOf(draft, "file") })
      });
    }
    const stored = publicItem(draft, file, thumb);
    stored.folderId = folderId;
    const items = await withCatalog(async function () {
      const cat = await readCatalog();
      const next = cat.items.filter(function (x) { return x.id !== stored.id; });
      next.push(stored);
      await writeCatalog(cat.fileId, next);
      return next;
    });
    return { item: stored, items: items };
  }

  async function fileParents(fileId) {
    const res = await driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?fields=parents&supportsAllDrives=true"
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.parents || [];
  }

  async function updateMeta(item) {
    const draft = Object.assign({}, item);
    draft.name = buildName(draft);
    const folderId = await ensureFolder([folderName(), draft.category || "其他", yearOf(draft)]);
    const oldParents = draft.folderId ? [draft.folderId] : await fileParents(draft.fileId);
    let url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(draft.fileId) +
      "?supportsAllDrives=true&fields=id,name,parents,mimeType,size";
    const remove = oldParents.filter(function (id) { return id && id !== folderId; });
    if (remove.length) {
      url += "&addParents=" + encodeURIComponent(folderId) + "&removeParents=" + encodeURIComponent(remove.join(","));
    }
    const res = await driveFetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        appProperties: propsOf(draft, "file")
      })
    });
    if (!res.ok) await readErr(res, "更新單據失敗");
    const file = await res.json();
    draft.folderId = folderId;
    draft.name = file.name || draft.name;
    const items = await withCatalog(async function () {
      const cat = await readCatalog();
      const next = cat.items.map(function (x) { return x.id === draft.id ? draft : x; });
      if (!next.some(function (x) { return x.id === draft.id; })) next.push(draft);
      await writeCatalog(cat.fileId, next);
      return next;
    });
    return { item: draft, items: items };
  }

  async function removeItem(item) {
    await trash(item.fileId);
    await trash(item.thumbId);
    const items = await withCatalog(async function () {
      const cat = await readCatalog();
      const next = cat.items.filter(function (x) { return x.id !== item.id; });
      await writeCatalog(cat.fileId, next);
      return next;
    });
    return items;
  }

  async function trash(id) {
    if (!id) return;
    const res = await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?supportsAllDrives=true", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
    if (!res.ok && res.status !== 404) await readErr(res, "刪除失敗");
  }

  async function download(id) {
    const res = await driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?alt=media&supportsAllDrives=true"
    );
    if (!res.ok) await readErr(res, "下載失敗");
    return res.blob();
  }

  function itemFromDrive(file) {
    const p = file.appProperties || {};
    if (p.jhRole && p.jhRole !== "file") return null;
    if (!p.jhId && !p.jhRole) return null;
    const amount = cleanProp(p.jhAmount);
    const num = amount === "" ? null : Number(amount);
    return {
      id: cleanProp(p.jhId) || file.id,
      fileId: file.id,
      thumbId: cleanProp(p.jhThumb),
      name: file.name || "",
      mime: file.mimeType || "",
      category: cleanProp(p.jhCat) || "其他",
      date: cleanProp(p.jhDate),
      vendor: cleanProp(p.jhVendor),
      amount: Number.isFinite(num) ? num : null,
      note: cleanProp(p.jhNote),
      invoiceNo: cleanProp(p.jhInv),
      taxId: cleanProp(p.jhTax),
      bytes: Number(file.size) || 0,
      createdAt: file.createdTime || "",
      needsReview: p.jhReview === "1",
      folderId: (file.parents && file.parents[0]) || "",
      text: ""
    };
  }

  async function rebuild() {
    const q = "appProperties has { key='jhRole' and value='file' } and trashed=false";
    const files = await listAll(q, "id,name,mimeType,size,createdTime,parents,appProperties");
    const items = [];
    files.forEach(function (file) {
      const item = itemFromDrive(file);
      if (item) items.push(item);
    });
    await withCatalog(async function () {
      const cat = await readCatalog();
      await writeCatalog(cat.fileId, items);
    });
    return items;
  }

  function explainAuthError(err) {
    const msg = String((err && err.message) || err || "");
    if (/origin|redirect_uri|not allowed|idpiframe/i.test(msg)) {
      return "這個網址還沒加入 Google 登入允許清單。請到 Google Cloud 的 OAuth 用戶端，把 https://schmidtaiwan.github.io 加到「已授權的 JavaScript 來源」。";
    }
    if (/popup_closed|access_denied|user_cancel|cancelled/i.test(msg)) return "已取消登入";
    return msg ? "登入失敗：" + msg : "登入失敗";
  }

  global.JHDrive = {
    init: init,
    login: login,
    logout: logout,
    readCatalog: readCatalog,
    uploadNew: uploadNew,
    updateMeta: updateMeta,
    removeItem: removeItem,
    download: download,
    rebuild: rebuild,
    explainAuthError: explainAuthError,
    preferredEmail: preferredEmail,
    folderName: folderName,
    account: function () { return account; }
  };
})(window);
