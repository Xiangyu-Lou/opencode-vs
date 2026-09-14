import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "vsworker") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
  // This fork's own identity. It has to differ from every upstream id, because an OpenCode.app installed on the
  // same machine would otherwise share the app id, the Electron user data directory, and the Dock entry.
  vsworker: "com.vsworker.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "vsworker-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  extraMetadata: {
    // CI runs scripts/prepare.ts to stamp package.json before packaging. A local VsWorker build sets
    // OPENCODE_VERSION instead, so the app reports the same version as the server bundled inside it without
    // the packaging step rewriting a tracked file.
    ...(process.env.OPENCODE_VERSION ? { version: process.env.OPENCODE_VERSION } : {}),
    // Linux launchers are .desktop files, so this is the desktop file name,
    // not just the app id. For prod, app id "ai.opencode.desktop" becomes
    // "ai.opencode.desktop.desktop".
    // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
    // https://www.electron.build/docs/linux/
    desktopName: `${appId}.desktop`,
    // A one-click, per-user NSIS installer names its install directory after the package
    // name rather than the product name, so the workspace name "@opencode-ai/desktop" would
    // put the app in %LOCALAPPDATA%\Programs\@opencode-aidesktop (and the updater cache in
    // @opencode-aidesktop-updater). Override it here instead of renaming the workspace.
    name: "vsworker-desktop",
    // Fills the NSIS installer description and the deb/rpm package description, both empty
    // otherwise: packages/desktop/package.json carries no description.
    description: "AI coding agent",
    // Shown as the "Help link" of the Add/Remove Programs entry on Windows.
    homepage: "https://github.com/Xiangyu-Lou/opencode-vs",
  },
  files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "VsWorker",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "VsWorker Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "VsWorker Beta",
        protocols: { name: "VsWorker Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "VsWorker",
        protocols: { name: "VsWorker", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
    case "vsworker": {
      // No `publish`: VsWorker releases are distributed by hand, and the updater is off for this channel.
      return {
        ...base,
        appId,
        productName: "VsWorker",
        mac: {
          ...base.mac,
          // Apple Silicon refuses to launch a bundle with no code signature, and this fork has no Developer ID.
          // "-" is the ad-hoc identity: it satisfies the loader without asserting an origin, which is what an
          // internally distributed build needs. electron-builder's own ad-hoc fallback does not fire when the
          // keychain holds any self-signed certificate, so it is requested explicitly. Set CSC_NAME to a real
          // "Developer ID Application" identity to sign properly, and add APPLE_API_KEY / APPLE_API_KEY_ID /
          // APPLE_API_ISSUER to notarize as CI does.
          identity: process.env.CSC_NAME ?? "-",
          notarize: Boolean(process.env.CSC_NAME),
        },
        dmg: { sign: Boolean(process.env.CSC_NAME) },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "vsworker", fpm: [metainfoFpm(appId)] },
      }
    }
  }
}

export default getConfig()
