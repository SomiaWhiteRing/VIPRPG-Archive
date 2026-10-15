import { recoverEntryTable } from "./recover-entry-table";

recoverEntryTable({
  id: "2015-kouhaku",
  originalBase: "http://www.geocities.jp/vipkohaku2015/",
  indexName: "khmain",
  expectedEntries: 92,
  bannerSelector: 'img[src*="kh2015"]',
  liveChecks: ["original-live", "mirror-live"],
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
