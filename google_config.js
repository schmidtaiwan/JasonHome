/* 與架線進度同一個 Google OAuth 網頁用戶端。
 * 「已授權的 JavaScript 來源」需包含：
 *   https://schmidtaiwan.github.io
 * 來源只看網域，不含路徑，因此 /JasonHome/ 與 /line-progress/ 共用這條即可。
 *
 * 單據只放在 preferredEmail 的「我的雲端硬碟 / JasonHome」。
 * editors 裡的帳號可以登入，寫入的仍是那一個資料夾。
 * 不要把收據放進架線進度的共用資料夾。
 */
window.GOOGLE_CONFIG = {
  clientId: "90391506221-41kb4us4hsuq7go94udf3o17hr2f9uoh.apps.googleusercontent.com",
  preferredEmail: "jason660803@gmail.com",
  editors: ["jason660803@gmail.com", "backy2777@gmail.com"],
  folderName: "JasonHome",
  catalogName: "catalog.json"
};
