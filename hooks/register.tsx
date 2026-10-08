import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bet, Game, Pick } from '../types'

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

const colorOf = (n: number): Pick =>
  n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black'

const payoutOf = (pick: Pick) => (pick === 'green' ? 36 : 2)

const money = (n: number) => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

const randomPocket = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 37

const easeOut = (t: number) => 1 - (1 - t) ** 3

const pointerAt = (from: number, distance: number, frame: number) =>
  Math.round(from + distance * easeOut(Math.min(1, frame / SPIN_FRAMES))) %
  WHEEL.length

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

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A new thinking session refills a busted bankroll.
    await update($, game, g =>
      g.isBust ? { ...INITIAL, pointer: g.pointer } : g,
    )

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !e.props.isWorking) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const g = await read($, game)
    const pointer = g.spin
      ? pointerAt(g.spin.from, g.spin.distance, g.spin.frame)
      : g.pointer
    const shown =
      Math.max(3, Math.min(13, Math.floor((e.props.bodyColumns - 2) / 4))) | 1
    const half = (shown - 1) / 2
    const pockets = Array.from({ length: shown }, (_, i) => {
      const index = (pointer - half + i + WHEEL.length * 2) % WHEEL.length
      return WHEEL[index] ?? 0
    })

    return (
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
  })
}
