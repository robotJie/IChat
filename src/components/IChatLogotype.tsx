interface IChatLogotypeProps {
  className?: string
  title?: string
  variant?: "wordmark" | "lockup-horizontal" | "lockup-compact" | "wordmark-small"
}

function WordmarkPaths({ small = false }: { small?: boolean }) {
  if (small) {
    return (
      <g fill="none" stroke="currentColor" strokeWidth="11.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 18H29" />
        <path d="M19.5 18V72" />
        <path d="M10 72H29" />
        <path d="M80 26A22 22 0 1 0 80 64" />
        <path d="M99 18V72" />
        <path d="M99 49Q99 36 114 36Q129 36 129 51V72" />
        <path d="M155 42A17 17 0 1 1 155 76A17 17 0 1 1 155 42" />
        <path d="M172 42V72" />
        <path d="M204 20V72" />
        <path d="M192 35H216" />
      </g>
    )
  }

  return (
    <g stroke="currentColor" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round">

    <g transform="translate(24 48) scale(0.85) translate(-22 -48)">
      <path d="M10 17H34" />
      <path d="M22 17V79" />
      <path d="M10 79H34" />
    </g>


    <g transform="translate(68 43.5) scale(0.9) translate(-70 -43.5)">
      <path d="M87 29A21 21 0 1 0 87 67" />
      <path d="M52 25H66" />
      <path d="M59 18V32" />
    </g>

    <path d="M104 22V68" />
    <path d="M104 52Q104 38 119 38Q134 38 134 54V68" />


    <path d="M168 42A13 13 0 1 1 168 68A13 13 0 1 1 168 42" />
    <path d="M181 42V68" />

    <path d="M216 24V59Q216 68 224 68Q229 68 233 64" />
    <path d="M202 38H231" />
  </g>
  )
}

function SymbolPaths() {
  return (
    <g
      fill="none"
      stroke="var(--ichat-brand-symbol, var(--ichat-accent-strong, currentColor))"
      strokeWidth="12"
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d="M76 18A28 28 0 1 0 76 78" />
      <path d="M48 24H64" />
      <path d="M56 24V72" />
      <path d="M48 72H64" />
    </g>
  )
}

export function IChatLogotype({ className, title = "IChat", variant = "wordmark" }: IChatLogotypeProps) {
  if (variant === "wordmark") {
    return (
      <svg aria-label={title} className={className} role="img" viewBox="0 0 280 96">
        <title>{title}</title>
        <WordmarkPaths />
      </svg>
    )
  }

  if (variant === "wordmark-small") {
    return (
      <svg aria-label={title} className={className} role="img" viewBox="0 0 228 86">
        <title>{title}</title>
        <WordmarkPaths small />
      </svg>
    )
  }

  if (variant === "lockup-compact") {
    return (
      <svg aria-label={title} className={className} role="img" viewBox="0 0 196 176">
        <title>{title}</title>
        <g transform="translate(42 10)">
          <SymbolPaths />
        </g>
        <g transform="translate(18 86) scale(0.56)">
          <WordmarkPaths />
        </g>
      </svg>
    )
  }

  return (
    <svg aria-label={title} className={className} role="img" viewBox="0 0 396 96">
      <title>{title}</title>
      <SymbolPaths />
      <g transform="translate(96 0)">
        <WordmarkPaths />
      </g>
    </svg>
  )
}
