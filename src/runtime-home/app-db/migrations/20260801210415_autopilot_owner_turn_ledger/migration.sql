CREATE TABLE `autopilot_owner_turns` (
	`turn_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`watch_id` text NOT NULL,
	`source` text NOT NULL,
	`mode` text NOT NULL,
	`idempotency_key` text,
	`event_fingerprint` text,
	`approved_revision_key` text,
	`envelope_json` text,
	`message_body` text,
	`prepared_json` text,
	`learning_memory_available` integer DEFAULT 0 NOT NULL,
	`learning_memory_loaded` integer DEFAULT 0 NOT NULL,
	`learning_memory_ids_json` text DEFAULT '[]' NOT NULL,
	`learning_memory_text` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`submission_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`admitted_at` text,
	`settled_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_turns_one_active` ON `autopilot_owner_turns` (`instance_id`) WHERE "autopilot_owner_turns"."status" IN ('reserved', 'admitted', 'settling');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_turns_delivery_key` ON `autopilot_owner_turns` (`instance_id`,`idempotency_key`) WHERE "autopilot_owner_turns"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_autopilot_owner_turns_active` ON `autopilot_owner_turns` (`instance_id`,`status`,"created_at" DESC);