import type { Core, ElementDefinition, EventObjectNode, StylesheetStyle } from 'cytoscape'
import type { GraphAdapter, GraphDensity, GraphRuntime } from '../components/FamilyGraph.vue'
import type { VisibleGraph } from '../model/buildVisibleGraph'
import personPlaceholder from '../../../assets/person-placeholder-round.png'
import { isPrimaryName, personNameTypeLabels } from '../../../shared/domain/personNames'

export interface GraphCreateOptions {
  container: HTMLElement
  graph: VisibleGraph
  density: GraphDensity
  selectedPersonId?: string
  onNodeClick(personId: string): void
  onNodeDoubleClick(personId: string): void
  onZoomChange(zoomLevel: number): void
}

function compactDate(label: string | undefined): string {
  if (!label) return ''
  const year = label.match(/\d{4}/)?.[0]
  if (!year) return label
  if (label.includes('以前')) return `<${year}`
  if (label.includes('以后')) return `${year}+`
  return `${label.includes('约') ? '约' : ''}${year}`
}

function nodeLabel(node: VisibleGraph['nodes'][number], density: GraphDensity): string {
  const lines = [node.primaryName]
  if (density.names) {
    const priorities = ['courtesy', 'art', 'genealogy', 'former'] as const
    const secondaryNames = priorities.flatMap((type) => node.person.names
      .filter((name) => name.type === type && !isPrimaryName(node.person, name))
      .map((name) => `${personNameTypeLabels[name.type]} ${name.value}`))
      .slice(0, 2)
    if (secondaryNames.length) lines.push(secondaryNames.join(' · '))
  }
  if (density.dates) {
    const lifespan = [compactDate(node.birthLabel), compactDate(node.deathLabel)].filter(Boolean).join(' — ')
    if (lifespan) lines.push(lifespan)
  }
  if (density.places && node.birthPlaceLabel) lines.push(node.birthPlaceLabel)
  if (node.collapsed) lines.push('＋ 分支已收起')
  return lines.join('\n')
}

interface BiologicalFamily {
  id: string
  parentIds: [string, string]
  childIds: string[]
  relationshipIds: string[]
}

