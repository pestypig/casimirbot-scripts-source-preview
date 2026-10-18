import { randomUUID } from "node:crypto";
import { z } from "zod";

/** The caller supplies authenticated fixture clients; headers, cookies and CSRF
 * stay inside that transport and are never returned in the evidence report. */
export type LocalAcceptanceClient = { send(method: "GET" | "POST", path: string, body?: unknown, requestKey?: string): Promise<{ status: number; body: unknown }> };
export type LocalAcceptanceCheck = { id: string; expected: string; actual: string; verdict: "PASS" | "FAIL" };
const roomSchema=z.object({roomId:z.string()}).passthrough();
const shareSchema=z.object({shareId:z.string(),revision:z.number(),documentId:z.string()}).passthrough();
const documentSchema=z.object({provider_calls:z.literal(0),document:z.object({documentId:z.string(),revision:z.number(),
  markers:z.array(z.object({requestId:z.string(),effectId:z.string(),markerId:z.string(),ownerId:z.string(),requesterId:z.string(),
    coordinates:z.object({x:z.number(),y:z.number()}),color:z.literal("blue")}))}).passthrough()}).passthrough();
const resultSchema=z.object({schema:z.literal("helix.hosted_guest_action.result.v1"),requestId:z.string(),status:z.string(),
  ownerId:z.string(),requesterId:z.string(),provider_calls:z.literal(0),answer_authority:z.literal(false),
  effectId:z.string().optional(),markerId:z.string().optional(),documentRevision:z.number().optional(),evidenceRef:z.string().optional()}).passthrough();

/** Real mounted local HTTP composition with explicitly synthetic identities.
 * This runner makes finite operator requests, not model decisions or retries.
 * A pending/unknown effect is inspected by ID and is never submitted again. */
