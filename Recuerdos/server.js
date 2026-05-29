const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const PORT = Number(process.env.PORT || 3000);
const SITE_PASSWORD = process.env.SITE_PASSWORD || "recuerdos";
const COOKIE_NAME = "memory_session";
const ROOT = __dirname;
const PRIVATE_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, ".private");
const UPLOAD_DIR = path.join(PRIVATE_DIR, "uploads");
const DATA_FILE = path.join(PRIVATE_DIR, "memories.json");
const MAX_BODY_SIZE = 80 * 1024 * 1024;
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 7;

const sessions = new Map();
const attempts = new Map();

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/memories.js", "memories.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
]);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = attempts.get(ip) || { count: 0, first: now };
  if (now - entry.first > windowMs) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  return entry.count > 10;
}

function safeCompare(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function cookieOptions(req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

function createSession(res, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_AGE_SECONDS * 1000);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; ${cookieOptions(req)}`);
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function isAuthenticated(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

async function ensureDataFiles() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await fsp.writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readMemories() {
  await ensureDataFiles();
  return JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
}

async function writeMemories(memories) {
  await ensureDataFiles();
  await fsp.writeFile(DATA_FILE, `${JSON.stringify(memories, null, 2)}\n`, "utf8");
}

async function readBody(req, limit = MAX_BODY_SIZE) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Archivo demasiado grande"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(req) {
  return readBody(req, 64 * 1024).then((body) => JSON.parse(body.toString("utf8") || "{}"));
}

function parseContentDisposition(value = "") {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawValue.length) continue;
    const key = rawKey.toLowerCase();
    const joined = rawValue.join("=");
    result[key] = joined.replace(/^"|"$/g, "").replace(/\\"/g, '"');
  }
  return result;
}

function bufferIndexOf(buffer, search, start = 0) {
  return buffer.indexOf(search, start);
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = bufferIndexOf(buffer, delimiter);

  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

    const headerEnd = bufferIndexOf(buffer, Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(cursor, headerEnd).toString("latin1");
    const headers = Object.fromEntries(
      rawHeaders.split("\r\n").map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      }),
    );

    const next = bufferIndexOf(buffer, delimiter, headerEnd + 4);
    if (next === -1) break;
    const dataEnd = buffer[next - 2] === 13 && buffer[next - 1] === 10 ? next - 2 : next;
    const disposition = parseContentDisposition(headers["content-disposition"]);
    parts.push({
      data: buffer.slice(headerEnd + 4, dataEnd),
      filename: disposition.filename,
      name: disposition.name,
      type: headers["content-type"] || "application/octet-stream",
    });
    cursor = next;
  }

  return parts;
}

function extensionForType(type) {
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/heic") return ".heic";
  if (type === "image/heif") return ".heif";
  return "";
}

function cleanTitle(filename = "Recuerdo") {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Recuerdo";
}

function normalizeMemoryText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 180);
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
    if (marker === 0xe1 && readAscii(buffer, segmentStart, 4) === "Exif") {
      return parseTiffYear(buffer, segmentStart + 6);
    }
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
  for (const dateValue of dates) {
    const match = typeof dateValue === "string" ? dateValue.match(/^(\d{4})[:/-]/) : null;
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

function publicMemory(memory) {
  return {
    id: memory.id,
    title: memory.title,
    year: memory.year,
    sourceLabel: memory.sourceLabel,
    imageUrl: `/api/images/${encodeURIComponent(memory.id)}?v=${encodeURIComponent(memory.updatedAt || memory.createdAt)}`,
  };
}

async function handleUpload(req, res) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) return send(res, 400, { error: "Formato de subida no valido" });

  const body = await readBody(req);
  const parts = parseMultipart(body, boundary);
  const memories = await readMemories();
  const created = [];

  for (const part of parts) {
    if (part.name !== "photos" || !part.filename || !part.type.startsWith("image/")) continue;
    const ext = extensionForType(part.type) || path.extname(part.filename).toLowerCase();
    if (!mimeTypes.has(ext)) continue;
    const id = crypto.randomUUID();
    const fileName = `${id}${ext}`;
    const year = extractExifYear(part.data) || new Date().getFullYear();
    const sourceLabel = year ? "Año detectado o aproximado desde el archivo" : "Año pendiente";
    await fsp.writeFile(path.join(UPLOAD_DIR, fileName), part.data, { flag: "wx" });
    const memory = {
      id,
      title: "",
      year,
      sourceLabel,
      fileName,
      mimeType: part.type,
      originalName: part.filename,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    memories.push(memory);
    created.push(memory);
  }

  await writeMemories(memories);
  return send(res, 201, { memories: created.map(publicMemory) });
}

async function handleDelete(req, res, id) {
  const memories = await readMemories();
  const memory = memories.find((item) => item.id === id);
  if (!memory) return send(res, 404, { error: "No encontrado" });
  await writeMemories(memories.filter((item) => item.id !== id));
  await fsp.rm(path.join(UPLOAD_DIR, memory.fileName), { force: true });
  return send(res, 200, { ok: true });
}

async function handleUpdate(req, res, id) {
  const body = await parseJsonBody(req).catch(() => ({}));
  const memories = await readMemories();
  const memory = memories.find((item) => item.id === id);
  if (!memory) return send(res, 404, { error: "No encontrado" });

  memory.title = normalizeMemoryText(body.title);
  memory.updatedAt = Date.now();
  await writeMemories(memories);
  return send(res, 200, { memory: publicMemory(memory) });
}

async function serveStatic(req, res) {
  const fileName = staticFiles.get(new URL(req.url, "http://local").pathname);
  if (!fileName) return false;
  const filePath = path.join(ROOT, fileName);
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
  await pipeline(fs.createReadStream(filePath), res);
  return true;
}

async function serveImage(req, res, id) {
  const memories = await readMemories();
  const memory = memories.find((item) => item.id === id);
  if (!memory) return send(res, 404, { error: "No encontrado" });
  const filePath = path.join(UPLOAD_DIR, memory.fileName);
  res.writeHead(200, {
    "Content-Type": memory.mimeType || mimeTypes.get(path.extname(memory.fileName)) || "application/octet-stream",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store, max-age=0",
    ...securityHeaders(),
  });
  await pipeline(fs.createReadStream(filePath), res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://local");
  const pathname = url.pathname;

  if (pathname === "/api/session" && req.method === "GET") return send(res, 200, { authenticated: isAuthenticated(req) });

  if (pathname === "/api/login" && req.method === "POST") {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) return send(res, 429, { error: "Demasiados intentos. Prueba mas tarde." });
    const body = await parseJsonBody(req).catch(() => ({}));
    if (!safeCompare(body.password || "", SITE_PASSWORD)) return send(res, 401, { error: "Clave incorrecta" });
    createSession(res, req);
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    clearSession(res);
    return send(res, 200, { ok: true });
  }

  if (!isAuthenticated(req)) return send(res, 401, { error: "Necesitas entrar con la clave" });

  if (pathname === "/api/memories" && req.method === "GET") {
    const memories = await readMemories();
    return send(res, 200, { memories: memories.map(publicMemory) });
  }

  if (pathname === "/api/memories" && req.method === "POST") return handleUpload(req, res);

  const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memoryMatch && req.method === "PATCH") return handleUpdate(req, res, decodeURIComponent(memoryMatch[1]));
  if (memoryMatch && req.method === "DELETE") return handleDelete(req, res, decodeURIComponent(memoryMatch[1]));

  const imageMatch = pathname.match(/^\/api\/images\/([^/]+)$/);
  if (imageMatch && req.method === "GET") return serveImage(req, res, decodeURIComponent(imageMatch[1]));

  return send(res, 404, { error: "No encontrado" });
}

async function route(req, res) {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    if (await serveStatic(req, res)) return;
    return send(res, 404, { error: "No encontrado" });
  } catch (error) {
    console.error(error);
    return send(res, error.statusCode || 500, { error: error.message || "Error interno" });
  }
}

ensureDataFiles().then(() => {
  http.createServer(route).listen(PORT, () => {
    console.log(`Recuerdos privado listo en http://localhost:${PORT}`);
    if (!process.env.SITE_PASSWORD) console.log("Usando clave temporal SITE_PASSWORD=recuerdos. Cambiala antes de publicar.");
  });
});
