-- Team management: deactivating a user (someone leaves the company, a
-- contractor's engagement ends) should be reversible and shouldn't destroy
-- their history as the uploaded_by/assigned party on existing records —
-- same reasoning as everywhere else destructive actions have been handled
-- carefully in this project. is_active gates login, not existence.
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
