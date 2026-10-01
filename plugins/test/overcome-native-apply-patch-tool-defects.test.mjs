import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

// Run: node --test overcome-native-apply-patch-tool-defects.mjs

const test_target_filename = "overcome-native-apply-patch-tool-defects.js"
const __dirname = dirname(fileURLToPath(import.meta.url));
const { default: preserveLineEndings } = await import(`file://${__dirname}/../${test_target_filename}`)
const temporary = path.join(tmpdir(), "opencode")
const bom = Buffer.from([0xef, 0xbb, 0xbf])
// for an presentation of the opencode patch format, see:
// https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.txt
const update = (file = "file.txt") => `*** Update File: ${file}\n@@\n-old\n+new`
const patch = (...sections) => ["*** Begin Patch", ...sections, "*** End Patch"].join("\n")

async function fixture(run, log = async () => {}) {
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(path.join(temporary, "line-endings-"))
  try {
    const plugin = await preserveLineEndings({
      directory,
      worktree: directory,
      client: { app: { log } },
    })
    let call = 0
    // Simulate only the native tool's writes, not its parser or patch algorithm.
    // These are hook tests; native OpenCode integration needs a separate check.
    const apply = async (patchText, nativeWrite) => {
      const input = { tool: "apply_patch", sessionID: "test", callID: String(call++) }
      await plugin["tool.execute.before"](input, { args: { patchText } })
      await nativeWrite()
      const output = { title: "Success", output: "Success", metadata: {} }
      await plugin["tool.execute.after"]({ ...input, args: { patchText } }, output)
      return output
    }
    await run({ directory, apply, plugin })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

for (const [name, before, native, expected] of [
  ["CRLF sans saut final, sortie native mixte avec saut final LF : le saut final n'est pas conservé", "first\r\nold", "first\r\nnew\n", "first\r\nnew"],
  ["CRLF avec saut final, sortie native LF avec saut final : le saut final est conservé", "first\r\nold\r\n", "first\nnew\n", "first\r\nnew\r\n"],
  ["la réduction des sauts finaux CRLF de l'outil natif est conservée", "old\r\n\r\n", "new\n", "new\r\n"],
  ["LF sans saut final : pas de saut ajouté", "first\nold", "first\nnew\n", "first\nnew"],
  ["réduction des sauts finaux LF conservée", "first\nold\n\n", "first\nnew\n", "first\nnew\n"],
  ["une seule ligne sans saut final", "old", "new\n", "new"],
  ["fichier initialement vide", "", "new\n", "new"],
  ["fichier vidé par le patch", "old\n\n", "", ""],
  ["fichier vidé avec BOM", "\uFEFFold\r\n", "\uFEFF", "\uFEFF"],
  ["lignes vides internes conservées", "first\r\n\r\nold", "first\n\nnew\n", "first\r\n\r\nnew"],
]) {
  test(name, async () => {
    await fixture(async ({ directory, apply }) => {
      const file = path.join(directory, "file.txt")
      await writeFile(file, before)
      const result = await apply(patch(update()), () => writeFile(file, native))
      assert.equal(await readFile(file, "utf8"), expected)
      assert.equal(result.output.includes("restored"), native !== expected)
    })
  })
}

for (const eol of ["\n", "\r\n"]) {
  for (const [name, before, native, expected] of [
    ["sans saut final : aucun saut ajouté", "first\nold", "first\nnew", "first\nnew"],
    ["sans saut final : retirer un seul des deux sauts", "first\nold", "first\nnew\n\n", "first\nnew\n"],
    ["sans saut final : retirer un seul des trois sauts", "first\nold", "first\nnew\n\n\n", "first\nnew\n\n"],
    ["avec saut final : ajout de sauts conservé", "old\n", "new\n\n\n", "new\n\n\n"],
    ["avec sauts finaux : suppression de tous les sauts conservée", "old\n\n", "new", "new"],
    ["sans saut final : espaces et tabulation conservés", "first\nold", "first\nnew \t\n", "first\nnew \t"],
    ["sans saut final : espace après un saut laissé intact", "first\nold", "first\nnew\n ", "first\nnew\n "],
    ["sans saut final : résultat réduit à un saut", "first\nold", "\n", ""],
    ["sans saut final : résultat réduit à deux sauts", "first\nold", "\n\n", "\n"],
    ["source vide : retirer un seul saut", "", "\n\n", "\n"],
    ["source BOM seul : retirer un seul saut", "\uFEFF", "\uFEFF\n\n", "\uFEFF\n"],
  ]) {
    test(`${eol === "\n" ? "LF" : "CRLF"} — ${name}`, async () => {
      await fixture(async ({ directory, apply }) => {
        const file = path.join(directory, "file.txt")
        await writeFile(file, before.replace(/\n/g, eol))
        const nativeText = native.replace(/\n/g, eol)
        // Without an original line break, the plugin defaults to LF.
        const expectedEol = before.includes("\n") ? eol : "\n"
        const expectedText = expected.replace(/\n/g, expectedEol)
        const result = await apply(patch(update()), () => writeFile(file, nativeText))
        assert.equal(await readFile(file, "utf8"), expectedText)
        assert.equal(result.output.includes("restored"), nativeText !== expectedText)
      })
    })
  }
}

for (const keepBOM of [true, false]) {
  test(`le BOM ${keepBOM ? "conservé" : "supprimé"} par l'outil natif reste tel quel`, async () => {
    await fixture(async ({ directory, apply }) => {
      const file = path.join(directory, "file.txt")
      const prefix = keepBOM ? bom : Buffer.alloc(0)
      await writeFile(file, Buffer.concat([bom, Buffer.from("first\r\nold")]))
      await apply(patch(update()), () => writeFile(file, Buffer.concat([prefix, Buffer.from("first\nnew\n")])))
      assert.deepEqual(await readFile(file), Buffer.concat([prefix, Buffer.from("first\r\nnew")]))
    })
  })
}

test("déplacement : le format de la source suit la destination", async () => {
  await fixture(async ({ directory, apply }) => {
    const source = path.join(directory, "source.txt")
    const destination = path.join(directory, "destination.txt")
    await writeFile(source, "first\r\nold\r\n")
    await apply(
      patch("*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-old\n+new"),
      async () => {
        await writeFile(destination, "first\r\nnew\n")
        await rm(source)
      },
    )
    assert.equal(await readFile(destination, "utf8"), "first\r\nnew\r\n")
    await assert.rejects(readFile(source), { code: "ENOENT" })
  })
})

for (const [name, before, native] of [
  ["fins de ligne mixtes", "one\r\nold\n", "one\r\nnew\n"],
  ["CR isolé dans la source", "one\rold", "one\rnew\n"],
  ["CR isolé dans le résultat", "one\r\nold", "one\rnew\n"],
  ["UTF-8 invalide dans la source", Buffer.from([0xff, 0x0a]), "new\n"],
  ["UTF-8 invalide dans le résultat", "old", Buffer.from([0xff, 0x0a])],
  ["octet NUL dans la source", "old\0", "new\n"],
  ["octet NUL dans le résultat", "old", "new\0\n"],
  ["source trop volumineuse", "x".repeat(8 * 1024 * 1024 + 1), "new\n"],
  ["résultat trop volumineux", "old", "x".repeat(8 * 1024 * 1024) + "\n"],
]) {
  test(`${name} : résultat natif laissé intact`, async () => {
    await fixture(async ({ directory, apply }) => {
      const file = path.join(directory, "file.txt")
      await writeFile(file, before)
      const result = await apply(patch(update()), () => writeFile(file, native))
      assert.deepEqual(await readFile(file), Buffer.from(native))
      assert.equal(result.output, "Success")
    })
  })
}

test("un format déjà correct ne déclenche aucune correction", async () => {
  await fixture(async ({ directory, apply }) => {
    const file = path.join(directory, "file.txt")
    await writeFile(file, "old\r\n")
    const result = await apply(patch(update()), () => writeFile(file, "new\r\n"))
    assert.equal(await readFile(file, "utf8"), "new\r\n")
    assert.equal(result.output, "Success")
  })
})

test("ajouts, suppressions et mises à jour coexistent dans un patch", async () => {
  await fixture(async ({ directory, apply }) => {
    const edited = path.join(directory, "edited.txt")
    const added = path.join(directory, "added.txt")
    const deleted = path.join(directory, "deleted.txt")
    await writeFile(edited, "old")
    await writeFile(deleted, "old")
    const result = await apply(
      patch(update("edited.txt"), "*** Add File: added.txt\n+new", "*** Delete File: deleted.txt"),
      async () => {
        await writeFile(edited, "new\n")
        await writeFile(added, "new\n")
        await rm(deleted)
      },
    )
    assert.equal(await readFile(edited, "utf8"), "new")
    assert.equal(await readFile(added, "utf8"), "new\n")
    await assert.rejects(readFile(deleted), { code: "ENOENT" })
    assert.doesNotMatch(result.output, /failed/)
  })
})

for (const operation of ["add", "delete"]) {
  test(`une opération ${operation} ultérieure annule la restauration de la même cible`, async () => {
    await fixture(async ({ directory, apply }) => {
      const file = path.join(directory, "file.txt")
      await writeFile(file, "old")
      const section = operation === "add" ? "*** Add File: file.txt\n+replacement" : "*** Delete File: file.txt"
      const result = await apply(patch(update(), section), () =>
        operation === "add" ? writeFile(file, "replacement\n") : rm(file),
      )
      if (operation === "add") assert.equal(await readFile(file, "utf8"), "replacement\n")
      else await assert.rejects(readFile(file), { code: "ENOENT" })
      assert.equal(result.output, "Success")
    })
  })
}

for (const [name, patchText] of [
  ["déplacement non adjacent", patch(update(), "*** Move to: unrelated.txt")],
  ["directives avant l'enveloppe", `${update()}\n*** Move to: unrelated.txt\n${patch(update())}`],
  ["directives après l'enveloppe", `${patch(update())}\n${update()}\n*** Move to: unrelated.txt`],
]) {
  test(`${name} : aucun fichier étranger au patch n'est corrigé`, async () => {
    await fixture(async ({ directory, apply }) => {
      const source = path.join(directory, "file.txt")
      const unrelated = path.join(directory, "unrelated.txt")
      await writeFile(source, "first\r\nold")
      await writeFile(unrelated, "untouched\n")
      const result = await apply(patchText, () => writeFile(source, "first\nnew\n"))
      assert.equal(await readFile(source, "utf8"), "first\r\nnew")
      assert.equal(await readFile(unrelated, "utf8"), "untouched\n")
      assert.match(result.output, /restored: file\.txt$/)
    })
  })
}

test("les directives présentes dans du contenu ajouté ne sont pas des en-têtes", async () => {
  await fixture(async ({ directory, apply }) => {
    const file = path.join(directory, "file.txt")
    const unrelated = path.join(directory, "unrelated.txt")
    await writeFile(file, "old")
    await writeFile(unrelated, "untouched\n")
    await apply(patch(`${update()}\n+*** Move to: unrelated.txt`), () =>
      writeFile(file, "new\n*** Move to: unrelated.txt\n"),
    )
    assert.equal(await readFile(file, "utf8"), "new\n*** Move to: unrelated.txt")
    assert.equal(await readFile(unrelated, "utf8"), "untouched\n")
  })
})

test("un patch CRLF et des chemins absolus sont acceptés", async () => {
  await fixture(async ({ directory, apply }) => {
    const file = path.join(directory, "with spaces.txt")
    await writeFile(file, "old")
    await apply(patch(update(file)).replace(/\n/g, "\r\n"), () => writeFile(file, "new\n"))
    assert.equal(await readFile(file, "utf8"), "new")
  })
})

test("les erreurs de restauration sont signalées même si la journalisation échoue", async () => {
  const logs = []
  await fixture(async ({ directory, apply }) => {
    const file = path.join(directory, "file.txt")
    await writeFile(file, "old")
    const result = await apply(patch(update()), () => rm(file))
    assert.match(result.output, /restoration failed: file\.txt:/)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].body.level, "error")
  }, async (entry) => {
    logs.push(entry)
    throw new Error("Logger unavailable")
  })
})

