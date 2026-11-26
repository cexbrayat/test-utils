import { type App, type ComponentPublicInstance, proxyRefs } from 'vue'
import BaseWrapper from './baseWrapper'
import { createDOMWrapper } from './wrapperFactory'
import type { DOMWrapper } from './domWrapper'
import { removeEventHistory } from './emit'
import { type VaporInstance, getVaporRootNodes } from './utils/getRootNodes'

/** Experimental DOM mounting. `vm` contains only unwrapped expose() bindings. */
export class VaporWrapper<
  Exposed = Record<string, unknown>,
  Props = Record<string, unknown>
> extends BaseWrapper<Node> {
  readonly vm: Exposed

  constructor(
    private readonly app: App,
    private readonly rootVm: ComponentPublicInstance,
    private readonly instance: VaporInstance,
    private readonly container: Element,
    private readonly updateProps: (
      props: Record<string, unknown>
    ) => Promise<void>
  ) {
    super(container)
    this.vm = proxyRefs(instance.exposed ?? {}) as Exposed
  }

  protected getRootNodes(): Node[] {
    return getVaporRootNodes(this.instance)
  }

  protected getCurrentComponent(): never {
    throw new Error(
      'Ref selectors are not supported for Vapor; use CSS selectors'
    )
  }

  get element(): Node {
    const roots = this.getRootNodes()
    return roots.length === 1 ? roots[0]! : this.container
  }

  findAll<K extends keyof HTMLElementTagNameMap>(
    selector: K
  ): DOMWrapper<HTMLElementTagNameMap[K]>[]
  findAll<K extends keyof SVGElementTagNameMap>(
    selector: K
  ): DOMWrapper<SVGElementTagNameMap[K]>[]
  findAll<T extends Element>(selector: string): DOMWrapper<T>[]
  findAll(selector: string) {
    return this.findAllDOMElements(selector).map(node => createDOMWrapper(node))
  }

  findComponent: BaseWrapper<Node>['findComponent'] = () => {
    throw new Error('Component discovery is not supported for Vapor')
  }

  findAllComponents: BaseWrapper<Node>['findAllComponents'] = () => {
    throw new Error('Component discovery is not supported for Vapor')
  }

  setProps(props: Partial<Props>): Promise<void> {
    return this.updateProps(props as Record<string, unknown>)
  }

  emitted(_event?: string): never {
    throw new Error(
      'emitted is not supported for experimental Vapor mounting yet'
    )
  }

  setData(_data?: Record<string, unknown>): never {
    throw new Error('setData is not supported for Vapor')
  }

  setValue(_value?: unknown): never {
    throw new Error('Use a DOM wrapper to setValue on a Vapor component')
  }

  exists(): boolean {
    return !this.instance.isUnmounted
  }

  unmount(): void {
    if (this.instance.isUnmounted) return
    try {
      this.app.unmount()
    } finally {
      removeEventHistory(this.rootVm)
    }
  }
}
