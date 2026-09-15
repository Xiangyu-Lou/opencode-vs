export * as VsWorkerProviders from "./providers"

import { truthy } from "@opencode-ai/core/flag/flag"

export const DISABLE_ENV = "VSWORKER_DISABLE_HIDDEN_PROVIDERS"

// Upstream's hosted offerings. They are billed and operated by opencode, not by this product, so a VsWorker user
// can neither buy nor use them. Listing them in `disabled_providers` is what keeps them out of every provider
// list: the provider HttpApi filters the models.dev catalog on that field before it answers, so one rule covers
// the web UI, the desktop app, the TUI, and `opencode providers` alike.
export const HIDDEN: readonly string[] = ["opencode", "opencode-go"]

export function killed(input: { disabled?: boolean }) {
  // Read at call time, not module load, so tests can set and restore the env var (matches the Flag getters).
  return Boolean(input.disabled) || truthy(DISABLE_ENV)
}

export type ApplyInput = {
  user: readonly string[] | undefined
  disabled?: boolean
}

// Union rather than append: a user config may already name one of these, and `disabled_providers` is compared
// with a Set, so a duplicate would be harmless but would still show up in the value the settings UI writes back.
export function apply(input: ApplyInput): string[] {
  const user = input.user ?? []
  if (killed(input)) return [...user]
  return [...new Set([...user, ...HIDDEN])]
}
