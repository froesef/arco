-- Record which LLM provider + model produced each run.
-- Nullable so pre-existing rows remain valid; new rows get populated by storage.js.

ALTER TABLE generated_pages ADD COLUMN llm_provider TEXT;
ALTER TABLE generated_pages ADD COLUMN llm_model TEXT;
