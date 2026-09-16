// VsWorker ships the plan/build agent picker on. Upstream ships it off and then latches that answer into every
// profile the first time the app runs, so flipping the default literal alone is overwritten on a fresh install.
// Seeding `agentVisibilityInitialized` is what makes the default stick: `initialAgentVisibility` returns
// undefined for an already-classified profile, so the one-time initializer -- the web effect in
// context/settings.tsx and packages/desktop/src/renderer/onboarding.tsx -- never reaches its "brand new
// install, hide it" branch.
//
// Both keys have to stay together, and this has to stay spread into `defaultSettings.general`: losing the
// spread drops the required Settings["general"]["showCustomAgents"], which is a typecheck failure rather than
// a silent revert.
export function agentVisibilityDefaults() {
  return { showCustomAgents: true, agentVisibilityInitialized: true }
}
