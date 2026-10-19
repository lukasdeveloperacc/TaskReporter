import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { docDiff, inWorkspace, readDoc, resolveDoc, watchDoc } from './docs.ts'

describe('docs', () => {
  let dir: string
  let root: string
  let project: string
  let doc: string
  const stops: (() => void)[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'office-docs-'))
    root = join(dir, 'workspace')
    project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    doc = join(project, 'plan.md')
    writeFileSync(doc, '# Plan\n')
  })
  afterEach(() => { stops.splice(0).forEach((stop) => stop()); rmSync(dir, { recursive: true, force: true }) })

  it('checks normalized workspace containment including trailing slash and sibling prefixes', () => {
    expect(inWorkspace('/a/orca', '/a/orca/')).toBe(true)
    expect(inWorkspace('/a/orca/project', '/a/orca/')).toBe(true)
    expect(inWorkspace('/a/orca/project/../notes', '/a/orca')).toBe(true)
    expect(inWorkspace('/a/orca2/project', '/a/orca')).toBe(false)
    expect(inWorkspace('/a/orca/../outside', '/a/orca')).toBe(false)
    expect(inWorkspace('/anywhere', '/')).toBe(true)
  })

  it('resolves readable md files but rejects traversal, wrong extension, directories and missing files', () => {
    expect(resolveDoc(project, 'plan.md', root)).toBe(doc)
    expect(resolveDoc(project, doc, root)).toBe(doc)
    expect(resolveDoc(project, null, root)).toBeNull()
    expect(resolveDoc(project, '', root)).toBeNull()
    writeFileSync(join(dir, 'outside.md'), 'outside')
    writeFileSync(join(project, 'notes.txt'), 'text')
    mkdirSync(join(project, 'directory.md'))
    expect(resolveDoc(project, '../../outside.md', root)).toBeNull()
    expect(resolveDoc(project, 'notes.txt', root)).toBeNull()
    expect(resolveDoc(project, 'directory.md', root)).toBeNull()
    expect(resolveDoc(project, 'missing.md', root)).toBeNull()
    expect(resolveDoc(dir, 'outside.md', root)).toBeNull()
  })

  it('rejects file and directory symlinks escaping the project or workspace, including a symlinked project', () => {
    const sibling = join(root, 'sibling')
    const outside = join(dir, 'outside')
    mkdirSync(sibling)
    mkdirSync(outside)
    for (const target of [sibling, outside]) writeFileSync(join(target, 'secret.md'), 'secret')
    symlinkSync(join(sibling, 'secret.md'), join(project, 'sibling.md'))
    symlinkSync(join(outside, 'secret.md'), join(project, 'outside.md'))
    symlinkSync(sibling, join(project, 'sibling-dir'))
    symlinkSync(outside, join(root, 'linked-project'))
    expect(resolveDoc(project, 'sibling.md', root)).toBeNull()
    expect(resolveDoc(project, 'outside.md', root)).toBeNull()
    expect(resolveDoc(project, 'sibling-dir/secret.md', root)).toBeNull()
    expect(resolveDoc(join(root, 'linked-project'), 'secret.md', root)).toBeNull()
    symlinkSync(doc, join(project, 'local.md'))
    expect(resolveDoc(project, 'local.md', root)).toBe(join(project, 'local.md'))
    rmSync(doc)
    symlinkSync(join(outside, 'secret.md'), doc)
    expect(resolveDoc(project, 'plan.md', root)).toBeNull()
  })

  it('reads without writing, returns null on read errors, and produces a unified diff', () => {
    expect(readDoc(doc)).toBe('# Plan\n')
    expect(readDoc(join(project, 'missing.md'))).toBeNull()
    const diff = docDiff('plan.md', 'old\n', 'new\n')
    expect(diff).toContain('--- plan.md')
    expect(diff).toContain('-old')
    expect(diff).toContain('+new')
    expect(readFileSync(doc, 'utf8')).toBe('# Plan\n')
  })

  it('polls changes within three seconds and stops only its own listener', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = watchDoc(doc, first)
    const stopSecond = watchDoc(doc, second)
    stops.push(stopFirst, stopSecond)
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(doc, 'changed\n')
    utimesSync(doc, new Date(), new Date(Date.now() + 1000))
    await vi.waitFor(() => { expect(first).toHaveBeenCalled(); expect(second).toHaveBeenCalled() }, { timeout: 3000, interval: 50 })
    stopFirst()
    const firstCount = first.mock.calls.length
    const secondCount = second.mock.calls.length
    writeFileSync(doc, 'again\n')
    utimesSync(doc, new Date(), new Date(Date.now() + 2000))
    await vi.waitFor(() => expect(second.mock.calls.length).toBeGreaterThan(secondCount), { timeout: 3000, interval: 50 })
    expect(first).toHaveBeenCalledTimes(firstCount)
    stopSecond()
    const stoppedCount = second.mock.calls.length
    writeFileSync(doc, 'after stop\n')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(second).toHaveBeenCalledTimes(stoppedCount)
  }, 8000)
})
