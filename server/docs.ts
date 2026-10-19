import { readFileSync, realpathSync, statSync, unwatchFile, watchFile } from 'node:fs'
import type { Stats } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'

export function inWorkspace(p: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(p))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function resolveDoc(projectPath: string, docPath: string | null, root: string): string | null {
  if (!docPath) return null
  const project = resolve(projectPath)
  const abs = resolve(project, docPath)
  if (extname(abs) !== '.md' || !inWorkspace(project, root) || !inWorkspace(abs, project) || !inWorkspace(abs, root)) return null
  try {
    const realRoot = realpathSync(root)
    const realProject = realpathSync(project)
    const realDoc = realpathSync(abs)
    if (!inWorkspace(realProject, realRoot) || !inWorkspace(realDoc, realProject) || !inWorkspace(realDoc, realRoot)) return null
    return statSync(realDoc).isFile() && readDoc(abs) !== null ? abs : null
  } catch {
    return null
  }
}

export function readDoc(abs: string): string | null {
  try { return readFileSync(abs, 'utf8') } catch { return null }
}

export function docDiff(path: string, old: string, next: string): string {
  return createTwoFilesPatch(path, path, old, next)
}

export function watchDoc(abs: string, onChange: () => void): () => void {
  const listener = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs !== prev.mtimeMs) onChange()
  }
  watchFile(abs, { interval: 1000 }, listener)
  return () => unwatchFile(abs, listener)
}
