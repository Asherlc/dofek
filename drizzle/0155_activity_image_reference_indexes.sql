CREATE INDEX activity_image_user_object_idx ON fitness.activity_image USING btree (user_id, object_id) WHERE fitness.activity_image.object_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX activity_image_work_user_image_idx ON fitness.activity_image_work USING btree (user_id, image_id);
