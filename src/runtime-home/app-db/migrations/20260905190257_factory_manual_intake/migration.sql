CREATE TABLE `factory_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`work_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_factory_audit_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_releases` (
	`id` text PRIMARY KEY,
	`work_id` text NOT NULL,
	`request_key` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_releases_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`),
	CONSTRAINT `factory_releases_work_id_request_key_unique` UNIQUE(`work_id`,`request_key`)
);
--> statement-breakpoint
CREATE TABLE `factory_sources` (
	`id` text PRIMARY KEY,
	`request_key` text NOT NULL UNIQUE,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `factory_spec_revisions` (
	`work_id` text NOT NULL,
	`version` integer NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `factory_spec_revisions_pk` PRIMARY KEY(`work_id`, `version`),
	CONSTRAINT `fk_factory_spec_revisions_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_work_items` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL UNIQUE,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_work_items_source_id_factory_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `factory_sources`(`id`)
);
