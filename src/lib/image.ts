// Magic-byte sniffing and header-only dimension parsing for JPEG, PNG and WebP (no decoding).

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageType = (typeof ACCEPTED_TYPES)[number];

export function sniffType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function extForType(t: string): string {
  return t === "image/png" ? "png" : t === "image/webp" ? "webp" : "jpg";
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  try {
    if (type === "image/png") {
      if (b.length < 24) return null;
      return { width: u32be(b, 16), height: u32be(b, 20) };
    }
    if (type === "image/webp") {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
      if (chunk === "VP8L") {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      return null;
    }
    // JPEG: walk markers until a SOFn marker.
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null;
      const len = u16be(b, o + 2);
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSof) {
        if (o + 9 > b.length) return null;
        return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
      }
      o += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a tiny structurally valid JPEG header of the given size (tests and placeholders). */
export function fakeJpeg(width: number, height: number, seed = 0): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const com = [0xff, 0xfe, 0x00, 0x06, seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff, (seed >> 24) & 0xff];
  return new Uint8Array([0xff, 0xd8, ...com, ...sof, 0xff, 0xd9]);
}
