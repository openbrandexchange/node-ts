// Procedural art for the demo showroom (docs/demo.md): editorial hero and login images, category
// tiles, a material close-up and product shots, drawn as SVG and rendered with rsvg-convert and
// ImageMagick (grain, JPEG). No photos, nothing downloaded; the same input always gives the same image.
// Demo content only: the spec fixtures (test/fixtures/maison-noor) stay as they are.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Colours of the fixture colour codes, a little muted for the studio look. */
export const COLORS: Record<string, string> = {
  NVY: "#232c45",
  OAT: "#d9ccb4",
  BLK: "#1f1e1d",
  OLV: "#5d5f3f",
  WHT: "#f1eee8",
  RST: "#a2573a",
  IND: "#2e3d5f",
  COG: "#9b5e33",
  CHR: "#3b3e41",
  BRN: "#4b3428",
  YLW: "#d9b04a",
};

/** The showroom palette (MAISON NOOR: ink, ivory, stone, a warm taupe). */
export const PALETTE = { ink: "#1b1a19", ivory: "#f6f3ee", stone: "#e7e1d8", taupe: "#8b7d6e", sand: "#cfc4b4", clay: "#a8927b" };

// ------------------------------------------------------------------ helpers

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
};
const shade = (c: string, t: number) => (t < 0 ? mix(c, "#000000", -t) : mix(c, "#ffffff", t));
const lum = (c: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function svg(w: number, h: number, body: string, viewBox = `0 0 ${w} ${h}`) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}">${body}</svg>`;
}

/** Fabric texture + soft light for a garment: fill, a fibre noise and a highlight, clipped to the shape. */
function garment(id: string, d: string, color: string, o: { fibre?: number; seed?: number; light?: "left" | "top" } = {}) {
  const fibre = o.fibre ?? 0.85;
  const light = o.light === "top" ? 'x1="0" y1="0" x2="0" y2="1"' : 'x1="0" y1="0" x2="1" y2="0.35"';
  const dark = lum(color) < 0.12;
  return `
  <defs>
    <clipPath id="c-${id}"><path d="${d}"/></clipPath>
    <linearGradient id="l-${id}" ${light}>
      <stop offset="0" stop-color="#ffffff" stop-opacity="${dark ? 0.16 : 0.22}"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${dark ? 0.25 : 0.2}"/>
    </linearGradient>
    <filter id="f-${id}" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="${fibre} ${fibre * 0.35}" numOctaves="2" seed="${o.seed ?? 3}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 ${dark ? 1 : 0}  0 0 0 0 ${dark ? 1 : 0}  0 0 0 0 ${dark ? 1 : 0}  0 0 0 0.55 -0.12"/>
    </filter>
    <filter id="s-${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <path d="${d}" fill="#000" opacity="0.16" transform="translate(10 18)" filter="url(#s-${id})"/>
  <path d="${d}" fill="${color}"/>
  <g clip-path="url(#c-${id})">
    <rect x="0" y="0" width="2400" height="2400" filter="url(#f-${id})" opacity="${dark ? 0.12 : 0.18}"/>
    <rect x="0" y="0" width="2400" height="2400" fill="url(#l-${id})"/>
  </g>`;
}

/** A darker or lighter line in the colour of the garment (seams, ribs, stitching). */
const seam = (d: string, color: string, t = -0.25, w = 3, extra = "") => `<path d="${d}" fill="none" stroke="${shade(color, t)}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const stitch = (d: string, color = "#c49a5a", w = 2.5) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-dasharray="9 7" stroke-linecap="round"/>`;
const ribs = (x1: number, x2: number, y1: number, y2: number, color: string, step = 12) => {
  let s = "";
  for (let x = x1 + step / 2; x < x2; x += step) s += `M${x.toFixed(1)} ${y1}V${y2}`;
  return seam(s, color, -0.18, 2);
};

/** Off-white studio: soft vignette and a floor shadow. */
function studio(w: number, h: number, shadow: { cx: number; cy: number; rx: number; ry: number } | null) {
  return `
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#f6f4f0"/><stop offset="0.7" stop-color="#efece6"/><stop offset="1" stop-color="#e4dfd7"/>
    </radialGradient>
    <filter id="floor" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${shadow ? `<ellipse cx="${shadow.cx}" cy="${shadow.cy}" rx="${shadow.rx}" ry="${shadow.ry}" fill="#5a5148" opacity="0.18" filter="url(#floor)"/>` : ""}`;
}