function biologicalFamilies(graph: Pick<VisibleGraph, 'nodes' | 'edges'>): BiologicalFamily[] {
  const visibleIds = new Set(graph.nodes.map(({ id }) => id))
  const parentsByChild = new Map<string, VisibleGraph['edges']>()
  for (const edge of graph.edges) {
    if (edge.category !== 'parent' || edge.type !== 'biological'
      || !visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue
    const entries = parentsByChild.get(edge.target)
    if (entries) entries.push(edge)
    else parentsByChild.set(edge.target, [edge])
  }

  const families = new Map<string, BiologicalFamily>()
  for (const [childId, edges] of parentsByChild) {
    const edgeByParent = new Map(edges.map((edge) => [edge.source, edge]))
    const parentIds = [...edgeByParent.keys()].sort()
    if (parentIds.length !== 2) continue
    const pair = parentIds as [string, string]
    const key = pair.join('|')
    const family = families.get(key) ?? {
      id: `family:${key}`,
      parentIds: pair,
      childIds: [],
      relationshipIds: [],
    }
    family.childIds.push(childId)
    family.relationshipIds.push(...pair.map((parentId) => edgeByParent.get(parentId)!.id))
    families.set(key, family)
  }
  return [...families.values()].map((family) => ({
    ...family,
    childIds: [...family.childIds].sort(),
    relationshipIds: [...new Set(family.relationshipIds)].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function elements(graph: VisibleGraph, density: GraphDensity): ElementDefinition[] {
  const families = biologicalFamilies(graph)
  const joinedRelationshipIds = new Set(families.flatMap(({ relationshipIds }) => relationshipIds))
  return [
    ...graph.nodes.map((node): ElementDefinition => ({
      group: 'nodes',
      data: {
        id: node.id,
        label: nodeLabel(node, density),
        generation: node.generation,
        status: node.person.status,
        sex: node.person.sex,
        avatar: density.avatars ? node.person.avatarUrl || personPlaceholder : '',
        isPerson: 'yes',
      },
    })),
    ...families.map((family): ElementDefinition => ({
      group: 'nodes',
      data: {
        id: family.id,
        label: '',
        avatar: '',
        junction: 'yes',
        isPerson: 'no',
        parentIds: family.parentIds,
        childIds: family.childIds,
      },
    })),
    ...graph.edges.filter(({ id }) => !joinedRelationshipIds.has(id)).map((edge): ElementDefinition => ({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: density.relationships ? edge.label : '',
        category: edge.category,
        type: edge.type,
        lineStyle: edge.lineStyle,
      },
    })),
    ...families.flatMap((family): ElementDefinition[] => [
      ...family.parentIds.map((parentId): ElementDefinition => ({
        group: 'edges',
        data: {
          id: `${family.id}:parent:${parentId}`,
          source: parentId,
          target: family.id,
          label: '',
          category: 'parent',
          type: 'biological',
          lineStyle: 'solid',
          familyId: family.id,
          familyRole: 'parent',
          relationshipIds: family.relationshipIds,
        },
      })),
      ...family.childIds.map((childId): ElementDefinition => ({
        group: 'edges',
        data: {
          id: `${family.id}:child:${childId}`,
          source: family.id,
          target: childId,
          label: density.relationships ? '亲生' : '',
          category: 'parent',
          type: 'biological',
          lineStyle: 'solid',
          familyId: family.id,
          familyRole: 'child',
          relationshipIds: family.relationshipIds,
        },
      })),
    ]),
  ]
}

export const buildCytoscapeElements = elements

export interface FamilyGraphPosition {
  x: number
  y: number
}

const PARTNER_GAP = 148
const FAMILY_GAP = 210
const GENERATION_GAP = 190

/**
 * Keeps partners together before positioning each generation. The previous
 * ID-only ordering allowed a long marriage edge to pass through unrelated
 * siblings and made it look like those people were directly connected.
 */
export function buildFamilyAwarePositions(
  graph: Pick<VisibleGraph, 'nodes' | 'edges'>,
): Map<string, FamilyGraphPosition> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const parentById = new Map(graph.nodes.map((node) => [node.id, node.id]))
  const find = (id: string): string => {
    const parent = parentById.get(id) ?? id
    if (parent === id) return id
    const root = find(parent)
    parentById.set(id, root)
    return root
  }
  const union = (leftId: string, rightId: string) => {
    const left = find(leftId)
    const right = find(rightId)
    if (left === right) return
    if (left.localeCompare(right) <= 0) parentById.set(right, left)
    else parentById.set(left, right)
  }

  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (edge.category === 'partner' && source && target && source.generation === target.generation) {
      union(source.id, target.id)
    }
  }
  for (const family of biologicalFamilies(graph)) union(family.parentIds[0], family.parentIds[1])

  const lineagePersonIds = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.category !== 'parent') continue
    lineagePersonIds.add(edge.source)
    lineagePersonIds.add(edge.target)
  }

  const positions = new Map<string, FamilyGraphPosition>()
  const generations = [...new Set(graph.nodes.map(({ generation }) => generation))].sort((left, right) => left - right)
  generations.forEach((generation, rowIndex) => {
    const components = new Map<string, typeof graph.nodes>()
    for (const node of graph.nodes.filter((item) => item.generation === generation)) {
      const root = find(node.id)
      const members = components.get(root)
      if (members) members.push(node)
      else components.set(root, [node])
    }

    const groups = [...components.values()].map((members) => {
      members.sort((left, right) => Number(!lineagePersonIds.has(left.id)) - Number(!lineagePersonIds.has(right.id))
        || left.id.localeCompare(right.id))
      const memberIds = new Set(members.map(({ id }) => id))
      const parentXs = graph.edges
        .filter((edge) => edge.category === 'parent' && memberIds.has(edge.target))
        .map((edge) => positions.get(edge.source)?.x)
        .filter((value): value is number => value !== undefined)
      return {
        members,
        anchor: parentXs.length
          ? parentXs.reduce((total, value) => total + value, 0) / parentXs.length
          : undefined,
        key: members.map(({ id }) => id).sort().join('\0'),
      }
    }).sort((left, right) => {
      if (left.anchor !== undefined && right.anchor !== undefined) return left.anchor - right.anchor || left.key.localeCompare(right.key)
      if (left.anchor !== undefined) return -1
      if (right.anchor !== undefined) return 1
      return left.key.localeCompare(right.key)
    })

    let cursor = 0
    const rowPositions: Array<[string, number]> = []
    for (const group of groups) {
      group.members.forEach((node, index) => rowPositions.push([node.id, cursor + index * PARTNER_GAP]))
      cursor += Math.max(0, group.members.length - 1) * PARTNER_GAP + FAMILY_GAP
    }
    if (!rowPositions.length) return
    const xs = rowPositions.map(([, x]) => x)
    const offset = (Math.min(...xs) + Math.max(...xs)) / 2
    rowPositions.forEach(([id, x]) => positions.set(id, { x: x - offset, y: rowIndex * GENERATION_GAP }))
  })
  return positions
}

