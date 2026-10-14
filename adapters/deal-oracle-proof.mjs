import {recoverTypedDataAddress,decodeAbiParameters}from'viem';
import {canonical,digest,requireThat}from'../src/shared/index.mjs';
import {validateOraclePrepared}from'../src/deals/decision.mjs';
export const IMD_ATTESTER='0x5598aa9146215bc13eb26f2c692ad1461fd32982';
const fields=values=>values.map(([name,type])=>({name,type}));
export const ORACLE_TYPES={OracleAttestation:fields([['requestId','bytes32'],['chainId','uint256'],['questionHash','bytes32'],['answerType','uint8'],['answer','bytes'],['figure','uint256'],['fromBlock','uint64'],['toBlock','uint64'],['blockHash','bytes32'],['panelJobId','bytes32'],['panelSize','uint16'],['quorum','uint16'],['agreed','uint16'],['issuedAt','uint64'],['expiresAt','uint64']])};
export const uuidWord=id=>{requireThat(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id??''),'invalid_oracle_id');return '0x'+id.replaceAll('-','').padEnd(64,'0');};
// The provider's HTTPS order/request binds the question to its signed ID.
// questionHash is provider-defined; do not invent a hash algorithm for it.
export async function verifyDealOracle({request,attestation,requestId,expected,preparedInput,maximumWei,now=Date.now()},{recover=recoverTypedDataAddress}={}){
 const q=request,a=attestation,m=a?.message,seconds=Math.floor(now/1000);
 validateOraclePrepared(preparedInput,expected);requireThat(q?.questionHash===preparedInput.questionHash&&q?.window?.fromBlock===preparedInput.pinned.fromBlock&&q.window.toBlock===preparedInput.pinned.toBlock&&q.window.toBlockHash===preparedInput.pinned.toBlockHash,'oracle_prepared_input_mismatch');
 requireThat(q?.id===requestId&&q.status==='attested'&&q.question===expected.question&&q.chainId===expected.chainId&&q.answerType==='uint256'&&q.evidence==='panel'&&q.panelSize===5&&q.quorum===4&&q.toleranceBps===0&&q.validForSeconds===expected.validForSeconds&&canonical(q.consumer)===canonical(expected.consumer)&&canonical(q.definitions)===canonical(expected.definitions)&&canonical(q.guards)===canonical(expected.guards),'oracle_question_mismatch');
 requireThat(a?.requestId===requestId&&a.primaryType==='OracleAttestation'&&canonical(a.types)===canonical(ORACLE_TYPES)&&canonical(a.domain)===canonical({name:'IdentityMD Oracle',version:'2',chainId:expected.consumer.chainId,verifyingContract:expected.consumer.verifyingContract})&&a.signer?.toLowerCase()===IMD_ATTESTER,'oracle_attestation_mismatch');
 requireThat(m?.requestId===uuidWord(requestId)&&m.panelJobId===uuidWord(q.jobId)&&m.questionHash===q.questionHash&&m.chainId===q.chainId&&m.answerType==='uint256'&&m.panelSize===5&&m.quorum===4&&Number.isInteger(m.agreed)&&m.agreed>=4&&m.agreed<=5&&m.fromBlock===q.window.fromBlock&&m.toBlock===q.window.toBlock&&m.fromBlock===expected.window.fromBlock&&m.toBlock===expected.window.toBlock&&m.blockHash===q.window.toBlockHash&&Number.isSafeInteger(m.issuedAt)&&m.issuedAt<=seconds+30&&Number.isSafeInteger(m.expiresAt)&&m.expiresAt>seconds+3600&&m.expiresAt-m.issuedAt===expected.validForSeconds,'oracle_attestation_mismatch');
 requireThat(typeof m.figure==='string'&&/^(0|[1-9][0-9]*)$/.test(m.figure)&&/^0x[0-9a-f]{64}$/i.test(m.answer),'oracle_amount_invalid');
 const amount=decodeAbiParameters([{type:'uint256'}],m.answer)[0];requireThat(amount===BigInt(m.figure)&&amount<=BigInt(maximumWei),'oracle_amount_invalid');
 // HTTP uses the readable answerType label, while the signed EIP-712 field is uint8.
 const signer=await recover({domain:a.domain,types:ORACLE_TYPES,primaryType:'OracleAttestation',message:{...m,answerType:3},signature:a.signature});requireThat(signer.toLowerCase()===IMD_ATTESTER,'oracle_signature_invalid');
 return {workerAmount:String(amount),artifactHash:digest({request:q,attestation:a}),expiresAt:m.expiresAt,requestId,panelJobId:q.jobId,signer};
}
