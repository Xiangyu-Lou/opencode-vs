// vsworker-seam: add a plugin by spec, and edit the options of a bundled one.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Field } from "./parts"
import "./vsworker.css"

export const DialogPluginAdd: Component<{ onSubmit: (spec: string) => Promise<unknown> }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [spec, setSpec] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const browse = async () => {
    if (platform.platform !== "desktop") return
    const picked = await platform.openDirectoryPickerDialog()
    const first = Array.isArray(picked) ? picked[0] : picked
    if (typeof first === "string" && first) setSpec(first)
  }

  const submit = async () => {
    const value = spec().trim()
    if (!value) {
      setError(language.t("vsworker.plugins.add.spec"))
      return
    }
    setError(undefined)
    setBusy(true)
    await props
      .onSubmit(value)
      .then(() => dialog.close())
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit class="vsworker-dialog vsworker-plugin-add-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("vsworker.plugins.add.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="vsworker-form">
          <Field
            label={language.t("vsworker.plugins.add.spec")}
            hint={language.t("vsworker.plugins.add.specHelp")}
            error={error()}
          >
            <TextInputV2
              appearance="large"
              class="!w-full self-stretch"
              value={spec()}
              placeholder={language.t("vsworker.plugins.add.specPlaceholder")}
              invalid={!!error()}
              autofocus
              onInput={(event) => setSpec(event.currentTarget.value)}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              data-action="vsworker-plugin-spec"
            />
          </Field>
          <Show when={platform.platform === "desktop"}>
            <div>
              <ButtonV2 variant="neutral" onClick={() => void browse()} data-action="vsworker-plugin-browse">
                {language.t("vsworker.plugins.add.browse")}
              </ButtonV2>
            </div>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy()} onClick={() => void submit()} data-action="vsworker-plugin-save">
          {busy() ? language.t("vsworker.plugins.add.working") : language.t("vsworker.plugins.add.submit")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export const DialogPluginOptions: Component<{
  name: string
  options?: Record<string, unknown>
  onSubmit: (options: Record<string, unknown> | null) => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [text, setText] = createSignal(props.options ? JSON.stringify(props.options, null, 2) : "{}")
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    const value = text().trim()
    // An empty box clears the key rather than writing an empty object.
    if (!value || value === "{}") {
      setBusy(true)
      await props
        .onSubmit(null)
        .then(() => dialog.close())
        .finally(() => setBusy(false))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      setError(true)
      return
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError(true)
      return
    }
    setError(false)
    setBusy(true)
    await props
      .onSubmit(parsed as Record<string, unknown>)
      .then(() => dialog.close())
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit class="vsworker-dialog vsworker-plugin-options-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("vsworker.plugins.options.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="vsworker-form">
          <Field
            label={language.t("vsworker.plugins.options.title")}
            hint={language.t("vsworker.plugins.options.description", { name: props.name })}
            error={error() ? language.t("vsworker.plugins.options.invalid") : undefined}
          >
            <TextareaV2
              class="vsworker-textarea"
              rows={10}
              value={text()}
              invalid={error()}
              onInput={(event) => {
                setText(event.currentTarget.value)
                setError(false)
              }}
              spellcheck={false}
              autocorrect="off"
              autocapitalize="off"
              data-action="vsworker-plugin-options"
            />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={busy()}
          onClick={() => void submit()}
          data-action="vsworker-plugin-options-save"
        >
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
