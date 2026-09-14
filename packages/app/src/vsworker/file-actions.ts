// vsworker-seam: desktop-only file affordances, feature-detected so the web build simply does not show them.
import { usePlatform } from "@/context/platform"

export function useFileActions() {
  const platform = usePlatform()
  return {
    canReveal(path: string | undefined): path is string {
      return Boolean(path) && typeof platform.revealPath === "function"
    },
    canOpen(path: string | undefined): path is string {
      return Boolean(path) && typeof platform.openPath === "function"
    },
    async reveal(path: string) {
      await platform.revealPath?.(path)
    },
    async open(path: string) {
      await platform.openPath?.(path)
    },
  }
}
