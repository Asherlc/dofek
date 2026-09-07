ALTER TABLE fitness.climbing_entry
ADD COLUMN lead boolean;

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_lead_routes_only CHECK (
  lead IS NULL OR climb_type = 'route'
) NOT VALID;

ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_lead_routes_only;
