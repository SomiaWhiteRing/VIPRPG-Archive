import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Festival, WorkEntry } from "../src/lib/types";
import { hasWorkDetail } from "../src/lib/work-detail";
import { getWorkDownloads } from "../src/lib/work-downloads";

// Inventory only: absent fields do not prove that the original site lacked them.
async function main() {
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const listedSources: Array<{ slug: string; url: string }> = JSON.parse((await fs.readFile("catch/festival-urls.json", "utf8")).replace(/^\uFEFF/, ""));
  const assets = new Map<string, Set<string>>();
  const rows = [];
  const addAsset = (url: string | undefined, owner: string) => {
    if (!url?.startsWith("/") || url.startsWith("//")) return;
    const owners = assets.get(url) ?? new Set<string>();
    owners.add(owner);
    assets.set(url, owners);
  };

  for (const festival of festivals) {
    const workBytes = await fs.readFile(path.join("src/data", festival.worksFile));
    const works: WorkEntry[] = JSON.parse(workBytes.toString("utf8"));
    const cached = await fs.readdir(path.join("catch", festival.id), { recursive: true }).catch(() => []);
    let cachedHtmlFiles = 0;
    for (const file of cached) {
      if (/\.html?$/i.test(file)) cachedHtmlFiles++;
      else if (/\.bin$/i.test(file)) {
        const bytes = await fs.readFile(path.join("catch", festival.id, file));
        if (/<(?:!doctype|html)\b/i.test(bytes.subarray(0, 512).toString("ascii"))) cachedHtmlFiles++;
      }
    }
    const summaryPaths = [
      `catch/${festival.id}/${festival.id}-scrape-summary.json`,
      `catch/${festival.id}-scrape-summary.json`,
    ];
    const summaries = [];
    for (const file of summaryPaths) {
      if (await fs.access(file).then(() => true, () => false)) summaries.push(file);
    }
    for (const banner of festival.banners) addAsset(banner, festival.id);
    for (const work of works) {
      addAsset(work.icon, work.id);
      addAsset(work.banner?.src, work.id);
      for (const screenshot of work.ss ?? []) addAsset(screenshot, work.id);
      for (const file of getWorkDownloads(work)) { addAsset(file.url, work.id); addAsset(file.previewUrl, work.id); }
      for (const text of [work.authorComment, work.hostComment]) {
        for (const match of text?.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi) ?? []) {
          addAsset(match[1], work.id);
        }
      }
    }
    rows.push({
      id: festival.id,
      dataSha256: createHash("sha256").update(workBytes).digest("hex"),
      listedSourceUrl: listedSources.find((source) => source.slug === festival.slug)?.url,
      works: works.length,
      banners: festival.banners.length,
      detailPages: works.filter((work) => hasWorkDetail(work, festival)).length,
      disabledDetails: works.filter((work) => !work.contentRestricted && (festival.hasDetail === false || work.detailDisabled)).length,
      restrictedDetails: works.filter((work) => work.contentRestricted).length,
      withAuthor: works.filter((work) => work.author.trim()).length,
      withComments: works.filter((work) => work.authorComment?.trim() || work.hostComment?.trim()).length,
      withScreenshots: works.filter((work) => work.ss?.length).length,
      withDownload: works.filter((work) => getWorkDownloads(work).length > 0).length,
      withSource: works.filter((work) => work.source?.url).length,
      cachedHtmlFiles,
      summaries,
    });
  }

  const assetIssues: Array<{ url: string; owners: string[]; issue: string }> = [];
  for (const [url, owners] of assets) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join("public", url));
    } catch {
      assetIssues.push({ url, owners: [...owners], issue: "missing" });
      continue;
    }
    const head = buffer.subarray(0, 256).toString("utf8").trimStart();
    if (/<(?:!doctype|html|head|body)\b/i.test(head)) {
      assetIssues.push({ url, owners: [...owners], issue: "html-instead-of-image" });
    } else if (/\.png$/i.test(url) && buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      assetIssues.push({ url, owners: [...owners], issue: "png-extension-mismatch" });
    }
  }

  const sum = (key: keyof typeof rows[number]) => rows.reduce((n, row) => n + (typeof row[key] === "number" ? row[key] as number : 0), 0);
  const report = {
    generatedAt: new Date().toISOString(),
    scope: "Local inventory; field presence is not source verification or completeness.",
    totals: {
      festivals: rows.length,
      festivalsWithBanners: rows.filter((row) => row.banners > 0).length,
      works: sum("works"),
      detailPages: sum("detailPages"),
      disabledDetails: sum("disabledDetails"),
      restrictedDetails: sum("restrictedDetails"),
      withComments: sum("withComments"),
      withScreenshots: sum("withScreenshots"),
      withDownload: sum("withDownload"),
      withSource: sum("withSource"),
      referencedAssets: assets.size,
      assetIssues: assetIssues.length,
    },
    festivals: rows,
    assetIssues,
  };

  if (process.argv.includes("--write")) {
    await fs.writeFile("catch/archive-audit.json", JSON.stringify(report, null, 2) + "\n");
    const lines = [
      "# 祭典数据清点",
      "",
      "由 `npm run audit:data -- --write` 生成；详细问题见 [archive-audit.json](archive-audit.json)。",
      "",
      "这是本地字段清点，不是抓取完成证明。旧的全部勾选记录已停用；字段为空不代表原站没有内容。",
      "“详情”指当前可访问的详情页，其中受限条目使用固定模板，并单列数量；“留言”和“截图”只统计源内容字段存在，不表示已逐页对照来源。缓存页数包含列表、详情和其他 HTML，不能当作作品页数。",
      "",
      `共 ${rows.length} 个祭典、${report.totals.works} 条作品、${report.totals.detailPages} 个可访问详情（含 ${report.totals.restrictedDetails} 个受限模板）、${assetIssues.length} 个资源问题。`,
      "",
      "| 祭典 | 作品 | 详情 | 横幅 | 有作者 | 有留言 | 有截图 | 有下载 | 有逐条来源 | 缓存 HTML |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows.map((row) => `| ${row.id} | ${row.works} | ${row.detailPages} | ${row.banners} | ${row.withAuthor} | ${row.withComments} | ${row.withScreenshots} | ${row.withDownload} | ${row.withSource} | ${row.cachedHtmlFiles} |`),
      "",
      "## 资源问题",
      "",
      ...assetIssues.map((issue) => `- \`${issue.url}\` — ${issue.issue}（${issue.owners.join(", ")}）`),
      ...(assetIssues.length ? [] : ["未发现缺失文件、HTML 冒充图片或 PNG 扩展名不符。图片实际解码仍需独立检查。"]),
      "",
    ];
    await fs.writeFile("catch/festival-scrape-status.md", lines.join("\n"));
    const progress: { order: string[]; activeFestival: string; pendingFestivals?: Array<{ festivalId: string; name: string; notes: string; sourceEvidence: string }>; insertedTask?: { status: string; plan: string; resumeFestival: string }; originalViewsReviewed?: Array<{ festivalId: string; evidence: string[] }>; completed: Array<{ festivalId: string; reviewedAt: string; dataSha256: string; status: string; sourceEvidence: string[]; notes: string }> } = JSON.parse(await fs.readFile("catch/restart-progress.json", "utf8"));
    const current = progress.completed.filter((entry) => rows.find((row) => row.id === entry.festivalId)?.dataSha256 === entry.dataSha256);
    const next = progress.order.find((id) => !current.some((entry) => entry.festivalId === id));
    const progressLines = [
      "# 重启后的逐祭典校对清单", "",
      `已校对 ${current.length}/${progress.order.length} 个祭典；当前顺序中的下一个：\`${next ?? "全部已校对"}\`。`, "",
      `原貌视图已验收 ${(progress.originalViewsReviewed ?? []).length}/${progress.order.length} 个；整理版与原貌版共同纳入后续逐祭典工作。`, "",
      ...((progress.pendingFestivals ?? []).length ? [
        `已入库 ${festivals.length} 个祭典；另有 ${progress.pendingFestivals!.length} 个新祭典已登记来源信息，作品数据及双视图尚未恢复，不计入已验收数量。`, "",
        "| 新祭典 | 已核实信息 | 来源记录 |", "| --- | --- | --- |",
        ...progress.pendingFestivals!.map((entry) => `| ${entry.name}（\`${entry.festivalId}\`） | ${entry.notes} | [信息与来源](../${entry.sourceEvidence}) |`), "",
      ] : []),
      ...(progress.insertedTask?.status === "active" ? [`当前先执行[插入的补充归档任务](../${progress.insertedTask.plan})，从 \`${progress.activeFestival}\` 开始；完成后回到 \`${progress.insertedTask.resumeFestival}\`。`, ""] : []),
      ...(progress.insertedTask?.status === "reviewed-with-exceptions" ? [`[补充归档复核记录](../${progress.insertedTask.plan})保留了本轮恢复结果及未恢复的限制条目；常规校对已按顺序推进至 \`${progress.activeFestival ?? next ?? "全部已校对"}\`。`, ""] : []),
      "只有完成来源逐项核对、资源检查和桌面验收的祭典才加入下表。数据字段清点见 [festival-scrape-status.md](../catch/festival-scrape-status.md)，不作为校对完成证明。", "",
      "进度依据：[restart-progress.json](../catch/restart-progress.json)。顺序沿用已完成的 2014 GW、2015 GW，接续 2015 红白／夏、2014–2005 年其余祭典，最后复核 2016–2025 年祭典。数据文件改变后，原完成记录会标为需要复核。", "",
      "| 顺序 | 祭典 | 日期 | 校对结果 | 来源证据 |", "| ---: | --- | --- | --- | --- |",
      ...progress.completed.map((entry) => `| ${progress.order.indexOf(entry.festivalId) + 1} | ${entry.festivalId} | ${entry.reviewedAt} | ${current.includes(entry) ? entry.notes : "数据已改变，需要复核"} | ${entry.sourceEvidence.map((file) => `[${file}](../${file})`).join("、")} |`),
      "", `尚未完成：${progress.order.filter((id) => !current.some((entry) => entry.festivalId === id)).map((id) => `\`${id}\``).join("、")}。`, "",
      `已校对但尚待原貌视图验收：${current.filter((entry) => !(progress.originalViewsReviewed ?? []).some((view) => view.festivalId === entry.festivalId)).map((entry) => `\`${entry.festivalId}\``).join("、") || "无"}。`, "",
    ];
    const progressBytes = Buffer.from(progressLines.join("\n")), progressHandle = await fs.open("docs/restart-progress.md", "r+");
    try { await progressHandle.writeFile(progressBytes); await progressHandle.truncate(progressBytes.length); } finally { await progressHandle.close(); }
    console.log("Wrote catch/archive-audit.json and catch/festival-scrape-status.md");
  }
  console.log(JSON.stringify(report.totals, null, 2));
  if (!process.argv.includes("--write")) {
    for (const issue of assetIssues) console.log(`${issue.issue}: ${issue.url}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
