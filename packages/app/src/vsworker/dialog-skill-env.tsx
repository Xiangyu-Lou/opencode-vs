// vsworker-seam: edit the environment variables of one bundled skill. The build ships an env.json; what is saved
// here is an override in the user's config, layered over that file when a command runs in the skill.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { Scope, SkillEnv } from "./api"
import { envErrors, envForm, envMask, envPayload, envSecrets, type EnvForm, type EnvValues } from "./controllers"
import { Field } from "./parts"
import "./vsworker.css"

export const DialogSkillEnv: Component<{
  scope: Scope
  env: SkillEnv
  onSubmit: (env: EnvValues) => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const defaults = () => props.env.defaults
  const mine = () => (props.scope === "project" ? props.env.overrides.project : props.env.overrides.global)
  const other = () => (props.scope === "project" ? props.env.overrides.global : props.env.overrides.project)

  const [form, setForm] = createStore<EnvForm>(envForm(defaults(), mine()))
  const [reveal, setReveal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const keys = createMemo(() => Object.keys(form.fields))
  // Covered until asked for, because a packaged file may ship a literal credential.
  const secrets = createMemo(() => new Set(envSecrets(defaults(), mine())))
  const errors = createMemo(() => envErrors(language.t, form))
  const hidden = (key: string) => secrets().has(key) && !reveal()

  const submit = async (env: EnvValues) => {
    setBusy(true)
    await props
      .onSubmit(env)
      .then(() => dialog.close())
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit class="vsworker-dialog-wide vsworker-skill-env-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("vsworker.skills.env.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="vsworker-form">
          <p class="vsworker-row-description">
            {language.t("vsworker.skills.env.description", { name: props.env.name })}
          </p>
          <p class="vsworker-row-description">
            {props.scope === "project"
              ? language.t("vsworker.skills.env.savedProject")
              : language.t("vsworker.skills.env.savedGlobal")}
          </p>

          <Show when={props.env.problems.length > 0}>
            <div class="vsworker-field-error" data-action="vsworker-skill-env-problems">
              <div>{language.t("vsworker.skills.env.problems")}</div>
              <For each={props.env.problems}>{(problem) => <div>{problem}</div>}</For>
            </div>
          </Show>

          <Show
            when={keys().length > 0}
            fallback={<p class="vsworker-row-description">{language.t("vsworker.skills.env.packagedNone")}</p>}
          >
            <For each={keys()}>
              {(key) => (
                <Field
                  label={key}
                  hint={
                    other()[key] !== undefined
                      ? props.scope === "project"
                        ? language.t("vsworker.skills.env.alsoGlobal")
                        : language.t("vsworker.skills.env.alsoProject")
                      : language.t("vsworker.skills.env.packaged", {
                          value: hidden(key) ? envMask(defaults()[key] ?? "") : (defaults()[key] ?? ""),
                        })
                  }
                >
                  <TextInputV2
                    appearance="large"
                    class="!w-full self-stretch"
                    type={hidden(key) ? "password" : "text"}
                    value={form.fields[key] ?? ""}
                    placeholder={hidden(key) ? envMask(defaults()[key] ?? "") : (defaults()[key] ?? "")}
                    onInput={(event) => setForm("fields", key, event.currentTarget.value)}
                    spellcheck={false}
                    autocorrect="off"
                    autocomplete="off"
                    autocapitalize="off"
                    data-action={`vsworker-skill-env-field-${key}`}
                  />
                </Field>
              )}
            </For>
          </Show>

          <Field
            label={language.t("vsworker.skills.env.extra")}
            hint={language.t("vsworker.skills.env.extraHint")}
            error={errors()[0]}
          >
            <TextareaV2
              class="vsworker-textarea"
              rows={3}
              value={form.extra}
              invalid={errors().length > 0}
              onInput={(event) => setForm("extra", event.currentTarget.value)}
              spellcheck={false}
              autocorrect="off"
              autocapitalize="off"
              data-action="vsworker-skill-env-extra"
            />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Show when={secrets().size > 0}>
          <ButtonV2 variant="ghost-muted" onClick={() => setReveal(!reveal())} data-action="vsworker-skill-env-reveal">
            {reveal() ? language.t("vsworker.skills.env.hide") : language.t("vsworker.skills.env.reveal")}
          </ButtonV2>
        </Show>
        <Show when={Object.keys(mine()).length > 0}>
          <ButtonV2
            variant="ghost-muted"
            disabled={busy()}
            onClick={() => void submit({})}
            data-action="vsworker-skill-env-clear"
          >
            {language.t("vsworker.skills.env.clear")}
          </ButtonV2>
        </Show>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={busy() || errors().length > 0}
          onClick={() => void submit(envPayload(defaults(), form))}
          data-action="vsworker-skill-env-save"
        >
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
