export const receiptGuardBody=`
BEGIN
 IF TG_OP = 'TRUNCATE' THEN
  RAISE EXCEPTION 'app_receipt_immutable' USING ERRCODE='42501';
 END IF;
 IF OLD.collection IN ('requests','events') OR (TG_OP = 'UPDATE' AND NEW.collection IN ('requests','events')) THEN
  RAISE EXCEPTION 'app_receipt_immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
`;
export async function readAppReceiptBoundary(pool){
 const {rows}=await pool.query(`SELECT t.tgname,t.tgtype,t.tgenabled,p.prosrc,p.prosecdef,
   NOT (has_table_privilege(current_user,'claus_network.app_documents','DELETE,TRUNCATE,TRIGGER')
    OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    OR p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS protected
  FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  WHERE t.tgrelid='claus_network.app_documents'::regclass AND t.tgname IN ('app_receipt_immutable','app_receipt_no_truncate')`);
 if(rows.length!==2||[['app_receipt_immutable',27],['app_receipt_no_truncate',34]].some(([name,type])=>!rows.some(r=>r.tgname===name&&r.tgtype===type&&r.tgenabled==='O'&&r.prosrc===receiptGuardBody&&r.prosecdef===false&&r.protected===true)))throw Error('app_receipt_boundary_unavailable');
 return {profile:'app-receipt-immutable/1',verified:true};
}
