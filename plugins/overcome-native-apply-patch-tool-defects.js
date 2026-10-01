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

function inside(root, file) {
  const relative = path.relative(root, file)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function readText(file, root) {
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

function layout(text) {
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

function targets(patchText, directory) {
  // for an presentation of the opencode patch format, see:
  // https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.txt
  const lines = patchText.trim().split("\n")
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin < 0 || end <= begin) return []
  const result = new Map()
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

export default async function preserveLineEndings({ directory, worktree, client }) {
  const root = await realpath(worktree)
  const lexicalRoot = path.resolve(worktree)
  const base = path.resolve(directory)
  // Windows may supply an 8.3 worktree path. Accept both spellings, then check
  // the actual file against the canonical root in readText.
  const inWorktree = (file) => inside(root, file) || inside(lexicalRoot, file)
  const relativePath = (file) => path.relative(inside(root, file) ? root : lexicalRoot, file)
  const pending = new Map()
  const log = async (message) => {
    try {
      await client.app.log({ body: { service: "preserve-line-endings", level: "error", message } })
    } catch {
      // Logging must never change the outcome of a patch.
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "apply_patch" || typeof output.args?.patchText !== "string") return
      const entries = []
      for (const { source, target } of targets(output.args.patchText, base)) {
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
      pending.set(`${input.sessionID}:${input.callID}`, entries)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "apply_patch") return
      const key = `${input.sessionID}:${input.callID}`
      const entries = pending.get(key) ?? []
      pending.delete(key)
      const corrected = []
      const errors = []
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
      if (corrected.length) {
        output.output += `\n\nLine endings restored: ${corrected.join(", ")}`
      }
      if (errors.length) {
        output.output += `\n\nLine-ending restoration failed: ${errors.join("; ")}`
        await log(errors.join("; "))
      }
    },

    // Failed/rejected apply_patch calls have no after hook; discard their snapshots
    // when the session stops. Concurrent calls remain separated by session and call ID.
    event: async ({ event }) => {
      if (event.type !== "session.idle" && event.type !== "session.error") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      for (const key of pending.keys()) if (key.startsWith(`${sessionID}:`)) pending.delete(key)
    },
  }
}
