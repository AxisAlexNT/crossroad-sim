import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
const {cfg}=migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json',import.meta.url),'utf8')));
const sim=new Simulation(cfg,compileModel(cfg).code,{headless:true});
try{
 sim.runUntil(60);const base=sim.st.vehicles[0];assert.ok(base);
 const north=sim.net.conns.find(c=>c.conn.id==='N0-S0'&&c.variant===0)!;
 const adjacent=sim.net.conns.find(c=>c.conn.id==='X:N1-S0')!;assert.ok(adjacent);
 const turn=sim.net.conns.find(c=>c.conn.id==='W2-S0'&&c.variant===0)!;
 const common=north.conflicts.find(r=>r.other===adjacent.idx&&sim.net.conflicts[r.conflict].kind==='merge')!;assert.ok(common);
 const make=(id:number,conn:number,s:number,entered:number):Vehicle=>({...structuredClone(base),id,conn,s,phase:'conn',v:0,a:0,len:4.3,wid:1.8,lat:0,lat2:0,origin:sim.net.conns[conn].conn.from.arm,dest:sim.net.conns[conn].conn.to.arm,committed:[],acceptedGrants:undefined,route:null,crashed:false,bayT:0,bayShift:0,tStop:entered});
 const follower=make(10001,north.idx,.001,10),leader=make(10002,adjacent.idx,40.8724,30),right=make(10003,turn.idx,12.8029,20);
 follower.committed=[common.conflict];leader.why='yield';leader.yieldTo=right.id;right.why='yield';right.yieldTo=follower.id;
 sim.st.vehicles=[follower,leader,right];sim.st.peds=[];sim.permit.fill('main');
 const internal=sim as unknown as {index():void;accel(v:Vehicle):number};
 for(const v of sim.st.vehicles)sim.pose(v);internal.index();internal.accel(follower);
 assert.equal(follower.why,'yield');assert.equal(follower.whyId,common.conflict);
 assert.equal(follower.yieldTo,leader.id,'Ожидание въезжающей в общую зону машины имеет конкретного адресата');
 console.log('Адресат ожидания: занятая общая зона не создаёт безымянное ребро графа.');
}finally{sim.dispose();}
