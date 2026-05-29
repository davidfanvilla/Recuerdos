const canvas = document.querySelector("#networkCanvas");
const ctx = canvas.getContext("2d");
const app = document.querySelector(".memory-app");
const emptyState = document.querySelector("#emptyState");
const photoInput = document.querySelector("#photoInput");
const heroPhotoInput = document.querySelector("#heroPhotoInput");
const shuffleButton = document.querySelector("#shuffleButton");
const memoryCount = document.querySelector("#memoryCount");
const yearRange = document.querySelector("#yearRange");
const panel = document.querySelector("#memoryPanel");
const closePanelButton = document.querySelector("#closePanelButton");
const selectedPhoto = document.querySelector("#selectedPhoto");
const selectedTitle = document.querySelector("#selectedTitle");
const selectedYear = document.querySelector("#selectedYear");
const selectedSource = document.querySelector("#selectedSource");
const previousButton = document.querySelector("#previousButton");
const nextButton = document.querySelector("#nextButton");
const saveTextButton = document.querySelector("#saveTextButton");
const deleteMemoryButton = document.querySelector("#deleteMemoryButton");
const toast = document.querySelector("#toast");
const storageState = document.querySelector("#storageState");
const authOverlay = document.querySelector("#authOverlay");
const authForm = document.querySelector("#authForm");
const authPassword = document.querySelector("#authPassword");
const authMessage = document.querySelector("#authMessage");

const TAU = Math.PI * 2;
const DB_NAME = "birthday-memory-universe";
const DB_VERSION = 1;
const STORE_NAME = "photos";
const HIDDEN_PRESET_KEY = "hidden-preset-memory-ids";
const EDITED_TEXT_KEY = "edited-memory-texts";
const MAX_IMAGE_EDGE = 1800;
const JPEG_QUALITY = 0.86;
const palette = ["#f7f3ea", "#d7d1c5", "#b9b1a4", "#ffffff", "#8f8c86"];
const particlePalette = ["#ffffff", "#f1ede5", "#c8c1b4", "#8f8c86"];

let width = 0;
let height = 0;
let dpr = 1;
let pointer = { x: -9999, y: -9999, down: false };
let memories = [];
let ambientNodes = [];
let particles = [];
let selectedIndex = -1;
let toastTimer = 0;
let rotation = { yaw: -0.45, pitch: 0.18 };
let targetRotation = { yaw: -0.45, pitch: 0.18 };
let dragState = null;
let backendMode = false;
let authenticated = false;
let textSaveTimer = 0;

function isLargeTouchPhone() {
  const hasTouch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  return hasTouch && width <= 520 && height >= 760;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function slugToTitle(name) {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Recuerdo";
}

function cleanMemoryText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 180);
}

function isCameraFileTitle(value) {
  const compact = cleanMemoryText(value).replace(/\s+/g, "").toUpperCase();
  return /^(IMG|DSC|DSCF|PXL|PHOTO|VID|WA)\d{2,}([A-Z]{0,3}\d{0,6})?$/.test(compact) || /^SCREENSHOT\d/.test(compact);
}

function getMemoryText(memory) {
  const text = cleanMemoryText(memory?.title);
  return isCameraFileTitle(text) ? "" : text;
}

