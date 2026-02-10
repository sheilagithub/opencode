import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Vcs } from "../../src/project/vcs"
import { tmpdir } from "../fixture/fixture"

describe("Vcs.branches", () => {
  test("returns current, default, and local branches", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(tmp.path).quiet()
    await $`git checkout -b feature/checkouts`.cwd(tmp.path).quiet()

    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const output = await Vcs.branches()
        await Instance.dispose()
        return output
      },
    })

    expect(result.current).toBe("feature/checkouts")
    expect(result.default).toBe("main")
    expect(result.locals).toContain("main")
    expect(result.locals).toContain("feature/checkouts")
    expect(result.remotes).toEqual([])
  })
})
