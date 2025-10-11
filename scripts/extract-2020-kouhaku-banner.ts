import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const input = path.join(process.cwd(), "catch", "2020-kouhaku", "index.html");
  const outDir = path.join(process.cwd(), "public", "banners");
  const outPath = path.join(outDir, "2020-kouhaku.png");

  const html = await fs.readFile(input, "utf8");
  const m = html.match(/<img[^>]+src=\"data:(image\/(png|jpeg|gif));base64,([^\"]+)\"/i);
  if (!m) {
    throw new Error("No data:image base64 banner found in catch/2020-kouhaku/index.html");
  }
  const mime = m[1];
  const ext = m[2].toLowerCase() === "jpeg" ? ".jpg" : ".png";
  const data = m[3];
  const buf = Buffer.from(data, "base64");
  await fs.mkdir(outDir, { recursive: true });
  const finalOut = path.join(outDir, `2020-kouhaku${ext}`);
  await fs.writeFile(finalOut, buf);
  console.log(`Saved banner to ${finalOut} (${buf.length} bytes, ${mime})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