function readEditedTexts() {
  try {
    return JSON.parse(localStorage.getItem(EDITED_TEXT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveEditedText(id, text) {
  if (!id) return;
  const texts = readEditedTexts();
  texts[id] = text;
  try {
    localStorage.setItem(EDITED_TEXT_KEY, JSON.stringify(texts));
  } catch {
    // The current screen is still updated even when this browser blocks localStorage.
  }
}

function updatePointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left;
  pointer.y = event.clientY - rect.top;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function showAuth(message = "") {
  authMessage.textContent = message;
  authOverlay.classList.remove("is-hidden");
  setTimeout(() => authPassword.focus(), 80);
}

function hideAuth() {
  authOverlay.classList.add("is-hidden");
  authPassword.value = "";
  authMessage.textContent = "";
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    authenticated = false;
    showAuth("Necesitas la clave para ver los recuerdos.");
  }

  return response;
}

async function readApiJson(path, options) {
  const response = await apiFetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar la accion");
  return data;
}

function makeId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readHiddenPresetIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_PRESET_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveHiddenPresetIds(ids) {
  try {
    localStorage.setItem(HIDDEN_PRESET_KEY, JSON.stringify([...ids]));
  } catch {
    // Keep removal working for the current view even if localStorage is unavailable.
  }
}

function resizeCanvas() {
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, isLargeTouchPhone() ? 2.35 : 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  createAmbientNodes();
  layoutMemories(true);
}

function createAmbientNodes() {
  const largeTouchPhone = isLargeTouchPhone();
  const nodeCount = clamp(Math.round((width * height) / 36000), 18, 64);
  const particleCount = clamp(Math.round((width * height) / (largeTouchPhone ? 620 : 760)), 430, largeTouchPhone ? 1850 : 1550);
  const bandCenter = height * (largeTouchPhone ? 0.52 : width < 760 ? 0.53 : 0.54);
  const sceneRadius = Math.min(width, height) * (largeTouchPhone ? 0.56 : width < 760 ? 0.5 : 0.42);

  ambientNodes = Array.from({ length: nodeCount }, (_, index) => ({
    x3: randomBetween(-sceneRadius, sceneRadius),
    y3: randomBetween(-sceneRadius * 0.78, sceneRadius * 0.78),
    z3: randomBetween(-sceneRadius, sceneRadius),
    r: randomBetween(2.6, width < 760 ? 11 : 15),
    phase: Math.random() * TAU,
    color: index % 3 === 0 ? "#ffffff" : palette[index % palette.length],
  }));

  particles = Array.from({ length: particleCount }, (_, index) => {
    const x = randomBetween(-width * 0.06, width * 1.06);
    const wave = Math.sin((x / Math.max(width, 1)) * TAU * 1.15 + 0.35) * height * 0.075;
    const spread = Math.pow(Math.random(), 1.8) * height * (width < 760 ? 0.25 : 0.21);
    const side = Math.random() < 0.5 ? -1 : 1;
    return {
      x,
      y: bandCenter + wave + spread * side,
      baseY: bandCenter + wave + spread * side,
      r: randomBetween(0.45, index % 11 === 0 ? 2.2 : 1.35),
      depth: randomBetween(0.35, 1.35),
      phase: Math.random() * TAU,
      color: particlePalette[index % particlePalette.length],
    };
  });
}

function makeMemoryNode(memory, index, total) {
  return {
    ...memory,
    x3: 0,
    y3: 0,
    z3: 0,
    sx: width / 2,
    sy: height / 2,
    radius: 52,
    projectedRadius: 52,
    scale: 1,
    depth: 0,
    phase: Math.random() * TAU,
    color: palette[index % palette.length],
    image: memory.image || null,
  };
}

function layoutMemories(immediate = false) {
  const total = memories.length;
  if (!total) return;

  const largeTouchPhone = isLargeTouchPhone();
  const sceneRadius = Math.min(width, height) * (largeTouchPhone ? 0.37 : width < 760 ? 0.34 : 0.32);
  const ringRadius = Math.min(width, height) * (largeTouchPhone ? 0.31 : width < 760 ? 0.28 : 0.25);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const baseNodeRadius = clamp(
    (largeTouchPhone ? 39 : width < 760 ? 34 : 40) + 86 / Math.sqrt(total + 2),
    largeTouchPhone ? 43 : width < 760 ? 36 : 42,
    largeTouchPhone ? 64 : width < 760 ? 58 : 70,
  );

  memories.forEach((memory, index) => {
    if (total < 7) {
      const angle = (index / Math.max(total, 1)) * TAU - Math.PI / 2;
      memory.x3 = Math.cos(angle) * ringRadius;
      memory.y3 = Math.sin(angle) * ringRadius * 0.64;
      memory.z3 = Math.sin(angle * 1.7 + index) * ringRadius * 0.56;
    } else {
      const y = 1 - (index / Math.max(total - 1, 1)) * 2;
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = index * goldenAngle;
      memory.x3 = Math.cos(theta) * radiusAtY * sceneRadius;
      memory.y3 = y * sceneRadius * 0.82;
      memory.z3 = Math.sin(theta) * radiusAtY * sceneRadius;
    }

    memory.radius = baseNodeRadius;
    projectNode(memory);
  });
}

function projectPoint(x, y, z) {
  const yaw = rotation.yaw;
  const pitch = rotation.pitch;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosX = Math.cos(pitch);
  const sinX = Math.sin(pitch);

  const x1 = x * cosY - z * sinY;
  const z1 = x * sinY + z * cosY;
  const y1 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  const cameraDistance = Math.max(width, height) * 1.15;
  const scale = cameraDistance / Math.max(120, cameraDistance - z2);

  return {
    x: width / 2 + x1 * scale,
    y: height * (isLargeTouchPhone() ? 0.52 : width < 760 ? 0.53 : 0.52) + y1 * scale,
    z: z2,
    scale,
  };
}

function projectNode(node) {
  const projected = projectPoint(node.x3 || 0, node.y3 || 0, node.z3 || 0);
  node.sx = projected.x;
  node.sy = projected.y;
  node.depth = projected.z;
  node.scale = projected.scale;
  node.projectedRadius = (node.radius || node.r || 8) * projected.scale;
  return node;
}

function projectScene() {
  ambientNodes.forEach(projectNode);
  memories.forEach(projectNode);
}

function updateStatus() {
  const total = memories.length;
  memoryCount.textContent = `${total} ${total === 1 ? "recuerdo" : "recuerdos"}`;
  emptyState.classList.toggle("is-hidden", total > 0);
  app.classList.toggle("has-memories", total > 0);
  if (!total) storageState.textContent = "Arrastra 360";

  const years = memories
    .map((memory) => Number(memory.year))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);

  if (!years.length) {
    yearRange.textContent = "Sin años todavía";
    return;
  }

  const first = years[0];
  const last = years[years.length - 1];
  yearRange.textContent = first === last ? `${first}` : `${first} - ${last}`;
}

function drawImageCover(image, x, y, size) {
  const imageRatio = image.naturalWidth / image.naturalHeight || 1;
  const targetRatio = 1;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;

  if (imageRatio > targetRatio) {
    sw = image.naturalHeight * targetRatio;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth / targetRatio;
    sy = (image.naturalHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, x - size / 2, y - size / 2, size, size);
}

function drawYearLabel(memory, hoverAmount) {
  if (!memory.year) return;

  const label = String(memory.year);
  ctx.save();
  const fontSize = clamp(11 * memory.scale, 10, 14);
  ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
  const textWidth = ctx.measureText(label).width;
  const pillWidth = textWidth + 20;
  const pillHeight = clamp(22 * memory.scale, 20, 25);
  const x = memory.sx - pillWidth / 2;
  const y = memory.sy + memory.projectedRadius + 9;

  ctx.shadowColor = "rgba(0, 0, 0, 0.34)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = `rgba(9, 9, 12, ${0.68 + hoverAmount * 0.12})`;
  roundedRect(x, y, pillWidth, pillHeight, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.stroke();
  ctx.fillStyle = "#f7f3ea";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, memory.sx, y + pillHeight / 2 + 0.5);
  ctx.restore();
}

function getRemoveButton(memory) {
  const radius = isLargeTouchPhone() ? clamp(12 * memory.scale, 11, 17) : clamp(10 * memory.scale, 8, 14);
  const offset = memory.projectedRadius * 0.74;
  return {
    x: memory.sx + offset,
    y: memory.sy - offset,
    r: radius,
  };
}

function drawRemoveButton(memory, hoverAmount) {
  const button = getRemoveButton(memory);
  const isHovering = Math.hypot(pointer.x - button.x, pointer.y - button.y) <= button.r + 4;
  const alpha = clamp(0.46 + hoverAmount * 0.36 + (isHovering ? 0.3 : 0), 0.42, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(0, 0, 0, 0.72)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = isHovering ? "rgba(247, 243, 234, 0.92)" : "rgba(10, 10, 10, 0.78)";
  ctx.beginPath();
  ctx.arc(button.x, button.y, button.r, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = isHovering ? "rgba(247, 243, 234, 0.88)" : "rgba(247, 243, 234, 0.4)";
  ctx.stroke();
  ctx.strokeStyle = isHovering ? "rgba(10, 10, 10, 0.92)" : "rgba(247, 243, 234, 0.82)";
  ctx.lineWidth = Math.max(1.4, button.r * 0.16);
  ctx.lineCap = "round";
  const cross = button.r * 0.36;
  ctx.beginPath();
  ctx.moveTo(button.x - cross, button.y - cross);
  ctx.lineTo(button.x + cross, button.y + cross);
  ctx.moveTo(button.x + cross, button.y - cross);
  ctx.lineTo(button.x - cross, button.y + cross);
  ctx.stroke();
  ctx.restore();
}

function roundedRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawNebula(time) {
  const centerX = width * (0.5 + Math.sin(time * 0.00012) * 0.04);
  const centerY = height * (width < 760 ? 0.53 : 0.54);
  const radius = Math.min(width, height) * (width < 760 ? 0.7 : 0.58);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const warmGlow = ctx.createRadialGradient(centerX - radius * 0.18, centerY, 0, centerX - radius * 0.18, centerY, radius);
  warmGlow.addColorStop(0, "rgba(247, 243, 234, 0.13)");
  warmGlow.addColorStop(0.42, "rgba(185, 177, 164, 0.045)");
  warmGlow.addColorStop(1, "rgba(247, 243, 234, 0)");
  ctx.fillStyle = warmGlow;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, radius * 1.08, radius * 0.42, -0.08, 0, TAU);
  ctx.fill();

  const coolGlow = ctx.createRadialGradient(centerX + radius * 0.18, centerY - radius * 0.03, 0, centerX + radius * 0.18, centerY, radius);
  coolGlow.addColorStop(0, "rgba(255, 255, 255, 0.1)");
  coolGlow.addColorStop(0.48, "rgba(143, 140, 134, 0.04)");
  coolGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = coolGlow;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY - radius * 0.03, radius * 1.02, radius * 0.36, 0.1, 0, TAU);
  ctx.fill();

  for (const particle of particles) {
    const driftX = Math.sin(time * 0.00018 * particle.depth + particle.phase) * 18 * particle.depth;
    const driftY = Math.cos(time * 0.00022 * particle.depth + particle.phase) * 10 * particle.depth;
    const twinkle = 0.45 + Math.sin(time * 0.0022 + particle.phase) * 0.38;
    const alpha = clamp(0.18 + twinkle * 0.65, 0.12, 0.88);

    ctx.fillStyle = hexToRgba(particle.color, alpha);
    ctx.beginPath();
    ctx.arc(particle.x + driftX, particle.baseY + driftY, particle.r * particle.depth, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

function drawNeuralCore(time) {
  const core = projectPoint(0, 0, 0);
  const base = Math.min(width, height) * (width < 760 ? 0.16 : 0.13);
  const pulse = 1 + Math.sin(time * 0.0014) * 0.04;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, base * 1.7);
  glow.addColorStop(0, "rgba(247, 243, 234, 0.12)");
  glow.addColorStop(0.42, "rgba(247, 243, 234, 0.035)");
  glow.addColorStop(1, "rgba(247, 243, 234, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(core.x, core.y, base * 1.7, 0, TAU);
  ctx.fill();

  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i += 1) {
    ctx.strokeStyle = `rgba(247, 243, 234, ${0.08 - i * 0.018})`;
    ctx.beginPath();
    ctx.ellipse(
      core.x,
      core.y,
      base * (0.72 + i * 0.36) * pulse,
      base * (0.24 + i * 0.16) * pulse,
      rotation.yaw * 0.5 + i * 0.82,
      0,
      TAU,
    );
    ctx.stroke();
  }
  ctx.restore();
}

function quadraticPoint(a, control, b, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
    y: mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y,
  };
}

function drawConnections(nodes, time, hoveredIndex) {
  const hoveredMemory = hoveredIndex >= 0 ? memories[hoveredIndex] : null;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.sx - b.sx;
      const dy = a.sy - b.sy;
      const distance = Math.hypot(dx, dy);
      const limit = memories.length ? Math.min(width, height) * 0.54 : 230;
      if (distance > limit) continue;

      const depthFade = clamp((a.scale + b.scale) / 2, 0.55, 1.6);
      const isMemoryLink = memories.includes(a) || memories.includes(b);
      const isHoveredLink = hoveredMemory && (a === hoveredMemory || b === hoveredMemory);
      const strength =
        (1 - distance / limit) *
        (isMemoryLink ? 0.36 : 0.12) *
        depthFade *
        (isHoveredLink ? 1.9 : 1);
      const pulse = 0.72 + Math.sin(time * 0.0014 + a.phase + b.phase) * 0.28;
      const gradient = ctx.createLinearGradient(a.sx, a.sy, b.sx, b.sy);
      gradient.addColorStop(0, hexToRgba(a.color, strength * pulse));
      gradient.addColorStop(1, hexToRgba(b.color, strength * pulse));
      ctx.strokeStyle = gradient;
      ctx.lineWidth = isMemoryLink ? 1.15 + (isHoveredLink ? 0.8 : 0) : 0.65;
      const midX = (a.sx + b.sx) / 2;
      const midY = (a.sy + b.sy) / 2;
      const curve = clamp((a.depth - b.depth) * 0.08, -46, 46);
      const control = {
        x: midX - dy * 0.08,
        y: midY + dx * 0.08 + curve,
      };
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.quadraticCurveTo(control.x, control.y, b.sx, b.sy);
      ctx.stroke();

      if (isMemoryLink && strength > 0.04) {
        const t = (time * 0.00024 + a.phase * 0.11 + j * 0.037) % 1;
        const point = quadraticPoint({ x: a.sx, y: a.sy }, control, { x: b.sx, y: b.sy }, t);
        ctx.fillStyle = `rgba(247, 243, 234, ${clamp(strength * 1.8, 0.06, 0.55)})`;
        ctx.beginPath();
        ctx.arc(point.x, point.y, isHoveredLink ? 2.6 : 1.7, 0, TAU);
        ctx.fill();
      }
    }
  }
}

function drawAmbient(time) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const node of [...ambientNodes].sort((a, b) => a.depth - b.depth)) {
    const glow = 0.34 + Math.sin(time * 0.0018 + node.phase) * 0.16;
    const size = clamp(node.r * node.scale, 1.2, width < 760 ? 12 : 18);
    ctx.shadowColor = hexToRgba(node.color, 0.48);
    ctx.shadowBlur = size * 5;
    ctx.fillStyle = hexToRgba(node.color, glow * clamp(node.scale, 0.42, 1.3));
    ctx.beginPath();
    ctx.arc(node.sx, node.sy, size, 0, TAU);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexToRgba("#f7f3ea", 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(node.sx, node.sy, size + 4 * node.scale, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMemory(memory, index, time) {
  const distance = Math.hypot(pointer.x - memory.sx, pointer.y - memory.sy);
  const isHovering = distance < memory.projectedRadius + 14;
  const isSelected = index === selectedIndex;
  const hoverAmount = isHovering || isSelected ? 1 : 0;
  const pulse = Math.sin(time * 0.002 + memory.phase) * 2.2 * memory.scale;
  const size = (memory.projectedRadius + pulse + hoverAmount * 8) * 2;
  const depthAlpha = clamp(0.45 + memory.scale * 0.42, 0.42, 1);

  ctx.save();
  ctx.globalAlpha = depthAlpha;
  ctx.shadowColor = hexToRgba(memory.color, 0.5 + hoverAmount * 0.22);
  ctx.shadowBlur = 24 * memory.scale + hoverAmount * 20;
  ctx.fillStyle = hexToRgba(memory.color, 0.13);
  ctx.beginPath();
  ctx.arc(memory.sx, memory.sy, size * 0.58, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(memory.sx, memory.sy, size / 2, 0, TAU);
  ctx.clip();

  if (memory.image?.complete && memory.image.naturalWidth > 0) {
    drawImageCover(memory.image, memory.sx, memory.sy, size);
  } else {
    const gradient = ctx.createLinearGradient(memory.sx - size / 2, memory.sy - size / 2, memory.sx + size / 2, memory.sy + size / 2);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.96)");
    gradient.addColorStop(0.54, hexToRgba(memory.color, 0.66));
    gradient.addColorStop(1, "rgba(42, 41, 39, 0.55)");
    ctx.fillStyle = gradient;
    ctx.fillRect(memory.sx - size / 2, memory.sy - size / 2, size, size);
  }

  const shade = ctx.createRadialGradient(
    memory.sx - size * 0.18,
    memory.sy - size * 0.22,
    size * 0.05,
    memory.sx,
    memory.sy,
    size * 0.62,
  );
  shade.addColorStop(0, "rgba(255, 255, 255, 0.34)");
  shade.addColorStop(0.45, "rgba(255, 255, 255, 0.02)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = shade;
  ctx.fillRect(memory.sx - size / 2, memory.sy - size / 2, size, size);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = depthAlpha;
  ctx.lineWidth = 2.2 + hoverAmount * 1.4;
  ctx.strokeStyle = index % 2 === 0 ? "rgba(255, 255, 255, 0.86)" : "rgba(215, 209, 197, 0.82)";
  ctx.beginPath();
  ctx.arc(memory.sx, memory.sy, size / 2 + 3, 0, TAU);
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.52)";
  ctx.beginPath();
  ctx.arc(memory.sx, memory.sy, size / 2 + 8 + pulse * 0.4, 0, TAU);
  ctx.stroke();
  ctx.restore();

  drawYearLabel(memory, hoverAmount);
  drawRemoveButton(memory, hoverAmount);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function animate(time = 0) {
  ctx.clearRect(0, 0, width, height);

  if (!dragState) {
    targetRotation.yaw += 0.0011;
  }
  rotation.yaw += (targetRotation.yaw - rotation.yaw) * 0.12;
  rotation.pitch += (targetRotation.pitch - rotation.pitch) * 0.12;
  projectScene();

  const allNodes = memories.length ? [...ambientNodes, ...memories] : ambientNodes;
  const hoveredIndex = getHoveredMemoryIndex();
  drawNebula(time);
  drawNeuralCore(time);
  drawConnections(allNodes, time, hoveredIndex);
  drawAmbient(time);

  memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => a.memory.depth - b.memory.depth)
    .forEach(({ memory, index }) => drawMemory(memory, index, time));
  const canRemove = getRemoveButtonIndex() >= 0;
  canvas.style.cursor = dragState ? "grabbing" : canRemove || getHoveredMemoryIndex() >= 0 ? "pointer" : "grab";
  requestAnimationFrame(animate);
}

function getHoveredMemoryIndex() {
  const candidates = memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => b.memory.depth - a.memory.depth);

  for (const { memory, index } of candidates) {
    const touchPadding = isLargeTouchPhone() ? 22 : 14;
    if (Math.hypot(pointer.x - memory.sx, pointer.y - memory.sy) < memory.projectedRadius + touchPadding) return index;
  }
  return -1;
}

function getRemoveButtonIndex() {
  const candidates = memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => b.memory.depth - a.memory.depth);

  for (const { memory, index } of candidates) {
    const button = getRemoveButton(memory);
    if (Math.hypot(pointer.x - button.x, pointer.y - button.y) <= button.r + (isLargeTouchPhone() ? 10 : 5)) return index;
  }
  return -1;
}

function openMemory(index) {
  if (!memories[index]) return;
  clearTimeout(textSaveTimer);
  selectedIndex = index;
  const memory = memories[index];
  const text = getMemoryText(memory);
  selectedPhoto.src = memory.src;
  selectedPhoto.alt = text || "Recuerdo";
  selectedTitle.value = text;
  selectedYear.textContent = memory.year ? String(memory.year) : "Año por confirmar";
  selectedSource.textContent = memory.sourceLabel || "Año pendiente";
  panel.classList.add("is-open");
}

function closeMemory() {
  if (selectedIndex >= 0) {
    clearTimeout(textSaveTimer);
    void saveSelectedMemoryText({ silent: true });
  }
  selectedIndex = -1;
  panel.classList.remove("is-open");
}

function showRelativeMemory(direction) {
  if (!memories.length) return;
  if (selectedIndex >= 0) {
    clearTimeout(textSaveTimer);
    void saveSelectedMemoryText({ silent: true });
  }
  const current = selectedIndex >= 0 ? selectedIndex : 0;
  const next = (current + direction + memories.length) % memories.length;
  openMemory(next);
}

async function removeMemory(index) {
  const memory = memories[index];
  if (!memory) return;
  closeMemory();

  if (backendMode && authenticated) {
    await removeBackendMemory(index).catch((error) => showToast(error.message));
    return;
  }

  memories.splice(index, 1);

  if (memory.local) {
    try {
      await deleteMemoryRecord(memory.id);
    } catch (error) {
      console.warn("No se pudo quitar del guardado local.", error);
    }
  } else {
    const hidden = readHiddenPresetIds();
    hidden.add(memory.id);
    saveHiddenPresetIds(hidden);
  }

  if (memory.src?.startsWith("blob:")) URL.revokeObjectURL(memory.src);
  layoutMemories(true);
  updateStatus();
  showToast("Foto quitada.");
}

async function persistMemoryText(memory, rawText, { silent = false, syncField = true } = {}) {
  if (!memory) return;
  const text = cleanMemoryText(rawText);
  memory.title = text;

  if (syncField && memory === memories[selectedIndex]) {
    selectedTitle.value = text;
    selectedPhoto.alt = text || "Recuerdo";
  }

  if (!syncField && memory === memories[selectedIndex]) {
    selectedPhoto.alt = text || "Recuerdo";
  }

  try {
    if (backendMode && authenticated && memory.server) {
      await updateBackendMemoryText(memory.id, text);
    } else if (memory.local) {
      await updateMemoryRecordTitle(memory.id, text);
    } else {
      saveEditedText(memory.id, text);
    }
    if (!silent) showToast(text ? "Texto guardado." : "Texto limpiado.");
  } catch (error) {
    showToast(error.message || "No se pudo guardar el texto.");
  }
}

async function saveSelectedMemoryText(options = {}) {
  const memory = memories[selectedIndex];
  if (!memory) return;
  await persistMemoryText(memory, selectedTitle.value, options);
}

function queueSelectedMemoryTextSave() {
  const memory = memories[selectedIndex];
  if (!memory) return;
  const draft = selectedTitle.value;
  clearTimeout(textSaveTimer);
  textSaveTimer = setTimeout(() => {
    void persistMemoryText(memory, draft, { silent: true, syncField: false });
  }, 700);
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;

  if (backendMode && authenticated) {
    await uploadFilesToBackend(files).catch((error) => showToast(error.message));
    return;
  }

  showToast("Preparando recuerdos...");
  const prepared = (
    await Promise.all(
      files.map(async (file) => {
        try {
          return await fileToMemory(file);
        } catch (error) {
          console.warn("No se pudo preparar una foto.", error);
          return null;
        }
      }),
    )
  ).filter(Boolean);
  if (!prepared.length) {
    showToast("No pude leer esas fotos.");
    return;
  }
  let savedCount = 0;

  for (const item of prepared) {
    try {
      await saveMemoryRecord(item.record);
      savedCount += 1;
    } catch (error) {
      console.warn("No se pudo guardar una foto en este navegador.", error);
    }
  }

  const newMemories = prepared.map((item) => item.memory);
  memories = [
    ...memories,
    ...newMemories.map((memory, index) => makeMemoryNode(memory, memories.length + index, memories.length + newMemories.length)),
  ];
  layoutMemories();
  updateStatus();
  storageState.textContent = savedCount === newMemories.length ? "Guardado en este celular" : "Guardado parcial";
  showToast(
    savedCount === newMemories.length
      ? `${newMemories.length} ${newMemories.length === 1 ? "foto guardada" : "fotos guardadas"} en este celular.`
      : `${newMemories.length} ${newMemories.length === 1 ? "foto cargada" : "fotos cargadas"}; algunas no se pudieron guardar.`,
  );
}

async function fileToMemory(file) {
  const buffer = await file.arrayBuffer();
  const exifDate = extractExifDate(buffer);
  const fallbackYear = Number.isFinite(file.lastModified) ? new Date(file.lastModified).getFullYear() : null;
  const year = exifDate?.year || fallbackYear || "";
  const sourceLabel = exifDate
    ? "Año detectado desde metadatos EXIF"
    : fallbackYear
      ? "Año aproximado desde el archivo"
      : "Año pendiente";
  const blob = await compressImageFile(file);
  const src = URL.createObjectURL(blob);
  const image = await loadImage(src);
  const id = makeId();
  const title = "";
  const savedLabel = `${sourceLabel}. Guardado en este celular`;

  return {
    memory: {
      id,
      title,
      src,
      year,
      sourceLabel: savedLabel,
      image,
      local: true,
    },
    record: {
      id,
      title,
      year,
      sourceLabel: savedLabel,
      blob,
      type: blob.type || file.type || "image/jpeg",
      createdAt: Date.now(),
      originalName: file.name,
    },
  };
}

async function compressImageFile(file) {
  const previewSrc = URL.createObjectURL(file);
  try {
    const image = await loadImage(previewSrc);
    if (!image.naturalWidth || !image.naturalHeight) return file;

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvasCopy = document.createElement("canvas");
    canvasCopy.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvasCopy.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const copyCtx = canvasCopy.getContext("2d", { alpha: false });
    if (!copyCtx) return file;
    copyCtx.fillStyle = "#050505";
    copyCtx.fillRect(0, 0, canvasCopy.width, canvasCopy.height);
    copyCtx.drawImage(image, 0, 0, canvasCopy.width, canvasCopy.height);

    return await new Promise((resolve) => {
      canvasCopy.toBlob((blob) => resolve(blob || file), "image/jpeg", JPEG_QUALITY);
    });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(previewSrc);
  }
}

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB no disponible"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el guardado local"));
  });
}

