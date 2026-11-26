import type {
  AppConfig,
  ComponentOptions,
  ConcreteComponent,
  DefineComponent,
  Plugin
} from 'vue'
import * as Vue from 'vue'
import type { VNode } from 'vue'
import {
  Comment,
  Fragment,
  Text,
  cloneVNode,
  createApp,
  createVNode,
  defineComponent,
  h,
  isVNode,
  proxyRefs,
  ref,
  shallowReactive,
  withCtx
} from 'vue'

import type { MountingOptions, Slot } from './types'
import {
  getComponentsFromStubs,
  getDirectivesFromStubs,
  isFunctionalComponent,
  isObject,
  isObjectComponent,
  isScriptSetup,
  mergeDeep,
  mergeGlobalProperties
} from './utils'
import { processSlot } from './utils/compileSlots'
import { attachEmitListener } from './emit'
import { registerStub } from './stubs'
import {
  isLegacyFunctionalComponent,
  unwrapLegacyVueExtendComponent
} from './utils/vueCompatSupport'
import {
  createVNodeTransformer,
  installVNodeTransformer
} from './vnodeTransformers/util'
import type { CreateStubComponentsTransformerConfig } from './vnodeTransformers/stubComponentsTransformer'
import { createStubComponentsTransformer } from './vnodeTransformers/stubComponentsTransformer'
import { createStubDirectivesTransformer } from './vnodeTransformers/stubDirectivesTransformer'

const MOUNT_OPTIONS: ReadonlyArray<keyof MountingOptions<any>> = [
  'attachTo',
  'attrs',
  'data',
  'props',
  'slots',
  'global',
  'shallow',
  'experimentalVapor'
] as const

function getInstanceOptions(
  options: MountingOptions<any> & Record<string, any>
): Record<string, any> {
  if (options.methods) {
    console.warn(
      "Passing a `methods` option to mount was deprecated on Vue Test Utils v1, and it won't have any effect on v2. For additional info: https://vue-test-utils.vuejs.org/upgrading-to-v1/#setmethods-and-mountingoptions-methods"
    )
    delete options.methods
  }

  const resultOptions = { ...options }
  for (const key of Object.keys(options)) {
    if (MOUNT_OPTIONS.includes(key as keyof MountingOptions<any>)) {
      delete resultOptions[key]
    }
  }
  return resultOptions
}

