import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import * as Vue from 'vue'
import {
  type App,
  type Plugin,
  Suspense,
  defineComponent,
  h,
  inject,
  nextTick,
  ref,
  watchEffect
} from 'vue'
import {
  config,
  disableAutoUnmount,
  enableAutoUnmount,
  flushPromises,
  mount,
  renderToString,
  shallowMount
} from '../../src'
import Counter from './Counter.vue'
import Unexposed from './Unexposed.vue'
import Async from './Async.vue'
import Teleported from './Teleported.vue'
import Directed from './Directed.vue'
import GlobalDefaults from './GlobalDefaults.vue'

// This suite requires 3.6; ordinary source/declaration checks also
// run on 3.5, so do not add a named Vapor-only import.
const interop = (Vue as unknown as { vaporInteropPlugin: Plugin })
  .vaporInteropPlugin
const options = { experimentalVapor: true as const }

describe('experimental Vapor mounting', () => {
  afterEach(() => {
    disableAutoUnmount()
    document.body.innerHTML = ''
  })

  test('mounts a compiled Vapor SFC with initial props, caller plugins and exposed-only vm', async () => {
    expect((Counter as { __vapor?: boolean }).__vapor).toBe(true)
    const listener = vi.fn<(value: number) => void>()
    const wrapper = mount(Counter, {
      ...options,
      props: { label: 'count', onChange: listener },
      global: {
        plugins: [
          { install: (app: App) => app.provide('mount-plugin', 'installed') }
        ]
      }
    })
    expect(wrapper.text()).toBe('count:0')
    expect(wrapper.attributes('aria-label')).toBe('count')
    expect(wrapper.attributes('data-plugin')).toBe('installed')
    expect(wrapper.classes()).toEqual(['counter'])
    expect(wrapper.html()).toContain('<button>count:0</button>')
    expect(wrapper.findAll('section.counter')).toHaveLength(1)
    expect(wrapper.find('.absent').exists()).toBe(false)
    expectTypeOf(wrapper.vm).toEqualTypeOf<{ count: number }>()
    expect(wrapper.vm.count).toBe(0)
    const untypedVm: Record<string, unknown> = wrapper.vm
    expect(untypedVm.hidden).toBeUndefined()
    expect(untypedVm.$).toBeUndefined()
    expect(untypedVm.$el).toBeUndefined()
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toBe('count:1')
    expect(wrapper.vm.count).toBe(1)
    expect(listener.mock.calls).toEqual([[1]])
    wrapper.unmount()
    expect(wrapper.exists()).toBe(false)
  })

  test('updates props without remounting', async () => {
    const observe = vi.fn<(value: number) => void>()
    const wrapper = mount(Counter, {
      ...options,
      props: { label: 'before', observe }
    })
    await wrapper.get('button').trigger('click')
    await wrapper.setProps({ label: 'after' })
    expect(wrapper.text()).toBe('after:1')
    expect(wrapper.attributes('aria-label')).toBe('after')
    await wrapper.setProps({ signal: ref(4) })
    expect(observe.mock.calls).toEqual([[0], [4]])
    wrapper.unmount()
  })

  test('applies Vapor function directives with reactive values and cleanup', async () => {
    expect((Directed as { __vapor?: boolean }).__vapor).toBe(true)
    const signal = ref(0)
    const observe = vi.fn<(text: string) => void>()
    const cleanup = vi.fn<() => void>()
    const wrapper = mount(Directed, {
      ...options,
      props: { label: 'before' },
      global: {
        directives: {
          label(el, getter, arg, modifiers) {
            watchEffect(() => {
              el.textContent = `${arg?.()}:${getter?.()}:${modifiers?.strong}:${signal.value}`
              observe(el.textContent)
            })
            return cleanup
          }
        }
      }
    })
    try {
      expect(wrapper.text()).toBe('prefix:before:true:0')
      await wrapper.setProps({ label: 'after' })
      expect(wrapper.text()).toBe('prefix:after:true:0')
      expect(observe.mock.calls).toEqual([
        ['prefix:before:true:0'],
        ['prefix:after:true:0']
      ])
    } finally {
      wrapper.unmount()
    }
    expect(cleanup).toHaveBeenCalledOnce()
    observe.mockClear()
    signal.value++
    await nextTick()
    expect(observe).not.toHaveBeenCalled()
  })

  test('accepts an explicitly installed interop plugin without duplicate warnings', () => {
    const warn = vi.spyOn(console, 'warn')
    try {
      for (const plugin of [interop, [interop] as [Plugin]]) {
        const wrapper = mount(Unexposed, {
          ...options,
          global: { plugins: [plugin] }
        })
        expect(wrapper.text()).toBe('firstsecond')
        wrapper.unmount()
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('uses an empty vm without defineExpose and reads multiple roots', () => {
    expect((Unexposed as { __vapor?: boolean }).__vapor).toBe(true)
    const wrapper = mount(Unexposed, options)
    expect(wrapper.vm).toEqual({})
    expect(wrapper.findAll('p').map(node => node.text())).toEqual([
      'first',
      'second'
    ])
    expect(wrapper.text()).toBe('firstsecond')
    wrapper.unmount()
  })

  test('finds content teleported from the root', () => {
    const wrapper = mount(Teleported, options)
    expect(wrapper.html()).toContain('<p class="teleported">teleported</p>')
    expect(wrapper.get('.teleported').text()).toBe('teleported')
    expect(document.body.querySelector('.teleported')).not.toBeNull()
    wrapper.unmount()
    expect(document.body.querySelector('.teleported')).toBeNull()
  })

  test('cleans attached DOM and effects on manual and automatic unmount', async () => {
    let cleanup!: () => void
    enableAutoUnmount(callback => {
      cleanup = callback
    })
    const signal = ref(0)
    const observe = vi.fn<(value: number) => void>()
    const disposed = vi.fn<() => void>()
    const wrapper = mount(Counter, {
      ...options,
      attachTo: document.body,
      props: { label: 'cleanup', signal, observe, cleanup: disposed }
    })
    const vdom = mount(defineComponent({ template: '<p>VDOM</p>' }))
    expect(observe).toHaveBeenLastCalledWith(0)
    signal.value = 3
    await nextTick()
    expect(observe).toHaveBeenLastCalledWith(3)
    wrapper.unmount()
    await nextTick()
    expect(disposed).toHaveBeenCalledOnce()
    expect(document.body.children).toHaveLength(0)
    observe.mockClear()
    signal.value = 7
    await nextTick()
    expect(observe).not.toHaveBeenCalled()
    cleanup()
    expect(disposed).toHaveBeenCalledOnce()
    expect(vdom.exists()).toBe(false)

    const automatic = mount(Unexposed, { ...options, attachTo: document.body })
    cleanup()
    expect(automatic.exists()).toBe(false)
    expect(document.body.children).toHaveLength(0)
  })

  test('leaves existing VDOM stubbing intact', async () => {
    const Child = defineComponent({
      name: 'Child',
      props: ['label'],
      template: '<strong>{{ label }}</strong>'
    })
    const Parent = defineComponent({
      props: ['label'],
      setup: props => () => h(Child, { label: props.label })
    })
    const vdom = shallowMount(Parent, { props: { label: 'before' } })
    const vapor = mount(Counter, { ...options, props: { label: 'Vapor' } })
    await vdom.setProps({ label: 'after' })
    expect(vdom.find('child-stub').attributes('label')).toBe('after')
    expect(vdom.find('strong').exists()).toBe(false)
    expect(vapor.text()).toBe('Vapor:0')
    vdom.unmount()
    vapor.unmount()
  })

  test('mounts VDOM components rendering Vapor children', async () => {
    const global = { plugins: [interop] }
    const Parent = defineComponent({
      props: ['label'],
      setup: props => () => h(Counter, { label: props.label })
    })
    const wrapper = mount(Parent, { props: { label: 'before' }, global })
    expect(wrapper.element).toBe(wrapper.find('section').element)
    await wrapper.setProps({ label: 'after' })
    await wrapper.get('button').trigger('click')
    expect(wrapper.html()).toContain('<button>after:1</button>')
    expect(wrapper.emitted('click')).toHaveLength(1)
    expect(wrapper.findComponent({ name: 'Missing' }).exists()).toBe(false)
    expect(wrapper.findComponent(Parent).props('label')).toBe('after')
    expect(() => wrapper.findComponent(Counter)).toThrow('Component discovery')
    wrapper.unmount()

    const MultiRoot = defineComponent({ setup: () => () => h(Unexposed) })
    const multi = mount(MultiRoot, { global })
    expect(multi.text()).toBe('firstsecond')
    expect(multi.element).toBe(multi.find('p').element.parentElement)
    multi.unmount()
  })

  test('mounts async Vapor setup inside Suspense', async () => {
    const wrapper = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(Async) })
      }),
      { global: { plugins: [interop] } }
    )
    expect(wrapper.text()).toBe('')
    await flushPromises()
    expect(wrapper.html()).toBe('<p>async</p>')
    wrapper.unmount()
  })

  test('accepts attrs and undefined options', () => {
    const wrapper = mount(Counter, {
      ...options,
      props: { label: 'attrs' },
      attrs: { id: 'root' },
      slots: undefined
    })
    expect(wrapper.attributes('id')).toBe('root')
    wrapper.unmount()
  })

  test('ignores inherited VDOM-only defaults without changing subsequent VDOM mounts', () => {
    const {
      mocks,
      stubs,
      mixins,
      renderStubDefaultSlot,
      components,
      provide,
      plugins
    } = config.global
    const Child = defineComponent({
      name: 'GlobalChild',
      setup() {
        return {
          inherited: inject('inherited-mixin', 'none'),
          provided: inject('supported-provide', 'none'),
          plugin: inject('supported-plugin', 'none')
        }
      },
      render() {
        return h(
          'strong',
          {
            'data-inherited': this.inherited,
            'data-provided': this.provided,
            'data-plugin': this.plugin
          },
          typeof this.$t === 'function' ? this.$t('child') : 'child'
        )
      }
    })
    Object.assign(config.global, {
      mocks: { $t: (key: string) => `mocked ${key}` },
      stubs: { ...stubs, GlobalChild: true },
      mixins: [{ provide: { 'inherited-mixin': 'mixin' } }],
      renderStubDefaultSlot: true,
      components: { ...components, GlobalChild: Child },
      provide: { ...provide, 'supported-provide': 'provided' },
      plugins: [
        ...plugins,
        { install: (app: App) => app.provide('supported-plugin', 'installed') }
      ]
    })
    try {
      const vapor = mount(GlobalDefaults, options)
      try {
        expect(vapor.text()).toBe('child')
        expect(vapor.get('strong').attributes()).toMatchObject({
          'data-inherited': 'none',
          'data-provided': 'provided',
          'data-plugin': 'installed'
        })
      } finally {
        vapor.unmount()
      }

      const vdom = mount(Child)
      try {
        expect(vdom.text()).toBe('mocked child')
        expect(vdom.attributes()).toMatchObject({
          'data-inherited': 'mixin',
          'data-provided': 'provided',
          'data-plugin': 'installed'
        })
      } finally {
        vdom.unmount()
      }
      const stubbed = mount({
        setup: () => () => h(Child, null, { default: () => 'slot' })
      })
      try {
        expect(stubbed.get('global-child-stub').text()).toBe('slot')
      } finally {
        stubbed.unmount()
      }
    } finally {
      Object.assign(config.global, {
        mocks,
        stubs,
        mixins,
        renderStubDefaultSlot,
        components,
        provide,
        plugins
      })
    }
  })

  test('rejects Vapor component ref discovery while preserving VDOM and DOM refs', () => {
    const Child = defineComponent({
      setup(_, { expose }) {
        expose({ count: ref(3) })
        return () => h('span', 'VDOM')
      }
    })
    for (const refInFor of [false, true]) {
      const Parent = defineComponent({
        setup: () => () =>
          h('div', [
            h(Counter, { label: 'ref', ref: 'vapor', ref_for: refInFor }),
            h(Unexposed, { ref: 'unexposed', ref_for: refInFor }),
            h(Child, { ref: 'vdom', ref_for: refInFor }),
            h('input', { ref: 'input' })
          ])
      })
      const wrapper = mount(Parent, { global: { plugins: [interop] } })
      try {
        for (const ref of ['vapor', 'unexposed']) {
          expect(() => wrapper.findComponent({ ref })).toThrow(
            'Component discovery is not supported for Vapor'
          )
          expect(() => wrapper.getComponent({ ref })).toThrow(
            'Component discovery is not supported for Vapor'
          )
        }
        expect(wrapper.findComponent({ ref: 'vdom' }).vm.count).toBe(3)
        expect(wrapper.findComponent({ ref: 'missing' }).exists()).toBe(false)
        expect(wrapper.findComponent({ ref: 'input' }).exists()).toBe(false)
        expect(wrapper.find({ ref: 'input' }).element).toBeInstanceOf(
          HTMLInputElement
        )
      } finally {
        wrapper.unmount()
      }
    }
  })

  test('rejects missing opt-in and unsupported features explicitly', () => {
    expect(() => mount(Counter)).toThrow('experimentalVapor: true')
    expect(() => shallowMount(Counter, options)).toThrow('shallow')
    expect(() => renderToString(Counter, options)).toThrow(
      'renderToString is not supported'
    )
    expect(() => mount(Async, options)).toThrow('inside <Suspense>')
    for (const extra of [
      { slots: { default: 'slot' } },
      { data: () => ({ count: 1 }) },
      { global: { stubs: { Child: true } } },
      { global: { mocks: { $t: () => '' } } },
      { global: { mixins: [{}] } },
      { global: { renderStubDefaultSlot: true } },
      { global: { directives: { Focus: { mounted: () => {} } } } }
    ]) {
      expect(() => mount(Counter, { ...options, ...extra } as any)).toThrow(
        'does not support'
      )
    }
    const wrapper = mount(Counter, {
      ...options,
      props: { label: 'unsupported' },
      // Vapor function directives are accepted.
      global: { directives: { Focus: () => {} } }
    })
    expect(() => wrapper.emitted('change')).toThrow('emitted is not supported')
    expect(() => wrapper.findComponent(Counter)).toThrow('Component discovery')
    expect(() => wrapper.findAllComponents(Counter)).toThrow(
      'Component discovery'
    )
    expect(() => wrapper.getComponent(Counter)).toThrow('Component discovery')
    expect(() => wrapper.find({ ref: 'button' })).toThrow('Ref selectors')
    expect(() => wrapper.setData({})).toThrow('setData')
    expect(() => wrapper.setValue('new')).toThrow('DOM wrapper')
    wrapper.unmount()
  })

  test('cleans the container when setup fails', () => {
    expect(() =>
      mount(Counter, {
        ...options,
        attachTo: document.body,
        props: {
          label: 'failure',
          observe: () => {
            throw new Error('setup failed')
          }
        }
      })
    ).toThrow('setup failed')
    expect(document.body.children).toHaveLength(0)
  })
})
