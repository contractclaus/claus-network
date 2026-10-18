CREATE TABLE IF NOT EXISTS public.claus_continuity_checkpoint (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 nonce text NOT NULL,
 source_at timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION public.claus_continuity_checkpoint(nonce_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE recorded timestamptz;
BEGIN
 IF nonce_value !~ '^[a-f0-9]{32}$' THEN
  RAISE EXCEPTION 'invalid_checkpoint_nonce';
 END IF;
 INSERT INTO public.claus_continuity_checkpoint(id,nonce,source_at)
 VALUES(true,nonce_value,clock_timestamp())
 ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,source_at=excluded.source_at
 RETURNING source_at INTO recorded;
 RETURN jsonb_build_object('nonce',nonce_value,'sourceAt',recorded);
END;
$$;
REVOKE ALL ON FUNCTION public.claus_continuity_checkpoint(text) FROM PUBLIC;
