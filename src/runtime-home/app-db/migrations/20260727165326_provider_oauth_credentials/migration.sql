CREATE TABLE `provider_oauth_credentials` (
	`provider_id` text PRIMARY KEY,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
