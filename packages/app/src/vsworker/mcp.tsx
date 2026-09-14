// vsworker-seam: the MCP servers tab.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import type { BundledMcp, McpConfig, Scope, UserMcp, VsWorker } from "./api"
import {
  filterMcp,
  isOn,
  stateLabel,
  stateTone,
  statusLabel,
  statusTone,
  toggleDisabled,
  userMcpRows,
} from "./controllers"
import { DialogConfirm } from "./dialog-confirm"
import { DialogMcpServer } from "./dialog-mcp-server"
import { Empty, Pill, Row, Section, StatusDot, TabHeader } from "./parts"
import "./vsworker.css"

export const VsWorkerMcp: Component<{
  vsworker: VsWorker
  directory: Accessor<string | undefined>
  scope: Accessor<Scope>
  setScope: (scope: Scope) => void
  hasProject: Accessor<boolean>
  query: Accessor<string>
  setQuery: (value: string) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()

  const data = () => props.vsworker.mcp.data
  const revisionFor = (scope: Scope) => {
    const revisions = data()?.revisions
    return scope === "project" ? revisions?.project : revisions?.global
  }
  const revision = () => revisionFor(props.scope())

  const toggle = props.vsworker.mutation((input: { name: string; enabled: boolean; scope?: Scope }) => {
    const scope = input.scope ?? props.scope()
    return props.vsworker
      .api()
      .mcp.toggle({ name: input.name, scope, enabled: input.enabled, expectedRevision: revisionFor(scope) })
  })

  const upsert = props.vsworker.mutation((input: { name: string; config: McpConfig; scope?: Scope }) => {
    const scope = input.scope ?? props.scope()
    return props.vsworker
      .api()
      .mcp.upsert({ name: input.name, scope, config: input.config, expectedRevision: revisionFor(scope) })
  })

  const remove = props.vsworker.mutation((row: UserMcp) => {
    const scope = row.scope ?? props.scope()
    return props.vsworker.api().mcp.remove({ name: row.name, scope, expectedRevision: revisionFor(scope) })
  })

  // OAuth stays on the stock MCP routes; this tab only points at them.
  const authenticate = props.vsworker.mutation(async (name: string) => {
    await serverSDK().client.mcp.auth.authenticate({ name })
  })

  const bundled = createMemo<BundledMcp[]>(() => filterMcp(data()?.bundled ?? [], props.query()))
  const user = createMemo(() => userMcpRows(data()?.user ?? [], props.query()))
  const taken = createMemo(() => [
    ...(data()?.user ?? []).map((row) => row.name),
    ...(data()?.bundled ?? []).map((row) => row.id),
  ])

  const needsAuth = (status: { status: string } | undefined) =>
    status?.status === "needs_auth" || status?.status === "needs_client_registration"

  const openEditor = (input: { mode: "add" | "edit"; name?: string; config?: McpConfig; scope?: Scope }) => {
    void dialog.push(() => (
      <DialogMcpServer
        mode={input.mode}
        scope={input.scope ?? props.scope()}
        name={input.name}
        config={input.config}
        taken={input.mode === "add" ? taken() : taken().filter((item) => item !== input.name)}
        onSubmit={(value) => upsert.mutateAsync({ ...value, scope: input.scope })}
      />
    ))
  }

  return (
    <>
      <TabHeader
        kind="mcp"
        title={language.t("vsworker.tab.mcp")}
        scope={props.scope()}
        onScope={props.setScope}
        hasProject={props.hasProject()}
        query={props.query()}
        onQuery={props.setQuery}
        searchLabel={language.t("vsworker.search.mcp")}
      />

      <div class="settings-v2-tab-body">
        <Section title={language.t("vsworker.section.bundled")}>
          <Show when={bundled().length > 0} fallback={<Empty>{language.t("vsworker.mcp.empty")}</Empty>}>
            <For each={bundled()}>
              {(row) => (
                <Row
                  action={`vsworker-mcp-bundled-${row.id}`}
                  title={
                    <>
                      <StatusDot tone={statusTone(row.status)} label={statusLabel(language.t, row.status)} />
                      <span class="vsworker-row-name">{row.id}</span>
                      <Tag>{language.t(`vsworker.mcp.type.${row.type}`)}</Tag>
                    </>
                  }
                  description={row.description}
                  meta={row.target}
                  actions={
                    <>
                      <Pill tone={stateTone(row.state)}>{stateLabel(language.t, row.state, "mcp")}</Pill>
                      <Switch
                        hideLabel
                        label={row.id}
                        checked={isOn(row.state)}
                        disabled={toggleDisabled(row.state) || toggle.isPending}
                        onChange={(checked) => toggle.mutate({ name: row.id, enabled: checked })}
                      />
                      <MenuV2 gutter={4} modal={false} placement="bottom-end">
                        <MenuV2.Trigger as={ButtonV2} variant="ghost-muted" size="normal">
                          {language.t("common.edit")}
                        </MenuV2.Trigger>
                        <MenuV2.Portal>
                          <MenuV2.Content>
                            <MenuV2.Item onSelect={() => openEditor({ mode: "add", name: row.id, config: row.config })}>
                              {language.t("vsworker.mcp.customize")}
                            </MenuV2.Item>
                            <Show when={needsAuth(row.status)}>
                              <MenuV2.Item onSelect={() => authenticate.mutate(row.id)}>
                                {language.t("vsworker.mcp.authenticate")}
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
          title={language.t("vsworker.section.yours.mcp")}
          actions={
            <ButtonV2
              variant="neutral"
              icon="plus"
              data-action="vsworker-mcp-add"
              onClick={() => openEditor({ mode: "add" })}
            >
              {language.t("vsworker.mcp.add")}
            </ButtonV2>
          }
        >
          <Show when={user().length > 0} fallback={<Empty>{language.t("vsworker.mcp.yours.empty")}</Empty>}>
            <For each={user()}>
              {(row) => (
                <Row
                  action={`vsworker-mcp-user-${row.name}`}
                  title={
                    <>
                      <StatusDot tone={statusTone(row.status)} label={statusLabel(language.t, row.status)} />
                      <span class="vsworker-row-name">{row.name}</span>
                      <Tag>{language.t(`vsworker.mcp.type.${row.type}`)}</Tag>
                      <Show when={row.scope}>{(scope) => <Tag>{language.t(`vsworker.origin.${scope()}`)}</Tag>}</Show>
                    </>
                  }
                  description={statusLabel(language.t, row.status)}
                  meta={row.target}
                  actions={
                    <>
                      <Switch
                        hideLabel
                        label={row.name}
                        checked={row.enabled}
                        disabled={!row.editable || toggle.isPending}
                        onChange={(checked) => toggle.mutate({ name: row.name, enabled: checked, scope: row.scope })}
                      />
                      <Show
                        when={row.editable}
                        fallback={
                          <span class="vsworker-scope-hint">{row.file || language.t("vsworker.origin.other")}</span>
                        }
                      >
                        <ButtonV2
                          variant="ghost-muted"
                          size="normal"
                          data-action={`vsworker-mcp-edit-${row.name}`}
                          onClick={() =>
                            openEditor({ mode: "edit", name: row.name, config: row.config, scope: row.scope })
                          }
                        >
                          {language.t("common.edit")}
                        </ButtonV2>
                        <MenuV2 gutter={4} modal={false} placement="bottom-end">
                          <MenuV2.Trigger as={ButtonV2} variant="ghost-muted" size="normal">
                            {language.t("vsworker.action.remove")}
                          </MenuV2.Trigger>
                          <MenuV2.Portal>
                            <MenuV2.Content>
                              <Show when={needsAuth(row.status)}>
                                <MenuV2.Item onSelect={() => authenticate.mutate(row.name)}>
                                  {language.t("vsworker.mcp.authenticate")}
                                </MenuV2.Item>
                              </Show>
                              <MenuV2.Item
                                onSelect={() =>
                                  void dialog.push(() => (
                                    <DialogConfirm
                                      message={language.t("vsworker.mcp.remove.confirm", { name: row.name })}
                                      confirmLabel={language.t("common.delete")}
                                      onConfirm={() => remove.mutateAsync(row)}
                                    />
                                  ))
                                }
                              >
                                {language.t("vsworker.action.remove")}
                              </MenuV2.Item>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
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
