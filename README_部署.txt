家用單據 — 部署
================
原理與架線進度相同：
  網頁是 GitHub Pages 靜態檔。
  登入用 Google 帳號。
  帳單、稅單、發票、收據的照片與 PDF 只放在 Google 雲端硬碟，不進 Git。

線上網址
  https://schmidtaiwan.github.io/JasonHome/

雲端位置（僅這個帳號）
  jason660803@gmail.com
  我的雲端硬碟 / JasonHome
    catalog.json          清單（搜尋用）
    帳單|稅單|發票|收據|其他 / 年份 / 檔案
    thumbs/               清單快照

Google 登入
  與架線進度共用同一個 OAuth 用戶端（google_config.js 的 clientId）。
  Google Cloud → 用戶端 → 已授權的 JavaScript 來源，需有：
    https://schmidtaiwan.github.io
  來源不含路徑。若架線進度已經加過這條，這裡不用再加。

手機
  用 Chrome 或 Safari 打開上面的網址。
  可加入主畫面，之後像 App 一樣開。
  不要用檔案總管直接點 index.html，Google 登入不允許 file://。

版次
  頁首顯示「版次 N (日期)」。數字在 app.js 的 PAGE_BUILD。
  改完功能會把 PAGE_BUILD 加 1，index.html 的 ?v= 改成同一個數字，並推上 main。

更新網頁
  推上 schmidtaiwan/JasonHome 的 main。
  Pages 來源是 main 根目錄。
  手機請 Ctrl+F5 或清除快取後再開。
