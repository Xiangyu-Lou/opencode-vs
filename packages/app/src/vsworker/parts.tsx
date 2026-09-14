// vsworker-seam: small presentational pieces shared by the three Extensions tabs.
import { Show, type Component, type JSX } from "solid-js"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import type { Scope } from "./api"
import "./vsworker.css"

export const Row: Component<{
  title: JSX.Element
  description?: JSX.Element
  meta?: JSX.Element
  actions?: JSX.Element
  action?: string
}> = (props) => (
  <div class="vsworker-row" data-action={props.action}>
    <div class="vsworker-row-copy">
      <div class="vsworker-row-title">{props.title}</div>
      <Show when={props.description}>
        <div class="vsworker-row-description">{props.description}</div>
      </Show>
      <Show when={props.meta}>
        <div class="vsworker-row-meta">{props.meta}</div>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class="vsworker-row-actions">{props.actions}</div>
    </Show>
  </div>
)

export const Pill: Component<{ tone?: "on" | "off" | "warn"; children: JSX.Element }> = (props) => (
  <span class="vsworker-pill" data-tone={props.tone ?? "off"}>
    {props.children}
  </span>
)

export const StatusDot: Component<{ tone: "ok" | "error" | "warn" | "idle"; label?: string }> = (props) => (
  <span class="vsworker-dot" data-tone={props.tone} role="img" aria-label={props.label} />
)

export const Empty: Component<{ children: JSX.Element }> = (props) => <div class="vsworker-empty">{props.children}</div>

export const Section: Component<{ title: string; children: JSX.Element; actions?: JSX.Element }> = (props) => (
  <div class="settings-v2-section">
    <h3 class="settings-v2-section-title">{props.title}</h3>
    <div data-component="settings-v2-list">{props.children}</div>
    <Show when={props.actions}>
      <div class="vsworker-section-actions">{props.actions}</div>
    </Show>
  </div>
)

export const Field: Component<{
  label: string
  hint?: string
  error?: string
  children: JSX.Element
}> = (props) => (
  <div class="vsworker-field">
    <label class="vsworker-field-label">{props.label}</label>
    {props.children}
    <Show
      when={props.error}
      fallback={<Show when={props.hint}>{(hint) => <span class="vsworker-field-hint">{hint()}</span>}</Show>}
    >
      {(error) => <span class="vsworker-field-error">{error()}</span>}
    </Show>
  </div>
)

// The header every tab shares: title, the scope the tab writes to, and a search box.
export const TabHeader: Component<{
  title: string
  scope: Scope
  onScope: (scope: Scope) => void
  hasProject: boolean
  query: string
  onQuery: (value: string) => void
  searchLabel: string
  kind: string
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
      <h2 class="settings-v2-tab-title">{props.title}</h2>
      <div class="vsworker-scope">
        <SegmentedControlV2
          value={props.scope}
          onChange={(value) => {
            if (value === "global" || value === "project") props.onScope(value)
          }}
          aria-label={language.t("vsworker.scope.label")}
          data-action={`vsworker-scope-${props.kind}`}
        >
          <SegmentedControlItemV2 value="global">{language.t("vsworker.scope.global")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="project" disabled={!props.hasProject}>
            {language.t("vsworker.scope.project")}
          </SegmentedControlItemV2>
        </SegmentedControlV2>
        <Show when={!props.hasProject}>
          <span class="vsworker-scope-hint">{language.t("vsworker.scope.noProject")}</span>
        </Show>
      </div>
      <div class="settings-v2-tab-search">
        <TextInputV2
          type="search"
          appearance="base"
          value={props.query}
          onInput={(event) => props.onQuery(event.currentTarget.value)}
          placeholder={props.searchLabel}
          aria-label={props.searchLabel}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          data-action={`vsworker-search-${props.kind}`}
        />
      </div>
    </div>
  )
}
