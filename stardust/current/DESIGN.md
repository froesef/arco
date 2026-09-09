---
name: Arco
description: Precision espresso equipment for the home barista — warm editorial layout, matte-black hardware with copper accents
colors:
  background: "#F5F0E8"
  surface: "#FFFFFF"
  dark: "#5C6B73"
  text: "#1C2B35"
  primary: "#B5651D"
  primary-hover: "#8E4E14"
  secondary: "#D4883A"
  border: "#D4CFC5"
  muted: "#5C6B73"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "46px"
    fontWeight: 600
    lineHeight: 1.15
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "37px"
    fontWeight: 600
    lineHeight: 1.15
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  sm: "12px"
  md: "12px"
spacing:
  nav-height: "80px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sm}"
---

## Overview

Arco sells precision espresso machines and grinders to home baristas who care
about craft and detail. The current site reads as a warm, editorial product
catalog: full-bleed photography of matte-black hardware with copper/brass
accents, set against a cream page background, with confident sans headings
and copper-colored CTAs. The register is unmistakably **brand** (marketing +
storytelling), not a bare product/dashboard tool — pages mix hero storytelling
copy, "Latest Stories" editorial content, and customer testimonials alongside
product cards.

## Colors

- Background `#F5F0E8` (warm cream) is the dominant page surface across every
  sampled page (home, product listing, story article).
- Text `#1C2B35` (near-navy charcoal) carries all headings and body copy —
  never pure black.
- Primary/link/CTA color `#B5651D` (burnt copper) marks every interactive
  element: nav CTAs, "View Product" links, category filter pills (active
  state), buttons. Hover state darkens to `#8E4E14`.
- Secondary accent `#D4883A` (lighter copper/amber) appears in the design
  tokens as a secondary accent, complementing the primary copper without
  being separately observed as a distinct UI role in the 3 sampled pages.
- Surface `#FFFFFF` is used for card backgrounds (product cards, story cards)
  sitting on top of the cream page background — a two-layer surface system.
- Border `#D4CFC5` (muted warm gray) and muted text `#5C6B73` handle
  dividers, filter-pill outlines, and secondary copy.

_Source: `--background-color`, `--text-color`, `--link-color`,
`--link-hover-color`, `--accent-secondary`, `--border-color`, `--muted-color`
custom properties, confirmed live via computed-style sampling on `/`,
`/products/espresso-machines`, `/stories/from-bean-to-cup`._

## Typography

Single font family throughout: **Inter** (sans-serif), no serif or
display-face pairing. Headings are set at weight 600, body copy at weight
400 — no italic or light weights observed. Heading line-height is tight
(1.15) for confident, editorial headlines; body line-height is generous
(1.75) for long-form story reading. Desktop H1 renders at 46px in the
`:root` scale (project also defines a narrower ≥900px breakpoint scale, not
resampled live from a mobile viewport in this pass).

## Layout

Warm editorial layout: hero sections with a full-bleed product photo and a
large left/centered headline; below-the-fold content in card grids (3-up
"Featured Products" grid; product category grid with 3 columns on desktop);
story pages read as a single centered content column with a wide hero image,
byline metadata, and a related-products card row at the end.

## Shapes

`--border-radius` / `--card-radius` both compute to a consistent **12px**,
applied to product/story cards and buttons/pills alike — a soft, rounded
form language with no sharp corners observed anywhere in the sampled pages.

## Do's and Don'ts

- Do keep the cream/copper/navy palette — no pure black or pure white text.
- Do use full-bleed, natural-light product photography (matte black
  hardware + copper accents on warm wood/stone countertops) as the primary
  visual motif; the imagery, not illustration or iconography, carries the
  brand.
- Do use the single Inter family for both headings and body; don't
  introduce a second display face.
- Don't sharpen the 12px card/button radius — it's consistent across every
  sampled surface.
