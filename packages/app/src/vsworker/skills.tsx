// vsworker-seam: the Skills tab.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Scope, SkillContent, SkillEnv, UserSkill, VsWorker } from "./api"
import {
  discoveredSkillRows,
  filterSkills,
  isOn,
  stateLabel,
  stateTone,
  toggleDisabled,
  userSkillRows,
  type EnvValues,
} from "./controllers"
import { DialogConfirm } from "./dialog-confirm"
import { DialogSkill } from "./dialog-skill"
import { DialogSkillEnv } from "./dialog-skill-env"
import { DialogSkillSources } from "./dialog-skill-sources"
import { useFileActions } from "./file-actions"
import { Empty, Pill, Row, Section, TabHeader } from "./parts"
import "./vsworker.css"

export const VsWorkerSkills: Component<{
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

  const data = () => props.vsworker.skills.data
  const revision = () => {
    const revisions = data()?.revisions
    return props.scope() === "project" ? revisions?.project : revisions?.global
  }

  const toggle = props.vsworker.mutation((input: { name: string; enabled: boolean }) =>
    props.vsworker
      .api()
      .skill.toggle({ name: input.name, scope: props.scope(), enabled: input.enabled, expectedRevision: revision() }),
  )

  const write = props.vsworker.mutation((input: { name: string; description: string; content: string }) =>
    props.vsworker.api().skill.write({ scope: props.scope(), ...input }),
  )

  const remove = props.vsworker.mutation((row: UserSkill) =>
    props.vsworker.api().skill.remove({ name: row.name, scope: row.scope ?? props.scope() }),
  )

  const sources = props.vsworker.mutation((input: { paths: string[]; urls: string[] }) =>
    props.vsworker.api().skill.sources({ scope: props.scope(), ...input, expectedRevision: revision() }),
  )

  const envWrite = props.vsworker.mutation((input: { name: string; env: EnvValues }) =>
    props.vsworker
      .api()
      .skill.envWrite({ name: input.name, scope: props.scope(), env: input.env, expectedRevision: revision() }),
  )

  const bundled = createMemo(() => filterSkills(data()?.bundled ?? [], props.query()))
  const user = createMemo(() => userSkillRows(data()?.user ?? [], props.query()))
  const discovered = createMemo(() => discoveredSkillRows(data()?.user ?? [], props.query()))

  // Fetched when the dialog opens rather than carried on every row: the values are the point of the dialog, and
  // the list is read far more often than it is edited.
  const openEnv = async (name: string) => {
    const result = await props.vsworker.api().skill.env({ name })
    const env = result.data as SkillEnv
    void dialog.push(() => (
      <DialogSkillEnv
        scope={props.scope()}
        env={env}
        onSubmit={(values) => envWrite.mutateAsync({ name, env: values })}
      />
    ))
  }

  const open = async (name: string, mode: "edit" | "view") => {
    const result = await props.vsworker.api().skill.content({ name })
    const content = result.data as SkillContent
    void dialog.push(() => (
      <DialogSkill
        mode={content.editable && mode === "edit" ? "edit" : "view"}
        location={content.location}
        initial={{ name: content.name, description: content.description ?? "", content: content.content }}
        onSubmit={(form) => write.mutateAsync(form)}
      />
    ))
  }

  return (
    <>
      <TabHeader
        kind="skills"
        title={language.t("vsworker.tab.skills")}
        scope={props.scope()}
        onScope={props.setScope}
        hasProject={props.hasProject()}
        query={props.query()}
        onQuery={props.setQuery}
        searchLabel={language.t("vsworker.search.skills")}
      />

      <div class="settings-v2-tab-body">
        <Section title={language.t("vsworker.section.bundled")}>
          <Show when={bundled().length > 0} fallback={<Empty>{language.t("vsworker.skills.empty")}</Empty>}>
            <For each={bundled()}>
              {(row) => (
                <Row
                  action={`vsworker-skill-bundled-${row.id}`}
                  title={<span class="vsworker-row-name">{row.id}</span>}
                  description={row.description}
                  actions={
                    <>
                      <Pill tone={stateTone(row.state)}>{stateLabel(language.t, row.state, "skill")}</Pill>
                      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void open(row.id, "view")}>
                        {language.t("vsworker.action.view")}
                      </ButtonV2>
                      {/* A killed or shadowed skill is not the one whose environment would be read. */}
                      <Show when={!toggleDisabled(row.state)}>
                        <ButtonV2
                          variant="ghost-muted"
                          size="normal"
                          data-action={`vsworker-skill-env-${row.id}`}
                          onClick={() => void openEnv(row.id)}
                        >
                          {language.t("vsworker.skills.env.action")}
                        </ButtonV2>
                      </Show>
                      <Switch
                        hideLabel
                        label={row.id}
                        checked={isOn(row.state)}
                        disabled={toggleDisabled(row.state) || toggle.isPending}
                        onChange={(checked) => toggle.mutate({ name: row.id, enabled: checked })}
                      />
                    </>
                  }
                />
              )}
            </For>
          </Show>
        </Section>

        <Section
          title={language.t("vsworker.section.yours.skills")}
          actions={
            <ButtonV2
              variant="neutral"
              icon="plus"
              data-action="vsworker-skill-new"
              onClick={() =>
                void dialog.push(() => <DialogSkill mode="create" onSubmit={(form) => write.mutateAsync(form)} />)
              }
            >
              {language.t("vsworker.skills.new")}
            </ButtonV2>
          }
        >
          <Show when={user().length > 0} fallback={<Empty>{language.t("vsworker.skills.yours.empty")}</Empty>}>
            <For each={user()}>
              {(row) => (
                <Row
                  action={`vsworker-skill-user-${row.name}`}
                  title={
                    <>
                      <span class="vsworker-row-name">{row.name}</span>
                      <Show when={row.scope}>{(scope) => <Tag>{language.t(`vsworker.origin.${scope()}`)}</Tag>}</Show>
                    </>
                  }
                  description={row.description}
                  meta={row.location}
                  actions={
                    <>
                      <Show when={files.canReveal(row.location)}>
                        <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void files.reveal(row.location)}>
                          {language.t("vsworker.file.reveal")}
                        </ButtonV2>
                      </Show>
                      <ButtonV2
                        variant="ghost-muted"
                        size="normal"
                        data-action={`vsworker-skill-edit-${row.name}`}
                        onClick={() => void open(row.name, "edit")}
                      >
                        {language.t("common.edit")}
                      </ButtonV2>
                      <ButtonV2
                        variant="ghost-muted"
                        size="normal"
                        disabled={remove.isPending}
                        data-action={`vsworker-skill-remove-${row.name}`}
                        onClick={() =>
                          void dialog.push(() => (
                            <DialogConfirm
                              message={language.t("vsworker.skills.remove.confirm", { name: row.name })}
                              confirmLabel={language.t("common.delete")}
                              onConfirm={() => remove.mutateAsync(row)}
                            />
                          ))
                        }
                      >
                        {language.t("common.delete")}
                      </ButtonV2>
                    </>
                  }
                />
              )}
            </For>
          </Show>
        </Section>

        <Section
          title={language.t("vsworker.section.discovered")}
          actions={
            <ButtonV2
              variant="neutral"
              data-action="vsworker-skill-sources"
              onClick={() =>
                void dialog.push(() => (
                  <DialogSkillSources
                    paths={data()?.sources.paths ?? []}
                    urls={data()?.sources.urls ?? []}
                    onSubmit={(input) => sources.mutateAsync(input)}
                  />
                ))
              }
            >
              {language.t("vsworker.skills.sources.manage")}
            </ButtonV2>
          }
        >
          <Show
            when={discovered().length > 0}
            fallback={<Empty>{language.t("vsworker.skills.discovered.empty")}</Empty>}
          >
            <For each={discovered()}>
              {(row) => (
                <Row
                  action={`vsworker-skill-discovered-${row.name}`}
                  title={
                    <>
                      <span class="vsworker-row-name">{row.name}</span>
                      <Tag>{language.t(`vsworker.origin.${row.origin}`)}</Tag>
                    </>
                  }
                  description={row.description ?? language.t("vsworker.skills.readOnly")}
                  meta={row.location}
                  actions={
                    <>
                      <Show when={files.canReveal(row.location)}>
                        <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void files.reveal(row.location)}>
                          {language.t("vsworker.file.reveal")}
                        </ButtonV2>
                      </Show>
                      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void open(row.name, "view")}>
                        {language.t("vsworker.action.view")}
                      </ButtonV2>
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
