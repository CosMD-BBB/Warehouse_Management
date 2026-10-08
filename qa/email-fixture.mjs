import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

// Only test callers import this module. It drives the actual OTP endpoints and
// captures an injected sender; it never weakens production verification.
export function createEmailFixture({now,sendFailure=false}={}){
  const messages=[];
  const emailAuth={secret:randomBytes(48).toString('hex'),...(now?{now}:{}),sendOtp:async payload=>{if(sendFailure)throw new Error('Fixture delivery failure');messages.push({...payload})}};
  const json=result=>result?.j??result?.json??result?.body??result;
  async function signup(post,fields={}){
    const email=fields.email||`${fields.username||'admin'}@fixture.example`,storeCode=fields.storeCode||'main';
    const requested=json(await post('/api/auth/email/request',{purpose:'signup',email,storeCode,username:fields.username}));
    assert.ok(requested.challengeId,'fixture OTP request must succeed');
    const message=messages.findLast(message=>message.challengeId===requested.challengeId);
    assert.ok(message,'fixture sender must receive OTP');
    const verified=json(await post('/api/auth/email/verify',{challengeId:requested.challengeId,code:message.code}));
    assert.ok(verified.verificationToken,'fixture OTP verification must succeed');
    return {...fields,email,verificationToken:verified.verificationToken};
  }
  return {emailAuth,messages,signup};
}