const stylesheet: StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      width: 104,
      height: 142,
      shape: 'round-rectangle',
      'background-color': '#fffdfa',
      'border-width': 1.5,
      'border-color': '#d8d0c2',
      color: '#292d29',
      label: 'data(label)',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'font-size': 10,
      'font-weight': 600,
      'line-height': 1.45,
      'text-wrap': 'wrap',
      'text-max-width': '88px',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-y': 36,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'node[isPerson = "yes"]',
    style: {
      'background-image': 'data(avatar)',
      'background-fit': 'none',
      'background-width': '52px',
      'background-height': '52px',
      'background-position-x': '50%',
      'background-position-y': '18%',
      'background-repeat': 'no-repeat',
    },
  },
  {
    selector: 'node:selected',
    style: { 'border-color': '#315d45', 'border-width': 3, 'background-color': '#fffdf9' },
  },
  {
    selector: 'edge',
    style: {
      width: 2,
      'line-color': '#87968a',
      'target-arrow-color': '#87968a',
      'target-arrow-shape': 'none',
      'curve-style': 'taxi',
      'taxi-direction': 'downward',
      'line-style': 'solid',
      label: 'data(label)',
      color: '#5f675f',
      'font-size': 9,
      'text-background-color': '#f5f0e7',
      'text-background-opacity': 1,
      'text-background-padding': '3px',
      'text-rotation': 'autorotate',
    },
  },
  {
    selector: 'edge[category = "partner"]',
    style: {
      'line-color': '#a76548',
      'target-arrow-color': '#a76548',
      'curve-style': 'bezier',
    },
  },
  { selector: 'edge[type = "biological"]', style: { 'line-color': '#506b57', 'line-style': 'solid', width: 2 } },
  { selector: 'edge[type = "adoptive"]', style: { 'line-color': '#9b783d', 'line-style': 'dashed', width: 2 } },
  { selector: 'edge[type = "step"]', style: { 'line-color': '#707870', 'line-style': 'dotted', width: 2 } },
  { selector: 'edge[type = "guardian"]', style: { 'line-color': '#526f86', 'line-style': 'dashed', width: 3 } },
  { selector: 'edge[type = "engaged"]', style: { 'line-color': '#b47a50', 'line-style': 'dotted', width: 2 } },
  { selector: 'edge[type = "married"]', style: { 'line-color': '#a76548', 'line-style': 'solid', width: 3 } },
  { selector: 'edge[type = "partner"]', style: { 'line-color': '#a76548', 'line-style': 'dashed', width: 2 } },
  { selector: 'edge[type = "separated"]', style: { 'line-color': '#9c625a', 'line-style': 'dashed', width: 3 } },
  { selector: 'edge[type = "divorced"]', style: { 'line-color': '#a04742', 'line-style': 'dotted', width: 3 } },
  { selector: 'edge.is-muted', style: { opacity: 0.12 } },
  { selector: 'edge.is-focused', style: { opacity: 1, width: 4, 'z-index': 10 } },
  { selector: 'node.is-muted', style: { opacity: 0.42 } },
  { selector: 'node.is-related', style: { 'border-color': '#9a674e', 'border-width': 2.5 } },
  { selector: 'node.is-focused', style: { 'border-color': '#315d45', 'border-width': 4, opacity: 1, 'z-index': 12 } },
  {
    selector: 'node[junction = "yes"]',
    style: {
      width: 10,
      height: 10,
      shape: 'ellipse',
      'background-color': '#506b57',
      'background-image': 'none',
      'border-width': 0,
      label: '',
      'z-index': 8,
    },
  },
]

export const familyGraphStylesheet = stylesheet

