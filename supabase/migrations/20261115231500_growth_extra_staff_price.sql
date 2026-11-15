-- Growth: extra staff R375 -> R350.
-- At R375 a 5-person shop paid R1,624 on Growth but only R1,499 on Business, so Growth was the worse deal exactly
-- where Business starts (Business includes 5 staff). At R350 the crossover is 5 staff: 4 staff = R1,199 on Growth,
-- 5 staff = R1,549 on Growth vs R1,499 on Business. Nobody was on Growth when this changed.
-- Prices are read from this table by the admin Billing panel, the invoice job and the public pricing page.
update public.plans set extra_staff_price_cents = 35000 where key = 'growth' and extra_staff_price_cents = 37500;
