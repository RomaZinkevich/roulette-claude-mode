import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bet, Game, Mode, Pick } from '../types'
import { drawWheel } from './wheel'

const BANKROLL = 1000
const MIN_BET = 50
const CHIPS: { bet: Bet; label: string; hotkey: string }[] = [
  { bet: 50, label: '$50', hotkey: '1' },
  { bet: 100, label: '$100', hotkey: '2' },
  { bet: 250, label: '$250', hotkey: '3' },
  { bet: 500, label: '$500', hotkey: '4' },
  { bet: 'all', label: 'All in', hotkey: '5' },
]
const PICKS: { pick: Pick; label: string; hotkey: string }[] = [
  { pick: 'red', label: 'Red ×2', hotkey: 'r' },
  { pick: 'black', label: 'Black ×2', hotkey: 'b' },
  { pick: 'green', label: 'Green ×36', hotkey: 'g' },
]

// European wheel, pockets in the order they sit on the wheel.
const WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]
const REDS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
])
const BACKGROUND: Record<Pick, string> = {
  red: '#b3262e',
  black: '#2b2b2b',
  green: '#1e8449',
}

const SPIN_FRAMES = 30
const FRAME_MS = 70

const INITIAL: Game = {
  balance: BANKROLL,
  bet: MIN_BET,
  pointer: 0,
  spin: null,
  last: null,
  isBust: false,
}
const game = atom({ plugin: 'roulette', key: 'game' } as const, INITIAL)
const mode = atom({ plugin: 'roulette', key: 'mode' } as const, 'thinking' as Mode)
const MODE_KEY = 'mode'

const isMode = (value: unknown): value is Mode =>
  value === 'thinking' || value === 'always'

const colorOf = (n: number): Pick =>
  n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black'

const payoutOf = (pick: Pick) => (pick === 'green' ? 36 : 2)

const money = (n: number) => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

const randomPocket = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 37

const easeOut = (t: number) => 1 - (1 - t) ** 3

// Where the wheel stands, in pockets turned past the top: fractional while
// it spins, so the drawn wheel turns smoothly.
const positionAt = (from: number, distance: number, frame: number) =>
  from + distance * easeOut(Math.min(1, frame / SPIN_FRAMES))

const pointerAt = (from: number, distance: number, frame: number) =>
  Math.round(positionAt(from, distance, frame)) % WHEEL.length

// The ball runs the other way round the track, slows, and drops into the
// pocket under the top as the wheel stops.
const ballAt = (frame: number) => {
  const t = Math.min(1, frame / SPIN_FRAMES)
  const drop = Math.min(1, Math.max(0, (t - 0.75) / 0.25))
  return {
    angle: -Math.PI / 2 - 5 * Math.PI * (1 - t) ** 2,
    radius: 0.83 - 0.13 * drop,
  }
}

const RESTING_BALL = { angle: -Math.PI / 2, radius: 0.7 }

const stakeOf = (g: Game) =>
  g.bet === 'all' ? g.balance : Math.min(g.bet, g.balance)

// Applies a finished spin: pays out or takes the stake, and ends the game
// once the balance can't cover the minimum bet.
const settle = (g: Game): Game => {
  if (g.spin === null) {
    return g
  }
  const { pick, stake, result, from, distance } = g.spin
  const isWin = colorOf(result) === pick
  const delta = isWin ? stake * (payoutOf(pick) - 1) : -stake
  const balance = g.balance + delta

  return {
    ...g,
    balance,
    pointer: pointerAt(from, distance, SPIN_FRAMES),
    spin: null,
    last: { result, pick, stake, delta },
    isBust: balance < MIN_BET,
  }
}

let ticker: { cancel: () => void } | null = null

const finish = async ($: EngineInterface) => {
  ticker?.cancel()
  ticker = null
  await update($, game, settle)
}

