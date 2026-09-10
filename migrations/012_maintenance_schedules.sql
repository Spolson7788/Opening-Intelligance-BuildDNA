-- Recurring maintenance schedules: "quarterly closer adjustments on this
-- door" instead of remembering to create a work order every time. No real
-- background job scheduler exists in this app (no cron process actually
-- running) — same honest scope boundary as the no-live-email,
-- no-live-carrier-tracking calls made elsewhere in this project. Due
-- schedules are generated lazily whenever the work order list is read
-- (see checkAndGenerateDueWorkOrders in src/routes/workOrders.ts), plus a
-- dedicated endpoint a real cron could call in production. Both paths use
-- the exact same generation function, so there's one place implementing
-- the actual logic.
CREATE TABLE maintenance_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assigned_to_user_id UUID REFERENCES users(id),
    interval_unit TEXT NOT NULL CHECK (interval_unit IN ('days', 'weeks', 'months', 'years')),
    interval_count INT NOT NULL CHECK (interval_count > 0),
    next_due_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_generated_at TIMESTAMPTZ
);

CREATE INDEX idx_maintenance_schedules_opening ON maintenance_schedules(opening_id);
CREATE INDEX idx_maintenance_schedules_due ON maintenance_schedules(next_due_date) WHERE is_active;

ALTER TABLE work_orders ADD COLUMN generated_from_schedule_id UUID REFERENCES maintenance_schedules(id);
