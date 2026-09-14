// vsworker-seam: create, edit, and read-only view for one skill's SKILL.md.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { slugify, validateSkill, type SkillForm } from "./controllers"
import { Field } from "./parts"
import "./vsworker.css"

export const DialogSkill: Component<{
  mode: "create" | "edit" | "view"
  initial?: Partial<SkillForm>
  location?: string
  onSubmit?: (form: SkillForm) => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [form, setForm] = createStore<SkillForm>({
    name: props.initial?.name ?? "",
    description: props.initial?.description ?? "",
    content: props.initial?.content ?? "",
  })
  const [errors, setErrors] = createSignal<Partial<Record<keyof SkillForm, string>>>({})
  const [busy, setBusy] = createSignal(false)
  // Only auto-derive the directory name while the user has not typed one themselves.
  const [linked, setLinked] = createSignal(props.mode === "create")

  const title = () => {
    if (props.mode === "create") return language.t("vsworker.skills.new.title")
    if (props.mode === "edit") return language.t("vsworker.skills.edit.title")
    return language.t("vsworker.skills.view.title")
  }

  const submit = async () => {
    if (!props.onSubmit) return
    const found = validateSkill(language.t, form)
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    await props
      .onSubmit({ name: form.name.trim(), description: form.description.trim(), content: form.content })
      .then(() => dialog.close())
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit class="vsworker-dialog-wide vsworker-skill-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="vsworker-form">
          <Show when={props.mode !== "view"}>
            <Field
              label={language.t("vsworker.skills.name")}
              hint={language.t("vsworker.skills.nameHelp")}
              error={errors().name}
            >
              <TextInputV2
                appearance="large"
                class="!w-full self-stretch"
                value={form.name}
                placeholder={language.t("vsworker.skills.namePlaceholder")}
                invalid={!!errors().name}
                disabled={props.mode === "edit"}
                onInput={(event) => {
                  setLinked(false)
                  setForm("name", event.currentTarget.value)
                }}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                data-action="vsworker-skill-name"
              />
            </Field>
          </Show>

          <Field
            label={language.t("vsworker.skills.description")}
            hint={props.mode === "view" ? undefined : language.t("vsworker.skills.descriptionHelp")}
            error={errors().description}
          >
            <TextareaV2
              rows={2}
              value={form.description}
              placeholder={language.t("vsworker.skills.descriptionPlaceholder")}
              invalid={!!errors().description}
              readonly={props.mode === "view"}
              onInput={(event) => {
                const value = event.currentTarget.value
                setForm("description", value)
                if (linked()) setForm("name", slugify(value))
              }}
              data-action="vsworker-skill-description"
            />
          </Field>

          <Field label={language.t("vsworker.skills.content")} error={errors().content}>
            <TextareaV2
              class="vsworker-textarea"
              rows={14}
              value={form.content}
              invalid={!!errors().content}
              readonly={props.mode === "view"}
              onInput={(event) => setForm("content", event.currentTarget.value)}
              spellcheck={false}
              autocorrect="off"
              autocapitalize="off"
              data-action="vsworker-skill-content"
            />
          </Field>

          <Show when={props.location}>{(location) => <div class="vsworker-row-meta">{location()}</div>}</Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {props.mode === "view" ? language.t("common.close") : language.t("common.cancel")}
        </ButtonV2>
        <Show when={props.mode !== "view"}>
          <ButtonV2
            variant="contrast"
            disabled={busy()}
            onClick={() => void submit()}
            data-action="vsworker-skill-save"
          >
            {language.t("common.save")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
