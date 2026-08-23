CREATE TABLE `activity_content_counters` (
	`scope` text PRIMARY KEY,
	`content_bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activity_events` ADD `content_bytes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `activity_events`
SET `content_bytes` = CASE
	WHEN `event_type` = 'task_start' AND json_valid(`summary_json`)
		THEN COALESCE(length(CAST(json_extract(`summary_json`, '$.prompt') AS BLOB)), 0)
	WHEN `event_type` = 'task' AND json_valid(`summary_json`)
		THEN COALESCE(length(CAST(json_extract(`summary_json`, '$.result') AS BLOB)), 0)
	ELSE 0
END;
--> statement-breakpoint
INSERT INTO `activity_content_counters` (`scope`, `content_bytes`, `updated_at`)
SELECT 'global', COALESCE(SUM(`content_bytes`), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `activity_events`;
--> statement-breakpoint
INSERT INTO `activity_content_counters` (`scope`, `content_bytes`, `updated_at`)
SELECT 'submission:' || `submission_id`, SUM(`content_bytes`), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `activity_events`
WHERE `submission_id` IS NOT NULL AND `content_bytes` > 0
GROUP BY `submission_id`;
