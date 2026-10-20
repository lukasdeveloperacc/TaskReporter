import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../../shared/contract.ts'
import { orderProjectFloors } from './floors.ts'

const project = (path: string, name: string): ProjectView => ({ path, name, in_workspace: true, runs: [] })

describe('orderProjectFloors', () => {
  it('keeps path/name order and floor numbers independent of report/input order', () => {
    const source = [project('/z', 'alpha'), project('/b', 'zeta'), project('/a', 'beta')]
    const labels = (items: ProjectView[]) => orderProjectFloors(items).map(({ project: item, floorNumber }) => [item.path, floorNumber])
    expect(labels(source)).toEqual([['/a', 3], ['/b', 2], ['/z', 1]])
    expect(labels([...source].reverse())).toEqual(labels(source))
  })
})
