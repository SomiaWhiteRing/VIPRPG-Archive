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
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    period: { type: "string" },
    worksFile: { type: "string", minLength: 1 },
    columns: {
      type: "array",
      minItems: 1,
      items: {
        enum: ["icon", "work", "type", "streaming", "download", "forum"],
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
    title: { type: "string", minLength: 1 },
    icon: { type: "string" },
    category: { type: "string" },
    engine: { type: "string" },
    author: { type: "string", minLength: 1 },
    streaming: { type: "string" },
    streamingPolicy: { enum: ["allow", "restricted", "forbid"] },
    download: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        label: { type: "string" },
      },
    },
    forum: { type: "string", format: "uri" },
    authorComment: { type: "string" },
    hostComment: { type: "string" },
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
