import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Branches = z
    .object({
      current: z.string().optional(),
      default: z.string().optional(),
      locals: z.array(z.string()),
      remotes: z.array(z.string()),
    })
    .meta({
      ref: "VcsBranches",
    })
  export type Branches = z.infer<typeof Branches>

  export const GithubRepo = z
    .object({
      id: z.number(),
      name: z.string(),
      full_name: z.string(),
      owner: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
      clone_url: z.string(),
      html_url: z.string(),
      updated_at: z.string(),
    })
    .meta({
      ref: "VcsGithubRepo",
    })
  export type GithubRepo = z.infer<typeof GithubRepo>

  export const GithubRepos = z
    .object({
      repos: z.array(GithubRepo),
    })
    .meta({
      ref: "VcsGithubRepos",
    })
  export type GithubRepos = z.infer<typeof GithubRepos>

  export const GithubCloneInput = z
    .object({
      full_name: z.string(),
      branch: z.string().optional(),
      parent: z.string().optional(),
    })
    .meta({
      ref: "VcsGithubCloneInput",
    })
  export type GithubCloneInput = z.infer<typeof GithubCloneInput>

  export const GithubCloneResult = z
    .object({
      directory: z.string(),
    })
    .meta({
      ref: "VcsGithubCloneResult",
    })
  export type GithubCloneResult = z.infer<typeof GithubCloneResult>

  async function currentBranch() {
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  function parseLines(input: string) {
    return input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async function listRemotes() {
    return $`git remote`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then(parseLines)
      .catch(() => [])
  }

  async function listRefs(kind: "heads" | "remotes") {
    return $`git for-each-ref refs/${kind} --format=${"%(refname:short)"}`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then(parseLines)
      .catch(() => [])
  }

  async function defaultBranch(remotes: string[]) {
    const remote = remotes.includes("origin") ? "origin" : remotes.at(0)
    if (remote) {
      const ref = await $`git symbolic-ref refs/remotes/${remote}/HEAD`
        .quiet()
        .nothrow()
        .cwd(Instance.worktree)
        .text()
        .then((x) => x.trim())
        .catch(() => "")
      if (ref) return ref.replace(`refs/remotes/${remote}/`, "")
    }

    const main = await $`git show-ref --verify --quiet refs/heads/main`.quiet().nothrow().cwd(Instance.worktree)
    if (main.exitCode === 0) return "main"

    const master = await $`git show-ref --verify --quiet refs/heads/master`.quiet().nothrow().cwd(Instance.worktree)
    if (master.exitCode === 0) return "master"

    return undefined
  }

  function githubHeaders(token: string) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "opencode",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  }

  function parseGithubRepos(input: unknown) {
    if (!Array.isArray(input)) return []

    const failed: string[] = []
    const result = input.flatMap((item) => {
      if (typeof item !== "object" || item === null) return []
      const raw = { ...item } as Record<string, unknown>
      // GitHub API returns owner as an object with a login field
      const owner = raw.owner
      if (typeof owner === "object" && owner !== null && "login" in owner) {
        raw.owner = (owner as Record<string, unknown>).login
      }
      const parsed = GithubRepo.safeParse(raw)
      if (!parsed.success) {
        const repoName = typeof raw.full_name === "string" ? raw.full_name : "unknown"
        failed.push(repoName)
        return []
      }
      return [parsed.data]
    })

    if (failed.length > 0) {
      log.warn("repos dropped due to validation failure", { count: failed.length, repos: failed })
    }

    return result
  }

  async function candidate(parent: string, name: string) {
    const base = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo"
    const existing = await fs
      .readdir(parent, { withFileTypes: true })
      .then((items) => new Set(items.filter((item) => item.isDirectory()).map((item) => item.name)))
      .catch(() => new Set<string>())

    if (!existing.has(base)) return path.join(parent, base)

    for (const i of Array.from({ length: 100 }, (_, index) => index + 1)) {
      const next = `${base}-${i}`
      if (!existing.has(next)) return path.join(parent, next)
    }

    return path.join(parent, `${base}-${Date.now()}`)
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch()
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(Event.BranchUpdated, { branch: next })
        }
      })

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }

  export async function branches() {
    if (Instance.project.vcs !== "git") {
      return {
        current: undefined,
        default: undefined,
        locals: [],
        remotes: [],
      }
    }

    const current = await currentBranch()
    const locals = await listRefs("heads")
    const remotes = (await listRefs("remotes")).filter((name) => !name.endsWith("/HEAD"))
    const defaultRef = await defaultBranch(await listRemotes())

    return {
      current: current || undefined,
      default: defaultRef,
      locals,
      remotes,
    }
  }

  export async function githubRepos(token: string) {
    const allRepos: GithubRepo[] = []
    let url: string | undefined = "https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc"
    const maxPages = 10
    let page = 0

    while (url && page < maxPages) {
      page++
      const response = await fetch(url, {
        headers: githubHeaders(token),
      })
      if (!response.ok) {
        const statusText = response.statusText
        let bodyText: string | undefined
        try {
          bodyText = await response.text()
        } catch {
          // Ignore body parsing errors; we'll still report status and headers.
        }

        const rateLimitRemaining = response.headers.get("x-ratelimit-remaining")
        const rateLimitReset = response.headers.get("x-ratelimit-reset")
        const githubRequestId = response.headers.get("x-github-request-id")

        const parts: string[] = []
        parts.push(
          `GitHub request failed with status ${response.status}${statusText ? ` ${statusText}` : ""}`,
        )
        if (rateLimitRemaining) {
          parts.push(`rate-limit-remaining=${rateLimitRemaining}`)
        }
        if (rateLimitReset) {
          parts.push(`rate-limit-reset=${rateLimitReset}`)
        }
        if (githubRequestId) {
          parts.push(`github-request-id=${githubRequestId}`)
        }
        if (bodyText) {
          const maxBodyLength = 500
          const snippet = bodyText.length > maxBodyLength ? `${bodyText.slice(0, maxBodyLength)}...` : bodyText
          parts.push(`response body: ${snippet}`)
        }

        throw new Error(parts.join("; "))
      }

      allRepos.push(...parseGithubRepos(await response.json()))

      // Parse Link header for next page
      const link = response.headers.get("link") ?? ""
      const next = link.split(",").find((part) => part.includes('rel="next"'))
      const match = next?.match(/<([^>]+)>/)
      url = match?.[1]
    }

    if (url && page >= maxPages) {
      log.warn("repo list truncated at pagination limit", { maxPages, totalFetched: allRepos.length })
    }

    return {
      repos: allRepos,
    }
  }

  export async function githubClone(input: GithubCloneInput, token: string) {
    const parent = input.parent?.trim() || process.cwd()
    const name = input.full_name.split("/").at(1) || input.full_name
    const target = await candidate(parent, name)

    await fs.mkdir(parent, { recursive: true })

    const auth = `https://x-access-token:${encodeURIComponent(token)}@github.com/${input.full_name}.git`
    const branch = input.branch?.trim()
    const clone = branch
      ? await $`git clone --branch ${branch} --single-branch ${auth} ${target}`.quiet().nothrow()
      : await $`git clone ${auth} ${target}`.quiet().nothrow()

    if (clone.exitCode !== 0) {
      const stderr = new TextDecoder().decode(clone.stderr).trim()
      const stdout = new TextDecoder().decode(clone.stdout).trim()
      const message = stderr || stdout || "Failed to clone GitHub repo"
      throw new Error(message)
    }

    await $`git remote set-url origin https://github.com/${input.full_name}.git`.quiet().nothrow().cwd(target)

    return {
      directory: target,
    }
  }
}
