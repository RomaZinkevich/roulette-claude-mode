import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bet, Game, Pick } from '../types'
import { MAX_WHEEL_ROWS, MIN_WHEEL_ROWS, drawWheel, wheelColumnsOf } from './wheel'

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

const PANE = 'roulette'
// The width the pane asks for when docked: room for the biggest wheel.
const PANE_COLUMNS = 32
// The narrowest the table beside the wheel goes, inline, before the wheel
// shrinks; and the rows the table takes above and below it, docked.
const TABLE_COLUMNS = 44
const TABLE_ROWS = 10

const INITIAL: Game = {
  balance: BANKROLL,
  bet: MIN_BET,
  pointer: 0,
  spin: null,
  last: null,
  isBust: false,
}
const game = atom({ plugin: 'roulette', key: 'game' } as const, INITIAL)
// Whether the pane was left open, to open it again next session.
const OPEN_KEY = 'isOpen'
const isMuted = atom({ plugin: 'roulette', key: 'isMuted' } as const, false)
const MUTED_KEY = 'isMuted'

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

// The ball runs the other way round the wheel, slows, and settles by the
// pocket under the pointer as the wheel stops: a slot, clockwise from it.
const ballAt = (frame: number) =>
  -WHEEL.length * 2.5 * (1 - Math.min(1, frame / SPIN_FRAMES)) ** 2

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

// Plays one of the mod's sounds unless muted; a terminal with no player
// (Linux, Windows) plays nothing, and a failure is never the game's.
const playSound = async ($: EngineInterface, name: string) => {
  if (await read($, isMuted)) {
    return
  }
  await $.audio.play({ asset: `sounds/${name}` }).catch(() => undefined)
}

const finish = async ($: EngineInterface) => {
  ticker?.cancel()
  ticker = null
  await update($, game, settle)

  const { last } = await read($, game)
  if (last) {
    void playSound(
      $,
      last.delta <= 0 ? 'lose.wav' : last.pick === 'green' ? 'jackpot.wav' : 'win.wav',
    )
  }
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

  void playSound($, 'spin.wav')
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

    const muted = await $.store.get(MUTED_KEY)
    if (typeof muted === 'boolean') {
      await update($, isMuted, () => muted)
    }
    await $.command.register({
      name: 'roulette',
      description: 'Open or close the roulette table beside the conversation',
      argumentHint: '[reset|mute|unmute]',
      immediate: true,
    })
    // Unasked, it waits undrawn on a narrow terminal until it widens.
    if ((await $.store.get(OPEN_KEY)) === true) {
      await $.ui.open({ id: PANE, title: 'Roulette', columns: PANE_COLUMNS })
    }

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'unload') {
      await $.store.set(OPEN_KEY, false)
    }
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
    if (asked === 'mute' || asked === 'unmute') {
      const muted = asked === 'mute'
      await update($, isMuted, () => muted)
      await $.store.set(MUTED_KEY, muted)
      return { text: muted ? 'Roulette sounds off.' : 'Roulette sounds on.' }
    }
    if (asked !== '') {
      return { text: 'Usage: /roulette [reset|mute|unmute]' }
    }
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Roulette table closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Roulette', columns: PANE_COLUMNS })
    await $.store.set(OPEN_KEY, true)

    return {
      text: opened.isPlaced
        ? 'Roulette table opened.'
        : `Roulette table opened; not shown yet: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const g = await read($, game)
    const pointer = g.spin
      ? pointerAt(g.spin.from, g.spin.distance, g.spin.frame)
      : g.pointer
    // Docked, the wheel goes under the table, as wide as the pane; inline,
    // beside it, as tall as the pane. The biggest (odd rows) that fits, none
    // below the smallest.
    const isDocked = e.props.placement === 'dock'
    const { bodyColumns } = e.props
    let wheelRows = Math.min(
      MAX_WHEEL_ROWS,
      isDocked ? e.props.scroll.bodyRows - TABLE_ROWS : e.props.scroll.bodyRows,
    )
    wheelRows -= 1 - (wheelRows % 2)
    while (
      wheelRows >= MIN_WHEEL_ROWS &&
      wheelColumnsOf(wheelRows) + (isDocked ? 0 : TABLE_COLUMNS + 2) > bodyColumns
    ) {
      wheelRows -= 2
    }
    const hasArt = e.surface === 'terminal' && wheelRows >= MIN_WHEEL_ROWS
    const shown = Math.max(3, Math.min(13, Math.floor((bodyColumns - 2) / 4))) | 1
    const half = (shown - 1) / 2
    const pockets = Array.from({ length: shown }, (_, i) => {
      const index = (pointer - half + i + WHEEL.length * 2) % WHEEL.length
      return WHEEL[index] ?? 0
    })

    const art = hasArt
      ? drawWheel(
          wheelRows,
          g.spin
            ? {
                position: positionAt(g.spin.from, g.spin.distance, g.spin.frame),
                ball: ballAt(g.spin.frame),
              }
            : { position: g.pointer, ball: g.last ? 0 : null },
          WHEEL,
          REDS,
        )
      : null

    const table = (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
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
        {art === null && (
          <Box key="strip" flexDirection="column">
            <Box flexDirection="row">
              <Text>{' '.repeat(half * 4 + 1)}</Text>
              <Text color="warning">▼</Text>
            </Box>
            <Box flexDirection="row">
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
          </Box>
        )}
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
            <Box key="chips" flexDirection="row" flexWrap="wrap" columnGap={2}>
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
            <Box key="picks" flexDirection="row" flexWrap="wrap" columnGap={2}>
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

    return isDocked ? (
      <Box flexDirection="column" gap={1} width={bodyColumns}>
        <Box justifyContent="center">
          <Raster key="wheel-art" {...art} />
        </Box>
        {table}
      </Box>
    ) : (
      <Box flexDirection="row" gap={2} width={bodyColumns} justifyContent="space-between">
        {table}
        <Raster key="wheel-art" {...art} />
      </Box>
    )
  })
}
