-- Keyset ordering for the predicted ranking (M4-W2): newest-first by
-- predicted likelihood, prop_id as the tie-breaker.
create index if not exists home_propensity_p_install_12m_idx
  on core.home_propensity (p_install_12m desc, prop_id);