const play = async ($: EngineInterface, pick: Pick) => {
  const g = await read($, game)
  if (g.spin !== null || g.isBust || g.balance < MIN_BET) {
    return
  }
  const result = randomPocket()
  const target = WHEEL.indexOf(result)
  const distance =
    WHEEL.length * 2 + ((target - g.pointer + WHEEL.length) % WHEEL.length)
  let isStarted = false
  await update($, game, current => {
    if (current.spin !== null || current.isBust) {
      isStarted = false
      return current
    }
    isStarted = true
    const stake = stakeOf(current)
    return {
      ...current,
      spin: { pick, stake, result, from: current.pointer, distance, frame: 0 },
    }
  })
  if (!isStarted) {
    return
  }

  ticker?.cancel()
  ticker = $.clock.every(FRAME_MS, () => {
    void update($, game, current =>
      current.spin === null
        ? current
        : { ...current, spin: { ...current.spin, frame: current.spin.frame + 1 } },
    ).then(async () => {
      const now = await read($, game)
      if (now.spin === null || now.spin.frame >= SPIN_FRAMES) {
        await finish($)
      }
    })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload drops the old timer: land any spin it left mid-air.
    await update($, game, settle)

    const stored = await $.store.get(MODE_KEY)
    if (isMode(stored)) {
      await update($, mode, () => stored)
    }
    await $.command.register({
      name: 'roulette',
      description: 'Roulette table: show it always, or only while Claude thinks',
      argumentHint: '[always|thinking|reset]',
      immediate: true,
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A new thinking session refills a busted bankroll.
    await update($, game, g =>
      g.isBust ? { ...INITIAL, pointer: g.pointer } : g,
    )

    return next(e)
  })

  on('command.run', { command: 'roulette' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (asked === 'reset') {
      // Back to a full bankroll; a spin in the air is called off, stake kept.
      await update($, game, g => ({ ...INITIAL, bet: g.bet, pointer: g.pointer }))
      return { text: `Roulette bankroll reset to ${money(BANKROLL)}.` }
    }
    if (asked !== '' && !isMode(asked)) {
      return { text: 'Usage: /roulette [always|thinking|reset]' }
    }
    const current = await read($, mode)
    const chosen: Mode =
      asked !== '' ? asked : current === 'always' ? 'thinking' : 'always'
    await update($, mode, () => chosen)
    await $.store.set(MODE_KEY, chosen)

    return {
      text:
        chosen === 'always'
          ? 'Roulette table is always shown.'
          : 'Roulette table shows only while Claude is thinking.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (
      e.props.hasSurvey ||
      (!e.props.isWorking && (await read($, mode)) !== 'always')
    ) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const g = await read($, game)
    const pointer = g.spin
      ? pointerAt(g.spin.from, g.spin.distance, g.spin.frame)
      : g.pointer
    const artRows = Math.min(12, e.props.maxRows)
    const hasArt =
      e.surface === 'terminal' &&
      artRows >= 7 &&
      e.props.bodyColumns >= artRows * 2 + 2 + 46
    const room = e.props.bodyColumns - (hasArt ? artRows * 2 + 2 : 0)
    const shown = Math.max(3, Math.min(13, Math.floor((room - 2) / 4))) | 1
    const half = (shown - 1) / 2
    const pockets = Array.from({ length: shown }, (_, i) => {
      const index = (pointer - half + i + WHEEL.length * 2) % WHEEL.length
      return WHEEL[index] ?? 0
    })

    const art = hasArt
      ? drawWheel(
          artRows,
          g.spin
            ? {
                position: positionAt(g.spin.from, g.spin.distance, g.spin.frame),
                ball: ballAt(g.spin.frame),
              }
            : { position: g.pointer, ball: g.last ? RESTING_BALL : null },
          WHEEL,
          REDS,
        )
      : null

    const table = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text bold>Roulette</Text>
          <Text>
            Balance <Text bold>{money(g.balance)}</Text>
          </Text>
          {!g.isBust && (
            <Text>
              Bet <Text bold>{money(g.spin ? g.spin.stake : stakeOf(g))}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="row">
          <Text>{' '.repeat(half * 4 + 1)}</Text>
          <Text color="warning">▼</Text>
        </Box>
        <Box key="wheel" flexDirection="row">
          {pockets.map((n, i) => (
            <Text
              backgroundColor={BACKGROUND[colorOf(n)]}
              color="#ffffff"
              bold={i === half}
              underline={i === half}
            >
              {String(n).padStart(3, ' ') + ' '}
            </Text>
          ))}
        </Box>
        {g.isBust ? (
          <Text color="error">
            Game over. The bankroll refills to {money(BANKROLL)} the next time
            Claude thinks.
          </Text>
        ) : g.spin ? (
          <Text dimColor>
            Spinning… {money(g.spin.stake)} on {g.spin.pick}
          </Text>
        ) : (
          <Box flexDirection="column">
            <Box key="chips" flexDirection="row" gap={2}>
              {CHIPS.map(chip => (
                <Button
                  key={`chip-${chip.hotkey}`}
                  plain
                  hotkey={chip.hotkey}
                  label={chip.label}
                  dimColor={g.bet !== chip.bet}
                  onPress={() => update($, game, cur => ({ ...cur, bet: chip.bet }))}
                />
              ))}
            </Box>
            <Box key="picks" flexDirection="row" gap={2}>
              {PICKS.map(p => (
                <Button
                  key={`pick-${p.pick}`}
                  plain
                  hotkey={p.hotkey}
                  label={p.label}
                  onPress={() => play($, p.pick)}
                />
              ))}
            </Box>
          </Box>
        )}
        {g.last && !g.spin && (
          <Text color={g.last.delta > 0 ? 'success' : 'subtle'}>
            {g.last.result} {colorOf(g.last.result)}:{' '}
            {g.last.delta > 0
              ? `won ${money(g.last.delta)}`
              : `lost ${money(-g.last.delta)}`}
          </Text>
        )}
        {!g.isBust && !g.spin && (
          <Text dimColor>ctrl+x tab to focus, then use the hotkeys, or click</Text>
        )}
      </Box>
    )

    if (art === null || e.surface !== 'terminal') {
      return table
    }
    const { Raster } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={2}>
        <Raster key="wheel-art" {...art} />
        {table}
      </Box>
    )
  })
}
