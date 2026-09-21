import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const source=fs.readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts',import.meta.url),'utf8');
const begin=source.indexOf('async function createLoginMember');
const handler=stripTypeScriptTypes(source.slice(begin,source.indexOf('Deno.serve',begin)));
function setup(overrides={}) {
 const calls=[];
 const admin={from:()=>({select:()=>({ilike:async()=>({data:[]})}),update:()=>({eq:async()=>({error:null})})}),auth:{admin:{generateLink:async()=>{calls.push('invite');return {data:{user:{id:'new-user'},properties:{hashed_token:'private-token'}}}},updateUserById:async()=>({error:null}),getUserById:async()=>({data:{user:{email_confirmed_at:'2026-09-21',app_metadata:{atlas_invited_by:'owner'}}}})}}};
 const scope={createClient:()=>admin,Deno:{env:{get:k=>k==='SUPABASE_URL'?'https://test.invalid':'secret'}},AUTH_PROJECT_URL:'https://test.invalid',ApiError:class extends Error { constructor(status,message){super(message);this.status=status;} },requireManager:c=>{if(c.profile.role!=='manager')throw Error('manager required')},requiredText:(v)=>{if(!v)throw Error('required');return v;},requiredEnum:(v,_,set)=>{if(!set.has(v))throw Error('invalid role');return v;},requireUuid:v=>v,branchRpc:async(name)=>calls.push(name),profileLabel:()=> 'Owner',logExternalEvent:async()=>calls.push('audit'),profileById:async()=>({active:true}),...overrides};
 vm.createContext(scope);vm.runInContext(handler,scope);return {scope,calls,admin};
}
const owner={user:{id:'owner'},profile:{role:'manager'}};
const body={display_name:'Test',email:'test@example.invalid',default_role:'Barback',login_role:'bartender'};
test('staff cannot create login accounts',async()=>{const {scope,calls}=setup();await assert.rejects(scope.createLoginMember({profile:{role:'bartender'}},body),/manager/);assert.deepEqual(calls,[])});
test('existing email is rejected before generating an invitation',async()=>{const {scope,admin,calls}=setup();admin.from=()=>({select:()=>({ilike:async()=>({data:[{id:'existing'}]})})});await assert.rejects(scope.createLoginMember(owner,body),/already has/);assert.deepEqual(calls,[])});
test('new login account connects details, shifts and audit before returning setup token',async()=>{const {scope,calls}=setup();const result=await scope.createLoginMember(owner,body);assert.equal(result.id,'new-user');assert.equal(result.email_sent,false);assert.deepEqual(calls,['invite','atlas_team_profile_upsert_details','atlas_shifts_sync_profiles','audit'])});
test('renewal cannot generate access links for an accepted account',async()=>{const {scope,calls}=setup();await assert.rejects(scope.renewMemberSetup(owner,{profile_id:'existing'}),/already accepted/);assert.deepEqual(calls,[])});
