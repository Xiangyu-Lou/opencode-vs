// vsworker-seam: the two fragments dialog-settings-v2.tsx mounts. Keeping the nav entries and the panels here
// means the upstream dialog only gains two lines, which is the whole point.
import { Icon } from "@opencode-ai/ui/icon"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { createMemo, createSignal, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useVsWorker, type Scope } from "./api"
import { VsWorkerMcp } from "./mcp"
import { VsWorkerPlugins } from "./plugins"
import { VsWorkerSkills } from "./skills"
import "./vsworker.css"

export const VSWORKER_TABS = ["vsworker-plugins", "vsworker-skills", "vsworker-mcp"] as const

export const VsWorkerSettingsNav: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-1.5">
      <TabsV2.SectionTitle>{language.t("vsworker.section.extensions")}</TabsV2.SectionTitle>
      <div class="flex flex-col gap-1.5 w-full">
        <TabsV2.Trigger value="vsworker-plugins" data-action="vsworker-tab-plugins">
          <Icon name="sliders" />
          {language.t("vsworker.tab.plugins")}
        </TabsV2.Trigger>
        <TabsV2.Trigger value="vsworker-skills" data-action="vsworker-tab-skills">
          <Icon name="brain" />
          {language.t("vsworker.tab.skills")}
        </TabsV2.Trigger>
        <TabsV2.Trigger value="vsworker-mcp" data-action="vsworker-tab-mcp">
          <Icon name="mcp" />
          {language.t("vsworker.tab.mcp")}
        </TabsV2.Trigger>
      </div>
    </div>
  )
}

export const VsWorkerSettingsPanels: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const vsworker = useVsWorker(props.directory)
  const hasProject = createMemo(() => Boolean(vsworker.plugins.data?.revisions.projectFile))
  // Scope is shared across the three tabs: it is one decision about where this session's edits land.
  const [scope, setScope] = createSignal<Scope>("global")
  const [pluginQuery, setPluginQuery] = createSignal("")
  const [skillQuery, setSkillQuery] = createSignal("")
  const [mcpQuery, setMcpQuery] = createSignal("")

  const current = createMemo<Scope>(() => (scope() === "project" && !hasProject() ? "global" : scope()))

  return (
    <>
      <TabsV2.Content value="vsworker-plugins" class="settings-v2-panel">
        <VsWorkerPlugins
          vsworker={vsworker}
          scope={current}
          setScope={setScope}
          hasProject={hasProject}
          query={pluginQuery}
          setQuery={setPluginQuery}
        />
      </TabsV2.Content>
      <TabsV2.Content value="vsworker-skills" class="settings-v2-panel">
        <VsWorkerSkills
          vsworker={vsworker}
          scope={current}
          setScope={setScope}
          hasProject={hasProject}
          query={skillQuery}
          setQuery={setSkillQuery}
        />
      </TabsV2.Content>
      <TabsV2.Content value="vsworker-mcp" class="settings-v2-panel">
        <VsWorkerMcp
          vsworker={vsworker}
          directory={props.directory}
          scope={current}
          setScope={setScope}
          hasProject={hasProject}
          query={mcpQuery}
          setQuery={setMcpQuery}
        />
      </TabsV2.Content>
    </>
  )
}
