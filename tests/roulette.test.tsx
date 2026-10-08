import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'roulette',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 40 },
} as const

const props = (isWorking: boolean) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 20,
  bodyColumns: 95,
  scroll: { bodyRows: 19, offset: 0, total: 0 },
  view: {},
})

const balanceOf = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }) => {
  const found = await ui.find({ type: 'Text', text: /^Balance/ })
  return Number((found?.text ?? '').replace(/[^\d]/g, ''))
}

test('the table shows only while Claude is working', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ ...BAND, surface, props: props(false) as never })
    expect(await idle.find({ type: 'Text', text: /Roulette/ })).toBeUndefined()
    await idle.unmount()

    const busy = await $.ui.mount({ ...BAND, surface, props: props(true) as never })
    expect(await busy.find({ type: 'Text', text: /Roulette/ })).toBeDefined()
    expect(await balanceOf(busy)).toBe(1000)
    await busy.unmount()
  }
})

test('a spin pays 2x on a colour, 36x on green, or takes the stake', async ($, on) => {
  const clock = mock.clock(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(true) as never })

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
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(true) as never })

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

test('the terminal draws the wheel beside the table; other surfaces skip it', async ($, on) => {
  const clock = mock.clock(on)
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(true) as never })
  expect(await terminal.find({ key: 'wheel-art' })).toBeDefined()
  await terminal.press({ key: 'pick-black' })
  await clock.advance(1000)
  expect(await terminal.find({ key: 'wheel-art' })).toBeDefined()
  await clock.advance(5000)
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop', props: props(true) as never })
  expect(await desktop.find({ key: 'wheel-art' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: /Roulette/ })).toBeDefined()
  await desktop.unmount()
})

test('/roulette always keeps the table up between turns, /roulette thinking hides it', async ($, on) => {
  mock.store(on)
  on('command.run', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const run = (args: string) =>
    $.command.run({ command: 'roulette', args } as never) as Promise<{ text?: string }>

  const before = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(false) as never })
  expect(await before.find({ type: 'Text', text: /Roulette/ })).toBeUndefined()
  await before.unmount()

  expect((await run('always')).text).toMatch(/always/)
  const always = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(false) as never })
  expect(await always.find({ type: 'Text', text: /Roulette/ })).toBeDefined()
  await always.unmount()

  expect((await run('')).text).toMatch(/thinking/)
  const thinking = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(false) as never })
  expect(await thinking.find({ type: 'Text', text: /Roulette/ })).toBeUndefined()
  await thinking.unmount()

  expect((await run('nope')).text).toMatch(/Usage/)
})

test('/roulette reset refills a busted bankroll mid-turn', async ($, on) => {
  const clock = mock.clock(on)
  on('command.run', () => ({ text: '' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: props(true) as never })

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
