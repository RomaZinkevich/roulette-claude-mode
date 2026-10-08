import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'roulette',
  component: 'Pane',
  requestId: 'roulette',
  viewport: { columns: 160, rows: 40 },
} as const

// Docked beside the transcript by default, a column floor to ceiling.
const props = (placement: 'dock' | 'inline' = 'dock', bodyColumns = 32, bodyRows = 38) => ({
  title: 'Roulette',
  isFocused: false,
  bodyColumns,
  placement,
  scroll: { bodyRows, offset: 0, total: 0 },
  view: {},
})

const balanceOf = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }) => {
  const found = await ui.find({ type: 'Text', text: /^Balance/ })
  return Number((found?.text ?? '').replace(/[^\d]/g, ''))
}

test('/roulette opens the table in a pane, and again closes it', async ($, on) => {
  mock.store(on)
  on('command.run', () => ({ text: '' }))
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }) as never)
  const run = (args: string) =>
    $.command.run({ command: 'roulette', args } as never) as Promise<{ text?: string }>

  expect((await run('')).text).toMatch(/opened/)
  expect([...open]).toEqual(['roulette'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: props() as never })
    expect(await ui.find({ type: 'Text', text: /Roulette/ })).toBeDefined()
    expect(await balanceOf(ui)).toBe(1000)
    await ui.unmount()
  }

  expect((await run('')).text).toMatch(/closed/)
  expect([...open]).toEqual([])
  expect((await run('nope')).text).toMatch(/Usage/)
})

test('a spin pays 2x on a colour, 36x on green, or takes the stake', async ($, on) => {
  const clock = mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props() as never })

  await ui.press({ key: 'chip-2' })
  await ui.press({ key: 'pick-red' })
  expect(await ui.find({ type: 'Text', text: /Spinning/ })).toBeDefined()
  await clock.advance(5000)

  expect(await ui.find({ type: 'Text', text: /Spinning/ })).toBeUndefined()
  expect([900, 1100]).toContain(await balanceOf(ui))
  await ui.unmount()
})

test('going broke ends the game until the next turn', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props() as never })

  await ui.press({ key: 'chip-5' })
  for (let i = 0; i < 60; i += 1) {
    if (await ui.find({ type: 'Text', text: /Game over/ })) {
      break
    }
    await ui.press({ key: 'pick-green' })
    await clock.advance(5000)
  }
  expect(await ui.find({ type: 'Text', text: /Game over/ })).toBeDefined()
  expect(await ui.find({ key: 'pick-red' })).toBeUndefined()

  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await ui.find({ type: 'Text', text: /Game over/ })).toBeUndefined()
  expect(await balanceOf(ui)).toBe(1000)
  await ui.unmount()
})

test('the terminal draws the wheel with the table; other surfaces show the strip', async ($, on) => {
  const clock = mock.clock(on)
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: props() as never })
  expect(await terminal.find({ key: 'wheel-art' })).toBeDefined()
  expect(await terminal.find({ key: 'strip' })).toBeUndefined()
  await terminal.press({ key: 'pick-black' })
  await clock.advance(1000)
  expect(await terminal.find({ key: 'wheel-art' })).toBeDefined()
  await clock.advance(5000)
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: props() as never })
  expect(await desktop.find({ key: 'wheel-art' })).toBeUndefined()
  expect(await desktop.find({ key: 'strip' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /Roulette/ })).toBeDefined()
  await desktop.unmount()
})

test('a short pane above the prompt gets a smaller wheel; too short a one gets the strip', async ($, on) => {
  const small = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: props('inline', 69, 8) as never,
  })
  expect(await small.find({ key: 'wheel-art' })).toBeDefined()
  await small.unmount()

  const tiny = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: props('inline', 69, 6) as never,
  })
  expect(await tiny.find({ key: 'wheel-art' })).toBeUndefined()
  expect(await tiny.find({ key: 'strip' })).toBeDefined()
  await tiny.unmount()
})

test('/roulette reset refills a busted bankroll mid-turn', async ($, on) => {
  const clock = mock.clock(on)
  on('command.run', () => ({ text: '' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props() as never })

  await ui.press({ key: 'chip-5' })
  for (let i = 0; i < 60 && !(await ui.find({ type: 'Text', text: /Game over/ })); i += 1) {
    await ui.press({ key: 'pick-green' })
    await clock.advance(5000)
  }
  expect(await ui.find({ type: 'Text', text: /Game over/ })).toBeDefined()

  const reset = (await $.command.run({ command: 'roulette', args: 'reset' } as never)) as { text?: string }
  expect(reset.text).toMatch(/\$1,000/)
  expect(await ui.find({ type: 'Text', text: /Game over/ })).toBeUndefined()
  expect(await balanceOf(ui)).toBe(1000)
  expect(await ui.find({ key: 'pick-red' })).toBeDefined()
  await ui.unmount()
})

test('a spin plays its sound, then the result; /roulette mute silences both', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.run', () => ({ text: '' }))
  const played: string[] = []
  on('audio.play', async ($, e) => {
    played.push(String((e.clip as { asset?: string }).asset ?? JSON.stringify(e.clip)))
    return { value: undefined } as never
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props() as never })

  await ui.press({ key: 'pick-red' })
  await clock.advance(5000)
  expect(played[0]).toMatch(/spin\.wav/)
  expect(played[1]).toMatch(/(win|lose)\.wav/)

  await $.command.run({ command: 'roulette', args: 'mute' } as never)
  await ui.press({ key: 'pick-black' })
  await clock.advance(5000)
  expect(played).toHaveLength(2)
  await ui.unmount()
})
