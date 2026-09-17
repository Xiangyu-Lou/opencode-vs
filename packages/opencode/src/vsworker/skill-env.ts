export * as VsWorkerSkillEnv from "./skill-env"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { VsWorkerEnv } from "@vsworker/bundle/env"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { VsWorkerConfigEdit } from "./config-edit"

export type Defaults = { present: boolean; values: VsWorkerEnv.Values; problems: string[] }

// The packaged env.json of a bundled skill, read from the build constant rather than the cache: byte-identical to
// the materialized copy by the hash gate, available whether or not the skill is enabled, and never touching the
// mtime cache the shell reads through.
export function defaults(id: string): Defaults {
  const entry = VsWorkerSkills.bundle.find((item) => item.id === id)
  const file = entry?.files.find((item) => item.path === VsWorkerEnv.FILE)
  if (!file) return { present: false, values: {}, problems: [] }
  const text = file.encoding === "base64" ? Buffer.from(file.data, "base64").toString("utf8") : file.data
  const parsed = VsWorkerEnv.parse(text, `${id}/${VsWorkerEnv.FILE}`)
  return { present: true, values: parsed.values, problems: parsed.problems }
}

function coerce(raw: unknown): VsWorkerEnv.Values | undefined {
  if (!VsWorkerConfigEdit.isRecord(raw)) return undefined
  const values: VsWorkerEnv.Values = {}
  for (const [key, value] of Object.entries(raw)) {
    const text = VsWorkerEnv.scalar(value)
    if (text !== undefined) values[key] = text
  }
  return values
}

// Every skill's overrides from the merged config, keyed by skill name, in the shape VsWorkerEnv.resolve takes.
export function overrides(config: Pick<ConfigV1.Info, "vsworker">): ReadonlyMap<string, VsWorkerEnv.Values> {
  const out = new Map<string, VsWorkerEnv.Values>()
  for (const [id, raw] of Object.entries(config.vsworker?.skill_env ?? {})) {
    const values = coerce(raw)
    if (values) out.set(id, values)
  }
  return out
}

// The overrides one config file carries for a skill, from that file's own parse, so the editor can say which
// scope set what. Values are the raw text of the file, placeholders intact.
export function scoped(parsed: unknown, id: string): VsWorkerEnv.Values | undefined {
  const vsworker = VsWorkerConfigEdit.isRecord(parsed) ? parsed["vsworker"] : undefined
  const all = VsWorkerConfigEdit.isRecord(vsworker) ? vsworker["skill_env"] : undefined
  const raw = VsWorkerConfigEdit.isRecord(all) ? all[id] : undefined
  return coerce(raw)
}

export function invalidKeys(env: Record<string, unknown>): string[] {
  return Object.keys(env).filter((key) => !VsWorkerEnv.KEY.test(key))
}
