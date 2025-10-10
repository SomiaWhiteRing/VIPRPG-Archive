import fs from "node:fs/promises";

function parseRateReaderMarkdown(reader: string) {
  try {
    const marker = "Markdown Content:\n";
    const idx = reader.indexOf(marker);
    const content = (idx >= 0 ? reader.slice(idx + marker.length) : reader).replace(/\r\n?/g, "\n");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pickLine = (label: string) => {
      const m = content.match(new RegExp(`${esc(`**${label}**`)}\\n+([^\\n]+)`, "i"));
      return m && m[1] ? m[1].trim() : undefined;
    };
    const pickBlock = (label: string) => {
      const m = content.match(new RegExp(`${esc(`**${label}**`)}\\n+([\\s\\S]*?)(?:\\n\\*\\*|\\nLeave a comment|\\nComments)`, "i"));
      if (m && m[1]) {
        const text = m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
        return text || undefined;
      }
      return undefined;
    };
    const gameUrl = (() => {
      const m = content.match(/\]\((https?:\/\/[\w.-]+\.itch\.io\/[\w\-\/.%]+)\)\s*\n\*\*/);
      if (m) return m[1];
      const m2 = content.match(/\((https?:\/\/[\w.-]+\.itch\.io\/[\w\-\/.%]+)\).*?(?:View game page|itch\.io page)/i);
      return m2 ? m2[1] : undefined;
    })();
    const hostComment = (() => {
      const m = content.match(/VIPRPGAD2023admin[\s\S]*?\n+([^\n]+)\n/);
      return m && m[1] ? m[1].trim() : undefined;
    })();
    const category = pickLine("ジャンル");
    const engine = pickLine("使用ツール");
    const streaming = pickLine("配信・動画化の可否") || pickLine("配信動画化の可否") || pickLine("配信/動画");
    const authorComment = pickBlock("作者コメント");
    return { category, engine, streaming, authorComment, hostComment, gameUrl } as const;
  } catch {
    return {} as { category?: string; engine?: string; streaming?: string; authorComment?: string; hostComment?: string; gameUrl?: string };
  }
}

async function main() {
  const p = "catch/2023-winter/rate/01_https-itch-io-jam-viprmwinterjam2023-anno-draconis-rate-2410248.html";
  const raw = await fs.readFile(p, "utf8");
  const parsed = parseRateReaderMarkdown(raw);
  console.log(parsed);
}

main().catch((e) => { console.error(e); process.exit(1); });