export async function runLocalPlatformAcceptance(input: {
  host: LocalAcceptanceClient; guest: LocalAcceptanceClient; outsider: LocalAcceptanceClient;
  guestProfileId: string; artifact: { baselineSha: string; artifactSha256: string; version: string };
  /** Reconstruct routers/service/store against the same durable fixture state. */
  restart: () => Promise<void>; waitForCompletion: (requestId: string) => Promise<void>;
  inspectBudget: () => Promise<{ settledEffects: number; unknownEffects: number }>;
}) {
  const checks: LocalAcceptanceCheck[]=[];
  const check=(id:string,expected:string,actual:string,pass:boolean)=>checks.push({id,expected,actual,verdict:pass?"PASS":"FAIL"});
  const runId=`local-acceptance:${randomUUID()}`;
  const prefix="/api/agi/hosted/v1";
  const call=async(client:LocalAcceptanceClient,method:"GET"|"POST",path:string,body?:unknown,key?:string)=>{
    const response=await client.send(method,prefix+path,body,key);
    if(response.status!==200) throw Error(`acceptance_http_${response.status}:${path}`);
    return response.body;
  };
  const room=roomSchema.parse(await call(input.host,"POST","/rooms",{title:"Synthetic local acceptance"},`${runId}:room`));
  const invite=z.object({invitation_id:z.string()}).passthrough().parse(await call(input.host,"POST",`/rooms/${room.roomId}/invites`,{invitee_profile_id:input.guestProfileId},`${runId}:invite`));
  await call(input.guest,"POST","/invitations/accept",{invitation_id:invite.invitation_id},`${runId}:join`);
  const share=shareSchema.parse(await call(input.host,"POST",`/rooms/${room.roomId}/program-shares`,{},`${runId}:share`));
  await call(input.host,"POST",`/rooms/${room.roomId}/program-shares/${share.shareId}/confirm`,{expected_share_revision:share.revision},`${runId}:confirm`);
  const path=`/rooms/${room.roomId}/program-shares/${share.shareId}/document`;
  const before=documentSchema.parse(await call(input.host,"GET",path));
  const coordinates={x:0.25,y:0.75};
  const offer=z.object({offerId:z.string(),revision:z.number()}).passthrough().parse(await call(input.host,"POST",`/rooms/${room.roomId}/action-offers`,{
    share_id:share.shareId,requester_profile_id:input.guestProfileId,expected_document_revision:before.document.revision,coordinates},`${runId}:offer`));
  const requests=`/rooms/${room.roomId}/action-requests`;
  const requestBody={offer_id:offer.offerId,expected_offer_revision:offer.revision};
  const receipt=z.object({request_id:z.string(),provider_calls:z.literal(0)}).passthrough().parse(await call(input.guest,"POST",requests,requestBody,`${runId}:effect`));
  await input.waitForCompletion(receipt.request_id);
  const result=resultSchema.parse(await call(input.guest,"GET",`${requests}/${receipt.request_id}`));
  check("native-result","succeeded with effect, marker, revision and evidence",result.status,
    result.status==="succeeded" && !!result.effectId && !!result.markerId && !!result.documentRevision && !!result.evidenceRef);
  const after=documentSchema.parse(await call(input.host,"GET",path));
  const marker=after.document.markers.find(item=>item.requestId===receipt.request_id);
  check("native-postcondition","one attributable blue marker at (0.25, 0.75)",`${after.document.markers.length} markers; revision ${after.document.revision}`,
    after.document.markers.length===before.document.markers.length+1 && after.document.revision===before.document.revision+1 &&
    marker?.effectId===result.effectId && marker?.markerId===result.markerId && marker?.ownerId===result.ownerId &&
    marker?.requesterId===input.guestProfileId && marker?.coordinates.x===coordinates.x && marker?.coordinates.y===coordinates.y);
  const replay=z.object({request_id:z.string()}).passthrough().parse(await call(input.guest,"POST",requests,requestBody,`${runId}:effect`));
  const afterReplay=documentSchema.parse(await call(input.host,"GET",path));
  check("duplicate-effect","original request; no extra effect",replay.request_id,replay.request_id===receipt.request_id && afterReplay.document.revision===after.document.revision);
  const outsider=await input.outsider.send("GET",prefix+`${requests}/${receipt.request_id}`);
  const hidden = outsider.status === 404 && (outsider.body as {error?:string})?.error === "request_not_found";
  check("outsider-denial","403/401 or typed nonenumerating request_not_found",String(outsider.status),[401,403].includes(outsider.status) || hidden);
  const budget=await input.inspectBudget();
  check("budget-settlement","one settled effect; zero unknown effects",JSON.stringify(budget),budget.settledEffects===1 && budget.unknownEffects===0);
  await input.restart();
  const recovered=resultSchema.parse(await call(input.guest,"GET",`${requests}/${receipt.request_id}`));
  const durable=documentSchema.parse(await call(input.host,"GET",path));
  check("durable-return","same effect, evidence and document revision",recovered.status,
    recovered.effectId===result.effectId && recovered.evidenceRef===result.evidenceRef && durable.document.revision===after.document.revision);
  const restoredBudget=await input.inspectBudget();
  check("durable-budget","one settled effect and zero unknown after reopen",JSON.stringify(restoredBudget),
    restoredBudget.settledEffects===1 && restoredBudget.unknownEffects===0);
  const durableReplay=z.object({request_id:z.string()}).passthrough().parse(await call(input.guest,"POST",requests,requestBody,`${runId}:effect`));
  const afterDurableReplay=documentSchema.parse(await call(input.host,"GET",path));
  const replayBudget=await input.inspectBudget();
  check("durable-idempotent-replay","same request and revision; one settled effect after restart",durableReplay.request_id,
    durableReplay.request_id===receipt.request_id && afterDurableReplay.document.revision===durable.document.revision &&
    afterDurableReplay.document.markers.length===durable.document.markers.length && replayBudget.settledEffects===1 && replayBudget.unknownEffects===0);
  // An already consumed grant would fail with grant_used even if revocation
  // were broken. Exercise a fresh, unconsumed grant after durable recovery.
  const revokeOffer=z.object({offerId:z.string(),revision:z.number()}).passthrough().parse(await call(input.host,"POST",`/rooms/${room.roomId}/action-offers`,{
    share_id:share.shareId,requester_profile_id:input.guestProfileId,expected_document_revision:durable.document.revision,coordinates},`${runId}:revoke-offer`));
  await call(input.host,"POST",`/rooms/${room.roomId}/action-offers/${revokeOffer.offerId}/revoke`,{expected_offer_revision:revokeOffer.revision},`${runId}:revoke`);
  const revoked=await input.guest.send("POST",prefix+requests,{offer_id:revokeOffer.offerId,expected_offer_revision:revokeOffer.revision},`${runId}:revoked-new-request`);
  const afterRevoke=documentSchema.parse(await call(input.host,"GET",path));
  const revokeBudget=await input.inspectBudget();
  check("revoked-grant-denial","grant_revoked; unchanged document and effect accounting",`${revoked.status}:${(revoked.body as {error?:string})?.error}`,
    [403,409].includes(revoked.status) && (revoked.body as {error?:string})?.error==="grant_revoked" &&
    afterRevoke.document.revision===durable.document.revision && afterRevoke.document.markers.length===durable.document.markers.length &&
    revokeBudget.settledEffects===restoredBudget.settledEffects && revokeBudget.unknownEffects===restoredBudget.unknownEffects);
  const stopped=resultSchema.parse(await call(input.host,"POST",`${requests}/${receipt.request_id}/stop`,{}));
  check("owner-stop","stop acknowledged; committed effect retained",stopped.status,
    (stopped as unknown as {stopRequested:boolean}).stopRequested===true && stopped.effectId===result.effectId);
  return {schema:"casimirbot.local_platform_acceptance.v1",runId,scope:"synthetic_identity_local_http_composition",artifact:input.artifact,
    providerCalls:0,credentialsIncluded:false,humanAcceptance:false,installedClockAcceptance:false,publicAcceptance:false,
    verdict:checks.every(item=>item.verdict==="PASS")?"PASS":"FAIL",checks};
}
