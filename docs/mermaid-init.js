/**
 * Renders the ```mermaid blocks in the generated doc pages.
 *
 * Loaded only by pages that contain a diagram (scripts/build-docs.js decides), from
 * the copy vendored at docs/vendor/mermaid.min.js — there is no CDN and no npm
 * dependency, the same arrangement as viewer/vendor/.
 *
 * The theme is wired to the same palette as docs.css, so a diagram is part of the page
 * rather than a picture pasted into it. Keep the two in step by hand: Mermaid cannot
 * read CSS custom properties.
 */
const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const SURFACE = '#fcfcfb';
const RULE = '#e1e0d9';
const CODE_BG = '#f1f0ea';
const CODE_RULE = '#d8d6ca';
const ACCENT = '#2a78d6';

/** Show the source again: better a visible block of syntax than an empty gap. */
function reveal() {
  for (const el of document.querySelectorAll('.mermaid')) el.classList.add('mermaid-failed');
}

function start() {
  if (!globalThis.mermaid) { reveal(); return; }
  globalThis.mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    fontFamily: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    flowchart: { curve: 'basis', nodeSpacing: 40, rankSpacing: 48, useMaxWidth: true, padding: 10 },
    sequence: { useMaxWidth: true, actorMargin: 60, mirrorActors: false, messageAlign: 'left' },
    themeVariables: {
      background: SURFACE,
      primaryColor: CODE_BG,
      primaryTextColor: INK,
      primaryBorderColor: CODE_RULE,
      secondaryColor: SURFACE,
      tertiaryColor: SURFACE,
      tertiaryBorderColor: RULE,
      lineColor: MUTED,
      textColor: INK_2,
      fontSize: '14px',
      clusterBkg: SURFACE,
      clusterBorder: RULE,
      edgeLabelBackground: SURFACE,
      // sequence diagrams
      actorBkg: CODE_BG,
      actorBorder: CODE_RULE,
      actorTextColor: INK,
      actorLineColor: MUTED,
      signalColor: INK_2,
      signalTextColor: INK_2,
      labelBoxBkgColor: CODE_BG,
      labelBoxBorderColor: CODE_RULE,
      labelTextColor: INK,
      noteBkgColor: SURFACE,
      noteBorderColor: ACCENT,
      noteTextColor: INK_2,
    },
  });
  globalThis.mermaid.run({ querySelector: '.mermaid' }).catch((e) => {
    // A diagram that will not parse must not take the page with it: leave the source
    // visible so the error is obvious to whoever just edited the Markdown.
    console.error('Mermaid failed to render', e);
    reveal();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
