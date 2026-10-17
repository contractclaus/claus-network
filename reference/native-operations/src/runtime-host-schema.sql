CREATE TABLE IF NOT EXISTS public.claus_native_hosts(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 enabled boolean NOT NULL DEFAULT false,
 mode text NOT NULL DEFAULT 'primary' CHECK(mode IN ('primary','standby','returning')),
 epoch bigint NOT NULL DEFAULT 0,
 executor text,
 generation integer,
 execution_deployment text,
 lease_until timestamptz,
 deadline timestamptz,
 primary_deployment text,
 primary_seen_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.claus_native_hosts(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.claus_native_host_events(
 id bigserial PRIMARY KEY,
 kind text NOT NULL,
 epoch bigint NOT NULL,
 generation integer NOT NULL,
 executor text,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.claus_native_host_permit(p_role text,p_executor text,p_generation integer,p_epoch bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.claus_state s CROSS JOIN public.claus_native_hosts h
  WHERE s.id=1 AND h.id AND s.generation=p_generation AND (
   (p_role='primary' AND (NOT h.enabled OR h.mode='primary')) OR
   (p_role='standby' AND h.enabled AND h.mode='standby' AND h.executor=p_executor
     AND h.epoch=p_epoch AND h.generation=p_generation AND h.lease_until>now() AND h.deadline>now()
     AND EXISTS(SELECT 1 FROM public.claus_operations_control c WHERE c.scope='native' AND c.enabled AND c.deployment=h.execution_deployment))
  ));
$$;

CREATE OR REPLACE FUNCTION public.claus_native_host_pulse(p_role text,p_executor text,p_generation integer,p_epoch bigint,p_deployment text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT public.claus_native_host_permit(p_role,p_executor,p_generation,p_epoch) THEN RETURN false; END IF;
 IF p_role='primary' THEN
  UPDATE public.claus_native_hosts SET primary_seen_at=clock_timestamp(),primary_deployment=p_deployment,updated_at=clock_timestamp()
   WHERE id AND mode='primary';
 ELSE
  UPDATE public.claus_native_hosts SET lease_until=LEAST(clock_timestamp()+interval '5 minutes',deadline),updated_at=clock_timestamp()
   WHERE id AND enabled AND mode='standby' AND executor=p_executor AND epoch=p_epoch AND generation=p_generation AND lease_until>clock_timestamp();
 END IF;
 RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claus_native_host_claim(p_executor text,p_deployment text,p_primary_failed boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.claus_native_hosts%ROWTYPE;s public.claus_state%ROWTYPE;t timestamptz:=clock_timestamp();new_generation integer;
BEGIN
 IF p_executor IS NULL OR p_executor!~'^[A-Za-z0-9:_-]{1,120}$' OR NOT p_primary_failed THEN RETURN jsonb_build_object('status','not_eligible'); END IF;
 PERFORM pg_advisory_xact_lock(7540317);
 SELECT * INTO h FROM public.claus_native_hosts WHERE id FOR UPDATE;
 SELECT * INTO s FROM public.claus_state WHERE id=1 FOR UPDATE;
 IF s.id IS NULL OR NOT h.enabled OR h.primary_deployment IS NULL OR h.primary_seen_at IS NULL OR h.primary_deployment<>p_deployment
  OR NOT EXISTS(SELECT 1 FROM public.claus_operations_control c WHERE c.scope='native' AND c.enabled AND c.deployment=p_deployment)
  OR NOT EXISTS(SELECT 1 FROM public.claus_config c WHERE c.revision=(SELECT max(revision) FROM public.claus_config) AND c.content->'settings'->>'enabled'='true')
 THEN RETURN jsonb_build_object('status','not_armed'); END IF;
 IF s.status NOT IN ('working','waiting','waiting_for_effect','retrying') OR s.lease_until>t
  OR s.updated_at>t-interval '5 minutes' OR h.primary_seen_at>t-interval '5 minutes'
  OR h.mode='returning' OR (h.mode='standby' AND h.lease_until>t)
 THEN RETURN jsonb_build_object('status','healthy_or_busy'); END IF;
 UPDATE public.claus_state SET generation=generation+1,updated_at=t WHERE id=1 AND generation=s.generation RETURNING generation INTO new_generation;
 UPDATE public.claus_native_hosts SET mode='standby',epoch=epoch+1,executor=p_executor,generation=new_generation,execution_deployment=p_deployment,
  lease_until=t+interval '5 minutes',deadline=t+interval '20 minutes',updated_at=t WHERE id RETURNING * INTO h;
 INSERT INTO public.claus_native_host_events(kind,epoch,generation,executor) VALUES('takeover',h.epoch,new_generation,p_executor);
 RETURN jsonb_build_object('status','claimed','generation',new_generation,'epoch',h.epoch,'deadline',h.deadline);
END;
$$;

CREATE OR REPLACE FUNCTION public.claus_native_host_return(p_executor text,p_generation integer,p_epoch bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(7540317);
 IF NOT public.claus_native_host_permit('standby',p_executor,p_generation,p_epoch) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.claus_state WHERE id=1 AND lease_until>clock_timestamp()) THEN RETURN false; END IF;
 UPDATE public.claus_native_hosts SET mode='returning',updated_at=clock_timestamp() WHERE id AND executor=p_executor AND epoch=p_epoch;
 INSERT INTO public.claus_native_host_events(kind,epoch,generation,executor) VALUES('return_requested',p_epoch,p_generation,p_executor);
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claus_native_host_resume_primary(p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.claus_native_hosts%ROWTYPE;s public.claus_state%ROWTYPE;t timestamptz:=clock_timestamp();new_generation integer;
BEGIN
 PERFORM pg_advisory_xact_lock(7540317);
 SELECT * INTO h FROM public.claus_native_hosts WHERE id FOR UPDATE;
 IF NOT h.enabled OR h.mode='primary' THEN RETURN jsonb_build_object('status','primary'); END IF;
 IF h.mode='standby' AND h.lease_until>t THEN RETURN jsonb_build_object('status','standby_active'); END IF;
 SELECT * INTO s FROM public.claus_state WHERE id=1 FOR UPDATE;
 IF s.lease_until>t THEN RETURN jsonb_build_object('status','draining'); END IF;
 IF s.status NOT IN ('working','waiting','waiting_for_effect','retrying')
  OR NOT EXISTS(SELECT 1 FROM public.claus_operations_control c WHERE c.scope='native' AND c.enabled AND c.deployment=p_deployment)
  OR NOT EXISTS(SELECT 1 FROM public.claus_config c WHERE c.revision=(SELECT max(revision) FROM public.claus_config) AND c.content->'settings'->>'enabled'='true')
 THEN RETURN jsonb_build_object('status','paused'); END IF;
 UPDATE public.claus_state SET generation=generation+1,updated_at=t WHERE id=1 AND generation=s.generation RETURNING generation INTO new_generation;
 UPDATE public.claus_native_hosts SET mode='primary',epoch=epoch+1,executor=NULL,generation=NULL,execution_deployment=NULL,lease_until=NULL,deadline=NULL,
  primary_seen_at=t,primary_deployment=p_deployment,updated_at=t WHERE id RETURNING * INTO h;
 INSERT INTO public.claus_native_host_events(kind,epoch,generation) VALUES('primary_resumed',h.epoch,new_generation);
 RETURN jsonb_build_object('status','resume','generation',new_generation,'epoch',h.epoch);
END;
$$;

REVOKE ALL ON public.claus_native_hosts,public.claus_native_host_events FROM PUBLIC,claus_native_runtime;
GRANT SELECT ON public.claus_native_hosts,public.claus_native_host_events TO claus_native_runtime;
REVOKE ALL ON FUNCTION public.claus_native_host_permit(text,text,integer,bigint),
 public.claus_native_host_pulse(text,text,integer,bigint,text),
 public.claus_native_host_claim(text,text,boolean),
 public.claus_native_host_return(text,integer,bigint),
 public.claus_native_host_resume_primary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claus_native_host_permit(text,text,integer,bigint),
 public.claus_native_host_pulse(text,text,integer,bigint,text),
 public.claus_native_host_claim(text,text,boolean),
 public.claus_native_host_return(text,integer,bigint),
 public.claus_native_host_resume_primary(text) TO claus_native_runtime;