for (const type of ["session.idle", "session.error"]) {
  test(`${type} nettoie uniquement les appels de la session concernée`, async () => {
    await fixture(async ({ directory, plugin }) => {
      const args = { patchText: patch(update()) }
      const first = { tool: "apply_patch", sessionID: "first", callID: "same", args }
      const second = { ...first, sessionID: "second" }
      const file = path.join(directory, "file.txt")
      await writeFile(file, "old")
      await plugin["tool.execute.before"](first, { args })
      await plugin["tool.execute.before"](second, { args })
      await plugin.event({ event: { type, properties: { sessionID: first.sessionID } } })
      await writeFile(file, "new\n")
      const output = { output: "Success" }
      await plugin["tool.execute.after"](first, output)
      assert.equal(await readFile(file, "utf8"), "new\n")
      assert.equal(output.output, "Success")
      await plugin["tool.execute.after"](second, output)
      assert.equal(await readFile(file, "utf8"), "new")
      // A consumed snapshot must not affect a later write or a duplicate after hook.
      await writeFile(file, "later\n")
      await plugin["tool.execute.after"](second, output)
      assert.equal(await readFile(file, "utf8"), "later\n")
    })
  })
}

test("deux appels entrelacés dans une session conservent leurs formats respectifs", async () => {
  await fixture(async ({ directory, plugin }) => {
    const file = path.join(directory, "file.txt")
    const args = { patchText: patch(update()) }
    const first = { tool: "apply_patch", sessionID: "test", callID: "first", args }
    const second = { ...first, callID: "second" }
    await writeFile(file, "old")
    await plugin["tool.execute.before"](first, { args })
    await writeFile(file, "old\r\n")
    await plugin["tool.execute.before"](second, { args })
    await writeFile(file, "new\n")
    await plugin["tool.execute.after"](second, { output: "Success" })
    assert.equal(await readFile(file, "utf8"), "new\r\n")
    await writeFile(file, "new\n")
    await plugin["tool.execute.after"](first, { output: "Success" })
    assert.equal(await readFile(file, "utf8"), "new")
  })
})

test("les chemins externes et les jonctions sortantes ne sont pas corrigés", async () => {
  await fixture(async ({ directory: outside }) => {
    await fixture(async ({ directory, apply }) => {
      const external = path.join(outside, "external.txt")
      const source = path.join(directory, "file.txt")
      const link = path.join(directory, "link")
      // Windows junctions do not require the privilege needed for file symlinks.
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
      for (const target of [external, path.join(link, "external.txt")]) {
        await writeFile(external, "old")
        const result = await apply(patch(update(target)), () => writeFile(external, "new\n"))
        assert.equal(await readFile(external, "utf8"), "new\n")
        assert.equal(result.output, "Success")
      }
      await writeFile(source, "old")
      const result = await apply(
        patch("*** Update File: file.txt\n*** Move to: link/external.txt\n@@\n-old\n+new"),
        async () => {
          await writeFile(external, "new\n")
          await rm(source)
        },
      )
      assert.equal(await readFile(external, "utf8"), "new\n")
      assert.equal(result.output, "Success")
    })
  })
})
