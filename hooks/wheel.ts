// Draws the roulette wheel as Raster cells of braille, 2 dots across and 4
// down each, which round a circle off far finer than whole or half cells:
// just the ring of pockets in their colours, and the ball inside it.

const BRAILLE = 0x2800
const SPACE = 0x20
const DEFAULT = 0x01000000

// A cell's braille bit for each dot, by column then row.
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

const RED = 0xd04538
// Grey for black, so the pockets show on a dark terminal.
const BLACK = 0x6a6e74
const GREEN = 0x2ea05c
const BALL = 0xffffff

// Dots across the ring's band.
const BAND = 2.2

// The rows a wheel takes: odd, so it sits centred on a row.
export const MIN_WHEEL_ROWS = 7
export const MAX_WHEEL_ROWS = 11

// Two cells across per row down: a cell is about twice as tall as wide.
export const wheelColumnsOf = (rows: number) => rows * 2

const SLICE = (Math.PI * 2) / 37

export type WheelArt = {
  // Which pocket index (fractional while spinning) sits at the top.
  position: number
  // The ball's slot, clockwise from the top (fractional while it rolls);
  // null draws no ball.
  ball: number | null
}

const pocketColor = (n: number, reds: Set<number>) =>
  n === 0 ? GREEN : reds.has(n) ? RED : BLACK

// Raster `cells` for a wheel `rows` tall (odd, MIN_WHEEL_ROWS to
// MAX_WHEEL_ROWS): base64 of [codePoint, fg, bg] little-endian u32 triplets,
// row-major.
export const drawWheel = (
  rows: number,
  art: WheelArt,
  wheel: readonly number[],
  reds: Set<number>,
) => {
  const columns = wheelColumnsOf(rows)
  // The centre and radii in dots, a dot's centre on its index.
  const cx = (columns * 2 - 1) / 2
  const cy = (rows * 4 - 1) / 2
  const outer = Math.min(cx, cy) + 0.3
  const inner = outer - BAND
  const track = inner - 4.5
  const turned = Math.round(art.position)
  const ball =
    art.ball === null
      ? null
      : {
          x: cx + Math.cos(-Math.PI / 2 + art.ball * SLICE) * track,
          y: cy + Math.sin(-Math.PI / 2 + art.ball * SLICE) * track,
        }

  // The slot a dot on the ring belongs to, or -1 off it.
  const slotAt = (x: number, y: number) => {
    const dx = x - cx
    const dy = y - cy
    const r = Math.hypot(dx, dy)
    if (r > outer || r <= inner) {
      return -1
    }
    // Clockwise from the top, each slot centred on its own angle.
    const round = Math.PI * 2
    const angle = (((Math.atan2(dy, dx) + Math.PI / 2 + SLICE / 2) % round) + round) % round
    return Math.floor(angle / SLICE)
  }

  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // A cell takes one colour: the ball's if it's here, else the pocket
      // with the most dots in it.
      let bits = 0
      let ballBits = 0
      const counts = new Map<number, number>()
      for (let i = 0; i < 2; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          const x = column * 2 + i
          const y = row * 4 + j
          const bit = DOT_BITS[i]?.[j] ?? 0
          if (ball && Math.hypot(x - ball.x, y - ball.y) < 1.1) {
            ballBits |= bit
          }
          const slot = slotAt(x, y)
          if (slot >= 0) {
            bits |= bit
            counts.set(slot, (counts.get(slot) ?? 0) + 1)
          }
        }
      }
      const at = (row * columns + column) * 3
      if (ballBits) {
        words.set([BRAILLE + ballBits, BALL, DEFAULT], at)
      } else if (bits) {
        const [slot] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))
        const n = wheel[(((turned + slot) % 37) + 37) % 37] ?? 0
        words.set([BRAILLE + bits, pocketColor(n, reds), DEFAULT], at)
      } else {
        words.set([SPACE, DEFAULT, DEFAULT], at)
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
