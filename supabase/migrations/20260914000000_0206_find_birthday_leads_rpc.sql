-- VELA: Function RPC to find leads with birthdays today
-- Filters leads with status != 'lost' and contacts where birthdate matches today (day/month)
-- Used by cron/birthday-greetings to send automated birthday messages via WhatsApp
--
-- Returns: (lead_id, contact_id, organization_id, display_name)

CREATE OR REPLACE FUNCTION find_birthday_leads(
  p_month INT,
  p_day INT
)
RETURNS TABLE(
  lead_id UUID,
  contact_id UUID,
  organization_id UUID,
  display_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.id,
    c.id,
    cl.organization_id,
    c.display_name
  FROM crm_leads cl
  INNER JOIN contacts c ON c.id = cl.contact_id
  WHERE
    cl.status != 'lost'
    AND c.birthdate IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthdate) = p_month
    AND EXTRACT(DAY FROM c.birthdate) = p_day;
END;
$$ LANGUAGE plpgsql STABLE;

-- Revoke execute from public; only authenticated internal service can call via RPC
REVOKE EXECUTE ON FUNCTION find_birthday_leads(INT, INT) FROM PUBLIC, ANON;
