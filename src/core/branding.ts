// Portal appearance (node-admin.yaml: branding.theme, branding.login, branding.home, branding images,
// favicon). Every member is optional; null means the node's default look. Unknown members of theme,
// login and home, and blocks of an unknown type, are stored and returned unchanged (forward
// compatible); only the members this node knows are validated.
import type { Ctx } from "./ctx";
import type { V } from "./validate";
import { isPlainObject } from "../lib/util";
import { placeholders } from "./read";

export const FONTS = [
  "system",
  "inter",
  "dm-sans",
  "manrope",
  "work-sans",
  "jost",
  "space-grotesk",
  "fraunces",
  "playfair-display",
  "libre-baskerville",
  "cormorant-garamond",
] as const;

export const BLOCK_TYPES = ["hero", "tiles", "text", "image_text", "products", "announcement", "contact"] as const;

/** Limits of the contract. */
export const BRANDING_LIMITS = {
  /** Whole branding object as JSON. */
  json_bytes: 64 * 1024,
  text_chars: 2000,
  body_chars: 10000,
  blocks: 30,
  block_id_chars: 40,
  tiles: 12,
  products: 24,
  image_bytes: 10 * 1048576,
  image_side: 8000,
  images: 200,
  favicon_bytes: 1048576,
  /** Demo mode (docs/demo.md): uploads are capped by OBX_DEMO_MAX_UPLOAD_BYTES as well. */
  demo_images: 20,
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
export const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LINK_RE = /^(\/(?![/\\])|https:\/\/[^/\s])\S*$/;
const UNKNOWN_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const COLOR_KEYS = ["primary", "secondary", "background", "surface", "text"] as const;

export interface BrandingImageRow {
  id: string;
  sha256: string;
  content_type: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}

export const imageUrl = (id: string) => `/admin/api/public/images/${encodeURIComponent(id)}`;

export function imageJson(r: BrandingImageRow) {
  return { id: r.id, url: imageUrl(r.id), width: r.width, height: r.height, bytes: r.bytes, content_type: r.content_type, created_at: r.created_at };
}

type Obj = Record<string, unknown>;

/** Every image id the branding refers to (any `image` / `background_image` member, also in unknown blocks). */
export function referencedImages(branding: Obj): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) for (const y of x) walk(y);
    else if (isPlainObject(x))
      for (const [k, v] of Object.entries(x)) {
        if ((k === "image" || k === "background_image") && typeof v === "string") out.add(v);
        else walk(v);
      }
  };
  walk({ theme: branding.theme, login: branding.login, home: branding.home });
  return out;
}

/**
 * Validates theme, login and home of the merged settings (V collects the errors; nothing is changed).
 * Known image positions must name an existing image (`imageExists`).
 */
