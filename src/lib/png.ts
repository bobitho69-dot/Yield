// Minimal PNG decoder + box downscaler for AI-generated textures. Cloudflare
// Workers have no canvas/image codecs, but Roblox Studio can only build textures
// from RAW pixels (EditableImage:WritePixelsBuffer) — the engine never fetches
// external image URLs. So the Worker decodes the generated PNG itself and ships
// RGBA bytes to the plugin.
//
// Scope: exactly what image-gen providers emit — 8-bit, non-interlaced PNG in
// grayscale / RGB / palette / gray+alpha / RGBA. Anything else returns null (the
// caller treats a null as "no texture this time", never an error).

export interface DecodedImage { width: number; height: number; rgba: Uint8Array }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 4_500_000; // ~2048x2048 — bounds worker CPU/memory on hostile input

function concatChunks(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function inflateZlib(compressed: Uint8Array): Promise<Uint8Array | null> {
  try {
    const body = new Response(compressed as unknown as BodyInit).body;
    if (!body) return null;
    const raw = await new Response(body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

// In-place PNG scanline unfilter (spec filters 0-4: None, Sub, Up, Average, Paeth).
function unfilter(f: number, cur: Uint8Array, prev: Uint8Array, bpp: number): boolean {
  const n = cur.length;
  if (f === 0) return true;
  if (f === 1) { for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; return true; }
  if (f === 2) { for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 0xff; return true; }
  if (f === 3) {
    for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0; cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff; }
    return true;
  }
  if (f === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
    return true;
  }
  return false; // unknown filter byte — corrupt stream
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedImage | null> {
  try {
    if (bytes.length < 45) return null;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];

    let ptr = 8;
    while (ptr + 8 <= bytes.length) {
      const len = dv.getUint32(ptr);
      const type = String.fromCharCode(bytes[ptr + 4], bytes[ptr + 5], bytes[ptr + 6], bytes[ptr + 7]);
      const dataStart = ptr + 8;
      if (len > bytes.length || dataStart + len > bytes.length) return null;
      if (type === 'IHDR') {
        width = dv.getUint32(dataStart);
        height = dv.getUint32(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlace = bytes[dataStart + 12];
      } else if (type === 'PLTE') palette = bytes.subarray(dataStart, dataStart + len);
      else if (type === 'tRNS') trns = bytes.subarray(dataStart, dataStart + len);
      else if (type === 'IDAT') idat.push(bytes.subarray(dataStart, dataStart + len));
      else if (type === 'IEND') break;
      ptr = dataStart + len + 4; // + CRC
    }

    if (!width || !height || bitDepth !== 8 || interlace !== 0 || !idat.length) return null;
    if (width * height > MAX_PIXELS) return null;
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!channels) return null;
    if (colorType === 3 && !palette) return null;

    const raw = await inflateZlib(concatChunks(idat));
    if (!raw) return null;
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;

    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(stride); // zeroed = spec's "row above first row"
    const cur = new Uint8Array(stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      cur.set(raw.subarray(pos, pos + stride));
      pos += stride;
      if (!unfilter(filter, cur, prev, channels)) return null;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const i = x * channels;
        if (colorType === 0) { const g = cur[i]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255; }
        else if (colorType === 2) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = 255; }
        else if (colorType === 3) {
          const idx = cur[i], p = idx * 3;
          out[o] = palette![p] ?? 0; out[o + 1] = palette![p + 1] ?? 0; out[o + 2] = palette![p + 2] ?? 0;
          out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 4) { const g = cur[i]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = cur[i + 1]; }
        else { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = cur[i + 3]; }
      }
      prev.set(cur);
    }
    return { width, height, rgba: out };
  } catch {
    return null;
  }
}

/** Box-average downscale so the pixels shipped to Studio stay small (KV/HTTP/EditableImage
 *  budgets). Integer bin size keeps it fast and artifact-free for power-of-two inputs. */
export function downscaleRgba(img: DecodedImage, maxSide: number): DecodedImage {
  const { width, height, rgba } = img;
  if (width <= maxSide && height <= maxSide) return img;
  const scale = Math.ceil(Math.max(width, height) / maxSide);
  const w = Math.max(1, Math.floor(width / scale));
  const h = Math.max(1, Math.floor(height / scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let dy = 0; dy < scale; dy++) {
        const sy = y * scale + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < scale; dx++) {
          const sx = x * scale + dx;
          if (sx >= width) break;
          const i = (sy * width + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; cnt++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt; out[o + 3] = a / cnt;
    }
  }
  return { width: w, height: h, rgba: out };
}
