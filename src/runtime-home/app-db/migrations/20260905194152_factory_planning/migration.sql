CREATE TABLE `factory_planning_bindings` (
	`work_id` text PRIMARY KEY,
	`session_id` text NOT NULL UNIQUE,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_planning_bindings_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`),
	CONSTRAINT `fk_factory_planning_bindings_session_id_chat_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_planning_effects` (
	`id` text PRIMARY KEY,
	`intent_id` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_planning_effects_intent_id_factory_planning_intents_id_fk` FOREIGN KEY (`intent_id`) REFERENCES `factory_planning_intents`(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_planning_intents` (
	`id` text PRIMARY KEY,
	`work_id` text NOT NULL,
	`request_key` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_factory_planning_intents_work_id_factory_work_items_id_fk` FOREIGN KEY (`work_id`) REFERENCES `factory_work_items`(`id`),
	CONSTRAINT `factory_planning_intents_work_id_request_key_unique` UNIQUE(`work_id`,`request_key`)
);
