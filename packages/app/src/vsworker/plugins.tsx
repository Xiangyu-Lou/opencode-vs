// vsworker-seam: the Plugins tab.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BundledPlugin, Scope, UserPlugin, VsWorker } from "./api"
import { filterPlugins, isOn, stateLabel, stateTone, toggleDisabled, userPluginRows } from "./controllers"
import { DialogConfirm } from "./dialog-confirm"
import { DialogPluginAdd, DialogPluginOptions } from "./dialog-plugin"
import { Empty, Pill, Row, Section, TabHeader } from "./parts"
import { useFileActions } from "./file-actions"
import "./vsworker.css"

export const VsWorkerPlugins: Component<{
  vsworker: VsWorker
  scope: Accessor<Scope>
  setScope: (scope: Scope) => void
  hasProject: Accessor<boolean>
  query: Accessor<string>
  setQuery: (value: string) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const files = useFileActions()

  const data = () => props.vsworker.plugins.data
  const revision = () => {
    const revisions = data()?.revisions
    return props.scope() === "project" ? revisions?.project : revisions?.global
  }

  const toggle = props.vsworker.mutation((input: { id: string; enabled: boolean }) =>
    props.vsworker
      .api()
      .plugin.update({ id: input.id, scope: props.scope(), enabled: input.enabled, expectedRevision: revision() }),
  )

  const setOptions = props.vsworker.mutation((input: { id: string; options: Record<string, unknown> }) =>
    props.vsworker
      .api()
      .plugin.update({ id: input.id, scope: props.scope(), options: input.options, expectedRevision: revision() }),
  )

  const add = props.vsworker.mutation((spec: string) =>
    props.vsworker.api().plugin.add({ scope: props.scope(), spec, expectedRevision: revision() }),
  )

  // A removal writes to the file that declares the entry, which is not always the tab's current scope.
  const remove = props.vsworker.mutation((row: UserPlugin) => {
    const scope = row.scope ?? props.scope()
    const revisions = props.vsworker.plugins.data?.revisions
    return props.vsworker.api().plugin.remove({
      id: row.name,
      scope,
      spec: row.spec,
      expectedRevision: scope === "project" ? revisions?.project : revisions?.global,
    })
  })

  const bundled = createMemo<BundledPlugin[]>(() => filterPlugins(data()?.bundled ?? [], props.query()))
  const user = createMemo(() => userPluginRows(data()?.user ?? [], props.query()))

  const openOptions = (row: BundledPlugin) => {
    void dialog.push(() => (
      <DialogPluginOptions
        name={row.id}
        options={row.options}
        onSubmit={(options) => setOptions.mutateAsync({ id: row.id, options: options ?? {} })}
      />
    ))
  }

  return (
    <>
      <TabHeader
        kind="plugins"
        title={language.t("vsworker.tab.plugins")}
        scope={props.scope()}
        onScope={props.setScope}
        hasProject={props.hasProject()}
        query={props.query()}
        onQuery={props.setQuery}
        searchLabel={language.t("vsworker.search.plugins")}
      />

      <div class="settings-v2-tab-body">
        <Section title={language.t("vsworker.section.bundled")}>
          <Show when={bundled().length > 0} fallback={<Empty>{language.t("vsworker.plugins.empty")}</Empty>}>
            <For each={bundled()}>
              {(row) => (
                <Row
                  action={`vsworker-plugin-bundled-${row.id}`}
                  title={
                    <>
                      <span class="vsworker-row-name">{row.id}</span>
                      <Tag>{row.version}</Tag>
                    </>
                  }
                  description={row.description}
                  actions={
                    <>
                      <Pill tone={stateTone(row.state)}>{stateLabel(language.t, row.state, "plugin")}</Pill>
                      <Switch
                        hideLabel
                        label={row.id}
                        checked={isOn(row.state)}
                        disabled={toggleDisabled(row.state) || toggle.isPending}
                        onChange={(checked) => toggle.mutate({ id: row.id, enabled: checked })}
                      />
                      <MenuV2 gutter={4} modal={false} placement="bottom-end">
                        <MenuV2.Trigger as={ButtonV2} variant="ghost-muted" size="normal">
                          {language.t("vsworker.plugins.options.action")}
                        </MenuV2.Trigger>
                        <MenuV2.Portal>
                          <MenuV2.Content>
                            <MenuV2.Item onSelect={() => openOptions(row)}>
                              {language.t("vsworker.plugins.options.action")}
                            </MenuV2.Item>
                            <Show when={row.decidedIn === props.scope()}>
                              <MenuV2.Item
                                onSelect={() =>
                                  toggle.mutate({ id: row.id, enabled: row.state === "disabled-by-config" })
                                }
                              >
                                {language.t("vsworker.plugins.reset")}
                              </MenuV2.Item>
                            </Show>
                          </MenuV2.Content>
                        </MenuV2.Portal>
                      </MenuV2>
                    </>
                  }
                />
              )}
            </For>
          </Show>
        </Section>

        <Section
          title={language.t("vsworker.section.yours.plugins")}
          actions={
            <ButtonV2
              variant="neutral"
              icon="plus"
              data-action="vsworker-plugin-add"
              onClick={() => void dialog.push(() => <DialogPluginAdd onSubmit={(spec) => add.mutateAsync(spec)} />)}
            >
              {language.t("vsworker.plugins.add")}
            </ButtonV2>
          }
        >
          <Show when={user().length > 0} fallback={<Empty>{language.t("vsworker.plugins.yours.empty")}</Empty>}>
            <For each={user()}>
              {(row) => (
                <Row
                  action={`vsworker-plugin-user-${row.name}`}
                  title={
                    <>
                      <span class="vsworker-row-name">{row.name}</span>
                      <Tag>{language.t(`vsworker.plugins.kind.${row.kind}`)}</Tag>
                      <Tag>{language.t(`vsworker.origin.${row.origin}`)}</Tag>
                    </>
                  }
                  description={row.origin === "discovered" ? language.t("vsworker.plugins.discoveredHint") : undefined}
                  meta={row.file}
                  actions={
                    <>
                      <Show when={files.canReveal(row.file)}>
                        <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void files.reveal(row.file)}>
                          {language.t("vsworker.file.reveal")}
                        </ButtonV2>
                      </Show>
                      <Show when={row.removable}>
                        <ButtonV2
                          variant="ghost-muted"
                          size="normal"
                          disabled={remove.isPending}
                          data-action={`vsworker-plugin-remove-${row.name}`}
                          onClick={() =>
                            void dialog.push(() => (
                              <DialogConfirm
                                message={language.t("vsworker.plugins.remove.confirm", { name: row.name })}
                                confirmLabel={language.t("common.delete")}
                                onConfirm={() => remove.mutateAsync(row)}
                              />
                            ))
                          }
                        >
                          {language.t("common.delete")}
                        </ButtonV2>
                      </Show>
                    </>
                  }
                />
              )}
            </For>
          </Show>
        </Section>
      </div>
    </>
  )
}