// ------------------------------------------------------------------ garments (1200 x 1500 canvas)

type View = "front" | "back" | "side" | "inside" | "detail" | "model";

function sweater(c: string, view: View) {
  const neck = view === "back" ? "Q600 372 670 342" : "Q600 410 670 342";
  const d = `M530 342 ${neck} L812 376 Q842 386 852 418 L1012 900 L936 938 L812 590 L816 1132 L384 1132 L388 590 L264 938 L188 900 L348 418 Q358 386 388 376 Z`;
  return (
    garment("sw", d, c, { fibre: 1.1, seed: 5 }) +
    seam(view === "back" ? "M528 344 Q600 380 672 344" : "M528 344 Q600 418 672 344", c, -0.3, 16) +
    `<g opacity="0.9">${ribs(386, 814, 1090, 1130, c, 11)}</g>` +
    seam("M386 1088 H814", c, -0.25, 3) +
    seam("M200 892 L270 926 M1000 892 L930 926", c, -0.3, 10) +
    seam("M388 590 L360 430 M812 590 L840 430", c, -0.18, 2.5) +
    (view === "front" ? seam("M600 470 V1080", c, -0.06, 1.5, 'stroke-dasharray="2 10"') : "")
  );
}

function tee(c: string, view: View) {
  const neck = view === "back" ? "Q600 382 668 360" : "Q600 420 668 360";
  const d = `M532 360 ${neck} L806 386 Q830 392 842 410 L972 530 L884 612 L804 548 L806 1110 L394 1110 L396 548 L316 612 L228 530 L358 410 Q370 392 394 386 Z`;
  return (
    garment("te", d, c, { fibre: 1.4, seed: 7 }) +
    seam(view === "back" ? "M530 362 Q600 390 670 362" : "M530 362 Q600 428 670 362", c, -0.22, 10) +
    seam("M396 1086 H804", c, -0.18, 2) +
    seam("M240 540 L326 600 M960 540 L874 600", c, -0.18, 2) +
    seam("M396 548 L384 420 M804 548 L816 420", c, -0.14, 2)
  );
}

function jacket(c: string, view: View, hood = false) {
  const d = `M520 338 Q600 368 680 338 L822 372 Q856 384 866 420 L1030 930 L950 966 L824 610 L830 1200 L370 1200 L376 610 L250 966 L170 930 L334 420 Q344 384 378 372 Z`;
  let s = garment("ja", d, c, { fibre: 0.7, seed: 11 });
  if (hood)
    s += view === "back"
      ? garment("ho", "M500 350 Q500 210 600 205 Q700 210 700 350 Q600 380 500 350 Z", shade(c, -0.04), { seed: 12 })
      : garment("ho", "M482 360 Q466 192 600 186 Q734 192 718 360 Z", shade(c, -0.04), { seed: 12 }) +
        `<path d="M528 352 Q534 246 600 242 Q666 246 672 352 Q600 372 528 352 Z" fill="${shade(c, -0.38)}"/>`;
  if (view === "back") {
    s += seam("M380 520 Q600 545 820 520", c, -0.22, 3);
    s += seam("M600 360 V1196", c, -0.08, 1.5, 'stroke-dasharray="2 9"');
  } else {
    if (!hood) s += garment("co", "M520 338 L600 372 L680 338 L712 352 L640 470 L600 420 L560 470 L488 352 Z", shade(c, -0.12), { seed: 13 });
    s += seam("M600 400 V1196", c, -0.35, 4);
    s += seam("M612 420 V1190", hood ? shade(c, -0.5) : c, -0.2, 2, 'stroke-dasharray="3 6"');
    for (const [x, y] of [[430, 760], [640, 760]]) {
      s += `<rect x="${x}" y="${y}" width="130" height="150" rx="8" fill="${shade(c, -0.06)}" stroke="${shade(c, -0.25)}" stroke-width="2.5"/>`;
      s += `<path d="M${x - 4} ${y - 6} h138 v52 h-138 z" fill="${shade(c, -0.1)}" stroke="${shade(c, -0.3)}" stroke-width="2.5"/>`;
    }
    if (!hood) for (const y of [520, 640, 760, 880, 1000, 1120]) s += `<circle cx="630" cy="${y}" r="9" fill="${shade(c, -0.4)}"/>`;
    if (hood) s += `<circle cx="566" cy="372" r="6" fill="${shade(c, -0.5)}"/><circle cx="634" cy="372" r="6" fill="${shade(c, -0.5)}"/>`;
  }
  s += seam("M184 924 L262 958 M1016 924 L938 958", c, -0.3, 8);
  return s;
}

