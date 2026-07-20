CREATE TABLE `autopilot_result_deliveries` (
	`id` text PRIMARY KEY,
	`admission_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`delivery_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`remote_id` text,
	`error` text,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `autopilot_admissions` ADD `pushed_commit_sha` text;--> statement-breakpoint
ALTER TABLE `prepared_diff_approvals` ADD `admission_id` text;--> statement-breakpoint
ALTER TABLE `prepared_diff_approvals` ADD `owner_generation` integer;--> statement-breakpoint
ALTER TABLE `prepared_diff_approvals` ADD `stage_attempt_id` text;--> statement-breakpoint
ALTER TABLE `prepared_diffs` ADD `pushed_commit_sha` text;--> statement-breakpoint
CREATE INDEX `idx_autopilot_result_delivery_target` ON `autopilot_result_deliveries` (`admission_id`,`delivery_kind`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_result_delivery_key` ON `autopilot_result_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prepared_diff_approvals_admission_push` ON `prepared_diff_approvals` (`admission_id`,`prepared_diff_id`,`owner_generation`,`stage_attempt_id`,`approval_type`,`target_sha`,`policy_hash`) WHERE `status` IN ('pending', 'approved');
