// vsworker-seam: data layer for the fork's management routes. Self-contained on purpose: it registers its own
// queries and its own event subscription rather than editing upstream's server-sync context, so an upstream
// merge never has to reconcile this file.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { UseMutationResult, UseQueryResult } from "@tanstack/solid-query"
import { createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import type {
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  OpencodeClient,
  VsWorkerBundledMcp,
  VsWorkerBundledPlugin,
  VsWorkerBundledSkill,
  VsWorkerBundledState,
  VsWorkerMcpList,
  VsWorkerOrigin,
  VsWorkerPluginList,
  VsWorkerRevisions,
  VsWorkerScope,
  VsWorkerSkillContent,
  VsWorkerSkillList,
  VsWorkerSkillSources,
  VsWorkerUserMcp,
  VsWorkerUserPlugin,
  VsWorkerUserSkill,
} from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { errorOf, isConflict } from "./errors"

// The wire shapes come straight from the generated SDK so this file can never drift from the routes.
export type Scope = VsWorkerScope
export type Revisions = VsWorkerRevisions
export type BundledState = VsWorkerBundledState
export type Origin = VsWorkerOrigin
export type BundledPlugin = VsWorkerBundledPlugin
export type UserPlugin = VsWorkerUserPlugin
export type PluginList = VsWorkerPluginList
export type BundledSkill = VsWorkerBundledSkill
export type UserSkill = VsWorkerUserSkill
export type SkillSources = VsWorkerSkillSources
export type SkillList = VsWorkerSkillList
export type SkillContent = VsWorkerSkillContent
export type BundledMcp = VsWorkerBundledMcp
export type UserMcp = VsWorkerUserMcp
export type McpList = VsWorkerMcpList
export type McpConfig = McpLocalConfig | McpRemoteConfig
export type McpStatusInfo = McpStatus

const KIND = ["vsworker-plugins", "vsworker-skills", "vsworker-mcp"] as const

export type VsWorkerApi = OpencodeClient["vsworker"]

export type VsWorker = {
  plugins: UseQueryResult<PluginList, Error>
  skills: UseQueryResult<SkillList, Error>
  mcp: UseQueryResult<McpList, Error>
  invalidate: () => Promise<void>
  mutation: <V>(run: (value: V) => Promise<unknown>) => UseMutationResult<unknown, unknown, V, unknown>
  api: Accessor<VsWorkerApi>
}

export function useVsWorker(directory: Accessor<string | undefined>): VsWorker {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  const language = useLanguage()

  const sdk = createMemo<OpencodeClient>(() => serverSDK().createClient({ directory: directory(), throwOnError: true }))
  const scope = createMemo(() => serverSDK().scope)
  const key = createMemo(() => directory() ?? "")
  const api = createMemo<VsWorkerApi>(() => sdk().vsworker)

  const keyFor = (kind: (typeof KIND)[number]): readonly unknown[] => [scope(), key(), kind]

  const plugins = useQuery(() =>
    queryOptions<PluginList>({
      queryKey: keyFor("vsworker-plugins"),
      queryFn: async () => {
        const result = await api().plugin.list()
        return result.data as PluginList
      },
    }),
  )

  const skills = useQuery(() =>
    queryOptions<SkillList>({
      queryKey: keyFor("vsworker-skills"),
      queryFn: async () => {
        const result = await api().skill.list()
        return result.data as SkillList
      },
    }),
  )

  const mcp = useQuery(() =>
    queryOptions<McpList>({
      queryKey: keyFor("vsworker-mcp"),
      queryFn: async () => {
        const result = await api().mcp.list()
        return result.data as McpList
      },
    }),
  )

  const invalidate = async () => {
    await Promise.all(KIND.map((kind) => queryClient.invalidateQueries({ queryKey: [scope(), key(), kind] })))
  }

  // Writes dispose the instance, so the server's own view of MCP status, skills, and plugins changes a moment
  // after the response. These are the events that say so.
  onMount(() => {
    const stop = serverSDK().event.listen((emitted) => {
      // The event union is wider than any one server build declares, so compare as strings the way
      // server-sync.tsx does.
      const type: string = emitted.details.type
      if (
        type === "config.updated" ||
        type === "global.disposed" ||
        type === "server.instance.disposed" ||
        type === "mcp.status.changed" ||
        type === "server.connected"
      ) {
        void invalidate()
      }
    })
    onCleanup(() => stop())
  })

  // Every write refreshes all three lists: a single config file backs all of them, so its revision moves even
  // when only one list changed, and a stale revision is what turns the next save into a conflict.
  const mutation = <V>(run: (value: V) => Promise<unknown>): UseMutationResult<unknown, unknown, V, unknown> =>
    useMutation(() => ({
      mutationFn: run,
      onSettled: () => invalidate(),
      onError: (error: unknown) => {
        const detail = errorOf(error)
        if (isConflict(error)) {
          showToast({
            variant: "error",
            title: language.t("vsworker.conflict.title"),
            description: language.t("vsworker.conflict.description", { file: detail.file ?? "" }),
          })
          return
        }
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: detail.message ?? (error instanceof Error ? error.message : String(error)),
        })
      },
    }))

  return { plugins, skills, mcp, invalidate, mutation, api }
}

export { errorOf, isConflict, type ErrorDetail } from "./errors"
