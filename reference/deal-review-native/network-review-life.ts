import {runNetworkReview} from './network-review.js';
export async function networkReviewLife(id:string) {
 'use workflow';
 return reviewStep(id);
}
async function reviewStep(id:string) {
 'use step';
 return runNetworkReview(id);
}
reviewStep.maxRetries=0;
