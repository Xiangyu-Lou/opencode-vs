#!/usr/bin/env bun
// Regenerates every raster brand asset from reference/VsWorker.svg.
//
//   bun run script/brand.ts            # everything
//   bun run script/brand.ts favicon    # web favicons + manifest icons only
//   bun run script/brand.ts desktop    # Electron channel icon sets only
//
// Rasterizing goes through headless Chrome: it is the only SVG renderer reliably present on a
// macOS dev box (rsvg-convert/inkscape are not, and ImageMagick's SVG delegate hangs on gradients).
// `sips`/`iconutil` build the .icns, `magick` packs the .ico.

import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const MARK_SVG = join(ROOT, "reference/VsWorker.svg")
const FAVICON_DIR = join(ROOT, "packages/ui/src/assets/favicon")
const DESKTOP_ICONS = join(ROOT, "packages/desktop/icons")

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

function chrome() {
  const found = process.env["CHROME_BIN"] ?? CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!found) throw new Error("no Chrome/Chromium found; set CHROME_BIN to a Chromium binary")
  return found
}

// The mark's drawing commands, without its <svg> wrapper, so it can be nested at any size.
async function markInner() {
  const raw = await readFile(MARK_SVG, "utf8")
  const open = raw.indexOf(">", raw.indexOf("<svg"))
  return raw.slice(open + 1, raw.lastIndexOf("</svg>"))
}

/** Apple-style squircle: the superellipse |x|^n + |y|^n = 1 that macOS icons are built on. */
function squircle(size: number, inset = 0, n = 5) {
  const r = (size - inset * 2) / 2
  const cx = size / 2
  const cy = size / 2
  const pts: string[] = []
  const steps = 240
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = cx + Math.sign(c) * Math.abs(c) ** (2 / n) * r
    const y = cy + Math.sign(s) * Math.abs(s) ** (2 / n) * r
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return pts.join("") + "Z"
}

type Ground = { id: string; from: string; to: string }

// The three app channels intentionally share one white ground — they are kept as separate
// entries so a channel can diverge again without reshaping the callers. `flat` is the dark
// ground the web assets use (favicons, PWA icons, social cards) and is unrelated to these.
const APP_GROUND = { from: "#FFFFFF", to: "#F0F0F2" }

const GROUNDS: Record<string, Ground> = {
  prod: { id: "prod", ...APP_GROUND },
  beta: { id: "beta", ...APP_GROUND },
  dev: { id: "dev", ...APP_GROUND },
  flat: { id: "flat", from: "#131010", to: "#131010" },
}

/** Light grounds need an edge, or the squircle vanishes against a white Finder background. */
function isLight(ground: Ground) {
  const luma = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  }
  return (luma(ground.from) + luma(ground.to)) / 2 > 0.6
}

/**
 * A square badge: channel ground + the mark centred on it.
 * `shape` picks the ground outline, `inset` leaves the transparent margin macOS app icons carry.
 */
async function badge(opts: {
  size: number
  ground: Ground
  shape: "square" | "squircle"
  inset?: number
  shadow?: boolean
  markWidth?: number
}) {
  const { size, ground, shape } = opts
  const inset = opts.inset ?? 0
  const markW = size * (opts.markWidth ?? 0.62)
  const markH = (markW * 98) / 112
  // A hairline keeps a light squircle readable on light backgrounds; the inset .icns artwork
  // gets its edge from the drop shadow instead, so it does not need one.
  const edge =
    isLight(ground) && !opts.shadow
      ? ` stroke="rgba(0,0,0,0.08)" stroke-width="${Math.max(1, size * 0.004).toFixed(2)}"`
      : ""
  const bg =
    shape === "square"
      ? `<rect width="${size}" height="${size}" fill="url(#g)"${edge}/>`
      : `<path d="${squircle(size, inset)}" fill="url(#g)"${edge}${opts.shadow ? ' filter="url(#s)"' : ""}/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ground.from}"/><stop offset="1" stop-color="${ground.to}"/></linearGradient>
${opts.shadow ? `<filter id="s" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="0" dy="${(size * 0.012).toFixed(2)}" stdDeviation="${(size * 0.016).toFixed(2)}" flood-opacity="0.32"/></filter>` : ""}
</defs>
${bg}
<svg x="${((size - markW) / 2).toFixed(2)}" y="${((size - markH) / 2).toFixed(2)}" width="${markW.toFixed(2)}" height="${markH.toFixed(2)}" viewBox="0 0 112 98">${await markInner()}</svg>
</svg>`
}

let workdir = ""
async function rasterize(svg: string, size: number, out: string) {
  const stem = `r${Math.random().toString(36).slice(2)}`
  const svgPath = join(workdir, `${stem}.svg`)
  const htmlPath = join(workdir, `${stem}.html`)
  await writeFile(svgPath, svg)
  await writeFile(
    htmlPath,
    `<html><body style="margin:0;background:transparent"><img src="${stem}.svg" style="display:block;width:${size}px;height:${size}px"></body></html>`,
  )
  await $`${chrome()} --headless --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=${size},${size} --screenshot=${out} ${"file://" + htmlPath}`.quiet()
}

