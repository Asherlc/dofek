-- Preserve unknown attempt methods independently of the route definition.
-- https://www.postgresql.org/docs/current/sql-droptrigger.html
DROP TRIGGER climbing_attempt_route_method_required ON fitness.climbing_attempt;
--> statement-breakpoint
DROP TRIGGER climbing_log_entry_route_method_guard ON fitness.climbing_log_entry;
--> statement-breakpoint
DROP TRIGGER climb_route_method_guard ON fitness.climb;
--> statement-breakpoint
DROP TRIGGER climbing_attempt_route_method_lock ON fitness.climbing_attempt;
--> statement-breakpoint
DROP TRIGGER climbing_log_entry_route_method_lock ON fitness.climbing_log_entry;
--> statement-breakpoint
DROP FUNCTION fitness.climbing_route_methods_valid();
--> statement-breakpoint
DROP FUNCTION fitness.lock_climbing_route_method_target();
--> statement-breakpoint
DROP FUNCTION fitness.assert_climbing_route_methods(uuid);
