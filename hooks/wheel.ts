// Draws the roulette wheel as Raster cells: two pixels per terminal cell,
// stacked with half blocks, so a wheel `rows` tall is `rows * 2` wide.

const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20
const DEFAULT = 0x01000000

const RED = 0xb3262e
const BLACK = 0x1f1f1f
const GREEN = 0x1e8449
const BALL = 0xf7f7f7

// Fractions of the radius where each ring ends, outside in.
const RIM = 0.86
const TRACK = 0.79
const POCKETS = 0.6
const FRETS = 0.52

export type WheelArt = {
  // Which pocket index (fractional while spinning) sits under the top.
  position: number
  // The ball's angle in radians (-π/2 is the top) and radius as a fraction;
  // null draws no ball.
  ball: { angle: number; radius: number } | null
}

const channel = (c: number, shift: number) => (c >> shift) & 0xff

const mix = (a: number, b: number, t: number) => {
  const k = Math.min(1, Math.max(0, t))
  const one = (shift: number) =>
    Math.round(channel(a, shift) * (1 - k) + channel(b, shift) * k) << shift
  return one(16) | one(8) | one(0)
}

const shade = (c: number, f: number) =>
  f >= 1 ? mix(c, 0xffffff, f - 1) : mix(0x000000, c, f)

const pocketColor = (n: number, reds: Set<number>) =>
  n === 0 ? GREEN : reds.has(n) ? RED : BLACK

// One pixel's color, or DEFAULT outside the wheel.
const pixel = (
  x: number,
  y: number,
  size: number,
  art: WheelArt,
  wheel: readonly number[],
  reds: Set<number>,
) => {
  const c = (size - 1) / 2
  const dx = x - c
  const dy = y - c
  const radius = size / 2
  const r = Math.hypot(dx, dy) / radius
  if (r > 1) {
    return DEFAULT
  }

  const slice = (Math.PI * 2) / wheel.length
  // The wheel turns so pocket `position` is centred on the top.
  const spin = -Math.PI / 2 - (art.position + 0.5) * slice
  const angle = Math.atan2(dy, dx)
  // Light from the top left.
  const light = 1 + (-(dx + dy) / size) * 0.35

  if (art.ball) {
    const bx = c + Math.cos(art.ball.angle) * art.ball.radius * radius
    const by = c + Math.sin(art.ball.angle) * art.ball.radius * radius
    if (Math.hypot(x - bx, y - by) < 0.75) {
      return BALL
    }
  }

  if (r > RIM) {
    const grain = Math.sin(x * 0.9 + y * 0.35 + Math.sin(y * 0.5) * 1.5) * 0.5 + 0.5
    const wood = mix(0x7a3416, 0xa5522a, grain)
    const edge = r > 0.95 || r < RIM + 0.03 ? 0.75 : 1
    return shade(wood, light * edge)
  }
  if (r > TRACK) {
    return shade(0x5a240f, light)
  }

  const turned = (((angle - spin) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const index = Math.floor(turned / slice) % wheel.length

  if (r > POCKETS) {
    return shade(pocketColor(wheel[index] ?? 0, reds), light * 0.95 + 0.05)
  }
  if (r > FRETS) {
    return shade(index % 2 === 0 ? 0x8f8f8f : 0x6e6e6e, light)
  }

  // The turret: four brass arms that turn with the wheel, and a knob.
  if (r < 0.13) {
    return shade(0xf3e3b0, light)
  }
  for (let k = 0; k < 4; k += 1) {
    const arm = spin + (k * Math.PI) / 2
    const along = dx * Math.cos(arm) + dy * Math.sin(arm)
    const across = Math.abs(-dx * Math.sin(arm) + dy * Math.cos(arm))
    if (along > 0 && along < FRETS * radius * 0.85 && across < 0.7) {
      return shade(0xe8cf8a, light)
    }
  }
  return shade(mix(0xd9bd78, 0x9c7c3c, r / FRETS), light)
}

// Raster `cells` for a wheel `rows` tall: base64 of [codePoint, fg, bg]
// little-endian u32 triplets, row-major.
export const drawWheel = (
  rows: number,
  art: WheelArt,
  wheel: readonly number[],
  reds: Set<number>,
) => {
  const size = rows * 2
  const columns = size
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = pixel(x, row * 2, size, art, wheel, reds)
      const bottom = pixel(x, row * 2 + 1, size, art, wheel, reds)
      const at = (row * columns + x) * 3
      if (top === DEFAULT && bottom === DEFAULT) {
        words.set([SPACE, DEFAULT, DEFAULT], at)
      } else if (top === DEFAULT) {
        words.set([LOWER_HALF, bottom, DEFAULT], at)
      } else {
        words.set([UPPER_HALF, top, bottom], at)
      }
    }
  }

  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { columns, rows, cells: btoa(binary) }
}
