import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

const components = import.meta.glob('../**/*.vue', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

type TemplateNode = {
  type: number
  tag?: string
  props: Array<{
    type: number
    name?: string
    value?: { content?: string }
  }>
  children?: TemplateNode[]
  loc: { start: { line: number } }
}

type ElementNode = TemplateNode & { type: 1; tag: string; children: TemplateNode[] }

function isElement(node: TemplateNode): node is ElementNode {
  return node.type === 1 && typeof node.tag === 'string' && Array.isArray(node.children)
}

function isVisuallyHidden(node: ElementNode): boolean {
  return node.props.some((prop) =>
    prop.type === 6
    && prop.name === 'class'
    && prop.value?.content?.split(/\s+/).includes('visually-hidden'))
}

function unwrappedSelects(source: string): number[] {
  const template = parse(source).descriptor.template?.ast as unknown as { children: TemplateNode[] } | undefined
  if (!template) return []
  const lines: number[] = []

  function visit(node: TemplateNode, ancestors: ElementNode[]) {
    if (!isElement(node)) return
    if (node.tag === 'select'
      && !isVisuallyHidden(node)
      && !ancestors.some(({ tag }) => tag === 'BaseSelectControl' || tag === 'FilterSelectControl')) {
      lines.push(node.loc.start.line)
    }
    for (const child of node.children) visit(child, [...ancestors, node])
  }

  for (const child of template.children) visit(child, [])
  return lines
}

describe('shared select control', () => {
  it('wraps every visible select so browser and desktop WebViews render the same UI', () => {
    const violations = Object.entries(components)
      .flatMap(([file, source]) => unwrappedSelects(source).map((line) => `${file}:${line}`))

    expect(violations, `Wrap visible selects with BaseSelectControl:\n${violations.join('\n')}`).toEqual([])
  })
})