// implementation
export function createInstance(
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  inputComponent: DefineComponent<{}, {}, any, any, any, any>,
  options?: MountingOptions<any> & Record<string, any>
) {
  // normalize the incoming component
  const originalComponent = unwrapLegacyVueExtendComponent(inputComponent)
  const isVapor = !!(originalComponent as any).__vapor
  if (isVapor || options?.experimentalVapor) {
    // Require both a compiled Vapor component and explicit opt-in so a VDOM
    // fallback cannot silently pass as an experimental Vapor mount.
    if (!isVapor || !options?.experimentalVapor) {
      throw new Error('Mount Vapor components with experimentalVapor: true')
    }
    const setup =
      typeof originalComponent === 'function'
        ? originalComponent
        : originalComponent.setup
    // Vapor crashes when mounting an async setup without <Suspense>. As for
    // VDOM, async setup must be mounted inside a <Suspense> parent instead.
    if (setup?.constructor.name === 'AsyncFunction') {
      throw new Error(
        'Async Vapor setup is not supported by mount(); mount it inside <Suspense> instead'
      )
    }
    // Reject unsupported VDOM mounting options rather than silently ignoring
    // them. Only check this mount's options: inherited VDOM-only defaults are
    // filtered out of the merged globals below.
    const mountGlobal = options.global ?? {}
    const unsupported = [
      ...Object.keys(options).filter(
        key =>
          options[key] !== undefined &&
          ![
            'experimentalVapor',
            'attachTo',
            'attrs',
            'props',
            'propsData',
            'global',
            'shallow'
          ].includes(key)
      ),
      options.shallow && 'shallow',
      mountGlobal.mixins?.length && 'global.mixins',
      Object.keys(mountGlobal.mocks ?? {}).length && 'global.mocks',
      mountGlobal.renderStubDefaultSlot && 'global.renderStubDefaultSlot',
      // Vapor directives are functions; VDOM object directives would be skipped.
      Object.values(mountGlobal.directives ?? {}).some(
        directive => typeof directive !== 'function'
      ) && 'global.directives',
      mountGlobal.stubs &&
        Object.values(mountGlobal.stubs).some(Boolean) &&
        'global.stubs'
    ].filter(Boolean)
    if (unsupported.length) {
      throw new Error(
        `Vapor mounting does not support: ${unsupported.join(', ')}`
      )
    }
  }
  let component: ConcreteComponent
  const instanceOptions = getInstanceOptions(options ?? {})

  const rootComponents: CreateStubComponentsTransformerConfig['rootComponents'] =
    {}

  if (isVapor) {
    component = originalComponent
  } else if (
    isFunctionalComponent(originalComponent) ||
    isLegacyFunctionalComponent(originalComponent)
  ) {
    component = defineComponent({
      compatConfig: {
        MODE: 3,
        INSTANCE_LISTENERS: false,
        INSTANCE_ATTRS_CLASS_STYLE: false,
        COMPONENT_FUNCTIONAL: isLegacyFunctionalComponent(originalComponent)
          ? 'suppress-warning'
          : false
      },
      props: originalComponent.props || {},
      setup:
        (props, { attrs, slots }) =>
        () =>
          h(originalComponent, { ...props, ...attrs }, slots),
      ...instanceOptions
    })
    rootComponents.functional = originalComponent
  } else if (isObjectComponent(originalComponent)) {
    component = { ...originalComponent, ...instanceOptions }
  } else {
    component = originalComponent
  }

  rootComponents.component = component
  // We've just replaced our component with its copy
  // Let's register it as a stub so user can find it
  registerStub({ source: originalComponent, stub: component })

  function slotToFunction(slot: Slot) {
    switch (typeof slot) {
      case 'function':
        return slot
      case 'object':
        return () => h(slot)
      case 'string':
        return processSlot(slot)
      default:
        throw Error(`Invalid slot received.`)
    }
  }

  // handle any slots passed via mounting options
  const slots =
    options?.slots &&
    Object.entries(options.slots).reduce(
      (
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        acc: { [key: string]: Function },
        [name, slot]: [string, Slot]
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      ): { [key: string]: Function } => {
        if (Array.isArray(slot)) {
          const normalized = slot.map(slotToFunction)
          acc[name] = (args: unknown) => normalized.map(f => f(args))
          return acc
        }

        acc[name] = slotToFunction(slot)
        return acc
      },
      {}
    )

  // override component data with mounting options data
  if (options?.data) {
    const providedData = options.data()
    if (isObjectComponent(originalComponent)) {
      // component is guaranteed to be the same type as originalComponent
      const objectComponent = component as ComponentOptions
      if (originalComponent.data) {
        const originalDataFn = originalComponent.data
        objectComponent.data = vm => ({
          ...originalDataFn.call(vm, vm),
          ...providedData
        })
      } else if (objectComponent.setup) {
        const originalSetupFn = objectComponent.setup
        objectComponent.setup = function (a, b) {
          const data = originalSetupFn(a, b)
          mergeDeep(proxyRefs(data), providedData)
          return data
        }
      } else {
        objectComponent.data = () => ({ ...providedData })
      }
    } else {
      throw new Error('data() option is not supported on functional components')
    }
  }

  const MOUNT_COMPONENT_REF = 'VTU_COMPONENT'
  // we define props as reactive so that way when we update them with `setProps`
  // Vue's reactivity system will cause a rerender.
  const props = shallowReactive<Record<string, unknown>>({
    ...options?.attrs,
    ...options?.propsData,
    ...options?.props,
    ref: MOUNT_COMPONENT_REF
  })

  const global = mergeGlobalProperties(options?.global)
  if (isVapor) {
    // These VDOM-only defaults can still affect the VDOM host and component
    // registration. Clear them on this mount's copy, not on config.global.
    global.mixins = []
    global.mocks = {}
    global.stubs = {}
    global.renderStubDefaultSlot = false
  }
  if (isObjectComponent(component) && !isVapor) {
    component.components = { ...component.components, ...global.components }
  }

  const componentRef = ref(null)
  // create the wrapper component
  const Parent = defineComponent({
    name: 'VTU_ROOT',
    setup() {
      return {
        [MOUNT_COMPONENT_REF]: componentRef
      }
    },
    render() {
      return h(
        component as ComponentOptions,
        props,
        slots && toCompiledSlots(slots)
      )
    }
  })

  // create the app
  const app = createApp(Parent)

  // add tracking for emitted events
  // this must be done after `createApp`: https://github.com/vuejs/test-utils/issues/436
  attachEmitListener()

  // global mocks mixin
  if (Object.keys(global?.mocks ?? {}).length > 0) {
    const mixin: ComponentOptions = {
      beforeCreate() {
        // we need to differentiate components that are or not not `script setup`
        // otherwise we run into a proxy set error
        // due to https://github.com/vuejs/core/commit/f73925d76a76ee259749b8b48cb68895f539a00f#diff-ea4d1ddabb7e22e17e80ada458eef70679af4005df2a1a6b73418fec897603ceR404
        // introduced in Vue v3.2.45
        // Also ensures not to include option API components in this block
        // since they can also have setup state but need to be patched using
        // the regular method.
        if (isScriptSetup(this)) {
          // add the mocks to setupState
          for (const [k, v] of Object.entries(
            global.mocks as { [key: string]: any }
          )) {
            // we do this in a try/catch, as some properties might be read-only
            try {
              this.$.setupState[k] = v
              // eslint-disable-next-line no-empty
            } catch (e) {}
          }
          // also intercept the proxy calls to make the mocks available on the instance
          // (useful when a template access a global function like $t and the developer wants to mock it)
          ;(this.$ as any).proxy = new Proxy((this.$ as any).proxy, {
            get(target, key) {
              if (key in global.mocks) {
                return global.mocks[key as string]
              }
              return target[key]
            }
          })
        } else {
          for (const [k, v] of Object.entries(
            global.mocks as { [key: string]: any }
          )) {
            // the proxy rejects `$x` when `x` is an internal instance field
            // (e.g. `$u` from uView), so we define these directly on the context
            if (k[0] === '$' && k.slice(1) in this.$) {
              Object.defineProperty((this.$ as any).ctx, k, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: v
              })
            } else {
              ;(this as any)[k] = v
            }
          }
        }
      }
    }

    app.mixin(mixin)
  }

  // AppConfig
  if (global.config) {
    for (const [k, v] of Object.entries(global.config) as [
      keyof Omit<AppConfig, 'isNativeTag'>,
      any
    ][]) {
      // TODO should be switched to a ts-expect-error once Vue 3.5 is used
      // @ts-expect-error https://github.com/vuejs/test-utils/issues/2483
      app.config[k] = isObject(app.config[k])
        ? Object.assign(app.config[k]!, v)
        : v
    }
  }

  // provide any values passed via provides mounting option
  if (global.provide) {
    for (const key of Reflect.ownKeys(global.provide)) {
      // TODO should be switched to a ts-expect-error
      // @ts-expect-error: https://github.com/microsoft/TypeScript/issues/1863
      app.provide(key, global.provide[key])
    }
  }

  // use and plugins from mounting options
  if (global.plugins) {
    for (const plugin of global.plugins) {
      if (Array.isArray(plugin)) {
        app.use(plugin[0], ...plugin.slice(1))
        continue
      }
      app.use(plugin)
    }
  }

  if (isVapor && !(app as any)._context.vapor) {
    // Look up the optional export without requiring it from Vue 3.5/CJS builds.
    // A caller plugin may already have enabled interop on this app.
    const interop = Reflect.get(Vue, 'vaporInteropPlugin') as Plugin | undefined
    if (!interop) {
      throw new Error(
        'experimentalVapor requires Vue 3.6 ESM builds exporting vaporInteropPlugin (Vue and Test Utils Node builds have no Vapor support)'
      )
    }
    app.use(interop)
  }

  // use any mixins from mounting options
  if (global.mixins) {
    for (const mixin of global.mixins) app.mixin(mixin)
  }

  if (global.components) {
    const stubs = getComponentsFromStubs(global.stubs)
    for (const [key, component] of Object.entries(global.components)) {
      // avoid registering components that are stubbed twice
      if (!stubs[key]) {
        app.component(key, component)
      }
    }
  }

  if (global.directives) {
    for (const [key, directive] of Object.entries(global.directives))
      app.directive(key, directive)
  }

  // Vapor blocks bypass VNode stubbing; leave other apps' transformers intact.
  if (isVapor) return { app, props, componentRef }

  // stubs
  // even if we are using `mount`, we will still
  // stub out Transition and Transition Group by default.
  installVNodeTransformer(
    app,
    createVNodeTransformer({
      rootComponents,
      transformers: [
        createStubComponentsTransformer({
          rootComponents,
          stubs: getComponentsFromStubs(global.stubs),
          shallow: options?.shallow,
          renderStubDefaultSlot: global.renderStubDefaultSlot
        }),
        createStubDirectivesTransformer({
          directives: getDirectivesFromStubs(global.stubs)
        })
      ]
    })
  )

  // users expect stubs to work with globally registered
  // components so we register stubs as global components to avoid
  // warning about not being able to resolve component
  //
  // component implementation provided here will never be called
  // but we need name to make sure that stubComponents will
  // properly stub this later by matching stub name
  //
  // ref: https://github.com/vuejs/test-utils/issues/249
  // ref: https://github.com/vuejs/test-utils/issues/425
  if (global?.stubs) {
    for (const name of Object.keys(getComponentsFromStubs(global.stubs))) {
      if (!app.component(name)) {
        app.component(name, { name })
      }
    }
  }

  return {
    app,
    props,
    componentRef
  }
}

// Same normalization Vue applies to raw slot functions (normalizeSlot in
// runtime-core/componentSlots.ts), minus the dev-only "invoked outside of the
// render function" warning. Mounting-option slots act like compiled template
// slots, which Vue never warns about (#2135).
function normalizeSlotChild(child: unknown): VNode {
  if (child == null || typeof child === 'boolean') return createVNode(Comment)
  if (Array.isArray(child)) return createVNode(Fragment, null, child.slice())
  if (isVNode(child)) {
    return (child.el === null && child.patchFlag !== -1) ||
      (child as { memo?: unknown }).memo
      ? child
      : cloneVNode(child)
  }
  return createVNode(Text, null, String(child))
}

function toCompiledSlots(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  slots: Record<string, Function>
) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return Object.entries(slots).reduce<Record<string, Function>>(
    (acc, [name, fn]) => {
      const normalized = withCtx((...args: unknown[]) => {
        const value = fn(...args)
        return Array.isArray(value)
          ? value.map(normalizeSlotChild)
          : [normalizeSlotChild(value)]
      })
      ;(normalized as { _c?: boolean })._c = false
      acc[name] = normalized
      return acc
    },
    {}
  )
}
