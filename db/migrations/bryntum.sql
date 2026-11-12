-- Columns the Bryntum scheduling views need on top of the existing schema.
-- The client's own expected pay date (null means: same as due_date).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS expected_pay_date date;

-- When the supplier payout is planned to leave (null means: follow the linked invoice's expected_pay_date).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS planned_date date;
