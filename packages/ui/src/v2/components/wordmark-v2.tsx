import { createUniqueId, type ComponentProps } from "solid-js"

// Traced by hand from reference/VsWork-text.png. `script/brand.ts` does not emit this file; update
// the path here when the reference art changes. Keep in sync with packages/ui/src/components/logo.tsx.

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 230 30"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <path
            data-slot="wordmark-v2"
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M0 0H7V13H0ZM21 0H28V13H21ZM60 0H67V30H60ZM82 0H89V30H82ZM153 0H160V30H153ZM32 7H55V13H32ZM93 7H120V13H93ZM124 7H148V13H124ZM170 7H178V13H170ZM182 7H205V13H182ZM209 7H230V13H209ZM7 12H10V30H7ZM18 12H21V30H18ZM71 12H78V26H71ZM165 12H170V26H165ZM3 13H7V21H3ZM21 13H25V21H21ZM32 13H39V21H32ZM93 13H100V30H93ZM113 13H120V30H113ZM124 13H131V30H124ZM170 13H174V17H170ZM182 13H189V30H182ZM198 13H205V21H198ZM209 13H216V30H209ZM160 15H165V22H160ZM39 16H55V21H39ZM189 16H198V21H189ZM67 20H71V30H67ZM78 20H82V30H78ZM170 20H174V30H170ZM6 21H7V30H6ZM10 21H18V30H10ZM21 21H22V30H21ZM48 21H55V30H48ZM32 24H48V30H32ZM100 24H113V30H100ZM174 24H178V30H174ZM189 24H205V30H189ZM71 26H72V30H71ZM76 26H78V30H76Z"
            fill="currentColor"
          />
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="230" height="30">
          <rect width="230" height="30" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="115" y1="0" x2="115" y2="30" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" />
          <stop offset="1" stop-color="white" stop-opacity="0.35" />
        </linearGradient>
      </defs>
    </svg>
  )
}