export function createNodeTapController(callbacks: {
  onClick(personId: string): void
  onDoubleClick(personId: string): void
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let destroyed = false
  return {
    tap(personId: string) {
      if (destroyed) return
      const pending = timers.get(personId)
      if (pending) {
        clearTimeout(pending)
        timers.delete(personId)
        callbacks.onDoubleClick(personId)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(personId)
        if (!destroyed) callbacks.onClick(personId)
      }, 220)
      timers.set(personId, timer)
    },
    destroy() {
      destroyed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

function runLayout(cy: Core, graph: VisibleGraph) {
  const positions = buildFamilyAwarePositions(graph)
  cy.nodes().forEach((node) => {
    if (node.data('junction') !== 'yes') node.position(positions.get(node.id()) ?? { x: 0, y: 0 })
  })
  cy.nodes('[junction = "yes"]').forEach((junction) => {
    const parentIds = junction.data('parentIds') as string[]
    const childIds = junction.data('childIds') as string[]
    const parentPositions = parentIds.map((id) => cy.getElementById(id).position())
    const childPositions = childIds.map((id) => cy.getElementById(id).position())
    const average = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
    junction.position({
      x: average(parentPositions.map(({ x }) => x)),
      y: (average(parentPositions.map(({ y }) => y)) + Math.min(...childPositions.map(({ y }) => y))) / 2,
    })
  })
  cy.layout({
    name: 'preset',
    fit: true,
    padding: 58,
    animate: false,
  } as never).run()
}

function applyRelationshipFocus(cy: Core, personId: string) {
  cy.elements().removeClass('is-focused is-related is-muted')
  const selected = cy.getElementById(personId)
  if (!personId || selected.empty()) return
  const focusedEdgeIds = new Set<string>()
  const relatedIds = new Set<string>()
  const includeEdge = (edge: ReturnType<Core['edges']>[number]) => {
    focusedEdgeIds.add(edge.id())
    for (const node of [edge.source(), edge.target()]) {
      if (node.data('isPerson') === 'yes') relatedIds.add(node.id())
    }
  }
  selected.connectedEdges().forEach((edge) => {
    includeEdge(edge)
    const junction = edge.source().data('junction') === 'yes'
      ? edge.source()
      : edge.target().data('junction') === 'yes'
        ? edge.target()
        : undefined
    if (!junction) return
    const selectedRole = edge.data('familyRole') as 'parent' | 'child'
    junction.connectedEdges().forEach((familyEdge) => {
      if (selectedRole === 'child' && familyEdge.data('familyRole') === 'child') return
      includeEdge(familyEdge)
    })
  })
  relatedIds.delete(personId)
  cy.edges().forEach((edge) => {
    edge.addClass(focusedEdgeIds.has(edge.id()) ? 'is-focused' : 'is-muted')
  })
  cy.nodes().forEach((node) => {
    if (node.id() === personId) node.addClass('is-focused')
    else if (relatedIds.has(node.id())) node.addClass('is-related')
    else node.addClass('is-muted')
  })
}

async function createRuntime(options: GraphCreateOptions): Promise<GraphRuntime> {
  const [{ default: cytoscape }, { default: registerElk }] = await Promise.all([
    import('cytoscape'),
    // The adapter lazily imports its pinned elkjs/lib/elk.bundled.js peer.
    import('cytoscape-elk'),
  ])
  cytoscape.use(registerElk)
  const cy = cytoscape({
    container: options.container,
    elements: elements(options.graph, options.density),
    style: stylesheet,
    minZoom: 0.2,
    maxZoom: 2.5,
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  })
  const taps = createNodeTapController({
    onClick: options.onNodeClick,
    onDoubleClick: options.onNodeDoubleClick,
  })
  const onTap = (event: EventObjectNode) => {
    taps.tap(event.target.id())
  }
  const onZoom = () => {
    options.onZoomChange(cy.zoom())
  }
  cy.on('tap', 'node[isPerson = "yes"]', onTap)
  cy.on('zoom', onZoom)
  let currentGraph = options.graph
  let selectedPersonId = options.selectedPersonId ?? ''
  runLayout(cy, currentGraph)
  applyRelationshipFocus(cy, selectedPersonId)
  onZoom()

  return {
    update(graph, density) {
      currentGraph = graph
      cy.elements().remove()
      cy.add(elements(graph, density))
      runLayout(cy, graph)
      applyRelationshipFocus(cy, selectedPersonId)
    },
    focus(personId) {
      selectedPersonId = personId
      applyRelationshipFocus(cy, selectedPersonId)
    },
    fit() { cy.fit(undefined, 42) },
    relayout() { runLayout(cy, currentGraph) },
    zoomIn() {
      cy.zoom({ level: Math.min(cy.maxZoom(), cy.zoom() * 1.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
    },
    zoomOut() {
      cy.zoom({ level: Math.max(cy.minZoom(), cy.zoom() / 1.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
    },
    zoomTo(zoomLevel) {
      cy.zoom({
        level: Math.min(cy.maxZoom(), Math.max(cy.minZoom(), zoomLevel)),
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      })
    },
    destroy() {
      taps.destroy()
      cy.off('tap', 'node[isPerson = "yes"]', onTap)
      cy.off('zoom', onZoom)
      cy.destroy()
    },
  }
}

export const cytoscapeGraphAdapter: GraphAdapter = { create: createRuntime }
