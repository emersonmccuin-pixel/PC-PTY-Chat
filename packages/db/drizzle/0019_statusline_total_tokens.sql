-- Section 31.11 follow-up — capture per-session running token totals.
--
-- CC's statusline payload carries `context_window.total_input_tokens` and
-- `total_output_tokens` as session-cumulative running totals (NOT per-turn
-- deltas). Adding these columns lets the global aggregate endpoint return
-- summed tokens per bucket, which the top-header global usage display
-- needs. Cost was already covered by `total_cost_usd`; tokens were not.

ALTER TABLE `statusline_snapshots` ADD COLUMN `total_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `statusline_snapshots` ADD COLUMN `total_output_tokens` integer;
