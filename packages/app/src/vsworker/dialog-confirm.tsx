// vsworker-seam: a small confirmation step before a destructive write. The app has no confirm primitive, and
// window.confirm is not usable in the Electron renderer.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import "./vsworker.css"

export const DialogConfirm: Component<{
  message: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  return (
    <Dialog fit class="vsworker-dialog vsworker-confirm-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{props.confirmLabel}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <p class="vsworker-row-description">{props.message}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          disabled={busy()}
          data-action="vsworker-confirm-accept"
          onClick={() => {
            setBusy(true)
            void props
              .onConfirm()
              .then(() => dialog.close())
              .finally(() => setBusy(false))
          }}
        >
          {props.confirmLabel}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
