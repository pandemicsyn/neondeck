CREATE TABLE `factory_writeback_records` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`work_id` text,
	`record` text NOT NULL
);
