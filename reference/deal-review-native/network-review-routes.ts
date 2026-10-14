import {Hono} from 'hono';
import {start} from 'workflow/api';
import {authorized} from './config.js';
import {submitNetworkReview,networkReviewStatus,cancelNetworkReview} from './network-review.js';
import {networkReviewLife} from './network-review-life.js';

export const networkReviewRoutes=new Hono();
networkReviewRoutes.use('*',async(c,next)=>{
 if(!authorized(c.req.header('authorization'),process.env.CLAUS_NETWORK_REVIEW_SECRET))return c.json({error:'unauthenticated'},401);
 await next();
});
networkReviewRoutes.post('/reviews',async c=>{
 const raw=await c.req.text();if(Buffer.byteLength(raw)>910000)return c.json({error:'request_too_large'},413);
 try{
  const review=await submitNetworkReview(JSON.parse(raw));
  if(review.state==='queued'&&Date.parse(review.retryAt)<=Date.now())await start(networkReviewLife,[review.id],{deploymentId:'latest'});
  return c.json(review,202);
 }catch(error){
  const message=error instanceof Error?error.message:'';
  const known=/^network_review_(invalid_input|proposal_expires|capacity|disabled|revoked)$/.test(message);
  return c.json({error:known?message:'network_review_unavailable'},message==='network_review_capacity'?429:message==='network_review_disabled'?403:known?400:503);
 }
});
networkReviewRoutes.delete('/reviews/:id',async c=>{
 try{return c.json(await cancelNetworkReview(c.req.param('id')));}
 catch{return c.json({error:'network_review_unavailable'},503);}
});
networkReviewRoutes.get('/reviews/:id',async c=>{
 try{return c.json(await networkReviewStatus(c.req.param('id')));}
 catch(error){const message=error instanceof Error?error.message:'';return c.json({error:message==='network_review_not_found'?message:'network_review_unavailable'},message==='network_review_not_found'?404:503);}
});
