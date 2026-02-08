import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
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
}
