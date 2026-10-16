import { Plugin } from "@opencode/plugin"
import { readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"

// Restore the original EOL style after apply_patch. If the original file had no
// final newline, remove at most one final newline from the tool's result.
// New, mixed-EOL and non-UTF-8 files are left untouched.
// Only files inside the worktree are handled: the before hook runs before
// permission checks, so it must not read files outside that boundary.

const MAX_FILE_BYTES = 8 * 1024 * 1024
// Despite its name, ignoreBOM keeps the BOM in the decoded text. Preserve the
// tool's resulting BOM as-is; do not restore a BOM that the tool removed.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

type TextFile = { actual: string; content: string }
type LineLayout = { eol: "\r\n" | "\n"; hasFinalNewline: boolean }
type PatchTarget = { source: string; target: string }
type Snapshot = LineLayout & { target: string }

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function readText(file: string, root: string): Promise<TextFile | undefined> {
  const actual = await realpath(file)
  if (!inside(root, actual)) return // Includes symlinks through parent directories.
  const info = await stat(actual)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return
  const raw = await readFile(actual)
  if (raw.length > MAX_FILE_BYTES || raw.includes(0)) return
  try {
    return { actual, content: decoder.decode(raw) }
  } catch {
    // Invalid UTF-8 must not be re-encoded with replacement characters.
  }
}

function layout(text: string): LineLayout | undefined {
  const crlf = text.includes("\r\n")
  const lf = /(?<!\r)\n/.test(text)
  const normalized = text.replace(/\r\n/g, "\n")
  // Neither mixed endings nor standalone CR characters have a safe conversion.
  if ((crlf && lf) || normalized.includes("\r")) return
  return {
    eol: crlf ? "\r\n" : "\n", // With no existing line break, default to LF.
    hasFinalNewline: normalized.endsWith("\n"),
  }
}

function targets(patchText: string, directory: string): PatchTarget[] {
  // for an presentation of the opencode patch format, see:
  // https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.txt
  const lines = patchText.trim().split("\n")
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin < 0 || end <= begin) return []
  const result = new Map<string, PatchTarget>()
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i]
    if (line.startsWith("*** Update File:")) {
      const source = line.slice("*** Update File:".length).trim()
      if (!source) continue
      const sourcePath = path.resolve(directory, source)
      // Like the native parser, accept Move to only directly after Update File.
      const move = lines[i + 1]?.startsWith("*** Move to:")
        ? lines[i + 1].slice("*** Move to:".length).trim()
        : ""
      const target = move ? path.resolve(directory, move) : sourcePath
      result.delete(sourcePath)
      result.set(target, { source: sourcePath, target })
    } else if (line.startsWith("*** Add File:") || line.startsWith("*** Delete File:")) {
      // A later add/delete supersedes an earlier update of the same destination.
      const file = line.slice(line.indexOf(":") + 1).trim()
      if (file) result.delete(path.resolve(directory, file))
    }
  }
  return [...result.values()]
}

export default Plugin.define({
  id: "preserve-line-endings",
  async setup(ctx) {
    const directory = ctx.location.directory
    const worktree = ctx.location.project.directory
    const root = await realpath(worktree)
    const lexicalRoot = path.resolve(worktree)
    const base = path.resolve(directory)
    // Windows may supply an 8.3 worktree path. Accept both spellings, then check
    // the actual file against the canonical root in readText.
    const inWorktree = (file: string) => inside(root, file) || inside(lexicalRoot, file)
    const relativePath = (file: string) => path.relative(inside(root, file) ? root : lexicalRoot, file)
    const pending = new Map<string, Snapshot[]>()
    const log = async (message: string) => {
      try {
        console.error(`[preserve-line-endings] ${message}`)
      } catch {
        // Logging must never change the outcome of a patch.
      }
    }

    await ctx.tool.hook("execute.before", async (event) => {
      const input = event.input as { patchText?: unknown } | undefined
      if ((event.tool !== "patch" && event.tool !== "apply_patch") || typeof input?.patchText !== "string") return
      const entries: Snapshot[] = []
      for (const { source, target } of targets(input.patchText, base)) {
        // This hook precedes permission checks; limit reads to the worktree.
        if (!inWorktree(source) || !inWorktree(target)) continue
        try {
          const file = await readText(source, root)
          if (!file) continue
          const style = layout(file.content)
          if (style) entries.push({ target, ...style })
        } catch {
          // Missing/unreadable files will be handled by the native tool.
        }
      }
      pending.set(`${event.sessionID}:${event.id}`, entries)
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "patch" && event.tool !== "apply_patch") return
      const key = `${event.sessionID}:${event.id}`
      const entries = pending.get(key) ?? []
      pending.delete(key)
      if (event.status !== "completed") return
      const corrected: string[] = []
      const errors: string[] = []
      for (const entry of entries) {
        try {
          // Recheck the destination: a move may follow a symlink out of the worktree.
          const file = await readText(entry.target, root)
          if (!file) continue
          const normalized = file.content.replace(/\r\n/g, "\n")
          if (normalized.includes("\r")) continue
          // Removing every line must still produce an empty file (with or without BOM).
          if (normalized === "" || normalized === "\uFEFF") continue
          // Work on normalized LF so a CRLF is removed as one complete newline.
          const adjusted = !entry.hasFinalNewline && normalized.endsWith("\n")
            ? normalized.slice(0, -1)
            : normalized
          const text = adjusted.replace(/\n/g, entry.eol)
          if (text === file.content) continue
          await writeFile(file.actual, text, "utf8")
          corrected.push(relativePath(entry.target))
        } catch (error) {
          errors.push(`${relativePath(entry.target)}: ${String(error)}`)
        }
      }
      let notice = ""
      if (corrected.length) notice += `\n\nLine endings restored: ${corrected.join(", ")}`
      if (errors.length) {
        notice += `\n\nLine-ending restoration failed: ${errors.join("; ")}`
        await log(errors.join("; "))
      }
      if (notice) {
        const content = event.result.content
        event.result = {
          ...event.result,
          content: typeof content === "string"
            ? content + notice
            : [...(content ?? []), { type: "text", text: notice }],
        }
      }
    })

    // Discard snapshots on terminal transitions, including interrupted/rejected calls.
    const controller = new AbortController()
    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed"
            && event.type !== "session.execution.interrupted" && event.type !== "session.deleted") continue
          for (const key of pending.keys()) if (key.startsWith(`${event.data.sessionID}:`)) pending.delete(key)
        }
      } catch (error) {
        if (!controller.signal.aborted) await log(`Event subscription failed: ${String(error)}`)
      }
    })()
    return async () => {
      controller.abort()
      pending.clear()
      await subscription
    }
  },
})
