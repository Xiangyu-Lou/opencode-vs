// vsworker-seam: edit the extra directories and index URLs the skill scanner walks.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { Field } from "./parts"
import "./vsworker.css"

const lines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)

export const DialogSkillSources: Component<{
  paths: string[]
  urls: string[]
  onSubmit: (input: { paths: string[]; urls: string[] }) => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [paths, setPaths] = createSignal(props.paths.join("\n"))
  const [urls, setUrls] = createSignal(props.urls.join("\n"))
  const [busy, setBusy] = createSignal(false)

  return (
    <Dialog fit class="vsworker-dialog vsworker-skill-sources-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("vsworker.skills.sources.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="vsworker-form">
          <p class="vsworker-row-description">{language.t("vsworker.skills.sources.description")}</p>
          <Field label={language.t("vsworker.skills.sources.paths")} hint={language.t("vsworker.skills.sources.hint")}>
            <TextareaV2
              class="vsworker-textarea"
              rows={4}
              value={paths()}
              placeholder={language.t("vsworker.skills.sources.pathsPlaceholder")}
              onInput={(event) => setPaths(event.currentTarget.value)}
              spellcheck={false}
              autocorrect="off"
              autocapitalize="off"
              data-action="vsworker-skill-sources-paths"
            />
          </Field>
          <Field label={language.t("vsworker.skills.sources.urls")} hint={language.t("vsworker.skills.sources.hint")}>
            <TextareaV2
              class="vsworker-textarea"
              rows={4}
              value={urls()}
              placeholder={language.t("vsworker.skills.sources.urlsPlaceholder")}
              onInput={(event) => setUrls(event.currentTarget.value)}
              spellcheck={false}
              autocorrect="off"
              autocapitalize="off"
              data-action="vsworker-skill-sources-urls"
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
          data-action="vsworker-skill-sources-save"
          onClick={() => {
            setBusy(true)
            void props
              .onSubmit({ paths: lines(paths()), urls: lines(urls()) })
              .then(() => dialog.close())
              .finally(() => setBusy(false))
          }}
        >
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
