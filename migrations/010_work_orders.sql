-- Work orders: the piece that closes the loop the alerts feature opened.
-- Alerts tell you something needs attention; work orders are where that
-- turns into an assigned task with a due date and a status someone can
-- actually update.
--
-- No DELETE endpoint by design — same soft-delete caution applied
-- everywhere destructive actions come up in this project. A work order
-- that's no longer needed gets status = 'cancelled', not removed, so the
-- history of what was asked for (and why it didn't happen) isn't lost.
CREATE TABLE work_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    due_date DATE,
    assigned_to_user_id UUID REFERENCES users(id),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_work_orders_opening ON work_orders(opening_id);
CREATE INDEX idx_work_orders_assigned ON work_orders(assigned_to_user_id);
CREATE INDEX idx_work_orders_status ON work_orders(status);