function runStoreTransaction(mode, callback) {
  return openMemoryDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result;

        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error("No se pudo guardar"));
        };

        result = callback(store);
      }),
  );
}

function saveMemoryRecord(record) {
  return runStoreTransaction("readwrite", (store) => store.put(record));
}

function deleteMemoryRecord(id) {
  return runStoreTransaction("readwrite", (store) => store.delete(id));
}

function updateMemoryRecordTitle(id, title) {
  return runStoreTransaction("readwrite", (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result;
      if (record) store.put({ ...record, title, updatedAt: Date.now() });
    };
  });
}

function loadMemoryRecords() {
  return runStoreTransaction(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("No se pudo leer el guardado local"));
      }),
  );
}

async function loadSavedMemories() {
  try {
    const records = await loadMemoryRecords();
    if (!records.length) {
      storageState.textContent = "Arrastra 360";
      return [];
    }

    storageState.textContent = "Guardado en este celular";
    const ordered = records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return Promise.all(
      ordered.map(async (record) => {
        const src = URL.createObjectURL(record.blob);
        const image = await loadImage(src);
        return {
          id: record.id,
          title: record.title || "",
          src,
          year: record.year || "",
          sourceLabel: record.sourceLabel || "Guardado en este celular",
          image,
          local: true,
        };
      }),
    );
  } catch (error) {
    console.warn("El guardado local no esta disponible.", error);
    storageState.textContent = "Guardado local no disponible";
    return [];
  }
}

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(image);
    image.src = src;
  });
}

