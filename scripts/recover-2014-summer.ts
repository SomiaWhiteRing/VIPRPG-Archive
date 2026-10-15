import { recoverEntryTable } from "./recover-entry-table";

recoverEntryTable({
  id: "2014-summer",
  originalBase: "http://www.geocities.jp/viprpg2014summer/",
  indexName: "index",
  expectedEntries: 73,
  bannerSelector: 'img[src*="summer2014"]',
  liveChecks: ["original-live", "mirror-live"],
  encoding: "euc-jp",
  categoryColumn: 3,
}).catch((error) => { console.error(error); process.exitCode = 1; });