function jeans(c: string, view: View) {
  const d = "M418 300 L782 300 L808 1260 L640 1260 L604 640 L596 640 L560 1260 L392 1260 Z";
  let s = garment("je", d, c, { fibre: 1.6, seed: 17, light: "top" });
  s += seam("M418 352 H782", c, -0.3, 3);
  for (const x of [440, 530, 670, 760]) s += `<rect x="${x - 7}" y="296" width="14" height="62" rx="3" fill="${shade(c, -0.12)}" stroke="${shade(c, -0.3)}" stroke-width="2"/>`;
  if (view === "back") {
    s += stitch("M420 420 Q600 470 780 420");
    for (const x of [445, 625]) s += `<path d="M${x} 480 h130 v120 l-65 34 l-65 -34 z" fill="${shade(c, -0.05)}" stroke="${shade(c, -0.25)}" stroke-width="2"/>` + stitch(`M${x + 10} 490 h110 v104 l-55 28 l-55 -28 z`);
    s += `<rect x="690" y="318" width="70" height="30" rx="3" fill="#8a6a45"/>`;
  } else {
    s += stitch("M600 356 V560 Q600 600 640 610");
    s += stitch("M430 360 Q470 440 520 452");
    s += stitch("M770 360 Q730 440 680 452");
    s += `<circle cx="600" cy="326" r="11" fill="#9a8463" stroke="#6f5b40" stroke-width="2"/>`;
    for (const [x, y] of [[518, 450], [682, 450]]) s += `<circle cx="${x}" cy="${y}" r="5" fill="#b08a55"/>`;
  }
  s += stitch("M400 1228 H562 M638 1228 H800");
  return s;
}

