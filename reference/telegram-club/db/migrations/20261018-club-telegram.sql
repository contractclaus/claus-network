CREATE TABLE IF NOT EXISTS club_telegram_config (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), chat_id text NOT NULL,
 bot_id text NOT NULL, bot_username text NOT NULL, owner_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, activated_at timestamptz
);
CREATE TABLE IF NOT EXISTS club_telegram_pairings (
 id text PRIMARY KEY, address text NOT NULL REFERENCES club_members(address),
 session_hash text NOT NULL REFERENCES club_sessions(token_hash) ON DELETE CASCADE,
 user_id text, username text, first_name text, expires_at timestamptz NOT NULL,
 confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_telegram_pairings_wallet ON club_telegram_pairings(address,created_at DESC);
CREATE TABLE IF NOT EXISTS club_telegram_members (
 address text PRIMARY KEY REFERENCES club_members(address), user_id text NOT NULL UNIQUE,
 username text, first_name text, state text NOT NULL CHECK(state IN ('verified','joined','left','revoked')),
 checked_at timestamptz NOT NULL DEFAULT now(), next_check_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 joined_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS club_telegram_invites (
 id uuid PRIMARY KEY, address text NOT NULL REFERENCES club_members(address), user_id text NOT NULL,
 invite_link text UNIQUE, state text NOT NULL CHECK(state IN ('reserved','live','used','revoked','uncertain')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS club_telegram_updates (
 id bigint PRIMARY KEY, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
 lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS club_telegram_updates_pending ON club_telegram_updates(state,created_at);
CREATE TABLE IF NOT EXISTS club_telegram_messages (
 chat_id text NOT NULL, telegram_id bigint NOT NULL, club_id bigint NOT NULL UNIQUE REFERENCES club_messages(id),
 user_id text, direction text NOT NULL CHECK(direction IN ('in','out')),
 PRIMARY KEY(chat_id,telegram_id)
);
CREATE TABLE IF NOT EXISTS club_telegram_outbox (
 id text PRIMARY KEY, method text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','done','uncertain','failed')),
 result jsonb, error_code text, lease_until timestamptz, next_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS club_telegram_outbox_pending ON club_telegram_outbox(state,next_at);

CREATE OR REPLACE FUNCTION club_telegram_confirm(who text,session_id text,pair_id text,telegram_user text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p club_telegram_pairings%ROWTYPE; previous club_telegram_members%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('telegram-wallet:'||who,0));
 SELECT * INTO p FROM club_telegram_pairings WHERE id=pair_id AND address=who AND session_hash=session_id AND user_id=telegram_user AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'telegram_pairing_expired'; END IF;
 SELECT * INTO previous FROM club_telegram_members WHERE address=who FOR UPDATE;
 IF FOUND AND previous.user_id<>p.user_id AND previous.state<>'revoked' THEN RAISE EXCEPTION 'telegram_already_linked'; END IF;
 INSERT INTO club_telegram_members(address,user_id,username,first_name,state)
 VALUES(who,p.user_id,p.username,p.first_name,'verified') ON CONFLICT(address) DO UPDATE SET
 user_id=excluded.user_id,username=excluded.username,first_name=excluded.first_name,
 state=CASE WHEN club_telegram_members.state='joined' THEN 'joined' ELSE 'verified' END,
 checked_at=now(),next_check_at=now()+interval '5 minutes',updated_at=now();
 UPDATE club_telegram_pairings SET confirmed_at=now() WHERE id=pair_id;
 UPDATE club_members SET username=coalesce(username,'tg_'||p.user_id) WHERE address=who;
END $$;

CREATE OR REPLACE FUNCTION club_telegram_ingest(chat text,msg bigint,who text,body text,parent bigint,edited boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE member club_telegram_members%ROWTYPE; item bigint; reply bigint; request uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('telegram:'||chat||':'||msg,0));
 SELECT club_id INTO item FROM club_telegram_messages WHERE chat_id=chat AND telegram_id=msg;
 IF item IS NOT NULL THEN
  IF edited AND EXISTS(SELECT 1 FROM club_telegram_messages WHERE club_id=item AND user_id=who AND direction='in') THEN UPDATE club_messages SET body=left(club_telegram_ingest.body,2000) WHERE id=item AND deleted_at IS NULL; END IF;
  RETURN item;
 END IF;
 IF edited THEN RETURN NULL; END IF;
 SELECT * INTO member FROM club_telegram_members WHERE user_id=who AND state IN ('verified','joined');
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM club_telegram_config WHERE id AND enabled AND chat_id=chat) THEN RAISE EXCEPTION 'telegram_member_required'; END IF;
 IF EXISTS(SELECT 1 FROM club_members WHERE address=member.address AND muted_until>clock_timestamp()) THEN RETURN NULL; END IF;
 SELECT club_id INTO reply FROM club_telegram_messages WHERE chat_id=chat AND telegram_id=parent;
 request:=md5('telegram:'||chat||':'||msg)::uuid;
 INSERT INTO club_messages(address,body,reply_to,request_id)
 VALUES(member.address,left(body,2000),reply,request) RETURNING id INTO item;
 INSERT INTO club_telegram_messages VALUES(chat,msg,item,who,'in');
 IF body ~* '@contractclausbot\y' THEN INSERT INTO club_mentions(message_id,address) VALUES(item,'0x000000000000000000000000000000000000c1a5') ON CONFLICT DO NOTHING; END IF;
 PERFORM pg_notify('claus_club_events','chat');
 RETURN item;
END $$;

CREATE OR REPLACE FUNCTION club_telegram_queue_reply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg club_telegram_config%ROWTYPE; target club_telegram_messages%ROWTYPE; payload jsonb;
BEGIN
 IF NEW.address<>'0x000000000000000000000000000000000000c1a5' OR NEW.deleted_at IS NOT NULL OR NEW.hidden_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO cfg FROM club_telegram_config WHERE id AND enabled;
 IF NOT FOUND THEN RETURN NEW; END IF;
 payload:=jsonb_build_object('chat_id',cfg.chat_id,'text',NEW.body,'link_preview_options',jsonb_build_object('is_disabled',true));
 IF NEW.reply_to IS NOT NULL THEN
  SELECT * INTO target FROM club_telegram_messages WHERE club_id=NEW.reply_to AND chat_id=cfg.chat_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  payload:=payload||jsonb_build_object('reply_parameters',jsonb_build_object('message_id',target.telegram_id,'allow_sending_without_reply',true));
 END IF;
 INSERT INTO club_telegram_outbox(id,method,payload) VALUES('club-message:'||NEW.id,'sendMessage',payload) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS club_telegram_reply ON club_messages;
CREATE TRIGGER club_telegram_reply AFTER INSERT ON club_messages FOR EACH ROW EXECUTE FUNCTION club_telegram_queue_reply();
REVOKE ALL ON FUNCTION club_telegram_ingest(text,bigint,text,text,bigint,boolean),club_telegram_queue_reply() FROM PUBLIC;

CREATE OR REPLACE FUNCTION club_telegram_mirror_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg club_telegram_config%ROWTYPE; mapped club_telegram_messages%ROWTYPE; member club_telegram_members%ROWTYPE; method text; payload jsonb; key text; val record;
BEGIN
 SELECT * INTO cfg FROM club_telegram_config WHERE id AND enabled;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='club_messages' THEN
  SELECT * INTO mapped FROM club_telegram_messages WHERE club_id=NEW.id AND chat_id=cfg.chat_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN method:='deleteMessage';payload:=jsonb_build_object('chat_id',cfg.chat_id,'message_id',mapped.telegram_id);
  ELSIF NEW.body IS DISTINCT FROM OLD.body AND mapped.direction='out' AND NEW.deleted_at IS NULL THEN method:='editMessageText';payload:=jsonb_build_object('chat_id',cfg.chat_id,'message_id',mapped.telegram_id,'text',NEW.body,'link_preview_options',jsonb_build_object('is_disabled',true));
  ELSIF NEW.pinned IS DISTINCT FROM OLD.pinned THEN method:=CASE WHEN NEW.pinned THEN 'pinChatMessage' ELSE 'unpinChatMessage' END;payload:=jsonb_build_object('chat_id',cfg.chat_id,'message_id',mapped.telegram_id);
  ELSE RETURN NULL; END IF;
  key:='message-change:'||NEW.id||':'||txid_current();
 ELSIF TG_TABLE_NAME='club_updates' THEN
  method:='sendMessage';key:='club-update:'||NEW.id;payload:=jsonb_build_object('chat_id',cfg.chat_id,'text',left(NEW.title||E'\n\n'||NEW.body,4096),'link_preview_options',jsonb_build_object('is_disabled',true));
 ELSIF TG_TABLE_NAME='club_members' THEN
  IF NEW.muted_until IS NOT DISTINCT FROM OLD.muted_until THEN RETURN NULL; END IF;
  SELECT * INTO member FROM club_telegram_members WHERE address=NEW.address;
  IF NOT FOUND OR member.user_id IN (cfg.owner_id,cfg.bot_id) THEN RETURN NULL; END IF;
  method:='restrictChatMember';key:='member-mute:'||member.user_id||':'||txid_current();
  payload:=jsonb_build_object('chat_id',cfg.chat_id,'user_id',member.user_id::bigint,'use_independent_chat_permissions',true,'permissions',jsonb_build_object('can_send_messages',coalesce(NEW.muted_until<=now(),true),'can_send_audios',coalesce(NEW.muted_until<=now(),true),'can_send_documents',coalesce(NEW.muted_until<=now(),true),'can_send_photos',coalesce(NEW.muted_until<=now(),true),'can_send_videos',coalesce(NEW.muted_until<=now(),true),'can_send_video_notes',coalesce(NEW.muted_until<=now(),true),'can_send_voice_notes',coalesce(NEW.muted_until<=now(),true),'can_send_other_messages',coalesce(NEW.muted_until<=now(),true),'can_add_web_page_previews',coalesce(NEW.muted_until<=now(),true)),'until_date',CASE WHEN NEW.muted_until IS NULL OR NOT isfinite(NEW.muted_until) THEN 0 ELSE extract(epoch FROM NEW.muted_until)::bigint END);
 ELSE
  IF TG_OP='DELETE' THEN val:=OLD;ELSE val:=NEW;END IF;
  IF val.address<>'0x000000000000000000000000000000000000c1a5' THEN RETURN NULL; END IF;
  SELECT * INTO mapped FROM club_telegram_messages WHERE club_id=val.message_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  method:='setMessageReaction';key:='reaction:'||val.message_id||':'||txid_current();payload:=jsonb_build_object('chat_id',cfg.chat_id,'message_id',mapped.telegram_id,'reaction',CASE WHEN TG_OP='DELETE' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('type','emoji','emoji',val.emoji)) END);
 END IF;
 INSERT INTO club_telegram_outbox(id,method,payload) VALUES(key,method,payload) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS club_telegram_change ON club_messages;
CREATE TRIGGER club_telegram_change AFTER UPDATE ON club_messages FOR EACH ROW EXECUTE FUNCTION club_telegram_mirror_change();
DROP TRIGGER IF EXISTS club_telegram_update ON club_updates;
CREATE TRIGGER club_telegram_update AFTER INSERT ON club_updates FOR EACH ROW EXECUTE FUNCTION club_telegram_mirror_change();
DROP TRIGGER IF EXISTS club_telegram_mute ON club_members;
CREATE TRIGGER club_telegram_mute AFTER UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION club_telegram_mirror_change();
DROP TRIGGER IF EXISTS club_telegram_reaction ON club_reactions;
CREATE TRIGGER club_telegram_reaction AFTER INSERT OR DELETE ON club_reactions FOR EACH ROW EXECUTE FUNCTION club_telegram_mirror_change();
REVOKE ALL ON FUNCTION club_telegram_mirror_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION club_telegram_confirm(text,text,text,text) FROM PUBLIC;
GRANT SELECT ON club_telegram_config TO claus_club_web;
GRANT SELECT,INSERT,UPDATE,DELETE ON club_telegram_pairings,club_telegram_members,club_telegram_invites,club_telegram_updates,club_telegram_messages,club_telegram_outbox TO claus_club_web;
GRANT EXECUTE ON FUNCTION club_telegram_confirm(text,text,text,text),club_telegram_ingest(text,bigint,text,text,bigint,boolean) TO claus_club_web;

GRANT UPDATE(enabled,activated_at) ON club_telegram_config TO claus_club_web;
