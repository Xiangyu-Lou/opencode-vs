// vsworker-seam: add/edit form for one MCP server definition.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { McpConfig, Scope } from "./api"
import {
  emptyMcpForm,
  fromMcpConfig,
  parseQuickAdd,
  quickAddToForm,
  secretWarnings,
  toMcpConfig,
  validateMcp,
  type McpForm,
} from "./controllers"
import { Field } from "./parts"
import "./vsworker.css"

export const DialogMcpServer: Component<{
  mode: "add" | "edit"
  scope: Scope
  name?: string
  config?: McpConfig
  taken?: string[]
  onSubmit: (input: { name: string; config: McpConfig }) => Promise<unknown>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [form, setForm] = createStore<McpForm>(
    props.config && props.name ? fromMcpConfig(props.name, props.config) : emptyMcpForm(),
  )
  const [errors, setErrors] = createSignal<Partial<Record<keyof McpForm, string>>>({})
  const [paste, setPaste] = createSignal(false)
  const [pasted, setPasted] = createSignal("")
  const [pasteError, setPasteError] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const taken = createMemo(() => (props.taken ?? []).filter((item) => item !== props.name))
  const warnings = createMemo(() => secretWarnings(form))

  const applyPaste = () => {
    const parsed = parseQuickAdd(pasted())
    if (!parsed) {
      setPasteError(true)
      return
    }
    setPasteError(false)
    setForm(quickAddToForm(parsed, { ...form }))
    setPaste(false)
  }

  const submit = async () => {
    const found = validateMcp(language.t, form, taken())
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    // The enabled flag is only written when editing an existing entry, so adding a server leaves the key out
    // and lets it default to on.
    const enabled = props.mode === "edit" ? props.config?.enabled : undefined
    await props
      .onSubmit({ name: form.name.trim(), config: toMcpConfig(form, enabled) })
      .then(() => dialog.close())
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit class="vsworker-dialog vsworker-mcp-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>
          {props.mode === "add" ? language.t("vsworker.mcp.add.title") : language.t("vsworker.mcp.edit.title")}
        </DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <Show
          when={!paste()}
          fallback={
            <div class="vsworker-form">
              <Field
                label={language.t("vsworker.mcp.paste")}
                hint={language.t("vsworker.mcp.pasteHint")}
                error={pasteError() ? language.t("vsworker.mcp.pasteInvalid") : undefined}
              >
                <TextareaV2
                  class="vsworker-textarea"
                  rows={8}
                  value={pasted()}
                  onInput={(event) => {
                    setPasted(event.currentTarget.value)
                    setPasteError(false)
                  }}
                  spellcheck={false}
                  autocorrect="off"
                  autocapitalize="off"
                  data-action="vsworker-mcp-paste"
                />
              </Field>
            </div>
          }
        >
          <div class="vsworker-form">
            <Field label={language.t("vsworker.mcp.name")} error={errors().name}>
              <TextInputV2
                appearance="large"
                class="!w-full self-stretch"
                value={form.name}
                placeholder={language.t("vsworker.mcp.namePlaceholder")}
                invalid={!!errors().name}
                disabled={props.mode === "edit"}
                onInput={(event) => setForm("name", event.currentTarget.value)}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                data-action="vsworker-mcp-name"
              />
            </Field>

            <Field label={language.t("vsworker.mcp.type")}>
              <SegmentedControlV2
                value={form.type}
                onChange={(value) => {
                  if (value === "local" || value === "remote") setForm("type", value)
                }}
                data-action="vsworker-mcp-type"
              >
                <SegmentedControlItemV2 value="local">{language.t("vsworker.mcp.type.local")}</SegmentedControlItemV2>
                <SegmentedControlItemV2 value="remote">{language.t("vsworker.mcp.type.remote")}</SegmentedControlItemV2>
              </SegmentedControlV2>
            </Field>

            <Show
              when={form.type === "local"}
              fallback={
                <>
                  <Field label={language.t("vsworker.mcp.url")} error={errors().url}>
                    <TextInputV2
                      appearance="large"
                      class="!w-full self-stretch"
                      value={form.url}
                      placeholder={language.t("vsworker.mcp.urlPlaceholder")}
                      invalid={!!errors().url}
                      onInput={(event) => setForm("url", event.currentTarget.value)}
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      data-action="vsworker-mcp-url"
                    />
                  </Field>
                  <Field label={language.t("vsworker.mcp.headers")} hint={language.t("vsworker.mcp.headersHint")}>
                    <TextareaV2
                      class="vsworker-textarea"
                      rows={3}
                      value={form.headers}
                      onInput={(event) => setForm("headers", event.currentTarget.value)}
                      spellcheck={false}
                      autocorrect="off"
                      autocapitalize="off"
                      data-action="vsworker-mcp-headers"
                    />
                  </Field>
                </>
              }
            >
              <Field label={language.t("vsworker.mcp.command")} error={errors().command}>
                <TextInputV2
                  appearance="large"
                  class="!w-full self-stretch"
                  value={form.command}
                  placeholder={language.t("vsworker.mcp.commandPlaceholder")}
                  invalid={!!errors().command}
                  onInput={(event) => setForm("command", event.currentTarget.value)}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  data-action="vsworker-mcp-command"
                />
              </Field>
              <Field label={language.t("vsworker.mcp.cwd")}>
                <TextInputV2
                  appearance="large"
                  class="!w-full self-stretch"
                  value={form.cwd}
                  placeholder={language.t("vsworker.mcp.cwdPlaceholder")}
                  onInput={(event) => setForm("cwd", event.currentTarget.value)}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  data-action="vsworker-mcp-cwd"
                />
              </Field>
              <Field label={language.t("vsworker.mcp.environment")} hint={language.t("vsworker.mcp.environmentHint")}>
                <TextareaV2
                  class="vsworker-textarea"
                  rows={3}
                  value={form.environment}
                  onInput={(event) => setForm("environment", event.currentTarget.value)}
                  spellcheck={false}
                  autocorrect="off"
                  autocapitalize="off"
                  data-action="vsworker-mcp-environment"
                />
              </Field>
            </Show>

            <Field label={language.t("vsworker.mcp.timeout")} error={errors().timeout}>
              <TextInputV2
                appearance="large"
                class="!w-full self-stretch"
                value={form.timeout}
                placeholder={language.t("vsworker.mcp.timeoutPlaceholder")}
                invalid={!!errors().timeout}
                inputmode="numeric"
                onInput={(event) => setForm("timeout", event.currentTarget.value)}
                data-action="vsworker-mcp-timeout"
              />
            </Field>

            <Show when={warnings().length > 0}>
              <div class="vsworker-field-hint" data-action="vsworker-mcp-secret-warning">
                <For each={warnings()}>
                  {(field) => <div>{`${field}: ${language.t("vsworker.mcp.secretWarning")}`}</div>}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2
          variant="ghost-muted"
          onClick={() => {
            setPasteError(false)
            setPaste(!paste())
          }}
          data-action="vsworker-mcp-paste-toggle"
        >
          {paste() ? language.t("vsworker.mcp.pasteBack") : language.t("vsworker.mcp.paste")}
        </ButtonV2>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <Show
          when={!paste()}
          fallback={
            <ButtonV2 variant="contrast" onClick={applyPaste} data-action="vsworker-mcp-paste-apply">
              {language.t("common.continue")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="contrast" disabled={busy()} onClick={() => void submit()} data-action="vsworker-mcp-save">
            {props.mode === "add" ? language.t("vsworker.mcp.add") : language.t("common.save")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
