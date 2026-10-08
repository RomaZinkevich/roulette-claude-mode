import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, Register } from 'claude-code'

import type { Bet, Death, Game, Pick } from '../types'
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
// null when death mode is off; never stored, so it never greets a session.
const death = atom(
  { plugin: 'roulette', key: 'death' } as const,
  null as Death | null,
)

// Frames the losing colour is held before the fake deletion, then the
// fake-deletion scene's own length. The wheel spins for SPIN_FRAMES.
const WRONG_FRAMES = 12
const DOOM_FRAMES = 32
// The "files" the fake deletion names: a scare, deleted only on screen. Real
// ones, so it stings; nothing here is ever read or touched on disk.
const FAKE_PATHS = [
  'hooks/register.tsx',
  'hooks/wheel.ts',
  'types/index.d.ts',
  'tests/roulette.test.tsx',
  'package.json',
  'tsconfig.json',
  '.git/HEAD',
  'README.md',
  'node_modules/',
  '~/Documents/',
  '~/.ssh/id_ed25519',
  'everything else',
]

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

let deathTicker: { cancel: () => void } | null = null

const endDeathTicker = () => {
  deathTicker?.cancel()
  deathTicker = null
}

// A pocket that is red or black — death mode never lands on green.
const deathPocket = () => {
  let n = randomPocket()
  while (n === 0) {
    n = randomPocket()
  }
  return n
}

// Takes the guess and spins the real wheel; then a clean win, or the losing
// colour held a beat before the fake-deletion scene. No bet, no bankroll.
const guess = async ($: EngineInterface, pick: Pick) => {
  const d = await read($, death)
  if (!d || d.phase !== 'armed') {
    return
  }
  const result = deathPocket()
  const target = WHEEL.indexOf(result)
  const distance =
    WHEEL.length * 2 + ((target - d.from + WHEEL.length) % WHEEL.length)
  await update($, death, cur =>
    cur && cur.phase === 'armed'
      ? { ...cur, phase: 'spinning' as const, pick, result, distance, frame: 0 }
      : cur,
  )
  void playSound($, 'spin.wav')
  endDeathTicker()
  deathTicker = $.clock.every(FRAME_MS, () => {
    void update($, death, cur =>
      cur && cur.phase !== 'armed' && cur.phase !== 'reprieve' && cur.phase !== 'survived'
        ? { ...cur, frame: cur.frame + 1 }
        : cur,
    ).then(async () => {
      const now = await read($, death)
      if (!now) {
        endDeathTicker()
        return
      }
      if (now.phase === 'spinning' && now.frame >= SPIN_FRAMES) {
        // The wheel has landed. Rest the pointer on the pocket it stopped on.
        const from = pointerAt(now.from, now.distance, SPIN_FRAMES)
        const survived = now.result !== null && colorOf(now.result) === now.pick
        if (survived) {
          endDeathTicker()
        }
        await update($, death, cur =>
          cur
            ? { ...cur, phase: survived ? ('survived' as const) : ('wrong' as const), from, frame: 0 }
            : cur,
        )
        void playSound($, survived ? 'jackpot.wav' : 'lose.wav')
      } else if (now.phase === 'wrong' && now.frame >= WRONG_FRAMES) {
        await update($, death, cur => (cur ? { ...cur, phase: 'doom' as const, frame: 0 } : cur))
      } else if (now.phase === 'doom' && now.frame >= DOOM_FRAMES) {
        endDeathTicker()
        await update($, death, cur => (cur ? { ...cur, phase: 'reprieve' as const } : cur))
      }
    })
  })
}

const armDeath = ($: EngineInterface) => {
  endDeathTicker()
  return update($, death, prev => ({
    phase: 'armed' as const,
    pick: null,
    result: null,
    // Spin on from where the last one landed, so the wheel doesn't jump.
    from: prev ? prev.from : 0,
    distance: 0,
    frame: 0,
  }))
}

