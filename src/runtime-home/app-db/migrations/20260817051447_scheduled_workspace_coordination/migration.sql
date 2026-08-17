CREATE TABLE `workspace_provider_coordinator` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `task_workspaces` ADD `provider_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `task_workspaces` ADD `physical_resource_key` text;--> statement-breakpoint
ALTER TABLE `task_workspaces` ADD `collection_owner` text;--> statement-breakpoint
ALTER TABLE `task_workspaces` ADD `collection_expires_at` text;