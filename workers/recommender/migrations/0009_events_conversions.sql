-- Arco Marketing Metrics — behavioural events, conversions, ROI assumptions
--
-- Complements (does not replace) Workers Analytics Engine. AE is sampled and
-- has no session dimension, so it can answer "how much traffic?" but never
-- "did this generated run cause this add-to-cart?". These tables carry exact
-- counts plus an attribution key back into generated_pages(id).

CREATE TABLE IF NOT EXISTS page_events (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  page_id           TEXT,                    -- ?q= visit this event belongs to (if any)
  run_id            TEXT,                    -- run that rendered the page the event fired on
  attributed_run_id TEXT,                    -- generated run credited for this event
  attribution       TEXT,                    -- 'direct' | 'last-touch' | 'none'
  event_type        TEXT NOT NULL,           -- see EVENT_TYPES in src/events.js
  path              TEXT,
  page_type         TEXT,                    -- classifyPageType()
  product_slug      TEXT,
  value_cents       INTEGER,
  dwell_ms          INTEGER,
  scroll_pct        INTEGER,
  referrer_path     TEXT,
  created_at        INTEGER NOT NULL,        -- unix seconds
  ip_hash           TEXT,
  user_agent        TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session    ON page_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created    ON page_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type       ON page_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_attributed ON page_events(attributed_run_id);
CREATE INDEX IF NOT EXISTS idx_events_product    ON page_events(product_slug);

-- Conversions are denormalised out of page_events so the funnel/ROI queries
-- never scan the (much larger) raw event stream.
CREATE TABLE IF NOT EXISTS conversions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  event_id          TEXT,                    -- originating page_events.id
  attributed_run_id TEXT,
  attribution       TEXT,                    -- 'direct' | 'last-touch' | 'none'
  conversion_type   TEXT NOT NULL,           -- 'product_view' (soft) | 'add_to_cart' (hard)
  product_slug      TEXT,
  value_cents       INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_created    ON conversions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_type       ON conversions(conversion_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_attributed ON conversions(attributed_run_id);
CREATE INDEX IF NOT EXISTS idx_conv_session    ON conversions(session_id);
