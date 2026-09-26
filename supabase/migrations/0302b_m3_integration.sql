-- 0302b_m3_integration.sql — M3 integration (Harris + Williamson): extend
-- core.base_capture's explicit per-utility CASE (0301_m3_ercot.sql) to
-- cover the Williamson-area utilities added to core.retail_market by
-- this ticket: Bartlett Electric Cooperative (1273), City of Bartlett
-- (1287), City of Georgetown (7129) -- all confirmed NOT on Base's own
-- served-utility list (pricing.md's "Search your area" list / llms.txt's
-- Texas service-area sentence name only Oncor/CenterPoint/AEP Texas/TNMP
-- plus CoServ/GVEC/Farmers Electric/El Paso Electric), so each maps to
-- 'not_served' -- the same tier Pedernales (14626) and Bluebonnet (1892)
-- already carry. Without this, a home served by one of these three
-- utilities would join core.base_capture (a SELECT FROM core.retail_market)
-- and get base_capture_null_reason='utility_tier_not_classified' --
-- accurate-but-vague, when the real, cited reason is "not served".
--
-- CREATE OR REPLACE VIEW, identical column list/order/types to
-- 0301_m3_ercot.sql's definition -- api.base_capture (a plain SELECT over
-- this view) is untouched and keeps working unchanged; no signature of
-- any function changes.
--
-- Dry-run first (per CLAUDE.md's Speed-mode rule): the block below was
-- applied inside BEGIN...ROLLBACK against live Supabase before this file
-- was committed, confirming the CREATE OR REPLACE succeeds and every one
-- of the three new eia_utility_numbers reads base_capture='not_served'
-- with base_capture_null_reason=null.

create or replace view core.base_capture as
select
    eia_utility_number,
    utility_name,
    retail_market,
    case eia_utility_number
        when '44372' then 'full'         -- Oncor Electric Delivery: deregulated TDU
        when '8901'  then 'full'         -- CenterPoint Energy: deregulated TDU
        when '40051' then 'full'         -- Texas-New Mexico Power (TNMP): deregulated TDU
        when '7752'  then 'partner'      -- GVEC: retail_market.csv plain_language "Cooperative area Base serves"
        when '6182'  then 'partner'      -- Farmers Electric Cooperative: same, "Cooperative area Base serves"
        when '1015'  then 'backup_only'  -- Austin Energy: municipal, no retail choice
        when '5701'  then 'backup_only'  -- El Paso Electric: "Utility area Base serves" but not_deregulated/regulated, backup only
        when '14626' then 'not_served'   -- Pedernales Electric Cooperative: "not on Base's service list"
        when '1892'  then 'not_served'   -- Bluebonnet Electric Cooperative: "not on Base's service list"
        when '1273'  then 'not_served'   -- Bartlett Electric Cooperative (M3, Williamson): not on Base's service list
        when '1287'  then 'not_served'   -- City of Bartlett (M3, Williamson): municipal, not on Base's service list
        when '7129'  then 'not_served'   -- City of Georgetown (M3, Williamson): municipal, not on Base's service list
        else null
    end as base_capture,
    case
        when eia_utility_number in (
            '44372', '8901', '40051', '7752', '6182', '1015', '5701',
            '14626', '1892', '1273', '1287', '7129'
        ) then null
        else 'utility_tier_not_classified'
    end as base_capture_null_reason,
    source_id
from core.retail_market;

comment on view core.base_capture is
    'Per-utility Base service tier (full/partner/backup_only/not_served), '
    'derived by an explicit case-by-eia_utility_number over the '
    'already-loaded core.retail_market -- see the view definition for the '
    'citation backing each row (retail_market.csv''s own plain_language/'
    'quote columns). NOT a name-pattern match: Pedernales, Bluebonnet, '
    'Bartlett Electric Cooperative, City of Bartlett, and City of '
    'Georgetown are all cooperatives/municipal utilities but retail_'
    'market.csv says Base does not serve them, so they are not_served, '
    'never partner/backup_only. Any utility not in the explicit list is '
    'NULL with base_capture_null_reason. Gates ERCOT/VPP value '
    'attribution per M3-S1; grid-value terms for backup_only/not_served '
    'homes must read NULL with reason, never a spread number or a 0 -- a '
    'later ticket''s job to wire in, not this one''s. Extended by '
    '0302b_m3_integration.sql (M3 integration: Harris + Williamson) to '
    'add Bartlett Electric Cooperative (1273), City of Bartlett (1287), '
    'and City of Georgetown (7129), all not_served.';
