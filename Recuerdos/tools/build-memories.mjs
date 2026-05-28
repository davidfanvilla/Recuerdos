import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const photosDir = path.join(root, "photos");
const outputFile = path.join(root, "memories.js");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif"]);

async function listImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listImages(absolutePath);
      if (!entry.isFile()) return [];
      return imageExtensions.has(path.extname(entry.name).toLowerCase()) ? [absolutePath] : [];
    }),
  );
  return files.flat();
}

function slugToTitle(name) {
  return path
    .basename(name, path.extname(name))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Recuerdo";
}

function readAscii(buffer, offset, length) {
  let text = "";
  for (let i = 0; i < length && offset + i < buffer.length; i += 1) {
    const code = buffer[offset + i];
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

function extractExifDate(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;

    const segmentLength = buffer.readUInt16BE(offset);
    const segmentStart = offset + 2;

    if (marker === 0xe1 && readAscii(buffer, segmentStart, 4) === "Exif") {
      return parseTiffDate(buffer, segmentStart + 6);
    }

    offset += segmentLength;
  }

  return null;
}

function parseTiffDate(buffer, tiffStart) {
  const byteOrder = readAscii(buffer, tiffStart, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return null;

  const get16 = (relativeOffset) =>
    littleEndian ? buffer.readUInt16LE(tiffStart + relativeOffset) : buffer.readUInt16BE(tiffStart + relativeOffset);
  const get32 = (relativeOffset) =>
    littleEndian ? buffer.readUInt32LE(tiffStart + relativeOffset) : buffer.readUInt32BE(tiffStart + relativeOffset);

  if (get16(2) !== 42) return null;

  const firstIfd = readIfd(buffer, tiffStart, get32(4), littleEndian);
  const exifOffset = firstIfd.get(0x8769);
  const dates = [];

  if (exifOffset) {
    const exifIfd = readIfd(buffer, tiffStart, exifOffset, littleEndian);
    dates.push(exifIfd.get(0x9003), exifIfd.get(0x9004));
  }
  dates.push(firstIfd.get(0x0132));

  for (const dateValue of dates) {
    const year = parseExifYear(dateValue);
    if (year) return { raw: dateValue, year, source: "EXIF" };
  }
  return null;
}

function readIfd(buffer, tiffStart, relativeOffset, littleEndian) {
  const tags = new Map();
  if (!relativeOffset || tiffStart + relativeOffset + 2 >= buffer.length) return tags;

  const get16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const get32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const typeSizes = new Map([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 4],
    [5, 8],
    [7, 1],
    [9, 4],
    [10, 8],
  ]);

  const ifdStart = tiffStart + relativeOffset;
  const entryCount = get16(ifdStart);

  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifdStart + 2 + i * 12;
    if (entry + 12 > buffer.length) break;

    const tag = get16(entry);
    const type = get16(entry + 2);
    const count = get32(entry + 4);
    const byteCount = (typeSizes.get(type) || 1) * count;
    const valueOffset = byteCount <= 4 ? entry + 8 : tiffStart + get32(entry + 8);
    if (valueOffset < 0 || valueOffset >= buffer.length) continue;

    if (type === 2) {
      tags.set(tag, readAscii(buffer, valueOffset, count).trim());
    } else if (type === 3 && count === 1) {
      tags.set(tag, get16(valueOffset));
    } else if (type === 4 && count === 1) {
      tags.set(tag, get32(valueOffset));
    }
  }

  return tags;
}

function parseExifYear(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^(\d{4})[:/-]/);
  if (!match) return null;
  const year = Number(match[1]);
  return year > 1900 && year < 2200 ? year : null;
}

function yearFromMacMetadata(file) {
  try {
    const raw = execFileSync("mdls", ["-raw", "-name", "kMDItemContentCreationDate", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw || raw === "(null)") return null;
    const year = new Date(raw).getFullYear();
    return Number.isFinite(year) ? { year, source: "macOS" } : null;
  } catch {
    return null;
  }
}

async function yearForFile(file) {
  try {
    const buffer = await readFile(file);
    const exif = extractExifDate(buffer);
    if (exif) return exif;
  } catch {
    // Keep going with macOS metadata.
  }
  return yearFromMacMetadata(file);
}

function toBrowserPath(file) {
  return path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
}

const files = (await listImages(photosDir)).sort((a, b) => a.localeCompare(b));
const memories = await Promise.all(
  files.map(async (file, index) => {
    const year = await yearForFile(file);
    return {
      id: `memory-${index + 1}`,
      title: slugToTitle(file),
      src: toBrowserPath(file),
      year: year?.year || "",
      sourceLabel: year ? `Ano detectado desde ${year.source}` : "Ano pendiente",
    };
  }),
);

await writeFile(
  outputFile,
  `window.PHOTO_MEMORIES = ${JSON.stringify(memories, null, 2)};\n`,
  "utf8",
);

console.log(`Listo: ${memories.length} recuerdos escritos en ${path.basename(outputFile)}.`);
