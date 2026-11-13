/* Google 登入與雲端硬碟。網頁只拿短期 token，單據本體不進 Git。
 * 用 drive 範圍，第二個帳號才看得到分享過來的 JasonHome 資料夾。
 */
(function (global) {
  const cfg = global.GOOGLE_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email";
  const enc = new TextEncoder();

  let tokenClient = null;
  let token = "";
  let exp = 0;
  let inflight = null;
  let account = null;
  let catalogId = "";
  let extraCategories = [];
  let folderLock = Promise.resolve();
  let catalogLock = Promise.resolve();
  const folderCache = new Map();

  function preferredEmail() {
    return String(cfg.preferredEmail || "").trim().toLowerCase();
  }

  function accountEmail() {
    return String((account && account.email) || "").trim().toLowerCase();
  }

  function allowedEmails() {
    const list = [];
    function add(raw) {
      const email = String(raw || "").trim().toLowerCase();
      if (email && list.indexOf(email) < 0) list.push(email);
    }
    add(cfg.preferredEmail);
    (cfg.editors || []).forEach(add);
    return list;
  }

  function isAllowed(email) {
    return allowedEmails().indexOf(String(email || "").trim().toLowerCase()) >= 0;
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

  async function grantWriter(folderId, email, notify) {
    const res = await driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(folderId) +
      "/permissions?supportsAllDrives=true&sendNotificationEmail=" + (notify ? "true" : "false"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "writer", type: "user", emailAddress: email })
      }
    );
    if (res.ok || res.status === 409) return "";
    const text = await res.text();
    if (/already exists|duplicate/i.test(text)) return "";
    return text.slice(0, 180);
  }

  async function shareVault(folderId) {
    const others = allowedEmails().filter(function (email) { return email !== accountEmail(); });
    for (let i = 0; i < others.length; i++) {
      try {
        let problem = await grantWriter(folderId, others[i], false);
        if (problem) problem = await grantWriter(folderId, others[i], true);
        if (problem) console.error("分享資料夾失敗", others[i], problem);
      } catch (err) {
        console.error("分享資料夾失敗", err);
      }
    }
  }

  async function vaultRoot() {
    if (folderCache.has("vault")) return folderCache.get("vault");
    const name = folderName();
    const owner = preferredEmail();
    const q = "mimeType='application/vnd.google-apps.folder' and name='" + qEscape(name) + "' and trashed=false";
    const found = await listAll(q, "id,name,createdTime,ownedByMe,owners(emailAddress)");
    const owned = found.filter(function (file) {
      const emails = (file.owners || []).map(function (item) {
        return String(item.emailAddress || "").trim().toLowerCase();
      });
      return emails.indexOf(owner) >= 0 || (file.ownedByMe && accountEmail() === owner);
    });
    owned.sort(function (a, b) {
      return String(a.createdTime || "").localeCompare(String(b.createdTime || ""));
    });
    let id = owned[0] && owned[0].id;
    if (!id) {
      if (accountEmail() !== owner) {
        throw new Error("還沒找到 " + owner + " 的「" + name + "」資料夾。請先用那個帳號登入一次，網頁會把資料夾分享出來。");
      }
      const res = await driveFetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          mimeType: "application/vnd.google-apps.folder",
          parents: ["root"]
        })
      });
      if (!res.ok) await readErr(res, "建立資料夾失敗");
      const created = await res.json();
      id = created.id;
    }
    if (accountEmail() === owner) await shareVault(id);
    folderCache.set("vault", id);
    folderCache.set("root/" + name, id);
    return id;
  }

  async function ensureFolderNow(parts) {
    let parent = "root";
    let start = 0;
    if (parts[0] === folderName()) {
      parent = await vaultRoot();
      start = 1;
    }
    for (let i = start; i < parts.length; i++) {
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
    extraCategories = [];
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
    extraCategories = [];
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

  function buildName(item, pageIndex) {
    const vendor = safeBit(item.vendor || item.note || "單據") || "單據";
    const date = item.date || "未標日期";
    const tail = String(item.id || "file").slice(-6);
    const pages = Number(item.pageCount) || (item.pages && item.pages.length) || 1;
    const pageBit = pages > 1 && pageIndex != null
      ? "_p" + String(pageIndex + 1).padStart(2, "0")
      : "";
    const pageItem = (item.pages && item.pages[pageIndex]) || item;
    return date + "_" + (item.category || "其他") + "_" + vendor + "_" + tail + pageBit + extOf(pageItem);
  }

  function propsOf(item, role, pageIndex, thumbId) {
    const pages = Number(item.pageCount) || (item.pages && item.pages.length) || 1;
    return {
      jhRole: role,
      jhId: prop(item.id, 60),
      jhCat: prop(item.category, 48),
      jhDate: prop(item.date, 20),
      jhVendor: prop(item.vendor, 72),
      jhAmount: item.amount == null || item.amount === "" ? "-" : prop(String(item.amount), 24),
      jhNote: prop(item.note, 80),
      jhInv: prop(item.invoiceNo, 20),
      jhTax: prop(item.taxId, 16),
      jhReview: item.needsReview ? "1" : "0",
      jhThumb: prop(thumbId != null ? thumbId : item.thumbId, 80),
      jhBy: prop(item.by, 80),
      jhPage: String(pageIndex == null ? 0 : pageIndex),
      jhPages: String(pages > 1 ? pages : 1)
    };
  }

  function pageListOf(item) {
    if (item && Array.isArray(item.pages) && item.pages.length) return item.pages;
    if (!item) return [];
    return [{
      fileId: item.fileId || "",
      thumbId: item.thumbId || "",
      mime: item.mime || "",
      bytes: item.bytes || 0,
      name: item.name || ""
    }];
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
    if (!catalogId) return { fileId: "", items: [], categories: [] };
    const blob = await download(catalogId);
    let data;
    try {
      data = JSON.parse(await blob.text());
    } catch (e) {
      throw new Error("雲端清單壞掉了，請按「從雲端重建」");
    }
    extraCategories = normalizeCategories(data.categories);
    return {
      fileId: catalogId,
      items: Array.isArray(data.items) ? data.items : [],
      categories: extraCategories.map(function (item) { return { name: item.name, help: item.help }; })
    };
  }

  function normalizeCategories(list) {
    const out = [];
    const seen = {};
    (list || []).forEach(function (item) {
      const name = Array.from(String(item && item.name || "").trim()).slice(0, 12).join("");
      const help = Array.from(String(item && item.help || "").trim()).slice(0, 80).join("");
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push({ name: name, help: help });
    });
    return out;
  }

  async function saveCategories(list) {
    const clean = normalizeCategories(list);
    return withCatalog(async function () {
      const cat = await readCatalog();
      extraCategories = clean;
      await writeCatalog(cat.fileId, cat.items || []);
      return extraCategories.map(function (item) { return { name: item.name, help: item.help }; });
    });
  }

  async function writeCatalog(fileId, items) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: items,
      categories: extraCategories
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
    return uploadSet(item, [{ store: storeBlob, thumb: thumbBlob, mime: item && item.mime }]);
  }

  async function uploadSet(item, pageBlobs) {
    const pagesIn = (pageBlobs || []).filter(function (p) { return p && p.store; });
    if (!pagesIn.length) throw new Error("沒有可上傳的檔案");
    const by = accountEmail();
    if (!by) throw new Error("無法確認是誰上傳，請重新登入");
    const draft = Object.assign({}, item);
    draft.by = by;
    draft.pageCount = pagesIn.length;
    const year = yearOf(draft);
    const folderId = await ensureFolder([folderName(), draft.category || "其他", year]);
    const thumbFolder = await ensureFolder([folderName(), "thumbs"]);
    const pages = [];
    for (let i = 0; i < pagesIn.length; i++) {
      const blob = pagesIn[i];
      const mime = blob.mime || draft.mime || blob.store.type || "application/octet-stream";
      const pageDraft = Object.assign({}, draft, {
        mime: mime,
        name: buildName(Object.assign({}, draft, { mime: mime, pageCount: pagesIn.length }), i)
      });
      let thumb = { id: "" };
      if (blob.thumb) {
        thumb = await uploadMultipart({
          name: draft.id + (pagesIn.length > 1 ? "_p" + String(i + 1).padStart(2, "0") : "") + ".jpg",
          mimeType: "image/jpeg",
          parents: [thumbFolder],
          appProperties: propsOf(draft, "thumb", i, "")
        }, blob.thumb, "image/jpeg");
      }
      const file = await uploadMultipart({
        name: pageDraft.name,
        mimeType: mime,
        parents: [folderId],
        appProperties: propsOf(draft, "file", i, thumb.id || "")
      }, blob.store, mime);
      pages.push({
        fileId: file.id,
        thumbId: thumb.id || "",
        mime: file.mimeType || mime,
        bytes: Number(file.size) || Number(blob.store.size) || 0,
        name: file.name || pageDraft.name
      });
    }
    const first = pages[0];
    draft.fileId = first.fileId;
    draft.thumbId = first.thumbId;
    draft.mime = first.mime;
    draft.bytes = first.bytes;
    draft.name = first.name;
    draft.folderId = folderId;
    draft.pages = pages;
    draft.pageCount = pages.length;
    delete draft.storeBlob;
    delete draft.thumbBlob;
    delete draft.ocrBlob;
    delete draft.previewUrl;
    const stored = draft;
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
    const pages = pageListOf(draft);
    draft.pageCount = pages.length;
    draft.pages = pages;
    const folderId = await ensureFolder([folderName(), draft.category || "其他", yearOf(draft)]);
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page.fileId) continue;
      const pageName = buildName(Object.assign({}, draft, {
        mime: page.mime,
        name: page.name,
        pageCount: pages.length
      }), i);
      const oldParents = (i === 0 && draft.folderId)
        ? [draft.folderId]
        : await fileParents(page.fileId);
      let url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(page.fileId) +
        "?supportsAllDrives=true&fields=id,name,parents,mimeType,size";
      const remove = oldParents.filter(function (id) { return id && id !== folderId; });
      if (remove.length) {
        url += "&addParents=" + encodeURIComponent(folderId) + "&removeParents=" + encodeURIComponent(remove.join(","));
      }
      const res = await driveFetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pageName,
          appProperties: propsOf(draft, "file", i, page.thumbId || "")
        })
      });
      if (!res.ok) await readErr(res, "更新單據失敗");
      const file = await res.json();
      page.name = file.name || pageName;
      page.mime = file.mimeType || page.mime;
      page.bytes = Number(file.size || page.bytes || 0);
      if (page.thumbId) {
        await driveFetch(
          "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(page.thumbId) + "?supportsAllDrives=true",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appProperties: propsOf(draft, "thumb", i, page.thumbId) })
          }
        ).catch(function () { /* 縮圖屬性更新失敗可忽略 */ });
      }
    }
    const first = pages[0] || {};
    draft.folderId = folderId;
    draft.fileId = first.fileId || draft.fileId;
    draft.thumbId = first.thumbId || draft.thumbId;
    draft.mime = first.mime || draft.mime;
    draft.bytes = first.bytes || draft.bytes;
    draft.name = first.name || draft.name;
    draft.pages = pages;
    draft.pageCount = pages.length;
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
    return removeItems([item]);
  }

  async function removeItems(list) {
    const drop = {};
    const batch = [];
    (list || []).forEach(function (item) {
      if (!item || !item.id || drop[item.id]) return;
      drop[item.id] = true;
      batch.push(item);
    });
    const ids = [];
    batch.forEach(function (item) {
      pageListOf(item).forEach(function (page) {
        if (page.fileId) ids.push(page.fileId);
        if (page.thumbId) ids.push(page.thumbId);
      });
    });
    const items = await withCatalog(async function () {
      const cat = await readCatalog();
      const next = cat.items.filter(function (x) { return !drop[x.id]; });
      await writeCatalog(cat.fileId, next);
      return next;
    });
    try {
      await trashMany(ids);
    } catch (err) {
      err.catalogUpdated = true;
      throw err;
    }
    return items;
  }

  async function trashMany(ids) {
    const unique = [];
    const seen = {};
    (ids || []).forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      unique.push(id);
    });
    for (let i = 0; i < unique.length; i += 80) {
      const slice = unique.slice(i, i + 80);
      try {
        await trashBatch(slice);
      } catch (err) {
        console.error(err);
        await Promise.all(slice.map(trash));
      }
    }
  }

  async function trashBatch(ids) {
    const boundary = "jhbatch_" + Date.now().toString(16) + Math.random().toString(16).slice(2);
    let body = "";
    ids.forEach(function (id, index) {
      body += "--" + boundary + "\r\n";
      body += "Content-Type: application/http\r\n";
      body += "Content-ID: <item" + index + ">\r\n\r\n";
      body += "PATCH /drive/v3/files/" + encodeURIComponent(id) + "?supportsAllDrives=true HTTP/1.1\r\n";
      body += "Content-Type: application/json\r\n\r\n";
      body += "{\"trashed\":true}\r\n";
    });
    body += "--" + boundary + "--";
    const res = await driveFetch("https://www.googleapis.com/batch/drive/v3", {
      method: "POST",
      headers: { "Content-Type": "multipart/mixed; boundary=" + boundary },
      body: body
    });
    if (!res.ok) await readErr(res, "刪除失敗");
    const text = await res.text();
    const type = res.headers.get("Content-Type") || "";
    const found = /boundary=("[^"]+"|[^;\s]+)/i.exec(type);
    const edge = found ? found[1].replace(/"/g, "") : boundary;
    const parts = text.split("--" + edge);
    let saw = 0;
    for (let i = 0; i < parts.length; i++) {
      const http = parts[i].match(/HTTP\/1\.[01] (\d{3})/);
      if (!http) continue;
      saw += 1;
      const status = Number(http[1]);
      if (status === 404 || (status >= 200 && status < 300)) continue;
      throw new Error("刪除失敗（" + status + "）");
    }
    if (saw < ids.length) throw new Error("刪除失敗");
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
    const pageIndex = Number(cleanProp(p.jhPage) || "0");
    const pageCount = Number(cleanProp(p.jhPages) || "1");
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
      by: cleanProp(p.jhBy),
      folderId: (file.parents && file.parents[0]) || "",
      text: "",
      pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1
    };
  }

  function mergeDrivePages(rows) {
    const groups = {};
    const order = [];
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      if (!groups[row.id]) {
        groups[row.id] = [];
        order.push(row.id);
      }
      groups[row.id].push(row);
    });
    return order.map(function (id) {
      const list = groups[id].slice().sort(function (a, b) {
        return (a.pageIndex || 0) - (b.pageIndex || 0);
      });
      const first = list[0];
      const pages = list.map(function (row) {
        return {
          fileId: row.fileId,
          thumbId: row.thumbId || "",
          mime: row.mime || "",
          bytes: row.bytes || 0,
          name: row.name || ""
        };
      });
      const item = Object.assign({}, first, {
        fileId: pages[0].fileId,
        thumbId: pages[0].thumbId,
        mime: pages[0].mime,
        bytes: pages[0].bytes,
        name: pages[0].name,
        pages: pages,
        pageCount: pages.length
      });
      delete item.pageIndex;
      return item;
    });
  }

  async function rebuild() {
    const q = "appProperties has { key='jhRole' and value='file' } and trashed=false";
    const files = await listAll(q, "id,name,mimeType,size,createdTime,parents,appProperties");
    const rows = [];
    files.forEach(function (file) {
      const item = itemFromDrive(file);
      if (item) rows.push(item);
    });
    const items = mergeDrivePages(rows);
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
    saveCategories: saveCategories,
    uploadNew: uploadNew,
    uploadSet: uploadSet,
    updateMeta: updateMeta,
    removeItem: removeItem,
    removeItems: removeItems,
    download: download,
    rebuild: rebuild,
    explainAuthError: explainAuthError,
    preferredEmail: preferredEmail,
    allowedEmails: allowedEmails,
    isAllowed: isAllowed,
    folderName: folderName,
    categories: function () {
      return extraCategories.map(function (item) { return { name: item.name, help: item.help }; });
    },
    account: function () { return account; }
  };
})(window);
