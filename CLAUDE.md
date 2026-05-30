# MedAdvocate Landing Page

Single-page marketing site for MedAdvocate. Deployed via GitHub Pages with a custom domain (the `CNAME` file must not be deleted).

## Stack

Vanilla HTML/CSS/JS only — no frameworks, no build step. Everything lives in `index.html` with inline `<style>` and `<script>` blocks.

## Structure (index.html)

| Line range | Section | Notes |
|---|---|---|
| 1–31 | `<head>` meta / OG / fonts | Google Fonts: Source Sans 3 + Source Serif 4 |
| 32–1236 | `<style>` | All CSS, inline |
| 1239–1318 | Header / Nav | Sticky, blur backdrop, hamburger drawer on mobile |
| 1322–1418 | Hero | Serif h1 with yellow-underline `<em>`, App Store + Google Play badges, phone mockup |
| 1421–1485 | Problem / Stats | Navy background, 4 animated counters |
| 1488–1640 | How It Works | 3-tab interface, each with phone screenshot |
| 1643–1793 | Errors / Interactive Bill | "Spot the errors" game, 5 clickable rows, progress bar |
| 1796–1869 | Contact + Footer | Contact info (Cloudflare-obfuscated emails), footer links |
| 1876–2059 | `<script>` | Scroll shadow, drawer toggle, IntersectionObserver reveals, counter animation, tab switching, bill error game |

## CSS variables (design tokens)

Defined in `:root` — always use these instead of raw hex values:

- `--bg` (`#f4efe5`) — page background
- `--bg-deep` (`#ebe3d2`) — darker background (errors section, decorative numbers)
- `--ink` (`#1b2c3d`) — primary text
- `--ink-soft` (`#4a5968`) — secondary/muted text
- `--navy` (`#153b62`) — primary brand color, CTAs, header
- `--yellow` (`#ffde39`) — accent, highlights, stat numbers
- `--blue` (`#268beb`) — focus rings on form inputs
- `--rule` (`rgba(27,44,61,0.14)`) — borders, dividers
- `--white` (`#ffffff`)
- `--font-sans` — Source Sans 3 stack
- `--font-serif` — Source Serif 4 stack
- `--max` (`1280px`) — container max-width
- `--gutter` (`clamp(20px,5vw,80px)`) — horizontal page padding

## Style conventions

- **Mobile-first responsive.** Base styles target small screens. Breakpoints at `768px` (tablet) and `1024px` (desktop).
- **Use existing CSS variables** for all colors, fonts, and spacing. Do not introduce new hex codes.
- **Preserve `prefers-reduced-motion` handling.** The page disables scroll animations and transitions when the user prefers reduced motion. Any new animations must respect this.
- **No frameworks.** No Tailwind, Bootstrap, React, etc. Keep everything vanilla.
- **Inline CSS/JS.** All styles and scripts live inside `index.html`. No external stylesheets or script files.
- **Accessibility.** Interactive elements need `min-height: 44px`, visible focus states (`:focus-visible`), proper ARIA attributes, and `.sr-only` labels where needed.

## Assets

- `assets/phone1.png`, `phone2.png`, `phone3.png` — app screenshots used in hero + "How it works" panels
- All images use `width`/`height` attributes for layout stability and `loading="lazy"` (except the hero image which is `eager`)

## Deployment

- GitHub Pages, served from the `main` branch
- **Do not delete the `CNAME` file** — it configures the custom domain
