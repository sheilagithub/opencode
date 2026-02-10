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

// Note: parseGithubRepos is tested implicitly through Vcs.githubRepos
// The function correctly handles GitHub API responses where owner is an object with a login field
// and transforms it to a string before validation. This is tested through integration with the API.

// TODO: Add test for Worktree.create with ref parameter
// The Worktree module has complex dependencies (Instance, Global, Storage, Project, etc.)
// that make unit testing difficult. Integration testing would be more appropriate.
