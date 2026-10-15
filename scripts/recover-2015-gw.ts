import { recoverEntryTable } from "./recover-entry-table";

recoverEntryTable({
  id: "2015-gw",
  originalBase: "http://www.geocities.jp/viprpg2015gw/",
  indexName: "archive-index",
  expectedEntries: 72,
  bannerSelector: 'img[src*="gw2015b"]',
  liveChecks: ["original-live", "mirror-live", "linked-migration-live"],
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
