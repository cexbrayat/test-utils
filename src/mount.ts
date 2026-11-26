import type {
  ComponentPublicInstance,
  DefineComponent,
  DirectiveModifiers,
  VNode
} from 'vue'
import type {
  ComponentExposed,
  ComponentProps,
  ComponentSlots
} from 'vue-component-type-helpers'
import { createInstance } from './createInstance'
import type { GlobalMountOptions, MountingOptions } from './types'
import { trackInstance } from './utils/autoUnmount'
import type { VueWrapper } from './vueWrapper'
import { createVueWrapper } from './wrapperFactory'
import { VaporWrapper } from './vaporWrapper'
import type { VaporInstance } from './utils/getRootNodes'
import { removeEventHistory } from './emit'

type ShimSlotReturnType<T> = T extends (...args: infer P) => any
  ? (...args: P) => any
  : never

type WithArray<T> = T | T[]

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ComponentData<T> = T extends { data?(...args: any): infer D } ? D : {}

// Keep the Vapor directive signature structural for Vue 3.5 consumers.
type VaporDirective = (
  el: any,
  getter?: () => any,
  arg?: () => any,
  modifiers?: DirectiveModifiers
) => (() => void) | void

export type ComponentMountingOptions<
  T,
  P extends ComponentProps<T> = ComponentProps<T>,
  Vapor extends boolean = false
> = Omit<MountingOptions<P, ComponentData<T>>, 'slots' | 'global'> & {
  global?: Vapor extends true
    ? Omit<GlobalMountOptions, 'directives'> & {
        directives?: Record<string, VaporDirective>
      }
    : GlobalMountOptions
  slots?: {
    [K in keyof ComponentSlots<T>]?: WithArray<
      | ShimSlotReturnType<ComponentSlots<T>[K]>
      | string
      | VNode
      | (new () => any)
      | { template: string }
    >
  }
} & Record<string, unknown>

// A Vapor wrapper's vm only holds defineExpose() bindings. DefineComponent and
// defineVaporComponent types resolve to instance types instead, so fall back to
// an untyped record for them (checked structurally to support Vue 3.5 types).
type VaporExposed<C> =
  ComponentExposed<C> extends { $props: any } | { vapor: true }
    ? Record<string, unknown>
    : ComponentExposed<C>

export function mount<
  T,
  C = T extends ((...args: any) => any) | (new (...args: any) => any)
    ? T
    : T extends { props?: infer Props }
      ? DefineComponent<
          Props extends Readonly<(infer PropNames)[]> | (infer PropNames)[]
            ? { [key in PropNames extends string ? PropNames : string]?: any }
            : Props
        >
      : DefineComponent,
  P extends ComponentProps<C> = ComponentProps<C>,
  Vapor extends boolean = false
>(
  originalComponent: T,
  // the bare `P` lets TypeScript infer a union of props objects as a whole
  options?: ComponentMountingOptions<C, P, Vapor> & {
    props?: P | null
    experimentalVapor?: Vapor
  }
): Vapor extends true
  ? VaporWrapper<VaporExposed<C>, ComponentProps<C>>
  : VueWrapper<
      ComponentProps<C> & ComponentData<C> & ComponentExposed<C>,
      ComponentPublicInstance<
        ComponentProps<C>,
        ComponentData<C> &
          ComponentExposed<C> &
          Omit<P, keyof ComponentProps<C>>
      >
    >

// implementation
export function mount(
  inputComponent: any,
  options?: ComponentMountingOptions<any, any, boolean>
): VueWrapper<any> | VaporWrapper {
  // Registration treats directives opaquely; Vue invokes their renderer-specific signature.
  const { app, props, componentRef } = createInstance(
    inputComponent,
    options as MountingOptions<any> | undefined
  )

  const setProps = (newProps: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(newProps)) {
      props[k] = v
    }

    return vm.$nextTick()
  }

  // Workaround for https://github.com/vuejs/core/issues/7020
  const originalErrorHandler = app.config.errorHandler

  const errorsOnMount: unknown[] = []
  app.config.errorHandler = (err, instance, info) => {
    errorsOnMount.push(err)

    return originalErrorHandler?.(err, instance, info)
  }

  // mount the app!
  const el = document.createElement('div')

  if (options?.attachTo) {
    let to: Element | null
    if (typeof options.attachTo === 'string') {
      to = document.querySelector(options.attachTo)
      if (!to) {
        throw new Error(
          `Unable to find the element matching the selector ${options.attachTo} given as the \`attachTo\` option`
        )
      }
    } else {
      to = options.attachTo
    }

    to.appendChild(el)
    const removeContainer = () => {
      // The wrapper may already have been manually unmounted before auto-unmount
      // runs, so the container can already be removed from its parent.
      if (el.parentNode === to) {
        to.removeChild(el)
      }
    }
    if (app.onUnmount) {
      app.onUnmount(removeContainer)
    } else {
      // app.onUnmount is only available since Vue 3.5
      const unmount = app.unmount
      app.unmount = () => {
        try {
          unmount()
        } finally {
          removeContainer()
        }
      }
    }
  }
  const vm = app.mount(el)
  if (errorsOnMount.length) {
    // If several errors are thrown during mount, then throw the first one
    if (options?.experimentalVapor) {
      try {
        app.unmount()
      } finally {
        removeEventHistory(vm)
      }
    }
    throw errorsOnMount[0]
  }
  app.config.errorHandler = originalErrorHandler

  if (options?.experimentalVapor) {
    // Vapor template refs expose bindings, not a ComponentPublicInstance.
    const instance = vm.$.subTree.component as unknown as VaporInstance
    const wrapper = new VaporWrapper(app, vm, instance, el, setProps)
    trackInstance(wrapper)
    return wrapper
  }

  const appRef = componentRef.value! as ComponentPublicInstance
  // we add `hasOwnProperty` so Jest can spy on the proxied vm without throwing
  // note that this is not necessary with Jest v27+ or Vitest, but is kept for compatibility with older Jest versions
  if (!app.hasOwnProperty) {
    appRef.hasOwnProperty = property => {
      return Reflect.has(appRef, property)
    }
  }
  const wrapper = createVueWrapper(app, appRef, setProps)
  trackInstance(wrapper)
  return wrapper
}

export const shallowMount: typeof mount = (component: any, options?: any) => {
  return mount(component, { ...options, shallow: true })
}
