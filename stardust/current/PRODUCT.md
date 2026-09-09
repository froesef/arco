# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Home baristas and enthusiasts shopping for espresso machines and grinders —
people who "care about every detail — from bean to cup" (site's own
description). The nav and homepage content ("Find Your Brew Style" quiz,
"Featured Products", buyer-facing specs like boiler count and burr size)
target a self-directed shopper doing research and comparison before a
purchase, not a trade/B2B buyer.

## Product Purpose

Arco sells precision-engineered espresso machines and grinders (Primo,
Doppio, Studio/Studio Pro, Nano, Ufficio, Automatico; Macinino/Macinino Pro
grinders) and educates buyers through editorial "Stories" content (coffee
processing, water chemistry, burr types) and guided "Experiences" (brew-style
quiz, upgrade path). Success reads as: a visitor understands the product
range, is guided to the right machine for their use case, and either
purchases or engages with a follow-on educational/quiz flow.

## Operating Context

Site includes a search/ask interface ("Ask about coffee equipment...") in
the header — an AI-assisted product-discovery affordance in addition to
standard nav-driven browsing. Product listing pages support filtering by
category tag (Single Boiler, Dual Boiler, Prosumer, Commercial, Compact,
Office, Portable, Automatic). Story/article pages carry byline, date, and
read-time metadata and end with related-product cards and a CTA into a
guided "Experience".

## Capabilities and Constraints

- Product catalog: espresso machines (7 SKUs observed on the listing page,
  $399–$4,299) and grinders (referenced from the nav, not sampled in this
  3-page pass).
- Editorial content library under `/stories/` (coffee craft/education) and
  guided quizzes/paths under `/experiences/`.
- Header includes "White Paper" and "Debug" utility links (debug likely a
  non-production affordance — not confirmed).

## Brand Commitments

Name: **Arco**. Wordmark uses a small circular bean-motif icon beside the
"Arco" text in the header (site's own `icons/arco-logo.png` asset). Voice is
confident, editorial, and detail-oriented — copy foregrounds craftsmanship
("beautifully engineered", "engineered for precision, built to last") and
sustainability/repairability ("Built to Last, Designed to Repair").

## Evidence on Hand

- Home page hero, product grid, testimonials, and "Built to Last" section —
  captured live at `stardust/current/pages/index.json` /
  `assets/screenshots/index.png`.
- Full espresso-machine catalog (8 SKUs, tag-filterable) — captured at
  `stardust/current/pages/products-espresso-machines.json` /
  `assets/screenshots/products-espresso-machines.png`.
- Long-form editorial story with author byline and related-product upsell —
  captured at `stardust/current/pages/stories-from-bean-to-cup.json` /
  `assets/screenshots/stories-from-bean-to-cup.png`.
- Customer testimonials on the home page (Marco L., Sarah K., James T.) are
  real captured copy, not fabricated — treat as evidence, not invented
  social proof.

## Product Principles

1. Photography carries the brand — every hero and card leans on full-bleed,
   natural-light product photography rather than illustration or icon-driven UI.
2. Editorial and commerce are fused — story content and product cards
   cross-link constantly; don't treat "content" and "shop" as separate
   surfaces.
3. Detail-orientation is the brand's core claim — copy and structure (specs,
   named burr sizes, boiler counts, repairability) should always support
   the "care about every detail" positioning, not undercut it with vague
   marketing language.
