import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "photos");
const privateDir = path.join(root, ".private");
const uploadDir = path.join(privateDir, "uploads");
const dataFile = path.join(privateDir, "memories.json");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);
const mimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
]);

async function listImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return listImages(absolute);
      if (!entry.isFile()) return [];
      return imageExtensions.has(path.extname(entry.name).toLowerCase()) ? [absolute] : [];
    }),
  );
  return nested.flat();
}

function cleanTitle(file) {
  return path
    .basename(file, path.extname(file))
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

function extractExifYear(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;
    const segmentLength = buffer.readUInt16BE(offset);
    const segmentStart = offset + 2;
    if (marker === 0xe1 && readAscii(buffer, segmentStart, 4) === "Exif") return parseTiffYear(buffer, segmentStart + 6);
    offset += segmentLength;
  }
  return null;
}

function parseTiffYear(buffer, tiffStart) {
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
  for (const value of dates) {
    const match = typeof value === "string" ? value.match(/^(\d{4})[:/-]/) : null;
    const year = match ? Number(match[1]) : null;
    if (year && year > 1900 && year < 2200) return year;
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
    if (type === 2) tags.set(tag, readAscii(buffer, valueOffset, count).trim());
    else if (type === 3 && count === 1) tags.set(tag, get16(valueOffset));
    else if (type === 4 && count === 1) tags.set(tag, get32(valueOffset));
  }
  return tags;
}

async function readExistingMemories() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch {
    return [];
  }
}

await mkdir(uploadDir, { recursive: true });

const existing = await readExistingMemories();
const existingOriginals = new Set(existing.map((memory) => memory.originalName));
const files = await listImages(sourceDir);
let imported = 0;

for (const file of files) {
  const originalName = path.relative(sourceDir, file);
  if (existingOriginals.has(originalName)) continue;
  const buffer = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const id = randomUUID();
  const fileName = `${id}${ext}`;
  await writeFile(path.join(uploadDir, fileName), buffer, { flag: "wx" });
  existing.push({
    id,
    title: cleanTitle(file),
    year: extractExifYear(buffer) || "",
    sourceLabel: "Año detectado desde metadatos o pendiente",
    fileName,
    mimeType: mimeTypes.get(ext) || "application/octet-stream",
    originalName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  imported += 1;
}

await writeFile(dataFile, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
console.log(`Listo: ${imported} fotos importadas a almacenamiento privado.`);