async function rasterizeWide(svg: string, w: number, h: number, out: string) {
  const stem = `r${Math.random().toString(36).slice(2)}`
  await writeFile(join(workdir, `${stem}.svg`), svg)
  const htmlPath = join(workdir, `${stem}.html`)
  await writeFile(
    htmlPath,
    `<html><body style="margin:0;background:transparent"><img src="${stem}.svg" style="display:block;width:${w}px;height:${h}px"></body></html>`,
  )
  await $`${chrome()} --headless --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=${w},${h} --screenshot=${out} ${"file://" + htmlPath}`.quiet()
}

async function buildFavicons() {
  console.log("favicons →", FAVICON_DIR)
  const flat = await badge({ size: 512, ground: GROUNDS["flat"]!, shape: "square", markWidth: 0.6 })
  await writeFile(join(FAVICON_DIR, "favicon.svg"), flat)
  await writeFile(join(FAVICON_DIR, "favicon-v3.svg"), flat)

  const png = async (size: number, names: string[]) => {
    const first = join(FAVICON_DIR, names[0]!)
    await rasterize(flat, size, first)
    for (const n of names.slice(1)) await $`cp ${first} ${join(FAVICON_DIR, n)}`.quiet()
  }
  await png(96, ["favicon-96x96.png", "favicon-96x96-v3.png"])
  await png(180, ["apple-touch-icon.png", "apple-touch-icon-v3.png"])

  // Maskable icons keep the mark inside the safe zone, so a circular OS crop never clips it.
  const maskable = await badge({ size: 512, ground: GROUNDS["flat"]!, shape: "square", markWidth: 0.46 })
  await rasterize(maskable, 192, join(FAVICON_DIR, "web-app-manifest-192x192.png"))
  await rasterize(maskable, 512, join(FAVICON_DIR, "web-app-manifest-512x512.png"))

  const ico = join(workdir, "fav48.png")
  await rasterize(flat, 48, ico)
  await $`magick ${ico} -define icon:auto-resize=48,32,16 ${join(FAVICON_DIR, "favicon.ico")}`.quiet()
  await $`cp ${join(FAVICON_DIR, "favicon.ico")} ${join(FAVICON_DIR, "favicon-v3.ico")}`.quiet()
}

async function buildSocial() {
  const dir = join(ROOT, "packages/ui/src/assets/images")
  console.log("social cards →", dir)
  const inner = await markInner()
  const card = (
    bg: string,
    fg: string,
  ) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${bg}"/>
<svg x="404" y="150" width="392" height="343" viewBox="0 0 112 98">${inner}</svg>
<text x="600" y="545" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="54" font-weight="600" letter-spacing="2" fill="${fg}">vsWorker</text>
</svg>`
  await rasterizeWide(card("#131010", "#F5F5F5"), 1200, 630, join(dir, "social-share.png"))
  await rasterizeWide(card("#000000", "#F5F5F5"), 1200, 630, join(dir, "social-share-black.png"))
}

// Full-bleed sizes electron-builder and the Windows Store consume directly.
const FLAT_SIZES: Array<[string, number]> = [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
]

const ICNS_SIZES: Array<[string, number]> = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]

async function buildDesktop(channel: "dev" | "beta" | "prod") {
  const dir = join(DESKTOP_ICONS, channel)
  console.log("desktop icons →", dir)
  const ground = GROUNDS[channel]!
  const bleed = await badge({ size: 1024, ground, shape: "squircle" })
  // macOS insets the squircle inside the canvas and adds a shadow; see icons/README.md.
  const inset = await badge({ size: 1024, ground, shape: "squircle", inset: 100, shadow: true, markWidth: 0.5 })

  for (const [name, size] of FLAT_SIZES) await rasterize(bleed, size, join(dir, name))

  const iconset = join(workdir, `${channel}.iconset`)
  await mkdir(iconset, { recursive: true })
  for (const [name, size] of ICNS_SIZES) await rasterize(inset, size, join(iconset, name))
  await $`iconutil -c icns ${iconset} -o ${join(dir, "icon.icns")}`.quiet()

  // dock.png must match the inset artwork baked into the .icns (README.md).
  await $`cp ${join(iconset, "icon_128x128@2x.png")} ${join(dir, "dock.png")}`.quiet()

  const ico256 = join(workdir, `${channel}-256.png`)
  await rasterize(bleed, 256, ico256)
  await $`magick ${ico256} -define icon:auto-resize=256,128,64,48,32,16 ${join(dir, "icon.ico")}`.quiet()
}

const target = process.argv[2] ?? "all"
workdir = await mkdtemp(join(tmpdir(), "vsworker-brand-"))
try {
  if (target === "all" || target === "favicon") await buildFavicons()
  if (target === "all" || target === "social") await buildSocial()
  if (target === "all" || target === "desktop") {
    for (const channel of ["dev", "beta", "prod"] as const) await buildDesktop(channel)
  }
  console.log("done")
} finally {
  await rm(workdir, { recursive: true, force: true })
}
