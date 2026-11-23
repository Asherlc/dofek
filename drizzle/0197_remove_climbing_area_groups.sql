-- dofek: deployment-mode=maintenance
ALTER TABLE fitness.area DROP COLUMN group_id;
--> statement-breakpoint
DROP TABLE fitness.area_group;
