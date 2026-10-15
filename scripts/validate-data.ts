import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import Ajv, { DefinedError } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

type ValidationError = {
  file: string;
  message: string;
  details?: string;
};

const festivalSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "year",
    "name",
    "slug",
    "type",
    "banners",
    "worksFile",
    "columns",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    year: { type: "integer" },
    name: { type: "string", minLength: 1 },
    slug: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    banners: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    hasDetail: { type: "boolean" },
    period: { type: "string" },
    materialTerms: { type: "string" },
    worksFile: { type: "string", minLength: 1 },
    columns: {
      type: "array",
      minItems: 1,
      items: {
        enum: ["no", "icon", "work", "type", "streaming", "download", "forum"],
      },
    },
  },
} as const;

const workSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "festivalId", "title", "author"],
  properties: {
    id: { type: "string", minLength: 1 },
    festivalId: { type: "string", minLength: 1 },
    no: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    icon: { type: "string" },
    category: { type: "string" },
    engine: { type: "string" },
    author: { type: "string", minLength: 0 },
    streaming: { type: "string" },
    streamingPolicy: { enum: ["allow", "restricted", "forbid"] },
    download: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri-reference" },
        label: { type: "string" },
        detail: { type: "string" },
        filename: { type: "string" },
        previewUrl: { type: "string", format: "uri-reference" },
      },
    },
    downloads: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["url"],
        properties: { url: { type: "string", format: "uri-reference" }, label: { type: "string" }, detail: { type: "string" }, filename: { type: "string" }, previewUrl: { type: "string", format: "uri-reference" } },
      },
    },
    materialInfo: {
      type: "object", additionalProperties: false,
      properties: { archivePermission: { type: "string" }, externalUsePermission: { type: "string" }, notes: { type: "string" } },
    },
    forum: { type: "string", format: "uri" },
    authorComment: { type: "string" },
    hostComment: { type: "string" },
    updates: { type: "string" },
    originalTitle: { type: "string", minLength: 1 },
    contentRestricted: { type: "boolean" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        snapshotUrl: { type: "string", format: "uri" },
        titleUrl: { type: "string", format: "uri" },
        authorOmitted: { type: "boolean" },
      },
    },
    detailDisabled: { type: "boolean" },
    ss: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const validateFestival = ajv.compile(festivalSchema);
const validateWork = ajv.compile(workSchema);

async function ensureReadable(filePath: string) {
  await access(filePath, constants.R_OK);
}

async function main() {
  const dataDir = path.join(process.cwd(), "src", "data");
  const errors: ValidationError[] = [];
  const festivalIds = new Set<string>();
  const slugs = new Set<string>();
  const workIds = new Set<string>();
  const checkedAssets = new Set<string>();

  async function checkAsset(url: string, file: string) {
    if (!url.startsWith("/") || url.startsWith("//") || checkedAssets.has(url)) return;
    checkedAssets.add(url);
    try {
      const buffer = await readFile(path.join(process.cwd(), "public", url));
      if (/<(?:!doctype|html|head|body)\b/i.test(buffer.subarray(0, 256).toString("utf8"))) {
        errors.push({ file, message: `Image is an HTML page: ${url}` });
      } else if (/\.png$/i.test(url) && buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        errors.push({ file, message: `Image does not match PNG extension: ${url}` });
      }
    } catch {
      errors.push({ file, message: `Missing local asset: ${url}` });
    }
  }

  const festivalsPath = path.join(dataDir, "festivals.json");
  await ensureReadable(festivalsPath);
  const festivalsRaw = await readFile(festivalsPath, "utf8");
  const festivals = JSON.parse(festivalsRaw);

  if (!Array.isArray(festivals)) {
    throw new Error("festivals.json must be an array");
  }

  for (const festival of festivals) {
    const validFestival = validateFestival(festival);
    if (!validFestival) {
      errors.push({
        file: "festivals.json",
        message: `Festival ${festival?.id ?? "<unknown>"} invalid`,
        details: formatErrors(validateFestival.errors),
      });
      continue;
    }

    if (festivalIds.has(festival.id) || slugs.has(festival.slug)) {
      errors.push({ file: "festivals.json", message: `Duplicate festival id or slug: ${festival.id}` });
    }
    festivalIds.add(festival.id);
    slugs.add(festival.slug);
    for (const banner of festival.banners) await checkAsset(banner, "festivals.json");

    const worksFilePath = path.join(dataDir, festival.worksFile);
    await ensureReadable(worksFilePath);

    const worksRaw = await readFile(worksFilePath, "utf8");
    const works = JSON.parse(worksRaw);

    if (!Array.isArray(works)) {
      errors.push({
        file: festival.worksFile,
        message: "Work list must be an array",
      });
      continue;
    }

    for (const work of works) {
      const validWork = validateWork(work);
      if (!validWork) {
        errors.push({
          file: festival.worksFile,
          message: `Work ${work?.id ?? "<unknown>"} invalid`,
          details: formatErrors(validateWork.errors),
        });
        continue;
      }

      if (work.festivalId !== festival.id) {
        errors.push({
          file: festival.worksFile,
          message: `Work ${work.id} festivalId mismatch`,
          details: `Expected ${festival.id}`,
        });
      }
      if (workIds.has(work.id)) {
        errors.push({ file: festival.worksFile, message: `Duplicate work id: ${work.id}` });
      }
      workIds.add(work.id);
      for (const file of [...(work.downloads ?? []), ...(work.download ? [work.download] : [])]) {
        if (file.url.startsWith("/")) {
          await ensureReadable(path.join("public", file.url));
        }
        if (file.previewUrl?.startsWith("/")) await ensureReadable(path.join("public", file.previewUrl));
      }
      for (const url of [work.icon, ...(work.ss ?? [])]) {
        if (url) await checkAsset(url, festival.worksFile);
      }
      for (const comment of [work.authorComment, work.hostComment]) {
        for (const match of comment?.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi) ?? []) {
          await checkAsset(match[1], festival.worksFile);
        }
      }
    }
  }

  if (errors.length) {
    console.error("Data validation failed:\n");
    for (const issue of errors) {
      console.error(`- [${issue.file}] ${issue.message}`);
      if (issue.details) {
        console.error(`  -> ${issue.details}`);
      }
    }
    process.exit(1);
  }

  console.log("Data validation passed ✔");
}

function formatErrors(items: DefinedError[] | null | undefined) {
  if (!items) return "";
  return items.map((error) => `${error.instancePath || "."} ${error.message}`).join("; ");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
