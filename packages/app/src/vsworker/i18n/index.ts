// vsworker-seam: the fork's i18n domain, merged into the app dictionary by context/language.tsx.
export { dict as en } from "./en"

export type VsWorkerDict = typeof import("./en").dict
export type VsWorkerKey = keyof VsWorkerDict

// Only locales with a translation appear here; every other locale falls back to English, which the language
// context already provides by spreading the English dict into the base.
export const loaders: Record<string, () => Promise<{ dict: Record<string, string> }>> = {
  zh: () => import("./zh"),
}