function shorts(c: string, view: View) {
  const d = "M410 420 L790 420 L830 860 L630 880 L600 600 L570 880 L370 860 Z";
  let s = garment("sh", d, c, { fibre: 1.3, seed: 19, light: "top" });
  s += `<rect x="408" y="400" width="384" height="56" rx="10" fill="${shade(c, -0.1)}"/>` + ribs(410, 790, 404, 452, c, 9);
  s += seam("M380 840 L568 856 M632 856 L820 840", c, 0.12, 4);
  if (view !== "back") s += `<path d="M560 456 q-10 60 4 110 M640 456 q10 60 -4 110" stroke="#e8e4dc" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  else s += `<rect x="640" y="500" width="110" height="80" rx="10" fill="${shade(c, -0.06)}" stroke="${shade(c, 0.15)}" stroke-width="3"/>`;
  s += seam("M790 470 L826 846", c, 0.25, 6);
  return s;
}

function beanie(c: string) {
  const d = "M380 900 Q360 520 600 480 Q840 520 820 900 Z";
  let s = garment("be", d, c, { fibre: 1.2, seed: 23, light: "top" });
  s += ribs(384, 818, 560, 896, c, 16);
  s += garment("bc", "M360 860 Q600 830 840 860 L846 1010 Q600 990 354 1010 Z", shade(c, -0.08), { seed: 24 }) + ribs(360, 842, 866, 1002, shade(c, -0.08), 12);
  s += `<rect x="560" y="880" width="80" height="54" rx="4" fill="#ece6dc" stroke="#bfb4a4" stroke-width="2"/>`;
  return s;
}

function weekender(c: string, view: View) {
  if (view === "inside") {
    let s = garment("wk", "M260 700 Q260 640 320 630 L880 630 Q940 640 940 700 L920 1080 Q900 1120 860 1120 L340 1120 Q300 1120 280 1080 Z", c, { fibre: 0.5, seed: 29 });
    s += `<ellipse cx="600" cy="680" rx="320" ry="70" fill="#2b2522"/><ellipse cx="600" cy="690" rx="296" ry="54" fill="#d8cdbb"/>`;
    s += `<path d="M330 690 Q600 760 870 690" fill="none" stroke="#b8ab96" stroke-width="3"/>`;
    s += seam("M286 640 Q600 610 914 640", "#7a6a55", 0, 6, 'stroke-dasharray="14 8"');
    return s;
  }
  if (view === "side") {
    let s = garment("wk", "M470 640 Q600 600 730 640 L760 1080 Q600 1110 440 1080 Z", c, { fibre: 0.5, seed: 29 });
    s += seam("M486 700 Q600 670 714 700", c, -0.3, 3) + stitch("M462 1040 Q600 1066 738 1040", shade(c, 0.35));
    s = `<path d="M530 650 Q600 440 670 650" fill="none" stroke="${shade(c, -0.22)}" stroke-width="26" stroke-linecap="round"/>` + s;
    return s;
  }
  let s = `<path d="M440 660 Q440 430 600 430 Q760 430 760 660" fill="none" stroke="${shade(c, -0.22)}" stroke-width="30" stroke-linecap="round"/>`;
  s += garment("wk", "M240 700 Q240 640 300 630 L900 630 Q960 640 960 700 L940 1060 Q930 1110 870 1110 L330 1110 Q270 1110 260 1060 Z", c, { fibre: 0.5, seed: 29 });
  s += seam("M270 670 Q600 650 930 670", "#3a2f27", 0, 5);
  s += stitch("M262 1050 Q600 1072 938 1050", shade(c, 0.35));
  for (const x of [440, 760]) s += `<rect x="${x - 26}" y="640" width="52" height="120" rx="6" fill="${shade(c, -0.2)}"/><circle cx="${x}" cy="740" r="10" fill="#c9b07a" stroke="#8d7444" stroke-width="2"/>`;
  s += `<rect x="560" y="660" width="80" height="26" rx="5" fill="#c9b07a" stroke="#8d7444" stroke-width="2"/>`;
  return s;
}

function messenger(c: string, view: View) {
  if (view === "inside") {
    let s = garment("ms", "M300 560 L900 560 L900 1060 Q900 1090 870 1090 L330 1090 Q300 1090 300 1060 Z", c, { fibre: 0.9, seed: 31 });
    s += `<rect x="330" y="580" width="540" height="300" rx="10" fill="#6e7378"/><rect x="360" y="610" width="480" height="230" rx="8" fill="#55595e"/>`;
    s += `<rect x="390" y="640" width="180" height="100" rx="6" fill="#62666b"/><rect x="600" y="640" width="210" height="170" rx="6" fill="#484c51"/>`;
    return s;
  }
  let s = `<path d="M330 580 Q300 260 600 250 Q900 260 870 580" fill="none" stroke="${shade(c, -0.2)}" stroke-width="34"/>`;
  s += garment("ms", "M300 560 L900 560 L900 1060 Q900 1090 870 1090 L330 1090 Q300 1090 300 1060 Z", c, { fibre: 0.9, seed: 31 });
  if (view !== "back") {
    s += garment("mf", "M290 548 L910 548 L910 900 Q910 940 870 940 L330 940 Q290 940 290 900 Z", shade(c, 0.06), { fibre: 0.9, seed: 32 });
    for (const x of [450, 750]) s += `<rect x="${x - 22}" y="760" width="44" height="200" rx="5" fill="#2a2725"/><rect x="${x - 30}" y="890" width="60" height="44" rx="6" fill="none" stroke="#b9a782" stroke-width="7"/>`;
    s += stitch("M310 916 H890", shade(c, 0.3), 2);
  } else s += `<rect x="360" y="640" width="480" height="300" rx="8" fill="${shade(c, -0.08)}"/>` + seam("M360 700 H840", c, -0.3, 6);
  return s;
}

function spinner(c: string, view: View) {
  if (view === "inside") {
    let s = garment("sp1", "M180 460 Q180 420 220 420 L580 420 Q600 420 600 440 L600 1180 Q600 1200 580 1200 L220 1200 Q180 1200 180 1160 Z", c, { fibre: 0.3, seed: 37 });
    s += garment("sp2", "M600 440 Q600 420 620 420 L980 420 Q1020 420 1020 460 L1020 1160 Q1020 1200 980 1200 L620 1200 Q600 1200 600 1180 Z", c, { fibre: 0.3, seed: 38 });
    s += `<rect x="210" y="450" width="360" height="720" rx="18" fill="#4a4f55"/><rect x="630" y="450" width="360" height="720" rx="18" fill="#4a4f55"/>`;
    s += `<path d="M230 470 L550 1150 M550 470 L230 1150" stroke="#2c2f33" stroke-width="22" stroke-linecap="round"/>`;
    s += `<rect x="650" y="480" width="320" height="300" rx="10" fill="#3d4247"/>` + seam("M650 800 H970", "#888", 0, 3, 'stroke-dasharray="10 6"');
    return s;
  }
  const w = view === "side" ? 170 : 210;
  const [x1, x2] = [600 - w, 600 + w];
  let s = `<rect x="${600 - 70}" y="200" width="20" height="260" fill="#9a9ea3"/><rect x="${600 + 50}" y="200" width="20" height="260" fill="#9a9ea3"/><rect x="${600 - 90}" y="180" width="180" height="44" rx="18" fill="#2b2b2b"/>`;
  s += garment("sp", `M${x1} 480 Q${x1} 430 ${x1 + 50} 430 L${x2 - 50} 430 Q${x2} 430 ${x2} 480 L${x2} 1180 Q${x2} 1230 ${x2 - 50} 1230 L${x1 + 50} 1230 Q${x1} 1230 ${x1} 1180 Z`, c, { fibre: 0.25, seed: 37 });
  for (let i = 1; i < 6; i++) {
    const x = x1 + ((x2 - x1) * i) / 6;
    s += `<path d="M${x} 470 V1190" stroke="${shade(c, 0.12)}" stroke-width="7" opacity="0.6"/><path d="M${x + 6} 470 V1190" stroke="${shade(c, -0.4)}" stroke-width="4" opacity="0.7"/>`;
  }
  if (view === "side") s += `<rect x="${x1 - 14}" y="760" width="28" height="140" rx="10" fill="#2a2a2a"/>`;
  for (const x of [x1 + 40, x2 - 40]) s += `<rect x="${x - 18}" y="1230" width="36" height="34" fill="#2a2a2a"/><circle cx="${x}" cy="1282" r="26" fill="#151515"/><circle cx="${x}" cy="1282" r="9" fill="#555"/>`;
  return s;
}

function boot(c: string, view: View) {
  if (view === "front") {
    let s = garment("bt", "M480 600 L720 600 L728 960 Q760 1090 742 1180 L458 1180 Q440 1090 472 960 Z", c, { fibre: 0.4, seed: 41 });
    s += `<path d="M458 1180 L742 1180 L748 1218 L452 1218 Z" fill="#1d1a18"/>`;
    s += garment("bg", "M482 616 L524 616 L530 880 Q500 890 486 860 Z", shade(c, -0.35), { seed: 42 });
    s += garment("bg2", "M676 616 L718 616 L714 860 Q700 890 670 880 Z", shade(c, -0.35), { seed: 43 });
    s += `<rect x="578" y="556" width="44" height="74" rx="8" fill="${shade(c, -0.15)}"/>`;
    s += stitch("M470 1166 Q600 1150 730 1166", shade(c, 0.35), 2);
    return s;
  }
  const d = "M440 560 L660 560 L668 880 Q720 950 860 985 Q962 1008 968 1090 L968 1150 L380 1150 L380 1040 Q420 970 434 880 Z";
  let s = garment("bt", d, c, { fibre: 0.4, seed: 41 });
  s += garment("bg", "M556 578 L640 578 L644 860 Q600 896 550 860 Z", shade(c, -0.35), { seed: 42 });
  for (let y = 596; y < 860; y += 14) s += `<path d="M558 ${y} H642" stroke="${shade(c, -0.5)}" stroke-width="2" opacity="0.6"/>`;
  s += `<path d="M372 1150 L976 1150 L976 1196 L372 1196 Z" fill="#1e1b19"/><path d="M380 1150 L520 1150 L520 1196 L380 1196 Z" fill="#141210"/>`;
  s += stitch("M392 1140 Q660 1110 960 1140", shade(c, 0.35), 2);
  s += `<path d="M452 564 Q458 498 506 504 L516 570" fill="none" stroke="${shade(c, -0.2)}" stroke-width="16"/>`;
  return s;
}

/** A dress form (for the "model" view: the garment on a neutral form, no person). */
function dressForm() {
  return (
    `<rect x="590" y="1180" width="20" height="200" fill="#6b625a"/><path d="M480 1390 L720 1390 L700 1370 L500 1370 Z" fill="#5a524b"/>` +
    garment("df", "M520 300 Q600 250 680 300 L760 360 Q800 600 760 820 Q820 1060 780 1190 L420 1190 Q380 1060 440 820 Q400 600 440 360 Z", "#cbbfae", { fibre: 0.6, seed: 47 }) +
    `<rect x="560" y="210" width="80" height="100" rx="30" fill="#b8ab98"/>`
  );
}

const ITEM_TYPES: Record<string, (c: string, v: View) => string> = {
  sweater,
  t_shirt: tee,
  jacket: (c, v) => jacket(c, v),
  rain_jacket: (c, v) => jacket(c, v, true),
  jeans,
  shorts,
  hat: (c) => beanie(c),
  bag: weekender,
  messenger,
  luggage: spinner,
  shoes: boot,
};

/** One product shot (1200 x 1500, studio background): `kind` is an item type (or messenger / rain_jacket), `view` the image's view. */
export function productSvg(kind: string, colorCode: string, view: View): string {
  const c = COLORS[colorCode] ?? "#8a8178";
  const draw = ITEM_TYPES[kind] ?? sweater;
  const floor = { cx: 600, cy: 1260, rx: 380, ry: 40 };
  if (view === "model") return svg(1200, 1500, studio(1200, 1500, { cx: 600, cy: 1400, rx: 260, ry: 26 }) + dressForm() + `<g transform="translate(600 640) scale(0.86) translate(-600 -640)">${draw(c, "front")}</g>`);
  if (view === "detail") return svg(1200, 1500, studio(1200, 1500, null) + draw(c, "front"), "430 330 320 400");
  const inner = draw(c, view === "side" && kind !== "bag" && kind !== "luggage" && kind !== "shoes" ? "front" : view);
  return svg(1200, 1500, studio(1200, 1500, floor) + inner);
}

// ------------------------------------------------------------------ editorial images

/** Grain filter layer for editorial images (rsvg renders feTurbulence). */
function grainDefs(id = "grain", seed = 9, opacity = 0.09) {
  return `<defs><filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="${seed}"/><feColorMatrix type="saturate" values="0"/></filter></defs><rect id="${id}-r" width="100%" height="100%" filter="url(#${id})" opacity="${opacity}"/>`;
}

/** Hero: dunes at first light, monochrome stone tones with atmospheric depth (2400 x 1200). */
export function heroSvg(): string {
  const r = rng(26);
  const layers = [
    { y: 640, amp: 60, col: "#d6cdc1" },
    { y: 720, amp: 80, col: "#bdb1a2" },
    { y: 800, amp: 90, col: "#9a8c7c" },
    { y: 900, amp: 110, col: "#6f6356" },
    { y: 1010, amp: 120, col: "#3f3831" },
    { y: 1110, amp: 90, col: "#221e1b" },
  ];
  let hills = "";
  layers.forEach((l, i) => {
    let d = `M0 1200 L0 ${l.y}`;
    const n = 5;
    for (let k = 0; k < n; k++) {
      const x1 = (2400 / n) * k;
      const x2 = (2400 / n) * (k + 1);
      const peak = l.y - l.amp * (0.4 + r());
      d += ` C${x1 + 160} ${peak} ${x2 - 220} ${peak + l.amp * 0.4} ${x2} ${l.y + (r() - 0.5) * l.amp * 0.6}`;
    }
    d += " L2400 1200 Z";
    hills += `<path d="${d}" fill="url(#h${i})"/><path d="${d}" fill="none" stroke="#fffaf2" stroke-opacity="${0.18 - i * 0.025}" stroke-width="2"/>`;
    hills += `<rect x="0" y="${l.y - 80}" width="2400" height="140" fill="url(#mist)" opacity="${0.5 - i * 0.07}"/>`;
  });
  const grads = layers.map((l, i) => `<linearGradient id="h${i}" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stop-color="${shade(l.col, 0.08)}"/><stop offset="0.6" stop-color="${l.col}"/><stop offset="1" stop-color="${shade(l.col, -0.12)}"/></linearGradient>`).join("");
  return svg(
    2400,
    1200,
    `<defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfc6ba"/><stop offset="0.55" stop-color="#ebe4d9"/><stop offset="1" stop-color="#f4efe7"/></linearGradient>
      <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffaf1"/><stop offset="0.35" stop-color="#fbf4e8" stop-opacity="0.9"/><stop offset="1" stop-color="#f4ece0" stop-opacity="0"/></radialGradient>
      <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3ede4" stop-opacity="0"/><stop offset="0.5" stop-color="#f3ede4" stop-opacity="0.7"/><stop offset="1" stop-color="#f3ede4" stop-opacity="0"/></linearGradient>
      ${grads}
    </defs>
    <rect width="2400" height="1200" fill="url(#sky)"/>
    <circle cx="1640" cy="520" r="420" fill="url(#sun)"/><circle cx="1640" cy="520" r="96" fill="#fdf8ef" opacity="0.95"/>
    ${hills}
    ${grainDefs("g", 4, 0.1)}`,
  );
}

/** Login: draped ivory silk in deep folds (1600 x 2000). */
export function loginSvg(): string {
  const r = rng(77);
  let folds = "";
  const n = 15;
  for (let i = 0; i < n; i++) {
    const x = -120 + (1840 / n) * i + r() * 40;
    const w = 150 + r() * 120;
    const sway = 60 + r() * 90;
    const d = `M${x} -20 C${x + sway} 500 ${x - sway} 1200 ${x + sway * 0.6} 2020 L${x + w + sway * 0.6} 2020 C${x + w - sway} 1200 ${x + w + sway} 500 ${x + w} -20 Z`;
    folds += `<path d="${d}" fill="url(#fold${i % 3})"/>`;
  }
  const stops = (a: string, b: string, c: string) => `<stop offset="0" stop-color="${a}"/><stop offset="0.35" stop-color="${b}"/><stop offset="0.55" stop-color="${c}"/><stop offset="0.8" stop-color="${b}"/><stop offset="1" stop-color="${a}"/>`;
  return svg(
    1600,
    2000,
    `<defs>
      <linearGradient id="fold0" x1="0" y1="0" x2="1" y2="0">${stops("#8f8172", "#d9cfc1", "#f6f1e8")}</linearGradient>
      <linearGradient id="fold1" x1="0" y1="0" x2="1" y2="0">${stops("#6f6356", "#c6b9a8", "#ece4d8")}</linearGradient>
      <linearGradient id="fold2" x1="0" y1="0" x2="1" y2="0">${stops("#a39482", "#e3dacd", "#faf6ef")}</linearGradient>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1a19" stop-opacity="0.35"/><stop offset="0.3" stop-color="#1b1a19" stop-opacity="0"/><stop offset="0.75" stop-color="#1b1a19" stop-opacity="0.05"/><stop offset="1" stop-color="#1b1a19" stop-opacity="0.45"/></linearGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="7"/></filter>
    </defs>
    <rect width="1600" height="2000" fill="#cbbfae"/>
    <g filter="url(#soft)">${folds}</g>
    <rect width="1600" height="2000" fill="url(#shade)"/>
    ${grainDefs("g", 8, 0.08)}`,
  );
}

/** Material close-up: a twill weave in undyed wool (1600 x 1200). */
export function materialSvg(): string {
  return svg(
    1600,
    1200,
    `<defs>
      <pattern id="tw" width="36" height="36" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
        <rect width="36" height="36" fill="#cbbda7"/>
        <rect width="36" height="20" fill="#e2d7c5"/><rect y="2" width="36" height="4" fill="#efe7d9" opacity="0.7"/><rect y="20" width="36" height="3" fill="#a8977f" opacity="0.6"/>
      </pattern>
      <filter id="warp" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.05" numOctaves="3" seed="5" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="26" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
      <filter id="fuzz" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="1.6 0.4" numOctaves="2" seed="2"/><feColorMatrix type="saturate" values="0"/></filter>
      <radialGradient id="light" cx="0.3" cy="0.25" r="0.9"><stop offset="0" stop-color="#fff8ec" stop-opacity="0.35"/><stop offset="0.6" stop-color="#fff8ec" stop-opacity="0"/><stop offset="1" stop-color="#2a241f" stop-opacity="0.4"/></radialGradient>
    </defs>
    <rect x="-100" y="-100" width="1800" height="1400" fill="url(#tw)" filter="url(#warp)"/>
    <rect width="1600" height="1200" filter="url(#fuzz)" opacity="0.12"/>
    <rect width="1600" height="1200" fill="url(#light)"/>`,
  );
}

/** Linen backdrop for the flat-lays. */
function linen(w: number, h: number, base = "#e8e1d6") {
  return `<defs>
    <filter id="lin" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9 0.06" numOctaves="2" seed="21"/><feColorMatrix type="saturate" values="0"/></filter>
    <filter id="lin2" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.06 0.9" numOctaves="2" seed="22"/><feColorMatrix type="saturate" values="0"/></filter>
    <radialGradient id="tl" cx="0.4" cy="0.35" r="0.85"><stop offset="0" stop-color="#ffffff" stop-opacity="0.25"/><stop offset="1" stop-color="#3a322b" stop-opacity="0.22"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="${base}"/><rect width="${w}" height="${h}" filter="url(#lin)" opacity="0.07"/><rect width="${w}" height="${h}" filter="url(#lin2)" opacity="0.06"/>`;
}
const tileLight = (w: number, h: number) => `<rect width="${w}" height="${h}" fill="url(#tl)"/>`;
const place = (x: number, y: number, s: number, rot: number, body: string) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s}) translate(-600 -750)">${body}</g>`;

/** Category tiles (1200 x 1500): flat-lays on linen in the showroom palette. */
export function tileSvg(kind: "knitwear" | "outerwear" | "bags" | "shoes"): string {
  const W = 1200;
  const H = 1500;
  let body = "";
  if (kind === "knitwear") {
    body = place(470, 640, 0.78, -8, sweater("#e6dccb", "front")) + place(760, 1060, 0.62, 12, sweater("#2a2826", "front")) + place(860, 380, 0.42, 18, beanie("#b5a48c"));
  } else if (kind === "outerwear") {
    body = place(600, 780, 0.95, -4, jacket("#a28c72", "front")) + place(930, 1260, 0.34, 20, beanie("#1f1e1d"));
  } else if (kind === "bags") {
    body = place(560, 560, 0.8, -6, weekender("#7a4f31", "front")) + place(690, 1080, 0.66, 9, messenger("#1f1e1d", "front"));
  } else {
    body = place(460, 680, 0.78, -3, boot("#2b2420", "side")) + place(900, 980, 0.62, 5, boot("#a07a58", "front"));
  }
  return svg(W, H, linen(W, H, kind === "outerwear" ? "#ddd6cb" : kind === "shoes" ? "#e9e4dc" : "#e6dfd4") + body + tileLight(W, H) + grainDefs("g", 31, 0.06));
}

// ------------------------------------------------------------------ rendering

/** SVG to JPEG: rsvg-convert, then ImageMagick adds a fine monochrome grain. Deterministic. */
export function renderJpeg(svgText: string, o: { width: number; height: number; grain?: number; quality?: number; seed?: number }): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "obx-demo-art-"));
  try {
    const src = join(tmp, "in.svg");
    const png = join(tmp, "out.png");
    const jpg = join(tmp, "out.jpg");
    writeFileSync(src, svgText);
    const run = (args: string[]) => {
      const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString()}`);
    };
    run(["rsvg-convert", "-w", String(o.width), "-h", String(o.height), "-o", png, src]);
    const g = o.grain ?? 0.18;
    run([
      "magick",
      png,
      "-seed",
      String(o.seed ?? 1),
      "(",
      "+clone",
      "-fill",
      "gray50",
      "-colorize",
      "100",
      "-attenuate",
      String(g),
      "+noise",
      "Gaussian",
      "-colorspace",
      "gray",
      ")",
      "-compose",
      "overlay",
      "-composite",
      "-sampling-factor",
      "4:2:0",
      "-interlace",
      "JPEG",
      "-quality",
      String(o.quality ?? 84),
      "-strip",
      jpg,
    ]);
    return new Uint8Array(readFileSync(jpg));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function hasArtTools(): boolean {
  const has = (cmd: string) => Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0;
  return has("rsvg-convert") && has("magick");
}

if (import.meta.main) {
  // Preview: bun scripts/demo-art.ts <dir>  writes every showroom image and one shot per item type.
  const out = process.argv[2] ?? "demo-art";
  Bun.spawnSync(["mkdir", "-p", out]);
  writeFileSync(join(out, "hero.jpg"), renderJpeg(heroSvg(), { width: 2400, height: 1200 }));
  writeFileSync(join(out, "login.jpg"), renderJpeg(loginSvg(), { width: 1600, height: 2000 }));
  writeFileSync(join(out, "material.jpg"), renderJpeg(materialSvg(), { width: 1600, height: 1200 }));
  for (const t of ["knitwear", "outerwear", "bags", "shoes"] as const) writeFileSync(join(out, `tile-${t}.jpg`), renderJpeg(tileSvg(t), { width: 1200, height: 1500 }));
  for (const [k, c] of [["sweater", "OAT"], ["t_shirt", "RST"], ["jacket", "OLV"], ["rain_jacket", "YLW"], ["jeans", "IND"], ["shorts", "BLK"], ["hat", "NVY"], ["bag", "COG"], ["messenger", "CHR"], ["luggage", "BLK"], ["shoes", "BRN"]])
    for (const v of ["front", "back", "side", "inside", "detail", "model"] as const) writeFileSync(join(out, `${k}-${c}-${v}.jpg`), renderJpeg(productSvg(k, c, v), { width: 600, height: 750, grain: 0.1 }));
  console.log(`written to ${out}`);
}
