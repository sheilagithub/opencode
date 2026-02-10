import { $ } from "bun"
import { beforeEach, describe, expect, mock, test } from "bun:test"
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

describe("Vcs.githubRepos", () => {
  const mockRepos = (count: number, page: number) => {
    return Array.from({ length: count }, (_, i) => ({
      id: page * 100 + i,
      name: `repo-${page}-${i}`,
      full_name: `owner/repo-${page}-${i}`,
      owner: { login: "owner", id: 1 },
      private: false,
      default_branch: "main",
      clone_url: `https://github.com/owner/repo-${page}-${i}.git`,
      html_url: `https://github.com/owner/repo-${page}-${i}`,
      updated_at: "2024-01-01T00:00:00Z",
    }))
  }

  beforeEach(() => {
    mock.restore()
  })

  test("handles owner object with login field", async () => {
    const mockFetch = mock((url: string) => {
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve(mockRepos(2, 1)),
      } as Response)
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await Vcs.githubRepos("test-token")

    expect(result.repos).toHaveLength(2)
    expect(result.repos[0].owner).toBe("owner")
    expect(typeof result.repos[0].owner).toBe("string")
  })

  test("aggregates results across multiple pages", async () => {
    let callCount = 0
    const mockFetch = mock((url: string) => {
      callCount++
      const hasNext = callCount < 3
      const headers = new Headers()
      if (hasNext) {
        headers.set("link", `<https://api.github.com/user/repos?page=${callCount + 1}>; rel="next"`)
      }

      return Promise.resolve({
        ok: true,
        headers,
        json: () => Promise.resolve(mockRepos(10, callCount)),
      } as Response)
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await Vcs.githubRepos("test-token")

    expect(callCount).toBe(3)
    expect(result.repos).toHaveLength(30)
  })

  test("respects max page limit", async () => {
    let callCount = 0
    const mockFetch = mock((url: string) => {
      callCount++
      const headers = new Headers()
      headers.set("link", `<https://api.github.com/user/repos?page=${callCount + 1}>; rel="next"`)

      return Promise.resolve({
        ok: true,
        headers,
        json: () => Promise.resolve(mockRepos(100, callCount)),
      } as Response)
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await Vcs.githubRepos("test-token")

    expect(callCount).toBe(10)
    expect(result.repos).toHaveLength(1000)
  })
})