const leaveDeath = ($: EngineInterface) => {
  endDeathTicker()
  return update($, death, () => null)
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
      // 'death' is a hidden easter egg, left out of the hint and usage on purpose.
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
    if (asked === 'death') {
      // Arm death mode and make sure the pane is up to show it.
      await armDeath($)
      await $.ui.open({ id: PANE, title: 'Roulette', columns: PANE_COLUMNS })
      await $.store.set(OPEN_KEY, true)
      return { text: 'Death mode armed. It is all bluff — nothing is deleted.' }
    }
    if (asked !== '') {
      return { text: 'Usage: /roulette [reset|mute|unmute]' }
    }
    // A plain /roulette while death mode is up just backs out of it.
    if ((await read($, death)) !== null) {
      await leaveDeath($)
      return { text: 'Left death mode.' }
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

    // The wheel's size and place are the same whatever is on the table.
    // Docked, it sits above; inline, beside. Biggest odd size that fits.
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

    // Lays a drawn wheel out with the panel: above it docked, beside inline.
    const withWheel = (
      art: ReturnType<typeof drawWheel> | null,
      panel: RenderElement,
    ): RenderElement => {
      if (art === null || e.surface !== 'terminal') {
        return panel
      }
      const { Raster } = $.ui.resolve(e)
      return isDocked ? (
        <Box flexDirection="column" gap={1} width={bodyColumns}>
          <Box justifyContent="center">
            <Raster key="wheel-art" {...art} />
          </Box>
          {panel}
        </Box>
      ) : (
        <Box flexDirection="row" gap={2} width={bodyColumns} justifyContent="space-between">
          {panel}
          <Raster key="wheel-art" {...art} />
        </Box>
      )
    }

    // Death mode: the same wheel, but no money — red or black, one guess.
    const d = await read($, death)
    if (d !== null) {
      const width = bodyColumns

      if (d.phase === 'doom') {
        const bar = (filled: number, total: number, lit: string, dim: string) =>
          lit.repeat(Math.max(0, Math.min(total, filled))) +
          dim.repeat(Math.max(0, total - filled))
        // The fake deletion: a scrolling log of paths that are never touched.
        const log = Array.from({ length: 6 }, (_, i) => {
          const at = d.frame - (5 - i)
          return at >= 0 ? FAKE_PATHS[at % FAKE_PATHS.length] ?? '' : null
        })
        return (
          <Box flexDirection="column" width={width}>
            <Text backgroundColor="#b3262e" color="#ffffff" bold>
              {' '.repeat(width)}
            </Text>
            <Text color="#ff5555" bold>
              {d.frame % 2 ? '  ☠  DELETING EVERYTHING  ☠' : '     DELETING EVERYTHING'}
            </Text>
            <Box flexDirection="column">
              {log.map((path, i) =>
                path === null ? (
                  <Text key={`log-${i}`}> </Text>
                ) : (
                  <Text key={`log-${i}`} color="#c0392b">
                    rm -rf {path}
                  </Text>
                ),
              )}
            </Box>
            <Text color="#ff5555">
              [{bar(Math.round((d.frame / DOOM_FRAMES) * 18), 18, '█', '░')}]
            </Text>
          </Box>
        )
      }

      if (d.phase === 'reprieve') {
        return (
          <Box flexDirection="column" gap={1} width={width}>
            <Text bold>nvm.</Text>
            <Text>
              opus 5.5 said its too destructive and i dont want to argue with
              super intelligence or lose my claude account
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Button key="again" plain hotkey="r" label="Again" onPress={() => armDeath($)} />
              <Button key="leave" plain hotkey="q" label="Leave" onPress={() => leaveDeath($)} />
            </Box>
          </Box>
        )
      }

      // The wheel: turning while 'spinning', then at rest on the pocket it
      // stopped on. No ball until it has somewhere to land.
      const n = d.result ?? 0
      const deathArt = hasArt
        ? drawWheel(
            wheelRows,
            d.phase === 'spinning'
              ? {
                  position: positionAt(d.from, d.distance, d.frame),
                  ball: ballAt(d.frame),
                }
              : { position: d.from, ball: d.result !== null ? 0 : null },
            WHEEL,
            REDS,
          )
        : null

      if (d.phase === 'survived') {
        return withWheel(
          deathArt,
          <Box flexDirection="column" gap={1}>
            <Text color="success" bold>
              SPARED.
            </Text>
            <Text>
              {n} {colorOf(n)}. you called it.
            </Text>
            <Text dimColor>the files live. this time.</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Button key="again" plain hotkey="r" label="Again" onPress={() => armDeath($)} />
              <Button key="leave" plain hotkey="q" label="Leave" onPress={() => leaveDeath($)} />
            </Box>
          </Box>,
        )
      }

      if (d.phase === 'wrong') {
        return withWheel(
          deathArt,
          <Box flexDirection="column" gap={1}>
            <Text color="#ff5555" bold>
              WRONG.
            </Text>
            <Text>
              {n} {colorOf(n)}. you said {d.pick}.
            </Text>
            <Text color="#ff5555">deleting everything…</Text>
          </Box>,
        )
      }

      if (d.phase === 'spinning') {
        return withWheel(
          deathArt,
          <Box flexDirection="column" gap={1}>
            <Text color="#ff5555" bold>
              ☠ DEATH ROULETTE ☠
            </Text>
            <Text dimColor>you said {d.pick}. round and round…</Text>
          </Box>,
        )
      }

      // armed
      return withWheel(
        deathArt,
        <Box flexDirection="column" gap={1}>
          <Text color="#ff5555" bold>
            ☠ DEATH ROULETTE ☠
          </Text>
          <Text>No chips. No bankroll. One guess.</Text>
          <Text dimColor>Guess wrong and every file here is deleted.</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="death-red" plain hotkey="r" label="Red" onPress={() => guess($, 'red')} />
            <Button key="death-black" plain hotkey="b" label="Black" onPress={() => guess($, 'black')} />
            <Button key="flee" plain hotkey="q" label="Flee" onPress={() => leaveDeath($)} />
          </Box>
          <Text dimColor>ctrl+x tab to focus, then press r or b</Text>
        </Box>,
      )
    }

    const g = await read($, game)
    const pointer = g.spin
      ? pointerAt(g.spin.from, g.spin.distance, g.spin.frame)
      : g.pointer
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

    return withWheel(art, table)
  })
}