export function validateAppearance(v: V, b: Obj, imageExists: (id: string) => boolean) {
  const text = (val: unknown, p: string, max: number = BRANDING_LIMITS.text_chars) => {
    if (val === undefined || val === null) return;
    const l = v.localized(val, p);
    if (l) for (const [k, s] of Object.entries(l)) if (s.length > max) v.err(`${p}/${k}`, `At most ${max} characters.`);
  };
  const hex = (val: unknown, p: string) => {
    if (val === undefined || val === null) return;
    if (typeof val !== "string" || !HEX.test(val)) v.err(p, "Use a colour like #1F4E5F.");
  };
  const image = (val: unknown, p: string) => {
    if (val === undefined || val === null) return;
    if (typeof val !== "string" || !IMAGE_ID_RE.test(val) || !imageExists(val)) v.err(p, "Unknown image. Upload it first (POST /admin/api/settings/images) and use its id.");
  };
  const link = (val: unknown, p: string) => {
    if (val === undefined || val === null) return;
    if (typeof val !== "string" || val.length > 2000 || !LINK_RE.test(val))
      v.err(p, "Use a portal path starting with a single / (e.g. /catalog?item_type=sweater) or an https:// address.");
  };
  const plain = (val: unknown, p: string, max: number) => {
    if (val === undefined || val === null) return;
    if (typeof val !== "string" || val.length > max) v.err(p, `Must be text of at most ${max} characters.`);
  };
  const obj = (val: unknown, p: string): Obj | null => {
    if (val === undefined || val === null) return null;
    if (!isPlainObject(val)) {
      v.err(p, "Must be an object or null.");
      return null;
    }
    return val;
  };

  const theme = obj(b.theme, "/branding/theme");
  if (theme) {
    v.enumv(theme.color_scheme, "/branding/theme/color_scheme", ["light", "dark", "auto"]);
    const colors = obj(theme.colors, "/branding/theme/colors");
    if (colors) for (const k of COLOR_KEYS) hex(colors[k], `/branding/theme/colors/${k}`);
    v.enumv(theme.heading_font, "/branding/theme/heading_font", FONTS);
    v.enumv(theme.body_font, "/branding/theme/body_font", FONTS);
    v.enumv(theme.radius, "/branding/theme/radius", ["none", "small", "medium", "large"]);
    v.enumv(theme.grid_density, "/branding/theme/grid_density", ["compact", "comfortable", "editorial"]);
    v.enumv(theme.card_style, "/branding/theme/card_style", ["plain", "bordered", "elevated"]);
    v.enumv(theme.image_fit, "/branding/theme/image_fit", ["contain", "cover"]);
    hex(theme.image_background, "/branding/theme/image_background");
  }

  const login = obj(b.login, "/branding/login");
  if (login) {
    v.enumv(login.layout, "/branding/login/layout", ["centered", "split"]);
    image(login.background_image, "/branding/login/background_image");
    text(login.title, "/branding/login/title");
    text(login.text, "/branding/login/text");
  }

  const home = obj(b.home, "/branding/home");
  if (home && home.blocks !== undefined && home.blocks !== null) {
    if (!Array.isArray(home.blocks)) v.err("/branding/home/blocks", "Must be a list of blocks.");
    else {
      if (home.blocks.length > BRANDING_LIMITS.blocks) v.err("/branding/home/blocks", `At most ${BRANDING_LIMITS.blocks} blocks.`);
      const ids = new Set<string>();
      home.blocks.forEach((raw, i) => {
        const p = `/branding/home/blocks/${i}`;
        if (!isPlainObject(raw)) return v.err(p, "Must be an object.");
        const blk = raw;
        if (typeof blk.id !== "string" || !blk.id || blk.id.length > BRANDING_LIMITS.block_id_chars) v.err(`${p}/id`, `Must be text of 1 to ${BRANDING_LIMITS.block_id_chars} characters.`);
        else if (ids.has(blk.id)) v.err(`${p}/id`, "Another block already has this id.");
        else ids.add(blk.id);
        if (typeof blk.type !== "string" || !blk.type) return v.err(`${p}/type`, "This field is required.");
        switch (blk.type) {
          case "hero":
            image(blk.image, `${p}/image`);
            text(blk.title, `${p}/title`);
            text(blk.text, `${p}/text`);
            text(blk.button_label, `${p}/button_label`);
            link(blk.link, `${p}/link`);
            v.enumv(blk.align, `${p}/align`, ["left", "center"]);
            v.enumv(blk.height, `${p}/height`, ["medium", "large"]);
            v.enumv(blk.overlay, `${p}/overlay`, ["none", "dark", "light"]);
            break;
          case "tiles": {
            text(blk.title, `${p}/title`);
            if (!Array.isArray(blk.items) || blk.items.length < 1 || blk.items.length > BRANDING_LIMITS.tiles) v.err(`${p}/items`, `List 1 to ${BRANDING_LIMITS.tiles} tiles.`);
            else
              blk.items.forEach((it, j) => {
                const q = `${p}/items/${j}`;
                if (!isPlainObject(it)) return v.err(q, "Must be an object.");
                image(it.image, `${q}/image`);
                text(it.title, `${q}/title`);
                link(it.link, `${q}/link`);
              });
            if (blk.columns !== undefined && blk.columns !== null && ![2, 3, 4].includes(blk.columns as number)) v.err(`${p}/columns`, "Must be 2, 3 or 4.");
            break;
          }
          case "text":
            text(blk.title, `${p}/title`);
            text(blk.body, `${p}/body`, BRANDING_LIMITS.body_chars);
            break;
          case "image_text":
            image(blk.image, `${p}/image`);
            text(blk.title, `${p}/title`);
            text(blk.text, `${p}/text`);
            text(blk.button_label, `${p}/button_label`);
            link(blk.link, `${p}/link`);
            v.enumv(blk.image_side, `${p}/image_side`, ["left", "right"]);
            break;
          case "products":
            text(blk.title, `${p}/title`);
            if (blk.style_numbers !== undefined && blk.style_numbers !== null) {
              const sn = blk.style_numbers;
              if (!Array.isArray(sn) || sn.length > BRANDING_LIMITS.products || sn.some((x) => typeof x !== "string" || !x || x.length > 100))
                v.err(`${p}/style_numbers`, `List at most ${BRANDING_LIMITS.products} style numbers.`);
            }
            plain(blk.query, `${p}/query`, 2000);
            if (typeof blk.query === "string" && /[?#\s]/.test(blk.query)) v.err(`${p}/query`, "The query string without the leading ?, e.g. season=AW26&qualifier=organic.");
            v.int(blk.max, `${p}/max`, 1, BRANDING_LIMITS.products);
            break;
          case "announcement":
            text(blk.text, `${p}/text`);
            v.enumv(blk.tone, `${p}/tone`, ["neutral", "info", "success"]);
            break;
          case "contact":
            text(blk.title, `${p}/title`);
            plain(blk.name, `${p}/name`, 200);
            if (blk.email !== undefined && blk.email !== null && blk.email !== "") v.email(blk.email, `${p}/email`);
            plain(blk.phone, `${p}/phone`, 50);
            break;
          default:
            // A type from a later version: stored and returned as it is.
            if (!UNKNOWN_TYPE_RE.test(blk.type)) v.err(`${p}/type`, "A block type is lower case letters, digits and _ (at most 40).");
        }
      });
    }
  }
}

/** Image ids of `ids` that exist. */
export async function existingImages(ctx: Ctx, ids: Iterable<string>): Promise<Set<string>> {
  const list = [...new Set(ids)];
  const out = new Set<string>();
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    for (const r of await ctx.db.all<{ id: string }>(`SELECT id FROM branding_images WHERE id IN (${placeholders(chunk.length)})`, chunk)) out.add(r.id);
  }
  return out;
}

/** A copy of `x` where every `image` / `background_image` id also gets its URL (`image_url` / `background_image_url`). */
export function withImageUrls<T>(x: T): T {
  if (Array.isArray(x)) return x.map(withImageUrls) as T;
  if (!isPlainObject(x)) return x;
  const out: Obj = {};
  for (const [k, v] of Object.entries(x)) {
    out[k] = withImageUrls(v);
    if (k === "image" || k === "background_image") out[`${k}_url`] = typeof v === "string" && v ? imageUrl(v) : null;
  }
  return out as T;
}

/**
 * theme / login / home as returned by the API: null when not set, else every known member (null when
 * not set; a merge patch drops nulls when it is stored) plus the unknown members as stored.
 */
export function appearanceJson(b: { theme: Obj | null; login: Obj | null; home: Obj | null }) {
  const theme = isPlainObject(b.theme)
    ? {
        color_scheme: null,
        heading_font: null,
        body_font: null,
        radius: null,
        grid_density: null,
        card_style: null,
        image_fit: null,
        image_background: null,
        ...b.theme,
        colors: isPlainObject(b.theme.colors) ? { ...Object.fromEntries(COLOR_KEYS.map((k) => [k, null])), ...b.theme.colors } : null,
      }
    : null;
  const login = isPlainObject(b.login) ? { layout: null, background_image: null, title: null, text: null, ...b.login } : null;
  const home = isPlainObject(b.home) ? { ...b.home, blocks: Array.isArray(b.home.blocks) ? b.home.blocks : [] } : null;
  return { theme, login, home };
}

/** Drops the resolved URLs (`image_url`, `background_image_url`) a client sent back: the node sets them. */
export function withoutImageUrls<T>(x: T): T {
  if (Array.isArray(x)) return x.map(withoutImageUrls) as T;
  if (!isPlainObject(x)) return x;
  const out: Obj = {};
  for (const [k, v] of Object.entries(x)) if (k !== "image_url" && k !== "background_image_url") out[k] = withoutImageUrls(v);
  return out as T;
}
