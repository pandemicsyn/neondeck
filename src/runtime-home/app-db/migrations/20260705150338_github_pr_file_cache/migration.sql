CREATE TABLE `github_pr_file_cache` (
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`payload` text NOT NULL,
	`byte_size` integer NOT NULL,
	`fetched_at` text NOT NULL,
	CONSTRAINT `github_pr_file_cache_pk` PRIMARY KEY(`repo`, `pr_number`, `head_sha`)
);