async function loadProtectedImage(src) {
  if (!backendMode || !src.startsWith("/api/")) {
    const image = await loadImage(src);
    return { src, image };
  }

  const response = await apiFetch(src, { headers: {} });
  if (!response.ok) throw new Error("No se pudo cargar una foto protegida");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const image = await loadImage(objectUrl);
  return { src: objectUrl, image, protectedObjectUrl: true };
}

function releaseMemoryUrls(list) {
  for (const memory of list) {
    if (memory.protectedObjectUrl && memory.src?.startsWith("blob:")) URL.revokeObjectURL(memory.src);
  }
}

function readAscii(view, offset, length) {
  let text = "";
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

function extractExifDate(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;

    const segmentLength = view.getUint16(offset, false);
    const segmentStart = offset + 2;

    if (marker === 0xe1 && readAscii(view, segmentStart, 4) === "Exif") {
      return parseTiffDate(view, segmentStart + 6);
    }

    offset += segmentLength;
  }

  return null;
}

function parseTiffDate(view, tiffStart) {
  const byteOrder = readAscii(view, tiffStart, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return null;

  const get16 = (relativeOffset) => view.getUint16(tiffStart + relativeOffset, littleEndian);
  const get32 = (relativeOffset) => view.getUint32(tiffStart + relativeOffset, littleEndian);
  if (get16(2) !== 42) return null;

  const firstIfdOffset = get32(4);
  const firstIfd = readIfd(view, tiffStart, firstIfdOffset, littleEndian);
  const exifOffset = firstIfd.get(0x8769);
  const dates = [];

  if (exifOffset) {
    const exifIfd = readIfd(view, tiffStart, exifOffset, littleEndian);
    dates.push(exifIfd.get(0x9003), exifIfd.get(0x9004));
  }
  dates.push(firstIfd.get(0x0132));

  for (const dateValue of dates) {
    const year = parseExifYear(dateValue);
    if (year) return { raw: dateValue, year };
  }
  return null;
}

function readIfd(view, tiffStart, relativeOffset, littleEndian) {
  const tags = new Map();
  if (!relativeOffset || tiffStart + relativeOffset + 2 >= view.byteLength) return tags;

  const get16 = (offset) => view.getUint16(offset, littleEndian);
  const get32 = (offset) => view.getUint32(offset, littleEndian);
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
    if (entry + 12 > view.byteLength) break;

    const tag = get16(entry);
    const type = get16(entry + 2);
    const count = get32(entry + 4);
    const byteCount = (typeSizes.get(type) || 1) * count;
    const valueOffset = byteCount <= 4 ? entry + 8 : tiffStart + get32(entry + 8);
    if (valueOffset < 0 || valueOffset >= view.byteLength) continue;

    if (type === 2) {
      tags.set(tag, readAscii(view, valueOffset, count).trim());
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

async function loadBackendMemories() {
  const data = await readApiJson("/api/memories");
  const loaded = await Promise.all(
    data.memories.map(async (memory) => {
      const protectedPhoto = await loadProtectedImage(memory.imageUrl);
      return {
        id: memory.id,
        title: memory.title || "",
        src: protectedPhoto.src,
        year: memory.year || "",
        sourceLabel: memory.sourceLabel || "Foto privada protegida por clave",
        image: protectedPhoto.image,
        protectedObjectUrl: protectedPhoto.protectedObjectUrl,
        server: true,
      };
    }),
  );

  releaseMemoryUrls(memories);
  memories = loaded.map((memory, index) => makeMemoryNode(memory, index, loaded.length));
  layoutMemories(true);
  updateStatus();
  storageState.textContent = loaded.length ? "Protegido con clave" : "Arrastra 360";
}

async function uploadFilesToBackend(files) {
  const formData = new FormData();
  files.forEach((file) => formData.append("photos", file, file.name));
  showToast("Subiendo fotos privadas...");
  await readApiJson("/api/memories", { method: "POST", body: formData });
  await loadBackendMemories();
  showToast(`${files.length} ${files.length === 1 ? "foto protegida" : "fotos protegidas"} en el servidor.`);
}

async function removeBackendMemory(index) {
  const memory = memories[index];
  if (!memory) return;
  await readApiJson(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
  await loadBackendMemories();
  showToast("Foto quitada del servidor.");
}

async function updateBackendMemoryText(id, title) {
  await readApiJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

async function loadPresetMemories() {
  const preset = Array.isArray(window.PHOTO_MEMORIES) ? window.PHOTO_MEMORIES : [];
  const hiddenPresetIds = readHiddenPresetIds();
  const editedTexts = readEditedTexts();
  const presetMemories = await Promise.all(
    preset
      .map((memory, index) => ({ memory, presetIndex: index, id: memory.id || `preset-${index}` }))
      .filter((item) => !hiddenPresetIds.has(item.id))
      .map(async ({ memory, presetIndex, id }) => {
        const image = await loadImage(memory.src);
        const savedText = Object.prototype.hasOwnProperty.call(editedTexts, id) ? editedTexts[id] : null;
        return {
          id,
          title: savedText ?? memory.title ?? "",
          src: memory.src,
          year: memory.year || "",
          sourceLabel: memory.sourceLabel || "Año detectado desde metadatos",
          image,
          local: false,
        };
      }),
  );

  const savedMemories = await loadSavedMemories();
  const combined = [...presetMemories, ...savedMemories];
  memories = combined.map((memory, index) => makeMemoryNode(memory, index, combined.length));
  layoutMemories(true);
  updateStatus();
}

function shuffleLayout() {
  targetRotation = { yaw: -0.45, pitch: 0.18 };
  closeMemory();
}

function handlePointerMove(event) {
  updatePointerPosition(event);

  if (!dragState) return;

  const dx = event.clientX - dragState.lastX;
  const dy = event.clientY - dragState.lastY;
  dragState.lastX = event.clientX;
  dragState.lastY = event.clientY;
  dragState.distance += Math.hypot(dx, dy);
  targetRotation.yaw += dx * 0.008;
  targetRotation.pitch = clamp(targetRotation.pitch + dy * 0.006, -1.15, 1.15);
}

function bindEvents() {
  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerleave", () => {
    if (dragState) return;
    pointer.x = -9999;
    pointer.y = -9999;
  });
  canvas.addEventListener("pointerdown", (event) => {
    updatePointerPosition(event);
    pointer.down = true;
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      distance: 0,
      pointerType: event.pointerType,
    };
    app.classList.add("is-rotating");
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointerup", (event) => {
    updatePointerPosition(event);
    pointer.down = false;
    app.classList.remove("is-rotating");
    canvas.releasePointerCapture?.(event.pointerId);
    const touchLike = dragState?.pointerType === "touch" || isLargeTouchPhone();
    const directDistance = dragState ? Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) : 0;
    const tapDistance = Math.max(directDistance, dragState?.distance || 0);
    const wasTap = !dragState || tapDistance < (touchLike ? 24 : 10);
    const removeIndex = getRemoveButtonIndex();
    const hoveredIndex = getHoveredMemoryIndex();
    if (wasTap && removeIndex >= 0) {
      removeMemory(removeIndex);
    } else if (wasTap && hoveredIndex >= 0) {
      openMemory(hoveredIndex);
    }
    dragState = null;
  });
  canvas.addEventListener("pointercancel", (event) => {
    pointer.down = false;
    dragState = null;
    app.classList.remove("is-rotating");
    canvas.releasePointerCapture?.(event.pointerId);
  });

  photoInput.addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });
  heroPhotoInput.addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });
  shuffleButton.addEventListener("click", shuffleLayout);
  closePanelButton.addEventListener("click", closeMemory);
  previousButton.addEventListener("click", () => showRelativeMemory(-1));
  nextButton.addEventListener("click", () => showRelativeMemory(1));
  saveTextButton.addEventListener("click", () => saveSelectedMemoryText());
  deleteMemoryButton.addEventListener("click", () => {
    if (selectedIndex >= 0) removeMemory(selectedIndex);
  });
  selectedTitle.addEventListener("input", queueSelectedMemoryTextSave);
  selectedTitle.addEventListener("blur", () => saveSelectedMemoryText({ silent: true }));
  selectedTitle.addEventListener("keydown", (event) => event.stopPropagation());
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authMessage.textContent = "Entrando...";
    try {
      await readApiJson("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: authPassword.value }),
      });
      authenticated = true;
      hideAuth();
      await loadBackendMemories();
    } catch (error) {
      authMessage.textContent = error.message;
    }
  });

  document.addEventListener("contextmenu", (event) => {
    if (backendMode && (event.target === canvas || event.target.closest?.("#memoryPanel"))) event.preventDefault();
  });
  selectedPhoto.addEventListener("dragstart", (event) => event.preventDefault());

  window.addEventListener("keydown", (event) => {
    if (event.target === selectedTitle) return;
    if (event.key === "Escape") closeMemory();
    if (event.key === "ArrowLeft") showRelativeMemory(-1);
    if (event.key === "ArrowRight") showRelativeMemory(1);
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    app.classList.add("is-dragging");
  });
  window.addEventListener("dragleave", () => app.classList.remove("is-dragging"));
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    app.classList.remove("is-dragging");
    addFiles(event.dataTransfer.files);
  });
}

async function initializeApp() {
  resizeCanvas();
  bindEvents();

  if (window.location.protocol !== "file:") {
    try {
      const session = await readApiJson("/api/session");
      backendMode = true;
      authenticated = Boolean(session.authenticated);
      if (authenticated) {
        hideAuth();
        await loadBackendMemories();
      } else {
        showAuth();
        updateStatus();
      }
    } catch {
      backendMode = false;
      await loadPresetMemories();
    }
  } else {
    await loadPresetMemories();
  }

  requestAnimationFrame(animate);
}

initializeApp();
