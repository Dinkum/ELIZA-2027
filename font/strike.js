const FONT_STACK = '"CTSS Correspondence 938", "CTSS Correspondence Extended", monospace';
const IMPRESSION_STACK = '"CTSS Correspondence 938 Impression", "CTSS Correspondence Extended", monospace';

function hash(seed, index, char) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ char.codePointAt(0)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function unit(value) {
  return value / 0xffffffff;
}

function bounded(value) {
  return Math.max(0, Math.min(1, value));
}

function normalize(text, mapBackslashToCent) {
  const normalized = String(text).replace(/\r\n?/g, "\n");
  return mapBackslashToCent ? normalized.replace(/\\/g, "¢") : normalized;
}

/** Draw fixed-pitch type impressions on a canvas. All dimensions are CSS pixels. */
export function renderStrike(canvas, text, options = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError("renderStrike expects a canvas element");
  }
  const size = options.size ?? 16;
  const pitch = options.pitch ?? size * 0.6; // 10 characters per inch at 96 px/in when size is 16.
  const lineAdvance = options.lineAdvance ?? size; // 6 lines per inch at size 16.
  const margin = options.margin ?? size * 2;
  const paper = options.paper ?? "#f4efe3";
  const ink = options.ink ?? [37, 34, 30];
  const ribbonWear = bounded(options.ribbonWear ?? options.texture ?? 0);
  const strikeVariation = bounded(options.strikeVariation ?? 0);
  const seed = options.seed ?? 938;
  const output = normalize(text, options.mapBackslashToCent ?? false);
  const lines = output.split("\n");
  const columns = Math.max(1, ...lines.map((line) => [...line].length));
  const width = options.width ?? Math.ceil(margin * 2 + columns * pitch);
  const height = options.height ?? Math.ceil(margin * 2 + lines.length * lineAdvance);
  const dpr = Math.max(1, options.pixelRatio ?? window.devicePixelRatio ?? 1);

  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = paper;
  context.fillRect(0, 0, width, height);
  context.font = `${size}px ${options.face === "impression" ? IMPRESSION_STACK : FONT_STACK}`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";

  let impression = 0;
  lines.forEach((line, row) => {
    [...line].forEach((char, column) => {
      if (char === " ") return;
      const value = hash(seed, impression++, char);
      // Ribbon condition and strike registration vary independently. Neither
      // alters the type element's outline.
      const density = 1 - ribbonWear * (0.04 + unit(value) * 0.13);
      const dx = (unit(hash(value, 1, char)) - 0.5) * strikeVariation * 0.55;
      const dy = (unit(hash(value, 2, char)) - 0.5) * strikeVariation * 0.45;
      const x = margin + column * pitch + dx;
      const y = margin + (row + 0.78) * lineAdvance + dy;

      context.fillStyle = `rgba(${ink.join(",")},${density})`;
      context.fillText(char, x, y);

      // Optional incomplete ink transfer, not an element-level defect.
      if (ribbonWear > 0) {
        context.fillStyle = paper;
        const count = unit(hash(value, 3, char)) > 0.4 ? 2 : 1;
        for (let n = 0; n < count; n++) {
          const sx = x + pitch * unit(hash(value, 4 + n * 2, char));
          const sy = y - size * (0.15 + 0.57 * unit(hash(value, 5 + n * 2, char)));
          const diameter = ribbonWear * (0.22 + 0.22 * unit(hash(value, 8 + n, char)));
          context.fillRect(sx, sy, diameter, diameter);
        }
      }
    });
  });
  return { width, height, pitch, lineAdvance };
}

/** Animate printing. Timing is adjustable because carrier return varies by setup. */
export function playStrike(canvas, text, options = {}) {
  const output = normalize(text, options.mapBackslashToCent ?? false);
  const chars = [...output];
  const size = options.size ?? 16;
  const pitch = options.pitch ?? size * 0.6;
  const lineAdvance = options.lineAdvance ?? size;
  const margin = options.margin ?? size * 2;
  const lines = output.split("\n");
  const fixedOptions = {
    ...options,
    width: options.width ?? Math.ceil(margin * 2 + Math.max(1, ...lines.map((line) => [...line].length)) * pitch),
    height: options.height ?? Math.ceil(margin * 2 + lines.length * lineAdvance),
  };
  const characterDelay = 1000 / (options.charactersPerSecond ?? 14.8);
  const returnDelay = options.returnDelay ?? 300;
  let index = 0;
  let timer;
  let cancelled = false;
  const frame = () => {
    if (cancelled) return;
    const next = chars[index++];
    renderStrike(canvas, chars.slice(0, index).join(""), fixedOptions);
    if (index < chars.length) {
      timer = window.setTimeout(frame, next === "\n" ? returnDelay : characterDelay);
    }
  };
  renderStrike(canvas, "", fixedOptions);
  timer = window.setTimeout(frame, characterDelay);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
