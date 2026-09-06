CREATE TABLE `factory_github_comments` (
	`id` text PRIMARY KEY,
	`work_id` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_github_comments_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_github_deliveries` (
	`id` text PRIMARY KEY,
	`connection_id` text NOT NULL,
	`issue_number` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `factory_github_sync` (
	`id` text PRIMARY KEY,
	`record` text NOT NULL
);
