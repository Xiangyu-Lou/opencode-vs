// Terminal wordmark, derived from reference/VsWork-text.png at half-block resolution.
// `left` ("vs") renders muted and `right` ("Worker") bold, matching how the wordmark is drawn.
// Shadow encoding: "_" filled shadow cell, "^" half block over shadow, "~" shadow top, "," shadow bottom.
export const logo = {
  left: ["██    ██       ", "██    ██ ██████", " ██  ██  ██▄▄▄▄", " ▀█▄▄█▀  ▀▀▀▀██", "  ████   ██████"],
  right: [
    "██    ██                 ██                   ",
    "██    ██ ███████ ███████ ██   ██ ██████ ██████",
    "██ ██ ██ ██___██ ██      ██▄▄██  ██▄▄██ ██    ",
    "██▄██▄██ ██___██ ██      ██▀▀█▄  ██▀▀▀▀ ██    ",
    "███▀▀███ ███████ ██      ██  ▀██ ██████ ██    ",
  ],
}

// Compact "v" badge for places a full wordmark does not fit, such as the mini-mode splash.
export const mark = ["██  ██", "▀█▄▄█▀", " ████ "]

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
