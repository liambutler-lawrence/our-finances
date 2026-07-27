CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`institution` text,
	`owner_label` text,
	`account_type` text,
	`currency` text NOT NULL,
	`asset_symbol` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_active_idx` ON `accounts` (`active`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`as_of_date` text NOT NULL,
	`balance_text` text NOT NULL,
	`currency` text NOT NULL,
	`source_ref` text,
	`verification_status` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `balances_date_idx` ON `balance_snapshots` (`as_of_date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`group_name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_label_idx` ON `categories` (`label`);--> statement-breakpoint
CREATE TABLE `data_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`month` text,
	`account_id` text,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`status` text NOT NULL,
	`source_ref` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `data_issues` (`status`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source_name` text,
	`imported_at` text NOT NULL,
	`imported_by` text NOT NULL,
	`record_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `legacy_aggregates` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`category_id` text,
	`label` text,
	`amount_text` text,
	`currency` text,
	`amount_mxn_text` text,
	`amount_usd_text` text,
	`source_ref` text,
	`verification_status` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `legacy_month_idx` ON `legacy_aggregates` (`month`);--> statement-breakpoint
CREATE INDEX `legacy_kind_idx` ON `legacy_aggregates` (`kind`);--> statement-breakpoint
CREATE TABLE `prices` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`kind` text NOT NULL,
	`quote_currency` text NOT NULL,
	`value_text` text NOT NULL,
	`updated_at` text,
	`source_ref` text
);
--> statement-breakpoint
CREATE INDEX `prices_symbol_idx` ON `prices` (`symbol`);--> statement-breakpoint
CREATE TABLE `statements` (
	`id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`source_basename` text NOT NULL,
	`institution` text,
	`account_id` text,
	`period_start` text,
	`period_end` text,
	`currency` text,
	`opening_balance` text,
	`closing_balance` text,
	`reconciliation_status` text NOT NULL,
	`validation_state` text NOT NULL,
	`transaction_count` integer DEFAULT 0 NOT NULL,
	`unparsed_money_line_count` integer DEFAULT 0 NOT NULL,
	`imported_at` text NOT NULL,
	`imported_by` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statements_sha_idx` ON `statements` (`source_sha256`);--> statement-breakpoint
CREATE INDEX `statements_period_idx` ON `statements` (`period_end`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`statement_id` text NOT NULL,
	`account_id` text NOT NULL,
	`category_id` text,
	`transaction_date` text,
	`posted_date` text,
	`description` text NOT NULL,
	`amount_text` text NOT NULL,
	`currency` text NOT NULL,
	`transaction_type` text NOT NULL,
	`category_confidence` text,
	`categorization_source` text,
	`review_status` text NOT NULL,
	`fee_text` text,
	`balance_text` text,
	`quantity_text` text,
	`unit_price_text` text,
	`symbol` text,
	`external_id` text,
	`source_page` integer,
	`source_line_start` integer,
	`source_line_end` integer,
	`raw_text` text NOT NULL,
	`notes` text,
	`reviewed_at` text,
	`reviewed_by` text,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_statement_idx` ON `transactions` (`statement_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`transaction_date`);--> statement-breakpoint
CREATE INDEX `transactions_review_idx` ON `transactions` (`review_status`);--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL
);
